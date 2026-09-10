-- ============================================================================
-- 0014 — Quy định đổi quà: hai món, mỗi người tối đa một chiếc túi.
--
-- AIM chốt 10/09/2026. Ở bàn quà chỉ có HAI vật thể: một chồng TÚI QUÀ và một
-- thùng HỘP BÚT.
--
--   * 7 badge  → 01 túi quà
--   * 9 badge  → 01 túi quà + 01 hộp bút — hộp bút CỘNG THÊM, không thay túi
--   * Ai đã lấy túi ở mức 7, sau đủ 9 badge quay lại → chỉ trao thêm hộp bút
--   * Ai đủ 9 badge ngay từ đầu → trao một lần cả hai, KHÔNG làm thêm một
--     giao dịch mức 7 nữa, vì mức 9 đã bao gồm chiếc túi
--
-- Bất biến: MỖI SV TỐI ĐA 1 TÚI VÀ TỐI ĐA 1 HỘP BÚT, đi đường nào cũng vậy.
--
-- Chế độ 'cumulative' cũ không diễn đạt được điều đó. Nó coi mỗi bậc là một
-- món quà độc lập, nên SV 9 badge bấm mức 7 rồi bấm mức 9 là cầm về HAI túi —
-- và tệ hơn: kho mức 7 KHÔNG bị trừ khi phát mức 9, dù một chiếc túi thật vừa
-- rời bàn. Hà Nội cấu hình 400/200 nghĩa là hệ thống cho phép phát tới 600 túi
-- từ một chồng 400 chiếc. Không có cách nào phát hiện tại chỗ: con số trên
-- màn hình vẫn xanh trong khi cái bàn đã trống.
--
-- Cách chữa: đổi nghĩa của bậc. MỖI BẬC = ĐÚNG MỘT MÓN NÓ CỘNG THÊM.
-- Bậc 1 = Túi quà (kho = tổng số túi). Bậc 2 = Hộp bút (kho = tổng số hộp).
-- Phát bậc cao thì tự cấp kèm mọi bậc thấp SV đã đủ mà chưa nhận — trừ đủ hai
-- kho, ghi đủ hai dòng. Nhờ vậy "kho bậc 1" luôn đúng bằng số túi đã rời bàn,
-- và câu hỏi "ai đang bị nợ một chiếc túi" trở thành một câu SELECT.
--
-- Không đổi schema, không đụng một dòng dữ liệu nào. Chỉ create-or-replace
-- đúng một function, giữ nguyên chữ ký — chạy được giữa lúc sự kiện đang chạy.
--
-- Ba điều KHÔNG được làm khác khi áp lên production:
--   * chép nguyên ba dòng `language plpgsql` / `security definer` /
--     `set search_path = public` — create-or-replace thay TOÀN BỘ định nghĩa,
--     thiếu dòng nào là mất dòng đó, kể cả cái ghim search_path;
--   * KHÔNG bao giờ `drop function` trước — drop+create đổi chủ sở hữu, mà với
--     security definer thì đổi chủ nghĩa là đổi quyền của mọi lượt gọi;
--   * chạy lúc vắng khách rồi thử ngay một SV nháp.
-- ============================================================================

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
  v_low         gift_tiers%rowtype;
  v_mode        text;
  v_badges      integer;
  v_best_tier   integer;
  v_claimed     boolean;
  v_low_claimed boolean;
  v_cascade     boolean;
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

  -- [0014] "SV này đã nhận đúng bậc này chưa" là một SỰ THẬT, không phải một
  -- phán xét — nên nó phải trả lời trước mọi luật lệ bên dưới. Trước 0014 câu
  -- hỏi đó chỉ được trả lời gián tiếp bởi unique index SAU khi đã trừ kho, nên
  -- một lần bấm lại lúc kho đã cạn trả về "ĐÃ HẾT quà bậc này" — sai, và sai
  -- đúng vào lúc đông nhất. Đặt lên đầu còn là điều kiện để luật chặn phát lùi
  -- bên dưới không phá mất tính an toàn khi PG bấm lại lúc mạng chập chờn.
  if exists (select 1 from gift_redemptions gr
              where gr.event_id = p_event_id
                and gr.student_id = p_student_id
                and gr.gift_tier_id = p_gift_tier_id) then
    return query select 'already_claimed'::text, v_tier.gift_name,
                        v_tier.stock_total - v_tier.stock_issued;
    return;
  end if;

  if v_badges < v_tier.required_badges then
    return query select 'not_eligible'::text, v_tier.gift_name,
                        v_tier.stock_total - v_tier.stock_issued;
    return;
  end if;

  -- [0014] Đường vé giấy (AC26) KHÔNG đi qua hai luật mới. Một vé giấy là một
  -- món có thật đã trao tận tay, không phải một yêu cầu chờ xét: nếu để cascade
  -- chạy, nhập vé mức 9 trước sẽ tự sinh dòng mức 7, rồi tấm vé mức 7 thật bị
  -- báo "vé giấy trùng, kiểm tra lại sổ" — biến một cuốn sổ đúng thành lỗi.
  v_cascade := (v_mode is distinct from 'highest_only') and not p_was_offline;

  -- [0014] Không bao giờ phát bậc thấp khi bậc cao hơn đang sẵn sàng: đó chính
  -- là "không thực hiện đổi quà mức 7 riêng" của AIM. Điều kiện `còn kho` là có
  -- chủ đích — hết hộp bút thì SV 9 badge vẫn phải nhận được chiếc túi. Điều
  -- kiện `chưa nhận` cũng vậy: sau khi đã có mức 9, luật này im lặng và câu trả
  -- lời đúng ("đã nhận rồi") đến từ đoạn ở trên.
  if v_cascade and exists (
    select 1 from gift_tiers gt
     where gt.event_id = p_event_id and gt.is_active
       and gt.tier > v_tier.tier
       and gt.required_badges <= v_badges
       and gt.stock_issued < gt.stock_total
       and not exists (select 1 from gift_redemptions gr
                        where gr.event_id = p_event_id
                          and gr.student_id = p_student_id
                          and gr.gift_tier_id = gt.id)
  ) then
    return query select 'claim_top_tier_first'::text, v_tier.gift_name,
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

  -- [0014] Khoá TRƯỚC, theo thứ tự bậc tăng dần, mọi dòng kho lượt này sẽ đụng.
  -- Dòng gift_tiers là tài nguyên dùng chung cho toàn bộ sinh viên, nên nếu cứ
  -- khoá bậc đích trước rồi mới khoá bậc thấp thì hai lượt phát ở hai bậc khác
  -- nhau sẽ xếp hàng ngược chiều nhau: A giữ T3 chờ T2, B giữ T2 chờ T1 mà A
  -- đang giữ — deadlock, và Postgres huỷ một bên sau một giây bằng một lỗi 500
  -- không ai đọc hiểu ở quầy. Với đúng hai bậc thì tình huống đó không tồn tại,
  -- nhưng hàm này viết tổng quát và bộ seed đang có ba bậc. Một câu khoá tăng
  -- dần ở đây là xong, rẻ hơn mọi cách chữa sau này.
  perform 1 from gift_tiers gt
   where gt.event_id = p_event_id
     and (gt.id = p_gift_tier_id
          or (v_cascade and gt.is_active
              and gt.tier < v_tier.tier
              and gt.required_badges <= v_badges))
   order by gt.tier
     for update;

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

  -- [0014] Bậc cao bao gồm mọi bậc thấp. Cùng khuôn với đoạn ở trên — trừ kho
  -- bằng một câu UPDATE có điều kiện, ghi dòng, hoàn kho nếu đụng — nhưng dùng
  -- biến RIÊNG: v_claimed của luồng chính không được phép bị vòng lặp ghi đè,
  -- và FOUND sau vòng lặp cũng không còn nghĩa gì.
  --
  -- Bậc thấp HẾT KHO thì bỏ qua lặng lẽ, có chủ đích: hết túi vẫn phải trao
  -- được hộp bút. SV đó đang bị nợ một chiếc túi và lấy lại được ngay khi BTC
  -- nạp thêm kho — lúc ấy luật chặn phát lùi đã im (mức 9 đã nhận), nên chỉ cần
  -- bấm mức 7 như bình thường.
  if v_cascade then
    for v_low in
      select gt.* from gift_tiers gt
       where gt.event_id = p_event_id and gt.is_active
         and gt.tier < v_tier.tier
         and gt.required_badges <= v_badges
         and not exists (select 1 from gift_redemptions gr
                          where gr.event_id = p_event_id
                            and gr.student_id = p_student_id
                            and gr.gift_tier_id = gt.id)
       order by gt.tier
    loop
      update gift_tiers
         set stock_issued = stock_issued + 1
       where id = v_low.id
         and stock_issued < stock_total;

      if found then
        insert into gift_redemptions (event_id, student_id, gift_tier_id, threshold_at_grant,
                                      badge_count_at_grant, staff_id, device_id, was_offline)
        values (p_event_id, p_student_id, v_low.id, v_low.required_badges,
                v_badges, p_staff_id, p_device_id, p_was_offline)
        on conflict (event_id, student_id, gift_tier_id) do nothing;

        get diagnostics v_low_claimed = row_count;

        if not v_low_claimed then
          -- Ảnh chụp của vòng lặp đã cũ: ai đó vừa cấp bậc này xong. Trả lại
          -- đơn vị vừa lấy, y như luồng chính.
          update gift_tiers set stock_issued = stock_issued - 1 where id = v_low.id;
        end if;
      end if;
    end loop;
  end if;

  return query select 'ok'::text, v_tier.gift_name, v_remaining;
end;
$$;
