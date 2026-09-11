/**
 * Khoá sự kiện (0015) — chạy trên schema thật, trước VÀ sau khi có cột.
 *
 * Điều kiện lọc được viết qua to_jsonb(e) để bản deploy chạy được trước khi
 * migration được áp. Nếu ai đó "dọn gọn" nó thành `not e.is_archived`, bài
 * đầu tiên đỏ ngay — và đó đúng là cái lỗi sẽ làm /api/refdata trả 500 trên
 * production trong khoảng giữa deploy và lúc chạy SQL.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { EVENT_NOT_ARCHIVED, EVENT_IS_ARCHIVED_COL } from '../src/lib/event-visibility.js';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'supabase', 'migrations');
const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();

const visibleIds = async (db) => (await db.query(
  `select e.id from events e where ${EVENT_NOT_ARCHIVED} order by e.id`)).rows.map((r) => r.id);

async function seed(db) {
  await db.exec(`
    insert into editions (id, year, name) values (1, 2026, 'ATL 2026');
    insert into events (id, edition_id, kind, slug, name, venue_name, city, starts_at, ends_at, token_key_id)
    values (1, 1, 'discovery_day', 'hn',  'Discovery Day — Hà Nội', 'FTU HN',  'HN',
            '2026-09-12 08:00+07', '2026-09-12 17:00+07', 'k1'),
           (2, 1, 'discovery_day', 'hcm', 'Discovery Day — TP.HCM', 'FTU HCM', 'HCM',
            '2026-09-12 08:00+07', '2026-09-12 17:00+07', 'k1'),
           (3, 1, 'discovery_day', 'dien-tap', 'DIỄN TẬP — không phải sự kiện thật', 'FTU HN', 'HN',
            '2026-09-10 08:00+07', '2026-09-10 17:00+07', 'k1');
  `);
}

describe('EVENT_NOT_ARCHIVED — trước khi áp 0015', () => {
  let db;
  before(async () => {
    db = new PGlite();
    for (const f of files.filter((x) => x < '0015')) await db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
    await seed(db);
  });

  test('cột chưa có: truy vấn KHÔNG lỗi, và chưa sự kiện nào bị ẩn', async () => {
    assert.deepEqual(await visibleIds(db), [1, 2, 3]);
  });

  test('cột đọc ra được, mặc định là chưa khoá', async () => {
    const r = (await db.query(`select e.id, ${EVENT_IS_ARCHIVED_COL} from events e order by e.id`)).rows;
    assert.deepEqual(r.map((x) => x.is_archived), [false, false, false]);
  });
});

describe('EVENT_NOT_ARCHIVED — sau khi áp 0015 và khoá DIỄN TẬP', () => {
  let db;
  before(async () => {
    db = new PGlite();
    for (const f of files) await db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
    await seed(db);
  });

  test('mọi sự kiện mặc định chưa khoá', async () => {
    assert.deepEqual(await visibleIds(db), [1, 2, 3]);
  });

  test('khoá DIỄN TẬP: chỉ còn Hà Nội và TP.HCM', async () => {
    await db.exec(`update events set is_archived = true where id = 3`);
    assert.deepEqual(await visibleIds(db), [1, 2]);
    const r = (await db.query(`select e.id, ${EVENT_IS_ARCHIVED_COL} from events e order by e.id`)).rows;
    assert.deepEqual(r.map((x) => x.is_archived), [false, false, true]);
  });

  test('đóng đăng ký online KHÔNG làm sự kiện bị ẩn — hai ý nghĩa riêng', async () => {
    await db.exec(`update events set is_registration_open = false where id in (1, 2)`);
    assert.deepEqual(await visibleIds(db), [1, 2]);
  });

  test('áp lại 0015 lần hai không lỗi, không đổi cờ đã đặt', async () => {
    const f = files.find((x) => x.startsWith('0015'));
    await db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
    assert.deepEqual(await visibleIds(db), [1, 2]);
  });
});
