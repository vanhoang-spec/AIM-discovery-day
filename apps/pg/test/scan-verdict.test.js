/**
 * Bộ dịch server_status → thẻ kết quả trên màn quét.
 *
 * Sinh từ diễn tập 09/09: màn quét không bao giờ cập nhật lại sau khi server
 * trả lời, nên tên SV không hiện và "đã nhận ở máy khác" trông y hệt thành
 * công. Các test dưới ghim đúng ba luật: counted = xanh + tên + tổng badge;
 * repeat/replay = HỔ PHÁCH (không bao giờ đỏ); rejected_* = đỏ + lý do người
 * đọc hiểu được. Trạng thái chưa chốt → null để thẻ đang hiện không bị đè.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resultFromServer, REJECT_REASON } from '../src/lib/scan-verdict.js';

const base = { student_seq: 1600, student_name: 'Trần Quốc Bảo', badge_count: 5 };

describe('resultFromServer', () => {
  test('counted → xanh, tên SV, tổng badge từ server', () => {
    const r = resultFromServer({ ...base, server_status: 'counted' });
    assert.equal(r.kind, 'ok');
    assert.equal(r.name, 'Trần Quốc Bảo');
    assert.match(r.meta, /tổng badge: 5/);
    assert.equal(r.confirmed, true);
  });

  test('repeat_not_counted → hổ phách "đã nhận trước đó", không phải đỏ', () => {
    const r = resultFromServer({ ...base, server_status: 'repeat_not_counted' });
    assert.equal(r.kind, 'amber');
    assert.match(r.verdict, /TRƯỚC ĐÓ/);
    assert.match(r.meta, /không cộng thêm/);
  });

  test('replay được đối xử y hệt repeat — một lần gửi lại không phải lỗi', () => {
    assert.equal(resultFromServer({ ...base, server_status: 'replay' }).kind, 'amber');
  });

  test('mọi rejected_* trong bảng lý do → đỏ kèm lời giải thích', () => {
    for (const status of Object.keys(REJECT_REASON)) {
      const r = resultFromServer({ ...base, server_status: status });
      assert.equal(r.kind, 'bad', status);
      assert.equal(r.meta, REJECT_REASON[status], status);
      assert.equal(r.name, 'Trần Quốc Bảo', status);
    }
  });

  test('rejected lạ chưa có trong bảng vẫn đỏ, meta là mã thô', () => {
    const r = resultFromServer({ ...base, server_status: 'rejected_moi_toanh' });
    assert.equal(r.kind, 'bad');
    assert.equal(r.meta, 'rejected_moi_toanh');
  });

  test('thiếu tên → "Mã <seq>" thay vì undefined', () => {
    const r = resultFromServer({ student_seq: 42, server_status: 'counted', badge_count: 1 });
    assert.equal(r.name, 'Mã 42');
  });

  test('chưa có trả lời của server → null (giữ nguyên thẻ đang hiện)', () => {
    assert.equal(resultFromServer(null), null);
    assert.equal(resultFromServer({ ...base, server_status: null }), null);
    assert.equal(resultFromServer({ ...base, server_status: 'error' }), null);
  });
});
