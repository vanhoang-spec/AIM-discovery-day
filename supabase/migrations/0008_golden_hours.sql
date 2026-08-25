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
