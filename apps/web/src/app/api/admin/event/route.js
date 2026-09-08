/**
 * Event-level operational switches (Layer B): the registration gate and the
 * Early Bird window. Small surface, big consequences — every change lands in
 * audit_log with before/after, because "ai đã đóng đăng ký lúc 21:14" is a
 * question that WILL be asked.
 */

import { getDb } from '@atl/db';
import { checkAdmin, adminError } from '../../../../lib/admin-auth.js';

export const dynamic = 'force-dynamic';

export async function PATCH(request) {
  const auth = checkAdmin(request);
  if (!auth.ok) return adminError(auth);
  const body = await request.json().catch(() => ({}));
  const eventId = Number(body.event ?? 1);
  const actor = String(body.actor ?? '').trim();
  if (!actor) return Response.json({ error: 'Thiếu tên người thao tác' }, { status: 400 });

  const db = await getDb();
  const before = (await db.query(
    `select is_registration_open, early_bird_until, checkin_checkpoint_id,
            early_bird_checkpoint_id
       from events where id = $1`, [eventId])).rows[0];
  if (!before) return Response.json({ error: 'not_found' }, { status: 404 });

  const patch = {};
  if (body.is_registration_open !== undefined) {
    patch.is_registration_open = !!body.is_registration_open;
  }
  if (body.early_bird_until !== undefined) {
    patch.early_bird_until = body.early_bird_until || null;
  }
  for (const k of ['checkin_checkpoint_id', 'early_bird_checkpoint_id']) {
    if (body[k] !== undefined) {
      patch[k] = body[k] ? Number(body[k]) : null;
      if (patch[k] !== null) {
        const ok = (await db.query(
          `select 1 from checkpoints where id = $1 and event_id = $2`,
          [patch[k], eventId])).rows.length;
        if (!ok) return Response.json({ error: 'Checkpoint không thuộc sự kiện này' }, { status: 400 });
      }
    }
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) return Response.json({ error: 'Không có gì để sửa' }, { status: 400 });

  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await db.query(
    `update events set ${sets} where id = $1`,
    [eventId, ...keys.map((k) => patch[k])],
  );
  await db.query(
    `insert into audit_log (event_id, actor_type, actor_id, action, target_type, target_id,
                            before_state, after_state)
     values ($1, 'super_admin', $2, 'set_event_ops', 'event', $5, $3::jsonb, $4::jsonb)`,
    // $5 riêng cho target_id: dùng lại $1 với hai kiểu (smallint + ::text) làm
    // Postgres từ chối suy kiểu — 42P08, chính là cú HTTP 500 ngày 08/09 khi
    // AIM bấm "Mở đăng ký" lần đầu tiên.
    [eventId, actor, JSON.stringify(before), JSON.stringify(patch), String(eventId)],
  );
  return Response.json({ ok: true });
}
