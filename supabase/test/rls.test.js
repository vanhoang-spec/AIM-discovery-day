/**
 * 0017 — RLS + thu quyền anon / authenticated (vá bảo mật 26/11/2026).
 *
 * Dựng database như Supabase thật: có role anon / authenticated và default
 * privileges cấp sẵn cho hai role đó trên mọi bảng / sequence / function mới
 * trong public — đúng thứ khiến REST API của Supabase mở mọi bảng. Rồi áp toàn
 * bộ migration và khẳng định điều không được xảy ra: anon / authenticated không
 * đọc, không ghi, không gọi được gì; chủ bảng (app) vẫn chạy.
 *
 * Bài "mọi bảng có RLS" chạy trên TOÀN BỘ migration hiện có, nên một migration
 * sau này tạo bảng mà quên `enable row level security` sẽ fail ở đây.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', 'migrations');
const FILES = readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort();
const CLIENT_ROLES = ['anon', 'authenticated'];

let db;

/** Giống Supabase: role client + default privileges cấp hết cho chúng. */
const SUPABASE_LIKE = `
  create role anon nologin;
  create role authenticated nologin;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
`;

before(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_LIKE);
  for (const f of FILES) await db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  await db.exec(`
    insert into editions (id, year, name) values (1, 2026, 'ATL 2026');
    insert into events (id, edition_id, kind, slug, name, venue_name, city, starts_at, ends_at, token_key_id)
    values (1, 1, 'discovery_day', 'hn', 'DD HN', 'FTU HN', 'HN',
            '2026-09-12 08:00+07', '2026-09-12 17:00+07', 'k1');
    insert into students (seq, lookup_code, full_name, name_search_key, email, phone, student_code, consent_event_at)
    values (1001, 'A00001', 'Nguyễn Thị Minh An', 'nguyen thi minh an', 'an@example.vn', '0912345678', '2214810', now());
  `);
});

const rows = async (sql, params) => (await db.query(sql, params)).rows;

describe('0017 — RLS', () => {
  test('0017 là migration cuối và file vá production là đúng nó', () => {
    assert.ok(FILES.includes('0017_rls_lockdown.sql'));
    const patch = readFileSync(join(HERE, '..', `production-patch-${FILES.at(-1).slice(0, 4)}.sql`), 'utf8');
    assert.ok(patch.includes(readFileSync(join(MIGRATIONS, FILES.at(-1)), 'utf8')),
      'production-patch chưa sinh lại — chạy node scripts/build-production-sql.mjs');
  });

  test('MỌI bảng trong public bật RLS (relrowsecurity = true)', async () => {
    const all = await rows(`select relname from pg_class
                             where relnamespace = 'public'::regnamespace and relkind in ('r', 'p')`);
    assert.ok(all.length >= 20, `chỉ thấy ${all.length} bảng — sai schema?`);
    const off = await rows(`select relname from pg_class
                             where relnamespace = 'public'::regnamespace and relkind in ('r', 'p')
                               and not relrowsecurity order by relname`);
    assert.deepEqual(off.map((r) => r.relname), [],
      'bảng mới phải `alter table … enable row level security` trong cùng migration');
  });

  test('KHÔNG FORCE: chủ bảng vẫn bỏ qua RLS', async () => {
    const forced = await rows(`select relname from pg_class
                                where relnamespace = 'public'::regnamespace and relforcerowsecurity`);
    assert.deepEqual(forced.map((r) => r.relname), []);
  });

  test('chủ bảng KHÔNG phải superuser vẫn đọc được dữ liệu (như app trên Supabase)', async () => {
    await db.exec(`create role atl_owner nologin; alter table students owner to atl_owner;`);
    try {
      await db.exec(`set role atl_owner`);
      const r = await rows(`select full_name from students where seq = 1001`);
      assert.equal(r.length, 1);
      assert.equal(r[0].full_name, 'Nguyễn Thị Minh An');
    } finally {
      await db.exec(`reset role; alter table students owner to current_user; drop role atl_owner;`);
    }
  });
});

describe('0017 — anon / authenticated không còn quyền gì', () => {
  for (const role of CLIENT_ROLES) {
    test(`${role}: không quyền trên bảng / view nào`, async () => {
      const leaks = await rows(
        `select c.relname from pg_class c
          where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
            and has_table_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')`,
        [role]);
      assert.deepEqual(leaks.map((r) => r.relname), []);
    });

    test(`${role}: không quyền trên sequence nào`, async () => {
      const leaks = await rows(
        `select c.relname from pg_class c
          where c.relnamespace = 'public'::regnamespace
            -- CASE: planner có thể gọi hàm trước khi lọc relkind (toast…).
            and case when c.relkind = 'S'
                     then has_sequence_privilege($1, c.oid, 'USAGE, SELECT, UPDATE') end`,
        [role]);
      assert.deepEqual(leaks.map((r) => r.relname), []);
    });

    test(`${role}: không gọi được function nào (kể cả qua PUBLIC)`, async () => {
      const all = await rows(`select count(*)::int n from pg_proc where pronamespace = 'public'::regnamespace`);
      assert.ok(all[0].n >= 10);
      const leaks = await rows(
        `select p.oid::regprocedure::text fn from pg_proc p
          where p.pronamespace = 'public'::regnamespace
            and has_function_privilege($1, p.oid, 'EXECUTE')`,
        [role]);
      assert.deepEqual(leaks.map((r) => r.fn), []);
    });
  }

  test('anon thử đọc / ghi / gọi RPC thật sự → permission denied', async () => {
    await db.exec(`set role anon`);
    try {
      await assert.rejects(db.query(`select * from students`), /permission denied/);
      await assert.rejects(db.query(`update students set full_name = 'x'`), /permission denied/);
      await assert.rejects(db.query(`select * from attendance`), /permission denied/);
      await assert.rejects(
        db.query(`select * from register_student(
          1::smallint, 'Kẻ Xấu', 'x@x.vn', '0900000000', null, null, 'X1', null, null, null, null, null,
          'general'::registration_type, 'online'::registration_source, true, false, null, 'v1', null)`),
        /permission denied/);
    } finally {
      await db.exec(`reset role`);
    }
  });

  test('bảng / sequence / function TẠO SAU 0017 cũng không tự cấp cho anon / authenticated', async () => {
    await db.exec(`
      create table zz_after_0017 (id bigserial primary key, note text);
      create function zz_after_0017_fn() returns int language sql as 'select 1';
    `);
    try {
      for (const role of CLIENT_ROLES) {
        const [t] = await rows(
          `select has_table_privilege($1, 'zz_after_0017', 'SELECT, INSERT, UPDATE, DELETE') t,
                  has_sequence_privilege($1, 'zz_after_0017_id_seq', 'USAGE, SELECT, UPDATE') s,
                  has_function_privilege($1, 'zz_after_0017_fn()', 'EXECUTE') f`,
          [role]);
        assert.deepEqual(t, { t: false, s: false, f: false }, role);
      }
    } finally {
      await db.exec(`drop function zz_after_0017_fn(); drop table zz_after_0017;`);
    }
  });

  test('chạy lại 0017 lần hai không lỗi (dán nhầm hai lần vẫn an toàn)', async () => {
    await db.exec(readFileSync(join(MIGRATIONS, '0017_rls_lockdown.sql'), 'utf8'));
  });
});

describe('0017 trên database KHÔNG có role anon (PGlite thuần, dev)', () => {
  test('áp toàn bộ migration không lỗi và vẫn bật RLS', async () => {
    const plain = new PGlite();
    for (const f of FILES) await plain.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
    const off = (await plain.query(`select count(*)::int n from pg_class
      where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') and not relrowsecurity`)).rows[0].n;
    assert.equal(off, 0);
  });
});
