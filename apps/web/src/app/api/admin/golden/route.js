/**
 * Giờ Vàng — activate / close (AC17). The three caps live in the DB
 * functions; this route only carries intent + actor. A Flow Marshal presses
 * the button, then walks to the MC — the app's audience for this feature is
 * the ~3 people running the floor, not the 2.000 students (that channel is
 * MC + zone signs + the PG's own banner, by decision).
 */

import { getDb } from '@atl/db';
import { checkAdmin, adminError } from '../../../../lib/admin-auth.js';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const auth = checkAdmin(request);
  if (!auth.ok) return adminError(auth);
  const body = await request.json().catch(() => ({}));
  const eventId = Number(body.event ?? 1);
  const actor = String(body.actor ?? '').trim();
  if (!actor) return Response.json({ error: 'Thiếu tên người thao tác' }, { status: 400 });

  const db = await getDb();

  if (body.action === 'activate') {
    const zoneId = Number(body.zone_id);
    if (!zoneId) return Response.json({ error: 'Thiếu zone' }, { status: 400 });
    const r = (await db.query(
      `select * from activate_golden_hour($1::smallint, $2::integer, $3, $4, $5)`,
      [eventId, zoneId, actor,
       Number(body.minutes ?? 40), Number(body.cap ?? 80)],
    )).rows[0];
    if (r.result !== 'ok') {
      const msg = {
        already_active: 'Đang có một Giờ Vàng chạy — đóng nó trước',
        budget_exhausted: 'Ngân sách badge thưởng của ngày đã hết',
        unknown_zone: 'Zone không tồn tại',
      }[r.result] ?? r.result;
      return Response.json({ error: msg, result: r.result }, { status: 409 });
    }
    return Response.json({ ok: true, golden_id: r.golden_id, ends_at: r.ends_at,
                           budget_left: r.budget_left });
  }

  if (body.action === 'close') {
    const id = (await db.query(
      `select close_golden_hour($1::smallint, $2) as id`, [eventId, actor],
    )).rows[0].id;
    if (id == null) return Response.json({ error: 'Không có Giờ Vàng nào đang mở' }, { status: 409 });
    return Response.json({ ok: true, closed: id });
  }

  return Response.json({ error: 'Hành động không hợp lệ' }, { status: 400 });
}
