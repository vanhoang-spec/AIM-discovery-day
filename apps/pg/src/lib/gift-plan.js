/**
 * Quầy quà: MỘT câu trả lời, MỘT nút bấm.
 *
 * Trước 10/09 màn quầy quà liệt kê từng bậc kèm một nút PHÁT riêng, và để PG tự
 * suy ra phải cầm món nào lên. Với quy định mới của AIM thì cách đó hỏng theo
 * cả hai chiều: SV đủ 9 badge có hai nút sáng (bấm cả hai là đưa ra hai chiếc
 * túi), còn SV đã lấy túi từ trước thì nút mức 9 không nói được rằng lần này
 * chỉ đưa hộp bút.
 *
 * Cả hai đều là cùng một lỗi: bắt người đứng trước hàng dài phải suy luận. Nên
 * ở đây tính sẵn đúng một hành động, kèm DANH SÁCH MÓN PHẢI CẦM LÊN, và màn
 * hình chỉ việc đọc ra.
 *
 * Quy ước đi cùng 0014: MỖI BẬC = ĐÚNG MỘT MÓN NÓ CỘNG THÊM (bậc 1 "Túi quà",
 * bậc 2 "Hộp bút Thiên Long"), nên ghép tên các bậc lại là ra đúng câu cần đọc.
 */

/** Sắp xếp theo bậc và chỉ giữ những gì dùng được. */
const sorted = (card) =>
  [...(card?.tiers ?? [])].filter((t) => t && t.id != null).sort((a, b) => a.tier - b.tier);

/**
 * Một lượt SV ở quầy quà.
 *
 * @returns {{
 *   state: 'none'|'locked'|'ready'|'done'|'out',
 *   target: object|null,   // bậc sẽ bấm — cũng là bậc gửi lên server
 *   hand: object[],        // ĐÚNG những món phải đưa cho SV lần này
 *   already: object[],     // đã nhận trước đó, kèm giờ
 *   shortfall: object[],   // đủ điều kiện nhưng hết kho — SV đang bị nợ
 *   missing: number|null,  // còn thiếu bao nhiêu badge (khi state='locked')
 *   next: object|null,     // bậc gần nhất chưa với tới
 * }}
 */
export function giftPlan(card) {
  const tiers = sorted(card);
  const badges = Number(card?.student?.badge_count ?? 0);

  const base = {
    state: 'none', target: null, hand: [], already: [], shortfall: [],
    missing: null, next: null,
  };

  // [11/09] Quy định AIM chỉ đúng ở thang CỘNG DỒN (0014): mức 9 = túi + bút.
  // TP.HCM bị bấm sang "Bậc cao nhất" từ 10/09 — ở chế độ đó server chỉ ghi
  // đúng một món, nên màn hình hứa túi + bút mà sổ chỉ có bút. Không hứa, không
  // phát gì cho tới khi BTC đặt lại. Server cũ không gửi chế độ → không chặn.
  if (card?.ladder_mode && card.ladder_mode !== 'cumulative') {
    return { ...base, state: 'misconfigured' };
  }

  if (!tiers.length) return base;

  // "Đã nhận" đọc theo dòng đã ghi, KHÔNG lọc theo điều kiện hiện tại: BTC nâng
  // ngưỡng giữa ngày không được phép xoá mất một món đã trao tận tay.
  const already = tiers.filter((t) => t.redeemed_at);
  const earned = tiers.filter((t) => badges >= t.required);

  if (!earned.length) {
    const next = tiers[0];
    return { ...base, state: 'locked', already, next, missing: next.required - badges };
  }

  const pending = earned.filter((t) => !t.redeemed_at);
  if (!pending.length) {
    const next = tiers.find((t) => badges < t.required) ?? null;
    return {
      ...base,
      state: 'done',
      already,
      next,
      missing: next ? next.required - badges : null,
    };
  }

  const inStock = pending.filter((t) => t.stock !== 'out');
  if (!inStock.length) return { ...base, state: 'out', already, shortfall: pending };

  // Bậc cao nhất còn phát được. Server cấp kèm mọi bậc thấp còn kho, nên danh
  // sách phải cầm lên đúng bằng tập đó — không thừa một món, không thiếu một
  // món. Bậc thấp hết kho rơi vào `shortfall`: SV vẫn nhận phần còn lại và
  // đang bị nợ món kia.
  const target = inStock[inStock.length - 1];
  const shortfall = pending.filter((t) => t.tier < target.tier && t.stock === 'out');

  return { ...base, state: 'ready', target, hand: inStock, already, shortfall };
}

/** "Túi quà + Hộp bút Thiên Long" — câu PG đọc để cầm đồ. */
export const itemNames = (tiers = []) => tiers.map((t) => t.name).join(' + ');

/**
 * Sau khi bấm PHÁT QUÀ: đưa món nào, và món nào dự định mà sổ KHÔNG ghi.
 *
 * DIỄN TẬP 11/09: SV đủ 9 badge, màn hình hứa "Túi quà + Hộp bút", PG đưa cả
 * hai rồi mới bấm — nhưng sổ chỉ ghi hộp bút. Quét lại, máy (đúng theo sổ) mời
 * trao thêm túi. Từ đó luồng là PHÁT trước, đưa sau, và danh sách "đưa cho SV"
 * đọc từ `granted` — những dòng server thật sự vừa ghi. Món nào dự định mà
 * không có trong đó thì phải nói to ra, để PG KHÔNG đưa.
 *
 * `planned` là plan.hand lúc bấm; `granted` là [{tier, name}] server trả.
 * Thiếu `granted` (không nên xảy ra) thì coi như chỉ ghi được bậc đích —
 * thà báo thiếu oan một món còn hơn để PG đưa ra một món sổ không có.
 */
export function grantOutcome(planned = [], granted, target = null) {
  const got = Array.isArray(granted) && granted.length
    ? granted
    : (target ? [{ tier: target.tier, name: target.name }] : []);
  const tiers = new Set(got.map((g) => g.tier));
  return {
    give: got.map((g) => g.name),
    missing: (planned ?? []).filter((t) => !tiers.has(t.tier)).map((t) => t.name),
  };
}
