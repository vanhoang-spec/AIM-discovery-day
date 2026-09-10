'use client';

/**
 * Admin console v1 — one page, four tabs, desktop-first.
 *
 * Reads poll /api/admin/overview every 5s from the pre-aggregated rollups;
 * the header always shows "dữ liệu tính đến HH:MM:SS" because with 40
 * offline-first scanners the dashboard is honest-stale by design, never
 * fake-realtime.
 *
 * Every mutating action asks for a typed reason and rides an actor name to
 * audit_log. Changes that narrow eligibility (raise y, raise a tier) come
 * back once as a dry run with the blast radius; the admin confirms with the
 * numbers in front of them.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const KEY_STORE = 'atl_admin_key';
const ACTOR_STORE = 'atl_admin_actor';
const EVENT_STORE = 'atl_admin_event';

/**
 * Công cụ theo khu vực — TẮT cho Discovery Day 12/09/2026.
 *
 * AIM chốt 10/09: không chạy Giờ Vàng ×2 và không dùng bảng điều phối theo
 * khu vực, nên hai khối đó chỉ làm rối bảng điều khiển cho nhân sự trực. Zone
 * vẫn tồn tại trong dữ liệu và vẫn hiện như nhãn nhóm của từng điểm quét —
 * chỉ các CÔNG CỤ thao tác theo zone là ẩn.
 *
 * Bật lại cho mùa sau: đổi thành true. Toàn bộ API và bảng dữ liệu phía dưới
 * vẫn nguyên vẹn, không có gì phải dựng lại.
 */
const SHOW_ZONE_TOOLS = false;

function useAdminFetch(accessKey) {
  return useCallback(async (path, init = {}) => {
    const res = await fetch(path, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${accessKey}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  }, [accessKey]);
}

const t = (iso) => iso ? new Date(iso).toLocaleTimeString('vi-VN', { hour12: false }) : '—';

/* ---------------- Tổng quan ---------------- */

function Overview({ api, actor, eventId }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [gMsg, setGMsg] = useState(null);

  const goldenAct = async (body) => {
    setGMsg(null);
    try {
      await api('/api/admin/golden', {
        method: 'POST',
        body: JSON.stringify({ event: eventId, actor, ...body }),
      });
      setGMsg(null);
    } catch (e) { setGMsg(e.message); }
  };

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const d = await api(`/api/admin/overview?event=${eventId}`);
        if (alive) { setData(d); setErr(null); }
      } catch (e) { if (alive) setErr(e.message); }
    };
    tick();
    const iv = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(iv); };
  }, [api, eventId]);

  if (err) return <p className="admin-err">Lỗi tải dashboard: {err}</p>;
  if (!data) return <p className="muted">Đang tải…</p>;

  const { totals, zones, tiers, special, devices, drift, threshold_check: tc, golden,
          badge_histogram: hist = [] } = data;
  // Ngưỡng quà đặc biệt (bậc 1). Chưa tạo tier thì chỉ hiển thị phân bố thô.
  const giftReq = tiers[0]?.required_badges ?? null;
  const goldenActive = golden?.active;
  const maxScan = Math.max(1, ...zones.map((z) => z.scans_15m));

  return (
    <div>
      <p className="admin-stamp">Dữ liệu tính đến <b>{t(data.generated_at)}</b> · làm mới mỗi 5s</p>

      <div className="stat-row">
        <div className="stat"><b>{totals.registered}</b><span>đã đăng ký</span></div>
        <div className="stat"><b>{totals.checked_in}</b><span>đã check-in</span></div>
        <div className="stat"><b>{totals.badges_total}</b><span>tổng badge</span></div>
        <div className={`stat ${drift > 0 ? 'stat-bad' : 'stat-ok'}`}>
          <b>{drift}</b><span>lệch bộ đếm {drift === 0 ? '(sạch)' : '— cần xem!'}</span>
        </div>
      </div>

      {tc?.mismatch && (
        <p className="admin-alert">
          ⚠️ Ngưỡng y = {tc.configured_threshold} CAO HƠN tổng badge một SV có thể đạt
          ({tc.available_total}) — không ai đủ điều kiện vào HĐ đặc biệt.
          Sửa y ở tab Cấu hình, hoặc kiểm tra lại trọng số các hoạt động.
        </p>
      )}

      {SHOW_ZONE_TOOLS && goldenActive && (
        <div className="gold-banner">
          <span>
            ⚡ <b>GIỜ VÀNG — {golden.zone_name}</b> · còn {Math.ceil(golden.seconds_left / 60)} phút
            · đã phát {golden.badges_issued}/{golden.badge_cap}
            · ngân sách ngày còn {golden.budget_left}
          </span>
          <button type="button" className="admin-btn"
            onClick={() => goldenAct({ action: 'close' })}>Đóng sớm</button>
        </div>
      )}
      {gMsg && <p className="admin-err">{gMsg}</p>}

      {SHOW_ZONE_TOOLS && (<>
      <h3>Khu vực — 15 phút gần nhất</h3>
      <table className="admin-table">
        <thead><tr><th>Zone</th><th className="num">Lượt quét</th><th className="num">Badge</th><th></th><th></th></tr></thead>
        <tbody>
          {zones.map((z) => (
            <tr key={z.id}>
              <td>{z.name}</td>
              <td className="num">{z.scans_15m}</td>
              <td className="num">{z.badges_15m}</td>
              <td className="bar-cell">
                <div className="bar" style={{ width: `${(z.scans_15m / maxScan) * 100}%` }} />
              </td>
              <td>
                <button type="button" className="admin-btn" disabled={goldenActive}
                  title={goldenActive ? 'Đang có một Giờ Vàng chạy' : 'Mở ×2 tại zone này 40 phút'}
                  onClick={() => {
                    if (window.confirm(`Mở Giờ Vàng ×2 tại "${z.name}" trong 40 phút (nắp 80 badge)?
Nhớ báo MC và cắm biển zone.`)) {
                      goldenAct({ action: 'activate', zone_id: z.id });
                    }
                  }}>⚡</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted" style={{ marginTop: -10 }}>
        ⚡ = mở Giờ Vàng ×2 (40 phút · nắp 80 · ngân sách ngày {golden ? golden.golden_budget : 300}).
        Kênh báo sinh viên là MC + biển zone + PG đọc khi quét — app SV không nhận thông báo đẩy.
      </p>
      </>)}

      <h3>Phân bố badge — dự trù quà đặc biệt</h3>
      {hist.length === 0 ? (
        <p className="muted">Chưa có sinh viên nào có badge.</p>
      ) : (
        <>
          <table className="admin-table" style={{ maxWidth: 640 }}>
            <thead><tr><th className="num">Số badge</th><th className="num">Số SV</th><th></th></tr></thead>
            <tbody>
              {hist.map((h) => {
                const near = giftReq != null && h.badges >= giftReq - 2 && h.badges < giftReq;
                const over = giftReq != null && h.badges >= giftReq;
                return (
                  <tr key={h.badges}>
                    <td className="num">{h.badges}</td>
                    <td className="num">{h.students}</td>
                    <td className={near ? 'cell-warn' : over ? 'cell-ok' : ''}>
                      {near && 'tiệm cận ngưỡng quà'}
                      {over && 'đã đủ đổi quà'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {giftReq != null && (
            <p className="muted" style={{ marginTop: -6 }}>
              Sắp đủ (còn 1–2 badge): <b>
                {hist.filter((h) => h.badges >= giftReq - 2 && h.badges < giftReq)
                     .reduce((s, h) => s + h.students, 0)}</b> SV ·
              đã đủ ngưỡng {giftReq}: <b>
                {hist.filter((h) => h.badges >= giftReq).reduce((s, h) => s + h.students, 0)}</b> SV ·
              kho còn: <b>{tiers[0] ? tiers[0].stock_total - tiers[0].stock_issued : '—'}</b>.
              Cột "sắp đủ" là con số dự trù kho — nó sẽ gõ cửa quầy quà trong giờ tới.
            </p>
          )}
        </>
      )}

      <h3>Phễu quà</h3>
      <table className="admin-table">
        <thead><tr><th>Bậc</th><th className="num">Ngưỡng</th><th className="num">Đủ điều kiện</th><th className="num">Đã đổi</th><th className="num">Kho</th></tr></thead>
        <tbody>
          {tiers.map((g) => {
            const left = g.stock_total - g.stock_issued;
            return (
              <tr key={g.tier}>
                <td>{g.tier} — {g.gift_name}</td>
                <td className="num">{g.required_badges}</td>
                <td className="num">{g.qualified}</td>
                <td className="num">{g.redeemed}</td>
                <td className={`num ${left === 0 ? 'cell-bad' : left < g.stock_total * 0.15 ? 'cell-warn' : ''}`}>
                  {g.stock_issued}/{g.stock_total}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h3>Hoạt động đặc biệt</h3>
      <table className="admin-table">
        <thead><tr><th>Tên</th><th className="num">Đã cấp</th><th className="num">Đang giữ</th><th className="num">Còn</th><th className="num">SV đủ điều kiện</th></tr></thead>
        <tbody>
          {special.map((s) => (
            <tr key={s.special_activity_id}>
              <td>{s.name}</td>
              <td className="num">{s.claimed}</td>
              <td className="num">{s.on_hold}</td>
              <td className="num">{s.available}</td>
              <td className="num">{s.students_eligible}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Thiết bị PG {devices.length === 0 && <span className="muted">(chưa máy nào nhận)</span>}</h3>
      {devices.length > 0 && (
        <table className="admin-table">
          <thead><tr><th>Máy</th><th>PG</th><th>Zone</th><th className="num">Hàng đợi</th><th className="num">Pin</th><th>Sync</th></tr></thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.device_id} className={d.sync_alert ? 'row-bad' : ''}>
                <td>{d.label}</td>
                <td>{d.staff_name ?? '—'}</td>
                <td>{d.zone_name ?? '—'}</td>
                <td className="num">{d.queue_depth}</td>
                <td className={`num ${d.battery_alert ? 'cell-bad' : ''}`}>
                  {d.battery_pct != null ? `${d.battery_pct}%` : '—'}
                </td>
                <td>{d.sync_alert ? `⚠️ ${Math.round((d.seconds_since_sync ?? 0) / 60)} phút trước` : t(d.last_sync_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ---------------- Sinh viên ---------------- */

function Students({ api, actor, eventId }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [detail, setDetail] = useState(null);
  const [msg, setMsg] = useState(null);
  const [form, setForm] = useState({ action: 'award', checkpoint_id: '', reason: '' });
  const debounce = useRef(null);

  const search = useCallback((text) => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      if (!text.trim()) { setResults([]); return; }
      try {
        const d = await api(`/api/admin/students?event=${eventId}&q=${encodeURIComponent(text)}`);
        setResults(d.students);
      } catch (e) { setMsg({ bad: true, text: e.message }); }
    }, 250);
  }, [api, eventId]);

  const open = useCallback(async (id) => {
    setMsg(null);
    const d = await api(`/api/admin/students/${id}?event=${eventId}`);
    setDetail(d);
    setForm({ action: 'award', checkpoint_id: d.awardable[0]?.id ?? '', reason: '' });
  }, [api, eventId]);

  const act = async (action, checkpointId, reason) => {
    try {
      const r = await api(`/api/admin/students/${detail.student.id}`, {
        method: 'POST',
        body: JSON.stringify({ event: eventId, action, checkpoint_id: checkpointId, reason, actor }),
      });
      setMsg({ bad: false, text: `Xong — badge hiện tại: ${r.badge_count}` });
      open(detail.student.id);
    } catch (e) {
      setMsg({ bad: true, text: e.message });
    }
  };

  return (
    <div className="admin-two-col">
      <div>
        <input
          className="admin-input" placeholder="Tên · SĐT · MSSV · mã 6 ký tự — gõ là tìm"
          value={q} onChange={(e) => { setQ(e.target.value); search(e.target.value); }}
        />
        <ul className="admin-hits">
          {results.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => open(s.id)}>
                <b>{s.full_name}</b>
                <span>{s.lookup_code} · {s.student_code ?? '—'} · {s.badge_count} badge</span>
              </button>
            </li>
          ))}
          {q && results.length === 0 && <li className="muted">Không thấy ai khớp.</li>}
        </ul>
      </div>

      {detail && (
        <div className="admin-detail">
          <h3>{detail.student.full_name}</h3>
          <p className="muted">
            {detail.student.lookup_code} · {detail.student.school_name ?? detail.student.school_other ?? '—'}
            {' '}· MSSV {detail.student.student_code ?? '—'}<br />
            <b>{detail.student.badge_count} badge</b> — dùng cho cả quà và suất đặc biệt
          </p>

          <h4>Badge</h4>
          <table className="admin-table">
            <thead><tr><th>Hoạt động</th><th>Lúc</th><th>Nguồn</th><th className="num">Badge cộng</th><th></th></tr></thead>
            <tbody>
              {detail.badges.map((b) => (
                <tr key={b.checkpoint_id + (b.voided_at ?? '')} className={b.voided_at ? 'row-void' : ''}>
                  <td>{b.name}</td>
                  <td>{t(b.awarded_at)}</td>
                  <td>{b.source}</td>
                  <td className="num">{b.badge_weight > 0 ? `+${b.badge_weight}` : '—'}</td>
                  <td>
                    {b.voided_at
                      ? <span className="muted">đã gỡ: {b.void_reason}</span>
                      : <button type="button" className="link-danger" onClick={() => {
                          const reason = prompt(`Lý do gỡ badge "${b.name}"? (bắt buộc)`);
                          if (reason) act('void', b.checkpoint_id, reason);
                        }}>gỡ</button>}
                  </td>
                </tr>
              ))}
              {detail.badges.length === 0 && <tr><td colSpan={5} className="muted">Chưa có badge.</td></tr>}
            </tbody>
          </table>

          {detail.redemptions.length > 0 && (
            <p className="muted">Đã đổi quà: {detail.redemptions.map((r) => `bậc ${r.tier} (${r.gift_name})`).join(', ')}</p>
          )}

          <h4>Cấp badge thủ công</h4>
          <div className="admin-form-row">
            <select
              className="admin-input"
              value={form.checkpoint_id}
              onChange={(e) => setForm((f) => ({ ...f, checkpoint_id: e.target.value }))}
            >
              {detail.awardable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input
              className="admin-input" placeholder="Lý do (bắt buộc, ≥5 ký tự)"
              value={form.reason}
              onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
            />
            <button
              type="button" className="admin-btn"
              onClick={() => act('award', Number(form.checkpoint_id), form.reason)}
            >Cấp</button>
          </div>
          {msg && <p className={msg.bad ? 'admin-err' : 'admin-ok'}>{msg.text}</p>}
        </div>
      )}
    </div>
  );
}

/* ---------------- Cấu hình ---------------- */

function Config({ api, actor, eventId }) {
  const [cfg, setCfg] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    setCfg(await api(`/api/admin/config?event=${eventId}`));
  }, [api, eventId]);
  useEffect(() => { load().catch((e) => setMsg({ bad: true, text: e.message })); }, [load]);

  const patch = async (body) => {
    setMsg(null);
    try {
      const r = await api('/api/admin/config', {
        method: 'PATCH',
        body: JSON.stringify({ event: eventId, actor, ...body }),
      });
      if (r.dry_run) {
        if (window.confirm(`${r.message}\n\nTiếp tục?`)) {
          return patch({ ...body, confirm: true });
        }
        return;
      }
      setMsg({ bad: false, text: 'Đã lưu.' });
      load();
    } catch (e) {
      setMsg({ bad: true, text: e.message });
    }
  };

  if (!cfg) return <p className="muted">Đang tải…</p>;
  const ev = cfg.event;

  return (
    <div>
      {msg && <p className={msg.bad ? 'admin-err' : 'admin-ok'}>{msg.text}</p>}

      <h3>Luật sự kiện</h3>
      <table className="admin-table admin-config">
        <tbody>
          <tr>
            <td>y — số <b>badge</b> (tổng, có trọng số) để mở hoạt động đặc biệt</td>
            <td className="num">{ev.special_threshold_y}</td>
            <td><button type="button" className="admin-btn" onClick={() => {
              const v = prompt('y mới?', ev.special_threshold_y);
              if (v != null) patch({ type: 'event_y', value: Number(v) });
            }}>Sửa</button></td>
          </tr>
          <tr>
            <td>z — mỗi SV được nhận tối đa mấy suất đặc biệt</td>
            <td className="num">{ev.special_claim_limit}</td>
            <td><button type="button" className="admin-btn" onClick={() => {
              const v = prompt('z mới?', ev.special_claim_limit);
              if (v != null) patch({ type: 'event_field', field: 'special_claim_limit', value: Number(v) });
            }}>Sửa</button></td>
          </tr>
          <tr>
            <td>Thang quà — cộng dồn hay chỉ bậc cao nhất</td>
            <td>{ev.gift_ladder_mode === 'cumulative' ? 'Cộng dồn' : 'Bậc cao nhất'}</td>
            <td><button type="button" className="admin-btn" onClick={() =>
              patch({ type: 'event_field', field: 'gift_ladder_mode',
                      value: ev.gift_ladder_mode === 'cumulative' ? 'highest_only' : 'cumulative' })
            }>Đổi</button></td>
          </tr>
        </tbody>
      </table>

      <h3>Bậc quà</h3>
      <table className="admin-table">
        <thead><tr><th>Bậc</th><th className="num">Ngưỡng badge</th><th className="num">Kho</th><th className="num">Đã phát</th><th></th></tr></thead>
        <tbody>
          {cfg.tiers.map((g) => (
            <tr key={g.id}>
              {/* Ô nhập tại chỗ thay hai prompt() nối nhau: Chrome nuốt hộp
                  thoại thứ hai khi người dùng tick "Ngăn trang tạo thêm hộp
                  thoại", nên ô Kho biến mất không dấu vết (AIM báo 10/09). */}
              <td>
                {g.tier} —{' '}
                <input className="admin-input" id={`gt-name-${g.id}`} type="text"
                       defaultValue={g.gift_name} style={{ maxWidth: 240 }} />
              </td>
              <td className="num">
                <input className="admin-input" id={`gt-req-${g.id}`} type="number" min="0"
                       defaultValue={g.required_badges}
                       style={{ maxWidth: 84, textAlign: 'right' }} />
              </td>
              <td className="num">
                <input className="admin-input" id={`gt-stock-${g.id}`} type="number" min="0"
                       defaultValue={g.stock_total}
                       style={{ maxWidth: 96, textAlign: 'right' }} />
              </td>
              <td className="num">{g.stock_issued}</td>
              <td>
                <button type="button" className="admin-btn" onClick={() => {
                  patch({ type: 'tier', tier_id: g.id,
                          gift_name: document.getElementById(`gt-name-${g.id}`).value.trim(),
                          required_badges: Number(document.getElementById(`gt-req-${g.id}`).value),
                          stock_total: Number(document.getElementById(`gt-stock-${g.id}`).value) });
                }}>Lưu</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="admin-form-row" style={{ maxWidth: 620 }}>
        <input className="admin-input" id="gt-tier" type="number" placeholder="Bậc" style={{ maxWidth: 70 }} />
        <input className="admin-input" id="gt-name" placeholder="Tên quà mới" />
        <input className="admin-input" id="gt-req" type="number" placeholder="Ngưỡng" style={{ maxWidth: 90 }} />
        <input className="admin-input" id="gt-stock" type="number" placeholder="Kho" style={{ maxWidth: 80 }} />
        <button type="button" className="admin-btn" onClick={async () => {
          setMsg(null);
          try {
            await api('/api/admin/config', {
              method: 'POST',
              body: JSON.stringify({
                event: eventId, actor,
                tier: Number(document.getElementById('gt-tier').value),
                gift_name: document.getElementById('gt-name').value.trim(),
                required_badges: Number(document.getElementById('gt-req').value),
                stock_total: Number(document.getElementById('gt-stock').value),
              }),
            });
            setMsg({ bad: false, text: 'Đã tạo bậc quà.' });
            load();
          } catch (e) { setMsg({ bad: true, text: e.message }); }
        }}>+ Tạo bậc</button>
      </div>
      <p className="muted">
        Sửa <b>tên</b>, <b>ngưỡng</b> hoặc <b>kho</b> ngay trong bảng rồi bấm <b>Lưu</b> ở cuối dòng.
        Tăng ngưỡng sẽ hiện trước số SV bị ảnh hưởng để xác nhận. Kho không đặt được thấp hơn
        số đã phát. Quyền lợi đã cấp không bao giờ bị thu hồi.
      </p>
      <p className="muted">
        <b>Mỗi bậc mang tên đúng MỘT món nó cộng thêm</b> — bậc 1 “Túi quà”, bậc 2 “Hộp bút
        Thiên Long”. Kho bậc 1 là tổng số túi, kho bậc 2 là tổng số hộp bút. Phát bậc cao sẽ tự
        trừ luôn kho bậc dưới nếu SV chưa nhận, nên <b>Đã phát</b> của bậc 1 phải luôn ≥ bậc 2.
        Máy PG và app SV tự ghép tên các bậc lại (“Túi quà + Hộp bút Thiên Long”), vì vậy đừng
        đặt tên bậc trên gồm cả món của bậc dưới.
      </p>

      <h3>Nhân bản sự kiện (Grand Finale / mùa sau)</h3>
      <p className="muted">
        Copy toàn bộ cấu hình — zone, hoạt động, bậc quà, suất, ngưỡng. KHÔNG copy
        người và lịch sử; sự kiện mới sinh ra ở trạng thái <b>đóng đăng ký</b>.
      </p>
      <form className="admin-form-col" onSubmit={async (ev) => {
        ev.preventDefault();
        const f = ev.target;
        setMsg(null);
        try {
          const r = await api('/api/admin/clone', {
            method: 'POST',
            body: JSON.stringify({
              source_event: eventId, actor,
              slug: f.slug.value, name: f.evname.value,
              venue: f.venue.value, city: f.city.value,
              starts_at: f.date.value + 'T08:00:00+07:00',
              ends_at: f.date.value + 'T17:00:00+07:00',
            }),
          });
          setMsg({ bad: false, text:
            `Đã tạo sự kiện #${r.new_event_id}: ${r.zones_copied} zone, ${r.checkpoints_copied} hoạt động, ${r.tiers_copied} bậc quà, ${r.specials_copied} hoạt động đặc biệt.` });
          f.reset();
        } catch (e2) { setMsg({ bad: true, text: e2.message }); }
      }}>
        <div className="admin-form-row">
          <input className="admin-input" name="slug" placeholder="slug (vd: grand-finale)" required />
          <input className="admin-input" name="evname" placeholder="Tên sự kiện" required />
        </div>
        <div className="admin-form-row">
          <input className="admin-input" name="venue" placeholder="Địa điểm" required />
          <input className="admin-input" name="city" placeholder="Thành phố" required />
          <input className="admin-input" name="date" type="date" required />
        </div>
        <button className="admin-btn admin-btn-primary" type="submit">Nhân bản</button>
      </form>
    </div>
  );
}

/* ---------------- Hoạt động ---------------- */

function Checkpoints({ api, actor, eventId }) {
  const [cfg, setCfg] = useState(null);
  const [msg, setMsg] = useState(null);
  const [draft, setDraft] = useState(null); // {id?} being edited, or {new:true}

  const load = useCallback(async () => {
    setCfg(await api(`/api/admin/config?event=${eventId}`));
  }, [api, eventId]);
  useEffect(() => { load().catch((e) => setMsg({ bad: true, text: e.message })); }, [load]);

  const save = async () => {
    setMsg(null);
    try {
      const body = { event: eventId, actor, ...draft };
      const r = draft.new
        ? await api('/api/admin/checkpoints', { method: 'POST', body: JSON.stringify(body) })
        : await api('/api/admin/checkpoints', { method: 'PATCH', body: JSON.stringify(body) });
      setMsg({
        bad: false,
        text: r.rebuilt ? `Đã lưu — tính lại bộ đếm cho ${r.rebuilt} SV.` : 'Đã lưu.',
      });
      setDraft(null);
      load();
    } catch (e) { setMsg({ bad: true, text: e.message }); }
  };

  if (!cfg) return <p className="muted">Đang tải…</p>;

  const field = (k, placeholder, type = 'text') => (
    <input
      className="admin-input" type={type} placeholder={placeholder}
      value={draft[k] ?? ''}
      onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
    />
  );

  return (
    <div>
      {msg && <p className={msg.bad ? 'admin-err' : 'admin-ok'}>{msg.text}</p>}
      <table className="admin-table">
        <thead><tr>
          <th>Hoạt động</th><th>Loại</th><th>Zone</th><th>Giờ</th>
          <th>Tính badge</th><th className="num">Trọng số</th><th>Đang mở</th><th></th>
        </tr></thead>
        <tbody>
          {cfg.checkpoints.map((c) => (
            <tr key={c.id} className={c.is_active ? '' : 'row-void'}>
              <td>{c.name}</td>
              <td>{c.kind}</td>
              <td>{cfg.zones.find((z) => z.id === c.zone_id)?.name ?? '—'}</td>
              <td>{c.starts_at ? `${t(c.starts_at)}–${t(c.ends_at)}` : 'cả ngày'}</td>
              <td>{c.counts_toward_badges ? '✓' : '—'}</td>
              <td className="num">{c.counts_toward_badges ? (c.badge_weight ?? 1) : '—'}</td>
              <td>{c.is_active ? '✓' : 'tắt'}</td>
              <td className="admin-row-actions">
                {(c.kind === 'sponsor_booth' || c.kind === 'diamond_booth') && (
                  <button type="button" className="admin-btn" title="Excel cho nhà tài trợ này"
                    onClick={async () => {
                      const res = await fetch(
                        `/api/admin/export-ntt?event=${eventId}&checkpoint=${c.id}`,
                        { headers: { Authorization: `Bearer ${localStorage.getItem('atl_admin_key')}` } });
                      if (!res.ok) return;
                      const blob = await res.blob();
                      const a = document.createElement('a');
                      a.href = URL.createObjectURL(blob);
                      a.download = (res.headers.get('content-disposition') ?? '')
                        .match(/filename="([^"]+)"/)?.[1] ?? 'NTT.xlsx';
                      a.click();
                      URL.revokeObjectURL(a.href);
                    }}>Excel NTT</button>
                )}
                <button type="button" className="admin-btn" onClick={() =>
                  setDraft({ id: c.id, name: c.name, description: c.description ?? '',
                             location_hint: c.location_hint ?? '',
                             starts_at: c.starts_at ?? '', ends_at: c.ends_at ?? '',
                             badge_weight: c.badge_weight ?? 1 })
                }>Sửa</button>
                <button type="button" className="admin-btn" onClick={() => {
                  const reason = `Đổi counts_toward_badges cho "${c.name}"`;
                  void reason;
                  api('/api/admin/checkpoints', {
                    method: 'PATCH',
                    body: JSON.stringify({ event: eventId, actor, id: c.id,
                                           counts_toward_badges: !c.counts_toward_badges }),
                  }).then((r) => {
                    setMsg({ bad: false, text: r.rebuilt ? `Đã đổi — tính lại ${r.rebuilt} SV.` : 'Đã đổi.' });
                    load();
                  }).catch((e) => setMsg({ bad: true, text: e.message }));
                }}>{c.counts_toward_badges ? 'Ngừng tính badge' : 'Tính badge'}</button>
                <button type="button" className="admin-btn" onClick={() => {
                  api('/api/admin/checkpoints', {
                    method: 'PATCH',
                    body: JSON.stringify({ event: eventId, actor, id: c.id, is_active: !c.is_active }),
                  }).then(() => load()).catch((e) => setMsg({ bad: true, text: e.message }));
                }}>{c.is_active ? 'Tắt' : 'Mở'}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {!draft && (
        <div className="admin-form-row">
          <button type="button" className="admin-btn" onClick={() =>
            setDraft({ new: true, kind: 'sponsor_booth', name: '' })
          }>+ Thêm hoạt động</button>
          {SHOW_ZONE_TOOLS && (<>
          <input className="admin-input" id="zn-name" placeholder="Tên zone mới" style={{ maxWidth: 180 }} />
          <button type="button" className="admin-btn" onClick={() => {
            const nm = document.getElementById('zn-name').value.trim();
            if (!nm) return;
            api('/api/admin/zones', {
              method: 'POST',
              body: JSON.stringify({ event: eventId, actor, name: nm }),
            }).then(() => { setMsg({ bad: false, text: 'Đã tạo zone.' }); load(); })
              .catch((e) => setMsg({ bad: true, text: e.message }));
          }}>+ Tạo zone</button>
          </>)}
        </div>
      )}

      {draft && (
        <div className="admin-detail">
          <h4>{draft.new ? 'Hoạt động mới' : 'Sửa hoạt động'}</h4>
          <div className="admin-form-col">
            {field('name', 'Tên hoạt động *')}
            {draft.new && (
              <select className="admin-input" value={draft.kind}
                onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value }))}>
                <option value="entrance">Cổng check-in</option>
                <option value="sponsor_booth">Gian hàng NTT</option>
                <option value="diamond_booth">Gian hàng Kim cương</option>
                <option value="hall_session">Sân khấu chính</option>
                <option value="learning_class">Lớp học</option>
                <option value="bonus">Badge thưởng (không tính thang đặc biệt)</option>
              </select>
            )}
            {field('description', 'Mô tả')}
            {field('location_hint', 'Vị trí (vd: Khu C, gần cổng sau)')}
            <div className="admin-form-row">
              {field('starts_at', 'Bắt đầu', 'datetime-local')}
              {field('ends_at', 'Kết thúc', 'datetime-local')}
            </div>
            <div className="admin-form-row">
              {field('badge_weight', 'Trọng số badge (1–9)', 'number')}
              <span className="muted" style={{ alignSelf: 'center', fontSize: 12.5 }}>
                Kế hoạch AIM 12/09: booth = 1 · Brief Day & Learning zone = 4 · Inspiration = 3.
                Cổng dùng nút "Ngừng tính badge" thay vì trọng số 0.
              </span>
            </div>
            <div className="admin-form-row">
              <button type="button" className="admin-btn admin-btn-primary" onClick={save}>Lưu</button>
              <button type="button" className="admin-btn" onClick={() => setDraft(null)}>Huỷ</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Khảo sát NTT (Track 3) ---------------- */

const Q_TYPES = [
  ['choice', 'Chọn một'], ['multi', 'Chọn nhiều'], ['scale', 'Thang 1–5'], ['text', 'Tự luận'],
];

function SurveyEditor({ initial, booths, onSave, onCancel, busy }) {
  const [f, setF] = useState(initial);
  const setQ = (i, patch) => setF((x) => ({
    ...x, questions: x.questions.map((q, j) => (j === i ? { ...q, ...patch } : q)),
  }));

  return (
    <div className="admin-detail" style={{ marginTop: 12 }}>
      <h4>{f.id ? 'Sửa khảo sát' : 'Khảo sát mới'}</h4>
      <div className="admin-form-col" style={{ maxWidth: 640 }}>
        {!f.id && (
          <select className="admin-input" value={f.checkpoint_id ?? ''}
            onChange={(e) => setF((x) => ({ ...x, checkpoint_id: Number(e.target.value) }))}>
            <option value="">Chọn gian hàng (mỗi booth một khảo sát)…</option>
            {booths.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}
        <input className="admin-input" placeholder="Tiêu đề *" value={f.title}
          onChange={(e) => setF((x) => ({ ...x, title: e.target.value }))} />
        <input className="admin-input" placeholder="Lời mở đầu (tuỳ chọn)" value={f.intro ?? ''}
          onChange={(e) => setF((x) => ({ ...x, intro: e.target.value }))} />
        <div className="admin-form-row">
          <input className="admin-input" style={{ maxWidth: 140 }} placeholder="#RRGGBB"
            value={f.accent_hex ?? ''}
            onChange={(e) => setF((x) => ({ ...x, accent_hex: e.target.value }))} />
          <span className="muted" style={{ alignSelf: 'center', fontSize: 12.5 }}>
            Màu nhấn của NTT — chỉ dùng ở nút và tiêu đề, chữ và nền vẫn của mình
          </span>
        </div>

        {f.questions.map((q, i) => (
          <div key={i} className="admin-form-col"
            style={{ border: '1px solid var(--line-soft)', borderRadius: 8, padding: 10, margin: 0 }}>
            <div className="admin-form-row">
              <select className="admin-input" style={{ maxWidth: 130 }} value={q.type}
                onChange={(e) => setQ(i, { type: e.target.value })}>
                {Q_TYPES.map(([v, t2]) => <option key={v} value={v}>{t2}</option>)}
              </select>
              <input className="admin-input" placeholder={`Câu ${i + 1} *`} value={q.label}
                onChange={(e) => setQ(i, { label: e.target.value })} />
              <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12.5 }}>
                <input type="checkbox" checked={!!q.required}
                  onChange={(e) => setQ(i, { required: e.target.checked })} />bắt buộc
              </label>
              <button type="button" className="admin-btn" onClick={() =>
                setF((x) => ({ ...x, questions: x.questions.filter((_, j) => j !== i) }))
              }>×</button>
            </div>
            {(q.type === 'choice' || q.type === 'multi') && (
              <input className="admin-input" placeholder="Các phương án, cách nhau dấu phẩy"
                value={(q.options ?? []).join(', ')}
                onChange={(e) => setQ(i, {
                  options: e.target.value.split(',').map((x) => x.trim()).filter(Boolean),
                })} />
            )}
          </div>
        ))}

        {f.questions.length < 8 ? (
          <button type="button" className="admin-btn" onClick={() =>
            setF((x) => ({
              ...x,
              questions: [...x.questions, { id: `q${Date.now().toString(36)}`, type: 'choice', label: '', options: [] }],
            }))
          }>+ Thêm câu ({f.questions.length}/8)</button>
        ) : (
          <p className="muted">Đủ 8 câu — trần cứng: khảo sát dài hơn sẽ bị bỏ dở trong hàng chờ.</p>
        )}

        <div className="admin-form-row">
          <button type="button" className="admin-btn admin-btn-primary" disabled={busy}
            onClick={() => onSave(f)}>Lưu</button>
          <button type="button" className="admin-btn" onClick={onCancel}>Huỷ</button>
        </div>
      </div>
    </div>
  );
}

function Surveys({ api, actor, eventId }) {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setData(await api(`/api/admin/surveys?event=${eventId}`));
  }, [api, eventId]);
  useEffect(() => { load().catch((e) => setMsg({ bad: true, text: e.message })); }, [load]);

  const save = async (f) => {
    setBusy(true); setMsg(null);
    try {
      const body = { event: eventId, actor, ...f };
      const r = f.id
        ? await api('/api/admin/surveys', { method: 'PATCH', body: JSON.stringify(body) })
        : await api('/api/admin/surveys', { method: 'POST', body: JSON.stringify(body) });
      setMsg({ bad: false, text: r.version_bumped
        ? 'Đã lưu — câu hỏi đổi nên phiên bản tăng; câu trả lời cũ giữ nguyên phiên bản cũ.'
        : 'Đã lưu.' });
      setDraft(null);
      load();
    } catch (e) { setMsg({ bad: true, text: e.message }); } finally { setBusy(false); }
  };

  if (!data) return <p className="muted">Đang tải…</p>;

  return (
    <div>
      {msg && <p className={msg.bad ? 'admin-err' : 'admin-ok'}>{msg.text}</p>}
      <table className="admin-table">
        <thead><tr>
          <th>Khảo sát</th><th>Gian hàng</th><th className="num">Câu</th><th className="num">Trả lời</th>
          <th className="num">Badge tại booth</th><th>Đang mở</th><th></th>
        </tr></thead>
        <tbody>
          {data.surveys.map((sv) => (
            <tr key={sv.survey_id} className={sv.is_active ? '' : 'row-void'}>
              <td>{sv.title} <span className="muted">v{sv.schema_version}</span></td>
              <td>{sv.checkpoint_name}</td>
              <td className="num">{sv.question_count}</td>
              <td className="num">{sv.responses}</td>
              <td className="num">{sv.badges_at_checkpoint}</td>
              <td>{sv.is_active ? '✓' : 'tắt'}</td>
              <td className="admin-row-actions">
                <button type="button" className="admin-btn" onClick={() =>
                  setDraft({ id: sv.survey_id, title: sv.title, intro: sv.intro,
                             accent_hex: sv.accent_hex, questions: sv.questions ?? [] })
                }>Sửa</button>
                <button type="button" className="admin-btn" onClick={() =>
                  api('/api/admin/surveys', {
                    method: 'PATCH',
                    body: JSON.stringify({ event: eventId, actor, id: sv.survey_id,
                                           is_active: !sv.is_active }),
                  }).then(load).catch((e) => setMsg({ bad: true, text: e.message }))
                }>{sv.is_active ? 'Tắt' : 'Mở'}</button>
              </td>
            </tr>
          ))}
          {data.surveys.length === 0 && (
            <tr><td colSpan={7} className="muted">Chưa có khảo sát nào.</td></tr>
          )}
        </tbody>
      </table>

      {!draft && data.available_booths.length > 0 && (
        <button type="button" className="admin-btn" onClick={() =>
          setDraft({ title: '', intro: '', accent_hex: '', questions: [], checkpoint_id: null })
        }>+ Khảo sát mới</button>
      )}
      {!draft && data.available_booths.length === 0 && data.surveys.length > 0 && (
        <p className="muted">Mọi gian hàng đều đã có khảo sát.</p>
      )}

      {draft && (
        <SurveyEditor initial={draft} booths={data.available_booths}
          onSave={save} onCancel={() => setDraft(null)} busy={busy} />
      )}
    </div>
  );
}

/* ---------------- Vận hành (Layer B) ---------------- */

function Ops({ api, actor, eventId }) {
  const [cfg, setCfg] = useState(null);      // từ /api/admin/config (event + checkpoints)
  const [dev, setDev] = useState(null);      // từ /api/admin/pg-devices
  const [specials, setSpecials] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    const [c, d, sp] = await Promise.all([
      api(`/api/admin/config?event=${eventId}`),
      api(`/api/admin/pg-devices?event=${eventId}`),
      api(`/api/admin/specials?event=${eventId}`),
    ]);
    setCfg(c); setDev(d); setSpecials(sp.activities);
  }, [api, eventId]);
  useEffect(() => { load().catch((e) => setMsg({ bad: true, text: e.message })); }, [load]);

  const call = async (path, method, body, okText = 'Đã lưu.') => {
    setMsg(null);
    try {
      const r = await api(path, { method, body: JSON.stringify({ event: eventId, actor, ...body }) });
      setMsg({ bad: false, text: r.claim_code ? `Đã tạo — mã nhận máy: ${r.claim_code}` : okText });
      load();
      return r;
    } catch (e) { setMsg({ bad: true, text: e.message }); return null; }
  };

  if (!cfg || !dev || !specials) return <p className="muted">Đang tải…</p>;
  const ev = cfg.event;
  const entrances = cfg.checkpoints.filter((c) => c.kind === 'entrance');
  const bonuses = cfg.checkpoints.filter((c) => c.kind === 'bonus');

  return (
    <div>
      {msg && <p className={msg.bad ? 'admin-err' : 'admin-ok'}>{msg.text}</p>}

      <h3>Đăng ký online</h3>
      <div className={`gold-banner`} style={ev.is_registration_open
        ? { background: 'var(--ok-soft)', color: 'var(--ink)' }
        : { background: 'var(--bad-soft)', color: 'var(--ink)' }}>
        <span>
          Form đăng ký online đang <b>{ev.is_registration_open ? 'MỞ' : 'ĐÓNG'}</b>.
          {' '}Đóng chỉ chặn form online — walk-in tại cổng, admin và import vẫn chạy.
        </span>
        <button type="button" className="admin-btn" onClick={() => {
          const next = !ev.is_registration_open;
          if (window.confirm(next ? 'Mở đăng ký online?' : 'ĐÓNG form đăng ký online?')) {
            call('/api/admin/event', 'PATCH', { is_registration_open: next });
          }
        }}>{ev.is_registration_open ? 'Đóng đăng ký' : 'Mở đăng ký'}</button>
      </div>

      <h3>Early Bird</h3>
      <table className="admin-table admin-config">
        <tbody>
          <tr>
            <td>Hạn chót check-in được thưởng (giờ VN)</td>
            <td>{ev.early_bird_until ? t(ev.early_bird_until) : 'chưa đặt'}</td>
            <td><button type="button" className="admin-btn" onClick={() => {
              const v = prompt('Nhập hạn (VD 2026-09-12T08:45), bỏ trống để tắt:',
                ev.early_bird_until ? String(ev.early_bird_until).slice(0, 16) : '2026-09-12T08:45');
              if (v === null) return;
              call('/api/admin/event', 'PATCH',
                { early_bird_until: v ? v + ':00+07:00' : null });
            }}>Sửa</button></td>
          </tr>
          <tr>
            <td>Checkpoint cổng check-in</td>
            <td>{cfg.checkpoints.find((c) => c.id === ev.checkin_checkpoint_id)?.name ?? '—'}</td>
            <td>
              <select className="admin-input" style={{ maxWidth: 220 }}
                value={ev.checkin_checkpoint_id ?? ''}
                onChange={(e) => call('/api/admin/event', 'PATCH',
                  { checkin_checkpoint_id: e.target.value || null })}>
                <option value="">—</option>
                {entrances.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </td>
          </tr>
          <tr>
            <td>Checkpoint badge Early Bird (loại bonus)</td>
            <td>{cfg.checkpoints.find((c) => c.id === ev.early_bird_checkpoint_id)?.name ?? '—'}</td>
            <td>
              <select className="admin-input" style={{ maxWidth: 220 }}
                value={ev.early_bird_checkpoint_id ?? ''}
                onChange={(e) => call('/api/admin/event', 'PATCH',
                  { early_bird_checkpoint_id: e.target.value || null })}>
                <option value="">—</option>
                {bonuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </td>
          </tr>
        </tbody>
      </table>

      <h3>Hoạt động đặc biệt</h3>
      <table className="admin-table">
        <thead><tr><th>Tên</th><th className="num">Suất</th><th className="num">Đã cấp</th><th>Nhận đăng ký</th><th></th></tr></thead>
        <tbody>
          {specials.map((a) => (
            <tr key={a.id}>
              <td>{a.name}</td>
              <td className="num">{a.capacity}</td>
              <td className="num">{a.claimed}</td>
              <td>{a.is_open ? '✓ đang mở' : 'đóng'}</td>
              <td className="admin-row-actions">
                <button type="button" className="admin-btn" onClick={() => {
                  const v = prompt(`Số suất mới cho "${a.name}"? (đã cấp ${a.claimed})`, a.capacity);
                  if (v != null) call('/api/admin/specials', 'PATCH', { id: a.id, capacity: Number(v) });
                }}>Sửa suất</button>
                <button type="button" className="admin-btn" onClick={() => {
                  const v = prompt('Tên hiển thị mới (PG đọc tên này khi cấp suất):', a.name);
                  if (v != null && v.trim()) {
                    call('/api/admin/specials', 'PATCH', { id: a.id, name: v.trim() });
                  }
                }}>Đổi tên</button>
                <button type="button" className="admin-btn" onClick={() =>
                  call('/api/admin/specials', 'PATCH', { id: a.id, is_open: !a.is_open })
                }>{a.is_open ? 'Đóng' : 'Mở'}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* Tổng suất ĐANG MỞ = đúng con số app SV đọc thành "còn N suất", và với
          z=1 cũng là số SV tối đa vào được. Hai hoạt động cùng mở sẽ cộng dồn:
          nếu thực tế chúng dùng chung một hội trường, con số này vượt sức chứa
          thật — chính là cái AIM phát hiện ngày 10/09. */}
      {(() => {
        const open = specials.filter((a) => a.is_open);
        const total = open.reduce((s, a) => s + a.capacity, 0);
        if (!open.length) {
          return <p className="muted" style={{ fontSize: 13 }}>
            Chưa hoạt động nào nhận đăng ký — sinh viên thấy “Đã hết suất”.
          </p>;
        }
        return (
          <p className="muted" style={{ fontSize: 13 }}>
            <b>{open.length}</b> hoạt động đang mở · tổng <b>{total} suất</b> — app sinh viên
            hiển thị đúng con số này, và với z = 1 đây cũng là <b>số SV tối đa</b> nhận suất.
            {open.length > 1 && ' Nhiều hoạt động dùng CHUNG một phòng thì chỉ nên mở một, '
              + 'nếu không tổng suất sẽ vượt sức chứa thật.'}
          </p>
        );
      })()}
      <div className="admin-form-row" style={{ maxWidth: 560 }}>
        <input className="admin-input" id="sp-name" placeholder="Tên hoạt động mới (vd: Meet & Greet)" />
        <input className="admin-input" id="sp-cap" type="number" placeholder="Số suất" style={{ maxWidth: 110 }} />
        <button type="button" className="admin-btn" onClick={() => {
          const name = document.getElementById('sp-name').value.trim();
          const cap = Number(document.getElementById('sp-cap').value);
          if (name && cap) call('/api/admin/specials', 'POST', { name, capacity: cap },
            'Đã tạo — sinh đủ slot, đang ĐÓNG; mở khi sẵn sàng.');
        }}>+ Tạo</button>
      </div>

      <h3>Đội PG & máy quét ({dev.devices.filter((d) => !d.revoked_at).length} máy hoạt động)</h3>
      <table className="admin-table">
        <thead><tr>
          <th>Máy</th><th className="num">Mã nhận máy</th><th>PG</th>
          <th>Đang quét điểm</th><th>Vai trò</th><th>Trạng thái</th><th></th>
        </tr></thead>
        <tbody>
          {dev.devices.map((d) => (
            <tr key={d.id} className={d.revoked_at ? 'row-void' : ''}>
              <td>{d.label}</td>
              <td className="num">
                <code style={{ fontSize: 13 }}>{d.claim_code}</code>{' '}
                {!d.revoked_at && (
                  <button type="button" className="admin-btn" style={{ padding: '2px 8px' }}
                    onClick={() => navigator.clipboard?.writeText(d.claim_code)}>copy</button>
                )}
              </td>
              <td>
                <select className="admin-input" style={{ minWidth: 120 }} disabled={!!d.revoked_at}
                  value={d.pg_staff_id ?? ''}
                  onChange={(e) => call('/api/admin/pg-devices', 'PATCH',
                    { id: d.id, pg_staff_id: e.target.value || null })}>
                  <option value="">—</option>
                  {dev.staff.map((st) => <option key={st.id} value={st.id}>{st.full_name}</option>)}
                </select>
              </td>
              {/* Điều chuyển PG: máy hỏi server mỗi 20 giây và dựng hộp thoại
                  "BTC ĐIỀU CHUYỂN VỊ TRÍ" — PG không còn tự đổi điểm trên máy
                  nữa (yêu cầu 10/09: hay bấm nhầm). Cột Zone cũ đã bỏ: nó
                  không điều khiển gì, chỉ làm rối bảng. */}
              <td>
                <select className="admin-input" style={{ minWidth: 150 }} disabled={!!d.revoked_at}
                  value={d.assigned_checkpoint_id ?? ''}
                  onChange={(e) => call('/api/admin/pg-devices', 'PATCH',
                    { id: d.id, action: 'assign_checkpoint', checkpoint_id: e.target.value || null },
                    e.target.value ? 'Đã điều chuyển — máy PG sẽ báo trong ~20 giây.'
                      : 'Đã gỡ phân công — máy giữ nguyên điểm đang quét.')}>
                  <option value="">— PG tự chọn —</option>
                  {(dev.checkpoints ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}{c.zone_name ? ` · ${c.zone_name}` : ''}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <select className="admin-input" style={{ minWidth: 130 }} disabled={!!d.revoked_at}
                  value={d.device_role ?? 'scan'}
                  onChange={(e) => call('/api/admin/pg-devices', 'PATCH',
                    { id: d.id, device_role: e.target.value },
                    e.target.value === 'hall_ticket'
                      ? 'Máy này giờ mở được quầy vé hội trường.'
                      : 'Máy này chỉ quét badge, không giữ chỗ được.')}>
                  <option value="scan">Quét badge</option>
                  <option value="hall_ticket">Quầy vé hội trường</option>
                </select>
              </td>
              <td>
                {d.revoked_at ? 'đã thu hồi'
                  : d.claimed_at ? `đã nhận · sync ${d.last_sync_at ? t(d.last_sync_at) : '—'}`
                  : 'chưa nhận'}
              </td>
              <td>
                {!d.revoked_at && (
                  <button type="button" className="link-danger" onClick={() => {
                    const reason = prompt(`THU HỒI máy ${d.label}? Token trên máy chết ngay lập tức. Lý do:`);
                    if (reason) call('/api/admin/pg-devices', 'PATCH',
                      { id: d.id, action: 'revoke', reason });
                  }}>thu hồi</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="admin-form-row" style={{ maxWidth: 640 }}>
        <input className="admin-input" id="dv-label" placeholder="Nhãn máy mới (vd: PG-08)" style={{ maxWidth: 150 }} />
        <button type="button" className="admin-btn" onClick={() => {
          const label = document.getElementById('dv-label').value.trim();
          if (label) call('/api/admin/pg-devices', 'POST', { type: 'device', label });
        }}>+ Tạo máy</button>
        <input className="admin-input" id="st-name" placeholder="Tên PG mới" style={{ maxWidth: 170 }} />
        <select className="admin-input" id="st-role" style={{ maxWidth: 130 }}>
          <option value="pg">PG</option>
          <option value="supervisor">Giám sát</option>
        </select>
        <button type="button" className="admin-btn" onClick={() => {
          const nm = document.getElementById('st-name').value.trim();
          if (nm) call('/api/admin/pg-devices', 'POST',
            { type: 'staff', full_name: nm, role: document.getElementById('st-role').value });
        }}>+ Thêm PG</button>
      </div>
      <p className="muted">
        In thẻ nhận máy: mỗi PG một thẻ ghi <b>mã nhận máy</b> + hướng dẫn 3 bước
        (cài màn hình chính TRƯỚC → mở app → nhập mã + PIN tự chọn). Thu hồi dùng khi
        mất máy — token chết ngay ở request kế tiếp.
      </p>
    </div>
  );
}

/* ---------------- Đối soát (AC26) ---------------- */

function Reconcile({ api, actor, eventId }) {
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);
  const [sv, setSv] = useState(null);
  const [msg, setMsg] = useState(null);
  const debounce = useRef(null);

  const load = useCallback(async () => {
    setData(await api(`/api/admin/reconcile?event=${eventId}`));
  }, [api, eventId]);
  useEffect(() => { load().catch((e) => setMsg({ bad: true, text: e.message })); }, [load]);

  const search = (text) => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      if (!text.trim()) { setHits([]); return; }
      const d = await api(`/api/admin/students?event=${eventId}&q=${encodeURIComponent(text)}`);
      setHits(d.students);
    }, 250);
  };

  const enter = async (body) => {
    setMsg(null);
    try {
      const r = await api('/api/admin/reconcile', {
        method: 'POST',
        body: JSON.stringify({ event: eventId, actor, student_id: sv.id, ...body }),
      });
      setMsg({ bad: false, text: r.gift ? `Đã ghi: ${r.gift} (kho còn ${r.remaining})`
                                        : `Đã ghi: suất số ${r.slot_no}` });
      load();
    } catch (e) {
      // 409s here are the FEATURE: a refused paper entry is a caught
      // double-entry, not a failure.
      setMsg({ bad: true, text: e.message });
    }
  };

  if (!data) return <p className="muted">Đang tải…</p>;

  return (
    <div>
      <p className="muted">
        Nhập vé giấy sau sự kiện. Mọi bản ghi đi qua đúng hàm của quầy thật —
        vé trùng hoặc vượt kho sẽ bị <b>từ chối và báo rõ</b>, đó là cách bắt lỗi sổ giấy.
      </p>

      {data.pending_queues.length > 0 && (
        <p className="admin-alert">
          ⚠️ {data.pending_queues.length} máy PG còn hàng đợi chưa xả:
          {' '}{data.pending_queues.map((d) => `${d.label} (${d.queue_depth})`).join(', ')}.
          Xả hết queue trước khi chốt sổ.
        </p>
      )}

      <div className="admin-two-col">
        <div>
          <input className="admin-input" placeholder="Tìm SV: tên · SĐT · MSSV · mã"
            value={q} onChange={(e) => { setQ(e.target.value); search(e.target.value); }} />
          <ul className="admin-hits">
            {hits.map((h) => (
              <li key={h.id}>
                <button type="button" onClick={() => { setSv(h); setMsg(null); }}>
                  <b>{h.full_name}</b>
                  <span>{h.lookup_code} · {h.badge_count} badge</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {sv && (
          <div className="admin-detail">
            <h4>{sv.full_name} <span className="muted">· {sv.lookup_code}</span></h4>
            <div className="admin-form-row">
              <select className="admin-input" id="rec-tier" defaultValue={data.tiers[0]?.id}>
                {data.tiers.map((t2) => (
                  <option key={t2.id} value={t2.id}>Bậc {t2.tier} — {t2.gift_name}</option>
                ))}
              </select>
              <button type="button" className="admin-btn admin-btn-primary" onClick={() =>
                enter({ type: 'gift', tier_id: Number(document.getElementById('rec-tier').value) })
              }>Nhập vé quà</button>
            </div>
            <div className="admin-form-row">
              <select className="admin-input" id="rec-act" defaultValue={data.activities[0]?.id}>
                {data.activities.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <button type="button" className="admin-btn admin-btn-primary" onClick={() =>
                enter({ type: 'special', activity_id: Number(document.getElementById('rec-act').value) })
              }>Nhập vé suất</button>
            </div>
            {msg && <p className={msg.bad ? 'admin-err' : 'admin-ok'}>{msg.text}</p>}
          </div>
        )}
      </div>

      <h3>Đã nhập từ giấy ({data.paper.length})</h3>
      <table className="admin-table">
        <thead><tr><th>Lúc</th><th>SV</th><th>Quà</th><th>Người nhập</th></tr></thead>
        <tbody>
          {data.paper.map((r, i) => (
            <tr key={i}>
              <td>{t(r.redeemed_at)}</td>
              <td>{r.full_name} <span className="muted">({r.lookup_code})</span></td>
              <td>Bậc {r.tier} — {r.gift_name}</td>
              <td>{r.staff_id}</td>
            </tr>
          ))}
          {data.paper.length === 0 && (
            <tr><td colSpan={4} className="muted">Chưa có bản ghi giấy nào.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- Shell ---------------- */

export default function AdminPage() {
  const [key, setKey] = useState(undefined);
  const [actor, setActor] = useState('');
  const [tab, setTab] = useState('overview');
  // Điểm đang xem. Trước đây là hằng số 1 dùng 27 chỗ, nên bảng điều khiển
  // chỉ chạm tới Hà Nội — và không hề nói ra điều đó. Ngày 12/09 hai điểm
  // chạy song song; người trực TP.HCM mở lên sẽ thấy số của Hà Nội và tưởng
  // là của mình. Mọi API phía sau vốn đã nhận tham số `event`, nên chỗ thiếu
  // duy nhất là ô chọn này.
  const [eventId, setEventId] = useState(1);
  const [events, setEvents] = useState([]);

  useEffect(() => {
    setKey(localStorage.getItem(KEY_STORE) ?? '');
    setActor(localStorage.getItem(ACTOR_STORE) ?? '');
    const saved = Number(localStorage.getItem(EVENT_STORE));
    if (saved) setEventId(saved);
  }, []);

  // refdata trả MỌI sự kiện kèm cờ mở/đóng (xem api/refdata/route.js), kể cả
  // khi đăng ký đang đóng — nên danh sách này không rỗng vào ngày sự kiện.
  useEffect(() => {
    fetch('/api/refdata')
      .then((r) => r.json())
      .then((d) => setEvents(d.events ?? []))
      .catch(() => setEvents([]));
  }, []);

  const api = useAdminFetch(key || '');

  if (key === undefined) return null;

  if (!key || !actor) {
    return (
      <main className="wrap admin">
        <h1>Bảng điều khiển ATL2026</h1>
        <p className="sub">Nhập mã truy cập AIM cấp và tên của bạn (dùng cho nhật ký thao tác).</p>
        <form
          className="admin-form-col"
          onSubmit={(e) => {
            e.preventDefault();
            const k = e.target.key.value.trim();
            const a = e.target.actor.value.trim();
            if (!k || !a) return;
            localStorage.setItem(KEY_STORE, k);
            localStorage.setItem(ACTOR_STORE, a);
            setKey(k); setActor(a);
          }}
        >
          <input className="admin-input" name="key" type="password" placeholder="Mã truy cập" />
          <input className="admin-input" name="actor" placeholder="Tên bạn (vd: Phong)" />
          <button className="admin-btn admin-btn-primary" type="submit">Vào</button>
        </form>
      </main>
    );
  }

  return (
    <main className="wrap admin admin-wide">
      <header className="admin-head">
        <h1>ATL2026 — Điều khiển</h1>
        {/* Tên điểm đứng ngay cạnh tiêu đề, không giấu trong menu: nhìn nhầm
            điểm là sai mọi con số bên dưới. */}
        <select
          className="admin-input" style={{ maxWidth: 260 }}
          value={eventId}
          onChange={(e) => {
            const v = Number(e.target.value);
            setEventId(v);
            localStorage.setItem(EVENT_STORE, String(v));
          }}
        >
          {events.length === 0 && <option value={eventId}>Đang tải điểm…</option>}
          {events.map((ev) => (
            <option key={ev.id} value={ev.id}>{ev.city} — {ev.name}</option>
          ))}
        </select>
        <span className="muted">{actor}</span>
        <button type="button" className="admin-btn" onClick={async () => {
          // fetch + blob so the Authorization header rides along — a plain
          // <a href> cannot carry it.
          const res = await fetch(`/api/admin/export?event=${eventId}`, {
            headers: { Authorization: `Bearer ${key}` },
          });
          if (!res.ok) return;
          const blob = await res.blob();
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = (res.headers.get('content-disposition') ?? '')
            .match(/filename="([^"]+)"/)?.[1] ?? 'ATL2026.xlsx';
          a.click();
          URL.revokeObjectURL(a.href);
        }}>⬇ Excel</button>
        <button type="button" className="admin-btn" onClick={() => {
          localStorage.removeItem(KEY_STORE);
          setKey('');
        }}>Thoát</button>
      </header>
      <nav className="admin-tabs">
        {[['overview', 'Tổng quan'], ['students', 'Sinh viên'],
          ['config', 'Cấu hình'], ['checkpoints', 'Hoạt động'],
          ['surveys', 'Khảo sát'], ['ops', 'Vận hành'],
          ['reconcile', 'Đối soát']].map(([id, label]) => (
          <button
            key={id} type="button"
            className={tab === id ? 'tab on' : 'tab'}
            onClick={() => setTab(id)}
          >{label}</button>
        ))}
      </nav>
      {tab === 'overview' && <Overview key={eventId} api={api} actor={actor} eventId={eventId} />}
      {tab === 'students' && <Students key={eventId} api={api} actor={actor} eventId={eventId} />}
      {tab === 'config' && <Config key={eventId} api={api} actor={actor} eventId={eventId} />}
      {tab === 'checkpoints' && <Checkpoints key={eventId} api={api} actor={actor} eventId={eventId} />}
      {tab === 'surveys' && <Surveys key={eventId} api={api} actor={actor} eventId={eventId} />}
      {tab === 'ops' && <Ops key={eventId} api={api} actor={actor} eventId={eventId} />}
      {tab === 'reconcile' && <Reconcile key={eventId} api={api} actor={actor} eventId={eventId} />}
    </main>
  );
}
