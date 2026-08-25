/**
 * 0008 — Giờ Vàng. Asserted the house way: the three caps are things that
 * CANNOT be exceeded, the bonus is a badge that CANNOT double, and the gift
 * economy is a number the feature CANNOT silently move.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', 'migrations');

let db;
let seqCounter = 8000;
let uidCounter = 1;

async function freshDb() {
  const pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    try {
      await pg.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
    } catch (err) {
      throw new Error(`Migration ${f} failed: ${err.message}`);
    }
  }
  await pg.exec(`
    insert into editions (id, year, name) values (1, 2026, 'ATL 2026');
    insert into events (id, edition_id, kind, slug, name, venue_name, city, starts_at, ends_at,
                        token_key_id)
    values (1, 1, 'discovery_day', 'hn', 'DD HN', 'FTU HN', 'HN',
            '2026-09-12 08:00+07', '2026-09-12 17:00+07', 'k1');

    insert into zones (id, event_id, name) values
      (1, 1, 'Cổng'), (2, 1, 'Finance zone'), (3, 1, 'Energy zone');

    insert into checkpoints (id, event_id, zone_id, kind, name, counts_toward_badges) values
      (1, 1, 1, 'entrance',      'Cổng check-in', true),
      (2, 1, 2, 'sponsor_booth', 'Booth Finance', true),
      (3, 1, 3, 'sponsor_booth', 'Booth Energy',  true),
      (4, 1, 2, 'hall_session',  'Talk tại Finance', true);

    insert into pg_staff (id, event_id, full_name, role) values (1, 1, 'PG Test', 'pg');
    insert into pg_devices (id, event_id, claim_code, pg_staff_id, zone_id, label)
    values (1, 1, 'K7M3QX', 1, 2, 'PG-01');

    -- Explicit ids do not advance serial sequences; activate_golden_hour
    -- creates checkpoints lazily and would collide without this.
    select setval(pg_get_serial_sequence('checkpoints', 'id'),
                  (select max(id) + 1 from checkpoints), false);
  `);
  await pg.query(`select * from claim_pg_device('K7M3QX', 'tok-1', 'pin', null, 'test')`);
  return pg;
}

async function student(pg) {
  const seq = seqCounter++;
  const r = await pg.query(
    `insert into students (seq, lookup_code, full_name, name_search_key, email)
     values ($1, $2, $3, $4, $5) returning id`,
    [seq, `G${String(seq).padStart(5, '0')}`.slice(0, 6), `SV ${seq}`, `sv ${seq}`, `g${seq}@t.vn`],
  );
  await pg.query(`insert into registrations (student_id, event_id) values ($1, 1)`, [r.rows[0].id]);
  return seq;
}

const scan = async (pg, seq, checkpoint) => {
  const uid = `00000000-0000-7000-9000-${String(uidCounter++).padStart(12, '0')}`;
  const r = await pg.query(
    `select * from record_pg_scan('tok-1', $1::uuid, $2::integer, $3::integer)`,
    [uid, seq, checkpoint],
  );
  return { ...r.rows[0], uid };
};

const rescan = async (pg, uid, seq, checkpoint) => {
  const r = await pg.query(
    `select * from record_pg_scan('tok-1', $1::uuid, $2::integer, $3::integer)`,
    [uid, seq, checkpoint],
  );
  return r.rows[0];
};

const activate = (pg, zone, opts = {}) =>
  pg.query(
    `select * from activate_golden_hour(1::smallint, $1, 'Marshal', $2, $3)`,
    [zone, opts.minutes ?? 40, opts.cap ?? 80],
  ).then((r) => r.rows[0]);

const counters = async (pg) => {
  const e = await pg.query(`select golden_issued, golden_budget from events where id = 1`);
  const g = await pg.query(
    `select badges_issued, badge_cap from golden_hours order by id desc limit 1`);
  return { ...e.rows[0], ...(g.rows[0] ?? {}) };
};

beforeEach(async () => {
  db = await freshDb();
});

describe('kích hoạt', () => {
  test('one active per event: the second activation is refused until close', async () => {
    assert.equal((await activate(db, 2)).result, 'ok');
    assert.equal((await activate(db, 3)).result, 'already_active');
    await db.query(`select close_golden_hour(1::smallint, 'Marshal')`);
    assert.equal((await activate(db, 3)).result, 'ok');
  });

  test('a time-expired activation is swept, not a blocker', async () => {
    assert.equal((await activate(db, 2)).result, 'ok');
    await db.query(`update golden_hours set started_at = now() - interval '41 minutes', ends_at = now() - interval '1 second'`);
    const r = await activate(db, 3);
    assert.equal(r.result, 'ok', 'sweep phải tự đóng đợt hết giờ');
    const swept = await db.query(
      `select closed_by from golden_hours where zone_id = 2`);
    assert.equal(swept.rows[0].closed_by, '(tự đóng)');
  });

  test('the zone bonus checkpoint is created once and reused across activations', async () => {
    await activate(db, 2);
    await db.query(`select close_golden_hour(1::smallint, 'x')`);
    await activate(db, 2);
    const cps = await db.query(
      `select count(*)::int as n from checkpoints where kind = 'bonus' and zone_id = 2`);
    assert.equal(cps.rows[0].n, 1);
  });

  test('activation refuses when the day budget is spent', async () => {
    await db.query(`update events set golden_budget = 10, golden_issued = 10 where id = 1`);
    assert.equal((await activate(db, 2)).result, 'budget_exhausted');
  });
});

describe('cấp badge thưởng', () => {
  test('a counted booth badge in the golden zone earns exactly one bonus', async () => {
    await activate(db, 2);
    const sv = await student(db);
    const r = await scan(db, sv, 2);
    assert.equal(r.status, 'counted');
    assert.equal(r.golden, true);
    assert.equal(r.badge_count, 2, 'badge gốc + badge thưởng');
    assert.deepEqual(await counters(db), {
      golden_issued: 1, golden_budget: 300, badges_issued: 1, badge_cap: 80,
    });
  });

  test('the bonus rides the gift ladder only — never the special ladder', async () => {
    await activate(db, 2);
    const sv = await student(db);
    await scan(db, sv, 2);
    const r = await db.query(
      `select r.badge_count, r.core_badge_count from registrations r
        join students s on s.id = r.student_id where s.seq = $1`, [sv]);
    assert.deepEqual(r.rows[0], { badge_count: 2, core_badge_count: 1 });
  });

  test('a replayed batch does not double the bonus or the counters', async () => {
    await activate(db, 2);
    const sv = await student(db);
    const first = await scan(db, sv, 2);
    const again = await rescan(db, first.uid, sv, 2);
    assert.equal(again.status, 'replay');
    assert.equal((await counters(db)).badges_issued, 1);
    assert.equal((await counters(db)).golden_issued, 1);
  });

  test('one bonus per student per zone: a second booth scan adds no second bonus', async () => {
    await db.query(`
      insert into checkpoints (id, event_id, zone_id, kind, name, counts_toward_badges)
      values (12, 1, 2, 'sponsor_booth', 'Booth Finance B', true)`);
    await activate(db, 2);
    const sv = await student(db);
    const r1 = await scan(db, sv, 2);
    const r2 = await scan(db, sv, 12);
    assert.equal(r1.golden, true);
    assert.equal(r2.status, 'counted', 'badge gốc booth B vẫn được cấp');
    assert.equal(r2.golden, false, 'nhưng không có badge thưởng thứ hai');
    assert.equal((await counters(db)).badges_issued, 1);
  });

  test('a session in the golden zone earns NO bonus — booths only', async () => {
    await activate(db, 2);
    const sv = await student(db);
    const r = await scan(db, sv, 4); // hall_session, zone 2
    assert.equal(r.status, 'counted');
    assert.equal(r.golden, false);
  });

  test('scans outside the golden zone earn no bonus', async () => {
    await activate(db, 2);
    const sv = await student(db);
    const r = await scan(db, sv, 3); // booth in zone 3
    assert.equal(r.golden, false);
  });

  test('a repeat (amber) scan earns no bonus and moves no counter', async () => {
    await activate(db, 2);
    const sv = await student(db);
    await scan(db, sv, 2);
    const again = await scan(db, sv, 2); // new uid, same booth
    assert.equal(again.status, 'repeat_not_counted');
    assert.equal((await counters(db)).badges_issued, 1);
  });
});

describe('ba nắp an toàn', () => {
  test('per-activation cap: with cap 3, five students get exactly 3 bonuses and 5 base badges', async () => {
    await activate(db, 2, { cap: 3 });
    let bonuses = 0;
    let base = 0;
    for (let i = 0; i < 5; i++) {
      const sv = await student(db);
      const r = await scan(db, sv, 2);
      if (r.status === 'counted') base++;
      if (r.golden) bonuses++;
    }
    assert.equal(base, 5, 'badge gốc không bao giờ bị nắp chặn');
    assert.equal(bonuses, 3);
    assert.equal((await counters(db)).badges_issued, 3);
  });

  test('time cap: past ends_at the bonus stops, the base badge does not', async () => {
    await activate(db, 2);
    await db.query(`update golden_hours set started_at = now() - interval '41 minutes', ends_at = now() - interval '1 second'`);
    const sv = await student(db);
    const r = await scan(db, sv, 2);
    assert.equal(r.status, 'counted');
    assert.equal(r.golden, false);
  });

  test('day budget is a hard stop across activations', async () => {
    await db.query(`update events set golden_budget = 2 where id = 1`);
    await activate(db, 2, { cap: 80 });
    for (let i = 0; i < 3; i++) await scan(db, await student(db), 2);
    const c = await counters(db);
    assert.equal(c.golden_issued, 2, 'ngân sách ngày 2 → đúng 2, dù cap đợt là 80');
    assert.equal(c.badges_issued, 2);
  });

  test('manual close stops the bonus immediately', async () => {
    await activate(db, 2);
    await db.query(`select close_golden_hour(1::smallint, 'Marshal')`);
    const r = await scan(db, await student(db), 2);
    assert.equal(r.golden, false);
  });
});

describe('trạng thái & sổ sách', () => {
  test('v_golden_status folds all three caps into `active`', async () => {
    await activate(db, 2, { cap: 1 });
    let s = await db.query(`select * from v_golden_status where event_id = 1`);
    assert.equal(s.rows[0].active, true);
    await scan(db, await student(db), 2); // hits the cap of 1
    s = await db.query(`select * from v_golden_status where event_id = 1`);
    assert.equal(s.rows[0].active, false);
    assert.equal(Number(s.rows[0].badges_issued), 1);
  });

  test('activation and close are audited', async () => {
    await activate(db, 2);
    await db.query(`select close_golden_hour(1::smallint, 'Marshal')`);
    const a = await db.query(
      `select action from audit_log where event_id = 1 order by id`);
    const actions = a.rows.map((r) => r.action);
    assert.ok(actions.includes('golden_hour_start'));
    assert.ok(actions.includes('golden_hour_close'));
  });

  test('drift view stays clean through bonus awards', async () => {
    await activate(db, 2);
    await scan(db, await student(db), 2);
    const drift = await db.query(`select * from v_progress_drift`);
    assert.equal(drift.rows.length, 0);
  });
});
