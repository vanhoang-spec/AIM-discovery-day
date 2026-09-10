/**
 * Một thang duy nhất — lint tĩnh sinh từ sự cố 10/09.
 *
 * Anh Hoàng gửi hai ảnh chụp CÙNG một sinh viên, CÙNG một lúc: app SV nói
 * "Đủ điều kiện — tới quầy đăng ký", máy PG ở quầy suất nói "Chưa đủ điều
 * kiện". Không phải lỗi đồng bộ: SV có 10 badge tổng nhưng chỉ 5 hoạt động
 * lõi. Migration 0012 đã chuyển `hold_special_slot` sang thang TỔNG theo chốt
 * của AIM, `/api/toi` đi theo, còn `/api/pg/special` bị bỏ quên và vẫn so
 * `core_badge_count >= y`.
 *
 * Hậu quả thật, không phải thẩm mỹ: PG đọc dòng "chưa đủ" rồi không bấm giữ
 * chỗ, nên sinh viên ĐỦ ĐIỀU KIỆN bị từ chối ngay tại quầy — trong khi database
 * sẵn sàng cấp suất.
 *
 * `core_badge_count` vẫn được duy trì trong DB (báo cáo nhà tài trợ đếm lượt
 * ghé cổng + gian hàng), nên không thể xoá cột. Thứ phải cấm là dùng nó để
 * QUYẾT ĐỊNH quyền lợi. Lint này canh đúng ranh giới đó.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, globSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FILES = [
  ...globSync('apps/web/src/**/*.js', { cwd: ROOT }),
  ...globSync('apps/pg/src/**/*.js', { cwd: ROOT }),
].map((f) => join(ROOT, f));

/** Nơi được phép đọc thang lõi: xuất dữ liệu cho nhà tài trợ. */
const ALLOWED = ['api/admin/export/route.js'];

/** Bỏ chú thích — các comment giải thích chính sự cố này có quyền gọi tên cột. */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('một thang badge duy nhất (sự cố quầy suất 10/09)', () => {
  test('không nơi nào so sánh core_badge_count để xét điều kiện', () => {
    // Bắt `core_badge_count >= y`, `y <= core_badge_count`, `... < ngưỡng` —
    // mọi phép so sánh, dù ở JS hay trong chuỗi SQL.
    const bad = [];
    for (const f of FILES) {
      const src = stripComments(readFileSync(f, 'utf8'));
      for (const m of src.matchAll(/core_badge_count\s*(>=|<=|>|<|===|==)|(>=|<=|>|<|===|==)\s*[\w.]*core_badge_count/g)) {
        const line = src.slice(0, m.index).split('\n').length;
        bad.push(`${f.replace(ROOT, '.')}:${line} — ${m[0].trim()}`);
      }
    }
    assert.deepEqual(bad, [], '\nDùng badge_count (thang tổng) để xét quyền lợi:\n' + bad.join('\n'));
  });

  test('không màn hình nào giải thích ngưỡng bằng "hoạt động (cổng + gian hàng)"', () => {
    // Chữ cũng là một dạng sai: PG đọc "thang này đếm hoạt động" rồi kết luận
    // sinh viên chưa đủ, dù con số quyết định là badge tổng.
    const bad = [];
    for (const f of FILES) {
      const src = readFileSync(f, 'utf8');
      if (/thang\s+core|\(cổng\s*\+\s*gian hàng\)|\(cổng\s*\+\s*booth\)/i.test(src)) {
        bad.push(f.replace(ROOT, '.'));
      }
    }
    assert.deepEqual(bad, [], '\nCòn mô tả ngưỡng theo thang lõi:\n' + bad.join('\n'));
  });

  test('core_badge_count chỉ còn xuất hiện ở nơi được phép', () => {
    const offenders = FILES
      .filter((f) => stripComments(readFileSync(f, 'utf8')).includes('core_badge_count'))
      .map((f) => f.replace(ROOT, '.').replace(/\\/g, '/'))
      .filter((f) => !ALLOWED.some((a) => f.includes(a)));
    assert.deepEqual(offenders, [],
      '\ncore_badge_count chỉ dành cho báo cáo NTT; mọi quyền lợi xét trên badge_count:\n'
      + offenders.join('\n'));
  });

  test('lint bắt được đúng mẫu lỗi gốc', () => {
    const original = 'eligible: student.core_badge_count >= y,';
    assert.ok(/core_badge_count\s*(>=|<=|>|<|===|==)/.test(original),
      'phải phát hiện phép so sánh trên thang lõi');
  });
});
