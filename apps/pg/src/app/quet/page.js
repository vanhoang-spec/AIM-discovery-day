'use client';

/**
 * The scanner.
 *
 * The whole screen is built around one rule: a scan is settled locally, shown
 * immediately, and synced later. The PG never waits for the network, and the
 * UI never claims the server agreed when it has not heard from the server.
 *
 * That last point is why every result carries either `~` (recorded on this
 * phone) or `✓` (server confirmed). Collapsing the two is how a PG ends up
 * telling a student "you have 5 badges" from a device that last synced at
 * 09:15.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { verifyToken, importKey, normaliseLookupCode } from '@atl/qr-token';
import {
  getQueue, getSession, getRoster, getActiveCheckpoint, setActiveCheckpoint, refreshRoster,
  getGoldenStatus,
} from '@/lib/session';
import { startScanner, feedback, holdWakeLock, IDLE_PAUSE_MS } from '@/lib/scanner';
import { screenFor } from '@/lib/boot-state';

const DEV_KEY = 'atl2026-dev-key-do-not-use-in-production';

export default function ScanPage() {
  const router = useRouter();
  const [golden, setGolden] = useState(null);
  const videoRef = useRef(null);
  const scannerRef = useRef(null);
  const idleTimer = useRef(null);
  const keyRef = useRef(null);
  const rosterRef = useRef([]);

  const [session, setSession] = useState(null);
  const [checkpoint, setCheckpoint] = useState(null);
  const [result, setResult] = useState(null);
  const [stats, setStats] = useState({ unsent: 0, confirmed: 0 });
  const [online, setOnline] = useState(true);
  const [camera, setCamera] = useState('starting'); // starting | on | paused | denied
  const [picking, setPicking] = useState(false);

  // ---- boot ----
  //
  // Read EVERYTHING first, then set state once. React renders at every await,
  // so setting `session` here and `checkpoint` three awaits later published a
  // half-loaded state to the JSX — which is exactly how production crashed on
  // 08/09 (see lib/boot-state.js). The refs are not state and can be filled as
  // they arrive; the two useState values are set together at the end, in one
  // synchronous block React batches into a single render.
  useEffect(() => {
    (async () => {
      const s = await getSession();
      if (!s) { router.replace('/'); return; }
      rosterRef.current = await getRoster();
      keyRef.current = await importKey(process.env.NEXT_PUBLIC_ATL_HMAC_KEY || DEV_KEY);
      const cp = await getActiveCheckpoint();
      setOnline(navigator.onLine);
      setCheckpoint(cp ?? null);
      setPicking(!cp);
      setSession(s);
    })();
  }, [router]);

  // ---- queue heartbeat: flush, refresh roster, report health ----
  useEffect(() => {
    if (!session) return;
    const q = getQueue();
    let alive = true;

    const tick = async () => {
      if (!alive) return;
      setStats(await q.stats());
      if (navigator.onLine && document.visibilityState === 'visible') {
        await q.flush().catch(() => {});
        setStats(await q.stats());
      }
      // Banner data rides sync responses; expire it locally so a device that
      // stopped syncing never shows a dead golden hour.
      const g = await getGoldenStatus().catch(() => null);
      setGolden(g && new Date(g.ends_at) > new Date() ? g : null);
    };
    const flushTimer = setInterval(tick, 5000);
    tick();

    // Ten minutes is a compromise: often enough to pick up walk-ins registered
    // at the door, rare enough to be invisible on a personal data plan.
    const rosterTimer = setInterval(async () => {
      if (!navigator.onLine) return;
      const r = await refreshRoster().catch(() => null);
      if (r?.ok) rosterRef.current = await getRoster();
    }, 600_000);

    const goOnline = () => { setOnline(true); tick(); };
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    // iOS has no Background Sync, so returning to the foreground is the only
    // reliable moment to drain the queue.
    document.addEventListener('visibilitychange', tick);

    return () => {
      alive = false;
      clearInterval(flushTimer);
      clearInterval(rosterTimer);
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [session]);

  // ---- the scan path: never touches the network ----
  const handleCode = useCallback(async (raw) => {
    if (!checkpoint) return;

    // expectedEventInstance: chặn NGAY TẠI MÁY, offline, mã QR của sự kiện
    // khác. Diễn tập 09/09 lộ lỗ hổng: thiếu tham số này, SV của điểm kia
    // được màn XANH "sinh viên mới đăng ký" rồi mới bị server từ chối âm
    // thầm trong hàng đợi — ngày 12/09 nghĩa là PG cho qua cổng một người
    // chưa đăng ký điểm mình.
    const verified = await verifyToken(raw, keyRef.current,
      { expectedEventInstance: session.event?.id });
    if (!verified.valid) {
      feedback('bad');
      setResult(verified.reason === 'wrong_event'
        ? {
            kind: 'bad',
            verdict: 'MÃ CỦA ĐIỂM KHÁC',
            name: 'Không ghi nhận được',
            meta: 'Mã này thuộc sự kiện khác — hướng dẫn bạn ấy kiểm tra lại email đăng ký',
          }
        : {
            kind: 'bad',
            verdict: 'MÃ KHÔNG HỢP LỆ',
            name: 'Thử tra cứu thủ công',
            meta: 'Không đọc được mã này',
          });
      return;
    }

    const student = rosterRef.current.find((r) => r.seq === verified.studentSeq);
    const q = getQueue();
    const { duplicate, item } = await q.enqueue({
      student_seq: verified.studentSeq,
      checkpoint_id: checkpoint.id,
      student_name: student?.name ?? null,
    });

    if (duplicate) {
      // Amber, deliberately not red. A duplicate is one of the most common
      // outcomes all day; treating it as an error trains PGs to ignore red.
      feedback('amber');
      setResult({
        kind: 'amber',
        verdict: 'ĐÃ CÓ BADGE NÀY',
        name: student?.name ?? `SV ${verified.studentSeq}`,
        meta: `Ghi nhận lúc ${new Date(item.client_ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`,
      });
      return;
    }

    if (!student) {
      // Signature is valid but this device's roster predates them — a walk-in
      // who registered minutes ago. Accept it; the server resolves the name.
      feedback('info');
      setResult({
        kind: 'info',
        verdict: 'SINH VIÊN MỚI ĐĂNG KÝ',
        name: `Mã ${verified.studentSeq}`,
        meta: 'Đã ghi nhận · tên sẽ hiện sau khi đồng bộ',
        pending: true,
      });
    } else {
      feedback('ok');
      setResult({
        kind: 'ok',
        verdict: 'ĐÃ GHI NHẬN',
        name: student.name,
        meta: `${student.mssv ?? ''} · badge thứ ${(student.badge_count ?? 0) + 1}`,
        pending: true,
      });
    }
    setStats(await q.stats());
    getQueue().flush().catch(() => {});
  }, [checkpoint, session]);

  // ---- camera lifecycle ----
  const startCamera = useCallback(async () => {
    if (!videoRef.current || scannerRef.current) return;
    setCamera('starting');
    const s = await startScanner({
      video: videoRef.current,
      onCode: (code) => { handleCode(code); armIdle(); },
      onError: () => setCamera('denied'),
    });
    if (!s.ok) return;
    scannerRef.current = s;
    setCamera('on');
    armIdle();
  }, [handleCode]);

  const stopCamera = useCallback(() => {
    scannerRef.current?.stop();
    scannerRef.current = null;
    clearTimeout(idleTimer.current);
    setCamera('paused');
  }, []);

  /** Pause after idle. In a queue this never fires; in the gaps it is most of
   *  the battery saving — roughly 18%/hour down to 6%. */
  const armIdle = useCallback(() => {
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(stopCamera, IDLE_PAUSE_MS);
  }, [stopCamera]);

  useEffect(() => {
    if (!checkpoint || picking) return;
    startCamera();
    let lock;
    holdWakeLock().then((l) => { lock = l; });
    return () => {
      scannerRef.current?.stop();
      scannerRef.current = null;
      clearTimeout(idleTimer.current);
      lock?.release?.().catch(() => {});
    };
  }, [checkpoint, picking, startCamera]);

  // One rule, one place, tested in test/boot-state.test.js. Ordering the boot
  // effect correctly is the fix; this is the guard that keeps it fixed when
  // someone later adds another await above.
  const screen = screenFor({ session, checkpoint, picking });
  if (screen === 'loading') return null;

  const syncClass = !online ? 'offline' : stats.unsent > 0 ? 'sending' : 'ok';
  const syncText = !online
    ? `Mất mạng · ${stats.unsent} chờ gửi`
    : stats.unsent > 0 ? `Đang gửi · ${stats.unsent}` : 'Đã đồng bộ';

  if (screen === 'picking') {
    return (
      <main className="screen">
        <div className={`syncbar ${syncClass}`}><span>{syncText}</span></div>
        <div className="pad">
          <h1>Bạn đang quét cho điểm nào?</h1>
          <p>Chọn sai sẽ làm hỏng số liệu của nhà tài trợ — chọn kỹ.</p>
          <div className="list" style={{ marginTop: 14 }}>
            {session.checkpoints.map((cp) => (
              <button
                key={cp.id} className="hit"
                onClick={async () => { await setActiveCheckpoint(cp); setCheckpoint(cp); setPicking(false); }}
              >
                <span>
                  <span className="nm">{cp.name}</span>
                  <span className="sub">{cp.zone_name ?? 'Không thuộc khu vực nào'}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="screen">
      <div className={`syncbar ${syncClass}`}>
        <span>{syncText}</span>
        <span className="who">{session.device.label} · {session.device.staff_name}</span>
      </div>

      <button
        className="cpbar" onClick={() => setPicking(true)}
        style={{ border: 'none', borderRadius: 0, minHeight: 0, width: '100%' }}
      >
        <span>Đang quét: {checkpoint.name}</span>
        <small>đổi ▸</small>
      </button>

      {golden && golden.zone_id === checkpoint.zone_id && (
        <div className="goldbar">
          ⚡ GIỜ VÀNG ×2 — zone này đang thưởng thêm 1 badge · còn{' '}
          {Math.max(1, Math.round((new Date(golden.ends_at) - Date.now()) / 60000))} phút.
          Nói với sinh viên khi quét!
        </div>
      )}
      {golden && golden.zone_id !== checkpoint.zone_id && (
        <div className="goldbar dim">
          ⚡ Giờ Vàng đang chạy ở {golden.zone_name} — hướng sinh viên rảnh sang đó.
        </div>
      )}

      <div className="camwrap" onClick={() => { if (camera !== 'on') startCamera(); }}>
        <video ref={videoRef} playsInline muted />
        {camera === 'on' && <div className="reticle" />}
        {camera === 'paused' && (
          <div className="camoff">
            <div style={{ fontSize: 42 }}>📷</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>Chạm để quét</div>
            <p className="muted" style={{ margin: 0 }}>Camera tạm tắt để tiết kiệm pin</p>
          </div>
        )}
        {camera === 'denied' && (
          <div className="camoff">
            <div className="alert bad" style={{ margin: 0 }}>
              <b>Không mở được camera</b>
              Vào Cài đặt → cho phép camera, rồi mở lại app. Trong lúc chờ, dùng tra cứu thủ công.
            </div>
          </div>
        )}
        {/* Kết quả ĐÈ lên đáy camera — diễn tập 09/09: để dưới camera thì nó
            rơi ra ngoài màn hình, PG phải cuộn mới biết vừa quét ra gì. */}
        {result && (
          <div className={`result result-overlay ${result.kind}`}>
            <p className="verdict">{result.verdict}</p>
            <p className="name">{result.name}</p>
            <p className="meta">
              {result.meta}
              {result.pending && <span className="tilde"> · ~ chờ đồng bộ</span>}
            </p>
          </div>
        )}
      </div>

      <div className="pad row">
        <button onClick={() => router.push('/tra-cuu')}>TRA CỨU TAY</button>
        <button onClick={() => router.push('/qua')}>QUẦY QUÀ</button>
        <button onClick={() => router.push('/suat')}>SUẤT ĐẶC BIỆT</button>
        <button className="ghost" onClick={() => router.push('/hang-cho')}>
          HÀNG ĐỢI {stats.unsent > 0 ? `· ${stats.unsent}` : ''}
        </button>
      </div>
    </main>
  );
}
