/**
 * AC28 — clone an event's configuration for the next one (Grand Finale,
 * next season). Copies structure, never people or history; the clone is
 * born with registration CLOSED. All the rules live in clone_event (0009).
 */

import { getDb } from '@atl/db';
import { checkAdmin, adminError } from '../../../../lib/admin-auth.js';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const auth = checkAdmin(request);
  if (!auth.ok) return adminError(auth);
  const body = await request.json().catch(() => ({}));
  const actor = String(body.actor ?? '').trim();
  if (!actor) return Response.json({ error: 'Thiếu tên người thao tác' }, { status: 400 });

  const slug = String(body.slug ?? '').trim().toLowerCase();
  const name = String(body.name ?? '').trim();
  const venue = String(body.venue ?? '').trim();
  const city = String(body.city ?? '').trim();
  const startsAt = String(body.starts_at ?? '').trim();
  const endsAt = String(body.ends_at ?? '').trim();
  if (!/^[a-z0-9-]{2,40}$/.test(slug)) {
    return Response.json({ error: 'Slug chỉ gồm a-z, 0-9, dấu gạch' }, { status: 400 });
  }
  if (!name || !venue || !city || !startsAt || !endsAt) {
    return Response.json({ error: 'Thiếu thông tin sự kiện mới' }, { status: 400 });
  }

  const db = await getDb();
  try {
    const r = (await db.query(
      `select * from clone_event($1::smallint, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8)`,
      [Number(body.source_event ?? 1), slug, name, venue, city, startsAt, endsAt, actor],
    )).rows[0];
    return Response.json({ ok: true, ...r });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 409 });
  }
}
