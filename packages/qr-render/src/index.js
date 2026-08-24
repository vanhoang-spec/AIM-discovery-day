/**
 * QR rendering for ATL2026 — server side only, on purpose.
 *
 * The student's QR is rendered ONCE, at registration, and the resulting SVG
 * string is cached on their device. The QR screen then just injects that
 * string. Two consequences, both wanted:
 *
 *   * The ~50 KB QR library never ships to the student bundle, which matters
 *     against a 120 KB budget on a congested 4G courtyard.
 *   * The QR screen works with zero network and zero JavaScript beyond reading
 *     localStorage. That screen is what the whole event runs on.
 *
 * SVG rather than PNG because one cached string renders crisply at every size,
 * from a 240 px phone view to a full-screen zoom, with no re-encoding.
 *
 * ---------------------------------------------------------------------------
 * Why these settings are not options
 *
 * PG staff scan a phone SCREEN, outdoors, using their OWN phones. Glass is a
 * specular reflector and cheap cameras focus poorly, so every setting below is
 * chosen for that case and locked:
 *
 *   ECC level Q   25% error correction, which recovers a glare patch across a
 *                 corner. Measured: a 26-character token still fits QR version
 *                 2 (25x25) at level Q — the SAME symbol size as level M. The
 *                 robustness is free. Level H would push to version 3 (29x29),
 *                 shrinking modules 14% for 5% more correction: a bad trade
 *                 when the camera is the weak link.
 *   Pure #000/#fff  Maximum contrast. Brand colours in the symbol cost decode
 *                 margin, and a logo overlay eats the very redundancy that ECC
 *                 Q was raised to provide.
 *   Margin 4      The quiet zone is part of the spec. Decoders fail without it
 *                 and it is the most common thing designers crop off.
 * ---------------------------------------------------------------------------
 */

import QRCode from 'qrcode';

export const ECC_LEVEL = 'Q';
export const QUIET_ZONE_MODULES = 4;
export const MAX_QR_VERSION = 2; // 25x25 — keep modules large for weak cameras

const LOCKED = Object.freeze({
  errorCorrectionLevel: ECC_LEVEL,
  margin: QUIET_ZONE_MODULES,
  color: { dark: '#000000ff', light: '#ffffffff' },
});

/**
 * Inspect what a payload would produce, without rendering it.
 * Used by the tests and by a build-time guard.
 */
export function inspect(payload) {
  const qr = QRCode.create(payload, { errorCorrectionLevel: ECC_LEVEL });
  return {
    version: qr.version,
    modules: qr.modules.size,
    mode: qr.segments[0]?.mode?.id,
    eccLevel: ECC_LEVEL,
  };
}

/**
 * Guard against silent symbol growth.
 *
 * If someone later decides to encode a URL "so the student can just tap it",
 * the symbol jumps several versions, modules shrink, and scanning degrades in
 * exactly the conditions we cannot test from a desk. Failing loudly here is the
 * cheapest place to catch that.
 */
export function assertScannable(payload) {
  const info = inspect(payload);
  if (info.version > MAX_QR_VERSION) {
    throw new Error(
      `QR payload too large: ${payload.length} chars produced version ${info.version} ` +
        `(${info.modules}x${info.modules}). Maximum is version ${MAX_QR_VERSION}. ` +
        `Do not put URLs or JWTs in the student QR — modules get too small to scan ` +
        `off a phone screen in sunlight.`,
    );
  }
  return info;
}

/**
 * Render a token to an SVG string. Store this on the device; it is the artifact
 * the offline QR screen displays.
 *
 * The SVG carries a viewBox and no fixed width/height, so CSS decides the size
 * and the caller can render it as large as the screen allows. Large modules are
 * how we compensate for a PG phone that cannot focus closer than 10 cm.
 */
export async function renderSVG(payload) {
  assertScannable(payload);
  const svg = await QRCode.toString(payload, { ...LOCKED, type: 'svg' });
  // Strip the fixed dimensions the library emits; keep the viewBox.
  return svg.replace(/\s(width|height)="[^"]*"/g, '');
}

/**
 * Render a PNG data URL. For the confirmation email, where an SVG attachment
 * is unreliable across mail clients, and for the "save image" button.
 *
 * `scale` is pixels per module. At scale 8 a 25x25 symbol plus its quiet zone
 * is (25 + 8) * 8 = 264 px, which is a sensible attachment size.
 */
export async function renderPNGDataURL(payload, { scale = 8 } = {}) {
  assertScannable(payload);
  return QRCode.toDataURL(payload, { ...LOCKED, scale, type: 'image/png' });
}

/** Raw PNG buffer, for attaching to an email server-side. */
export async function renderPNGBuffer(payload, { scale = 8 } = {}) {
  assertScannable(payload);
  return QRCode.toBuffer(payload, { ...LOCKED, scale, type: 'png' });
}
