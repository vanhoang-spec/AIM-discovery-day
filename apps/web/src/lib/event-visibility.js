/**
 * Sự kiện đã KHOÁ (0015) — một điều kiện SQL, dùng ở mọi chỗ liệt kê sự kiện.
 *
 * AIM 11/09: "khoá/ẩn phần DIỄN TẬP để ngày mai không bị rối". Sự kiện diễn tập
 * từng lộ ra ở form đăng ký tại cổng, ô chọn sự kiện của admin, trang lịch, và
 * danh sách hợp lệ viết cứng trong /api/register. Gom điều kiện về một chỗ để
 * không chỗ nào lọc theo một ý khác.
 *
 * Đọc cờ qua `to_jsonb(e)` thay vì `e.is_archived`: bản deploy này phải chạy
 * được cả TRƯỚC khi 0015 được áp (cột chưa có → coi như chưa khoá) lẫn sau.
 * Tham chiếu thẳng một cột chưa tồn tại làm /api/refdata trả 500 — mà đó chính
 * là cổng kiểm tra sức khoẻ của mỗi lần deploy. Bảng events có vài dòng, nên
 * dựng jsonb cho từng dòng không tốn gì đáng kể.
 *
 * Luôn dùng với bí danh `e` cho bảng events.
 */
export const EVENT_NOT_ARCHIVED =
  `coalesce((to_jsonb(e) ->> 'is_archived')::boolean, false) = false`;

/** Cờ khoá dưới dạng một cột đọc được, cho những chỗ cần hiện chứ không lọc. */
export const EVENT_IS_ARCHIVED_COL =
  `coalesce((to_jsonb(e) ->> 'is_archived')::boolean, false) as is_archived`;
