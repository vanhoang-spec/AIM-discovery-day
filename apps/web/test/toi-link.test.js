/**
 * Link riêng trong email (/toi#t=<mã QR>) — [14/11, AIM]. Đọc sai ở đây là SV
 * bấm link trong thư mà vẫn phải điền lại form, đúng cái lỗi AIM báo từ 12/09.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenFromLocation } from '../src/lib/toi-link.js';

test('đọc mã sau dấu #', () => {
  assert.equal(tokenFromLocation('#t=AbC-_123', ''), 'AbC-_123');
});

test('mã đã encodeURIComponent vẫn ra đúng mã gốc', () => {
  const token = 'Ab+/c=';
  assert.equal(tokenFromLocation(`#t=${encodeURIComponent(token)}`, ''), token);
});

test('nhận cả ?t= (link dán lại), # được ưu tiên', () => {
  assert.equal(tokenFromLocation('', '?t=Query1'), 'Query1');
  assert.equal(tokenFromLocation('#t=Hash1', '?t=Query1'), 'Hash1');
});

test('không có mã / mã rỗng / mã rác thì null — không gọi mạng vô ích', () => {
  assert.equal(tokenFromLocation('', ''), null);
  assert.equal(tokenFromLocation(undefined, undefined), null);
  assert.equal(tokenFromLocation('#t=', ''), null);
  assert.equal(tokenFromLocation('#other=1', ''), null);
  assert.equal(tokenFromLocation('#t=<script>', ''), null);
  assert.equal(tokenFromLocation(`#t=${'a'.repeat(300)}`, ''), null);
});
