/**
 * Event-level knobs: x/x+1/x+2 gift thresholds + stock, y, z, ladder mode
 * (R6/R7 — "x là số admin có thể thay đổi được", yêu cầu gốc của AIM).
 *
 * The one rule that shapes this file: NEVER revoke granted rights. Raising a
 * threshold mid-event does not touch existing redemptions (each carries
 * threshold_at_grant). So every change that NARROWS eligibility runs twice:
 * once as a dry run returning the impact ("223 SV mất điều kiện, 88 đã đổi
 * quà — giữ nguyên"), and only with confirm:true does it write. The admin
 * always sees the blast radius before pulling the trigger, and audit_log
 * records before/after either way.
 */

import { getDb } from '@atl/db';
import { checkAdmin, adminError } from '../../../../lib/admin-auth.js';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const auth = checkAdmin(request);
  if (!auth.ok) return adminError(auth);
  const eventId = Number(new URL(request.url).searchParams.get('event') ?? 1);
  const db = await getDb();

  const [event, tiers, checkpoints, zones] = await Promise.all([
    db.query(
      `select id, name, special_threshold_y, special_claim_limit, gift_ladder_mode,
              early_bird_until, sms_enabled, is_registration_open,
              checkin_checkpoint_id, early_bird_checkpoint_id
         from events where id = $1`, [eventId]),
    db.query(
      `select id, tier, gift_name, required_badges, stock_total, stock_issued, is_active
         from gift_tiers where event_id = $1 order by tier`, [eventId]),
    db.query(
      `select c.id, c.name, c.kind::text as kind, c.description, c.location_hint,
              c.starts_at, c.ends_at, c.capacity, c.zone_id,
              c.counts_toward_badges, c.badge_award_mode::text as badge_award_mode,
              c.is_active, c.display_order, c.badge_weight
         from checkpoints c where c.event_id = $1
        order by c.display_order, c.id`, [eventId]),
    db.query(`select id, name from zones where event_id = $1 order by display_order`, [eventId]),
  ]);

  return Response.json(
    { event: event.rows[0], tiers: tiers.rows,
      checkpoints: checkpoints.rows, zones: zones.rows },
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

  // Create a NEW gift tier (Layer B — the edit UI existed, creation did not).
  const tier = Number(body.tier);
  const name = String(body.gift_name ?? '').trim();
  const req = Number(body.required_badges);
  const stock = Number(body.stock_total);
  if (!Number.isInteger(tier) || tier < 1 || !name
      || !Number.isInteger(req) || req < 0
      || !Number.isInteger(stock) || stock < 0) {
    return Response.json({ error: 'Thiếu hoặc sai dữ liệu bậc quà' }, { status: 400 });
  }
  const db = await getDb();
  try {
    const r = await db.query(
      `insert into gift_tiers (event_id, tier, required_badges, gift_name, stock_total)
       values ($1, $2, $3, $4, $5) returning id`,
      [eventId, tier, req, name, stock]);
    await db.query(
      `insert into audit_log (event_id, actor_type, actor_id, action, target_type, target_id,
                              after_state)
       values ($1, 'super_admin', $2, 'create_gift_tier', 'gift_tier', $3::text, $4::jsonb)`,
      [eventId, actor, String(r.rows[0].id),
       JSON.stringify({ tier, required_badges: req, stock_total: stock })]);
    return Response.json({ ok: true, id: r.rows[0].id });
  } catch (err) {
    return Response.json(
      { error: /unique/i.test(err.message) ? `Bậc ${tier} đã tồn tại` : err.message },
      { status: 409 });
  }
}

export async function PATCH(request) {
  const auth = checkAdmin(request);
  if (!auth.ok) return adminError(auth);
  const body = await request.json().catch(() => ({}));
  const eventId = Number(body.event ?? 1);
  const actor = String(body.actor ?? '').trim();
  if (!actor) return Response.json({ error: 'Thiếu tên người thao tác' }, { status: 400 });

  const db = await getDb();

  // ---- y (special threshold) ----
  if (body.type === 'event_y') {
    const newY = Number(body.value);
    if (!Number.isInteger(newY) || newY < 0 || newY > 20) {
      return Response.json({ error: 'Giá trị y không hợp lệ' }, { status: 400 });
    }
    const cur = (await db.query(
      `select special_threshold_y from events where id = $1`, [eventId])).rows[0];
    if (!cur) return Response.json({ error: 'not_found' }, { status: 404 });
    const oldY = cur.special_threshold_y;

    if (newY > oldY) {
      const impact = (await db.query(
        `select count(*)::int as losing from registrations
          where event_id = $1 and core_badge_count >= $2 and core_badge_count < $3`,
        [eventId, oldY, newY])).rows[0];
      if (!body.confirm) {
        return Response.json({
          dry_run: true,
          message: `Tăng y từ ${oldY} lên ${newY}: ${impact.losing} SV đang đủ điều kiện sẽ mất điều kiện. Suất đã cấp giữ nguyên.`,
        });
      }
    }
    await db.query(`update events set special_threshold_y = $2 where id = $1`, [eventId, newY]);
    await db.query(
      `insert into audit_log (event_id, actor_type, actor_id, action, target_type, target_id,
                              before_state, after_state)
       values ($1, 'super_admin', $2, 'set_threshold_y', 'event', $5,
               jsonb_build_object('y', $3::int), jsonb_build_object('y', $4::int))`,
      // $5: không dùng lại $1 dưới hai kiểu (42P08 — xem event/route.js).
      [eventId, actor, oldY, newY, String(eventId)]);
    return Response.json({ ok: true, y: newY });
  }

  // ---- z (per-student special claim limit) / ladder mode ----
  if (body.type === 'event_field') {
    const allowed = {
      special_claim_limit: (v) => Number.isInteger(v) && v >= 0 && v <= 10,
      gift_ladder_mode: (v) => v === 'cumulative' || v === 'highest_only',
    };
    const field = body.field;
    if (!allowed[field] || !allowed[field](body.value)) {
      return Response.json({ error: 'Trường hoặc giá trị không hợp lệ' }, { status: 400 });
    }
    const before = (await db.query(
      `select special_claim_limit, gift_ladder_mode from events where id = $1`, [eventId])).rows[0];
    await db.query(
      field === 'special_claim_limit'
        ? `update events set special_claim_limit = $2 where id = $1`
        : `update events set gift_ladder_mode = $2 where id = $1`,
      [eventId, body.value]);
    await db.query(
      `insert into audit_log (event_id, actor_type, actor_id, action, target_type, target_id,
                              before_state, after_state)
       values ($1, 'super_admin', $2, 'set_event_field', 'event', $5, $3::jsonb, $4::jsonb)`,
      // $5: không dùng lại $1 dưới hai kiểu (42P08 — xem event/route.js).
      [eventId, actor, JSON.stringify(before),
       JSON.stringify({ [field]: body.value }), String(eventId)]);
    return Response.json({ ok: true });
  }

  // ---- gift tier: threshold or stock ----
  if (body.type === 'tier') {
    const tierId = Number(body.tier_id);
    const cur = (await db.query(
      `select tier, gift_name, required_badges, stock_total, stock_issued
         from gift_tiers where id = $1 and event_id = $2`, [tierId, eventId])).rows[0];
    if (!cur) return Response.json({ error: 'not_found' }, { status: 404 });

    const req = body.required_badges != null ? Number(body.required_badges) : cur.required_badges;
    const stock = body.stock_total != null ? Number(body.stock_total) : cur.stock_total;
    if (!Number.isInteger(req) || req < 0 || !Number.isInteger(stock) || stock < 0) {
      return Response.json({ error: 'Giá trị không hợp lệ' }, { status: 400 });
    }
    if (stock < cur.stock_issued) {
      return Response.json(
        { error: `Không thể đặt kho ${stock} thấp hơn số đã phát (${cur.stock_issued})` },
        { status: 409 });
    }
    if (req > cur.required_badges) {
      const impact = (await db.query(
        `select count(*) filter (where r.badge_count >= $2 and r.badge_count < $3)::int as losing,
                (select count(*)::int from gift_redemptions gr
                  where gr.gift_tier_id = $4 and gr.event_id = $1) as already_redeemed
           from registrations r where r.event_id = $1`,
        [eventId, cur.required_badges, req, tierId])).rows[0];
      if (!body.confirm) {
        return Response.json({
          dry_run: true,
          message: `Tăng bậc ${cur.tier} từ ${cur.required_badges} lên ${req} badge: ${impact.losing} SV không còn đủ điều kiện; ${impact.already_redeemed} SV đã đổi quà (giữ nguyên).`,
        });
      }
    }
    await db.query(
      `update gift_tiers set required_badges = $3, stock_total = $4
        where id = $1 and event_id = $2`, [tierId, eventId, req, stock]);
    await db.query(
      `insert into audit_log (event_id, actor_type, actor_id, action, target_type, target_id,
                              before_state, after_state)
       values ($1, 'super_admin', $2, 'set_gift_tier', 'gift_tier', $3::text, $4::jsonb, $5::jsonb)`,
      [eventId, actor, String(tierId),
       JSON.stringify({ required_badges: cur.required_badges, stock_total: cur.stock_total }),
       JSON.stringify({ required_badges: req, stock_total: stock })]);
    return Response.json({ ok: true });
  }

  return Response.json({ error: 'type không hợp lệ' }, { status: 400 });
}
