# ATL2026 — Web-app đăng ký & tracking

Hệ thống đăng ký và tracking cho **Awaken The Lions 2026** (AIM Academy × FTU): Discovery Day Hà Nội và HCM ngày 12/09/2026, Grand Finale TPHCM ngày 01/11/2026.

Kế hoạch đầy đủ: xem plan file đã duyệt.

## Trạng thái

| Phần | Trạng thái |
|------|-----------|
| Thư viện QR token (`packages/qr-token`) | ✅ Xong, 26 test |
| Render QR (`packages/qr-render`) | ✅ Xong, 17 test |
| Tra cứu tiếng Việt (`packages/vn-text`) | ✅ Xong, 22 test |
| **Hàng đợi offline (`packages/scan-queue`)** | ✅ Xong, 43 test |
| **Kết nối DB dùng chung (`packages/db`)** | ✅ Xong |
| Schema + sổ cái quét (`0001`, `0002`) | ✅ Xong, 16 test |
| Quà & suất giới hạn (`0003`) | ✅ Xong, 18 test |
| Đăng ký (`0004`) | ✅ Xong, 15 test |
| **Thiết bị PG + Early Bird (`0005`)** | ✅ Xong, 28 test |
| App sinh viên — đăng ký, `/toi` | ✅ Chạy được end-to-end |
| **App PG — quét, tra cứu, hàng đợi** | ✅ Chạy được end-to-end |
| **Hai thang đếm badge (`0006`, `0007`)** | ✅ Xong, 13 test |
| **Email xác nhận + nhắc (`packages/email` + cron outbox)** | ✅ Xong, 13 test |
| **Trang lịch `/lich` (2 route tĩnh ISR 60s)** | ✅ Chạy được |
| **`/toi` tiến độ badge + ĐÃ HẾT** | ✅ Chạy được |
| **Admin console `/admin` (4 tab)** | ✅ Chạy được end-to-end |
| **Giờ Vàng (`0008`)** | ✅ Xong, 18 test |
| **Walk-in cổng · quầy suất · đối soát vé giấy · export NTT · nhân bản sự kiện** | ✅ Chạy được |
| **Excel export (`packages/xlsx-lite`)** | ✅ Xong, 8 test |
| **Survey NTT (`0010` + /khao-sat + tab builder)** | ✅ Chạy được end-to-end |
| **Cổng đăng ký + tab Vận hành (`0011`: PG/máy quét, zone, bậc quà, suất, Early Bird)** | ✅ Chạy được |
| **Brand kit tập trung (`packages/brand` + khối BRAND KIT trong CSS)** | ✅ Xong |

**266 test, tất cả xanh.**

```bash
npm install && npm test
```

Test chạy Postgres thật qua **PGlite** (WASM) — không cần cài Postgres hay Docker.

## Những gì đã được bảo đảm

Các bảo đảm dưới đây do **ràng buộc của storage engine** thực thi, không do code nhớ làm đúng. Mỗi dòng có test tương ứng.

| Bảo đảm | Cơ chế |
|---------|--------|
| Quét lại cùng một lượt (hàng đợi offline gửi lại) không cấp badge thứ hai | `scan_uid` do client sinh là khoá chính |
| Hai PG quét cùng lúc cùng một SV tại một booth → đúng 1 badge | Partial unique index trên `(event, student, checkpoint)` |
| Không đổi trùng một bậc quà, thử lại bao nhiêu lần cũng vậy | Unique index + hoàn kho khi insert thất bại |
| Không bao giờ phát quá kho | `UPDATE … WHERE stock_issued < stock_total` + CHECK |
| **Đúng N người nhận suất khi cap = N** | Slot rows pre-allocated + `FOR UPDATE SKIP LOCKED` |
| Mạng rớt giữa chừng không đốt mất suất | Hold 2 pha, tự hết hạn và trả suất về kho |
| Dữ liệu Hà Nội không lẫn sang HCM | Khoá ngoại phức hợp `(checkpoint_id, event_id)` |
| Không mất bằng chứng khi sửa sai | Ledger append-only; gỡ badge là soft delete + audit log |
| Admin đổi ngưỡng giữa sự kiện không thu hồi quà đã trao | `threshold_at_grant` lưu luật tại thời điểm trao |

Ba lỗi thật đã bị test bắt trong lúc dựng, đáng ghi lại vì cả ba đều sẽ hỏng âm thầm ở production:

1. **Base32 không song ánh** — 16 byte = 128 bit nhưng 26 ký tự chứa 130 bit, nên 4 chuỗi khác nhau giải mã ra cùng một sinh viên và ký tự cuối sửa được mà chữ ký vẫn hợp lệ. Đã bắt buộc dạng chuẩn tắc khi giải mã.
2. **Thứ tự ghi sai** — `attendance` tham chiếu ngoại tới `ledger_events` nhưng phải ghi trước, vì kết quả `ON CONFLICT` mới quyết định status ghi vào ledger. Đảo thứ tự sẽ phải đọc-rồi-ghi, tức tái tạo đúng race đang tránh. Đã hoãn kiểm khoá ngoại đến lúc commit.
3. **Tên cột nhập nhằng** — `SET badge_count = badge_count + 1` trùng tên với cột trả về của hàm.

## Giới hạn hiện tại của bộ test

PGlite chạy **một kết nối**, nên các test trên chứng minh *logic* đúng chứ chưa chứng minh *đồng thời* đúng. Ba bài dưới đây phải chạy lại trên Supabase thật, đa kết nối, trước 05/09:

- 500 client cùng claim suất với cap 200 → **đúng 200**, chạy 10 lần
- 200 client cùng claim một bậc quà cho một SV → đúng 1 thành công
- 20 luồng quét + 20 luồng claim song song 60 giây → `v_progress_drift` trả 0 dòng

## Việc cần con người làm trước khi code chạy tiếp

Theo thứ tự đường găng:

| # | Việc | Hạn | Ghi chú |
|---|------|-----|---------|
| 1 | **Cấu hình SPF/DKIM/DMARC trên subdomain gửi mail, gửi email thật đầu tiên** | **Ngay** | Lead-time dài nhất dự án, tốn 0đ. Gửi từ subdomain riêng, không bao giờ từ `aimacademy.vn` gốc |
| 2 | Mua domain + tạo Vercel Pro (pin `sin1`) + Supabase project **`ap-southeast-1`**, **tắt spend cap** | 25/08 | Chặn mọi việc deploy |
| 3 | Chốt danh sách trường đại học và 34 tỉnh/thành để seed | 26/08 | Cần cho form đăng ký |
| 4 | Chốt danh sách booth, zone, khung giờ, ngưỡng x/y/z, kho quà | 27/08 | Cần cho seed data |
| 5 | Xin FTU SSID riêng cho ~50 máy PG, cắm mạng dây | 05/09 | Tốn 0đ, hiệu quả cao nhất |
| 6 | Hotspot 2 nhà mạng khác nhau | 10/09 | Một nhà mạng nghẽn không hạ cả đội |
| 7 | **45 pin dự phòng (~7 triệu)** | 11/09 | Vì PG dùng máy cá nhân nên pin quan trọng **hơn**. Nếu chỉ xin được một thứ, xin cái này |
| 8 | 5–8 máy mượn cho PG trượt kiểm tra ở briefing | 11/09 | Dễ xoay hơn 45 máy đồng bộ |
| 9 | In sổ vé giấy đánh số cho hoạt động đặc biệt + bảng ký tên cổng | 11/09 | Đường lui bắt buộc khi mất mạng |
| 10 | Luật sư rà văn bản đồng ý + hồ sơ chuyển dữ liệu xuyên biên giới | Tuần này | Hosting Singapore là chuyển dữ liệu ra nước ngoài |

### Briefing PG: 7 bước, đỗ/trượt từng máy

Với BYOD đây là biện pháp kiểm soát quan trọng nhất còn lại, và phải làm cho **từng máy** chứ không phổ biến chung:

1. Mở bằng Chrome/Safari, **không phải webview Zalo**
2. Thêm vào màn hình chính **trước**, mở PWA, **rồi mới** nhập mã thiết bị
3. Cấp quyền camera
4. Tải xong roster (chip đồng bộ xanh)
5. Quét thử 5 lượt, trong đó **1 lượt trùng** để PG thấy màn hổ phách không phải lỗi
6. Tra cứu thủ công 1 lần bằng tên
7. Bật **chế độ máy bay**, quét 2 lượt, tắt đi, xác nhận hàng đợi tự đẩy

Máy chưa qua đủ 7 bước thì không ra trận — chuyển vị trí không quét, nhận máy mượn, hoặc ghép cặp.

## Cấu trúc

```
apps/web/              App sinh viên — đăng ký, /toi (QR offline)
apps/pg/               App PG — origin riêng, đóng băng được độc lập ngày sự kiện
packages/qr-token/     Mint & verify token — dùng chung server, app PG, app SV
packages/qr-render/    Render QR sang SVG/PNG — CHỈ chạy phía server
packages/vn-text/      Gấp dấu tiếng Việt + tra cứu roster offline
packages/scan-queue/   Hàng đợi offline + phát hiện môi trường trình duyệt
packages/db/           Kết nối DB dùng chung (pooler settings) + seed dev
supabase/migrations/   0001 nền tảng · 0002 sổ cái · 0003 quà · 0004 đăng ký · 0005 thiết bị PG
supabase/test/         Test schema chạy trên PGlite
docs/                  Production Spec v1.1 + wireframe v0.2
```

## Định dạng QR

```
16 byte: version(1) + event(1) + student_seq(4) + HMAC-SHA256 cắt 80 bit(10)
→ Crockford Base32 → 26 ký tự → QR version 2 (25×25), ECC-Q, quiet zone 4
```

**ECC-Q, đã đo chứ không đoán:** 26 ký tự alphanumeric vẫn nằm gọn ở version 2 với ECC-Q, tức 25% sửa lỗi thay vì 15% của ECC-M mà symbol giữ nguyên 25×25 — miễn phí, và đúng loại hỏng cần chống (loá nắng che một mảng QR). ECC-H nhảy lên 29×29, module nhỏ đi 14% đổi lấy 5% sửa lỗi: lỗ, vì camera mới là mắt xích yếu. Test `qr-render` khẳng định lại điều này mỗi lần chạy.

QR được render **một lần phía server** lúc đăng ký, rồi cache chuỗi SVG trên máy sinh viên. Nhờ vậy thư viện QR (~50KB) không bao giờ vào bundle của app sinh viên, và màn hình QR chạy được với **0 request mạng**.

Ba điều tuyệt đối không làm:

- **Không nhét URL hay JWT vào QR sinh viên.** Symbol phồng lên, module co lại, decode tốt trong văn phòng và hỏng ngoài nắng sân trường. `assertScannable()` sẽ throw nếu ai đó thử.
- **Không fork `qr-token` cho từng app.** Scanner offline bất đồng với server về chữ ký sẽ từ chối sinh viên thật ngay tại booth.
- **Không chèn logo vào giữa QR, không đổi màu.** Logo ăn đúng phần dự phòng sửa lỗi mà ECC-Q vừa được nâng lên để có.

Khoá HMAC nằm trong biến môi trường, **không bao giờ trong database và không bao giờ trong git**. Mỗi sự kiện một khoá (`events.token_key_id` cho biết dùng khoá nào).

## App PG — vì sao nó được xây như vậy

Đây là mảnh lớn nhất và rủi ro nhất của dự án. Ba quyết định định hình toàn bộ:

**Hàng đợi là nguồn sự thật trên máy, server là thứ đối chiếu sau.** PG quét,
thấy kết quả dưới 150ms, đi tiếp. Có mạng hay không tại khoảnh khắc đó không
phải việc của họ. `packages/scan-queue` tách rời khỏi trình duyệt — lớp lưu trữ
được tiêm vào — nên logic quan trọng nhất dự án test được bằng Node, không cần
giả lập IndexedDB. Có bài test mô phỏng **mất mạng một tiếng, 60 lượt quét,
không mất lượt nào**, và bài test khẳng định gửi lại cùng một batch **không tạo
badge thứ hai**.

**Không bao giờ hiện "thành công" trơn.** Mỗi kết quả mang `~` (đã ghi trên máy
này) hoặc `✓` (server xác nhận). Gộp hai thứ này là cách một PG tự tin nói với
sinh viên "bạn có 5 badge" từ một máy chưa đồng bộ từ 9h15.

**Quét trùng ra màu hổ phách, không phải màu đỏ.** Đây sẽ là kết quả phổ biến
thứ nhì cả ngày. Coi nó là lỗi sẽ dạy PG bỏ qua màu đỏ, và lỗi thật sẽ lọt lưới.

Ba thứ nữa đáng biết trước khi sửa app PG:

- **Webview Zalo bị chặn ở màn nhận máy.** Thẻ thiết bị sẽ được chụp và gửi qua
  Zalo; PG bấm link; Zalo mở trong webview của nó và camera không hoạt động.
  `environment.js` phát hiện và **chặn hẳn** kèm hướng dẫn — đây là lỗi tôi cho
  là dễ xảy ra nhất trong ngày sự kiện.
- **iPhone: cài vào màn hình chính TRƯỚC khi nhập mã.** Claim trong Safari rồi
  mới cài sẽ cho PWA một kho lưu trữ riêng và PG phải nhập lại từ đầu.
- **Camera tự tắt sau 8 giây không quét được.** Khi có hàng thì nó không bao giờ
  kích hoạt; phần tiết kiệm pin đến từ các khoảng trống, vốn chiếm phần lớn ngày.

## Hai ràng buộc thực tế định hình thiết kế

**Không có máy in tem tại điểm.** Nên tra cứu thủ công không còn là dự phòng mà là **đường chính thứ hai**, và `vn-text` được làm cho đúng tầm đó: một ô nhập tự nhận diện PG đang gõ mã 6 ký tự, số điện thoại, MSSV hay tên; tìm không dấu; chạy offline; ~1,8ms trên 2.000 dòng nên gõ tới đâu lọc tới đó. Sinh viên hết pin vẫn nhận được badge — PG tra bằng tên, mất ~15 giây thay vì 3 giây.

**PG dùng điện thoại cá nhân.** Kéo theo: phải chặn webview Zalo (link gửi qua Zalo mở trong webview của nó sẽ hỏng camera và service worker), phải nhúng bộ giải mã WASM vì iOS không có `BarcodeDetector`, hàng đợi offline chỉ đẩy được ở tiền cảnh vì iOS không có Background Sync, và **render QR thật to** trên máy sinh viên để bù cho camera không lấy nét gần được.

Kèm một bẫy iOS phải nằm trong kịch bản briefing: claim mã thiết bị trong Safari rồi mới "thêm vào màn hình chính" sẽ khiến PWA có kho lưu trữ riêng và phải claim lại. Thứ tự đúng là thêm vào màn hình chính trước, mở PWA, rồi mới nhập mã.
