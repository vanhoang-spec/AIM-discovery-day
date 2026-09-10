-- ---------------------------------------------------------------------------
-- 0013 — Vai trò của máy PG
--
-- Test thực tế 10/09: "tất cả các máy của các PG ở các quầy đều chọn được
-- GIỮ CHỖ". Đúng vậy — mọi máy đã nhận đều mở được cả năm màn, kể cả quầy vé
-- hội trường. Một PG ở booth bấm nhầm vào đó là cấp mất một ghế hội trường.
--
-- Cách chữa rẻ nhất mà vẫn kiểm tra được: một cột vai trò, mặc định 'scan'.
-- Mặc định giữ NGUYÊN hành vi cũ cho việc quét badge; chỉ quầy vé hội trường
-- bị siết lại — và siết theo hướng an toàn: mặc định KHÔNG máy nào vào được,
-- BTC phải chỉ định đúng máy đứng trước hội trường.
--
-- Không đụng function nào, không đụng dữ liệu cũ. Chạy được giữa lúc sự kiện
-- đang chạy mà không khoá bảng lâu (ADD COLUMN có DEFAULT là thao tác chỉ ghi
-- metadata từ PG 11).
-- ---------------------------------------------------------------------------

alter table pg_devices
  add column if not exists device_role text not null default 'scan';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'pg_devices_device_role_check'
  ) then
    alter table pg_devices
      add constraint pg_devices_device_role_check
      check (device_role in ('scan', 'hall_ticket'));
  end if;
end $$;

comment on column pg_devices.device_role is
  'scan = máy quét badge thường (mặc định). hall_ticket = máy quầy vé trước '
  'hội trường, là vai trò DUY NHẤT mở được màn Giữ chỗ suất đặc biệt.';
