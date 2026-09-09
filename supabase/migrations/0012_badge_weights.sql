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
