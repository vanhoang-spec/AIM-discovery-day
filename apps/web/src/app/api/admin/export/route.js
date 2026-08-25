/**
 * AC33 — AIM's internal Excel export. Six sheets, one click, a real .xlsx.
 *
 * This is the INTERNAL export: full PII, because AIM is the data controller
 * running the event. The per-sponsor export (AC27) is a different route with
 * consent filtering and no contact columns — do not merge the two; their
 * privacy postures are opposites.
 *
 * Aggregate queries here scan real tables, not the 5s rollups — fine,
 * because this runs once after the event (or a handful of times during),
 * not on a poll. ~86k rows per event stays comfortably in one request.
 */

import { getDb } from '@atl/db';
import { buildWorkbook } from '@atl/xlsx-lite';
import { checkAdmin, adminError } from '../../../../lib/admin-auth.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const VN_OFFSET = "interval '7 hours'";

export async function GET(request) {
  const auth = checkAdmin(request);
  if (!auth.ok) return adminError(auth);
  const eventId = Number(new URL(request.url).searchParams.get('event') ?? 1);
  const db = await getDb();

  const ev = (await db.query(`select slug, name from events where id = $1`, [eventId])).rows[0];
  if (!ev) return Response.json({ error: 'not_found' }, { status: 404 });

  const [hourly, byZone, students, funnel, special, audit] = await Promise.all([
    db.query(
      `select to_char(minute_ts + ${VN_OFFSET}, 'HH24:00') as hour,
              sum(scan_count)::int as scans, sum(badge_count)::int as badges
         from checkpoint_minute_counts where event_id = $1
        group by 1 order by 1`, [eventId]),
    db.query(
      `select coalesce(z.name, '(không zone)') as zone, c.name as checkpoint,
              c.kind::text as kind,
              count(a.id) filter (where a.voided_at is null)::int as badges,
              count(a.id)::int as scans_counted
         from checkpoints c
         left join zones z on z.id = c.zone_id and z.event_id = c.event_id
         left join attendance a on a.checkpoint_id = c.id and a.event_id = c.event_id
        where c.event_id = $1
        group by z.name, c.name, c.kind, c.display_order
        order by z.name nulls last, c.display_order`, [eventId]),
    db.query(
      `select s.full_name, coalesce(rs.name, s.school_other, '') as school,
              coalesce(s.student_code, '') as mssv, coalesce(s.phone, '') as phone,
              coalesce(s.email, '') as email,
              r.badge_count, r.core_badge_count,
              case when s.consent_sponsors_at is not null then 'Có' else 'Không' end as consent_ntt,
              coalesce((
                select string_agg('Bậc ' || gt.tier, ', ' order by gt.tier)
                  from gift_redemptions gr
                  join gift_tiers gt on gt.id = gr.gift_tier_id
                 where gr.event_id = r.event_id and gr.student_id = s.id), '') as gifts
         from registrations r
         join students s on s.id = r.student_id
         left join ref_schools rs on rs.id = s.school_id
        where r.event_id = $1 and s.merged_into_id is null
        order by s.full_name`, [eventId]),
    db.query(
      `select gt.tier, gt.gift_name, gt.required_badges,
              (select count(*)::int from registrations r
                where r.event_id = $1 and r.badge_count >= gt.required_badges) as qualified,
              (select count(*)::int from gift_redemptions gr
                where gr.event_id = $1 and gr.gift_tier_id = gt.id) as redeemed,
              gt.stock_issued, gt.stock_total
         from gift_tiers gt where gt.event_id = $1 order by gt.tier`, [eventId]),
    db.query(
      `select sa.name as activity, ss.slot_no, s.full_name,
              to_char(ss.claimed_at + ${VN_OFFSET}, 'HH24:MI') as claimed_at
         from special_slots ss
         join special_activities sa on sa.id = ss.special_activity_id
         left join students s on s.id = ss.student_id
        where ss.event_id = $1 and ss.student_id is not null
        order by sa.name, ss.slot_no`, [eventId]),
    db.query(
      `select to_char(created_at + ${VN_OFFSET}, 'DD/MM HH24:MI') as at,
              actor_id, action, coalesce(target_id, '') as target,
              coalesce(reason, '') as reason
         from audit_log where event_id = $1
        order by created_at desc limit 500`, [eventId]),
  ]);

  const wb = buildWorkbook([
    { name: 'Điểm danh theo giờ', rows: [
      ['Giờ', 'Lượt quét', 'Badge cấp'],
      ...hourly.rows.map((r) => [r.hour, r.scans, r.badges]),
    ] },
    { name: 'Badge theo khu vực', rows: [
      ['Khu vực', 'Hoạt động', 'Loại', 'Badge (đang hiệu lực)', 'Tổng lượt tính'],
      ...byZone.rows.map((r) => [r.zone, r.checkpoint, r.kind, r.badges, r.scans_counted]),
    ] },
    { name: 'Sinh viên', rows: [
      ['Họ tên', 'Trường', 'MSSV', 'SĐT', 'Email', 'Badge', 'Hoạt động (thang đặc biệt)',
       'Đồng ý chia sẻ NTT', 'Quà đã nhận'],
      ...students.rows.map((r) => [r.full_name, r.school, r.mssv, r.phone, r.email,
        r.badge_count, r.core_badge_count, r.consent_ntt, r.gifts]),
    ] },
    { name: 'Phễu quà', rows: [
      ['Bậc', 'Quà', 'Ngưỡng badge', 'SV đủ điều kiện', 'Đã đổi', 'Kho đã phát', 'Kho tổng'],
      ...funnel.rows.map((r) => [r.tier, r.gift_name, r.required_badges, r.qualified,
        r.redeemed, r.stock_issued, r.stock_total]),
    ] },
    { name: 'Suất đặc biệt', rows: [
      ['Hoạt động', 'Suất số', 'Sinh viên', 'Nhận lúc'],
      ...special.rows.map((r) => [r.activity, r.slot_no, r.full_name, r.claimed_at]),
    ] },
    { name: 'Nhật ký chỉnh tay', rows: [
      ['Lúc', 'Người', 'Hành động', 'Đối tượng', 'Lý do'],
      ...audit.rows.map((r) => [r.at, r.actor_id, r.action, r.target, r.reason]),
    ] },
  ]);

  const stamp = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  return new Response(new Uint8Array(wb), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="ATL2026-${ev.slug}-${stamp}.xlsx"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
