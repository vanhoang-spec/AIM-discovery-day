'use client';

/**
 * Chế độ quầy quà — the ONE screen in this app that requires network.
 *
 * A badge can queue offline because awarding twice is absorbed by the unique
 * index. A physical gift cannot: the hand-over happens in the real world, so
 * the stock decrement and the dedup must be confirmed by the server BEFORE
 * the PG reaches into the box. When the network is down this screen says so
 * and points at the paper flow (supervisor + wristband) instead of
 * pretending — an optimistic UI at a gift counter is how one notebook gets
 * handed to two students.
 *
 * Flow: scan QR or type (roster search, offline) → server check → entitlement
 * card → tap the tier being handed over → server confirms → green card.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { verifyToken, importKey } from '@atl/qr-token';
import { searchRoster } from '@atl/vn-text';
import { getRoster, getSession } from '@/lib/session';
import { startScanner, feedback, holdWakeLock } from '@/lib/scanner';

const DEV_KEY = 'atl2026-dev-key-do-not-use-in-production';

const maskPhone = (p) => (p ? p.replace(/^(\d{3})\d{4}(\d{2,})$/, '$1····$2') : null);

export default function GiftCounterPage() {
  const router = useRouter();
  const [session, setSession] = useState(undefined);
  const [online, setOnline] = useState(true);
  const [query, setQuery] = useState('');
  const [roster, setRoster] = useState([]);
  const [card, setCard] = useState(null);      // entitlement card from server
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [flash, setFlash] = useState(null);    // {name, tier} after a redeem
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
    let lock;
    holdWakeLock().then((l) => { lock = l; });
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
      scannerRef.current?.stop();
      lock?.release?.().catch(() => {});
    };
  }, [router]);

  const api = useCallback(async (body) => {
    const s = await getSession();
    const res = await fetch('/api/pg/gift', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  }, []);

  const check = useCallback(async (seq) => {
    setBusy(true); setErr(null); setFlash(null);
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

  const redeem = async (tier) => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const d = await api({
        action: 'redeem',
        student_seq: card.student.seq,
        gift_tier_id: tier.id,
      });
      feedback('ok');
      setCard(d);
      setFlash({ name: tier.name, tier: tier.tier });
    } catch (e) {
      feedback('bad');
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  // ---- scan path ----
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

  return (
    <main className="screen">
      <div className="cpbar">
        <span>Quầy quà · {session?.device?.label ?? ''}</span>
        <small>{online ? 'cần mạng · đang có mạng' : '⚠ MẤT MẠNG'}</small>
      </div>

      {!online && (
        <div className="alert warn" style={{ margin: 12 }}>
          <b>Quầy quà cần mạng — không có chế độ chờ gửi.</b>
          Phát quà lúc mất mạng phải qua giám sát: ghi sổ giấy + vòng tay theo bậc,
          nhập lại sau sự kiện. Đừng phát dựa trên số badge hiện trên máy sinh viên.
        </div>
      )}

      {flash && (
        <div className="result ok" style={{ padding: 16, margin: '12px 12px 0' }}>
          <p className="verdict">ĐÃ PHÁT — BẬC {flash.tier}</p>
          <p className="meta">{flash.name} · trao quà cho sinh viên rồi bấm người tiếp theo</p>
        </div>
      )}

      {err && (
        <div className="alert warn" style={{ margin: '12px 12px 0' }}>
          <b>{err}</b>
        </div>
      )}

      {card ? (
        <div className="pad">
          <p className="name" style={{ fontSize: 22, margin: '6px 0 2px' }}>
            {card.student.full_name}
          </p>
          <p className="meta" style={{ margin: 0 }}>
            {card.student.lookup_code} · {card.student.student_code ?? '—'} ·{' '}
            <b>{card.student.badge_count} badge</b>
          </p>

          <div className="list" style={{ marginTop: 14 }}>
            {card.tiers.map((t) => {
              const state = t.redeemed_at ? 'done'
                : t.stock === 'out' ? 'out'
                : t.eligible ? 'ready' : 'locked';
              return (
                <div key={t.id} className="hit" style={{ cursor: 'default' }}>
                  <span>
                    <span className="nm">Bậc {t.tier} — {t.name}</span>
                    <span className="sub">
                      cần {t.required} badge
                      {t.left != null && t.stock !== 'out' && ` · còn ${t.left}`}
                    </span>
                  </span>
                  {state === 'ready' && (
                    <button className="primary" style={{ width: 'auto', padding: '10px 16px' }}
                      disabled={busy} onClick={() => redeem(t)}>
                      PHÁT
                    </button>
                  )}
                  {state === 'done' && <span className="badges" style={{ color: 'var(--ok, #2c6e52)' }}>✓ đã nhận</span>}
                  {state === 'out' && <span className="badges" style={{ color: 'var(--bad, #a33526)' }}>ĐÃ HẾT</span>}
                  {state === 'locked' && (
                    <span className="badges">thiếu {t.required - card.student.badge_count}</span>
                  )}
                </div>
              );
            })}
          </div>

          <button className="ghost" style={{ marginTop: 14 }}
            onClick={() => { setCard(null); setFlash(null); setErr(null); }}>
            NGƯỜI TIẾP THEO
          </button>
        </div>
      ) : (
        <div className="pad">
          <div className="camwrap" style={{ minHeight: 160 }}
            onClick={() => { if (camera !== 'on') startCamera(); }}>
            <video ref={videoRef} playsInline muted style={{ width: '100%', borderRadius: 12 }} />
            {camera !== 'on' && (
              <p className="muted" style={{ textAlign: 'center' }}>
                {camera === 'denied' ? 'Không mở được camera — dùng ô gõ dưới'
                  : 'Chạm để quét QR'}
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

      <div className="pad" style={{ marginTop: 'auto' }}>
        <button className="ghost" onClick={() => router.push('/quet')}>VỀ MÀN QUÉT</button>
      </div>
    </main>
  );
}
