# Tiếp tục phiên làm việc

File này để mở lại công việc từ máy khác (điện thoại, máy khác, phiên cloud).
Đọc xong file này là đủ ngữ cảnh để làm tiếp mà không cần lịch sử hội thoại cũ.

**Cách dùng trên điện thoại:** mở `claude.ai/code`, chọn repo
`vanhoang-spec/AIM-discovery-day`, rồi gõ: *"Đọc TIEP-TUC.md và làm tiếp"*.

---

## Đang ở đâu (cập nhật 25/08/2026)

Commit gần nhất: `008c961` · **185 test, tất cả xanh** · CI xanh cả 3 job.

| Phần | Trạng thái |
|---|---|
| `packages/qr-token`, `qr-render`, `vn-text`, `scan-queue`, `db` | ✅ Xong |
| Migration `0001`–`0005` | ✅ Xong |
| App sinh viên — đăng ký, `/toi` | ✅ Chạy được end-to-end |
| App PG — quét, tra cứu, hàng đợi | ✅ Chạy được end-to-end |
| Email xác nhận · trang lịch hoạt động | ⬜ Chưa |
| Admin console · survey nhà tài trợ | ⬜ Chưa |

Mốc thật: **đăng ký phải live ~30/08** (không phải 12/09). Discovery Day 12/09,
Grand Finale 01/11.

---

## Quyết định mới nhất — CHƯA có trong spec, cần vá trước khi code

Ngày 25/08 phát hiện một chỗ mô tả không nhất quán: `/toi` được xây offline
hoàn toàn (chỉ đọc `localStorage`, không gọi server lần nào), nhưng bốn tính năng
sau lại ngầm giả định máy sinh viên đang online — **hết quà, zone nào đang x2,
special session, và gợi ý việc tiếp theo**.

Hai điều đó không thể cùng đúng. Cách giải đã chốt:

### Nguyên tắc nền

**Điện thoại SV không bao giờ là nơi ra quyết định — nó là màn hình hiển thị.**
Mọi quyết định thật (đủ badge chưa / còn quà không / còn suất không) xảy ra ở máy
PG hoặc server tại thời điểm SV đứng trước quầy. SV offline dẫn tới *thiếu thông
tin để tự điều phối*, **không** dẫn tới sai dữ liệu.

### Tách hai loại thông tin

| | Nội dung | Cỡ | Cách giao |
|---|---|---|---|
| **Broadcast** | hết quà · zone x2 · thông báo | ~230 byte, **giống hệt nhau cho cả 2.000 SV** | Cache ở edge, **không đụng DB** |
| **Cá nhân** | số badge, còn thiếu mấy | ~200 byte/người | Cần DB, nhưng chịu được cũ |

Vì broadcast giống nhau cho mọi người nên nó **rẻ nhất để giao, không phải đắt
nhất**. Đây là chỗ trước đây nghĩ sai.

### Kênh chính KHÔNG phải app

Ngay cả khi mạng hoàn hảo, app vẫn là kênh tệ hơn cho ba trong bốn thứ trên:

- **PG là người giao tin tốt nhất.** Mỗi SV gặp PG 2–6 lần/ngày (đó là toàn bộ
  thiết kế badge), và máy PG nằm trên mạng riêng có kiểm soát.
- **MC/loa phủ 100% sân, độ trễ 0.** Không hạ tầng nào bằng.
- **Biển vật lý đặt đúng nơi ra quyết định** (biển lật tại quầy quà) đáng tin hơn
  mọi thông báo đẩy.

**Hai thứ không nên broadcast kể cả khi mạng hoàn hảo:**

- *Giờ Vàng x2* có nắp 80 badge / 40 phút. Bắn tới 2.000 người để phát 80 badge
  tạo ra **đúng cơn dồn cục mà nó sinh ra để giải quyết**.
- *Special session* có 60 suất nhưng ~190 SV đủ điều kiện (y=6, 9,5% của 2.000).
  Báo cho cả 190 người là công thức tạo cảnh chen lấn trước mặt nhà tài trợ.

---

## Việc tiếp theo, theo thứ tự

### 1. Vá spec v1.1 (`docs/ATL2026-Production-Spec.md`)

- Thêm mục mới về tầng broadcast + nguyên tắc "máy SV là màn hình, không phải
  nguồn sự thật".
- Sửa AC Giờ Vàng: **bỏ phần banner nhắm mục tiêu đẩy xuống app SV**; giữ nguyên
  logic cấp badge thưởng và 3 nắp an toàn ở server. Kênh thông báo chuyển sang
  MC + biển zone + PG nói khi quét.
- Thêm AC cho `/api/bulletin` (xem mục 2).
- Thêm vào gói vận hành: biển lật 3 bậc quà tại quầy, 6 biển zone có khe cắm thẻ
  "×2 ĐANG DIỄN RA", agenda khổ lớn ở 4 điểm — **~1,3 triệu/điểm**.

### 2. Code phần bulletin

**Endpoint mới `GET /api/bulletin?event=<id>`**

```
Cache-Control: public, s-maxage=60, stale-while-revalidate=600
```

- `s-maxage=60` → CDN hấp thụ 2.000 request, **nhiều nhất 1 lần đọc DB mỗi phút**
  bất kể bao nhiêu sinh viên.
- `stale-while-revalidate=600` → DB trục trặc không bao giờ làm hỏng request của
  sinh viên; CDN vẫn trả bản cũ và tự làm mới ngầm.

Payload (~230 byte, **tuyệt đối không chứa dữ liệu cá nhân** — đó là điều kiện để
cache được ở edge):

```json
{
  "t": 1757640000,
  "event": 1,
  "gifts": [{"tier":1,"s":"ok"},{"tier":2,"s":"low"},{"tier":3,"s":"out"}],
  "x2":    [{"zone":"finance","until":1757641800}],
  "msg":   [{"id":9,"txt":"Talk chính 14:00 — Hội trường A"}]
}
```

**Chỉ trả `ok` / `low` / `out`, không bao giờ trả số phần còn lại chính xác.**
Nói "còn 12 phần" khi có 20 người đang xếp hàng là tự tạo ra một cuộc tranh cãi
tại quầy. `low` = dưới 15%. Đọc từ bảng rollup, không đếm sống trên ledger.

**Bên app SV (`apps/web/src/app/toi/page.js`):** render từ cache `localStorage`
trước, gọi mạng sau; luôn hiện *"Cập nhật lúc HH:MM"*. Không bao giờ để màn hình
trắng chờ mạng.

**Bên app PG:** *không* gọi endpoint riêng — nhét bulletin vào response của
`/api/pg/sync` (đã có nhịp 5 giây sẵn). Chỉ 40 máy nên không cần edge cache, và
tiết kiệm một round-trip. Sau mỗi lượt quét, máy PG hiện **đúng một dòng** để PG
đọc to, ví dụ *"Còn 1 badge nữa là đủ bậc 2"*.

> Cân chỉnh theo vị trí: ở **cổng** (chế độ quét liên tục) **tắt hẳn dòng này** —
> không có thời gian, cổng cần 8 người/phút/lane. Ở **booth** một dòng. Ở **quầy
> quà** hiện đầy đủ, vì đó là nơi ra quyết định.

**Migration mới `0006`:** bảng `announcements` (id, event_id, text, active_from,
active_until) + rollup tồn kho quà. Nhớ `#variable_conflict use_column` trong mọi
function mới.

### 3. Làm tiếp app PG — AC14–AC17

Đây là module lớn nhất **không bị khoá bởi bất kỳ quyết định nào của AIM**:
survey trong hàng · chế độ quét cổng liên tục · chế độ quét cửa RA · Giờ Vàng.

---

## Hai chỗ thật sự cần mạng (không phải 40)

| Chỗ | Vì sao bắt buộc | Cách lo |
|---|---|---|
| **Quầy quà trung tâm** | Số badge phải gộp từ mọi máy PG; máy A không biết lượt quét của máy B | 6 trạm cùng một chỗ → một router 4G riêng hoặc dây mạng |
| **Trạm suất đặc biệt** | Cap là biến toàn cục, hai máy offline không tự chia nhau đếm | Một điểm cố định + sổ vé giấy đánh số làm đường lui |

40 máy PG rong ruổi thì không cần — hàng đợi offline đã có test chứng minh.

**Thứ hỏng nặng nhất khi mạng kém không phải trải nghiệm SV, mà là dashboard của
AIM** (bản chất là view trực tiếp). Dữ liệu không mất, cuối ngày vẫn đối soát đủ.
Dashboard phải luôn ghi *"dữ liệu tính đến HH:MM"*, không giả vờ là realtime.

---

## Bẫy đã gặp — đừng gặp lại

- **Dev: mỗi app có PGlite riêng trong bộ nhớ.** Sinh viên đăng ký bên app web
  *không* xuất hiện bên app PG. Seed có sẵn 5 SV `seq` 1001–1005 để quét thử.
  Muốn chạy xuyên app thật thì trỏ cả hai vào cùng một `DATABASE_URL`.
- **`transpilePackages` biên dịch `packages/db` vào bản build.** Sửa seed xong
  phải rebuild, không thì tưởng seed không ăn.
- **Heredoc bash + tiếng Việt có dấu backtick sẽ hỏng.** Dùng Write tool hoặc
  script `.mjs` đứng riêng.
- **Ambiguous column trong plpgsql.** `#variable_conflict use_column` ở đầu mọi
  function, hoặc qualify tên bảng.
- **Deploy không tự động.** Phải vào tab Actions bấm *Run workflow*, bản
  production còn phải gõ tay chữ `DEPLOY`.
- **Giữ 185 test xanh.** Test viết theo kiểu khẳng định *điều không thể xảy ra*,
  không phải happy path.

Đọc thêm: [`CONTRIBUTING.md`](CONTRIBUTING.md) (nên soi kỹ chỗ nào, nguyên tắc đã
chốt) và [`README.md`](README.md).
