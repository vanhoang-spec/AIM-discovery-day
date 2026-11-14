/**
 * Link riêng trong email: /toi#t=<mã QR>. [14/11, AIM yêu cầu]
 *
 * Đợt 12/09, SV mở /toi trên máy chưa có thẻ (đổi trình duyệt, xoá dữ liệu,
 * mở từ app mail) thì phải điền lại form đăng ký mới thấy điểm. Thư giờ mang
 * một link chứa chính mã QR của người đó; /toi đổi mã lấy thẻ tham dự qua
 * /api/toi/pass rồi lưu vào máy như lúc vừa đăng ký.
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
