/**
 * Link riêng trong email: /toi#t=<mã truy cập>. [14/11, AIM yêu cầu]
 *
 * Đợt 12/09, SV mở /toi trên máy chưa có thẻ (đổi trình duyệt, xoá dữ liệu,
 * mở từ app mail) thì phải điền lại form đăng ký mới thấy điểm. Thư giờ mang
 * một link riêng của người đó; /toi đổi mã lấy thẻ tham dự qua /api/toi/pass
 * rồi lưu vào máy như lúc vừa đăng ký.
 *
 * [26/11] Mã trong link là MÃ TRUY CẬP (lib/access-token.js), không còn là mã
 * QR — khoá ký mã QR công khai ở app PG. Thư gửi trước 26/11 mang mã QR: server
 * trả 401 reason 'qr_token' và /toi báo "link cũ, lấy lại mã".
 *
 * Mã đặt sau dấu # chứ không ở ?t= : phần sau # không được trình duyệt gửi lên
 * máy chủ, nên không nằm trong nhật ký Vercel hay header Referer. Vẫn nhận ?t=
 * cho link ai đó tự gõ / dán lại.
 */

/** Lấy mã từ `location.hash` / `location.search`; null nếu không có. */
export function tokenFromLocation(hash, search) {
  for (const raw of [hash, search]) {
    if (!raw) continue;
    const params = new URLSearchParams(String(raw).replace(/^[#?]/, ''));
    const t = (params.get('t') ?? '').trim();
    // Mã QR là chuỗi ngắn base64url; chặn rác/độ dài vô lý trước khi gọi mạng.
    if (t && t.length <= 256 && /^[A-Za-z0-9_\-.~:+/=]+$/.test(t)) return t;
  }
  return null;
}
