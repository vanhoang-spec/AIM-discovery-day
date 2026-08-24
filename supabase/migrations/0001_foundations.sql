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
