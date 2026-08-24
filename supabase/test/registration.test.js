import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', 'migrations');

let db;

async function freshDb() {
  const pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  await pg.exec(`
    insert into editions (id, year, name) values (1, 2026, 'ATL 2026');
    insert into events (id, edition_id, kind, slug, name, venue_name, city, starts_at, ends_at,
                        token_key_id)
    values (1, 1, 'discovery_day', 'hn', 'DD HN', 'FTU HN', 'HN',
            '2026-09-12 08:00+07', '2026-09-12 17:00+07', 'k1'),
           (2, 1, 'discovery_day', 'hcm', 'DD HCM', 'FTU HCM', 'HCM',
            '2026-09-12 08:00+07', '2026-09-12 17:00+07', 'k2');
    insert into ref_schools (id, name, search_key) values
      (1, 'Đại học Ngoại thương', 'dai hoc ngoai thuong');
  `);
  return pg;
}

/** Call register_student with sensible defaults, overridable per test. */
async function reg(pg, over = {}) {
  const p = {
    event_id: 1,
    full_name: 'Nguyễn Thị Minh An',
    email: 'minh.an@test.vn',
    phone: '0912345678',
    school_id: 1,
    student_code: '2214810',
    consent_event: true,
    consent_sponsors: false,
    ...over,
  };
  const r = await pg.query(
    `select * from register_student(
       $1::smallint, $2, $3, $4, $5::smallint, null, $6, null, null, null, null, null,
       'general'::registration_type, 'online'::registration_source,
       $7, $8, '10.0.0.1'::inet, 'v1', $9)`,
    [p.event_id, p.full_name, p.email, p.phone, p.school_id, p.student_code,
     p.consent_event, p.consent_sponsors, p.name_search_key ?? null],
  );
  return r.rows[0];
}

beforeEach(async () => {
  db = await freshDb();
});

describe('register_student', () => {
  test('creates a student, a registration, and queues the confirmation email', async () => {
    const r = await reg(db);
    assert.equal(r.status, 'created');
    assert.ok(r.seq >= 1001);
    assert.match(r.lookup_code, /^[0-9A-HJKMNP-TV-Z]{6}$/);

    const s = await db.query(`select * from students where id = $1`, [r.student_id]);
    assert.equal(s.rows[0].email, 'minh.an@test.vn');
    assert.ok(s.rows[0].consent_event_at, 'mandatory consent must be stamped');
    assert.equal(s.rows[0].consent_sponsors_at, null, 'optional consent not given');
    assert.equal(s.rows[0].consent_text_version, 'v1');

    const n = await db.query(
      `select channel, template from notification_outbox where student_id = $1`,
      [r.student_id]);
    assert.deepEqual(n.rows.map((x) => `${x.channel}:${x.template}`), ['email:confirm']);
  });

  test('SMS stays off unless the event opts in — it is not in scope', async () => {
    const off = await reg(db);
    const none = await db.query(
      `select count(*)::int as c from notification_outbox
        where student_id = $1 and channel = 'sms'`, [off.student_id]);
    assert.equal(none.rows[0].c, 0, 'default must queue no SMS');

    // The contingency path: one boolean, no migration, no code change.
    await db.query(`update events set sms_enabled = true where id = 1`);
    const on = await reg(db, { email: 'sms@test.vn', phone: '0977000111' });
    const queued = await db.query(
      `select channel from notification_outbox where student_id = $1 order by channel`,
      [on.student_id]);
    assert.deepEqual(queued.rows.map((x) => x.channel), ['email', 'sms']);
  });

  test('refuses registration without the mandatory consent', async () => {
    await assert.rejects(() => reg(db, { consent_event: false }), /đồng ý điều khoản/);
  });

  test('normalises the email so case cannot create twins', async () => {
    await reg(db);
    const again = await reg(db, { email: '  Minh.An@Test.VN ' });
    assert.equal(again.status, 'already_registered');
  });

  test('resubmitting the form is the resend flow, never a twin', async () => {
    const first = await reg(db);
    for (let i = 0; i < 5; i++) {
      const again = await reg(db);
      assert.equal(again.status, 'already_registered');
      assert.equal(again.student_id, first.student_id);
      assert.equal(again.lookup_code, first.lookup_code, 'the printed code must not change');
    }
    const count = await db.query(`select count(*)::int as c from students`);
    assert.equal(count.rows[0].c, 1);

    // And still exactly one confirmation email — the outbox index absorbed
    // every duplicate submit.
    const n = await db.query(
      `select count(*)::int as c from notification_outbox where template = 'confirm'`);
    assert.equal(n.rows[0].c, 1);
  });

  test('matches an existing person by phone even with a new email', async () => {
    const first = await reg(db);
    const byPhone = await reg(db, { email: 'khac@test.vn', phone: '0912 345 678' });
    assert.equal(byPhone.status, 'already_registered');
    assert.equal(byPhone.student_id, first.student_id);
  });

  test('the same person registering for the second event links, not duplicates', async () => {
    const dd = await reg(db);
    const gf = await reg(db, { event_id: 2 });
    assert.equal(gf.status, 'linked');
    assert.equal(gf.student_id, dd.student_id);

    const regs = await db.query(
      `select event_id from registrations where student_id = $1 order by event_id`,
      [dd.student_id]);
    assert.deepEqual(regs.rows.map((x) => x.event_id), [1, 2]);
  });

  test('a burst of concurrent submits of one person yields exactly one student', async () => {
    // PGlite serialises statements on one connection, but the function's
    // conflict handler is still the code under test: fire the same submit many
    // times interleaved and assert the invariant the unique indexes guarantee.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => reg(db)),
    );
    assert.equal(results.filter((r) => r.status === 'created').length, 1);
    assert.equal(results.filter((r) => r.status === 'already_registered').length, 19);
    const count = await db.query(`select count(*)::int as c from students`);
    assert.equal(count.rows[0].c, 1);
  });

  test('distinct people get distinct seqs and codes', async () => {
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      const r = await reg(db, { email: `sv${i}@test.vn`, phone: `09000000${String(i).padStart(2, '0')}` });
      assert.equal(r.status, 'created');
      assert.ok(!seen.has(r.lookup_code), 'lookup codes must be unique');
      seen.add(r.lookup_code);
    }
  });
});

describe('register_team', () => {
  const member = (n) => ({
    full_name: `Thành viên ${n}`,
    email: `tv${n}@test.vn`,
    phone: `091100000${n}`,
    consent_event: true,
  });

  test('registers two contestants atomically and links them', async () => {
    const r = await db.query(
      `select * from register_team(1::smallint, 'Đội Sư Tử', $1::jsonb, $2::jsonb,
                                   '10.0.0.1'::inet, 'v1')`,
      [JSON.stringify(member(1)), JSON.stringify(member(2))]);
    const t = r.rows[0];
    assert.match(t.team_code, /^T[0-9A-HJKMNP-TV-Z]{6}$/);
    assert.notEqual(t.a_student_id, t.b_student_id);

    const regs = await db.query(
      `select type, team_id from registrations where team_id = $1`, [t.team_id]);
    assert.equal(regs.rows.length, 2);
    for (const row of regs.rows) assert.equal(row.type, 'contestant');
  });

  test('refuses a team of one person twice', async () => {
    await assert.rejects(
      () => db.query(
        `select * from register_team(1::smallint, 'X', $1::jsonb, $1::jsonb)`,
        [JSON.stringify(member(9))]),
      /chung email|trùng nhau/,
    );
  });

  test('a member who already registered individually is upgraded to contestant', async () => {
    const solo = await reg(db, { email: 'tv5@test.vn', phone: '0911000005' });
    const r = await db.query(
      `select * from register_team(1::smallint, 'Đội Ghép', $1::jsonb, $2::jsonb)`,
      [JSON.stringify({ ...member(5) }), JSON.stringify(member(6))]);
    assert.equal(r.rows[0].a_student_id, solo.student_id, 'existing person is reused');
    const upgraded = await db.query(
      `select type from registrations where student_id = $1 and event_id = 1`,
      [solo.student_id]);
    assert.equal(upgraded.rows[0].type, 'contestant');
  });
});

describe('notification outbox worker protocol', () => {
  test('claim marks rows sending and never hands the same row out twice', async () => {
    // 10 students → 10 queued emails (SMS is off by default).
    for (let i = 0; i < 10; i++) {
      await reg(db, { email: `w${i}@test.vn`, phone: `09220000${String(i).padStart(2, '0')}` });
    }
    const first = await db.query(`select * from claim_outbox_batch(6)`);
    assert.equal(first.rows.length, 6);
    for (const row of first.rows) assert.equal(row.status, 'sending');

    const second = await db.query(`select * from claim_outbox_batch(20)`);
    assert.equal(second.rows.length, 4, 'only the unclaimed remainder');
  });

  test('failure backs off and eventually parks as failed', async () => {
    const r = await reg(db);
    const row = await db.query(
      `select id from notification_outbox where student_id = $1 and channel = 'email'`,
      [r.student_id]);
    const id = row.rows[0].id;

    // Drive the REAL protocol: claim (which increments attempts) → fail →
    // backoff pushes scheduled_at into the future → time-travel past it →
    // claim again. Manually flipping status would skip the attempts counter
    // and test nothing.
    for (let attempt = 1; attempt <= 8; attempt++) {
      await db.query(`update notification_outbox set scheduled_at = now() where id=$1`, [id]);
      const claimed = await db.query(`select id from claim_outbox_batch(10)`);
      assert.ok(claimed.rows.some((x) => x.id === id), `round ${attempt} must re-claim the row`);
      await db.query(`select finish_outbox($1, false, 'provider 500')`, [id]);
    }
    const final = await db.query(`select status, last_error from notification_outbox where id=$1`, [id]);
    assert.equal(final.rows[0].status, 'failed', 'after 8 attempts it parks, not loops');
    assert.equal(final.rows[0].last_error, 'provider 500');
  });

  test('success stamps sent_at', async () => {
    const r = await reg(db);
    const claimed = await db.query(`select * from claim_outbox_batch(1)`);
    await db.query(`select finish_outbox($1, true)`, [claimed.rows[0].id]);
    const done = await db.query(
      `select status, sent_at from notification_outbox where id = $1`, [claimed.rows[0].id]);
    assert.equal(done.rows[0].status, 'sent');
    assert.ok(done.rows[0].sent_at);
  });
});
