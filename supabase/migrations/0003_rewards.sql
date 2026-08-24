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
