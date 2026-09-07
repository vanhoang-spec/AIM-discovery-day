/**
 * Registration burst (rehearsal test #1) — the write path nobody had loaded.
 *
 * WHY
 * T1–T7 and write-load.mjs cover scans, holds and gifts. Registration is a
 * different function with different hazards — the campaign-wide email/phone
 * uniqueness, the lookup-code retry loop, the outbox insert — and it is the
 * FIRST thing to take real load: the moment AIM posts the link, and again at
 * the walk-in desk on the morning. /api/register does exactly one statement
 * against the database (`register_student`); everything else in that route
 * is validation and QR rendering on Vercel. So a function-level rehearsal on
 * the sandbox exercises the whole database side of a real registration.
 *
 * PHASES
 *   A  500 distinct people submit in the same second   → 500 created, 0 errors
 *   B  20 registrations/s for DURATION_S (default 300) → p95 < 600 ms, 0 errors
 *   C  200 submits of the SAME person in the same second (double-tap, retry
 *      storm) → exactly 1 student, 1 registration, 1 confirmation email
 *   C2 100 concurrent registrations of an existing person for a SECOND event
 *      → still 1 student, now 2 registrations ("linked")
 *   D  gate closed: 100 online → all 'closed', nothing written;
 *      100 walk-in → all created (the gate must not kill the desk)
 *
 * SANDBOX ONLY — same interlock as concurrency.mjs. Writes ~7.000 students.
 *
 * USAGE
 *   node --env-file=.env.local scripts/register-load.mjs
 *   DURATION_S=120 RPS=40 node --env-file=.env.local scripts/register-load.mjs
 */

import postgres from 'postgres';

const env = (k, d) => Number(process.env[k] ?? d);
const DURATION_S  = env('DURATION_S', 300);
const RPS         = env('RPS', 20);
const BURST       = env('BURST', 500);
const MAX_SOCKETS = env('MAX_SOCKETS', 150);
const P95_LIMIT   = env('P95_LIMIT_MS', 600);

const URL_ = process.env.DATABASE_URL;
if (!URL_) die('DATABASE_URL trống. Điền vào .env.local rồi chạy lại.');
if (URL_.includes('[')) die('DATABASE_URL còn [YOUR-PASSWORD] — thay bằng mật khẩu thật.');

const sql = postgres(URL_, { max: 4, prepare: false, onnotice: () => {} });
function die(msg) { console.error('\n✗ ' + msg + '\n'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms * (0.8 + 0.4 * Math.random());
const pct = (arr, q) => arr.length ? arr[Math.floor(q * (arr.length - 1))] : 0;
const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1; };

async function assertSandbox() {
  const [m] = await sql`select to_regclass('public.concurrency_sandbox') as t`;
  if (!m?.t) {
    die('ĐÂY KHÔNG PHẢI DATABASE SANDBOX — từ chối chạy.\n\n'
      + '  Nếu database đang trỏ tới ĐÚNG là bản nháp dùng xong xoá, chạy câu này\n'
      + '  trong SQL Editor của nó rồi thử lại:\n\n'
      + '      create table concurrency_sandbox (note text);\n');
  }
  const [{ n }] = await sql`select count(*)::int as n from students`;
  console.log(`  (sandbox hợp lệ · đang có ${n} sinh viên)\n`);
}

// ── fixture: two open events, and a person generator that never collides ────
async function fixture() {
  const tag = 'R' + Date.now().toString(36);
  const [ed] = await sql`
    insert into editions (year, name) values (2026, 'Sandbox')
    on conflict (year, name) do update set name = excluded.name returning id`;
  const [{ free }] = await sql`
    select greatest(coalesce(max(id), 0) + 1, 10)::int as free from events`;
  const ids = [free, free + 1];
  for (const [i, id] of ids.entries()) {
    await sql`
      insert into events (id, edition_id, kind, slug, name, venue_name, city,
                          starts_at, ends_at, token_key_id, is_registration_open,
                          special_threshold_y)
      values (${id}, ${ed.id}, 'discovery_day', ${tag + '-' + i}, ${'Sandbox ' + tag + '-' + i},
              'sandbox', 'sandbox', now(), now() + interval '8 hours', 'dd-2026', true, 1)`;
  }
  // Phones are unique campaign-wide; earlier sandbox runs used 09xxxxxxxx, this
  // script uses 08xxxxxxxx and starts above its own high-water mark.
  const [{ hi }] = await sql`
    select coalesce(max(substring(phone from 3)::bigint), 0)::bigint as hi
      from students where phone ~ '^08[0-9]{8}$'`;
  let seq = Number(hi) + 1;
  const person = () => {
    const s = seq++;
    return { name: 'Đăng Ký ' + s, email: `dk${s}@sandbox.invalid`,
             phone: '08' + String(s).padStart(8, '0'), code: tag + '-' + s };
  };
  return { tag, eventA: ids[0], eventB: ids[1], person };
}

// Exactly the statement /api/register runs (route.js), same casts, same order.
function register(c, ev, p, { source = 'online' } = {}) {
  return c`
    select * from register_student(
      ${ev}::smallint, ${p.name}, ${p.email}, ${p.phone}, null::smallint, 'Trường sandbox',
      ${p.code}, null, null::smallint, null, null, null::gender,
      'general'::registration_type, ${source}::registration_source,
      true, false, '203.0.113.7'::inet, 'v1-2026-08', ${p.name.toLowerCase()})`;
}

/** N attempts with as much real simultaneity as the pooler allows. */
async function stampede(n, fn) {
  const sockets = Math.min(n, MAX_SOCKETS);
  const conns = Array.from({ length: sockets }, () =>
    postgres(URL_, { max: 1, prepare: false, onnotice: () => {} }));
  const out = new Array(n);
  try {
    await Promise.all(conns.map((c) => c`select 1`));
    const buckets = Array.from({ length: sockets }, () => []);
    for (let i = 0; i < n; i++) buckets[i % sockets].push(i);
    const t0 = performance.now();
    await Promise.all(conns.map(async (c, s) => {
      for (const i of buckets[s]) {
        const a = performance.now();
        try { out[i] = { ok: true, rows: await fn(c, i), ms: performance.now() - a }; }
        catch (e) { out[i] = { ok: false, err: String(e?.message ?? e), ms: performance.now() - a }; }
      }
    }));
    out.wall = performance.now() - t0;
    return out;
  } finally {
    await Promise.allSettled(conns.map((c) => c.end({ timeout: 5 })));
  }
}

function describe(out) {
  const st = {}, errs = {};
  out.forEach((o) => o.ok ? bump(st, o.rows[0]?.status ?? '?') : bump(errs, o.err.replace(/\s+/g, ' ').slice(0, 90)));
  const lat = out.map((o) => o.ms).sort((a, b) => a - b);
  return { st, errs, nErr: Object.values(errs).reduce((a, b) => a + b, 0),
           p50: pct(lat, .5), p95: pct(lat, .95), max: lat.at(-1) ?? 0 };
}
const results = [];
function record(id, ok, detail) {
  results.push({ id, ok });
  console.log(`${ok ? '  ✔' : '  ✗'} ${id}  ${detail}`);
}
const ms = (v) => Math.round(v) + 'ms';

// ── run ─────────────────────────────────────────────────────────────────────
console.log(`\nĐăng ký dồn (test #1) · A=${BURST} cùng lúc · B=${RPS}/s × ${DURATION_S}s · C=200 cùng người · D=cổng đóng\n`);
await assertSandbox();
const f = await fixture();
console.log(`  fixture ${f.tag}: sự kiện ${f.eventA} và ${f.eventB}\n`);

// A — distinct people, same second
{
  const people = Array.from({ length: BURST }, () => f.person());
  const out = await stampede(BURST, (c, i) => register(c, f.eventA, people[i]));
  const d = describe(out);
  const [{ n }] = await sql`select count(*)::int as n from students where student_code like ${f.tag + '-%'}`;
  const [{ codes }] = await sql`select count(distinct lookup_code)::int as codes from students where student_code like ${f.tag + '-%'}`;
  const [{ reg }] = await sql`select count(*)::int as reg from registrations where event_id = ${f.eventA}`;
  const [{ mail }] = await sql`select count(*)::int as mail from notification_outbox where event_id = ${f.eventA} and channel = 'email'`;
  const ok = d.st.created === BURST && d.nErr === 0 && n === BURST && codes === BURST && reg === BURST && mail === BURST;
  record('A', ok, `${BURST} người cùng lúc: created=${d.st.created ?? 0} lỗi=${d.nErr} · SV=${n} mã riêng=${codes} đăng ký=${reg} email xếp hàng=${mail}`
    + ` · p50=${ms(d.p50)} p95=${ms(d.p95)} max=${ms(d.max)} · cả đợt ${ms(out.wall)}`
    + (d.nErr ? ` · ví dụ lỗi: ${Object.keys(d.errs)[0]}` : ''));
}

// B — steady RPS for DURATION_S through RPS*2 sockets (each fires every 2 s)
{
  const WORKERS = RPS * 2, every = 1000 * WORKERS / RPS;
  const conns = Array.from({ length: WORKERS }, () => postgres(URL_, { max: 1, prepare: false, onnotice: () => {} }));
  const lat = [], st = {}, errs = {};
  const until = Date.now() + DURATION_S * 1000;
  let stop = false;
  const minute = setInterval(() => {
    const s = [...lat].sort((a, b) => a - b);
    console.log(`     B ${Math.round((DURATION_S * 1000 - (until - Date.now())) / 1000)}s: n=${lat.length} p50=${ms(pct(s, .5))} p95=${ms(pct(s, .95))} max=${ms(s.at(-1) ?? 0)} lỗi=${Object.values(errs).reduce((a, b) => a + b, 0)}`);
  }, 60_000);
  try {
    await Promise.all(conns.map((c) => c`select 1`));
    await Promise.all(conns.map(async (c) => {
      await sleep(Math.random() * every);
      while (!stop && Date.now() < until) {
        const tick = Date.now(), a = performance.now();
        try { const r = await register(c, f.eventA, f.person()); lat.push(performance.now() - a); bump(st, r[0]?.status ?? '?'); }
        catch (e) { lat.push(performance.now() - a); bump(errs, String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 90)); }
        await sleep(Math.max(0, jitter(every) - (Date.now() - tick)));
      }
    }));
  } finally {
    stop = true; clearInterval(minute);
    await Promise.allSettled(conns.map((c) => c.end({ timeout: 5 })));
  }
  const s = [...lat].sort((a, b) => a - b);
  const nErr = Object.values(errs).reduce((a, b) => a + b, 0);
  const p95 = pct(s, .95);
  const ok = nErr === 0 && p95 < P95_LIMIT && (st.created ?? 0) === lat.length;
  record('B', ok, `${RPS}/s × ${DURATION_S}s: n=${lat.length} (${(lat.length / DURATION_S).toFixed(1)}/s thật) created=${st.created ?? 0} lỗi=${nErr}`
    + ` · p50=${ms(pct(s, .5))} p95=${ms(p95)} p99=${ms(pct(s, .99))} max=${ms(s.at(-1) ?? 0)}`
    + (nErr ? ` · ví dụ lỗi: ${Object.keys(errs)[0]}` : ''));
}

// C — the same person, 200 times, same second
{
  const p = f.person();
  const out = await stampede(200, (c) => register(c, f.eventA, p));
  const d = describe(out);
  const [{ n }] = await sql`select count(*)::int as n from students where email = ${p.email} or phone = ${p.phone}`;
  const [{ reg }] = await sql`select count(*)::int as reg from registrations r join students s on s.id = r.student_id where s.email = ${p.email}`;
  const [{ mail }] = await sql`select count(*)::int as mail from notification_outbox o join students s on s.id = o.student_id where s.email = ${p.email} and o.channel = 'email'`;
  const ok = d.nErr === 0 && (d.st.created ?? 0) === 1 && n === 1 && reg === 1 && mail === 1;
  record('C', ok, `200 lượt cùng một người: trạng thái=${JSON.stringify(d.st)} lỗi=${d.nErr} · SV=${n} đăng ký=${reg} email=${mail}`
    + (d.nErr ? ` · ví dụ lỗi: ${Object.keys(d.errs)[0]}` : ''));
}

// C2 — an existing person registers for the second event, 100 times at once
{
  const p = f.person();
  await register(sql, f.eventA, p);
  const out = await stampede(100, (c) => register(c, f.eventB, p));
  const d = describe(out);
  const [{ n }] = await sql`select count(*)::int as n from students where email = ${p.email}`;
  const [{ reg }] = await sql`select count(*)::int as reg from registrations r join students s on s.id = r.student_id where s.email = ${p.email}`;
  const ok = d.nErr === 0 && n === 1 && reg === 2 && !d.st.created;
  record('C2', ok, `người cũ đăng ký sự kiện thứ hai ×100 cùng lúc: trạng thái=${JSON.stringify(d.st)} lỗi=${d.nErr} · SV=${n} đăng ký=${reg} (phải 1 và 2)`);
}

// D — gate closed: online refused cleanly, walk-in still works
{
  await sql`update events set is_registration_open = false where id = ${f.eventA}`;
  const before = (await sql`select count(*)::int as n from students`)[0].n;
  const on = describe(await stampede(100, (c) => register(c, f.eventA, f.person())));
  const after = (await sql`select count(*)::int as n from students`)[0].n;
  const wi = describe(await stampede(100, (c) => register(c, f.eventA, f.person(), { source: 'walk_in' })));
  const ok = on.nErr === 0 && on.st.closed === 100 && after === before && wi.nErr === 0 && wi.st.created === 100;
  record('D', ok, `cổng đóng: online ×100 → ${JSON.stringify(on.st)} (SV không tăng: ${after === before}) · walk-in ×100 → ${JSON.stringify(wi.st)} lỗi=${on.nErr + wi.nErr}`);
  await sql`update events set is_registration_open = true where id = ${f.eventA}`;
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} đạt\n`);
await sql.end({ timeout: 5 });
process.exit(passed === results.length ? 0 : 1);
