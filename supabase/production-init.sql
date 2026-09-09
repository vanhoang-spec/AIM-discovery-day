-- SINH TỰ ĐỘNG từ supabase/migrations (12 file) — đừng sửa tay.
-- Tái sinh: node scripts/build-production-sql.mjs
-- Dán nguyên file vào Supabase SQL Editor và Run MỘT lần trên database MỚI.

-- ═══════════ 0001_foundations.sql ═══════════
-- ============================================================================
-- ATL2026 — 0001 foundations: editions, events, zones, checkpoints, people.
--
-- Two rules hold throughout the schema and every later migration depends on
-- them:
--
--   1. Every row that belongs to a running event carries `event_id`. One
--      deployment serves Discovery Day Hà Nội, Discovery Day HCM and the Grand
--      Finale, and will serve the 2027 edition after a clone.
--
--   2. Child rows reference their parent with a COMPOSITE key that includes
--      `event_id`. A plain `checkpoint_id` FK would let a Hà Nội scan attach
--      itself to an HCM checkpoint; the composite form makes that unrepresent-
--      able rather than merely unlikely. Both venues run on the same backend on
--      12/09, so this is a live hazard, not a theoretical one.
-- ============================================================================

-- No extensions are required. `scan_uid` values are generated on the PG device
-- (that is what makes the offline queue idempotent), so the server never needs
-- to mint a UUID and pgcrypto is not a dependency.

-- ----------------------------------------------------------------------------
-- Reference data
-- ----------------------------------------------------------------------------

-- Schools are a controlled list, not free text. Free text produces forty
-- spellings of "Đại học Ngoại thương" and destroys the post-event report.
create table ref_schools (
  id            smallserial primary key,
  name          text        not null unique,
  short_name    text,
  city          text,
  -- Diacritic-free lowercase form so typing "ngoai thuong" finds the school.
  search_key    text        not null,
  is_active     boolean     not null default true
);
create index ref_schools_search on ref_schools (search_key text_pattern_ops);

-- Vietnam reorganised into 34 provinces/cities in 2025. Store the code, render
-- the name, so a later administrative change does not rewrite historical rows.
create table ref_provinces (
  code          text        primary key,
  name          text        not null,
  search_key    text        not null
);

-- ----------------------------------------------------------------------------
-- Editions and event instances
-- ----------------------------------------------------------------------------

create table editions (
  id            smallserial primary key,
  year          smallint    not null,
  name          text        not null,
  created_at    timestamptz not null default now(),
  unique (year, name)
);

create type event_kind as enum ('discovery_day', 'grand_finale');

create table events (
  id                  smallint     primary key,      -- 1=DD HN, 2=DD HCM, 3=GF
                                                     -- Mirrored in the QR token's
                                                     -- eventInstance byte, so it is
                                                     -- assigned, never serial.
  edition_id          smallint     not null references editions (id),
  kind                event_kind   not null,
  slug                text         not null unique,
  name                text         not null,
  venue_name          text         not null,
  city                text         not null,
  starts_at           timestamptz  not null,
  ends_at             timestamptz  not null,
  timezone            text         not null default 'Asia/Ho_Chi_Minh',

  -- Rule configuration. Admins change these mid-event; see 0003 for the
  -- "never revoke what was granted" policy that makes that safe.
  gift_ladder_mode    text         not null default 'cumulative'
                                   check (gift_ladder_mode in ('cumulative', 'highest_only')),
  special_threshold_y smallint     not null default 5 check (special_threshold_y >= 0),
  special_claim_limit smallint     not null default 2 check (special_claim_limit >= 0),

  -- Identifies which HMAC secret signs this event's QR tokens. The secret
  -- itself lives in the app's environment, never in the database.
  token_key_id        text         not null,

  is_registration_open boolean     not null default false,
  created_at          timestamptz  not null default now(),

  check (ends_at > starts_at),
  check (id between 1 and 255)  -- must fit the single token byte
);

create table zones (
  id            serial      primary key,
  event_id      smallint    not null references events (id) on delete cascade,
  name          text        not null,
  color_hex     text        check (color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  display_order smallint    not null default 0,
  unique (event_id, name),
  unique (id, event_id)      -- enables the composite FK from checkpoints
);

create type checkpoint_kind as enum (
  'sponsor_booth',   -- Finance / Living / Energy / Career / Creative zones
  'diamond_booth',   -- Nhà tài trợ Kim cương
  'hall_session',    -- Brief day, Inspiration talks, SSC finale
  'learning_class',  -- Learning zone rooms
  'info_desk',
  'gift_counter',
  'entrance'
);

-- How a student earns the badge at this checkpoint. Configurable per booth
-- because sponsors want different things: some run a survey, some want the
-- rep to hand the badge over in person, some want both.
create type badge_award_mode as enum (
  'pg_scan',          -- default: a PG must scan the student
  'survey_complete',  -- completing this sponsor's survey is enough
  'either',
  'both_required'
);

create table checkpoints (
  id                    serial            primary key,
  event_id              smallint          not null references events (id) on delete cascade,
  zone_id               integer,
  kind                  checkpoint_kind   not null,
  name                  text              not null,
  description           text,
  location_hint         text,                      -- "Khu C, gần cổng sau"
  starts_at             timestamptz,
  ends_at               timestamptz,
  capacity              integer           check (capacity is null or capacity > 0),

  -- Whether a badge here counts toward the x / x+1 / x+2 gift ladder and the
  -- y threshold. Admin-toggled per activity: it is the dial that balances
  -- sponsor booth traffic against learning-zone attendance.
  counts_toward_badges  boolean           not null default true,
  badge_award_mode      badge_award_mode  not null default 'pg_scan',

  -- Off by default. A supervisor turns this on for a zone when a PG device
  -- dies, letting students scan a booth poster instead. See 0002.
  allow_student_scan    boolean           not null default false,

  display_order         smallint          not null default 0,
  is_active             boolean           not null default true,
  created_at            timestamptz       not null default now(),
  updated_at            timestamptz       not null default now(),

  foreign key (zone_id, event_id) references zones (id, event_id),
  check (ends_at is null or starts_at is null or ends_at > starts_at),
  unique (id, event_id)
);
create index checkpoints_by_event on checkpoints (event_id) where is_active;
create index checkpoints_by_zone  on checkpoints (zone_id);

-- ----------------------------------------------------------------------------
-- People
--
-- `students` is campaign-scoped, not event-scoped: one person may attend
-- Discovery Day in September and the Grand Finale in November with the same QR.
-- Per-event facts live in `registrations`.
-- ----------------------------------------------------------------------------

create type gender as enum ('nam', 'nu', 'khac');

create table students (
  id                  bigserial   primary key,

  -- The uint32 carried in the QR token. Separate from `id` so the token format
  -- stays 4 bytes even if `id` outgrows it, and so a merged duplicate can keep
  -- its printed sticker working.
  seq                 integer     not null unique check (seq > 0 and seq <= 2147483647),

  -- Six human-typeable characters printed under the QR. The fallback when a
  -- camera fails, a screen is cracked or a battery is dead.
  lookup_code         text        not null unique check (lookup_code ~ '^[0-9A-HJKMNP-TV-Z]{6}$'),

  full_name           text        not null,
  name_search_key     text        not null,          -- diacritic-free, lowercase
  -- Stored lowercase (enforced, not hoped for) so the unique index below
  -- actually prevents "An@gmail.com" and "an@gmail.com" registering twice.
  email               text        check (email is null or email = lower(email)),
  phone               text        check (phone is null or phone ~ '^\+?[0-9]{8,15}$'),

  school_id           smallint    references ref_schools (id),
  school_other        text,                          -- when "Trường khác" is picked
  student_code        text,                          -- MSSV: text, not numeric —
                                                     -- many contain letters
  major               text,
  birth_year          smallint    check (birth_year between 1980 and 2015),
  province_code       text        references ref_provinces (code),
  employer            text,
  gender              gender,

  -- Consent is recorded per purpose, with evidence. Under Vietnam's personal
  -- data rules a pre-ticked box is not consent, and sharing with sponsors is a
  -- separate purpose from running the event — so these are two columns, never
  -- one. A null timestamp means "not given".
  consent_event_at        timestamptz,
  consent_event_ip        inet,
  consent_sponsors_at     timestamptz,
  consent_sponsors_ip     inet,
  consent_text_version    text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Duplicate resolution: the losing row points at the survivor and stops
  -- being counted. Walk-in registration guarantees duplicates.
  merged_into_id      bigint      references students (id),

  -- Either an email or a phone must exist: the QR is keyed off one of them and
  -- a student with neither cannot recover their code.
  check (email is not null or phone is not null)
);

create unique index students_email_unique on students (email) where merged_into_id is null;
create unique index students_phone_unique on students (phone) where merged_into_id is null;
create index students_name_search on students (name_search_key text_pattern_ops);
create index students_student_code on students (school_id, student_code)
  where student_code is not null;

create sequence student_seq_counter as integer start 1001;

create type registration_type as enum ('contestant', 'general');
create type registration_source as enum ('online', 'walk_in', 'admin', 'import');

-- Teams of exactly two, for Awaken The Lions contestants. Badges are always
-- counted per person: a shared team QR would break the badge model, and the
-- two members walk the courtyard separately anyway.
create table teams (
  id            bigserial   primary key,
  event_id      smallint    not null references events (id) on delete cascade,
  team_code     text        not null,
  name          text,
  created_at    timestamptz not null default now(),
  unique (event_id, team_code),
  unique (id, event_id)
);

create table registrations (
  student_id        bigint              not null references students (id) on delete cascade,
  event_id          smallint            not null references events (id) on delete cascade,
  type              registration_type   not null default 'general',
  source            registration_source not null default 'online',
  team_id           bigint,
  ssc_opted_in      boolean             not null default true,

  registered_at     timestamptz         not null default now(),
  checked_in_at     timestamptz,

  -- Denormalised badge count, maintained in the same transaction as the badge
  -- insert (see 0002). The student app's hot path is a single indexed row read;
  -- it must never aggregate the ledger.
  badge_count       integer             not null default 0 check (badge_count >= 0),

  primary key (student_id, event_id),
  foreign key (team_id, event_id) references teams (id, event_id)
);
create index registrations_by_event on registrations (event_id);
create index registrations_team on registrations (team_id) where team_id is not null;

-- ----------------------------------------------------------------------------
-- Audit log — every manual override and every rule change lands here.
--
-- After the event somebody will ask "why does this student have 7 badges".
-- The answer has to take ten seconds to find, so this is a first-class table
-- with a first-class UI, not a debugging afterthought.
-- ----------------------------------------------------------------------------

create table audit_log (
  id            bigserial   primary key,
  event_id      smallint    references events (id) on delete set null,
  actor_type    text        not null,   -- super_admin | pg | system
  actor_id      text,
  action        text        not null,
  target_type   text,
  target_id     text,
  before_state  jsonb,
  after_state   jsonb,
  reason        text,
  created_at    timestamptz not null default now()
);
create index audit_log_recent on audit_log (event_id, created_at desc);
create index audit_log_target on audit_log (target_type, target_id);

-- ----------------------------------------------------------------------------
-- updated_at maintenance
-- ----------------------------------------------------------------------------

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger students_touch    before update on students
  for each row execute function touch_updated_at();
create trigger checkpoints_touch before update on checkpoints
  for each row execute function touch_updated_at();

-- ═══════════ 0002_ledger.sql ═══════════
-- ============================================================================
-- ATL2026 — 0002 the scan ledger.
--
-- This migration is where "no wrong data when many users are concurrent" is
-- actually delivered. The guarantees below are enforced by the storage engine,
-- not by application code remembering to be careful. That is the difference
-- between "we were careful" and "that cannot happen".
--
-- Three tables, three jobs:
--
--   ledger_events  append-only evidence. Every touch, including duplicates,
--                  replays and rejections. Never updated, never deleted.
--   attendance     the badge. Exactly one row per (event, student, checkpoint).
--                  A unique index makes a double badge unrepresentable.
--   registrations  .badge_count — the denormalised counter the student app
--                  reads. Maintained in the same transaction as the badge.
-- ============================================================================

create type scan_source as enum (
  'pg_scan',        -- primary: a PG scanned the student at a booth
  'student_scan',   -- fallback: the student scanned a booth poster
  'survey',         -- the student completed this sponsor's survey
  'admin_manual',   -- an admin fixed a mis-scan, with a reason
  'walk_in'         -- registered at the door
);

create type scan_status as enum (
  'counted',                 -- a new badge was awarded
  'repeat_not_counted',      -- the student already had this badge
  'replay',                  -- this exact scan_uid was already processed
  'pending_other_condition', -- both_required: waiting for the counterpart
  'rejected_unknown_student',
  'rejected_checkpoint_closed',
  'rejected_not_registered'
);

-- ----------------------------------------------------------------------------
-- The ledger
--
-- `scan_uid` is the primary key and it is generated on the PG device, not by
-- the server. That single choice is what makes the offline queue safe: a device
-- that loses its connection mid-flush can resend the whole batch and the second
-- attempt is a no-op. Without it, retries silently double-count.
-- ----------------------------------------------------------------------------

create table ledger_events (
  scan_uid        uuid          primary key,          -- UUIDv7 from the client
  event_id        smallint      not null references events (id) on delete cascade,
  student_id      bigint        references students (id) on delete set null,
  checkpoint_id   integer,
  source          scan_source   not null,
  status          scan_status   not null,

  pg_staff_id     text,
  device_id       text,

  -- Device clocks are wrong. Forty borrowed phones guarantee at least one is
  -- set to the wrong month. `client_ts` is forensic only; `server_ts` orders
  -- everything and is the only timestamp any report may use.
  client_ts       timestamptz,
  server_ts       timestamptz   not null default now(),

  meta            jsonb,

  foreign key (checkpoint_id, event_id) references checkpoints (id, event_id)
);

create index ledger_by_checkpoint on ledger_events (checkpoint_id, server_ts desc);
create index ledger_by_student    on ledger_events (student_id, server_ts desc);
create index ledger_by_device     on ledger_events (device_id, server_ts desc);
create index ledger_by_event_time on ledger_events (event_id, server_ts desc);

-- Append-only, enforced. A support ticket six weeks after the event is answered
-- from this table; if it can be rewritten it is not evidence.
create or replace function ledger_is_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'ledger_events is append-only (attempted % on scan_uid %)',
    tg_op, coalesce(old.scan_uid::text, '?');
end;
$$;

create trigger ledger_no_update before update on ledger_events
  for each row execute function ledger_is_append_only();
create trigger ledger_no_delete before delete on ledger_events
  for each row execute function ledger_is_append_only();

-- ----------------------------------------------------------------------------
-- Attendance — the badge itself
--
-- The unique constraint is the whole anti-double-count story. Two PGs scanning
-- the same student at the same booth at the same instant produce one row; the
-- loser gets 'repeat_not_counted' and the amber "đã có badge này" screen, which
-- is a normal outcome, not an error.
-- ----------------------------------------------------------------------------

create table attendance (
  id              bigserial     primary key,
  event_id        smallint      not null,
  student_id      bigint        not null references students (id) on delete cascade,
  checkpoint_id   integer       not null,

  -- Deferred on purpose. record_scan must attempt the badge insert BEFORE it
  -- knows the ledger status to write — the ON CONFLICT result is what decides
  -- 'counted' vs 'repeat_not_counted'. Checking this FK immediately would force
  -- the ledger row to be written first, which would mean deciding the status by
  -- reading before writing, and that is exactly the race the design avoids.
  -- Both rows exist by commit, so integrity still holds.
  first_scan_uid  uuid          references ledger_events (scan_uid)
                                deferrable initially deferred,
  source          scan_source   not null,
  awarded_at      timestamptz   not null default now(),

  -- Soft delete only. An admin removing a mis-scan must leave a trace.
  voided_at       timestamptz,
  void_reason     text,

  foreign key (checkpoint_id, event_id) references checkpoints (id, event_id),
  foreign key (student_id, event_id) references registrations (student_id, event_id)
    on delete cascade
);

create unique index attendance_one_per_checkpoint
  on attendance (event_id, student_id, checkpoint_id)
  where voided_at is null;

create index attendance_by_student on attendance (event_id, student_id) where voided_at is null;
create index attendance_by_checkpoint on attendance (checkpoint_id, awarded_at desc)
  where voided_at is null;

-- ----------------------------------------------------------------------------
-- Dashboard rollup
--
-- The admin dashboard polls every 5 seconds. It must never aggregate the
-- ledger: one unbounded COUNT(*) on a 5-second timer is how a system that had
-- 200x headroom falls over. Counters are incremented on write instead.
-- ----------------------------------------------------------------------------

create table checkpoint_minute_counts (
  checkpoint_id integer     not null,
  event_id      smallint    not null,
  minute_ts     timestamptz not null,
  badge_count   integer     not null default 0,
  scan_count    integer     not null default 0,
  primary key (checkpoint_id, minute_ts),
  foreign key (checkpoint_id, event_id) references checkpoints (id, event_id)
);
create index cmc_recent on checkpoint_minute_counts (event_id, minute_ts desc);

-- ----------------------------------------------------------------------------
-- Progress recomputation
--
-- Used in three situations: to repair drift, after an admin toggles
-- `counts_toward_badges` on an activity (which retroactively changes what
-- counts), and after a duplicate merge.
-- ----------------------------------------------------------------------------

create or replace function rebuild_student_progress(p_event_id smallint, p_student_id bigint)
returns integer
language plpgsql as $$
declare
  v_count integer;
begin
  select count(*)::integer into v_count
    from attendance a
    join checkpoints c on c.id = a.checkpoint_id and c.event_id = a.event_id
   where a.event_id = p_event_id
     and a.student_id = p_student_id
     and a.voided_at is null
     and c.counts_toward_badges;

  update registrations
     set badge_count = v_count
   where event_id = p_event_id and student_id = p_student_id;

  return v_count;
end;
$$;

create or replace function rebuild_all_progress(p_event_id smallint)
returns integer
language plpgsql as $$
declare
  v_rows integer;
begin
  with truth as (
    select r.student_id,
           count(a.id) filter (where c.counts_toward_badges) as real_count
      from registrations r
      left join attendance a
        on a.event_id = r.event_id and a.student_id = r.student_id and a.voided_at is null
      left join checkpoints c
        on c.id = a.checkpoint_id and c.event_id = a.event_id
     where r.event_id = p_event_id
     group by r.student_id
  )
  update registrations r
     set badge_count = t.real_count
    from truth t
   where r.event_id = p_event_id
     and r.student_id = t.student_id
     and r.badge_count is distinct from t.real_count;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- Any row here means the denormalised counter has diverged from the ledger.
-- Poll it every few minutes during the event: the point is to find out at
-- 10:30 while it is fixable, not from the post-event report in October.
create or replace view v_progress_drift as
select r.event_id,
       r.student_id,
       r.badge_count as stored_count,
       count(a.id) filter (where c.counts_toward_badges) as real_count
  from registrations r
  left join attendance a
    on a.event_id = r.event_id and a.student_id = r.student_id and a.voided_at is null
  left join checkpoints c
    on c.id = a.checkpoint_id and c.event_id = a.event_id
 group by r.event_id, r.student_id, r.badge_count
having r.badge_count is distinct from count(a.id) filter (where c.counts_toward_badges);

-- ----------------------------------------------------------------------------
-- record_scan — the single write path for the PG app
--
-- Idempotent on two independent levels, because they fail differently:
--
--   scan_uid           the same physical scan replayed from an offline queue.
--                      Returns 'replay'; nothing changes.
--   (student, checkpoint)  two different scans of the same student at the same
--                      booth — a double-tap, or two PGs at once. Returns
--                      'repeat_not_counted'; the badge is not doubled.
--
-- A repeat is still written to the ledger. Knowing a student visited a booth
-- three times is useful to the sponsor; awarding three badges is not.
-- ----------------------------------------------------------------------------

create or replace function record_scan(
  p_scan_uid      uuid,
  p_event_id      smallint,
  p_student_id    bigint,
  p_checkpoint_id integer,
  p_source        scan_source default 'pg_scan',
  p_pg_staff_id   text        default null,
  p_device_id     text        default null,
  p_client_ts     timestamptz default null,
  p_meta          jsonb       default null
)
returns table (status scan_status, badge_count integer, awarded_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing      ledger_events%rowtype;
  v_checkpoint    checkpoints%rowtype;
  v_status        scan_status;
  v_attendance_id bigint;
  v_awarded_at    timestamptz;
  v_counts        boolean;
  v_badge_count   integer;
  v_has_scan      boolean;
  v_has_survey    boolean;
  v_award         boolean := false;
begin
  -- Level 1: has this exact scan already been processed?
  select * into v_existing from ledger_events where scan_uid = p_scan_uid;
  if found then
    select r.badge_count into v_badge_count
      from registrations r
     where r.event_id = v_existing.event_id and r.student_id = v_existing.student_id;
    return query select 'replay'::scan_status, coalesce(v_badge_count, 0), v_existing.server_ts;
    return;
  end if;

  select * into v_checkpoint
    from checkpoints
   where id = p_checkpoint_id and event_id = p_event_id;

  if not found or not v_checkpoint.is_active then
    insert into ledger_events (scan_uid, event_id, student_id, checkpoint_id, source,
                               status, pg_staff_id, device_id, client_ts, meta)
    values (p_scan_uid, p_event_id, p_student_id, null, p_source,
            'rejected_checkpoint_closed', p_pg_staff_id, p_device_id, p_client_ts, p_meta);
    return query select 'rejected_checkpoint_closed'::scan_status, 0, null::timestamptz;
    return;
  end if;

  -- The student must be registered for THIS event. A walk-in is registered by
  -- the door flow before their first scan, so this is a real error, not a
  -- routine case.
  perform 1 from registrations
   where event_id = p_event_id and student_id = p_student_id;
  if not found then
    insert into ledger_events (scan_uid, event_id, student_id, checkpoint_id, source,
                               status, pg_staff_id, device_id, client_ts, meta)
    values (p_scan_uid, p_event_id, p_student_id, p_checkpoint_id, p_source,
            'rejected_not_registered', p_pg_staff_id, p_device_id, p_client_ts, p_meta);
    return query select 'rejected_not_registered'::scan_status, 0, null::timestamptz;
    return;
  end if;

  -- Does this source satisfy the checkpoint's award rule?
  case v_checkpoint.badge_award_mode
    when 'pg_scan' then
      v_award := p_source in ('pg_scan', 'student_scan', 'admin_manual', 'walk_in');
    when 'survey_complete' then
      v_award := p_source in ('survey', 'admin_manual');
    when 'either' then
      v_award := true;
    when 'both_required' then
      -- Award only once both halves are on record. Check the ledger for the
      -- counterpart, treating this in-flight scan as already present.
      v_has_scan := p_source in ('pg_scan', 'student_scan', 'walk_in') or exists (
        select 1 from ledger_events
         where event_id = p_event_id and student_id = p_student_id
           and checkpoint_id = p_checkpoint_id
           and source in ('pg_scan', 'student_scan', 'walk_in')
      );
      v_has_survey := p_source = 'survey' or exists (
        select 1 from ledger_events
         where event_id = p_event_id and student_id = p_student_id
           and checkpoint_id = p_checkpoint_id
           and source = 'survey'
      );
      v_award := (v_has_scan and v_has_survey) or p_source = 'admin_manual';
  end case;

  -- Level 2: try to claim the badge. ON CONFLICT DO NOTHING against the partial
  -- unique index is the atomic step — no read-then-write, so no race.
  if v_award then
    insert into attendance (event_id, student_id, checkpoint_id, first_scan_uid, source)
    values (p_event_id, p_student_id, p_checkpoint_id, p_scan_uid, p_source)
    on conflict (event_id, student_id, checkpoint_id) where voided_at is null
    do nothing
    returning id, attendance.awarded_at into v_attendance_id, v_awarded_at;

    if v_attendance_id is not null then
      v_status := 'counted';
    else
      v_status := 'repeat_not_counted';
      select a.awarded_at into v_awarded_at
        from attendance a
       where a.event_id = p_event_id and a.student_id = p_student_id
         and a.checkpoint_id = p_checkpoint_id and a.voided_at is null;
    end if;
  else
    v_status := 'pending_other_condition';
  end if;

  insert into ledger_events (scan_uid, event_id, student_id, checkpoint_id, source,
                             status, pg_staff_id, device_id, client_ts, meta)
  values (p_scan_uid, p_event_id, p_student_id, p_checkpoint_id, p_source,
          v_status, p_pg_staff_id, p_device_id, p_client_ts, p_meta);

  -- Counter and rollup move in the same transaction as the badge, so a reader
  -- can never observe a badge that is not yet counted.
  v_counts := v_checkpoint.counts_toward_badges;

  if v_status = 'counted' and v_counts then
    -- Both sides qualified: `badge_count` is also the name of an OUT column of
    -- this function, and an unqualified reference is ambiguous.
    update registrations
       set badge_count = registrations.badge_count + 1
     where event_id = p_event_id and student_id = p_student_id
    returning registrations.badge_count into v_badge_count;
  else
    select r.badge_count into v_badge_count
      from registrations r
     where r.event_id = p_event_id and r.student_id = p_student_id;
  end if;

  insert into checkpoint_minute_counts (checkpoint_id, event_id, minute_ts, badge_count, scan_count)
  values (p_checkpoint_id, p_event_id, date_trunc('minute', now()),
          case when v_status = 'counted' then 1 else 0 end, 1)
  on conflict (checkpoint_id, minute_ts) do update
     set badge_count = checkpoint_minute_counts.badge_count + excluded.badge_count,
         scan_count  = checkpoint_minute_counts.scan_count + excluded.scan_count;

  return query select v_status, coalesce(v_badge_count, 0), v_awarded_at;
end;
$$;

-- ----------------------------------------------------------------------------
-- Voiding a badge — an admin correcting a mis-scan.
-- The ledger row stays; the badge is soft-deleted and the counter rebuilt.
-- ----------------------------------------------------------------------------

create or replace function void_attendance(
  p_event_id      smallint,
  p_student_id    bigint,
  p_checkpoint_id integer,
  p_actor_id      text,
  p_reason        text
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_count integer;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'A reason is required to void a badge';
  end if;

  update attendance
     set voided_at = now(), void_reason = p_reason
   where event_id = p_event_id and student_id = p_student_id
     and checkpoint_id = p_checkpoint_id and voided_at is null;

  if not found then
    raise exception 'No active badge for student % at checkpoint %', p_student_id, p_checkpoint_id;
  end if;

  v_new_count := rebuild_student_progress(p_event_id, p_student_id);

  insert into audit_log (event_id, actor_type, actor_id, action, target_type, target_id, reason,
                         after_state)
  values (p_event_id, 'super_admin', p_actor_id, 'void_attendance', 'student',
          p_student_id::text, p_reason, jsonb_build_object('badge_count', v_new_count));

  return v_new_count;
end;
$$;

-- ═══════════ 0003_rewards.sql ═══════════
-- ============================================================================
-- ATL2026 — 0003 gifts and capacity-limited special activities.
--
-- The highest-risk code in the project. The naive implementation of a capped
-- resource is:
--
--     SELECT count(*) ... ; IF count < cap THEN INSERT
--
-- Under READ COMMITTED two sessions both read 199 against a cap of 200 and both
-- insert. 201 students are promised a seat at the celebrity meet-and-greet and
-- one of them is turned away in front of the sponsor, on camera. That is
-- precisely the "sai dữ liệu khi đông người" the client asked us to prevent,
-- and no amount of testing the happy path finds it.
--
-- Everything below allocates by mutating a row under a lock, so the check and
-- the claim are the same operation and cannot interleave.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Gift ladder: x, x+1, x+2 → tiered gifts
-- ----------------------------------------------------------------------------

create table gift_tiers (
  id                serial      primary key,
  event_id          smallint    not null references events (id) on delete cascade,
  tier              smallint    not null check (tier > 0),
  required_badges   smallint    not null check (required_badges >= 0),
  gift_name         text        not null,
  stock_total       integer     not null check (stock_total >= 0),
  stock_issued      integer     not null default 0 check (stock_issued >= 0),
  is_active         boolean     not null default true,
  created_at        timestamptz not null default now(),

  unique (event_id, tier),
  unique (id, event_id),
  -- Cannot issue more than exists. Belt as well as braces: even a hand-written
  -- UPDATE in a psql session cannot oversell.
  check (stock_issued <= stock_total)
);

create table gift_redemptions (
  id                  bigserial   primary key,
  event_id            smallint    not null,
  student_id          bigint      not null references students (id) on delete cascade,
  gift_tier_id        integer     not null,

  -- The threshold as it stood when the gift was handed over. Admins may raise
  -- x mid-event; a student who legitimately earned a notebook at x=2 keeps it
  -- when x becomes 3. Recording the rule at grant time is what makes that
  -- auditable rather than merely asserted.
  threshold_at_grant  smallint    not null,
  badge_count_at_grant integer    not null,

  redeemed_at         timestamptz not null default now(),
  staff_id            text,
  device_id           text,
  was_offline         boolean     not null default false,

  foreign key (gift_tier_id, event_id) references gift_tiers (id, event_id),
  foreign key (student_id, event_id) references registrations (student_id, event_id)
    on delete cascade
);

-- One student, one tier, once. This is what makes the claim safe to retry from
-- a flaky counter connection.
create unique index gift_one_per_tier
  on gift_redemptions (event_id, student_id, gift_tier_id);
create index gift_by_student on gift_redemptions (event_id, student_id);

-- ----------------------------------------------------------------------------
-- claim_gift_tier
--
-- Two things must be atomic together: decrementing stock, and recording that
-- this student took this tier. Stock moves first with a conditional UPDATE, so
-- if the insert then conflicts we release the unit back rather than leaking it.
-- ----------------------------------------------------------------------------

create or replace function claim_gift_tier(
  p_event_id      smallint,
  p_student_id    bigint,
  p_gift_tier_id  integer,
  p_staff_id      text default null,
  p_device_id     text default null,
  p_was_offline   boolean default false
)
returns table (result text, gift_name text, remaining integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tier        gift_tiers%rowtype;
  v_mode        text;
  v_badges      integer;
  v_best_tier   integer;
  v_claimed     boolean;
  v_remaining   integer;
begin
  select * into v_tier
    from gift_tiers where id = p_gift_tier_id and event_id = p_event_id and is_active;
  if not found then
    return query select 'unknown_tier'::text, null::text, 0;
    return;
  end if;

  select e.gift_ladder_mode into v_mode from events e where e.id = p_event_id;

  select r.badge_count into v_badges
    from registrations r
   where r.event_id = p_event_id and r.student_id = p_student_id;
  if v_badges is null then
    return query select 'not_registered'::text, v_tier.gift_name, 0;
    return;
  end if;

  if v_badges < v_tier.required_badges then
    return query select 'not_eligible'::text, v_tier.gift_name,
                        v_tier.stock_total - v_tier.stock_issued;
    return;
  end if;

  -- In highest_only mode a student receives exactly one gift: the best tier
  -- they qualify for. Asking for a lower tier is a counter mistake, not a
  -- choice, so it is refused rather than silently downgrading them.
  if v_mode = 'highest_only' then
    if exists (select 1 from gift_redemptions
                where event_id = p_event_id and student_id = p_student_id) then
      return query select 'already_claimed'::text, v_tier.gift_name,
                          v_tier.stock_total - v_tier.stock_issued;
      return;
    end if;

    select max(gt.tier) into v_best_tier
      from gift_tiers gt
     where gt.event_id = p_event_id and gt.is_active
       and gt.required_badges <= v_badges
       and gt.stock_issued < gt.stock_total;

    if v_best_tier is distinct from v_tier.tier then
      return query select 'not_highest_tier'::text, v_tier.gift_name,
                          v_tier.stock_total - v_tier.stock_issued;
      return;
    end if;
  end if;

  -- Atomic stock take. The predicate and the decrement are one statement, so
  -- two counters cannot both see the last unit.
  update gift_tiers
     set stock_issued = stock_issued + 1
   where id = p_gift_tier_id
     and stock_issued < stock_total
  returning stock_total - stock_issued into v_remaining;

  if not found then
    return query select 'out_of_stock'::text, v_tier.gift_name, 0;
    return;
  end if;

  insert into gift_redemptions (event_id, student_id, gift_tier_id, threshold_at_grant,
                                badge_count_at_grant, staff_id, device_id, was_offline)
  values (p_event_id, p_student_id, p_gift_tier_id, v_tier.required_badges,
          v_badges, p_staff_id, p_device_id, p_was_offline)
  on conflict (event_id, student_id, gift_tier_id) do nothing;

  get diagnostics v_claimed = row_count;

  if not v_claimed then
    -- Someone else claimed this tier for this student first. Put the unit back;
    -- otherwise a retried request quietly burns stock.
    update gift_tiers set stock_issued = stock_issued - 1 where id = p_gift_tier_id
    returning stock_total - stock_issued into v_remaining;
    return query select 'already_claimed'::text, v_tier.gift_name, v_remaining;
    return;
  end if;

  return query select 'ok'::text, v_tier.gift_name, v_remaining;
end;
$$;

-- ----------------------------------------------------------------------------
-- Special activities: "join y activities → unlock z special activities"
--
-- Capacity is allocated as PRE-CREATED SLOT ROWS rather than a counter. Two
-- reasons beyond correctness:
--
--   * `FOR UPDATE SKIP LOCKED` lets concurrent claimants take different rows
--     instead of queueing behind one hot counter.
--   * The result is self-auditing. "Who holds slot 147" is a lookup, and the
--     student gets a real slot number to show at the door.
-- ----------------------------------------------------------------------------

create table special_activities (
  id                serial      primary key,
  event_id          smallint    not null references events (id) on delete cascade,
  name              text        not null,
  description       text,
  location_hint     text,
  starts_at         timestamptz,
  capacity          integer     not null check (capacity > 0),
  is_open           boolean     not null default true,
  created_at        timestamptz not null default now(),
  unique (event_id, name),
  unique (id, event_id)
);

create table special_slots (
  id                  bigserial   primary key,
  special_activity_id integer     not null,
  event_id            smallint    not null,
  slot_no             integer     not null,

  student_id          bigint      references students (id) on delete set null,
  claimed_at          timestamptz,

  -- Two-phase claim. A connection that drops between "capacity taken" and
  -- "student told" must not burn the slot forever, so a hold expires.
  held_by_student_id  bigint      references students (id) on delete set null,
  held_until          timestamptz,

  foreign key (special_activity_id, event_id) references special_activities (id, event_id)
    on delete cascade,
  unique (special_activity_id, slot_no)
);

-- A student holds at most one slot per activity.
create unique index special_one_per_student
  on special_slots (special_activity_id, student_id)
  where student_id is not null;

-- The index that makes allocation fast: find a free slot without scanning
-- claimed ones.
create index special_free_slots
  on special_slots (special_activity_id, slot_no)
  where student_id is null;

-- Pre-create the slot rows for an activity. Called when the activity is created
-- and whenever an admin raises the capacity.
create or replace function ensure_special_slots(p_special_activity_id integer)
returns integer
language plpgsql as $$
declare
  v_act     special_activities%rowtype;
  v_existing integer;
  v_created integer := 0;
begin
  select * into v_act from special_activities where id = p_special_activity_id;
  if not found then
    raise exception 'Unknown special activity %', p_special_activity_id;
  end if;

  select count(*) into v_existing from special_slots
   where special_activity_id = p_special_activity_id;

  if v_act.capacity > v_existing then
    insert into special_slots (special_activity_id, event_id, slot_no)
    select p_special_activity_id, v_act.event_id, gs
      from generate_series(v_existing + 1, v_act.capacity) gs;
    v_created := v_act.capacity - v_existing;
  end if;

  -- Lowering capacity never removes a claimed slot; it removes free ones only.
  if v_act.capacity < v_existing then
    delete from special_slots
     where special_activity_id = p_special_activity_id
       and student_id is null
       and held_until is null
       and slot_no > v_act.capacity;
  end if;

  return v_created;
end;
$$;

-- ----------------------------------------------------------------------------
-- claim_special_slot — phase 1: hold
--
-- ONLINE ONLY. A PG device cannot do this offline and the app says so loudly,
-- because capacity is global state and two disconnected devices cannot agree
-- on how much of it is left.
-- ----------------------------------------------------------------------------

create or replace function hold_special_slot(
  p_event_id            smallint,
  p_student_id          bigint,
  p_special_activity_id integer,
  p_hold_seconds        integer default 90
)
returns table (result text, slot_no integer, held_until timestamptz, remaining integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_act         special_activities%rowtype;
  v_threshold   smallint;
  v_limit       smallint;
  v_badges      integer;
  v_used        integer;
  v_slot_id     bigint;
  v_slot_no     integer;
  v_until       timestamptz;
  v_remaining   integer;
begin
  select * into v_act
    from special_activities where id = p_special_activity_id and event_id = p_event_id;
  if not found or not v_act.is_open then
    return query select 'closed'::text, null::integer, null::timestamptz, 0;
    return;
  end if;

  select e.special_threshold_y, e.special_claim_limit into v_threshold, v_limit
    from events e where e.id = p_event_id;

  select r.badge_count into v_badges
    from registrations r
   where r.event_id = p_event_id and r.student_id = p_student_id;
  if v_badges is null then
    return query select 'not_registered'::text, null::integer, null::timestamptz, 0;
    return;
  end if;

  if v_badges < v_threshold then
    return query select 'not_eligible'::text, null::integer, null::timestamptz, 0;
    return;
  end if;

  -- Already holding or holding-and-claimed a slot here?
  select s.slot_no, s.held_until into v_slot_no, v_until
    from special_slots s
   where s.special_activity_id = p_special_activity_id
     and (s.student_id = p_student_id
          or (s.held_by_student_id = p_student_id and s.held_until > now()));
  if found then
    return query select 'already_held'::text, v_slot_no, v_until, 0;
    return;
  end if;

  -- z: how many special activities this student may take in total.
  select count(*)::integer into v_used
    from special_slots s
   where s.event_id = p_event_id
     and (s.student_id = p_student_id
          or (s.held_by_student_id = p_student_id and s.held_until > now()));
  if v_used >= v_limit then
    return query select 'limit_reached'::text, null::integer, null::timestamptz, 0;
    return;
  end if;

  -- The allocation. SKIP LOCKED means concurrent claimants take different rows
  -- rather than serialising, and an expired hold is reclaimed here rather than
  -- needing a sweeper to have run first.
  update special_slots
     set held_by_student_id = p_student_id,
         held_until = now() + make_interval(secs => p_hold_seconds)
   where id = (
     select s.id from special_slots s
      where s.special_activity_id = p_special_activity_id
        and s.student_id is null
        and (s.held_until is null or s.held_until <= now())
      order by s.slot_no
        for update skip locked
      limit 1
   )
  returning special_slots.id, special_slots.slot_no, special_slots.held_until
       into v_slot_id, v_slot_no, v_until;

  if v_slot_id is null then
    return query select 'sold_out'::text, null::integer, null::timestamptz, 0;
    return;
  end if;

  select count(*)::integer into v_remaining
    from special_slots s
   where s.special_activity_id = p_special_activity_id
     and s.student_id is null
     and (s.held_until is null or s.held_until <= now());

  return query select 'held'::text, v_slot_no, v_until, v_remaining;
end;
$$;

-- Phase 2: convert the hold into a claim.
create or replace function confirm_special_slot(
  p_event_id            smallint,
  p_student_id          bigint,
  p_special_activity_id integer,
  p_staff_id            text default null
)
returns table (result text, slot_no integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slot_no integer;
begin
  update special_slots
     set student_id = p_student_id,
         claimed_at = now(),
         held_by_student_id = null,
         held_until = null
   where special_activity_id = p_special_activity_id
     and event_id = p_event_id
     and held_by_student_id = p_student_id
     and held_until > now()
     and student_id is null
  returning special_slots.slot_no into v_slot_no;

  if v_slot_no is null then
    -- Either the hold expired, or this is a retry of a confirm that already
    -- succeeded. The second case must look like success, not like an error.
    select s.slot_no into v_slot_no
      from special_slots s
     where s.special_activity_id = p_special_activity_id
       and s.student_id = p_student_id;
    if v_slot_no is not null then
      return query select 'ok'::text, v_slot_no;
    else
      return query select 'hold_expired'::text, null::integer;
    end if;
    return;
  end if;

  insert into audit_log (event_id, actor_type, actor_id, action, target_type, target_id,
                         after_state)
  values (p_event_id, 'pg', p_staff_id, 'confirm_special_slot', 'student',
          p_student_id::text,
          jsonb_build_object('activity_id', p_special_activity_id, 'slot_no', v_slot_no));

  return query select 'ok'::text, v_slot_no;
end;
$$;

-- Live control panel: what the admin watches to decide when to close the gate.
create or replace view v_special_control_panel as
select sa.event_id,
       sa.id   as special_activity_id,
       sa.name,
       sa.capacity,
       count(*) filter (where s.student_id is not null)                     as claimed,
       count(*) filter (where s.student_id is null
                          and s.held_until > now())                          as on_hold,
       count(*) filter (where s.student_id is null
                          and (s.held_until is null or s.held_until <= now())) as available,
       (select count(*) from registrations r
         where r.event_id = sa.event_id
           and r.badge_count >= (select e.special_threshold_y
                                   from events e where e.id = sa.event_id))  as students_eligible
  from special_activities sa
  join special_slots s on s.special_activity_id = sa.id
 group by sa.event_id, sa.id, sa.name, sa.capacity;

-- ═══════════ 0004_registration.sql ═══════════
-- ============================================================================
-- ATL2026 — 0004 registration path: the notification outbox and the atomic
-- registration functions.
--
-- Registration is the 30/08 critical path. Two properties matter:
--
--   * A submit retried over a flaky courtyard connection must never create a
--     second student. Dedupe lives HERE, in one transaction with the insert —
--     not as a read-then-write in the API, which is exactly the race the rest
--     of the schema was built to avoid.
--
--   * Email and SMS must never be sent from inside the request. They go to an
--     outbox in the same transaction; a worker drains it with throttling and
--     retries. A slow provider then costs seconds of delivery, not a failed
--     registration.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Notification outbox
-- ----------------------------------------------------------------------------

create type notification_channel as enum ('email', 'sms');
create type notification_status  as enum ('queued', 'sending', 'sent', 'failed', 'cancelled');

-- SMS is OFF by default and is not part of the delivered scope.
--
-- The QR reaches the student three ways that cost nothing: it renders on the
-- success screen immediately, the "save image" button puts it in Photos, and
-- it is cached on the device. A student who arrives with none of those is
-- found by PG lookup on their PHONE NUMBER — high-entropy, unlike Vietnamese
-- names, and already offline-capable.
--
-- So SMS buys a faster gate, not access. The column exists because the
-- deliverability test on 01/09 could come back bad; if it does, flipping this
-- boolean turns the channel on with no migration and no code change.
alter table events add column sms_enabled boolean not null default false;

create table notification_outbox (
  id            bigserial            primary key,
  channel       notification_channel not null,
  student_id    bigint               references students (id) on delete cascade,
  event_id      smallint             references events (id) on delete cascade,
  template      text                 not null,   -- 'confirm' | 'reminder_d3' | 'reminder_d1' | 'morning'
  recipient     text                 not null,   -- email address or phone number
  payload       jsonb,                           -- template variables (name, lookup code, ...)
  status        notification_status  not null default 'queued',
  attempts      smallint             not null default 0,
  last_error    text,
  scheduled_at  timestamptz          not null default now(),
  sent_at       timestamptz,
  created_at    timestamptz          not null default now()
);

-- The worker's polling query: oldest due message first.
create index outbox_due on notification_outbox (scheduled_at)
  where status = 'queued';
create index outbox_by_student on notification_outbox (student_id, template);

-- One confirmation per student per event per channel. A double-submitted form
-- or a replayed request queues exactly one email and one SMS.
create unique index outbox_confirm_once
  on notification_outbox (student_id, event_id, channel, template)
  where template = 'confirm';

-- Atomically claim a batch for sending. SKIP LOCKED so two workers (or a
-- restarted worker overlapping its predecessor) never send the same row twice.
create or replace function claim_outbox_batch(p_limit integer default 20)
returns setof notification_outbox
language sql
security definer
set search_path = public
as $$
  update notification_outbox
     set status = 'sending', attempts = attempts + 1
   where id in (
     select id from notification_outbox
      where status = 'queued' and scheduled_at <= now()
      order by scheduled_at
        for update skip locked
      limit p_limit
   )
  returning *;
$$;

create or replace function finish_outbox(p_id bigint, p_ok boolean, p_error text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_ok then
    update notification_outbox
       set status = 'sent', sent_at = now(), last_error = null
     where id = p_id;
  else
    -- Exponential backoff: 1, 2, 4, 8... minutes, capped at 30. After 8
    -- attempts the row parks as failed and shows up in the admin's list
    -- instead of retrying forever against a dead address.
    update notification_outbox
       set status      = (case when attempts >= 8 then 'failed' else 'queued' end)::notification_status,
           last_error  = p_error,
           scheduled_at = now() + make_interval(
             mins => least(30, power(2, least(attempts, 5))::integer))
     where id = p_id;
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- Lookup-code generation (server side)
--
-- Same Crockford alphabet as @atl/qr-token. Codes are random across a ~1e9
-- space; uniqueness is enforced by the column's constraint and a retry loop in
-- register_student.
-- ----------------------------------------------------------------------------

create or replace function gen_lookup_code()
returns text
language sql
volatile
as $$
  select string_agg(
    substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + floor(random() * 32)::int, 1), '')
  from generate_series(1, 6);
$$;

-- ----------------------------------------------------------------------------
-- register_student — the single write path for the registration form
--
-- Returns one row describing what happened:
--   status = 'created'            new student + registration
--            'already_registered' this person already has a registration for
--                                 this event (the "gửi lại mã QR" flow)
--            'linked'             student existed (e.g. registered for another
--                                 event) — a registration for THIS event was added
--
-- The email/phone unique indexes are the backstop: two concurrent submits of
-- the same person race to insert, one wins, the loser lands in the conflict
-- handler and is told "already registered" instead of creating a twin.
-- ----------------------------------------------------------------------------

create or replace function register_student(
  p_event_id        smallint,
  p_full_name       text,
  p_email           text,
  p_phone           text,
  p_school_id       smallint  default null,
  p_school_other    text      default null,
  p_student_code    text      default null,
  p_major           text      default null,
  p_birth_year      smallint  default null,
  p_province_code   text      default null,
  p_employer        text      default null,
  p_gender          gender    default null,
  p_type            registration_type   default 'general',
  p_source          registration_source default 'online',
  p_consent_event   boolean   default false,
  p_consent_sponsors boolean  default false,
  p_consent_ip      inet      default null,
  p_consent_version text      default null,
  p_name_search_key text      default null
)
returns table (
  status       text,
  student_id   bigint,
  seq          integer,
  lookup_code  text
)
language plpgsql
security definer
set search_path = public
as $$
-- The OUT columns above are also PL/pgSQL variables, which would make bare
-- references like `on conflict (student_id, event_id)` ambiguous. Inside SQL
-- statements the column is always what is meant here.
#variable_conflict use_column
declare
  v_email       text;
  v_phone       text;
  v_student     students%rowtype;
  v_id          bigint;
  v_seq         integer;
  v_code        text;
  v_is_new      boolean := false;
  v_had_reg     boolean;
  v_try         integer;
begin
  -- Normalise identifiers before any lookup. The schema enforces lowercase
  -- email; doing it here means the API cannot forget.
  v_email := nullif(lower(trim(p_email)), '');
  v_phone := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '');

  if v_email is null and v_phone is null then
    raise exception 'Email hoặc số điện thoại là bắt buộc';
  end if;
  if p_consent_event is distinct from true then
    -- The mandatory consent is a legal requirement, not a UX preference.
    raise exception 'Chưa đồng ý điều khoản xử lý dữ liệu';
  end if;

  -- Find an existing person by either identifier.
  select * into v_student
    from students s
   where s.merged_into_id is null
     and ((v_email is not null and s.email = v_email)
       or (v_phone is not null and s.phone = v_phone))
   limit 1;

  if not found then
    -- New person. Seq comes from a dedicated sequence; the lookup code is
    -- random, retried on the (astronomically rare) collision.
    v_seq := nextval('student_seq_counter')::integer;
    v_try := 0;
    loop
      v_try := v_try + 1;
      v_code := gen_lookup_code();
      begin
        insert into students (seq, lookup_code, full_name, name_search_key, email, phone,
                              school_id, school_other, student_code, major, birth_year,
                              province_code, employer, gender,
                              consent_event_at, consent_event_ip,
                              consent_sponsors_at, consent_sponsors_ip,
                              consent_text_version)
        values (v_seq, v_code, trim(p_full_name),
                coalesce(p_name_search_key, lower(trim(p_full_name))),
                v_email, v_phone,
                p_school_id, p_school_other, nullif(trim(p_student_code), ''), p_major,
                p_birth_year, p_province_code, nullif(trim(p_employer), ''), p_gender,
                now(), p_consent_ip,
                case when p_consent_sponsors then now() end,
                case when p_consent_sponsors then p_consent_ip end,
                p_consent_version)
        returning id into v_id;
        v_is_new := true;
        exit;
      exception
        when unique_violation then
          -- Either the lookup code collided (retry with a new one) or a
          -- concurrent submit of the same person won the race (re-read and
          -- fall through to the existing-person path).
          select * into v_student
            from students s
           where s.merged_into_id is null
             and ((v_email is not null and s.email = v_email)
               or (v_phone is not null and s.phone = v_phone))
           limit 1;
          if found then
            v_id := v_student.id;
            v_seq := v_student.seq;
            v_code := v_student.lookup_code;
            exit;
          end if;
          if v_try >= 5 then
            raise; -- five random-code collisions in a row is not chance
          end if;
      end;
    end loop;
  else
    v_id := v_student.id;
    v_seq := v_student.seq;
    v_code := v_student.lookup_code;
  end if;

  -- Registration for THIS event, exactly once.
  insert into registrations (student_id, event_id, type, source)
  values (v_id, p_event_id, p_type, p_source)
  on conflict (student_id, event_id) do nothing;
  v_had_reg := not found;

  -- Queue the confirmation exactly once per channel. The partial unique index
  -- makes a double submit a no-op rather than a double email.
  if v_email is not null then
    insert into notification_outbox (channel, student_id, event_id, template, recipient, payload)
    values ('email', v_id, p_event_id, 'confirm', v_email,
            jsonb_build_object('full_name', trim(p_full_name), 'lookup_code', v_code, 'seq', v_seq))
    on conflict do nothing;
  end if;
  -- Only when the event has the SMS channel switched on (default: off).
  if v_phone is not null
     and (select e.sms_enabled from events e where e.id = p_event_id) then
    insert into notification_outbox (channel, student_id, event_id, template, recipient, payload)
    values ('sms', v_id, p_event_id, 'confirm', v_phone,
            jsonb_build_object('lookup_code', v_code))
    on conflict do nothing;
  end if;

  return query select
    case
      when v_had_reg then 'already_registered'
      when v_is_new  then 'created'
      else 'linked'
    end,
    v_id, v_seq, v_code;
end;
$$;

-- ----------------------------------------------------------------------------
-- register_team — two contestants, one atomic call
--
-- Both members register (or attach, if one already exists) and the team links
-- them. Badges stay individual; the team exists for the competition only.
-- ----------------------------------------------------------------------------

create or replace function register_team(
  p_event_id   smallint,
  p_team_name  text,
  p_member_a   jsonb,   -- same keys as register_student parameters, minus event/type
  p_member_b   jsonb,
  p_consent_ip inet default null,
  p_consent_version text default null
)
returns table (
  team_id      bigint,
  team_code    text,
  a_student_id bigint, a_lookup_code text,
  b_student_id bigint, b_lookup_code text
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_team_id   bigint;
  v_team_code text;
  v_a record;
  v_b record;
begin
  if p_member_a->>'email' is not distinct from p_member_b->>'email'
     and p_member_a->>'email' is not null then
    raise exception 'Hai thành viên không được dùng chung email';
  end if;

  select * into v_a from register_student(
    p_event_id,
    p_member_a->>'full_name', p_member_a->>'email', p_member_a->>'phone',
    (p_member_a->>'school_id')::smallint, p_member_a->>'school_other',
    p_member_a->>'student_code', p_member_a->>'major',
    (p_member_a->>'birth_year')::smallint, p_member_a->>'province_code',
    p_member_a->>'employer', (p_member_a->>'gender')::gender,
    'contestant', 'online',
    coalesce((p_member_a->>'consent_event')::boolean, false),
    coalesce((p_member_a->>'consent_sponsors')::boolean, false),
    p_consent_ip, p_consent_version,
    p_member_a->>'name_search_key');

  select * into v_b from register_student(
    p_event_id,
    p_member_b->>'full_name', p_member_b->>'email', p_member_b->>'phone',
    (p_member_b->>'school_id')::smallint, p_member_b->>'school_other',
    p_member_b->>'student_code', p_member_b->>'major',
    (p_member_b->>'birth_year')::smallint, p_member_b->>'province_code',
    p_member_b->>'employer', (p_member_b->>'gender')::gender,
    'contestant', 'online',
    coalesce((p_member_b->>'consent_event')::boolean, false),
    coalesce((p_member_b->>'consent_sponsors')::boolean, false),
    p_consent_ip, p_consent_version,
    p_member_b->>'name_search_key');

  if v_a.student_id = v_b.student_id then
    raise exception 'Hai thành viên trùng nhau';
  end if;

  -- Team code: short, readable, unique per event by retry.
  for i in 1..5 loop
    v_team_code := 'T' || gen_lookup_code();
    begin
      insert into teams (event_id, team_code, name)
      values (p_event_id, v_team_code, nullif(trim(p_team_name), ''))
      returning id into v_team_id;
      exit;
    exception when unique_violation then
      if i = 5 then raise; end if;
    end;
  end loop;

  update registrations set type = 'contestant', team_id = v_team_id
   where event_id = p_event_id and student_id in (v_a.student_id, v_b.student_id);

  return query select v_team_id, v_team_code,
                      v_a.student_id, v_a.lookup_code,
                      v_b.student_id, v_b.lookup_code;
end;
$$;

-- ═══════════ 0005_pg_devices.sql ═══════════
-- ============================================================================
-- ATL2026 — 0005 PG devices, staff, and the batch sync entry point.
--
-- PGs are casual staff hired days before the event, using their own phones.
-- The login model follows from that: a 6-character claim code printed on a
-- card, plus a 4-digit PIN they choose. No email, no password — forty password
-- resets on event morning is the scenario being designed out.
--
-- The device token is what authorises a sync. It is scoped to one event and
-- one zone, so a Finance-zone device cannot award Energy-zone badges even by
-- accident — which would silently corrupt the per-sponsor report they are
-- paying to receive.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Staff and devices
-- ----------------------------------------------------------------------------

create type pg_role as enum ('pg', 'supervisor');

create table pg_staff (
  id            serial      primary key,
  event_id      smallint    not null references events (id) on delete cascade,
  full_name     text        not null,
  phone         text,
  role          pg_role     not null default 'pg',
  created_at    timestamptz not null default now(),
  unique (id, event_id)
);
create index pg_staff_by_event on pg_staff (event_id);

create table pg_devices (
  id                serial      primary key,
  event_id          smallint    not null references events (id) on delete cascade,

  -- Printed on the device card handed out at the briefing. Same alphabet as
  -- the student lookup code so it can be read aloud without ambiguity.
  claim_code        text        not null unique
                                check (claim_code ~ '^[0-9A-HJKMNP-TV-Z]{6}$'),

  -- Opaque bearer token minted at claim time. Only the hash is stored: a
  -- database dump must not yield working device credentials.
  token_hash        text        unique,

  -- PIN is likewise hashed. It guards a phone left on a table, not a
  -- determined attacker — 4 digits is the right strength for that threat.
  pin_hash          text,

  pg_staff_id       integer,
  zone_id           integer,
  label             text,                       -- "PG-07", printed on the card

  -- Health telemetry for the supervisor board. The two numbers that matter on
  -- event day are last_sync_at and queue_depth: a device that has not synced
  -- for ten minutes needs a runner dispatched, and that is invisible without
  -- these columns.
  claimed_at        timestamptz,
  last_sync_at      timestamptz,
  queue_depth       integer     not null default 0,
  battery_pct       smallint,
  app_version       text,

  revoked_at        timestamptz,
  created_at        timestamptz not null default now(),

  foreign key (pg_staff_id, event_id) references pg_staff (id, event_id),
  foreign key (zone_id, event_id) references zones (id, event_id),
  unique (id, event_id)
);
create index pg_devices_by_event on pg_devices (event_id) where revoked_at is null;

-- Checkpoints a device may scan for. A device with no rows here may scan any
-- checkpoint in its zone; rows here narrow it further.
create table pg_device_checkpoints (
  device_id     integer  not null,
  checkpoint_id integer  not null,
  event_id      smallint not null,
  primary key (device_id, checkpoint_id),
  foreign key (device_id, event_id) references pg_devices (id, event_id) on delete cascade,
  foreign key (checkpoint_id, event_id) references checkpoints (id, event_id) on delete cascade
);

-- ----------------------------------------------------------------------------
-- Early Bird (AC12)
--
-- Arriving before a cut-off earns one extra badge, in the SAME scan — not a
-- second scan. The cut-off is per event because the two venues may open
-- differently, and it is nullable so the mechanic can be switched off without
-- a migration.
-- ----------------------------------------------------------------------------

alter table events add column early_bird_until timestamptz;
alter table events add column checkin_checkpoint_id integer;

-- Early Bird is awarded at its OWN checkpoint, not as a second badge at the
-- check-in one. That is not a workaround — the attendance unique index is
-- (event, student, checkpoint), so a second award at the same checkpoint is
-- correctly refused. Giving the bonus its own checkpoint reuses that exact
-- constraint to guarantee it can never be granted twice, and lets AIM decide
-- via counts_toward_badges whether it counts toward the gift ladder.
alter table events add column early_bird_checkpoint_id integer;

-- ----------------------------------------------------------------------------
-- Device claim
--
-- Called once per device at the briefing, on good wifi. Claiming is
-- idempotent per code: re-running with the same code re-issues a token to the
-- same device rather than erroring, because a PG who taps twice on a flaky
-- connection must not be locked out of their own device.
-- ----------------------------------------------------------------------------

create or replace function claim_pg_device(
  p_claim_code  text,
  p_token_hash  text,
  p_pin_hash    text,
  p_pg_staff_id integer default null,
  p_app_version text    default null
)
returns table (
  device_id     integer,
  event_id      smallint,
  label         text,
  zone_id       integer,
  zone_name     text,
  staff_name    text
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_dev pg_devices%rowtype;
begin
  select * into v_dev from pg_devices d
   where d.claim_code = upper(trim(p_claim_code)) and d.revoked_at is null;

  if not found then
    raise exception 'Mã thiết bị không hợp lệ hoặc đã bị thu hồi';
  end if;

  update pg_devices
     set token_hash  = p_token_hash,
         pin_hash    = coalesce(p_pin_hash, pin_hash),
         pg_staff_id = coalesce(p_pg_staff_id, pg_staff_id),
         app_version = coalesce(p_app_version, app_version),
         claimed_at  = coalesce(claimed_at, now())
   where id = v_dev.id;

  return query
    select d.id, d.event_id, d.label, d.zone_id, z.name, s.full_name
      from pg_devices d
      left join zones z on z.id = d.zone_id and z.event_id = d.event_id
      left join pg_staff s on s.id = d.pg_staff_id and s.event_id = d.event_id
     where d.id = v_dev.id;
end;
$$;

-- Resolve a bearer token to a device. Returns no rows for revoked or unknown
-- tokens, so every caller fails closed.
create or replace function resolve_pg_device(p_token_hash text)
returns table (
  device_id  integer,
  event_id   smallint,
  label      text,
  zone_id    integer,
  staff_name text
)
language sql
security definer
set search_path = public
as $$
  select d.id, d.event_id, d.label, d.zone_id, s.full_name
    from pg_devices d
    left join pg_staff s on s.id = d.pg_staff_id and s.event_id = d.event_id
   where d.token_hash = p_token_hash
     and d.revoked_at is null
     and d.claimed_at is not null;
$$;

-- ----------------------------------------------------------------------------
-- Roster snapshot for offline lookup
--
-- ~62 bytes per student. At 2,000 students that is ~124 KB raw, ~38 KB gzipped
-- — small enough to precache at the briefing and refresh by delta during the
-- day. `since` returns only rows changed after that moment, so a device that
-- has been offline for an hour catches up on walk-ins without re-downloading
-- everyone.
-- ----------------------------------------------------------------------------

create or replace function pg_roster(p_event_id smallint, p_since timestamptz default null)
returns table (
  seq          integer,
  lookup_code  text,
  name         text,
  name_key     text,
  mssv         text,
  phone        text,
  badge_count  integer,
  updated_at   timestamptz
)
language sql
security definer
set search_path = public
as $$
  select s.seq, s.lookup_code, s.full_name, s.name_search_key,
         s.student_code, s.phone, r.badge_count,
         greatest(s.updated_at, r.registered_at)
    from registrations r
    join students s on s.id = r.student_id
   where r.event_id = p_event_id
     and s.merged_into_id is null
     and (p_since is null or greatest(s.updated_at, r.registered_at) > p_since)
   order by greatest(s.updated_at, r.registered_at);
$$;

-- ----------------------------------------------------------------------------
-- record_pg_scan — the batch sync entry point
--
-- Wraps record_scan with the three things the scanner needs on top of it:
--
--   * device authorisation — a revoked device syncs nothing, and a device
--     cannot scan outside the checkpoints it is scoped to;
--   * student resolution by `seq` — the scanner only knows the number inside
--     the QR token, never the database id;
--   * Early Bird — the extra badge is awarded inside the same call, so it
--     cannot half-apply if the connection drops between two requests.
--
-- Returns one row per submitted scan, in the same order, so the client can
-- reconcile its queue item by item.
-- ----------------------------------------------------------------------------

create or replace function record_pg_scan(
  p_token_hash    text,
  p_scan_uid      uuid,
  p_student_seq   integer,
  p_checkpoint_id integer,
  p_client_ts     timestamptz default null,
  p_source        scan_source default 'pg_scan'
)
returns table (
  scan_uid     uuid,
  status       text,
  badge_count  integer,
  student_name text,
  awarded_at   timestamptz,
  early_bird   boolean
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_dev        record;
  v_student_id bigint;
  v_name       text;
  v_res        record;
  v_event      events%rowtype;
  v_eb         boolean := false;
  v_eb_uid     uuid;
  v_allowed    boolean;
begin
  select * into v_dev from resolve_pg_device(p_token_hash);
  if not found then
    return query select p_scan_uid, 'rejected_device'::text, 0, null::text,
                        null::timestamptz, false;
    return;
  end if;

  -- Scope check: if the device has an explicit checkpoint list, honour it.
  select (count(*) = 0 or bool_or(c.checkpoint_id = p_checkpoint_id)) into v_allowed
    from pg_device_checkpoints c where c.device_id = v_dev.device_id;
  if not v_allowed then
    return query select p_scan_uid, 'rejected_out_of_scope'::text, 0, null::text,
                        null::timestamptz, false;
    return;
  end if;

  select s.id, s.full_name into v_student_id, v_name
    from students s where s.seq = p_student_seq and s.merged_into_id is null;
  if v_student_id is null then
    return query select p_scan_uid, 'rejected_unknown_student'::text, 0, null::text,
                        null::timestamptz, false;
    return;
  end if;

  select * into v_res from record_scan(
    p_scan_uid, v_dev.event_id, v_student_id, p_checkpoint_id,
    p_source, v_dev.staff_name, v_dev.label, p_client_ts);

  -- Early Bird rides along on the check-in scan. Its scan_uid is derived from
  -- the original so a replayed batch produces the same derived id and the
  -- ledger's primary key absorbs the duplicate — no second badge.
  select * into v_event from events where id = v_dev.event_id;
  if v_res.status = 'counted'
     and v_event.early_bird_until is not null
     and v_event.early_bird_checkpoint_id is not null
     and v_event.checkin_checkpoint_id = p_checkpoint_id
     and coalesce(p_client_ts, now()) <= v_event.early_bird_until then
    v_eb_uid := uuid_in(md5(p_scan_uid::text || ':early_bird')::cstring);
    begin
      perform record_scan(v_eb_uid, v_dev.event_id, v_student_id,
                          v_event.early_bird_checkpoint_id,
                          'admin_manual'::scan_source, v_dev.staff_name, v_dev.label,
                          p_client_ts, jsonb_build_object('early_bird', true));
      v_eb := true;
    exception when others then
      -- Early Bird is a bonus; never let it fail the check-in it rides on.
      v_eb := false;
    end;
  end if;

  update pg_devices set last_sync_at = now() where id = v_dev.device_id;

  select r.badge_count into badge_count
    from registrations r
   where r.event_id = v_dev.event_id and r.student_id = v_student_id;

  return query select p_scan_uid, v_res.status::text, coalesce(badge_count, 0),
                      v_name, v_res.awarded_at, v_eb;
end;
$$;

-- Device health, reported alongside a sync so the supervisor board stays live
-- without a separate request.
create or replace function report_device_health(
  p_token_hash  text,
  p_queue_depth integer,
  p_battery_pct smallint default null
) returns void
language sql
security definer
set search_path = public
as $$
  update pg_devices
     set queue_depth = greatest(0, p_queue_depth),
         battery_pct = coalesce(p_battery_pct, battery_pct),
         last_sync_at = now()
   where token_hash = p_token_hash and revoked_at is null;
$$;

-- What the supervisor watches all day. Problems sort to the top.
create or replace view v_device_health as
select d.event_id, d.id as device_id, d.label, s.full_name as staff_name,
       z.name as zone_name, d.queue_depth, d.battery_pct, d.last_sync_at,
       extract(epoch from (now() - d.last_sync_at))::integer as seconds_since_sync,
       (d.last_sync_at is null or now() - d.last_sync_at > interval '10 minutes')
         as sync_alert,
       (d.battery_pct is not null and d.battery_pct < 20) as battery_alert
  from pg_devices d
  left join pg_staff s on s.id = d.pg_staff_id and s.event_id = d.event_id
  left join zones z on z.id = d.zone_id and z.event_id = d.event_id
 where d.revoked_at is null and d.claimed_at is not null
 order by sync_alert desc, battery_alert desc, d.queue_depth desc;

-- ═══════════ 0006_checkpoint_bonus_kind.sql ═══════════
-- ============================================================================
-- 0006 — checkpoint_kind 'bonus'
--
-- A 'bonus' checkpoint awards a badge that is NOT an activity: Early Bird,
-- Giờ Vàng ×2, and anything similar. The distinction matters because of the
-- two-ladder rule introduced in 0007 (Ver02 §025):
--
--   gift ladder  (bậc 1/2/3)      counts every badge, bonuses included
--   special ladder (Meet & Greet)  counts only real activities:
--                                  entrance check-in + sponsor booths
--
-- Early Bird was seeded as kind 'entrance', which would silently let a bonus
-- count as an activity. From now on every bonus-type checkpoint MUST use
-- kind = 'bonus'; 0007 backfills the ones we can identify.
--
-- This lives in its own file because a value added by ALTER TYPE cannot be
-- used inside the same transaction, and the migration runner executes each
-- file as one batch.
-- ============================================================================

alter type checkpoint_kind add value if not exists 'bonus';

-- ═══════════ 0007_two_ladders.sql ═══════════
-- ============================================================================
-- 0007 — two ladders (Ver02 §025, decided 25/08 with the client)
--
-- Ver02 adds: "Đã hết quà đặc biệt — những món số lượng có hạn mà chỉ tham gia
-- >70% hoạt động mới được nhận". AIM defined the denominator on 25/08: one
-- entrance check-in + one badge per booth, 5–7 booths, so N = 6–8 activities.
-- ">70%" is POLICY wording; what runs is the absolute number it works out to
-- (N=6..7 → ≥5, N=8 → ≥6), pinned once the booth list is final. No percentage
-- machinery in the schema — v_special_threshold_check below watches for the
-- configured y drifting away from the policy when a booth is added or pulled.
--
-- The decision that shapes this file: the two reward tracks count DIFFERENT
-- sets of badges.
--
--   gift ladder   (bậc 1/2/7 quà)   badge_count       — every badge: booths,
--                                   check-in, hall sessions, learning classes,
--                                   Early Bird, Giờ Vàng. Keeps lever #3
--                                   (session badges) alive and the gift order
--                                   1.750/430/90 unchanged.
--   special ladder (Meet & Greet,   core_badge_count  — entrance + sponsor
--                  quà đặc biệt)                        booths only. This is
--                                   what sponsors pay for: you cannot reach
--                                   the special tier without walking most of
--                                   the booths.
--
-- Both counters are denormalised on registrations and move in the same
-- transaction as the badge itself, same as badge_count always has.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The one place the rule lives. Everything below calls this; nothing inlines
-- its own kind list. 'bonus' checkpoints (Early Bird, Giờ Vàng) fail the kind
-- test; a booth an admin has toggled out of the game fails the boolean.
-- ----------------------------------------------------------------------------
create or replace function counts_toward_special(
  p_kind                 checkpoint_kind,
  p_counts_toward_badges boolean
) returns boolean
language sql
immutable
as $$
  select p_counts_toward_badges
     and p_kind in ('entrance', 'sponsor_booth', 'diamond_booth')
$$;

-- Backfill: any checkpoint already wired as an event's Early Bird target is a
-- bonus, whatever kind it was seeded with.
update checkpoints c
   set kind = 'bonus'
  from events e
 where e.early_bird_checkpoint_id = c.id
   and c.kind <> 'bonus';

alter table registrations
  add column core_badge_count integer not null default 0
    check (core_badge_count >= 0);

-- Core badges are a subset of counted badges, so the counter can never lead.
alter table registrations
  add constraint registrations_core_within_total
    check (core_badge_count <= badge_count);

-- ----------------------------------------------------------------------------
-- record_scan — same contract as 0002 (signature, statuses, return columns),
-- now maintaining both counters. The returned badge_count stays the gift-
-- ladder number: it is what a PG reads aloud at a booth.
-- ----------------------------------------------------------------------------
create or replace function record_scan(
  p_scan_uid      uuid,
  p_event_id      smallint,
  p_student_id    bigint,
  p_checkpoint_id integer,
  p_source        scan_source default 'pg_scan',
  p_pg_staff_id   text        default null,
  p_device_id     text        default null,
  p_client_ts     timestamptz default null,
  p_meta          jsonb       default null
)
returns table (status scan_status, badge_count integer, awarded_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing      ledger_events%rowtype;
  v_checkpoint    checkpoints%rowtype;
  v_status        scan_status;
  v_attendance_id bigint;
  v_awarded_at    timestamptz;
  v_counts        boolean;
  v_core          boolean;
  v_badge_count   integer;
  v_has_scan      boolean;
  v_has_survey    boolean;
  v_award         boolean := false;
begin
  -- Level 1: has this exact scan already been processed?
  select * into v_existing from ledger_events where scan_uid = p_scan_uid;
  if found then
    select r.badge_count into v_badge_count
      from registrations r
     where r.event_id = v_existing.event_id and r.student_id = v_existing.student_id;
    return query select 'replay'::scan_status, coalesce(v_badge_count, 0), v_existing.server_ts;
    return;
  end if;

  select * into v_checkpoint
    from checkpoints
   where id = p_checkpoint_id and event_id = p_event_id;

  if not found or not v_checkpoint.is_active then
    insert into ledger_events (scan_uid, event_id, student_id, checkpoint_id, source,
                               status, pg_staff_id, device_id, client_ts, meta)
    values (p_scan_uid, p_event_id, p_student_id, null, p_source,
            'rejected_checkpoint_closed', p_pg_staff_id, p_device_id, p_client_ts, p_meta);
    return query select 'rejected_checkpoint_closed'::scan_status, 0, null::timestamptz;
    return;
  end if;

  -- The student must be registered for THIS event. A walk-in is registered by
  -- the door flow before their first scan, so this is a real error, not a
  -- routine case.
  perform 1 from registrations
   where event_id = p_event_id and student_id = p_student_id;
  if not found then
    insert into ledger_events (scan_uid, event_id, student_id, checkpoint_id, source,
                               status, pg_staff_id, device_id, client_ts, meta)
    values (p_scan_uid, p_event_id, p_student_id, p_checkpoint_id, p_source,
            'rejected_not_registered', p_pg_staff_id, p_device_id, p_client_ts, p_meta);
    return query select 'rejected_not_registered'::scan_status, 0, null::timestamptz;
    return;
  end if;

  -- Does this source satisfy the checkpoint's award rule?
  case v_checkpoint.badge_award_mode
    when 'pg_scan' then
      v_award := p_source in ('pg_scan', 'student_scan', 'admin_manual', 'walk_in');
    when 'survey_complete' then
      v_award := p_source in ('survey', 'admin_manual');
    when 'either' then
      v_award := true;
    when 'both_required' then
      -- Award only once both halves are on record. Check the ledger for the
      -- counterpart, treating this in-flight scan as already present.
      v_has_scan := p_source in ('pg_scan', 'student_scan', 'walk_in') or exists (
        select 1 from ledger_events
         where event_id = p_event_id and student_id = p_student_id
           and checkpoint_id = p_checkpoint_id
           and source in ('pg_scan', 'student_scan', 'walk_in')
      );
      v_has_survey := p_source = 'survey' or exists (
        select 1 from ledger_events
         where event_id = p_event_id and student_id = p_student_id
           and checkpoint_id = p_checkpoint_id
           and source = 'survey'
      );
      v_award := (v_has_scan and v_has_survey) or p_source = 'admin_manual';
  end case;

  -- Level 2: try to claim the badge. ON CONFLICT DO NOTHING against the partial
  -- unique index is the atomic step — no read-then-write, so no race.
  if v_award then
    insert into attendance (event_id, student_id, checkpoint_id, first_scan_uid, source)
    values (p_event_id, p_student_id, p_checkpoint_id, p_scan_uid, p_source)
    on conflict (event_id, student_id, checkpoint_id) where voided_at is null
    do nothing
    returning id, attendance.awarded_at into v_attendance_id, v_awarded_at;

    if v_attendance_id is not null then
      v_status := 'counted';
    else
      v_status := 'repeat_not_counted';
      select a.awarded_at into v_awarded_at
        from attendance a
       where a.event_id = p_event_id and a.student_id = p_student_id
         and a.checkpoint_id = p_checkpoint_id and a.voided_at is null;
    end if;
  else
    v_status := 'pending_other_condition';
  end if;

  insert into ledger_events (scan_uid, event_id, student_id, checkpoint_id, source,
                             status, pg_staff_id, device_id, client_ts, meta)
  values (p_scan_uid, p_event_id, p_student_id, p_checkpoint_id, p_source,
          v_status, p_pg_staff_id, p_device_id, p_client_ts, p_meta);

  -- Counters and rollup move in the same transaction as the badge, so a reader
  -- can never observe a badge that is not yet counted. Core implies counted
  -- (the helper requires counts_toward_badges), so one guard covers both.
  v_counts := v_checkpoint.counts_toward_badges;
  v_core   := counts_toward_special(v_checkpoint.kind, v_checkpoint.counts_toward_badges);

  if v_status = 'counted' and v_counts then
    -- Both sides qualified: `badge_count` is also the name of an OUT column of
    -- this function, and an unqualified reference is ambiguous.
    update registrations
       set badge_count      = registrations.badge_count + 1,
           core_badge_count = registrations.core_badge_count
                              + (case when v_core then 1 else 0 end)
     where event_id = p_event_id and student_id = p_student_id
    returning registrations.badge_count into v_badge_count;
  else
    select r.badge_count into v_badge_count
      from registrations r
     where r.event_id = p_event_id and r.student_id = p_student_id;
  end if;

  insert into checkpoint_minute_counts (checkpoint_id, event_id, minute_ts, badge_count, scan_count)
  values (p_checkpoint_id, p_event_id, date_trunc('minute', now()),
          case when v_status = 'counted' then 1 else 0 end, 1)
  on conflict (checkpoint_id, minute_ts) do update
     set badge_count = checkpoint_minute_counts.badge_count + excluded.badge_count,
         scan_count  = checkpoint_minute_counts.scan_count + excluded.scan_count;

  return query select v_status, coalesce(v_badge_count, 0), v_awarded_at;
end;
$$;

-- ----------------------------------------------------------------------------
-- Rebuilds — recompute BOTH counters from the ledger. Return value stays the
-- gift-ladder count so 0002's void_attendance keeps working unchanged.
-- ----------------------------------------------------------------------------
create or replace function rebuild_student_progress(p_event_id smallint, p_student_id bigint)
returns integer
language plpgsql as $$
declare
  v_count integer;
  v_core  integer;
begin
  select count(*) filter (where c.counts_toward_badges)::integer,
         count(*) filter (where counts_toward_special(c.kind, c.counts_toward_badges))::integer
    into v_count, v_core
    from attendance a
    join checkpoints c on c.id = a.checkpoint_id and c.event_id = a.event_id
   where a.event_id = p_event_id
     and a.student_id = p_student_id
     and a.voided_at is null;

  update registrations
     set badge_count = v_count, core_badge_count = v_core
   where event_id = p_event_id and student_id = p_student_id;

  return v_count;
end;
$$;

create or replace function rebuild_all_progress(p_event_id smallint)
returns integer
language plpgsql as $$
declare
  v_rows integer;
begin
  with truth as (
    select r.student_id,
           count(a.id) filter (where c.counts_toward_badges) as real_count,
           count(a.id) filter (where counts_toward_special(c.kind, c.counts_toward_badges))
             as real_core
      from registrations r
      left join attendance a
        on a.event_id = r.event_id and a.student_id = r.student_id and a.voided_at is null
      left join checkpoints c
        on c.id = a.checkpoint_id and c.event_id = a.event_id
     where r.event_id = p_event_id
     group by r.student_id
  )
  update registrations r
     set badge_count = t.real_count, core_badge_count = t.real_core
    from truth t
   where r.event_id = p_event_id
     and r.student_id = t.student_id
     and (r.badge_count is distinct from t.real_count
          or r.core_badge_count is distinct from t.real_core);

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- Drift view — same shape as 0002 with the core pair appended (CREATE OR
-- REPLACE VIEW may only add columns at the end). A row means SOME counter has
-- diverged from the ledger; which pair differs says which one.
create or replace view v_progress_drift as
select r.event_id,
       r.student_id,
       r.badge_count as stored_count,
       count(a.id) filter (where c.counts_toward_badges) as real_count,
       r.core_badge_count as stored_core,
       count(a.id) filter (where counts_toward_special(c.kind, c.counts_toward_badges))
         as real_core
  from registrations r
  left join attendance a
    on a.event_id = r.event_id and a.student_id = r.student_id and a.voided_at is null
  left join checkpoints c
    on c.id = a.checkpoint_id and c.event_id = a.event_id
 group by r.event_id, r.student_id, r.badge_count, r.core_badge_count
having r.badge_count is distinct from count(a.id) filter (where c.counts_toward_badges)
    or r.core_badge_count is distinct from
       count(a.id) filter (where counts_toward_special(c.kind, c.counts_toward_badges));

-- ----------------------------------------------------------------------------
-- hold_special_slot — byte-for-byte 0003 except eligibility now reads the
-- special ladder. A student with seven session badges and two booth badges is
-- rich on the gift ladder and NOT eligible here; that asymmetry is the point.
-- ----------------------------------------------------------------------------
create or replace function hold_special_slot(
  p_event_id            smallint,
  p_student_id          bigint,
  p_special_activity_id integer,
  p_hold_seconds        integer default 90
)
returns table (result text, slot_no integer, held_until timestamptz, remaining integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_act         special_activities%rowtype;
  v_threshold   smallint;
  v_limit       smallint;
  v_badges      integer;
  v_used        integer;
  v_slot_id     bigint;
  v_slot_no     integer;
  v_until       timestamptz;
  v_remaining   integer;
begin
  select * into v_act
    from special_activities where id = p_special_activity_id and event_id = p_event_id;
  if not found or not v_act.is_open then
    return query select 'closed'::text, null::integer, null::timestamptz, 0;
    return;
  end if;

  select e.special_threshold_y, e.special_claim_limit into v_threshold, v_limit
    from events e where e.id = p_event_id;

  -- The special ladder: entrance + sponsor booths only (Ver02 §025).
  select r.core_badge_count into v_badges
    from registrations r
   where r.event_id = p_event_id and r.student_id = p_student_id;
  if v_badges is null then
    return query select 'not_registered'::text, null::integer, null::timestamptz, 0;
    return;
  end if;

  if v_badges < v_threshold then
    return query select 'not_eligible'::text, null::integer, null::timestamptz, 0;
    return;
  end if;

  -- Already holding or holding-and-claimed a slot here?
  select s.slot_no, s.held_until into v_slot_no, v_until
    from special_slots s
   where s.special_activity_id = p_special_activity_id
     and (s.student_id = p_student_id
          or (s.held_by_student_id = p_student_id and s.held_until > now()));
  if found then
    return query select 'already_held'::text, v_slot_no, v_until, 0;
    return;
  end if;

  -- z: how many special activities this student may take in total.
  select count(*)::integer into v_used
    from special_slots s
   where s.event_id = p_event_id
     and (s.student_id = p_student_id
          or (s.held_by_student_id = p_student_id and s.held_until > now()));
  if v_used >= v_limit then
    return query select 'limit_reached'::text, null::integer, null::timestamptz, 0;
    return;
  end if;

  -- The allocation. SKIP LOCKED means concurrent claimants take different rows
  -- rather than serialising, and an expired hold is reclaimed here rather than
  -- needing a sweeper to have run first.
  update special_slots
     set held_by_student_id = p_student_id,
         held_until = now() + make_interval(secs => p_hold_seconds)
   where id = (
     select s.id from special_slots s
      where s.special_activity_id = p_special_activity_id
        and s.student_id is null
        and (s.held_until is null or s.held_until <= now())
      order by s.slot_no
        for update skip locked
      limit 1
   )
  returning special_slots.id, special_slots.slot_no, special_slots.held_until
       into v_slot_id, v_slot_no, v_until;

  if v_slot_id is null then
    return query select 'sold_out'::text, null::integer, null::timestamptz, 0;
    return;
  end if;

  select count(*)::integer into v_remaining
    from special_slots s
   where s.special_activity_id = p_special_activity_id
     and s.student_id is null
     and (s.held_until is null or s.held_until <= now());

  return query select 'held'::text, v_slot_no, v_until, v_remaining;
end;
$$;

-- Control panel: the eligibility headcount switches to the special ladder —
-- this is the number AIM watches to decide whether Meet & Greet will fill.
create or replace view v_special_control_panel as
select sa.event_id,
       sa.id   as special_activity_id,
       sa.name,
       sa.capacity,
       count(*) filter (where s.student_id is not null)                     as claimed,
       count(*) filter (where s.student_id is null
                          and s.held_until > now())                          as on_hold,
       count(*) filter (where s.student_id is null
                          and (s.held_until is null or s.held_until <= now())) as available,
       (select count(*) from registrations r
         where r.event_id = sa.event_id
           and r.core_badge_count >= (select e.special_threshold_y
                                        from events e where e.id = sa.event_id)) as students_eligible
  from special_activities sa
  join special_slots s on s.special_activity_id = sa.id
 group by sa.event_id, sa.id, sa.name, sa.capacity;

-- ----------------------------------------------------------------------------
-- The ">70%" watchdog. AIM's rule is a percentage of activities; the runtime
-- threshold is events.special_threshold_y. When a sponsor booth is added or
-- pulled in the final week the two drift apart — this view is the alarm.
-- ">70% of N" = the smallest integer strictly greater than 0.7·N.
-- Deliberately NOT auto-applied: changing y mid-event is a human decision
-- (never revoke granted rights), the view just makes the gap visible.
-- ----------------------------------------------------------------------------
create or replace view v_special_threshold_check as
select e.id as event_id,
       count(c.id)::integer as core_checkpoints,
       (floor(0.7 * count(c.id)) + 1)::integer as implied_threshold,
       e.special_threshold_y::integer as configured_threshold,
       e.special_threshold_y is distinct from (floor(0.7 * count(c.id)) + 1)::smallint
         as mismatch
  from events e
  left join checkpoints c
    on c.event_id = e.id
   and c.is_active
   and counts_toward_special(c.kind, c.counts_toward_badges)
 group by e.id, e.special_threshold_y;

-- ═══════════ 0008_golden_hours.sql ═══════════
-- ============================================================================
-- 0008 — Giờ Vàng (AC17)
--
-- A demand-shaping lever: when a zone sits idle, a supervisor opens a golden
-- hour there and every student earning a booth badge in that zone gets ONE
-- extra bonus badge — felt as "×2". It exists to fill wasted booth capacity
-- without creating a new rush, so its guardrails are the design:
--
--   * three caps, all DB predicates, never client timers:
--       40 minutes  · 80 badges per activation · 300 per event day
--     The 300 matters most: thresholds 2/5/7 were computed from a 6,025-badge
--     supply that already includes this budget. Exceeding it silently
--     invalidates the gift order.
--   * one active golden hour per event at a time — MC and signage cannot
--     narrate two at once, and narrow targeting is the point.
--   * one bonus per student per zone per day — enforced by the same
--     (event, student, checkpoint) unique index as every other badge, because
--     the bonus lands on a per-zone checkpoint of kind 'bonus'. No second
--     dedup mechanism.
--   * bonus badges ride the GIFT ladder only. kind 'bonus' is excluded from
--     the special ladder by 0007's rule, so ×2 cannot buy a Meet & Greet seat
--     and AIM's ">70% of activities" stays meaningful.
--
-- The award happens inside record_pg_scan — same pattern as Early Bird — so
-- it cannot half-apply when a connection drops between two requests, and a
-- replayed offline batch derives the same bonus scan_uid and is absorbed by
-- the ledger's primary key.
-- ============================================================================

alter table events add column golden_budget smallint not null default 300
  check (golden_budget >= 0);
alter table events add column golden_issued integer not null default 0
  check (golden_issued >= 0);

create table golden_hours (
  id                   serial      primary key,
  event_id             smallint    not null references events (id) on delete cascade,
  zone_id              integer     not null,
  bonus_checkpoint_id  integer     not null,
  badge_cap            smallint    not null default 80 check (badge_cap > 0),
  badges_issued        integer     not null default 0 check (badges_issued >= 0),
  started_at           timestamptz not null default now(),
  ends_at              timestamptz not null,
  started_by           text        not null,
  closed_at            timestamptz,
  closed_by            text,

  foreign key (zone_id, event_id) references zones (id, event_id),
  foreign key (bonus_checkpoint_id, event_id) references checkpoints (id, event_id),
  check (ends_at > started_at),
  check (badges_issued <= badge_cap)
);

-- One open activation per event. Time expiry leaves closed_at null, so
-- activate_golden_hour sweeps expired rows shut before checking this.
create unique index golden_one_open_per_event
  on golden_hours (event_id) where closed_at is null;

create index golden_by_zone on golden_hours (event_id, zone_id);

-- ----------------------------------------------------------------------------
-- Activation / close. Both audited. Activation lazily creates the zone's
-- bonus checkpoint on first use and reuses it forever after — that reuse is
-- what makes "one bonus per student per zone per day" fall out of the
-- existing unique index instead of new bookkeeping.
-- ----------------------------------------------------------------------------
create or replace function activate_golden_hour(
  p_event_id smallint,
  p_zone_id  integer,
  p_actor    text,
  p_minutes  integer default 40,
  p_cap      integer default 80
)
returns table (result text, golden_id integer, ends_at timestamptz, budget_left integer)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_zone     zones%rowtype;
  v_ev       events%rowtype;
  v_cp_id    integer;
  v_id       integer;
  v_ends     timestamptz;
begin
  if p_actor is null or length(trim(p_actor)) = 0 then
    raise exception 'Cần tên người kích hoạt';
  end if;
  if p_minutes not between 5 and 120 or p_cap not between 1 and 500 then
    raise exception 'Tham số ngoài khoảng cho phép';
  end if;

  select * into v_zone from zones where id = p_zone_id and event_id = p_event_id;
  if not found then
    return query select 'unknown_zone'::text, null::integer, null::timestamptz, 0;
    return;
  end if;

  -- Sweep: a time- or cap-expired activation is closed here rather than by a
  -- background job. "Closed" is written at the moment anyone next cares.
  update golden_hours
     set closed_at = least(now(), ends_at), closed_by = '(tự đóng)'
   where event_id = p_event_id and closed_at is null
     and (now() >= ends_at or badges_issued >= badge_cap);

  if exists (select 1 from golden_hours
              where event_id = p_event_id and closed_at is null) then
    return query select 'already_active'::text, null::integer, null::timestamptz, 0;
    return;
  end if;

  select * into v_ev from events where id = p_event_id;
  if v_ev.golden_issued >= v_ev.golden_budget then
    return query select 'budget_exhausted'::text, null::integer, null::timestamptz, 0;
    return;
  end if;

  -- Reuse the zone's bonus checkpoint from any earlier activation; create on
  -- first use.
  select gh.bonus_checkpoint_id into v_cp_id
    from golden_hours gh
   where gh.event_id = p_event_id and gh.zone_id = p_zone_id
   order by gh.id limit 1;
  if v_cp_id is null then
    insert into checkpoints (event_id, zone_id, kind, name, counts_toward_badges,
                             badge_award_mode, display_order)
    values (p_event_id, p_zone_id, 'bonus', 'Giờ Vàng — ' || v_zone.name, true,
            'pg_scan', 90)
    returning id into v_cp_id;
  end if;

  v_ends := now() + make_interval(mins => p_minutes);
  insert into golden_hours (event_id, zone_id, bonus_checkpoint_id, badge_cap,
                            ends_at, started_by)
  values (p_event_id, p_zone_id, v_cp_id, p_cap, v_ends, trim(p_actor))
  returning id into v_id;

  insert into audit_log (event_id, actor_type, actor_id, action, target_type, target_id,
                         after_state)
  values (p_event_id, 'super_admin', trim(p_actor), 'golden_hour_start', 'zone',
          p_zone_id::text,
          jsonb_build_object('golden_id', v_id, 'minutes', p_minutes, 'cap', p_cap));

  return query select 'ok'::text, v_id, v_ends,
                      (v_ev.golden_budget - v_ev.golden_issued)::integer;
end;
$$;

create or replace function close_golden_hour(p_event_id smallint, p_actor text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id integer;
begin
  update golden_hours
     set closed_at = now(), closed_by = coalesce(trim(p_actor), 'admin')
   where event_id = p_event_id and closed_at is null
  returning id into v_id;

  if v_id is not null then
    insert into audit_log (event_id, actor_type, actor_id, action, target_type, target_id)
    values (p_event_id, 'super_admin', coalesce(trim(p_actor), 'admin'),
            'golden_hour_close', 'golden_hour', v_id::text);
  end if;
  return v_id;
end;
$$;

-- What the dashboard shows. `active` folds in all three caps so the UI never
-- re-implements the rules.
create or replace view v_golden_status as
select gh.event_id, gh.id as golden_id, gh.zone_id, z.name as zone_name,
       gh.badge_cap, gh.badges_issued, gh.started_at, gh.ends_at, gh.started_by,
       gh.closed_at,
       (gh.closed_at is null and now() < gh.ends_at
         and gh.badges_issued < gh.badge_cap)                    as active,
       greatest(0, extract(epoch from (gh.ends_at - now()))::integer) as seconds_left,
       e.golden_budget, e.golden_issued,
       (e.golden_budget - e.golden_issued)                        as budget_left
  from golden_hours gh
  join zones z on z.id = gh.zone_id and z.event_id = gh.event_id
  join events e on e.id = gh.event_id;

-- ----------------------------------------------------------------------------
-- record_pg_scan, now returning `golden` alongside `early_bird`. The return
-- type changes, so the old function must be dropped, not replaced.
-- ----------------------------------------------------------------------------
drop function if exists record_pg_scan(text, uuid, integer, integer, timestamptz, scan_source);

create function record_pg_scan(
  p_token_hash    text,
  p_scan_uid      uuid,
  p_student_seq   integer,
  p_checkpoint_id integer,
  p_client_ts     timestamptz default null,
  p_source        scan_source default 'pg_scan'
)
returns table (
  scan_uid     uuid,
  status       text,
  badge_count  integer,
  student_name text,
  awarded_at   timestamptz,
  early_bird   boolean,
  golden       boolean
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_dev        record;
  v_student_id bigint;
  v_name       text;
  v_res        record;
  v_gres       record;
  v_event      events%rowtype;
  v_gh         golden_hours%rowtype;
  v_eb         boolean := false;
  v_gold       boolean := false;
  v_eb_uid     uuid;
  v_g_uid      uuid;
  v_allowed    boolean;
begin
  select * into v_dev from resolve_pg_device(p_token_hash);
  if not found then
    return query select p_scan_uid, 'rejected_device'::text, 0, null::text,
                        null::timestamptz, false, false;
    return;
  end if;

  -- Scope check: if the device has an explicit checkpoint list, honour it.
  select (count(*) = 0 or bool_or(c.checkpoint_id = p_checkpoint_id)) into v_allowed
    from pg_device_checkpoints c where c.device_id = v_dev.device_id;
  if not v_allowed then
    return query select p_scan_uid, 'rejected_out_of_scope'::text, 0, null::text,
                        null::timestamptz, false, false;
    return;
  end if;

  select s.id, s.full_name into v_student_id, v_name
    from students s where s.seq = p_student_seq and s.merged_into_id is null;
  if v_student_id is null then
    return query select p_scan_uid, 'rejected_unknown_student'::text, 0, null::text,
                        null::timestamptz, false, false;
    return;
  end if;

  select * into v_res from record_scan(
    p_scan_uid, v_dev.event_id, v_student_id, p_checkpoint_id,
    p_source, v_dev.staff_name, v_dev.label, p_client_ts);

  select * into v_event from events where id = v_dev.event_id;

  -- Early Bird rides along on the check-in scan. Its scan_uid is derived from
  -- the original so a replayed batch produces the same derived id and the
  -- ledger's primary key absorbs the duplicate — no second badge.
  if v_res.status = 'counted'
     and v_event.early_bird_until is not null
     and v_event.early_bird_checkpoint_id is not null
     and v_event.checkin_checkpoint_id = p_checkpoint_id
     and coalesce(p_client_ts, now()) <= v_event.early_bird_until then
    v_eb_uid := uuid_in(md5(p_scan_uid::text || ':early_bird')::cstring);
    begin
      perform record_scan(v_eb_uid, v_dev.event_id, v_student_id,
                          v_event.early_bird_checkpoint_id,
                          'admin_manual'::scan_source, v_dev.staff_name, v_dev.label,
                          p_client_ts, jsonb_build_object('early_bird', true));
      v_eb := true;
    exception when others then
      -- Early Bird is a bonus; never let it fail the check-in it rides on.
      v_eb := false;
    end;
  end if;

  -- Giờ Vàng: a counted BOOTH badge in the golden zone earns one bonus badge,
  -- subject to all three caps. Order matters and is deliberate:
  --   1. cheap exists-check (also swallows replays — the derived uid's badge
  --      is already on file),
  --   2. take the day budget, then the activation cap — both row-locked
  --      predicates, so concurrent scanners serialise on the counters,
  --   3. only then write the badge; if it still loses a same-student race,
  --      give both counters back in this same transaction.
  if v_res.status = 'counted' then
    select gh.* into v_gh
      from golden_hours gh
      join checkpoints c on c.id = p_checkpoint_id and c.event_id = v_dev.event_id
     where gh.event_id = v_dev.event_id
       and gh.zone_id = c.zone_id
       and gh.closed_at is null
       and now() < gh.ends_at
       and gh.badges_issued < gh.badge_cap
       and c.kind in ('sponsor_booth', 'diamond_booth');

    if found then
      perform 1 from attendance a
        where a.event_id = v_dev.event_id and a.student_id = v_student_id
          and a.checkpoint_id = v_gh.bonus_checkpoint_id and a.voided_at is null;

      if not found then
        update events set golden_issued = golden_issued + 1
         where id = v_dev.event_id and golden_issued < golden_budget;

        if found then
          update golden_hours set badges_issued = badges_issued + 1
           where id = v_gh.id and closed_at is null
             and now() < ends_at and badges_issued < badge_cap;

          if found then
            v_g_uid := uuid_in(md5(p_scan_uid::text || ':golden')::cstring);
            begin
              select * into v_gres from record_scan(
                v_g_uid, v_dev.event_id, v_student_id, v_gh.bonus_checkpoint_id,
                'pg_scan'::scan_source, v_dev.staff_name, v_dev.label,
                p_client_ts, jsonb_build_object('golden_hour', v_gh.id));
              if v_gres.status = 'counted' then
                v_gold := true;
              else
                update events set golden_issued = golden_issued - 1
                 where id = v_dev.event_id;
                update golden_hours set badges_issued = badges_issued - 1
                 where id = v_gh.id;
              end if;
            exception when others then
              update events set golden_issued = golden_issued - 1
               where id = v_dev.event_id;
              update golden_hours set badges_issued = badges_issued - 1
               where id = v_gh.id;
            end;
          else
            update events set golden_issued = golden_issued - 1
             where id = v_dev.event_id;
          end if;
        end if;
      end if;
    end if;
  end if;

  update pg_devices set last_sync_at = now() where id = v_dev.device_id;

  select r.badge_count into badge_count
    from registrations r
   where r.event_id = v_dev.event_id and r.student_id = v_student_id;

  return query select p_scan_uid, v_res.status::text, coalesce(badge_count, 0),
                      v_name, v_res.awarded_at, v_eb, v_gold;
end;
$$;

-- ═══════════ 0009_clone_event.sql ═══════════
-- ============================================================================
-- 0009 — clone_event (AC28)
--
-- Grand Finale 01/11 and every season after must be one action, not a
-- redeploy: copy an event's CONFIGURATION — zones, checkpoints, gift tiers,
-- special activities, thresholds — never its people or its history.
--
-- What deliberately does NOT copy:
--   * students / registrations / ledger / redemptions — one person keeps one
--     QR across the campaign; they register into the new event through the
--     normal flow, which links them (status 'linked') instead of duplicating.
--   * counters: stock_issued, golden_issued, badges — a new event starts at 0.
--   * golden_hours rows and Early Bird cutoff — tied to a specific day.
--   * is_registration_open — a clone is born CLOSED; opening it is an
--     explicit, separate decision.
--
-- Checkpoint times shift by the difference between the two events' start
-- times, so an agenda built for 12/09 lands correctly shaped on 01/11.
-- ============================================================================

create or replace function clone_event(
  p_source_id smallint,
  p_slug      text,
  p_name      text,
  p_venue     text,
  p_city      text,
  p_starts_at timestamptz,
  p_ends_at   timestamptz,
  p_actor     text
)
returns table (new_event_id smallint, zones_copied integer, checkpoints_copied integer,
               tiers_copied integer, specials_copied integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_src        events%rowtype;
  v_new_id     smallint;
  v_shift      interval;
  v_zones      integer := 0;
  v_cps        integer := 0;
  v_tiers      integer := 0;
  v_specials   integer := 0;
  v_new_checkin integer;
  v_new_eb      integer;
  r             record;
  v_zone_map    jsonb := '{}'::jsonb;   -- old zone id -> new zone id
  v_cp_map      jsonb := '{}'::jsonb;   -- old checkpoint id -> new id
  v_new_zone    integer;
  v_new_cp      integer;
  v_new_act     integer;
begin
  if p_actor is null or length(trim(p_actor)) = 0 then
    raise exception 'Cần tên người thao tác';
  end if;

  select * into v_src from events where id = p_source_id;
  if not found then
    raise exception 'Sự kiện nguồn % không tồn tại', p_source_id;
  end if;

  -- Self-defence against the explicit-id trap (bitten five times by 26/08):
  -- rows seeded or imported with explicit ids never advance the serial
  -- sequences, and this function inserts WITHOUT ids. Bump every sequence it
  -- relies on past its table's max, so a clone works no matter how the
  -- source data got in.
  perform setval(pg_get_serial_sequence('zones', 'id'),
                 (select coalesce(max(id), 0) + 1 from zones), false);
  perform setval(pg_get_serial_sequence('checkpoints', 'id'),
                 (select coalesce(max(id), 0) + 1 from checkpoints), false);
  perform setval(pg_get_serial_sequence('gift_tiers', 'id'),
                 (select coalesce(max(id), 0) + 1 from gift_tiers), false);
  perform setval(pg_get_serial_sequence('special_activities', 'id'),
                 (select coalesce(max(id), 0) + 1 from special_activities), false);

  -- events.id is the QR token byte: assigned, never serial. Take the next
  -- free byte value.
  select coalesce(max(id), 0) + 1 into v_new_id from events;
  if v_new_id > 255 then
    raise exception 'Hết chỗ id sự kiện (byte token 1..255)';
  end if;

  v_shift := p_starts_at - v_src.starts_at;

  insert into events (id, edition_id, kind, slug, name, venue_name, city,
                      starts_at, ends_at, timezone,
                      gift_ladder_mode, special_threshold_y, special_claim_limit,
                      token_key_id, is_registration_open,
                      golden_budget, golden_issued, sms_enabled)
  values (v_new_id, v_src.edition_id, v_src.kind, p_slug, p_name, p_venue, p_city,
          p_starts_at, p_ends_at, v_src.timezone,
          v_src.gift_ladder_mode, v_src.special_threshold_y, v_src.special_claim_limit,
          v_src.token_key_id, false,
          v_src.golden_budget, 0, false);

  for r in select * from zones where event_id = p_source_id order by id loop
    insert into zones (event_id, name, color_hex, display_order)
    values (v_new_id, r.name, r.color_hex, r.display_order)
    returning id into v_new_zone;
    v_zone_map := v_zone_map || jsonb_build_object(r.id::text, v_new_zone);
    v_zones := v_zones + 1;
  end loop;

  for r in select * from checkpoints where event_id = p_source_id order by id loop
    insert into checkpoints (event_id, zone_id, kind, name, description, location_hint,
                             starts_at, ends_at, capacity, counts_toward_badges,
                             badge_award_mode, allow_student_scan, display_order, is_active)
    values (v_new_id,
            case when r.zone_id is null then null
                 else (v_zone_map ->> r.zone_id::text)::integer end,
            r.kind, r.name, r.description, r.location_hint,
            r.starts_at + v_shift, r.ends_at + v_shift,
            r.capacity, r.counts_toward_badges,
            r.badge_award_mode, r.allow_student_scan, r.display_order, r.is_active)
    returning id into v_new_cp;
    v_cp_map := v_cp_map || jsonb_build_object(r.id::text, v_new_cp);
    v_cps := v_cps + 1;
  end loop;

  -- Re-point the wired checkpoints through the map. Early Bird cutoff stays
  -- NULL — it is a time of a specific morning, set when that morning is real.
  v_new_checkin := (v_cp_map ->> v_src.checkin_checkpoint_id::text)::integer;
  v_new_eb      := (v_cp_map ->> v_src.early_bird_checkpoint_id::text)::integer;
  update events
     set checkin_checkpoint_id = v_new_checkin,
         early_bird_checkpoint_id = v_new_eb,
         early_bird_until = null
   where id = v_new_id;

  for r in select * from gift_tiers where event_id = p_source_id order by tier loop
    insert into gift_tiers (event_id, tier, required_badges, gift_name,
                            stock_total, stock_issued, is_active)
    values (v_new_id, r.tier, r.required_badges, r.gift_name,
            r.stock_total, 0, r.is_active);
    v_tiers := v_tiers + 1;
  end loop;

  for r in select * from special_activities where event_id = p_source_id order by id loop
    insert into special_activities (event_id, name, capacity, is_open)
    values (v_new_id, r.name, r.capacity, false)
    returning id into v_new_act;
    perform ensure_special_slots(v_new_act);
    v_specials := v_specials + 1;
  end loop;

  insert into audit_log (event_id, actor_type, actor_id, action, target_type, target_id,
                         after_state)
  values (v_new_id, 'super_admin', trim(p_actor), 'clone_event', 'event',
          p_source_id::text,
          jsonb_build_object('new_event_id', v_new_id, 'slug', p_slug,
                             'zones', v_zones, 'checkpoints', v_cps,
                             'tiers', v_tiers, 'specials', v_specials));

  return query select v_new_id, v_zones, v_cps, v_tiers, v_specials;
end;
$$;

-- ═══════════ 0010_surveys.sql ═══════════
-- ============================================================================
-- 0010 — sponsor surveys (Track 3)
--
-- One survey belongs to one sponsor checkpoint. The rules that shape it:
--
--   * HARD CAP: 8 questions. A 20-question survey in a booth queue does not
--     get completed — it gets abandoned, the report shows 12%, and the
--     sponsor blames the system. The cap is a CHECK constraint, not a UI
--     suggestion, so no amount of admin enthusiasm can raise it.
--
--   * VERSIONED QUESTIONS: a sponsor editing their form at 11:00 must not
--     corrupt a response submitted 10:59. Every edit that touches questions
--     bumps schema_version; every response records the version it answered.
--     Old responses stay interpretable forever.
--
--   * IDEMPOTENT SUBMIT: the response_uid is client-generated (the in-queue
--     survey is filled on flaky venue 4G and retried), so a replayed submit
--     is absorbed by the primary key, and (survey, student) is unique —
--     one person answers once.
--
--   * BADGE IN THE SAME TRANSACTION (AC16): submit_survey_response calls
--     record_scan with source 'survey' at the survey's checkpoint. Whether
--     that awards a badge is the checkpoint's badge_award_mode —
--     'survey_complete' awards now, 'both_required' waits for the PG scan,
--     'pg_scan' means the survey never awards. The survey system does not
--     grow its own award logic; it feeds the one that exists.
--
--   * BRAND, v1: one accent colour, validated hex, used only where our
--     layout says accents go. Raw CSS/HTML/SVG from sponsors is a rejected
--     design (XSS surface on a page holding student PII) — the full brand
--     kit (fonts, rasterised logos) is post-12/09 scope.
-- ============================================================================

create table surveys (
  id              serial      primary key,
  event_id        smallint    not null references events (id) on delete cascade,
  checkpoint_id   integer     not null,
  title           text        not null,
  intro           text,
  accent_hex      text        check (accent_hex is null or accent_hex ~ '^#[0-9A-Fa-f]{6}$'),
  is_active       boolean     not null default false,
  schema_version  integer     not null default 1,
  -- [{id, type: 'choice'|'multi'|'scale'|'text', label, options?, required?}]
  questions       jsonb       not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  foreign key (checkpoint_id, event_id) references checkpoints (id, event_id),
  unique (checkpoint_id),            -- one survey per booth
  unique (id, event_id),
  check (jsonb_typeof(questions) = 'array'),
  check (jsonb_array_length(questions) <= 8)
);

create table survey_responses (
  response_uid    uuid        primary key,          -- client-generated
  survey_id       integer     not null,
  event_id        smallint    not null,
  student_id      bigint      not null references students (id) on delete cascade,
  schema_version  integer     not null,
  answers         jsonb       not null,
  submitted_at    timestamptz not null default now(),

  foreign key (survey_id, event_id) references surveys (id, event_id),
  foreign key (student_id, event_id) references registrations (student_id, event_id),
  unique (survey_id, student_id)
);

create index survey_responses_by_survey on survey_responses (survey_id, submitted_at);

-- ----------------------------------------------------------------------------
-- submit_survey_response — the single write path.
--
-- Statuses:
--   'submitted'          first submission; badge attempt ran (see badge_status)
--   'replay'             same response_uid again — queue retry; nothing changed
--   'already_submitted'  same student, different uid — double tap; nothing changed
--   'closed'             survey inactive or unknown
-- ----------------------------------------------------------------------------
create or replace function submit_survey_response(
  p_response_uid uuid,
  p_event_id     smallint,
  p_survey_id    integer,
  p_student_id   bigint,
  p_answers      jsonb
)
returns table (status text, badge_status text, badge_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_survey  surveys%rowtype;
  v_scan    record;
  v_uid     uuid;
begin
  select * into v_survey
    from surveys where id = p_survey_id and event_id = p_event_id;
  if not found or not v_survey.is_active then
    return query select 'closed'::text, null::text, 0;
    return;
  end if;

  if exists (select 1 from survey_responses where response_uid = p_response_uid) then
    return query select 'replay'::text, null::text, 0;
    return;
  end if;

  begin
    insert into survey_responses (response_uid, survey_id, event_id, student_id,
                                  schema_version, answers)
    values (p_response_uid, p_survey_id, p_event_id, p_student_id,
            v_survey.schema_version, p_answers);
  exception when unique_violation then
    return query select 'already_submitted'::text, null::text, 0;
    return;
  end;

  -- The badge ride-along. Derived uid: a replayed submit would re-derive the
  -- same scan uid, and the ledger's PK absorbs it — same trick as Early Bird.
  v_uid := uuid_in(md5(p_response_uid::text || ':survey')::cstring);
  select * into v_scan from record_scan(
    v_uid, p_event_id, p_student_id, v_survey.checkpoint_id,
    'survey'::scan_source, null, 'survey-web', null,
    jsonb_build_object('survey_id', p_survey_id));

  return query select 'submitted'::text, v_scan.status::text, v_scan.badge_count;
end;
$$;

-- Completion-vs-redemption is the number every sponsor asks for; keep it a
-- view so the export and the admin tab cannot disagree.
create or replace view v_survey_stats as
select sv.event_id, sv.id as survey_id, sv.title, sv.checkpoint_id,
       c.name as checkpoint_name, sv.is_active, sv.schema_version,
       jsonb_array_length(sv.questions) as question_count,
       (select count(*)::int from survey_responses r where r.survey_id = sv.id) as responses,
       (select count(*)::int from attendance a
         where a.checkpoint_id = sv.checkpoint_id and a.event_id = sv.event_id
           and a.voided_at is null) as badges_at_checkpoint
  from surveys sv
  join checkpoints c on c.id = sv.checkpoint_id and c.event_id = sv.event_id;

-- ═══════════ 0011_registration_gate.sql ═══════════
-- ============================================================================
-- 0011 — the registration gate (Layer B close-out)
--
-- events.is_registration_open existed since 0001 but NOTHING read it — the
-- admin toggle would have been a decorative switch. This recreates
-- register_student (same body as 0004, one gate added at the top) so the
-- flag actually closes the ONLINE form.
--
-- The gate applies to source 'online' ONLY. On event day pre-registration is
-- typically closed while the gate poster keeps taking walk-ins — so
-- 'walk_in', 'admin' and 'import' bypass it. Closing registration means
-- "stop the marketing funnel", never "lock the venue door".
-- ============================================================================

create or replace function register_student(
  p_event_id        smallint,
  p_full_name       text,
  p_email           text,
  p_phone           text,
  p_school_id       smallint  default null,
  p_school_other    text      default null,
  p_student_code    text      default null,
  p_major           text      default null,
  p_birth_year      smallint  default null,
  p_province_code   text      default null,
  p_employer        text      default null,
  p_gender          gender    default null,
  p_type            registration_type   default 'general',
  p_source          registration_source default 'online',
  p_consent_event   boolean   default false,
  p_consent_sponsors boolean  default false,
  p_consent_ip      inet      default null,
  p_consent_version text      default null,
  p_name_search_key text      default null
)
returns table (
  status       text,
  student_id   bigint,
  seq          integer,
  lookup_code  text
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_email       text;
  v_phone       text;
  v_student     students%rowtype;
  v_id          bigint;
  v_seq         integer;
  v_code        text;
  v_is_new      boolean := false;
  v_had_reg     boolean;
  v_try         integer;
  v_open        boolean;
begin
  -- The gate. Online only — see header.
  select e.is_registration_open into v_open from events e where e.id = p_event_id;
  if v_open is null then
    raise exception 'Sự kiện % không tồn tại', p_event_id;
  end if;
  if p_source = 'online' and not v_open then
    return query select 'closed'::text, null::bigint, null::integer, null::text;
    return;
  end if;

  -- Normalise identifiers before any lookup. The schema enforces lowercase
  -- email; doing it here means the API cannot forget.
  v_email := nullif(lower(trim(p_email)), '');
  v_phone := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '');

  if v_email is null and v_phone is null then
    raise exception 'Email hoặc số điện thoại là bắt buộc';
  end if;
  if p_consent_event is distinct from true then
    raise exception 'Chưa đồng ý điều khoản xử lý dữ liệu';
  end if;

  select * into v_student
    from students s
   where s.merged_into_id is null
     and ((v_email is not null and s.email = v_email)
       or (v_phone is not null and s.phone = v_phone))
   limit 1;

  if not found then
    v_seq := nextval('student_seq_counter')::integer;
    v_try := 0;
    loop
      v_try := v_try + 1;
      v_code := gen_lookup_code();
      begin
        insert into students (seq, lookup_code, full_name, name_search_key, email, phone,
                              school_id, school_other, student_code, major, birth_year,
                              province_code, employer, gender,
                              consent_event_at, consent_event_ip,
                              consent_sponsors_at, consent_sponsors_ip,
                              consent_text_version)
        values (v_seq, v_code, trim(p_full_name),
                coalesce(p_name_search_key, lower(trim(p_full_name))),
                v_email, v_phone,
                p_school_id, p_school_other, nullif(trim(p_student_code), ''), p_major,
                p_birth_year, p_province_code, nullif(trim(p_employer), ''), p_gender,
                now(), p_consent_ip,
                case when p_consent_sponsors then now() end,
                case when p_consent_sponsors then p_consent_ip end,
                p_consent_version)
        returning id into v_id;
        v_is_new := true;
        exit;
      exception
        when unique_violation then
          select * into v_student
            from students s
           where s.merged_into_id is null
             and ((v_email is not null and s.email = v_email)
               or (v_phone is not null and s.phone = v_phone))
           limit 1;
          if found then
            v_id := v_student.id;
            v_seq := v_student.seq;
            v_code := v_student.lookup_code;
            exit;
          end if;
          if v_try >= 5 then
            raise;
          end if;
      end;
    end loop;
  else
    v_id := v_student.id;
    v_seq := v_student.seq;
    v_code := v_student.lookup_code;
  end if;

  insert into registrations (student_id, event_id, type, source)
  values (v_id, p_event_id, p_type, p_source)
  on conflict (student_id, event_id) do nothing;
  v_had_reg := not found;

  if v_email is not null then
    insert into notification_outbox (channel, student_id, event_id, template, recipient, payload)
    values ('email', v_id, p_event_id, 'confirm', v_email,
            jsonb_build_object('full_name', trim(p_full_name), 'lookup_code', v_code, 'seq', v_seq))
    on conflict do nothing;
  end if;
  if v_phone is not null
     and (select e.sms_enabled from events e where e.id = p_event_id) then
    insert into notification_outbox (channel, student_id, event_id, template, recipient, payload)
    values ('sms', v_id, p_event_id, 'confirm', v_phone,
            jsonb_build_object('lookup_code', v_code))
    on conflict do nothing;
  end if;

  return query select
    case
      when v_had_reg then 'already_registered'
      when v_is_new  then 'created'
      else 'linked'
    end,
    v_id, v_seq, v_code;
end;
$$;

-- ═══════════ 0012_badge_weights.sql ═══════════
-- ============================================================================
-- 0012 — Badge có trọng số, và điều kiện suất đặc biệt chuyển sang thang TỔNG.
--
-- Nguồn: file "Planning by AIM" bản cuối 09/09/2026 + hai chốt miệng của anh
-- Hoàng cùng ngày. Kế hoạch của AIM cho 12/09:
--
--   * Booth NTT: 1 badge/lượt.  Brief Day & Learning zone: 4.  Inspiration: 3.
--   * "Tối thiểu 10 badge để vào HĐ đặc biệt" đếm trên TỔNG badge — gồm cả
--     điểm trọng số của hoạt động, không riêng thang lõi cổng+booth.
--
-- Hệ hiện tại cộng cứng 1 badge/lượt (0002→0007) và xét suất đặc biệt bằng
-- core_badge_count (luật >70% của Ver02). Với cấu hình AIM, thang lõi tối đa
-- chỉ 6–7 → không sinh viên nào chạm nổi 10: hai hoạt động đặc biệt sẽ trống.
--
-- Thay đổi:
--   1. checkpoints.badge_weight (1–9, mặc định 1) — booth giữ 1, hoạt động 3/4.
--   2. record_scan cộng badge_count theo trọng số (attendance vẫn đúng 1
--      dòng/mốc — trọng số là CHUYỆN ĐẾM, không phải chuyện chống trùng).
--   3. rebuild_* + v_progress_drift đổi count → sum(weight): void/rebuild và
--      máy dò lệch nói cùng một thứ tiếng với bộ đếm mới.
--   4. hold_special_slot + v_special_control_panel xét badge_count (thang
--      tổng). core_badge_count VẪN được duy trì — cột và trigger không đổi —
--      nhưng từ 0012 không còn cổng nào xét nó; giữ để đối soát và để luật
--      cũ có đường quay lại nếu một mùa sau cần.
--   5. v_special_threshold_check viết lại: luật 70% không còn là luật đang
--      chạy; cảnh báo duy nhất còn ý nghĩa là "y vượt tổng khả dụng — không
--      ai đạt nổi". DROP vì CREATE OR REPLACE không cho đổi cột.
--
-- Trọng số 0 KHÔNG tồn tại: "cổng không tính badge" đã có cờ
-- counts_toward_badges=false lo — một cơ chế cho một ý nghĩa.
-- ============================================================================

alter table checkpoints
  add column badge_weight smallint not null default 1
  check (badge_weight between 1 and 9);

comment on column checkpoints.badge_weight is
  'Số badge cộng vào thang tổng cho MỘT lượt ghi nhận tại mốc này (AIM 09/09: booth 1, Brief/LZ 4, Inspiration 3). Chống trùng vẫn ở attendance: mỗi SV mỗi mốc đúng một dòng.';

-- ----------------------------------------------------------------------------
-- record_scan — nguyên văn 0007, khác đúng hai chỗ đánh dấu [0012].
-- ----------------------------------------------------------------------------
create or replace function record_scan(
  p_scan_uid      uuid,
  p_event_id      smallint,
  p_student_id    bigint,
  p_checkpoint_id integer,
  p_source        scan_source default 'pg_scan',
  p_pg_staff_id   text        default null,
  p_device_id     text        default null,
  p_client_ts     timestamptz default null,
  p_meta          jsonb       default null
)
returns table (status scan_status, badge_count integer, awarded_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing      ledger_events%rowtype;
  v_checkpoint    checkpoints%rowtype;
  v_status        scan_status;
  v_attendance_id bigint;
  v_awarded_at    timestamptz;
  v_counts        boolean;
  v_core          boolean;
  v_badge_count   integer;
  v_has_scan      boolean;
  v_has_survey    boolean;
  v_award         boolean := false;
begin
  select * into v_existing from ledger_events where scan_uid = p_scan_uid;
  if found then
    select r.badge_count into v_badge_count
      from registrations r
     where r.event_id = v_existing.event_id and r.student_id = v_existing.student_id;
    return query select 'replay'::scan_status, coalesce(v_badge_count, 0), v_existing.server_ts;
    return;
  end if;

  select * into v_checkpoint
    from checkpoints
   where id = p_checkpoint_id and event_id = p_event_id;

  if not found or not v_checkpoint.is_active then
    insert into ledger_events (scan_uid, event_id, student_id, checkpoint_id, source,
                               status, pg_staff_id, device_id, client_ts, meta)
    values (p_scan_uid, p_event_id, p_student_id, null, p_source,
            'rejected_checkpoint_closed', p_pg_staff_id, p_device_id, p_client_ts, p_meta);
    return query select 'rejected_checkpoint_closed'::scan_status, 0, null::timestamptz;
    return;
  end if;

  perform 1 from registrations
   where event_id = p_event_id and student_id = p_student_id;
  if not found then
    insert into ledger_events (scan_uid, event_id, student_id, checkpoint_id, source,
                               status, pg_staff_id, device_id, client_ts, meta)
    values (p_scan_uid, p_event_id, p_student_id, p_checkpoint_id, p_source,
            'rejected_not_registered', p_pg_staff_id, p_device_id, p_client_ts, p_meta);
    return query select 'rejected_not_registered'::scan_status, 0, null::timestamptz;
    return;
  end if;

  case v_checkpoint.badge_award_mode
    when 'pg_scan' then
      v_award := p_source in ('pg_scan', 'student_scan', 'admin_manual', 'walk_in');
    when 'survey_complete' then
      v_award := p_source in ('survey', 'admin_manual');
    when 'either' then
      v_award := true;
    when 'both_required' then
      v_has_scan := p_source in ('pg_scan', 'student_scan', 'walk_in') or exists (
        select 1 from ledger_events
         where event_id = p_event_id and student_id = p_student_id
           and checkpoint_id = p_checkpoint_id
           and source in ('pg_scan', 'student_scan', 'walk_in')
      );
      v_has_survey := p_source = 'survey' or exists (
        select 1 from ledger_events
         where event_id = p_event_id and student_id = p_student_id
           and checkpoint_id = p_checkpoint_id
           and source = 'survey'
      );
      v_award := (v_has_scan and v_has_survey) or p_source = 'admin_manual';
  end case;

  if v_award then
    insert into attendance (event_id, student_id, checkpoint_id, first_scan_uid, source)
    values (p_event_id, p_student_id, p_checkpoint_id, p_scan_uid, p_source)
    on conflict (event_id, student_id, checkpoint_id) where voided_at is null
    do nothing
    returning id, attendance.awarded_at into v_attendance_id, v_awarded_at;

    if v_attendance_id is not null then
      v_status := 'counted';
    else
      v_status := 'repeat_not_counted';
      select a.awarded_at into v_awarded_at
        from attendance a
       where a.event_id = p_event_id and a.student_id = p_student_id
         and a.checkpoint_id = p_checkpoint_id and a.voided_at is null;
    end if;
  else
    v_status := 'pending_other_condition';
  end if;

  insert into ledger_events (scan_uid, event_id, student_id, checkpoint_id, source,
                             status, pg_staff_id, device_id, client_ts, meta)
  values (p_scan_uid, p_event_id, p_student_id, p_checkpoint_id, p_source,
          v_status, p_pg_staff_id, p_device_id, p_client_ts, p_meta);

  v_counts := v_checkpoint.counts_toward_badges;
  v_core   := counts_toward_special(v_checkpoint.kind, v_checkpoint.counts_toward_badges);

  if v_status = 'counted' and v_counts then
    -- [0012] Thang tổng cộng theo trọng số; thang lõi vẫn đếm mốc (+1).
    update registrations
       set badge_count      = registrations.badge_count + v_checkpoint.badge_weight,
           core_badge_count = registrations.core_badge_count
                              + (case when v_core then 1 else 0 end)
     where event_id = p_event_id and student_id = p_student_id
    returning registrations.badge_count into v_badge_count;
  else
    select r.badge_count into v_badge_count
      from registrations r
     where r.event_id = p_event_id and r.student_id = p_student_id;
  end if;

  -- [0012] Rollup phút cũng đếm theo trọng số — dashboard zone-heat đọc cột
  -- này như "badge phát ra", nên nó phải khớp với thang tổng.
  insert into checkpoint_minute_counts (checkpoint_id, event_id, minute_ts, badge_count, scan_count)
  values (p_checkpoint_id, p_event_id, date_trunc('minute', now()),
          case when v_status = 'counted' and v_counts
               then v_checkpoint.badge_weight else 0 end,
          1)
  on conflict (checkpoint_id, minute_ts) do update
     set badge_count = checkpoint_minute_counts.badge_count + excluded.badge_count,
         scan_count  = checkpoint_minute_counts.scan_count + excluded.scan_count;

  return query select v_status, coalesce(v_badge_count, 0), v_awarded_at;
end;
$$;

-- ----------------------------------------------------------------------------
-- Rebuild — sự thật từ ledger giờ là sum(trọng số). void_attendance (0002)
-- gọi rebuild_student_progress nên tự đúng: void một mốc trọng số 4 trả về
-- đúng 4 badge, không phải 1.
-- ----------------------------------------------------------------------------
create or replace function rebuild_student_progress(p_event_id smallint, p_student_id bigint)
returns integer
language plpgsql as $$
declare
  v_count integer;
  v_core  integer;
begin
  select coalesce(sum(c.badge_weight) filter (where c.counts_toward_badges), 0)::integer,
         count(*) filter (where counts_toward_special(c.kind, c.counts_toward_badges))::integer
    into v_count, v_core
    from attendance a
    join checkpoints c on c.id = a.checkpoint_id and c.event_id = a.event_id
   where a.event_id = p_event_id
     and a.student_id = p_student_id
     and a.voided_at is null;

  update registrations
     set badge_count = v_count, core_badge_count = v_core
   where event_id = p_event_id and student_id = p_student_id;

  return v_count;
end;
$$;

create or replace function rebuild_all_progress(p_event_id smallint)
returns integer
language plpgsql as $$
declare
  v_rows integer;
begin
  with truth as (
    select r.student_id,
           coalesce(sum(c.badge_weight) filter (where c.counts_toward_badges), 0) as real_count,
           count(a.id) filter (where counts_toward_special(c.kind, c.counts_toward_badges))
             as real_core
      from registrations r
      left join attendance a
        on a.event_id = r.event_id and a.student_id = r.student_id and a.voided_at is null
      left join checkpoints c
        on c.id = a.checkpoint_id and c.event_id = a.event_id
     where r.event_id = p_event_id
     group by r.student_id
  )
  update registrations r
     set badge_count = t.real_count, core_badge_count = t.real_core
    from truth t
   where r.event_id = p_event_id
     and r.student_id = t.student_id
     and (r.badge_count is distinct from t.real_count
          or r.core_badge_count is distinct from t.real_core);

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- Máy dò lệch phải nói cùng thứ tiếng với bộ đếm, nếu không mọi SV có badge
-- trọng số đều thành "lệch" và chuông kêu cả ngày 12/09 vì một bản vá đúng.
create or replace view v_progress_drift as
select r.event_id,
       r.student_id,
       r.badge_count as stored_count,
       coalesce(sum(c.badge_weight) filter (where c.counts_toward_badges), 0) as real_count,
       r.core_badge_count as stored_core,
       count(a.id) filter (where counts_toward_special(c.kind, c.counts_toward_badges))
         as real_core
  from registrations r
  left join attendance a
    on a.event_id = r.event_id and a.student_id = r.student_id and a.voided_at is null
  left join checkpoints c
    on c.id = a.checkpoint_id and c.event_id = a.event_id
 group by r.event_id, r.student_id, r.badge_count, r.core_badge_count
having r.badge_count is distinct from
       coalesce(sum(c.badge_weight) filter (where c.counts_toward_badges), 0)
    or r.core_badge_count is distinct from
       count(a.id) filter (where counts_toward_special(c.kind, c.counts_toward_badges));

-- ----------------------------------------------------------------------------
-- hold_special_slot — nguyên văn 0007 trừ MỘT chỗ đánh dấu [0012]: điều kiện
-- xét trên badge_count (thang tổng), theo chốt của AIM 09/09. Thang lõi thôi
-- giữ vai trò gác cổng từ đây.
-- ----------------------------------------------------------------------------
create or replace function hold_special_slot(
  p_event_id            smallint,
  p_student_id          bigint,
  p_special_activity_id integer,
  p_hold_seconds        integer default 90
)
returns table (result text, slot_no integer, held_until timestamptz, remaining integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_act         special_activities%rowtype;
  v_threshold   smallint;
  v_limit       smallint;
  v_badges      integer;
  v_used        integer;
  v_slot_id     bigint;
  v_slot_no     integer;
  v_until       timestamptz;
  v_remaining   integer;
begin
  select * into v_act
    from special_activities where id = p_special_activity_id and event_id = p_event_id;
  if not found or not v_act.is_open then
    return query select 'closed'::text, null::integer, null::timestamptz, 0;
    return;
  end if;

  select e.special_threshold_y, e.special_claim_limit into v_threshold, v_limit
    from events e where e.id = p_event_id;

  -- [0012] Thang TỔNG: booth 1 điểm + hoạt động theo trọng số (AIM 09/09).
  select r.badge_count into v_badges
    from registrations r
   where r.event_id = p_event_id and r.student_id = p_student_id;
  if v_badges is null then
    return query select 'not_registered'::text, null::integer, null::timestamptz, 0;
    return;
  end if;

  if v_badges < v_threshold then
    return query select 'not_eligible'::text, null::integer, null::timestamptz, 0;
    return;
  end if;

  select s.slot_no, s.held_until into v_slot_no, v_until
    from special_slots s
   where s.special_activity_id = p_special_activity_id
     and (s.student_id = p_student_id
          or (s.held_by_student_id = p_student_id and s.held_until > now()));
  if found then
    return query select 'already_held'::text, v_slot_no, v_until, 0;
    return;
  end if;

  select count(*)::integer into v_used
    from special_slots s
   where s.event_id = p_event_id
     and (s.student_id = p_student_id
          or (s.held_by_student_id = p_student_id and s.held_until > now()));
  if v_used >= v_limit then
    return query select 'limit_reached'::text, null::integer, null::timestamptz, 0;
    return;
  end if;

  update special_slots
     set held_by_student_id = p_student_id,
         held_until = now() + make_interval(secs => p_hold_seconds)
   where id = (
     select s.id from special_slots s
      where s.special_activity_id = p_special_activity_id
        and s.student_id is null
        and (s.held_until is null or s.held_until <= now())
      order by s.slot_no
        for update skip locked
      limit 1
   )
  returning special_slots.id, special_slots.slot_no, special_slots.held_until
       into v_slot_id, v_slot_no, v_until;

  if v_slot_id is null then
    return query select 'sold_out'::text, null::integer, null::timestamptz, 0;
    return;
  end if;

  select count(*)::integer into v_remaining
    from special_slots s
   where s.special_activity_id = p_special_activity_id
     and s.student_id is null
     and (s.held_until is null or s.held_until <= now());

  return query select 'held'::text, v_slot_no, v_until, v_remaining;
end;
$$;

-- Bảng điều khiển suất: "bao nhiêu SV đủ điều kiện" giờ đếm theo thang tổng —
-- cùng con số mà hold_special_slot dùng để cho vào.
create or replace view v_special_control_panel as
select sa.event_id,
       sa.id   as special_activity_id,
       sa.name,
       sa.capacity,
       count(*) filter (where s.student_id is not null)                     as claimed,
       count(*) filter (where s.student_id is null
                          and s.held_until > now())                          as on_hold,
       count(*) filter (where s.student_id is null
                          and (s.held_until is null or s.held_until <= now())) as available,
       (select count(*) from registrations r
         where r.event_id = sa.event_id
           and r.badge_count >= (select e.special_threshold_y
                                   from events e where e.id = sa.event_id)) as students_eligible
  from special_activities sa
  join special_slots s on s.special_activity_id = sa.id
 group by sa.event_id, sa.id, sa.name, sa.capacity;

-- ----------------------------------------------------------------------------
-- Chuông ngưỡng viết lại. Luật ">70% số hoạt động" (Ver02) không còn là luật
-- đang chạy — AIM 09/09 chốt ngưỡng tuyệt đối trên thang tổng. Cảnh báo duy
-- nhất còn nghĩa: y đặt CAO HƠN tổng badge một SV có thể đạt → không ai vào
-- được HĐ đặc biệt. DROP vì đổi bộ cột; UI overview đọc cột mới.
-- ----------------------------------------------------------------------------
drop view v_special_threshold_check;
create view v_special_threshold_check as
select e.id as event_id,
       coalesce(sum(c.badge_weight) filter
                (where c.is_active and c.counts_toward_badges), 0)::integer as available_total,
       e.special_threshold_y::integer as configured_threshold,
       e.special_threshold_y > coalesce(sum(c.badge_weight) filter
                (where c.is_active and c.counts_toward_badges), 0)
         as mismatch
  from events e
  left join checkpoints c on c.event_id = e.id
 group by e.id, e.special_threshold_y;
