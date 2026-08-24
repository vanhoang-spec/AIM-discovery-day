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
                        token_key_id, gift_ladder_mode, special_threshold_y, special_claim_limit)
    values (1, 1, 'discovery_day', 'hn', 'DD HN', 'FTU HN', 'HN',
            '2026-09-12 08:00+07', '2026-09-12 17:00+07', 'k1', 'cumulative', 5, 2);

    insert into gift_tiers (id, event_id, tier, required_badges, gift_name, stock_total) values
      (1, 1, 1, 1, 'Bút chì', 1000),
      (2, 1, 2, 2, 'Sổ tay',  500),
      (3, 1, 3, 3, 'Túi vải', 3);

    insert into special_activities (id, event_id, name, capacity) values
      (1, 1, 'Quay số trúng thưởng', 5),
      (2, 1, 'Giao lưu khách mời',   3);
  `);
  await pg.query(`select ensure_special_slots(1)`);
  await pg.query(`select ensure_special_slots(2)`);
  return pg;
}

/** Create a student with `badges` badge_count already set. */
async function student(pg, seq, badges = 0) {
  const r = await pg.query(
    `insert into students (seq, lookup_code, full_name, name_search_key, email)
     values ($1, $2, $3, $4, $5) returning id`,
    [seq, `S${String(seq).padStart(5, '0')}`.slice(0, 6), `SV ${seq}`, `sv ${seq}`, `s${seq}@t.vn`],
  );
  const id = r.rows[0].id;
  await pg.query(
    `insert into registrations (student_id, event_id, badge_count) values ($1, 1, $2)`,
    [id, badges],
  );
  return id;
}

const claimGift = (pg, sid, tier) =>
  pg.query(`select * from claim_gift_tier(1::smallint, $1, $2, 'staff-1', 'dev-1')`, [sid, tier])
    .then((r) => r.rows[0]);

const hold = (pg, sid, act, secs = 90) =>
  pg.query(`select * from hold_special_slot(1::smallint, $1, $2, $3)`, [sid, act, secs])
    .then((r) => r.rows[0]);

const confirm = (pg, sid, act) =>
  pg.query(`select * from confirm_special_slot(1::smallint, $1, $2, 'staff-1')`, [sid, act])
    .then((r) => r.rows[0]);

beforeEach(async () => {
  db = await freshDb();
});

describe('gift ladder', () => {
  test('a student below the threshold is refused', async () => {
    const s = await student(db, 2001, 0);
    const r = await claimGift(db, s, 1);
    assert.equal(r.result, 'not_eligible');

    const stock = await db.query(`select stock_issued from gift_tiers where id = 1`);
    assert.equal(stock.rows[0].stock_issued, 0, 'a refused claim must not consume stock');
  });

  test('claiming the same tier twice yields one gift and one unit of stock', async () => {
    const s = await student(db, 2002, 3);

    const first = await claimGift(db, s, 1);
    assert.equal(first.result, 'ok');
    assert.equal(first.gift_name, 'Bút chì');

    // The counter's connection dropped; the staff member taps again.
    for (let i = 0; i < 10; i++) {
      assert.equal((await claimGift(db, s, 1)).result, 'already_claimed');
    }

    const stock = await db.query(`select stock_issued from gift_tiers where id = 1`);
    assert.equal(stock.rows[0].stock_issued, 1, 'retries must not burn stock');

    const rows = await db.query(
      `select count(*)::int as c from gift_redemptions where student_id = $1 and gift_tier_id = 1`,
      [s]);
    assert.equal(rows.rows[0].c, 1);
  });

  test('cumulative mode hands over every tier the student has passed', async () => {
    const s = await student(db, 2003, 3);
    assert.equal((await claimGift(db, s, 1)).result, 'ok');
    assert.equal((await claimGift(db, s, 2)).result, 'ok');
    assert.equal((await claimGift(db, s, 3)).result, 'ok');

    const n = await db.query(
      `select count(*)::int as c from gift_redemptions where student_id = $1`, [s]);
    assert.equal(n.rows[0].c, 3);
  });

  test('highest_only mode hands over exactly one gift, and it must be the best one', async () => {
    await db.query(`update events set gift_ladder_mode = 'highest_only' where id = 1`);
    const s = await student(db, 2004, 3);

    // Asking for a lower tier is a counter mistake, not a choice.
    assert.equal((await claimGift(db, s, 1)).result, 'not_highest_tier');
    assert.equal((await claimGift(db, s, 3)).result, 'ok');
    assert.equal((await claimGift(db, s, 2)).result, 'already_claimed');

    const n = await db.query(
      `select count(*)::int as c from gift_redemptions where student_id = $1`, [s]);
    assert.equal(n.rows[0].c, 1);
  });

  test('stock runs out exactly at the limit, never past it', async () => {
    // Tier 3 has 3 units.
    const ids = [];
    for (let i = 0; i < 10; i++) ids.push(await student(db, 2100 + i, 5));

    const results = [];
    for (const id of ids) results.push((await claimGift(db, id, 3)).result);

    assert.equal(results.filter((r) => r === 'ok').length, 3, 'exactly the stock, no more');
    assert.equal(results.filter((r) => r === 'out_of_stock').length, 7);

    const stock = await db.query(`select stock_issued, stock_total from gift_tiers where id = 3`);
    assert.equal(stock.rows[0].stock_issued, 3);
    assert.ok(stock.rows[0].stock_issued <= stock.rows[0].stock_total);
  });

  test('the database itself refuses to oversell, even by hand', async () => {
    await assert.rejects(
      () => db.query(`update gift_tiers set stock_issued = stock_total + 1 where id = 3`),
      /violates check/i,
      'the check constraint is the backstop behind the function',
    );
  });

  test('raising the threshold does not revoke a gift already handed over', async () => {
    const s = await student(db, 2200, 2);
    assert.equal((await claimGift(db, s, 2)).result, 'ok');

    const grant = await db.query(
      `select threshold_at_grant, badge_count_at_grant from gift_redemptions
        where student_id = $1 and gift_tier_id = 2`, [s]);
    assert.equal(grant.rows[0].threshold_at_grant, 2, 'the rule at grant time is recorded');
    assert.equal(grant.rows[0].badge_count_at_grant, 2);

    // Admin raises x mid-event. The student keeps the notebook.
    await db.query(`update gift_tiers set required_badges = 4 where id = 2`);
    const still = await db.query(
      `select count(*)::int as c from gift_redemptions where student_id = $1`, [s]);
    assert.equal(still.rows[0].c, 1);

    // But they cannot now claim a tier they no longer qualify for.
    const s2 = await student(db, 2201, 2);
    assert.equal((await claimGift(db, s2, 2)).result, 'not_eligible');
  });
});

describe('capacity-limited special activities', () => {
  test('slots are pre-created to match capacity', async () => {
    const r = await db.query(
      `select count(*)::int as c from special_slots where special_activity_id = 1`);
    assert.equal(r.rows[0].c, 5);
  });

  test('a student below the y threshold cannot hold a slot', async () => {
    const s = await student(db, 3001, 4); // y = 5
    assert.equal((await hold(db, s, 1)).result, 'not_eligible');
  });

  test('exactly `capacity` students get a slot — never one more', async () => {
    const ids = [];
    for (let i = 0; i < 20; i++) ids.push(await student(db, 3100 + i, 5));

    let held = 0;
    let soldOut = 0;
    for (const id of ids) {
      const r = await hold(db, id, 1);
      if (r.result === 'held') {
        held++;
        assert.equal((await confirm(db, id, 1)).result, 'ok');
      } else if (r.result === 'sold_out') {
        soldOut++;
      }
    }

    assert.equal(held, 5, 'capacity is 5, so exactly 5 students may be promised a seat');
    assert.equal(soldOut, 15);

    const claimed = await db.query(
      `select count(*)::int as c from special_slots
        where special_activity_id = 1 and student_id is not null`);
    assert.equal(claimed.rows[0].c, 5);
  });

  test('slot numbers are unique and contiguous, so a paper list matches the app', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await student(db, 3200 + i, 5));
    const nums = [];
    for (const id of ids) {
      await hold(db, id, 1);
      nums.push((await confirm(db, id, 1)).slot_no);
    }
    assert.deepEqual([...nums].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  });

  test('z caps how many special activities one student may take', async () => {
    await db.query(`update events set special_claim_limit = 1 where id = 1`);
    const s = await student(db, 3300, 5);

    assert.equal((await hold(db, s, 1)).result, 'held');
    assert.equal((await confirm(db, s, 1)).result, 'ok');
    assert.equal((await hold(db, s, 2)).result, 'limit_reached');
  });

  test('a second hold on the same activity returns the existing one', async () => {
    const s = await student(db, 3400, 5);
    const a = await hold(db, s, 1);
    assert.equal(a.result, 'held');
    const b = await hold(db, s, 1);
    assert.equal(b.result, 'already_held');
    assert.equal(b.slot_no, a.slot_no, 'the student keeps the slot they were shown');
  });

  test('an expired hold releases the slot back to the pool', async () => {
    const a = await student(db, 3500, 5);
    const held = await hold(db, a, 2, 0); // expires immediately
    assert.equal(held.result, 'held');

    // The connection dropped before the student was told. The seat must not be
    // burned forever.
    const b = await student(db, 3501, 5);
    const reclaimed = await hold(db, b, 2);
    assert.equal(reclaimed.result, 'held');
    assert.equal(reclaimed.slot_no, held.slot_no, 'the same seat is reissued');

    // And the original holder can no longer confirm it.
    assert.equal((await confirm(db, a, 2)).result, 'hold_expired');
  });

  test('confirming twice is safe — a retried request is not an error', async () => {
    const s = await student(db, 3600, 5);
    await hold(db, s, 1);
    const first = await confirm(db, s, 1);
    assert.equal(first.result, 'ok');

    for (let i = 0; i < 5; i++) {
      const again = await confirm(db, s, 1);
      assert.equal(again.result, 'ok');
      assert.equal(again.slot_no, first.slot_no);
    }

    const n = await db.query(
      `select count(*)::int as c from special_slots
        where special_activity_id = 1 and student_id = $1`, [s]);
    assert.equal(n.rows[0].c, 1);
  });

  test('raising capacity adds seats without disturbing the ones already taken', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await student(db, 3700 + i, 5));
    for (const id of ids) {
      await hold(db, id, 1);
      await confirm(db, id, 1);
    }
    assert.equal((await hold(db, await student(db, 3799, 5), 1)).result, 'sold_out');

    await db.query(`update special_activities set capacity = 8 where id = 1`);
    await db.query(`select ensure_special_slots(1)`);

    const late = await student(db, 3800, 5);
    const r = await hold(db, late, 1);
    assert.equal(r.result, 'held');
    assert.equal(r.slot_no, 6);

    const taken = await db.query(
      `select count(*)::int as c from special_slots
        where special_activity_id = 1 and student_id is not null`);
    assert.equal(taken.rows[0].c, 5, 'existing claims are untouched');
  });

  test('lowering capacity removes only free seats', async () => {
    const s = await student(db, 3900, 5);
    await hold(db, s, 1);
    await confirm(db, s, 1);

    await db.query(`update special_activities set capacity = 2 where id = 1`);
    await db.query(`select ensure_special_slots(1)`);

    const rows = await db.query(
      `select count(*)::int as c from special_slots where special_activity_id = 1`);
    assert.equal(rows.rows[0].c, 2);

    const kept = await db.query(
      `select count(*)::int as c from special_slots
        where special_activity_id = 1 and student_id = $1`, [s]);
    assert.equal(kept.rows[0].c, 1, 'a claimed seat is never deleted');
  });

  test('the control panel reports what the admin needs to close the gate', async () => {
    for (let i = 0; i < 3; i++) {
      const id = await student(db, 4000 + i, 5);
      await hold(db, id, 1);
      await confirm(db, id, 1);
    }
    await hold(db, await student(db, 4100, 5), 1); // held, not confirmed
    await student(db, 4200, 6); // eligible, has not claimed

    const r = await db.query(
      `select * from v_special_control_panel where special_activity_id = 1`);
    const row = r.rows[0];
    assert.equal(row.capacity, 5);
    assert.equal(row.claimed, 3);
    assert.equal(row.on_hold, 1);
    assert.equal(row.available, 1);
    assert.ok(row.students_eligible >= 5);
  });
});
