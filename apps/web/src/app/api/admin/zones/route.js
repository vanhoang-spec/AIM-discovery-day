/**
 * Zone CRUD (Layer B). Zones were seed-only; a fork configuring a new venue
 * needs them creatable from the console. Deleting is deliberately absent —
 * a zone with history must not vanish; deactivate its checkpoints instead.
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
  const name = String(body.name ?? '').trim();
  if (!actor) return Response.json({ error: 'Thiếu tên người thao tác' }, { status: 400 });
  if (!name) return Response.json({ error: 'Thiếu tên zone' }, { status: 400 });

  const db = await getDb();
  const r = await db.query(
    `insert into zones (event_id, name, display_order)
     values ($1, $2, coalesce($3, (select coalesce(max(display_order), 0) + 1
                                     from zones where event_id = $1)))
     returning id`,
    [eventId, name, body.display_order != null ? Number(body.display_order) : null],
  );
  await db.query(
    `insert into audit_log (event_id, actor_type, actor_id, action, target_type, target_id)
     values ($1, 'super_admin', $2, 'create_zone', 'zone', $3::text)`,
    [eventId, actor, String(r.rows[0].id)],
  );
  return Response.json({ ok: true, id: r.rows[0].id });
}

export async function PATCH(request) {
  const auth = checkAdmin(request);
  if (!auth.ok) return adminError(auth);
  const body = await request.json().catch(() => ({}));
  const eventId = Number(body.event ?? 1);
  const id = Number(body.id);
  const actor = String(body.actor ?? '').trim();
  const name = String(body.name ?? '').trim();
  if (!id || !actor || !name) return Response.json({ error: 'Thiếu dữ liệu' }, { status: 400 });

  const db = await getDb();
  const r = await db.query(
    `update zones set name = $3 where id = $1 and event_id = $2 returning id`,
    [id, eventId, name],
  );
  if (!r.rows.length) return Response.json({ error: 'not_found' }, { status: 404 });
  await db.query(
    `insert into audit_log (event_id, actor_type, actor_id, action, target_type, target_id,
                            after_state)
     values ($1, 'super_admin', $2, 'rename_zone', 'zone', $3::text, $4::jsonb)`,
    [eventId, actor, String(id), JSON.stringify({ name })],
  );
  return Response.json({ ok: true });
}
