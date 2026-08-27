# Fork Playbook — engine sự kiện, mỗi khách hàng một fork

**Chiến lược đã chốt (26/08/2026):** không làm SaaS đa tenant. Mỗi khách hàng
= một fork của repo này, một database riêng, một bộ subdomain riêng. Chạy xong
chiến dịch thì đóng băng fork; mùa mới thì mở lại, `clone_event`, config lại.
Với đội IT mỏng, chi phí thật nằm ở **số phút để dựng fork mới** — tài liệu này
tồn tại để số phút đó nhỏ.

## Vì sao fork, không phải tenant — trade-off ghi thẳng

Retrofit multi-tenancy là dự án nhiều tuần: cột tenant xâu qua events →
attendance → redemptions → mọi unique index, RLS theo tenant, auth theo
tenant, và mọi bài test viết lại. Đổi lại được gì? Một deployment chung —
thứ chỉ có giá trị khi vận hành *đồng thời nhiều khách trên một hạ tầng*.
Mô hình kinh doanh ở đây là chiến dịch theo mùa, tuần tự, đội mỏng: fork rẻ
hơn ở mọi điểm trừ một — **bản vá bảo mật phải chạy trên N codebase khi có N
client**. Chấp nhận có ý thức; giảm nhẹ bằng cách giữ engine (packages/) sạch
để cherry-pick một bản vá sang các fork là thao tác git tầm thường.

Nếu ngày nào đó có 4+ client chạy *đồng thời*, mở lại quyết định này — các
điểm phải đụng khi ấy được đánh dấu sẵn trong Bản đồ Layer C bên dưới.

## Bản đồ ba lớp — cái gì là config, cái gì là luật

### Layer A — config trong DB, admin sửa qua UI (fork KHÔNG đụng code)
Ngưỡng bậc quà + kho (có dry-run bán kính ảnh hưởng) · y/z/chế độ thang quà ·
checkpoint CRUD đủ cờ (`counts_toward_badges`, `badge_award_mode`, giờ, zone)
· zone · bậc quà mới · hoạt động đặc biệt (capacity = số slot) · đội PG + mã
máy quét (tạo/gán/thu hồi) · mở/đóng đăng ký · Early Bird · survey builder
(≤8 câu, màu nhấn) · Giờ Vàng (phút/cap/ngân sách) · nhân bản sự kiện.

### Layer B — dữ liệu seed một lần mỗi fork (script, không phải UI)
Danh sách trường (`ref_schools`) và tỉnh thành (`ref_provinces`) · sự kiện
đầu tiên của campaign (id 1..255 — byte trong QR token) · nội dung email
(copy trong `packages/email`, sửa như code).

### Layer C — LUẬT trong code/schema. Đổi = đổi hình dạng luật, làm trong fork
| # | Luật | Nằm ở | Ghi chú khi client cần khác |
|---|---|---|---|
| 1 | Đủ N badge → mở bậc quà | `claim_gift_tier` (0003) | Tích điểm trọng số / tiêu điểm / xổ số = viết hàm mới. "Đếm mốc → đổi thưởng theo bậc" là phổ quát cho activation; biến thể là việc của fork |
| 2 | Thang đặc biệt chỉ đếm cổng + booth | `counts_toward_special` (0007) hardcode kind | Đặc thù luật ">70%" của AIM. Generalize = thêm cột `counts_toward_special` trên checkpoints thay hardcode — migration nhỏ, làm khi fork đầu tiên cần |
| 3 | Giờ Vàng chỉ thưởng booth | `record_pg_scan` (0008) hardcode kind | Như trên |
| 4 | 1 người = 1 QR toàn campaign | unique email/phone toàn bảng `students` | Client muốn danh tính per-event → đổi unique index + `register_student` |
| 5 | Survey ≤8 câu, 4 loại, 1 booth 1 survey | CHECK constraint (0010) | Trần 8 là quyết định vận hành có lý do — nghĩ kỹ trước khi nâng |
| 6 | Hai checkbox đồng ý tách riêng, không tick sẵn | form + `register_student` | Pháp lý VN — KHÔNG đổi |

**Generic tốt — dùng nguyên, đừng fork:** `qr-token` (ký HMAC, verify offline
hai đầu), `scan-queue` (hàng đợi offline — file quan trọng nhất), `vn-text`,
`xlsx-lite`, `qr-render`, `db` (pooler settings), hold-90s, append-only ledger.

## Quy trình dựng fork cho client mới (~nửa ngày, đích: dưới 2 giờ)

1. Fork repo → repo private mới của client. Đổi tên trong `package.json` gốc nếu muốn.
2. **Brand (2 chỗ, đúng 2 chỗ):** khối `BRAND KIT` đầu `apps/web/src/app/globals.css`
   (+ accent trong `apps/pg/src/app/globals.css`) và `packages/brand/src/index.js`.
   Quy tắc cứng: màu nhấn trên nền sáng phải đạt AA — đo trước khi chốt.
3. Font: đổi trong `apps/web/src/app/layout.js` (next/font) — bắt buộc subset `vietnamese`.
4. Seed Layer B: sửa `packages/db/src/seed-dev.js` làm bản dev; viết seed
   production riêng (trường/tỉnh/sự kiện). **Nhớ bài học 5 lần dẫm:** chèn id
   tường minh thì `setval` mọi sequence sau seed.
5. Hạ tầng: Supabase project mới `ap-southeast-1` (thêm vào org Pro sẵn có
   = +$10/tháng compute) · 2 project Vercel · env (`ATL_HMAC_KEY` **mới, không
   dùng lại của client cũ** — token QR hai campaign phải không đổi lẫn được,
   `ADMIN_ACCESS_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`, `NEXT_PUBLIC_SITE_URL`).
6. DNS + email: theo mẫu `ATL2026-Huong-dan-DNS-MatBao.pdf` — 2 CNAME app,
   subdomain `mail.` riêng, SPF/DKIM/DMARC, nuôi uy tín từ sớm.
7. Vào admin `/admin` → tab Vận hành/Cấu hình/Hoạt động: dựng zone, checkpoint,
   bậc quà, suất đặc biệt, đội PG. Không cần SQL.
8. `npm test` phải xanh **trước khi** deploy — bộ test là hợp đồng của engine.
9. Chạy T1–T7 (tranh chấp đa kết nối) trên hạ tầng thật của client.
10. Tổng duyệt thiết bị thật theo checklist 7 bước trong CONTRIBUTING.

## Versioning engine

Monorepo là đơn vị phát hành. Mốc ổn định = git tag `engine-vX.Y.Z`
(hiện tại: `engine-v1.0.0`, 266 test). Mỗi package có `CHANGELOG.md`; sửa
package nào thì ghi một dòng vào CHANGELOG của nó trong cùng commit. Bản vá
bảo mật lên engine: sửa ở repo gốc → tag mới → các fork
`git cherry-pick`/merge tag đó. Không có package registry riêng — fork mang
theo nguyên monorepo, "version" của một fork là tag engine nó xuất phát.

## Sau mỗi mùa

Đóng đăng ký → xuất Excel nội bộ + file NTT → hạ subscription về free (dữ
liệu ~75MB nằm dưới hạn free của Supabase, giữ nguyên) → tag
`campaign/<slug>-final` để mùa sau biết chính xác trạng thái đã chạy.
