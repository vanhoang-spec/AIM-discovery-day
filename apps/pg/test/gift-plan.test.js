/**
 * Quy định đổi quà của AIM (10/09), viết thành bài kiểm.
 *
 * Bàn quà có đúng hai vật thể: một chồng TÚI (bậc 1, ngưỡng 7) và một thùng
 * HỘP BÚT (bậc 2, ngưỡng 9). Cột `hand` của mỗi bài chính là câu hỏi thật ở
 * quầy: PG phải cầm món nào lên lần này?
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { giftPlan, itemNames } from '../src/lib/gift-plan.js';

const TUI = { id: 1, tier: 1, name: 'Túi quà', required: 7, stock: 'ok', left: null };
const BUT = { id: 2, tier: 2, name: 'Hộp bút Thiên Long', required: 9, stock: 'ok', left: null };

/** Dựng đúng payload mà /api/pg/gift trả về. */
const card = (badges, over = {}) => ({
  student: { seq: 1, full_name: 'Nguyễn Văn A', badge_count: badges },
  tiers: [
    { ...TUI, redeemed_at: null, eligible: badges >= 7, ...(over.tui ?? {}) },
    { ...BUT, redeemed_at: null, eligible: badges >= 9, ...(over.but ?? {}) },
  ],
});

const names = (p) => itemNames(p.hand);

describe('giftPlan — một lượt SV ở quầy quà', () => {
  test('chưa đủ 7 badge: không có nút phát, nói rõ còn thiếu mấy cái', () => {
    const p = giftPlan(card(5));
    assert.equal(p.state, 'locked');
    assert.equal(p.missing, 2);
    assert.equal(p.next.tier, 1);
    assert.deepEqual(p.hand, []);
  });

  test('đúng 7 badge: trao túi quà', () => {
    const p = giftPlan(card(7));
    assert.equal(p.state, 'ready');
    assert.equal(p.target.tier, 1);
    assert.equal(names(p), 'Túi quà');
  });

  test('đủ 9 badge từ đầu: MỘT lượt, trao cả túi lẫn hộp bút', () => {
    const p = giftPlan(card(9));
    assert.equal(p.state, 'ready');
    assert.equal(p.target.tier, 2, 'bấm mức 9 — mức 7 đã nằm trong đó');
    assert.equal(names(p), 'Túi quà + Hộp bút Thiên Long');
    assert.deepEqual(p.already, []);
  });

  test('đã lấy túi từ trước, nay đủ 9: CHỈ trao thêm hộp bút', () => {
    const p = giftPlan(card(9, { tui: { redeemed_at: '2026-09-12T03:32:00Z' } }));
    assert.equal(p.state, 'ready');
    assert.equal(p.target.tier, 2);
    assert.equal(names(p), 'Hộp bút Thiên Long', 'không đổi lại túi');
    assert.deepEqual(p.already.map((t) => t.tier), [1], 'màn hình phải nhắc túi đã nhận lúc nào');
  });

  test('đã nhận đủ cả hai: không còn nút phát nào', () => {
    const p = giftPlan(card(9, {
      tui: { redeemed_at: '2026-09-12T03:32:00Z' },
      but: { redeemed_at: '2026-09-12T06:10:00Z' },
    }));
    assert.equal(p.state, 'done');
    assert.equal(p.target, null);
    assert.deepEqual(p.hand, []);
    assert.deepEqual(p.already.map((t) => t.tier), [1, 2]);
  });

  test('đã lấy túi, mới 7 badge: chờ thêm 2 badge nữa mới có hộp bút', () => {
    const p = giftPlan(card(7, { tui: { redeemed_at: '2026-09-12T03:32:00Z' } }));
    assert.equal(p.state, 'done', 'không còn gì để trao lúc này');
    assert.equal(p.next.tier, 2);
    assert.equal(p.missing, 2);
  });

  test('hết hộp bút: SV 9 badge vẫn nhận được túi', () => {
    const p = giftPlan(card(9, { but: { stock: 'out', left: 0 } }));
    assert.equal(p.state, 'ready');
    assert.equal(p.target.tier, 1);
    assert.equal(names(p), 'Túi quà');
  });

  test('hết túi: vẫn trao hộp bút, và ghi nhận SV đang bị nợ một chiếc túi', () => {
    const p = giftPlan(card(9, { tui: { stock: 'out', left: 0 } }));
    assert.equal(p.state, 'ready');
    assert.equal(p.target.tier, 2);
    assert.equal(names(p), 'Hộp bút Thiên Long');
    assert.deepEqual(p.shortfall.map((t) => t.tier), [1]);
  });

  test('hết sạch cả hai: nói hết quà, không bắt SV đứng chờ', () => {
    const p = giftPlan(card(9, { tui: { stock: 'out' }, but: { stock: 'out' } }));
    assert.equal(p.state, 'out');
    assert.deepEqual(p.shortfall.map((t) => t.tier), [1, 2]);
    assert.deepEqual(p.hand, []);
  });

  test('BTC nâng ngưỡng sau khi SV đã nhận: món đã trao không biến mất', () => {
    // Ngưỡng bậc 1 bị nâng lên 12 trong khi SV chỉ có 9 badge và đã cầm túi về.
    const p = giftPlan(card(9, {
      tui: { required: 12, redeemed_at: '2026-09-12T03:32:00Z' },
    }));
    assert.deepEqual(p.already.map((t) => t.tier), [1], 'vẫn phải hiện "đã nhận"');
    assert.equal(p.target.tier, 2);
    assert.equal(names(p), 'Hộp bút Thiên Long', 'không phát lại túi em đã có');
  });

  test('sự kiện chưa cấu hình bậc quà nào', () => {
    const p = giftPlan({ student: { badge_count: 9 }, tiers: [] });
    assert.equal(p.state, 'none');
    assert.equal(p.target, null);
  });

  test('payload rỗng hoặc hỏng không làm sập màn hình', () => {
    for (const bad of [null, undefined, {}, { tiers: null }]) {
      assert.equal(giftPlan(bad).state, 'none');
    }
  });
});
