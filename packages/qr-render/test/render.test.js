import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mintToken } from '../../qr-token/src/index.js';
import {
  inspect,
  assertScannable,
  renderSVG,
  renderPNGDataURL,
  ECC_LEVEL,
  QUIET_ZONE_MODULES,
} from '../src/index.js';

const KEY = 'atl2026-test-key-do-not-use-in-production';
const token = await mintToken({ eventInstance: 1, studentSeq: 1337 }, KEY);

describe('symbol size — the measurement the design rests on', () => {
  test('a real 26-character token fits QR version 2 at ECC level Q', () => {
    assert.equal(token.length, 26);
    const info = inspect(token);
    assert.equal(info.eccLevel, 'Q');
    assert.equal(info.version, 2);
    assert.equal(info.modules, 25, 'a 25x25 symbol keeps modules large for weak cameras');
    assert.equal(info.mode, 'Alphanumeric', 'byte mode would need a bigger symbol');
  });

  test('raising correction from M to Q costs nothing in symbol size', () => {
    // The whole reason level Q was chosen: same 25x25 grid, 25% correction
    // instead of 15%, which is what recovers a glare patch off a phone screen.
    assert.equal(inspect(token).modules, 25);
  });

  test('every event instance and sequence number stays within version 2', async () => {
    for (const eventInstance of [1, 2, 3]) {
      for (const studentSeq of [1, 1000, 65535, 2147483647]) {
        const t = await mintToken({ eventInstance, studentSeq }, KEY);
        const info = inspect(t);
        assert.equal(info.version, 2, `event ${eventInstance} seq ${studentSeq} grew the symbol`);
      }
    }
  });
});

describe('the guard against silent symbol growth', () => {
  test('a URL payload is refused with an explanation, not silently rendered', () => {
    assert.throws(
      () => assertScannable(`https://atl.aimacademy.vn/q/${token}`),
      /too large|Do not put URLs/,
      'wrapping the token in a URL must fail loudly at build time',
    );
  });

  test('a JWT-shaped payload is refused', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6Ik5ndXllbiBWYW4gQSIsImlhdCI6MTUxNjIzOTAyMn0.' +
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    assert.throws(() => assertScannable(jwt), /too large/);
  });

  test('the error says what to do, not just that something is wrong', () => {
    try {
      assertScannable('https://example.com/a-fairly-long-url-that-will-not-fit-in-version-2');
      assert.fail('should have thrown');
    } catch (err) {
      assert.match(err.message, /version/);
      assert.match(err.message, /phone screen in sunlight/);
    }
  });
});

describe('SVG rendering', () => {
  const svgPromise = renderSVG(token);

  test('produces a scalable SVG with a viewBox and no fixed size', async () => {
    const svg = await svgPromise;
    assert.match(svg, /^<svg/);
    assert.match(svg, /viewBox="0 0 33 33"/, '25 modules + 4 quiet zone each side = 33');
    assert.doesNotMatch(svg, /\swidth="/, 'CSS must control the size, not the SVG');
    assert.doesNotMatch(svg, /\sheight="/);
  });

  test('is pure black on white — no brand colour eating decode margin', async () => {
    const svg = await svgPromise;
    const colours = [...svg.matchAll(/#[0-9a-fA-F]{3,8}/g)].map((m) => m[0].toLowerCase());
    for (const c of colours) {
      assert.ok(
        ['#000', '#fff', '#000000', '#ffffff', '#000000ff', '#ffffffff'].includes(c),
        `unexpected colour ${c} in the symbol`,
      );
    }
  });

  test('includes the quiet zone decoders require', async () => {
    const svg = await svgPromise;
    const [, w] = svg.match(/viewBox="0 0 (\d+) \d+"/);
    assert.equal(Number(w), 25 + QUIET_ZONE_MODULES * 2);
  });

  test('carries nothing that executes or fetches — it is injected into a page', async () => {
    const svg = await svgPromise;
    // The xmlns declaration is a namespace identifier, not a fetch: it is inert
    // and required. What must be absent is anything that runs or loads.
    const withoutNamespace = svg.replace(/xmlns(:\w+)?="[^"]*"/g, '');
    assert.doesNotMatch(withoutNamespace, /<script/i);
    assert.doesNotMatch(withoutNamespace, /<foreignObject/i);
    assert.doesNotMatch(withoutNamespace, /<(image|use)\b/i);
    assert.doesNotMatch(withoutNamespace, /\son\w+=/i, 'no inline event handlers');
    assert.doesNotMatch(withoutNamespace, /https?:\/\//i, 'no external resource');
    assert.doesNotMatch(withoutNamespace, /url\(/i);
  });

  test('is small enough to cache on the device alongside the token', async () => {
    const svg = await svgPromise;
    assert.ok(svg.length < 8000, `cached SVG is ${svg.length} bytes`);
  });

  test('the same token always renders the same SVG', async () => {
    assert.equal(await renderSVG(token), await renderSVG(token));
  });
});

describe('PNG rendering for email', () => {
  test('produces a PNG data URL', async () => {
    const url = await renderPNGDataURL(token);
    assert.match(url, /^data:image\/png;base64,/);
  });

  test('scale controls pixel size: (25 modules + 8 quiet) x scale', async () => {
    const url = await renderPNGDataURL(token, { scale: 8 });
    const png = Buffer.from(url.split(',')[1], 'base64');
    // PNG IHDR: width is a big-endian uint32 at byte offset 16.
    const width = png.readUInt32BE(16);
    assert.equal(width, (25 + QUIET_ZONE_MODULES * 2) * 8);
  });

  test('is large enough to survive an email client resizing it', async () => {
    const url = await renderPNGDataURL(token, { scale: 8 });
    const png = Buffer.from(url.split(',')[1], 'base64');
    assert.ok(png.readUInt32BE(16) >= 256, 'a too-small attachment cannot be scanned');
  });
});

describe('locked settings', () => {
  test('the ECC level is Q and is not a caller-supplied option', () => {
    assert.equal(ECC_LEVEL, 'Q');
  });

  test('a caller cannot weaken the settings by passing options through', async () => {
    // renderSVG takes no options object at all; the signature is the guard.
    assert.equal(renderSVG.length, 1);
  });
});
