/**
 * Test #3 — đứt rồi nối (failover drill). Sandbox only.
 *
 * WHY
 * Every load test so far ran on a healthy network. The 06/09 incident was
 * not a load problem — it was a STUCK-STATE problem: a connection that
 * stopped answering and a function that waited five minutes for it. The fix
 * (serializeQueries + QUERY_TIMEOUT_MS + cancel) is right on paper and in
 * fakes; this drill is the first time it meets a real broken connection.
 *
 * Two different breaks, because they expose two different bugs:
 *
 *   A  SERVER CUTS EVERY CONNECTION mid-load (pg_terminate_backend on all
 *      backends). What a Supabase restart, failover or pooler reset looks
 *      like. The socket errors loudly; the question is whether the next
 *      statement reconnects on its own, and how fast.
 *
 *   B  THE NETWORK GOES SILENT for 30 s. A local TCP proxy sits between the
 *      client and the pooler and simply stops forwarding bytes — sockets stay
 *      open, nothing errors, nothing answers. This is the shape of the 06/09
 *      hang. Without the timeout every statement would wait until Vercel
 *      kills the function at 300 s. With it, each must fail at ~10 s and the
 *      instance must be healthy again the moment bytes flow.
 *
 * The client under test is composed EXACTLY like @atl/db's createPostgres —
 * postgres(url, POSTGRES_OPTIONS) wrapped in serializeQueries(…, QUERY_TIMEOUT_MS)
 * — so what is measured is the production connection layer, not raw postgres.js.
 * Eight such "instances" run paced booth scans through record_pg_scan, the
 * same statement /api/pg/sync issues.
 *
 * USAGE
 *   node --env-file=.env.local scripts/failover-drill.mjs        # A then B
 *   node --env-file=.env.local scripts/failover-drill.mjs B      # one scenario
 */

import postgres from 'postgres';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { serializeQueries, POSTGRES_OPTIONS, QUERY_TIMEOUT_MS } from '@atl/db';

const WANTED = process.argv.slice(2).map((s) => s.toUpperCase());
const want = (id) => WANTED.length === 0 || WANTED.includes(id);
const INSTANCES = Number(process.env.INSTANCES ?? 8);
const OP_EVERY_MS = Number(process.env.OP_EVERY_MS ?? 500);   // per instance → 16 ops/s total
const FREEZE_S = Number(process.env.FREEZE_S ?? 30);
const PROXY_PORT = Number(process.env.PROXY_PORT ?? 6544);

const URL_ = process.env.DATABASE_URL;
if (!URL_) die('DATABASE_URL trống. Điền vào .env.local rồi chạy lại.');
if (URL_.includes('[')) die('DATABASE_URL còn [YOUR-PASSWORD] — thay bằng mật khẩu thật.');

const control = postgres(URL_, { max: 2, prepare: false, onnotice: () => {} });
function die(msg) { console.error('\n✗ ' + msg + '\n'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1; };
const fmt = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms');

async function assertSandbox() {
  const [m] = await control`select to_regclass('public.concurrency_sandbox') as t`;
  if (!m?.t) {
    die('ĐÂY KHÔNG PHẢI DATABASE SANDBOX — từ chối chạy.\n\n'
      + '  Bài này GIẾT mọi kết nối tới database. Chỉ chạy trên bản nháp dùng xong xoá.\n'
      + '  Nếu đúng là bản nháp, chạy trong SQL Editor của nó rồi thử lại:\n\n'
      + '      create table concurrency_sandbox (note text);\n');
  }
  const [{ n }] = await control`select count(*)::int as n from ledger_events`;
  console.log(`  (sandbox hợp lệ · ledger đang có ${n} dòng)\n`);
}

// ── fixture: one event, 4 booths, 400 students, INSTANCES devices ───────────
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let codeSeq = Math.floor(Math.random() * 900_000_000);
function lookupCode() {
  let n = codeSeq++, out = '';
  for (let i = 0; i < 6; i++) { out = CROCKFORD[n % 32] + out; n = Math.floor(n / 32); }
  return out;
}
async function fixture(tag) {
  const [ed] = await control`
    insert into editions (year, name) values (2026, 'Sandbox')
    on conflict (year, name) do update set name = excluded.name returning id`;
  const [{ free }] = await control`select greatest(coalesce(max(id), 0) + 1, 10)::int as free from events`;
  const eventId = free;
  await control`
    insert into events (id, edition_id, kind, slug, name, venue_name, city, starts_at, ends_at,
                        token_key_id, is_registration_open, special_threshold_y)
    values (${eventId}, ${ed.id}, 'discovery_day', ${tag}, ${'Sandbox ' + tag}, 'sandbox', 'sandbox',
            now(), now() + interval '8 hours', 'dd-2026', true, 1)`;
  const [zone] = await control`insert into zones (event_id, name, display_order) values (${eventId}, 'Z', 0) returning id`;
  const booths = await control`
    insert into checkpoints (event_id, zone_id, kind, name, counts_toward_badges, display_order)
    select ${eventId}, ${zone.id}, 'sponsor_booth', 'Booth ' || g, true, g from generate_series(1, 4) g returning id`;
  const [{ hi }] = await control`
    select coalesce(max(substring(phone from 3)::bigint), 0)::bigint as hi from students where phone ~ '^07[0-9]{8}$'`;
  let seq = Number(hi) + 1;
  const rows = Array.from({ length: 400 }, (_, i) => {
    const s = seq++;
    return { lookup_code: lookupCode(), full_name: 'SV ' + s, name_search_key: 'sv ' + s,
             email: `fo${s}@sandbox.invalid`, phone: '07' + String(s).padStart(8, '0'), student_code: tag + '-' + i };
  });
  const students = await control`
    insert into students (seq, lookup_code, full_name, name_search_key, email, phone, student_code, consent_event_at)
    select nextval('student_seq_counter'), r.lookup_code, r.full_name, r.name_search_key, r.email, r.phone, r.student_code, now()
      from jsonb_to_recordset(${control.json(rows)})
        as r(lookup_code text, full_name text, name_search_key text, email text, phone text, student_code text)
    returning id, seq`;
  await control`insert into registrations (student_id, event_id)
                select id, ${eventId} from students where id = any(${students.map((s) => s.id)}::bigint[])`;
  const staff = await control`
    insert into pg_staff (event_id, full_name, role) select ${eventId}, 'PG ' || g, 'pg'
      from generate_series(1, ${INSTANCES}) g returning id`;
  const devs = staff.map((s, i) => ({ pg_staff_id: Number(s.id), claim_code: lookupCode(), label: 'FO-' + (i + 1),
                                       token_hash: `tok-${tag}-${i}-${Math.random().toString(36).slice(2)}` }));
  await control`
    insert into pg_devices (event_id, claim_code, pg_staff_id, zone_id, label, token_hash, claimed_at)
    select ${eventId}, r.claim_code, r.pg_staff_id, ${zone.id}, r.label, r.token_hash, now()
      from jsonb_to_recordset(${control.json(devs)}) as r(pg_staff_id bigint, claim_code text, label text, token_hash text)`;
  return { eventId, booths: booths.map((b) => b.id), seqs: students.map((s) => Number(s.seq)), tokens: devs.map((d) => d.token_hash) };
}

// ── the production connection layer, one "instance" ─────────────────────────
function instance(url) {
  const sql = postgres(url, POSTGRES_OPTIONS);
  const query = serializeQueries((text, params) => sql.unsafe(text, params), QUERY_TIMEOUT_MS);
  return { query, end: () => sql.end({ timeout: 5 }).catch(() => {}) };
}

// ── silent-network proxy (scenario B) ───────────────────────────────────────
function startProxy(upstreamHost, upstreamPort, port) {
  const state = { frozen: false, pairs: new Set(), pending: [], seen: 0 };
  const server = net.createServer((client) => {
    const attach = () => {
      state.seen++;
      const up = net.connect(upstreamPort, upstreamHost);
      const pair = { client, up };
      state.pairs.add(pair);
      client.pipe(up); up.pipe(client);
      if (state.frozen) { client.pause(); up.pause(); }
      const drop = () => { state.pairs.delete(pair); client.destroy(); up.destroy(); };
      client.on('error', drop); up.on('error', drop); client.on('close', drop); up.on('close', drop);
    };
    // A connection that arrives during the freeze meets silence too — the
    // handshake never answers, which is what connect_timeout is for.
    if (state.frozen) state.pending.push(attach); else attach();
  });
  server.listen(port, '127.0.0.1');
  return {
    freeze() { state.frozen = true; for (const p of state.pairs) { p.client.pause(); p.up.pause(); } },
    thaw() { state.frozen = false; for (const p of state.pairs) { p.client.resume(); p.up.resume(); } for (const a of state.pending.splice(0)) a(); },
    close() { for (const p of state.pairs) { p.client.destroy(); p.up.destroy(); } server.close(); },
    seen: () => state.seen,
  };
}

// ── one scenario: paced load + an injected fault, everything timestamped ────
async function runScenario({ id, title, url, durationS, fault }) {
  const f = await fixture('F' + id + Date.now().toString(36));
  const insts = Array.from({ length: INSTANCES }, () => instance(url));
  const ops = [];               // { t, ms, ok, inst, cls }
  const t0 = Date.now();
  const rel = () => (Date.now() - t0) / 1000;
  let stop = false;
  const marks = [];
  const mark = (s) => { marks.push([rel(), s]); console.log(`  ${rel().toFixed(1).padStart(5)}s  ── ${s}`); };

  console.log(`\n${id} · ${title}`);
  const workers = insts.map(async (inst, i) => {
    await sleep((i * OP_EVERY_MS) / INSTANCES);
    while (!stop) {
      const tick = Date.now();
      const seq = f.seqs[Math.floor(Math.random() * f.seqs.length)];
      const cp = f.booths[i % f.booths.length];
      const a = performance.now();
      try {
        const r = await inst.query(
          `select * from record_pg_scan($1, $2::uuid, $3::integer, $4::integer, now())`,
          [f.tokens[i], randomUUID(), seq, cp]);
        ops.push({ t: rel(), ms: performance.now() - a, ok: true, inst: i, cls: r.rows[0]?.status ?? '?' });
      } catch (e) {
        const m = String(e?.message ?? e);
        const cls = /quá \d+ms, đã huỷ/.test(m) ? 'TIMEOUT_10S'
                  : /CONNECTION_CLOSED|CONNECTION_ENDED|ECONNRESET|terminat|EPIPE/i.test(m) ? 'CONNECTION_CLOSED'
                  : /CONNECT_TIMEOUT/i.test(m) ? 'CONNECT_TIMEOUT'
                  : /canceling statement/i.test(m) ? 'CANCELLED'
                  : 'OTHER: ' + m.replace(/\s+/g, ' ').slice(0, 70);
        ops.push({ t: rel(), ms: performance.now() - a, ok: false, inst: i, cls });
      }
      await sleep(Math.max(0, OP_EVERY_MS - (Date.now() - tick)));
    }
  });

  // Timeline every 5 s: ok / err in that window, slowest op in that window.
  let last = 0;
  const timeline = setInterval(() => {
    const now = rel();
    const w = ops.filter((o) => o.t > last && o.t <= now);
    const ok = w.filter((o) => o.ok).length, err = w.length - ok;
    const slow = w.length ? Math.max(...w.map((o) => o.ms)) : 0;
    const cls = {}; w.filter((o) => !o.ok).forEach((o) => bump(cls, o.cls));
    console.log(`  ${now.toFixed(0).padStart(5)}s  ok=${String(ok).padStart(3)} lỗi=${String(err).padStart(3)} chậm nhất=${fmt(slow).padStart(6)}${err ? '  ' + JSON.stringify(cls) : ''}`);
    last = now;
  }, 5000);

  const faultAt = 20;
  await sleep(faultAt * 1000);
  await fault(mark);
  await sleep((durationS - faultAt) * 1000);
  stop = true;
  clearInterval(timeline);
  await Promise.allSettled(workers);
  await Promise.allSettled(insts.map((x) => x.end()));

  // ── verdict ──
  const faultT = marks[0][0];
  const restoreT = marks.length > 1 ? marks[1][0] : faultT;
  const before = ops.filter((o) => o.t < faultT);
  const during = ops.filter((o) => o.t >= faultT && o.t < restoreT + 0.5);
  const after = ops.filter((o) => o.t >= restoreT + 0.5);
  const firstOkAfter = ops.find((o) => o.ok && o.t >= restoreT);
  const recoverS = firstOkAfter ? firstOkAfter.t - restoreT : null;
  const slowest = Math.max(...ops.map((o) => o.ms));
  const errCls = {}; ops.filter((o) => !o.ok).forEach((o) => bump(errCls, o.cls));
  const aliveAfter = new Set(after.filter((o) => o.ok).map((o) => o.inst)).size;
  const [{ ledger }] = await control`select count(*)::int as ledger from ledger_events where event_id = ${f.eventId}`;
  const drift = await control`select * from v_progress_drift where event_id = ${f.eventId}`;
  const okCounted = ops.filter((o) => o.ok).length;

  console.log(`\n  KẾT QUẢ ${id}`);
  console.log(`    trước sự cố : ${before.length} thao tác, lỗi=${before.filter((o) => !o.ok).length}`);
  console.log(`    trong sự cố : ${during.length} thao tác, lỗi=${during.filter((o) => !o.ok).length} ${JSON.stringify(errCls)}`);
  console.log(`    sau khôi phục: ${after.length} thao tác, lỗi=${after.filter((o) => !o.ok).length} · instance còn sống ${aliveAfter}/${INSTANCES}`);
  console.log(`    thời gian tới thao tác thành công đầu tiên sau khôi phục: ${recoverS === null ? 'KHÔNG BAO GIỜ' : recoverS.toFixed(1) + 's'}`);
  console.log(`    thao tác chậm nhất toàn bài: ${fmt(slowest)} (trần thiết kế ${QUERY_TIMEOUT_MS / 1000}s)`);
  console.log(`    ledger +${ledger} dòng · client nhận ok=${okCounted} · lệch=${drift.length}`);
  return { id, ops, before, during, after, recoverS, slowest, aliveAfter, drift: drift.length, ledger, okCounted, errCls };
}

// ── run ─────────────────────────────────────────────────────────────────────
console.log(`\nĐứt rồi nối (test #3) · ${INSTANCES} instance × 1 thao tác/${OP_EVERY_MS}ms · sự cố ở giây 20\n`);
await assertSandbox();
const results = [];

if (want('A')) {
  let killed = 0;
  const r = await runScenario({
    id: 'A', title: 'máy chủ cắt mọi kết nối (pg_terminate_backend) — Supabase khởi động lại / failover',
    url: URL_, durationS: 50,
    fault: async (mark) => {
      // Only OUR role's backends: the pooled backends serving the app's
      // connections. pg_stat_activity also lists Supabase's own superuser
      // sessions, and touching one of those fails the whole statement.
      try {
        const [{ n }] = await control`
          select count(pg_terminate_backend(pid))::int as n
            from pg_stat_activity
           where datname = current_database() and usename = current_user
             and pid <> pg_backend_pid() and backend_type = 'client backend'`;
        killed = n;
        mark(`CẮT: đã giết ${n} backend (role của app)`);
      } catch (e) {
        mark(`CẮT THẤT BẠI: ${String(e.message).slice(0, 80)}`);
      }
      mark('KHÔI PHỤC: máy chủ nhận kết nối lại ngay (không có gì để chờ)');
    },
  });
  const errWindow = r.ops.filter((o) => !o.ok).map((o) => o.t);
  const lastErr = errWindow.length ? Math.max(...errWindow) : 0;
  const faultT = 20;
  // killed >= 1 guards against a false pass: no permission → nothing cut → "no errors".
  const ok = killed >= 1 && r.before.every((o) => o.ok)
    && r.recoverS !== null && r.recoverS <= 5
    && (errWindow.length === 0 || lastErr - faultT <= 5)
    && r.slowest <= QUERY_TIMEOUT_MS + 1500
    && r.aliveAfter === INSTANCES && r.drift === 0;
  console.log(`  ${ok ? '✔' : '✗'} A  giết ${killed} backend · lỗi gom trong ${errWindow.length ? (lastErr - faultT).toFixed(1) : 0}s sau cú cắt · nối lại sau ${r.recoverS?.toFixed(1)}s · ${r.aliveAfter}/${INSTANCES} instance sống · lệch=${r.drift}`);
  results.push(ok);
}

if (want('B')) {
  const u = new URL(URL_);
  const upstreamHost = u.hostname, upstreamPort = Number(u.port || 5432);
  const proxy = startProxy(upstreamHost, upstreamPort, PROXY_PORT);
  u.hostname = '127.0.0.1'; u.port = String(PROXY_PORT);
  await sleep(300);
  const r = await runScenario({
    id: 'B', title: `mạng im lặng ${FREEZE_S}s (proxy ngừng chuyển byte, socket vẫn mở) — hình dạng cú treo 06/09`,
    url: u.toString(), durationS: 20 + FREEZE_S + 40,
    fault: async (mark) => {
      proxy.freeze(); mark(`ĐÓNG BĂNG mạng ${FREEZE_S}s`);
      await sleep(FREEZE_S * 1000);
      proxy.thaw(); mark('MỞ BĂNG: byte chạy lại');
    },
  });
  const seen = proxy.seen();
  proxy.close();
  const failedDuring = r.during.filter((o) => !o.ok);
  const capHeld = failedDuring.every((o) => o.ms <= QUERY_TIMEOUT_MS + 1500);
  const worstDuring = failedDuring.length ? Math.max(...failedDuring.map((o) => o.ms)) : 0;
  // Two guards against a false pass: the proxy must really have been in the
  // path (it saw every instance connect), and the freeze must really have bitten.
  const ok = seen >= INSTANCES && failedDuring.length >= 1 && r.before.every((o) => o.ok)
    && capHeld && r.slowest <= QUERY_TIMEOUT_MS + 2500
    && r.recoverS !== null && r.recoverS <= 5
    && r.after.filter((o) => !o.ok).length === 0
    && r.aliveAfter === INSTANCES && r.drift === 0;
  console.log(`  ${ok ? '✔' : '✗'} B  proxy thấy ${seen} kết nối · ${failedDuring.length} thao tác trong lúc băng, chậm nhất ${fmt(worstDuring)} (trần ${QUERY_TIMEOUT_MS / 1000}s${capHeld ? ', giữ được' : ', VỠ'}) · nối lại sau ${r.recoverS?.toFixed(1)}s · lỗi sau khi mở băng=${r.after.filter((o) => !o.ok).length} · ${r.aliveAfter}/${INSTANCES} instance sống · lệch=${r.drift}`);
  results.push(ok);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} đạt\n`);
await control.end({ timeout: 5 });
process.exit(passed === results.length ? 0 : 1);
