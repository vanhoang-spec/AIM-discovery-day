/**
 * Hằng số SQL dùng mà không import — sự cố đêm 11/09.
 *
 * /api/register ghép `${EVENT_NOT_ARCHIVED}` vào câu SQL nhưng quên import.
 * `next build` không bắt được: biến chưa khai báo trong JavaScript chỉ nổ lúc
 * chạy. Kết quả là MỌI lượt đăng ký trả 500 trong khoảng 25 phút, đúng tối trước
 * ngày sự kiện, và form chỉ nói "Mạng đang chập chờn".
 *
 * Luật ghim ở đây hẹp và rẻ: trong mã nguồn hai app, mọi hằng số VIẾT_HOA được
 * ghép vào template literal (`${TEN_HANG}`) phải được import hoặc khai báo ngay
 * trong file đó. Không cố làm một trình kiểm tra biến tổng quát — chỉ chặn đúng
 * lớp lỗi đã xảy ra, không báo sai.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SRC_DIRS = ['apps/web/src', 'apps/pg/src'].map((d) => join(ROOT, d));

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.js')) yield p;
  }
}

/** Tên được import hoặc khai báo trong file (đủ cho các mẫu dùng trong repo). */
function declaredNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (n) names.add(n);
    }
  }
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return names;
}

test('mọi ${HANG_SO} ghép vào template literal đều được import hoặc khai báo', () => {
  const problems = [];
  let checked = 0;
  for (const dir of SRC_DIRS) {
    for (const file of walk(dir)) {
      const src = readFileSync(file, 'utf8');
      const used = new Set([...src.matchAll(/\$\{\s*([A-Z][A-Z0-9_]{2,})\s*\}/g)].map((m) => m[1]));
      if (used.size === 0) continue;
      checked += 1;
      const known = declaredNames(src);
      for (const name of used) {
        if (!known.has(name)) problems.push(`${relative(ROOT, file)}: \${${name}} chưa import/khai báo`);
      }
    }
  }
  assert.ok(checked > 0, 'phải quét được ít nhất một file có hằng số SQL');
  assert.deepEqual(problems, []);
});

test('bài kiểm tự bắt được đúng lỗi đêm 11/09', () => {
  const broken = `
    import { getDb } from '@atl/db';
    const q = \`select 1 from events e where e.id = $1 and \${EVENT_NOT_ARCHIVED}\`;
  `;
  const used = [...broken.matchAll(/\$\{\s*([A-Z][A-Z0-9_]{2,})\s*\}/g)].map((m) => m[1]);
  const known = declaredNames(broken);
  assert.deepEqual(used.filter((n) => !known.has(n)), ['EVENT_NOT_ARCHIVED']);

  const fixed = `import { EVENT_NOT_ARCHIVED } from '@/lib/event-visibility';\n${broken}`;
  assert.deepEqual(used.filter((n) => !declaredNames(fixed).has(n)), []);
});
