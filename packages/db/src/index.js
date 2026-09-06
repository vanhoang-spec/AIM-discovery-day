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
    // connect_timeout: fail loudly instead of hanging. On 06/09 /api/refdata
    // and /api/admin/overview sat silent for ~5 minutes ("Task timed out")
    // after ~9 hours with no traffic, while the cron route on the same
    // database answered every minute. Root cause NOT established; the
    // idle_timeout hypothesis was tested (45s idle, twice) and did not
    // reproduce. What IS certain: a stalled connect that eats the whole
    // function budget is the worst outcome — the registration form already
    // retries 3× on a fast error, and nothing retries a 60-second hang.
    // 10s is generous for a handshake to Singapore (normally ~100ms) and
    // still leaves the 15s default function budget room to respond.
    const sql = postgres(url, POSTGRES_OPTIONS);
    return {
      query: async (text, params = []) => {
        const rows = await sql.unsafe(text, params);
        return { rows };
      },
      kind: 'postgres',
    };
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
