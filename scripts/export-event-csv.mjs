#!/usr/bin/env node
/**
 * Dựng bộ CSV nghiệm thu cho TỪNG sự kiện từ bản xuất thô các bảng database.
 *
 * Vì sao có script này (20/11/2026): không ai nhớ mật khẩu database nên
 * scripts/backup-db.mjs không chạy được. Cách còn lại không cần mật khẩu: tải
 * từng bảng từ Supabase (Table Editor → Export → "Export table as CSV", ra file
 * "<bảng>_rows.csv"), rồi script này nối các bảng lại thành file người đọc được,
 * mỗi sự kiện một thư mục.
 *
 *   node scripts/export-event-csv.mjs <thư-mục-bảng-thô> <thư-mục-ra> [--events=1,2,4]
 *
 * Kiểm đủ dòng: đặt file _so-dong.json ({"students": 2131, ...} — đếm bằng
 * count(*) trên SQL Editor) vào thư mục bảng thô; script dừng nếu file CSV nào
 * lệch số dòng, thiếu file, hoặc cột khác lược đồ migrations 0001–0016.
 *
 * Ra: <thư-mục-ra>/<NN>_<tên-sự-kiện>/ gồm các file .csv (UTF-8 có BOM để Excel
 * đọc đúng dấu) + 1 file .xlsx gộp đủ các bảng đó thành sheet (SĐT giữ số 0 đầu),
 * và <thư-mục-ra>/TONG-HOP-CAC-SU-KIEN.csv.
 *
 * Cố ý KHÔNG xuất: token_hash / pin_hash / claim_code của máy quét, payload thư
 * (chứa link riêng /toi#t=<mã QR> của từng SV), khoá có tên hash/token/pin/secret
 * trong JSON nhật ký. Chỉ đọc file, không chạm database.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildWorkbook } from '../packages/xlsx-lite/src/index.js';

/* -------------------------------------------------------------- tham số -- */

const argv = process.argv.slice(2);
const flags = Object.fromEntries(argv.filter((a) => a.startsWith('--'))
  .map((a) => { const [k, v = ''] = a.slice(2).split('='); return [k, v]; }));
const [RAW, OUT] = argv.filter((a) => !a.startsWith('--'));
if (!RAW || !OUT) {
  console.error('Cách dùng: node scripts/export-event-csv.mjs <thư-mục-bảng-thô> <thư-mục-ra> [--events=1,2,4]');
  process.exit(2);
}

/* ----------------------------------------------- lược đồ (0001 → 0016) -- */

const SCHEMA = {
  editions: 'id year name created_at',
  events: 'id edition_id kind slug name venue_name city starts_at ends_at timezone gift_ladder_mode special_threshold_y special_claim_limit token_key_id is_registration_open created_at sms_enabled early_bird_until checkin_checkpoint_id early_bird_checkpoint_id golden_budget golden_issued is_archived email_copy',
  zones: 'id event_id name color_hex display_order',
  checkpoints: 'id event_id zone_id kind name description location_hint starts_at ends_at capacity counts_toward_badges badge_award_mode allow_student_scan display_order is_active created_at updated_at badge_weight',
  ref_schools: 'id name short_name city search_key is_active',
  ref_provinces: 'code name search_key',
  students: 'id seq lookup_code full_name name_search_key email phone school_id school_other student_code major birth_year province_code employer gender consent_event_at consent_event_ip consent_sponsors_at consent_sponsors_ip consent_text_version created_at updated_at merged_into_id',
  teams: 'id event_id team_code name created_at',
  registrations: 'student_id event_id type source team_id ssc_opted_in registered_at checked_in_at badge_count core_badge_count',
  attendance: 'id event_id student_id checkpoint_id first_scan_uid source awarded_at voided_at void_reason',
  ledger_events: 'scan_uid event_id student_id checkpoint_id source status pg_staff_id device_id client_ts server_ts meta',
  checkpoint_minute_counts: 'checkpoint_id event_id minute_ts badge_count scan_count',
  gift_tiers: 'id event_id tier required_badges gift_name stock_total stock_issued is_active created_at',
  gift_redemptions: 'id event_id student_id gift_tier_id threshold_at_grant badge_count_at_grant redeemed_at staff_id device_id was_offline',
  special_activities: 'id event_id name description location_hint starts_at capacity is_open created_at',
  special_slots: 'id special_activity_id event_id slot_no student_id claimed_at held_by_student_id held_until',
  notification_outbox: 'id channel student_id event_id template recipient payload status attempts last_error scheduled_at sent_at created_at',
  pg_staff: 'id event_id full_name phone role created_at',
  pg_devices: 'id event_id claim_code token_hash pin_hash pg_staff_id zone_id label claimed_at last_sync_at queue_depth battery_pct app_version revoked_at created_at device_role',
  pg_device_checkpoints: 'device_id checkpoint_id event_id',
  golden_hours: 'id event_id zone_id bonus_checkpoint_id badge_cap badges_issued started_at ends_at started_by closed_at closed_by',
  surveys: 'id event_id checkpoint_id title intro accent_hex is_active schema_version questions created_at updated_at',
  survey_responses: 'response_uid survey_id event_id student_id schema_version answers submitted_at',
  audit_log: 'id event_id actor_type actor_id action target_type target_id before_state after_state reason created_at',
};

/* ------------------------------------------------------------------ CSV -- */

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { /* CRLF: để \n xử lý */ }
    else field += c;
  }
  if (quoted) throw new Error('CSV hỏng: thiếu dấu " đóng');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file, header, rows) {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(','));
  writeFileSync(file, '\ufeff' + lines.join('\r\n') + '\r\n', 'utf8');
}

/* ----------------------------------------------------------- nạp bảng -- */

const expectedCounts = existsSync(join(RAW, '_so-dong.json'))
  ? JSON.parse(readFileSync(join(RAW, '_so-dong.json'), 'utf8')) : null;
const problems = [];

// Gói gộp (cách không cần tải từng bảng): CSV tải từ SQL Editor sau khi chạy
// scripts/export-bundle-sql.mjs — cột bang,phan,du_lieu, mỗi ô du_lieu là mảng
// JSON (to_jsonb) tối đa 500 dòng của một bảng. Trùng (bang, phan) thì giữ bản đầu.
const BUNDLE = new Map();
const flat = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
for (const name of readdirSync(RAW).filter((n) => /\.csv$/i.test(n))) {
  const grid = parseCsv(readFileSync(join(RAW, name), 'utf8'));
  if ((grid[0] ?? []).map((h) => h.trim()).join(',') !== 'bang,phan,du_lieu') continue;
  for (const [table, part, data] of grid.slice(1).filter((r) => r.length >= 3)) {
    const b = BUNDLE.get(table) ?? { parts: new Set(), rows: [] };
    if (b.parts.has(part)) { problems.push(`${table} phần ${part} có 2 lần (giữ bản đầu) — ${name}`); continue; }
    b.parts.add(part);
    for (const row of JSON.parse(data)) b.rows.push(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, flat(v)])));
    BUNDLE.set(table, b);
  }
}

const T = {};
for (const [table, cols] of Object.entries(SCHEMA)) {
  const file = [`${table}_rows.csv`, `${table}.csv`].map((n) => join(RAW, n)).find(existsSync);
  const want = expectedCounts?.[table];
  if (!file && BUNDLE.has(table)) {
    const rows = BUNDLE.get(table).rows;
    const need = cols.split(' ');
    const bad = rows.find((r) => Object.keys(r).length !== need.length || need.some((c) => !(c in r)));
    if (bad) problems.push(`${table}: cột trong gói gộp khác lược đồ (${Object.keys(bad).join(' ')})`);
    if (want !== undefined && want !== rows.length) problems.push(`${table}: gói gộp có ${rows.length} dòng, database đếm ${want}`);
    T[table] = rows;
    continue;
  }
  if (!file) {
    if (want !== 0) problems.push(`thiếu file bảng ${table}${want ? ` (cần ${want} dòng)` : ''}`);
    T[table] = [];
    continue;
  }
  const grid = parseCsv(readFileSync(file, 'utf8'));
  const head = (grid[0] ?? []).map((h) => h.trim());
  const need = cols.split(' ');
  const lack = need.filter((c) => !head.includes(c));
  const extra = head.filter((c) => !need.includes(c));
  if (lack.length) problems.push(`${table}: thiếu cột ${lack.join(', ')}`);
  if (extra.length) problems.push(`${table}: cột lạ ${extra.join(', ')}`);
  const body = grid.slice(1).filter((r) => !(r.length === 1 && r[0] === ''));
  for (const r of body) {
    if (r.length !== head.length) { problems.push(`${table}: có dòng ${r.length} ô, tiêu đề ${head.length} cột`); break; }
  }
  if (want !== undefined && want !== body.length) problems.push(`${table}: file có ${body.length} dòng, database đếm ${want}`);
  T[table] = body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}
if (!expectedCounts) problems.push('không có _so-dong.json — chưa đối chiếu được số dòng');
if (problems.length) {
  console.error('KIỂM ĐẦU VÀO:\n  - ' + problems.join('\n  - '));
  if (!('force' in flags)) process.exit(1);
}

/* ------------------------------------------------------------- giá trị -- */

const nz = (v) => (v === undefined || v === null || v === '' ? null : v);
const num = (v) => (nz(v) === null ? null : Number(v));
function bool(v) {
  if (nz(v) === null) return null;
  if (/^(true|t)$/i.test(v)) return true;
  if (/^(false|f)$/i.test(v)) return false;
  throw new Error(`Không đọc được giá trị đúng/sai: ${v}`);
}
function json(v) {
  if (nz(v) === null) return null;
  try { return JSON.parse(v); } catch { throw new Error(`Không đọc được JSON: ${String(v).slice(0, 80)}`); }
}
const SECRET_KEY = /hash|token|pin|secret|password|claim_code/i;
function redact(x) {
  if (Array.isArray(x)) return x.map(redact);
  if (x && typeof x === 'object') {
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, SECRET_KEY.test(k) ? '(ẩn)' : redact(v)]));
  }
  return x;
}
const jsonText = (v) => { const j = json(v); return j === null ? '' : JSON.stringify(redact(j)); };

const TS = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)$/i;
function ts(v) {
  if (nz(v) === null) return null;
  const m = TS.exec(String(v).trim());
  if (!m) throw new Error(`Không đọc được thời điểm (cần có múi giờ): ${v}`);
  const [, Y, Mo, D, h, mi, s = '0', frac = '', tz] = m;
  let off = 0;
  if (tz.toUpperCase() !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1;
    off = sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3).replace(':', '') || 0));
  }
  const ms = frac ? Math.round(Number(frac) * 1000) : 0;
  return new Date(Date.UTC(+Y, +Mo - 1, +D, +h, +mi, +s, ms) - off * 60000);
}
const p2 = (n) => String(n).padStart(2, '0');
const vnParts = (v) => { const d = ts(v); return d && new Date(d.getTime() + 7 * 3600e3); };
/** Giờ Việt Nam (UTC+7, không có giờ mùa hè): DD/MM/YYYY HH:mm:ss */
function vn(v) {
  const x = vnParts(v);
  if (!x) return '';
  return `${p2(x.getUTCDate())}/${p2(x.getUTCMonth() + 1)}/${x.getUTCFullYear()} ${p2(x.getUTCHours())}:${p2(x.getUTCMinutes())}:${p2(x.getUTCSeconds())}`;
}
const vnDay = (v) => { const x = vnParts(v); return x ? `${p2(x.getUTCDate())}/${p2(x.getUTCMonth() + 1)}/${x.getUTCFullYear()}` : ''; };
const vnHour = (v) => { const x = vnParts(v); return x ? `${p2(x.getUTCHours())}:00` : ''; };
const yn = (b) => (b === null ? '' : b ? 'Có' : 'Không');
const time = (v) => ts(v)?.getTime() ?? Infinity;

const LABEL = {
  registration_type: { contestant: 'Thí sinh ATL', general: 'Khách tham quan' },
  registration_source: { online: 'Đăng ký online', walk_in: 'Đăng ký tại chỗ', admin: 'Admin thêm', import: 'Nhập từ file' },
  gender: { nam: 'Nam', nu: 'Nữ', khac: 'Khác' },
  event_kind: { discovery_day: 'Discovery Day', grand_finale: 'Chung kết' },
  checkpoint_kind: {
    sponsor_booth: 'Gian hàng nhà tài trợ', diamond_booth: 'Gian hàng NTT Kim cương',
    hall_session: 'Phiên hội trường', learning_class: 'Lớp học', info_desk: 'Bàn thông tin',
    gift_counter: 'Quầy quà', entrance: 'Cổng vào', bonus: 'Hoạt động thưởng',
  },
  badge_award_mode: {
    pg_scan: 'PG quét', survey_complete: 'Làm khảo sát', either: 'PG quét hoặc làm khảo sát',
    both_required: 'Cần cả PG quét và khảo sát',
  },
  scan_source: {
    pg_scan: 'PG quét', student_scan: 'SV tự quét', survey: 'Khảo sát',
    admin_manual: 'Admin chỉnh tay', walk_in: 'Đăng ký tại cổng',
  },
  scan_status: {
    counted: 'Cấp badge mới', repeat_not_counted: 'Quét lại (đã có badge)',
    replay: 'Gửi trùng (bỏ qua)', pending_other_condition: 'Chờ điều kiện còn lại',
    rejected_unknown_student: 'Từ chối: không nhận ra SV',
    rejected_checkpoint_closed: 'Từ chối: hoạt động đã đóng',
    rejected_not_registered: 'Từ chối: SV chưa đăng ký sự kiện',
  },
  notification_channel: { email: 'Email', sms: 'SMS' },
  notification_status: { queued: 'Đang chờ gửi', sending: 'Đang gửi', sent: 'Đã gửi', failed: 'Lỗi', cancelled: 'Đã huỷ' },
  pg_role: { pg: 'PG', supervisor: 'Giám sát' },
};
const lab = (kind, v) => (nz(v) === null ? '' : LABEL[kind][v] ?? v);

/* -------------------------------------------------------------- chỉ mục -- */

const byKey = (rows, key) => new Map(rows.map((r) => [r[key], r]));
const groupBy = (rows, key) => {
  const m = new Map();
  for (const r of rows) { const k = r[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return m;
};
const STUDENT = byKey(T.students, 'id');
const SCHOOL = byKey(T.ref_schools, 'id');
const PROVINCE = byKey(T.ref_provinces, 'code');
const TEAM = byKey(T.teams, 'id');
const ZONE = byKey(T.zones, 'id');
const CP = byKey(T.checkpoints, 'id');
const TIER = byKey(T.gift_tiers, 'id');
const STAFF = byKey(T.pg_staff, 'id');
const DEVICE = byKey(T.pg_devices, 'id');
const SPECIAL = byKey(T.special_activities, 'id');

const stu = (id) => STUDENT.get(id) ?? {};
const seq = (id) => num(stu(id).seq);
const school = (s) => SCHOOL.get(s.school_id)?.name ?? s.school_other ?? '';
const cpName = (id) => CP.get(id)?.name ?? (nz(id) ? `#${id}` : '');
const zoneOfCp = (id) => ZONE.get(CP.get(id)?.zone_id)?.name ?? '';
const staffName = (v) => (nz(v) === null ? '' : STAFF.has(v) ? `${STAFF.get(v).full_name} (#${v})` : v);
const deviceName = (v) => (nz(v) === null ? '' : DEVICE.has(v) ? `${DEVICE.get(v).label || 'Máy'} (#${v})` : v);
const slug = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd')
  .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
const byTime = (key) => (a, b) => time(a[key]) - time(b[key]);

/* --------------------------------------------------------- từng sự kiện -- */

function buildEvent(ev) {
  const eid = ev.id;
  const of = (table) => T[table].filter((r) => r.event_id === eid);
  const regs = of('registrations').sort(byTime('registered_at'));
  const att = of('attendance').sort(byTime('awarded_at'));
  const valid = att.filter((a) => !nz(a.voided_at));
  const ledger = of('ledger_events').sort(byTime('server_ts'));
  const gifts = of('gift_redemptions').sort(byTime('redeemed_at'));
  const tiers = of('gift_tiers').sort((a, b) => num(a.tier) - num(b.tier));
  const zones = of('zones');
  const zoneOrder = (id) => num(ZONE.get(id)?.display_order) ?? 999;
  const cps = of('checkpoints').sort((a, b) => zoneOrder(a.zone_id) - zoneOrder(b.zone_id)
    || num(a.display_order) - num(b.display_order) || num(a.id) - num(b.id));
  const minutes = of('checkpoint_minute_counts').sort(byTime('minute_ts'));
  const specials = of('special_activities').sort((a, b) => num(a.id) - num(b.id));
  const slots = of('special_slots');
  const surveys = of('surveys').sort((a, b) => num(a.id) - num(b.id));
  const responses = of('survey_responses').sort(byTime('submitted_at'));
  const outbox = of('notification_outbox').sort(byTime('created_at'));
  const audit = of('audit_log').sort(byTime('created_at'));
  const golden = of('golden_hours').sort(byTime('started_at'));
  const staff = of('pg_staff').sort((a, b) => num(a.id) - num(b.id));
  const devices = of('pg_devices').sort((a, b) => num(a.id) - num(b.id));
  const deviceCps = groupBy(of('pg_device_checkpoints'), 'device_id');
  const teams = of('teams').sort((a, b) => String(a.team_code).localeCompare(String(b.team_code)));

  const validByStudent = groupBy(valid, 'student_id');
  const giftsByStudent = groupBy(gifts, 'student_id');
  const slotsByStudent = groupBy(slots.filter((s) => nz(s.student_id)), 'student_id');
  const regsByTeam = groupBy(regs.filter((r) => nz(r.team_id)), 'team_id');
  const giftLabel = (g) => {
    const t = TIER.get(g.gift_tier_id);
    return `Bậc ${t?.tier ?? '?'} - ${t?.gift_name ?? ''} (${vn(g.redeemed_at)})`;
  };

  const sets = [];
  const add = (file, sheet, header, rows) => sets.push({ file, sheet, header, rows });

  add('01-sinh-vien-dang-ky', '01 Sinh viên đăng ký', [
    'STT', 'Mã SV (seq)', 'Mã tra cứu', 'Họ tên', 'Email', 'SĐT', 'Trường', 'Trường (SV tự ghi)',
    'MSSV', 'Ngành', 'Năm sinh', 'Tỉnh/TP', 'Nơi làm việc', 'Giới tính', 'Loại đăng ký',
    'Nguồn đăng ký', 'Mã đội', 'Tên đội', 'Đăng ký SSC', 'Đăng ký lúc', 'Check-in lúc', 'Số badge',
    'Badge thang đặc biệt', 'Số hoạt động đã ghé', 'Các hoạt động đã ghé', 'Quà đã nhận',
    'Suất đặc biệt', 'Đồng ý dùng dữ liệu cho sự kiện lúc', 'Đồng ý chia sẻ cho nhà tài trợ',
    'Đồng ý chia sẻ NTT lúc', 'Phiên bản điều khoản', 'IP lúc đồng ý (sự kiện)',
    'IP lúc đồng ý (NTT)', 'Hồ sơ trùng, đã gộp vào Mã SV',
  ], regs.map((r, i) => {
    const s = stu(r.student_id);
    const team = TEAM.get(r.team_id);
    const mine = validByStudent.get(r.student_id) ?? [];
    return [
      i + 1, num(s.seq), s.lookup_code ?? '', s.full_name ?? `(không thấy SV #${r.student_id})`,
      s.email ?? '', s.phone ?? '', school(s), s.school_other ?? '', s.student_code ?? '',
      s.major ?? '', num(s.birth_year), PROVINCE.get(s.province_code)?.name ?? s.province_code ?? '',
      s.employer ?? '', lab('gender', s.gender), lab('registration_type', r.type),
      lab('registration_source', r.source), team?.team_code ?? '', team?.name ?? '',
      yn(bool(r.ssc_opted_in)), vn(r.registered_at), vn(r.checked_in_at), num(r.badge_count),
      num(r.core_badge_count), new Set(mine.map((a) => a.checkpoint_id)).size,
      mine.map((a) => cpName(a.checkpoint_id)).join('; '),
      (giftsByStudent.get(r.student_id) ?? []).map(giftLabel).join('; '),
      (slotsByStudent.get(r.student_id) ?? []).map((x) => `${SPECIAL.get(x.special_activity_id)?.name ?? ''} - suất ${x.slot_no}`).join('; '),
      vn(s.consent_event_at), yn(nz(s.consent_sponsors_at) !== null), vn(s.consent_sponsors_at),
      s.consent_text_version ?? '', s.consent_event_ip ?? '', s.consent_sponsors_ip ?? '',
      nz(s.merged_into_id) ? seq(s.merged_into_id) ?? `#${s.merged_into_id}` : '',
    ];
  }));

  add('02-badge-tung-hoat-dong', '02 Badge từng hoạt động', [
    'STT', 'Mã SV (seq)', 'Họ tên', 'Khu vực', 'Hoạt động', 'Loại hoạt động', 'Nhận badge lúc',
    'Cách ghi nhận', 'Trạng thái', 'Huỷ lúc', 'Lý do huỷ', 'Mã lượt quét đầu tiên',
  ], att.map((a, i) => [
    i + 1, seq(a.student_id), stu(a.student_id).full_name ?? '', zoneOfCp(a.checkpoint_id),
    cpName(a.checkpoint_id), lab('checkpoint_kind', CP.get(a.checkpoint_id)?.kind), vn(a.awarded_at),
    lab('scan_source', a.source), nz(a.voided_at) ? 'Đã huỷ' : 'Hợp lệ', vn(a.voided_at),
    a.void_reason ?? '', a.first_scan_uid ?? '',
  ]));

  add('03-nhat-ky-quet', '03 Nhật ký quét', [
    'STT', 'Mã lượt quét', 'Mã SV (seq)', 'Họ tên', 'Khu vực', 'Hoạt động', 'Nguồn', 'Kết quả',
    'Giờ trên máy quét', 'Giờ máy chủ nhận', 'Nhân viên PG', 'Máy quét', 'Thông tin thêm',
  ], ledger.map((l, i) => [
    i + 1, l.scan_uid, seq(l.student_id), stu(l.student_id).full_name ?? '', zoneOfCp(l.checkpoint_id),
    cpName(l.checkpoint_id), lab('scan_source', l.source), lab('scan_status', l.status),
    vn(l.client_ts), vn(l.server_ts), staffName(l.pg_staff_id), deviceName(l.device_id), jsonText(l.meta),
  ]));

  add('04-nhan-qua', '04 Nhận quà', [
    'STT', 'Mã SV (seq)', 'Họ tên', 'Email', 'SĐT', 'Trường', 'Bậc quà', 'Tên quà',
    'Ngưỡng badge khi nhận', 'Số badge khi nhận', 'Nhận lúc', 'Nhân viên phát', 'Máy quét',
    'Ghi nhận khi mất mạng',
  ], gifts.map((g, i) => {
    const s = stu(g.student_id);
    const t = TIER.get(g.gift_tier_id);
    return [
      i + 1, num(s.seq), s.full_name ?? '', s.email ?? '', s.phone ?? '', school(s), num(t?.tier),
      t?.gift_name ?? '', num(g.threshold_at_grant), num(g.badge_count_at_grant), vn(g.redeemed_at),
      staffName(g.staff_id), deviceName(g.device_id), yn(bool(g.was_offline)),
    ];
  }));

  add('05-bac-qua-va-kho', '05 Bậc quà và kho', [
    'Bậc', 'Tên quà', 'Ngưỡng badge', 'SV đủ điều kiện (badge >= ngưỡng)', 'Lượt đã nhận',
    'Kho đã phát', 'Kho tổng', 'Kho còn lại', 'Đang dùng',
  ], tiers.map((t) => [
    num(t.tier), t.gift_name, num(t.required_badges),
    regs.filter((r) => num(r.badge_count) >= num(t.required_badges)).length,
    gifts.filter((g) => g.gift_tier_id === t.id).length, num(t.stock_issued), num(t.stock_total),
    nz(t.stock_total) === null ? '' : num(t.stock_total) - num(t.stock_issued), yn(bool(t.is_active)),
  ]));

  const attByCp = groupBy(att, 'checkpoint_id');
  const ledgerByCp = groupBy(ledger, 'checkpoint_id');
  add('06-hoat-dong-va-khu-vuc', '06 Hoạt động và khu vực', [
    'Mã hoạt động', 'Khu vực', 'Tên hoạt động', 'Loại', 'Mô tả', 'Vị trí', 'Bắt đầu', 'Kết thúc',
    'Sức chứa', 'Tính badge', 'Hệ số badge', 'Cách cấp badge', 'SV tự quét được', 'Đang mở',
    'Badge hợp lệ', 'Badge đã huỷ', 'Số SV khác nhau (badge hợp lệ)', 'Tổng lượt quét',
  ], cps.map((c) => {
    const a = attByCp.get(c.id) ?? [];
    const ok = a.filter((x) => !nz(x.voided_at));
    return [
      num(c.id), ZONE.get(c.zone_id)?.name ?? '', c.name, lab('checkpoint_kind', c.kind),
      c.description ?? '', c.location_hint ?? '', vn(c.starts_at), vn(c.ends_at), num(c.capacity),
      yn(bool(c.counts_toward_badges)), num(c.badge_weight), lab('badge_award_mode', c.badge_award_mode),
      yn(bool(c.allow_student_scan)), yn(bool(c.is_active)), ok.length, a.length - ok.length,
      new Set(ok.map((x) => x.student_id)).size, (ledgerByCp.get(c.id) ?? []).length,
    ];
  }));

  const hourKey = (m) => `${vnDay(m.minute_ts)} ${vnHour(m.minute_ts)}`;
  const hourly = new Map();
  const hourlyCp = new Map();
  for (const m of minutes) {
    const k = hourKey(m);
    const h = hourly.get(k) ?? [vnDay(m.minute_ts), vnHour(m.minute_ts), 0, 0];
    h[2] += num(m.scan_count); h[3] += num(m.badge_count); hourly.set(k, h);
    const kc = `${k}|${m.checkpoint_id}`;
    const c = hourlyCp.get(kc) ?? [vnDay(m.minute_ts), vnHour(m.minute_ts), zoneOfCp(m.checkpoint_id), cpName(m.checkpoint_id), 0, 0];
    c[4] += num(m.scan_count); c[5] += num(m.badge_count); hourlyCp.set(kc, c);
  }
  add('07-luot-theo-gio', '07 Lượt theo giờ', ['Ngày', 'Giờ', 'Lượt quét', 'Badge cấp'], [...hourly.values()]);
  add('08-luot-theo-gio-tung-hoat-dong', '08 Theo giờ từng hoạt động',
    ['Ngày', 'Giờ', 'Khu vực', 'Hoạt động', 'Lượt quét', 'Badge cấp'], [...hourlyCp.values()]);

  const specialRows = [];
  for (const sa of specials) {
    const taken = slots.filter((x) => x.special_activity_id === sa.id && nz(x.student_id))
      .sort((a, b) => num(a.slot_no) - num(b.slot_no));
    const head = [sa.name, sa.description ?? '', sa.location_hint ?? '', vn(sa.starts_at), num(sa.capacity), yn(bool(sa.is_open))];
    if (!taken.length) specialRows.push([...head, '(chưa ai nhận)', '', '', '', '', '']);
    for (const x of taken) {
      const s = stu(x.student_id);
      specialRows.push([...head, num(x.slot_no), num(s.seq), s.full_name ?? '', s.email ?? '', s.phone ?? '', vn(x.claimed_at)]);
    }
  }
  add('09-suat-dac-biet', '09 Suất đặc biệt', [
    'Hoạt động đặc biệt', 'Mô tả', 'Vị trí', 'Bắt đầu', 'Sức chứa', 'Đang mở', 'Suất số',
    'Mã SV (seq)', 'Họ tên', 'Email', 'SĐT', 'Nhận suất lúc',
  ], specialRows);

  const respBySurvey = groupBy(responses, 'survey_id');
  add('10-khao-sat', '10 Khảo sát', ['Mã khảo sát', 'Tên khảo sát', 'Gắn với hoạt động', 'Số câu hỏi', 'Lượt trả lời', 'Đang mở', 'File chi tiết'],
    surveys.map((sv) => [num(sv.id), sv.title, cpName(sv.checkpoint_id), (json(sv.questions) ?? []).length,
      (respBySurvey.get(sv.id) ?? []).length, yn(bool(sv.is_active)), `10-khao-sat-${sv.id}-${slug(sv.title).slice(0, 40)}.csv`]));
  for (const sv of surveys) {
    const qs = json(sv.questions) ?? [];
    const known = new Set(qs.map((q) => q.id));
    const show = (v) => (v === null || v === undefined ? '' : Array.isArray(v) ? v.join('; ') : typeof v === 'object' ? JSON.stringify(v) : v);
    add(`10-khao-sat-${sv.id}-${slug(sv.title).slice(0, 40)}`, `10.${sv.id} ${sv.title}`.slice(0, 31), [
      'STT', 'Mã SV (seq)', 'Họ tên', 'Trả lời lúc', 'Phiên bản câu hỏi', ...qs.map((q) => q.label ?? q.id),
      'Trả lời cho câu đã bỏ (JSON)',
    ], (respBySurvey.get(sv.id) ?? []).map((r, i) => {
      const a = json(r.answers) ?? {};
      const rest = Object.fromEntries(Object.entries(a).filter(([k]) => !known.has(k)));
      return [i + 1, seq(r.student_id), stu(r.student_id).full_name ?? '', vn(r.submitted_at),
        num(r.schema_version), ...qs.map((q) => show(a[q.id])), Object.keys(rest).length ? JSON.stringify(rest) : ''];
    }));
  }

  add('11-thu-da-gui', '11 Thư đã gửi', [
    'STT', 'Mã SV (seq)', 'Họ tên', 'Kênh', 'Mẫu thư', 'Người nhận', 'Trạng thái', 'Số lần gửi',
    'Lỗi gần nhất', 'Hẹn gửi lúc', 'Gửi xong lúc', 'Tạo lúc',
  ], outbox.map((o, i) => [
    i + 1, seq(o.student_id), stu(o.student_id).full_name ?? '', lab('notification_channel', o.channel),
    o.template, o.recipient ?? '', lab('notification_status', o.status), num(o.attempts),
    o.last_error ?? '', vn(o.scheduled_at), vn(o.sent_at), vn(o.created_at),
  ]));

  add('12-nhat-ky-chinh-tay', '12 Nhật ký chỉnh tay', [
    'STT', 'Lúc', 'Loại người làm', 'Người làm', 'Hành động', 'Loại đối tượng', 'Đối tượng',
    'Trước khi sửa', 'Sau khi sửa', 'Lý do',
  ], audit.map((x, i) => [
    i + 1, vn(x.created_at), x.actor_type ?? '', x.actor_id ?? '', x.action ?? '', x.target_type ?? '',
    x.target_id ?? '', jsonText(x.before_state), jsonText(x.after_state), x.reason ?? '',
  ]));

  add('13-gio-vang', '13 Giờ vàng', [
    'STT', 'Khu vực', 'Hoạt động thưởng', 'Trần badge', 'Badge đã cấp', 'Bắt đầu', 'Kết thúc dự kiến',
    'Người mở', 'Đóng lúc', 'Người đóng',
  ], golden.map((g, i) => [
    i + 1, ZONE.get(g.zone_id)?.name ?? '', cpName(g.bonus_checkpoint_id), num(g.badge_cap),
    num(g.badges_issued), vn(g.started_at), vn(g.ends_at), g.started_by ?? '', vn(g.closed_at), g.closed_by ?? '',
  ]));

  add('14-nhan-su-pg', '14 Nhân sự PG', ['Mã', 'Họ tên', 'SĐT', 'Vai trò', 'Tạo lúc'],
    staff.map((s) => [num(s.id), s.full_name, s.phone ?? '', lab('pg_role', s.role), vn(s.created_at)]));

  add('15-may-quet', '15 Máy quét', [
    'Mã máy', 'Nhãn', 'Vai trò máy', 'Khu vực', 'Nhân viên', 'Hoạt động được gán', 'Nhận máy lúc',
    'Đồng bộ lần cuối', 'Lượt chờ gửi lúc đồng bộ cuối', 'Pin (%)', 'Phiên bản app', 'Thu hồi lúc', 'Tạo lúc',
  ], devices.map((d) => [
    num(d.id), d.label ?? '', d.device_role ?? '', ZONE.get(d.zone_id)?.name ?? '', staffName(d.pg_staff_id),
    (deviceCps.get(d.id) ?? []).map((x) => cpName(x.checkpoint_id)).join('; '), vn(d.claimed_at),
    vn(d.last_sync_at), num(d.queue_depth), num(d.battery_pct), d.app_version ?? '', vn(d.revoked_at), vn(d.created_at),
  ]));

  add('16-doi-thi', '16 Đội thi', ['Mã đội', 'Tên đội', 'Số thành viên', 'Thành viên (Mã SV - Họ tên)', 'Tạo lúc'],
    teams.map((t) => {
      const m = regsByTeam.get(t.id) ?? [];
      return [t.team_code, t.name ?? '', m.length, m.map((r) => `${seq(r.student_id)} - ${stu(r.student_id).full_name ?? ''}`).join('; '), vn(t.created_at)];
    }));

  /* ---- tổng quan ---- */
  const count = (rows, pred) => rows.filter(pred).length;
  const S = [];
  const put = (k, v) => S.push([k, v]);
  put('Mã sự kiện', num(ev.id));
  put('Tên sự kiện', ev.name);
  put('Loại', lab('event_kind', ev.kind));
  put('Địa điểm', ev.venue_name ?? '');
  put('Thành phố', ev.city ?? '');
  put('Bắt đầu', vn(ev.starts_at));
  put('Kết thúc', vn(ev.ends_at));
  put('Cổng đăng ký', bool(ev.is_registration_open) ? 'Đang mở' : 'Đã đóng');
  put('Đã khoá sự kiện', yn(bool(ev.is_archived)));
  put('Tổng lượt đăng ký', regs.length);
  for (const [k, v] of Object.entries(LABEL.registration_type)) put(`Đăng ký: ${v}`, count(regs, (r) => r.type === k));
  for (const [k, v] of Object.entries(LABEL.registration_source)) put(`Nguồn: ${v}`, count(regs, (r) => r.source === k));
  put('Hồ sơ trùng đã gộp (vẫn tính trong tổng đăng ký)', count(regs, (r) => nz(stu(r.student_id).merged_into_id)));
  put('SV đồng ý chia sẻ cho nhà tài trợ', count(regs, (r) => nz(stu(r.student_id).consent_sponsors_at)));
  put('SV có ít nhất 1 badge (có mặt)', new Set(valid.map((a) => a.student_id)).size);
  put('Badge hợp lệ', valid.length);
  put('Badge đã huỷ', att.length - valid.length);
  put('Tổng lượt quét', ledger.length);
  for (const [k, v] of Object.entries(LABEL.scan_status)) put(`Lượt quét: ${v}`, count(ledger, (l) => l.status === k));
  put('Tổng lượt nhận quà', gifts.length);
  put('Số SV đã nhận quà', new Set(gifts.map((g) => g.student_id)).size);
  for (const t of tiers) put(`Nhận quà bậc ${t.tier} (${t.gift_name})`, count(gifts, (g) => g.gift_tier_id === t.id));
  put('Hoạt động đặc biệt', specials.length);
  put('Suất đặc biệt đã nhận', count(slots, (x) => nz(x.student_id)));
  put('Khảo sát', surveys.length);
  put('Lượt trả lời khảo sát', responses.length);
  put('Thư đã xếp', outbox.length);
  for (const [k, v] of Object.entries(LABEL.notification_status)) put(`Thư: ${v}`, count(outbox, (o) => o.status === k));
  put('Khu vực', zones.length);
  put('Hoạt động (điểm quét)', cps.length);
  put('Giờ vàng đã mở', golden.length);
  put('Nhân sự PG', staff.length);
  put('Máy quét', devices.length);
  put('Đội thi', teams.length);
  put('Lần chỉnh tay (nhật ký)', audit.length);
  put('Ghi chú', 'Giờ trong mọi file là giờ Việt Nam (UTC+7). "Check-in lúc" trống ở mọi sự kiện vì hệ thống đếm người có mặt theo badge, không dùng cột này.');
  sets.unshift({ file: '00-tong-quan', sheet: '00 Tổng quan', header: ['Chỉ số', 'Giá trị'], rows: S });
  return { sets, summary: S };
}

/* ----------------------------------------------------------------- chạy -- */

const wanted = flags.events ? new Set(flags.events.split(',').map((s) => s.trim())) : null;
const events = T.events.filter((e) => !wanted || wanted.has(e.id)).sort((a, b) => num(a.id) - num(b.id));
if (!events.length) { console.error('Không có sự kiện nào khớp --events'); process.exit(1); }
mkdirSync(OUT, { recursive: true });

const all = [];
for (const ev of events) {
  const { sets, summary } = buildEvent(ev);
  const date = vnDay(ev.starts_at).replace(/\//g, '-');
  const dir = `${p2(num(ev.id))}_${slug(ev.name)}_${date}`;
  mkdirSync(join(OUT, dir), { recursive: true });
  for (const s of sets) writeCsv(join(OUT, dir, `${s.file}.csv`), s.header, s.rows);
  writeFileSync(join(OUT, dir, `ATL2026_${dir}.xlsx`),
    buildWorkbook(sets.map((s) => ({ name: s.sheet, rows: [s.header, ...s.rows] }))));
  all.push({ ev, summary });
  console.log(`\n${dir}`);
  for (const s of sets) console.log(`  ${s.file}.csv`.padEnd(64) + String(s.rows.length).padStart(7) + ' dòng');
}

// Bảng tổng hợp: mỗi sự kiện một cột, chỉ số lấy theo thứ tự xuất hiện.
const keys = [];
for (const { summary } of all) for (const [k] of summary) if (!keys.includes(k) && k !== 'Ghi chú') keys.push(k);
writeCsv(join(OUT, 'TONG-HOP-CAC-SU-KIEN.csv'), ['Chỉ số', ...all.map(({ ev }) => ev.name)],
  keys.map((k) => [k, ...all.map(({ summary }) => summary.find(([x]) => x === k)?.[1] ?? '')]));
console.log(`\nXong: ${all.length} sự kiện → ${OUT}`);
