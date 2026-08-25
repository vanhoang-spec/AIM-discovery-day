import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderConfirmEmail,
  renderReminderEmail,
  sendViaResend,
  subjectFor,
} from '../src/index.js';

const ev = {
  name: 'Discovery Day Hà Nội',
  venue_name: 'FTU Hà Nội',
  city: 'Hà Nội',
  starts_at: '2026-09-12T01:00:00Z', // 08:00 giờ VN
};
const student = { full_name: 'Nguyễn Văn <An>', lookup_code: 'K7M3QX' };
const base = {
  student,
  ev,
  qrPngBase64: 'iVBORw0KGgoAAAANSUhEUg',
  agendaUrl: 'https://atl.aimacademy.vn/lich',
  myUrl: 'https://atl.aimacademy.vn/toi',
};

describe('confirm email', () => {
  const msg = renderConfirmEmail(base);

  test('QR rides as a real attachment referenced by cid, never a remote image', () => {
    assert.equal(msg.attachments.length, 1);
    assert.equal(msg.attachments[0].content_id, 'qr-code');
    assert.equal(msg.attachments[0].content, base.qrPngBase64);
    assert.match(msg.html, /src="cid:qr-code"/);
    // The one rule that keeps the email working with images blocked:
    assert.doesNotMatch(msg.html, /img[^>]+src="https?:/);
  });

  test('lookup code is shown grouped, exactly as /toi shows it', () => {
    assert.match(msg.html, /K7M-3QX/);
    assert.match(msg.text, /K7M-3QX/);
  });

  test('event date renders in VN time with the Vietnamese weekday', () => {
    // 2026-09-12 is a Saturday.
    assert.match(msg.html, /Thứ bảy 12\/09\/2026/);
    assert.match(msg.text, /Thứ bảy 12\/09\/2026/);
  });

  test('student-controlled text is escaped in HTML, intact in plain text', () => {
    assert.match(msg.html, /Nguyễn Văn &lt;An&gt;/);
    assert.doesNotMatch(msg.html, /Nguyễn Văn <An>/);
    assert.match(msg.text, /Nguyễn Văn <An>/);
  });

  test('the save-the-image warning is present — the one instruction that matters', () => {
    assert.match(msg.html, /lưu ảnh mã QR/i);
    assert.match(msg.text, /lưu ảnh mã QR/i);
  });

  test('links to the agenda page', () => {
    assert.match(msg.html, /https:\/\/atl\.aimacademy\.vn\/lich/);
  });
});

describe('reminder emails', () => {
  test('each template gets its own subject and lead', () => {
    for (const [template, re] of [
      ['reminder_d3', /Còn 3 ngày/],
      ['reminder_d1', /Ngày mai/],
      ['morning', /Hôm nay/],
    ]) {
      const m = renderReminderEmail({ ...base, template });
      assert.equal(m.subject, subjectFor(template, ev));
      assert.match(m.html, re);
    }
  });

  test('reminders carry NO attachment — the QR lives in the confirm email and /toi', () => {
    const m = renderReminderEmail({ ...base, template: 'reminder_d1' });
    assert.equal(m.attachments.length, 0);
  });

  test('unknown template throws instead of sending something half-rendered', () => {
    assert.throws(() => subjectFor('newsletter', ev), /Unknown template/);
  });
});

describe('sendViaResend', () => {
  const msg = {
    from: 'ATL 2026 <hello@atl.aimacademy.vn>',
    to: 'sv@test.vn',
    subject: 'x',
    html: '<p>x</p>',
    text: 'x',
    attachments: [{ filename: 'qr.png', content: 'AAAA', content_id: 'qr-code' }],
  };

  test('posts the exact Resend shape with auth header', async () => {
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return { ok: true, json: async () => ({ id: 're_123' }) };
    };
    const r = await sendViaResend(msg, { apiKey: 'key-1', fetchImpl });
    assert.deepEqual(r, { ok: true, id: 're_123' });
    assert.equal(captured.url, 'https://api.resend.com/emails');
    assert.equal(captured.init.headers.Authorization, 'Bearer key-1');
    const body = JSON.parse(captured.init.body);
    assert.deepEqual(body.to, ['sv@test.vn']);
    assert.equal(body.attachments[0].content_id, 'qr-code');
  });

  test('HTTP failure returns ok:false with detail — it must NOT throw', async () => {
    const fetchImpl = async () => ({
      ok: false, status: 422, json: async () => ({ message: 'invalid from' }),
    });
    const r = await sendViaResend(msg, { apiKey: 'k', fetchImpl });
    assert.equal(r.ok, false);
    assert.match(r.error, /422/);
    assert.match(r.error, /invalid from/);
  });

  test('network failure returns ok:false so the outbox backoff owns the retry', async () => {
    const fetchImpl = async () => { throw new Error('ECONNRESET'); };
    const r = await sendViaResend(msg, { apiKey: 'k', fetchImpl });
    assert.equal(r.ok, false);
    assert.match(r.error, /network: ECONNRESET/);
  });

  test('refuses to run without an API key — a silent no-op would look like spam-folder trouble', async () => {
    await assert.rejects(sendViaResend(msg, { fetchImpl: async () => ({}) }), /apiKey/);
  });
});
