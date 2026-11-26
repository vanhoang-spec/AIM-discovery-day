# Tiếp tục phiên làm việc

File này để mở lại công việc từ máy khác (điện thoại, máy khác, phiên cloud).
Đọc xong file này là đủ ngữ cảnh để làm tiếp mà không cần lịch sử hội thoại cũ.

**Cách dùng trên điện thoại:** mở `claude.ai/code`, chọn repo
`vanhoang-spec/AIM-discovery-day`, rồi gõ: *"Đọc TIEP-TUC.md và làm tiếp"*.

---

## XONG (26/11/2026) — gói dữ liệu lưu trữ cho AIM

**`D:\AI_App_Embassy\AIM Academy\ATL2026-du-lieu-luu-tru-AIM-2026-11-26.zip`** (2,4 MB, 57 file,
SHA256 `2853620bbd1ce3defb335f0ed1e6a7a6f3f5989f6d08932034c393465458677c`). Bản giải nén nằm ở
`ATL2026-du-lieu-2026-11-20\gui-AIM\`: 3 thư mục sự kiện (01 HN, 02 HCM, 04 UEF; mỗi thư mục 17 CSV + 1 xlsx),
`TONG-HOP-CAC-SU-KIEN.csv`, `DOC-TRUOC.txt`, `SHA256SUMS.txt`. Có họ tên / email / SĐT → chỉ gửi AIM qua
kênh riêng tư; zip KHÔNG có mật khẩu (máy không có 7-Zip). Đã giải nén thử, 56/56 mã kiểm tra khớp.
Số dòng 24 bảng đếm lại 26/11 = y hệt 20/11; số chốt khớp: HN 782/342/311 · HCM 1.116/731/627 · UEF 498/474/618.

**Cách lấy dữ liệu không cần mật khẩu DB và không cần hộp Save As** (dùng lại được):
SQL Editor → dán `phan-1.sql` / `phan-2.sql` → Run → nút *Export* mở bằng JS
(`dispatchEvent(new PointerEvent('pointerdown',…))`; click thường không mở menu) → bấm menuitem
**"Copy as CSV"** qua extension (click thật, có user-activation) → PowerShell `Get-Clipboard -Raw` ghi ra
`bang-tho\goi-phan-1.csv` / `goi-phan-2.csv` (UTF-8 không BOM) → `Set-Clipboard ' '` xoá clipboard (có PII)
→ `node scripts/export-event-csv.mjs …\bang-tho …\gui-AIM --events=1,2,4`. Zip bằng `tar.exe -a -c -f`
(Compress-Archive của PowerShell 5.1 ghi đường dẫn bằng `\`, mở trên Mac bị hỏng).
Phiên Supabase trên Chrome hết hạn sau vài ngày — chủ phải tự đăng nhập lại (GitHub).

Phát hiện khi xuất: UEF **không có thư nhắc 6h nào** trong outbox (`queue_event_reminders` chưa từng chạy) —
chỉ 498 thư xác nhận; 493/498 SV đăng ký ngay trong ngày 17/11 nên ảnh hưởng nhỏ. UEF có 13 lượt quét
16/11 (chạy thử máy). Special gift UEF đổi ngưỡng 4 → 3 (16/11) → 2 (17/11 14:23).

### Ghi chép cũ của bước này (20–21/11, giữ để tra)

Chủ muốn: **toàn bộ dữ liệu ra CSV, tách riêng từng sự kiện AIM tổ chức** (HN 12/09, HCM 12/09,
UEF 17/11 — bỏ event 3 diễn tập) để gửi AIM nghiệm thu. Có thể phiên sau chạy trên tài khoản
Claude khác cùng máy này: mọi file dưới đây nằm trên ổ D:, đọc thẳng được.

**Thư mục dữ liệu (NGOÀI repo, có họ tên / email / SĐT — không đưa vào git):**
`D:\AI_App_Embassy\AIM Academy\ATL2026-du-lieu-2026-11-20\bang-tho\`
- `_so-dong.json` — số dòng 24 bảng, đếm trên production 20/11 bằng `_dem-dong.sql`
  (students 2401, registrations 2414, attendance 6027, ledger_events 6140, gift_redemptions 1558,
  notification_outbox 2398…; golden_hours / surveys / survey_responses / teams = 0).
- `phan-1.sql`, `phan-2.sql` — sinh bằng `node scripts/export-bundle-sql.mjs <thư-mục>`; SELECT chỉ
  đọc, mỗi dòng kết quả = tối đa 500 dòng của 1 bảng dạng JSON. Đã chạy trên SQL Editor 20/11:
  phần 1 ra **33 dòng**, phần 2 ra **35 dòng**, không lỗi.

**Đang chờ chủ:** ở 2 tab Supabase SQL Editor, bấm *Export → Download CSV* (agent KHÔNG tải được:
Chrome của chủ bật "hỏi nơi lưu từng file" và extension không bấm được hộp Save As — đã thử 2 lần).
File tải về vào `bang-tho\` hoặc `D:\Downloads` (tên kiểu `Supabase Snippet ….csv`, dòng đầu
`bang,phan,du_lieu`). Mất 2 tab thì mở lại SQL Editor, dán `phan-1.sql` / `phan-2.sql`, Run, Export.

**Khi có 2 file:** chuyển vào `bang-tho\`, rồi chạy
`node scripts/export-event-csv.mjs "<…>\bang-tho" "<…>\ATL2026-du-lieu-2026-11-20\gui-AIM" --events=1,2,4`
(xem tên sự kiện in ra để chắc id 1 = HN, 2 = HCM, 4 = UEF). Script tự dừng nếu bảng nào lệch số dòng
so với `_so-dong.json` hoặc cột khác lược đồ. Ra mỗi sự kiện 1 thư mục: `00-tong-quan` … `16-doi-thi`
(.csv UTF-8 BOM) + 1 file .xlsx gộp. Đối chiếu `00-tong-quan.csv` với số liệu cuối:
HN 782 đăng ký / 342 SV có badge / 311 lượt quà · HCM 1.116 / 731 / 627 · UEF 498 / 474 / 618.
Rồi: viết `DOC-TRUOC.txt` cho gói dữ liệu, `SHA256SUMS.txt`, báo chủ gửi AIM qua kênh riêng tư.
Script đã thử trên PGlite (cả 2 cách: CSV từng bảng và gói gộp, ra kết quả giống nhau).

**Gói mã nguồn bàn giao (xong 20/11, đã kiểm 506/506 test từ bản giải nén):**
`D:\AI_App_Embassy\AIM Academy\ATL2026-ban-giao-2026-11-20\` — `.zip` mã nguồn, `.bundle` git đủ lịch sử,
`DOC-TRUOC.txt`, `SHA256SUMS.txt`. Chủ gửi máy chủ TCM (cả 3 file) và AIM (.zip). Gói này dựng từ
commit `02f86f3`; hai script xuất dữ liệu ở trên commit sau đó — không bắt buộc dựng lại gói.

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
2. **Sao lưu không cần mật khẩu: xem mục "ĐANG LÀM DỞ" ở đầu file** (gói gộp qua SQL Editor —
   đủ mọi bảng, có đối chiếu số dòng). Cách cũ bên dưới vẫn đúng nếu sau này cần `pg` trực tiếp.
   `scripts/backup-db.mjs` (chỉ đọc, ghi ra
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
- Agent Chrome: `monaco` chưa có ngay khi trang SQL Editor vừa mở — chờ tải xong; Ctrl+Enter không chạy,
  phải bấm nút Run. Lưới kết quả tự giới hạn 100 dòng ("Limit to only 100 rows") → câu nào trả nhiều
  dòng phải gộp (như `phan-*.sql`). Agent không tải file về được (xem mục đầu file).
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
