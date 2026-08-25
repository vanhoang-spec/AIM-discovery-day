/**
 * 0006 + 0007 — the two-ladder rule (Ver02 §025).
 *
 *   gift ladder    badge_count       every counted badge, bonuses included
 *   special ladder core_badge_count  entrance + sponsor booths ONLY
 *
 * Written the house way: assert what must NEVER happen (a session badge
 * leaking into special eligibility; a bonus counting as an activity; the
 * core counter outrunning the total), not the happy path.
 */
import { test, describe, before } from 'node:test';
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
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    try {
      await pg.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
    } catch (err) {
      throw new Error(`Migration ${file} failed: ${err.message}`);
    }
  }
  return pg;
}

// One event modelled on the real venue plan: 1 entrance + 6 booths (N = 7,
// so ">70%" implies y = 5), plus the badge sources that must NOT count
// toward special: a hall session, a learning class, and Early Bird.
async function seed(pg) {
  await pg.exec(`
    insert into editions (id, year, name) values (1, 2026, 'ATL 2026');
    insert into events (id, edition_id, kind, slug, name, venue_name, city,
                        starts_at, ends_at, token_key_id, special_threshold_y,
                        special_claim_limit)
    values (1, 1, 'discovery_day', 'hn', 'DD HN', 'FTU HN', 'HN',
            '2026-09-12 08:00+07', '2026-09-12 17:00+07', 'k1', 5, 2);

    insert into zones (id, event_id, name) values (1, 1, 'Cổng'), (2, 1, 'Booths');

    insert into checkpoints (id, event_id, zone_id, kind, name, counts_toward_badges) values
      (1,  1, 1, 'entrance',       'Cổng check-in', true),
      (2,  1, 2, 'sponsor_booth',  'Booth 1',       true),
      (3,  1, 2, 'sponsor_booth',  'Booth 2',       true),
      (4,  1, 2, 'sponsor_booth',  'Booth 3',       true),
      (5,  1, 2, 'sponsor_booth',  'Booth 4',       true),
      (6,  1, 2, 'sponsor_booth',  'Booth 5',       true),
      (7,  1, 2, 'diamond_booth',  'Booth Kim cương', true),
      (8,  1, 1, 'hall_session',   'Inspiration talk', true),
      (9,  1, 1, 'learning_class', 'Lớp AI',        true),
      (10, 1, 1, 'bonus',          'Early Bird',    true),
      -- A booth toggled out of the game: counts toward NEITHER ladder.
      (11, 1, 2, 'sponsor_booth',  'Booth tắt',     false);

    insert into special_activities (id, event_id, name, capacity, is_open)
    values (1, 1, 'Meet & Greet', 3, true);
    insert into special_slots (event_id, special_activity_id, slot_no)
    select 1, 1, n from generate_series(1, 3) n;
  `);
}

let nextSeq = 7000;
async function student(pg) {
  const seq = nextSeq++;
  const r = await pg.query(
    `insert into students (seq, lookup_code, full_name, name_search_key, email)
     values ($1, $2, $3, $4, $5) returning id`,
    [seq, `T${String(seq).padStart(5, '0')}`.slice(0, 6), `SV ${seq}`, `sv ${seq}`, `t${seq}@t.vn`],
  );
  const id = r.rows[0].id;
  await pg.query(`insert into registrations (student_id, event_id) values ($1, 1)`, [id]);
  return id;
}

let nextUid = 1;
const scan = async (pg, studentId, checkpointId) => {
  const uid = `00000000-0000-7000-8000-${String(nextUid++).padStart(12, '0')}`;
  const r = await pg.query(
    `select * from record_scan($1::uuid, 1::smallint, $2, $3)`,
    [uid, studentId, checkpointId],
  );
  return r.rows[0];
};

const counters = async (pg, studentId) => {
  const r = await pg.query(
    `select badge_count, core_badge_count from registrations
      where event_id = 1 and student_id = $1`, [studentId],
  );
  return r.rows[0];
};

before(async () => {
  db = await freshDb();
  await seed(db);
});

describe('what feeds which ladder', () => {
  test('entrance and booth badges move both counters', async () => {
    const sv = await student(db);
    await scan(db, sv, 1);           // entrance
    await scan(db, sv, 2);           // booth
    await scan(db, sv, 7);           // diamond booth
    assert.deepEqual(await counters(db, sv), { badge_count: 3, core_badge_count: 3 });
  });

  test('session, class and bonus badges move ONLY the gift ladder', async () => {
    const sv = await student(db);
    await scan(db, sv, 8);           // hall_session
    await scan(db, sv, 9);           // learning_class
    await scan(db, sv, 10);          // bonus (Early Bird)
    assert.deepEqual(await counters(db, sv), { badge_count: 3, core_badge_count: 0 });
  });

  test('a booth toggled off counts toward neither', async () => {
    const sv = await student(db);
    await scan(db, sv, 11);
    assert.deepEqual(await counters(db, sv), { badge_count: 0, core_badge_count: 0 });
  });

  test('a repeat scan at a booth moves neither counter', async () => {
    const sv = await student(db);
    await scan(db, sv, 2);
    const again = await scan(db, sv, 2);
    assert.equal(again.status, 'repeat_not_counted');
    assert.deepEqual(await counters(db, sv), { badge_count: 1, core_badge_count: 1 });
  });

  test('the core counter can never exceed the total — even by hand', async () => {
    const sv = await student(db);
    await assert.rejects(
      db.query(
        `update registrations set core_badge_count = 5
          where event_id = 1 and student_id = $1`, [sv],
      ),
      /registrations_core_within_total/,
    );
  });
});

describe('special eligibility reads the special ladder', () => {
  test('rich on sessions, poor on booths: NOT eligible', async () => {
    const sv = await student(db);
    // 7 badges total — but only 2 are activities (entrance + 1 booth).
    await scan(db, sv, 1);
    await scan(db, sv, 2);
    await scan(db, sv, 8);
    await scan(db, sv, 9);
    await scan(db, sv, 10);
    await db.query(
      `update registrations set badge_count = 7
        where event_id = 1 and student_id = $1`, [sv],
    );
    const r = await db.query(
      `select * from hold_special_slot(1::smallint, $1, 1)`, [sv],
    );
    assert.equal(r.rows[0].result, 'not_eligible',
      'y must gate on activities walked, not on total badges');
  });

  test('five real activities: eligible', async () => {
    const sv = await student(db);
    for (const cp of [1, 2, 3, 4, 5]) await scan(db, sv, cp);   // core = 5 = y
    const r = await db.query(
      `select * from hold_special_slot(1::smallint, $1, 1)`, [sv],
    );
    assert.equal(r.rows[0].result, 'held');
  });

  test('control panel headcount uses the special ladder', async () => {
    // The previous test left exactly one core-eligible student; the
    // sessions-rich student (badge_count 7, core 2) must not inflate it.
    const r = await db.query(
      `select students_eligible from v_special_control_panel where special_activity_id = 1`,
    );
    assert.equal(Number(r.rows[0].students_eligible), 1);
  });
});

describe('rebuild and drift cover both counters', () => {
  test('rebuild_student_progress restores both from the ledger', async () => {
    const sv = await student(db);
    await scan(db, sv, 1);           // core
    await scan(db, sv, 8);           // session
    await db.query(
      `update registrations set badge_count = 0, core_badge_count = 0
        where event_id = 1 and student_id = $1`, [sv],
    );
    await db.query(`select rebuild_student_progress(1::smallint, $1)`, [sv]);
    assert.deepEqual(await counters(db, sv), { badge_count: 2, core_badge_count: 1 });
  });

  test('core-only drift is caught by v_progress_drift', async () => {
    const sv = await student(db);
    await scan(db, sv, 2);
    // badge_count is right; only core is corrupted (set low, staying within
    // the core<=total check — exactly the drift the old view could not see).
    await db.query(
      `update registrations set core_badge_count = 0
        where event_id = 1 and student_id = $1`, [sv],
    );
    const drift = await db.query(
      `select * from v_progress_drift where student_id = $1`, [sv],
    );
    assert.equal(drift.rows.length, 1);
    assert.equal(Number(drift.rows[0].stored_core), 0);
    assert.equal(Number(drift.rows[0].real_core), 1);
    await db.query(`select rebuild_all_progress(1::smallint)`);
    const after = await db.query(
      `select * from v_progress_drift where student_id = $1`, [sv],
    );
    assert.equal(after.rows.length, 0);
  });
});

describe('the >70% watchdog', () => {
  test('N=7 activities implies y=5 and matches the configured threshold', async () => {
    const r = await db.query(
      `select * from v_special_threshold_check where event_id = 1`,
    );
    const row = r.rows[0];
    // 1 entrance + 5 sponsor booths + 1 diamond = 7. Booth 11 (toggled off),
    // sessions and bonus must not be in the denominator.
    assert.equal(Number(row.core_checkpoints), 7);
    assert.equal(Number(row.implied_threshold), 5);   // >70% của 7 = >4.9
    assert.equal(row.mismatch, false);
  });

  test('pulling a booth flips the alarm without touching y', async () => {
    await db.query(`update checkpoints set is_active = false where id = 7`);
    const r = await db.query(
      `select * from v_special_threshold_check where event_id = 1`,
    );
    // N drops to 6: >70% của 6 = >4.2 → 5. Still 5 — no alarm.
    assert.equal(Number(r.rows[0].implied_threshold), 5);
    assert.equal(r.rows[0].mismatch, false);

    await db.query(`update checkpoints set is_active = false where id = 6`);
    const r2 = await db.query(
      `select * from v_special_threshold_check where event_id = 1`,
    );
    // N=5: >3.5 → 4, configured y=5 → alarm. The view alerts; it never edits.
    assert.equal(Number(r2.rows[0].implied_threshold), 4);
    assert.equal(r2.rows[0].mismatch, true);
    const y = await db.query(`select special_threshold_y from events where id = 1`);
    assert.equal(y.rows[0].special_threshold_y, 5);

    await db.query(`update checkpoints set is_active = true where id in (6, 7)`);
  });

  test('N=8 implies y=6 — the boundary AIM asked about', async () => {
    await db.query(`
      insert into checkpoints (id, event_id, zone_id, kind, name, counts_toward_badges)
      values (12, 1, 2, 'sponsor_booth', 'Booth 7', true)`);
    const r = await db.query(
      `select * from v_special_threshold_check where event_id = 1`,
    );
    assert.equal(Number(r.rows[0].core_checkpoints), 8);
    assert.equal(Number(r.rows[0].implied_threshold), 6);  // >5.6 → 6
    await db.query(`delete from checkpoints where id = 12`);
  });
});
