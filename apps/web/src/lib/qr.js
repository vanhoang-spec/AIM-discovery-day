/**
 * Server-side QR issuing.
 *
 * The HMAC key never leaves the environment. In development a fixed key keeps
 * tokens stable across restarts; in production ATL_HMAC_KEY is required and a
 * missing value must fail the boot, not silently sign with the dev key.
 */

import { mintToken, importKey, formatLookupCode } from '@atl/qr-token';
import { renderSVG } from '@atl/qr-render';

const DEV_KEY = 'atl2026-dev-key-do-not-use-in-production';

let keyPromise;
function getKey() {
  if (!keyPromise) {
    const secret = process.env.ATL_HMAC_KEY;
    if (!secret && process.env.NODE_ENV === 'production') {
      throw new Error('ATL_HMAC_KEY is required in production');
    }
    keyPromise = importKey(secret || DEV_KEY);
  }
  return keyPromise;
}

/**
 * Mint the student's token and render the QR once. The SVG string is what the
 * client caches; the phone never needs a QR library or a network round-trip to
 * show its code again.
 */
export async function issueQr({ eventInstance, studentSeq }) {
  const key = await getKey();
  const token = await mintToken({ eventInstance, studentSeq }, key);
  const svg = await renderSVG(token);
  return { token, svg };
}

export { formatLookupCode };
