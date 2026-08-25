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
