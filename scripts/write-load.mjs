/**
 * Write-load rehearsal (spec §4.3) — the event-day WRITE mix, at real pace.
 *
 * WHY THIS EXISTS NEXT TO concurrency.mjs
 * T1–T7 prove the locks hold when everyone hits the same row at once. They
 * say nothing about the ordinary morning: two venues, doors open at 08:00,
 * every gate lane scanning a student every ~3.5 s, eighty booth PGs scanning
 * whenever a student walks up, a few gift desks redeeming. That mix is what
 * production will actually see, and the questions it answers are different:
 * what is p95 per operation under the real write rate, does anything error,
 * does the ledger drift, and how many pooler clients does it take.
 *
 * Every simulated device holds ONE connection for the whole run — the same
 * shape as a warm Vercel instance with `max: 1` — so the client count the
 * pooler sees is the device count by construction, and is printed.
 *
 * WHY IT REFUSES TO RUN WITHOUT A SANDBOX MARKER
 * Same reason as concurrency.mjs: `ledger_events` is append-only and this
 * script writes ~3.000 rows in five minutes. Sandbox project only.
 *
 * USAGE
 *   node --env-file=.env.local scripts/write-load.mjs
 *   DURATION_S=120 LANES=8 node --env-file=.env.local scripts/write-load.mjs
 *
 * Defaults model BOTH venues at gate peak (§4.3: 17 người/phút/lane):
 *   LANES=16 LANE_PER_MIN=17   → 4,5 quét cổng/s
 *   BOOTH_PGS=80 BOOTH_EVERY_S=15 → 5,3 quét booth/s
 *   GIFT_DESKS=4 GIFT_EVERY_S=8  → 0,5 đổi quà/s
 *   DURATION_S=300
 */

import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

const env = (k, d) => Number(process.env[k] ?? d);
const DURATION_S    = env('DURATION_S', 300);
const LANES         = env('LANES', 16);
const LANE_PER_MIN  = env('LANE_PER_MIN', 17);
const BOOTH_PGS     = env('BOOTH_PGS', 80);
const BOOTH_EVERY_S = env('BOOTH_EVERY_S', 15);
const BOOTHS        = env('BOOTHS', 10);
const GIFT_DESKS    = env('GIFT_DESKS', 4);
const GIFT_EVERY_S  = env('GIFT_EVERY_S', 8);
const P95_LIMIT_MS  = env('P95_LIMIT_MS', 600);

const URL_ = process.env.DATABASE_URL;
if (!URL_) die('DATABASE_URL trống. Điền vào .env.local rồi chạy lại.');
if (URL_.includes('[')) die('DATABASE_URL còn [YOUR-PASSWORD] — thay bằng mật khẩu thật.');
if (DURATION_S > 900) die('DURATION_S tối đa 900 — dài hơn không đo thêm được gì, chỉ tốn dòng ledger.');

const sql = postgres(URL_, { max: 4, prepare: false, onnotice: () => {} });

function die(msg) { console.error('\n✗ ' + msg + '\n'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms * (0.8 + 0.4 * Math.random());

// ── safety interlock (identical to concurrency.mjs) ─────────────────────────
async function assertSandbox() {
  const [m] = await sql`select to_regclass('public.concurrency_sandbox') as t`;
  if (!m?.t) {
    die(
      'ĐÂY KHÔNG PHẢI DATABASE SANDBOX — từ chối chạy.\n\n'
      + '  ledger_events là append-only: mọi lượt quét test sẽ nằm lại VĨNH VIỄN.\n'
      + '  Nếu database đang trỏ tới ĐÚNG là bản nháp dùng xong xoá, chạy câu này\n'
      + '  trong SQL Editor của nó rồi thử lại:\n\n'
      + '      create table concurrency_sandbox (note text);\n',
    );
  }
  const [{ n }] = await sql`select count(*)::int as n from ledger_events`;
  console.log(`  (sandbox hợp lệ · ledger đang có ${n} dòng)\n`);
}

// ── fixture: one event, 1 entrance + BOOTHS booths, N students, devices ─────
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let codeSeq = Math.floor(Math.random() * 900_000_000);
function lookupCode() {
  let n = codeSeq++, out = '';
  for (let i = 0; i < 6; i++) { out = CROCKFORD[n % 32] + out; n = Math.floor(n / 32); }
  return out;
}

async function fixture(students) {
  const tag = 'W' + Date.now().toString(36);
  const [ed] = await sql`
    insert into editions (year, name) values (2026, 'Sandbox')
    on conflict (year, name) do update set name = excluded.name returning id`;
  const [{ free }] = await sql`
    select greatest(coalesce(max(id), 0) + 1, 10)::int as free from events`;
  const eventId = free;
  await sql`
    insert into events (id, edition_id, kind, slug, name, venue_name, city,
                        starts_at, ends_at, token_key_id, is_registration_open,
                        special_threshold_y)
    values (${eventId}, ${ed.id}, 'discovery_day', ${tag}, ${'Sandbox ' + tag},
            'sandbox', 'sandbox', now(), now() + interval '8 hours', 'dd-2026', true, 1)`;
  const [zone] = await sql`
    insert into zones (event_id, name, display_order) values (${eventId}, 'Z', 0) returning id`;
  const [entrance] = await sql`
    insert into checkpoints (event_id, zone_id, kind, name, counts_toward_badges, display_order)
    values (${eventId}, ${zone.id}, 'entrance', 'Cổng', true, 0) returning id`;
  const booths = await sql`
    insert into checkpoints (event_id, zone_id, kind, name, counts_toward_badges, display_order)
    select ${eventId}, ${zone.id}, 'sponsor_booth', 'Booth ' || g, true, g
      from generate_series(1, ${BOOTHS}) g returning id`;
  const [tier] = await sql`
    insert into gift_tiers (event_id, tier, required_badges, gift_name, stock_total)
    values (${eventId}, 1, 1, 'Quà', 100000) returning id`;

  // Students in ONE statement. Phone/email are unique campaign-wide, so start
  // above whatever earlier sandbox runs (T1–T7 included) left behind.
  const [{ hi }] = await sql`
    select coalesce(max(nullif(substring(phone from 3), '')::bigint), 0)::bigint as hi
      from students where phone ~ '^09[0-9]{8}$'`;
  let seq = Number(hi) + 1;
  const rows = Array.from({ length: students }, (_, i) => {
    const s = seq++;
    return { lookup_code: lookupCode(), full_name: 'SV ' + s, name_search_key: 'sv ' + s,
             email: `sv${s}@sandbox.invalid`, phone: '09' + String(s).padStart(8, '0'),
             student_code: tag + '-' + i };
  });
  const inserted = await sql`
    insert into students (seq, lookup_code, full_name, name_search_key, email, phone,
                          student_code, consent_event_at)
    select nextval('student_seq_counter'), r.lookup_code, r.full_name, r.name_search_key,
           r.email, r.phone, r.student_code, now()
      from jsonb_to_recordset(${sql.json(rows)})
        as r(lookup_code text, full_name text, name_search_key text, email text,
             phone text, student_code text)
    returning id, seq`;
  await sql`
    insert into registrations (student_id, event_id)
    select id, ${eventId} from students where id = any(${inserted.map((r) => r.id)}::bigint[])`;

  // One device per simulated scanner: gate lanes, booth PGs, gift desks.
  const nDev = LANES + BOOTH_PGS + GIFT_DESKS;
  const staff = await sql`
    insert into pg_staff (event_id, full_name, role)
    select ${eventId}, 'PG ' || g, 'pg' from generate_series(1, ${nDev}) g returning id`;
  const devRows = staff.map((s, i) => ({
    pg_staff_id: Number(s.id), claim_code: lookupCode(), label: 'DEV-' + (i + 1),
    token_hash: `tok-${tag}-${i}-${Math.random().toString(36).slice(2)}`,
  }));
  await sql`
    insert into pg_devices (event_id, claim_code, pg_staff_id, zone_id, label, token_hash, claimed_at)
    select ${eventId}, r.claim_code, r.pg_staff_id, ${zone.id}, r.label, r.token_hash, now()
      from jsonb_to_recordset(${sql.json(devRows)})
        as r(pg_staff_id bigint, claim_code text, label text, token_hash text)`;

  return {
    tag, eventId, entrance: entrance.id, booths: booths.map((b) => b.id), tierId: tier.id,
    students: inserted.map((r) => ({ id: Number(r.id), seq: Number(r.seq) })),
    tokens: devRows.map((d) => d.token_hash),
  };
}

// ── measurement ─────────────────────────────────────────────────────────────
const lat = { gate: [], booth: [], gift: [] };
const status = { gate: {}, booth: {}, gift: {} };
const errors = { gate: {}, booth: {}, gift: {} };
const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1; };
const pct = (arr, q) => arr.length ? arr[Math.floor(q * (arr.length - 1))] : 0;

async function timed(kind, fn) {
  const t0 = performance.now();
  try {
    const rows = await fn();
    lat[kind].push(performance.now() - t0);
    const st = rows?.[0]?.status ?? rows?.[0]?.result ?? 'ok';
    bump(status[kind], st);
  } catch (e) {
    lat[kind].push(performance.now() - t0);
    bump(errors[kind], String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 90));
  }
}

function summary(kind) {
  const a = [...lat[kind]].sort((x, y) => x - y);
  const errs = Object.values(errors[kind]).reduce((s, n) => s + n, 0);
  return `${kind.padEnd(5)} n=${String(a.length).padStart(5)} lỗi=${String(errs).padStart(3)}`
    + ` p50=${Math.round(pct(a, 0.5)).toString().padStart(5)}ms`
    + ` p95=${Math.round(pct(a, 0.95)).toString().padStart(5)}ms`
    + ` p99=${Math.round(pct(a, 0.99)).toString().padStart(5)}ms`
    + ` max=${Math.round(a.at(-1) ?? 0).toString().padStart(5)}ms`
    + `  ${JSON.stringify(status[kind])}`;
}

// ── run ─────────────────────────────────────────────────────────────────────
console.log(`\nTải ghi ngày sự kiện (spec §4.3) · ${DURATION_S}s`
  + ` · ${LANES} lane × ${LANE_PER_MIN}/phút · ${BOOTH_PGS} PG booth mỗi ${BOOTH_EVERY_S}s`
  + ` · ${GIFT_DESKS} bàn quà mỗi ${GIFT_EVERY_S}s\n`);
await assertSandbox();

const needStudents = Math.ceil(LANES * LANE_PER_MIN * DURATION_S / 60) + LANES;
const t0 = Date.now();
const f = await fixture(needStudents);
console.log(`  fixture ${f.tag}: sự kiện ${f.eventId}, ${f.students.length} SV, `
  + `${f.tokens.length} thiết bị, ${f.booths.length} booth — ${Date.now() - t0}ms\n`);

const nDev = f.tokens.length;
const conns = f.tokens.map(() => postgres(URL_, { max: 1, prepare: false, onnotice: () => {} }));
let nextStudent = 0;
const entered = [];        // students already through the gate — booths/gifts pick from here
const until = Date.now() + DURATION_S * 1000;
let stop = false;

const gateLane = async (c, tok) => {
  const every = 60_000 / LANE_PER_MIN;
  while (!stop && Date.now() < until && nextStudent < f.students.length) {
    const s = f.students[nextStudent++];
    const tick = Date.now();
    await timed('gate', () => c`
      select * from record_pg_scan(${tok}, ${randomUUID()}::uuid, ${s.seq}::integer,
                                   ${f.entrance}::integer, now())`);
    entered.push(s);
    await sleep(Math.max(0, jitter(every) - (Date.now() - tick)));
  }
};
const boothPg = async (c, tok, i) => {
  const cp = f.booths[i % f.booths.length];
  await sleep(Math.random() * BOOTH_EVERY_S * 1000);   // PGs are not synchronised
  while (!stop && Date.now() < until) {
    const tick = Date.now();
    if (entered.length) {
      const s = entered[Math.floor(Math.random() * entered.length)];
      await timed('booth', () => c`
        select * from record_pg_scan(${tok}, ${randomUUID()}::uuid, ${s.seq}::integer,
                                     ${cp}::integer, now())`);
    }
    await sleep(Math.max(0, jitter(BOOTH_EVERY_S * 1000) - (Date.now() - tick)));
  }
};
const giftDesk = async (c, tok, i) => {
  await sleep(Math.random() * GIFT_EVERY_S * 1000);
  while (!stop && Date.now() < until) {
    const tick = Date.now();
    if (entered.length) {
      const s = entered[Math.floor(Math.random() * entered.length)];
      await timed('gift', () => c`
        select * from claim_gift_tier(${f.eventId}::smallint, ${s.id}::bigint,
                                      ${f.tierId}::integer, ${'desk-' + i}, ${tok}, false)`);
    }
    await sleep(Math.max(0, jitter(GIFT_EVERY_S * 1000) - (Date.now() - tick)));
  }
};

// Pooler-side view, sampled while the load runs. pg_stat_activity shows the
// BACKENDS Supavisor opened to Postgres, not client sockets — our own socket
// count (nDev + 4) is the client number; both are printed.
let peakBackends = 0;
async function monitor() {
  while (!stop) {
    await sleep(15_000);
    if (stop) break;
    let be = 'n/a';
    try {
      const [r] = await sql`
        select count(*)::int as total,
               count(*) filter (where state = 'active')::int as active
          from pg_stat_activity
         where backend_type = 'client backend' and datname = current_database()`;
      be = `${r.active} active / ${r.total} backend`;
      peakBackends = Math.max(peakBackends, r.total);
    } catch { /* role may lack pg_read_all_stats — fine */ }
    const el = Math.round((Date.now() - (until - DURATION_S * 1000)) / 1000);
    console.log(`  ${String(el).padStart(3)}s  cổng=${lat.gate.length} booth=${lat.booth.length}`
      + ` quà=${lat.gift.length} · client=${live.length + 4} · DB: ${be}`);
  }
}

const refused = {};
let live = [];
try {
  // Warm every socket first. Past the pooler's client cap (200 on Micro)
  // Supavisor answers with a hard error, not a queue — count those instead
  // of crashing, so a run that crosses the cap reports it as a finding.
  const warm = await Promise.allSettled(conns.map((c) => c`select 1`));
  warm.forEach((w) => {
    if (w.status === 'rejected') bump(refused, String(w.reason?.message ?? w.reason).replace(/\s+/g, ' ').slice(0, 80));
  });
  live = conns.map((_, i) => i).filter((i) => warm[i].status === 'fulfilled');
  console.log(`  ${live.length}/${nDev} kết nối mở được (+4 điều khiển = ${live.length + 4} client trên pooler)`);
  for (const [m, n] of Object.entries(refused)) console.log(`  ✗ pooler từ chối ${n} kết nối: ${m}`);
  console.log('');
  const workers = [];
  for (const i of live) {
    const c = conns[i], tok = f.tokens[i];
    if (i < LANES) workers.push(gateLane(c, tok));
    else if (i < LANES + BOOTH_PGS) workers.push(boothPg(c, tok, i - LANES));
    else workers.push(giftDesk(c, tok, i - LANES - BOOTH_PGS));
  }
  const mon = monitor();
  await Promise.all(workers);
  stop = true;
  await mon;
} finally {
  stop = true;
  await Promise.allSettled(conns.map((c) => c.end({ timeout: 5 })));
}

// ── verdict ─────────────────────────────────────────────────────────────────
const drift = await sql`select * from v_progress_drift where event_id = ${f.eventId}`;
const [{ ledger }] = await sql`
  select count(*)::int as ledger from ledger_events where event_id = ${f.eventId}`;
const total = lat.gate.length + lat.booth.length + lat.gift.length;
const errs = ['gate', 'booth', 'gift']
  .reduce((s, k) => s + Object.values(errors[k]).reduce((a, n) => a + n, 0), 0);

console.log(`\nKẾT QUẢ (${DURATION_S}s · ${total} thao tác · ${(total / DURATION_S).toFixed(1)} ghi/s)`);
for (const k of ['gate', 'booth', 'gift']) console.log('  ' + summary(k));
for (const k of ['gate', 'booth', 'gift']) {
  for (const [m, n] of Object.entries(errors[k])) console.log(`  ✗ ${k}: ${n}× ${m}`);
}
const refusedN = Object.values(refused).reduce((s, n) => s + n, 0);
console.log(`  ledger +${ledger} dòng · lệch=${drift.length} · client trên pooler=${live.length + 4}`
  + ` · bị pooler từ chối=${refusedN} · backend đỉnh=${peakBackends || 'n/a'}`);

const p95s = ['gate', 'booth', 'gift'].map((k) => pct([...lat[k]].sort((a, b) => a - b), 0.95));
const pass = errs === 0 && refusedN === 0 && drift.length === 0 && p95s.every((p) => p < P95_LIMIT_MS);
console.log(`\n${pass ? '✔ ĐẠT' : '✗ KHÔNG ĐẠT'} — tiêu chí: lỗi=0, không kết nối nào bị từ chối, lệch=0, p95 < ${P95_LIMIT_MS}ms mọi loại\n`);
await sql.end({ timeout: 5 });
process.exit(pass ? 0 : 1);
