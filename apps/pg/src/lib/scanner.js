'use client';

/**
 * Camera and QR decoding.
 *
 * Two decoders because the fleet is BYOD. Chrome on Android has
 * `BarcodeDetector` natively and it is fast; iPhones do not have it at all, so
 * a WASM decoder is bundled for everyone else. The scanner must not care which
 * one it got.
 *
 * Battery is the constraint that shapes the rest. A camera held open for nine
 * hours costs roughly 18%/hour; pausing it after a few idle seconds and
 * showing a large tap-to-scan button brings that to about 6%. In a queue the
 * pause never fires because scans keep arriving — the saving comes entirely
 * from the gaps, which is most of the day.
 */

const CAPTURE = { width: { ideal: 1280 }, height: { ideal: 720 } };
const DECODE_FPS = 10;
export const IDLE_PAUSE_MS = 8000;

/* ------------------------------------------------------------------ *
 * Decoder self-test — vì "máy không phản hồi gì hết" (diễn tập 09/09).
 *
 * Hai kiểu hỏng đều CÂM nếu không tự kiểm tra:
 *
 *   1. BarcodeDetector trên một số máy Android khai "hỗ trợ qr_code" nhưng
 *      thiếu model MLKit — detect() chạy êm và không bao giờ thấy mã nào.
 *   2. Bộ đọc WASM nạp TRỄ ở khung hình đầu tiên; sau một lần deploy, trang
 *      cũ xin chunk cũ đã bị Vercel dọn → 404 mỗi khung hình, bị nuốt bởi
 *      "a bad frame is normal" → camera sáng, quét mãi không ra gì.
 *
 * Thuốc chung: một mã QR BIẾT TRƯỚC, nhúng sẵn dưới dạng ma trận bit (không
 * cần thư viện sinh QR trong bundle). Bộ đọc nào không đọc nổi nó thì hoặc
 * bị thay bằng bộ khác, hoặc báo lỗi TO cho PG — không bao giờ im lặng.
 * ------------------------------------------------------------------ */
export const SELF_TEST_PAYLOAD = 'ATL2026-SELFTEST-OK';
// qrcode.create('ATL2026-SELFTEST-OK', {errorCorrectionLevel:'M'}) — version 1, 21×21.
export const SELF_TEST_MATRIX = [
  '111111101100101111111', '100000100101001000001', '101110101101001011101',
  '101110101010101011101', '101110101010101011101', '100000101111101000001',
  '111111101010101111111', '000000000010000000000', '001111110000010111101',
  '010000011100001100110', '001111111100110111100', '100100000001111011101',
  '110011111111110110011', '000000000000110011000', '111111101100000101110',
  '100000101001100100101', '101110101101111011101', '101110101111010000000',
  '101110101101010111101', '100000100111110100000', '111111100110101010010',
];

/** Vẽ ma trận thành ảnh ImageData-like (scale 4, quiet zone 4 module). */
export function selfTestImage() {
  const scale = 4, margin = 4;
  const n = SELF_TEST_MATRIX.length;
  const size = (n + margin * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (SELF_TEST_MATRIX[y][x] !== '1') continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ((y + margin) * scale + dy) * size + (x + margin) * scale + dx;
          data[px * 4] = 0; data[px * 4 + 1] = 0; data[px * 4 + 2] = 0;
        }
      }
    }
  }
  return { data, width: size, height: size };
}

let zxing;
let nativeVerified = null; // kết quả self-test native, một lần cho cả phiên trang

/** Nạp VÀ chứng minh bộ đọc WASM ngay lúc mở camera, không đợi khung hình đầu. */
async function loadWasmDecoder() {
  if (!zxing) {
    zxing = await import('zxing-wasm/reader'); // trang cũ sau deploy: ném 404 TẠI ĐÂY, hiện rõ
  }
  const res = await zxing.readBarcodes(selfTestImage(), {
    tryHarder: true, formats: ['QRCode'], maxNumberOfSymbols: 1,
  });
  if (res?.[0]?.text !== SELF_TEST_PAYLOAD) {
    throw new Error('Bộ đọc WASM không qua được self-test');
  }
}

async function nativeDetectorWorks(det) {
  if (nativeVerified !== null) return nativeVerified;
  try {
    const img = selfTestImage();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    canvas.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
    const codes = await det.detect(canvas);
    nativeVerified = codes?.[0]?.rawValue === SELF_TEST_PAYLOAD;
  } catch {
    nativeVerified = false;
  }
  return nativeVerified;
}

async function decodeWithWasm(bitmapSource) {
  const results = await zxing.readBarcodes(bitmapSource, {
    // tryHarder bật từ 09/09: SV chìa MÀN HÌNH điện thoại, lóa + moiré làm
    // chế độ nhanh trượt hoài. Chậm hơn vài chục ms một khung — rẻ hơn nhiều
    // so với một PG đứng vẫy mã mà máy "không phản hồi gì hết".
    tryHarder: true,
    formats: ['QRCode'],
    maxNumberOfSymbols: 1,
  });
  return results?.[0]?.text ?? null;
}

/**
 * Pick the fastest decoder this phone offers — nhưng chỉ sau khi nó ĐỌC ĐƯỢC
 * mã tự kiểm tra. Ném lỗi khi cả hai bộ đọc cùng hỏng; startScanner sẽ báo
 * `onError(err, 'decoder')` để UI hiện hướng xử lý thay vì im lặng.
 */
export async function createDecoder() {
  if (typeof globalThis.BarcodeDetector === 'function') {
    try {
      const supported = await globalThis.BarcodeDetector.getSupportedFormats();
      if (supported.includes('qr_code')) {
        const det = new globalThis.BarcodeDetector({ formats: ['qr_code'] });
        if (await nativeDetectorWorks(det)) {
          return {
            kind: 'native',
            decode: async (video) => {
              const codes = await det.detect(video);
              return codes?.[0]?.rawValue ?? null;
            },
          };
        }
      }
    } catch {
      /* fall through to WASM */
    }
  }
  await loadWasmDecoder();
  return {
    kind: 'wasm',
    decode: async (video) => {
      const canvas = createDecoder._canvas ??= document.createElement('canvas');
      const w = video.videoWidth, h = video.videoHeight;
      if (!w || !h) return null;
      // Downscale before decoding. Full-resolution decoding on a cheap phone is
      // the single biggest cause of a scanner that "feels slow".
      const scale = Math.min(1, 640 / Math.max(w, h));
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return decodeWithWasm(data);
    },
  };
}

/**
 * Start the camera and run a decode loop.
 *
 * `onCode` is called at most once per distinct code per `cooldownMs` — a QR
 * held in front of the lens decodes every frame, and without this the PG would
 * get thirty identical results a second.
 */
export async function startScanner({ video, onCode, onError, onTrackEnd, cooldownMs = 2500 }) {
  let stream, raf, timer, stopped = false, lastCode = null, lastAt = 0;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, ...CAPTURE },
      audio: false,
    });
  } catch (err) {
    onError?.(err, 'camera');
    return { stop() {}, ok: false };
  }

  video.srcObject = stream;
  video.setAttribute('playsinline', '');   // iOS refuses to inline-play without it
  video.muted = true;
  await video.play().catch(() => {});

  // iOS giết track camera khi khoá màn hình / chuyển app — video đứng hình ở
  // khung cuối, nhìn như đang chạy. Báo ra để UI về trạng thái "Chạm để quét"
  // thay vì để PG quét vào một tấm ảnh tĩnh.
  stream.getVideoTracks()[0]?.addEventListener('ended', () => {
    if (!stopped) onTrackEnd?.();
  });

  let decoder;
  try {
    decoder = await createDecoder();
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
    onError?.(err, 'decoder');
    return { stop() {}, ok: false };
  }
  const interval = 1000 / DECODE_FPS;
  let lastTick = 0;

  const tick = async (ts) => {
    if (stopped) return;
    if (ts - lastTick >= interval) {
      lastTick = ts;
      try {
        const code = await decoder.decode(video);
        if (code) {
          const now = Date.now();
          if (code !== lastCode || now - lastAt > cooldownMs) {
            lastCode = code;
            lastAt = now;
            onCode(code);
          }
        }
      } catch {
        /* a bad frame is normal; keep going */
      }
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    ok: true,
    decoderKind: decoder.kind,
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}

/**
 * Feedback for the four scan outcomes.
 *
 * Distinct vibration patterns matter more than the sounds: a PG in a loud
 * courtyard feels the phone before they read it, and the amber "already has
 * this badge" pattern must feel different from the red "invalid" one — while
 * still not feeling like an error, because a duplicate is a normal outcome.
 */
const HAPTIC = {
  ok: [40],
  amber: [30, 60, 30],
  bad: [200],
  info: [40, 40, 40],
};

export function feedback(kind) {
  try { navigator.vibrate?.(HAPTIC[kind] ?? [40]); } catch { /* unsupported */ }
  try { tone(kind); } catch { /* audio blocked until first gesture */ }
}

let audioCtx;
function tone(kind) {
  audioCtx ??= new (globalThis.AudioContext ?? globalThis.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const notes = {
    ok: [[880, 0], [1320, 0.07]],
    amber: [[520, 0]],
    bad: [[200, 0], [160, 0.12]],
    info: [[660, 0]],
  }[kind] ?? [[880, 0]];

  for (const [freq, delay] of notes) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.0001, audioCtx.currentTime + delay);
    gain.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + delay + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + delay + 0.14);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(audioCtx.currentTime + delay);
    osc.stop(audioCtx.currentTime + delay + 0.16);
  }
}

/** Keep the screen awake while scanning — on iOS, a locked screen stops sync. */
export async function holdWakeLock() {
  try {
    return await navigator.wakeLock?.request('screen');
  } catch {
    return null;
  }
}
