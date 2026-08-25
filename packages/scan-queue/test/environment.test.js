import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectWebview, isIOS, capabilities, deviceVerdict } from '../src/environment.js';

// Real user-agent strings. The Zalo one is the reason this module exists.
const UA = {
  zalo: 'Mozilla/5.0 (Linux; Android 13; SM-A515F) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/117.0.0.0 Mobile Safari/537.36 Zalo/23.09.01 (Android)',
  zaloIOS: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Zalo/23.09.01',
  facebook: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 [FBAN/FBIOS;FBAV/432.0.0.32.107]',
  messenger: 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/110.0 Mobile Safari/537.36 Messenger/400.0',
  tiktok: 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/110.0 Mobile Safari/537.36 musical_ly_2022 TikTok/26.5.3',
  androidWv: 'Mozilla/5.0 (Linux; Android 11; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/95.0 Mobile Safari/537.36',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
  safariIOS: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
};

describe('webview detection — the failure most likely on event day', () => {
  test('catches Zalo on both platforms', () => {
    assert.equal(detectWebview(UA.zalo).isWebview, true);
    assert.equal(detectWebview(UA.zalo).app, 'Zalo');
    assert.equal(detectWebview(UA.zaloIOS).isWebview, true);
  });

  test('catches the other in-app browsers device cards get shared through', () => {
    for (const key of ['facebook', 'messenger', 'tiktok']) {
      assert.equal(detectWebview(UA[key]).isWebview, true, `${key} should be flagged`);
    }
  });

  test('catches a generic Android WebView', () => {
    assert.equal(detectWebview(UA.androidWv).isWebview, true);
  });

  test('does NOT flag the real browsers PGs are told to use', () => {
    assert.equal(detectWebview(UA.chromeAndroid).isWebview, false);
    assert.equal(detectWebview(UA.safariIOS).isWebview, false);
  });

  test('survives a missing user agent instead of throwing mid-boot', () => {
    for (const v of [undefined, null, '']) {
      assert.equal(detectWebview(v).isWebview, false);
    }
  });
});

describe('platform detection', () => {
  test('identifies iOS', () => {
    assert.equal(isIOS(UA.safariIOS), true);
    assert.equal(isIOS(UA.zaloIOS), true);
    assert.equal(isIOS(UA.chromeAndroid), false);
  });
});

describe('device verdict — the seven-step briefing gate', () => {
  const good = {
    webview: { isWebview: false, app: null },
    ios: false, standalone: false, camera: true, nativeBarcode: true,
    backgroundSync: true, wakeLock: true, storage: true, vibrate: true,
  };

  test('a Chrome-on-Android phone passes clean', () => {
    const v = deviceVerdict(good);
    assert.equal(v.ok, true);
    assert.equal(v.blockers.length, 0);
    assert.equal(v.warnings.length, 0);
  });

  test('a phone in the Zalo webview is BLOCKED, not merely warned', () => {
    const v = deviceVerdict({ ...good, webview: { isWebview: true, app: 'Zalo' } });
    assert.equal(v.ok, false);
    assert.equal(v.blockers[0].code, 'webview');
    assert.match(v.blockers[0].message, /Zalo/);
    assert.match(v.blockers[0].fix, /trình duyệt/i);
  });

  test('no camera blocks deployment', () => {
    const v = deviceVerdict({ ...good, camera: false });
    assert.equal(v.ok, false);
    assert.ok(v.blockers.some((b) => b.code === 'camera'));
  });

  test('no offline storage blocks deployment — a queue that cannot persist is useless', () => {
    const v = deviceVerdict({ ...good, storage: false });
    assert.equal(v.ok, false);
    assert.ok(v.blockers.some((b) => b.code === 'storage'));
  });

  test('an iPhone not yet installed passes, but warns about the claim-order trap', () => {
    const v = deviceVerdict({ ...good, ios: true, standalone: false });
    assert.equal(v.ok, true, 'this is a warning, not a blocker');
    const w = v.warnings.find((x) => x.code === 'ios-install-order');
    assert.ok(w, 'must warn');
    assert.match(w.message, /TRƯỚC/);
  });

  test('an installed iPhone gets no install-order warning', () => {
    const v = deviceVerdict({ ...good, ios: true, standalone: true, backgroundSync: false });
    assert.ok(!v.warnings.some((x) => x.code === 'ios-install-order'));
    assert.ok(v.warnings.some((x) => x.code === 'no-bg-sync'), 'but still warns about foreground-only sync');
  });

  test('missing background sync warns to keep the screen on', () => {
    const v = deviceVerdict({ ...good, backgroundSync: false });
    assert.equal(v.ok, true);
    const w = v.warnings.find((x) => x.code === 'no-bg-sync');
    assert.match(w.fix, /khoá màn hình/i);
  });

  test('every blocker and warning tells the PG what to do about it', () => {
    const v = deviceVerdict({
      webview: { isWebview: true, app: 'Zalo' },
      ios: true, standalone: false, camera: false, nativeBarcode: false,
      backgroundSync: false, wakeLock: false, storage: false, vibrate: false,
    });
    for (const item of [...v.blockers, ...v.warnings]) {
      assert.ok(item.message?.length > 10, `${item.code} needs a real message`);
      assert.ok(item.fix?.length > 10, `${item.code} needs an actionable fix`);
    }
  });
});

describe('capabilities probe', () => {
  test('reads a bare navigator without throwing', () => {
    const caps = capabilities({ userAgent: UA.chromeAndroid }, UA.chromeAndroid);
    assert.equal(caps.camera, false);
    assert.equal(caps.webview.isWebview, false);
    assert.equal(typeof caps.storage, 'boolean');
  });

  test('reports camera support when getUserMedia exists', () => {
    const caps = capabilities(
      { userAgent: UA.chromeAndroid, mediaDevices: { getUserMedia() {} } },
      UA.chromeAndroid,
    );
    assert.equal(caps.camera, true);
  });
});
