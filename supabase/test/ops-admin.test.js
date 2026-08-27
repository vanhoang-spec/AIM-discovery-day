/**
 * Layer B — the operational switches, asserted the house way.
 *
 * The registration gate: closing stops the ONLINE funnel and nothing else —
 * walk-ins at the venue door must keep working on event day. Device revoke:
 * a revoked phone is dead to the server on its very next request, even
 * mid-queue. Specials: capacity IS the slot count, including after a raise.
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
let seqUid = 1;
const uid = () => `00000000-0000-7000-b000-${String(seqUid++).padStart(12, '0')}`;

const reg = (pg, phone, source = 'online') =>
  pg.query(
    `select * from register_student(
       1::smallint, 'SV Gate', null, $1, 1::smallint, null, 'MS1',
       null, null, null, null, null,
       'general'::registration_type, $2::registration_source,
       true, false, '10.0.0.1'::inet, 'v1', 'sv gate')`,
    [phone, source],
  ).then((r) => r.rows[0]);

beforeEach(async () => {
  db = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  await db.exec(`
    insert into editions (id, year, name) values (1, 2026, 'ATL 2026');
    insert into events (id, edition_id, kind, slug, name, venue_name, city, starts_at, ends_at,
                        token_key_id, is_registration_open)
    values (1, 1, 'discovery_day', 'hn', 'DD HN', 'FTU HN', 'HN',
            '2026-09-12 08:00+07', '2026-09-12 17:00+07', 'k1', true);
    insert into ref_schools (id, name, search_key) values (1, 'FTU', 'ftu');
    insert into zones (id, event_id, name) values (1, 1, 'Cổng');
    insert into checkpoints (id, event_id, zone_id, kind, name, counts_toward_badges)
    values (1, 1, 1, 'entrance', 'Cổng', true);
    insert into pg_staff (id, event_id, full_name, role) values (1, 1, 'PG', 'pg');
    insert into pg_devices (id, event_id, claim_code, pg_staff_id, zone_id, label)
    values (1, 1, 'K7M3QX', 1, 1, 'PG-01');
    select setval(pg_get_serial_sequence('checkpoints', 'id'),
                  (select max(id) + 1 from checkpoints), false);
  `);
});

describe('cổng đóng/mở đăng ký', () => {
  test('closed stops ONLINE and only online — walk-in keeps working', async () => {
    await db.query(`update events set is_registration_open = false where id = 1`);
    const online = await reg(db, '0911000001', 'online');
    assert.equal(online.status, 'closed');
    assert.equal(online.student_id, null, 'đóng là đóng — không tạo ai');

    const walkin = await reg(db, '0911000002', 'walk_in');
    assert.equal(walkin.status, 'created', 'cổng ngày sự kiện vẫn nhận walk-in');

    const admin = await reg(db, '0911000003', 'admin');
    assert.equal(admin.status, 'created');
  });

  test('reopening restores online registration', async () => {
    await db.query(`update events set is_registration_open = false where id = 1`);
    assert.equal((await reg(db, '0911000004')).status, 'closed');
    await db.query(`update events set is_registration_open = true where id = 1`);
    assert.equal((await reg(db, '0911000004')).status, 'created');
  });

  test('a closed gate creates NOTHING — no student row, no outbox row', async () => {
    await db.query(`update events set is_registration_open = false where id = 1`);
    await reg(db, '0911000005');
    const n = await db.query(
      `select (select count(*)::int from students where phone = '0911000005') as students,
              (select count(*)::int from notification_outbox) as outbox`);
    assert.deepEqual(n.rows[0], { students: 0, outbox: 0 });
  });
});

describe('thu hồi máy PG', () => {
  test('a revoked device is dead on its very next request', async () => {
    await db.query(`select * from claim_pg_device('K7M3QX', 'tok-rev', 'pin', null, 't')`);
    assert.equal(
      (await db.query(`select * from resolve_pg_device('tok-rev')`)).rows.length, 1);

    await db.query(
      `update pg_devices set revoked_at = now(), token_hash = null where id = 1`);

    assert.equal(
      (await db.query(`select * from resolve_pg_device('tok-rev')`)).rows.length, 0,
      'token cũ chết ngay');
    const scan = await db.query(
      `select * from record_pg_scan('tok-rev', $1::uuid, 999, 1)`, [uid()]);
    assert.equal(scan.rows[0].status, 'rejected_device');
  });

  test('a revoked claim code cannot be claimed again — it refuses loudly', async () => {
    await db.query(
      `update pg_devices set revoked_at = now() where id = 1`);
    await assert.rejects(
      db.query(`select * from claim_pg_device('K7M3QX', 'tok-x', 'pin', null, 't')`),
      /thu hồi|không hợp lệ/,
    );
  });
});

describe('hoạt động đặc biệt: capacity là số slot', () => {
  test('ensure_special_slots fills to capacity, and again after a raise', async () => {
    const act = (await db.query(
      `insert into special_activities (event_id, name, capacity, is_open)
       values (1, 'Meet & Greet', 5, false) returning id`)).rows[0];
    await db.query(`select ensure_special_slots($1)`, [act.id]);
    let n = (await db.query(
      `select count(*)::int as n from special_slots where special_activity_id = $1`,
      [act.id])).rows[0];
    assert.equal(n.n, 5);

    await db.query(`update special_activities set capacity = 8 where id = $1`, [act.id]);
    await db.query(`select ensure_special_slots($1)`, [act.id]);
    n = (await db.query(
      `select count(*)::int as n from special_slots where special_activity_id = $1`,
      [act.id])).rows[0];
    assert.equal(n.n, 8, 'nâng cap thì sinh thêm đúng phần thiếu');

    // Calling again is a no-op, never a duplicate.
    await db.query(`select ensure_special_slots($1)`, [act.id]);
    n = (await db.query(
      `select count(*)::int as n from special_slots where special_activity_id = $1`,
      [act.id])).rows[0];
    assert.equal(n.n, 8);
  });
});
