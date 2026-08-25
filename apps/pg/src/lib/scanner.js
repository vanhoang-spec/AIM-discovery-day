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

let zxing;

async function decodeWithWasm(bitmapSource) {
  if (!zxing) {
    const mod = await import('zxing-wasm/reader');
    zxing = mod;
  }
  const results = await zxing.readBarcodes(bitmapSource, {
    tryHarder: false,          // speed over exhaustiveness; the QR is small and clean
    formats: ['QRCode'],
    maxNumberOfSymbols: 1,
  });
  return results?.[0]?.text ?? null;
}

/** Pick the fastest decoder this phone offers. */
export async function createDecoder() {
  if (typeof globalThis.BarcodeDetector === 'function') {
    try {
      const supported = await globalThis.BarcodeDetector.getSupportedFormats();
      if (supported.includes('qr_code')) {
        const det = new globalThis.BarcodeDetector({ formats: ['qr_code'] });
        return {
          kind: 'native',
          decode: async (video) => {
            const codes = await det.detect(video);
            return codes?.[0]?.rawValue ?? null;
          },
        };
      }
    } catch {
      /* fall through to WASM */
    }
  }
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
export async function startScanner({ video, onCode, onError, cooldownMs = 2500 }) {
  let stream, raf, timer, stopped = false, lastCode = null, lastAt = 0;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, ...CAPTURE },
      audio: false,
    });
  } catch (err) {
    onError?.(err);
    return { stop() {}, ok: false };
  }

  video.srcObject = stream;
  video.setAttribute('playsinline', '');   // iOS refuses to inline-play without it
  video.muted = true;
  await video.play().catch(() => {});

  const decoder = await createDecoder();
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
