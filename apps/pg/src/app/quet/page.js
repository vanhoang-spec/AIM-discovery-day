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
} from '@/lib/session';
import { startScanner, feedback, holdWakeLock, IDLE_PAUSE_MS } from '@/lib/scanner';

const DEV_KEY = 'atl2026-dev-key-do-not-use-in-production';

export default function ScanPage() {
  const router = useRouter();
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
  useEffect(() => {
    (async () => {
      const s = await getSession();
      if (!s) { router.replace('/'); return; }
      setSession(s);
      rosterRef.current = await getRoster();
      keyRef.current = await importKey(process.env.NEXT_PUBLIC_ATL_HMAC_KEY || DEV_KEY);
      const cp = await getActiveCheckpoint();
      if (cp) setCheckpoint(cp); else setPicking(true);
      setOnline(navigator.onLine);
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

    const verified = await verifyToken(raw, keyRef.current);
    if (!verified.valid) {
      feedback('bad');
      setResult({
        kind: 'bad',
        verdict: 'MÃ KHÔNG HỢP LỆ',
        name: 'Thử tra cứu thủ công',
        meta: verified.reason === 'wrong_event' ? 'Mã của điểm khác' : 'Không đọc được mã này',
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
  }, [checkpoint]);

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

  if (!session) return null;

  const syncClass = !online ? 'offline' : stats.unsent > 0 ? 'sending' : 'ok';
  const syncText = !online
    ? `Mất mạng · ${stats.unsent} chờ gửi`
    : stats.unsent > 0 ? `Đang gửi · ${stats.unsent}` : 'Đã đồng bộ';

  if (picking) {
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
      </div>

      {result && (
        <div className={`result ${result.kind}`}>
          <p className="verdict">{result.verdict}</p>
          <p className="name">{result.name}</p>
          <p className="meta">
            {result.meta}
            {result.pending && <span className="tilde"> · ~ chờ đồng bộ</span>}
          </p>
        </div>
      )}

      <div className="pad row">
        <button onClick={() => router.push('/tra-cuu')}>TRA CỨU TAY</button>
        <button onClick={() => router.push('/qua')}>QUẦY QUÀ</button>
        <button className="ghost" onClick={() => router.push('/hang-cho')}>
          HÀNG ĐỢI {stats.unsent > 0 ? `· ${stats.unsent}` : ''}
        </button>
      </div>
    </main>
  );
}
