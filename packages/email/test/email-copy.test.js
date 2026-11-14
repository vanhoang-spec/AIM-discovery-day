/**
 * Mẫu thư theo sự kiện (events.email_copy, migration 0016).
 *
 * Hai điều không được xảy ra:
 *   1. Sự kiện cũ (email_copy NULL) nhận thư khác đi dù một byte — Hà Nội /
 *      TP.HCM đã gửi hàng nghìn thư bằng mẫu đó; ai sửa mẫu cũ phải cố ý sửa
 *      cả dấu vân tay bên dưới.
 *   2. Sự kiện có email_copy nhận bất kỳ chữ nào của ATL2026 ("Awaken The
 *      Lions", lịch /lich, Early Bird 8h45) — hoặc mất QR / mã dự phòng.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderConfirmEmail,
  renderReminderEmail,
  subjectFor,
  parseEmailCopy,
} from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const COPY = JSON.parse(readFileSync(join(HERE, 'fixtures', 'discovery-day-1711.json'), 'utf8'));

// ---------------------------------------------------------------------------
// 1. Mẫu cũ đứng yên
// ---------------------------------------------------------------------------

const oldEv = {
  name: 'Discovery Day Hà Nội',
  venue_name: 'FTU Hà Nội',
  city: 'Hà Nội',
  starts_at: '2026-09-12T01:00:00Z',
};
const oldBase = {
  student: { full_name: 'Nguyễn Văn <An>', lookup_code: 'K7M3QX' },
  ev: oldEv,
  qrPngBase64: 'iVBORw0KGgoAAAANSUhEUg',
  agendaUrl: 'https://atl.aimacademy.vn/lich',
  myUrl: 'https://atl.aimacademy.vn/toi',
};
const sha = (m) => createHash('sha256').update(JSON.stringify(m)).digest('hex');

// Chụp từ code TRƯỚC 0016 (commit 3d1cf4c), cùng dữ liệu oldBase.
const PRE_0016 = {
  confirm: '3deab0b6e33a06a2ed377cead8bea85ab58d49d63a7e684d8663117780404816',
  reminder_d3: '707995e2cf1aedf2b4225137eda832940d609279f2fdc6b4e4331ef97064e380',
  reminder_d1: 'abff7df91d84060e976d2c8c80f151e1fca0a0de323f5bcb2fce8cae42d17cb8',
  morning: 'c7b30dc2e5fa22a8bec8e1d487153e763e2a7df97ba2a3a8c5ad7ee03a28574e',
};

describe('sự kiện không có email_copy → thư y hệt mẫu cũ', () => {
  // Worker giờ đọc thêm ends_at + email_copy; hai cột đó không được làm đổi
  // một byte nào khi email_copy là NULL.
  for (const ev of [
    oldEv,
    { ...oldEv, email_copy: null },
    { ...oldEv, email_copy: null, ends_at: '2026-09-12T10:00:00Z' },
  ]) {
    const label = 'email_copy' in ev ? `email_copy null${ev.ends_at ? ' + ends_at' : ''}` : 'không có khoá';
    test(`confirm (${label})`, () => {
      assert.equal(sha(renderConfirmEmail({ ...oldBase, ev })), PRE_0016.confirm);
    });
    for (const template of ['reminder_d3', 'reminder_d1', 'morning']) {
      test(`${template} (${label})`, () => {
        assert.equal(sha(renderReminderEmail({ ...oldBase, ev, template })), PRE_0016[template]);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Mẫu kiểu AIM
// ---------------------------------------------------------------------------

const ev = {
  name: 'Discovery Day — tên nội bộ',
  venue_name: 'Tên nội bộ',
  city: 'TP.HCM',
  starts_at: '2026-11-17T01:00:00Z', // 08:00 giờ VN
  ends_at: '2026-11-17T10:30:00Z', // 17:30 giờ VN
  email_copy: COPY,
};
const base = {
  student: { full_name: 'Trần <script>alert(1)</script> & Bình', lookup_code: 'K7M3QX' },
  ev,
  qrPngBase64: 'iVBORw0KGgoAAAANSUhEUg',
  agendaUrl: 'https://atl.aimacademy.vn/lich',
  myUrl: 'https://atl.aimacademy.vn/toi',
};
const ATL_ONLY = [/Awaken The Lions/i, /\/lich/, /Early Bird/i, /8h45/, /8h00–17h00/, /Cannes Lions/];

describe('thư xác nhận kiểu AIM', () => {
  const msg = renderConfirmEmail(base);

  test('tiêu đề nguyên văn từ JSON', () => {
    assert.equal(msg.subject, 'AIM Academy - Cảm ơn bạn đã đăng ký tham gia Discovery Day');
    assert.equal(subjectFor('confirm', ev), msg.subject);
  });

  test('không còn một chữ nào của ATL2026 — cả HTML, text lẫn tiêu đề', () => {
    for (const re of ATL_ONLY) {
      assert.doesNotMatch(msg.html, re);
      assert.doesNotMatch(msg.text, re);
      assert.doesNotMatch(msg.subject, re);
    }
  });

  test('vẫn đính kèm QR thật qua cid, không ảnh từ xa', () => {
    assert.equal(msg.attachments.length, 1);
    assert.equal(msg.attachments[0].content_id, 'qr-code');
    assert.equal(msg.attachments[0].content, base.qrPngBase64);
    assert.match(msg.html, /src="cid:qr-code"/);
    assert.doesNotMatch(msg.html, /img[^>]+src="https?:/);
  });

  test('mã dự phòng có trong cả HTML và text', () => {
    assert.match(msg.html, /K7M-3QX/);
    assert.match(msg.html, /Mã dự phòng — đọc cho nhân viên khi không quét được/);
    assert.match(msg.text, /mã dự phòng này cho nhân viên: K7M-3QX/);
  });

  test('[14/11 AIM] có nút xem điểm cá nhân — link riêng từng SV, không phải /dang-ky', () => {
    const url = 'https://app.awakenthelions.net/toi#t=AbC-_123';
    const m = renderConfirmEmail({ ...base, myUrl: url });
    assert.ok(m.html.includes(`href="${url}"`));
    assert.ok(m.html.includes('Xem điểm và mã QR của bạn'));
    assert.ok(m.text.includes(url));
    assert.doesNotMatch(m.html, /\/dang-ky/);
    // Không có myUrl thì không có nút rỗng.
    const bare = renderConfirmEmail({ ...base, myUrl: undefined });
    assert.doesNotMatch(bare.html, /Xem điểm và mã QR/);
    assert.doesNotMatch(bare.html, /href=""/);
  });

  test('link xem điểm bị escape trong thuộc tính href', () => {
    const m = renderConfirmEmail({ ...base, myUrl: 'https://x.test/toi#t="><script>' });
    assert.doesNotMatch(m.html, /"><script>/);
  });

  test('tên có <script> bị escape trong HTML, nguyên vẹn trong text', () => {
    assert.doesNotMatch(msg.html, /<script>/i);
    assert.match(msg.html, /Trần &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; Bình/);
    assert.match(msg.text, /Xin chào Trần <script>alert\(1\)<\/script> & Bình,/);
  });

  test('đủ từng câu AIM gửi, đúng chỗ in đậm', () => {
    for (const s of [
      'Cảm ơn bạn đã đăng ký tham gia <b>Discovery Day - UEF</b>!',
      'Đừng quên lưu và sử dụng <b>QR Code</b> đính kèm trong email này',
      'thu thập <b>badge</b> và đổi quà khủng tại <b>Quầy Quà Trung Tâm</b> của Ban Tổ chức.',
      '<b>Lưu ý:</b> Hãy đảm bảo bạn mang theo QR Code trong suốt sự kiện để không bỏ lỡ cơ hội thu thập badge và nhận quà đặc biệt.',
      'vui lòng liên hệ Ban Tổ chức tại <b>lầu 6 (UEF campus 141-145 Điện Biên Phủ).</b>',
      'Hẹn gặp bạn tại UEF.',
      'Trân trọng cảm ơn.',
      'Ban tổ chức <b>Discovery Day - UEF.</b>',
    ]) assert.ok(msg.html.includes(s), `thiếu trong HTML: ${s}`);
    assert.ok(msg.text.includes('Cảm ơn bạn đã đăng ký tham gia Discovery Day - UEF!'));
    assert.ok(msg.text.includes('Ban tổ chức Discovery Day - UEF.'));
  });

  test('dấu chấm cuối trong JSON không thành hai dấu', () => {
    const m = renderConfirmEmail({
      ...base,
      ev: { ...ev, email_copy: { ...COPY, organizer: 'Discovery Day - UEF.', support_place: 'lầu 6.' } },
    });
    assert.ok(m.html.includes('Ban tổ chức <b>Discovery Day - UEF.</b>'));
    assert.ok(m.html.includes('tại <b>lầu 6.</b>'));
    assert.doesNotMatch(m.html + m.text, /\.\./);
  });

  test('chữ trong JSON cũng bị escape — admin dán HTML không lọt vào thư', () => {
    const m = renderConfirmEmail({
      ...base,
      ev: { ...ev, email_copy: { ...COPY, see_you: 'Hẹn <img src=x onerror=alert(1)> gặp' } },
    });
    assert.doesNotMatch(m.html, /<img src=x/);
    assert.match(m.html, /Hẹn &lt;img src=x onerror=alert\(1\)&gt; gặp/);
  });

  test('ảnh chữ ký: vắng thì không có; có thì đúng một ảnh từ xa, thuộc tính được escape', () => {
    const url = 'https://cdn.example.com/sig.png?a=1&b="x"';
    const m = renderConfirmEmail({
      ...base,
      ev: { ...ev, email_copy: { ...COPY, signature_image_url: url, signature_image_width: 240 } },
    });
    const remote = [...m.html.matchAll(/<img[^>]+src="(https?:[^"]*)"/g)].map((x) => x[1]);
    assert.deepEqual(remote, ['https://cdn.example.com/sig.png?a=1&amp;b=&quot;x&quot;']);
    assert.match(m.html, /width="240"/);
    assert.equal(m.attachments.length, 1, 'ảnh chữ ký không được biến thành tệp đính kèm');
  });
});

describe('thư nhắc 6h sáng kiểu AIM', () => {
  const msg = renderReminderEmail({ ...base, template: 'morning' });

  test('tiêu đề nguyên văn từ JSON', () => {
    assert.equal(
      msg.subject,
      'AIM Academy - Đừng bỏ lỡ những phần quà hấp dẫn tại Discovery Day (UEF campus 141-145 Điện Biên Phủ)',
    );
  });

  test('không đính kèm QR — nhưng có đường mở mã QR (/toi)', () => {
    assert.equal(msg.attachments.length, 0);
    assert.doesNotMatch(msg.html, /cid:qr-code/);
    assert.match(msg.html, /href="https:\/\/atl\.aimacademy\.vn\/toi"/);
    assert.match(msg.text, /Xem điểm và mã QR của bạn: https:\/\/atl\.aimacademy\.vn\/toi/);
  });

  test('không còn chữ ATL2026', () => {
    for (const re of ATL_ONLY) {
      assert.doesNotMatch(msg.html, re);
      assert.doesNotMatch(msg.text, re);
    }
  });

  test('câu mở đầu đã sửa lỗi gõ: không có khoảng trắng trước dấu chấm', () => {
    assert.ok(msg.html.includes('<b>Discovery Day</b> sẽ chính thức bắt đầu. Bạn đã sẵn sàng'));
    assert.ok(msg.text.includes('Discovery Day sẽ chính thức bắt đầu. Bạn đã sẵn sàng'));
    assert.doesNotMatch(msg.html + msg.text, /bắt đầu \./);
  });

  test('ba dòng thông tin đúng nguyên văn', () => {
    for (const s of [
      '<b>Địa điểm:</b> Sảnh và lầu 06 - (UEF campus 141-145 Điện Biên Phủ)',
      '<b>Thời gian:</b> 8h - 17h30, thứ ba, 17.11.2026',
      '<b>Booth hoạt động từ:</b> 7h45',
    ]) assert.ok(msg.html.includes(s), `thiếu: ${s}`);
    assert.ok(msg.text.includes('- Thời gian: 8h - 17h30, thứ ba, 17.11.2026'));
  });

  test('vẫn có Lưu ý, nơi hỗ trợ, hẹn gặp, chữ ký', () => {
    for (const s of ['<b>Lưu ý:</b>', 'tại <b>lầu 6 (UEF campus 141-145 Điện Biên Phủ).</b>',
      'Hẹn gặp bạn tại UEF.', 'Ban tổ chức <b>Discovery Day - UEF.</b>']) {
      assert.ok(msg.html.includes(s), `thiếu: ${s}`);
    }
  });

  test('tên có <script> bị escape', () => {
    assert.doesNotMatch(msg.html, /<script>/i);
    assert.match(msg.html, /&lt;script&gt;/);
  });

  test('thiếu time_line → dựng từ starts_at/ends_at, ra đúng chữ AIM viết', () => {
    const { time_line, ...rest } = COPY;
    const m = renderReminderEmail({ ...base, template: 'morning', ev: { ...ev, email_copy: rest } });
    assert.ok(m.html.includes('<b>Thời gian:</b> 8h - 17h30, thứ ba, 17.11.2026'));
  });

  test('thiếu booth_opens → không in dòng booth rỗng', () => {
    const { booth_opens, ...rest } = COPY;
    const m = renderReminderEmail({ ...base, template: 'morning', ev: { ...ev, email_copy: rest } });
    assert.doesNotMatch(m.html + m.text, /Booth/);
  });

  test('mẫu AIM không có thư D-3 / D-1 — từ chối thay vì gửi câu "sắp bắt đầu" sai ngày', () => {
    for (const template of ['reminder_d3', 'reminder_d1']) {
      assert.throws(() => renderReminderEmail({ ...base, template }), /chỉ có confirm và morning/);
      assert.throws(() => subjectFor(template, ev), /chỉ có confirm và morning/);
    }
  });
});

describe('parseEmailCopy', () => {
  test('null / undefined → null (mẫu cũ)', () => {
    assert.equal(parseEmailCopy(null), null);
    assert.equal(parseEmailCopy(undefined), null);
  });

  test('nhận cả chuỗi JSON (driver trả jsonb dạng text)', () => {
    assert.deepEqual(parseEmailCopy(JSON.stringify(COPY)), parseEmailCopy(COPY));
  });

  test('liệt kê đủ mọi trường thiếu trong một lỗi', () => {
    assert.throws(
      () => parseEmailCopy({ event_title: 'X', subjects: { confirm: 'A' } }),
      (e) => /subjects\.morning/.test(e.message) && /support_place/.test(e.message)
        && /venue_line/.test(e.message) && /see_you/.test(e.message),
    );
  });

  test('chuỗi rỗng / toàn khoảng trắng không tính là có', () => {
    assert.throws(() => parseEmailCopy({ ...COPY, see_you: '   ' }), /thiếu see_you/);
  });

  test('ảnh chữ ký http (không s) bị từ chối', () => {
    assert.throws(() => parseEmailCopy({ ...COPY, signature_image_url: 'http://x/a.png' }), /https/);
  });

  test('xuống dòng trong tiêu đề bị gộp thành một dòng', () => {
    const c = parseEmailCopy({ ...COPY, subjects: { ...COPY.subjects, confirm: 'A\r\nBcc: x@y.z' } });
    assert.equal(c.subjects.confirm, 'A Bcc: x@y.z');
  });

  test('mảng / số / chuỗi không phải JSON bị từ chối', () => {
    assert.throws(() => parseEmailCopy([]), /object/);
    assert.throws(() => parseEmailCopy(42), /object/);
    assert.throws(() => parseEmailCopy('{oops'), /không phải JSON/);
  });
});

test('code không viết cứng chữ riêng của sự kiện — mọi chữ đó nằm trong JSON', () => {
  for (const f of ['packages/email/src/index.js', 'apps/web/src/app/api/cron/outbox/route.js']) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    for (const re of [/UEF/, /Điện Biên Phủ/, /17h30/, /7h45/]) {
      assert.doesNotMatch(src, re, `${f} chứa ${re}`);
    }
  }
});
