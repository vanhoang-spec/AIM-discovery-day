/**
 * One student, and the two corrections an admin can make (AC36, second half).
 *
 * GET  — badge list with per-checkpoint provenance, redemptions, special slot.
 * POST — { action: 'void',  checkpoint_id, reason, actor }
 *        { action: 'award', checkpoint_id, reason, actor }
 *
 * Both corrections REQUIRE a reason and an actor name; both land in
 * audit_log. Void goes through void_attendance (soft delete + both counters
 * rebuilt in-function). Award goes through record_scan with source
 * 'admin_manual' — the same single write path every badge takes, so a manual
 * award can never bypass the unique index, the rollups, or the two ladders.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '@atl/db';
import { checkAdmin, adminError } from '../../../../../lib/admin-auth.js';

export const dynamic = 'force-dynamic';

export async function GET(request, { params }) {
  const auth = checkAdmin(request);
  if (!auth.ok) return adminError(auth);
  const { id } = await params;
  const eventId = Number(new URL(request.url).searchParams.get('event') ?? 1);
  const db = await getDb();

  const student = (await db.query(
    `select s.id, s.seq, s.full_name, s.lookup_code, s.phone, s.email,
            s.student_code, s.school_other, rs.name as school_name,
            r.badge_count
       from students s
       join registrations r on r.student_id = s.id and r.event_id = $2
       left join ref_schools rs on rs.id = s.school_id
      where s.id = $1`,
    [Number(id), eventId],
  )).rows[0];
  if (!student) return Response.json({ error: 'not_found' }, { status: 404 });

  const [badges, redemptions, checkpoints] = await Promise.all([
    db.query(
      `select a.checkpoint_id, c.name, c.kind::text as kind, a.awarded_at, a.source::text as source,
              a.voided_at, a.void_reason,
              case when c.counts_toward_badges then c.badge_weight else 0 end as badge_weight,
              counts_toward_special(c.kind, c.counts_toward_badges) as is_core
         from attendance a
         join checkpoints c on c.id = a.checkpoint_id and c.event_id = a.event_id
        where a.event_id = $1 and a.student_id = $2
        order by a.awarded_at`,
      [eventId, Number(id)],
    ),
    db.query(
      `select gr.redeemed_at, gt.tier, gt.gift_name
         from gift_redemptions gr
         join gift_tiers gt on gt.id = gr.gift_tier_id
        where gr.event_id = $1 and gr.student_id = $2
        order by gt.tier`,
      [eventId, Number(id)],
    ),
    // For the award dropdown: checkpoints this student does NOT yet hold.
    db.query(
      `select c.id, c.name from checkpoints c
        where c.event_id = $1 and c.is_active
          and not exists (select 1 from attendance a
                           where a.event_id = c.event_id and a.checkpoint_id = c.id
                             and a.student_id = $2 and a.voided_at is null)
        order by c.display_order, c.id`,
      [eventId, Number(id)],
    ),
  ]);

  return Response.json(
    { student, badges: badges.rows, redemptions: redemptions.rows,
      awardable: checkpoints.rows },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}

export async function POST(request, { params }) {
  const auth = checkAdmin(request);
  if (!auth.ok) return adminError(auth);
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const eventId = Number(body.event ?? 1);
  const checkpointId = Number(body.checkpoint_id);
  const reason = String(body.reason ?? '').trim();
  const actor = String(body.actor ?? '').trim();

  if (!checkpointId) return Response.json({ error: 'Thiếu checkpoint' }, { status: 400 });
  if (reason.length < 5) {
    return Response.json({ error: 'Lý do bắt buộc, tối thiểu 5 ký tự' }, { status: 400 });
  }
  if (!actor) return Response.json({ error: 'Thiếu tên người thao tác' }, { status: 400 });

  const db = await getDb();

  if (body.action === 'void') {
    try {
      const r = await db.query(
        `select void_attendance($1::smallint, $2::bigint, $3::integer, $4, $5) as new_count`,
        [eventId, Number(id), checkpointId, actor, reason],
      );
      return Response.json({ ok: true, badge_count: r.rows[0].new_count });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 409 });
    }
  }

  if (body.action === 'award') {
    const r = await db.query(
      `select * from record_scan($1::uuid, $2::smallint, $3::bigint, $4::integer,
                                 'admin_manual'::scan_source, $5, 'admin-console', null, $6::jsonb)`,
      [randomUUID(), eventId, Number(id), checkpointId, actor,
       JSON.stringify({ reason, via: 'admin-console' })],
    );
    const row = r.rows[0];
    // record_scan writes the ledger; the console adds the WHY alongside.
    await db.query(
      `insert into audit_log (event_id, actor_type, actor_id, action, target_type, target_id,
                              reason, after_state)
       values ($1, 'super_admin', $2, 'manual_award', 'student', $3, $4, $5::jsonb)`,
      [eventId, actor, String(id), reason,
       JSON.stringify({ checkpoint_id: checkpointId, status: row.status })],
    );
    if (row.status !== 'counted') {
      return Response.json(
        { error: row.status === 'repeat_not_counted'
            ? 'SV đã có badge này rồi' : `Không cấp được: ${row.status}` },
        { status: 409 },
      );
    }
    return Response.json({ ok: true, badge_count: row.badge_count });
  }

  return Response.json({ error: 'Hành động không hợp lệ' }, { status: 400 });
}
