/**
 * CRON_SECRET bắt buộc trên production — vá bảo mật 26/11.
 *
 * Trước bản vá, route chỉ kiểm header KHI có CRON_SECRET: production quên đặt
 * biến là ai biết URL /api/cron/outbox cũng kích được outbox gửi thư. Giờ:
 *   - production thiếu CRON_SECRET → 503, không nhận dòng nào, không gửi thư;
 *   - có CRON_SECRET → bắt `Authorization: Bearer <CRON_SECRET>` như cũ;
 *   - ngoài production thiếu biến vẫn chạy (dev / test).
 */

import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/next-alias.mjs';

for (const k of ['ATL_HMAC_KEY', 'ATL_ACCESS_KEY', 'DATABASE_URL', 'CRON_SECRET', 'RESEND_API_KEY', 'EMAIL_FROM']) {
  delete process.env[k];
}
process.env.NODE_ENV = 'test';

const outbox = await import('../src/app/api/cron/outbox/route.js');
const { getDb } = await import('@atl/db');

const call = (auth) => outbox.GET(new Request('http://localhost/api/cron/outbox',
  auth === undefined ? {} : { headers: { authorization: auth } }));

const realFetch = globalThis.fetch;
let fetchCalls = 0;
let rowId;

before(async () => {
  // Database dựng ở chế độ dev, có sẵn một thư đang chờ gửi.
  const db = await getDb();
  const st = (await db.query(`select id from students where seq = 1003`)).rows[0];
  rowId = (await db.query(
    `insert into notification_outbox (channel, student_id, event_id, template, recipient)
     values ('email', $1, 1, 'reminder_d1', 'sv1003@example.vn') returning id`,
    [st.id],
  )).rows[0].id;
  globalThis.fetch = async () => { fetchCalls++; return new Response('{}', { status: 200 }); };
});

after(() => { globalThis.fetch = realFetch; });

afterEach(() => {
  process.env.NODE_ENV = 'test';
  for (const k of ['CRON_SECRET', 'RESEND_API_KEY', 'EMAIL_FROM', 'ATL_HMAC_KEY', 'ATL_ACCESS_KEY']) {
    delete process.env[k];
  }
});

async function outboxRow() {
  const db = await getDb();
  return (await db.query(`select status::text, attempts from notification_outbox where id = $1`, [rowId])).rows[0];
}

describe('production thiếu CRON_SECRET', () => {
  test('từ chối mọi lời gọi, kể cả có header — 503, lỗi nói rõ, không gửi thư', async () => {
    process.env.NODE_ENV = 'production';
    // Cấu hình gửi thư đầy đủ: nếu cổng hở, thư SẼ đi — nên "không gửi" là thật.
    process.env.RESEND_API_KEY = 're_test_not_real';
    process.env.EMAIL_FROM = 'BTC <btc@example.vn>';
    process.env.ATL_HMAC_KEY = 'q'.repeat(32);
    process.env.ATL_ACCESS_KEY = 'a'.repeat(32);

    for (const auth of [undefined, '', 'Bearer ', 'Bearer undefined', 'Bearer null', 'Bearer anything']) {
      const res = await call(auth);
      assert.equal(res.status, 503, `header ${JSON.stringify(auth)}`);
      const body = await res.json();
      assert.equal(body.error, 'cron_secret_missing');
      assert.match(body.message, /CRON_SECRET/);
    }
    assert.equal(fetchCalls, 0, 'không thư nào được gửi');
    assert.deepEqual(await outboxRow(), { status: 'queued', attempts: 0 }, 'không dòng nào bị nhận');
  });
});

describe('production có CRON_SECRET', () => {
  test('thiếu / sai header → 401, không gửi thư', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CRON_SECRET = 'cron-secret-for-test-0123456789';
    process.env.RESEND_API_KEY = 're_test_not_real';
    process.env.EMAIL_FROM = 'BTC <btc@example.vn>';
    for (const auth of [undefined, '', 'Bearer ', 'Bearer wrong', 'cron-secret-for-test-0123456789',
      'bearer cron-secret-for-test-0123456789', 'Bearer cron-secret-for-test-012345678']) {
      const res = await call(auth);
      assert.equal(res.status, 401, `header ${JSON.stringify(auth)}`);
    }
    assert.equal(fetchCalls, 0);
    assert.deepEqual(await outboxRow(), { status: 'queued', attempts: 0 });
  });

  test('đúng `Bearer <CRON_SECRET>` → qua cổng', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CRON_SECRET = 'cron-secret-for-test-0123456789';
    // Không cấu hình Resend: qua cổng thì route trả "skipped" — chứng minh đã qua
    // mà không chạm database production nào.
    const res = await call('Bearer cron-secret-for-test-0123456789');
    assert.equal(res.status, 200);
    assert.match((await res.json()).skipped, /RESEND_API_KEY/);
  });
});

describe('ngoài production', () => {
  test('thiếu CRON_SECRET vẫn chạy như cũ (dev / test)', async () => {
    const res = await call(undefined);
    assert.equal(res.status, 200);
    assert.match((await res.json()).skipped, /RESEND_API_KEY/);
  });

  test('có CRON_SECRET thì vẫn bắt header', async () => {
    process.env.CRON_SECRET = 'dev-secret-0123456789';
    assert.equal((await call('Bearer nope')).status, 401);
    assert.equal((await call('Bearer dev-secret-0123456789')).status, 200);
  });

  test('qua cổng và có cấu hình gửi → thư đi thật (đối chứng cho các bài trên)', async () => {
    process.env.RESEND_API_KEY = 're_test_not_real';
    process.env.EMAIL_FROM = 'BTC <btc@example.vn>';
    const res = await call(undefined);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.sent >= 1, JSON.stringify(body));
    assert.ok(fetchCalls >= 1);
    assert.equal((await outboxRow()).status, 'sent');
  });
});

describe('production thiếu ATL_ACCESS_KEY', () => {
  test('dừng TRƯỚC khi nhận dòng — không tiêu lượt thử của thư', async () => {
    const db = await getDb();
    const st = (await db.query(`select id from students where seq = 1004`)).rows[0];
    const id = (await db.query(
      `insert into notification_outbox (channel, student_id, event_id, template, recipient)
       values ('email', $1, 1, 'reminder_d1', 'sv1004@example.vn') returning id`,
      [st.id],
    )).rows[0].id;
    process.env.NODE_ENV = 'production';
    process.env.CRON_SECRET = 'cron-secret-for-test-0123456789';
    process.env.RESEND_API_KEY = 're_test_not_real';
    process.env.EMAIL_FROM = 'BTC <btc@example.vn>';
    process.env.ATL_HMAC_KEY = 'q'.repeat(32);
    const res = await call('Bearer cron-secret-for-test-0123456789');
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'access_key_missing');
    const row = (await db.query(`select status::text, attempts from notification_outbox where id = $1`, [id])).rows[0];
    assert.deepEqual(row, { status: 'queued', attempts: 0 });
  });
});
