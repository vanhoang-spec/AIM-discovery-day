# @atl/email

Quy ước: sửa package này thì thêm một dòng vào đây trong CÙNG commit.
Mốc ổn định của cả engine là git tag `engine-vX.Y.Z` — xem docs/FORK-PLAYBOOK.md.

## 1.0.1 — 2026-09-04
- `reply_to` trong payload Resend (mảng, snake_case). Thiếu nó thì mọi thư
  sinh viên bấm "Trả lời" đều rơi vào hư không: dòng From là no-reply trên
  tên miền con vốn KHÔNG có bản ghi MX. 2 test mới, gồm bài chốt "không có
  replyTo thì khoá phải vắng mặt, không phải null".

## 1.0.0 — 2026-08-26 (engine-v1.0.0)
- Template email tiếng Việt (QR đính kèm cid), outbox claim SKIP LOCKED, backoff riêng. 13 test.
