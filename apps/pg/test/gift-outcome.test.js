/**
 * PHÁT trước, đưa sau — ảnh chụp DIỄN TẬP 11/09, 18:18.
 *
 * SV Lê Minh Kha đủ 9 badge. Màn hình hứa "Túi quà + Hộp bút", PG đưa cả hai
 * rồi mới bấm xác nhận, nhưng sổ chỉ ghi hộp bút. Quét lại thì máy — đúng theo
 * sổ — mời "TRAO THÊM Túi quà". Nay danh sách đưa cho SV đọc từ những dòng
 * server vừa ghi, và món dự định mà sổ không có phải được nói ra.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { grantOutcome } from '../src/lib/gift-plan.js';

const TUI = { id: 1, tier: 1, name: 'Túi quà' };
const BUT = { id: 2, tier: 2, name: 'Hộp bút Thiên Long' };

describe('grantOutcome — đưa món nào sau khi bấm PHÁT QUÀ', () => {
  test('ghi đủ cả hai: đưa cả hai, không thiếu gì', () => {
    const r = grantOutcome([TUI, BUT], [{ tier: 1, name: 'Túi quà' }, { tier: 2, name: 'Hộp bút Thiên Long' }], BUT);
    assert.deepEqual(r.give, ['Túi quà', 'Hộp bút Thiên Long']);
    assert.deepEqual(r.missing, []);
  });

  test('đúng ca 18:09: dự định túi + bút, sổ chỉ ghi bút → chỉ đưa bút, báo thiếu túi', () => {
    const r = grantOutcome([TUI, BUT], [{ tier: 2, name: 'Hộp bút Thiên Long' }], BUT);
    assert.deepEqual(r.give, ['Hộp bút Thiên Long']);
    assert.deepEqual(r.missing, ['Túi quà'], 'PG phải được dặn KHÔNG đưa túi');
  });

  test('SV đã có túi từ trước: dự định chỉ bút, ghi bút → không báo thiếu', () => {
    const r = grantOutcome([BUT], [{ tier: 2, name: 'Hộp bút Thiên Long' }], BUT);
    assert.deepEqual(r.give, ['Hộp bút Thiên Long']);
    assert.deepEqual(r.missing, []);
  });

  test('server không trả granted: chỉ tin bậc đích, mọi món khác coi như thiếu', () => {
    const r = grantOutcome([TUI, BUT], undefined, BUT);
    assert.deepEqual(r.give, ['Hộp bút Thiên Long']);
    assert.deepEqual(r.missing, ['Túi quà']);
  });

  test('granted rỗng cũng xử lý như không trả', () => {
    const r = grantOutcome([TUI], [], TUI);
    assert.deepEqual(r.give, ['Túi quà']);
    assert.deepEqual(r.missing, []);
  });
});
