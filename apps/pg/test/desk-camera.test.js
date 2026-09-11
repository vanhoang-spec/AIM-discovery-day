/**
 * Camera của quầy quà / quầy vé — sinh từ video DIỄN TẬP 11/09.
 *
 * Triệu chứng trong video: quét SV thứ nhất, bấm NGƯỜI TIẾP THEO, khung camera
 * đen; vài giây sau thẻ của chính SV đó tự hiện lại, lặp mãi. Camera cũ không
 * bao giờ tắt và vẫn đọc mã của người vừa rồi. Các bài dưới dùng một
 * startScanner giả để ghim từng luật của lib/desk-camera.js.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createDeskCamera } from '../src/lib/desk-camera.js';

const VIDEO = {};

/** startScanner giả: ghi lại mọi lần mở camera và handle đã trả ra. */
function fakeStart({ defer = false, fail = null } = {}) {
  const calls = [];
  const fn = async (opts) => {
    const handle = {
      ok: true,
      stopped: false,
      paused: false,
      resumes: [],
      stop() { this.stopped = true; },
      pause() { this.paused = true; },
      resume(o) { this.paused = false; this.resumes.push(o); },
    };
    const call = { opts, handle, release: null };
    calls.push(call);
    if (defer) await new Promise((r) => { call.release = r; });
    if (fail) {
      opts.onError?.(new Error('fake'), fail);
      return { ok: false, stop() {} };
    }
    return handle;
  };
  fn.calls = calls;
  return fn;
}

const tick = () => new Promise((r) => setImmediate(r));

function setup(opts) {
  const start = fakeStart(opts);
  const states = [];
  const cam = createDeskCamera({ start, onState: (s) => states.push(s) });
  return { start, states, cam };
}

describe('createDeskCamera — lỗi "không quét được người tiếp theo" 11/09', () => {
  test('stop() tắt ĐÚNG camera đang chạy (trước đây gọi vào null)', async () => {
    const { start, cam } = setup();
    await cam.start(VIDEO, async () => {});
    assert.equal(cam.running, true);

    cam.stop();
    assert.equal(start.calls[0].handle.stopped, true, 'camera phải tắt thật');
    assert.equal(cam.running, false);
  });

  test('camera cũ đọc lại mã SV vừa rồi sau khi đã stop → bị bỏ qua', async () => {
    const { start, cam } = setup();
    const seen = [];
    await cam.start(VIDEO, async (c) => { seen.push(c); });
    cam.stop();

    // Đúng cảnh trong video: vòng giải mã cũ vẫn gọi onCode với mã của SV cũ.
    await start.calls[0].opts.onCode('MA-SV-CU');
    assert.deepEqual(seen, [], 'thẻ của SV cũ không được mở lại');
  });

  test('người tiếp theo: start lại mở camera MỚI và mã mới đi qua', async () => {
    const { start, cam } = setup();
    const seen = [];
    await cam.start(VIDEO, async (c) => { seen.push(c); });
    cam.stop();
    await cam.start(VIDEO, async (c) => { seen.push(c); });

    assert.equal(start.calls.length, 2);
    await start.calls[1].opts.onCode('MA-SV-MOI');
    assert.deepEqual(seen, ['MA-SV-MOI']);
  });

  test('stop() lúc camera còn đang khởi động → camera đó tắt ngay khi sáng', async () => {
    const { start, states, cam } = setup({ defer: true });
    const p = cam.start(VIDEO, async () => {});
    await tick();
    cam.stop(); // PG gõ tay chọn SV trước khi camera kịp sáng
    start.calls[0].release();

    assert.equal(await p, false);
    assert.equal(start.calls[0].handle.stopped, true, 'không để camera mồ côi');
    assert.equal(cam.running, false);
    assert.notEqual(states.at(-1), 'on');
  });

  test('hai lần bật chồng nhau lúc camera chưa sáng → chỉ mở một camera', async () => {
    const { start, cam } = setup({ defer: true });
    const p1 = cam.start(VIDEO, async () => {});
    const p2 = cam.start(VIDEO, async () => {});
    await tick();
    assert.equal(start.calls.length, 1);
    start.calls[0].release();
    assert.equal(await p1, true);
    assert.equal(await p2, false);
  });

  test('stop rồi bật lại ngay khi lần bật trước còn treo → vẫn bật được', async () => {
    const { start, cam } = setup({ defer: true });
    const p1 = cam.start(VIDEO, async () => {});
    await tick();
    cam.stop();
    const p2 = cam.start(VIDEO, async () => {});
    await tick();
    assert.equal(start.calls.length, 2, 'lần bật mới không bị chặn bởi lần đã huỷ');

    start.calls[0].release();
    start.calls[1].release();
    assert.equal(await p1, false);
    assert.equal(await p2, true);
    assert.equal(start.calls[0].handle.stopped, true);
    assert.equal(start.calls[1].handle.stopped, false);
  });

  test('đang tra mã thì dừng giải mã; tra xong vẫn ở màn quét → chạy tiếp, GIỮ cooldown', async () => {
    const { start, cam } = setup();
    let finish;
    await cam.start(VIDEO, () => new Promise((r) => { finish = r; }));
    const h = start.calls[0].handle;

    const lookup = start.calls[0].opts.onCode('MA-SAI');
    assert.equal(h.paused, true, 'không nhận mã khác khi đang tra');
    finish();
    await lookup;
    assert.equal(h.paused, false);
    assert.deepEqual(h.resumes, [{ keepLast: true }],
      'giữ mã vừa đọc, nếu không hộp thoại lỗi bật liên hồi');
  });

  test('tra xong và thẻ SV đã hiện (trang gọi stop) → không chạy tiếp', async () => {
    const { start, cam } = setup();
    await cam.start(VIDEO, async () => { cam.stop(); });
    const h = start.calls[0].handle;

    await start.calls[0].opts.onCode('MA-DUNG');
    assert.equal(h.stopped, true);
    assert.deepEqual(h.resumes, []);
  });

  test('trong lúc đang tra một mã, mã thứ hai bị bỏ qua', async () => {
    const { start, cam } = setup();
    const seen = [];
    let finish;
    await cam.start(VIDEO, (c) => { seen.push(c); return new Promise((r) => { finish = r; }); });

    const first = start.calls[0].opts.onCode('A');
    await start.calls[0].opts.onCode('B');
    finish();
    await first;
    assert.deepEqual(seen, ['A']);
  });

  test('trang ném lỗi khi tra mã → không kẹt, mã sau vẫn nhận', async () => {
    const { start, cam } = setup();
    const seen = [];
    await cam.start(VIDEO, async (c) => { seen.push(c); if (c === 'A') throw new Error('mất mạng'); });
    await start.calls[0].opts.onCode('A');
    await start.calls[0].opts.onCode('B');
    assert.deepEqual(seen, ['A', 'B']);
  });

  test('camera bị từ chối → trạng thái denied, chạm lại thì thử mở lại', async () => {
    const { start, states, cam } = setup({ fail: 'camera' });
    assert.equal(await cam.start(VIDEO, async () => {}), false);
    assert.equal(states.at(-1), 'denied');
    assert.equal(cam.running, false);

    await cam.start(VIDEO, async () => {});
    assert.equal(start.calls.length, 2);
  });

  test('bộ đọc mã hỏng → trạng thái broken (khác lời hướng dẫn với camera bị từ chối)', async () => {
    const { states, cam } = setup({ fail: 'decoder' });
    await cam.start(VIDEO, async () => {});
    assert.equal(states.at(-1), 'broken');
  });

  test('iOS giết track camera → về off, không để PG quét vào ảnh tĩnh', async () => {
    const { start, states, cam } = setup();
    await cam.start(VIDEO, async () => {});
    start.calls[0].opts.onTrackEnd();
    assert.equal(cam.running, false);
    assert.equal(start.calls[0].handle.stopped, true);
    assert.equal(states.at(-1), 'off');
  });

  test('chưa có thẻ <video> (màn đang hiện thẻ SV) → không mở camera', async () => {
    const { start, cam } = setup();
    assert.equal(await cam.start(null, async () => {}), false);
    assert.equal(start.calls.length, 0);
  });
});
