'use client';

/**
 * Quầy hoạt động đặc biệt (AC22 UI + AC24).
 *
 * The one screen that is online-by-NECESSITY: the cap is a global number and
 * two offline phones cannot share a counter. So the offline state here is not
 * a queue and not a warning banner — it is a full-screen CHẾ ĐỘ GIẤY (AC24)
 * that tells the PG to stop scanning and reach for the numbered paper ticket
 * book. An app that half-works offline at this desk would over-promise seats
 * in front of the sponsor; an app that refuses loudly cannot.
 *
 * Flow: scan/type → eligibility (CORE ladder — sessions and bonuses do not
 * count, and the screen says so) → GIỮ CHỖ (90s hold, countdown visible) →
 * XÁC NHẬN → big slot number the PG reads aloud.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { verifyToken, importKey } from '@atl/qr-token';
import { searchRoster } from '@atl/vn-text';
import { getRoster, getSession } from '@/lib/session';
import { startScanner, feedback, holdWakeLock } from '@/lib/scanner';

const DEV_KEY = 'atl2026-dev-key-do-not-use-in-production';
const maskPhone = (p) => (p ? p.replace(/^(\d{3})\d{4}(\d{2,})$/, '$1····$2') : null);

export default function SpecialDeskPage() {
  const router = useRouter();
  const [session, setSession] = useState(undefined);
  const [online, setOnline] = useState(true);
  const [roster, setRoster] = useState([]);
  const [query, setQuery] = useState('');
  const [card, setCard] = useState(null);
  const [hold, setHold] = useState(null);   // {activity_id, slot_no, held_until}
  const [claimed, setClaimed] = useState(null); // {activity, slot_no}
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [camera, setCamera] = useState('off');
  const videoRef = useRef(null);
  const scannerRef = useRef(null);
  const keyRef = useRef(null);

  useEffect(() => {
    (async () => {
      const s = await getSession();
      if (!s) { router.replace('/'); return; }
      setSession(s);
      setRoster(await getRoster());
      keyRef.current = await importKey(process.env.NEXT_PUBLIC_ATL_HMAC_KEY || DEV_KEY);
    })();
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    let lock;
    holdWakeLock().then((l) => { lock = l; });
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
      clearInterval(clock);
      scannerRef.current?.stop();
      lock?.release?.().catch(() => {});
    };
  }, [router]);

  const api = useCallback(async (body) => {
    const s = await getSession();
    const res = await fetch('/api/pg/special', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  }, []);

  const check = useCallback(async (seq) => {
    setBusy(true); setErr(null); setClaimed(null); setHold(null);
    try {
      setCard(await api({ action: 'check', student_seq: seq }));
      setQuery('');
      feedback('ok');
    } catch (e) {
      feedback('bad');
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }, [api]);

  const doHold = async (act) => {
    setBusy(true); setErr(null);
    try {
      const r = await api({ action: 'hold', student_seq: card.student.seq, activity_id: act.id });
      setHold({ activity: act, slot_no: r.slot_no, held_until: r.held_until });
      feedback('ok');
    } catch (e) { feedback('bad'); setErr(e.message); } finally { setBusy(false); }
  };

  const doConfirm = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api({ action: 'confirm', student_seq: card.student.seq,
                            activity_id: hold.activity.id });
      setClaimed({ activity: hold.activity, slot_no: r.slot_no });
      setHold(null);
      feedback('ok');
    } catch (e) { feedback('bad'); setErr(e.message); setHold(null); } finally { setBusy(false); }
  };

  const startCamera = useCallback(async () => {
    if (!videoRef.current || scannerRef.current) return;
    setCamera('starting');
    const s = await startScanner({
      video: videoRef.current,
      onCode: async (raw) => {
        const v = await verifyToken(raw, keyRef.current);
        if (!v.valid) { feedback('bad'); setErr('Mã không hợp lệ'); return; }
        scannerRef.current?.stop();
        scannerRef.current = null;
        setCamera('off');
        check(v.studentSeq);
      },
      onError: () => setCamera('denied'),
    });
    if (s.ok) setCamera('on');
  }, [check]);

  const results = useMemo(
    () => (query.trim() ? searchRoster(roster, query, { limit: 6 }).results : []),
    [roster, query],
  );

  if (session === undefined) return null;

  // ---- AC24: offline here is a full-screen stop, not a degraded mode ----
  if (!online) {
    return (
      <main className="screen">
        <div className="result bad" style={{ padding: 24, margin: 12 }}>
          <p className="verdict">CHẾ ĐỘ GIẤY</p>
          <p className="name">Quầy suất đặc biệt cần mạng — và đang mất mạng.</p>
          <p className="meta" style={{ lineHeight: 1.6 }}>
            Số suất là con số chung toàn sự kiện; hai máy offline không thể chia nhau đếm.
            <br /><br />
            1. Lấy <b>sổ vé giấy đánh số</b> từ giám sát.<br />
            2. Kiểm tra điều kiện bằng <b>số hoạt động</b> sinh viên (hỏi giám sát nếu nghi ngờ).<br />
            3. Xé vé theo đúng thứ tự số — <b>không nhảy số</b>.<br />
            4. Sau sự kiện, admin nhập lại vé giấy ở màn Đối soát.
          </p>
        </div>
        <div className="pad">
          <button className="ghost" onClick={() => router.push('/quet')}>VỀ MÀN QUÉT</button>
        </div>
      </main>
    );
  }

  const holdLeft = hold ? Math.max(0, Math.floor((new Date(hold.held_until) - now) / 1000)) : 0;

  return (
    <main className="screen">
      <div className="cpbar">
        <span>Suất đặc biệt · {session?.device?.label ?? ''}</span>
        <small>bắt buộc có mạng</small>
      </div>

      {err && <div className="alert warn" style={{ margin: '12px 12px 0' }}><b>{err}</b></div>}

      {claimed && (
        <div className="result ok" style={{ padding: 22, margin: 12 }}>
          <p className="verdict">SUẤT SỐ {claimed.slot_no}</p>
          <p className="name">{card.student.full_name}</p>
          <p className="meta">{claimed.activity.name} — đọc to số suất cho sinh viên</p>
        </div>
      )}

      {card && !claimed ? (
        <div className="pad">
          <p className="name" style={{ fontSize: 22, margin: '6px 0 2px' }}>
            {card.student.full_name}
          </p>
          <p className="meta" style={{ margin: 0 }}>
            {card.student.lookup_code} · <b>{card.student.badge_count} badge</b>
            {' '}(cần {card.y})
          </p>
          {!card.eligible && (
            <div className="alert warn" style={{ marginTop: 10 }}>
              <b>Chưa đủ điều kiện.</b>
              Cần <b>{card.y} badge</b>, bạn này đang có <b>{card.student.badge_count}</b>.
              Mọi hoạt động đều được tính — kể cả hội trường và Learning Zone.
            </div>
          )}

          {hold ? (
            <div className="result info" style={{ padding: 18, marginTop: 12 }}>
              <p className="verdict">ĐANG GIỮ SUẤT {hold.slot_no}</p>
              <p className="meta">{hold.activity.name} · còn <b>{holdLeft}s</b> để xác nhận</p>
              <button className="primary" style={{ marginTop: 12 }}
                disabled={busy || holdLeft === 0} onClick={doConfirm}>
                XÁC NHẬN — SV CÓ MẶT TẠI QUẦY
              </button>
              {holdLeft === 0 && <p className="meta" style={{ marginTop: 8 }}>Hết giờ giữ — bấm giữ lại.</p>}
            </div>
          ) : (
            <div className="list" style={{ marginTop: 14 }}>
              {card.activities.map((a) => (
                <div key={a.id} className="hit" style={{ cursor: 'default' }}>
                  <span>
                    <span className="nm">{a.name}</span>
                    <span className="sub">
                      {a.already_claimed ? `đã có suất số ${a.claimed_slot}`
                        : !a.is_open ? 'chưa mở nhận'
                        : a.slots_left > 0 ? `còn ${a.slots_left} suất` : 'ĐÃ HẾT SUẤT'}
                    </span>
                  </span>
                  {card.eligible && a.is_open && !a.already_claimed && a.slots_left > 0 && (
                    <button className="primary" style={{ width: 'auto', padding: '10px 16px' }}
                      disabled={busy} onClick={() => doHold(a)}>
                      GIỮ CHỖ
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          <button className="ghost" style={{ marginTop: 14 }}
            onClick={() => { setCard(null); setHold(null); setErr(null); }}>
            NGƯỜI TIẾP THEO
          </button>
        </div>
      ) : !claimed && (
        <div className="pad">
          <div className="camwrap" style={{ minHeight: 160 }}
            onClick={() => { if (camera !== 'on') startCamera(); }}>
            <video ref={videoRef} playsInline muted style={{ width: '100%', borderRadius: 12 }} />
            {camera !== 'on' && (
              <p className="muted" style={{ textAlign: 'center' }}>
                {camera === 'denied' ? 'Không mở được camera — dùng ô gõ dưới' : 'Chạm để quét QR'}
              </p>
            )}
          </div>
          <input
            type="text" inputMode="text" autoComplete="off"
            placeholder="Hoặc gõ: mã 6 ký tự, SĐT, MSSV, tên"
            style={{ marginTop: 12 }}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="list" style={{ marginTop: 10 }}>
            {results.map((s) => (
              <button key={s.seq} className="hit" disabled={busy} onClick={() => check(s.seq)}>
                <span>
                  <span className="nm">{s.name}</span>
                  <span className="sub">
                    {[s.mssv, maskPhone(s.phone)].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className="badges">{s.badge_count ?? 0} badge</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {claimed && (
        <div className="pad">
          <button className="primary" onClick={() => { setCard(null); setClaimed(null); }}>
            NGƯỜI TIẾP THEO
          </button>
        </div>
      )}

      <div className="pad" style={{ marginTop: 'auto' }}>
        <button className="ghost" onClick={() => router.push('/quet')}>VỀ MÀN QUÉT</button>
      </div>
    </main>
  );
}
