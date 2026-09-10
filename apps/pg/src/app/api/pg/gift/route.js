/**
 * POST /api/pg/gift — the gift counter (AC18–AC20 UI side).
 *
 * Từ 10/09 route này còn giữ hai luật mà giao diện không giữ nổi: chỉ máy đang
 * đứng ở Quầy đổi quà mới gọi được (403 cho mọi máy khác), và câu trả lời nói
 * đúng NHỮNG MÓN vừa rời bàn — không phải cái nút PG đã bấm. Xem hai khối
 * `desk` và `granted` bên dưới.
 *
 * ONLINE-ONLY by design, unlike scanning. A badge award is idempotent and
 * can queue; handing over a physical gift is not — the stock decrement and
 * the dedup both live in claim_gift_tier's single transaction, and two
 * counters working offline could each hand over the last notebook. When the
 * network dies at the counter, the fallback is paper + wristband (AC21),
 * never an offline queue.
 *
 *   { action: 'check',  student_seq }              → entitlement card
 *   { action: 'redeem', student_seq, gift_tier_id } → hand-over
 *
 * Both are device-token authed; the redemption records staff + device, so
 * "who gave out gift #147" is always answerable.
 */

import { getDb } from '@atl/db';
import { bearerFrom, sha256Hex } from '@/lib/device';

export async function POST(request) {
  const token = bearerFrom(request);
  if (!token) return Response.json({ error: 'Thiếu token thiết bị' }, { status: 401 });

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Dữ liệu không hợp lệ' }, { status: 400 });
  }

  const db = await getDb();
  const dev = (await db.query(
    `select * from resolve_pg_device($1)`, [await sha256Hex(token)],
  )).rows[0];
  if (!dev) return Response.json({ error: 'Thiết bị không hợp lệ' }, { status: 401 });

  // [10/09] "Siết luôn đi, chỉ máy quầy quà mới trao được" — và siết ở ĐÂY,
  // không phải chỉ ở giao diện. canOpenGiftDesk() trên máy chỉ giấu cái nút;
  // một token PG bất kỳ vẫn POST thẳng vào đây được. Quy ước "đúng một dòng =
  // vị trí hiện tại" giống /api/pg/state, nên BTC điều chuyển bằng đúng cái ô
  // đã dùng cho mọi máy khác và ~20 giây sau máy nhận vị trí mới.
  const desk = await db.query(
    `select c.kind
       from pg_device_checkpoints dc
       join checkpoints c on c.id = dc.checkpoint_id and c.event_id = dc.event_id
      where dc.device_id = $1 and dc.event_id = $2 and c.is_active`,
    [dev.device_id, dev.event_id],
  );
  if (desk.rows.length !== 1 || desk.rows[0].kind !== 'gift_counter') {
    return Response.json(
      { error: 'Máy này không phải Quầy đổi quà', result: 'not_gift_desk' },
      { status: 403 },
    );
  }

  const seq = Number(body.student_seq);
  if (!Number.isInteger(seq) || seq <= 0) {
    return Response.json({ error: 'Thiếu mã sinh viên' }, { status: 400 });
  }

  const student = (await db.query(
    `select s.id, s.full_name, s.lookup_code, s.student_code,
            r.badge_count
       from students s
       join registrations r on r.student_id = s.id and r.event_id = $2
      where s.seq = $1 and s.merged_into_id is null`,
    [seq, dev.event_id],
  )).rows[0];
  if (!student) {
    return Response.json({ error: 'SV chưa đăng ký sự kiện này' }, { status: 404 });
  }

  // [0014] Ảnh chụp TRƯỚC khi phát. Từ 0014 một lượt phát bậc cao còn cấp kèm
  // mọi bậc thấp SV đã đủ mà chưa nhận, trong khi claim_gift_tier chỉ trả về
  // tên của bậc được bấm. Không có ảnh chụp này thì màn PG báo "ĐÃ PHÁT — Hộp
  // bút" đúng lúc hệ thống vừa trừ cả một chiếc túi, và dòng túi lập tức hiện
  // "✓ đã nhận" — đúng tín hiệu bảo PG ĐỪNG đưa túi. SV cầm mỗi hộp bút ra về,
  // sổ sách ghi đã nhận cả hai. Diff hai ảnh là cách duy nhất nói thật.
  let before = null;

  if (body.action === 'redeem') {
    const tierId = Number(body.gift_tier_id);
    if (!tierId) return Response.json({ error: 'Thiếu bậc quà' }, { status: 400 });

    before = new Set((await db.query(
      `select gift_tier_id from gift_redemptions where event_id = $1 and student_id = $2`,
      [dev.event_id, student.id],
    )).rows.map((x) => x.gift_tier_id));

    const r = (await db.query(
      `select * from claim_gift_tier($1::smallint, $2::bigint, $3::integer, $4, $5)`,
      [dev.event_id, student.id, tierId, dev.staff_name ?? null, String(dev.device_id)],
    )).rows[0];
    if (r.result !== 'ok') {
      const msg = {
        already_claimed: 'SV đã nhận bậc này rồi',
        not_eligible: 'Chưa đủ badge cho bậc này',
        out_of_stock: 'ĐÃ HẾT quà bậc này',
        // [0014] Chế độ cộng dồn: bấm bậc thấp khi bậc cao còn trên bàn.
        claim_top_tier_first: 'SV đã đủ mức cao hơn — bấm mức cao nhất (đã gồm mức dưới)',
        not_highest_tier: 'Chế độ "bậc cao nhất": phải phát bậc cao nhất SV đạt',
        not_registered: 'SV chưa đăng ký',
        unknown_tier: 'Bậc quà không tồn tại',
      }[r.result] ?? r.result;
      return Response.json({ error: msg, result: r.result }, { status: 409 });
    }
    // Fall through: return the refreshed card so the counter sees the new
    // state (redeemed row + updated stock) in one round-trip.
  } else if (body.action !== 'check') {
    return Response.json({ error: 'Hành động không hợp lệ' }, { status: 400 });
  }

  const [ev, tiers, redemptions] = await Promise.all([
    db.query(`select gift_ladder_mode, special_threshold_y from events where id = $1`,
      [dev.event_id]),
    db.query(
      `select id, tier, gift_name, required_badges,
              (stock_total - stock_issued) as left_exact,
              case
                when stock_issued >= stock_total then 'out'
                when stock_total - stock_issued < stock_total * 0.15 then 'low'
                else 'ok'
              end as stock
         from gift_tiers where event_id = $1 and is_active order by tier`,
      [dev.event_id]),
    db.query(
      `select gr.gift_tier_id, gr.redeemed_at, gt.tier
         from gift_redemptions gr
         join gift_tiers gt on gt.id = gr.gift_tier_id
        where gr.event_id = $1 and gr.student_id = $2`,
      [dev.event_id, student.id],
    ),
  ]);

  // Re-read the counters: a redeem above may sit alongside a concurrent scan.
  const fresh = (await db.query(
    `select badge_count from registrations
      where event_id = $1 and student_id = $2`, [dev.event_id, student.id],
  )).rows[0];

  const redeemedBy = new Map(redemptions.rows.map((x) => [x.gift_tier_id, x.redeemed_at]));

  // Đúng những món vừa rời bàn trong lượt này — đọc từ dòng đã ghi, không phải
  // từ cái nút PG đã bấm.
  const granted = before
    ? tiers.rows
      .filter((t2) => !before.has(t2.id) && redeemedBy.has(t2.id))
      .map((t2) => ({ tier: t2.tier, name: t2.gift_name }))
    : undefined;

  return Response.json({
    student: {
      seq,
      full_name: student.full_name,
      lookup_code: student.lookup_code,
      student_code: student.student_code,
      badge_count: fresh.badge_count,
    },
    ladder_mode: ev.rows[0].gift_ladder_mode,
    special_threshold_y: ev.rows[0].special_threshold_y,
    tiers: tiers.rows.map((t2) => ({
      id: t2.id,
      tier: t2.tier,
      name: t2.gift_name,
      required: t2.required_badges,
      stock: t2.stock,
      // The counter DOES see low stock precisely ("còn 3") — staff need it to
      // manage the line. Students never do; /toi shows only ok/low/out.
      left: t2.stock === 'ok' ? null : Number(t2.left_exact),
      redeemed_at: redeemedBy.get(t2.id) ?? null,
      eligible: fresh.badge_count >= t2.required_badges,
    })),
    redeemed: body.action === 'redeem' ? true : undefined,
    granted,
  });
}
