/**
 * 0009 — clone_event (AC28). The assertions that matter: configuration
 * copies EXACTLY, history copies NEVER, and the clone cannot silently leak
 * state (open registration, spent stock, an active golden hour) from its
 * source.
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
let clone; // result row

before(async () => {
  db = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  await db.exec(`
    insert into editions (id, year, name) values (1, 2026, 'ATL 2026');
    insert into events (id, edition_id, kind, slug, name, venue_name, city, starts_at, ends_at,
                        token_key_id, special_threshold_y, special_claim_limit,
                        is_registration_open)
    values (1, 1, 'discovery_day', 'hn', 'DD HN', 'FTU HN', 'HN',
            '2026-09-12 08:00+07', '2026-09-12 17:00+07', 'k1', 6, 2, true);

    insert into zones (id, event_id, name, display_order) values
      (1, 1, 'Cổng', 0), (2, 1, 'Finance', 1);

    insert into checkpoints (id, event_id, zone_id, kind, name, counts_toward_badges,
                             badge_award_mode, starts_at, ends_at) values
      (1, 1, 1, 'entrance',      'Cổng check-in', true, 'pg_scan', null, null),
      (2, 1, 2, 'sponsor_booth', 'Booth A', true, 'survey_complete',
         '2026-09-12 09:00+07', '2026-09-12 16:00+07'),
      (3, 1, 1, 'bonus',         'Early Bird', true, 'pg_scan', null, null);

    update events set checkin_checkpoint_id = 1, early_bird_checkpoint_id = 3,
                      early_bird_until = '2026-09-12 08:45+07'
     where id = 1;

    insert into gift_tiers (event_id, tier, required_badges, gift_name, stock_total, stock_issued)
    values (1, 1, 2, 'Bút chì', 100, 37), (1, 2, 5, 'Sổ tay', 50, 9);

    insert into special_activities (id, event_id, name, capacity, is_open)
    values (1, 1, 'Meet & Greet', 4, true);
    insert into special_slots (event_id, special_activity_id, slot_no)
    select 1, 1, n from generate_series(1, 4) n;
    -- One slot claimed on the source: must NOT follow the clone.
    insert into students (id, seq, lookup_code, full_name, name_search_key, email)
    values (1, 500, 'CX0001', 'SV Gốc', 'sv goc', 'goc@t.vn');
    insert into registrations (student_id, event_id) values (1, 1);
    update special_slots set student_id = 1, claimed_at = now()
     where special_activity_id = 1 and slot_no = 1;
  `);
  clone = (await db.query(
    `select * from clone_event(1::smallint, 'gf', 'Grand Finale', 'GEM Center', 'TPHCM',
       '2026-11-01 08:00+07'::timestamptz, '2026-11-01 17:00+07'::timestamptz, 'Hoang')`,
  )).rows[0];
});

describe('clone_event', () => {
  test('one call copies the whole shape', () => {
    assert.equal(clone.zones_copied, 2);
    assert.equal(clone.checkpoints_copied, 3);
    assert.equal(clone.tiers_copied, 2);
    assert.equal(clone.specials_copied, 1);
  });

  test('the clone is born CLOSED with zeroed counters', async () => {
    const e = (await db.query(
      `select is_registration_open, golden_issued, early_bird_until,
              special_threshold_y, gift_ladder_mode
         from events where id = $1`, [clone.new_event_id])).rows[0];
    assert.equal(e.is_registration_open, false, 'mở đăng ký là quyết định riêng');
    assert.equal(e.golden_issued, 0);
    assert.equal(e.early_bird_until, null, 'giờ Early Bird thuộc về một buổi sáng cụ thể');
    assert.equal(e.special_threshold_y, 6, 'ngưỡng thì copy');
  });

  test('gift stock copies the plan, never the spend', async () => {
    const t = (await db.query(
      `select tier, required_badges, stock_total, stock_issued
         from gift_tiers where event_id = $1 order by tier`, [clone.new_event_id])).rows;
    assert.deepEqual(t.map((x) => [x.tier, x.required_badges, x.stock_total, x.stock_issued]),
      [[1, 2, 100, 0], [2, 5, 50, 0]]);
  });

  test('special slots are regenerated empty — a claimed source slot does not follow', async () => {
    const s = (await db.query(
      `select count(*)::int as total,
              count(*) filter (where student_id is not null)::int as claimed
         from special_slots ss
         join special_activities sa on sa.id = ss.special_activity_id
        where sa.event_id = $1`, [clone.new_event_id])).rows[0];
    assert.deepEqual(s, { total: 4, claimed: 0 });
    const open = (await db.query(
      `select is_open from special_activities where event_id = $1`, [clone.new_event_id])).rows[0];
    assert.equal(open.is_open, false);
  });

  test('checkin and early-bird pointers land on the NEW checkpoints', async () => {
    const e = (await db.query(
      `select checkin_checkpoint_id, early_bird_checkpoint_id
         from events where id = $1`, [clone.new_event_id])).rows[0];
    const kinds = (await db.query(
      `select id, kind::text as kind from checkpoints where event_id = $1`,
      [clone.new_event_id])).rows;
    const byId = new Map(kinds.map((k) => [k.id, k.kind]));
    assert.equal(byId.get(e.checkin_checkpoint_id), 'entrance');
    assert.equal(byId.get(e.early_bird_checkpoint_id), 'bonus');
    // And they are genuinely new rows, not the source's ids.
    assert.notEqual(e.checkin_checkpoint_id, 1);
    assert.notEqual(e.early_bird_checkpoint_id, 3);
  });

  test('checkpoint times shift by the event-start delta (12/09 → 01/11 = 50 days)', async () => {
    const cp = (await db.query(
      `select starts_at from checkpoints
        where event_id = $1 and name = 'Booth A'`, [clone.new_event_id])).rows[0];
    assert.equal(new Date(cp.starts_at).toISOString(), '2026-11-01T02:00:00.000Z'); // 09:00 VN
  });

  test('no people, no ledger, no registrations cross over', async () => {
    const r = (await db.query(
      `select count(*)::int as n from registrations where event_id = $1`,
      [clone.new_event_id])).rows[0];
    assert.equal(r.n, 0);
  });

  test('the source event is untouched', async () => {
    const src = (await db.query(
      `select is_registration_open,
              (select stock_issued from gift_tiers where event_id = 1 and tier = 1) as issued,
              (select count(*)::int from special_slots ss
                join special_activities sa on sa.id = ss.special_activity_id
               where sa.event_id = 1 and ss.student_id is not null) as claimed
         from events where id = 1`)).rows[0];
    assert.equal(src.is_registration_open, true);
    assert.equal(src.issued, 37);
    assert.equal(src.claimed, 1);
  });

  test('cloning the clone works too — ids are assigned, not serial', async () => {
    const again = (await db.query(
      `select * from clone_event($1::smallint, 'gf-2027', 'GF 2027', 'X', 'HCM',
         '2027-11-01 08:00+07'::timestamptz, '2027-11-01 17:00+07'::timestamptz, 'Hoang')`,
      [clone.new_event_id])).rows[0];
    assert.equal(again.new_event_id, clone.new_event_id + 1);
    assert.equal(again.checkpoints_copied, 3);
  });

  test('the clone is audited with its inventory', async () => {
    const a = (await db.query(
      `select after_state from audit_log
        where action = 'clone_event' and event_id = $1`, [clone.new_event_id])).rows[0];
    assert.equal(a.after_state.checkpoints, 3);
  });
});
