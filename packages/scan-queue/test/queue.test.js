import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ScanQueue, createMemoryStore, uuidv7, backoffMs, STATE, MAX_BATCH,
} from '../src/index.js';

/** Fake server: records every batch, answers with whatever the test dictates. */
function makeServer() {
  const server = {
    batches: [],
    seen: new Map(),      // scan_uid -> times received
    behaviour: 'ok',      // ok | fail | partial | drop-one
    badgeBySeq: new Map(),
  };
  server.send = async (batch) => {
    server.batches.push(batch);
    // A network failure means the request may never have reached the server,
    // so nothing is recorded as seen. Recording before throwing would model a
    // server that received every scan and then lied about it — and would make
    // the retried batch come back as 'replay' instead of 'counted'.
    if (server.behaviour === 'fail') throw new Error('network down');
    for (const s of batch) {
      server.seen.set(s.scan_uid, (server.seen.get(s.scan_uid) ?? 0) + 1);
    }
    return batch
      .filter((s, i) => !(server.behaviour === 'drop-one' && i === 0))
      .map((s) => {
        // A resend of a scan the server already settled comes back as replay —
        // exactly what the real ledger does via its primary key.
        const times = server.seen.get(s.scan_uid);
        const count = (server.badgeBySeq.get(s.student_seq) ?? 0) + 1;
        if (times === 1) server.badgeBySeq.set(s.student_seq, count);
        return {
          scan_uid: s.scan_uid,
          status: times > 1 ? 'replay' : 'counted',
          badge_count: server.badgeBySeq.get(s.student_seq),
          student_name: 'Nguyễn Thị Minh An',
        };
      });
  };
  return server;
}

let store, server, q, clock;

beforeEach(() => {
  store = createMemoryStore();
  server = makeServer();
  clock = 1_700_000_000_000;
  q = new ScanQueue({
    store,
    send: server.send,
    now: () => clock,
    random: () => 0.5, // deterministic jitter
  });
});

describe('uuidv7', () => {
  test('is well-formed and marks version 7', () => {
    const id = uuidv7(clock);
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('sorts in the order scans actually happened', () => {
    const ids = [];
    for (let i = 0; i < 50; i++) ids.push(uuidv7(clock + i * 7));
    assert.deepEqual([...ids].sort(), ids, 'lexical order must equal time order');
  });

  test('two scans in the same millisecond still differ', () => {
    const seen = new Set();
    for (let i = 0; i < 500; i++) seen.add(uuidv7(clock));
    assert.equal(seen.size, 500);
  });
});

describe('backoff', () => {
  test('grows then caps at 30 seconds', () => {
    const noJitter = () => 0.5; // exactly 1.0x
    assert.equal(backoffMs(1, noJitter), 1000);
    assert.equal(backoffMs(2, noJitter), 2000);
    assert.equal(backoffMs(5, noJitter), 16000);
    assert.equal(backoffMs(9, noJitter), 30000);
    assert.equal(backoffMs(50, noJitter), 30000);
  });

  test('jitter spreads retries so 40 devices do not stampede together', () => {
    // Without jitter every device that lost signal together retries together.
    const delays = new Set();
    for (let i = 0; i < 200; i++) delays.add(backoffMs(4, Math.random));
    assert.ok(delays.size > 100, `expected a wide spread, got ${delays.size} distinct values`);
    for (const d of delays) {
      assert.ok(d >= 4800 && d <= 11200, `${d}ms outside the ±40% band around 8000ms`);
    }
  });
});

describe('enqueue — the sub-150ms local path', () => {
  test('returns immediately without touching the network', async () => {
    const r = await q.enqueue({ student_seq: 1001, checkpoint_id: 1, student_name: 'An' });
    assert.equal(r.duplicate, false);
    assert.equal(r.item.state, STATE.PENDING);
    assert.equal(server.batches.length, 0, 'enqueue must not call the server');
  });

  test('a double tap is caught locally and shown as duplicate', async () => {
    await q.enqueue({ student_seq: 1001, checkpoint_id: 1 });
    const second = await q.enqueue({ student_seq: 1001, checkpoint_id: 1 });
    assert.equal(second.duplicate, true);
    assert.equal((await q.stats()).total, 1, 'no second row queued');
  });

  test('same student at a different checkpoint is a real scan, not a duplicate', async () => {
    await q.enqueue({ student_seq: 1001, checkpoint_id: 1 });
    const other = await q.enqueue({ student_seq: 1001, checkpoint_id: 2 });
    assert.equal(other.duplicate, false);
    assert.equal((await q.stats()).total, 2);
  });
});

describe('flush', () => {
  test('sends pending scans and marks them confirmed', async () => {
    for (let i = 0; i < 5; i++) await q.enqueue({ student_seq: 1000 + i, checkpoint_id: 1 });
    const res = await q.flush();
    assert.equal(res.sent, 5);
    const s = await q.stats();
    assert.equal(s.confirmed, 5);
    assert.equal(s.unsent, 0);
  });

  test('overwrites the local badge count with the server figure', async () => {
    await q.enqueue({ student_seq: 1001, checkpoint_id: 1 });
    await q.flush();
    const all = await store.all();
    assert.equal(all[0].badge_count, 1, 'server count wins over any local guess');
  });

  test('never runs two batches at once', async () => {
    for (let i = 0; i < 3; i++) await q.enqueue({ student_seq: 2000 + i, checkpoint_id: 1 });
    const [a, b] = await Promise.all([q.flush(), q.flush()]);
    const skipped = [a, b].filter((r) => r.skipped).length;
    assert.equal(skipped, 1, 'the second concurrent flush must be refused');
    for (const [, times] of server.seen) assert.equal(times, 1, 'no scan sent twice');
  });

  test('respects the batch limit', async () => {
    for (let i = 0; i < MAX_BATCH + 30; i++) {
      await q.enqueue({ student_seq: 3000 + i, checkpoint_id: 1 });
    }
    await q.flush();
    assert.equal(server.batches[0].length, MAX_BATCH);
    assert.equal((await q.stats()).unsent, 30);
  });
});

describe('losing the network — the property the event rests on', () => {
  test('an hour offline loses nothing and drains in order when signal returns', async () => {
    server.behaviour = 'fail';
    for (let i = 0; i < 60; i++) {
      await q.enqueue({ student_seq: 4000 + i, checkpoint_id: 1 });
      clock += 60_000; // one scan a minute for an hour
    }
    for (let i = 0; i < 5; i++) { await q.flush(); clock += 60_000; }

    let s = await q.stats();
    assert.equal(s.unsent, 60, 'every scan is still held');
    assert.equal(s.confirmed, 0);

    server.behaviour = 'ok';
    clock += 60_000;
    const res = await q.flush();
    assert.equal(res.sent, 60);

    s = await q.stats();
    assert.equal(s.confirmed, 60);
    assert.equal(s.unsent, 0);

    const order = server.batches.at(-1).map((x) => x.scan_uid);
    assert.deepEqual([...order].sort(), order, 'drained in the order scans happened');
  });

  test('a failed flush backs off instead of hammering', async () => {
    await q.enqueue({ student_seq: 5001, checkpoint_id: 1 });
    server.behaviour = 'fail';
    await q.flush();

    const afterFirst = (await store.all())[0];
    assert.equal(afterFirst.state, STATE.PENDING);
    assert.equal(afterFirst.attempts, 1);
    assert.ok(afterFirst.next_attempt_at > clock, 'must not be due immediately');

    // Nothing is due yet, so a flush right now sends nothing.
    const immediate = await q.flush();
    assert.equal(immediate.sent ?? 0, 0);
    assert.equal(server.batches.length, 1, 'no second attempt before the backoff elapses');

    clock += 60_000;
    server.behaviour = 'ok';
    const later = await q.flush();
    assert.equal(later.sent, 1);
  });

  test('replaying the same batch does not create a second badge', async () => {
    await q.enqueue({ student_seq: 6001, checkpoint_id: 1 });
    await q.flush();

    // Simulate the classic failure: the response was lost, so the device
    // believes the scan is unsent and sends it again.
    const item = (await store.all())[0];
    await store.put({ ...item, state: STATE.PENDING, next_attempt_at: 0 });
    await q.flush();

    assert.equal(server.seen.get(item.scan_uid), 2, 'the server saw it twice');
    assert.equal(server.badgeBySeq.get(6001), 1, 'but awarded exactly one badge');
    const finalItem = (await store.all())[0];
    assert.equal(finalItem.state, STATE.DUPLICATE, 'and the device settles it as duplicate');
  });

  test('a scan the server ignored stays queued rather than being assumed sent', async () => {
    for (let i = 0; i < 3; i++) await q.enqueue({ student_seq: 7000 + i, checkpoint_id: 1 });
    server.behaviour = 'drop-one';
    await q.flush();

    const s = await q.stats();
    assert.equal(s.confirmed, 2);
    assert.equal(s.unsent, 1, 'the unanswered scan must not be treated as delivered');
  });
});

describe('server verdicts', () => {
  const verdicts = [
    ['counted', STATE.CONFIRMED],
    ['repeat_not_counted', STATE.DUPLICATE],
    ['replay', STATE.DUPLICATE],
    ['pending_other_condition', STATE.CONFIRMED],
    ['rejected_unknown_student', STATE.REJECTED],
    ['rejected_device', STATE.REJECTED],
    ['rejected_out_of_scope', STATE.REJECTED],
  ];

  for (const [status, expected] of verdicts) {
    test(`${status} → ${expected}`, async () => {
      const qq = new ScanQueue({
        store: createMemoryStore(),
        send: async (batch) => batch.map((s) => ({ scan_uid: s.scan_uid, status, badge_count: 3 })),
        now: () => clock,
      });
      await qq.enqueue({ student_seq: 8001, checkpoint_id: 1 });
      await qq.flush();
      const item = (await qq.store.all())[0];
      assert.equal(item.state, expected);
    });
  }

  test('an unknown status is retried, not silently discarded', async () => {
    const qq = new ScanQueue({
      store: createMemoryStore(),
      send: async (batch) => batch.map((s) => ({ scan_uid: s.scan_uid, status: 'something_new' })),
      now: () => clock,
    });
    await qq.enqueue({ student_seq: 8002, checkpoint_id: 1 });
    await qq.flush();
    const item = (await qq.store.all())[0];
    assert.equal(item.state, STATE.PENDING);
    assert.equal(item.attempts, 1);
  });

  test('a rejected scan can be put back in line by the supervisor', async () => {
    const qq = new ScanQueue({
      store: createMemoryStore(),
      send: async (batch) =>
        batch.map((s) => ({ scan_uid: s.scan_uid, status: 'rejected_unknown_student' })),
      now: () => clock,
    });
    const { item } = await qq.enqueue({ student_seq: 8003, checkpoint_id: 1 });
    await qq.flush();
    assert.equal((await qq.store.get(item.scan_uid)).state, STATE.REJECTED);
    const back = await qq.retry(item.scan_uid);
    assert.equal(back.state, STATE.PENDING);
  });
});

describe('housekeeping', () => {
  test('prune keeps recent settled scans and drops the rest', async () => {
    for (let i = 0; i < 40; i++) {
      await q.enqueue({ student_seq: 9000 + i, checkpoint_id: 1 });
      clock += 10;
    }
    await q.flush();
    await q.prune({ keep: 10 });
    const s = await q.stats();
    assert.equal(s.total, 10);
  });

  test('prune never removes anything still unsent', async () => {
    server.behaviour = 'fail';
    for (let i = 0; i < 20; i++) await q.enqueue({ student_seq: 9500 + i, checkpoint_id: 1 });
    await q.flush();
    await q.prune({ keep: 0 });
    assert.equal((await q.stats()).unsent, 20, 'unsent scans are never pruned');
  });
});

describe('get — màn quét đọc lại lượt của chính nó sau flush (09/09)', () => {
  test('trả về bản đã settle với tên + badge từ server', async () => {
    const { item } = await q.enqueue({ student_seq: 8101, checkpoint_id: 2 });
    await q.flush();
    const settled = await q.get(item.scan_uid);
    assert.equal(settled.state, STATE.CONFIRMED);
    assert.equal(settled.server_status, 'counted');
    assert.equal(settled.student_name, 'Nguyễn Thị Minh An');
    assert.equal(settled.badge_count, 1);
  });

  test('uid không tồn tại → undefined, không ném lỗi', async () => {
    assert.equal(await q.get('khong-co-uid-nay'), undefined);
  });
});
