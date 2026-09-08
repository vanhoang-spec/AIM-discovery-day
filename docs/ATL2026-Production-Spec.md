# ATL2026 — Production Spec
### Web-app đăng ký, quét badge & tracking Discovery Day / Grand Finale

**Phiên bản:** 1.2 · **Ngày:** 26/08/2026 · **Chủ dự án:** Blue (Phong Nguyen) · **Repo:** `AIM-discovery-day`
**Đối tượng đọc:** dùng làm brief làm việc trực tiếp với Claude Code — mỗi mục AC có thể copy thành 1 task.

---

## 0. Cách dùng tài liệu này

Mỗi mục **AC (Acceptance Criteria)** viết theo dạng "Given / When / Then" hoặc checklist — có thể paste thẳng vào Claude Code làm task brief. Mục nào chưa có AC nghĩa là chưa đủ thông tin để code — **phải chốt với AIM trước khi giao việc**, đừng để Claude Code tự đoán.

Trạng thái: `⬜ Chưa bắt đầu` · `🟨 Có nền, thiếu giao diện` · `✅ Xong + có test` · `🔒 Chờ quyết định con người`

> **Tài liệu này sống trong repo** (`docs/`), không nằm rời trên máy cá nhân. Cập nhật trạng thái AC ngay khi hoàn thành để spec và code không lệch nhau. Bản trong `Downloads/` coi như đã hết hiệu lực.

### 0.1 Đã sửa gì so với v1.0

v1.0 được đối chiếu từng mục với repo thật ngày 25/08. Bảy chỗ vênh, năm AC thiếu:

| # | Sửa gì | Vì sao quan trọng |
|---|---|---|
| 1 | **AC1 — phạm vi chống trùng** đổi từ `(SĐT, sự kiện)` thành **toàn campaign** | Làm đúng theo chữ v1.0 sẽ phải đổi unique index và viết lại `register_student`, khiến cùng một người có **2 mã QR khác nhau** cho 2 sự kiện — phá thiết kế đã có test |
| 2 | **AC1 — bỏ câu "MSSV *hoặc* chưa đi làm"** | Hai trường không liên quan nhau. MSSV bắt buộc; công ty đang làm việc là tuỳ chọn |
| 3 | **AC5 / 4.5 / 🔒 — gỡ SMS** | SMS đã quyết bỏ 25/08. v1.0 dựng nó thành **điều kiện no-go**, tức spec sẽ chặn go-live vì một thứ đã cố ý cắt |
| 4 | **Thêm §1.4 pin cứng ngưỡng badge** | Wireframe v0.1 dùng ngưỡng cũ 2/4/6; số đã chốt là **2/5/7, y=6**. Đơn hàng quà phụ thuộc con số này |
| 5 | **Bảng test 4.1: 99 → 114**, thêm dòng `registration` | Spec là nguồn giao việc; con số sai làm mất niềm tin vào phần còn lại |
| 6 | **Viết lại §5.1** — bỏ Vercel Git integration | v1.0 nói preview tự deploy qua Git integration, mâu thuẫn với chính cảnh báo ngay dưới nó và với yêu cầu "chỉ deploy khi tôi cho phép" |
| 7 | **Thêm AC32–AC36** | Ba yêu cầu gốc của AIM trong file DOCX **không có AC nào** (trang lịch, export Excel tổng, CRUD hoạt động); hai AC còn lại do cả hai bản đánh giá độc lập cùng nêu |
| 8 | **Thêm §3.0 bản đồ AC → hạn → khoá** | v1.0 là backlog phẳng trong khi deadline có hai nhánh |

### 0.2 Đã sửa gì so với v1.1 (26/08 — sau khi nhận Ver02 của AIM)

AIM gửi DOCX Ver02 với 4 điểm mới (đánh dấu xanh). Đối chiếu + chốt trực tiếp với khách:

| # | Nguồn | Thay đổi |
|---|---|---|
| 1 | Ver02 §025 ">70% hoạt động mới nhận quà đặc biệt" | **Hai thang đếm badge** — xem §1.5 mới. Mẫu số chốt với khách: 1 check-in + 5–7 booth (N=6–8). Migration `0006`/`0007`, AC37 |
| 2 | Ver02 §024 "app check-in offline cho ~40 PG" | Đã là thiết kế lõi — AC10–AC13 `✅` |
| 3 | Ver02 §021 "admin xem real time để điều phối PG" | AC35 giữ nguyên; ghi chú: PG offline ↔ dashboard real time là mâu thuẫn vận hành — dashboard luôn ghi "dữ liệu tính đến HH:MM" |
| 4 | Ver02 §026 "thông báo đủ điều kiện Meet & Greet (optional)" | AC38 mới, optional đúng như khách ghi |
| 5 | Trạng thái | AC5 email `✅` (worker + template + cron) · AC32 trang lịch `✅` (2 route tĩnh ISR 60s) · AC14b /toi tiến độ `✅` · test 185 → **211** |

---

## 1. Mục tiêu

### 1.1 Mục tiêu sản phẩm
Xây hệ thống đăng ký, phát QR, quét badge tại booth, đổi quà theo bậc, và báo cáo — vận hành ổn định cho **1.500–2.000 sinh viên/điểm**, tại **2 điểm song song** (FTU Hà Nội, FTU HCM) ngày **12/09/2026**, tái sử dụng nguyên trạng cho Grand Finale **01/11/2026**.

### 1.2 Mục tiêu kỹ thuật (không thương lượng)
- **Tính đúng đắn do database bảo đảm**, không do quy trình con người: không đổi trùng badge, không vượt kho quà, đúng N suất khi cap = N.
- **App PG (quét) chạy 100% offline-first.** Mất sóng sân trường không được làm mất một lượt quét nào.
- **App sinh viên chịu được tải 4G nghẽn**: màn QR chạy 0 request mạng sau khi tải lần đầu.
- Chỉ **một luồng bắt buộc online**: giữ suất cho hoạt động đặc biệt (vì cap là trạng thái toàn cục).

### 1.3 Ngoài phạm vi (đã chốt, không code)
| Hạng mục | Thay bằng |
|---|---|
| Bán vé Grand Finale | Nền tảng Events Box có sẵn của AIM |
| Live quiz SSC finale | Kahoot/Slido, app chỉ lọc danh sách đủ điều kiện |
| Tài khoản riêng cho nhà tài trợ | AIM cấu hình hộ, gửi link báo cáo chỉ-đọc |
| App native | PWA only — điều kiện hợp đồng: không NTT nào được bắt SV cài app |
| Hàng chờ ảo, websocket, chấm điểm tự động | Không làm — đã cân nhắc và bác |
| **SMS brandname** *(bỏ 25/08)* | Tra cứu bằng **số điện thoại** phía PG, chạy offline. Cột `events.sms_enabled` giữ lại, mặc định `false` — nếu test inbox 01/09 hỏng thì bật một boolean, không cần migration |

**Vì sao bỏ SMS được:** badge cổng cần *nhận diện được* sinh viên, không cần sinh viên *có QR trong tay*. PG tra số điện thoại (entropy cao, chạy offline) xử lý được nhóm đến tay không. SMS mua **tốc độ cổng**, không mua **quyền vào**. Tiết kiệm 3–6 triệu/sự kiện.

### 1.4 Cấu hình đã chốt — pin cứng, không để rải rác

Đây là các con số **sinh ra mọi thứ khác** (đơn hàng quà, cân bằng trò chơi). Đừng lấy số từ wireframe hay PDF cũ.

| Tham số | Giá trị chốt | % SV đạt |
|---|---|---|
| Bậc 1 (x) | **2 badge** | ~83% |
| Bậc 2 (x+1) | **5 badge** | ~19,5% |
| Bậc 3 (x+2) | **7 badge** | ~4% |
| y — mở hoạt động đặc biệt | **6 badge** | ~9,5% (cạnh tranh 3,2:1) |

| Kho quà | Bậc 1 | Bậc 2 | Bậc 3 | Suất đặc biệt |
|---|---|---|---|---|
| HN (2.000 SV) | 1.750 | 430 | 90 | 60 |
| HCM (1.180 SV) | 1.030 | 255 | 55 | 40 |

Tính ngược từ **tổng cung 6.025 badge** sau khi áp 4 đòn bẩy miễn phí (check-in cổng, survey, dự session, cắt pitch ≤45s), đã gồm ngân sách 300 badge Giờ Vàng và 500 Early Bird. HCM cap đăng ký ~1.800 (sức chứa sân 1.000).

> ⚠️ Hiệu chỉnh lần cuối tại tổng duyệt 10/09 bằng số đo thật: bấm giờ 25 lượt mỗi zone, tính từ lúc SV **bước vào vị trí phục vụ**, không tính thời gian xếp hàng.

### 1.5 Hai thang đếm badge (chốt 25/08, theo Ver02 §025)

Ver02 thêm luật *"quà đặc biệt chỉ dành cho người tham gia >70% hoạt động"*. Mẫu số chốt với AIM: **1 check-in cổng + mỗi booth 1 badge, 5–7 booth → N = 6–8**. ">70%" là câu chính sách; thứ chạy trong hệ thống là **con số tuyệt đối** nó quy ra:

| Số booth | N | >70% quy ra | Trùng với |
|---|---|---|---|
| 5–6 | 6–7 | **≥ 5** | đúng ngưỡng bậc 2 |
| 7 | 8 | **≥ 6** | đúng ngưỡng y |

Hệ quả là **hai thang đếm khác nhau** (migration `0006` + `0007`):

| Thang | Cột | Đếm gì | Vì sao |
|---|---|---|---|
| Bậc quà 1/2/3 | `badge_count` | **mọi** badge: booth, cổng, session, lớp, Early Bird, Giờ Vàng | Giữ đòn bẩy session sống; đơn hàng 1.750/430/90 giữ nguyên |
| Quà đặc biệt / Meet & Greet | `core_badge_count` | **chỉ** cổng + sponsor/diamond booth | Đúng thứ NTT trả tiền: muốn nhận phải đi gần hết gian hàng |

- Checkpoint loại `bonus` (Early Bird, Giờ Vàng) **không bao giờ** vào thang đặc biệt.
- View `v_special_threshold_check` là chuông báo: NTT rút booth tuần cuối làm y lệch khỏi chính sách >70% thì view hiện mismatch — **chỉ báo, không tự đổi y** (đổi ngưỡng giữa sự kiện là quyết định con người).

---

## 2. Actor & phạm vi truy cập

| Actor | App | Thiết bị | Đăng nhập |
|---|---|---|---|
| Sinh viên | SV-APP (PWA) | Điện thoại cá nhân, đa dạng | Không tài khoản — link cá nhân + QR |
| PG (promotion girl/boy) | PG-APP (PWA riêng origin) | Điện thoại cá nhân (BYOD) | Mã thiết bị 6 ký tự + PIN 4 số |
| Supervisor tại điểm | ADMIN (mobile view) | Điện thoại/tablet | Tài khoản Supabase Auth |
| AIM / Flow Marshal | ADMIN (desktop) | Laptop | Tài khoản Supabase Auth, role admin |
| Nhà tài trợ | Không có app | — | Nhận file Excel qua email, không truy cập hệ thống |

---

## 3. Acceptance Criteria theo module

### 3.0 Bản đồ AC → hạn → khoá

Deadline có **hai nhánh**, không phải một backlog phẳng.

| Nhánh | AC | Hạn | Bị khoá bởi |
|---|---|---|---|
| **Đăng ký** | AC1–AC9, **AC32** | **30/08** | 🔒 danh sách trường (AC1) · code AC5+AC32 `✅`, còn DNS email |
| **Vận hành ngày sự kiện** | AC10–AC17 | 09/09 | **không có 🔒 nào** |
| Quà & suất | AC18–AC24 | 09/09 | *(ngưỡng đã chốt ở §1.4 — hết khoá)* |
| Đối soát & báo cáo | AC25–AC28, AC33–AC36 | 09/09 | 🔒 pháp lý (chỉ AC27) |
| Cấu hình | AC29–AC31 | 09/09 | *(UI đã đủ — zone/bậc quà/suất/PG tạo được từ admin; chỉ còn chờ 🔒 nội dung danh sách booth/zone từ AIM để nhập)* |

> **AC10–AC17 (app PG) là module lớn duy nhất không bị khoá bởi bất kỳ 🔒 nào** — trong khi nó cũng là mảnh lớn nhất và rủi ro nhất (offline queue, chặn webview Zalo, decoder WASM, device claim + PIN). Nó không thể bắt đầu muộn mà kịp 09/09. **Đây là chỗ nên code tiếp theo**, không chờ AIM gỡ các khoá còn lại.

### 3.1 Đăng ký (SV-APP)
Nền tảng: `✅` schema `0004_registration.sql` · `✅` form `/dang-ky` · `⬜` email

- **AC1** `🟨` — Given sinh viên chưa đăng ký, When điền form (họ tên, SĐT, email, trường — tìm không dấu, MSSV **bắt buộc**, công ty đang làm việc **tuỳ chọn**, 2 checkbox đồng ý không tick sẵn), Then:
  - chống trùng **theo phạm vi campaign**, không theo từng sự kiện — `students_email_unique` và `students_phone_unique` không chứa `event_id`;
  - đăng ký sự kiện **thứ hai** với cùng email/SĐT trả `linked` và **giữ nguyên mã QR cũ** — một người, một mã, dùng cho cả Discovery Day lẫn Grand Finale;
  - đăng ký **lại cùng một sự kiện** trả `already_registered` (chặn bởi PK `(student_id, event_id)`) — đây chính là luồng "gửi lại mã QR";
  - **không** chặn theo tên.
  🔒 chờ danh sách trường thật để seed.
- **AC2** `🟨` — Given đăng ký theo đội thi (2 thành viên), When một thành viên đã có trong đội khác của cùng sự kiện, Then từ chối kèm thông báo rõ lý do bằng tiếng Việt (không phải mã lỗi số). *(hàm `register_team` đã có + test; thiếu giao diện)*
- **AC3** `✅` — Given form đang điền dở, When người dùng thoát ngang giữa chừng, Then lần quay lại (cùng thiết bị) khôi phục được dữ liệu đã nhập — lưu nháp local, không cần đăng nhập.
- **AC4** `✅` — Given submit thành công, When trong vòng 1 giây, Then màn hình hiện QR ngay tại chỗ (không chờ email) + mã 6 ký tự in dưới QR + nút "Lưu ảnh mã QR".
- **AC5** `✅` — Given submit thành công, When server ghi DB xong, Then đẩy **1 email** (QR đính kèm PNG **thật qua cid**, không hotlink — Gmail chặn ảnh remote mặc định) vào `notification_outbox` và **trả response ngay**. Worker `/api/cron/outbox` chạy mỗi phút qua Vercel Cron, claim bằng SKIP LOCKED, retry thuộc riêng outbox (backoff 1→2→4 phút, đỗ `failed` sau 8 lần). *(`packages/email` 13 test; SMS đã bỏ — xem §1.3.)* 🔒 **còn chờ**: domain + DNS SPF/DKIM/DMARC + `RESEND_API_KEY` thật — code xong không có nghĩa email tới inbox.
- **AC6** `🟨` — Given form trên mạng 4G nghẽn, When submit, Then retry tự động tối đa 3 lần với backoff, hiện trạng thái "đang gửi" rõ ràng, và **bấm nhiều lần không tạo bản trùng** — vì server coi mọi lần submit lại là luồng gửi lại mã. *(client retry `✅`; cần test throttle Slow 3G)*
- **AC7** `✅` — Given walk-in tại cổng chưa đăng ký trước, When quét QR poster mở `/dang-ky?nhanh` trên **máy của chính sinh viên**, Then form 4 ô (tên, SĐT, trường, MSSV) + 1 checkbox đồng ý → QR hiện ngay như AC4, nút "LẤY MÃ QR NGAY". Email **tuỳ chọn** — SĐT là danh tính; không email thì outbox tự bỏ qua (không xếp mail cho địa chỉ không tồn tại). Nguồn ghi `walk_in` để báo cáo tách được. Gửi lại cùng SĐT = luồng gửi lại mã.
  *Vì sao trên máy SV chứ không phải máy PG: không có máy in — mã QR phải nằm trên máy sinh viên để dùng cả ngày, và SV gõ tên mình trên bàn phím của mình nhanh hơn PG gõ hộ. Máy PG chỉ chỉ tay vào poster.*
  *Poster: in QR trỏ `https://<domain>/dang-ky?nhanh` — hạng mục in ấn, thuộc gói vận hành.*

### 3.2 Nhắc lịch (ADMIN → email, tự động)
- **AC8** `🟨` — Given SV đã đăng ký, When đến D-3, D-1, và 07:00 sáng ngày sự kiện, Then tự gửi email nhắc, throttle ~500 email/giờ, ghi log bounce. *(bảng outbox + `claim_outbox_batch` + worker + template nhắc D-3/D-1/sáng-D `✅`; thiếu: job đẩy hàng loạt vào outbox theo mốc ngày — một câu INSERT có điều kiện, chạy tay hoặc cron)*
- **AC9** `🟨` — Given một email bounce cứng, When lần gửi tiếp theo tới cùng địa chỉ, Then **không** gửi nữa và đánh dấu để supervisor xử lý tay. *(`finish_outbox` park sau 8 lần thử `✅`; thiếu webhook bounce của Resend)*

### 3.3 Check-in cổng (PG-APP) — `✅` lõi + giao diện, 28 test schema + 43 test client
- **AC10** `✅` — Given PG mở chế độ "quét liên tục" tại cổng, When quét QR hợp lệ chưa check-in, Then cấp badge check-in trong **<150ms cảm nhận** (phản hồi local trước, đồng bộ server sau), phát âm thanh + rung + hiện tên — **không có màn xác nhận yêu cầu bấm tiếp**.
- **AC11** `✅` — Given quét lại QR đã check-in rồi, When quét, Then hiện màu **hổ phách** "đã check-in lúc HH:MM" — **đây không phải lỗi, không phát âm lỗi**. Coi nó là lỗi sẽ dạy PG bỏ qua màu đỏ, và lỗi thật sẽ lọt lưới.
- **AC12** `✅` — Given SV đến trước 08:45, When check-in, Then tự cộng thêm 1 badge "Early Bird" **trong cùng một lượt quét** (không phải quét 2 lần). *Cần migration mới: cột giờ cắt trên `events` + loại badge riêng.*
- **AC13** `✅` — Given máy PG ở chế độ máy bay, When quét 2.000 lượt liên tục, Then không mất lượt nào; khi có mạng lại hàng đợi tự đẩy theo thứ tự, và **không lượt nào tạo 2 bản ghi trên server**. *(nền tảng `✅`: `scan_uid` do client sinh làm khoá chính)*

### 3.4 Vòng lặp booth (PG-APP + SV-APP) — `⬜`
- **AC14** `🟨` — Given SV đang xếp hàng tại 1 zone, When mở /khao-sat trong lúc chờ, Then làm được survey ≤8 câu ngay tại chỗ; `response_uid` sinh MỘT lần mỗi lượt và giữ nguyên qua các lần bấm lại — mạng chập chờn cứ bấm gửi lại, server nuốt replay. Survey trong hàng **không tiêu tốn công suất trạm** — badge duy nhất tăng cung mà không tăng tải. *(Đã có: danh sách + form + màn COMPLETE có vòng pulse sống để nhân viên booth phân biệt màn hình thật với ảnh chụp. Chưa có: "việc tiếp theo nên làm" + bản đồ sân.)*
- **AC14b** `✅` — Given SV mở /toi, When máy có mạng, Then thấy: số badge + "Cập nhật HH:MM", còn thiếu mấy badge tới bậc kế, bậc nào **ĐÃ HẾT** (chỉ ok/low/out — không bao giờ hiện số kho chính xác), và điều kiện hoạt động đặc biệt đọc **thang core** kèm câu giải thích. Auth = chính token QR (HMAC), không session. Poll 30s chỉ khi tab hiện. Mất mạng → QR vẫn render từ cache trước, kèm snapshot tiến độ cuối có giờ.
- **AC15** `🟨` — Given PG quét badge tại bàn thoát của 1 checkpoint, When SV chưa có badge zone này, Then cấp 1 badge; **unique index chặn** SV có 2 badge cùng 1 checkpoint dù 2 PG quét cùng lúc. *(ràng buộc DB `✅` trong `0002_ledger.sql`)*
- **AC16** `✅` — Given booth đặt `badge_award_mode`, When SV nộp khảo sát, Then `submit_survey_response` ghi câu trả lời VÀ gọi `record_scan` nguồn `survey` **trong cùng một transaction** — mode `survey_complete`/`either` cấp badge ngay, `both_required` chờ thêm lượt quét PG (record_scan sẵn có xử lý cả bốn mode; survey không mọc logic cấp riêng). Màn COMPLETE hiện tên + mã cho nhân viên đối chiếu khi mode yêu cầu gặp người.
- **AC17** `✅` — Given zone đang rảnh, When supervisor bấm ⚡ trong tab Tổng quan, Then mọi badge **booth** được cấp tại zone đó kèm thêm 1 badge thưởng; tự tắt khi hết 40 phút **HOẶC** phát đủ 80 badge **HOẶC** hết ngân sách ngày (300) — **3 nắp đều là predicate DB trong `record_pg_scan`, không phải hẹn giờ client** (migration `0008`, 18 test).
  Badge thưởng là **dòng riêng trên checkpoint `bonus` theo zone** — không nhân số đếm (bất biến "một checkpoint = một badge" giữ nguyên), mỗi SV tối đa 1 thưởng/zone/ngày nhờ đúng unique index đó, đếm **thang quà** và không đếm thang đặc biệt (§1.5). uid thưởng suy ra từ uid gốc nên batch replay không nhân đôi.
  **Kênh báo SV đã đổi so với v1.0: KHÔNG banner trong app SV** — bắn thông báo cho 2.000 người để phát 80 badge tạo đúng cơn dồn cục mà tính năng này sinh ra để giải quyết. Kênh: MC + biển zone + banner trên máy PG (đi ké response sync, không tạo nhịp mạng mới) + PG đọc một câu khi quét.

### 3.5 Quầy đổi quà (PG-APP chế độ quầy + SV-APP)
Nền tảng: `✅` schema `0003_rewards.sql` + 18 test · `⬜` giao diện

- **AC18** `⬜` — Given SV đủ điều kiện 1 bậc quà, When mở app trước khi tới quầy, Then thấy rõ "bạn còn thiếu gì" — cập nhật theo badge thật, không phải số tĩnh. Màn này loại ~25% người không đủ điều kiện **trước khi** họ xếp hàng.
- **AC19** `🟨` — Given 1 bậc quà đã hết kho, When bất kỳ ai submit đổi quà bậc đó, Then **request bị từ chối ở tầng DB** (`UPDATE ... WHERE stock_issued < stock_total` + CHECK), và SV-APP hiện "ĐÃ HẾT" ngay khi cạn. *(ràng buộc DB `✅`; thiếu giao diện)*
- **AC20** `🟨` — Given 2 quầy thao tác đổi quà cùng lúc cho cùng 1 SV cùng 1 bậc, When cả hai submit gần như đồng thời, Then chỉ **đúng 1** giao dịch thành công. *(unique index + hoàn kho khi conflict `✅`; test tranh chấp đa kết nối xem T2)*
- **AC21** `🟨` — Given mất mạng tại quầy quà, Then /qua hiện cảnh báo chuyển hẳn sang luồng giấy: giám sát + **vòng tay giấy phân màu theo bậc** (không phải dấu mực — mực nhoè sau 20 phút mồ hôi), nhập lại qua màn Đối soát (AC26).
  *Quyết định có chủ đích: KHÔNG build hàng đợi offline cho phát quà. App ghi nhận offline tạo cảm giác an toàn giả — hai quầy offline vẫn có thể cùng phát cuốn sổ cuối; vật kiểm soát thật là vòng tay. PIN supervisor để bật chế độ cũng bỏ theo — chế độ giấy không cần app cho phép.*

### 3.6 Hoạt động đặc biệt — luồng online bắt buộc
- **AC22** `✅` — Given cap N suất, When SV giữ chỗ, Then giữ tối đa 90 giây rồi tự nhả nếu không xác nhận (2-phase hold), và tổng suất phát ra **không bao giờ vượt N**. *(`hold_special_slot`/`confirm_special_slot` `✅` + màn /suat trên app PG: quét/gõ → điều kiện đọc THANG CORE kèm câu giải thích → GIỮ CHỖ với đồng hồ 90s → XÁC NHẬN → số suất to để đọc. Retry một confirm đã xong trông như thành công, không phải lỗi.)*
- **AC23** *(test bắt buộc — xem T1)* — 500 client giả lập tranh 200 suất → đúng 200 thành công, **10/10 lần** trên Supabase thật.
- **AC24** `✅` — Given mất mạng tại điểm hoạt động đặc biệt, Then /suat chuyển thành **màn CHẾ ĐỘ GIẤY toàn màn hình** — không phải banner cảnh báo: 4 bước sổ vé đánh số, không có nút quét nào còn bấm được. App nửa-chạy-offline ở quầy này là app hứa thừa suất trước mặt NTT; app từ chối to thì không.

### 3.7 Đối soát & báo cáo (ADMIN) — `⬜` giao diện
- **AC25** `🟨` — *(dashboard /admin đã hiện: drift tile, hàng đợi + sync từng máy PG — còn thiếu màn nhập vé giấy)* Given hết giờ sự kiện, When supervisor mở màn đối soát, Then thấy: hàng đợi từng máy PG đã xả về 0 chưa, số giao dịch break-glass cần nhập tay, và view tự phát hiện lệch số. *(`v_progress_drift` `✅` trong `0002_ledger.sql`)*
- **AC26** `✅` — Given giao dịch break-glass đã ghi giấy, When supervisor nhập lại ở tab Đối soát, Then bản ghi đi qua **đúng hàm của quầy thật** (`claim_gift_tier` với `was_offline=true`, hold+confirm cho suất) — không ghi đè, không insert thô. Vé trùng hoặc vượt kho bị **từ chối kèm hướng xử lý** ("vé giấy trùng, kiểm tra lại sổ") — 409 ở màn này là tính năng: đó là cách bắt lỗi sổ giấy. Kèm cảnh báo máy PG còn hàng đợi chưa xả trước khi chốt sổ.
- **AC27** `🟨` 🔒 — Given cần xuất báo cáo cho 1 NTT cụ thể, When admin bấm "Excel NTT" trên dòng gian hàng, Then file chỉ gồm SV **đã tick đồng ý chia sẻ VÀ đã ghé đúng gian hàng đó** — người khác không xuất hiện dưới bất kỳ dạng nào, kể cả ẩn danh; 3 sheet: tổng quan, lượt ghé theo giờ, danh sách liên hệ đã đồng ý. Posture ngược với AC33 (nội bộ, đủ PII) — hai route riêng, không bao giờ gộp. *Sheet survey chờ Track 3. Vẫn 🔒 pháp lý xác nhận phạm vi chia sẻ trước khi GIAO file thật cho NTT.*
- **AC28** `✅` — Given cần chạy Grand Finale 01/11, When admin điền form nhân bản (tab Cấu hình), Then MỘT thao tác copy toàn bộ cấu hình — zone, checkpoint (giờ tự dịch theo chênh lệch ngày), bậc quà, suất, ngưỡng — sang `event_id` mới. **Không copy**: người, lịch sử, kho đã phát, và trạng thái mở đăng ký — bản sao sinh ra ĐÓNG, mở là quyết định riêng. *(`clone_event` 0009, 10 test — gồm bài "clone của clone".)*

### 3.8 Cấu hình vận hành (không cứng trong code)
Ba tham số sau **phải** là dữ liệu theo `event_id`. Cột đã có; thiếu giao diện admin.

- **AC29** `✅` — Bật/tắt từng hoạt động có tính badge hay không. *(cột + nút trong tab Hoạt động, tự rebuild bộ đếm)*
- **AC30** `✅` — Survey có tự cấp badge hay không, theo từng booth. *(`checkpoints.badge_award_mode` 4 chế độ, giờ có cả đường chạy thật qua `submit_survey_response` + test cả bốn mode.)*
- **AC31** `✅` — Thang quà cộng dồn hay chỉ bậc cao nhất. *(nút đổi trong tab Cấu hình + audit)*

Chính sách đổi ngưỡng giữa sự kiện (đã cài trong /admin): **không bao giờ thu hồi quyền lợi đã cấp**. Tăng x hoặc y chạy hai nhịp — nhịp một trả dry-run kèm bán kính ảnh hưởng ("N SV mất điều kiện, M SV đã đổi quà — giữ nguyên"), chỉ `confirm: true` mới ghi; hạ kho dưới số đã phát bị chặn 409; mọi thay đổi vào audit_log với before/after.

### 3.9 AC bổ sung — yêu cầu gốc của AIM chưa có trong v1.0

- **AC32** `✅` **— Trang lịch hoạt động.** Given SV mở link trong email xác nhận, When xem lịch, Then thấy danh sách hoạt động **theo giờ** và **theo khu vực** (2 chế độ xem), có chỉ báo `Đông / Vừa / Vắng`. Đã build thành **hai route tĩnh** `/lich` và `/lich/khu-vuc` ISR 60s (một route + `?xem=` sẽ thành dynamic và mọi SV chạm origin — đúng cái bẫy cần tránh); 0 byte client JS; chip Đông/Vừa/Vắng đọc từ bảng rollup và **chỉ hiện khi có scan thật**.
  > **Thuộc mốc 30/08**, không phải mốc sau: email xác nhận trỏ tới trang này. *(Yêu cầu #3 phía SV trong DOCX gốc — v1.0 không có AC.)*
- **AC33** `⬜` **— Export Excel tổng cho AIM.** Given admin cần báo cáo nội bộ, When xuất, Then nhận file multi-sheet đầy đủ — khác AC27 vốn chỉ lo phần riêng từng NTT và đã lọc PII. Sinh bằng **job nền**, không sinh đồng bộ trong HTTP request. Dùng `.xlsx` thật, không CSV: Excel bản Việt Nam mở CSV thiếu BOM sẽ hiện `Nguyá»…n VÄƒn A` và khách sẽ báo là "sai dữ liệu". *(Yêu cầu admin #4 trong DOCX gốc.)*
- **AC34** `✅` **— CRUD hoạt động.** *(tab Hoạt động trong /admin: tạo/sửa tên, mô tả, giờ, vị trí; bật/tắt `counts_toward_badges` tự chạy `rebuild_all_progress` cả hai thang để drift tiếp tục nghĩa là "bug" chứ không phải "ai đó vừa đổi config".)* Given admin cần sửa chương trình, When mở màn quản lý, Then sửa được **tên, mô tả, thời gian** từng hoạt động, cùng zone, sức chứa, và 3 cờ ở AC29–31. *(Yêu cầu admin #5 trong DOCX gốc — AC29–31 chỉ là cờ dữ liệu, không phải màn sửa.)*
- **AC35** `🟨` **— Dashboard zone nóng/nguội.** *(tab Tổng quan: zone heat 15 phút từ rollup, phễu quà, suất đặc biệt + SV đủ điều kiện thang core, sức khoẻ thiết bị PG, drift tile, chuông >70%; poll 5s; luôn ghi "dữ liệu tính đến HH:MM:SS". Còn thiếu: nút gửi thông báo đẩy SV về zone vắng — thuộc gói bulletin.)* Given AIM cần điều phối đám đông, When mở dashboard, Then thấy zone nào đông/vắng theo 15 phút gần nhất, phễu ngưỡng quà, suất đặc biệt còn lại. **Poll 5 giây từ bảng đếm tiền tổng hợp** (`checkpoint_minute_counts`) — tuyệt đối không `COUNT(*)` trên ledger mỗi 5 giây. Kèm nút "gửi thông báo" đẩy SV về zone vắng. *(Yêu cầu admin #3 trong DOCX gốc.)*
- **AC36** `✅` **— Tra cứu SV + sửa badge thủ công.** *(tab Sinh viên: một ô tìm tự nhận diện tên/SĐT/MSSV/mã — cùng `detectQueryKind` với app PG nên hai bề mặt không bao giờ hiểu khác nhau; gỡ badge qua `void_attendance` (xoá mềm + rebuild 2 thang), cấp bù qua `record_scan` nguồn `admin_manual` — cùng một đường ghi duy nhất, không thể lách unique index; cả hai bắt buộc lý do + tên người thao tác, vào audit_log.)* Given PG quét nhầm người, When admin tra cứu SV và sửa, Then thêm/gỡ badge được, **bắt buộc nhập lý do**, ghi `audit_log`, và gỡ badge là **xoá mềm** (`voided_at`) chứ không xoá thật. Không có đường sửa thì sai số nằm lại trong báo cáo NTT vĩnh viễn. *(Cả hai bản đánh giá độc lập đều nêu; `void_attendance` đã có `✅` ở tầng DB.)*
- **AC37** `✅` **— Hai thang đếm badge** (Ver02 §025, xem §1.5). Given SV có 7 badge tổng nhưng chỉ 2 hoạt động thật (cổng + 1 booth), When giữ suất hoạt động đặc biệt, Then bị từ chối `not_eligible` — giàu thang quà không mua được vé Meet & Greet. Bậc quà 1/2/3 vẫn đếm đủ 7. *(13 test trong `two-ladders.test.js`, gồm cả watchdog >70%.)*
- **AC39** `✅` **— Survey NTT trọn gói (Track 3).** Given admin tạo khảo sát cho một gian hàng (tab Khảo sát: mỗi booth một khảo sát, tối đa 8 câu — trần là CHECK constraint không phải gợi ý UI, 4 loại câu, màu nhấn hex-only), When SV làm trong hàng chờ, Then badge theo AC16, replay an toàn, một người một lần; sửa câu hỏi tự tăng `schema_version` và **câu trả lời cũ giữ phiên bản cũ** — sponsor sửa form 11:00 không hỏng response 10:59. Kết quả tổng hợp (đếm theo phương án, không định danh) tự nối vào sheet "Khảo sát" của export NTT; danh sách liên hệ vẫn là sheet riêng chỉ gồm người đã đồng ý — sponsor thấy NGƯỜI TA TRẢ LỜI GÌ và AI CHO PHÉP LIÊN HỆ là hai câu hỏi tách rời. *(Brand kit v1 = một màu nhấn; font/logo raster hoá là scope sau 12/09.)*
- **AC38** `⬜` *(optional — đúng chữ Ver02 §026)* **— Thông báo đủ điều kiện Meet & Greet.** Given SV vừa đạt `core_badge_count ≥ y`, When mở /toi lần poll kế, Then hàng "Hoạt động đặc biệt" chuyển "Đủ điều kiện — tới quầy đăng ký" *(phần passive này đã nằm trong AC14b)*. Phần đẩy chủ động (email/push) **không làm**: 60 suất cho ~190 người đủ điều kiện — đẩy thông báo là công thức tạo cảnh chen lấn trước mặt NTT; kênh chủ động là PG đọc khi quét + MC.

---

## 4. Test Plan

### 4.1 Đã có — **266 test**, PGlite, chạy trong CI mọi push

| Bộ test | Test | Chứng minh |
|---|---|---|
| qr-token | 26 | Mint/verify token, chặn Base32 không song ánh |
| qr-render | 17 | ECC-Q, chặn nhét URL vào QR |
| vn-text | 22 | Gấp dấu, nhận diện loại truy vấn, tra cứu offline |
| **scan-queue** | **27** | Mất mạng 1 tiếng không mất lượt nào · backoff có jitter · replay không nhân đôi |
| **environment** | **16** | Chặn webview Zalo · cổng kiểm thiết bị đỗ/trượt |
| schema + ledger | 16 | Idempotency 2 lớp, ledger append-only |
| rewards | 18 | Thang quà, tồn kho nguyên tử, cấp đúng N |
| registration | 18 | Chống trùng trong transaction, outbox có backoff, walk-in không email |
| **pg-devices** | **28** | Claim thiết bị · phân quyền checkpoint · Early Bird · roster delta |
| **two-ladders** | **13** | Hai thang đếm (§1.5) · session không lọt thang đặc biệt · watchdog >70% |
| **golden-hours** | **18** | 3 nắp không thể vượt · thưởng không thể nhân đôi · replay an toàn · ngân sách ngày là hard stop |
| **xlsx-lite** | **8** | Zip round-trip · tiếng Việt nguyên vẹn theo cấu trúc · số là ô số |
| **email** | **13** | QR đính kèm qua cid, không hotlink · escape HTML · Resend protocol, lỗi không throw |
| **clone-event** | **10** | Copy cấu hình đúng · lịch sử không bao giờ theo · clone sinh ra đóng |
| **surveys** | **10** | Trần 8 câu là constraint · badge cùng transaction, đủ 4 mode · sửa 11:00 không hỏng response 10:59 |
| **ops-admin** | **6** | Cổng đăng ký chỉ chặn online (walk-in xuyên qua) · thu hồi máy chết ngay · capacity = số slot |
| **Tổng** | **266** | |

**Giới hạn đã biết:** PGlite chạy 1 kết nối → chứng minh *logic*, chưa chứng minh *đồng thời*.

### 4.2 Bắt buộc trước 05/09 (Supabase thật, đa kết nối) — `✅` chạy 04/09

Chạy bằng `npm run test:concurrency` (`scripts/concurrency.mjs`), trên một
**project Supabase nháp dùng-xong-xoá**, KHÔNG phải database sự kiện: bảng
`ledger_events` là append-only nên mọi lượt quét test sẽ nằm lại vĩnh viễn.
Bộ test tự từ chối chạy nếu không thấy bảng đánh dấu `concurrency_sandbox`.
| # | Kịch bản | Tiêu chí đạt |
|---|---|---|
| T1 | 500 client tranh 200 suất hoạt động đặc biệt | Đúng 200 thành công, **10/10 lần chạy** |
| T2 | 200 client cùng claim 1 bậc quà cho 1 SV | Đúng 1 thành công, 199 bị từ chối sạch (không lỗi 500) |
| T3 | 20 luồng quét + 20 luồng claim quà song song 60 giây | `v_progress_drift` trả 0 dòng |
| T4 | Quét lại từ hàng đợi offline (replay) 3 lần liên tiếp | Không tạo badge thứ 2, không lỗi |
| T5 | 2 PG quét cùng SV cùng checkpoint trong <100ms | Đúng 1 badge, 1 lượt trả về "đã có" |
| **T6** | **Giờ Vàng: 200 lượt quét trong đợt có nắp 80** | Đúng 80 badge thưởng, badge gốc đủ 200, đợt tự đóng |
| **T7** | **Giờ Vàng: vượt ngân sách ngày 300** | Đợt tiếp theo bị từ chối kích hoạt |

**Kết quả 04/09 — 7/7 đạt.** T1 held=200/500 (`sold_out`=300), T2 đúng 1
thành công trên 200 lượt claim (kho 49/50), T3 60 giây 17.513 thao tác 0 lỗi
0 dòng lệch, T4 `counted,replay,replay` 1 dòng ledger, T5
`counted/repeat_not_counted` 1 badge, T6 đúng 80 badge thưởng trên 200 lượt
quét PG, T7 trả `budget_exhausted`. **Không hàm nghiệp vụ nào phải sửa** —
mọi lần báo đỏ đều là lỗi trong chính bộ test.

⚠️ **Trần kết nối phát hiện khi chạy.** Supavisor chặn cứng **200 client**
(compute Micro — dashboard ghi *"cannot be changed"*), trả `EMAXCONN` chứ
không xếp hàng. Trần này đếm theo **instance Vercel đang ấm**, không phải
request đồng thời, vì client nằm trong `globalThis`. Đã thêm
`idle_timeout: 20` vào `@atl/db` để instance rảnh trả chỗ về. **Phải đo số
client đỉnh trong buổi §4.3** — chạm trần thì nâng compute Micro → Small.

### 4.2b Đo khả năng vào inbox — 05/09 (thật, 11 thư tới 3 nền tảng)

DNS Mắt Bão publish 04/09. Gửi thư thật qua đường ống production (đăng ký →
outbox → cron → Resend) tới 8 địa chỉ trên 3 hệ lọc khác nhau.

**Xác thực: hoàn hảo, không còn gì để sửa.** Header do Microsoft 365 ghi:

```
spf=pass      smtp.mailfrom=rsend.mail.awakenthelions.net
dkim=pass     header.d=mail.awakenthelions.net
dkim=pass     header.d=amazonses.com
dmarc=pass    action=none
compauth=pass reason=100          ← kết quả tốt nhất Microsoft có thể trả
```

| Nền tảng nhận | Kết quả | Chỉ số |
|---|---|---|
| **Gmail / Google Workspace** (5 địa chỉ) | **Inbox** | — |
| Microsoft 365 (`tcmbtl.com`) | **Junk** | `SCL:5` · `CAT:SPM` · `BCL:0` · BulkCategory Promotions |
| SpamAssassin / Exim (hosting Mắt Bão) | **Spam** | ghi `***SPAM***` vào tiêu đề |

Đọc chỉ số Microsoft: `SCL:5` là **vừa chạm vạch** (7–9 mới là spam
độ tin cậy cao). `BCL:0` nghĩa là **không** bị coi là thư hàng loạt.
`CAT:SPM` là spam nội dung — **không phải** `SPOOF`/`PHISH`/`DMARC`,
tức không phải lỗi xác thực. Nguyên nhân còn lại: **uy tín tên miền mới** —
cả `mail.awakenthelions.net` lẫn `app.awakenthelions.net` (tên miền trong liên kết,
Microsoft chấm nặng) đều mới sinh, gửi qua IP dùng chung của Amazon SES.

⚠️ **Kết quả âm tính đáng ghi:** bỏ `noreply` khỏi `EMAIL_FROM` và thêm
`List-Unsubscribe` đưa kiểm định Resend từ 11/12 lên **12/12 DOING GREAT**,
nhưng **không** kéo được SCL xuống dưới 5. Hai bản vá đúng và đáng giữ, song
chúng không phải nguyên nhân. Đừng kỳ vọng thêm header sẽ giải quyết việc này.

#### Nền tảng thư của các trường mục tiêu (tra MX ngày 05/09)

| Trường | Nền tảng | Dự đoán |
|---|---|---|
| **Ngoại thương (FTU)** — nơi tổ chức cả 2 điểm | Google | **Inbox** |
| KHXH&NV TP.HCM · Kinh tế–Luật (UEL) | Google | Inbox |
| Bách khoa Hà Nội · Kinh tế Quốc dân · RMIT | **Microsoft 365** | **Junk** |

Nhóm đông nhất (FTU + Gmail cá nhân) an toàn. Đa số SV Việt Nam điền Gmail
cá nhân chứ không điền email trường, nên phần phơi nhiễm nhỏ hơn bảng trên.

**Quyết định đã gỡ bỏ:** không chuyển sang tên miền con của `aimacademy.vn`.
Phương án đó chỉ đặt ra phòng khi Gmail cũng hỏng — Gmail vào inbox nên bỏ,
tránh thêm một vòng DNS và tránh đặt uy tín hộp thư chính của AIM vào rủi ro.

**Rủi ro còn lại là cú tăng sản lượng, không phải xác thực.** Tên miền mới gửi
11 thư; thư nhắc D-3 sẽ gửi ~4.000. Worker outbox chạy **40 thư/phút** nên
4.000 thư trải ra ~100 phút — nhịp lành với Gmail. **Giữ nguyên 40/phút, đừng
tăng cho nhanh.** Và **mở đăng ký sớm** để tên miền có lịch sử gửi đều cho
người thật trước ngày cao điểm — đây là lý do kỹ thuật, không chỉ marketing.

**Việc vận hành cho AIM:** nhân sự AIM dùng M365 và nhà tài trợ dùng thư doanh
nghiệp sẽ thấy thư trong Junk → thêm allow-list nội bộ. Sinh viên các trường
chạy Microsoft nên được nhắc điền Gmail cá nhân khi đăng ký.

### 4.3 Mô phỏng ngày sự kiện — chạy sớm 07/09 (kết quả thật)

Chạy trên production, **chỉ đường đọc** (ledger append-only, project nháp đã xoá
nên tải ghi chưa chạy). Tải nền 8 phút @ 36 req/s đúng hỗn hợp thật, cộng kịch
bản "nguội ≥ 30 phút rồi gọi dồn" vào `/api/refdata`.

| Đường | Kết quả |
|---|---|
| `/api/refdata` qua CDN (12.000 req) | **100%** · p95 **94 ms** |
| `/lich`, `/dang-ky` (4.300 req) | 100% · p95 ~115 ms |
| `/api/refdata` ép xuống DB, chỉ **2 req/s** | **4% thành công** · p50 = 60 s · **120 hàm treo cùng lúc** |
| Nguội → dồn 300 req qua CDN | 293 OK · **7 request treo 60 s** |
| Nguội → dồn 150 req xuống DB | **46 OK (31%) · 103 treo · 1 lỗi 500** |
| Một request để yên | **504 sau đúng 300 s** — Vercel giữ hàm treo 5 phút (Fluid Compute) |

**Nguyên nhân gốc — đã chốt bằng `pg_stat_activity`:** backend `active` chờ
`ClientRead` **7+ phút**, tất cả đang chạy câu đầu của `/api/admin/overview`. Đây là
chữ ký của client bỏ dở cuộc hội thoại: postgres.js với `max: 1` **pipeline** các
truy vấn đồng thời (`Promise.all`) lên một socket, còn **Supavisor chế độ transaction
không chịu được client pipelining**. Hai route dùng Promise.all (refdata, overview)
hỏng; cron truy vấn tuần tự không hỏng lần nào trong cùng khoảng thời gian. Fluid
Compute làm nặng thêm vì nhiều request chung một instance → chung một kết nối.
Pool backend **không** đầy (9/15) và trần 200 client **không** chạm — hai nghi can
ban đầu đều được minh oan bằng số liệu.

**Sửa (@atl/db 1.0.4):** `serializeQueries` — một statement trên dây mỗi kết nối,
không bao giờ pipeline; + `QUERY_TIMEOUT_MS = 10s` gọi `.cancel()` để nhả backend
thay vì treo tới khi Vercel thu hồi hàm sau 5 phút.

**Kiểm chứng sau deploy `be48fdd` (07/09 00:35, cùng kịch bản, cùng script):**

| Kịch bản | Trước vá | Sau vá |
|---|---|---|
| 150 request đồng thời ép xuống DB | 31% OK · p50 60 s · 103 treo | **150/150 (100%)** · p50 1,2 s · p95 1,3 s · max 1,4 s |
| 2 req/s × 120 s ép xuống DB | 4% OK · 110 timeout | **240/240 (100%)** · p50 232 ms · p95 277 ms · max 347 ms |

Không còn request nào vượt 1,5 s; không có 5xx; không có timeout. Đường DB "ép"
này là đường xấu nhất (bỏ qua CDN) — sinh viên thật đi qua CDN nên còn nhanh hơn.
Con số p50 1,2 s ở kịch bản 150-đồng-thời là do 150 request chia nhau vài instance,
mỗi instance xếp hàng tuần tự 3 câu × ~50 ms — đúng cái giá đã tính của việc bỏ
pipelining, và vẫn dưới ngưỡng p95 600 ms cho lưu lượng thật (36 req/s trải đều).

**Tải ghi — chạy 07/09 trên project Supabase nháp mới (`npm run test:write-load`,
`scripts/write-load.mjs`):** mô phỏng CẢ HAI địa điểm ở đỉnh cổng, mỗi thiết bị giữ
đúng một kết nối như một instance Vercel: 16 lane cổng × 17 người/phút, 80 PG booth
quét mỗi 15 s, 4 bàn quà mỗi 8 s, 5 phút liên tục, đi qua đúng hàm máy quét thật
`record_pg_scan` và `claim_gift_tier`.

| Thao tác | Số lượt | Lỗi | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|
| Quét cổng | 1.363 | 0 | 117 ms | **128 ms** | 173 ms | 391 ms |
| Quét booth | 1.593 (160 lượt quét lại, đúng luật không tính) | 0 | 106 ms | **126 ms** | 142 ms | 198 ms |
| Đổi quà | 150 (11 lượt "đã nhận") | 0 | 116 ms | **123 ms** | 124 ms | 177 ms |

Tổng 3.106 thao tác = **10,4 lượt ghi/giây**, ledger +2.956 dòng, `v_progress_drift`
**0 dòng**. Sàn ~110 ms là RTT laptop → Singapore; từ Vercel sin1 sẽ thấp hơn.

**Số client đỉnh chạm pooler (đo được rồi):** 104 client giữ liên tục suốt 5 phút
→ Supavisor chỉ mở **21 backend** xuống Postgres, 1–4 backend active tại mọi thời
điểm lấy mẫu. Tức là ở tải ghi thật, database gần như rảnh; thứ duy nhất tiến gần
trần là *số instance Vercel còn ấm* (mỗi cái 1 client), và `idle_timeout: 20` là
van xả cho đúng con số đó. Với 104 client, còn cách trần 200 gần một nửa — **chưa
cần nâng compute Micro → Small**; chỉ nâng nếu ngày 12/09 thấy lỗi `EMAXCONN`.

**T1–T7 chạy lại 07/09 trên schema 11 migration: 7/7 đạt.** T1 1 vòng (10/10 vòng
đã có từ 04/09, hàm `hold_special_slot` không đổi từ đó); T3 60 s = 8.302 quét +
8.416 claim song song, 0 lỗi, 0 lệch; T6 đúng 80 badge thưởng trên 200 lượt.

**Lần chạy ×2 — chiều 07/09, mọi tiêu chí nhân đôi** (báo cáo cho BTC bằng ngôn ngữ
thường: `ATL2026-Bao-cao-Kiem-tra-Tai-Gap-Doi.pdf`; `scripts/concurrency.mjs` nhận `SCALE=2`,
`scripts/write-load.mjs` nhận nhịp qua env và đếm kết nối bị pooler từ chối):

| Kịch bản (×2) | Kết quả |
|---|---|
| Nguội → dồn **600** req qua CDN | 600/600 khi giới hạn 100 song song · p50 68 ms · toàn bộ CDN HIT/STALE, **0 request chạm DB**. 600 luồng cùng lúc từ một laptop: 19 lỗi `UND_ERR_CONNECT_TIMEOUT` — phía máy đo, không phải máy chủ |
| Nguội → dồn **300** req ép xuống DB | **300/300** · p50 1,55 s · p95 2,4 s · max 7,6 s (×1: 150/150, p50 1,2 s, max 1,4 s) |
| **4** req/s × 120 s ép xuống DB | 480/480 · p50 240 ms · p95 378 ms · max 702 ms |
| Tải nền **72** req/s × 8 phút (34.560 req) | 100% mọi đường (1 lỗi phía máy đo) · p50 68–120 ms · p95 394–440 ms · p99 ~2 s chỉ ở phút cuối, khi máy đo đồng thời mở 204 client cho bài thăm dò |
| T1–T7 `SCALE=2` (1.000 / 400 / 80 luồng / 6 / 4 / 400) | **7/7** · T1 1.000 tranh 200 → đúng 200 · T3 8.583 quét + 8.559 claim / 60 s, 0 lệch · fixture chèn hàng loạt: T1 từ 183 s xuống 7 s |
| Tải ghi **×2 nhịp** (34/phút/lane, booth 7,5 s, quà 4 s · 104 client) | **6.203 thao tác / 300 s = 20,7 ghi/s** · p95 cổng 234 · booth 209 · quà 201 ms · 0 lỗi · lệch 0 · 20 backend, 1–5 active |
| Thăm dò trần: **204** client | Đúng 1 kết nối bị từ chối `EMAXCONN … limit: 200`, tức thì, không treo, không xếp hàng · 199 client còn lại 2.491 thao tác, 0 lỗi, 0 lệch · **đuôi trễ dài ra**: p95 640–740 ms, p99 ~2 s (có nhiễu máy đo). Cùng 20,8 ghi/s với dòng trên → thứ làm chậm là số client, không phải số lượt ghi |

Kết luận ×2: mọi tiêu chí đạt với biên gấp đôi; vẫn **chưa cần** nâng Micro → Small. Hai
chỗ "xấu" duy nhất đều thuộc về máy đo (một laptop không đóng giả được 600 điện thoại
bắt tay TLS cùng lúc), không thuộc về hệ thống. Trần 200 client là giới hạn cứng cần giữ
khoảng cách — ×2 thực tế dùng 104.

**Test #1 — đăng ký dồn (chiều 07/09, project nháp, `npm run test:register-load`,
`scripts/register-load.mjs`):** đường ghi đầu tiên chịu tải thật — lúc AIM đăng link và tại bàn
walk-in. `/api/register` chỉ chạy đúng một câu `register_student` (validate + vẽ QR nằm trên
Vercel), nên test ở mức hàm bao trọn phần DB của một lượt đăng ký thật.

| Pha | Kết quả |
|---|---|
| A · 500 người đăng ký cùng một giây | 500 created · 0 lỗi · 500 mã riêng biệt · 500 email xếp hàng · **cả đợt xong 2,1 s** (p50 531 ms vì 500 lượt chia 150 kết nối, mỗi kết nối xếp hàng 3–4 lượt) |
| B · 20 đăng ký/s × 300 s | 5.980 created (19,9/s thật) · 0 lỗi · p50 104 · **p95 124 ms** · p99 180 · max 337 |
| C · 200 lượt cùng một người cùng giây (double-tap, bão retry) | 1 created + 199 already_registered · đúng **1 SV, 1 đăng ký, 1 email** |
| C2 · người cũ đăng ký sự kiện thứ hai, ×100 cùng lúc | 1 linked + 99 already_registered · 1 SV, 2 đăng ký |
| D · cổng online đóng | online ×100 → 100 `closed`, không ghi gì · walk-in ×100 → 100 created (cổng đóng không giết bàn walk-in) |

Kết luận: mở đăng ký không cần ghép lịch hay giới hạn tốc độ; vòng retry sinh mã / trùng email
của `register_student` đúng dưới tranh chấp thật, không rò một dòng trùng.

**Test #3 — đứt rồi nối (08/09, project nháp, `npm run test:failover`,
`scripts/failover-drill.mjs`):** 8 "instance" ghép đúng như `createPostgres` của @atl/db
(`POSTGRES_OPTIONS` + `serializeQueries` + `QUERY_TIMEOUT_MS`), 16 lượt `record_pg_scan`/s,
sự cố gây ở giây 20. Lần đầu bản vá 06/09 gặp một cú treo THẬT chứ không phải fake trong test.

| Kịch bản | Kết quả |
|---|---|
| A · máy chủ cắt kết nối: `pg_terminate_backend` toàn bộ backend của role app giữa lúc đang ghi (Supabase restart / failover / pooler reset) | Giết 5 backend → **0 lỗi phía client**, thao tác thành công đầu tiên sau 0,1 s, 8/8 instance sống, lệch 0. Supavisor transaction mode gán backend mới trong suốt — **restart DB là vô hình với app** |
| B · mạng im lặng 30 s: proxy TCP cục bộ ngừng chuyển byte, socket vẫn mở (đúng hình dạng cú treo 06/09) | 21 thao tác trong lúc băng chết **đúng 10,0 s**, không cái nào vượt trần · nối lại **0,1 s** sau khi byte chạy · 1.104 thao tác sau đó 0 lỗi · 8/8 instance sống · lệch 0. Ledger +1.440 vs client nhận 1.431: **9 lượt máy chủ ghi xong nhưng client đã bỏ cuộc** — chính là lý do mọi lượt ghi mang `scan_uid` do client sinh: gửi lại thành `replay`, không nhân đôi (T4) |

Kết luận: không còn đường nào để một request treo tới 300 s; sau sự cố hệ thống tự lành
trong dưới một giây mà không cần ai khởi động lại gì.

**Phát hiện kèm theo — kết nối DB đang đi plaintext.** postgres.js mặc định `ssl: false`
khi chuỗi kết nối không có `sslmode` (`node_modules/postgres/src/index.js:450`). Chuỗi
trong `.env.local` không có; nếu chuỗi trên Vercel cũng vậy thì mật khẩu DB và dữ liệu SV
đi Vercel → Supabase **không mã hoá**. Đã thử trên pooler: `ssl: require` bắt tay 710 ms,
`verify-full` thất bại (chứng chỉ Supabase tự ký, muốn xác thực đầy đủ phải tải CA của họ
qua `sslrootcert`). Đề xuất: thêm `ssl: require` vào `POSTGRES_OPTIONS` — không phụ thuộc
ai gõ chuỗi kết nối thế nào — cập nhật guard.test, deploy. **Chờ quyết định.**

**Chưa đo (có chủ đích):** 4.000 email test — không gửi, vì Resend tính hạn ngạch
và domain đang cần "ấm" bằng thư thật, không phải thư test (§4.2b).

**Rule cảnh báo Vercel không kích hoạt** trong suốt 8 phút với ~920 request treo —
vì Vercel chỉ coi là lỗi khi hàm chết ở giây 300, và bộ dò bất thường cần nền lưu
lượng. Đừng trông cậy vào nó để phát hiện kiểu treo này; `QUERY_TIMEOUT_MS` mới là
thứ biến treo thành lỗi 5xx nhìn thấy được.

Tiêu chí gốc vẫn giữ nguyên bên dưới cho lần chạy đủ (có tải ghi) trước 10/09:

### 4.3 (gốc) Mô phỏng ngày sự kiện — 08/09
- Chạy song song 45 phút, giả lập tải thực (36 req/giây nền + đỉnh cổng 17 người/phút/lane).
- Tiêu chí: **p95 dưới 600ms**; gửi 4.000 email test đạt **≥95% vào inbox** trên ít nhất 3 nhà cung cấp.

### 4.4 Tổng duyệt — 10/09 (thiết bị thật, SV thật, 4G thật)
**Cổng go/no-go**, cần tiêu chí bằng số trước khi vào phòng họp:
- [ ] Đo lại thời gian phục vụ booth để chốt ngưỡng badge lần cuối (§1.4).
- [ ] 100% trong số ≥30 SV thử nghiệm hoàn tất đăng ký → nhận QR → check-in → 1 lượt quét booth mà **không cần hỗ trợ kỹ thuật**.
- [ ] Briefing PG cổng kiểm 7 bước: **0 máy** được ra trận nếu chưa qua đủ 7 bước.
- [ ] Kịch bản **bắt buộc phải có**: 3 walk-in, 2 người đăng ký *sau khi* máy PG đã cache roster, 1 điện thoại chết, 2 SV trùng họ tên. Roster trên máy PG là *ảnh chụp tĩnh* trong khi ngày sự kiện là *danh sách động* — diễn tập với roster sạch sẽ không phát hiện được khe hở này.
- [ ] Có phương án B bằng văn bản nếu không đạt (sổ vé giấy đã in, sẵn tại kho).

### 4.5 Điều kiện KHÔNG đạt → không go
Bất kỳ điều nào chưa đạt thì **hoãn tính năng đó, không hoãn cả sự kiện** — chuyển sang quy trình giấy đã thiết kế sẵn:
- ~~T1–T7 chưa xanh trên Supabase thật.~~ `✅` 7/7 ngày 04/09 — xem §4.2.
- Số client đỉnh chạm trần 200 của pooler trong buổi mô phỏng §4.3 (đo 07/09: 104 client giữ liên tục → 21 backend, còn cách trần gần một nửa — đạt).
- ~~**SPF/DKIM/DMARC chưa publish**~~ `✅` publish 04/09, đo thật 05/09:
  `dmarc=pass` `compauth=pass reason=100`, Gmail vào Inbox — xem §4.2b.
  Còn lại là uy tín tên miền mới, giảm bằng cách mở đăng ký sớm để gửi đều.
  *Ghi chú lại một câu của v1.1:* "email là kênh gửi mã duy nhất" **không**
  đúng — mã QR hiện ngay trên màn hình lúc đăng ký, lưu localStorage, và
  `/toi` render offline (AC4, AC7, AC14b). Thứ thật sự phụ thuộc email là
  **các thư nhắc D-3 / D-1 / sáng ngày sự kiện**, vốn kéo tỉ lệ đi thật.

*(v1.0 liệt "chưa có SMS brandname" vào đây — đã gỡ, xem §1.3.)*

---

## 5. Deployment Plan

### 5.1 Môi trường — mọi deploy đều thủ công, một cơ chế duy nhất

| Env | Mục đích | Trigger deploy |
|---|---|---|
| Preview | Review trước merge, test tích hợp | `workflow_dispatch` → target `preview` |
| Production | Sự kiện thật | `workflow_dispatch` → target `production`, **phải gõ `DEPLOY`** + ghi lý do |

> ⚠️ **KHÔNG connect repo trong Vercel dashboard.** Nếu bật Vercel Git integration, Vercel deploy mỗi lần push **bất kể** `deploy.yml`, và toàn bộ cơ chế duyệt tay chỉ là hình thức. Deploy preview bằng chính workflow với `target=preview` — một cơ chế, không có cửa sau.
>
> Nếu đã trót connect: Vercel → Project → Settings → Git → **tắt "Automatic deployments from Git"**.

Workflow đã có job `verify` chạy toàn bộ test **trước** khi deploy, kể cả khi chạy tay, và smoke check `GET /api/refdata` sau khi deploy xong.

### 5.2 Nhánh & quy trình merge
- `main` = trạng thái staging, luôn phải xanh (CI bắt buộc pass trước khi merge).
- Nhánh tính năng: `feature/<module>` — ví dụ `feature/pg-scanner`, `feature/admin-dashboard`.
- **Không merge thẳng vào main nếu CI đỏ** — kể cả khi gấp. Một bug lọt vào main 1 ngày trước sự kiện nguy hiểm hơn 1 tính năng thiếu.
- Code freeze: **11/09, 12:00 trưa** — sau mốc này chỉ merge hotfix đã test.

### 5.3 Biến môi trường & secrets
| Secret | Nơi lưu | Ghi chú |
|---|---|---|
| `ATL_HMAC_KEY` | Vercel env (production) | Khoá ký QR — **không bao giờ trong git, không bao giờ trong DB**. Code từ chối fallback sang khoá dev khi `NODE_ENV=production` |
| `DATABASE_URL` | Vercel env | Chuỗi Supavisor **cổng 6543**. Thiếu nó trên production thì `@atl/db` **dừng hẳn**, không rơi về PGlite (rỗng + mã máy quét demo). ⚠️ Vercel **đóng băng biến lúc build** — sửa biến xong phải **deploy lại production**, nếu không bản đang chạy vẫn không thấy |
| `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | GitHub Actions secrets | Cho workflow deploy thủ công |
| Supabase service role key | Vercel env | Chỉ server-side, không lộ ra client |
| Resend API key (`RESEND_API_KEY`) + `EMAIL_FROM` | Vercel env | Domain gửi phải là **subdomain riêng**, không dùng domain gốc |
| `CRON_SECRET` | Vercel env | Vercel Cron tự gắn header này khi gọi `/api/cron/outbox`; thiếu nó endpoint từ chối |
| `ADMIN_ACCESS_KEY` | Vercel env | Mã truy cập console /admin (v1: một mã chung cho ~3 admin AIM — đánh đổi có chủ đích, mọi thao tác vẫn ghi audit_log kèm tên người gõ). Production từ chối chạy nếu thiếu |
| `NEXT_PUBLIC_SITE_URL` | Vercel env | URL gốc dùng trong email (link /toi, /lich) |

*(v1.0 có dòng SMS credentials — đã gỡ.)*

🔒 **Chốt trước 25/8**: mua domain, tạo Vercel Pro (pin region `sin1`), tạo Supabase project vùng `ap-southeast-1`, **tắt spend cap**.

### 5.4 Runbook ngày sự kiện (12/09)
| Giờ | Việc | Người |
|---|---|---|
| 06:00 | Smoke test cả 2 điểm (`/api/refdata` trả 200) | Người trực kỹ thuật |
| 06:00–08:00 | Cả 2 điểm xác nhận có mạng, dashboard admin lên được | Người trực kỹ thuật |
| Suốt ngày | 1 người **có tên cụ thể** trực production, biết rollback qua Vercel dashboard (<2 phút) | **Chưa chốt — rủi ro số 1** |
| 17:00–18:30 | Đối soát, xả hàng đợi, nhập break-glass | Supervisor + admin |

### 5.5 Rollback
- Vercel giữ lịch sử deployment — rollback là chọn deployment trước và "Promote to Production", dưới 2 phút.
- Với migration DB: **không** viết migration phá dữ liệu đã ghi (không `DROP COLUMN`, không đổi kiểu) từ 11/09 trở đi — chỉ thêm, không sửa/xoá.

### 5.6 Bus factor — vấn đề chưa có câu trả lời
Cả 2 chuyên gia đánh giá độc lập (61/100, 52/100) đều nêu cùng một điểm: **một người viết code, không ai review**. Câu hỏi "ai sửa lỗi production lúc 9h15 sáng thứ Bảy" cần **tên người cụ thể** trước 11/09 — kể cả chỉ là hợp đồng on-call theo giờ với 1 dev backup biết đọc log Vercel và revert deployment.

---

## 6. Yêu cầu phi chức năng

| Hạng mục | Ngưỡng |
|---|---|
| First Load JS trang `/dang-ky` | Dưới ~120kB — **hiện 108 kB**, CI in bảng bundle mỗi PR |
| Phản hồi quét badge (cảm nhận, local-first) | <150ms |
| p95 API response khi tải đỉnh | <600ms |
| Vùng deploy | Singapore (`sin1` / `ap-southeast-1`) |
| Dữ liệu cá nhân | Không xuất ra file NTT nếu chưa tick đồng ý; hosting ngoài VN = chuyển dữ liệu xuyên biên giới, cần xác nhận pháp lý |
| Khả năng chịu mất mạng | PG-APP: 100% chức năng quét/tra cứu/quà booth chạy offline; chỉ hoạt động đặc biệt tạm dừng |

---

## 7. Việc cần chốt trước khi giao thêm việc cho Claude Code

Những mục 🔒 dưới đây chặn AC tương ứng — đừng giao task khi còn thiếu input này.

1. 🔒 **Danh sách trường** để seed dropdown — chặn AC1. *(34 tỉnh/thành đã seed theo danh sách sau sáp nhập 2025, cần AIM xác nhận.)*
2. 🔒 **Danh sách booth/zone + khung giờ** — chặn AC29–AC31, AC34. *(Ngưỡng badge và số lượng quà đã chốt ở §1.4 — hết khoá.)*
3. 🔒 **Xác nhận pháp lý** văn bản đồng ý + phạm vi chia sẻ với NTT — chặn AC1, AC27.
4. 🔒 **Tên người trực production** ngày sự kiện — chặn §5.4; không phải task code nhưng bắt buộc trước 11/09.

*(v1.0 có 🔒 số 3 về SMS — đã gỡ cùng với việc bỏ SMS.)*

---

*Tài liệu này sống trong `docs/` của repo. Cập nhật trạng thái AC ngay khi hoàn thành, để spec, README và code không lệch nhau.*
