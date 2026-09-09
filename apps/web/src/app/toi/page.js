'use client';

/**
 * /toi — the screen the whole event runs on.
 *
 * Order of operations is the contract: the QR renders from the SVG cached at
 * registration BEFORE any network is attempted, and everything below it is
 * progressive enhancement. A phone in a dead zone shows exactly what it
 * showed before progress existed — QR, code, name — with the last progress
 * snapshot it managed to fetch, stamped with its time.
 *
 * Progress polls foreground-only every 30s (paused when the tab is hidden),
 * authenticated by the QR token itself. The numbers come from the PG's scan
 * reaching the server, so the copy never promises instant: it shows
 * "Cập nhật HH:MM" instead — a stale number WITH a timestamp is information,
 * a stale number without one is an argument at the gift desk.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const PASS_KEY = 'atl_pass_v1';
const PROGRESS_KEY = 'atl_progress_v1';
const POLL_MS = 30_000;

function hhmm(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function Progress({ p }) {
  if (!p) return null;
  const next = p.tiers.find((t) => !t.redeemed && t.stock !== 'out' && p.badge_count < t.required);

  return (
    <section className="progress" aria-label="Tiến độ badge">
      <div className="progress-head">
        <span className="progress-count">{p.badge_count}</span>
        <span className="progress-label">badge</span>
        <span className="progress-stamp">Cập nhật {hhmm(p.updated_at)}</span>
      </div>

      {next && (
        <p className="progress-next">
          Còn <b>{next.required - p.badge_count} badge</b> nữa là đổi được {next.name}.
        </p>
      )}

      <ul className="tier-list">
        {p.tiers.map((t) => {
          const state = t.redeemed ? 'done'
            : t.stock === 'out' ? 'out'
            : p.badge_count >= t.required ? 'ready' : 'locked';
          return (
            <li key={t.tier} className={`tier tier-${state}`}>
              <span className="tier-req">{t.required}</span>
              <span className="tier-name">{t.name}</span>
              <span className="tier-state">
                {state === 'done' && 'Đã nhận'}
                {state === 'ready' && 'Đủ điều kiện — tới quầy quà'}
                {state === 'out' && 'ĐÃ HẾT'}
                {state === 'locked' && `Còn thiếu ${t.required - p.badge_count}`}
              </span>
            </li>
          );
        })}
        {p.special?.y != null && (
          <li className={`tier tier-${p.special.eligible ? 'ready' : 'locked'}`}>
            <span className="tier-req">{p.special.y}</span>
            <span className="tier-name">Hoạt động đặc biệt</span>
            <span className="tier-state">
              {p.special.eligible
                ? (p.special.slots_left > 0 ? 'Đủ điều kiện — tới quầy đăng ký' : 'Đã hết suất')
                : `Cần ${p.special.y} badge (bạn có ${p.special.badge_count ?? p.special.core_badge_count})`}
            </span>
          </li>
        )}
      </ul>
      {p.special?.y != null && (
        <p className="muted progress-note">
          Hoạt động đặc biệt tính theo số <b>hoạt động</b> (cổng + gian hàng),
          không tính badge thưởng.
        </p>
      )}
    </section>
  );
}

export default function MyQrPage() {
  const [pass, setPass] = useState(undefined); // undefined = loading, null = none
  const [progress, setProgress] = useState(null);
  const timer = useRef(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PASS_KEY);
      setPass(raw ? JSON.parse(raw) : null);
      const prog = localStorage.getItem(PROGRESS_KEY);
      if (prog) setProgress(JSON.parse(prog));
    } catch {
      setPass(null);
    }
  }, []);

  const refresh = useCallback(async (token) => {
    try {
      const res = await fetch(`/api/toi?t=${encodeURIComponent(token)}`);
      if (!res.ok) return;
      const data = await res.json();
      setProgress(data);
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(data));
    } catch {
      /* offline — keep showing the cached snapshot */
    }
  }, []);

  // Foreground-only polling: fetch now, every 30s while visible, and on
  // return to the tab. Hidden tabs stop entirely — 1.500 idle phones must
  // not keep a heartbeat against the origin.
  useEffect(() => {
    if (!pass?.token) return;
    const start = () => {
      refresh(pass.token);
      clearInterval(timer.current);
      timer.current = setInterval(() => refresh(pass.token), POLL_MS);
    };
    const onVis = () => {
      if (document.hidden) clearInterval(timer.current);
      else start();
    };
    start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(timer.current);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [pass, refresh]);

  // Keep the screen awake while the QR is up — a PG mid-scan losing the screen
  // to auto-lock is a real failure on event day.
  useEffect(() => {
    if (!pass) return;
    let lock;
    navigator.wakeLock?.request('screen').then((l) => { lock = l; }).catch(() => {});
    return () => lock?.release?.().catch(() => {});
  }, [pass]);

  if (pass === undefined) return null;

  if (pass === null) {
    return (
      <main className="wrap">
        <h1>Chưa có mã trên máy này</h1>
        <p className="sub">
          Bạn đã đăng ký rồi? Điền lại đúng email hoặc SĐT cũ — mình hiện lại mã
          của bạn, không tạo bản trùng.
        </p>
        <a href="/dang-ky"><button className="primary" type="button">Lấy mã QR của mình</button></a>
      </main>
    );
  }

  const code = pass.lookup_code.slice(0, 3) + '-' + pass.lookup_code.slice(3);

  return (
    <main className="wrap">
      <div className="qr-card">
        <div dangerouslySetInnerHTML={{ __html: pass.qr_svg }} />
        <p className="lookup-code">{code}</p>
        <p className="qr-name">{pass.full_name}</p>
      </div>
      <p className="sub" style={{ textAlign: 'center' }}>
        Đưa mã này cho nhân viên tại booth để nhận badge.
        Máy sắp hết pin? Đọc mã <b>{code}</b> là đủ.
      </p>

      <Progress p={progress} />

      <p className="muted" style={{ textAlign: 'center' }}>
        Mã QR hoạt động cả khi không có mạng.
        {' '}<a href="/lich" style={{ color: 'var(--accent)' }}>Lịch hoạt động</a>
        {' · '}<a href="/khao-sat" style={{ color: 'var(--accent)' }}>Khảo sát nhận badge</a>
      </p>
    </main>
  );
}
