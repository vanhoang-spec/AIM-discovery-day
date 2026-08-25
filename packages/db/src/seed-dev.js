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
                        starts_at, ends_at, token_key_id, is_registration_open,
                        special_threshold_y)
    values
      (1, 1, 'discovery_day', 'ha-noi', 'Discovery Day — Hà Nội', 'ĐH Ngoại thương Hà Nội',
       'Hà Nội', '2026-09-12 08:00+07', '2026-09-12 17:00+07', 'dd-2026', true, 6),
      (2, 1, 'discovery_day', 'ho-chi-minh', 'Discovery Day — TP.HCM', 'ĐH Ngoại thương CS II',
       'TP.HCM', '2026-09-12 08:00+07', '2026-09-12 17:00+07', 'dd-2026', true, 6)
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

/**
 * Dev-only PG fixtures: zones, checkpoints, staff and three claimable devices.
 *
 * Without these the scanner cannot be exercised at all locally — there is no
 * code to claim and nowhere to award a badge. The claim codes are printed here
 * on purpose so a developer can type one straight into the app.
 *
 *   K7M3QX → PG-07, cổng check-in
 *   P4R8TW → PG-14, Finance zone
 *   B2C5DF → PG-22, Finance zone
 */
export async function seedPgDev(pg) {
  await pg.exec(`
    insert into zones (id, event_id, name, display_order) values
      (1, 1, 'Cổng vào', 0),
      (2, 1, 'Finance zone', 1),
      (3, 1, 'Living zone', 2)
    on conflict do nothing;

    insert into checkpoints (id, event_id, zone_id, kind, name, counts_toward_badges,
                             display_order) values
      (1, 1, 1, 'entrance',      'Cổng check-in',      true, 0),
      (2, 1, 2, 'sponsor_booth', 'Techcombank',        true, 1),
      (3, 1, 3, 'sponsor_booth', 'Vinamilk',           true, 2),
      -- 'bonus': counts on the gift ladder, NOT on the special ladder (0007).
      (4, 1, 1, 'bonus',         'Early Bird',         true, 9),
      -- A session checkpoint so dev data shows the two ladders diverging.
      (5, 1, 1, 'hall_session',  'Inspiration Talk',   true, 3)
    on conflict do nothing;

    insert into pg_staff (id, event_id, full_name, role) values
      (1, 1, 'Trần Minh', 'pg'),
      (2, 1, 'Lê Thị Hoa', 'pg'),
      (3, 1, 'Phạm Giám Sát', 'supervisor')
    on conflict do nothing;

    insert into pg_devices (id, event_id, claim_code, pg_staff_id, zone_id, label) values
      (1, 1, 'K7M3QX', 1, 1, 'PG-07'),
      (2, 1, 'P4R8TW', 2, 2, 'PG-14'),
      (3, 1, 'B2C5DF', 3, 2, 'PG-22')
    on conflict do nothing;

    update events
       set early_bird_until = now() + interval '12 hours',
           checkin_checkpoint_id = 1,
           early_bird_checkpoint_id = 4
     where id = 1 and checkin_checkpoint_id is null;
  `);
}

/**
 * A handful of students so the scanner has something to scan locally.
 *
 * Needed because each app gets its own in-memory PGlite in development: a
 * student registered through the web app does not exist in the PG app's
 * database. Point both at the same `DATABASE_URL` to exercise the real
 * cross-app flow.
 *
 * Their QR tokens are minted from seq 1001–1005 with the dev HMAC key.
 */
export async function seedStudentsDev(pg) {
  const people = [
    [1001, 'A00001', 'Nguyễn Thị Minh An', 'nguyen thi minh an', '0912345678', '2214810'],
    [1002, 'A00002', 'Trần Quốc Tuấn',     'tran quoc tuan',     '0987654321', '2214811'],
    [1003, 'A00003', 'Lê Hoàng Phương Uyên', 'le hoang phuong uyen', '0901112223', '2214812'],
    [1004, 'A00004', 'Nguyễn Văn An',      'nguyen van an',      '0933445566', '2214813'],
    [1005, 'A00005', 'Phạm Thị Bích',      'pham thi bich',      '0944556677', 'K58A1234'],
  ];
  for (const [seq, code, name, key, phone, mssv] of people) {
    const r = await pg.query(
      `insert into students (seq, lookup_code, full_name, name_search_key, email, phone,
                             school_id, student_code, consent_event_at)
       values ($1,$2,$3,$4,$5,$6,1,$7, now())
       on conflict do nothing returning id`,
      [seq, code, name, key, `sv${seq}@example.vn`, phone, mssv],
    );
    if (r.rows[0]) {
      await pg.query(
        `insert into registrations (student_id, event_id) values ($1, 1) on conflict do nothing`,
        [r.rows[0].id],
      );
    }
  }

  // The locked thresholds (§1.4): 2/5/7, y = 6 — so /toi shows a real ladder
  // in dev. Small stocks so the 'low'/'out' states are reachable by hand.
  await pg.exec(`
    insert into gift_tiers (event_id, tier, required_badges, gift_name, stock_total) values
      (1, 1, 2, 'Bút chì Cannes Lions', 30),
      (1, 2, 5, 'Sổ tay ATL2026',       10),
      (1, 3, 7, 'Áo thun Discovery Day', 5)
    on conflict do nothing;

    insert into special_activities (id, event_id, name, capacity, is_open)
    values (1, 1, 'Meet & Greet khách mời', 5, true)
    on conflict do nothing;

    insert into special_slots (event_id, special_activity_id, slot_no)
    select 1, 1, n from generate_series(1, 5) n
    on conflict do nothing;
  `);

  // Seeds insert explicit ids, which do NOT advance the serial sequences —
  // the first admin-created row would then collide with id 1. Bump every
  // sequence past its table's max. (Classic trap; hit for real on 26/08,
  // FOUR times now — the fourth was student_seq_counter below, which broke
  // every new dev registration once students 1001–1005 were seeded.)
  await pg.query(
    `select setval('student_seq_counter',
                   greatest((select coalesce(max(seq), 1000) from students), 1000) + 1,
                   false)`,
  );
  for (const table of ['ref_schools', 'zones', 'checkpoints', 'gift_tiers',
                       'special_activities', 'pg_staff', 'pg_devices', 'editions']) {
    await pg.query(
      `select setval(pg_get_serial_sequence($1, 'id'),
                     (select coalesce(max(id), 0) + 1 from ${table}), false)`,
      [table],
    );
  }
}
