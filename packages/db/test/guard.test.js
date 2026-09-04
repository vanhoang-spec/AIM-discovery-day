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
