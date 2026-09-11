/**
 * Thẻ kết quả trên màn quét, TRƯỚC khi server trả lời — DIỄN TẬP 11/09.
 *
 * Dòng phụ cũ luôn là "badge thứ N+1": hứa một badge không tồn tại ở cổng
 * check-in và quầy đổi quà (sổ tay PG dặn "cổng không cấp badge, đừng hứa"
 * trong khi chính màn hình lại hứa), và đếm hụt ở hoạt động trọng số 3–4.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { localScanMeta, duplicateVerdict } from '../src/lib/scan-verdict.js';

const sv = { name: 'Trần Quốc Bảo', mssv: 'K62-0412', badge_count: 2 };

describe('localScanMeta — dòng phụ trên thẻ xanh', () => {
  test('gian hàng 1 badge: +1 và tổng mới', () => {
    assert.equal(
      localScanMeta({ counts_toward_badges: true, badge_weight: 1 }, sv),
      'K62-0412 · +1 badge → tổng 3');
  });

  test('hoạt động trọng số 4: cộng đúng 4, không phải "badge thứ 3"', () => {
    assert.equal(
      localScanMeta({ counts_toward_badges: true, badge_weight: 4 }, sv),
      'K62-0412 · +4 badge → tổng 6');
  });

  test('cổng check-in: KHÔNG hứa badge nào', () => {
    const m = localScanMeta({ kind: 'entrance', counts_toward_badges: false, badge_weight: 1 }, sv);
    assert.doesNotMatch(m, /\+\d|tổng/);
    assert.match(m, /không cộng badge/);
  });

  test('phiên máy nhận từ trước, thiếu trường mới: giữ hành vi cũ (1 badge)', () => {
    assert.equal(localScanMeta({}, sv), 'K62-0412 · +1 badge → tổng 3');
  });

  test('SV thiếu MSSV và chưa có số badge', () => {
    assert.equal(
      localScanMeta({ counts_toward_badges: true, badge_weight: 1 }, { name: 'A' }),
      '+1 badge → tổng 1');
  });
});

describe('duplicateVerdict — thẻ hổ phách khi quét trùng', () => {
  test('điểm có badge', () => {
    assert.equal(duplicateVerdict({ counts_toward_badges: true }), 'ĐÃ CÓ BADGE NÀY');
  });

  test('điểm không có badge thì không được nói "đã có badge"', () => {
    assert.equal(duplicateVerdict({ counts_toward_badges: false }), 'ĐÃ GHI NHẬN Ở ĐIỂM NÀY RỒI');
  });
});
