/**
 * Lịch sử trải nghiệm của sinh viên — dựng từ các dòng attendance.
 *
 * Tách khỏi route vì hai lỗi thật của DIỄN TẬP 11/09 nằm đúng ở đây:
 *
 *   1. "+1" hiện cho điểm KHÔNG tính badge. attendance ghi một dòng cho MỌI
 *      điểm (record_scan chỉ bỏ qua bước cộng badge_count), còn route cũ lấy
 *      badge_weight — mặc định 1 — mà không hỏi counts_toward_badges. Ngày
 *      12/09 mọi SV qua cổng sẽ thấy "Cổng check-in +1" trong khi con số badge
 *      to phía trên không nhúc nhích: hai con số trên cùng một màn hình cãi
 *      nhau, và cả nghìn người cùng hỏi PG vì sao.
 *   2. Quầy đổi quà hiện như một "hoạt động đã hoàn thành". Ghé quầy quà không
 *      phải trải nghiệm; món quà đã nhận hiện ở thang quà ngay phía trên.
 *
 * Loại "không phải hoạt động" trùng với /lich/agenda.js — trừ cổng: giờ
 * check-in là thứ SV thật sự muốn biết, nên giữ lại nhưng không mang badge.
 */

const NOT_AN_EXPERIENCE = new Set(['gift_counter', 'info_desk']);

export function historyFrom(rows) {
  return (rows ?? [])
    .filter((r) => r && !NOT_AN_EXPERIENCE.has(r.kind))
    .map((r) => ({
      name: r.name,
      kind: r.kind,
      zone: r.zone_name ?? null,
      // Chỉ `true` mới có badge. Thiếu cột thì hiện "—" còn hơn bịa ra +1:
      // con số trong lịch sử phải cộng lại đúng bằng con số to phía trên.
      badges: r.counts_toward_badges === true ? Number(r.badge_weight ?? 1) : 0,
      at: r.awarded_at,
    }));
}
