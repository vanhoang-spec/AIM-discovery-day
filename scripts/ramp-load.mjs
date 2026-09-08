/**
 * Thang bậc tải — đi tìm ĐIỂM GÃY, không phải để chứng minh "đạt".
 *
 * VÌ SAO CẦN, DÙ §4.3 ĐÃ XANH
 * Mọi lần đo trước chạy trên database TRỐNG. Tối 08/09 đã nhập 590 sinh viên
 * thật, và dữ liệu đổi thì kế hoạch truy vấn cũng đổi: `/api/refdata` vẫn
 * hằng số, nhưng mọi thứ đọc `students`/`registrations` giờ mới có việc thật
 * để làm. Một hệ thống xanh trên bảng rỗng chưa nói gì về hệ thống có dữ liệu.
 *
 * CÁCH TÌM CỔ CHAI
 * Tăng tải theo bậc cho tới khi HỎNG, thay vì dừng ở mức mục tiêu. Điểm gãy
 * là con số duy nhất cho biết còn bao nhiêu biên an toàn cho ngày 12/09.
 * Mỗi bậc giữ đủ lâu để CDN và instance ổn định, nghỉ giữa hai bậc để không
 * đo dư âm của bậc trước (bài học 08/09: đo nhỏ giọt ngay sau đợt dồn cho
 * p95 1,7 s — hoàn toàn là dư âm burst).
 *
 * PHÂN BIỆT NGHẼN MÁY ĐO VỚI NGHẼN MÁY CHỦ — quan trọng nhất
 * Một laptop không đóng giả được 600 điện thoại: 08/09 đã có 19 lỗi bắt tay
 * TLS ở phía máy đo trong khi máy chủ không hề lỗi. Nên mỗi bậc ghi cả
 * `maxInflight` (số request đang bay) và `dispatchLag` (độ trễ giữa lúc ĐỊNH
 * bắn và lúc BẮN được). dispatchLag lớn = máy đo không theo kịp, và mọi con
 * số p95 của bậc đó phải đọc là "của máy đo", không phải của hệ thống.
 *
 * DÙNG
 *   node scripts/ramp-load.mjs                    # thang mặc định
 *   STEPS=36,72,144 STEP_S=120 node scripts/ramp-load.mjs
 *   SOAK_S=1200 node scripts/ramp-load.mjs        # chạy bền sau thang bậc
 *
 * CHỈ ĐỌC — không ghi một dòng nào vào production.
 */

const BASE = process.env.BASE ?? 'https://app.awakenthelions.net';
const STEPS = (process.env.STEPS ?? '36,72,144,288,576').split(',').map(Number);
const STEP_S = Number(process.env.STEP_S ?? 120);
const REST_S = Number(process.env.REST_S ?? 45);
const SOAK_S = Number(process.env.SOAK_S ?? 0);
const P95_STOP = Number(process.env.P95_STOP ?? 2000);
const ERR_STOP = Number(process.env.ERR_STOP ?? 0.02);

// Hỗn hợp đúng tỉ lệ lưu lượng thật, tổng = 1.
const MIX = [
  { name: 'refdata-cdn', share: 0.69, url: () => `${BASE}/api/refdata` },
  { name: 'refdata-db', share: 0.06, url: () => `${BASE}/api/refdata?t=${Date.now()}-${Math.random().toString(36).slice(2, 7)}` },
  { name: 'lich', share: 0.14, url: () => `${BASE}/lich` },
  { name: 'dang-ky', share: 0.11, url: () => `${BASE}/dang-ky` },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] : 0);
const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1; };

/** Một bậc: bắn `rps` req/s trong `seconds`, trả số liệu từng đường. */
async function step(rps, seconds, label) {
  const st = Object.fromEntries(MIX.map((m) => [m.name, { lat: [], codes: {}, cache: {} }]));
  let inflight = 0, maxInflight = 0, lagMax = 0, lagSum = 0, ticks = 0;
  const t0 = Date.now();

  const fire = (m) => {
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    const s = Date.now();
    fetch(m.url(), { signal: AbortSignal.timeout(60_000) })
      .then(async (r) => {
        await r.arrayBuffer();
        st[m.name].lat.push(Date.now() - s);
        bump(st[m.name].codes, r.status);
        bump(st[m.name].cache, r.headers.get('x-vercel-cache') ?? '-');
      })
      .catch((e) => {
        st[m.name].lat.push(Date.now() - s);
        bump(st[m.name].codes, 'ERR:' + (e.name ?? 'x'));
      })
      .finally(() => { inflight--; });
  };

  for (let sec = 0; sec < seconds; sec++) {
    const due = t0 + sec * 1000;
    const lag = Date.now() - due;                 // máy đo có bắn đúng nhịp không?
    lagMax = Math.max(lagMax, lag); lagSum += lag; ticks++;
    for (const m of MIX) {
      const n = Math.round(rps * m.share);
      for (let i = 0; i < n; i++) setTimeout(() => fire(m), Math.floor(1000 * i / Math.max(1, n)));
    }
    const wait = due + 1000 - Date.now();
    if (wait > 0) await sleep(wait);
  }
  await sleep(3000);                              // gom nốt request đang bay
  for (let i = 0; i < 20 && inflight > 0; i++) await sleep(1000);

  const all = MIX.flatMap((m) => st[m.name].lat);
  const okAll = MIX.reduce((s, m) => s + (st[m.name].codes[200] ?? 0), 0);
  const nAll = all.length;
  const res = {
    label, rps, n: nAll, okRate: nAll ? okAll / nAll : 0,
    p50: pct(all, 0.5), p95: pct(all, 0.95), p99: pct(all, 0.99), max: Math.max(0, ...all),
    maxInflight, lagAvg: Math.round(lagSum / Math.max(1, ticks)), lagMax,
    lanes: Object.fromEntries(MIX.map((m) => [m.name, {
      n: st[m.name].lat.length,
      ok: (st[m.name].codes[200] ?? 0),
      p50: pct(st[m.name].lat, 0.5), p95: pct(st[m.name].lat, 0.95),
      codes: st[m.name].codes, cache: st[m.name].cache,
    }])),
  };
  return res;
}

function print(r) {
  const meterWarn = r.lagMax > 2000 ? '  ⚠ MÁY ĐO trễ nhịp — số của bậc này là của máy đo' : '';
  console.log(`\n▸ ${r.label}: ${r.rps} req/s · n=${r.n} · ok=${(100 * r.okRate).toFixed(1)}%`
    + ` · p50=${r.p50}ms p95=${r.p95}ms p99=${r.p99}ms max=${r.max}ms`
    + ` · inflight đỉnh=${r.maxInflight} · lệch nhịp tb=${r.lagAvg}ms/đỉnh=${r.lagMax}ms${meterWarn}`);
  for (const [k, v] of Object.entries(r.lanes)) {
    console.log(`    ${k.padEnd(12)} n=${String(v.n).padStart(5)} ok=${String(v.ok).padStart(5)}`
      + ` p50=${String(v.p50).padStart(5)}ms p95=${String(v.p95).padStart(5)}ms`
      + ` ${JSON.stringify(v.codes)}${v.cache && Object.keys(v.cache).length > 1 ? ' cdn=' + JSON.stringify(v.cache) : ''}`);
  }
}

console.log(`Thang bậc tải · ${BASE} · bậc: ${STEPS.join(', ')} req/s · mỗi bậc ${STEP_S}s, nghỉ ${REST_S}s`);
console.log(`Dừng khi p95 > ${P95_STOP}ms hoặc lỗi > ${(ERR_STOP * 100).toFixed(0)}% · bắt đầu ${new Date().toISOString()}\n`);

const results = [];
let broke = null;
for (const rps of STEPS) {
  const r = await step(rps, STEP_S, `bậc ${rps}`);
  print(r);
  results.push(r);
  const failRate = 1 - r.okRate;
  const meterBound = r.lagMax > 2000;
  if (!meterBound && (r.p95 > P95_STOP || failRate > ERR_STOP)) {
    broke = { rps, why: r.p95 > P95_STOP ? `p95 ${r.p95}ms vượt ${P95_STOP}ms` : `lỗi ${(failRate * 100).toFixed(1)}%` };
    console.log(`\n✗ ĐIỂM GÃY ở ${rps} req/s — ${broke.why}. Dừng thang.`);
    break;
  }
  if (meterBound) console.log(`  (bỏ qua tiêu chí dừng ở bậc này: máy đo trễ nhịp ${r.lagMax}ms)`);
  if (rps !== STEPS.at(-1)) { console.log(`  … nghỉ ${REST_S}s cho hệ thống về nền`); await sleep(REST_S * 1000); }
}

if (SOAK_S > 0) {
  console.log(`\n── Chạy bền ${SOAK_S}s ở ${STEPS[0]} req/s (tìm rò rỉ chậm) ──`);
  const r = await step(STEPS[0], SOAK_S, 'bền');
  print(r);
  results.push(r);
}

console.log('\n══ TỔNG HỢP ══');
console.log('bậc(req/s) │  n     │ ok%   │ p50   │ p95   │ p99   │ inflight │ lệch nhịp');
for (const r of results) {
  console.log(`${String(r.rps).padStart(9)} │ ${String(r.n).padStart(6)} │ ${(100 * r.okRate).toFixed(1).padStart(5)} │`
    + ` ${String(r.p50).padStart(5)} │ ${String(r.p95).padStart(5)} │ ${String(r.p99).padStart(5)} │`
    + ` ${String(r.maxInflight).padStart(8)} │ ${String(r.lagMax).padStart(6)}ms`);
}
console.log(broke ? `\nKẾT LUẬN: gãy ở ${broke.rps} req/s (${broke.why})`
  : `\nKẾT LUẬN: KHÔNG gãy tới ${STEPS.at(-1)} req/s — trần thật nằm cao hơn thang này hoặc cao hơn sức máy đo.`);
process.exit(0);
