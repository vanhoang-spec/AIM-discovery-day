/**
 * PG staff & scanner devices (Layer B) — the gap that mattered most: 45 real
 * devices were creatable only through SQL. Now the console mints claim codes
 * (Crockford, same generator as student lookup codes — one alphabet across
 * the whole system), assigns zones/staff, and revokes.
 *
 * Revoke is the security lever: it clears token_hash and stamps revoked_at,
 * so the phone's stored token dies on its very next request (tested in
 * ops-admin.test.js). A lost phone is one click from harmless.
 */

import { getDb } from '@atl/db';
import { generateLookupCode } from '@atl/qr-token';
import { checkAdmin, adminError } from '../../../../lib/admin-auth.js';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const auth = checkAdmin(request);
  if (!auth.ok) return adminError(auth);
  const eventId = Number(new URL(request.url).searchParams.get('event') ?? 1);
  const db = await getDb();
  const [devices, staff, zones] = await Promise.all([
    db.query(
      `select d.id, d.label, d.claim_code, d.zone_id, d.pg_staff_id,
              s.full_name as staff_name, z.name as zone_name,
              d.claimed_at, d.revoked_at, d.last_sync_at, d.queue_depth, d.battery_pct
         from pg_devices d
         left join pg_staff s on s.id = d.pg_staff_id and s.event_id = d.event_id
         left join zones z on z.id = d.zone_id and z.event_id = d.event_id
        where d.event_id = $1
        order by d.revoked_at nulls first, d.label`, [eventId]),
    db.query(
      `select id, full_name, role from pg_staff where event_id = $1 order by full_name`,
      [eventId]),
    db.query(`select id, name from zones where event_id = $1 order by display_order`, [eventId]),
  ]);
  return Response.json(
    { devices: devices.rows, staff: staff.rows, zones: zones.rows },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}

export async function POST(request) {
  const auth = checkAdmin(request);
  if (!auth.ok) return adminError(auth);
  const body = await request.json().catch(() => ({}));
  const eventId = Number(body.event ?? 1);
  const actor = String(body.actor ?? '').trim();
  if (!actor) return Response.json({ error: 'Thiếu tên người thao tác' }, { status: 400 });

  const db = await getDb();

  if (body.type === 'staff') {
    const name = String(body.full_name ?? '').trim();
    if (!name) return Response.json({ error: 'Thiếu tên PG' }, { status: 400 });
    const role = body.role === 'supervisor' ? 'supervisor' : 'pg';
    const r = await db.query(
      `insert into pg_staff (event_id, full_name, role) values ($1, $2, $3) returning id`,
      [eventId, name, role],
    );
    await db.query(
      `insert into audit_log (event_id, actor_type, actor_id, action, target_type, target_id)
       values ($1, 'super_admin', $2, 'create_pg_staff', 'pg_staff', $3::text)`,
      [eventId, actor, String(r.rows[0].id)]);
    return Response.json({ ok: true, id: r.rows[0].id });
  }

  if (body.type === 'device') {
    const label = String(body.label ?? '').trim();
    if (!label) return Response.json({ error: 'Thiếu nhãn máy (vd: PG-08)' }, { status: 400 });

    // Crockford code from the shared generator; retried on the rare collision
    // — same pattern register_student uses for lookup codes.
    let created = null;
    for (let attempt = 0; attempt < 5 && !created; attempt++) {
      const code = generateLookupCode(crypto.getRandomValues(new Uint8Array(8)));
      try {
        const r = await db.query(
          `insert into pg_devices (event_id, claim_code, label, zone_id, pg_staff_id)
           values ($1, $2, $3, $4, $5) returning id, claim_code`,
          [eventId, code, label,
           body.zone_id ? Number(body.zone_id) : null,
           body.pg_staff_id ? Number(body.pg_staff_id) : null],
        );
        created = r.rows[0];
      } catch (err) {
        if (!/unique|duplicate/i.test(err.message)) throw err;
      }
    }
    if (!created) return Response.json({ error: 'Không sinh được mã — thử lại' }, { status: 500 });
    await db.query(
      `insert into audit_log (event_id, actor_type, actor_id, action, target_type, target_id,
                              after_state)
       values ($1, 'super_admin', $2, 'create_pg_device', 'pg_device', $3::text, $4::jsonb)`,
      [eventId, actor, String(created.id), JSON.stringify({ label })]);
    return Response.json({ ok: true, id: created.id, claim_code: created.claim_code });
  }

  return Response.json({ error: 'type không hợp lệ' }, { status: 400 });
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

  if (body.action === 'revoke') {
    const r = await db.query(
      `update pg_devices set revoked_at = now(), token_hash = null
        where id = $1 and event_id = $2 and revoked_at is null
        returning label`,
      [id, eventId]);
    if (!r.rows.length) return Response.json({ error: 'Máy không tồn tại hoặc đã thu hồi' }, { status: 409 });
    await db.query(
      `insert into audit_log (event_id, actor_type, actor_id, action, target_type, target_id,
                              reason)
       values ($1, 'super_admin', $2, 'revoke_pg_device', 'pg_device', $3::text, $4)`,
      [eventId, actor, String(id), String(body.reason ?? '').trim() || null]);
    return Response.json({ ok: true, revoked: r.rows[0].label });
  }

  const patch = {};
  if (body.zone_id !== undefined) patch.zone_id = body.zone_id ? Number(body.zone_id) : null;
  if (body.pg_staff_id !== undefined) patch.pg_staff_id = body.pg_staff_id ? Number(body.pg_staff_id) : null;
  if (body.label != null && String(body.label).trim()) patch.label = String(body.label).trim();
  const keys = Object.keys(patch);
  if (!keys.length) return Response.json({ error: 'Không có gì để sửa' }, { status: 400 });

  const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
  const r = await db.query(
    `update pg_devices set ${sets} where id = $1 and event_id = $2 returning id`,
    [id, eventId, ...keys.map((k) => patch[k])]);
  if (!r.rows.length) return Response.json({ error: 'not_found' }, { status: 404 });
  await db.query(
    `insert into audit_log (event_id, actor_type, actor_id, action, target_type, target_id,
                            after_state)
     values ($1, 'super_admin', $2, 'update_pg_device', 'pg_device', $3::text, $4::jsonb)`,
    [eventId, actor, String(id), JSON.stringify(patch)]);
  return Response.json({ ok: true });
}
