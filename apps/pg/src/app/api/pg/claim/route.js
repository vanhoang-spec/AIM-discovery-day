/**
 * POST /api/pg/claim — one device, once, at the briefing.
 *
 * Takes the 6-character code printed on the device card and returns a bearer
 * token the phone stores. This is the only moment the PG app needs a good
 * connection; everything after it works offline.
 */

import { getDb } from '@atl/db';
import { sha256Hex, mintToken } from '@/lib/device';

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Dữ liệu không hợp lệ' }, { status: 400 });
  }

  const code = String(body.claim_code ?? '').replace(/[\s-]/g, '').toUpperCase();
  const pin = String(body.pin ?? '');

  if (!/^[0-9A-HJKMNP-TV-Z]{6}$/.test(code)) {
    return Response.json({ error: 'Mã thiết bị gồm 6 ký tự' }, { status: 400 });
  }
  if (!/^\d{4}$/.test(pin)) {
    return Response.json({ error: 'PIN gồm 4 chữ số' }, { status: 400 });
  }

  const token = mintToken();
  const db = await getDb();

  try {
    const res = await db.query(
      `select * from claim_pg_device($1, $2, $3, $4::integer, $5)`,
      [code, await sha256Hex(token), await sha256Hex(`${code}:${pin}`),
       body.pg_staff_id ?? null, body.app_version ?? null],
    );
    const row = res.rows[0];

    // Everything the device needs to run offline for the rest of the day:
    // its identity, its scope, and the checkpoints it may scan.
    const [checkpoints, event] = await Promise.all([
      db.query(
        `select c.id, c.name, c.kind, c.zone_id, z.name as zone_name,
                c.counts_toward_badges, c.badge_weight
           from checkpoints c
           left join zones z on z.id = c.zone_id and z.event_id = c.event_id
          where c.event_id = $1 and c.is_active
          order by c.display_order, c.id`,
        [row.event_id],
      ),
      db.query(
        `select id, name, slug, early_bird_until, checkin_checkpoint_id
           from events where id = $1`,
        [row.event_id],
      ),
    ]);

    return Response.json({
      token,
      device: {
        id: row.device_id,
        label: row.label,
        event_id: row.event_id,
        zone_id: row.zone_id,
        zone_name: row.zone_name,
        staff_name: row.staff_name,
      },
      event: event.rows[0],
      checkpoints: checkpoints.rows,
    });
  } catch (err) {
    const known = /Mã thiết bị/.test(err.message ?? '');
    if (known) return Response.json({ error: err.message }, { status: 404 });
    console.error('claim_pg_device failed:', err);
    return Response.json({ error: 'Không nhận diện được thiết bị' }, { status: 500 });
  }
}
