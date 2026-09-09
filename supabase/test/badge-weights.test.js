/**
 * 0012 — badge có trọng số + điều kiện suất đặc biệt trên thang TỔNG.
 *
 * Nguồn luật: file "Planning by AIM" bản cuối 09/09/2026 — booth 1 badge,
 * Brief Day/Learning zone 4, Inspiration 3; "tối thiểu 10 badge" đếm trên
 * tổng có trọng số. Viết theo lối của nhà: khẳng định điều KHÔNG BAO GIỜ
 * được xảy ra — quét lại được cộng đôi trọng số, void trả nhầm 1 thay vì
 * trọng số, máy dò lệch la làng trên dữ liệu đúng, màn hình nói "đủ" mà
 * quầy từ chối.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', 'migrations');

let pg;
const uid = () => randomUUID();
const scan = async (student, checkpoint, source = 'pg_scan') =>
  (await pg.query(
    `select * from record_scan($1::uuid, 1::smallint, $2::bigint, $3::integer, $4::scan_source)`,
    [uid(), student, checkpoint, source],
  )).rows[0];

before(async () => {
  pg = new PGlite();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    try {
      await pg.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
    } catch (err) {
      throw new Error(`Migration ${file} failed: ${err.message}`);
    }
  }
  // Mô hình đúng kế hoạch HCM 12/09: cổng KHÔNG tính badge, 2 booth (1 điểm),
  // Brief Day (4), Inspiration (3). y = 10 — con số thật của AIM.
  await pg.exec(`
    insert into editions (id, year, name) values (1, 2026, 'ATL 2026');
    insert into events (id, edition_id, kind, slug, name, venue_name, city,
                        starts_at, ends_at, token_key_id, special_threshold_y,
                        special_claim_limit)
    values (1, 1, 'discovery_day', 'hcm', 'DD HCM', 'FTU HCM', 'HCM',
            '2026-09-12 08:00+07', '2026-09-12 17:00+07', 'k1', 10, 2);
    insert into zones (id, event_id, name) values (1, 1, 'Khu A');
    insert into checkpoints (id, event_id, zone_id, kind, name,
                             counts_toward_badges, badge_weight) values
      (1, 1, 1, 'entrance',      'Cổng',       false, 1),
      (2, 1, 1, 'sponsor_booth', 'Booth TGDD', true,  1),
      (3, 1, 1, 'sponsor_booth', 'Booth C2',   true,  1),
      (4, 1, 1, 'hall_session',  'Brief Day',  true,  4),
      (5, 1, 1, 'hall_session',  'Inspiration',true,  3);
    insert into students (id, seq, lookup_code, full_name, name_search_key, email,
                          consent_event_at)
    values (1, 101, 'AAAAA2', 'SV Một', 'sv mot', 'sv1@t.vn', now()),
           (2, 102, 'AAAAA3', 'SV Hai', 'sv hai', 'sv2@t.vn', now());
    insert into registrations (student_id, event_id) values (1, 1), (2, 1);
    insert into special_activities (id, event_id, name, capacity)
    values (1, 1, 'Meet & Greet', 5);
  `);
  await pg.query(`select ensure_special_slots(1)`);
});

const reg = async (sid = 1) =>
  (await pg.query(
    `select badge_count, core_badge_count from registrations
      where event_id = 1 and student_id = $1`, [sid])).rows[0];

describe('trọng số cộng vào thang tổng', () => {
  test('Brief Day (4) + booth (1) + Inspiration (3) = 8, không phải 3 lượt = 3', async () => {
    assert.equal((await scan(1, 4)).status, 'counted'); // Brief +4
    assert.equal((await scan(1, 2)).status, 'counted'); // booth +1
    const last = await scan(1, 5);                      // Inspiration +3
    assert.equal(last.status, 'counted');
    assert.equal(last.badge_count, 8, 'record_scan phải trả về tổng đã có trọng số');
    const r = await reg();
    assert.equal(r.badge_count, 8);
    // Thang lõi vẫn đếm MỐC: chỉ booth (cổng tắt cờ) — 1 mốc, không phải 1 điểm/badge.
    assert.equal(r.core_badge_count, 1);
  });

  test('cổng tắt cờ tính badge: quét được ghi nhận nhưng tổng đứng yên', async () => {
    const before = (await reg()).badge_count;
    assert.equal((await scan(1, 1)).status, 'counted');
    assert.equal((await reg()).badge_count, before, 'cờ counts_toward_badges=false phải thắng trọng số');
  });

  test('quét lại mốc trọng số 4 KHÔNG cộng thêm 4 lần nữa', async () => {
    const before = (await reg()).badge_count;
    const again = await scan(1, 4);
    assert.equal(again.status, 'repeat_not_counted');
    assert.equal((await reg()).badge_count, before, 'chống trùng nằm ở attendance, trọng số không được xuyên qua');
  });

  test('máy dò lệch im lặng trên dữ liệu đúng, và bắt được khi bộ đếm bị sửa tay', async () => {
    assert.equal((await pg.query(`select * from v_progress_drift`)).rows.length, 0);
    await pg.exec(`alter table registrations disable trigger all;
                   update registrations set badge_count = 99 where student_id = 1;
                   alter table registrations enable trigger all;`);
    const drift = (await pg.query(`select * from v_progress_drift where student_id = 1`)).rows;
    assert.equal(drift.length, 1);
    assert.equal(Number(drift[0].real_count), 8, 'sự thật từ ledger phải là tổng trọng số');
    await pg.query(`select rebuild_student_progress(1::smallint, 1::bigint)`);
    assert.equal((await reg()).badge_count, 8, 'rebuild phải trả về đúng tổng trọng số');
  });

  test('void một mốc trọng số 4 trừ đúng 4, không phải 1', async () => {
    await pg.query(`select void_attendance(1::smallint, 1::bigint, 4, 'test', 'trao nhầm')`);
    assert.equal((await reg()).badge_count, 4, '8 − Brief(4) = 4');
    // Trao lại để các test sau giữ nguyên trạng thái 8.
    assert.equal((await scan(1, 4, 'admin_manual')).status, 'counted');
    assert.equal((await reg()).badge_count, 8);
  });
});

describe('suất đặc biệt xét thang TỔNG (chốt AIM 09/09)', () => {
  test('SV đạt 10 nhờ trọng số dù thang lõi chỉ có 2 — quầy phải cho vào', async () => {
    // SV1 đang có 8 (booth1 + Brief4 + Insp3). Thêm booth C2 → 9: chưa đủ.
    assert.equal((await scan(1, 3)).status, 'counted');
    let hold = (await pg.query(
      `select * from hold_special_slot(1::smallint, 1::bigint, 1)`)).rows[0];
    assert.equal(hold.result, 'not_eligible', '9 < 10 phải bị từ chối sạch');
    // Trao lại Brief cho SV2 để chứng minh đường đạt: SV2 = Brief4+Insp3+2 booth = 9? — không:
    // SV2 lấy đủ: Brief(4)+Insp(3)+TGDD(1)+C2(1) = 9 <10 — thiếu thật theo kế hoạch AIM
    // (max HCM 25 tính cả 7 booth). Ở fixture rút gọn, nâng SV1 bằng void-reaward không được —
    // dùng admin_manual thêm 1 booth nữa qua checkpoint mới weight 1.
    await pg.exec(`insert into checkpoints (id, event_id, zone_id, kind, name,
                                            counts_toward_badges, badge_weight)
                   values (6, 1, 1, 'sponsor_booth', 'Booth Vifon', true, 1)`);
    assert.equal((await scan(1, 6)).status, 'counted');            // 9 + 1 = 10
    hold = (await pg.query(
      `select * from hold_special_slot(1::smallint, 1::bigint, 1)`)).rows[0];
    assert.equal(hold.result, 'held', 'đủ 10 trên thang tổng phải được giữ chỗ');
    const r = await reg();
    assert.equal(r.badge_count, 10);
    assert.ok(r.core_badge_count < 10, 'bằng chứng: thang lõi KHÔNG thể đạt 10 — nếu hold còn xét lõi thì test này đỏ');
  });

  test('/toi và quầy nói cùng một câu: eligible của control panel đếm thang tổng', async () => {
    const panel = (await pg.query(
      `select students_eligible from v_special_control_panel where special_activity_id = 1`)).rows[0];
    assert.equal(Number(panel.students_eligible), 1, 'chỉ SV1 (10 badge tổng) đủ điều kiện');
  });

  test('chuông ngưỡng: y cao hơn tổng khả dụng thì reo, không thì im', async () => {
    let tc = (await pg.query(
      `select * from v_special_threshold_check where event_id = 1`)).rows[0];
    // Khả dụng: booth 1+1+1 + Brief 4 + Insp 3 = 10 = y → không reo.
    assert.equal(Number(tc.available_total), 10);
    assert.equal(tc.mismatch, false);
    await pg.exec(`update events set special_threshold_y = 11 where id = 1`);
    tc = (await pg.query(
      `select * from v_special_threshold_check where event_id = 1`)).rows[0];
    assert.equal(tc.mismatch, true, 'y=11 > khả dụng 10: không ai đạt nổi — phải reo');
    await pg.exec(`update events set special_threshold_y = 10 where id = 1`);
  });
});
