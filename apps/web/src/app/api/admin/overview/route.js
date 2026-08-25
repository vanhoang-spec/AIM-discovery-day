/**
 * One payload for the whole dashboard, polled every 5s by ~3 admin browsers.
 * Every number reads a rollup table or a small view — never COUNT(*) over
 * the ledger. 10 admin tabs = 2 req/s; nobody can tell it from realtime on
 * a bar chart, and there is no websocket tier to babysit.
 *
 * The response always carries generated_at: the dashboard's contract is
 * "dữ liệu tính đến HH:MM", never a promise of realtime — with 40 offline-
 * first scanners, honesty about staleness IS the feature (Ver02 §021 vs
 * §024 tension, resolved in spec §0.2).
 */

import { getDb } from '@atl/db';
import { checkAdmin, adminError } from '../../../../lib/admin-auth.js';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const auth = checkAdmin(request);
  if (!auth.ok) return adminError(auth);

  const eventId = Number(new URL(request.url).searchParams.get('event') ?? 1);
  const db = await getDb();

  const [totals, zones, tiers, special, devices, drift, threshold] = await Promise.all([
    // Registered / checked-in / badge funnel — all from registrations.
    db.query(
      `select count(*)::int                                   as registered,
              count(*) filter (where badge_count > 0)::int    as active,
              count(*) filter (where core_badge_count >= 1)::int as checked_in,
              coalesce(sum(badge_count), 0)::int              as badges_total
         from registrations where event_id = $1`,
      [eventId],
    ),
    // Zone heat: scans per zone over the last 15 minutes, from the rollup.
    db.query(
      `select z.id, z.name,
              coalesce(sum(m.scan_count) filter (
                where m.minute_ts >= now() - interval '15 minutes'), 0)::int as scans_15m,
              coalesce(sum(m.badge_count) filter (
                where m.minute_ts >= now() - interval '15 minutes'), 0)::int as badges_15m
         from zones z
         left join checkpoints c on c.zone_id = z.id and c.event_id = z.event_id
         left join checkpoint_minute_counts m
                on m.checkpoint_id = c.id and m.event_id = z.event_id
        where z.event_id = $1
        group by z.id, z.name
        order by scans_15m desc, z.display_order`,
      [eventId],
    ),
    // Gift funnel: per tier — how many students qualify, how many redeemed,
    // stock position.
    db.query(
      `select gt.tier, gt.gift_name, gt.required_badges,
              gt.stock_total, gt.stock_issued,
              (select count(*)::int from registrations r
                where r.event_id = gt.event_id
                  and r.badge_count >= gt.required_badges) as qualified,
              (select count(*)::int from gift_redemptions gr
                where gr.gift_tier_id = gt.id and gr.event_id = gt.event_id) as redeemed
         from gift_tiers gt
        where gt.event_id = $1 and gt.is_active
        order by gt.tier`,
      [eventId],
    ),
    db.query(`select * from v_special_control_panel where event_id = $1`, [eventId]),
    db.query(`select * from v_device_health where event_id = $1 limit 60`, [eventId]),
    // Drift: a count is enough for the dashboard tile; the reconciliation
    // screen drills in. 0 is the only good number.
    db.query(
      `select count(*)::int as drifted from v_progress_drift where event_id = $1`,
      [eventId],
    ),
    db.query(`select * from v_special_threshold_check where event_id = $1`, [eventId]),
  ]);

  return Response.json(
    {
      generated_at: new Date().toISOString(),
      event_id: eventId,
      totals: totals.rows[0],
      zones: zones.rows,
      tiers: tiers.rows,
      special: special.rows,
      devices: devices.rows,
      drift: drift.rows[0].drifted,
      threshold_check: threshold.rows[0] ?? null,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
