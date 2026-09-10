/**
 * GET /api/pg/state — máy PG hỏi "tôi còn hợp lệ không, và tôi đang đứng đâu?"
 *
 * Sinh từ test thực tế 10/09. Hai việc trước đây máy PG không thể tự biết:
 *
 *   1. Admin bấm THU HỒI → token chết ngay, nhưng màn hình PG vẫn sáng như
 *      thường cho tới lần gửi hàng đợi kế tiếp. PG đứng quét vào hư không.
 *   2. Admin ĐIỀU CHUYỂN PG từ cổng sang quầy → không có đường nào báo cho
 *      máy biết. Trước đây PG tự bấm đổi trên máy, và đó chính là nút hay
 *      bấm nhầm mà AIM yêu cầu gỡ.
 *
 * Endpoint này rẻ có chủ đích — hai câu SELECT, không ghi gì — vì 45 máy poll
 * nó mỗi 20 giây (≈2,3 req/s, so với 576 req/s đã đo được ở §4.3c).
 *
 * Điểm quét được phân công lấy từ `pg_device_checkpoints` (bảng có sẵn từ
 * 0005). Quy ước: **đúng một dòng = vị trí hiện tại của máy**. Không dòng nào
 * nghĩa là chưa phân công — máy giữ nguyên điểm PG đã chọn lúc nhận máy.
 */

import { getDb } from '@atl/db';
import { bearerFrom, sha256Hex } from '@/lib/device';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const token = bearerFrom(request);
  if (!token) return Response.json({ error: 'Thiếu token thiết bị' }, { status: 401 });

  const db = await getDb();
  const dev = await db.query(`select * from resolve_pg_device($1)`, [await sha256Hex(token)]);

  // resolve_pg_device lọc sẵn revoked_at is null — không tìm thấy nghĩa là
  // token đã chết. 403 là tín hiệu máy PG dựng màn "đã bị thu hồi".
  if (dev.rows.length === 0) {
    return Response.json(
      { revoked: true, error: 'Thiết bị đã bị thu hồi' },
      { status: 403, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }

  const d = dev.rows[0];
  // Cột device_role đến từ 0013. Đọc phòng thủ để bản deploy này chạy được cả
  // trước lẫn sau khi migration được áp — thiếu cột thì mọi máy là 'scan',
  // tức không máy nào mở được quầy vé, hướng an toàn.
  const role = await db.query(
    `select device_role from pg_devices where id = $1`, [d.device_id],
  ).then((r) => r.rows[0]?.device_role ?? 'scan').catch(() => 'scan');

  const cp = await db.query(
    `select c.id, c.name, c.kind, c.zone_id, z.name as zone_name,
            c.counts_toward_badges, c.badge_weight
       from pg_device_checkpoints dc
       join checkpoints c on c.id = dc.checkpoint_id and c.event_id = dc.event_id
       left join zones z on z.id = c.zone_id and z.event_id = c.event_id
      where dc.device_id = $1 and dc.event_id = $2 and c.is_active
      order by c.display_order, c.id`,
    [d.device_id, d.event_id],
  );

  return Response.json(
    {
      revoked: false,
      device: { id: d.device_id, label: d.label, staff_name: d.staff_name, role },
      // Chỉ coi là "đã phân công" khi có ĐÚNG một điểm. Nhiều dòng là cấu hình
      // phạm vi kiểu cũ, không phải lệnh điều chuyển — im lặng để máy giữ
      // nguyên chỗ đang đứng thay vì nhảy sang một điểm tuỳ ý.
      assigned: cp.rows.length === 1 ? cp.rows[0] : null,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
