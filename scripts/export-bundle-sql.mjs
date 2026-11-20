#!/usr/bin/env node
/**
 * Sinh câu SQL "gói gộp" để sao lưu TOÀN BỘ dữ liệu qua Supabase SQL Editor khi
 * không có mật khẩu database (20/11/2026). Mỗi câu chỉ SELECT, trả về vài chục
 * dòng (bang, phan, du_lieu): du_lieu là mảng JSON to_jsonb của tối đa 500 dòng
 * một bảng. Chạy trên SQL Editor → Export → Download CSV, rồi đưa file vào
 * scripts/export-event-csv.mjs. Bảng 0 dòng không sinh dòng nào (đối chiếu bằng
 * _so-dong.json).
 *
 *   node scripts/export-bundle-sql.mjs <thư-mục-ra>
 *
 * Tách 2 câu cho mỗi kết quả chỉ vài MB: phần 1 = ba bảng quét lớn, phần 2 = còn lại.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2];
if (!OUT) { console.error('Cách dùng: node scripts/export-bundle-sql.mjs <thư-mục-ra>'); process.exit(2); }

const PART1 = ['attendance', 'checkpoint_minute_counts', 'ledger_events'];
const PART2 = ['audit_log', 'checkpoints', 'editions', 'events', 'gift_redemptions', 'gift_tiers',
  'golden_hours', 'notification_outbox', 'pg_device_checkpoints', 'pg_devices', 'pg_staff',
  'ref_provinces', 'ref_schools', 'registrations', 'special_activities', 'special_slots',
  'students', 'survey_responses', 'surveys', 'teams', 'zones'];

const one = (t) => `select '${t}' as bang, (rn - 1) / 500 as phan, json_agg(j order by rn)::text as du_lieu
  from (select to_jsonb(x) as j, row_number() over () as rn from ${t} x) s group by (rn - 1) / 500`;
const sql = (tables) => `-- Chỉ đọc. Kết quả: mỗi dòng = tối đa 500 dòng của 1 bảng, dạng JSON.\n${tables.map(one).join('\nunion all\n')}\norder by bang, phan;\n`;

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'phan-1.sql'), sql(PART1));
writeFileSync(join(OUT, 'phan-2.sql'), sql(PART2));
console.log(`Đã ghi ${join(OUT, 'phan-1.sql')} (${PART1.length} bảng) và phan-2.sql (${PART2.length} bảng)`);
