'use client';

/**
 * Queue inspector.
 *
 * Exists so a PG can answer "did that scan actually go through?" without
 * asking anyone, and so a supervisor walking the floor can see the state of a
 * device in one glance. Rejected rows get a retry button — the alternative is
 * a scan that silently never lands.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { STATE } from '@atl/scan-queue';
import { getQueue, getSession } from '@/lib/session';

const LABEL = {
  [STATE.PENDING]: { text: 'Chờ gửi', cls: 'warn' },
  [STATE.SENDING]: { text: 'Đang gửi', cls: 'warn' },
  [STATE.CONFIRMED]: { text: '✓ Server xác nhận', cls: 'ok' },
  [STATE.DUPLICATE]: { text: '◐ Đã có trước đó', cls: 'warn' },
  [STATE.REJECTED]: { text: '⛔ Bị từ chối', cls: 'bad' },
};

// Diễn tập 09/09: "Bị từ chối" trần khiến PG bấm Thử lại vô vọng — máy chủ
// nói RÕ lý do trong server_status mà UI nuốt mất. Lý do phổ biến nhất ngày
// thật sẽ là SV của điểm kia (đăng ký HN, quét máy HCM).
const REJECT_REASON = {
  rejected_not_registered: 'SV chưa đăng ký sự kiện của máy này — có thể nhầm điểm. Thử lại sẽ KHÔNG giúp; kiểm tra email đăng ký của bạn ấy.',
  rejected_unknown_student: 'Không tìm thấy SV này trên hệ thống — mã in có thể hỏng, dùng tra cứu tay.',
  rejected_checkpoint_closed: 'Điểm quét đã bị tắt trên trang quản trị.',
  rejected_device: 'Máy này đã bị thu hồi — báo giám sát đổi máy.',
  rejected_out_of_scope: 'Máy không được phân quyền quét điểm này.',
};

export default function QueuePage() {
  const router = useRouter();
  const [items, setItems] = useState([]);
  const [stats, setStats] = useState(null);

  const load = async () => {
    const q = getQueue();
    const all = await q.store.all();
    setItems(all.sort((a, b) => b.scan_uid.localeCompare(a.scan_uid)).slice(0, 50));
    setStats(await q.stats());
  };

  useEffect(() => {
    (async () => {
      if (!(await getSession())) { router.replace('/'); return; }
      await load();
    })();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [router]);

  if (!stats) return null;

  return (
    <main className="screen">
      <div className="cpbar">
        <span>Hàng đợi trên máy này</span>
        <small>{stats.unsent} chờ · {stats.confirmed} xong</small>
      </div>

      <div className="pad">
        {stats.rejected > 0 && (
          <div className="alert bad">
            <b>{stats.rejected} lượt bị từ chối</b>
            Bấm “Thử lại” bên dưới. Nếu vẫn hỏng, báo giám sát — đừng để sinh viên
            đi mà không có badge.
          </div>
        )}
        {stats.unsent > 25 && (
          <div className="alert warn">
            <b>Hàng đợi đang dày ({stats.unsent})</b>
            Máy này mất mạng lâu. Đi tới vùng có wifi vài phút để xả bớt.
          </div>
        )}

        <div className="list">
          {items.map((it) => {
            const l = LABEL[it.state] ?? { text: it.state, cls: 'warn' };
            return (
              <div key={it.scan_uid} className="hit" style={{ alignItems: 'flex-start' }}>
                <span>
                  <span className="nm">{it.student_name ?? `Mã ${it.student_seq}`}</span>
                  <span className="sub">
                    {new Date(it.client_ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    {' · '}{l.text}
                    {it.attempts > 0 && ` · thử ${it.attempts} lần`}
                  </span>
                  {it.state === STATE.REJECTED && REJECT_REASON[it.server_status] && (
                    <span className="sub" style={{ color: '#f08b74' }}>
                      {REJECT_REASON[it.server_status]}
                    </span>
                  )}
                  {it.error && <span className="sub" style={{ color: '#f08b74' }}>{it.error}</span>}
                </span>
                {it.state === STATE.REJECTED && (
                  <button
                    style={{ width: 'auto', minHeight: 44, padding: '8px 14px' }}
                    onClick={async () => { await getQueue().retry(it.scan_uid); await load(); }}
                  >
                    Thử lại
                  </button>
                )}
              </div>
            );
          })}
          {items.length === 0 && <p className="muted">Chưa có lượt quét nào trên máy này.</p>}
        </div>

        <button className="primary" style={{ marginTop: 16 }} onClick={() => router.push('/quet')}>
          QUAY LẠI MÀN QUÉT
        </button>
      </div>
    </main>
  );
}
