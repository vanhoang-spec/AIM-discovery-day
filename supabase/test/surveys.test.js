/**
 * 0010 — sponsor surveys. What must never happen: a ninth question, a second
 * response, a badge without the award mode saying so, or an edit at 11:00
 * corrupting an answer from 10:59.
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
let seqN = 9000;
let uidN = 1;
const uid = () => `00000000-0000-7000-a000-${String(uidN++).padStart(12, '0')}`;

async function student(pg) {
  const seq = seqN++;
  const r = await pg.query(
    `insert into students (seq, lookup_code, full_name, name_search_key, email)
     values ($1, $2, $3, $4, $5) returning id`,
    [seq, `V${String(seq).padStart(5, '0')}`.slice(0, 6), `SV ${seq}`, `sv ${seq}`, `v${seq}@t.vn`],
  );
  await pg.query(`insert into registrations (student_id, event_id) values ($1, 1)`, [r.rows[0].id]);
  return r.rows[0].id;
}

const submit = (pg, surveyId, studentId, ruid = uid()) =>
  pg.query(
    `select * from submit_survey_response($1::uuid, 1::smallint, $2, $3, '{"q1":"a"}'::jsonb)`,
    [ruid, surveyId, studentId],
  ).then((r) => ({ ...r.rows[0], ruid }));

before(async () => {
  db = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  await db.exec(`
    insert into editions (id, year, name) values (1, 2026, 'ATL 2026');
    insert into events (id, edition_id, kind, slug, name, venue_name, city, starts_at, ends_at,
                        token_key_id)
    values (1, 1, 'discovery_day', 'hn', 'DD HN', 'FTU HN', 'HN',
            '2026-09-12 08:00+07', '2026-09-12 17:00+07', 'k1');
    insert into zones (id, event_id, name) values (1, 1, 'Booths');
    insert into checkpoints (id, event_id, zone_id, kind, name, counts_toward_badges,
                             badge_award_mode) values
      (1, 1, 1, 'sponsor_booth', 'Booth Survey-đủ',  true, 'survey_complete'),
      (2, 1, 1, 'sponsor_booth', 'Booth Cần-cả-hai', true, 'both_required'),
      (3, 1, 1, 'sponsor_booth', 'Booth Chỉ-quét',   true, 'pg_scan');
    insert into surveys (id, event_id, checkpoint_id, title, is_active, questions) values
      (1, 1, 1, 'Khảo sát A', true,  '[{"id":"q1","type":"choice","label":"?","options":["a","b"]}]'),
      (2, 1, 2, 'Khảo sát B', true,  '[{"id":"q1","type":"text","label":"?"}]'),
      (3, 1, 3, 'Khảo sát C', true,  '[{"id":"q1","type":"scale","label":"?"}]');
    select setval(pg_get_serial_sequence('surveys', 'id'),
                  (select max(id) + 1 from surveys), false);
  `);
});

describe('ràng buộc cứng', () => {
  test('a ninth question is refused by the table, not the UI', async () => {
    const nine = JSON.stringify(
      Array.from({ length: 9 }, (_, i) => ({ id: `q${i}`, type: 'text', label: 'x' })));
    await assert.rejects(
      db.query(`update surveys set questions = $1::jsonb where id = 1`, [nine]),
      /check/i,
    );
  });

  test('accent must be a hex colour — raw CSS has no door to walk through', async () => {
    await assert.rejects(
      db.query(`update surveys set accent_hex = 'red; } body { display:none' where id = 1`),
      /check/i,
    );
    await db.query(`update surveys set accent_hex = '#B26A17' where id = 1`);
  });
});

describe('submit + badge trong một transaction', () => {
  test('survey_complete mode: submitting IS the badge', async () => {
    const sv = await student(db);
    const r = await submit(db, 1, sv);
    assert.equal(r.status, 'submitted');
    assert.equal(r.badge_status, 'counted');
    assert.equal(r.badge_count, 1);
  });

  test('replay of the same response_uid changes nothing', async () => {
    const sv = await student(db);
    const first = await submit(db, 1, sv);
    const again = await submit(db, 1, sv, first.ruid);
    assert.equal(again.status, 'replay');
    const c = await db.query(
      `select count(*)::int as n from survey_responses where student_id = $1`, [sv]);
    assert.equal(c.rows[0].n, 1);
  });

  test('a second submission by the same student is refused, badge stays at one', async () => {
    const sv = await student(db);
    await submit(db, 1, sv);
    const dup = await submit(db, 1, sv); // uid mới, người cũ
    assert.equal(dup.status, 'already_submitted');
    const b = await db.query(
      `select badge_count from registrations where student_id = $1 and event_id = 1`, [sv]);
    assert.equal(b.rows[0].badge_count, 1);
  });

  test('both_required: survey alone holds, the PG scan completes it', async () => {
    const sv = await student(db);
    const r = await submit(db, 2, sv);
    assert.equal(r.badge_status, 'pending_other_condition', 'survey một mình chưa đủ');
    const scan = await db.query(
      `select * from record_scan($1::uuid, 1::smallint, $2, 2, 'pg_scan')`, [uid(), sv]);
    assert.equal(scan.rows[0].status, 'counted', 'quét PG hoàn tất điều kiện');
  });

  test('pg_scan mode: the survey NEVER awards, however hard it submits', async () => {
    const sv = await student(db);
    const r = await submit(db, 3, sv);
    assert.equal(r.status, 'submitted');
    assert.equal(r.badge_status, 'pending_other_condition');
    const b = await db.query(
      `select badge_count from registrations where student_id = $1 and event_id = 1`, [sv]);
    assert.equal(b.rows[0].badge_count, 0);
  });

  test('an inactive survey refuses politely', async () => {
    await db.query(`update surveys set is_active = false where id = 3`);
    const sv = await student(db);
    const r = await submit(db, 3, sv);
    assert.equal(r.status, 'closed');
    await db.query(`update surveys set is_active = true where id = 3`);
  });
});

describe('phiên bản câu hỏi', () => {
  test('an 11:00 edit does not corrupt a 10:59 response', async () => {
    const sv = await student(db);
    await submit(db, 1, sv);
    await db.query(
      `update surveys set questions = '[{"id":"q_moi","type":"text","label":"khác"}]'::jsonb,
                          schema_version = schema_version + 1
        where id = 1`);
    const r = await db.query(
      `select r.schema_version as answered, s.schema_version as current
         from survey_responses r join surveys s on s.id = r.survey_id
        where r.student_id = $1`, [sv]);
    assert.ok(r.rows[0].answered < r.rows[0].current,
      'response giữ phiên bản nó đã trả lời');
  });
});

describe('thống kê', () => {
  test('v_survey_stats counts responses and checkpoint badges from one place', async () => {
    const s = await db.query(`select * from v_survey_stats where survey_id = 1`);
    assert.ok(Number(s.rows[0].responses) >= 3);
    assert.ok(Number(s.rows[0].badges_at_checkpoint) >= 3);
  });
});
