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
