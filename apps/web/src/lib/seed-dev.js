/**
 * Development seed: the two Discovery Day events plus reference data.
 *
 * The school and province lists are REAL content the form depends on. Schools
 * here are the target schools named in the agency brief plus common Hà Nội /
 * TP.HCM universities — AIM extends the list in admin, and "Trường khác" (free
 * text) catches the rest, so an incomplete list degrades to a text field, never
 * to a blocked registration.
 *
 * Provinces follow the 34-unit list in force since the 2025 administrative
 * merger. ⚠️ Verify against the official list before production seed — codes
 * are stable slugs so a rename later never rewrites student rows.
 */

import { searchKey } from '@atl/vn-text';

const SCHOOLS = [
  'Đại học Ngoại thương',
  'Đại học Công nghệ TP.HCM (HUTECH)',
  'Đại học Kinh tế - Tài chính TP.HCM (UEF)',
  'Đại học Quốc tế Hồng Bàng',
  'Đại học RMIT Việt Nam',
  'Học viện Ngoại giao',
  'Học viện Công nghệ Bưu chính Viễn thông',
  'Đại học KHXH&NV - ĐHQG TP.HCM',
  'Đại học KHXH&NV - ĐHQG Hà Nội',
  'Đại học Kinh tế Quốc dân',
  'Đại học Bách khoa Hà Nội',
  'Đại học Kinh tế TP.HCM',
  'Đại học Tôn Đức Thắng',
  'Đại học Văn Lang',
  'Đại học Hoa Sen',
  'Đại học FPT',
  'Đại học Thương mại',
  'Đại học Hà Nội',
  'Học viện Báo chí và Tuyên truyền',
  'Đại học Mở TP.HCM',
  'Đại học Sài Gòn',
  'Đại học Công nghiệp TP.HCM',
  'Đại học Sư phạm Kỹ thuật TP.HCM',
  'Cao đẳng FPT Polytechnic',
];

const PROVINCES = [
  ['ha-noi', 'Hà Nội'], ['hai-phong', 'Hải Phòng'], ['da-nang', 'Đà Nẵng'],
  ['hue', 'Huế'], ['tp-hcm', 'TP. Hồ Chí Minh'], ['can-tho', 'Cần Thơ'],
  ['tuyen-quang', 'Tuyên Quang'], ['cao-bang', 'Cao Bằng'], ['lai-chau', 'Lai Châu'],
  ['lao-cai', 'Lào Cai'], ['dien-bien', 'Điện Biên'], ['son-la', 'Sơn La'],
  ['lang-son', 'Lạng Sơn'], ['thai-nguyen', 'Thái Nguyên'], ['phu-tho', 'Phú Thọ'],
  ['bac-ninh', 'Bắc Ninh'], ['quang-ninh', 'Quảng Ninh'], ['hung-yen', 'Hưng Yên'],
  ['ninh-binh', 'Ninh Bình'], ['thanh-hoa', 'Thanh Hoá'], ['nghe-an', 'Nghệ An'],
  ['ha-tinh', 'Hà Tĩnh'], ['quang-tri', 'Quảng Trị'], ['quang-ngai', 'Quảng Ngãi'],
  ['gia-lai', 'Gia Lai'], ['khanh-hoa', 'Khánh Hoà'], ['dak-lak', 'Đắk Lắk'],
  ['lam-dong', 'Lâm Đồng'], ['dong-nai', 'Đồng Nai'], ['tay-ninh', 'Tây Ninh'],
  ['vinh-long', 'Vĩnh Long'], ['dong-thap', 'Đồng Tháp'], ['an-giang', 'An Giang'],
  ['ca-mau', 'Cà Mau'],
];

export async function seedDev(pg) {
  await pg.exec(`
    insert into editions (id, year, name) values (1, 2026, 'Awaken The Lions 2026')
    on conflict do nothing;

    insert into events (id, edition_id, kind, slug, name, venue_name, city,
                        starts_at, ends_at, token_key_id, is_registration_open)
    values
      (1, 1, 'discovery_day', 'ha-noi', 'Discovery Day — Hà Nội', 'ĐH Ngoại thương Hà Nội',
       'Hà Nội', '2026-09-12 08:00+07', '2026-09-12 17:00+07', 'dd-2026', true),
      (2, 1, 'discovery_day', 'ho-chi-minh', 'Discovery Day — TP.HCM', 'ĐH Ngoại thương CS II',
       'TP.HCM', '2026-09-12 08:00+07', '2026-09-12 17:00+07', 'dd-2026', true)
    on conflict do nothing;
  `);

  for (const name of SCHOOLS) {
    await pg.query(
      `insert into ref_schools (name, search_key) values ($1, $2) on conflict do nothing`,
      [name, searchKey(name)],
    );
  }
  for (const [code, name] of PROVINCES) {
    await pg.query(
      `insert into ref_provinces (code, name, search_key) values ($1, $2, $3)
       on conflict do nothing`,
      [code, name, searchKey(name)],
    );
  }
}
