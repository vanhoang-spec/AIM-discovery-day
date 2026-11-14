/**
 * Đổi mã QR (từ link riêng trong email, /toi#t=…) lấy "thẻ tham dự" mà /toi
 * lưu trong máy — đúng các trường /dang-ky lưu lúc vừa đăng ký xong.
 * [14/11, AIM yêu cầu: SV bấm link trong thư là xem được điểm, không điền lại form.]
 *
 * Xác thực Y HỆT /api/toi: chính mã QR có chữ ký HMAC. Ai cầm mã QR của một
 * người vốn đã xem được điểm của người đó qua /api/toi — route này chỉ trả thêm
 * họ tên, mã dự phòng và ảnh QR để màn hình /toi dựng lại được khi máy trống.
 * Không cache: dữ liệu theo từng người.
 */

import { getDb } from '@atl/db';
import { verifyToken, importKey } from '@atl/qr-token';
import { renderSVG } from '@atl/qr-render';

export const dynamic = 'force-dynamic';

const DEV_KEY = 'atl2026-dev-key-do-not-use-in-production';
const NO_STORE = { 'Cache-Control': 'no-store' };

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
  const claims = await verifyToken(token, await getKey());
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

  return Response.json(
    {
      token,
      qr_svg: await renderSVG(token),
      lookup_code: student.lookup_code,
      full_name: student.full_name,
      event_id: claims.eventInstance,
    },
    { headers: NO_STORE },
  );
}
