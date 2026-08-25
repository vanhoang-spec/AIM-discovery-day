/**
 * Browser environment checks the PG app must make before it can be trusted.
 *
 * All pure functions over a user-agent string so they are testable in Node.
 * The app calls them with `navigator.userAgent`.
 */

/**
 * In-app browsers that break the scanner.
 *
 * This is the failure I expect to see most on event day. Device cards get
 * photographed and sent round on Zalo; a PG taps the link; Zalo opens it in
 * its own webview. There the camera permission prompt often never appears and
 * service-worker storage is unreliable — so the PG sees a blank scanner and
 * concludes their phone is broken, minutes before the gates open.
 *
 * Detecting it and refusing to continue, with instructions, is worth far more
 * than any amount of scanner optimisation.
 */
export function detectWebview(ua = '') {
  const s = String(ua);
  const checks = [
    [/\bZalo\b/i, 'Zalo'],
    [/\bFB(AN|AV|_IAB)\b|FBAN|FBAV/i, 'Facebook'],
    [/\bInstagram\b/i, 'Instagram'],
    [/\bMessenger\b/i, 'Messenger'],
    [/\bTikTok\b|musical_ly/i, 'TikTok'],
    [/\bLine\//i, 'LINE'],
    [/\bMicroMessenger\b/i, 'Zalo/WeChat'],
  ];
  for (const [re, name] of checks) {
    if (re.test(s)) return { isWebview: true, app: name };
  }
  // Android WebView announces itself with "; wv" in the UA.
  if (/\bwv\b/.test(s) && /Android/i.test(s)) {
    return { isWebview: true, app: 'ứng dụng khác' };
  }
  return { isWebview: false, app: null };
}

export function isIOS(ua = '') {
  const s = String(ua);
  // iPadOS 13+ reports itself as Macintosh; the touch-points check separates
  // an iPad from a real Mac.
  return /iPad|iPhone|iPod/.test(s) ||
    (/Macintosh/.test(s) && (globalThis.navigator?.maxTouchPoints ?? 0) > 1);
}

/**
 * Whether the page is running as an installed PWA.
 *
 * This matters because of an iOS trap: a device code claimed in Safari does
 * NOT carry over to the installed app, which gets its own storage. A PG who
 * claims first and installs second finds themselves logged out. The briefing
 * script therefore says install first, then claim — and this check lets the
 * app warn when the order is about to go wrong.
 */
export function isStandalone() {
  return (
    globalThis.matchMedia?.('(display-mode: standalone)')?.matches === true ||
    globalThis.navigator?.standalone === true
  );
}

/** Capability probe used by the briefing gate and the diagnostics screen. */
export function capabilities(nav = globalThis.navigator, ua = nav?.userAgent ?? '') {
  const webview = detectWebview(ua);
  return {
    webview,
    ios: isIOS(ua),
    standalone: isStandalone(),
    camera: typeof nav?.mediaDevices?.getUserMedia === 'function',
    // Chrome on Android decodes natively and fast; everywhere else falls back
    // to the bundled WASM decoder.
    nativeBarcode: typeof globalThis.BarcodeDetector === 'function',
    // iOS Safari has no Background Sync, so the queue can only drain while the
    // app is in the foreground. That is why the scanner holds a wake lock and
    // the briefing tells PGs not to lock the screen.
    backgroundSync: 'serviceWorker' in (nav ?? {}) && 'SyncManager' in globalThis,
    wakeLock: typeof nav?.wakeLock?.request === 'function',
    storage: typeof globalThis.indexedDB === 'object' && globalThis.indexedDB !== null,
    vibrate: typeof nav?.vibrate === 'function',
  };
}

/**
 * Verdict for the briefing gate: can this phone be deployed tomorrow?
 *
 * Blockers are things that make scanning impossible. Warnings are things a PG
 * needs to be told about but can work around. A device with any blocker does
 * not go out — that rule is the whole point of the seven-step gate.
 */
export function deviceVerdict(caps) {
  const blockers = [];
  const warnings = [];

  if (caps.webview.isWebview) {
    blockers.push({
      code: 'webview',
      message: `Đang mở trong ${caps.webview.app}. Camera sẽ không hoạt động.`,
      fix: 'Bấm ⋯ rồi chọn "Mở bằng trình duyệt" (Chrome hoặc Safari).',
    });
  }
  if (!caps.camera) {
    blockers.push({
      code: 'camera',
      message: 'Trình duyệt này không cho phép dùng camera.',
      fix: 'Mở bằng Chrome (Android) hoặc Safari (iPhone).',
    });
  }
  if (!caps.storage) {
    blockers.push({
      code: 'storage',
      message: 'Không lưu được dữ liệu offline trên máy này.',
      fix: 'Tắt chế độ duyệt web riêng tư, rồi mở lại.',
    });
  }
  if (caps.ios && !caps.standalone) {
    warnings.push({
      code: 'ios-install-order',
      message: 'iPhone: hãy "Thêm vào màn hình chính" TRƯỚC khi nhập mã thiết bị.',
      fix: 'Nhập mã trong Safari rồi mới cài sẽ phải nhập lại từ đầu.',
    });
  }
  if (!caps.backgroundSync) {
    warnings.push({
      code: 'no-bg-sync',
      message: 'Máy này chỉ gửi dữ liệu khi app đang mở.',
      fix: 'Đừng khoá màn hình khi đang quét.',
    });
  }
  if (!caps.nativeBarcode) {
    warnings.push({
      code: 'wasm-decoder',
      message: 'Dùng bộ giải mã dự phòng — quét có thể chậm hơn một chút.',
      fix: 'Giữ mã QR cách camera 20–30cm để dễ lấy nét.',
    });
  }
  return { ok: blockers.length === 0, blockers, warnings };
}
