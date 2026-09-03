-- SINH TỰ ĐỘNG — dữ liệu nền production. Dán sau production-init.sql.
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

insert into ref_schools (name, search_key) values ('Đại học Ngoại thương', 'dai hoc ngoai thuong') on conflict do nothing;
insert into ref_schools (name, search_key) values ('Đại học Công nghệ TP.HCM (HUTECH)', 'dai hoc cong nghe tp hcm hutech') on conflict do nothing;
insert into ref_schools (name, search_key) values ('Đại học Kinh tế - Tài chính TP.HCM (UEF)', 'dai hoc kinh te tai chinh tp hcm uef') on conflict do nothing;
insert into ref_schools (name, search_key) values ('Đại học Quốc tế Hồng Bàng', 'dai hoc quoc te hong bang') on conflict do nothing;
insert into ref_schools (name, search_key) values ('Đại học RMIT Việt Nam', 'dai hoc rmit viet nam') on conflict do nothing;
insert into ref_schools (name, search_key) values ('Học viện Ngoại giao', 'hoc vien ngoai giao') on conflict do nothing;
insert into ref_schools (name, search_key) values ('Học viện Công nghệ Bưu chính Viễn thông', 'hoc vien cong nghe buu chinh vien thong') on conflict do nothing;
insert into ref_schools (name, search_key) values ('Đại học KHXH&NV - ĐHQG TP.HCM', 'dai hoc khxh nv dhqg tp hcm') on conflict do nothing;
insert into ref_schools (name, search_key) values ('Đại học KHXH&NV - ĐHQG Hà Nội', 'dai hoc khxh nv dhqg ha noi') on conflict do nothing;
insert into ref_schools (name, search_key) values ('Đại học Kinh tế Quốc dân', 'dai hoc kinh te quoc dan') on conflict do nothing;
insert into ref_schools (name, search_key) values ('Đại học Bách khoa Hà Nội', 'dai hoc bach khoa ha noi') on conflict do nothing;
insert into ref_schools (name, search_key) values ('Đại học Kinh tế TP.HCM', 'dai hoc kinh te tp hcm') on conflict do nothing;
insert into ref_schools (name, search_key) values ('Đại học Tôn Đức Thắng', 'dai hoc ton duc thang') on conflict do nothing;
insert into ref_schools (name, search_key) values ('Đại học Văn Lang', 'dai hoc van lang') on conflict do nothing;
insert into ref_schools (name, search_key) values ('Đại học Hoa Sen', 'dai hoc hoa sen') on conflict do nothing;
insert into ref_schools (name, search_key) values ('Đại học FPT', 'dai hoc fpt') on conflict do nothing;
insert into ref_schools (name, search_key) values ('Đại học Thương mại', 'dai hoc thuong mai') on conflict do nothing;
insert into ref_schools (name, search_key) values ('Đại học Hà Nội', 'dai hoc ha noi') on conflict do nothing;
insert into ref_schools (name, search_key) values ('Học viện Báo chí và Tuyên truyền', 'hoc vien bao chi va tuyen truyen') on conflict do nothing;
insert into ref_schools (name, search_key) values ('Đại học Mở TP.HCM', 'dai hoc mo tp hcm') on conflict do nothing;
insert into ref_schools (name, search_key) values ('Đại học Sài Gòn', 'dai hoc sai gon') on conflict do nothing;
insert into ref_schools (name, search_key) values ('Đại học Công nghiệp TP.HCM', 'dai hoc cong nghiep tp hcm') on conflict do nothing;
insert into ref_schools (name, search_key) values ('Đại học Sư phạm Kỹ thuật TP.HCM', 'dai hoc su pham ky thuat tp hcm') on conflict do nothing;
insert into ref_schools (name, search_key) values ('Cao đẳng FPT Polytechnic', 'cao dang fpt polytechnic') on conflict do nothing;

insert into ref_provinces (code, name, search_key) values ('ha-noi', 'Hà Nội', 'ha noi') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('hai-phong', 'Hải Phòng', 'hai phong') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('da-nang', 'Đà Nẵng', 'da nang') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('hue', 'Huế', 'hue') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('tp-hcm', 'TP. Hồ Chí Minh', 'tp ho chi minh') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('can-tho', 'Cần Thơ', 'can tho') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('tuyen-quang', 'Tuyên Quang', 'tuyen quang') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('cao-bang', 'Cao Bằng', 'cao bang') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('lai-chau', 'Lai Châu', 'lai chau') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('lao-cai', 'Lào Cai', 'lao cai') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('dien-bien', 'Điện Biên', 'dien bien') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('son-la', 'Sơn La', 'son la') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('lang-son', 'Lạng Sơn', 'lang son') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('thai-nguyen', 'Thái Nguyên', 'thai nguyen') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('phu-tho', 'Phú Thọ', 'phu tho') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('bac-ninh', 'Bắc Ninh', 'bac ninh') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('quang-ninh', 'Quảng Ninh', 'quang ninh') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('hung-yen', 'Hưng Yên', 'hung yen') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('ninh-binh', 'Ninh Bình', 'ninh binh') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('thanh-hoa', 'Thanh Hoá', 'thanh hoa') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('nghe-an', 'Nghệ An', 'nghe an') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('ha-tinh', 'Hà Tĩnh', 'ha tinh') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('quang-tri', 'Quảng Trị', 'quang tri') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('quang-ngai', 'Quảng Ngãi', 'quang ngai') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('gia-lai', 'Gia Lai', 'gia lai') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('khanh-hoa', 'Khánh Hoà', 'khanh hoa') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('dak-lak', 'Đắk Lắk', 'dak lak') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('lam-dong', 'Lâm Đồng', 'lam dong') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('dong-nai', 'Đồng Nai', 'dong nai') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('tay-ninh', 'Tây Ninh', 'tay ninh') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('vinh-long', 'Vĩnh Long', 'vinh long') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('dong-thap', 'Đồng Tháp', 'dong thap') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('an-giang', 'An Giang', 'an giang') on conflict do nothing;
insert into ref_provinces (code, name, search_key) values ('ca-mau', 'Cà Mau', 'ca mau') on conflict do nothing;

-- Kiểm nhanh sau khi chạy:
--   select id, name, is_registration_open from events;   → 2 dòng, đều false
--   select count(*) from ref_schools;                     → 24
--   select count(*) from ref_provinces;                   → 34
