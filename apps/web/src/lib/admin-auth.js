/**
 * Admin access, v1: ONE shared access key for AIM's ~3 admins.
 *
 * A deliberate trade against a full account system (2 days we do not have):
 * the console is read-mostly, every mutating action goes through functions
 * that write audit_log with an actor name typed per-action, and the key
 * lives in an env var so rotating it is a redeploy, not a migration. The
 * upgrade path to real accounts is additive — nothing here leaks into the
 * schema.
 *
 * In dev (no ADMIN_ACCESS_KEY set) the key is 'dev-admin', mirroring how
 * the HMAC dev key works; production REFUSES to fall back.
 */

export function checkAdmin(request) {
  const configured = process.env.ADMIN_ACCESS_KEY;
  if (!configured && process.env.NODE_ENV === 'production') {
    return { ok: false, status: 500, error: 'ADMIN_ACCESS_KEY chưa được cấu hình' };
  }
  const expected = configured || 'dev-admin';
  const got = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (got !== expected) {
    return { ok: false, status: 401, error: 'Sai mã truy cập' };
  }
  return { ok: true };
}

export function adminError(check) {
  return Response.json({ error: check.error }, { status: check.status });
}
