/**
 * Lịch sử trải nghiệm trên app SV — sinh từ ảnh chụp DIỄN TẬP 11/09.
 *
 * Màn hình hiện "2 badge" ở trên nhưng lịch sử bên dưới liệt kê ba dòng "+1",
 * dòng thứ ba là Quầy đổi quà — một điểm BTC đã tắt tính badge. Luật mà các
 * bài dưới ghim: cộng các con số trong lịch sử phải ra đúng con số to.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { historyFrom } from '../src/lib/experience.js';

const row = (over = {}) => ({
  name: 'Booth C2',
  kind: 'sponsor_booth',
  badge_weight: 1,
  counts_toward_badges: true,
  zone_name: 'Gian hàng',
  awarded_at: '2026-09-11T03:32:00Z',
  ...over,
});

describe('historyFrom — lịch sử trải nghiệm của SV', () => {
  test('đúng ảnh chụp 11/09: 2 booth + quầy quà → 2 dòng, cộng lại khớp 2 badge', () => {
    const h = historyFrom([
      row({ name: 'Booth AIM Academy' }),
      row({ name: 'Booth C2' }),
      row({ name: 'Quầy đổi quà', kind: 'gift_counter', counts_toward_badges: false, zone_name: null }),
    ]);
    assert.deepEqual(h.map((x) => x.name), ['Booth AIM Academy', 'Booth C2']);
    assert.equal(h.reduce((s, x) => s + x.badges, 0), 2,
      'tổng trong lịch sử phải bằng con số badge to phía trên');
  });

  test('cổng check-in: giữ lại (SV muốn biết giờ vào) nhưng KHÔNG mang badge', () => {
    const [c] = historyFrom([
      row({ name: 'Cổng check-in', kind: 'entrance', counts_toward_badges: false, zone_name: 'Cổng' }),
    ]);
    assert.equal(c.kind, 'entrance');
    assert.equal(c.badges, 0);
  });

  test('hoạt động trọng số 4 hiện +4, không phải +1', () => {
    const [b] = historyFrom([row({ name: 'Brief Day', kind: 'hall_session', badge_weight: 4 })]);
    assert.equal(b.badges, 4);
  });

  test('BTC tắt tính badge của một booth giữa ngày: dòng vẫn còn, badge về 0', () => {
    const [b] = historyFrom([row({ counts_toward_badges: false })]);
    assert.equal(b.name, 'Booth C2');
    assert.equal(b.badges, 0);
  });

  test('quầy thông tin cũng không phải một hoạt động', () => {
    assert.deepEqual(historyFrom([row({ kind: 'info_desk', counts_toward_badges: false })]), []);
  });

  test('thiếu cột counts_toward_badges: không bao giờ bịa ra +1', () => {
    const r = row();
    delete r.counts_toward_badges;
    assert.equal(historyFrom([r])[0].badges, 0);
  });

  test('đầu vào rỗng hoặc hỏng không làm sập trang', () => {
    for (const bad of [undefined, null, [], [null]]) {
      assert.deepEqual(historyFrom(bad), []);
    }
  });
});
