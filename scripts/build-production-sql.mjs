/**
 * Sinh hai file SQL dán-một-lần cho Supabase production:
 *
 *   supabase/production-init.sql  — toàn bộ migration 0001→hiện tại, đúng thứ tự
 *   supabase/production-seed.sql  — CHỈ dữ liệu nền production: trường, tỉnh,
 *                                   2 sự kiện (sinh ra ở trạng thái ĐÓNG đăng ký)
 *
 * Cố ý KHÔNG seed: zone, checkpoint, bậc quà, suất, PG, sinh viên — tất cả tạo
 * qua màn /admin (Layer B đã đóng). Chạy lại script này mỗi khi thêm migration:
 *   node scripts/build-production-sql.mjs
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { SCHOOLS, PROVINCES } from '../packages/db/src/seed-dev.js';
import { searchKey } from '../packages/vn-text/src/index.js';

const files = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();
const esc = (x) => x.replace(/'/g, "''");

const init = [
  `-- SINH TỰ ĐỘNG từ supabase/migrations (${files.length} file) — đừng sửa tay.`,
  `-- Tái sinh: node scripts/build-production-sql.mjs`,
  `-- Dán nguyên file vào Supabase SQL Editor và Run MỘT lần trên database MỚI.`,
  '',
  ...files.map((f) => `-- ═══════════ ${f} ═══════════\n${readFileSync(`supabase/migrations/${f}`, 'utf8')}`),
].join('\n');
writeFileSync('supabase/production-init.sql', init);

const seed = `-- SINH TỰ ĐỘNG — dữ liệu nền production. Dán sau production-init.sql.
-- Chỉ gồm: trường, tỉnh, 2 sự kiện (ĐÓNG đăng ký — mở bằng tab Vận hành).
-- Zone / checkpoint / bậc quà / suất / PG: tạo qua màn /admin, không seed.

insert into editions (id, year, name) values (1, 2026, 'Awaken The Lions 2026')
on conflict do nothing;

insert into events (id, edition_id, kind, slug, name, venue_name, city,
                    starts_at, ends_at, token_key_id, is_registration_open,
                    special_threshold_y)
values
  (1, 1, 'discovery_day', 'ha-noi', 'Discovery Day — Hà Nội',
   'ĐH Ngoại thương Hà Nội', 'Hà Nội',
   '2026-09-12 08:00+07', '2026-09-12 17:00+07', 'dd-2026', false, 6),
  (2, 1, 'discovery_day', 'ho-chi-minh', 'Discovery Day — TP.HCM',
   'ĐH Ngoại thương CS II', 'TP.HCM',
   '2026-09-12 08:00+07', '2026-09-12 17:00+07', 'dd-2026', false, 6)
on conflict do nothing;

${SCHOOLS.map((n) => `insert into ref_schools (name, search_key) values ('${esc(n)}', '${esc(searchKey(n))}') on conflict do nothing;`).join('\n')}

${PROVINCES.map(([c, n]) => `insert into ref_provinces (code, name, search_key) values ('${c}', '${esc(n)}', '${esc(searchKey(n))}') on conflict do nothing;`).join('\n')}

-- Kiểm nhanh sau khi chạy:
--   select id, name, is_registration_open from events;   → 2 dòng, đều false
--   select count(*) from ref_schools;                     → ${SCHOOLS.length}
--   select count(*) from ref_provinces;                   → ${PROVINCES.length}
`;
writeFileSync('supabase/production-seed.sql', seed);
console.log(`init: ${files.length} migration, ${(init.length / 1024).toFixed(0)} KB · seed: ${SCHOOLS.length} trường + ${PROVINCES.length} tỉnh + 2 sự kiện`);
