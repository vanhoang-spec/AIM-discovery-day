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
