/**
 * eventWhen — ngày giờ sự kiện cho SV đọc. Lỗi ở đây là SV đọc sai ngày
 * ngay trên đầu form đăng ký (14/11: form UEF vẫn ghi "Thứ Bảy 12/09").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventWhen } from '../src/lib/event-when.js';

test('Discovery Day UEF: thứ ba 17/11, 8h–17h30 giờ Việt Nam', () => {
  assert.equal(
    eventWhen({ starts_at: '2026-11-17T01:00:00+00:00', ends_at: '2026-11-17T10:30:00+00:00' }),
    'Thứ Ba 17/11/2026 · 8h–17h30',
  );
});

test('Discovery Day 12/09 cũ vẫn ra đúng thứ bảy', () => {
  assert.equal(
    eventWhen({ starts_at: '2026-09-12T01:00:00Z', ends_at: '2026-09-12T10:00:00Z' }),
    'Thứ Bảy 12/09/2026 · 8h–17h',
  );
});

test('giờ UTC tối hôm trước vẫn là sáng hôm sau ở Việt Nam', () => {
  // 17:30 UTC ngày 16/11 = 00:30 ngày 17/11 giờ VN.
  assert.equal(eventWhen({ starts_at: '2026-11-16T17:30:00Z' }), 'Thứ Ba 17/11/2026 · 0h30');
});

test('không có hoặc sai starts_at thì trả rỗng, không bịa ngày', () => {
  assert.equal(eventWhen(null), '');
  assert.equal(eventWhen({}), '');
  assert.equal(eventWhen({ starts_at: 'không-phải-ngày' }), '');
  assert.equal(eventWhen({ city: 'TP.HCM' }), '');
});

test('ends_at hỏng thì chỉ in giờ bắt đầu', () => {
  assert.equal(
    eventWhen({ starts_at: '2026-11-17T01:00:00Z', ends_at: 'x' }),
    'Thứ Ba 17/11/2026 · 8h',
  );
});
