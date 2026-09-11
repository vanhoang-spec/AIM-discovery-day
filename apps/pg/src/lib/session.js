'use client';

/**
 * Device session, roster cache, and the singleton scan queue.
 *
 * Everything the scanner needs lives in IndexedDB, so a reload — or the phone
 * killing the tab to reclaim memory — costs nothing. Nothing here is held only
 * in React state.
 */

import { ScanQueue } from '@atl/scan-queue';
import { createIdbStore, kv, requestPersistence } from '@atl/scan-queue/idb-store';

const K = {
  session: 'session',
  roster: 'roster',
  rosterVersion: 'roster_version',
  checkpoint: 'active_checkpoint',
  golden: 'golden_status',
};

let queue;

/** One queue per page, created lazily so it never runs during SSR. */
export function getQueue() {
  if (!queue) {
    queue = new ScanQueue({
      store: createIdbStore(),
      send: async (batch) => {
        const session = await getSession();
        const stats = await queue.stats();
        const res = await fetch('/api/pg/sync', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.token}`,
          },
          body: JSON.stringify({
            scans: batch,
            queue_depth: stats.unsent,
            battery_pct: await batteryPct(),
          }),
        });
        if (!res.ok) throw new Error(`sync ${res.status}`);
        const data = await res.json();
        // Giờ Vàng status rides the sync response; stash it for the banner.
        if (data.golden_status !== undefined) {
          kv.set(K.golden, data.golden_status).catch(() => {});
        }
        return data.results;
      },
    });
  }
  return queue;
}

async function batteryPct() {
  try {
    const b = await navigator.getBattery?.();
    return b ? Math.round(b.level * 100) : null;
  } catch {
    return null;
  }
}

export const getSession = () => kv.get(K.session);
export const setSession = (s) => kv.set(K.session, s);
export const clearSession = () => kv.delete(K.session);

/**
 * Xoá sạch máy cũ khỏi điện thoại để nhận mã máy mới. CHỈ gọi khi server đã
 * khẳng định máy bị THU HỒI (fetchDeviceState → revoked: true, tức 403).
 *
 * Sinh 11/09, khi khoá sự kiện DIỄN TẬP: trang nhận máy chỉ hiện "Máy đã sẵn
 * sàng" khi điện thoại còn phiên cũ, và màn thu hồi không có lối ra — nên một
 * điện thoại đã tập dượt không có cách nào nhập mã máy thật của ngày sự kiện,
 * trừ việc bắt PG vào cài đặt trình duyệt xoá dữ liệu trang web.
 *
 * Xoá cả hàng đợi là có chủ đích, và an toàn ĐÚNG VÌ đã bị thu hồi: token cũ
 * đã chết nên không lượt nào trong đó còn gửi lên được. Giữ lại thì chúng sẽ
 * đi lên bằng token của máy MỚI — với điểm quét của sự kiện cũ — và bị từ
 * chối, hoặc tệ hơn là chặn nhầm "đã có badge" cho chính SV đó ở máy mới.
 */
export async function forgetRevokedDevice() {
  const q = getQueue();
  for (const row of await q.store.all()) await q.store.delete(row.scan_uid);
  await Promise.all(Object.values(K).map((key) => kv.delete(key)));
}

export const getActiveCheckpoint = () => kv.get(K.checkpoint);
export const getGoldenStatus = () => kv.get(K.golden);
export const setActiveCheckpoint = (cp) => kv.set(K.checkpoint, cp);

export const getRoster = async () => (await kv.get(K.roster)) ?? [];

/**
 * Pull roster changes since the last sync.
 *
 * Merging by `seq` rather than replacing means a delta covering three walk-ins
 * costs three rows, not two thousand — which is the difference between a
 * ten-minute refresh being free and being something a PG notices.
 */
export async function refreshRoster({ full = false } = {}) {
  const session = await getSession();
  if (!session) return { ok: false, reason: 'no-session' };

  const since = full ? null : await kv.get(K.rosterVersion);
  const url = '/api/pg/roster' + (since ? `?since=${encodeURIComponent(since)}` : '');

  const res = await fetch(url, { headers: { Authorization: `Bearer ${session.token}` } });
  if (!res.ok) return { ok: false, status: res.status };
  const data = await res.json();

  const current = data.full ? [] : await getRoster();
  const bySeq = new Map(current.map((r) => [r.seq, r]));
  for (const row of data.students) bySeq.set(row.seq, row);

  const merged = [...bySeq.values()];
  await kv.set(K.roster, merged);
  await kv.set(K.rosterVersion, data.version);
  return { ok: true, total: merged.length, changed: data.students.length };
}

/**
 * Hỏi server: máy còn hợp lệ không, BTC có điều chuyển mình không.
 *
 * Trả `{ ok:false, revoked:true }` khi token đã chết — màn quét dựng màn chặn
 * từ tín hiệu đó. Lỗi mạng trả `{ ok:false }` KHÔNG kèm revoked: mất sóng
 * tuyệt đối không được biến thành "máy bị thu hồi".
 */
export async function fetchDeviceState() {
  const session = await getSession();
  if (!session) return { ok: false };
  try {
    const res = await fetch('/api/pg/state', {
      headers: { Authorization: `Bearer ${session.token}` },
      cache: 'no-store',
    });
    if (res.status === 403) return { ok: false, revoked: true };
    if (!res.ok) return { ok: false };
    return { ok: true, ...(await res.json()) };
  } catch {
    return { ok: false };
  }
}

/**
 * Ghi lại vai trò máy vào phiên đang lưu trên điện thoại.
 *
 * Vai trò được ghi lúc NHẬN MÁY, nên nếu không có hàm này thì một máy đã nhận
 * từ hôm trước sẽ không bao giờ biết BTC vừa đổi vai trò cho nó — kể cả khi
 * tải lại trang, vì phiên đọc từ IndexedDB chứ không gọi lại /claim. Đó là
 * đúng tình huống ngày 12/09: điều một máy dự phòng sang trực quầy vé.
 *
 * Trả về true khi có thay đổi, để màn hình biết mà vẽ lại.
 */
export async function syncDeviceRole(role) {
  if (!role) return false;
  const s = await getSession();
  if (!s || s.device?.role === role) return false;
  await setSession({ ...s, device: { ...s.device, role } });
  return true;
}

export async function claimDevice({ claimCode, pin }) {
  // Asking for persistent storage before anything is written gives the browser
  // the best chance of granting it — and an unpersisted queue is one storage
  // squeeze away from losing scans.
  await requestPersistence();

  const res = await fetch('/api/pg/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ claim_code: claimCode, pin, app_version: 'pg-0.1.0' }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'Không nhận diện được thiết bị');

  await setSession({
    token: data.token,
    device: data.device,
    event: data.event,
    checkpoints: data.checkpoints,
    claimed_at: Date.now(),
  });
  // BTC đã phân công sẵn điểm quét thì máy vào thẳng việc, không hỏi PG —
  // đúng ý "PG không tự chọn điểm để khỏi bấm nhầm" (10/09).
  if (data.assigned) await setActiveCheckpoint(data.assigned);
  await refreshRoster({ full: true });
  return data;
}
