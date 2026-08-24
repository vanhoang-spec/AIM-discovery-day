import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', 'migrations');

let db;

/** Apply every migration in filename order, then seed one event. */
async function freshDb() {
  const pg = new PGlite();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    try {
      await pg.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
    } catch (err) {
      throw new Error(`Migration ${file} failed: ${err.message}`);
    }
  }
  return pg;
}

async function seed(pg) {
  await pg.exec(`
    insert into editions (id, year, name) values (1, 2026, 'Awaken The Lions 2026');
    insert into events (id, edition_id, kind, slug, name, venue_name, city,
                        starts_at, ends_at, token_key_id, special_threshold_y,
                        special_claim_limit)
    values (1, 1, 'discovery_day', 'ha-noi', 'Discovery Day Hà Nội', 'FTU Hà Nội', 'Hà Nội',
            '2026-09-12 08:00+07', '2026-09-12 17:00+07', 'k-hn-2026', 5, 2),
           (2, 1, 'discovery_day', 'ho-chi-minh', 'Discovery Day HCM', 'FTU HCM', 'TPHCM',
            '2026-09-12 08:00+07', '2026-09-12 17:00+07', 'k-hcm-2026', 5, 2);

    insert into zones (id, event_id, name) values
      (1, 1, 'Finance zone'), (2, 1, 'Energy zone'), (3, 2, 'Finance zone HCM');

    insert into checkpoints (id, event_id, zone_id, kind, name, counts_toward_badges,
                             badge_award_mode) values
      (1, 1, 1, 'sponsor_booth',  'Techcombank booth', true,  'pg_scan'),
      (2, 1, 2, 'sponsor_booth',  'Vinamilk booth',    true,  'survey_complete'),
      (3, 1, 1, 'sponsor_booth',  'Momo booth',        true,  'both_required'),
      (4, 1, null, 'hall_session','Inspiration talk',  false, 'pg_scan'),
      (5, 1, null, 'learning_class','AI cho học tập',  true,  'either'),
      (6, 2, 3, 'sponsor_booth',  'HCM booth',         true,  'pg_scan');

    insert into ref_schools (id, name, search_key) values (1, 'Đại học Ngoại thương', 'dai hoc ngoai thuong');
  `);
}

/** Register n students in an event; returns their ids. */
async function addStudents(pg, eventId, n, offset = 0) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const seq = 1000 + offset + i;
    const r = await pg.query(
      `insert into students (seq, lookup_code, full_name, name_search_key, email, school_id)
       values ($1, $2, $3, $4, $5, 1) returning id`,
      [seq, `A${String(seq).padStart(5, '0')}`.slice(0, 6), `SV ${seq}`, `sv ${seq}`, `sv${seq}@test.vn`],
    );
    const id = r.rows[0].id;
    await pg.query(
      `insert into registrations (student_id, event_id) values ($1, $2)`,
      [id, eventId],
    );
    ids.push(id);
  }
  return ids;
}

const uuid = (n) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

before(async () => {
  db = await freshDb();
  await seed(db);
});

describe('migrations', () => {
  test('all migrations apply cleanly', async () => {
    const r = await db.query(
      `select count(*)::int as n from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    assert.ok(r.rows[0].n >= 15, `expected the full schema, found ${r.rows[0].n} tables`);
  });

  test('a checkpoint cannot be attached to another event\'s zone', async () => {
    // Zone 3 belongs to event 2. Claiming it from event 1 must be impossible.
    await assert.rejects(
      () => db.query(
        `insert into checkpoints (event_id, zone_id, kind, name)
         values (1, 3, 'sponsor_booth', 'cross-venue smuggling')`,
      ),
      /foreign key|violates/i,
      'a Hà Nội checkpoint must not be able to reference an HCM zone',
    );
  });

  test('an event id must fit the single byte carried in the QR token', async () => {
    await assert.rejects(
      () => db.query(
        `insert into events (id, edition_id, kind, slug, name, venue_name, city,
                             starts_at, ends_at, token_key_id)
         values (300, 1, 'discovery_day', 'too-big', 'x', 'v', 'c',
                 '2026-09-12 08:00+07', '2026-09-12 17:00+07', 'k')`,
      ),
      /violates check/i,
    );
  });

  test('an email that is not lowercase is refused, so duplicates cannot slip in', async () => {
    await assert.rejects(
      () => db.query(
        `insert into students (seq, lookup_code, full_name, name_search_key, email)
         values (99001, 'ZZZ001', 'Mixed Case', 'mixed case', 'An@Gmail.com')`,
      ),
      /violates check/i,
    );
  });

  test('a student with neither email nor phone is refused', async () => {
    await assert.rejects(
      () => db.query(
        `insert into students (seq, lookup_code, full_name, name_search_key)
         values (99002, 'ZZZ002', 'No Contact', 'no contact')`,
      ),
      /violates check/i,
    );
  });
});

describe('ledger idempotency', () => {
  test('the same scan_uid replayed does not award a second badge', async () => {
    const [s] = await addStudents(db, 1, 1, 100);
    const args = [uuid(1), 1, s, 1, 'pg_scan', 'pg-01', 'dev-01'];

    const first = await db.query(
      `select * from record_scan($1,$2::smallint,$3,$4,$5::scan_source,$6,$7)`, args);
    assert.equal(first.rows[0].status, 'counted');
    assert.equal(first.rows[0].badge_count, 1);

    // The offline queue flushes the same batch again after a dropped response.
    for (let i = 0; i < 20; i++) {
      const replay = await db.query(
        `select * from record_scan($1,$2::smallint,$3,$4,$5::scan_source,$6,$7)`, args);
      assert.equal(replay.rows[0].status, 'replay');
      assert.equal(replay.rows[0].badge_count, 1);
    }

    const n = await db.query(
      `select count(*)::int as c from attendance where student_id = $1 and voided_at is null`, [s]);
    assert.equal(n.rows[0].c, 1);
  });

  test('different scans of the same student at one booth award exactly one badge', async () => {
    const [s] = await addStudents(db, 1, 1, 200);
    let counted = 0;
    let repeats = 0;

    // 30 distinct scans: a double-tapping PG plus a second PG at the same booth.
    for (let i = 0; i < 30; i++) {
      const r = await db.query(
        `select * from record_scan($1,$2::smallint,$3,$4,$5::scan_source,$6,$7)`,
        [uuid(200 + i), 1, s, 1, 'pg_scan', `pg-0${i % 2}`, `dev-0${i % 2}`]);
      if (r.rows[0].status === 'counted') counted++;
      if (r.rows[0].status === 'repeat_not_counted') repeats++;
    }

    assert.equal(counted, 1, 'exactly one scan may award the badge');
    assert.equal(repeats, 29);

    const reg = await db.query(
      `select badge_count from registrations where student_id = $1 and event_id = 1`, [s]);
    assert.equal(reg.rows[0].badge_count, 1);

    // Every touch is still on record — the sponsor wants the visit count.
    const led = await db.query(
      `select count(*)::int as c from ledger_events where student_id = $1`, [s]);
    assert.equal(led.rows[0].c, 30);
  });

  test('the ledger cannot be rewritten', async () => {
    await assert.rejects(
      () => db.query(`update ledger_events set status = 'counted' where scan_uid = $1`, [uuid(1)]),
      /append-only/,
    );
    await assert.rejects(
      () => db.query(`delete from ledger_events where scan_uid = $1`, [uuid(1)]),
      /append-only/,
    );
  });

  test('a scan for a checkpoint in another event is rejected, not mis-filed', async () => {
    const [s] = await addStudents(db, 1, 1, 300);
    const r = await db.query(
      `select * from record_scan($1,$2::smallint,$3,$4,$5::scan_source,$6,$7)`,
      [uuid(300), 1, s, 6 /* HCM checkpoint */, 'pg_scan', 'pg-01', 'dev-01']);
    assert.equal(r.rows[0].status, 'rejected_checkpoint_closed');
    assert.equal(r.rows[0].badge_count, 0);
  });

  test('an unregistered student is rejected', async () => {
    const ins = await db.query(
      `insert into students (seq, lookup_code, full_name, name_search_key, email)
       values (98000, 'NREG01', 'Chua dang ky', 'chua dang ky', 'noreg@test.vn') returning id`);
    const r = await db.query(
      `select * from record_scan($1,$2::smallint,$3,$4,$5::scan_source,$6,$7)`,
      [uuid(310), 1, ins.rows[0].id, 1, 'pg_scan', 'pg-01', 'dev-01']);
    assert.equal(r.rows[0].status, 'rejected_not_registered');
  });
});

describe('badge award modes', () => {
  test('survey_complete: a PG scan alone does not award, the survey does', async () => {
    const [s] = await addStudents(db, 1, 1, 400);

    const scan = await db.query(
      `select * from record_scan($1,$2::smallint,$3,$4,$5::scan_source,$6,$7)`,
      [uuid(400), 1, s, 2, 'pg_scan', 'pg-01', 'dev-01']);
    assert.equal(scan.rows[0].status, 'pending_other_condition');
    assert.equal(scan.rows[0].badge_count, 0);

    const survey = await db.query(
      `select * from record_scan($1,$2::smallint,$3,$4,$5::scan_source,$6,$7)`,
      [uuid(401), 1, s, 2, 'survey', null, null]);
    assert.equal(survey.rows[0].status, 'counted');
    assert.equal(survey.rows[0].badge_count, 1);
  });

  test('both_required: the badge lands only when both halves are on record', async () => {
    const [s] = await addStudents(db, 1, 1, 500);

    const scanOnly = await db.query(
      `select * from record_scan($1,$2::smallint,$3,$4,$5::scan_source,$6,$7)`,
      [uuid(500), 1, s, 3, 'pg_scan', 'pg-01', 'dev-01']);
    assert.equal(scanOnly.rows[0].status, 'pending_other_condition');

    const withSurvey = await db.query(
      `select * from record_scan($1,$2::smallint,$3,$4,$5::scan_source,$6,$7)`,
      [uuid(501), 1, s, 3, 'survey', null, null]);
    assert.equal(withSurvey.rows[0].status, 'counted');
    assert.equal(withSurvey.rows[0].badge_count, 1);
  });

  test('an activity flagged as not counting still records attendance but not a badge', async () => {
    const [s] = await addStudents(db, 1, 1, 600);
    const r = await db.query(
      `select * from record_scan($1,$2::smallint,$3,$4,$5::scan_source,$6,$7)`,
      [uuid(600), 1, s, 4 /* inspiration talk, counts_toward_badges = false */,
       'pg_scan', 'pg-01', 'dev-01']);
    assert.equal(r.rows[0].status, 'counted');
    assert.equal(r.rows[0].badge_count, 0, 'attendance is recorded, but it is not a badge');

    const att = await db.query(
      `select count(*)::int as c from attendance where student_id = $1 and checkpoint_id = 4`, [s]);
    assert.equal(att.rows[0].c, 1);
  });

  test('toggling counts_toward_badges retroactively corrects every student', async () => {
    const before = await db.query(
      `select badge_count from registrations where event_id = 1 order by student_id`);
    const sum = (rs) => rs.rows.reduce((a, r) => a + r.badge_count, 0);
    const beforeSum = sum(before);

    await db.query(`update checkpoints set counts_toward_badges = true where id = 4`);
    await db.query(`select rebuild_all_progress(1::smallint)`);
    const after = await db.query(
      `select badge_count from registrations where event_id = 1 order by student_id`);
    assert.ok(sum(after) > beforeSum, 'enabling an activity must grant its badges');

    await db.query(`update checkpoints set counts_toward_badges = false where id = 4`);
    await db.query(`select rebuild_all_progress(1::smallint)`);
    const restored = await db.query(
      `select badge_count from registrations where event_id = 1 order by student_id`);
    assert.equal(sum(restored), beforeSum, 'disabling it must put every count back');
  });

  test('no drift between the counter and the ledger', async () => {
    const drift = await db.query(`select * from v_progress_drift`);
    assert.equal(drift.rows.length, 0, JSON.stringify(drift.rows));
  });
});

describe('voiding a mis-scan', () => {
  test('requires a reason, soft-deletes, and rebuilds the count', async () => {
    const [s] = await addStudents(db, 1, 1, 700);
    await db.query(`select * from record_scan($1,$2::smallint,$3,$4,$5::scan_source,$6,$7)`,
      [uuid(700), 1, s, 1, 'pg_scan', 'pg-01', 'dev-01']);

    await assert.rejects(
      () => db.query(`select void_attendance(1::smallint, $1, 1, 'admin', '')`, [s]),
      /reason is required/,
    );

    const r = await db.query(
      `select void_attendance(1::smallint, $1, 1, 'admin-01', 'PG quét nhầm người') as c`, [s]);
    assert.equal(r.rows[0].c, 0);

    // The evidence survives the correction.
    const led = await db.query(
      `select count(*)::int as c from ledger_events where student_id = $1`, [s]);
    assert.equal(led.rows[0].c, 1);

    const audit = await db.query(
      `select count(*)::int as c from audit_log where action = 'void_attendance'
        and target_id = $1`, [String(s)]);
    assert.equal(audit.rows[0].c, 1);

    // And the badge can be re-awarded afterwards — the partial unique index
    // ignores voided rows.
    const re = await db.query(`select * from record_scan($1,$2::smallint,$3,$4,$5::scan_source,$6,$7)`,
      [uuid(701), 1, s, 1, 'pg_scan', 'pg-01', 'dev-01']);
    assert.equal(re.rows[0].status, 'counted');
  });
});
