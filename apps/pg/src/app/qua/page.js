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
 * Flow: scan QR or type (roster search, offline) → server check → MỘT thẻ
 * quyết định → một nút xác nhận → pop-up giữa màn hình kể đúng món đã trao.
 *
 * Vì sao chỉ một nút (AIM 10/09): bàn quà có đúng hai vật thể — một chồng TÚI
 * và một thùng HỘP BÚT — và mức 9 là "túi + bút" chứ không thay thế túi. Danh
 * sách từng bậc kèm một nút PHÁT riêng bắt PG phải tự suy ra phải cầm món nào
 * lên, giữa một hàng dài. Hai kiểu nhầm sinh ra từ đó đều tốn đồ thật: bấm cả
 * hai nút là đưa ra hai chiếc túi, còn với SV đã lấy túi từ sáng thì không gì
 * trên màn hình nói rằng lần này chỉ đưa hộp bút. Nay máy tính sẵn một hành
 * động kèm DANH SÁCH MÓN PHẢI CẦM LÊN (xem `lib/gift-plan.js`), và pop-up sau
 * khi phát đọc từ `granted` do server trả — tức là từ những dòng đã thật sự ghi
 * vào sổ, không phải từ cái nút vừa bấm.
 *
 * Camera (11/09): bật khi và chỉ khi màn quét đang hiện — xem `lib/desk-camera.js`
 * cho lỗi "không quét được người tiếp theo" mà bộ điều khiển đó sinh ra để chữa.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { verifyToken, importKey } from '@atl/qr-token';
import { searchRoster } from '@atl/vn-text';
import { getRoster, getSession, getActiveCheckpoint } from '@/lib/session';
import { canOpenGiftDesk } from '@/lib/device-role';
import { giftPlan, itemNames } from '@/lib/gift-plan';
import { feedback, holdWakeLock } from '@/lib/scanner';
import { createDeskCamera } from '@/lib/desk-camera';

const DEV_KEY = 'atl2026-dev-key-do-not-use-in-production';

const maskPhone = (p) => (p ? p.replace(/^(\d{3})\d{4}(\d{2,})$/, '$1····$2') : null);

const hhmm = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const CAMERA_HINT = {
  denied: 'Không mở được camera — dùng ô gõ dưới',
  broken: 'Bộ đọc mã không khởi động — tải lại trang',
  starting: 'Đang mở camera…',
};

export default function GiftCounterPage() {
  const router = useRouter();
  const [session, setSession] = useState(undefined);
  const [checkpoint, setCheckpoint] = useState(null); // điểm máy đang đứng
  const [online, setOnline] = useState(true);
  const [query, setQuery] = useState('');
  const [roster, setRoster] = useState([]);
  const [card, setCard] = useState(null);      // entitlement card from server
  const [busy, setBusy] = useState(false);
  // Một mô hình duy nhất cho mọi thứ cần PG dừng lại và đọc: {kind, title,
  // lines, done}. `done` = xong lượt này, đóng lại là sang người tiếp theo.
  const [modal, setModal] = useState(null);
  const [camera, setCamera] = useState('off');
  const videoRef = useRef(null);
  const keyRef = useRef(null);
  // MỘT bộ điều khiển camera cho cả vòng đời trang (lỗi 11/09: trước đây handle
  // của scanner không bao giờ được giữ, camera cũ không tắt và cứ mở lại thẻ
  // của SV vừa rồi).
  const camRef = useRef(null);
  if (!camRef.current) camRef.current = createDeskCamera({ onState: setCamera });

  useEffect(() => {
    (async () => {
      const s = await getSession();
      if (!s) { router.replace('/'); return; }
      // Khoá giải mã phải sẵn TRƯỚC khi màn quét hiện: camera nay tự bật ngay
      // khi có phiên, và một mã đọc được trước khi có khoá sẽ bị báo sai.
      keyRef.current = await importKey(process.env.NEXT_PUBLIC_ATL_HMAC_KEY || DEV_KEY);
      setCheckpoint(await getActiveCheckpoint());
      setSession(s);
      setRoster(await getRoster());
    })();
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    let lock;
    holdWakeLock().then((l) => { lock = l; });
    const cam = camRef.current;
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
      cam.stop();
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
    setBusy(true); setModal(null);
    try {
      setCard(await api({ action: 'check', student_seq: seq }));
      setQuery('');
      feedback('ok');
    } catch (e) {
      feedback('bad');
      setModal({ kind: 'bad', title: 'KHÔNG TRA ĐƯỢC', lines: [e.message] });
    } finally {
      setBusy(false);
    }
  }, [api]);

  const redeem = async (tier) => {
    if (busy || !tier) return;
    setBusy(true);
    const who = card?.student?.full_name ?? '';
    try {
      const d = await api({
        action: 'redeem',
        student_seq: card.student.seq,
        gift_tier_id: tier.id,
      });
      feedback('ok');
      setCard(d);
      // Nguồn sự thật là `granted` — những dòng server vừa ghi. Nếu vì lý do gì
      // đó server không trả, thà nói tên bậc vừa bấm còn hơn nói bừa cả hai.
      const items = d.granted?.length ? d.granted.map((g) => g.name) : [tier.name];
      setModal({ kind: 'ok', title: 'ĐÃ PHÁT QUÀ', who, items, done: true });
    } catch (e) {
      feedback('bad');
      setModal({ kind: 'bad', title: 'CHƯA PHÁT ĐƯỢC', lines: [e.message], who });
    } finally {
      setBusy(false);
    }
  };

  const nextPerson = () => { setModal(null); setCard(null); setQuery(''); };

  const results = useMemo(
    () => (query.trim() ? searchRoster(roster, query, { limit: 6 }).results : []),
    [roster, query],
  );

  // ---- scan path ----
  const onScan = useCallback(async (raw) => {
    const v = await verifyToken(raw, keyRef.current);
    if (!v.valid) {
      feedback('bad');
      setModal({ kind: 'bad', title: 'MÃ KHÔNG HỢP LỆ', lines: ['Quét lại, hoặc gõ tên/SĐT ở ô dưới'] });
      return;
    }
    await check(v.studentSeq);
  }, [check]);

  const startCamera = useCallback(
    () => camRef.current.start(videoRef.current, onScan),
    [onScan],
  );

  // Camera sáng khi và chỉ khi màn quét đang hiện. Thẻ SV hiện lên — dù do
  // quét hay gõ tay — là tắt; bấm NGƯỜI TIẾP THEO là tự bật lại, PG không phải
  // chạm vào khung camera nữa.
  const scanning = session !== undefined && canOpenGiftDesk(checkpoint) && !card;
  useEffect(() => {
    if (scanning) startCamera();
    else camRef.current.stop();
  }, [scanning, startCamera]);

  if (session === undefined) return null;

  // Trao quà tập trung một chỗ (AIM 10/09): chỉ máy đang đứng ở Quầy đổi quà
  // mới trao được. Trước đây mọi máy đều mở được màn này — cùng lớp lỗi với
  // quầy vé hội trường, và ở đây hậu quả là phát nhầm một phần quà thật.
  // Server cũng từ chối (403), màn này chỉ là lớp nói cho người nghe.
  if (!canOpenGiftDesk(checkpoint)) {
    return (
      <main className="screen">
        <div className="pad" style={{ paddingTop: 40 }}>
          <div className="alert warn" style={{ fontSize: 16 }}>
            <b style={{ fontSize: 19 }}>MÁY NÀY KHÔNG PHẢI QUẦY ĐỔI QUÀ</b>
            Quà được trao tập trung tại một bàn duy nhất. Nếu bạn đang trực bàn
            trao quà, báo BTC chuyển máy này sang điểm “Quầy đổi quà” — khoảng
            20 giây sau máy sẽ tự nhận.
          </div>
          <button className="primary" style={{ marginTop: 18 }}
            onClick={() => router.push('/quet')}>
            VỀ MÀN QUÉT
          </button>
        </div>
      </main>
    );
  }

  const plan = card ? giftPlan(card) : null;

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

      {card ? (
        <div className="pad">
          <p className="name" style={{ fontSize: 22, margin: '6px 0 2px' }}>
            {card.student.full_name}
          </p>
          <p className="meta" style={{ margin: 0 }}>
            {card.student.lookup_code} · {card.student.student_code ?? '—'} ·{' '}
            <b>{card.student.badge_count} badge</b>
          </p>

          <GiftDecision plan={plan} busy={busy} onRedeem={redeem} />

          <button className="ghost" style={{ marginTop: 14 }} onClick={nextPerson}>
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
                {CAMERA_HINT[camera] ?? 'Chạm để quét QR'}
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

      {/* Pop-up giữa màn hình, không tự tắt: PG đưa đồ xong mới bấm (AIM 10/09
          — màn hình thấp làm dòng kết quả dưới đáy gần như không đọc được). */}
      {modal && (
        <div className="modal-back" role="dialog" aria-modal="true">
          <div className={`modal-card ${modal.kind}`}>
            <p className="verdict">{modal.title}</p>
            {modal.items?.length > 0 && (
              <p className="name">{modal.items.join(' + ')}</p>
            )}
            {modal.items?.length > 0 && modal.who && (
              <p className="meta">Trao cho {modal.who}</p>
            )}
            {!modal.items?.length && modal.lines?.map((l, i) => (
              <p key={i} className={i === 0 ? 'name' : 'meta'} style={{ fontSize: i === 0 ? 22 : undefined }}>{l}</p>
            ))}
            <button className="modal-go" onClick={modal.done ? nextPerson : () => setModal(null)}>
              {modal.done ? 'HOÀN TẤT — NGƯỜI TIẾP THEO' : 'ĐÓNG'}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

/**
 * Một trạng thái, một câu, tối đa một nút.
 *
 * `hand` là danh sách món phải cầm lên — in to nhất trên màn hình, vì đó là
 * thông tin duy nhất PG cần trong ba giây đứng trước một người.
 */
function GiftDecision({ plan, busy, onRedeem }) {
  if (!plan) return null;

  if (plan.state === 'none') {
    return (
      <div className="alert warn" style={{ marginTop: 14 }}>
        <b>Sự kiện chưa cấu hình bậc quà</b>
        Báo BTC mở trang quản trị → tab Cấu hình → Bậc quà.
      </div>
    );
  }

  if (plan.state === 'locked') {
    return (
      <div className="result info" style={{ padding: 16, marginTop: 14, borderRadius: 12 }}>
        <p className="verdict">CHƯA ĐỦ ĐIỀU KIỆN</p>
        <p className="name">Còn thiếu {plan.missing} badge</p>
        <p className="meta">Đủ {plan.next.required} badge sẽ nhận {plan.next.name}.</p>
      </div>
    );
  }

  if (plan.state === 'out') {
    return (
      <div className="result bad" style={{ padding: 16, marginTop: 14, borderRadius: 12 }}>
        <p className="verdict">ĐÃ HẾT QUÀ</p>
        <p className="name">{itemNames(plan.shortfall)}</p>
        <p className="meta">Báo BTC nạp thêm kho; SV quay lại sau, quyền lợi không mất.</p>
      </div>
    );
  }

  if (plan.state === 'done') {
    return (
      <>
        <div className="result ok" style={{ padding: 16, marginTop: 14, borderRadius: 12 }}>
          <p className="verdict">{plan.next ? 'ĐÃ NHẬN ĐỦ PHẦN NÀY' : 'ĐÃ NHẬN ĐỦ QUÀ'}</p>
          <p className="name">Không đưa thêm gì</p>
          <p className="meta">
            {plan.already.map((t) => `${t.name} lúc ${hhmm(t.redeemed_at)}`).join(' · ')}
          </p>
        </div>
        {plan.next && (
          <div className="alert warn" style={{ marginTop: 10 }}>
            <b>Còn thiếu {plan.missing} badge để nhận thêm {plan.next.name}</b>
            Mời SV thu thập thêm rồi quay lại quầy.
          </div>
        )}
      </>
    );
  }

  // state === 'ready'
  const low = plan.hand.filter((t) => t.stock === 'low' && t.left != null);
  return (
    <>
      <div className="result ok" style={{ padding: 16, marginTop: 14, borderRadius: 12 }}>
        <p className="verdict">{plan.already.length ? 'TRAO THÊM' : 'TRAO'}</p>
        <p className="name">{itemNames(plan.hand)}</p>
        <p className="meta">
          {plan.hand.length > 1
            ? `${plan.hand.length} món — đưa đủ rồi mới bấm xác nhận`
            : 'Đưa cho SV rồi bấm xác nhận'}
        </p>
      </div>

      {plan.already.length > 0 && (
        <div className="alert warn" style={{ marginTop: 10 }}>
          <b>SV đã nhận trước đó — KHÔNG đưa lại</b>
          {plan.already.map((t) => `${t.name} lúc ${hhmm(t.redeemed_at)}`).join(' · ')}
        </div>
      )}

      {plan.shortfall.length > 0 && (
        <div className="alert bad" style={{ marginTop: 10 }}>
          <b>HẾT {itemNames(plan.shortfall).toUpperCase()}</b>
          SV đủ điều kiện nhưng kho đã cạn — trao phần còn lại, báo BTC nạp thêm
          rồi mời SV quay lại lấy nốt.
        </div>
      )}

      {low.length > 0 && (
        <p className="meta" style={{ marginTop: 8 }}>
          Kho gần cạn: {low.map((t) => `${t.name} còn ${t.left}`).join(' · ')}
        </p>
      )}

      <button className="primary" style={{ marginTop: 14 }}
        disabled={busy} onClick={() => onRedeem(plan.target)}>
        XÁC NHẬN ĐÃ TRAO — MỨC {plan.target.required}
      </button>
    </>
  );
}
