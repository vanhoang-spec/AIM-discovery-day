/**
 * Mã truy cập tách khỏi mã QR — vá bảo mật 26/11.
 *
 * Khoá ký mã QR nằm trong JavaScript công khai của app PG
 * (`NEXT_PUBLIC_ATL_HMAC_KEY`, PG cần nó để kiểm mã khi mất mạng). Trước bản vá,
 * /api/toi, /api/toi/pass và /api/khao-sat xác thực bằng chính mã QR: ai lấy
 * được khoá đó tự ký mã cho mọi `seq` rồi đọc họ tên, mã tra cứu, badge của
 * người khác. Ở đây người tấn công được giả định CẦM khoá QR (`QR_KEY` dưới),
 * và mọi đường đọc dữ liệu cá nhân phải đóng với họ.
 *
 * Gọi thẳng route handler thật trên PGlite dev (seed SV seq 1001–1005 ở sự
 * kiện 1), không chép lại logic.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/next-alias.mjs';
import { mintToken, verifyToken, importKey, TOKEN_LENGTH } from '@atl/qr-token';

for (const k of ['ATL_HMAC_KEY', 'ATL_ACCESS_KEY', 'DATABASE_URL', 'CRON_SECRET', 'RESEND_API_KEY', 'EMAIL_FROM']) {
  delete process.env[k];
}
process.env.NODE_ENV = 'test';

/** Khoá QR dev — đúng thứ app PG nhúng vào JS công khai. Người tấn công có nó. */
const QR_KEY = await importKey('atl2026-dev-key-do-not-use-in-production');
const OTHER_KEY = await importKey('khoa-cua-nguoi-khac-hoan-toan-0123456789');

const lib = await import('../src/lib/access-token.js');
const { mintAccessToken, verifyAccessToken, accessSecret, getAccessKey, ACCESS_TOKEN_LENGTH } = lib;
const toi = await import('../src/app/api/toi/route.js');
const pass = await import('../src/app/api/toi/pass/route.js');
const khaoSat = await import('../src/app/api/khao-sat/route.js');
const register = await import('../src/app/api/register/route.js');
const outbox = await import('../src/app/api/cron/outbox/route.js');
const { getDb } = await import('@atl/db');

const ACCESS_KEY = await getAccessKey();
const SV = { eventInstance: 1, studentSeq: 1001 }; // seed dev: Nguyễn Thị Minh An, A00001

const get = (handler, path, t) =>
  handler.GET(new Request(`http://localhost${path}?t=${encodeURIComponent(t)}`));

describe('định dạng mã truy cập', () => {
  test('26 ký tự như mã QR (link ngắn), nhưng khác mã QR của cùng người', async () => {
    const access = await mintAccessToken(SV, ACCESS_KEY);
    const qr = await mintToken(SV, QR_KEY);
    assert.equal(access.length, ACCESS_TOKEN_LENGTH);
    assert.equal(ACCESS_TOKEN_LENGTH, TOKEN_LENGTH);
    assert.match(access, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.notEqual(access, qr);
    assert.equal(await mintAccessToken(SV, ACCESS_KEY), access, 'xác định: thư gửi lại mang đúng link cũ');
  });

  test('máy PG không bao giờ nhận mã truy cập là mã QR (kể cả cùng khoá)', async () => {
    const access = await mintAccessToken(SV, QR_KEY);
    const v = await verifyToken(access, QR_KEY);
    assert.equal(v.valid, false);
    assert.equal(v.reason, 'unsupported_version');
  });

  test('mã QR hợp lệ KHÔNG phải mã truy cập hợp lệ — báo đúng lý do qr_token', async () => {
    const qr = await mintToken(SV, QR_KEY);
    assert.equal((await verifyToken(qr, QR_KEY)).valid, true, 'mã QR vẫn quét được ở PG');
    const v = await verifyAccessToken(qr, ACCESS_KEY);
    assert.deepEqual(v, { valid: false, reason: 'qr_token' });
  });

  test('ký bằng khoá QR (khoá công khai ở PG) hay khoá lạ đều bad_signature', async () => {
    for (const key of [QR_KEY, OTHER_KEY]) {
      const forged = await mintAccessToken(SV, key);
      assert.deepEqual(await verifyAccessToken(forged, ACCESS_KEY), { valid: false, reason: 'bad_signature' });
    }
  });

  test('mọi đột biến một ký tự đều bị từ chối', async () => {
    const access = await mintAccessToken(SV, ACCESS_KEY);
    const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    for (let i = 0; i < access.length; i++) {
      for (const ch of ALPHABET) {
        if (ch === access[i]) continue;
        const mutated = access.slice(0, i) + ch + access.slice(i + 1);
        const v = await verifyAccessToken(mutated, ACCESS_KEY);
        assert.equal(v.valid, false, `đột biến vị trí ${i} → ${ch} lọt qua`);
      }
    }
  });

  test('rác / rỗng / quá dài / không phải chuỗi → malformed, không throw', async () => {
    for (const bad of ['', 'abc', '!!!!', 'U'.repeat(26), 'M'.repeat(200), null, undefined, 42]) {
      const v = await verifyAccessToken(bad, ACCESS_KEY);
      assert.equal(v.valid, false);
      assert.equal(v.reason, 'malformed', `${String(bad).slice(0, 20)}`);
    }
  });

  test('kiểm đúng mã thật → ra đúng sự kiện và seq', async () => {
    const access = await mintAccessToken({ eventInstance: 2, studentSeq: 123456 }, ACCESS_KEY);
    assert.deepEqual(await verifyAccessToken(access, ACCESS_KEY),
      { valid: true, eventInstance: 2, studentSeq: 123456 });
    // Đọc lại từ chữ thường / có gạch (gõ tay) vẫn ra đúng người.
    assert.equal((await verifyAccessToken(access.toLowerCase(), ACCESS_KEY)).valid, true);
  });
});

describe('khoá ATL_ACCESS_KEY', () => {
  test('production thiếu khoá thì dừng hẳn, không ký bằng khoá dev', () => {
    assert.throws(() => accessSecret({ NODE_ENV: 'production', ATL_HMAC_KEY: 'q'.repeat(32) }),
      /ATL_ACCESS_KEY is required in production/);
  });

  test('đặt trùng ATL_HMAC_KEY (khoá công khai ở PG) thì từ chối chạy', () => {
    const same = 'z'.repeat(40);
    assert.throws(() => accessSecret({ NODE_ENV: 'production', ATL_HMAC_KEY: same, ATL_ACCESS_KEY: same }),
      /must differ from ATL_HMAC_KEY/);
    assert.throws(() => accessSecret({ ATL_ACCESS_KEY: 'atl2026-dev-key-do-not-use-in-production' }),
      /must differ/);
  });

  test('production đủ hai khoá khác nhau thì dùng đúng khoá đã đặt', () => {
    assert.equal(accessSecret({ NODE_ENV: 'production', ATL_HMAC_KEY: 'q'.repeat(32), ATL_ACCESS_KEY: 'a'.repeat(32) }),
      'a'.repeat(32));
  });

  test('dev thiếu khoá thì có khoá dev riêng, khác khoá QR dev', () => {
    const dev = accessSecret({});
    assert.ok(dev.length >= 16);
    assert.notEqual(dev, 'atl2026-dev-key-do-not-use-in-production');
  });
});

describe('/api/toi và /api/toi/pass chỉ mở bằng mã truy cập', () => {
  test('mã QR hợp lệ (ai có khoá PG cũng ký được) → 401 ở cả hai route', async () => {
    const qr = await mintToken(SV, QR_KEY);
    for (const [h, path] of [[toi, '/api/toi'], [pass, '/api/toi/pass']]) {
      const res = await get(h, path, qr);
      assert.equal(res.status, 401, path);
      const body = await res.json();
      assert.equal(body.reason, 'qr_token');
      assert.equal(body.full_name, undefined);
      assert.equal(body.lookup_code, undefined);
      assert.equal(body.badge_count, undefined);
    }
  });

  test('mã truy cập giả (ký bằng khoá QR / khoá lạ) và mã rác → 401', async () => {
    const forged = [
      await mintAccessToken(SV, QR_KEY),
      await mintAccessToken(SV, OTHER_KEY),
      'MZZZZZZZZZZZZZZZZZZZZZZZZZ',
      '',
      'not-a-token',
    ];
    for (const t of forged) {
      for (const [h, path] of [[toi, '/api/toi'], [pass, '/api/toi/pass']]) {
        const res = await get(h, path, t);
        assert.equal(res.status, 401, `${path} nhận ${t}`);
      }
    }
  });

  test('quét hết seq bằng mã tự ký cũng không đọc được ai', async () => {
    for (let seq = 1001; seq <= 1005; seq++) {
      const qr = await mintToken({ eventInstance: 1, studentSeq: seq }, QR_KEY);
      const fake = await mintAccessToken({ eventInstance: 1, studentSeq: seq }, QR_KEY);
      for (const t of [qr, fake]) {
        assert.equal((await get(pass, '/api/toi/pass', t)).status, 401);
      }
    }
  });

  test('mã truy cập đúng → /api/toi trả tiến độ của đúng người', async () => {
    const res = await get(toi, '/api/toi', await mintAccessToken(SV, ACCESS_KEY));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.event_id, 1);
    assert.equal(typeof body.badge_count, 'number');
    assert.ok(Array.isArray(body.tiers));
    assert.match(res.headers.get('cache-control'), /no-store/);
  });

  test('mã truy cập đúng → /api/toi/pass trả thẻ: mã QR quét được ở PG + mã truy cập', async () => {
    const access = await mintAccessToken(SV, ACCESS_KEY);
    const res = await get(pass, '/api/toi/pass', access);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.full_name, 'Nguyễn Thị Minh An');
    assert.equal(body.lookup_code, 'A00001');
    assert.equal(body.access, access);
    assert.match(body.qr_svg, /^<svg/);
    // Mã QR trong thẻ chính là mã PG đang quét — định dạng không đổi.
    assert.equal(body.token, await mintToken(SV, QR_KEY));
    const v = await verifyToken(body.token, QR_KEY);
    assert.equal(v.valid, true);
    assert.equal(v.studentSeq, 1001);
    assert.match(res.headers.get('cache-control'), /no-store/);
  });

  test('mã truy cập đúng nhưng SV không đăng ký sự kiện đó → 404, không lộ gì', async () => {
    const res = await get(pass, '/api/toi/pass', await mintAccessToken({ eventInstance: 2, studentSeq: 1001 }, ACCESS_KEY));
    assert.equal(res.status, 404);
    assert.equal((await res.json()).full_name, undefined);
  });
});

describe('/api/khao-sat cũng chỉ mở bằng mã truy cập', () => {
  test('GET bằng mã QR → 401; bằng mã truy cập → 200', async () => {
    const qr = await mintToken(SV, QR_KEY);
    assert.equal((await get(khaoSat, '/api/khao-sat', qr)).status, 401);
    const ok = await get(khaoSat, '/api/khao-sat', await mintAccessToken(SV, ACCESS_KEY));
    assert.equal(ok.status, 200);
    assert.ok(Array.isArray((await ok.json()).surveys));
  });

  test('POST bằng mã QR → 401 (không trả lời / cộng badge hộ người khác)', async () => {
    const res = await khaoSat.POST(new Request('http://localhost/api/khao-sat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        t: await mintToken(SV, QR_KEY), survey_id: 1,
        response_uid: '00000000-0000-4000-8000-000000000000', answers: {},
      }),
    }));
    assert.equal(res.status, 401);
  });
});

describe('/api/register trả thêm mã truy cập', () => {
  test('đăng ký mới → mã QR (khoá QR) + mã truy cập (khoá server) của đúng người', async () => {
    const res = await register.POST(new Request('http://localhost/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        full_name: 'Đỗ Thị Kiểm Thử', email: 'kiem.thu@example.vn', phone: '0977000111',
        event_id: 1, school_id: 1, student_code: 'KT0001', consent_event: true,
      }),
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    const qr = await verifyToken(body.token, QR_KEY);
    assert.equal(qr.valid, true);
    assert.equal(qr.studentSeq, body.seq);
    const acc = await verifyAccessToken(body.access, ACCESS_KEY);
    assert.deepEqual(acc, { valid: true, eventInstance: 1, studentSeq: body.seq });
    // Và mã truy cập đó mở được điểm của chính người vừa đăng ký.
    assert.equal((await get(toi, '/api/toi', body.access)).status, 200);
  });
});

describe('outbox: link riêng trong thư dùng mã truy cập', () => {
  const realFetch = globalThis.fetch;
  const sent = [];
  before(async () => {
    process.env.RESEND_API_KEY = 're_test_not_real';
    process.env.EMAIL_FROM = 'BTC <btc@example.vn>';
    globalThis.fetch = async (url, init) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: `fake-${sent.length}` }), { status: 200 });
    };
  });
  after(() => {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
  });

  test('thư nhắc mang /toi#t=<mã truy cập> của đúng người, không phải mã QR', async () => {
    const db = await getDb();
    const st = (await db.query(`select id from students where seq = 1002`)).rows[0];
    await db.query(
      `insert into notification_outbox (channel, student_id, event_id, template, recipient)
       values ('email', $1, 1, 'reminder_d1', 'sv1002@example.vn')`,
      [st.id],
    );

    const res = await outbox.GET(new Request('http://localhost/api/cron/outbox'));
    assert.equal(res.status, 200);
    const mail = sent.find((m) => m.to[0] === 'sv1002@example.vn');
    assert.ok(mail, 'thư nhắc phải được gửi');

    const links = [...`${mail.html}\n${mail.text}`.matchAll(/\/toi#t=([A-Za-z0-9%_\-.~]+)/g)]
      .map((m) => decodeURIComponent(m[1]));
    assert.ok(links.length > 0, 'thư phải có link riêng /toi#t=');
    for (const t of links) {
      assert.deepEqual(await verifyAccessToken(t, ACCESS_KEY),
        { valid: true, eventInstance: 1, studentSeq: 1002 });
      assert.equal((await verifyToken(t, QR_KEY)).valid, false, 'link không được mang mã QR');
    }
    // Bấm link trong thư → /api/toi/pass mở được thẻ.
    assert.equal((await get(pass, '/api/toi/pass', links[0])).status, 200);
  });
});
