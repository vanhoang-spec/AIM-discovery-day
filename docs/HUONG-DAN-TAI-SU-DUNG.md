# Hướng dẫn bàn giao và tái sử dụng mã nguồn ATL2026

Nền tảng đăng ký, quét badge và đổi quà cho sự kiện sinh viên của AIM Academy
(Awaken The Lions 2026 · Discovery Day Hà Nội và TP.HCM 12/09/2026 · Discovery Day UEF 17/11/2026)

| | |
|---|---|
| Ngày lập | **26/11/2026** |
| Căn cứ | Mã nguồn nhánh `main` tại commit `a3552f4` (26/11/2026). Bộ test chạy lại ngày 26/11: **506/506 xanh** |
| Gửi tới | **AIM Academy** (khách hàng, chủ dữ liệu) và **TCM** (đơn vị lưu trữ kỹ thuật) |
| Cách đọc | Phần I (mục 1) đọc trong 5 phút, không cần biết kỹ thuật. Phần II–IV dành cho đội kỹ thuật tiếp nhận |

Quy ước trong tài liệu:

- Chữ **"cần kiểm lại"** đánh dấu điều chưa xác minh được từ mã nguồn hoặc phụ thuộc vào dịch vụ bên ngoài
  (giao diện, gói cước có thể đã đổi). Danh sách gom ở Phụ lục E.
- Tài liệu **không chứa** mật khẩu, khoá bí mật hay dữ liệu cá nhân của sinh viên. Chỗ cần giá trị thật
  ghi dạng `<trong-ngoặc-nhọn>`.
- Đường dẫn file tính từ thư mục gốc của mã nguồn (nơi có `package.json`).

---

## Mục lục

**Phần I — Cho người không làm kỹ thuật**

1. Tóm tắt trong 5 phút
   - 1.1 Hệ thống làm gì
   - 1.2 Đã chạy những sự kiện nào
   - 1.3 Trong gói bàn giao có gì
   - 1.4 Muốn chạy sự kiện mới thì cần gì
   - 1.5 Ai làm được việc gì
   - 1.6 Ba điều phải nhớ

**Phần II — Hiểu hệ thống**

2. Kiến trúc
   - 2.1 Sơ đồ tổng
   - 2.2 Hai ứng dụng
   - 2.3 Tám thư viện dùng chung
   - 2.4 Database và 17 migration
   - 2.5 Luồng chính
   - 2.6 Những bảo đảm không được phá
3. Hạ tầng tại ngày bàn giao và quyền sở hữu
   - 3.1 Dịch vụ đang chạy
   - 3.2 Biến môi trường và secrets
   - 3.3 Khoá ký mã QR (`ATL_HMAC_KEY`) — đổi thì sao
   - 3.4 Mật khẩu database — không ai còn giữ
   - 3.5 Chuyển quyền sở hữu

**Phần III — Làm việc với hệ thống**

4. Dựng lại từ đầu trên tài khoản mới
5. Chạy một sự kiện mới trên hệ thống đang có (runbook)
6. Xuất và sao lưu dữ liệu
7. Đổi thương hiệu, dùng cho khách hàng khác

**Phần IV — Giữ cho hệ thống đúng**

8. Bảo trì và quy tắc
9. Bảo mật và dữ liệu cá nhân
10. Giới hạn hiện tại và hướng phát triển

**Phụ lục**

- A. Cây thư mục
- B. Lệnh và câu SQL thường dùng
- C. Bảng biến môi trường
- D. Các bảng database chính
- E. Danh sách "cần kiểm lại"
- F. Tài liệu khác trong gói

---

# Phần I — Cho người không làm kỹ thuật

## 1. Tóm tắt trong 5 phút

### 1.1 Hệ thống làm gì

Một bộ phần mềm chạy trên web, gồm hai ứng dụng:

1. **Trang dành cho sinh viên** (`app.awakenthelions.net`): sinh viên đăng ký tham dự, nhận email xác nhận
   có **mã QR** riêng, xem lịch hoạt động, xem mình đã có bao nhiêu badge và đủ điều kiện nhận quà gì.
   Cùng trang này có **bảng điều khiển cho Ban tổ chức** (`/admin`).
2. **Ứng dụng máy quét cho nhân sự PG** (`pg.awakenthelions.net`): PG dùng điện thoại của mình quét mã QR
   của sinh viên ở cổng, ở gian hàng nhà tài trợ, ở hội trường, lớp học. Mỗi lượt quét cộng badge cho
   sinh viên. Đủ số badge thì sinh viên nhận quà ở **Quầy quà** và giữ được suất **hoạt động đặc biệt**.

Ban tổ chức theo dõi số liệu gần như trực tiếp (làm mới mỗi 5 giây), sửa badge khi có sai sót, quản lý
máy quét, và sau sự kiện xuất Excel: một file nội bộ đầy đủ và một file riêng cho từng nhà tài trợ
(chỉ gồm sinh viên đã đồng ý chia sẻ thông tin).

Ba điểm khiến hệ thống đáng tin trong ngày đông người:

- **Máy quét chạy được khi mất mạng.** Lượt quét lưu trên điện thoại, có sóng lại thì tự gửi lên.
- **Không cấp trùng, không phát quá kho.** Quét lại bao nhiêu lần cũng chỉ một badge; không bao giờ phát
  quá số quà hay số suất đã khai báo. Các bảo đảm này do database thực thi, có test kiểm tra.
- **Mọi chỉnh sửa đều để lại dấu vết** (ai, lúc nào, lý do).

### 1.2 Đã chạy những sự kiện nào

Số liệu đọc từ database production ngày 20/11/2026, đếm lại ngày 26/11/2026 không đổi.

| Sự kiện | Ngày | Đăng ký | Sinh viên có badge | Lượt nhận quà | Trạng thái |
|---|---|---:|---:|---:|---|
| Discovery Day Hà Nội (FTU Hà Nội) | 12/09/2026 | 782 | 342 | 311 | Đã khoá |
| Discovery Day TP.HCM (FTU cơ sở II) | 12/09/2026 | 1.116 | 731 | 627 | Đã khoá |
| Discovery Day - UEF (UEF campus 141-145 Điện Biên Phủ) | 17/11/2026, 8h00–17h30 | 498 | 474 | 618 | Đã đóng đăng ký, **chưa khoá** |

Ghi chú:

- Ngoài ba sự kiện trên còn một **sự kiện diễn tập** (số 3, 09–11/09/2026), đã khoá và ẩn khỏi mọi danh sách.
- Đợt 12/09 có 1.211 sinh viên được nhập từ danh sách của AIM qua 3 đợt, 0 lỗi.
- UEF: 493/498 sinh viên đăng ký ngay trong ngày 17/11 (phần lớn tại cổng); 1.078 lượt quét; quà bậc 7 badge:
  366 lượt, bậc 8 badge: 252 lượt. **Không có thư nhắc buổi sáng** vì bước xếp thư nhắc chưa được chạy
  (xem mục 5.11 để lần sau không lặp lại). 4 thư xác nhận không gửi được do sinh viên nhập sai email.
- "Có mặt" được đếm theo số sinh viên có ít nhất một badge. Cột `checked_in_at` trong database không được
  dùng ở sự kiện nào (luôn bằng 0) — đây không phải lỗi dữ liệu.

### 1.3 Trong gói bàn giao có gì

| Thành phần | Nội dung | Ai giữ |
|---|---|---|
| File `.zip` mã nguồn | 2 ứng dụng, 8 thư viện dùng chung, 16 migration database, script vận hành, spec kỹ thuật, 14 tài liệu PDF đã gửi AIM | AIM và TCM |
| File `.bundle` git | Cùng mã nguồn kèm **toàn bộ lịch sử thay đổi**, để đội kỹ thuật biết vì sao từng dòng được viết như vậy. Khôi phục: `git clone <tên-file>.bundle ATL2026` | TCM (AIM giữ thêm nếu có đội kỹ thuật) |
| `DOC-TRUOC.txt`, `SHA256SUMS.txt` | Giới thiệu ngắn và mã kiểm tra từng file | Cả hai |
| Tài liệu này | `docs/HUONG-DAN-TAI-SU-DUNG.md` | Cả hai |

**Cố ý không có trong gói:** mật khẩu và khoá bí mật (chỉ nằm trong Vercel, xem mục 3.2), dữ liệu sinh viên,
hai tài liệu mật của AIM (Agency Brief PDF, file Website `.docx`), thư mục thư viện cài đặt `node_modules`
(tải lại bằng `npm ci`).

**Gói dữ liệu sinh viên là gói riêng** (`ATL2026-du-lieu-luu-tru-AIM-2026-11-26.zip`, lập 26/11/2026): mỗi sự kiện
một thư mục gồm 17 file CSV và 1 file Excel, có họ tên, email, số điện thoại. Chỉ gửi AIM qua kênh riêng tư.
File zip này **không đặt mật khẩu** — AIM nên cất ở nơi có phân quyền (xem mục 9).

> Nếu gói mã nguồn bạn nhận là bản **20/11/2026** (dựng từ commit `02f86f3`): bản đó **chưa có** hai script xuất
> dữ liệu `scripts/export-bundle-sql.mjs`, `scripts/export-event-csv.mjs` (thêm ở commit `2188681`, 21/11) và
> chưa có tài liệu này. Nên dùng gói dựng từ commit mới nhất.

Kiểm file sau khi chép sang máy khác:

- Windows: `Get-FileHash <tên-file> -Algorithm SHA256`, so với dòng tương ứng trong `SHA256SUMS.txt`.
- macOS / Linux: `sha256sum -c SHA256SUMS.txt` (đứng trong thư mục chứa các file).

### 1.4 Muốn chạy sự kiện mới thì cần gì

Có hai cách:

**Cách A — dùng tiếp hệ thống đang chạy** (nhanh nhất). Ngày 26/11/2026 hệ thống vẫn chạy ở
`app.awakenthelions.net`. Cần:

- mã truy cập trang quản trị (`/admin`);
- quyền vào project Supabase đang chạy (để chạy vài câu SQL);
- quyền chạy GitHub Actions trên kho mã (để deploy);
- nội dung sự kiện: danh sách gian hàng / hoạt động, ngưỡng badge, số lượng quà, nội dung thư.

Thời gian chuẩn bị nên có **ít nhất 1–2 tuần** (lịch lùi ở mục 5.1). Rủi ro: toàn bộ hạ tầng đang nằm ở
tài khoản của chủ dự án (mục 3.1), database đang ở gói miễn phí.

**Cách B — dựng mới trên tài khoản của AIM hoặc TCM.** Cần tài khoản GitHub, Vercel, Supabase, Resend
(gửi email) và quyền sửa DNS của tên miền. Một lập trình viên quen Node.js dựng xong trong khoảng nửa ngày
đến một ngày (mục 4), cộng thêm **24–72 giờ** chờ DNS và **vài ngày** gửi thư thử để email không vào thư rác.

Tài khoản và chi phí — chỉ ghi những con số có trong tài liệu dự án:

| Dịch vụ | Dùng để | Gói | Chi phí ghi trong tài liệu |
|---|---|---|---|
| GitHub | Lưu mã, chạy test, chạy deploy | Kho riêng tư + GitHub Actions | Không ghi |
| Vercel | Chạy 2 ứng dụng | **Pro** — tài liệu dựng 27/08 ghi cần Pro cho máy chủ Singapore và cho bộ hẹn giờ gửi email mỗi phút | Không ghi giá (xem bảng giá Vercel hiện hành — cần kiểm lại) |
| Supabase | Database | Hiện tại: **Free**. Khi chạy sự kiện tài liệu khuyên Pro (sao lưu tự động hằng ngày, giữ 7 ngày) | Thêm một project vào tổ chức Pro sẵn có: **+10 USD/tháng** tiền máy (`docs/FORK-PLAYBOOK.md`) |
| Resend | Gửi email | — | Không ghi |
| Tên miền | Địa chỉ web và gửi thư | AIM đang có `awakenthelions.net` tại Mắt Bão | Không ghi |

Vật tư ngày sự kiện (từ `README.md`, cho đợt 2 điểm, khoảng 45–50 máy PG): khoảng 45 pin dự phòng
(~7 triệu đồng), hotspot của 2 nhà mạng khác nhau, 5–8 điện thoại mượn cho PG có máy không đạt, sổ vé giấy
đánh số dự phòng khi mất mạng.

### 1.5 Ai làm được việc gì

| Việc | Ai làm được | Cần gì |
|---|---|---|
| Dựng gian hàng / hoạt động, bậc quà, số lượng quà, ngưỡng; tạo và phát máy cho PG; mở / đóng đăng ký; theo dõi số liệu; sửa badge; xuất Excel | Nhân sự AIM đã đọc PDF *Hướng dẫn Admin* | Mã truy cập `/admin` |
| Nhân bản cấu hình từ sự kiện cũ sang sự kiện mới | Nhân sự AIM (một nút trong trang quản trị) | Như trên. Giờ bắt đầu / kết thúc nút này đặt cứng 8h–17h, khác giờ thì cần kỹ thuật sửa (mục 5.4) |
| Đặt nội dung thư riêng cho sự kiện, sửa giờ sự kiện, khoá sự kiện cũ, xếp thư nhắc, xuất toàn bộ dữ liệu | Người biết dùng **Supabase SQL Editor** (dán câu SQL có sẵn trong tài liệu này) | Quyền vào project Supabase |
| Sửa danh sách sự kiện dự phòng trong mã, deploy | Lập trình viên (JavaScript cơ bản) | Quyền GitHub Actions |
| Dựng lại hạ tầng, đổi thương hiệu, sửa luật tính điểm | Lập trình viên Node.js / Next.js / PostgreSQL | Tài khoản các dịch vụ ở mục 1.4 |

### 1.6 Ba điều phải nhớ

1. **Hạ tầng hiện thuộc tài khoản của chủ dự án.** Nên chốt sớm việc chuyển quyền hoặc dựng lại trên tài khoản
   của AIM / TCM (mục 3.5).
2. **Không ai còn giữ mật khẩu database.** Muốn sao lưu trực tiếp hoặc chuyển dữ liệu phải đặt lại mật khẩu
   theo đúng quy trình (mục 3.4), nếu làm sai ứng dụng mất kết nối ngay.
3. **Dữ liệu sinh viên là dữ liệu cá nhân.** Không gửi file Excel tổng cho nhà tài trợ; chỉ gửi file riêng
   từng nhà tài trợ lấy trong trang quản trị (mục 9).

---

# Phần II — Hiểu hệ thống

## 2. Kiến trúc

### 2.1 Sơ đồ tổng

```
 Sinh viên (điện thoại)        Nhân sự PG (điện thoại)           Ban tổ chức (laptop)
 app.<tên-miền>                pg.<tên-miền>                     app.<tên-miền>/admin
 apps/web  (Next.js)           apps/pg  (Next.js, PWA offline)   apps/web
        \                              |                             /
         \______ Vercel, vùng sin1 (Singapore), 2 project __________/
                                       |
                 Supabase Postgres, vùng ap-southeast-1
                 (kết nối qua Transaction pooler cổng 6543, bắt buộc SSL)
                                       |
   Vercel Cron mỗi phút -> /api/cron/outbox -> Resend (mail.<tên-miền>) -> hộp thư sinh viên
```

Công nghệ: Node.js (CI dùng bản 22), npm workspaces, Next.js 15, React 19, thư viện `postgres` (postgres.js).
Test chạy Postgres thật biên dịch sang WebAssembly (**PGlite**) — không cần cài Postgres hay Docker.

### 2.2 Hai ứng dụng

**`apps/web` — app sinh viên + trang quản trị + API + bộ gửi thư** (Vercel project web, gợi ý tên `atl2026-web`)

| Đường dẫn | Việc |
|---|---|
| `/` | Trang chủ |
| `/dang-ky` | Form đăng ký online (đóng / mở bằng nút trong admin) |
| `/dang-ky?nhanh` | Form đăng ký nhanh tại cổng — **vẫn chạy khi đăng ký online đã đóng** |
| `/toi` | Mã QR (xem được khi không có mạng), tiến độ badge, quà đủ điều kiện. Link riêng trong thư: `/toi#t=<mã truy cập SV>` (từ 26/11; trước đó là mã QR) |
| `/lich`, `/lich/khu-vuc` | Lịch hoạt động (làm mới mỗi 60 giây) |
| `/khao-sat` | Khảo sát của gian hàng |
| `/admin` | Bảng điều khiển Ban tổ chức (7 tab, bảng dưới) |
| `/api/register` | Nhận đăng ký, ký mã QR |
| `/api/refdata` | Danh sách sự kiện, trường, tỉnh cho form — **CDN giữ 1 giờ** (xem mục 5.9) |
| `/api/toi`, `/api/toi/pass`, `/api/khao-sat` | Tiến độ / thẻ tham dự / khảo sát của sinh viên. Xác thực bằng **mã truy cập SV** (khoá `ATL_ACCESS_KEY`), **không** bằng mã QR (mục 9) |
| `/api/cron/outbox` | Bộ gửi thư, Vercel Cron gọi mỗi phút (`apps/web/vercel.json`). Production bắt buộc `CRON_SECRET` |
| `/api/admin/*` | API của trang quản trị, kiểm mã truy cập `ADMIN_ACCESS_KEY` |

Trang quản trị làm được gì (chi tiết thao tác: PDF `ATL2026-Huong-dan-Admin.pdf`):

| Tab | Việc | API |
|---|---|---|
| Tổng quan | Số đăng ký, check-in, tổng badge, **lệch bộ đếm (phải luôn bằng 0)**, phân bố badge, phễu quà, suất đặc biệt, tình trạng từng máy PG. Làm mới mỗi 5 giây | `overview` |
| Sinh viên | Tìm theo tên / SĐT / MSSV / mã 6 ký tự (gõ không dấu được); gỡ badge, cấp badge tay (bắt buộc lý do) | `students`, `students/[id]` |
| Cấu hình | Ngưỡng và kho từng bậc quà (thu hẹp điều kiện thì chạy thử trước để xem ảnh hưởng), `y` (badge cần cho suất đặc biệt), `z` (số suất tối đa mỗi người), thang quà; **Nhân bản sự kiện** | `config`, `clone` |
| Hoạt động | Thêm / sửa điểm quét: tên, giờ, vị trí, loại, trọng số badge 1–9, bật / tắt tính badge; nút **Excel NTT** cho từng gian hàng | `checkpoints`, `zones`, `export-ntt` |
| Khảo sát | Khảo sát gắn gian hàng, tối đa 8 câu | `surveys` |
| Vận hành | Mở / đóng đăng ký online, Early Bird, hoạt động đặc biệt (số suất), nhân sự PG và máy quét: tạo, gán điểm quét, vai trò, thu hồi | `event`, `specials`, `pg-devices` |
| Đối soát | Sau sự kiện: nhập vé giấy / quà phát tay khi mất mạng, qua đúng luật của quầy thật | `reconcile` |
| Nút ⬇ Excel | File Excel nội bộ của sự kiện đang chọn (đủ thông tin cá nhân) | `export` |
| (đang ẩn) Giờ Vàng, công cụ theo khu vực | Tắt bằng `SHOW_ZONE_TOOLS = false` trong `apps/web/src/app/admin/page.js` | `golden`, `zones` |

Trang quản trị **không** làm được (phải dùng SQL, xem Phụ lục B): sửa tên / địa điểm / giờ của sự kiện,
đặt nội dung thư riêng (`email_copy`), khoá sự kiện (`is_archived`), xếp thư nhắc hàng loạt, sửa danh sách
trường / tỉnh, gửi lại thư xác nhận.

**`apps/pg` — app máy quét cho PG** (Vercel project pg, gợi ý tên `atl2026-pg`). Là PWA: cài vào màn hình chính,
chạy khi mất mạng, hàng đợi lưu trong trình duyệt (IndexedDB).

| Màn | Việc | Máy nào mở được |
|---|---|---|
| `/` | Nhận máy: mã 6 ký tự in trên thẻ + PIN 4 số PG tự đặt | Mọi máy |
| `/quet` | Quét badge ở cổng / gian hàng / hội trường / lớp | Mọi máy (điểm quét do Ban tổ chức gán) |
| `/tra-cuu` | Tra tay theo tên, SĐT, MSSV, mã 6 ký tự (khi SV hết pin, mất mã) — chạy offline | Mọi máy |
| `/hang-cho` | Xem các lượt quét chưa gửi lên | Mọi máy |
| `/qua` | Trao quà | Chỉ máy đang được gán vào điểm quét loại **Quầy đổi quà** (`gift_counter`) |
| `/suat` | Giữ chỗ / vé hội trường (hoạt động đặc biệt) | Chỉ máy có vai trò **Quầy vé hội trường** (`hall_ticket`) |

API của app PG (`/api/pg/claim`, `sync`, `roster`, `state`, `gift`, `special`) đều kiểm token của máy;
máy bị thu hồi thì bị từ chối ngay ở lần gọi kế tiếp.

Hai app deploy **độc lập**: app PG có thể đóng băng từ sáng ngày sự kiện trong khi app sinh viên vẫn sửa nóng
được. Lần deploy cuối của app PG là 11/09/2026 (đợt UEF không sửa app PG).

### 2.3 Tám thư viện dùng chung (`packages/`)

| Thư viện | Việc | Ghi chú |
|---|---|---|
| `@atl/qr-token` | Ký và kiểm mã QR bằng HMAC, kiểm được cả khi offline | **Dùng chung nguyên vẹn** cho server, app PG, app SV. Tách bản riêng là máy quét sẽ từ chối SV thật |
| `@atl/qr-render` | Vẽ mã QR ra SVG / PNG | Chỉ chạy phía server |
| `@atl/scan-queue` | Hàng đợi quét offline, gửi lại có giãn cách ngẫu nhiên, phát hiện webview Zalo | "File quan trọng nhất dự án" |
| `@atl/db` | Kết nối database (`max: 1`, `prepare: false`, cổng 6543, timeout 10 giây); không có `DATABASE_URL` thì dùng PGlite + dữ liệu mẫu (chỉ ở môi trường dev) | Production thiếu `DATABASE_URL` thì **dừng hẳn**, không rơi về PGlite |
| `@atl/email` | Mẫu thư (mẫu cũ ATL2026 và mẫu kiểu AIM theo `events.email_copy`), gửi qua Resend | |
| `@atl/vn-text` | Gấp dấu tiếng Việt, tra cứu danh sách SV offline (~1,8 ms trên 2.000 dòng) | |
| `@atl/xlsx-lite` | Xuất file Excel `.xlsx` không cần thư viện ngoài | |
| `@atl/brand` | Tên chiến dịch, màu, địa chỉ trả lời thư | Chỗ chính để đổi thương hiệu (mục 7) |

Mỗi thư viện có `CHANGELOG.md`. Mốc ổn định đánh tag git `engine-vX.Y.Z` (hiện có `engine-v1.0.0`).

### 2.4 Database và 17 migration

24 bảng (Phụ lục D). Hai luật xuyên suốt: mọi dòng thuộc một sự kiện mang `event_id`; bảng con tham chiếu
bảng cha bằng **khoá phức hợp có `event_id`**, nên dữ liệu Hà Nội không thể lẫn sang TP.HCM.

| Migration | Nội dung |
|---|---|
| `0001_foundations` | Mùa (`editions`), sự kiện (`events`, id 1–255 vì nằm trong mã QR), khu vực, điểm quét, trường, tỉnh, sinh viên, đội, đăng ký, nhật ký thao tác |
| `0002_ledger` | Sổ cái quét `ledger_events` (chỉ ghi thêm, trigger chặn sửa / xoá), `attendance` (một SV một điểm một badge), đếm theo phút |
| `0003_rewards` | Bậc quà, lượt nhận quà, hoạt động đặc biệt và suất tạo sẵn (`FOR UPDATE SKIP LOCKED`, giữ chỗ 2 pha) |
| `0004_registration` | Hàng đợi thư `notification_outbox`; `register_student` chống trùng trong một transaction |
| `0005_pg_devices` | Nhân sự PG, máy quét (mã nhận máy + PIN), điểm vào đồng bộ hàng loạt; cột Early Bird |
| `0006_checkpoint_bonus_kind` | Loại điểm quét `bonus` (Early Bird, Giờ Vàng) |
| `0007_two_ladders` | Hai thang đếm: thang quà và thang suất đặc biệt |
| `0008_golden_hours` | Giờ Vàng (×2 badge có trần) |
| `0009_clone_event` | `clone_event`: chép cấu hình sang sự kiện mới, không chép người và lịch sử |
| `0010_surveys` | Khảo sát gian hàng, tối đa 8 câu (ràng buộc CHECK) |
| `0011_registration_gate` | Cờ mở / đóng đăng ký thật sự chặn form online; tại cổng vẫn nhận |
| `0012_badge_weights` | Badge có trọng số; suất đặc biệt xét trên tổng badge |
| `0013_device_roles` | Vai trò máy: `scan` (mặc định) / `hall_ticket` |
| `0014_gift_cascade` | Luật đổi quà cộng dồn (7 badge → túi; 9 badge → túi + hộp bút) |
| `0015_event_archive` | `events.is_archived`: khoá và ẩn sự kiện |
| `0016_event_email_copy` | `events.email_copy` (chữ thư riêng từng sự kiện) + `queue_event_reminders` (xếp thư nhắc hàng loạt) |
| `0017_rls_lockdown` | Vá bảo mật 26/11: bật RLS mọi bảng (không policy, không FORCE), thu mọi quyền của `anon` / `authenticated` và EXECUTE của PUBLIC, default privileges cho object mới (mục 9) |

Các file SQL sinh tự động bằng `node scripts/build-production-sql.mjs` (chạy ở thư mục gốc, **đừng sửa tay**):

- `supabase/production-init.sql` — toàn bộ 17 migration theo thứ tự, **chỉ** dán vào database **mới, trống**.
- `supabase/production-patch-0017.sql` — chỉ migration mới nhất (0017), bọc một transaction, cho database đang chạy.
  `production-patch-0016.sql` là bản vá trước (đã áp 11/2026), giữ lại để đối chiếu.
- `supabase/production-seed.sql` — dữ liệu nền: 24 trường, 34 tỉnh, mùa 2026 và 2 sự kiện Hà Nội / TP.HCM 12/09/2026
  ở trạng thái đóng đăng ký.

### 2.5 Luồng chính

1. **Đăng ký.** Form đọc danh sách sự kiện / trường / tỉnh từ `/api/refdata`. `/api/register` kiểm dữ liệu rồi gọi
   `register_student`: tìm người theo **email hoặc SĐT trên toàn bộ chiến dịch** (một người một hồ sơ, một số `seq`),
   tạo dòng đăng ký, xếp đúng **một** thư xác nhận vào `notification_outbox`. Gửi form hai lần không tạo hồ sơ trùng.
   Cổng đăng ký đóng thì từ chối nguồn `online`; đăng ký tại cổng (`walk_in`) vẫn qua. Sự kiện đã khoá thì từ chối tất cả.
2. **Mã QR.** Server ký mã: 16 byte = phiên bản (1) + id sự kiện (1) + `seq` sinh viên (4) + HMAC-SHA256 cắt còn 80 bit (10)
   → Crockford Base32, 26 ký tự → QR cỡ 25×25, mức sửa lỗi Q. Ảnh QR gửi về máy SV một lần, `/toi` hiện lại không cần mạng.
   Kèm **mã tra cứu 6 ký tự** để PG nhập tay. Mã QR **chỉ để quét**: khoá ký nó công khai trong app PG.
   Cùng lúc server ký **mã truy cập SV** (cùng khung 16 byte / 26 ký tự, byte đầu `0xA1`, khoá `ATL_ACCESS_KEY` chỉ có ở
   server — `apps/web/src/lib/access-token.js`). `/toi` lưu nó trong thẻ (`atl_pass_v1.access`) và dùng nó để đọc điểm.
3. **Gửi thư.** Vercel Cron gọi `/api/cron/outbox` mỗi phút (kèm `CRON_SECRET`; production thiếu biến này thì route
   từ chối mọi lời gọi, trả 503, không gửi thư). Mỗi lượt nhận tối đa **40 thư**
   (~2.400 thư/giờ). Mẫu thư chọn **lúc gửi**: sự kiện có `email_copy` dùng mẫu kiểu AIM, không có thì dùng mẫu cũ ATL2026.
   Mã QR được ký lại mỗi lần gửi (cùng kết quả); link riêng `/toi#t=…` mang **mã truy cập SV**, không mang mã QR.
   Lỗi thì lùi lịch 1 → 2 → 4… phút, sau 8 lần thì đánh dấu `failed`.
4. **Quét.** Máy PG đã nhận mã, đã tải danh sách SV (làm mới phần thay đổi mỗi 10 phút). Quét QR → kiểm chữ ký ngay
   trên máy → hiện kết quả trong ~150 ms (dấu `~` = đã ghi trên máy, `✓` = server đã xác nhận; quét trùng hiện **màu hổ phách**,
   không phải lỗi) → hàng đợi đẩy lên `/api/pg/sync` → `record_pg_scan` ghi `ledger_events` và `attendance`, cộng badge theo
   trọng số của điểm quét.
5. **Đổi quà.** Máy đứng ở Quầy đổi quà gọi `claim_gift_tier`: đủ ngưỡng thì trừ kho nguyên tử, thang cộng dồn
   (đủ mốc cao nhận kèm mọi mốc thấp chưa nhận). Không bao giờ phát quá kho, không đổi trùng một bậc.
6. **Suất đặc biệt.** Máy vai trò Quầy vé hội trường giữ chỗ 90 giây rồi xác nhận, trên các suất tạo sẵn đúng bằng sức chứa.
7. **Theo dõi.** SV xem tiến độ ở `/toi` (tự làm mới 30 giây/lần khi đang mở). Ban tổ chức xem `/admin` (5 giây/lần).
8. **Sau sự kiện.** Đối soát vé giấy, xuất Excel, khoá sự kiện, xuất toàn bộ dữ liệu (mục 5.13 và 6).

### 2.6 Những bảo đảm không được phá

Bảng đầy đủ và test tương ứng: `README.md` mục "Những gì đã được bảo đảm". Danh sách file cần soi kỹ: `CONTRIBUTING.md`.
Những quyết định trông như thiếu sót nhưng là cố ý: không có websocket (SV tự hỏi lại định kỳ); quét trùng không phải lỗi;
không nhét URL hay JWT vào QR, không chèn logo, không đổi màu QR; sổ cái chỉ ghi thêm; hai ô đồng ý tách riêng,
không tick sẵn; thẻ QR nền trắng kể cả ở chế độ tối.

---

## 3. Hạ tầng tại ngày bàn giao và quyền sở hữu

### 3.1 Dịch vụ đang chạy

| Thành phần | Ở đâu | Chủ hiện tại | Ghi chú |
|---|---|---|---|
| Mã nguồn | GitHub, kho riêng tư `vanhoang-spec/AIM-discovery-day`, nhánh `main` | Tài khoản GitHub của chủ dự án | Gói `.zip` / `.bundle` là bản sao đầy đủ |
| Database | Supabase, project `atl2026-production`, ref `qllxeocjtbgtsrzpolqr`, vùng ap-southeast-1 | Tổ chức Supabase "Embassy", **gói Free** | Không ai còn mật khẩu database (mục 3.4). Gói Free: chính sách tạm dừng project ít hoạt động và sao lưu tự động — cần kiểm lại |
| Hosting | Vercel, vùng `sin1`, 2 project: app sinh viên và app PG | Tài khoản / team Vercel của chủ dự án | Tên project theo tài liệu dựng: `atl2026-web`, `atl2026-pg`; team đang chứa 2 project (sổ nội bộ ghi `hoang77`, thông báo lỗi trong `deploy.yml` nhắc team TCM, slug `tcm17`) — cần kiểm lại |
| Deploy | GitHub Actions, workflow **Deploy (manual only)** | Kho GitHub | Không tự deploy khi push. 2 project Vercel **không nối Git** |
| Tên miền | `awakenthelions.net`, DNS tại **Mắt Bão** | AIM | `app.` → Vercel web, `pg.` → Vercel pg, 4 bản ghi email dưới `mail.` (PDF `ATL2026-Huong-dan-DNS-MatBao.pdf`). Tên miền cũ `atl.aimacademy.vn` **đã mất DNS** — đừng dùng trong thư |
| Email | Resend, gửi từ `mail.awakenthelions.net`, trả lời về `competition@aimacademy.vn` | Tài khoản Resend — cần kiểm lại chủ sở hữu | Subdomain gửi thư không có bản ghi MX (cố ý); thư trả lời đi về địa chỉ trong `packages/brand/src/index.js` |

Kiểm nhanh hệ thống còn sống, không cần quyền gì: mở `https://app.awakenthelions.net/api/refdata` phải ra JSON có
mảng `events`.

### 3.2 Biến môi trường và secrets

Bảng đầy đủ (tên, project, ý nghĩa, cách tạo giá trị mới, đổi xong phải làm gì): **Phụ lục C**. Những điều cần biết:

- Giá trị thật chỉ nằm trong **Vercel → project → Settings → Environment Variables**, đặt kiểu *Sensitive* (không xem
  lại hay sao chép ra được) và trong **GitHub → Settings → Secrets and variables → Actions**. Không có trong git,
  không có trong database. Lịch sử git đã được quét ngày 20/11/2026: không có khoá thật nào.
- **Vercel đóng băng biến lúc build.** Sửa biến xong phải deploy lại app đó thì bản đang chạy mới thấy. Biến
  `NEXT_PUBLIC_*` còn được nhúng thẳng vào mã chạy trên trình duyệt.
- App PG cần **`NEXT_PUBLIC_ATL_HMAC_KEY` có giá trị y hệt `ATL_HMAC_KEY` của app web**. Thiếu biến này, app PG lặng lẽ
  dùng khoá dev và báo sai **mọi** mã QR thật. (PDF Setup có biến này, nhưng danh sách trong `DOC-TRUOC.txt` ngày 20/11 bỏ sót —
  đã kiểm trong `apps/pg/src/app/quet/page.js`, `qua/page.js`, `suat/page.js`.)
- **`ATL_ACCESS_KEY`** (chỉ project web, từ 26/11): khoá ký mã truy cập SV — mở điểm, thẻ tham dự, khảo sát của một
  sinh viên. **Phải khác** `ATL_HMAC_KEY` (code từ chối chạy nếu trùng) và **không bao giờ** đặt vào project pg hay một
  biến `NEXT_PUBLIC_*`. Production thiếu biến này thì đăng ký, `/toi` và outbox dừng hẳn, không ký bằng khoá dev.
- Tổ chức tiếp nhận nên lưu bản sao các giá trị trong trình quản lý mật khẩu của tổ chức ngay khi tạo.

Secrets của GitHub Actions (cho workflow deploy):

| Secret | Lấy ở đâu | Dạng đúng |
|---|---|---|
| `VERCEL_TOKEN` | Vercel → ảnh đại diện → Account Settings → Tokens → Create (scope: team chứa 2 project) | Chuỗi token. Tài liệu dựng đặt hạn 90 ngày — token tạo đầu 09/2026 có thể đã hoặc sắp hết hạn, cần kiểm lại |
| `VERCEL_ORG_ID` | Vercel → Settings của team → General → Team ID | Bắt đầu bằng `team_` (không phải slug hay tên team) |
| `VERCEL_PROJECT_ID_WEB` | Project web → Settings → General → Project ID | Bắt đầu bằng `prj_` |
| `VERCEL_PROJECT_ID_PG` | Project pg → Settings → General → Project ID | Bắt đầu bằng `prj_` |

### 3.3 Khoá ký mã QR (`ATL_HMAC_KEY`) — đổi thì sao

Toàn bộ hệ thống dùng **một khoá cho mọi sự kiện** trong cùng một lần dựng (cột `events.token_key_id` chỉ là nhãn,
code không dùng nó để chọn khoá). Khi đổi khoá:

1. **Mọi mã QR đã phát không còn hợp lệ:** ảnh QR trong thư cũ, mã QR lưu trong `/toi` trên điện thoại SV. Máy PG báo
   mã sai. Link riêng `/toi#t=…` (mã truy cập SV, khoá khác) vẫn mở được và trả về mã QR **mới** — SV mở lại link là xong.
2. **Dữ liệu không mất:** badge, quà, đăng ký đều nằm trong database, không phụ thuộc khoá.
3. PG vẫn tra tay được bằng tên, SĐT, MSSV hoặc mã 6 ký tự.
4. Thư gửi **sau** khi đổi sẽ mang mã QR mới (mã được ký lúc gửi).
5. Phải đổi **cùng lúc** `ATL_HMAC_KEY` (web) và `NEXT_PUBLIC_ATL_HMAC_KEY` (pg) rồi deploy lại **cả hai**. Lệch nhau một
   phút là máy PG từ chối SV thật.

Khi nào nên đổi: dựng cho khách hàng / mùa mới (`docs/FORK-PLAYBOOK.md` bắt buộc khoá mới để mã QR hai chiến dịch không
dùng lẫn được), hoặc khi nghi lộ khoá (xem mục 9). **Không đổi giữa lúc SV đang cầm mã cho một sự kiện sắp diễn ra.**

**Đổi `ATL_ACCESS_KEY`** (khoá mã truy cập SV, chỉ ở web): mã QR **không** đổi, máy PG quét bình thường. Mất hiệu lực là
link riêng trong mọi thư đã gửi và phần điểm / khảo sát trên thẻ đã lưu ở điện thoại SV (`/toi` báo "lấy lại mã"). SV lấy
lại bằng `/dang-ky` (điền lại đúng email hoặc SĐT) hoặc thư gửi sau khi đổi. Chỉ deploy lại web. Đổi khi nghi lộ khoá này.

### 3.4 Mật khẩu database — không ai còn giữ

`DATABASE_URL` trên Vercel là biến Sensitive, không đọc lại được, và không ai nhớ mật khẩu. Hệ thống vẫn chạy bình thường;
chỉ vướng khi cần kết nối trực tiếp (sao lưu bằng `scripts/backup-db.mjs`, chuyển dữ liệu). Muốn lấy lại quyền:

1. Chọn thời điểm **không có sinh viên dùng**, xa ngày sự kiện. Từ lúc đặt lại đến lúc deploy xong, cả hai app mất kết nối
   database.
2. Supabase → project → Project Settings → Database → **Reset database password**. Đặt chuỗi dài **chỉ gồm chữ và số**
   (ký tự `@ # / ? : &` làm hỏng chuỗi kết nối). Lưu ngay vào trình quản lý mật khẩu.
3. Lấy chuỗi kết nối: nút **Connect** của project → mục **Transaction pooler** → URI. Chuỗi đúng có `:6543`, có
   `pooler.supabase.com`, không còn chữ `[YOUR-PASSWORD]`.
4. Sửa `DATABASE_URL` ở **cả hai** project Vercel.
5. Deploy lại **cả hai** app ở production (mục 8.3).
6. Kiểm: `/api/refdata` trả 200, đăng nhập `/admin` thấy số liệu, một máy PG đồng bộ được.

Đừng bấm *Reset database password* khi chưa sẵn sàng làm đủ bước 4–5.

### 3.5 Chuyển quyền sở hữu

**Lựa chọn 1 — chuyển nguyên hệ thống đang chạy** sang tài khoản của AIM / TCM (giữ dữ liệu, giữ địa chỉ):

1. GitHub: chuyển kho (Settings → Transfer) hoặc đẩy bản `.bundle` lên kho mới (mục 4.2), rồi tạo lại 4 secret.
2. Supabase: chuyển project sang tổ chức của bên nhận (Supabase có chức năng chuyển project giữa các tổ chức — cần kiểm lại
   điều kiện hiện hành), nâng gói nếu cần.
3. Vercel: chuyển 2 project sang team của bên nhận (cần kiểm lại chức năng chuyển project của Vercel), sau đó tạo
   `VERCEL_TOKEN` mới thuộc team mới, cập nhật `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID_*`. Biến môi trường kiểu Sensitive có đi
   theo project khi chuyển hay không — cần kiểm lại; nếu không thì phải tạo lại giá trị, kéo theo các bước ở mục 3.3 và 3.4.
4. Resend: thêm tên miền gửi vào tài khoản Resend của bên nhận (bản ghi DNS sẽ khác), tạo `RESEND_API_KEY` mới,
   deploy lại web.
5. Đặt lại mật khẩu database (mục 3.4) để bên nhận có quyền trực tiếp.

**Lựa chọn 2 — dựng mới hoàn toàn** trên tài khoản bên nhận (mục 4). Dữ liệu ba sự kiện đã có trong gói dữ liệu ngày
26/11; nếu không cần sinh viên cũ dùng lại hồ sơ thì không cần chuyển database. Sau khi bản mới chạy ổn, xin chủ dự án
tắt hệ thống cũ và xoá dữ liệu cũ theo thoả thuận với AIM.

---

# Phần III — Làm việc với hệ thống

## 4. Dựng lại từ đầu trên tài khoản mới

Tài liệu bấm-chuột chi tiết (viết 27/08/2026): PDF `ATL2026-Setup-Supabase-Vercel.pdf`. **Ba điểm trong PDF đó đã cũ**:
số migration (nay 16, file init 4.140 dòng), số test (nay 506), và bước B3 bảo xoá trống *Root Directory* — **sai**, xem 4.4.

### 4.1 Lấy mã nguồn và chạy trên máy

Cần Node.js 22 (bản CI dùng; đã chạy được trên Node 24). `package.json` ghi `>=20`, nhưng lệnh test dùng mẫu đường dẫn
có dấu `*`; trên Windows với Node 20 mẫu này có thể không được mở rộng — cần kiểm lại nếu buộc dùng Node 20.

```bash
# Cách 1: từ file .bundle (có lịch sử git)
git clone ATL2026-git-day-du-2026-11-20.bundle ATL2026
# Cách 2: giải nén file .zip vào thư mục ATL2026

cd ATL2026
npm ci                    # cài thư viện theo đúng package-lock.json
npm test                  # 506 test, khoảng 2 phút, tất cả phải xanh
npm run dev --workspace @atl/web               # app SV + admin: http://localhost:3000
npm run dev --workspace @atl/pg -- -p 3001     # app PG:        http://localhost:3001
```

Ở môi trường dev, không đặt `DATABASE_URL` thì mỗi app tự dựng một database PGlite trong bộ nhớ, có dữ liệu mẫu:
2 sự kiện, 24 trường, 34 tỉnh, 5 sinh viên mẫu (`seq` 1001–1005) để quét thử, máy PG mẫu mã `K7M3QX`.
Mã truy cập `/admin` ở dev là `dev-admin`. **Hai app dev không dùng chung dữ liệu** — SV đăng ký bên web không hiện bên PG.
Muốn chạy xuyên app thì trỏ cả hai vào cùng một `DATABASE_URL` (database thử, không phải production).

### 4.2 Đưa mã lên kho GitHub mới

```bash
cd ATL2026
# Nếu lấy từ .bundle: origin đang trỏ vào file .bundle, gỡ đi
git remote remove origin
# Nếu giải nén từ .zip mà không có thư mục .git: tạo kho mới (mất lịch sử)
#   git init -b main && git add -A && git commit -m "Mã nguồn ATL2026"
git remote add origin https://github.com/<to-chuc>/<ten-kho>.git
git push -u origin main
git push origin --tags
```

Kho nên để **riêng tư**. Workflow `CI` tự chạy test và build mỗi lần push; workflow deploy chỉ chạy khi có người bấm.

### 4.3 Supabase

1. Tạo project mới, vùng **Southeast Asia (Singapore) — ap-southeast-1** (sai vùng là chậm thêm ~250 ms mỗi lần gọi từ
   Việt Nam). Mật khẩu database: chỉ chữ và số, lưu ngay.
2. *(Khuyên làm)* Sửa dữ liệu nền trước khi sinh file SQL:
   - sự kiện đầu tiên và tên mùa: khối `seed` trong `scripts/build-production-sql.mjs` (đang là Hà Nội / TP.HCM 12/09/2026);
   - danh sách trường `SCHOOLS`, tỉnh `PROVINCES`: `packages/db/src/seed-dev.js` (dùng chung cho dev).

   Rồi ở thư mục gốc: `node scripts/build-production-sql.mjs` và `npm test`.
3. Supabase → **SQL Editor** → New query → dán toàn bộ `supabase/production-init.sql` → bấm nút **Run**.
   Kết quả "Success. No rows returned" là **thành công**. Kiểm: `select count(*) from pg_tables where schemaname='public';` → **24**.
   Nếu hỏng giữa chừng trên database **mới, chưa có gì**: chạy
   `drop schema public cascade; create schema public; grant all on schema public to postgres, public;` rồi dán lại.
   Tuyệt đối không làm vậy trên database có dữ liệu.
4. New query → dán `supabase/production-seed.sql` → Run. Kiểm: `select id, name, is_registration_open from events;`
   (sự kiện ở trạng thái `false`), `select count(*) from ref_schools;`, `select count(*) from ref_provinces;`.
   Không seed khu vực, điểm quét, bậc quà, suất, PG — tạo trong `/admin`.
   Nếu bỏ qua bước 2, tạo sự kiện bằng SQL thay cho seed (Phụ lục B, mục "Tạo sự kiện đầu tiên").
5. Lấy `DATABASE_URL` như mục 3.4 bước 3 (Transaction pooler, cổng 6543).
6. Không cần bật thêm gì cho app chạy (app chỉ truy cập qua server bằng chuỗi kết nối, không dùng khoá `anon` của Supabase).
   `production-init.sql` đã gồm 0017: bật RLS mọi bảng và thu quyền `anon` / `authenticated` (mục 9). Kiểm:
   `select relname from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r','p') and not relrowsecurity;`
   → không dòng nào.

### 4.4 Vercel

1. Tạo team, bật gói Pro (mục 1.4).
2. **Add New → Project → Import** kho GitHub → Project Name `atl2026-web` (tên tuỳ ý) → **Root Directory: `apps/web`** → Deploy.
   Lần build này có thể báo đỏ vì chưa có biến môi trường — bình thường.
3. Ngay sau đó: project → Settings → **Git → Disconnect** (ngắt Git). Nếu không ngắt, Vercel tự deploy mỗi lần push,
   bất kể workflow (cách khác: tắt "Automatic deployments from Git"). **Giữ nguyên Root Directory = `apps/web`**: workflow
   deploy chạy Vercel CLI từ thư mục gốc kho và dựa vào thiết lập này để biết build app nào (ghi chú trong
   `.github/workflows/deploy.yml`, commit `fce2536` ngày 04/09/2026 — PDF cũ bảo xoá trống là sai).
4. Lặp lại bước 2–3 cho app PG: tên `atl2026-pg`, **Root Directory: `apps/pg`**.
5. Vùng chạy đã ghim trong `apps/web/vercel.json` và `apps/pg/vercel.json` (`sin1`); cron gửi thư khai trong
   `apps/web/vercel.json`. Cron của Vercel chỉ chạy trên bản **production**.
6. Tạo giá trị bí mật (mỗi lệnh chạy một lần, ra 64 ký tự chữ và số):

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   Cần 4 giá trị, **mỗi cái một lần chạy lệnh**: `ATL_HMAC_KEY`, `ATL_ACCESS_KEY`, `ADMIN_ACCESS_KEY`, `CRON_SECRET`.
7. Khai biến môi trường theo **Phụ lục C**: project web 8 biến, project pg 2 biến. Áp cho Production và Preview.
   Lưu ý: nếu Preview dùng cùng `DATABASE_URL` với Production thì **mọi thao tác thử trên bản preview ghi thẳng vào
   database thật**. Muốn thử an toàn, đặt `DATABASE_URL` của Preview trỏ một project Supabase thử.
   `RESEND_API_KEY` có thể thêm sau (mục 4.7) — thiếu nó thư chỉ nằm chờ, không bị đánh hỏng.

### 4.5 GitHub Actions secrets

GitHub → kho → Settings → Secrets and variables → Actions → New repository secret, tạo 4 secret ở bảng mục 3.2.
Workflow tự kiểm dạng (`team_…`, `prj_…`), tự cắt ký tự thừa (xuống dòng vô hình khi dán), và in ra danh sách project
mà token nhìn thấy để chẩn đoán.

### 4.6 Deploy lần đầu (bản preview)

GitHub → tab **Actions** → **Deploy (manual only)** → **Run workflow**, điền:

| Ô | Giá trị |
|---|---|
| `app` | `web` (lần sau: `pg`) |
| `target` | `preview` |
| `confirm` | để trống (chỉ production mới cần) |
| `reason` | bắt buộc, ví dụ `dung lai lan dau` |

Hoặc bằng GitHub CLI:

```bash
gh workflow run deploy.yml -f app=web -f target=preview -f reason="dung lai lan dau"
gh run list --workflow=deploy.yml --limit 5
```

Workflow chạy 3 bước: kiểm xác nhận → **`npm ci` + `npm test` (đỏ là dừng)** → `vercel pull` / `vercel build` /
`vercel deploy --prebuilt` → kiểm sống (`GET /api/refdata` với web, `GET /` với pg, phải trả 200). Link bản deploy
ghi ở phần Summary của lượt chạy.

### 4.7 Tên miền, Resend và DNS

1. Vercel → project web → Settings → Domains → thêm `app.<tên-miền>`; project pg → thêm `pg.<tên-miền>`. Vercel đưa ra
   giá trị CNAME **riêng cho từng project** — chép đúng chuỗi đó.
2. Resend → thêm domain **`mail.<tên-miền>`** (luôn gửi từ subdomain riêng, không bao giờ từ tên miền chính của tổ chức).
   Resend đưa ra các bản ghi cần thêm; đợt 2026 là 2 CNAME (`send.mail`, `rsend.mail`) và 2 TXT (`resend._domainkey.mail`,
   `_dmarc.mail` với `v=DMARC1; p=none;`), không có MX, không đụng SPF của tên miền chính. Làm theo đúng bản ghi Resend
   hiển thị; PDF `ATL2026-Huong-dan-DNS-MatBao.pdf` là mẫu phiếu gửi nhà quản lý DNS (lỗi hay gặp: thiếu đuôi `.mail` ở ô Host).
3. Thêm 6 bản ghi ở nhà quản lý DNS (TTL 3600). Chờ lan truyền (2 giờ đến 24 giờ, có khi tới 72 giờ). Kiểm bằng dnschecker.org.
4. Resend báo **Verified** → tạo API key quyền *Sending* → khai `RESEND_API_KEY`, `EMAIL_FROM`
   (dạng `Tên hiển thị <noreply@mail.<tên-miền>>`), `NEXT_PUBLIC_SITE_URL` (`https://app.<tên-miền>`) ở project web → deploy lại web.
5. **Nuôi uy tín gửi thư:** gửi thử tăng dần tới vài hộp Gmail / Outlook trong vài ngày trước khi mở đăng ký đại trà.
   Đợt 05/09/2026 xác thực SPF / DKIM / DMARC đều đạt nhưng Microsoft 365 vẫn xếp thư vào Junk lúc đầu
   (`docs/ATL2026-Production-Spec.md` mục 4.2b).

### 4.8 Deploy production và nghiệm thu

1. Chạy workflow với `target = production`, `confirm = DEPLOY` (gõ đúng chữ in hoa), cho cả `web` và `pg`:
   `gh workflow run deploy.yml -f app=web -f target=production -f confirm=DEPLOY -f reason="go-live"`.
2. Nghiệm thu (theo PDF Setup, bước B9):
   - `https://app.<tên-miền>/dang-ky` hiện form; thử gửi → báo "Đăng ký online đã tạm đóng…" (đúng: sự kiện sinh ra đã đóng).
   - `/admin` → nhập `ADMIN_ACCESS_KEY` + tên → thấy 7 tab.
   - Tab Hoạt động → thêm một điểm quét loại *Cổng vào*.
   - Tab Vận hành → tạo một máy → nhận mã 6 ký tự.
   - Mở `https://pg.<tên-miền>` trên điện thoại thật → nhập mã + PIN → màn quét mở được camera, quét thử được mã QR của
     một đăng ký thử (kiểm `NEXT_PUBLIC_ATL_HMAC_KEY` khớp).
   - Vercel → project web → Cron Jobs: thấy `/api/cron/outbox` lịch mỗi phút.
   - Mở đăng ký (mục 5.9), đăng ký bằng email nội bộ → nhận được thư có mã QR; `/toi` hiện điểm (mã truy cập SV chạy);
     bấm link riêng trong thư trên máy khác → mở được thẻ.
   - Mở `https://app.<tên-miền>/api/cron/outbox` trên trình duyệt (không header) → phải ra `401 unauthorized`.
     Ra `503 cron_secret_missing` = thiếu `CRON_SECRET` trên project web, thư sẽ không đi.

### 4.9 Kiểm tra tranh chấp trên hạ tầng thật (khuyên làm trước sự kiện lớn)

Bộ test thường chạy trên PGlite một kết nối nên chứng minh **logic** đúng, chưa chứng minh **khoá** đúng khi nhiều kết nối.
Bảy bài T1–T7 (`scripts/concurrency.mjs`) và các bài tải ghi chỉ được chạy trên **project Supabase thử**, vì sổ cái không
xoá được:

1. Tạo project Supabase thử, dán `production-init.sql`, rồi chạy trong SQL Editor của project thử:
   `create table concurrency_sandbox (note text);` (script từ chối chạy nếu không thấy bảng này).
2. Tạo file `.env.local` ở thư mục gốc với `DATABASE_URL` của project thử. (File `.env.local` cũ trên máy chủ dự án trỏ vào
   một project đã không còn — đừng dùng.)
3. `npm run test:concurrency`, `npm run test:write-load`, `npm run test:register-load`, `npm run test:failover`.

Kết quả các lần chạy năm 2026: `docs/ATL2026-Production-Spec.md` mục 4.2–4.4.

---

## 5. Chạy một sự kiện mới trên hệ thống đang có (runbook)

Rút từ kinh nghiệm đợt UEF (17/11/2026). Ví dụ dưới dùng **sự kiện mới số 5** — thay bằng số thật (số sự kiện mới
= số lớn nhất hiện có + 1; hiện có 1–4).

### 5.1 Lịch lùi

| Thời điểm | Việc | Mục |
|---|---|---|
| T−14 ngày | Kiểm hạ tầng còn sống; chốt với khách: gian hàng, giờ, trọng số badge, bậc quà và kho, suất đặc biệt, nội dung thư | 5.2 |
| T−10 | Nhân bản sự kiện, sửa giờ, cấu hình trong admin, đặt chữ thư | 5.3–5.6 |
| T−8 | Sửa `FALLBACK_EVENTS`, deploy web | 5.7 |
| T−7 | Khoá sự kiện cũ; mở đăng ký; xoá cache CDN; tự đăng ký thử | 5.8–5.9 |
| T−3 đến T−1 | Tạo PG và máy, briefing từng máy; xếp thư nhắc | 5.10–5.11 |
| Ngày sự kiện | Kiểm sáng sớm, trực suốt ngày | 5.12 |
| T+1 | Đối soát, xuất dữ liệu, thu hồi máy, khoá sự kiện | 5.13, 6 |

### 5.2 Kiểm hạ tầng còn sống

- `https://app.awakenthelions.net/api/refdata` trả JSON; `/admin` đăng nhập được.
- Supabase project không bị tạm dừng (gói Free — cần kiểm lại trạng thái trên trang Supabase).
- Chạy thử workflow deploy với `target = preview` để chắc `VERCEL_TOKEN` còn hạn (lỗi ở bước "Pull Vercel environment"
  thường là token hết hạn → tạo token mới, cập nhật secret).
- Resend: domain gửi vẫn Verified.
- Lần deploy gần nhất có thể báo CI đỏ vì bước build tải font Google lỗi mạng tạm thời — bấm *Re-run*.

### 5.3 Nhân bản sự kiện

`/admin` → chọn **sự kiện nguồn** ở ô chọn sự kiện (nên chọn sự kiện gần giống nhất, ví dụ UEF số 4 — **làm trước khi khoá nó**,
vì sự kiện đã khoá biến khỏi ô chọn) → tab **Cấu hình** → khối **Nhân bản sự kiện** → điền slug (chỉ `a-z`, `0-9`, `-`),
tên, địa điểm, thành phố, ngày → **Nhân bản**.

`clone_event` (migration 0009) làm gì:

| Được chép | Không chép |
|---|---|
| Khu vực, điểm quét (giờ dời theo chênh lệch ngày bắt đầu), bậc quà, hoạt động đặc biệt, ngưỡng `y` / `z`, chế độ thang quà, ngân sách Giờ Vàng, nhãn khoá | Sinh viên, đăng ký, badge, quà đã phát, bộ đếm kho (về 0), Giờ Vàng, giờ Early Bird, **nhân sự PG và máy quét**, **chữ thư `email_copy`** (sự kiện mới là `NULL`) |

Sự kiện mới sinh ra **đóng đăng ký**, chưa khoá.

### 5.4 Sửa giờ, tên, địa điểm (SQL)

Form nhân bản **đặt cứng giờ 08:00–17:00 (+07)**. Giờ thật khác thì sửa trong Supabase SQL Editor (giờ ghi kèm `+07`):

```sql
update events
   set starts_at = '2027-03-20 08:00+07',
       ends_at   = '2027-03-20 17:30+07'
 where id = 5;

select id, slug, name, venue_name, city, starts_at, ends_at,
       is_registration_open, is_archived, email_copy is not null as co_thu_rieng
  from events order by id;
```

Ngày giờ này hiện trên form đăng ký, trang chủ, trang lịch, và là giờ mặc định trong thư. Sau khi sửa, vào tab **Hoạt động**
kiểm lại giờ từng điểm quét (đã dời theo ngày, không theo giờ).

### 5.5 Cấu hình trong trang quản trị

Theo PDF `ATL2026-Huong-dan-Admin.pdf` và `ATL2026-Huong-dan-Tao-May-PG.pdf`:

1. **Hoạt động:** sửa tên, giờ, vị trí, trọng số badge (1–9). Điểm không dùng thì bấm **Tắt** (không có nút xoá — điểm có lịch sử
   không được biến mất). Cổng chỉ điểm danh thì bấm **Ngừng tính badge**, không đặt trọng số 0. Phải có một điểm loại **Quầy đổi quà**.
2. **Cấu hình:** từng bậc quà — tên (mỗi bậc đúng **một** món cộng thêm), ngưỡng, kho; kho 0 hiện "ĐÃ HẾT QUÀ". Thang quà phải là
   **Cộng dồn** (chữ đỏ "Bậc cao nhất — SAI quy định" thì bấm *Đặt lại Cộng dồn*). Đặt `y`, `z`. Không thêm bậc giữa ngày.
3. **Vận hành:** hoạt động đặc biệt (số suất = số ghế; hai hoạt động dùng chung một phòng thì chỉ mở **một** dòng);
   Early Bird để trống nếu không dùng.
4. **Khảo sát** nếu gian hàng cần.

Tab Tổng quan có chuông cảnh báo nếu tổng badge còn kiếm được thấp hơn ngưỡng `y`. Khu vực và Giờ Vàng đang ẩn
(`SHOW_ZONE_TOOLS = false`); cần dùng thì đổi thành `true` trong `apps/web/src/app/admin/page.js` và deploy lại web.

### 5.6 Đặt chữ thư riêng cho sự kiện (`events.email_copy`)

**Bắt buộc với mọi sự kiện mới, và phải xong trước khi mở đăng ký.** Không có `email_copy` thì hệ thống dùng mẫu cũ viết cứng
"Awaken The Lions 2026", giờ "8h00–17h00", dòng Early Bird 8h45 — sai cho sự kiện khác. Mẫu được chọn lúc gửi, nên thư nào gửi
trước khi đặt sẽ mang chữ cũ.

Các trường (chi tiết: chú thích hàm `parseEmailCopy` trong `packages/email/src/index.js`; ví dụ đầy đủ của UEF:
`packages/email/test/fixtures/discovery-day-1711.json`). Mọi trường là chữ thường, không HTML. `*` = bắt buộc.

| Trường | Hiện ở đâu |
|---|---|
| `event_title`* | "Cảm ơn bạn đã đăng ký tham gia **{event_title}**!" và dòng nhỏ đầu thư |
| `short_title` | Mở đầu thư nhắc "**{short_title}** sẽ chính thức bắt đầu." (vắng → `event_title`) |
| `subjects.confirm`*, `subjects.morning`* | Tiêu đề thư xác nhận / thư nhắc sáng ngày sự kiện, nguyên văn |
| `support_place`* | "…liên hệ Ban Tổ chức tại **{support_place}**." |
| `venue_line`* | Dòng "Địa điểm:" của thư nhắc |
| `time_line` | Dòng "Thời gian:" (vắng → dựng từ giờ sự kiện, dạng "8h - 17h30, thứ ba, 17.11.2026") |
| `booth_opens` | Dòng "Booth hoạt động từ:" (vắng → không in) |
| `see_you`* | Câu hẹn gặp, nguyên văn |
| `organizer` | Chữ ký "Ban tổ chức **{organizer}**." (vắng → `event_title`) |
| `signature_image_url` | Ảnh chữ ký, phải `https://` (Gmail chặn ảnh từ xa mặc định) |
| `signature_image_width` | Số nguyên 40–504 (px) |

```sql
update events set email_copy = '{
  "event_title": "<Tên sự kiện>",
  "short_title": "<Tên ngắn>",
  "subjects": {
    "confirm": "<Tiêu đề thư xác nhận>",
    "morning": "<Tiêu đề thư nhắc sáng ngày sự kiện>"
  },
  "support_place": "<Nơi hỗ trợ>",
  "venue_line": "<Địa điểm>",
  "time_line": null,
  "booth_opens": "7h45",
  "see_you": "<Câu hẹn gặp>",
  "organizer": "<Tên Ban tổ chức>",
  "signature_image_url": null
}'::jsonb
 where id = 5;
```

Thiếu trường bắt buộc thì database **từ chối ngay** (ràng buộc `events_email_copy_valid`) — câu lệnh báo lỗi, không có gì
được ghi. Mẫu AIM có đúng hai thư: xác nhận (`confirm`) và nhắc sáng ngày sự kiện (`morning`). Phần chữ chung (đoạn QR Code /
badge / Quầy Quà Trung Tâm, câu "Lưu ý", nút "Xem điểm và mã QR của bạn") viết trong code — muốn đổi xem mục 7.

### 5.7 Sửa danh sách sự kiện dự phòng (`FALLBACK_EVENTS`) và deploy web

Khi điện thoại SV không tải được `/api/refdata` (mạng yếu), form dùng danh sách viết cứng trong
`apps/web/src/lib/event-choices.js`. Hiện là UEF (số 4). Sửa thành sự kiện mới:

```js
export const FALLBACK_EVENTS = [
  { id: 5, city: '<Thành phố>', name: '<Tên sự kiện>', venue_name: '<Địa điểm>' },
];
```

Chỉ liệt kê sự kiện **đang nhận đăng ký**. Test `apps/web/test/event-choices.test.js` không cho phép id 1 và 2. Chạy `npm test`,
commit, push, rồi deploy **web** ở production (mục 8.3). App PG không cần deploy lại cho sự kiện mới.

### 5.8 Khoá sự kiện cũ

Làm **sau** khi đã nhân bản (5.3) và đã xuất xong dữ liệu sự kiện cũ (mục 6) — sự kiện đã khoá biến khỏi ô chọn của admin,
không xuất Excel được nữa trong giao diện.

1. Admin, chọn sự kiện cũ → tab Vận hành → **Đóng đăng ký**; **Thu hồi** từng máy PG của sự kiện đó (có ghi nhật ký).
   Cách nhanh bằng SQL (không ghi nhật ký thao tác):

   ```sql
   update pg_devices set revoked_at = now(), token_hash = null
    where event_id = 4 and revoked_at is null;
   ```

2. Khoá:

   ```sql
   update events set is_registration_open = false, is_archived = true where id = 4;
   ```

Sự kiện đã khoá: ẩn khỏi form đăng ký (kể cả tại cổng), ô chọn của admin, trang lịch; `/api/register` từ chối;
`queue_event_reminders` từ chối. Muốn mở lại: `update events set is_archived = false where id = 4;`.
Tại ngày bàn giao, **UEF (số 4) chưa khoá** — dữ liệu đã xuất ngày 26/11, có thể khoá khi bắt đầu chuẩn bị sự kiện mới.

### 5.9 Mở đăng ký, xoá cache CDN, tự thử

1. Admin, chọn sự kiện mới → tab Vận hành → **Mở đăng ký**. Database chặn / mở cổng ngay lập tức.
2. **Xoá cache CDN của project web.** `/api/refdata` trả `Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400`:
   CDN giữ bản cũ tới **1 giờ** và có thể trả bản cũ thêm một lượt trong lúc làm mới. Không xoá cache thì form có thể vẫn hiện
   "Đăng ký online đã tạm đóng", hoặc vẫn hiện sự kiện vừa khoá. Cách làm: Vercel → project web → Settings → mục cache
   (*Caches* / *CDN Cache*) → **Purge** — tên mục có thể khác theo giao diện Vercel, cần kiểm lại; hoặc deploy lại app web
   (bản deploy mới không dùng cache của bản cũ — cần kiểm lại).
3. Kiểm: mở `https://app.awakenthelions.net/api/refdata` → mảng `events` có sự kiện mới với `"is_registration_open": true`,
   không còn sự kiện vừa khoá.
4. **Làm lại bước 2–3 sau mỗi lần** đổi thứ form đọc: mở / đóng đăng ký, khoá, tên, ngày giờ, danh sách trường.
5. Tự đăng ký bằng email nội bộ → nhận thư đúng mẫu mới, mã QR mở được, link "Xem điểm" mở đúng `/toi`.

### 5.10 Nhân sự PG và máy quét

Theo PDF `ATL2026-Huong-dan-Tao-May-PG.pdf`, `ATL2026-So-tay-May-quet-PG.pdf`:

1. Admin, đúng sự kiện mới → tab Vận hành → **Thêm PG** (tên, vai trò PG / Giám sát) → **Tạo máy** (nhãn `PG-01`…) → nhận mã 6 ký tự.
2. Cột **Đang quét điểm**: chọn điểm PG sẽ đứng (máy tự vào điểm đó). Máy ở Quầy đổi quà → chọn điểm Quầy đổi quà.
   Máy trước hội trường → cột **Vai trò** = Quầy vé hội trường. Đổi ô này giữa ngày thì ~20 giây sau máy tự nhận.
3. In thẻ cho từng PG; **không** gửi mã qua nhóm chat chung. Tạo dư 2–3 máy mỗi điểm. Phát máy trước ít nhất một ngày,
   nơi có wifi tốt (máy tải danh sách SV về để quét offline).
4. PG đã dùng điện thoại ở sự kiện trước: máy cũ bị thu hồi sẽ hiện màn "BTC đã thu hồi mã" → bấm **NHẬN MÃ MÁY MỚI** (xoá sạch
   dữ liệu cũ trên máy) → nhập mã mới.
5. **Briefing 7 bước, đỗ / trượt từng máy** (`README.md`): mở bằng Chrome / Safari, không phải webview Zalo · thêm vào màn hình
   chính **trước**, mở app, **rồi mới** nhập mã (iPhone làm ngược là phải nhận lại) · cấp quyền camera · tải xong danh sách
   (chip đồng bộ xanh) · quét thử 5 lượt có 1 lượt trùng (màn hổ phách) · tra tay 1 lần bằng tên · bật chế độ máy bay quét 2 lượt,
   tắt đi, xác nhận hàng đợi tự đẩy. Máy chưa qua đủ 7 bước thì không ra trận.

### 5.11 Xếp thư nhắc buổi sáng

Thư nhắc **không tự xếp** — phải chạy tay. Đợt UEF quên bước này nên không SV nào nhận thư nhắc.

```sql
-- Hẹn 06:00 sáng ngày sự kiện, giờ Việt Nam. Trả về số thư vừa xếp.
select queue_event_reminders(5::smallint, 'morning', '2027-03-20 06:00:00+07');

-- Theo dõi
select template, status, count(*) from notification_outbox
 where event_id = 5 group by 1, 2 order by 1, 2;

-- Lý do thư lỗi (không in địa chỉ)
select last_error, count(*) from notification_outbox
 where event_id = 5 and status = 'failed' group by 1;
```

- Hàm **chạy lại an toàn**: SV đã có thư nhắc (bất kể trạng thái) thì bỏ qua. Nên chạy một lần khi đăng ký online đóng hoặc
  tối hôm trước, rồi chạy lại sáng sớm cho người đăng ký muộn.
- Chỉ xếp cho SV đã đăng ký sự kiện đó và có email. Sự kiện có `email_copy` chỉ nhận mẫu `morning` (từ chối `reminder_d3`,
  `reminder_d1`). Sự kiện đã khoá: từ chối.
- Giờ hẹn đã qua thì thư gửi ngay. Tốc độ 40 thư/phút: 1.000 thư mất khoảng 25 phút — hẹn sớm cho kịp.
- Đã xếp rồi muốn đổi giờ: chạy lại không đổi gì; sửa `notification_outbox.scheduled_at` của các dòng `queued` bằng tay.

### 5.12 Ngày sự kiện

- Sáng sớm (06:00): `/api/refdata` trả 200; `pg.<tên-miền>` mở được; admin tab Tổng quan **Lệch bộ đếm = 0**; cột trạng thái máy
  PG không còn máy "chưa nhận".
- Có **một người trực kỹ thuật có tên cụ thể** suốt ngày, biết rollback trên Vercel (mục 8.3).
- **Không deploy app PG** trong ngày. App web chỉ sửa nóng khi đã test.
- Đăng ký tại cổng: poster mã QR dẫn tới `/dang-ky?nhanh` — chạy cả khi đăng ký online đã đóng.
- Sẵn sổ vé giấy đánh số cho hoạt động đặc biệt và quà, phòng mất mạng.
- Tình huống thường gặp và cách xử lý: PDF *Hướng dẫn Admin* mục 10.

### 5.13 Sau sự kiện

1. **Xả hàng đợi** của mọi máy PG (tab Đối soát cảnh báo máy nào còn lượt kẹt) — mở app trên máy đó, chờ đồng bộ.
2. Tab **Đối soát**: nhập vé giấy / quà phát tay. Bản ghi trùng hoặc vượt kho bị từ chối kèm lý do.
3. Tab Vận hành: **Đóng đăng ký**.
4. Xuất **Excel nội bộ** (nút ⬇ Excel) và **Excel NTT** cho từng gian hàng (tab Hoạt động). Thống nhất với Ban tổ chức trước
   khi gửi file NTT ra ngoài.
5. Xuất **toàn bộ dữ liệu** (mục 6), cất ngoài kho mã.
6. **Thu hồi mọi máy PG**; nhắc PG mở app bấm *NHẬN MÃ MÁY MỚI* hoặc xoá dữ liệu trang web để xoá danh sách SV khỏi điện thoại.
7. **Khoá sự kiện** (mục 5.8) và xoá cache CDN (mục 5.9).
8. Đánh tag git `campaign/<slug>-final`. Cân nhắc hạ gói dịch vụ (dữ liệu cả mùa khoảng 75 MB, theo `docs/FORK-PLAYBOOK.md`).

---

## 6. Xuất và sao lưu dữ liệu

File xuất chứa họ tên, email, SĐT: **luôn ghi ra ngoài thư mục mã nguồn**, không commit, không để thư mục dùng chung.

### 6.1 Cách A — không cần mật khẩu database (đã dùng 20–26/11/2026)

Chỉ cần quyền vào Supabase SQL Editor. Mọi câu đều chỉ đọc.

1. Sinh câu SQL "gói gộp":

   ```bash
   node scripts/export-bundle-sql.mjs "<thư-mục-thô>"
   ```

   Ra `phan-1.sql` (3 bảng quét lớn) và `phan-2.sql` (21 bảng còn lại). Mỗi dòng kết quả = tối đa 500 dòng của một bảng, dạng JSON —
   tránh giới hạn hiển thị 100 dòng của SQL Editor.
2. Đếm số dòng để đối chiếu: chạy câu **"Đếm dòng 24 bảng"** ở Phụ lục B trong SQL Editor, sao chép ô kết quả (một chuỗi JSON)
   vào file `<thư-mục-thô>/_so-dong.json`. Thiếu file này script bước 4 dừng.
3. SQL Editor → dán `phan-1.sql` → bấm **Run** (Ctrl+Enter có thể không chạy) → **Export → Download CSV** (hoặc *Copy as CSV* rồi
   dán vào trình soạn thảo, lưu UTF-8) → lưu vào `<thư-mục-thô>`. Làm tương tự với `phan-2.sql`. Tên file tuỳ ý; dòng đầu phải là
   `bang,phan,du_lieu`. Ngày 20/11: phần 1 ra 33 dòng, phần 2 ra 35 dòng.
4. Dựng bộ CSV theo từng sự kiện:

   ```bash
   node scripts/export-event-csv.mjs "<thư-mục-thô>" "<thư-mục-ra>" --events=1,2,4
   ```

   Bỏ `--events` để xuất mọi sự kiện. Script dừng nếu bảng nào lệch số dòng so với `_so-dong.json`, thiếu bảng, hoặc cột khác
   lược đồ 0001–0016 (`--force` bỏ qua kiểm — không khuyên). Kết quả: mỗi sự kiện một thư mục gồm `00-tong-quan.csv` …
   `16-doi-thi.csv` (UTF-8 có BOM, mở thẳng bằng Excel) và một file `.xlsx` gộp; thêm `TONG-HOP-CAC-SU-KIEN.csv`.
   Script cố ý **không** xuất băm mã máy / PIN và nội dung thư (có link riêng của từng SV).
5. Đối chiếu `00-tong-quan.csv` với số trong admin (mục 1.2 cho ba sự kiện năm 2026).
6. Đóng gói. Trên Windows dùng `tar.exe -a -c -f <tên>.zip <thư-mục>` (lệnh `Compress-Archive` của PowerShell 5.1 ghi đường dẫn
   bằng dấu `\`, mở trên Mac bị hỏng). Lập `SHA256SUMS.txt`. Xoá clipboard nếu đã dùng *Copy as CSV*.

### 6.2 Cách B — sao lưu trực tiếp (cần mật khẩu database)

```bash
DATABASE_URL="<chuỗi-kết-nối>" node scripts/backup-db.mjs "<thư-mục-đích>"
```

(Trên PowerShell: `$env:DATABASE_URL = "<chuỗi-kết-nối>"; node scripts/backup-db.mjs "<thư-mục-đích>"`.)
Chạy trong một transaction chỉ đọc, mọi bảng cùng một thời điểm. Ra `data/<bảng>.ndjson` (bản gốc), `data/<bảng>.csv`,
`schema/*` (hàm, view, trigger, index…), `manifest.json` (số dòng, mã kiểm tra, commit git). Mặc định ghi vào
`../ATL2026-backups/<ngày_giờ>/`. Script **từ chối** chạy nếu chuỗi kết nối không phải project `qllxeocjtbgtsrzpolqr`; với
project khác thêm `--any`. Chưa từng chạy được vì không có mật khẩu (mục 3.4).

### 6.3 Cất giữ

- Mỗi bản xuất kèm `SHA256SUMS.txt`, ghi ngày xuất và commit mã nguồn.
- Cất ở nơi có phân quyền, mã hoá nếu được; gửi qua kênh riêng tư.
- Supabase gói Free: không trông vào sao lưu tự động của dịch vụ — cần kiểm lại chính sách hiện hành; tự xuất sau mỗi sự kiện.

---

## 7. Đổi thương hiệu, dùng cho khách hàng khác

### 7.1 Chiến lược đã chốt: mỗi khách hàng một bản sao (fork)

Không làm hệ thống dùng chung nhiều khách (multi-tenant). Mỗi khách = một bản sao kho mã + một database + một bộ tên miền.
Lý do và cái giá chấp nhận (bản vá bảo mật phải áp cho từng bản sao): `docs/FORK-PLAYBOOK.md`. Bản đồ "cái gì là cấu hình,
cái gì là luật":

- **Lớp A — cấu hình trong admin, không đụng code:** ngưỡng / kho bậc quà, `y` / `z`, điểm quét và cờ của nó, khu vực, hoạt động
  đặc biệt, PG và máy, mở / đóng đăng ký, Early Bird, khảo sát, Giờ Vàng, nhân bản sự kiện.
- **Lớp B — dữ liệu nền mỗi bản sao:** trường, tỉnh, sự kiện đầu tiên, chữ thư.
- **Lớp C — luật trong code / schema:** đủ N badge mở bậc quà; thang đặc biệt chỉ đếm cổng + gian hàng; Giờ Vàng chỉ thưởng gian hàng;
  một người một mã QR toàn chiến dịch (email / SĐT duy nhất); khảo sát tối đa 8 câu; hai ô đồng ý tách riêng (**pháp lý — không đổi**).
  Loại sự kiện chỉ có `discovery_day` / `grand_finale` (kiểu enum).

### 7.2 Những chỗ viết cứng cần sửa (đã dò trong code ngày 26/11/2026)

`FORK-PLAYBOOK` ghi "đổi thương hiệu: đúng 2 chỗ" (`packages/brand/src/index.js` + khối `BRAND KIT` trong CSS). Thực tế còn
nhiều chỗ khác:

| # | Nội dung viết cứng | File |
|---|---|---|
| 1 | Tên chiến dịch, tiêu đề trang, tên app quét, màu thư, địa chỉ trả lời thư `competition@aimacademy.vn` | `packages/brand/src/index.js` |
| 2 | Màu giao diện (khối `BRAND KIT — Awaken The Lions 2026`) | `apps/web/src/app/globals.css`; màu nhấn app PG: `apps/pg/src/app/globals.css`. Màu chữ trên nền sáng phải đạt chuẩn tương phản AA |
| 3 | Font Roboto / Roboto Slab (bắt buộc subset `vietnamese`), mô tả trang "Đăng ký tham gia Discovery Day…" | `apps/web/src/app/layout.js` |
| 4 | Tiêu đề "Discovery Day" trang chủ | `apps/web/src/app/page.js` |
| 5 | "Đăng ký Discovery Day", chữ dự phòng "Discovery Day" | `apps/web/src/app/dang-ky/page.js` |
| 6 | Câu đồng ý "Mình đồng ý để **AIM Academy** xử lý thông tin…" và ô đồng ý nhận thông tin nhà tài trợ | `apps/web/src/app/dang-ky/page.js` |
| 7 | Phiên bản văn bản đồng ý `'v1-2026-08'` (đổi câu chữ đồng ý thì đổi phiên bản); năm hiện tại `CURRENT_YEAR = 2026` (kiểm năm sinh 15–40 tuổi); định dạng SĐT Việt Nam | `apps/web/src/app/api/register/route.js` |
| 8 | Tiêu đề tab "Lịch hoạt động — Awaken The Lions 2026", "Lịch theo khu vực — …"; dòng nhỏ "Discovery Day" | `apps/web/src/app/lich/page.js`, `lich/khu-vuc/page.js`, `lich/agenda.js` |
| 9 | Mẫu thư cũ (khi `email_copy` NULL): "Awaken The Lions 2026", "AIM Academy · Đại diện chính thức Cannes Lions tại Việt Nam", "8h00–17h00", "Đến trước 8h45 được thêm 1 badge Early Bird" | `packages/email/src/index.js` (`renderConfirmEmail`, `renderReminderEmail`) |
| 10 | Chữ chung mẫu AIM: đoạn QR Code / badge / "Quầy Quà Trung Tâm", câu "Lưu ý", câu mở thư nhắc, nút "Xem điểm và mã QR của bạn" | `packages/email/src/index.js` (`AIM_QR_HTML`, `AIM_NOTE_HTML`, `AIM_REMINDER_LEAD`, `AIM_REMINDER_KEEP`, `AIM_MY_LABEL`). Test `packages/email/test/email-copy.test.js` khẳng định một số câu — sửa test cùng lúc |
| 11 | Tên miền dự phòng `https://app.awakenthelions.net` khi thiếu `NEXT_PUBLIC_SITE_URL` | `apps/web/src/app/api/cron/outbox/route.js` |
| 12 | Tên file Excel bắt đầu bằng `ATL2026-…` | `apps/web/src/app/api/admin/export/route.js`, `export-ntt/route.js`, `apps/web/src/app/admin/page.js` |
| 13 | Gợi ý trọng số "Kế hoạch AIM 12/09: booth = 1 · Brief Day & Learning zone = 4 · Inspiration = 3" | `apps/web/src/app/admin/page.js` |
| 14 | `SHOW_ZONE_TOOLS = false` (ẩn khu vực, Giờ Vàng); form nhân bản đặt giờ 08:00–17:00 | `apps/web/src/app/admin/page.js` |
| 15 | Danh sách sự kiện dự phòng `FALLBACK_EVENTS` (đang là UEF, số 4) | `apps/web/src/lib/event-choices.js` |
| 16 | Tên app PG trên màn hình chính "ATL2026 — Máy quét PG", màu nền | `apps/pg/public/manifest.json` |
| 17 | Dữ liệu nền: mùa "Awaken The Lions 2026", 2 sự kiện 12/09/2026, nhãn khoá `dd-2026` | `scripts/build-production-sql.mjs` (production), `packages/db/src/seed-dev.js` (dev: 24 trường, 34 tỉnh, quà mẫu "Bút chì Cannes Lions"…) |
| 18 | Giờ Việt Nam cố định +7 | `apps/web/src/lib/event-when.js`, `packages/email/src/index.js` |
| 19 | Mã project production `qllxeocjtbgtsrzpolqr` trong script sao lưu | `scripts/backup-db.mjs` (`PROD_REF`) |
| 20 | Địa chỉ mặc định của test tải `https://app.awakenthelions.net` | `scripts/ramp-load.mjs` (biến `BASE`) |
| 21 | Lược đồ cột của 24 bảng theo 0001–0016 | `scripts/export-event-csv.mjs` (`SCHEMA`) — thêm cột bằng migration mới thì sửa ở đây |

Tìm lại những chỗ còn sót: `grep -rn -i "awaken\|aim academy\|aimacademy\|awakenthelions\|ATL2026\|Discovery Day" apps/*/src packages/*/src`.

### 7.3 Quy trình rút gọn cho khách hàng mới

1. Tạo kho riêng tư mới từ mã này (mục 4.2). Đổi `name` trong `package.json` gốc nếu muốn.
2. Sửa các chỗ ở 7.2. Chạy `npm test`.
3. Dữ liệu nền (mục 4.3 bước 2). Nhớ: chèn id tường minh thì phải `setval` mọi sequence sau đó (bẫy đã gặp 5 lần;
   `clone_event` tự phòng thủ việc này).
4. Hạ tầng mới (mục 4.3–4.8) với **`ATL_HMAC_KEY` mới**, không dùng lại khoá của khách cũ.
5. Cấu hình trong admin (mục 5.5), chữ thư (5.6), `FALLBACK_EVENTS` (5.7).
6. Chạy T1–T7 trên hạ tầng thật của khách (mục 4.9); tổng duyệt thiết bị thật theo 7 bước (mục 5.10).

---

# Phần IV — Giữ cho hệ thống đúng

## 8. Bảo trì và quy tắc

### 8.1 Test

- `npm test` — 506 test (97 nhóm) ngày 26/11/2026, khoảng 2 phút. Mỗi file test áp toàn bộ migration từ đầu trên PGlite,
  nên migration hỏng là đỏ ngay. Riêng lẻ: `npm run test:qr`, `npm run test:db`.
- Test viết theo kiểu **khẳng định điều không thể xảy ra** (ví dụ "đúng N người nhận suất khi sức chứa là N", "quét lại 20 lần
  vẫn một badge", "mọi đột biến một ký tự của mã QR đều bị từ chối"), không phải chỉ đường đi suôn sẻ. Sửa phần nào thì thêm test
  kiểu đó; giữ toàn bộ xanh.
- Có test chặn tái phạm cho hai lỗi production cũ: hằng số SQL dùng mà không import (`apps/web/test/undeclared-sql-constants.test.js`),
  cùng một tham số `$N` dùng dưới hai kiểu trong một câu (`sql-param-lint.test.js`, sinh từ lỗi nút "Mở đăng ký" 08/09).
- CI (`.github/workflows/ci.yml`) chạy test và build cả hai app trên mọi push và pull request, in kích thước bundle
  (trang `/dang-ky` giữ dưới ~120 kB First Load JS cho mạng 4G nghẽn).

### 8.2 Migration

1. **Chỉ thêm, không sửa, không xoá.** Không sửa file migration đã áp. Không `DROP COLUMN`, không đổi kiểu cột đang có dữ liệu.
   Viết để chạy lại lần hai vẫn an toàn (`if not exists`, `create or replace`, khối `DO` kiểm ràng buộc).
2. Tạo `supabase/migrations/00NN_<tên>.sql` (số kế tiếp, hiện là 0018) + test trong `supabase/test/`. `npm test`.
3. `node scripts/build-production-sql.mjs` (ở thư mục gốc) → sinh lại `production-init.sql`, `production-seed.sql` và
   `production-patch-00NN.sql` (bọc một transaction: lỗi giữa chừng thì không có gì được áp). Commit cả ba.
4. Dán `production-patch-00NN.sql` vào SQL Editor của database đang chạy → Run, **trước** khi deploy code đọc cột mới.
   Code nên đọc cột mới theo kiểu chịu được khi cột chưa có (mẫu: `to_jsonb(e) ->> 'is_archived'` trong
   `apps/web/src/lib/event-visibility.js`).
5. Không bao giờ dán `production-init.sql` lên database đang chạy.
6. Mọi hàm plpgsql mở đầu bằng `#variable_conflict use_column` (tránh lỗi tên cột nhập nhằng).
7. Không tạo unique index trên bảng production có thể đã có dữ liệu trùng — dùng advisory lock + `NOT EXISTS` như 0016.
8. **Bảng mới: `alter table <bảng> enable row level security;` ngay trong migration đó** (không policy, không FORCE).
   RLS không có "mặc định cho bảng mới"; `supabase/test/rls.test.js` fail nếu quên. Quyền của `anon` / `authenticated`
   và EXECUTE của PUBLIC trên bảng / function mới thì default privileges của 0017 đã chặn (khi migration chạy bằng role `postgres`).

### 8.3 Deploy và rollback

- Deploy chỉ bằng workflow **Deploy (manual only)** (mục 4.6). Production phải gõ `DEPLOY`. Workflow chạy `npm test` trước,
  đỏ là không deploy. Không có cơ chế deploy nào khác — đừng nối Git trong Vercel.
- Mỗi app deploy riêng. Đổi biến môi trường của app nào thì deploy lại app đó; đổi `DATABASE_URL` hoặc khoá QR thì deploy cả hai.
- Nên deploy khi không có sinh viên dùng (chủ dự án dùng khung 22:00–07:00 giờ Việt Nam); đóng băng app PG từ sáng ngày sự kiện.
- **Rollback code:** Vercel → project → Deployments → chọn bản trước → *Promote to Production* (dưới 2 phút).
  Migration thì không rollback được — vì vậy chỉ viết migration thêm.
- Nhánh: `main` luôn xanh; nhánh tính năng `feature/<module>`; không merge khi CI đỏ.

### 8.4 Bẫy đã gặp — đừng gặp lại

| Bẫy | Cách tránh |
|---|---|
| Dev: mỗi app một PGlite riêng — SV đăng ký bên web không có bên PG | Dùng 5 SV mẫu `seq` 1001–1005, hoặc trỏ hai app vào cùng một database thử |
| `transpilePackages` biên dịch `packages/db` vào bản build | Sửa seed xong phải build lại |
| Production thiếu `DATABASE_URL` thì dừng hẳn | Cố ý. Thêm biến rồi **deploy lại** (Vercel đóng băng biến lúc build) |
| Hằng số SQL dùng mà không import làm đăng ký trả 500 (11/09) | Đã có test chặn |
| Lỗi "ambiguous column" trong plpgsql | `#variable_conflict use_column` ở đầu mọi hàm |
| Chèn dữ liệu có id tường minh làm sequence không tăng (5 lần) | `setval` mọi sequence sau khi seed |
| Vercel nối Git thì deploy sau lưng mỗi lần push | Disconnect Git, deploy chỉ qua workflow |
| Chạy Vercel CLI trong `apps/<app>` báo thiếu thư viện | Chạy từ thư mục gốc; Root Directory đặt trong project Vercel |
| Dán slug / tên team thay cho id, hoặc dán kèm xuống dòng | `VERCEL_ORG_ID` = `team_…`, `VERCEL_PROJECT_ID_*` = `prj_…`; workflow tự kiểm và cắt |
| CI đỏ ở bước build tải font Google (lỗi mạng tạm thời) | Bấm *Re-run* |
| Mật khẩu database có ký tự đặc biệt làm hỏng URI | Chỉ chữ và số |
| Bấm *Reset database password* khi chưa sẵn sàng | Làm đủ quy trình mục 3.4 |
| SQL Editor: Ctrl+Enter có lúc không chạy; lưới kết quả giới hạn 100 dòng; "Success. No rows returned" là thành công | Bấm nút Run; gộp kết quả như `phan-*.sql` |
| `/api/refdata` cache 1 giờ — form hiện trạng thái cũ sau khi mở / đóng / khoá | Xoá cache CDN (mục 5.9) |
| Quên xếp thư nhắc (UEF 17/11) | Mục 5.11, có trong lịch lùi |
| Sự kiện mới không có `email_copy` → thư mang chữ ATL2026 12/09 | Mục 5.6, trước khi mở đăng ký |
| Hai hoạt động đặc biệt dùng chung một phòng, mở cả hai dòng → phát gấp đôi số ghế | Chỉ mở một dòng |
| Thang quà bị bấm sang "Bậc cao nhất" (TP.HCM 10/09 → 2 SV bị ghi thiếu túi) | Đã khoá cứng ở Cộng dồn; thấy chữ đỏ thì bấm *Đặt lại Cộng dồn* |
| iPhone nhập mã trong Safari rồi mới cài vào màn hình chính → app mất phiên | Cài trước, nhập mã sau |
| Mở app PG từ link Zalo / Messenger → camera không chạy | App tự chặn; mở bằng trình duyệt |
| SV nhập email có dấu (gõ Telex) → thư lỗi 8 lần | Form và server vẫn đang nhận email có dấu (chưa sửa); sửa email trong database rồi đưa thư vào lại hàng đợi |
| Heredoc của bash với tiếng Việt có dấu và dấu backtick bị hỏng | Viết file bằng trình soạn thảo hoặc script `.mjs` |
| `Compress-Archive` (PowerShell 5.1) tạo zip hỏng trên Mac | `tar.exe -a -c -f` |
| Route đọc dữ liệu SV xác thực bằng mã QR — khoá QR công khai trong app PG (sửa 26/11) | Dùng mã truy cập SV (`apps/web/src/lib/access-token.js`, `verifyAccess`); test `apps/web/test/access-token.test.js` |
| Bảng mới quên bật RLS → REST API Supabase mở bảng cho `anon` | `enable row level security` trong cùng migration; test `supabase/test/rls.test.js` |
| `CRON_SECRET` để trống trên production → ai cũng kích được outbox (sửa 26/11) | Route giờ trả 503 và không gửi; đặt biến rồi deploy lại web |

---

## 9. Bảo mật và dữ liệu cá nhân

**Gói mã nguồn:** không có khoá thật, không có dữ liệu sinh viên. Lịch sử git đã được quét ngày 20/11/2026. Dữ liệu sinh viên chỉ có
trong database production và trong gói dữ liệu riêng (mục 1.3).

**Trang quản trị:** một mã truy cập chung cho cả đội (đánh đổi có chủ đích của phiên bản 1). Mã lưu trong trình duyệt đã đăng nhập —
dùng nút *Thoát* trên máy mượn. Ô "Tên bạn" chỉ để ghi nhật ký, không xác thực danh tính. Đổi mã = sửa `ADMIN_ACCESS_KEY` + deploy lại
web; nên đổi sau mỗi mùa hoặc khi có người rời đội.

**Ba lỗ hổng phát hiện khi lập tài liệu — đã sửa trong code ngày 26/11/2026** (nhánh `fix/bao-mat-3-diem`). Bản đang chạy
chỉ hết lỗ sau khi áp đủ runbook ngay dưới.

1. **Khoá ký mã QR nằm trong app PG.** Để máy quét kiểm mã khi mất mạng, app PG đọc `NEXT_PUBLIC_ATL_HMAC_KEY`; biến
   `NEXT_PUBLIC_*` được nhúng vào JavaScript mà trình duyệt tải về từ `pg.<tên-miền>`, nên khoá này coi như **công khai**.
   Trước 26/11, `/api/toi`, `/api/toi/pass` (và `/api/khao-sat`) xác thực bằng chính mã QR: ai có khoá tự tạo mã cho mọi `seq`
   rồi đọc **họ tên, mã tra cứu, số badge** của sinh viên khác (và làm khảo sát nhận badge thay họ).
   **Cách sửa:** tách hai khoá. Mã QR giữ nguyên định dạng và khoá cũ — chỉ để quét, máy PG không phải sửa hay deploy lại.
   Mọi đường đọc dữ liệu cá nhân (`/api/toi`, `/api/toi/pass`, `/api/khao-sat`, link riêng trong thư) dùng **mã truy cập SV**:
   26 ký tự, ký HMAC bằng `ATL_ACCESS_KEY` chỉ có ở server web. `/api/register` trả thêm mã này, `/toi` lưu nó trong thẻ.
   Mã QR gửi tới các route đó bị 401 (`reason: qr_token`).
   **Tác động lên SV đang có thẻ cũ** (lưu trước khi deploy): mã QR vẫn hiện offline và quét bình thường; riêng phần điểm và
   khảo sát báo "mở link trong email mới nhất hoặc lấy lại mã". Link trong các thư đã gửi trước đó (mang mã QR) không còn mở
   được trang điểm — `/toi` báo "link cũ, lấy lại mã bằng email / SĐT". Không màn hình trắng, không mất dữ liệu.
   Còn lại: ai có khoá PG vẫn tạo được **mã QR** quét được ở booth (cộng badge vẫn phải qua máy PG đã nhận mã) — muốn chặn hẳn
   thì chuyển sang chữ ký bất đối xứng (mục 10). Khoá mới cho mỗi khách hàng / mùa (mục 3.3).
2. **Database chưa bật RLS.** Supabase mở REST API (`/rest/v1`, `/rest/v1/rpc`) cho `anon` / `authenticated` trên schema
   `public`; ai có khoá `anon` của project đọc / ghi được bảng và gọi được các hàm `security definer`.
   **Cách sửa:** migration `0017_rls_lockdown` bật RLS mọi bảng (không policy, **không FORCE** — app nối bằng role chủ bảng nên
   vẫn chạy y như cũ), thu mọi quyền của `anon` / `authenticated` trên bảng / view / sequence / function, thu EXECUTE của PUBLIC
   trên function của app, đặt default privileges để object mới không tự cấp cho các role đó. App không dùng khoá `anon`.
3. **`CRON_SECRET` không bắt buộc.** Production thiếu biến là ai biết URL cũng kích được outbox gửi thư.
   **Cách sửa:** production thiếu `CRON_SECRET` thì `/api/cron/outbox` từ chối mọi lời gọi (503 `cron_secret_missing`,
   không nhận dòng, không gửi thư); có thì bắt `Authorization: Bearer <CRON_SECRET>` như cũ.

**Runbook áp bản vá 26/11 lên hệ thống đang chạy** (trong khung 22:00–07:00, không có sự kiện sắp diễn ra; đúng thứ tự):

1. Supabase → project production → **SQL Editor** → New query → dán nguyên `supabase/production-patch-0017.sql` → **Run**.
   "Success. No rows returned" là xong (cả file một transaction: lỗi thì không có gì được áp). App đang chạy không bị ảnh hưởng.
   Kiểm: `select relname from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r','p') and not relrowsecurity;`
   → không dòng nào; `select has_table_privilege('anon', 'students', 'select');` → `false`. Supabase → Advisors hết cảnh báo RLS.
2. Vercel → **project web** → Settings → Environment Variables: thêm **`ATL_ACCESS_KEY`** (Sensitive, Production + Preview;
   tạo bằng lệnh ở mục 4.4 bước 6, **khác** `ATL_HMAC_KEY`). Kiểm **`CRON_SECRET`** đã có (thiếu thì tạo). **Không** thêm gì vào project pg.
3. Deploy **web** production (mục 4.8 bước 1, `app=web`). **App PG không phải deploy lại.**
4. Kiểm: đăng ký thử (hoặc gửi lại form bằng email đã đăng ký) → `/toi` hiện điểm; mở `/api/cron/outbox` không header → `401`;
   Vercel → Logs không có dòng `CRON_SECRET chưa đặt` hay `ATL_ACCESS_KEY is required`.

Bước 1 làm độc lập được (code cũ vẫn chạy trên database đã vá). Bước 3 mà thiếu `ATL_ACCESS_KEY` thì đăng ký và `/toi` báo lỗi,
outbox dừng (503) mà không tiêu lượt thử của thư — thêm biến rồi deploy lại là chạy.

**Dữ liệu cá nhân của sinh viên:**

- AIM là bên kiểm soát dữ liệu. Hosting ở Singapore là chuyển dữ liệu ra nước ngoài — `README.md` (việc số 10) và spec mục 6 yêu cầu
  luật sư rà văn bản đồng ý và hồ sơ chuyển dữ liệu; trạng thái hồ sơ không ghi trong kho mã — cần kiểm lại với AIM.
- Hai ô đồng ý **tách riêng, không tick sẵn**: ô 1 (xử lý để tổ chức sự kiện) bắt buộc; ô 2 (nhận thông tin từ nhà tài trợ) không bắt
  buộc và **chỉ có ở form online** — sinh viên đăng ký tại cổng không bao giờ có trong file nhà tài trợ.
- File **Excel NTT** (tab Hoạt động) chỉ gồm sinh viên đã tick ô 2 **và** có ghé đúng gian hàng đó; gồm họ tên, trường, email, SĐT,
  giờ ghé. File **Excel nội bộ** có đủ thông tin cá nhân của mọi sinh viên — **không gửi cho đối tác**.
- Điện thoại PG (máy cá nhân) giữ danh sách sinh viên của sự kiện để tra offline: họ tên, MSSV, SĐT, số badge (không có email).
  Sau sự kiện: thu hồi máy và xoá dữ liệu trên máy (mục 5.13 bước 6).
- Sổ cái quét chỉ ghi thêm; hiện **chưa có chức năng xoá hay ẩn danh dữ liệu của một sinh viên** theo yêu cầu. Nếu cần đáp ứng yêu cầu
  xoá, phải thiết kế riêng (mục 10).
- Nhật ký thư (`notification_outbox.payload`, `last_error`) có thể chứa tên và địa chỉ email — không dán kết quả truy vấn ra kênh chung.
- Gói dữ liệu 26/11/2026 không đặt mật khẩu: cất ở nơi có phân quyền, mã hoá nếu được; quyết định thời hạn lưu giữ và xoá khi hết mục đích.

---

## 10. Giới hạn hiện tại và hướng phát triển

**Giới hạn đã biết**

1. Trang quản trị dùng một mã chung, không có tài khoản từng người.
2. Một khoá ký QR cho mọi sự kiện, và khoá đó công khai trong app PG (mục 9): từ 26/11 nó chỉ dùng để quét, không mở được dữ
   liệu của ai, nhưng ai có nó vẫn tạo được mã QR quét được ở booth. `events.token_key_id` chưa được dùng.
3. Không có công cụ nhập danh sách sinh viên hàng loạt trong kho mã. Đợt 07–11/09/2026 nhập bằng script viết riêng (`convert.mjs`, nằm
   ngoài kho), gọi `/api/register` khoảng 2 lượt/giây, chạy thử 5–10 dòng trước; luật làm sạch dữ liệu và nhật ký ba đợt nhập ghi ở
   spec mục 4.5.
4. Form và server vẫn nhận email có dấu (gây thư lỗi); SĐT chỉ theo định dạng Việt Nam.
5. Mẫu thư kiểu AIM chỉ có thư xác nhận và thư nhắc buổi sáng; thư nhắc phải xếp tay bằng SQL; không gửi lại thư xác nhận từ admin.
6. Sửa tên / giờ sự kiện, chữ thư, khoá sự kiện, danh sách trường đều phải dùng SQL; form nhân bản đặt cứng giờ 8h–17h.
7. Giờ Việt Nam cố định +7; `CURRENT_YEAR = 2026` viết cứng.
8. `registrations.checked_in_at` không được ghi — đếm có mặt theo badge.
9. Không có thông báo đẩy tới điện thoại sinh viên; iPhone không đồng bộ nền (hàng đợi PG chỉ đẩy khi app đang mở).
10. Các luật lớp C viết cứng (mục 7.1); mỗi khách hàng một bản sao, không dùng chung hạ tầng.
11. Database đang ở gói Free; chưa có bản sao lưu trực tiếp nào (chỉ có bản xuất qua SQL Editor 26/11).
12. Spec `docs/ATL2026-Production-Spec.md` dừng ở 12/09/2026, chưa ghi đợt UEF và migration 0016 (thông tin đó nằm ở `TIEP-TUC.md`
    và chú thích trong code).
13. Bộ test PGlite chỉ chứng minh logic; tính đúng khi tranh chấp phải chạy lại T1–T7 trên hạ tầng thật mỗi lần dựng mới.

**Hướng phát triển gợi ý** (theo mức ưu tiên)

1. Chuyển hạ tầng sang tài khoản của AIM / TCM, đặt lại mật khẩu database, chạy sao lưu định kỳ.
2. Tách khoá: ký bất đối xứng (Ed25519 hoặc tương tự) để máy quét chỉ giữ khoá công khai; dùng `token_key_id` để mỗi sự kiện một khoá.
3. Màn admin cho: sửa thông tin sự kiện, chữ thư, khoá sự kiện, xếp thư nhắc (hoặc tự xếp theo lịch), xoá cache sau khi đổi cờ.
4. Công cụ nhập danh sách Excel có kiểm tra trước (đưa script đợt 09/2026 vào kho, có test).
5. Chặn email có dấu ở cả form và server.
6. Tài khoản admin riêng từng người.
7. Chức năng ẩn danh / xoá dữ liệu một sinh viên theo yêu cầu, và chính sách thời hạn lưu giữ.
8. Kế hoạch `/api/bulletin` (thông báo chung, ghi ngày 25/08/2026) chưa làm — chỉ làm nếu khách cần.

---

# Phụ lục

## A. Cây thư mục

```
.
├── apps/
│   ├── web/                     App sinh viên + /admin + API + cron gửi thư (Next.js)
│   │   ├── src/app/             Trang: page.js, dang-ky/, toi/, lich/, khao-sat/, admin/
│   │   ├── src/app/api/         register, refdata, toi, toi/pass, khao-sat, cron/outbox, admin/*
│   │   ├── src/lib/             event-choices.js (FALLBACK_EVENTS), event-visibility.js, event-when.js, qr.js, admin-auth.js…
│   │   ├── test/                Test của app web
│   │   └── vercel.json          Vùng sin1 + cron /api/cron/outbox mỗi phút
│   └── pg/                      App máy quét PG (Next.js, PWA)
│       ├── src/app/             page.js (nhận máy), quet/, qua/, suat/, tra-cuu/, hang-cho/
│       ├── src/app/api/pg/      claim, sync, roster, state, gift, special
│       ├── src/lib/             device-role.js, session.js, scanner.js, gift-plan.js…
│       ├── public/manifest.json
│       ├── test/
│       └── vercel.json          Vùng sin1
├── packages/                    brand, db, email, qr-render, qr-token, scan-queue, vn-text, xlsx-lite
│                                (mỗi thư viện: src/, test/, CHANGELOG.md)
├── supabase/
│   ├── migrations/              0001_foundations.sql … 0017_rls_lockdown.sql
│   ├── production-init.sql      Sinh tự động — database MỚI
│   ├── production-patch-0017.sql Sinh tự động — database đang chạy
│   ├── production-seed.sql      Sinh tự động — dữ liệu nền
│   └── test/                    Test database (PGlite)
├── scripts/                     build-production-sql, export-bundle-sql, export-event-csv, backup-db,
│                                concurrency, write-load, register-load, failover-drill, ramp-load
├── docs/
│   ├── ATL2026-Production-Spec.md   Spec, số đo test tải, sự cố, quyết định (đến 12/09/2026)
│   ├── FORK-PLAYBOOK.md             Dùng lại cho khách hàng khác
│   ├── HUONG-DAN-TAI-SU-DUNG.md     Tài liệu này
│   └── ATL2026-lofi-wireframe.html
├── .github/workflows/           ci.yml (test + build mọi push), deploy.yml (deploy bằng tay)
├── ATL2026-*.pdf                14 tài liệu đã gửi AIM (Phụ lục F)
├── README.md, CONTRIBUTING.md, TIEP-TUC.md (sổ bàn giao)
├── package.json, package-lock.json
└── .gitignore                   Loại .env*, node_modules, 2 tài liệu mật của AIM
```

## B. Lệnh và câu SQL thường dùng

**Lệnh (chạy ở thư mục gốc)**

| Lệnh | Việc |
|---|---|
| `npm ci` | Cài thư viện đúng phiên bản khoá |
| `npm test` | Toàn bộ 506 test |
| `npm run test:qr` · `npm run test:db` | Riêng mã QR · riêng database |
| `npm run dev --workspace @atl/web` | Chạy app web dev, cổng 3000 |
| `npm run dev --workspace @atl/pg -- -p 3001` | Chạy app PG dev, cổng 3001 |
| `node scripts/build-production-sql.mjs` | Sinh lại `production-init.sql`, `production-patch-<mới nhất>.sql`, `production-seed.sql` |
| `node scripts/export-bundle-sql.mjs <thư-mục>` | Sinh `phan-1.sql`, `phan-2.sql` để xuất dữ liệu qua SQL Editor |
| `node scripts/export-event-csv.mjs <thô> <ra> [--events=1,2,4] [--force]` | Dựng CSV + Excel theo từng sự kiện |
| `node scripts/backup-db.mjs [thư-mục] [--any]` | Sao lưu trực tiếp (cần `DATABASE_URL`) |
| `npm run test:concurrency` · `test:write-load` · `test:register-load` · `test:failover` | Test tranh chấp / tải — **chỉ project thử**, đọc `.env.local` |
| `npm run test:ramp` | Tải đọc tăng dần vào `BASE` (mặc định địa chỉ production) — chỉ chạy khi đã thống nhất |
| `gh workflow run deploy.yml -f app=<web\|pg> -f target=<preview\|production> [-f confirm=DEPLOY] -f reason="<lý do>"` | Deploy |
| `gh run list --workflow=deploy.yml --limit 5` | Xem các lượt deploy |
| `git clone <file>.bundle <thư-mục>` | Khôi phục kho từ bundle |
| `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` | Sinh khoá ngẫu nhiên 64 ký tự |

**SQL (Supabase SQL Editor)** — các câu dưới đã chạy thử trên database dựng từ `production-init.sql` (PGlite) ngày 26/11/2026.

Xem nhanh các sự kiện:

```sql
select id, slug, name, starts_at, ends_at, is_registration_open, is_archived,
       email_copy is not null as co_thu_rieng
  from events order by id;
```

Tạo sự kiện đầu tiên trên database mới (thay cho seed mặc định):

```sql
insert into editions (id, year, name) values (1, 2027, '<Tên chiến dịch>') on conflict do nothing;
insert into events (id, edition_id, kind, slug, name, venue_name, city,
                    starts_at, ends_at, token_key_id, is_registration_open)
values (1, 1, 'discovery_day', '<slug>', '<Tên sự kiện>', '<Địa điểm>', '<Thành phố>',
        '2027-03-20 08:00+07', '2027-03-20 17:00+07', '<nhãn-khoá>', false);
```

Sửa giờ (5.4), đặt chữ thư (5.6), khoá sự kiện và thu hồi máy (5.8), xếp và theo dõi thư nhắc (5.11): xem các mục tương ứng.

Đếm dòng 24 bảng (kết quả dùng làm `_so-dong.json`, mục 6.1):

```sql
select json_build_object(
  'attendance', (select count(*) from attendance),
  'audit_log', (select count(*) from audit_log),
  'checkpoint_minute_counts', (select count(*) from checkpoint_minute_counts),
  'checkpoints', (select count(*) from checkpoints),
  'editions', (select count(*) from editions),
  'events', (select count(*) from events),
  'gift_redemptions', (select count(*) from gift_redemptions),
  'gift_tiers', (select count(*) from gift_tiers),
  'golden_hours', (select count(*) from golden_hours),
  'ledger_events', (select count(*) from ledger_events),
  'notification_outbox', (select count(*) from notification_outbox),
  'pg_device_checkpoints', (select count(*) from pg_device_checkpoints),
  'pg_devices', (select count(*) from pg_devices),
  'pg_staff', (select count(*) from pg_staff),
  'ref_provinces', (select count(*) from ref_provinces),
  'ref_schools', (select count(*) from ref_schools),
  'registrations', (select count(*) from registrations),
  'special_activities', (select count(*) from special_activities),
  'special_slots', (select count(*) from special_slots),
  'students', (select count(*) from students),
  'survey_responses', (select count(*) from survey_responses),
  'surveys', (select count(*) from surveys),
  'teams', (select count(*) from teams),
  'zones', (select count(*) from zones)
)::text as so_dong;
```

Kiểm database mới dựng: `select count(*) from pg_tables where schemaname='public';` → 24.

## C. Bảng biến môi trường

Không ghi giá trị nào. "Deploy lại" = chạy workflow deploy cho app đó ở production.

| Biến | Project | Bắt buộc | Ý nghĩa | Tạo giá trị mới | Đổi xong phải |
|---|---|---|---|---|---|
| `DATABASE_URL` | web **và** pg (cùng giá trị) | Có — production thiếu là dừng | Chuỗi kết nối Supabase qua **Transaction pooler cổng 6543** | Supabase → Connect → Transaction pooler → URI; mật khẩu chỉ chữ và số | Deploy lại **cả hai** |
| `ATL_HMAC_KEY` | web | Có — production và bước build từ chối khi thiếu | Khoá ký **mã QR** phía server (đăng ký, ảnh QR trong thư, thẻ `/toi`). Coi như công khai vì app PG giữ bản sao | Chuỗi ngẫu nhiên, tối thiểu 16 byte; khuyên 64 ký tự hex (lệnh ở Phụ lục B) | Xem mục 3.3 — đổi cùng `NEXT_PUBLIC_ATL_HMAC_KEY`, deploy cả hai |
| `NEXT_PUBLIC_ATL_HMAC_KEY` | pg | Có — thiếu thì app PG dùng khoá dev, báo sai mọi mã thật | Khoá để máy quét kiểm mã offline. **Y hệt** `ATL_HMAC_KEY` | Chép đúng giá trị `ATL_HMAC_KEY` (không thừa dấu cách / xuống dòng) | Deploy lại pg (giá trị nhúng lúc build) |
| `ATL_ACCESS_KEY` | **chỉ web** | Có (từ 26/11) — production thiếu thì đăng ký, `/toi`, outbox dừng; trùng `ATL_HMAC_KEY` cũng dừng | Khoá ký **mã truy cập SV**: mở điểm, thẻ tham dự, khảo sát, link riêng trong thư. **Không bao giờ** đặt vào pg hay `NEXT_PUBLIC_*` | Chuỗi ngẫu nhiên như `ATL_HMAC_KEY` (lệnh ở mục 4.4), **khác** `ATL_HMAC_KEY` | Deploy lại web. Link thư cũ và thẻ đã lưu mất phần điểm (mục 3.3) |
| `ADMIN_ACCESS_KEY` | web | Có — production từ chối khi thiếu | Mã vào `/admin` | Chuỗi ngẫu nhiên | Deploy lại web; báo đội admin mã mới |
| `CRON_SECRET` | web | Có (từ 26/11) — production thiếu thì `/api/cron/outbox` từ chối mọi lời gọi (503), không gửi thư | Vercel Cron tự gửi kèm header `Authorization: Bearer <CRON_SECRET>` | Chuỗi ngẫu nhiên | Deploy lại web |
| `RESEND_API_KEY` | web | Để gửi thư — thiếu thì thư nằm chờ trong outbox, không bị đánh hỏng | Khoá API Resend | Resend → API Keys, quyền *Sending* | Deploy lại web |
| `EMAIL_FROM` | web | Đi cùng `RESEND_API_KEY` | Địa chỉ gửi | `Tên hiển thị <noreply@mail.<tên-miền>>`, domain phải Verified trên Resend | Deploy lại web |
| `NEXT_PUBLIC_SITE_URL` | web | Nên có — thiếu thì dùng `https://app.awakenthelions.net` | URL gốc trong thư (link `/toi`, `/lich`) | `https://app.<tên-miền>` | Deploy lại web |

Vercel tự đặt `NODE_ENV`, `VERCEL_GIT_COMMIT_SHA` (app PG đọc để báo phiên bản; khi deploy bằng CLI có thể trống) — không cần khai.

Chỉ dùng trên máy (file `.env.local` ở thư mục gốc, không commit): `DATABASE_URL` của **project thử** cho các script
`test:concurrency`, `test:write-load`, `test:register-load`, `test:failover`; biến tuỳ chọn của script tải như `SCALE`,
`DURATION_S`, `BASE`, `STEPS` (xem đầu từng file trong `scripts/`).

Secrets GitHub Actions: bảng ở mục 3.2.

## D. Các bảng database chính

| Bảng | Một dòng mô tả |
|---|---|
| `editions` | Mùa / chiến dịch (ví dụ 2026) |
| `events` | Sự kiện: id 1–255 (nằm trong mã QR), tên, địa điểm, giờ, luật (`y`, `z`, thang quà), cờ mở đăng ký, Early Bird, `is_archived`, `email_copy` |
| `zones` | Khu vực trong một sự kiện |
| `checkpoints` | Điểm quét: loại (cổng, gian hàng, gian hàng kim cương, hội trường, lớp học, quầy thông tin, quầy quà, bonus), giờ, trọng số badge, cờ tính badge |
| `ref_schools` | Danh sách trường cho form đăng ký |
| `ref_provinces` | 34 tỉnh / thành |
| `students` | Hồ sơ sinh viên — một người một hồ sơ toàn chiến dịch; `seq` dùng trong mã QR; mã tra cứu 6 ký tự; thời điểm đồng ý |
| `registrations` | Sinh viên đăng ký sự kiện nào, nguồn (`online` / `walk_in` / `admin` / `import`), số badge |
| `teams` | Đội thi (năm 2026 không dùng, 0 dòng) |
| `audit_log` | Nhật ký thao tác của admin: ai, lúc nào, trước / sau, lý do |
| `ledger_events` | Sổ cái **mọi** lượt quét, kể cả trùng và bị từ chối — chỉ ghi thêm |
| `attendance` | Badge hợp lệ: một sinh viên một điểm quét; gỡ badge là xoá mềm kèm lý do |
| `checkpoint_minute_counts` | Đếm lượt theo phút cho bảng điều khiển |
| `gift_tiers` | Bậc quà: ngưỡng badge, kho, đã phát |
| `gift_redemptions` | Lượt nhận quà, kèm ngưỡng tại thời điểm trao |
| `special_activities` | Hoạt động đặc biệt có giới hạn suất |
| `special_slots` | Từng suất tạo sẵn (giữ 90 giây rồi xác nhận) |
| `notification_outbox` | Hàng đợi thư: mẫu, người nhận, trạng thái, số lần thử, lỗi cuối, giờ hẹn |
| `pg_staff` | Nhân sự PG / giám sát của một sự kiện |
| `pg_devices` | Máy quét: mã nhận máy, PIN và token (lưu dạng băm), điểm được gán, vai trò, pin, hàng đợi, thu hồi |
| `pg_device_checkpoints` | Phạm vi điểm quét của máy (kiểu cũ từ 0005) |
| `golden_hours` | Lượt Giờ Vàng (năm 2026 không dùng) |
| `surveys` | Khảo sát gắn gian hàng (tối đa 8 câu, có phiên bản câu hỏi) |
| `survey_responses` | Câu trả lời khảo sát |

## E. Danh sách "cần kiểm lại"

1. Giá và gói hiện hành của Vercel (Pro), Resend, tên miền; Vercel gói thấp hơn có còn chạy được cron mỗi phút và vùng `sin1` hay không.
2. Chính sách gói Free của Supabase: tạm dừng project ít hoạt động, sao lưu tự động; trạng thái project `qllxeocjtbgtsrzpolqr` trước mỗi sự kiện.
3. Team Vercel đang chứa 2 project và tên thật của 2 project (`atl2026-web`, `atl2026-pg` theo tài liệu dựng).
4. Chủ sở hữu tài khoản Resend.
5. Hạn của `VERCEL_TOKEN` hiện tại (tài liệu dựng đặt 90 ngày, tạo đầu 09/2026).
6. Ai còn giữ bản sao `ATL_HMAC_KEY`, `ATL_ACCESS_KEY`, `ADMIN_ACCESS_KEY`, `CRON_SECRET` ngoài Vercel.
7. Điều kiện chuyển project Supabase giữa tổ chức và chuyển project Vercel giữa team; biến Sensitive có đi theo project hay không.
8. Vị trí nút xoá cache CDN trong giao diện Vercel; deploy lại có xoá cache CDN hay không.
9. Node.js 20 trên Windows có chạy được `npm test` (mẫu đường dẫn `*`) hay không — khuyên dùng Node 22.
10. Bản vá bảo mật 26/11 đã lên production chưa: patch 0017 đã dán, `ATL_ACCESS_KEY` + `CRON_SECRET` có trên project web,
    web đã deploy lại (runbook mục 9).
11. Sau khi áp 0017: có ai / công cụ nào ngoài app dùng khoá `anon` của Supabase không (theo code thì không) — nếu có, nó sẽ hỏng.
12. Trạng thái hồ sơ pháp lý về văn bản đồng ý và chuyển dữ liệu ra nước ngoài.
13. `pg.awakenthelions.net` còn trỏ đúng app PG (tài liệu 09/2026 ghi vậy; sổ bàn giao chỉ kiểm `app.`).

## F. Tài liệu khác trong gói

| File | Dành cho | Ghi chú |
|---|---|---|
| `TIEP-TUC.md` | Kỹ thuật | Sổ bàn giao mới nhất: tình hình, việc còn lửng, bẫy |
| `README.md` | Kỹ thuật | Bảo đảm cốt lõi, định dạng QR, lý do thiết kế app PG, briefing 7 bước |
| `CONTRIBUTING.md` | Kỹ thuật | Chạy thử 2 phút, file cần soi kỹ, nguyên tắc đã chốt |
| `docs/FORK-PLAYBOOK.md` | Kỹ thuật | Dùng lại cho khách hàng khác |
| `docs/ATL2026-Production-Spec.md` | Kỹ thuật | Spec, kết quả test tải và tranh chấp, sự cố, runbook 12/09 (file lớn, ~94 KB) |
| `ATL2026-Setup-Supabase-Vercel.pdf` | Người dựng hạ tầng | Bấm-chuột từng bước (27/08; 3 điểm đã cũ, xem mục 4) |
| `ATL2026-Huong-dan-DNS-MatBao.pdf` | Người quản lý DNS | Phiếu 6 bản ghi DNS |
| `ATL2026-Huong-dan-Admin.pdf` | Ban tổ chức | Vận hành trang quản trị (bản 11/09) |
| `ATL2026-Huong-dan-Tao-May-PG.pdf`, `ATL2026-So-tay-May-quet-PG.pdf` | Ban tổ chức, PG | Tạo máy, dùng máy quét |
| `ATL2026-Huong-dan-App-Sinh-vien.pdf` | Sinh viên | Dùng app sinh viên |
| `ATL2026-Phuong-an-de-xuat.pdf`, `ATL2026-Goi-toi-uu-luong.pdf`, `ATL2026-Flow-diem-cham-app.pdf`, `ATL2026-Tinh-nang-app-xac-nhan.pdf`, `ATL2026-Truong-thong-tin-Dang-ky.pdf`, `ATL2026-Gioi-thieu-app-cho-AIM.pdf`, `Tran-cong-suat-booth-ATL2026.pdf`, `ATL2026-Bao-cao-Kiem-tra-Tai-Gap-Doi.pdf` | AIM, kỹ thuật | Phương án, luồng, tính năng đã xác nhận, báo cáo kiểm tra tải |
