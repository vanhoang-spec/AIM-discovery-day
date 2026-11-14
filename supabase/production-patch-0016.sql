-- SINH TỰ ĐỘNG từ supabase/migrations/0016_event_email_copy.sql — đừng sửa tay.
-- Tái sinh: node scripts/build-production-sql.mjs
-- Dán vào Supabase SQL Editor của database production ĐANG CHẠY và Run MỘT lần.
-- Cả file là một transaction: lỗi giữa chừng thì không có gì được áp.

begin;

-- ---------------------------------------------------------------------------
-- 0016 — Chữ thư riêng cho từng sự kiện + xếp thư nhắc hàng loạt vào outbox
--
-- Sự kiện kế tiếp là "Discovery Day - UEF" (17/11/2026). AIM gửi nội dung thư
-- riêng; mẫu cũ trong @atl/email viết cứng "Awaken The Lions 2026", giờ
-- 8h00–17h00 và dòng Early Bird 8h45 — đúng cho 12/09, sai cho UEF.
--
--   * events.email_copy (jsonb) — chữ riêng của sự kiện. NULL = giữ nguyên mẫu
--     cũ, nên Hà Nội / TP.HCM / diễn tập không đổi một byte. Có giá trị thì
--     @atl/email dùng mẫu kiểu AIM. Shape ghi ở `comment on column` bên dưới
--     và ở packages/email/src/index.js (parseEmailCopy). CHECK chặn một JSON
--     thiếu trường bắt buộc ngay lúc UPDATE — nếu không, mọi thư xác nhận của
--     sự kiện đó sẽ nổ lúc render và đậu 'failed' sau 8 lần thử.
--
--   * queue_event_reminders(event, template, giờ hẹn) — phần AC8 còn thiếu:
--     chèn một dòng outbox cho mỗi SV đã đăng ký sự kiện có email. IDEMPOTENT:
--     SV đã có dòng (cùng event, kênh email, cùng template) ở BẤT KỲ trạng thái
--     nào thì bỏ qua — chạy lại không gửi lại. Trả số dòng đã chèn.
--     Cố ý KHÔNG dùng unique index như outbox_confirm_once: production có thể
--     đã có dòng nhắc chèn tay hôm 12/09, và CREATE UNIQUE INDEX trên dữ liệu
--     trùng sẽ làm hỏng cả file này. Thay vào đó: advisory lock theo sự kiện
--     (hai lượt gọi cùng lúc chạy nối tiếp) + NOT EXISTS.
--
-- Chỉ THÊM: một cột (NULL, không default — chỉ ghi metadata), một CHECK trên
-- chính cột mới, hai function mới. Không đụng cột / dữ liệu cũ. Chạy lại cả
-- file lần hai an toàn (if not exists / create or replace / DO kiểm constraint).
-- Không tham chiếu cột của 0015 trực tiếp (is_archived đọc qua to_jsonb), nên
-- áp được cả trên database chưa có 0015.
-- ---------------------------------------------------------------------------

alter table events
  add column if not exists email_copy jsonb;

-- Kiểm shape. Bản JS tương ứng: parseEmailCopy() trong @atl/email — test
-- supabase/test/event-email-copy.test.js chạy cùng bộ mẫu qua cả hai.
create or replace function email_copy_is_valid(p jsonb)
returns boolean
language sql
immutable
as $$
  select case
    when p is null then true
    when jsonb_typeof(p) <> 'object' then false
    else
      -- Bắt buộc: chuỗi, không rỗng.
      not exists (
        select 1
          from (values (array['event_title']),
                       (array['subjects', 'confirm']),
                       (array['subjects', 'morning']),
                       (array['support_place']),
                       (array['venue_line']),
                       (array['see_you'])) as req(path)
         where coalesce(jsonb_typeof(p #> req.path), '') <> 'string'
            or btrim(p #>> req.path) = '')
      -- Tuỳ chọn: vắng, null, hoặc chuỗi.
      and not exists (
        select 1
          from unnest(array['short_title', 'time_line', 'booth_opens',
                            'organizer', 'signature_image_url']) as k
         where coalesce(jsonb_typeof(p -> k), 'null') not in ('string', 'null'))
      -- Ảnh chữ ký: chỉ https (thư mở trên điện thoại; http bị chặn / cảnh báo).
      and (case when jsonb_typeof(p -> 'signature_image_url') = 'string'
                 and btrim(p ->> 'signature_image_url') <> ''
                then btrim(p ->> 'signature_image_url') ~* '^https://'
                else true end)
      -- Độ rộng ảnh chữ ký (px): số nguyên 40–504 (thẻ thư 560 trừ lề 2×28).
      and (case coalesce(jsonb_typeof(p -> 'signature_image_width'), 'null')
             when 'null' then true
             when 'number' then
               (p ->> 'signature_image_width')::numeric between 40 and 504
               and (p ->> 'signature_image_width')::numeric
                 = trunc((p ->> 'signature_image_width')::numeric)
             else false end)
  end;
$$;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'events_email_copy_valid'
                    and conrelid = 'events'::regclass) then
    alter table events
      add constraint events_email_copy_valid check (email_copy_is_valid(email_copy));
  end if;
end $$;

comment on column events.email_copy is
  'Chữ thư riêng của sự kiện (mẫu kiểu AIM). NULL = mẫu cũ ATL2026. Shape: '
  '{ event_title*, short_title, subjects: { confirm*, morning* }, support_place*, '
  'venue_line*, time_line, booth_opens, see_you*, organizer, signature_image_url, '
  'signature_image_width } — * bắt buộc. Chi tiết từng trường: parseEmailCopy() '
  'trong packages/email/src/index.js. Mẫu AIM chỉ có thư confirm và morning.';

-- ---------------------------------------------------------------------------
-- queue_event_reminders
--
-- Gọi tay (SQL Editor) hoặc từ cron sau này. Ví dụ hẹn 06:00 sáng ngày sự kiện:
--   select queue_event_reminders(4::smallint, 'morning', '2026-11-17 06:00:00+07');
--
-- Chọn ai: mọi registrations của sự kiện, SV chưa bị gộp (merged_into_id null),
-- có email. SV của sự kiện khác không bao giờ được xếp; SV không email bỏ qua.
-- Đổi giờ hẹn sau khi đã xếp: chạy lại KHÔNG đổi gì (trả 0) — sửa
-- notification_outbox.scheduled_at của các dòng 'queued' bằng tay.
-- ---------------------------------------------------------------------------

create or replace function queue_event_reminders(
  p_event_id     smallint,
  p_template     text,
  p_scheduled_at timestamptz
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_event events%rowtype;
  v_n     integer;
begin
  if p_template is null or p_template not in ('reminder_d3', 'reminder_d1', 'morning') then
    raise exception 'queue_event_reminders: template không hợp lệ: % (chỉ reminder_d3 | reminder_d1 | morning; thư confirm do register_student xếp)',
      coalesce(p_template, 'null');
  end if;
  if p_scheduled_at is null then
    raise exception 'queue_event_reminders: thiếu giờ hẹn gửi';
  end if;

  -- Hai lượt gọi cùng lúc cho cùng sự kiện: lượt sau chờ lượt trước commit,
  -- rồi NOT EXISTS (snapshot mới của câu INSERT) thấy hết dòng vừa chèn.
  -- Advisory lock thay vì FOR UPDATE trên events: không chặn ghi vào dòng
  -- sự kiện (giờ vàng, mở/đóng đăng ký) trong lúc xếp thư.
  perform pg_advisory_xact_lock(hashtext('queue_event_reminders'), p_event_id::integer);

  select * into v_event from events e where e.id = p_event_id;
  if not found then
    raise exception 'queue_event_reminders: không có sự kiện %', p_event_id;
  end if;
  if coalesce((to_jsonb(v_event) ->> 'is_archived')::boolean, false) then
    raise exception 'queue_event_reminders: sự kiện % đã khoá (is_archived)', p_event_id;
  end if;
  -- Mẫu AIM chỉ viết thư nhắc sáng ngày sự kiện ("... sẽ chính thức bắt
  -- đầu"). Xếp D-3 / D-1 cho sự kiện có email_copy là gửi câu đó sai ngày —
  -- từ chối ở đây thay vì để worker render sai.
  if v_event.email_copy is not null and p_template <> 'morning' then
    raise exception 'queue_event_reminders: sự kiện % dùng mẫu AIM (email_copy) — chỉ có thư nhắc morning, không có %',
      p_event_id, p_template;
  end if;

  insert into notification_outbox (channel, student_id, event_id, template,
                                   recipient, payload, scheduled_at)
  select 'email', s.id, p_event_id, p_template, btrim(s.email),
         jsonb_build_object('full_name', s.full_name, 'lookup_code', s.lookup_code, 'seq', s.seq),
         p_scheduled_at
    from registrations r
    join students s on s.id = r.student_id
   where r.event_id = p_event_id
     and s.merged_into_id is null
     and nullif(btrim(s.email), '') is not null
     and not exists (
       select 1 from notification_outbox o
        where o.student_id = s.id
          and o.event_id   = p_event_id
          and o.channel    = 'email'
          and o.template   = p_template);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Hàm gửi thư hàng loạt: chỉ chủ database (SQL Editor / app server) được gọi.
-- Trên Supabase, function mới trong public tự được cấp cho anon/authenticated.
do $$
begin
  revoke all on function queue_event_reminders(smallint, text, timestamptz) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function queue_event_reminders(smallint, text, timestamptz) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function queue_event_reminders(smallint, text, timestamptz) from authenticated;
  end if;
end $$;

commit;
