'use client';

/**
 * /toi — the screen the whole event runs on.
 *
 * Renders the QR from the SVG cached at registration: zero network requests,
 * pure white ground in both themes, code and name printed under it. If there
 * is no cached pass (new phone, cleared storage), the page degrades to a link
 * back to registration — which doubles as the resend flow.
 */

import { useEffect, useState } from 'react';

const PASS_KEY = 'atl_pass_v1';

export default function MyQrPage() {
  const [pass, setPass] = useState(undefined); // undefined = loading, null = none

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PASS_KEY);
      setPass(raw ? JSON.parse(raw) : null);
    } catch {
      setPass(null);
    }
  }, []);

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
      <p className="muted" style={{ textAlign: 'center' }}>
        Màn hình này hoạt động cả khi không có mạng.
      </p>
    </main>
  );
}
