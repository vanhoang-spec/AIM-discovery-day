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
 * authenticated by the ACCESS token in the pass (`pass.access`, 26/11) — not
 * the QR token, whose key is public on the PG app. A pass saved before 26/11
 * has no access token: its QR still renders offline exactly as before, only
 * the progress part asks the student to reopen the email link / lấy lại mã.
 * The numbers come from the PG's scan
 * reaching the server, so the copy never promises instant: it shows
 * "Cập nhật HH:MM" instead — a stale number WITH a timestamp is information,
 * a stale number without one is an argument at the gift desk.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { tokenFromLocation } from '../../lib/toi-link.js';

const PASS_KEY = 'atl_pass_v1';
const PROGRESS_KEY = 'atl_progress_v1';
const POLL_MS = 30_000;

function hhmm(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Tên quà ở một mốc = mọi món tính tới mốc đó.
 *
 * [0014] Từ 10/09 mỗi bậc mang tên đúng MỘT món nó cộng thêm ("Túi quà", rồi
 * "Hộp bút Thiên Long"), vì đó là cách bàn quà thật vận hành và là cách hệ
 * thống đếm kho. Nhưng sinh viên đọc theo mốc badge chứ không đọc theo bậc:
 * "9 badge" với các em nghĩa là túi + bút. Ghép tên lại ở đây, ngay chỗ đọc.
 */
const giftAt = (tiers, i) => tiers.slice(0, i + 1).map((t) => t.name).join(' + ');

function Progress({ p }) {
  if (!p) return null;
  const nextIdx = p.tiers.findIndex(
    (t) => !t.redeemed && t.stock !== 'out' && p.badge_count < t.required);
  const next = nextIdx === -1 ? null : p.tiers[nextIdx];

  return (
    <section className="progress" aria-label="Tiến độ badge">
      <div className="progress-head">
        <span className="progress-count">{p.badge_count}</span>
        <span className="progress-label">badge</span>
        <span className="progress-stamp">Cập nhật {hhmm(p.updated_at)}</span>
      </div>

      {next && (
        <p className="progress-next">
          Còn <b>{next.required - p.badge_count} badge</b> nữa là đổi được{' '}
          {giftAt(p.tiers, nextIdx)}
          {next.remaining != null ? ` (còn ${next.remaining} suất)` : ''}.
        </p>
      )}

      <ul className="tier-list">
        {p.tiers.map((t, i) => {
          const state = t.redeemed ? 'done'
            : t.stock === 'out' ? 'out'
            : p.badge_count >= t.required ? 'ready' : 'locked';
          // Đã cầm về phần của mốc dưới thì lên mốc này chỉ nhận thêm phần
          // chênh — nói thẳng, để không ai xếp hàng lần nữa vì tưởng được đổi
          // lại cả bộ.
          const gotLower = p.tiers.slice(0, i).some((x) => x.redeemed);
          return (
            <li key={t.tier} className={`tier tier-${state}`}>
              <span className="tier-req">{t.required}</span>
              <span className="tier-name">{giftAt(p.tiers, i)}</span>
              <span className="tier-state">
                {state === 'done' && 'Đã nhận'}
                {state === 'ready' && (gotLower
                  ? `Đủ điều kiện — tới quầy nhận thêm ${t.name}`
                  : t.remaining != null
                    ? `Đủ điều kiện — còn ${t.remaining} suất, tới quầy quà`
                    : 'Đủ điều kiện — tới quầy quà')}
                {state === 'out' && 'ĐÃ HẾT QUÀ — không cần tới quầy nữa'}
                {state === 'locked' && (gotLower
                  ? `Còn thiếu ${t.required - p.badge_count} — sẽ nhận thêm ${t.name}`
                  : `Còn thiếu ${t.required - p.badge_count}`)}
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
                : `Cần ${p.special.y} badge (bạn có ${p.special.badge_count})`}
            </span>
          </li>
        )}
      </ul>
      {p.special?.y != null && (
        <p className="muted progress-note">
          Hoạt động đặc biệt tính trên <b>tổng badge</b> — mọi hoạt động đều được
          tính. Mỗi bạn nhận <b>một suất</b>.
        </p>
      )}

      <ExperienceLog history={p.history} />
    </section>
  );
}

/**
 * Lịch sử trải nghiệm — AIM yêu cầu 10/09: "để mỗi SV nắm được mình đã xong
 * booth nào rồi".
 *
 * Danh sách theo thứ tự thời gian, không phải bảng: sinh viên đọc nó trên
 * điện thoại giữa sân, vừa đi vừa xem. Mỗi dòng nói rõ được mấy badge, vì với
 * trọng số thì "đã ghé 4 chỗ" không còn suy ra được "đang có mấy badge".
 *
 * Dữ liệu đi kèm bản tiến độ đã lưu trong máy, nên phần này cũng mở được khi
 * mất mạng — đúng như phần mã QR ngay trên nó.
 */
function ExperienceLog({ history }) {
  const [open, setOpen] = useState(false);
  if (!Array.isArray(history)) return null;

  const when = (iso) => {
    try {
      return new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  };

  return (
    <div className="xp-log">
      <button type="button" className="xp-toggle" onClick={() => setOpen((v) => !v)}
        aria-expanded={open}>
        {/* Check-in ở cổng là điểm danh, không phải một hoạt động — đếm nó vào
            đây là "1 hoạt động" cho người mới qua cổng. */}
        <span>
          Lịch sử trải nghiệm
          {history.some((h) => h.kind !== 'entrance')
            ? ` · ${history.filter((h) => h.kind !== 'entrance').length} hoạt động`
            : ''}
        </span>
        <span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && (history.length === 0 ? (
        <p className="muted xp-empty">
          Bạn chưa quét mã ở hoạt động nào. Ghé một gian hàng bất kỳ và đưa mã QR
          phía trên cho nhân viên để bắt đầu.
        </p>
      ) : (
        <ul className="xp-list">
          {history.map((h, i) => (
            <li key={`${h.name}-${i}`}>
              <span className="xp-tick" aria-hidden="true">✓</span>
              <span className="xp-body">
                <span className="xp-name">{h.name}</span>
                <span className="xp-meta">
                  {when(h.at)}{h.zone ? ` · ${h.zone}` : ''}
                </span>
              </span>
              {/* [11/09] Chỉ điểm thật sự tính badge mới có "+N" — cộng các số ở
                  cột này phải ra đúng con số badge to phía trên. */}
              <span className={`xp-badge${h.badges > 0 ? '' : ' none'}`}>
                {h.badges > 0 ? `+${h.badges}` : h.kind === 'entrance' ? 'Check-in' : '—'}
              </span>
            </li>
          ))}
        </ul>
      ))}
    </div>
  );
}

/**
 * [26/11] Thẻ không có mã truy cập (lưu trước bản vá bảo mật), hoặc mã truy cập
 * bị server từ chối: mã QR phía trên vẫn dùng bình thường, chỉ phần điểm cần
 * mã mới. Nói đúng việc cần làm, không để màn hình trắng.
 */
function NeedAccess() {
  return (
    <section className="progress" aria-label="Tiến độ badge">
      <p className="progress-next">
        Mã QR phía trên vẫn quét bình thường. Để xem điểm trên máy này, mở link
        trong email mới nhất của ban tổ chức, hoặc{' '}
        <a href="/dang-ky" style={{ color: 'var(--accent)' }}>lấy lại mã</a> bằng
        email / SĐT đã đăng ký.
      </p>
    </section>
  );
}

export default function MyQrPage() {
  const [pass, setPass] = useState(undefined); // undefined = loading, null = none
  const [progress, setProgress] = useState(null);
  const [linkFailed, setLinkFailed] = useState(null); // null | 'old_link' | 'failed'
  const [accessRefused, setAccessRefused] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    let local = null;
    let localProgress = null;
    try {
      const raw = localStorage.getItem(PASS_KEY);
      local = raw ? JSON.parse(raw) : null;
      const prog = localStorage.getItem(PROGRESS_KEY);
      localProgress = prog ? JSON.parse(prog) : null;
    } catch {
      local = null;
    }

    // [14/11] Link riêng trong email (/toi#t=<mã>): đổi mã lấy thẻ rồi lưu
    // như lúc vừa đăng ký — SV khỏi điền lại form mới xem được điểm.
    // [26/11] Mã trong link là mã truy cập. Link thư cũ mang mã QR: nếu máy đã
    // có đúng thẻ đó thì dùng thẻ trong máy, khỏi gọi mạng.
    const linkToken = tokenFromLocation(window.location.hash, window.location.search);
    const clearLink = () => {
      try { window.history.replaceState(null, '', window.location.pathname); } catch {}
    };
    if (!linkToken || local?.access === linkToken || local?.token === linkToken) {
      if (linkToken) clearLink();
      setPass(local);
      if (localProgress) setProgress(localProgress);
      return undefined;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/toi/pass?t=${encodeURIComponent(linkToken)}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw Object.assign(new Error(`pass ${res.status}`), { reason: body.reason });
        }
        const data = await res.json();
        const fresh = {
          token: data.token,
          qr_svg: data.qr_svg,
          access: data.access,
          lookup_code: data.lookup_code,
          full_name: data.full_name,
          event_id: data.event_id,
          saved_at: Date.now(),
        };
        try {
          localStorage.setItem(PASS_KEY, JSON.stringify(fresh));
          localStorage.removeItem(PROGRESS_KEY); // điểm cũ là của thẻ khác
        } catch {}
        clearLink();
        if (!cancelled) setPass(fresh);
      } catch (err) {
        // Giữ #t= trên thanh địa chỉ: tải lại trang là thử lại được — trừ link
        // thư cũ mang mã QR, tải lại bao nhiêu lần cũng không mở được.
        if (!cancelled) {
          const oldLink = err?.reason === 'qr_token';
          if (oldLink) clearLink();
          setLinkFailed(oldLink ? 'old_link' : 'failed');
          setPass(local);
          if (local && localProgress) setProgress(localProgress);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const refresh = useCallback(async (access) => {
    try {
      const res = await fetch(`/api/toi?t=${encodeURIComponent(access)}`);
      // 401 = mã truy cập không còn được nhận (vd. BTC đổi ATL_ACCESS_KEY):
      // thăm dò tiếp vô ích, báo SV lấy mã mới.
      if (res.status === 401) {
        setAccessRefused(true);
        clearInterval(timer.current);
        return;
      }
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
    if (!pass?.access) return;
    const start = () => {
      refresh(pass.access);
      clearInterval(timer.current);
      timer.current = setInterval(() => refresh(pass.access), POLL_MS);
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

  if (pass === null && linkFailed === 'old_link') {
    return (
      <main className="wrap">
        <h1>Link này là bản cũ</h1>
        <p className="sub">
          Link trong các email gửi trước bản cập nhật bảo mật tháng 11/2026 không
          còn mở được trang điểm. Lấy lại mã bằng email hoặc SĐT đã đăng ký — mã QR
          của bạn vẫn giữ nguyên, không tạo bản trùng.
        </p>
        <a href="/dang-ky"><button className="primary" type="button">Lấy mã QR của mình</button></a>
      </main>
    );
  }

  if (pass === null && linkFailed) {
    return (
      <main className="wrap">
        <h1>Chưa mở được trang điểm</h1>
        <p className="sub">
          Mạng đang yếu hoặc link trong email bị cắt mất. Thử tải lại trang; nếu vẫn
          không được, lấy lại mã bằng email hoặc SĐT đã đăng ký.
        </p>
        <button className="primary" type="button" onClick={() => window.location.reload()}>
          Thử lại
        </button>
        <a href="/dang-ky"><button className="ghost" type="button">Lấy mã QR của mình</button></a>
      </main>
    );
  }

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
      {(!pass.access || accessRefused) && <NeedAccess />}

      <p className="muted" style={{ textAlign: 'center' }}>
        Mã QR hoạt động cả khi không có mạng.
        {' '}<a href="/lich" style={{ color: 'var(--accent)' }}>Lịch hoạt động</a>
        {' · '}<a href="/khao-sat" style={{ color: 'var(--accent)' }}>Khảo sát nhận badge</a>
      </p>
    </main>
  );
}
