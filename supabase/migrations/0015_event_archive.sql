-- ---------------------------------------------------------------------------
-- 0015 — Khoá (lưu trữ) một sự kiện
--
-- AIM 11/09, đêm trước sự kiện: "khoá/ẩn phần DIỄN TẬP để ngày mai không bị
-- rối". Sự kiện diễn tập là bản sao đầy đủ của Hà Nội (0009 clone_event) và nó
-- vẫn lộ ra ở những chỗ nhân sự ngày 12/09 sẽ chạm vào:
--
--   * form đăng ký TẠI CỔNG — có chủ đích hiện cả sự kiện đã đóng đăng ký
--     online (xem apps/web/src/lib/event-choices.js), nên DIỄN TẬP nằm ngay đó.
--     Chọn nhầm là một SV thật cầm mã QR của diễn tập, quét ở đâu cũng đỏ;
--   * ô chọn sự kiện trên trang quản trị;
--   * /api/register — danh sách sự kiện hợp lệ viết cứng [1, 2, 3].
--
-- `is_registration_open` không gánh được việc này: nó chỉ đóng cổng ONLINE, và
-- trang lịch dùng nó để lọc — nên khi AIM đóng đăng ký online thì Hà Nội và
-- TP.HCM cũng biến khỏi trang lịch. "Đã khoá" là một ý nghĩa riêng.
--
-- Chỉ thêm cột, không đụng dữ liệu. ADD COLUMN có DEFAULT hằng là thao tác chỉ
-- ghi metadata — chạy được giữa lúc hệ thống đang phục vụ. Việc KHOÁ sự kiện cụ
-- thể (và thu hồi máy PG của nó) là thao tác vận hành, nằm ngoài migration.
--
-- App đọc cờ qua to_jsonb(e) ->> 'is_archived' nên chạy được cả trước khi file
-- này được áp (thiếu cột = chưa khoá).
-- ---------------------------------------------------------------------------

alter table events
  add column if not exists is_archived boolean not null default false;

comment on column events.is_archived is
  'Đã khoá: ẩn khỏi form đăng ký (kể cả tại cổng), ô chọn sự kiện admin, trang lịch; '
  '/api/register từ chối. Máy PG của sự kiện khoá phải thu hồi riêng.';
