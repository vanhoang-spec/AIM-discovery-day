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

    insert into zones (id, event_id, name) values (1, 1, 'Cổng'), (2, 1, 'Finance'), (3, 2, 'HCM zone');

    insert into checkpoints (id, event_id, zone_id, kind, name, counts_toward_badges) values
      (1, 1, 1, 'entrance',      'Cổng check-in',    true),
      (2, 1, 2, 'sponsor_booth', 'Techcombank',      true),
      (3, 1, 2, 'sponsor_booth', 'Momo',             true),
      (4, 2, 3, 'sponsor_booth', 'Booth HCM',        true),
      (5, 1, 1, 'entrance',      'Early Bird',       true);

    -- Wired after the checkpoints exist, since these columns point at them.
    update events set early_bird_until = '2026-09-12 08:45+07',
                      checkin_checkpoint_id = 1,
                      early_bird_checkpoint_id = 5
     where id = 1;

    insert into pg_staff (id, event_id, full_name, role) values
      (1, 1, 'Trần Minh', 'pg'),
      (2, 1, 'Lê Hoa',   'supervisor');

    insert into pg_devices (id, event_id, claim_code, pg_staff_id, zone_id, label) values
      (1, 1, 'K7M3QX', 1, 1, 'PG-07'),
      (2, 1, 'P4R8TW', 2, 2, 'PG-14'),
      (3, 1, 'B2C5DF', 1, 2, 'PG-22');
  `);
  return pg;
}

/** Claim a device and return its token hash. */
async function claim(pg, code, tokenHash = 'tok-' + code) {
  const r = await pg.query(
    `select * from claim_pg_device($1, $2, $3, null, 'test')`,
    [code, tokenHash, 'pin-hash'],
  );
  return { row: r.rows[0], token: tokenHash };
}

/** Register a student and return their seq. */
async function student(pg, seq, eventId = 1) {
  const r = await pg.query(
    `insert into students (seq, lookup_code, full_name, name_search_key, email)
     values ($1, $2, $3, $4, $5) returning id`,
    [seq, `S${String(seq).padStart(5, '0')}`.slice(0, 6), `SV ${seq}`, `sv ${seq}`, `s${seq}@t.vn`],
  );
  await pg.query(`insert into registrations (student_id, event_id) values ($1, $2)`,
    [r.rows[0].id, eventId]);
  return seq;
}

const uuid = (n) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const scan = (pg, token, uid, seq, checkpoint, clientTs = null) =>
  pg.query(
    `select * from record_pg_scan($1, $2, $3, $4, $5::timestamptz)`,
    [token, uid, seq, checkpoint, clientTs],
  ).then((r) => r.rows[0]);

beforeEach(async () => { db = await freshDb(); });

describe('device claim', () => {
  test('claiming with a printed code returns the device context the app needs', async () => {
    const { row } = await claim(db, 'K7M3QX');
    assert.equal(row.device_id, 1);
    assert.equal(row.event_id, 1);
    assert.equal(row.label, 'PG-07');
    assert.equal(row.zone_name, 'Cổng');
    assert.equal(row.staff_name, 'Trần Minh');
  });

  test('is case-insensitive and tolerant of stray spaces', async () => {
    const { row } = await claim(db, '  k7m3qx  ');
    assert.equal(row.device_id, 1);
  });

  test('claiming twice is safe — a double tap must not lock a PG out', async () => {
    await claim(db, 'K7M3QX', 'tok-A');
    const { row } = await claim(db, 'K7M3QX', 'tok-B');
    assert.equal(row.device_id, 1);
    // The newest token wins; the older one stops working.
    const old = await db.query(`select * from resolve_pg_device('tok-A')`);
    assert.equal(old.rows.length, 0);
    const now = await db.query(`select * from resolve_pg_device('tok-B')`);
    assert.equal(now.rows.length, 1);
  });

  test('an unknown code is refused in Vietnamese, not a numeric error', async () => {
    await assert.rejects(() => claim(db, 'ZZZZZZ'), /Mã thiết bị không hợp lệ/);
  });

  test('a revoked device cannot be re-claimed', async () => {
    await db.query(`update pg_devices set revoked_at = now() where id = 1`);
    await assert.rejects(() => claim(db, 'K7M3QX'), /không hợp lệ|thu hồi/);
  });

  test('an unclaimed device resolves to nothing — tokens only exist after claiming', async () => {
    const r = await db.query(`select * from resolve_pg_device('never-issued')`);
    assert.equal(r.rows.length, 0);
  });
});

describe('scanning', () => {
  test('a valid scan awards a badge and returns the name for the PG to read', async () => {
    const { token } = await claim(db, 'P4R8TW');
    await student(db, 5001);
    const r = await scan(db, token, uuid(1), 5001, 2);
    assert.equal(r.status, 'counted');
    assert.equal(r.badge_count, 1);
    assert.equal(r.student_name, 'SV 5001');
  });

  test('a revoked device syncs nothing', async () => {
    const { token } = await claim(db, 'P4R8TW');
    await student(db, 5002);
    await db.query(`update pg_devices set revoked_at = now() where claim_code = 'P4R8TW'`);
    const r = await scan(db, token, uuid(2), 5002, 2);
    assert.equal(r.status, 'rejected_device');
    assert.equal(r.badge_count, 0);
  });

  test('an unknown student is rejected cleanly, not with a crash', async () => {
    const { token } = await claim(db, 'P4R8TW');
    const r = await scan(db, token, uuid(3), 999999, 2);
    assert.equal(r.status, 'rejected_unknown_student');
  });

  test('replaying the same scan_uid never awards a second badge', async () => {
    const { token } = await claim(db, 'P4R8TW');
    await student(db, 5003);
    const first = await scan(db, token, uuid(4), 5003, 2);
    assert.equal(first.status, 'counted');
    for (let i = 0; i < 10; i++) {
      const again = await scan(db, token, uuid(4), 5003, 2);
      assert.equal(again.status, 'replay');
      assert.equal(again.badge_count, 1);
    }
  });

  test('two devices scanning the same student at one checkpoint yield exactly one badge', async () => {
    const a = await claim(db, 'P4R8TW', 'tok-a');
    const b = await claim(db, 'B2C5DF', 'tok-b');
    await student(db, 5004);
    const r1 = await scan(db, a.token, uuid(5), 5004, 2);
    const r2 = await scan(db, b.token, uuid(6), 5004, 2);
    const outcomes = [r1.status, r2.status].sort();
    assert.deepEqual(outcomes, ['counted', 'repeat_not_counted']);
    assert.equal(r2.badge_count, 1);
  });

  test('a device cannot scan a checkpoint outside its assigned list', async () => {
    const { token } = await claim(db, 'P4R8TW');
    await db.query(
      `insert into pg_device_checkpoints (device_id, checkpoint_id, event_id) values (2, 2, 1)`);
    await student(db, 5005);

    const allowed = await scan(db, token, uuid(7), 5005, 2);
    assert.equal(allowed.status, 'counted');

    const denied = await scan(db, token, uuid(8), 5005, 3);
    assert.equal(denied.status, 'rejected_out_of_scope',
      'a Finance device must not be able to award a Momo badge');
  });

  test('with no explicit list a device may scan anywhere in its event', async () => {
    const { token } = await claim(db, 'P4R8TW');
    await student(db, 5006);
    assert.equal((await scan(db, token, uuid(9), 5006, 2)).status, 'counted');
    assert.equal((await scan(db, token, uuid(10), 5006, 3)).status, 'counted');
  });

  test('a Hà Nội device cannot touch an HCM checkpoint', async () => {
    const { token } = await claim(db, 'P4R8TW');
    await student(db, 5007);
    const r = await scan(db, token, uuid(11), 5007, 4);
    assert.equal(r.status, 'rejected_checkpoint_closed');
  });

  test('every scan updates the device heartbeat the supervisor board reads', async () => {
    const { token } = await claim(db, 'P4R8TW');
    await student(db, 5008);
    await scan(db, token, uuid(12), 5008, 2);
    const d = await db.query(`select last_sync_at from pg_devices where claim_code = 'P4R8TW'`);
    assert.ok(d.rows[0].last_sync_at);
  });
});

describe('Early Bird (AC12)', () => {
  test('arriving before the cut-off earns 2 badges in ONE scan', async () => {
    const { token } = await claim(db, 'K7M3QX');
    await student(db, 6001);
    const r = await scan(db, token, uuid(20), 6001, 1, '2026-09-12 08:30+07');
    assert.equal(r.status, 'counted');
    assert.equal(r.early_bird, true);
    assert.equal(r.badge_count, 2, 'check-in badge + Early Bird, from a single scan');
  });

  test('arriving after the cut-off earns exactly 1', async () => {
    const { token } = await claim(db, 'K7M3QX');
    await student(db, 6002);
    const r = await scan(db, token, uuid(21), 6002, 1, '2026-09-12 09:15+07');
    assert.equal(r.early_bird, false);
    assert.equal(r.badge_count, 1);
  });

  test('Early Bird applies only at the check-in checkpoint, not at booths', async () => {
    const { token } = await claim(db, 'B2C5DF');
    await student(db, 6003);
    const r = await scan(db, token, uuid(22), 6003, 2, '2026-09-12 08:30+07');
    assert.equal(r.early_bird, false, 'a booth scan before 08:45 is not Early Bird');
    assert.equal(r.badge_count, 1);
  });

  test('replaying an Early Bird scan does not award a third badge', async () => {
    const { token } = await claim(db, 'K7M3QX');
    await student(db, 6004);
    await scan(db, token, uuid(23), 6004, 1, '2026-09-12 08:30+07');
    for (let i = 0; i < 5; i++) {
      const again = await scan(db, token, uuid(23), 6004, 1, '2026-09-12 08:30+07');
      assert.equal(again.status, 'replay');
    }
    const reg = await db.query(
      `select badge_count from registrations r join students s on s.id = r.student_id
        where s.seq = 6004`);
    assert.equal(reg.rows[0].badge_count, 2, 'still exactly 2');
  });

  test('an event with the mechanic switched off never awards it', async () => {
    await db.query(`update events set early_bird_until = null where id = 1`);
    const { token } = await claim(db, 'K7M3QX');
    await student(db, 6005);
    const r = await scan(db, token, uuid(24), 6005, 1, '2026-09-12 08:00+07');
    assert.equal(r.early_bird, false);
    assert.equal(r.badge_count, 1);
  });
});

describe('roster snapshot', () => {
  test('returns the compact rows the offline lookup needs', async () => {
    for (let i = 0; i < 5; i++) await student(db, 7000 + i);
    const r = await db.query(`select * from pg_roster(1::smallint)`);
    assert.equal(r.rows.length, 5);
    const row = r.rows[0];
    for (const k of ['seq', 'lookup_code', 'name', 'name_key', 'mssv', 'phone', 'badge_count']) {
      assert.ok(k in row, `roster row must carry ${k}`);
    }
  });

  test('only covers the requested event', async () => {
    await student(db, 7100, 1);
    await student(db, 7200, 2);
    const hn = await db.query(`select * from pg_roster(1::smallint)`);
    assert.deepEqual(hn.rows.map((r) => r.seq), [7100]);
  });

  test('delta returns walk-ins registered after the device cached its snapshot', async () => {
    await student(db, 7300);
    const snapshotAt = (await db.query(`select now() as t`)).rows[0].t;
    await db.query(`select pg_sleep(0.05)`);
    await student(db, 7301); // registered at the door, after the briefing cache

    const delta = await db.query(`select * from pg_roster(1::smallint, $1::timestamptz)`,
      [snapshotAt]);
    assert.deepEqual(delta.rows.map((r) => r.seq), [7301],
      'a device offline for an hour catches up on walk-ins without re-downloading everyone');
  });

  test('stays small enough to precache — under ~70 bytes a student', async () => {
    for (let i = 0; i < 200; i++) await student(db, 8000 + i);
    const r = await db.query(`select * from pg_roster(1::smallint)`);
    const bytes = Buffer.byteLength(JSON.stringify(r.rows), 'utf8');
    const perStudent = bytes / r.rows.length;
    assert.ok(perStudent < 200, `${perStudent.toFixed(0)}B/student raw before gzip`);
  });
});

describe('device health board', () => {
  test('flags a device that has not synced for over ten minutes', async () => {
    await claim(db, 'K7M3QX');
    await db.query(
      `update pg_devices set last_sync_at = now() - interval '11 minutes', queue_depth = 47
        where id = 1`);
    const r = await db.query(`select * from v_device_health where device_id = 1`);
    assert.equal(r.rows[0].sync_alert, true);
    assert.equal(r.rows[0].queue_depth, 47);
  });

  test('flags a low battery', async () => {
    await claim(db, 'K7M3QX');
    await db.query(`select report_device_health('tok-K7M3QX', 3, 18::smallint)`);
    const r = await db.query(`select * from v_device_health where device_id = 1`);
    assert.equal(r.rows[0].battery_alert, true);
    assert.equal(r.rows[0].queue_depth, 3);
    assert.equal(r.rows[0].sync_alert, false, 'health report counts as a sync');
  });

  test('sorts problem devices to the top', async () => {
    await claim(db, 'K7M3QX', 'tok-1');
    await claim(db, 'P4R8TW', 'tok-2');
    await db.query(`select report_device_health('tok-2', 0, 90::smallint)`);
    await db.query(
      `update pg_devices set last_sync_at = now() - interval '20 minutes' where id = 1`);
    const r = await db.query(`select device_id, sync_alert from v_device_health where event_id = 1`);
    assert.equal(r.rows[0].device_id, 1, 'the stale device comes first');
  });

  test('a revoked device disappears from the board', async () => {
    await claim(db, 'K7M3QX');
    await db.query(`update pg_devices set revoked_at = now() where id = 1`);
    const r = await db.query(`select * from v_device_health where device_id = 1`);
    assert.equal(r.rows.length, 0);
  });
});
