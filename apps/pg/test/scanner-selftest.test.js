/**
 * Mã QR tự kiểm tra của bộ đọc — chứng minh fixture nhúng là một mã QR THẬT.
 *
 * Diễn tập 09/09: "máy không phản hồi gì hết". Hai bộ đọc đều có kiểu hỏng
 * câm (BarcodeDetector thiếu model MLKit; chunk WASM 404 sau deploy), nên
 * scanner.js giờ bắt mỗi bộ đọc phải giải mã một mã QR biết trước rồi mới
 * được cầm camera. Test này chạy chính zxing-wasm thật trên fixture đó: nếu
 * ai sửa ma trận (hay đổi payload mà quên sinh lại ma trận), self-test ngoài
 * hiện trường sẽ loại oan bộ đọc còn tốt — và test này đỏ trước.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SELF_TEST_PAYLOAD, SELF_TEST_MATRIX, selfTestImage } from '../src/lib/scanner.js';

describe('decoder self-test fixture', () => {
  test('ma trận là QR version 1 (21×21), mỗi hàng đúng 21 bit', () => {
    assert.equal(SELF_TEST_MATRIX.length, 21);
    for (const row of SELF_TEST_MATRIX) assert.match(row, /^[01]{21}$/);
  });

  test('ảnh dựng ra có quiet zone trắng và kích thước khớp scale 4 + margin 4', () => {
    const img = selfTestImage();
    assert.equal(img.width, (21 + 8) * 4);
    assert.equal(img.height, img.width);
    // Góc trên trái nằm trong quiet zone — phải trắng tinh.
    assert.equal(img.data[0], 255);
    // Module (0,0) của ma trận là finder pattern — phải đen.
    const px = (4 * 4 * img.width + 4 * 4) * 4;
    assert.equal(img.data[px], 0);
  });

  test('zxing-wasm THẬT giải mã fixture ra đúng payload', async () => {
    const { readBarcodes } = await import('zxing-wasm/reader');
    const res = await readBarcodes(selfTestImage(), {
      tryHarder: true, formats: ['QRCode'], maxNumberOfSymbols: 1,
    });
    assert.equal(res?.[0]?.text, SELF_TEST_PAYLOAD);
  });

  test('payload không thể nhầm với token SV thật (token là 26 ký tự Base32)', () => {
    // Nếu self-test payload lọt vào handleCode vì lý do gì đó, verifyToken
    // phải từ chối nó chứ không thể ghi nhận thành một lượt quét.
    assert.notEqual(SELF_TEST_PAYLOAD.length, 26);
  });
});
