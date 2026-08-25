/**
 * AC27 — the per-sponsor export. The privacy posture is the OPPOSITE of the
 * internal export (AC33) and they must never merge:
 *
 *   AC33 (nội bộ)   every student, full PII — AIM is the controller.
 *   AC27 (giao NTT) ONLY students who ticked consent checkbox #2, and only
 *                   those who actually visited this sponsor's checkpoint.
 *                   Everyone else does not appear in any form, not even
 *                   anonymised — absence is the default, presence is opt-in.
 *
 * A sponsor is addressed as a checkpoint (their booth). Survey results join
 * this file when Track 3 ships.
 */

import { getDb } from '@atl/db';
import { buildWorkbook } from '@atl/xlsx-lite';
import { checkAdmin, adminError } from '../../../../lib/admin-auth.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request) {
  const auth = checkAdmin(request);
  if (!auth.ok) return adminError(auth);
  const url = new URL(request.url);
  const eventId = Number(url.searchParams.get('event') ?? 1);
  const checkpointId = Number(url.searchParams.get('checkpoint'));
  if (!checkpointId) return Response.json({ error: 'Thiếu checkpoint' }, { status: 400 });

  const db = await getDb();
  const cp = (await db.query(
    `select c.name, c.kind::text as kind, z.name as zone_name, e.slug
       from checkpoints c
       join events e on e.id = c.event_id
       left join zones z on z.id = c.zone_id and z.event_id = c.event_id
      where c.id = $1 and c.event_id = $2`,
    [checkpointId, eventId],
  )).rows[0];
  if (!cp) return Response.json({ error: 'not_found' }, { status: 404 });

  const [totals, hourly, consented] = await Promise.all([
    db.query(
      `select count(*) filter (where a.voided_at is null)::int as badges,
              count(distinct a.student_id)::int as unique_visitors
         from attendance a
        where a.event_id = $1 and a.checkpoint_id = $2`,
      [eventId, checkpointId]),
    db.query(
      `select to_char(minute_ts + interval '7 hours', 'HH24:00') as hour,
              sum(scan_count)::int as scans, sum(badge_count)::int as badges
         from checkpoint_minute_counts
        where event_id = $1 and checkpoint_id = $2
        group by 1 order by 1`,
      [eventId, checkpointId]),
    // The consent gate, twice over: ticked checkbox #2 AND visited THIS booth.
    db.query(
      `select s.full_name, coalesce(rs.name, s.school_other, '') as school,
              coalesce(s.email, '') as email, coalesce(s.phone, '') as phone,
              to_char(a.awarded_at + interval '7 hours', 'HH24:MI') as visited_at
         from attendance a
         join students s on s.id = a.student_id
         left join ref_schools rs on rs.id = s.school_id
        where a.event_id = $1 and a.checkpoint_id = $2 and a.voided_at is null
          and s.consent_sponsors_at is not null
          and s.merged_into_id is null
        order by s.full_name`,
      [eventId, checkpointId]),
  ]);

  const wb = buildWorkbook([
    { name: 'Tổng quan', rows: [
      ['Chỉ số', 'Giá trị'],
      ['Gian hàng', cp.name],
      ['Khu vực', cp.zone_name ?? ''],
      ['Tổng badge cấp tại gian hàng', totals.rows[0].badges],
      ['Số sinh viên khác nhau đã ghé', totals.rows[0].unique_visitors],
      ['SV đồng ý nhận thông tin (danh sách ở sheet 3)', consented.rows.length],
      ['', ''],
      ['Ghi chú', 'Danh sách liên hệ chỉ gồm sinh viên ĐÃ tick đồng ý chia sẻ với nhà tài trợ và ĐÃ ghé gian hàng này. Sinh viên khác không xuất hiện dưới bất kỳ dạng nào.'],
    ] },
    { name: 'Lượt ghé theo giờ', rows: [
      ['Giờ', 'Lượt quét', 'Badge cấp'],
      ...hourly.rows.map((r) => [r.hour, r.scans, r.badges]),
    ] },
    { name: 'SV đồng ý nhận tin', rows: [
      ['Họ tên', 'Trường', 'Email', 'SĐT', 'Ghé lúc'],
      ...consented.rows.map((r) => [r.full_name, r.school, r.email, r.phone, r.visited_at]),
    ] },
  ]);

  const safe = cp.name.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return new Response(new Uint8Array(wb), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="ATL2026-${cp.slug}-NTT-${safe}.xlsx"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
