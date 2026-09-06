/**
 * serializeQueries — the fix for the 06/09 hang, reproduced 07/09.
 *
 * Under Supavisor (transaction mode) a pipelined client — two statements on
 * one socket before the first answers — left backends stuck in ClientRead
 * for minutes. These tests pin the two properties that remove that failure:
 * strictly one statement in flight per connection, and no statement allowed
 * to hang past the timeout (with the backend told to cancel).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { serializeQueries, QUERY_TIMEOUT_MS } from '../src/index.js';

/** A fake PendingQuery: resolves when told to, records cancel(). */
function pending() {
  let resolve, reject;
  const p = new Promise((res, rej) => { resolve = res; reject = rej; });
  p.cancelled = false;
  p.cancel = () => { p.cancelled = true; };
  return { p, resolve, reject };
}

describe('serializeQueries', () => {
  test('never has two statements on the wire at once', async () => {
    let inflight = 0, maxInflight = 0;
    const order = [];
    const runner = (text) => {
      inflight++; maxInflight = Math.max(maxInflight, inflight);
      order.push('start ' + text);
      return new Promise((res) => setTimeout(() => {
        inflight--; order.push('end ' + text); res([{ text }]);
      }, 10));
    };
    const query = serializeQueries(runner, 1000);
    // Exactly the shape of /api/refdata: three queries fired together.
    const out = await Promise.all([query('q1'), query('q2'), query('q3')]);
    assert.equal(maxInflight, 1, 'pipelining is the bug — at most one in flight');
    assert.deepEqual(order, ['start q1', 'end q1', 'start q2', 'end q2', 'start q3', 'end q3']);
    assert.deepEqual(out.map((o) => o.rows[0].text), ['q1', 'q2', 'q3']);
  });

  test('a failing statement does not block the ones queued behind it', async () => {
    const runner = (text) => text === 'bad' ? Promise.reject(new Error('boom')) : Promise.resolve([text]);
    const query = serializeQueries(runner, 1000);
    const bad = query('bad');
    const good = query('good');
    await assert.rejects(bad, /boom/);
    assert.deepEqual((await good).rows, ['good']);
  });

  test('a stalled statement rejects at the timeout AND cancels the backend', async () => {
    const stuck = pending();               // never resolves — a ClientRead hang
    const query = serializeQueries(() => stuck.p, 30);
    const t0 = Date.now();
    await assert.rejects(query('select 1'), /quá 30ms, đã huỷ/);
    assert.ok(Date.now() - t0 < 500, 'must fail fast, not wait for the socket');
    assert.equal(stuck.p.cancelled, true, 'cancel() frees the backend, not just our promise');
  });

  test('after a timeout the next statement still runs', async () => {
    let n = 0;
    const runner = () => (++n === 1 ? pending().p : Promise.resolve(['ok']));
    const query = serializeQueries(runner, 20);
    await assert.rejects(query('first'), /đã huỷ/);
    assert.deepEqual((await query('second')).rows, ['ok']);
  });

  test('a fast statement is untouched by the timer (no leaked rejection)', async () => {
    const query = serializeQueries(() => Promise.resolve([1]), 20);
    assert.deepEqual((await query('x')).rows, [1]);
    await new Promise((r) => setTimeout(r, 40)); // timer would have fired by now
  });

  test('production timeout is 10 seconds — inside the function budget', () => {
    assert.equal(QUERY_TIMEOUT_MS, 10_000);
  });
});
