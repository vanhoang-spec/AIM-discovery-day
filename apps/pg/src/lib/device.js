/**
 * Device token handling, server side.
 *
 * The token the phone holds is a random opaque string. Only its SHA-256 hash
 * reaches the database, so a database dump yields nothing that can be replayed
 * against the sync endpoint. Same reasoning as password hashing, minus the
 * need for a slow KDF: the token is 256 bits of entropy the server generated,
 * not something a human chose, so there is nothing to brute-force.
 */

const enc = new TextEncoder();

export async function sha256Hex(value) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(String(value)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 256 bits, base64url — safe in a header and in localStorage. */
export function mintToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Read the bearer token from a request. Returns null rather than throwing. */
export function bearerFrom(request) {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}
