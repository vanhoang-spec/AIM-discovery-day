/**
 * GET /api/pg/roster[?since=ISO] — the offline lookup table.
 *
 * Full snapshot at the briefing, deltas during the day. The delta is what
 * closes the gap the dress rehearsal must test for: a device that cached its
 * roster last night knows nothing about the students who registered at the
 * door this morning, and the manual-lookup path is exactly where that gap
 * hurts. Ten-minute polling keeps it small.
 *
 * Note what is NOT here: no email, no address, no consent flags. A PG phone is
 * an unmanaged personal device, so it holds the minimum needed to identify a
 * student at a booth — name, student number, phone, badge count.
 */

import { getDb } from '@atl/db';
import { bearerFrom, sha256Hex } from '@/lib/device';

export async function GET(request) {
  const token = bearerFrom(request);
  if (!token) return Response.json({ error: 'Thiếu token thiết bị' }, { status: 401 });

  const db = await getDb();
  const tokenHash = await sha256Hex(token);

  const dev = await db.query(`select * from resolve_pg_device($1)`, [tokenHash]);
  if (dev.rows.length === 0) {
    return Response.json({ error: 'Thiết bị đã bị thu hồi' }, { status: 403 });
  }

  const since = new URL(request.url).searchParams.get('since');
  const rows = await db.query(
    `select * from pg_roster($1::smallint, $2::timestamptz)`,
    [dev.rows[0].event_id, since || null],
  );

  return Response.json(
    {
      students: rows.rows,
      // The client stores this and sends it back as `since` next time. Server
      // time, not device time — forty borrowed phones have forty wrong clocks.
      version: new Date().toISOString(),
      full: !since,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
