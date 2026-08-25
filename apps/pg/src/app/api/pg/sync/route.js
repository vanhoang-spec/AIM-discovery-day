/**
 * POST /api/pg/sync — the batch ingest the offline queue drains into.
 *
 * Contract with the client, in order of importance:
 *
 *   1. Every submitted scan gets exactly one result, keyed by `scan_uid`.
 *      The queue treats a missing result as unsent and retries — so partial
 *      answers are safe, but silence about an item is never read as success.
 *   2. Sending the same `scan_uid` twice is a no-op that reports `replay`.
 *      That is what makes the retry-on-flaky-network design safe.
 *   3. A rejected device gets a rejection per scan, not a 401. The scanner
 *      then marks those items rejected and shows them to the supervisor,
 *      rather than silently spinning forever against a revoked token.
 */

import { getDb } from '@atl/db';
import { bearerFrom, sha256Hex } from '@/lib/device';

const MAX_BATCH = 200;

export async function POST(request) {
  const token = bearerFrom(request);
  if (!token) {
    return Response.json({ error: 'Thiếu token thiết bị' }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Dữ liệu không hợp lệ' }, { status: 400 });
  }

  const scans = Array.isArray(body.scans) ? body.scans : [];
  if (scans.length === 0) return Response.json({ results: [] });
  if (scans.length > MAX_BATCH) {
    return Response.json(
      { error: `Tối đa ${MAX_BATCH} lượt quét mỗi lần gửi` },
      { status: 413 },
    );
  }

  const tokenHash = await sha256Hex(token);
  const db = await getDb();
  const results = [];

  // Sequential on purpose. Each call is a short transaction and the whole
  // batch is at most 200 rows; running them concurrently through a
  // transaction-mode pooler would consume connections for no gain, since the
  // physical scan rate is capped at roughly ten a second by the humans doing
  // the scanning.
  for (const scan of scans) {
    const uid = String(scan.scan_uid ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(uid)) {
      results.push({ scan_uid: uid, status: 'rejected_malformed' });
      continue;
    }
    try {
      const r = await db.query(
        `select * from record_pg_scan($1, $2::uuid, $3::integer, $4::integer,
                                      $5::timestamptz, $6::scan_source)`,
        [tokenHash, uid, Number(scan.student_seq), Number(scan.checkpoint_id),
         scan.client_ts ?? null, scan.source ?? 'pg_scan'],
      );
      const row = r.rows[0];
      results.push({
        scan_uid: row.scan_uid,
        status: row.status,
        badge_count: row.badge_count,
        student_name: row.student_name,
        early_bird: row.early_bird,
        golden: row.golden,
      });
    } catch (err) {
      // Report the failure against this scan rather than failing the batch:
      // one bad row must not strand the other 199.
      console.error('record_pg_scan failed for', uid, err);
      results.push({ scan_uid: uid, status: 'error', error: 'server' });
    }
  }

  // Device health rides along with the sync, so the supervisor board stays
  // live without the phone making a second request.
  if (typeof body.queue_depth === 'number') {
    await db.query(`select report_device_health($1, $2::integer, $3::smallint)`,
      [tokenHash, body.queue_depth, body.battery_pct ?? null]).catch(() => {});
  }

  // Giờ Vàng status rides along too — no new polling loop on 40 devices. A
  // device that is scanning IS syncing, so a golden-zone PG stays fresh; the
  // banner self-expires client-side via ends_at either way.
  let golden = null;
  try {
    const g = await db.query(
      `select g.zone_id, g.zone_name, g.ends_at, g.badge_cap, g.badges_issued
         from v_golden_status g
         join pg_devices d on d.event_id = g.event_id
        where d.token_hash = $1 and g.active
        limit 1`,
      [tokenHash],
    );
    golden = g.rows[0] ?? null;
  } catch { /* status is decorative; a sync must never fail on it */ }

  return Response.json({ results, golden_status: golden, server_now: new Date().toISOString() });
}
