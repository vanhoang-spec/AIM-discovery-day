/**
 * Ba câu hỏi về quyền và vị trí của một máy PG, gom về một chỗ.
 *
 * Trước 10/09 cả ba nằm rải trong JSX: mọi máy đều mở được quầy vé hội trường
 * (AIM phát hiện khi test thật — một cú bấm nhầm ở booth là mất một ghế), và
 * việc đổi điểm quét là một nút ngay trên màn quét, cũng hay bị bấm nhầm.
 * Nay quyền do BTC đặt trên trang quản trị, còn máy chỉ đọc và tuân theo.
 */

/** Chỉ máy được BTC chỉ định mới mở được màn Giữ chỗ. Thiếu thông tin = KHÔNG. */
export function canOpenHallDesk(session) {
  return session?.device?.role === 'hall_ticket';
}

/**
 * Chỉ máy đang đứng ở Quầy đổi quà mới trao quà được (AIM 10/09: "trao tập
 * trung một vị trí thôi").
 *
 * Ở đây KHÔNG cần thêm vai trò máy như quầy vé, vì quầy quà là một điểm quét
 * thật trên sơ đồ — máy nào được phân công đứng đó thì đúng là máy trao quà.
 * Một nguồn sự thật, và BTC điều chuyển bằng đúng cái ô đã dùng cho mọi máy
 * khác. Máy bị gán nhầm điểm không kẹt: BTC đổi ô đó, ~20 giây sau máy nhận.
 */
export function canOpenGiftDesk(checkpoint) {
  return checkpoint?.kind === 'gift_counter';
}

/**
 * Điểm quét BTC phân công cho máy, lấy từ kết quả đếm của server.
 * ĐÚNG một dòng mới là lệnh phân công — nhiều dòng là cấu hình phạm vi kiểu
 * cũ (0005) và không được tự chọn hộ PG.
 */
export function assignedFrom({ assigned_id: id, assigned_count: count } = {}, checkpoints = []) {
  if (Number(count) !== 1 || id == null) return null;
  return checkpoints.find((c) => c.id === id) ?? null;
}

/**
 * Có hiện hộp thoại "BTC ĐIỀU CHUYỂN VỊ TRÍ" không?
 *
 * `state.ok === false` nghĩa là không hỏi được server (mất sóng). Im lặng là
 * bắt buộc: đẩy PG rời vị trí vì một lần fetch hỏng sẽ làm hỏng số liệu của
 * cả điểm cũ lẫn điểm mới.
 */
export function needsMove(state, current) {
  if (!state?.ok || !state.assigned) return false;
  return state.assigned.id !== current?.id;
}
