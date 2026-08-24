/**
 * ATL2026 QR token — mint & verify.
 *
 * The same bytes must be produced by the server, the PG scanner and the student
 * app, so this module depends only on Web Crypto (present in Node >= 19,
 * browsers, and service workers). Do not add dependencies and do not fork this
 * file per app: an offline scanner that disagrees with the server about a
 * signature rejects real students at a booth.
 *
 * Wire format — 16 bytes:
 *   [0]      version         0x01
 *   [1]      eventInstance   1=DD Hà Nội, 2=DD HCM, 3=Grand Finale
 *   [2..5]   studentSeq      uint32 big-endian
 *   [6..15]  tag             HMAC-SHA256(key, bytes[0..5]) truncated to 80 bits
 *
 * Crockford Base32 of 16 bytes = 26 chars, which fits a QR version 2 (25x25)
 * symbol at ECC level M using alphanumeric mode. That size decodes in one frame
 * on a cheap phone in sunlight; a JWT payload (~45x45) does not. Never put a URL
 * or a JWT in the student QR.
 */

export const TOKEN_VERSION = 0x01;
export const PAYLOAD_BYTES = 16;
export const TOKEN_LENGTH = 26;
export const TAG_BYTES = 10;

/** Crockford Base32: no I, L, O or U, so it survives being read aloud. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Decoding is lenient: O->0, I/L->1, lowercase and hyphens accepted. */
const DECODE_MAP = (() => {
  const map = new Map();
  for (let i = 0; i < ALPHABET.length; i++) {
    map.set(ALPHABET[i], i);
    map.set(ALPHABET[i].toLowerCase(), i);
  }
  for (const [ch, val] of [['O', 0], ['o', 0], ['I', 1], ['i', 1], ['L', 1], ['l', 1]]) {
    map.set(ch, val);
  }
  return map;
})();

function getCrypto() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new Error('Web Crypto unavailable. Node >= 19, a browser or a service worker is required.');
  }
  return c;
}

/**
 * Encode bytes as Crockford Base32, MSB first, no padding.
 * 16 bytes -> 26 chars (the last char carries 3 significant bits).
 */
export function encodeBase32(bytes) {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += ALPHABET[(buffer << (5 - bits)) & 0x1f];
  }
  return out;
}

/**
 * Decode Crockford Base32 back to bytes. Hyphens and whitespace are stripped so
 * a code read off a printed sticker can be typed with or without separators.
 * Throws on any character outside the alphabet.
 *
 * Canonical form is enforced: 16 bytes occupy 128 bits but 26 Base32 characters
 * carry 130, so the final character has 2 spare low bits. Without this check
 * four different strings decode to the same student, the encoding is not a
 * bijection, and a tampered last character still verifies. Any input whose
 * padding bits are non-zero is rejected.
 */
export function decodeBase32(text, expectedBytes) {
  const cleaned = String(text).replace(/[\s-]/g, '');
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of cleaned) {
    const val = DECODE_MAP.get(ch);
    if (val === undefined) {
      throw new Error(`Invalid Base32 character: ${JSON.stringify(ch)}`);
    }
    buffer = (buffer << 5) | val;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >>> bits) & 0xff);
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) {
    throw new Error('Non-canonical Base32: padding bits must be zero');
  }
  if (expectedBytes !== undefined && out.length !== expectedBytes) {
    throw new Error(`Expected ${expectedBytes} bytes, decoded ${out.length}`);
  }
  return Uint8Array.from(out);
}

/** Build the 6 signed bytes that the tag is computed over. */
function buildHeader({ version = TOKEN_VERSION, eventInstance, studentSeq }) {
  if (!Number.isInteger(eventInstance) || eventInstance < 0 || eventInstance > 255) {
    throw new RangeError('eventInstance must be an integer in 0..255');
  }
  if (!Number.isInteger(studentSeq) || studentSeq < 0 || studentSeq > 0xffffffff) {
    throw new RangeError('studentSeq must be a uint32');
  }
  const header = new Uint8Array(6);
  header[0] = version & 0xff;
  header[1] = eventInstance & 0xff;
  header[2] = (studentSeq >>> 24) & 0xff;
  header[3] = (studentSeq >>> 16) & 0xff;
  header[4] = (studentSeq >>> 8) & 0xff;
  header[5] = studentSeq & 0xff;
  return header;
}

/**
 * Import an HMAC key. `secret` is raw bytes or a UTF-8 string. Callers should
 * import once per event and reuse the CryptoKey; on the scan path this matters.
 */
export async function importKey(secret) {
  const raw = typeof secret === 'string' ? new TextEncoder().encode(secret) : secret;
  if (raw.byteLength < 16) {
    throw new Error('HMAC secret must be at least 16 bytes');
  }
  return getCrypto().subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
}

async function computeTag(key, header) {
  const cryptoKey = key instanceof CryptoKey ? key : await importKey(key);
  const sig = await getCrypto().subtle.sign('HMAC', cryptoKey, header);
  return new Uint8Array(sig).slice(0, TAG_BYTES);
}

/** Compare two byte arrays without an early exit. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Mint a token string for one student.
 * @returns {Promise<string>} 26 uppercase Crockford Base32 characters.
 */
export async function mintToken({ version = TOKEN_VERSION, eventInstance, studentSeq }, key) {
  const header = buildHeader({ version, eventInstance, studentSeq });
  const tag = await computeTag(key, header);
  const payload = new Uint8Array(PAYLOAD_BYTES);
  payload.set(header, 0);
  payload.set(tag, 6);
  return encodeBase32(payload);
}

/**
 * Read a token without checking its signature. Useful for diagnostics and for
 * deciding which event key to verify against — never for granting a badge.
 */
export function parseTokenUnverified(token) {
  const bytes = decodeBase32(token, PAYLOAD_BYTES);
  return {
    version: bytes[0],
    eventInstance: bytes[1],
    studentSeq: ((bytes[2] << 24) >>> 0) + (bytes[3] << 16) + (bytes[4] << 8) + bytes[5],
    tag: bytes.slice(6),
    header: bytes.slice(0, 6),
  };
}

/**
 * Verify a scanned token.
 *
 * Returns `{ valid: false, reason }` rather than throwing, because the scanner
 * shows a distinct UI state per reason and a thrown error in the camera loop
 * would stall scanning.
 *
 * A `valid: true` result means the token was minted by us. It does NOT mean the
 * student exists in this device's roster — a student who registered minutes ago
 * is legitimately absent from a cached roster and must still be accepted.
 */
export async function verifyToken(token, key, { expectedEventInstance } = {}) {
  let parsed;
  try {
    parsed = parseTokenUnverified(token);
  } catch (err) {
    return { valid: false, reason: 'malformed', error: err.message };
  }
  if (parsed.version !== TOKEN_VERSION) {
    return { valid: false, reason: 'unsupported_version', version: parsed.version };
  }
  if (expectedEventInstance !== undefined && parsed.eventInstance !== expectedEventInstance) {
    return {
      valid: false,
      reason: 'wrong_event',
      eventInstance: parsed.eventInstance,
      expectedEventInstance,
    };
  }
  const expectedTag = await computeTag(key, parsed.header);
  if (!timingSafeEqual(expectedTag, parsed.tag)) {
    return { valid: false, reason: 'bad_signature' };
  }
  return {
    valid: true,
    version: parsed.version,
    eventInstance: parsed.eventInstance,
    studentSeq: parsed.studentSeq,
  };
}

/* ------------------------------------------------------------------ *
 * Human-typeable lookup code
 *
 * Printed under the QR so a PG can find a student when the camera fails,
 * the screen is cracked or the phone is dead. 26 characters cannot be typed
 * with a queue waiting; 6 can. Uniqueness is enforced by a DB constraint —
 * generate, insert, retry on conflict.
 * ------------------------------------------------------------------ */

export const LOOKUP_CODE_LENGTH = 6;

/** Random 6-character code from the Crockford alphabet (~1.07e9 space). */
export function generateLookupCode(randomBytes) {
  const bytes = randomBytes ?? getCrypto().getRandomValues(new Uint8Array(LOOKUP_CODE_LENGTH));
  let out = '';
  for (let i = 0; i < LOOKUP_CODE_LENGTH; i++) {
    out += ALPHABET[bytes[i] % 32];
  }
  return out;
}

/** `K7M3QX` -> `K7M-3QX`, the form printed on stickers and device cards. */
export function formatLookupCode(code) {
  const c = normaliseLookupCode(code);
  return `${c.slice(0, 3)}-${c.slice(3)}`;
}

/**
 * Canonicalise typed input for lookup: strip separators, uppercase, and fold
 * the characters humans confuse (O->0, I/L->1). Returns null if the result is
 * not a well-formed code, so callers can show "mã không hợp lệ" instead of
 * querying with garbage.
 */
export function normaliseLookupCode(input) {
  const cleaned = String(input ?? '').replace(/[\s-]/g, '');
  if (cleaned.length !== LOOKUP_CODE_LENGTH) return null;
  let out = '';
  for (const ch of cleaned) {
    const val = DECODE_MAP.get(ch);
    if (val === undefined) return null;
    out += ALPHABET[val];
  }
  return out;
}
