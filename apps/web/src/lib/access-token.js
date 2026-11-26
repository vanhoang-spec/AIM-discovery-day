/**
 * Mã truy cập — chìa khoá ĐỌC dữ liệu cá nhân của một sinh viên. [26/11, vá bảo mật]
 *
 * Vì sao có nó: máy PG phải kiểm mã QR khi mất mạng, nên khoá ký QR được nhúng
 * vào JavaScript công khai của app PG (`NEXT_PUBLIC_ATL_HMAC_KEY`). Trước bản vá,
 * /api/toi, /api/toi/pass và /api/khao-sat lại xác thực bằng CHÍNH mã QR — ai
 * mở DevTools trên app PG lấy được khoá là tự ký mã QR cho mọi `seq` rồi đọc họ
 * tên, mã tra cứu, badge của người khác.
 *
 * Từ giờ hai việc dùng hai khoá:
 *   - Mã QR (`@atl/qr-token`, khoá `ATL_HMAC_KEY`) chỉ để QUÉT. Coi như công
 *     khai. Định dạng giữ nguyên byte-cho-byte, máy PG đang chạy không phải sửa.
 *   - Mã truy cập (file này, khoá `ATL_ACCESS_KEY`) mở các đường đọc dữ liệu cá
 *     nhân. Khoá CHỈ nằm trên server app web, không bao giờ ở biến NEXT_PUBLIC_*.
 *
 * Định dạng: dùng lại nguyên khung 16 byte của mã QR, chỉ khác byte đầu —
 *   [0] 0xA1 (mã QR là 0x01) · [1] eventInstance · [2..5] seq · [6..15] HMAC.
 * Crockford Base32 → 26 ký tự (bắt đầu bằng "M"; mã QR bắt đầu bằng "0"), nên
 * link trong thư vẫn ngắn: /toi#t=<26 ký tự>. Byte đầu khác nhau là ngăn cách
 * miền ký: kể cả lỡ đặt hai khoá giống nhau, một mã QR cũng không bao giờ là
 * mã truy cập hợp lệ — nhưng code vẫn từ chối chạy khi hai khoá trùng, vì khi
 * đó ai có khoá PG cũng tự ký được mã truy cập.
 *
 * Ký và kiểm đi qua đúng hàm `mintToken` đã được test đột biến của
 * `@atl/qr-token` — không viết lại HMAC ở đây.
 */

import { mintToken, parseTokenUnverified, decodeBase32, importKey, TOKEN_VERSION } from '@atl/qr-token';

export const ACCESS_VERSION = 0xa1;
export const ACCESS_TOKEN_LENGTH = 26;

const DEV_ACCESS_KEY = 'atl2026-dev-access-key-do-not-use-in-production';
// Khoá QR dev của lib/qr.js — chỉ để chặn cấu hình dev đặt hai khoá trùng nhau.
const DEV_QR_KEY = 'atl2026-dev-key-do-not-use-in-production';

/**
 * Khoá ký mã truy cập lấy từ môi trường. Production thiếu `ATL_ACCESS_KEY` thì
 * dừng hẳn (như `ATL_HMAC_KEY`), không lặng lẽ ký bằng khoá dev.
 */
export function accessSecret(env = process.env) {
  const secret = env.ATL_ACCESS_KEY;
  const production = env.NODE_ENV === 'production';
  if (!secret) {
    if (production) throw new Error('ATL_ACCESS_KEY is required in production');
    return DEV_ACCESS_KEY;
  }
  const qrSecret = env.ATL_HMAC_KEY || (production ? null : DEV_QR_KEY);
  if (qrSecret && secret === qrSecret) {
    throw new Error('ATL_ACCESS_KEY must differ from ATL_HMAC_KEY (the QR key is public on the PG app)');
  }
  return secret;
}

let cached = { secret: null, key: null };
/** CryptoKey nhập một lần, dùng lại; đổi biến môi trường thì nhập lại. */
export function getAccessKey() {
  const secret = accessSecret();
  if (cached.secret !== secret) cached = { secret, key: importKey(secret) };
  return cached.key;
}

/** Ký mã truy cập cho một sinh viên ở một sự kiện. 26 ký tự, xác định (deterministic). */
export async function mintAccessToken({ eventInstance, studentSeq }, key) {
  return mintToken({ version: ACCESS_VERSION, eventInstance, studentSeq }, key);
}

/** Ký bằng khoá server — dùng ở /api/register, /api/toi/pass, outbox. */
export async function issueAccessToken({ eventInstance, studentSeq }) {
  return mintAccessToken({ eventInstance, studentSeq }, await getAccessKey());
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Kiểm mã truy cập. Không throw — trả `{ valid: false, reason }` như verifyToken.
 * reason: 'malformed' | 'qr_token' (đây là mã QR, không phải mã truy cập — link
 * thư cũ trước 26/11) | 'unsupported_version' | 'bad_signature'.
 */
export async function verifyAccessToken(token, key) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 64) {
    return { valid: false, reason: 'malformed' };
  }
  let parsed;
  try {
    parsed = parseTokenUnverified(token);
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (parsed.version === TOKEN_VERSION) return { valid: false, reason: 'qr_token' };
  if (parsed.version !== ACCESS_VERSION) return { valid: false, reason: 'unsupported_version' };

  const expected = decodeBase32(
    await mintAccessToken({ eventInstance: parsed.eventInstance, studentSeq: parsed.studentSeq }, key),
  ).slice(6);
  if (!timingSafeEqual(expected, parsed.tag)) return { valid: false, reason: 'bad_signature' };
  return { valid: true, eventInstance: parsed.eventInstance, studentSeq: parsed.studentSeq };
}

/** Kiểm bằng khoá server — cửa vào chung của mọi route đọc dữ liệu cá nhân. */
export async function verifyAccess(token) {
  return verifyAccessToken(token, await getAccessKey());
}
