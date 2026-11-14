/**
 * "Thứ Ba 17/11/2026 · 8h–17h30" — ngày giờ của MỘT sự kiện, dựng từ
 * events.starts_at / ends_at theo giờ Việt Nam.
 *
 * [14/11] Trước đây trang đăng ký, trang chủ và trang lịch viết cứng
 * "Thứ Bảy 12/09 · 8h–17h". Discovery Day UEF (17/11) mở đăng ký trên cùng
 * hệ thống, nên chữ đó thành sai ngày ngay trên đầu form. Mọi chỗ hiện ngày
 * giờ sự kiện cho SV đọc từ đây.
 *
 * Máy chủ chạy UTC, sự kiện thì không: cộng cố định +7 rồi đọc bằng getUTC*,
 * cùng cách packages/email đang làm — không phụ thuộc múi giờ của máy chạy.
 */

const DAYS = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
const VN_OFFSET_MS = 7 * 3600 * 1000;

function toVn(value) {
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? new Date(t + VN_OFFSET_MS) : null;
}

/** 8:00 → "8h", 17:30 → "17h30". */
function hourLabel(d) {
  const m = d.getUTCMinutes();
  return m ? `${d.getUTCHours()}h${String(m).padStart(2, '0')}` : `${d.getUTCHours()}h`;
}

/** "" khi không có starts_at hợp lệ — người gọi tự bỏ cả dòng. */
export function eventWhen(ev) {
  const s = ev?.starts_at ? toVn(ev.starts_at) : null;
  if (!s) return '';
  const date = `${DAYS[s.getUTCDay()]} ${String(s.getUTCDate()).padStart(2, '0')}/`
    + `${String(s.getUTCMonth() + 1).padStart(2, '0')}/${s.getUTCFullYear()}`;
  const e = ev.ends_at ? toVn(ev.ends_at) : null;
  return e ? `${date} · ${hourLabel(s)}–${hourLabel(e)}` : `${date} · ${hourLabel(s)}`;
}
