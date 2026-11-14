/**
 * 0016 — events.email_copy + queue_event_reminders.
 *
 * Điều không được xảy ra:
 *   * chạy xếp thư nhắc hai lần → SV nhận hai thư;
 *   * SV của sự kiện KHÁC, SV không có email, SV đã bị gộp được xếp thư;
 *   * thư nhắc rời outbox trước giờ hẹn;
 *   * một email_copy thiếu trường lọt vào database (mọi thư xác nhận của sự
 *     kiện đó sẽ nổ lúc render);
 *   * database và @atl/email bất đồng về thế nào là email_copy hợp lệ;
 *   * file vá production lệch khỏi migration, hoặc áp lần hai làm hỏng.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { parseEmailCopy } from '../../packages/email/src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', 'migrations');
const MIGRATION_0016 = '0016_event_email_copy.sql';
const PATCH = join(HERE, '..', 'production-patch-0016.sql');
const COPY = JSON.parse(readFileSync(
  join(HERE, '..', '..', 'packages', 'email', 'test', 'fixtures', 'discovery-day-1711.json'), 'utf8'));

async function applyMigrations(pg, { upTo } = {}) {
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    if (upTo && f > upTo) break;
    await pg.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
}

async function seedEvents(pg) {
  await pg.exec(`
    insert into editions (id, year, name) values (1, 2026, 'ATL 2026');
    insert into events (id, edition_id, kind, slug, name, venue_name, city, starts_at, ends_at,
                        token_key_id)
    values (1, 1, 'discovery_day', 'hn', 'DD HN', 'FTU HN', 'HN',
            '2026-09-12 08:00+07', '2026-09-12 17:00+07', 'k1'),
           (2, 1, 'discovery_day', 'hcm', 'DD HCM', 'FTU HCM', 'HCM',
            '2026-09-12 08:00+07', '2026-09-12 17:00+07', 'k2'),
           (4, 1, 'discovery_day', 'dd-1711', 'DD 17/11', 'Trường', 'TP.HCM',
            '2026-11-17 08:00+07', '2026-11-17 17:30+07', 'k4');
    update events set is_registration_open = true;
  `);
}

async function reg(pg, { event_id, full_name, email, phone }) {
  const r = await pg.query(
    `select * from register_student(
       $1::smallint, $2, $3, $4, null, null, null, null, null, null, null, null,
       'general'::registration_type, 'online'::registration_source,
       true, false, '10.0.0.1'::inet, 'v1', null)`,
    [event_id, full_name, email ?? null, phone ?? null],
  );
  return r.rows[0];
}

const queue = (pg, ev, template = 'morning', at = '2026-11-17 06:00:00+07') =>
  pg.query(`select queue_event_reminders($1::smallint, $2, $3::timestamptz) as n`, [ev, template, at])
    .then((r) => r.rows[0].n);

const reminders = (pg, template = 'morning') =>
  pg.query(
    `select student_id, event_id, recipient, scheduled_at, status, payload
       from notification_outbox where template = $1 order by student_id`, [template],
  ).then((r) => r.rows);

let db;

describe('queue_event_reminders', () => {
  beforeEach(async () => {
    db = new PGlite();
    await applyMigrations(db);
    await seedEvents(db);
  });

  test('chạy hai lần không tạo thư trùng — lần hai trả 0', async () => {
    await reg(db, { event_id: 4, full_name: 'A', email: 'a@test.vn', phone: '0900000001' });
    await reg(db, { event_id: 4, full_name: 'B', email: 'b@test.vn', phone: '0900000002' });

    assert.equal(await queue(db, 4), 2);
    assert.equal(await queue(db, 4), 0);
    // Lần ba với giờ khác cũng không thêm, không dời giờ đã hẹn.
    assert.equal(await queue(db, 4, 'morning', '2026-11-17 05:00:00+07'), 0);

    const rows = await reminders(db);
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(new Date(r.scheduled_at).toISOString(), '2026-11-16T23:00:00.000Z');
      assert.equal(r.status, 'queued');
    }
  });

  test('chạy lại sau khi thư đã gửi / đã hỏng vẫn không gửi lại', async () => {
    const a = await reg(db, { event_id: 4, full_name: 'A', email: 'a@test.vn', phone: '0900000001' });
    const b = await reg(db, { event_id: 4, full_name: 'B', email: 'b@test.vn', phone: '0900000002' });
    await queue(db, 4);
    await db.query(`update notification_outbox set status = 'sent' where template = 'morning' and student_id = $1`, [a.student_id]);
    await db.query(`update notification_outbox set status = 'failed' where template = 'morning' and student_id = $1`, [b.student_id]);
    assert.equal(await queue(db, 4), 0);
    assert.equal((await reminders(db)).length, 2);
  });

  test('chỉ người mới đăng ký sau lượt trước được xếp ở lượt sau', async () => {
    await reg(db, { event_id: 4, full_name: 'A', email: 'a@test.vn', phone: '0900000001' });
    assert.equal(await queue(db, 4), 1);
    const late = await reg(db, { event_id: 4, full_name: 'Muộn', email: 'late@test.vn', phone: '0900000009' });
    assert.equal(await queue(db, 4), 1);
    const rows = await reminders(db);
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((r) => r.student_id === late.student_id).length, 1);
  });

  test('không bao giờ xếp cho SV của sự kiện khác', async () => {
    await reg(db, { event_id: 1, full_name: 'HN', email: 'hn@test.vn', phone: '0900000011' });
    await reg(db, { event_id: 2, full_name: 'HCM', email: 'hcm@test.vn', phone: '0900000012' });
    const mine = await reg(db, { event_id: 4, full_name: 'Mới', email: 'moi@test.vn', phone: '0900000013' });

    assert.equal(await queue(db, 4), 1);
    const rows = await reminders(db);
    assert.deepEqual(rows.map((r) => [Number(r.student_id), r.event_id]), [[Number(mine.student_id), 4]]);
  });

  test('SV đăng ký cả hai sự kiện: đúng một thư, gắn đúng sự kiện được gọi', async () => {
    const both = await reg(db, { event_id: 1, full_name: 'Cả hai', email: 'both@test.vn', phone: '0900000021' });
    await reg(db, { event_id: 4, full_name: 'Cả hai', email: 'both@test.vn', phone: '0900000021' });
    assert.equal(await queue(db, 4), 1);
    const rows = await reminders(db);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].student_id), Number(both.student_id));
    assert.equal(rows[0].event_id, 4);
  });

  test('bỏ qua SV không có email (chỉ đăng ký bằng số điện thoại)', async () => {
    await reg(db, { event_id: 4, full_name: 'Chỉ SĐT', email: null, phone: '0900000031' });
    const withMail = await reg(db, { event_id: 4, full_name: 'Có mail', email: 'c@test.vn', phone: '0900000032' });
    assert.equal(await queue(db, 4), 1);
    const rows = await reminders(db);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].student_id), Number(withMail.student_id));
    assert.equal(rows[0].recipient, 'c@test.vn');
  });

  test('bỏ qua bản ghi SV đã bị gộp vào bản khác', async () => {
    const dup = await reg(db, { event_id: 4, full_name: 'Bản trùng', email: 'dup@test.vn', phone: '0900000041' });
    const keep = await reg(db, { event_id: 4, full_name: 'Bản giữ', email: 'keep@test.vn', phone: '0900000042' });
    await db.query(`update students set merged_into_id = $1 where id = $2`, [keep.student_id, dup.student_id]);
    assert.equal(await queue(db, 4), 1);
    const rows = await reminders(db);
    assert.deepEqual(rows.map((r) => Number(r.student_id)), [Number(keep.student_id)]);
  });

  test('payload giống thư xác nhận: full_name, lookup_code, seq', async () => {
    const a = await reg(db, { event_id: 4, full_name: 'Nguyễn A', email: 'a@test.vn', phone: '0900000051' });
    await queue(db, 4);
    const [row] = await reminders(db);
    assert.deepEqual(row.payload, { full_name: 'Nguyễn A', lookup_code: a.lookup_code, seq: a.seq });
  });

  test('không đụng thư xác nhận đã xếp lúc đăng ký', async () => {
    await reg(db, { event_id: 4, full_name: 'A', email: 'a@test.vn', phone: '0900000061' });
    const before = await db.query(`select id, status, scheduled_at from notification_outbox where template = 'confirm'`);
    await queue(db, 4);
    const after = await db.query(`select id, status, scheduled_at from notification_outbox where template = 'confirm'`);
    assert.deepEqual(after.rows, before.rows);
  });

  test('thư nhắc không rời outbox trước giờ hẹn', async () => {
    await reg(db, { event_id: 4, full_name: 'A', email: 'a@test.vn', phone: '0900000071' });
    await db.query(`update notification_outbox set status = 'sent' where template = 'confirm'`);
    await queue(db, 4, 'morning', new Date(Date.now() + 3600e3).toISOString());
    const early = await db.query(`select * from claim_outbox_batch(40)`);
    assert.equal(early.rows.length, 0);

    await db.query(`update notification_outbox set scheduled_at = now() - interval '1 second' where template = 'morning'`);
    const due = await db.query(`select * from claim_outbox_batch(40)`);
    assert.equal(due.rows.length, 1);
    assert.equal(due.rows[0].template, 'morning');
  });

  test('từ chối template lạ, thư confirm, giờ hẹn rỗng, sự kiện không tồn tại', async () => {
    await assert.rejects(queue(db, 4, 'newsletter'), /template không hợp lệ/);
    await assert.rejects(queue(db, 4, 'confirm'), /template không hợp lệ/);
    await assert.rejects(queue(db, 4, null), /template không hợp lệ/);
    await assert.rejects(
      db.query(`select queue_event_reminders(4::smallint, 'morning', null)`), /thiếu giờ hẹn/);
    await assert.rejects(queue(db, 99), /không có sự kiện 99/);
  });

  test('từ chối sự kiện đã khoá', async () => {
    await reg(db, { event_id: 4, full_name: 'A', email: 'a@test.vn', phone: '0900000081' });
    await db.query(`update events set is_archived = true where id = 4`);
    await assert.rejects(queue(db, 4), /đã khoá/);
    assert.equal((await reminders(db)).length, 0);
  });

  test('sự kiện dùng mẫu AIM: chỉ nhận morning — D-3 / D-1 bị từ chối, không xếp dòng nào', async () => {
    await reg(db, { event_id: 4, full_name: 'A', email: 'a@test.vn', phone: '0900000091' });
    await db.query(`update events set email_copy = $1::jsonb where id = 4`, [JSON.stringify(COPY)]);
    await assert.rejects(queue(db, 4, 'reminder_d1'), /mẫu AIM/);
    await assert.rejects(queue(db, 4, 'reminder_d3'), /mẫu AIM/);
    assert.equal((await reminders(db, 'reminder_d1')).length, 0);
    assert.equal(await queue(db, 4, 'morning'), 1);
  });

  test('sự kiện mẫu cũ (email_copy NULL) vẫn xếp được cả ba loại nhắc, mỗi loại một lần', async () => {
    await reg(db, { event_id: 1, full_name: 'A', email: 'a@test.vn', phone: '0900000101' });
    for (const t of ['reminder_d3', 'reminder_d1', 'morning']) {
      assert.equal(await queue(db, 1, t), 1);
      assert.equal(await queue(db, 1, t), 0);
    }
  });
});

describe('events.email_copy', () => {
  beforeEach(async () => {
    db = new PGlite();
    await applyMigrations(db);
    await seedEvents(db);
  });

  test('sự kiện có sẵn mặc định NULL — mẫu cũ', async () => {
    const r = await db.query(`select count(*)::int n from events where email_copy is not null`);
    assert.equal(r.rows[0].n, 0);
  });

  test('CHECK nhận JSON của sự kiện 17/11, chặn JSON thiếu trường', async () => {
    await db.query(`update events set email_copy = $1::jsonb where id = 4`, [JSON.stringify(COPY)]);
    const { see_you, ...noSeeYou } = COPY;
    await assert.rejects(
      db.query(`update events set email_copy = $1::jsonb where id = 1`, [JSON.stringify(noSeeYou)]),
      /events_email_copy_valid/,
    );
    const r = await db.query(`select id from events where email_copy is not null`);
    assert.deepEqual(r.rows.map((x) => x.id), [4]);
  });

  // Cùng một bộ mẫu qua CHECK của database và parseEmailCopy() của @atl/email.
  // Hai bên lệch nhau = database nhận một JSON mà worker sẽ nổ khi render
  // (hoặc ngược lại, từ chối một JSON đúng).
  const { short_title, time_line, booth_opens, organizer, signature_image_url, ...minimal } = COPY;
  const SAMPLES = [
    ['đầy đủ (17/11)', COPY, true],
    ['chỉ trường bắt buộc', minimal, true],
    ['trường lạ bị bỏ qua', { ...COPY, _ghi_chu: 'AIM duyệt 14/11' }, true],
    ['ảnh chữ ký https + width', { ...COPY, signature_image_url: 'https://x.vn/a.png', signature_image_width: 240 }, true],
    ['ảnh chữ ký chuỗi rỗng = vắng', { ...COPY, signature_image_url: '' }, true],
    ['tuỳ chọn = null', { ...COPY, booth_opens: null, time_line: null }, true],
    ['thiếu event_title', { ...COPY, event_title: undefined }, false],
    ['event_title rỗng', { ...COPY, event_title: '  ' }, false],
    ['event_title là số', { ...COPY, event_title: 5 }, false],
    ['thiếu subjects', { ...COPY, subjects: undefined }, false],
    ['subjects là chuỗi', { ...COPY, subjects: 'x' }, false],
    ['thiếu subjects.morning', { ...COPY, subjects: { confirm: 'x' } }, false],
    ['thiếu support_place', { ...COPY, support_place: undefined }, false],
    ['thiếu venue_line', { ...COPY, venue_line: undefined }, false],
    ['thiếu see_you', { ...COPY, see_you: undefined }, false],
    ['booth_opens là số', { ...COPY, booth_opens: 745 }, false],
    ['ảnh chữ ký http', { ...COPY, signature_image_url: 'http://x.vn/a.png' }, false],
    ['ảnh chữ ký javascript:', { ...COPY, signature_image_url: 'javascript:alert(1)' }, false],
    ['width lẻ', { ...COPY, signature_image_width: 240.5 }, false],
    ['width quá lớn', { ...COPY, signature_image_width: 900 }, false],
    ['width là chuỗi', { ...COPY, signature_image_width: '240' }, false],
    ['mảng', [COPY], false],
  ];

  for (const [label, sample, expected] of SAMPLES) {
    test(`database và @atl/email cùng kết luận: ${label} → ${expected ? 'hợp lệ' : 'từ chối'}`, async () => {
      const json = JSON.stringify(sample); // undefined → khoá biến mất, như thật
      const r = await db.query(`select email_copy_is_valid($1::jsonb) ok`, [json]);
      let js = true;
      try { parseEmailCopy(JSON.parse(json)); } catch { js = false; }
      assert.equal(r.rows[0].ok, expected, 'database');
      assert.equal(js, expected, '@atl/email');
    });
  }
});

describe('file vá production 0016', () => {
  test('chứa nguyên văn migration 0016, bọc trong một transaction', () => {
    const patch = readFileSync(PATCH, 'utf8');
    assert.ok(patch.includes(readFileSync(join(MIGRATIONS, MIGRATION_0016), 'utf8')),
      'production-patch-0016.sql lệch khỏi migration — chạy lại node scripts/build-production-sql.mjs');
    assert.match(patch, /^begin;$/m);
    assert.match(patch, /^commit;$/m);
  });

  test('áp lên database 0001–0015 có dữ liệu, rồi áp lần hai: không hỏng, không mất gì', async () => {
    const pg = new PGlite();
    await applyMigrations(pg, { upTo: '0015_event_archive.sql' });
    await seedEvents(pg);
    await reg(pg, { event_id: 4, full_name: 'A', email: 'a@test.vn', phone: '0900000111' });

    const patch = readFileSync(PATCH, 'utf8');
    await pg.exec(patch);
    await pg.query(`update events set email_copy = $1::jsonb where id = 4`, [JSON.stringify(COPY)]);
    await pg.exec(patch); // lần hai — người áp tay bấm Run hai lần

    const ev = await pg.query(`select email_copy from events where id = 4`);
    assert.deepEqual(ev.rows[0].email_copy, COPY, 'áp lần hai không được xoá JSON đã đặt');
    const c = await pg.query(
      `select count(*)::int n from pg_constraint where conname = 'events_email_copy_valid'`);
    assert.equal(c.rows[0].n, 1);
    assert.equal(
      (await pg.query(`select queue_event_reminders(4::smallint, 'morning', now()) n`)).rows[0].n, 1);
  });
});
