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
