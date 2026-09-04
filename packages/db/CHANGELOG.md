# @atl/db

Quy ước: sửa package này thì thêm một dòng vào đây trong CÙNG commit.
Mốc ổn định của cả engine là git tag `engine-vX.Y.Z` — xem docs/FORK-PLAYBOOK.md.

## 1.0.2 — 2026-09-04
- `idle_timeout: 20` cho kết nối Supabase. Supavisor chặn cứng 200 CLIENT
  (Micro, dashboard ghi "cannot be changed") và trả EMAXCONN chứ không xếp
  hàng — T1/T2/T6 đã dính đúng lỗi này khi mở 500 kết nối. Trần đó đếm theo
  **instance đang ấm**, không phải request đồng thời: instance rảnh vẫn giữ
  chỗ vì client nằm trong globalThis. Có timeout thì nó trả chỗ về giữa các
  đợt, trong đợt vẫn giữ nguyên lợi thế không phải bắt tay TLS lại.

## 1.0.1 — 2026-09-04
- `assertDatabaseConfigured`: production thiếu `DATABASE_URL` thì **dừng hẳn**,
  không âm thầm rơi về PGlite (database rỗng + mã máy quét demo của seed-dev).
  Chốt đặt TRƯỚC khi ghi vào `globalThis.__atlDb` nên lỗi lặp lại mọi request,
  không cache một handle hỏng. 7 test mới ở `test/guard.test.js`.
  *Vì sao có:* 04/09 production trả 500 nhiều giờ — bản deploy cũ hơn biến
  `DATABASE_URL` 2 tiếng, Vercel đóng băng biến lúc build nên bản đang chạy
  chưa từng thấy nó. Trước đây chỉ chết nhờ may (file .sql không nằm trong
  bundle), giờ là từ chối có chủ đích, và thông báo chỉ thẳng "deploy lại".

## 1.0.0 — 2026-08-26 (engine-v1.0.0)
- Kết nối dùng chung: Supavisor 6543, max 1, prepare false; PGlite fallback dev + seed.
