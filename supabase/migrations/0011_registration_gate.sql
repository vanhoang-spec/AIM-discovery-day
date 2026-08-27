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
