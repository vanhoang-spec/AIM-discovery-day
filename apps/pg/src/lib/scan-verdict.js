/**
 * Một chỗ duy nhất dịch `server_status` thành lời cho PG đọc.
 *
 * Sinh từ diễn tập 09/09, hai phát hiện cùng gốc: hàng-chờ nuốt lý do từ
 * chối, và màn quét không bao giờ cập nhật lại sau khi server trả lời — nên
 * "tên sẽ hiện sau khi đồng bộ" là một lời hứa suông, và một SV đã nhận badge
 * ở MÁY KHÁC vẫn được màn xanh trên máy này. Cả /quet lẫn /hang-cho cùng đọc
 * từ đây để hai màn không bao giờ kể hai câu chuyện khác nhau về một lượt quét.
 */

export const REJECT_REASON = {
  rejected_not_registered: 'SV chưa đăng ký sự kiện của máy này — có thể nhầm điểm. Thử lại sẽ KHÔNG giúp; kiểm tra email đăng ký của bạn ấy.',
  rejected_unknown_student: 'Không tìm thấy SV này trên hệ thống — mã in có thể hỏng, dùng tra cứu tay.',
  rejected_checkpoint_closed: 'Điểm quét đã bị tắt trên trang quản trị.',
  rejected_device: 'Máy này đã bị thu hồi — báo giám sát đổi máy.',
  rejected_out_of_scope: 'Máy không được phân quyền quét điểm này.',
};

/**
 * Dịch một dòng hàng đợi ĐÃ có trả lời của server thành thẻ kết quả cho màn
 * quét. Trả về null khi chưa có gì đáng thay ("chưa gửi" hay "server lỗi tạm")
 * — người gọi giữ nguyên thẻ đang hiện.
 *
 * Chú ý màu: repeat/replay là HỔ PHÁCH chứ không đỏ — "đã nhận rồi" là kết
 * quả bình thường cả ngày; đỏ để dành cho việc cần người can thiệp.
 */
export function resultFromServer(item) {
  if (!item || !item.server_status) return null;
  const name = item.student_name ?? `Mã ${item.student_seq}`;
  const badge = item.badge_count != null ? `tổng badge: ${item.badge_count}` : '';

  switch (item.server_status) {
    case 'counted':
      return { kind: 'ok', verdict: 'ĐÃ GHI NHẬN ✓', name, meta: badge, confirmed: true };
    case 'repeat_not_counted':
    case 'replay':
      return {
        kind: 'amber',
        verdict: 'ĐÃ NHẬN Ở ĐIỂM NÀY TRƯỚC ĐÓ',
        name,
        meta: badge ? `không cộng thêm — ${badge}` : 'không cộng thêm badge',
        confirmed: true,
      };
    case 'pending_other_condition':
      return { kind: 'info', verdict: 'ĐÃ GHI NHẬN ✓', name, meta: 'chờ điều kiện thưởng khác', confirmed: true };
    default:
      if (item.server_status.startsWith('rejected')) {
        return {
          kind: 'bad',
          verdict: 'SERVER TỪ CHỐI LƯỢT NÀY',
          name,
          meta: REJECT_REASON[item.server_status] ?? item.server_status,
          confirmed: true,
        };
      }
      return null;
  }
}
