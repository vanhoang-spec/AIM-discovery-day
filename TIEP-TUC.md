# Tiếp tục phiên làm việc

File này để mở lại công việc từ máy khác (điện thoại, máy khác, phiên cloud).
Đọc xong file này là đủ ngữ cảnh để làm tiếp mà không cần lịch sử hội thoại cũ.

**Cách dùng trên điện thoại:** mở `claude.ai/code`, chọn repo
`vanhoang-spec/AIM-discovery-day`, rồi gõ: *"Đọc TIEP-TUC.md và làm tiếp"*.

---

## Đang ở đâu (cập nhật 20/11/2026)

Commit code gần nhất: `85a50d4` (14/11) · **506 test xanh** (đo trong lần deploy 14/11).

### Đã chạy thật

| Sự kiện | Ngày | Ghi chú |
|---|---|---|
| Awaken The Lions — Hà Nội + TP.HCM | 12/09/2026 | 1.211 SV nhập qua 3 đợt, 0 lỗi. Hai sự kiện đã **khoá** (`is_archived`) |
| Event 3 — sân diễn tập | 09–11/09 | Đã khoá, ẩn khỏi mọi danh sách chọn |
| Discovery Day - UEF (event 4) | 17/11/2026, 8h00–17h30 | 498 đăng ký (493 ngay trong ngày 17/11) · 474 SV có badge (1.078 lượt quét) · 618 lượt nhận quà (bậc 7: 366, bậc 8: 252). Đăng ký đã đóng, **chưa khoá** |

### Làm cho UEF (14/11, đã lên production — web)

- `0016`: `events.email_copy` (thư riêng theo sự kiện, mẫu AIM) + `queue_event_reminders()`
  xếp thư nhắc hàng loạt vào outbox, idempotent. File vá: `supabase/production-patch-0016.sql`.
- Form đăng ký / trang chủ / trang lịch lấy ngày giờ từ `events.starts_at/ends_at`
  (`apps/web/src/lib/event-when.js`), không còn chữ cứng "Thứ Bảy 12/09".
- Thư có link riêng `/toi#t=<mã QR>` → `/api/toi/pass` đổi lấy thẻ tham dự, SV khỏi điền lại form.
- Tên miền: **`app.awakenthelions.net`**. `atl.aimacademy.vn` đã mất DNS — đừng dùng trong thư.

App PG lần deploy cuối là **11/09** (đợt UEF không sửa app PG).

---

## Còn lửng — làm trước khi nhận việc mới

1. **Số liệu UEF đã đọc 20/11** (SQL Editor, xem bảng trên). `0016` **đã áp** trên production
   (có `queue_event_reminders`, `events.email_copy` của event 4 là object). Thư xác nhận UEF:
   494 gửi được, **4 lỗi** do email SV nhập sai (3 sai định dạng, 1 có dấu) — sự kiện đã qua, chỉ
   sửa nếu AIM muốn 4 SV đó xem điểm qua link. `registrations.checked_in_at` = 0 ở **mọi** sự kiện,
   kể cả 12/09 → không phải lỗi riêng UEF; đếm người có mặt theo badge. Event 4 chưa khoá (HN/HCM đã khoá).
2. **Chưa có bản sao lưu nào sau sự kiện.** `scripts/backup-db.mjs` (chỉ đọc, ghi ra
   `../ATL2026-backups/<ngày_giờ>/`, NGOÀI repo vì có họ tên/email/SĐT) chưa chạy lần nào. Vướng:
   **không ai nhớ mật khẩu database**, và `DATABASE_URL` trên Vercel là biến *Sensitive* (không xem /
   copy lại được). Muốn sao lưu phải đặt lại mật khẩu Supabase → sửa `DATABASE_URL` ở **cả hai**
   project Vercel (web + pg) → deploy lại cả hai — làm trong khung 22:00–07:00. Có URL rồi thì chạy
   `node scripts/backup-db.mjs` (tự dừng nếu URL không phải project `qllxeocjtbgtsrzpolqr`).
3. **CI của `85a50d4` đỏ** vì bước build tải font Google (`next/font`: "Cannot read properties of
   null") — lỗi mạng tạm thời, không phải code; deploy cùng commit vẫn chạy test xanh và thành công.
   Bấm *Re-run* là xanh.
4. **Spec chưa ghi UEF / `0016`.** `docs/ATL2026-Production-Spec.md` dừng ở 12/09.
5. Kế hoạch `/api/bulletin` (ghi ngày 25/08) **chưa làm** — không có route nào; chỉ làm nếu AIM cần lại.

---

## Truy cập production (kiểm 20/11)

- Supabase project production: `qllxeocjtbgtsrzpolqr`.
- `.env.local` ở gốc repo trỏ project **khác, đã không còn** ("tenant/user not found") — đừng tin nó.
- Supabase MCP bị từ chối quyền vào project prod (có thể project thuộc tài khoản kia).
- **Cách đọc số liệu đang dùng được:** Supabase SQL Editor trên Chrome của chủ (đã đăng nhập),
  chỉ chạy `SELECT` đếm tổng, không in họ tên / email / SĐT. Làm 20/11 bằng agent Sonnet.
- Đừng bấm *Reset database password* khi chưa sẵn sàng sửa cả hai project Vercel — app mất kết nối ngay.
- Đọc được không cần quyền: `https://app.awakenthelions.net/api/refdata` (sự kiện đang hiện trên
  form, công khai) và `gh run list` (CI + deploy).

---

## Deploy

- **Không tự động.** GitHub → Actions → *Deploy (manual only)* → *Run workflow*, chọn `app`
  (`web` / `pg`) và `target` (`preview` / `production`); production phải gõ đúng chữ `DEPLOY`.
  Workflow chạy `npm test` trước, đỏ là không deploy.
- Migration mới: chạy `scripts/build-production-sql.mjs` để sinh `supabase/production-patch-00NN.sql`
  (bọc một transaction), dán vào SQL Editor của Supabase **trước** khi deploy code đọc cột mới.
- Khung phát hành của chủ: **22:00–07:00** (UTC+7). Ngoài khung chỉ commit, không push / deploy.

---

## Bẫy đã gặp — đừng gặp lại

- **Dev: mỗi app có PGlite riêng trong bộ nhớ.** SV đăng ký bên app web *không* xuất hiện bên
  app PG. Seed có sẵn 5 SV `seq` 1001–1005 để quét thử. Muốn chạy xuyên app thật thì trỏ cả hai
  vào cùng một `DATABASE_URL`.
- **`transpilePackages` biên dịch `packages/db` vào bản build.** Sửa seed xong phải rebuild.
- **Production thiếu `DATABASE_URL` thì dừng hẳn**, không rơi về PGlite (cố ý).
- **Hằng số SQL dùng mà không import** từng làm đăng ký trả 500 (11/09) — có test chặn tái phạm.
- **Heredoc bash + tiếng Việt có dấu backtick sẽ hỏng.** Dùng Write tool hoặc script `.mjs` riêng.
- **Ambiguous column trong plpgsql.** `#variable_conflict use_column` ở đầu mọi function.
- **Không tạo unique index trên bảng production có thể đã có dữ liệu trùng** (vd `notification_outbox`
  có dòng nhắc chèn tay) — dùng advisory lock + `NOT EXISTS` như `0016`.
- **Giữ test xanh.** Test viết theo kiểu khẳng định *điều không thể xảy ra*, không phải happy path.

Đọc thêm: [`CONTRIBUTING.md`](CONTRIBUTING.md), [`README.md`](README.md),
[`docs/ATL2026-Production-Spec.md`](docs/ATL2026-Production-Spec.md) (đọc theo đoạn — file ~94 KB).
