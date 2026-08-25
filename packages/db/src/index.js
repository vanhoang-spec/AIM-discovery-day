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

function createPostgres(url) {
  // Lazy import so the dev path never pays for it.
  return import('postgres').then(({ default: postgres }) => {
    const sql = postgres(url, { max: 1, prepare: false });
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
 * Singleton across hot reloads. Next.js re-evaluates modules in dev; without
 * the globalThis stash every reload would boot a fresh empty PGlite and
 * "lose" all registrations, which reads as a data-loss bug while developing.
 */
export function getDb() {
  if (!globalThis.__atlDb) {
    const url = process.env.DATABASE_URL;
    globalThis.__atlDb = url ? createPostgres(url) : createPglite();
  }
  return globalThis.__atlDb;
}
