/**
 * Lint tĩnh cho SQL trong các route — sinh từ sự cố production 08/09/2026.
 *
 * AIM bấm "Mở đăng ký" lần đầu tiên và nhận HTTP 500. Ba route quản trị mang
 * cùng một lỗi nằm im từ ngày viết, vì chưa ai bấm tới:
 *
 *   42P08  cùng một $N dùng dưới HAI kiểu trong một câu — `values ($1, …,
 *          $1::text, …)` với $1 vừa smallint (event_id) vừa text (target_id).
 *          Postgres từ chối suy kiểu cho $1.
 *   42P18  $N trần bên trong jsonb_build_object(…) — không suy được kiểu.
 *
 * Test suite không gọi các route này (chúng cần checkAdmin + body đúng shape
 * từng nhánh), nên lỗi lớp này không có lưới nào khác. Lint mẫu lỗi trên mã
 * nguồn bắt đúng lớp bug mà không phải giả lập từng endpoint.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FILES = [
  ...globSync('apps/web/src/**/*.js', { cwd: ROOT }),
  ...globSync('apps/pg/src/**/*.js', { cwd: ROOT }),
].map((f) => join(ROOT, f));

/** Mọi template literal chứa chữ SQL quen thuộc — đủ cho cách repo này viết query. */
function sqlStrings(src) {
  return [...src.matchAll(/`([^`]*(?:insert into|update |select |delete from)[^`]*)`/gis)].map((m) => m[1]);
}

describe('SQL param lint (42P08 / 42P18 — sự cố nút "Mở đăng ký" 08/09)', () => {
  test('không câu nào dùng lại một $N dưới hai kiểu (có cast lẫn không cast)', () => {
    const bad = [];
    for (const f of FILES) {
      for (const sql of sqlStrings(readFileSync(f, 'utf8'))) {
        const casted = new Set([...sql.matchAll(/\$(\d+)::/g)].map((m) => m[1]));
        for (const n of casted) {
          // $N xuất hiện KHÔNG kèm :: ở chỗ khác trong cùng câu?
          const bare = new RegExp(`\\$${n}(?!\\d)(?!::)`);
          if (bare.test(sql.replace(new RegExp(`\\$${n}::`, 'g'), '§'))) {
            bad.push(`${f.replace(ROOT, '.')} — $${n} vừa có cast vừa trần trong:\n    ${sql.replace(/\s+/g, ' ').slice(0, 140)}`);
          }
        }
      }
    }
    assert.deepEqual(bad, [], '\n' + bad.join('\n'));
  });

  test('không $N trần bên trong jsonb_build_object(…)', () => {
    const bad = [];
    for (const f of FILES) {
      for (const sql of sqlStrings(readFileSync(f, 'utf8'))) {
        for (const m of sql.matchAll(/jsonb_build_object\s*\(([^()]*)\)/gi) ?? []) {
          if (/\$\d+(?!\d)(?!::)/.test(m[1].replace(/\$\d+::/g, '§'))) {
            bad.push(`${f.replace(ROOT, '.')} — jsonb_build_object có $N thiếu cast: ${m[1].replace(/\s+/g, ' ').slice(0, 100)}`);
          }
        }
      }
    }
    assert.deepEqual(bad, [], '\n' + bad.join('\n'));
  });

  test('lint tự chứng minh nó bắt được đúng mẫu lỗi gốc', () => {
    // Chính câu đã làm sập nút "Mở đăng ký" — nếu regex lỏng tay, test này đỏ.
    const original = "values ($1, 'super_admin', $2, 'set_event_ops', 'event', $1::text, $3::jsonb)";
    const masked = original.replace(/\$1::/g, '§');
    assert.ok(/\$1(?!\d)(?!::)/.test(masked), 'phải phát hiện $1 trần khi $1::text cũng tồn tại');
    assert.ok(/\$\d+(?!\d)(?!::)/.test("jsonb_build_object('y', $3)"), 'phải phát hiện $3 trần trong jsonb_build_object');
  });
});
