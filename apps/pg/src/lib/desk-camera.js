/**
 * Camera cho hai quầy online — Quầy đổi quà (/qua) và Quầy vé hội trường (/suat).
 *
 * DIỄN TẬP 11/09 (video của AIM): quét người thứ nhất xong, bấm NGƯỜI TIẾP
 * THEO, rồi cứ vài giây màn hình lại tự nhảy về đúng người vừa rồi — không quét
 * được người tiếp theo. Nguyên nhân: cả hai màn gọi startScanner() nhưng KHÔNG
 * BAO GIỜ giữ lại cái handle nó trả về. `scannerRef.current?.stop()` gọi vào
 * null, camera không tắt, và vòng giải mã cũ cứ chạy trên thẻ <video> đã bị gỡ
 * khỏi màn hình — hết mỗi cooldown 2,5 giây nó đọc lại mã của SV cũ và mở lại
 * thẻ của SV đó. /quet không dính vì nó gán handle từ ngày đầu.
 *
 * Bộ điều khiển này giữ ba luật để lỗi đó không quay lại dưới dạng khác:
 *
 *   1. Luôn giữ ĐÚNG MỘT handle, và stop() thật sự tắt nó.
 *   2. Mỗi stop() mở một thế hệ mới; callback của thế hệ cũ bị bỏ qua — kể cả
 *      khi một camera cũ vì lý do nào đó vẫn còn thở.
 *   3. stop() gọi trong lúc camera còn đang khởi động (PG gõ tay chọn SV trước
 *      khi camera kịp sáng) thì camera đó bị tắt ngay khi nó sáng, không mồ côi.
 *
 * Trong lúc trang tra cứu một mã, việc giải mã tạm dừng. Tra xong mà màn hình
 * vẫn ở chế độ quét (mã sai, mất mạng) thì chạy tiếp nhưng GIỮ cooldown của mã
 * vừa đọc — nếu không, chính cái mã đang chìa trước camera bị đọc lại ngay
 * khung hình kế tiếp và hộp thoại lỗi bật liên hồi.
 *
 * Không phụ thuộc React: test bằng một startScanner giả (test/desk-camera.test.js).
 */

import { startScanner } from './scanner.js';

export function createDeskCamera({ start = startScanner, onState = () => {} } = {}) {
  let handle = null;   // scanner đang chạy — nhiều nhất một
  let gen = 0;         // thế hệ hiện tại; mỗi start/stop tăng một
  let pending = 0;     // thế hệ của lần khởi động đang chờ camera (0 = không có)
  let busyGen = 0;     // thế hệ đang tra cứu một mã (0 = rảnh)

  async function begin(video, onCode) {
    if (!video || handle || (pending !== 0 && pending === gen)) return false;
    const my = ++gen;
    pending = my;
    busyGen = 0;
    onState('starting');

    let self = null;
    let errored = false;
    try {
      const s = await start({
        video,
        onCode: async (code) => {
          if (my !== gen || busyGen === my) return;
          busyGen = my;
          self?.pause?.();
          try {
            await onCode(code);
          } catch {
            // Trang tự báo lỗi của nó; ở đây chỉ cần không kẹt ở trạng thái bận.
          } finally {
            if (busyGen === my) busyGen = 0;
            if (my === gen && self) self.resume?.({ keepLast: true });
          }
        },
        onError: (_err, reason) => {
          errored = true;
          if (my === gen) onState(reason === 'decoder' ? 'broken' : 'denied');
        },
        // iOS giết track khi khoá màn hình: về "Chạm để quét" thay vì đứng hình.
        onTrackEnd: () => { if (my === gen) end(); },
      });

      if (!s?.ok) {
        if (my === gen && !errored) onState('off');
        return false;
      }
      if (my !== gen) {
        // stop() đã được gọi trong lúc chờ camera: tắt ngay, không để mồ côi.
        s.stop();
        return false;
      }
      self = s;
      handle = s;
      onState('on');
      return true;
    } finally {
      if (pending === my) pending = 0;
    }
  }

  function end(state = 'off') {
    gen += 1;
    busyGen = 0;
    const h = handle;
    handle = null;
    h?.stop();
    onState(state);
  }

  return {
    start: begin,
    stop: end,
    get running() { return handle !== null; },
  };
}
