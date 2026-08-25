'use client';

/**
 * Device claim — the briefing gate.
 *
 * This screen is where tomorrow's offline capability is actually established,
 * so it refuses to proceed on a phone that cannot do the job. A device that
 * fails a blocker here does not go out; that rule is the whole point of the
 * seven-step check, and enforcing it in software means it does not depend on
 * whoever is running the briefing remembering to look.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { capabilities, deviceVerdict } from '@atl/scan-queue/environment';
import { claimDevice, getSession } from '@/lib/session';

export default function ClaimPage() {
  const router = useRouter();
  const [verdict, setVerdict] = useState(null);
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [existing, setExisting] = useState(null);

  useEffect(() => {
    setVerdict(deviceVerdict(capabilities()));
    getSession().then((s) => s && setExisting(s));
  }, []);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await claimDevice({ claimCode: code, pin });
      router.push('/quet');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!verdict) return null;

  if (existing) {
    return (
      <main className="screen pad">
        <h1>Máy đã sẵn sàng</h1>
        <div className="card">
          <div style={{ fontSize: 22, fontWeight: 700 }}>{existing.device.label}</div>
          <p style={{ margin: '4px 0 0' }}>
            {existing.device.staff_name} · {existing.device.zone_name ?? 'chưa gán khu vực'}
          </p>
          <p className="muted">{existing.event?.name}</p>
        </div>
        <button className="primary" onClick={() => router.push('/quet')}>MỞ MÀN QUÉT</button>
        <p className="muted" style={{ marginTop: 16 }}>
          Cần đổi sang máy khác? Báo giám sát thu hồi mã trước, đừng tự nhập mã mới —
          hàng đợi chưa gửi trên máy này sẽ mất.
        </p>
      </main>
    );
  }

  const blocked = !verdict.ok;

  return (
    <main className="screen pad">
      <h1>Nhận máy quét</h1>
      <p>Nhập mã in trên thẻ thiết bị được phát ở buổi briefing.</p>

      {verdict.blockers.map((b) => (
        <div className="alert bad" key={b.code}>
          <b>⛔ {b.message}</b>
          {b.fix}
        </div>
      ))}
      {verdict.warnings.map((w) => (
        <div className="alert warn" key={w.code}>
          <b>⚠️ {w.message}</b>
          {w.fix}
        </div>
      ))}

      {blocked ? (
        <>
          <p className="muted">
            Máy này chưa dùng để quét được. Xử lý theo hướng dẫn phía trên rồi mở lại trang,
            hoặc báo giám sát để nhận máy mượn.
          </p>
          <button className="ghost" onClick={() => location.reload()}>KIỂM TRA LẠI</button>
        </>
      ) : (
        <form onSubmit={submit}>
          <label htmlFor="code" style={{ display: 'block', marginTop: 18, marginBottom: 6, fontWeight: 600 }}>
            Mã thiết bị
          </label>
          <input
            id="code" className="code" type="text" inputMode="text"
            autoComplete="off" autoCapitalize="characters" maxLength={7}
            placeholder="K7M3QX" value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^0-9a-zA-Z]/g, '').toUpperCase())}
          />

          <label htmlFor="pin" style={{ display: 'block', marginTop: 16, marginBottom: 6, fontWeight: 600 }}>
            Đặt mã PIN 4 số
          </label>
          <input
            id="pin" className="code" type="tel" inputMode="numeric"
            autoComplete="off" maxLength={4} placeholder="••••" value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          />
          <p className="muted">Dùng để mở khoá lại khi máy tự khoá. Đừng dùng ngày sinh.</p>

          {error && <div className="alert bad" style={{ marginTop: 12 }}>{error}</div>}

          <button
            className="primary" type="submit" style={{ marginTop: 18 }}
            disabled={busy || code.length !== 6 || pin.length !== 4}
          >
            {busy ? 'ĐANG TẢI DANH SÁCH…' : 'NHẬN MÁY'}
          </button>
          <p className="muted" style={{ marginTop: 10 }}>
            Bước này cần wifi tốt — nó tải sẵn danh sách sinh viên để ngày mai quét được
            khi không có mạng.
          </p>
        </form>
      )}
    </main>
  );
}
