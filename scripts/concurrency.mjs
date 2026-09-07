/**
 * T1–T7 — the contention tests (spec §4.2).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `npm test`
 * The 282 tests in the suite run on PGlite, which is a single connection.
 * They prove the LOGIC is right. They cannot prove the LOCKING is right,
 * because nothing ever races. On 12/09 there are 1.500–2.000 students and
 * ~45 scanners per venue hitting the same rows at the same millisecond.
 * `FOR UPDATE SKIP LOCKED`, the partial unique indexes and the golden-hour
 * caps are all correct on paper — and "correct on paper" is exactly what
 * failed twice on 04/09.
 *
 * WHY IT REFUSES TO RUN WITHOUT A SANDBOX MARKER
 * `ledger_events` is append-only, enforced by triggers (0002:83-86). Every
 * scan these tests generate is PERMANENT — no DELETE, not even by hand, not
 * even as the owner. T1 alone writes 500 contended holds; T3 hammers scans
 * for 60 seconds. Pointed at production, this file would inject thousands of
 * unremovable junk rows into the database AIM runs the event on, and there
 * is no undo. So it demands a marker table that only exists where someone
 * deliberately created it.
 *
 *   Run once in the SANDBOX project's SQL editor:
 *     create table concurrency_sandbox (note text);
 *
 * USAGE
 *   node --env-file=.env.local scripts/concurrency.mjs        # all
 *   node --env-file=.env.local scripts/concurrency.mjs T1 T5  # some
 */

import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

const WANTED = process.argv.slice(2).map((s) => s.toUpperCase());
const want = (id) => WANTED.length === 0 || WANTED.includes(id);

// SCALE=2 doubles every client / attempt count. The caps stay fixed — 200
// slots, 1 gift, 80 bonus badges — because the invariant under test is
// "N attempts against a cap of M yield exactly M winners", whatever N is.
const SCALE = Number(process.env.SCALE ?? 1);

const URL_ = process.env.DATABASE_URL;
if (!URL_) die('DATABASE_URL trống. Điền vào .env.local rồi chạy lại.');
if (URL_.includes('[')) die('DATABASE_URL còn [YOUR-PASSWORD] — thay bằng mật khẩu thật.');

// One pool for setup/assertions, and separate single connections per worker:
// a pooled client would serialise the very contention we are trying to cause.
const sql = postgres(URL_, { max: 4, prepare: false, onnotice: () => {} });

function die(msg) {
  console.error('\n✗ ' + msg + '\n');
  process.exit(1);
}

const results = [];
function record(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? '  ✔' : '  ✗'} ${id}  ${detail}`);
}

/**
 * Fire `n` attempts with as much real simultaneity as the pooler allows.
 *
 * Supavisor caps CLIENT connections (200 on this compute size) and answers
 * EMAXCONN past it — so "500 sockets at once" is not a thing that can happen,
 * against this database or against production. Instead: open MAX_SOCKETS real
 * connections, warm them, then have each drive its share of the attempts back
 * to back. At every instant MAX_SOCKETS statements are genuinely in flight and
 * racing for the same rows; across the run all `n` attempts are made.
 *
 * That still tests the invariant these cases exist for — N attempts against a
 * cap of M must yield exactly M winners — while staying inside a limit the
 * production system also lives inside.
 */
const MAX_SOCKETS = Number(process.env.MAX_SOCKETS ?? 150);
let lastSockets = 0;

async function stampede(n, fn) {
  const sockets = Math.min(n, MAX_SOCKETS);
  lastSockets = sockets;
  const conns = Array.from({ length: sockets }, () =>
    postgres(URL_, { max: 1, prepare: false, onnotice: () => {} }));
  const out = new Array(n);
  try {
    // Warm every socket BEFORE the contended statement, so the race is over
    // the row lock and not over TCP setup.
    await Promise.all(conns.map((c) => c`select 1`));
    const buckets = Array.from({ length: sockets }, () => []);
    for (let i = 0; i < n; i++) buckets[i % sockets].push(i);
    await Promise.all(conns.map(async (c, s) => {
      for (const i of buckets[s]) {
        try { out[i] = { ok: true, rows: await fn(c, i) }; }
        catch (e) { out[i] = { ok: false, err: String(e?.message ?? e) }; }
      }
    }));
    return out;
  } finally {
    await Promise.allSettled(conns.map((c) => c.end({ timeout: 5 })));
  }
}

// ── safety interlock ────────────────────────────────────────────────────────
async function assertSandbox() {
  const [m] = await sql`select to_regclass('public.concurrency_sandbox') as t`;
  if (!m?.t) {
    die(
      'ĐÂY KHÔNG PHẢI DATABASE SANDBOX — từ chối chạy.\n\n'
      + '  ledger_events là append-only: mọi lượt quét test sẽ nằm lại VĨNH VIỄN,\n'
      + '  không xoá được. Không bao giờ chạy bộ này trên database thật của sự kiện.\n\n'
      + '  Nếu database đang trỏ tới ĐÚNG là bản nháp dùng xong xoá, chạy câu này\n'
      + '  trong SQL Editor của nó rồi thử lại:\n\n'
      + '      create table concurrency_sandbox (note text);\n',
    );
  }
  const [{ n }] = await sql`select count(*)::int as n from ledger_events`;
  console.log(`  (sandbox hợp lệ · ledger đang có ${n} dòng${SCALE !== 1 ? ` · SCALE=${SCALE}` : ''})\n`);
}

// ── fixtures ────────────────────────────────────────────────────────────────
// events.id is ASSIGNED, never serial (0001:62) — it is mirrored into the QR
// token's eventInstance byte, so Postgres must not pick it. Real events take
// 1/2/3; sandbox events start well clear of those.
let nextEventId = 10;

// Crockford Base32 — the alphabet the lookup_code CHECK accepts: no I, L, O
// or U, because a student reads this code aloud to a PG at a noisy gate.
// Counting upward from a random start keeps all codes in one run unique
// without a collision-retry loop.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let codeSeq = Math.floor(Math.random() * 900_000_000);
function lookupCode() {
  let n = codeSeq++;
  let out = '';
  for (let i = 0; i < 6; i++) { out = CROCKFORD[n % 32] + out; n = Math.floor(n / 32); }
  return out;
}

/**
 * Campaign-wide person counter — email and phone are unique across ALL events,
 * so it must also survive a RERUN. Earlier attempts leave `sv1@…`/`0900000001`
 * behind; starting from 1 again collides on the second run, which looks like a
 * concurrency failure and is not one. Read the high-water mark instead.
 */
let personSeq = 1;
async function initPersonSeq() {
  const [r] = await sql`
    select coalesce(max(nullif(substring(phone from 3), '')::bigint), 0)::bigint as hi
      from students where phone ~ '^09[0-9]{8}$'`;
  personSeq = Number(r.hi) + 1;
}

/** A fresh event + zone + checkpoints + N students, all owned by this run. */
async function fixture({ students, slots, withDevice = false }) {
  const tag = 'T' + Date.now().toString(36);
  // A blank sandbox has run production-init but not the seed, so there may be
  // no edition to point at and events.edition_id is NOT NULL.
  const [ed] = await sql`
    insert into editions (year, name) values (2026, 'Sandbox')
    on conflict (year, name) do update set name = excluded.name
    returning id`;
  // Ask the database, don't count in memory: a half-finished earlier run
  // leaves its event behind, and events.id has no sequence to fall back on.
  const [{ free }] = await sql`
    select greatest(coalesce(max(id), 0) + 1, ${nextEventId})::int as free from events`;
  const eventId = free;
  nextEventId = free + 1;
  await sql`
    insert into events (id, edition_id, kind, slug, name, venue_name, city,
                        starts_at, ends_at, token_key_id, is_registration_open,
                        special_threshold_y)
    values (${eventId}, ${ed.id}, 'discovery_day',
            ${tag}, ${'Sandbox ' + tag}, 'sandbox', 'sandbox',
            now(), now() + interval '8 hours', 'dd-2026', true, 1)`;

  const [zone] = await sql`
    insert into zones (event_id, name, display_order) values (${eventId}, 'Z', 0)
    returning id`;
  const [entrance] = await sql`
    insert into checkpoints (event_id, zone_id, kind, name, counts_toward_badges, display_order)
    values (${eventId}, ${zone.id}, 'entrance', 'Cổng', true, 0) returning id`;
  const [booth] = await sql`
    insert into checkpoints (event_id, zone_id, kind, name, counts_toward_badges, display_order)
    values (${eventId}, ${zone.id}, 'sponsor_booth', 'Booth', true, 1) returning id`;

  // Students. Three constraints bite here (0001:178-185): lookup_code must be
  // exactly six Crockford characters, email must be lowercase, phone digits
  // only. And email/phone are unique CAMPAIGN-wide, not per event — so the
  // counter must run across every fixture in the process, never restart at 0.
  // Bulk, not a loop. Three statements per student at ~120 ms each to
  // Singapore made a 500-student fixture cost three minutes; at SCALE=2 that
  // would be six. One insert through jsonb_to_recordset, one registrations
  // insert, and every entrance scan inside a single statement.
  const rows = Array.from({ length: students }, (_, i) => {
    const seq = personSeq++;
    return { lookup_code: lookupCode(), full_name: 'SV ' + seq, name_search_key: 'sv ' + seq,
             email: `sv${seq}@sandbox.invalid`, phone: '09' + String(seq).padStart(8, '0'),
             student_code: tag + '-' + i };
  });
  const inserted = await sql`
    insert into students (seq, lookup_code, full_name, name_search_key, email, phone,
                          school_id, student_code, consent_event_at)
    select nextval('student_seq_counter'), r.lookup_code, r.full_name, r.name_search_key,
           r.email, r.phone, null, r.student_code, now()
      from jsonb_to_recordset(${sql.json(rows)})
        as r(lookup_code text, full_name text, name_search_key text, email text,
             phone text, student_code text)
    returning id, seq`;
  const ids = inserted.map((s) => Number(s.id));
  const seqs = inserted.map((s) => Number(s.seq));
  await sql`insert into registrations (student_id, event_id)
            select id, ${eventId} from students where id = any(${ids}::bigint[])`;
  // One entrance badge each → passes the special-activity threshold (y = 1).
  await sql`select record_scan(gen_random_uuid(), ${eventId}::smallint, s.id, ${entrance.id}::integer)
              from unnest(${ids}::bigint[]) as s(id)`;

  let token = null;
  if (withDevice) {
    const [st] = await sql`
      insert into pg_staff (event_id, full_name, role)
      values (${eventId}, 'Sandbox PG', 'pg') returning id`;
    token = 'tok-' + tag + '-' + Math.random().toString(36).slice(2);
    await sql`
      insert into pg_devices (event_id, claim_code, pg_staff_id, zone_id, label,
                              token_hash, claimed_at)
      values (${eventId}, ${lookupCode()}, ${st.id}, ${zone.id}, 'PG-01',
              ${token}, now())`;
  }

  let activityId = null;
  if (slots) {
    const [a] = await sql`
      insert into special_activities (event_id, name, capacity, is_open)
      values (${eventId}, 'Suất', ${slots}, true) returning id`;
    activityId = a.id;
    await sql`select ensure_special_slots(${activityId}::integer)`;
  }

  return { tag, eventId, zoneId: zone.id, entrance: entrance.id, booth: booth.id,
           ids, seqs, activityId, token };
}

// ── T1 ──────────────────────────────────────────────────────────────────────
async function T1() {
  // Spec §4.2 asks for 10/10 runs, not one lucky pass: a lock bug that loses
  // a race one time in twenty is exactly the kind that survives a single
  // green run and then oversells the Meet & Greet on the day. Build the
  // students once and reset the slots between rounds.
  const SLOTS = 200, CLIENTS = 500 * SCALE;
  const RUNS = Number(process.env.T1_RUNS ?? 1);
  const f = await fixture({ students: CLIENTS, slots: SLOTS });
  const rounds = [];
  let bad = null;

  for (let r = 0; r < RUNS; r++) {
    if (r > 0) {
      await sql`update special_slots
                   set held_by_student_id = null, held_until = null,
                       student_id = null, claimed_at = null
                 where special_activity_id = ${f.activityId}`;
    }
    const out = await stampede(CLIENTS, (c, i) =>
      c`select * from hold_special_slot(${f.eventId}::smallint, ${f.ids[i]}::bigint,
                                        ${f.activityId}::integer, 90)`);
    const held = out.filter((x) => x.ok && x.rows[0]?.result === 'held').length;
    const soldOut = out.filter((x) => x.ok && x.rows[0]?.result === 'sold_out').length;
    const errs = out.filter((x) => !x.ok);
    const [{ n }] = await sql`select count(*)::int as n from special_slots
                               where special_activity_id = ${f.activityId}
                                 and held_by_student_id is not null`;
    rounds.push(held);
    if (held !== SLOTS || n !== SLOTS || soldOut !== CLIENTS - SLOTS || errs.length) {
      bad = `vòng ${r + 1}: held=${held} sold_out=${soldOut} ghế=${n} lỗi=${errs.length}`
          + (errs.length ? ` · ${errs[0].err.slice(0, 90)}` : '');
      break;
    }
  }

  const okAll = bad === null && rounds.length === RUNS;
  record('T1', okAll,
    okAll
      ? `${CLIENTS} tranh ${SLOTS} qua ${lastSockets} kết nối · ${RUNS}/${RUNS} vòng đều đúng ${SLOTS} held`
      : `${bad} (đã chạy ${rounds.length}/${RUNS} vòng, held mỗi vòng: ${rounds.join(',')})`);
}

// ── T2 ──────────────────────────────────────────────────────────────────────
async function T2() {
  const CLIENTS = 200 * SCALE;
  const f = await fixture({ students: 1 });
  const [tier] = await sql`
    insert into gift_tiers (event_id, tier, required_badges, gift_name, stock_total)
    values (${f.eventId}, 1, 1, 'Quà', 50) returning id`;
  const out = await stampede(CLIENTS, (c) =>
    c`select * from claim_gift_tier(${f.eventId}::smallint, ${f.ids[0]}::bigint,
                                    ${tier.id}::integer, 'T2', 'T2', false)`);
  const okd = out.filter((r) => r.ok && r.rows[0]?.result === 'ok').length;
  const errs = out.filter((r) => !r.ok);
  const [{ n }] = await sql`select count(*)::int as n from gift_redemptions
                             where gift_tier_id = ${tier.id}`;
  const [{ left }] = await sql`select stock_total - stock_issued as left
                                 from gift_tiers where id = ${tier.id}`;
  record('T2', okd === 1 && n === 1 && errs.length === 0 && Number(left) === 49,
    `${CLIENTS} cùng claim 1 bậc: thành công=${okd} lỗi=${errs.length} · bản ghi đổi quà=${n} · kho còn=${left}/50`
    + (errs.length ? ` · ví dụ lỗi: ${errs[0].err.slice(0, 90)}` : ''));
}

// ── T4 ──────────────────────────────────────────────────────────────────────
async function T4() {
  const f = await fixture({ students: 1 });
  const uid = randomUUID();
  const seen = [];
  const REPLAYS = 3 * SCALE;
  for (let i = 0; i < REPLAYS; i++) {
    const r = await sql`select * from record_scan(${uid}::uuid, ${f.eventId}::smallint,
                                                  ${f.ids[0]}::bigint, ${f.booth}::integer)`;
    seen.push(r[0]?.status);
  }
  const [{ n }] = await sql`select count(*)::int as n from ledger_events where scan_uid = ${uid}`;
  const [{ b }] = await sql`select badge_count as b from registrations
                             where student_id = ${f.ids[0]} and event_id = ${f.eventId}`;
  record('T4', n === 1 && Number(b) === 2
    && seen[0] === 'counted' && seen.slice(1).every((s) => s === 'replay'),
    `phát lại ${REPLAYS} lần cùng scan_uid: trạng thái=${seen.join(',')} · dòng ledger=${n} · badge=${b} (cổng+booth)`);
}

// ── T5 ──────────────────────────────────────────────────────────────────────
async function T5() {
  const f = await fixture({ students: 1 });
  const PGS = 2 * SCALE;
  const out = await stampede(PGS, (c) =>
    c`select * from record_scan(${randomUUID()}::uuid, ${f.eventId}::smallint,
                                ${f.ids[0]}::bigint, ${f.booth}::integer)`);
  const st = out.map((r) => (r.ok ? r.rows[0]?.status : 'ERR:' + r.err.slice(0, 40)));
  const [{ n }] = await sql`select count(*)::int as n from attendance
                             where student_id = ${f.ids[0]} and checkpoint_id = ${f.booth}`;
  // scan_status is an enum: 'counted' | 'replay' | 'repeat_not_counted'.
  // The loser must come back as repeat_not_counted — a clean, quiet answer the
  // PG app shows in amber, NOT an error. AC11: treating it as an error teaches
  // PGs to ignore red, and then a real error slips through.
  record('T5', n === 1
    && st.filter((s) => s === 'counted').length === 1
    && st.filter((s) => s === 'repeat_not_counted').length === PGS - 1,
    `${PGS} PG quét cùng lúc: ${st.join(' / ')} · badge trong DB=${n}`);
}

// ── T6 / T7 ─────────────────────────────────────────────────────────────────
async function T6() {
  const SCANS = 200 * SCALE, CAP = 80;
  const f = await fixture({ students: SCANS, withDevice: true });
  const [g] = await sql`select * from activate_golden_hour(${f.eventId}::smallint,
                          ${f.zoneId}::integer, 'T6', 40, ${CAP})`;
  if (g.result !== 'ok') return record('T6', false, `không mở được đợt: ${g.result}`);
  const out = await stampede(SCANS, (c, i) =>
    c`select * from record_pg_scan(${f.token}, ${randomUUID()}::uuid,
                                   ${f.seqs[i]}::integer, ${f.booth}::integer)`);
  const errs = out.filter((r) => !r.ok).length;
  const goldTrue = out.filter((r) => r.ok && r.rows[0]?.golden === true).length;
  const [{ bonus }] = await sql`select count(*)::int as bonus from attendance a
      join checkpoints c on c.id = a.checkpoint_id
      where a.event_id = ${f.eventId} and c.kind = 'bonus'`;
  const [{ base }] = await sql`select count(*)::int as base from attendance
      where event_id = ${f.eventId} and checkpoint_id = ${f.booth}`;
  record('T6', bonus === CAP && base === SCANS && goldTrue === CAP && errs === 0,
    `${SCANS} lượt quét PG trong đợt nắp ${CAP}: badge thưởng=${bonus} (hàm báo golden=${goldTrue}) · badge gốc=${base} · lỗi=${errs}`);
}

async function T7() {
  const f = await fixture({ students: 1 });
  await sql`update events set golden_issued = 300 where id = ${f.eventId}`;
  const [g] = await sql`select * from activate_golden_hour(${f.eventId}::smallint,
                          ${f.zoneId}::integer, 'T7', 40, 80)`;
  record('T7', g.result !== 'ok',
    `ngân sách ngày đã cạn (300/300) → mở đợt mới trả "${g.result}" (phải khác 'ok')`);
}

// ── T3 ──────────────────────────────────────────────────────────────────────
async function T3() {
  const SECONDS = Number(process.env.T3_SECONDS ?? 60);
  const THREADS = 40 * SCALE;
  const f = await fixture({ students: THREADS });
  const [tier] = await sql`
    insert into gift_tiers (event_id, tier, required_badges, gift_name, stock_total)
    values (${f.eventId}, 1, 1, 'Quà', 1000) returning id`;
  const until = Date.now() + SECONDS * 1000;
  const conns = Array.from({ length: THREADS }, () =>
    postgres(URL_, { max: 1, prepare: false, onnotice: () => {} }));
  let scans = 0, claims = 0, errs = 0;
  try {
    await Promise.all(conns.map((c) => c`select 1`));
    await Promise.all(conns.map(async (c, i) => {
      const student = f.ids[i];
      while (Date.now() < until) {
        try {
          if (i % 2 === 0) {
            await c`select record_scan(${randomUUID()}::uuid, ${f.eventId}::smallint,
                                       ${student}::bigint, ${f.booth}::integer)`;
            scans++;
          } else {
            await c`select claim_gift_tier(${f.eventId}::smallint, ${student}::bigint,
                                           ${tier.id}::integer, 'T3', 'T3', false)`;
            claims++;
          }
        } catch { errs++; }
      }
    }));
  } finally {
    await Promise.allSettled(conns.map((c) => c.end({ timeout: 5 })));
  }
  const drift = await sql`select * from v_progress_drift where event_id = ${f.eventId}`;
  record('T3', drift.length === 0,
    `${SECONDS}s · ${THREADS} luồng · ${scans} quét + ${claims} claim song song, lỗi=${errs} · dòng lệch=${drift.length}`);
}

// ── run ─────────────────────────────────────────────────────────────────────
const ALL = { T1, T2, T3, T4, T5, T6, T7 };

console.log('\nT1–T7 · tranh chấp đa kết nối (spec §4.2)\n');
await assertSandbox();
await initPersonSeq();

for (const [id, fn] of Object.entries(ALL)) {
  if (!want(id)) continue;
  const t0 = Date.now();
  try {
    await fn();
  } catch (err) {
    record(id, false, 'NGOẠI LỆ: ' + String(err.message ?? err).slice(0, 160));
  }
  console.log(`      (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} đạt`);
if (failed.length) console.log('KHÔNG ĐẠT: ' + failed.map((f) => f.id).join(', '));
await sql.end({ timeout: 5 });
process.exit(failed.length ? 1 : 0);
