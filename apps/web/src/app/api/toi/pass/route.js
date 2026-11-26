/**
 * Đổi mã truy cập (từ link riêng trong email, /toi#t=…) lấy "thẻ tham dự" mà
 * /toi lưu trong máy — đúng các trường /dang-ky lưu lúc vừa đăng ký xong.
 * [14/11, AIM yêu cầu: SV bấm link trong thư là xem được điểm, không điền lại form.]
 *
 * [26/11, vá bảo mật] Xác thực bằng MÃ TRUY CẬP (lib/access-token.js, khoá
 * ATL_ACCESS_KEY chỉ có ở server), KHÔNG bằng mã QR: khoá ký QR nằm trong
 * JavaScript công khai của app PG, ai cũng tự ký được mã QR cho người khác.
 * Mã QR gửi tới đây (link thư cũ) bị 401 với reason 'qr_token' để /toi nói
 * đúng chuyện "link cũ", không bảo SV tải lại trang vô ích.
 *
 * Trả về: mã QR + ảnh QR (ký lại phía server — xác định, nên trùng byte với mã
 * trong thư), mã truy cập dạng chuẩn, họ tên, mã dự phòng. Không cache.
 */

import { getDb } from '@atl/db';
import { issueQr } from '@/lib/qr';
import { verifyAccess, issueAccessToken } from '@/lib/access-token';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(request) {
  const token = new URL(request.url).searchParams.get('t') ?? '';
  const claims = await verifyAccess(token);
  if (!claims.valid) {
    return Response.json({ error: 'invalid_token', reason: claims.reason }, { status: 401, headers: NO_STORE });
  }

  const db = await getDb();
  const student = (await db.query(
    `select id, full_name, lookup_code from students where seq = $1 and merged_into_id is null`,
    [claims.studentSeq],
  )).rows[0];
  if (!student) return Response.json({ error: 'unknown_student' }, { status: 404, headers: NO_STORE });

  const reg = (await db.query(
    `select 1 from registrations where event_id = $1 and student_id = $2`,
    [claims.eventInstance, student.id],
  )).rows[0];
  if (!reg) return Response.json({ error: 'not_registered' }, { status: 404, headers: NO_STORE });

  const who = { eventInstance: claims.eventInstance, studentSeq: claims.studentSeq };
  const { token: qrToken, svg } = await issueQr(who);

  return Response.json(
    {
      token: qrToken,
      qr_svg: svg,
      access: await issueAccessToken(who),
      lookup_code: student.lookup_code,
      full_name: student.full_name,
      event_id: claims.eventInstance,
    },
    { headers: NO_STORE },
  );
}
