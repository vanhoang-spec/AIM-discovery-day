/**
 * Database adapter — one `query(text, params)` interface, two backends.
 *
 * Production (`DATABASE_URL` set): postgres.js against the Supavisor
 * transaction pooler. The three settings below are not tuning, they are the
 * difference between surviving the 08:00 burst and connection exhaustion:
 *
 *   port 6543        transaction-mode pooling (direct :5432 is for migrations)
 *   max: 1           each serverless instance holds ONE connection; fifty
 *                    instances × pool of ten is how max_connections dies
 *   prepare: false   named prepared statements break behind a transaction
 *                    pooler, which hands each query a different backend
 *
 * Development (no `DATABASE_URL`): PGlite — real Postgres compiled to WASM,
 * migrations + seed applied on first touch. Zero accounts, zero Docker; the
 * whole registration flow runs on a laptop, which is what lets development
 * proceed before the Supabase project exists.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Walk up from this file until the repo root (which holds supabase/). */
function findMigrationsDir() {
  let dir = HERE;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'supabase', 'migrations');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error('supabase/migrations not found above ' + HERE);
}

async function createPglite() {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  const dir = findMigrationsDir();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await pg.exec(readFileSync(join(dir, f), 'utf8'));
  }
  const { seedDev, seedPgDev, seedStudentsDev } = await import('./seed-dev.js');
  await seedDev(pg);
  await seedPgDev(pg);
  await seedStudentsDev(pg);
  return {
    query: (text, params = []) => pg.query(text, params),
    kind: 'pglite',
  };
}

/**
 * A malformed DATABASE_URL surfaces deep inside the driver as a bare
 * "TypeError: Invalid URL" with the value redacted — from a build log that
 * tells you nothing. Check the shape here and name the two mistakes that
 * actually happen: the [YOUR-PASSWORD] placeholder left in place, and a
 * password containing characters that are illegal unencoded in a URL.
 */
function assertConnectionString(url) {
  if (url.includes('[') || url.includes(']')) {
    throw new Error(
      'DATABASE_URL còn dấu ngoặc vuông — bạn chưa thay [YOUR-PASSWORD] bằng mật khẩu thật.',
    );
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      'DATABASE_URL không phải URL hợp lệ. Thường do mật khẩu chứa ký tự đặc biệt '
      + '(@ # / ? : &) — đặt lại mật khẩu database chỉ gồm chữ và số, rồi ghép lại chuỗi.',
    );
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw new Error(`DATABASE_URL phải bắt đầu bằng postgresql:// — đang là "${parsed.protocol}"`);
  }
  if (parsed.port !== '6543') {
    console.warn(
      `[@atl/db] Cổng ${parsed.port || '(mặc định 5432)'} — production phải dùng `
      + 'Transaction pooler cổng 6543, nếu không sẽ cạn connection lúc cao điểm.',
    );
  }
}

/**
 * The four numbers that decide whether the app survives 08:00 on 12/09.
 * Exported so a test can pin them — each one was added after a real
 * incident, and each is the kind of thing a well-meaning cleanup deletes.
 */
export const POSTGRES_OPTIONS = Object.freeze({
  max: 1,              // one connection per serverless instance (§ header)
  prepare: false,      // named statements break behind a transaction pooler
  idle_timeout: 20,    // return the slot to the 200-client cap when idle
  connect_timeout: 10, // a stalled handshake fails fast instead of hanging
});

function createPostgres(url) {
  assertConnectionString(url);
  // Lazy import so the dev path never pays for it.
  return import('postgres').then(({ default: postgres }) => {
    // idle_timeout: hand the connection back when this instance goes quiet.
    //
    // Supavisor caps CLIENT connections — 200 on Micro, and the dashboard
    // says the number "cannot be changed" at that compute size. Past it the
    // answer is a hard EMAXCONN error, not a queue.
    //
    // The trap is that the cap counts WARM INSTANCES, not concurrent
    // requests. `getDb` stashes this client on globalThis so a warm Vercel
    // instance reuses it — deliberately, it saves a TLS handshake to
    // Singapore on every request — but without a timeout that instance also
    // holds its slot in the 200 while doing nothing at all. At 08:00 on
    // 12/09, with both venues arriving at once, Vercel fans out to many more
    // instances than there are simultaneous requests, and they stay warm for
    // minutes afterwards. Requests would then fail on connect while the
    // database sits nearly idle.
    //
    // 20s is chosen against the traffic shape: inside a burst the connection
    // never goes idle that long, so the hot path keeps its handshake saving;
    // between bursts the slot goes back to the pool. Measured for real in
    // the §4.3 load rehearsal — treat this number as a starting point.
    //
    // connect_timeout: a stalled handshake fails in 10s instead of eating the
    // function budget. Added 06/09 as a defensive guess; the real cause of
    // that day's hang turned out to be pipelining (see serializeQueries) —
    // kept anyway, a handshake to Singapore is ~100ms and 10s is generous.
    const sql = postgres(url, POSTGRES_OPTIONS);
    const query = serializeQueries((text, params) => sql.unsafe(text, params), QUERY_TIMEOUT_MS);
    return { query, kind: 'postgres' };
  });
}

/** Hard cap on one statement. Why it exists: see serializeQueries. */
export const QUERY_TIMEOUT_MS = 10_000;

/**
 * One statement in flight per connection, and none allowed to run forever.
 *
 * THE INCIDENT — 06/09, then reproduced on demand during the 07/09 load
 * rehearsal. postgres.js with `max: 1` PIPELINES concurrent queries onto its
 * single socket: a route doing `Promise.all([q1, q2, q3])` puts three
 * statements on the wire back to back. Supavisor in transaction mode does
 * not cope with pipelined clients. pg_stat_activity showed backends `active`
 * on wait_event `ClientRead` for 7+ minutes — Postgres mid-conversation,
 * waiting for a client that had gone silent — and every one of them was
 * running /api/admin/overview's first statement. The two routes built on
 * Promise.all (/api/refdata, /api/admin/overview) failed 96% of attempts at
 * a mere 2 req/s, each hang holding a function and a pooler slot for a
 * minute or more; the cron route, which queries sequentially, never failed
 * once in the same window. Vercel Fluid Compute makes it worse: concurrent
 * requests share an instance, so they share the one connection, so they
 * pipeline.
 *
 * Fix 1 — serialize. A promise chain guarantees at most one statement is on
 * the wire per connection. Cost: one extra round-trip (~50ms) per extra
 * query; refdata goes from 3 parallel to 3 sequential. Cheap, and it removes
 * the failure mode rather than papering over it.
 *
 * Fix 2 — timeout + cancel. A statement that has not answered in
 * QUERY_TIMEOUT_MS rejects, and postgres.js's `.cancel()` sends
 * pg_cancel_backend so the backend is released instead of sitting in
 * ClientRead until Vercel reaps the function. The route turns that into a
 * fast 5xx; the registration form already retries — a 10-second error
 * self-heals, a 5-minute hang does not.
 *
 * Pure on purpose: `runner(text, params)` returns a thenable (postgres.js's
 * PendingQuery), so the tests drive it with fakes and never open a socket.
 */
export function serializeQueries(runner, timeoutMs = QUERY_TIMEOUT_MS) {
  let chain = Promise.resolve();
  return function query(text, params = []) {
    const run = chain.then(() => withTimeout(runner(text, params), timeoutMs, text));
    // A failure must not poison the chain for the next caller.
    chain = run.then(() => {}, () => {});
    return run.then((rows) => ({ rows }));
  };
}

function withTimeout(pending, ms, text) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // Release the backend, not just our promise. postgres.js queries carry
      // cancel(); a test fake may not — hence the optional call.
      try { pending.cancel?.(); } catch { /* best effort */ }
      reject(new Error(
        `[@atl/db] truy vấn quá ${ms}ms, đã huỷ: ${String(text).replace(/\s+/g, ' ').slice(0, 80)}`,
      ));
    }, ms);
    Promise.resolve(pending).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * PGlite is the DEVELOPMENT backend, and production must never reach it.
 *
 * It is an empty in-memory Postgres that seeds itself from `seed-dev.js` —
 * five fake students and, worse, three working PG claim codes (K7M3QX,
 * P4R8TW, B2C5DF). Booting on it in production would serve real students an
 * empty database and make those demo codes live scanners.
 *
 * Today that fallback happens to crash anyway, because the migration .sql
 * files are not in the serverless bundle. That is luck, not a guarantee:
 * bundle one file differently and the app comes up on fixtures, quietly.
 *
 * Hit for real on 04/09/2026: the production build was two hours older than
 * the DATABASE_URL variable, and Vercel freezes env vars at build time — so
 * the running build never saw the variable and fell through to here. The
 * message names that cause, because "DATABASE_URL is missing" sends people
 * to check a setting that is already correct.
 */
export function assertDatabaseConfigured(url) {
  if (url || process.env.NODE_ENV !== 'production') return;
  throw new Error(
    'DATABASE_URL trống trên production — dừng, KHÔNG chạy tiếp bằng database '
    + 'tạm (PGlite): nó rỗng và chứa dữ liệu mẫu, kể cả mã máy quét demo. '
    + 'Nguyên nhân thường gặp: biến môi trường được thêm SAU khi bản deploy này '
    + 'được build. Vercel đóng băng biến lúc build, nên sửa biến thôi chưa đủ — '
    + 'phải deploy lại production.',
  );
}

/**
 * Singleton across hot reloads. Next.js re-evaluates modules in dev; without
 * the globalThis stash every reload would boot a fresh empty PGlite and
 * "lose" all registrations, which reads as a data-loss bug while developing.
 */
export function getDb() {
  if (!globalThis.__atlDb) {
    const url = process.env.DATABASE_URL;
    // Before the stash, so a misconfigured boot keeps failing loudly instead
    // of caching a broken handle and going quiet on the second request.
    assertDatabaseConfigured(url);
    globalThis.__atlDb = url ? createPostgres(url) : createPglite();
  }
  return globalThis.__atlDb;
}
