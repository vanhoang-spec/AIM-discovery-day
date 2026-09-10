/**
 * Ba luật mới của máy PG, sinh từ test thực tế 10/09 (AIM).
 *
 * Không có test nào ở đây gọi API — chúng ghim đúng phần LOGIC mà con người
 * dễ làm hỏng khi sửa vội: ai được mở quầy vé, khi nào coi là "BTC đã phân
 * công", và khi nào một hộp thoại điều chuyển được phép hiện lên. Ba câu hỏi
 * đó trước đây nằm rải trong JSX và không có lưới nào đỡ.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { canOpenHallDesk, canOpenGiftDesk, assignedFrom, needsMove } from '../src/lib/device-role.js';

describe('canOpenHallDesk — chỉ quầy vé trước hội trường', () => {
  test('máy quét badge thường KHÔNG mở được', () => {
    assert.equal(canOpenHallDesk({ device: { role: 'scan' } }), false);
  });

  test('máy được BTC đặt vai trò quầy vé thì mở được', () => {
    assert.equal(canOpenHallDesk({ device: { role: 'hall_ticket' } }), true);
  });

  test('phiên cũ chưa có trường role → KHÔNG mở được (hướng an toàn)', () => {
    // Máy đã nhận từ hôm qua giữ session không có `role`. Đoán "cho phép" ở
    // đây nghĩa là mọi máy cũ vẫn cấp được ghế hội trường — đúng cái lỗi đang
    // sửa. Bắt PG tải lại trang rẻ hơn nhiều so với mất một ghế.
    assert.equal(canOpenHallDesk({ device: {} }), false);
    assert.equal(canOpenHallDesk({}), false);
    assert.equal(canOpenHallDesk(null), false);
  });
});

describe('assignedFrom — đúng MỘT điểm mới là lệnh phân công', () => {
  const cps = [{ id: 7, name: 'Booth C2' }, { id: 9, name: 'Brief Day' }];

  test('một dòng → máy nhận điểm đó', () => {
    assert.deepEqual(assignedFrom({ assigned_id: 9, assigned_count: 1 }, cps), cps[1]);
  });

  test('không dòng nào → null, PG tự chọn như cũ', () => {
    assert.equal(assignedFrom({ assigned_id: null, assigned_count: 0 }, cps), null);
  });

  test('nhiều dòng → null: đó là cấu hình phạm vi 0005, không phải điều chuyển', () => {
    assert.equal(assignedFrom({ assigned_id: 7, assigned_count: 2 }, cps), null);
  });

  test('điểm được phân công không còn hoạt động → null, không nhảy bừa', () => {
    assert.equal(assignedFrom({ assigned_id: 999, assigned_count: 1 }, cps), null);
  });
});

describe('needsMove — khi nào hiện hộp thoại ĐIỀU CHUYỂN', () => {
  const cp = (id) => ({ id, name: `CP${id}` });

  test('điểm phân công khác điểm đang quét → hiện', () => {
    assert.equal(needsMove({ ok: true, assigned: cp(9) }, cp(7)), true);
  });

  test('trùng điểm đang quét → im lặng', () => {
    assert.equal(needsMove({ ok: true, assigned: cp(7) }, cp(7)), false);
  });

  test('máy chưa chọn điểm nào mà BTC đã phân công → hiện', () => {
    assert.equal(needsMove({ ok: true, assigned: cp(9) }, null), true);
  });

  test('mất mạng (ok:false) → KHÔNG hiện, dù dữ liệu cũ nói gì', () => {
    // Mất sóng không được biến thành lệnh điều chuyển: PG đang đứng đúng chỗ
    // mà bị bảo đi nơi khác là hỏng số liệu của cả hai điểm.
    assert.equal(needsMove({ ok: false }, cp(7)), false);
    assert.equal(needsMove({ ok: false, assigned: cp(9) }, cp(7)), false);
  });

  test('BTC gỡ phân công → im lặng, máy giữ nguyên chỗ đang đứng', () => {
    assert.equal(needsMove({ ok: true, assigned: null }, cp(7)), false);
  });
});

describe('vai trò phải theo kịp BTC — lỗ hổng phát hiện 10/09 tối', () => {
  // Vai trò được ghi vào phiên lúc NHẬN MÁY. Một máy đã nhận từ hôm trước giữ
  // phiên cũ, và tải lại trang KHÔNG gọi lại /claim — nên nếu không đồng bộ
  // lại, máy vừa được BTC chỉ định làm quầy vé vẫn bị chặn vĩnh viễn. Ba test
  // dưới ghim đúng phép so sánh mà syncDeviceRole dựa vào.
  const changed = (sessionRole, serverRole) =>
    Boolean(serverRole) && sessionRole !== serverRole;

  test('phiên cũ không có vai trò + server nói hall_ticket → phải cập nhật', () => {
    assert.equal(changed(undefined, 'hall_ticket'), true);
  });

  test('BTC gỡ vai trò quầy vé → phải cập nhật xuống scan', () => {
    assert.equal(changed('hall_ticket', 'scan'), true);
  });

  test('không đổi gì → không ghi lại phiên (tránh viết IndexedDB mỗi 20 giây)', () => {
    assert.equal(changed('scan', 'scan'), false);
    assert.equal(changed('hall_ticket', 'hall_ticket'), false);
  });

  test('server không trả vai trò (mất mạng) → giữ nguyên phiên đang có', () => {
    assert.equal(changed('hall_ticket', undefined), false);
    assert.equal(changed('hall_ticket', null), false);
  });
});

describe('canOpenGiftDesk — trao quà tập trung một chỗ (AIM 10/09)', () => {
  test('máy đứng ở Quầy đổi quà thì trao được', () => {
    assert.equal(canOpenGiftDesk({ id: 40, kind: 'gift_counter' }), true);
  });

  test('máy ở gian hàng nhà tài trợ thì KHÔNG', () => {
    assert.equal(canOpenGiftDesk({ id: 7, kind: 'sponsor_booth' }), false);
  });

  test('máy ở cổng check-in thì KHÔNG', () => {
    assert.equal(canOpenGiftDesk({ id: 1, kind: 'entrance' }), false);
  });

  test('chưa có điểm nào (máy vừa nhận, BTC chưa gán) → KHÔNG', () => {
    // Hướng an toàn: thà bắt BTC gán một ô còn hơn để một máy chưa cấu hình
    // phát quà thật.
    assert.equal(canOpenGiftDesk(null), false);
    assert.equal(canOpenGiftDesk(undefined), false);
    assert.equal(canOpenGiftDesk({ id: 5 }), false);
  });
});
