/**
 * POST /api/register — the single registration endpoint.
 *
 * All correctness lives in the database function `register_student` (dedupe,
 * consent stamping, outbox). This layer only validates shape, normalises, and
 * translates the result into what the success screen needs: the token and the
 * pre-rendered QR SVG the client will cache.
 *
 * A retried submit (flaky network, double tap) returns `already_registered`
 * with the SAME code and QR — the resend flow and the duplicate-protection
 * flow are the same path.
 */

import { getDb } from '@atl/db';
import { issueQr } from '@/lib/qr';
import { searchKey } from '@atl/vn-text';

const CURRENT_YEAR = 2026;

function bad(message, field) {
  return Response.json({ error: message, field }, { status: 400 });
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return bad('Dữ liệu gửi lên không hợp lệ');
  }

  const fullName = String(body.full_name ?? '').trim();
  const email = String(body.email ?? '').trim().toLowerCase();
  const phone = String(body.phone ?? '').replace(/[^0-9+]/g, '');
  const eventId = Number(body.event_id);
  const schoolId = body.school_id ? Number(body.school_id) : null;
  const schoolOther = String(body.school_other ?? '').trim() || null;
  const studentCode = String(body.student_code ?? '').trim();
  const major = String(body.major ?? '').trim() || null;
  const birthYear = body.birth_year ? Number(body.birth_year) : null;
  const provinceCode = String(body.province_code ?? '').trim() || null;
  const employer = String(body.employer ?? '').trim() || null;
  const gender = ['nam', 'nu', 'khac'].includes(body.gender) ? body.gender : null;

  if (fullName.length < 2 || fullName.length > 120) return bad('Vui lòng nhập họ và tên', 'full_name');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return bad('Email chưa đúng định dạng', 'email');
  if (!/^(\+?84|0)\d{8,10}$/.test(phone)) return bad('Số điện thoại chưa đúng', 'phone');
  if (![1, 2, 3].includes(eventId)) return bad('Vui lòng chọn sự kiện', 'event_id');
  if (!schoolId && !schoolOther) return bad('Vui lòng chọn trường đang học', 'school_id');
  if (!studentCode) return bad('Vui lòng nhập mã số sinh viên', 'student_code');
  if (birthYear !== null && (birthYear < CURRENT_YEAR - 40 || birthYear > CURRENT_YEAR - 15)) {
    return bad('Năm sinh chưa hợp lệ', 'birth_year');
  }
  if (body.consent_event !== true) {
    return bad('Bạn cần đồng ý điều khoản xử lý dữ liệu để đăng ký', 'consent_event');
  }

  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;

  const db = await getDb();
  let row;
  try {
    const result = await db.query(
      `select * from register_student(
         $1::smallint, $2, $3, $4, $5::smallint, $6, $7, $8, $9::smallint, $10,
         $11, $12::gender, 'general'::registration_type, 'online'::registration_source,
         $13, $14, $15::inet, $16, $17)`,
      [eventId, fullName, email, phone, schoolId, schoolOther, studentCode,
       major, birthYear, provinceCode, employer, gender,
       true, body.consent_sponsors === true, ip, 'v1-2026-08', searchKey(fullName)],
    );
    row = result.rows[0];
  } catch (err) {
    // The function raises in Vietnamese for rule violations; surface those,
    // hide anything else.
    const known = /đồng ý điều khoản|bắt buộc/.test(err.message ?? '');
    if (known) return bad(err.message);
    console.error('register_student failed:', err);
    return Response.json(
      { error: 'Không đăng ký được lúc này. Bạn thử lại giúp mình nhé.' },
      { status: 500 },
    );
  }

  const { token, svg } = await issueQr({
    eventInstance: eventId,
    studentSeq: row.seq,
  });

  return Response.json({
    status: row.status, // created | already_registered | linked
    student_id: Number(row.student_id),
    seq: row.seq,
    lookup_code: row.lookup_code,
    token,
    qr_svg: svg,
    full_name: fullName,
    event_id: eventId,
  });
}
