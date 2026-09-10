/**
 * AC26 — merging the paper trail back into the ledger after the event.
 *
 * Break-glass gift hand-overs (wristbands) and paper special tickets go
 * through the SAME functions the live counters use — claim_gift_tier with
 * was_offline=true, hold+confirm for slots — never through raw inserts.
 * That is the whole design: a paper entry that collides with an online one
 * (student already redeemed, stock already empty) is REFUSED and surfaced,
 * which is exactly how a double-entry on paper gets caught instead of
 * silently becoming two notebooks in the report.
 */

import { getDb } from '@atl/db';
import { checkAdmin, adminError } from '../../../../lib/admin-auth.js';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const auth = checkAdmin(request);
  if (!auth.ok) return adminError(auth);
  const eventId = Number(new URL(request.url).searchParams.get('event') ?? 1);
  const db = await getDb();

  const [paper, tiers, activities, queues] = await Promise.all([
    // Everything that entered through the paper path, newest first.
    db.query(
      `select gr.redeemed_at, gt.tier, gt.gift_name, s.full_name, s.lookup_code,
              gr.staff_id
         from gift_redemptions gr
         join gift_tiers gt on gt.id = gr.gift_tier_id
         join students s on s.id = gr.student_id
        where gr.event_id = $1 and gr.was_offline
        order by gr.redeemed_at desc limit 200`, [eventId]),
    db.query(
      `select id, tier, gift_name from gift_tiers
        where event_id = $1 and is_active order by tier`, [eventId]),
    db.query(
      `select id, name from special_activities where event_id = $1 order by id`, [eventId]),
    // Devices still holding unsent scans — the other half of closing the books.
    db.query(
      `select label, staff_name, queue_depth, last_sync_at
         from v_device_health where event_id = $1 and queue_depth > 0
        order by queue_depth desc`, [eventId]),
  ]);

  return Response.json(
    { paper: paper.rows, tiers: tiers.rows, activities: activities.rows,
      pending_queues: queues.rows },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}

export async function POST(request) {
  const auth = checkAdmin(request);
  if (!auth.ok) return adminError(auth);
  const body = await request.json().catch(() => ({}));
  const eventId = Number(body.event ?? 1);
  const actor = String(body.actor ?? '').trim();
  const studentId = Number(body.student_id);
  if (!actor) return Response.json({ error: 'Thiếu tên người thao tác' }, { status: 400 });
  if (!studentId) return Response.json({ error: 'Thiếu sinh viên' }, { status: 400 });

  const db = await getDb();

  if (body.type === 'gift') {
    const r = (await db.query(
      `select * from claim_gift_tier($1::smallint, $2::bigint, $3::integer, $4, $5, true)`,
      [eventId, studentId, Number(body.tier_id), `paper:${actor}`, 'reconciliation'],
    )).rows[0];
    if (r.result !== 'ok') {
      const msg = {
        already_claimed: 'SV này ĐÃ có bậc này trong hệ thống — vé giấy trùng, kiểm tra lại sổ',
        out_of_stock: 'Kho bậc này đã hết trên hệ thống — số giấy và số máy đang lệch, cần đối chiếu tay',
        not_eligible: 'SV không đủ badge cho bậc này — ghi chú lại, có thể đã phát nhầm tại quầy',
        // Hai mã dưới đây KHÔNG xảy ra trên đường vé giấy — 0014 tắt cả cascade
        // lẫn luật chặn phát lùi khi was_offline, đúng vì mỗi tấm vé là một món
        // đã trao tận tay chứ không phải một yêu cầu chờ xét. Vẫn dịch sẵn:
        // một mã tiếng Anh lọt ra màn chốt sổ lúc 22:00 là thứ không ai đoán nổi.
        claim_top_tier_first: 'Hệ thống yêu cầu phát bậc cao nhất trước — nhập vé bậc cao rồi nhập lại vé này',
        not_highest_tier: 'Sự kiện đang ở chế độ "bậc cao nhất" — chỉ nhập được bậc cao nhất SV đạt',
        unknown_tier: 'Bậc quà không tồn tại hoặc đã tắt',
        not_registered: 'SV chưa đăng ký sự kiện này',
      }[r.result] ?? r.result;
      return Response.json({ error: msg, result: r.result }, { status: 409 });
    }
    return Response.json({ ok: true, gift: r.gift_name, remaining: r.remaining });
  }

  if (body.type === 'special') {
    const activityId = Number(body.activity_id);
    const h = (await db.query(
      `select * from hold_special_slot($1::smallint, $2::bigint, $3::integer, 60)`,
      [eventId, studentId, activityId],
    )).rows[0];
    if (h.result !== 'held' && h.result !== 'already_held') {
      const msg = {
        sold_out: 'Hệ thống đã hết suất — vé giấy vượt cap, cần đối chiếu với sổ',
        not_eligible: 'SV không đủ số hoạt động — có thể phát nhầm tại điểm',
        limit_reached: 'SV đã dùng hết lượt — vé giấy trùng',
      }[h.result] ?? h.result;
      return Response.json({ error: msg, result: h.result }, { status: 409 });
    }
    const c = (await db.query(
      `select * from confirm_special_slot($1::smallint, $2::bigint, $3::integer, $4)`,
      [eventId, studentId, activityId, `paper:${actor}`],
    )).rows[0];
    if (c.result !== 'ok') {
      return Response.json({ error: `Không xác nhận được: ${c.result}` }, { status: 409 });
    }
    return Response.json({ ok: true, slot_no: c.slot_no });
  }

  return Response.json({ error: 'type không hợp lệ' }, { status: 400 });
}
