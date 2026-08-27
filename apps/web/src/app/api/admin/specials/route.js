/**
 * Special activities CRUD (Layer B). The one rule that matters: capacity IS
 * the number of pre-allocated slot rows — every create or raise flows
 * through ensure_special_slots (0003), which fills exactly the shortfall and
 * never duplicates. Lowering capacity is refused when it would strand
 * already-claimed slots; the cap can be closed with is_open instead.
 */

import { getDb } from '@atl/db';
import { checkAdmin, adminError } from '../../../../lib/admin-auth.js';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const auth = checkAdmin(request);
  if (!auth.ok) return adminError(auth);
  const eventId = Number(new URL(request.url).searchParams.get('event') ?? 1);
  const db = await getDb();
  const rows = (await db.query(
    `select sa.id, sa.name, sa.capacity, sa.is_open,
            count(ss.*) filter (where ss.student_id is not null)::int as claimed
       from special_activities sa
       left join special_slots ss on ss.special_activity_id = sa.id
      where sa.event_id = $1
      group by sa.id order by sa.id`, [eventId])).rows;
  return Response.json({ activities: rows },
    { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function POST(request) {
  const auth = checkAdmin(request);
  if (!auth.ok) return adminError(auth);
  const body = await request.json().catch(() => ({}));
  const eventId = Number(body.event ?? 1);
  const actor = String(body.actor ?? '').trim();
  const name = String(body.name ?? '').trim();
  const capacity = Number(body.capacity);
  if (!actor || !name) return Response.json({ error: 'Thiếu dữ liệu' }, { status: 400 });
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 2000) {
    return Response.json({ error: 'Số suất từ 1 đến 2000' }, { status: 400 });
  }

  const db = await getDb();
  const r = await db.query(
    `insert into special_activities (event_id, name, capacity, is_open)
     values ($1, $2, $3, false) returning id`,
    [eventId, name, capacity],
  );
  await db.query(`select ensure_special_slots($1)`, [r.rows[0].id]);
  await db.query(
    `insert into audit_log (event_id, actor_type, actor_id, action, target_type, target_id,
                            after_state)
     values ($1, 'super_admin', $2, 'create_special', 'special_activity', $3::text, $4::jsonb)`,
    [eventId, actor, String(r.rows[0].id), JSON.stringify({ name, capacity })],
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
  if (!id || !actor) return Response.json({ error: 'Thiếu dữ liệu' }, { status: 400 });

  const db = await getDb();
  const cur = (await db.query(
    `select sa.capacity, sa.is_open, sa.name,
            count(ss.*) filter (where ss.student_id is not null)::int as claimed
       from special_activities sa
       left join special_slots ss on ss.special_activity_id = sa.id
      where sa.id = $1 and sa.event_id = $2
      group by sa.id`, [id, eventId])).rows[0];
  if (!cur) return Response.json({ error: 'not_found' }, { status: 404 });

  const patch = {};
  if (body.name != null && String(body.name).trim()) patch.name = String(body.name).trim();
  if (body.is_open !== undefined) patch.is_open = !!body.is_open;
  if (body.capacity !== undefined) {
    const cap = Number(body.capacity);
    if (!Number.isInteger(cap) || cap < 1 || cap > 2000) {
      return Response.json({ error: 'Số suất từ 1 đến 2000' }, { status: 400 });
    }
    if (cap < cur.claimed) {
      return Response.json(
        { error: `Không thể hạ xuống ${cap} — đã cấp ${cur.claimed} suất. Muốn dừng nhận thì tắt hoạt động.` },
        { status: 409 });
    }
    patch.capacity = cap;
  }
  const keys = Object.keys(patch);
  if (!keys.length) return Response.json({ error: 'Không có gì để sửa' }, { status: 400 });

  const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
  await db.query(
    `update special_activities set ${sets} where id = $1 and event_id = $2`,
    [id, eventId, ...keys.map((k) => patch[k])],
  );
  // Raising capacity mints the shortfall; lowering never deletes slots (empty
  // extra slots above a lowered cap are harmless: hold_special_slot allocates
  // by slot_no order and the cap check is capacity-based in the view).
  if (patch.capacity && patch.capacity > cur.capacity) {
    await db.query(`select ensure_special_slots($1)`, [id]);
  }
  await db.query(
    `insert into audit_log (event_id, actor_type, actor_id, action, target_type, target_id,
                            before_state, after_state)
     values ($1, 'super_admin', $2, 'update_special', 'special_activity', $3::text,
             $4::jsonb, $5::jsonb)`,
    [eventId, actor, String(id),
     JSON.stringify({ capacity: cur.capacity, is_open: cur.is_open }),
     JSON.stringify(patch)],
  );
  return Response.json({ ok: true });
}
