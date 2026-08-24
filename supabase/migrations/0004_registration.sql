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
