/**
 * The production database guard.
 *
 * Written after 04/09/2026, when production served `/api/refdata` a 500 for
 * hours: the deploy was built two hours before DATABASE_URL was added, so the
 * running bundle never saw it and fell through to the PGlite dev backend.
 * It only failed loudly by accident — the migration files were not in the
 * bundle. These tests make the refusal deliberate.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { assertDatabaseConfigured, getDb } from '../src/index.js';

const ENV = process.env.NODE_ENV;
const URL_ = process.env.DATABASE_URL;

beforeEach(() => {
  delete globalThis.__atlDb;
});

afterEach(() => {
  if (ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ENV;
  if (URL_ === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = URL_;
  delete globalThis.__atlDb;
});

describe('assertDatabaseConfigured', () => {
  test('production without DATABASE_URL refuses', () => {
    process.env.NODE_ENV = 'production';
    assert.throws(() => assertDatabaseConfigured(undefined), /DATABASE_URL trống/);
  });

  test('the message says to redeploy, not just to add the variable', () => {
    process.env.NODE_ENV = 'production';
    // The failure we actually hit had the variable set correctly already, so
    // an error that only says "missing" sends people to the wrong screen.
    assert.throws(() => assertDatabaseConfigured(''), /deploy lại production/);
  });

  test('production with a DATABASE_URL passes', () => {
    process.env.NODE_ENV = 'production';
    assert.doesNotThrow(() =>
      assertDatabaseConfigured('postgresql://u:p@host:6543/postgres'));
  });

  test('development without DATABASE_URL still allows PGlite', () => {
    process.env.NODE_ENV = 'development';
    assert.doesNotThrow(() => assertDatabaseConfigured(undefined));
  });

  test('test runs are not production either', () => {
    process.env.NODE_ENV = 'test';
    assert.doesNotThrow(() => assertDatabaseConfigured(undefined));
  });
});

describe('getDb', () => {
  test('refuses on production with no DATABASE_URL', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.DATABASE_URL;
    assert.throws(() => getDb(), /PGlite/);
  });

  test('keeps refusing — never caches a broken handle', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.DATABASE_URL;
    assert.throws(() => getDb(), /DATABASE_URL trống/);
    // A guard that fires once and then hands back a poisoned (or undefined)
    // stash would be worse than none: the first request 500s, every later one
    // fails somewhere deeper with no clue why.
    assert.throws(() => getDb(), /DATABASE_URL trống/);
    assert.equal(globalThis.__atlDb, undefined);
  });
});

describe('POSTGRES_OPTIONS', () => {
  // Each of these was added after a real incident. A refactor that drops one
  // will pass every other test and fail on event day, so pin them here.
  test('the five production settings are exactly what they must be', async () => {
    const { POSTGRES_OPTIONS: o } = await import('../src/index.js');
    assert.equal(o.max, 1, 'max:1 — 50 instances × pool of 10 is how max_connections dies');
    assert.equal(o.prepare, false, 'prepare:false — named statements break behind Supavisor');
    assert.equal(o.idle_timeout, 20, 'idle_timeout — warm-but-idle instances must release their slot');
    assert.equal(o.connect_timeout, 10, 'connect_timeout — 06/09: a stalled connect ate the whole function budget');
    // 08/09: postgres.js is plaintext unless told otherwise, and the dashboard
    // connection string does not tell it. The option must not depend on the URL.
    assert.equal(o.ssl, 'require', 'ssl:require — password and student data must not cross the internet in clear');
  });

  test('TLS does not depend on the connection string carrying sslmode', async () => {
    const { POSTGRES_OPTIONS: o } = await import('../src/index.js');
    // Whatever someone pastes, the code decides. A URL with no sslmode is the
    // exact string the Supabase dashboard hands out.
    const url = 'postgresql://u:p@host:6543/postgres';
    assert.ok(!url.includes('sslmode'));
    assert.equal(o.ssl, 'require');
  });

  test('is frozen — nothing can quietly mutate it at runtime', async () => {
    const { POSTGRES_OPTIONS: o } = await import('../src/index.js');
    assert.ok(Object.isFrozen(o));
  });
});
