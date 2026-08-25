# Hướng dẫn cho người review code

Dự án cho sự kiện **Awaken The Lions 2026 — Discovery Day** (12/09/2026, FTU Hà Nội &
TP.HCM, ~2.000 sinh viên mỗi điểm). Tài liệu phương án nằm trong các file PDF ở thư
mục gốc; tài liệu gốc của AIM không đưa lên repo.

## Chạy thử trong 2 phút

```bash
npm install
npm test
```

Bộ test chạy **Postgres thật biên dịch sang WASM** (PGlite) — không cần cài Postgres,
không cần Docker, không cần tài khoản. Mỗi file test áp toàn bộ migration từ đầu, nên
migration hỏng sẽ fail ngay.

Chạy app đăng ký:

```bash
cd apps/web && npm run dev
```

Chạy app quét PG (cổng 3001, mã thiết bị mẫu `K7M3QX`):

```bash
cd apps/pg && npm run dev
```

Không có `DATABASE_URL` thì app tự dùng PGlite trong bộ nhớ và seed sẵn 2 sự kiện,
24 trường, 34 tỉnh thành. Mở http://localhost:3000/dang-ky.

## Nên soi kỹ chỗ nào

Dự án này có một mối lo duy nhất chi phối mọi quyết định: **sai dữ liệu khi hàng nghìn
người dùng đồng thời, trong điều kiện sóng chập chờn ngoài sân trường**. Nếu chỉ có
thời gian đọc vài file, đọc theo thứ tự này:

| File | Vì sao |
|---|---|
| `supabase/migrations/0002_ledger.sql` | Sổ cái quét: idempotency **hai lớp**. `scan_uid` do máy PG sinh làm khoá chính (chống replay từ hàng đợi offline), cộng partial unique index trên `(event, student, checkpoint)` (chống hai PG quét cùng lúc). Chỗ này sai là sai cả sự kiện. |
| `supabase/migrations/0003_rewards.sql` | Cấp suất giới hạn bằng `FOR UPDATE SKIP LOCKED` trên slot tạo sẵn. Cách ngây thơ (đọc count → so cap → insert) sẽ cấp 201 suất khi cap là 200. |
| `supabase/migrations/0004_registration.sql` | `register_student` — chống trùng nằm **trong** transaction, không phải đọc-rồi-ghi ở tầng API. Gửi lại form = luồng gửi lại mã, không tạo bản trùng. |
| `packages/qr-token/src/index.js` | Token QR ký HMAC, xác thực **offline** ở cả hai đầu. Dùng chung nguyên vẹn giữa server, app PG và app sinh viên — fork file này là scanner sẽ từ chối sinh viên thật tại booth. |
| `packages/db/src/index.js` | `max: 1`, `prepare: false`, cổng 6543. Ba dòng này là khác biệt giữa sống sót burst 8h sáng và cạn connection. Dùng chung cho cả hai app — **đừng fork**. |
| `packages/scan-queue/src/index.js` | Hàng đợi offline. **File quan trọng nhất dự án.** Idempotency hai lớp, backoff có jitter (40 máy mất sóng cùng lúc không được retry đồng loạt), và một lượt quét không có phản hồi từ server thì **giữ lại chờ gửi**, không bao giờ mặc định là đã tới. |

## Nguyên tắc đã chốt — đừng "sửa" nhầm

Vài chỗ trông như thiếu sót nhưng là quyết định có chủ đích:

- **Không có websocket.** Sinh viên poll. 1.500 kết nối đồng thời là bài toán ta cố ý
  không tạo ra. Xem phần concurrency trong `ATL2026-Phuong-an-de-xuat.pdf`.
- **Quét trùng không phải lỗi.** App PG hiện màn hổ phách "đã có badge này". Coi nó là
  lỗi sẽ dạy PG bỏ qua màu đỏ, và lỗi thật sẽ lọt lưới.
- **Không nhét URL hay JWT vào QR sinh viên.** Symbol phồng lên, module co lại, decode
  hỏng ngoài nắng. `assertScannable()` sẽ throw nếu ai đó thử.
- **Sổ cái chỉ ghi thêm.** Gỡ badge là xoá mềm kèm lý do. Trigger chặn `UPDATE`/`DELETE`.
- **Hai checkbox đồng ý tách riêng, không tick sẵn.** Yêu cầu pháp lý, không phải UX.
- **Thẻ QR nền trắng ở cả dark mode.** Tương phản cho camera rẻ tiền quan trọng hơn
  nhất quán theme.

## Quy trình

Nhánh từ `main`, mở PR. CI chạy toàn bộ test và build app trên mỗi push.

**Deploy không tự động.** Không có workflow nào deploy khi push. Việc deploy chỉ xảy ra
khi có người vào tab Actions bấm *Run workflow* trong `Deploy (manual only)`, và bản
production còn phải gõ tay chữ `DEPLOY` để xác nhận. Chi tiết trong
`.github/workflows/deploy.yml`.

## Viết test cho phần mình sửa

Mọi ràng buộc về tính đúng đắn đều có test đi kèm, và test được viết theo kiểu **khẳng
định điều không thể xảy ra**, không phải khẳng định happy path. Ví dụ mẫu:

- `supabase/test/rewards.test.js` — "đúng N người nhận suất khi cap là N"
- `supabase/test/schema.test.js` — "quét lại 20 lần vẫn đúng một badge"
- `packages/qr-token/test/token.test.js` — thử **mọi** đột biến một ký tự của token

Bộ test hiện có **185 bài**, tất cả xanh. Xin giữ nguyên con số đó khi gửi PR.
