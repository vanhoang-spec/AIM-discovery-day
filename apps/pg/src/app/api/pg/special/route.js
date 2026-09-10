/**
 * POST /api/pg/special — the special-activity desk (AC22 UI side).
 *
 * The ONLY point in the whole event that is online-by-necessity, not by
 * choice: the cap is a global number and two offline devices cannot share a
 * counter. Everything here leans on 0003's two-phase hold —
 *
 *   check   → entitlement (core ladder!) + open activities + slots left
 *   hold    → reserve one slot for 90s (SKIP LOCKED, exactly-N guaranteed)
 *   confirm → the hold becomes a claim; retry of a done confirm looks like
 *             success, and a dropped connection mid-flow just lets the hold
 *             lapse — no slot is silently burned (the 2-phase design's point)
 *
 * When the network is down the client shows CHẾ ĐỘ GIẤY (AC24) and this
 * route is simply unreachable — there is no offline branch to get wrong.
 */

import { getDb } from '@atl/db';
import { bearerFrom, sha256Hex } from '@/lib/device';

export async function POST(request) {
  const token = bearerFrom(request);
  if (!token) return Response.json({ error: 'Thiếu token thiết bị' }, { status: 401 });

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Dữ liệu không hợp lệ' }, { status: 400 });
  }

  const db = await getDb();
  const dev = (await db.query(
    `select * from resolve_pg_device($1)`, [await sha256Hex(token)],
  )).rows[0];
  if (!dev) return Response.json({ error: 'Thiết bị không hợp lệ' }, { status: 401 });

  const seq = Number(body.student_seq);
  if (!Number.isInteger(seq) || seq <= 0) {
    return Response.json({ error: 'Thiếu mã sinh viên' }, { status: 400 });
  }
  const student = (await db.query(
    `select s.id, s.full_name, s.lookup_code, r.badge_count
       from students s
       join registrations r on r.student_id = s.id and r.event_id = $2
      where s.seq = $1 and s.merged_into_id is null`,
    [seq, dev.event_id],
  )).rows[0];
  if (!student) {
    return Response.json({ error: 'SV chưa đăng ký sự kiện này' }, { status: 404 });
  }

  if (body.action === 'hold') {
    const r = (await db.query(
      `select * from hold_special_slot($1::smallint, $2::bigint, $3::integer)`,
      [dev.event_id, student.id, Number(body.activity_id)],
    )).rows[0];
    if (r.result !== 'held' && r.result !== 'already_held') {
      const msg = {
        not_eligible: 'Chưa đủ badge để nhận suất đặc biệt',
        sold_out: 'ĐÃ HẾT SUẤT',
        limit_reached: 'SV đã dùng hết lượt hoạt động đặc biệt',
        closed: 'Hoạt động chưa mở nhận',
        not_registered: 'SV chưa đăng ký',
      }[r.result] ?? r.result;
      return Response.json({ error: msg, result: r.result }, { status: 409 });
    }
    return Response.json({ ok: true, result: r.result, slot_no: r.slot_no,
                           held_until: r.held_until, remaining: r.remaining });
  }

  if (body.action === 'confirm') {
    const r = (await db.query(
      `select * from confirm_special_slot($1::smallint, $2::bigint, $3::integer, $4)`,
      [dev.event_id, student.id, Number(body.activity_id), dev.staff_name ?? dev.label],
    )).rows[0];
    if (r.result !== 'ok') {
      return Response.json(
        { error: 'Giữ chỗ đã hết hạn — bấm giữ lại', result: r.result },
        { status: 409 });
    }
    return Response.json({ ok: true, slot_no: r.slot_no });
  }

  if (body.action !== 'check') {
    return Response.json({ error: 'Hành động không hợp lệ' }, { status: 400 });
  }

  const [ev, acts] = await Promise.all([
    db.query(`select special_threshold_y, special_claim_limit from events where id = $1`,
      [dev.event_id]),
    db.query(
      `select sa.id, sa.name, sa.is_open,
              count(*) filter (where s.student_id is null
                                and (s.held_until is null or s.held_until <= now()))::int
                as slots_left,
              bool_or(s.student_id = $2) as already_claimed,
              max(s.slot_no) filter (where s.student_id = $2) as claimed_slot
         from special_activities sa
         join special_slots s on s.special_activity_id = sa.id
        where sa.event_id = $1
        group by sa.id, sa.name, sa.is_open
        order by sa.id`,
      [dev.event_id, student.id],
    ),
  ]);

  const y = ev.rows[0].special_threshold_y;
  return Response.json({
    student: {
      seq,
      full_name: student.full_name,
      lookup_code: student.lookup_code,
      badge_count: student.badge_count,
    },
    y,
    // [10/09] PHẢI là badge_count — thang TỔNG. hold_special_slot xét thang
    // này kể từ migration 0012; so bằng core_badge_count ở đây khiến màn hình
    // quầy suất báo "chưa đủ điều kiện" cho đúng người mà database sẵn sàng
    // cấp suất (SV có 10 badge tổng / 5 hoạt động lõi). PG đọc dòng đó rồi
    // không bấm giữ chỗ — sinh viên bị từ chối oan ngay tại quầy.
    eligible: student.badge_count >= y,
    claim_limit: ev.rows[0].special_claim_limit,
    activities: acts.rows,
  });
}
