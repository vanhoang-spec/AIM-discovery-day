# @atl/email

Quy ước: sửa package này thì thêm một dòng vào đây trong CÙNG commit.
Mốc ổn định của cả engine là git tag `engine-vX.Y.Z` — xem docs/FORK-PLAYBOOK.md.

## 1.0.2 — 2026-09-05
- `unsubscribeHeaders()` + truyền `headers` xuống Resend. Máy chủ nhận đọc
  việc THIẾU `List-Unsubscribe` như dấu hiệu gửi hàng loạt không cho ai thoát ra —
  một trong số ít tín hiệu tốt mà tên miền vừa sinh có thể tạo ra ngay ngày đầu.
  CỐ Ý không khai `List-Unsubscribe-Post: One-Click`: nó hứa một endpoint
  HTTPS nhận POST mà mình không có, và Gmail có gọi thử thật. Hứa mà không
  làm được thì tệ hơn là không hứa. 4 test mới khoá đúng điều đó.
  *Bối cảnh:* 05/09 thư test vào spam ở hosting Mắt Bão, bị SpamAssassin
  ghi ***SPAM*** vào tiêu đề. SPF/DKIM/DMARC đã kiểm là ĐÚNG — nên đây là
  điểm nội dung, và thiếu header này là một trong các luật nghi can.

## 1.0.1 — 2026-09-04
- `reply_to` trong payload Resend (mảng, snake_case). Thiếu nó thì mọi thư
  sinh viên bấm "Trả lời" đều rơi vào hư không: dòng From là no-reply trên
  tên miền con vốn KHÔNG có bản ghi MX. 2 test mới, gồm bài chốt "không có
  replyTo thì khoá phải vắng mặt, không phải null".

## 1.0.0 — 2026-08-26 (engine-v1.0.0)
- Template email tiếng Việt (QR đính kèm cid), outbox claim SKIP LOCKED, backoff riêng. 13 test.
