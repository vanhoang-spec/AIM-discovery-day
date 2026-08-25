/**
 * Personal progress for /toi (the other half of AC "SV biết mình đã tham gia
 * bao nhiêu hoạt động", plus AC18's "bạn còn thiếu gì" screen).
 *
 * Auth IS the QR token: the client sends the signed token it already caches,
 * the server verifies the HMAC and derives event + student from it. No
 * session, no cookie, nothing new to lose — a phone that can show its QR can
 * fetch its progress, and nobody can fetch someone else's without their
 * token, which is exactly the same trust boundary as the QR itself.
 *
 * The response deliberately never carries exact stock numbers — 'ok' /
 * 'low' / 'out' only. Telling 20 queueing students "còn 12 phần" is how a
 * counter argument starts at the gift desk. 'low' = dưới 15%.
 *
 * Per-student and therefore uncacheable — this is the ~200-byte "cá nhân"
 * lane. Clients poll it foreground-only every 30s; at 1.900 phones that is
 * ~63 PK-indexed reads/s, well inside capacity. The broadcast lane (zone ×2,
 * announcements) stays on its own edge-cached endpoint.
 */

import { getDb } from '@atl/db';
import { verifyToken, importKey } from '@atl/qr-token';

export const dynamic = 'force-dynamic';

const DEV_KEY = 'atl2026-dev-key-do-not-use-in-production';

let keyPromise;
function getKey() {
  if (!keyPromise) {
    const secret = process.env.ATL_HMAC_KEY;
    if (!secret && process.env.NODE_ENV === 'production') {
      throw new Error('ATL_HMAC_KEY is required in production');
    }
    keyPromise = importKey(secret || DEV_KEY);
  }
  return keyPromise;
}

export async function GET(request) {
  const token = new URL(request.url).searchParams.get('t') ?? '';

  // verifyToken never throws — it returns { valid, reason } so the PG scanner
  // can show a distinct state per reason. Same contract here.
  const claims = await verifyToken(token, await getKey());
  if (!claims.valid) {
    return Response.json({ error: 'invalid_token', reason: claims.reason }, { status: 401 });
  }

  const db = await getDb();
  const student = (await db.query(
    `select id, full_name from students where seq = $1 and merged_into_id is null`,
    [claims.studentSeq],
  )).rows[0];
  if (!student) return Response.json({ error: 'unknown_student' }, { status: 404 });

  const eventId = claims.eventInstance;
  const reg = (await db.query(
    `select r.badge_count, r.core_badge_count
       from registrations r where r.event_id = $1 and r.student_id = $2`,
    [eventId, student.id],
  )).rows[0];
  if (!reg) return Response.json({ error: 'not_registered' }, { status: 404 });

  const [ev, tiers, redeemed, special] = await Promise.all([
    db.query(
      `select special_threshold_y, gift_ladder_mode from events where id = $1`,
      [eventId],
    ),
    db.query(
      `select id, tier, required_badges, gift_name,
              case
                when stock_issued >= stock_total then 'out'
                when stock_total - stock_issued < stock_total * 0.15 then 'low'
                else 'ok'
              end as stock
         from gift_tiers
        where event_id = $1 and is_active
        order by tier`,
      [eventId],
    ),
    db.query(
      `select gift_tier_id from gift_redemptions
        where event_id = $1 and student_id = $2`,
      [eventId, student.id],
    ),
    db.query(
      `select count(*) filter (where s.student_id is null
                                 and (s.held_until is null or s.held_until <= now()))::int
                as slots_left
         from special_activities sa
         join special_slots s on s.special_activity_id = sa.id
        where sa.event_id = $1 and sa.is_open`,
      [eventId],
    ),
  ]);

  const y = ev.rows[0]?.special_threshold_y ?? null;
  const redeemedIds = new Set(redeemed.rows.map((r) => r.gift_tier_id));

  return Response.json(
    {
      updated_at: new Date().toISOString(),
      event_id: eventId,
      badge_count: reg.badge_count,
      core_badge_count: reg.core_badge_count,
      tiers: tiers.rows.map((t) => ({
        tier: t.tier,
        required: t.required_badges,
        name: t.gift_name,
        stock: t.stock,
        redeemed: redeemedIds.has(t.id),
      })),
      special: {
        y,
        eligible: y != null && reg.core_badge_count >= y,
        core_badge_count: reg.core_badge_count,
        slots_left: special.rows[0]?.slots_left ?? 0,
      },
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
