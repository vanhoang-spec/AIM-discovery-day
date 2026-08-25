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
const EVENT_ID = 1;

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

function Overview({ api, actor }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [gMsg, setGMsg] = useState(null);

  const goldenAct = async (body) => {
    setGMsg(null);
    try {
      await api('/api/admin/golden', {
        method: 'POST',
        body: JSON.stringify({ event: EVENT_ID, actor, ...body }),
      });
      setGMsg(null);
    } catch (e) { setGMsg(e.message); }
  };

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const d = await api(`/api/admin/overview?event=${EVENT_ID}`);
        if (alive) { setData(d); setErr(null); }
      } catch (e) { if (alive) setErr(e.message); }
    };
    tick();
    const iv = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(iv); };
  }, [api]);

  if (err) return <p className="admin-err">Lỗi tải dashboard: {err}</p>;
  if (!data) return <p className="muted">Đang tải…</p>;

  const { totals, zones, tiers, special, devices, drift, threshold_check: tc, golden } = data;
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
          ⚠️ Ngưỡng y = {tc.configured_threshold} lệch khỏi luật &gt;70%:
          {' '}{tc.core_checkpoints} hoạt động → y nên là {tc.implied_threshold}.
          Sửa ở tab Cấu hình nếu đây không phải chủ đích.
        </p>
      )}

      {goldenActive && (
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

      <h3>Khu vực — 15 phút gần nhất</h3>
      <table className="admin-table">
        <thead><tr><th>Zone</th><th>Lượt quét</th><th>Badge</th><th></th><th></th></tr></thead>
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

      <h3>Phễu quà</h3>
      <table className="admin-table">
        <thead><tr><th>Bậc</th><th>Ngưỡng</th><th>Đủ điều kiện</th><th>Đã đổi</th><th>Kho</th></tr></thead>
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
        <thead><tr><th>Tên</th><th>Đã cấp</th><th>Đang giữ</th><th>Còn</th><th>SV đủ điều kiện (thang core)</th></tr></thead>
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
          <thead><tr><th>Máy</th><th>PG</th><th>Zone</th><th>Hàng đợi</th><th>Pin</th><th>Sync</th></tr></thead>
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

function Students({ api, actor }) {
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
        const d = await api(`/api/admin/students?event=${EVENT_ID}&q=${encodeURIComponent(text)}`);
        setResults(d.students);
      } catch (e) { setMsg({ bad: true, text: e.message }); }
    }, 250);
  }, [api]);

  const open = useCallback(async (id) => {
    setMsg(null);
    const d = await api(`/api/admin/students/${id}?event=${EVENT_ID}`);
    setDetail(d);
    setForm({ action: 'award', checkpoint_id: d.awardable[0]?.id ?? '', reason: '' });
  }, [api]);

  const act = async (action, checkpointId, reason) => {
    try {
      const r = await api(`/api/admin/students/${detail.student.id}`, {
        method: 'POST',
        body: JSON.stringify({ event: EVENT_ID, action, checkpoint_id: checkpointId, reason, actor }),
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
                <span>{s.lookup_code} · {s.student_code ?? '—'} · {s.badge_count} badge
                  ({s.core_badge_count} hoạt động)</span>
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
            <b>{detail.student.badge_count} badge</b> · {detail.student.core_badge_count} hoạt động (thang đặc biệt)
          </p>

          <h4>Badge</h4>
          <table className="admin-table">
            <thead><tr><th>Hoạt động</th><th>Lúc</th><th>Nguồn</th><th>Thang core</th><th></th></tr></thead>
            <tbody>
              {detail.badges.map((b) => (
                <tr key={b.checkpoint_id + (b.voided_at ?? '')} className={b.voided_at ? 'row-void' : ''}>
                  <td>{b.name}</td>
                  <td>{t(b.awarded_at)}</td>
                  <td>{b.source}</td>
                  <td>{b.is_core ? '✓' : '—'}</td>
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

function Config({ api, actor }) {
  const [cfg, setCfg] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    setCfg(await api(`/api/admin/config?event=${EVENT_ID}`));
  }, [api]);
  useEffect(() => { load().catch((e) => setMsg({ bad: true, text: e.message })); }, [load]);

  const patch = async (body) => {
    setMsg(null);
    try {
      const r = await api('/api/admin/config', {
        method: 'PATCH',
        body: JSON.stringify({ event: EVENT_ID, actor, ...body }),
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
            <td>y — số <b>hoạt động</b> (cổng + booth) để mở hoạt động đặc biệt</td>
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
        <thead><tr><th>Bậc</th><th>Ngưỡng badge</th><th>Kho</th><th>Đã phát</th><th></th></tr></thead>
        <tbody>
          {cfg.tiers.map((g) => (
            <tr key={g.id}>
              <td>{g.tier} — {g.gift_name}</td>
              <td className="num">{g.required_badges}</td>
              <td className="num">{g.stock_total}</td>
              <td className="num">{g.stock_issued}</td>
              <td>
                <button type="button" className="admin-btn" onClick={() => {
                  const req = prompt(`Ngưỡng bậc ${g.tier}?`, g.required_badges);
                  if (req == null) return;
                  const stock = prompt('Kho?', g.stock_total);
                  if (stock == null) return;
                  patch({ type: 'tier', tier_id: g.id,
                          required_badges: Number(req), stock_total: Number(stock) });
                }}>Sửa</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">
        Tăng ngưỡng sẽ hiện trước số SV bị ảnh hưởng để xác nhận. Quyền lợi đã cấp không bao giờ bị thu hồi.
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
              source_event: EVENT_ID, actor,
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

function Checkpoints({ api, actor }) {
  const [cfg, setCfg] = useState(null);
  const [msg, setMsg] = useState(null);
  const [draft, setDraft] = useState(null); // {id?} being edited, or {new:true}

  const load = useCallback(async () => {
    setCfg(await api(`/api/admin/config?event=${EVENT_ID}`));
  }, [api]);
  useEffect(() => { load().catch((e) => setMsg({ bad: true, text: e.message })); }, [load]);

  const save = async () => {
    setMsg(null);
    try {
      const body = { event: EVENT_ID, actor, ...draft };
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
          <th>Tính badge</th><th>Đang mở</th><th></th>
        </tr></thead>
        <tbody>
          {cfg.checkpoints.map((c) => (
            <tr key={c.id} className={c.is_active ? '' : 'row-void'}>
              <td>{c.name}</td>
              <td>{c.kind}</td>
              <td>{cfg.zones.find((z) => z.id === c.zone_id)?.name ?? '—'}</td>
              <td>{c.starts_at ? `${t(c.starts_at)}–${t(c.ends_at)}` : 'cả ngày'}</td>
              <td>{c.counts_toward_badges ? '✓' : '—'}</td>
              <td>{c.is_active ? '✓' : 'tắt'}</td>
              <td className="admin-row-actions">
                {(c.kind === 'sponsor_booth' || c.kind === 'diamond_booth') && (
                  <button type="button" className="admin-btn" title="Excel cho nhà tài trợ này"
                    onClick={async () => {
                      const res = await fetch(
                        `/api/admin/export-ntt?event=${EVENT_ID}&checkpoint=${c.id}`,
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
                             starts_at: c.starts_at ?? '', ends_at: c.ends_at ?? '' })
                }>Sửa</button>
                <button type="button" className="admin-btn" onClick={() => {
                  const reason = `Đổi counts_toward_badges cho "${c.name}"`;
                  void reason;
                  api('/api/admin/checkpoints', {
                    method: 'PATCH',
                    body: JSON.stringify({ event: EVENT_ID, actor, id: c.id,
                                           counts_toward_badges: !c.counts_toward_badges }),
                  }).then((r) => {
                    setMsg({ bad: false, text: r.rebuilt ? `Đã đổi — tính lại ${r.rebuilt} SV.` : 'Đã đổi.' });
                    load();
                  }).catch((e) => setMsg({ bad: true, text: e.message }));
                }}>{c.counts_toward_badges ? 'Ngừng tính badge' : 'Tính badge'}</button>
                <button type="button" className="admin-btn" onClick={() => {
                  api('/api/admin/checkpoints', {
                    method: 'PATCH',
                    body: JSON.stringify({ event: EVENT_ID, actor, id: c.id, is_active: !c.is_active }),
                  }).then(() => load()).catch((e) => setMsg({ bad: true, text: e.message }));
                }}>{c.is_active ? 'Tắt' : 'Mở'}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {!draft && (
        <button type="button" className="admin-btn" onClick={() =>
          setDraft({ new: true, kind: 'sponsor_booth', name: '' })
        }>+ Thêm hoạt động</button>
      )}

      {draft && (
        <div className="admin-detail">
          <h4>{draft.new ? 'Hoạt động mới' : 'Sửa hoạt động'}</h4>
          <div className="admin-form-col">
            {field('name', 'Tên hoạt động *')}
            {draft.new && (
              <select className="admin-input" value={draft.kind}
                onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value }))}>
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
              <button type="button" className="admin-btn admin-btn-primary" onClick={save}>Lưu</button>
              <button type="button" className="admin-btn" onClick={() => setDraft(null)}>Huỷ</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Đối soát (AC26) ---------------- */

function Reconcile({ api, actor }) {
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);
  const [sv, setSv] = useState(null);
  const [msg, setMsg] = useState(null);
  const debounce = useRef(null);

  const load = useCallback(async () => {
    setData(await api(`/api/admin/reconcile?event=${EVENT_ID}`));
  }, [api]);
  useEffect(() => { load().catch((e) => setMsg({ bad: true, text: e.message })); }, [load]);

  const search = (text) => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      if (!text.trim()) { setHits([]); return; }
      const d = await api(`/api/admin/students?event=${EVENT_ID}&q=${encodeURIComponent(text)}`);
      setHits(d.students);
    }, 250);
  };

  const enter = async (body) => {
    setMsg(null);
    try {
      const r = await api('/api/admin/reconcile', {
        method: 'POST',
        body: JSON.stringify({ event: EVENT_ID, actor, student_id: sv.id, ...body }),
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
                  <span>{h.lookup_code} · {h.badge_count} badge ({h.core_badge_count} hoạt động)</span>
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

  useEffect(() => {
    setKey(localStorage.getItem(KEY_STORE) ?? '');
    setActor(localStorage.getItem(ACTOR_STORE) ?? '');
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
        <span className="muted">{actor}</span>
        <button type="button" className="admin-btn" onClick={async () => {
          // fetch + blob so the Authorization header rides along — a plain
          // <a href> cannot carry it.
          const res = await fetch(`/api/admin/export?event=${EVENT_ID}`, {
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
          ['reconcile', 'Đối soát']].map(([id, label]) => (
          <button
            key={id} type="button"
            className={tab === id ? 'tab on' : 'tab'}
            onClick={() => setTab(id)}
          >{label}</button>
        ))}
      </nav>
      {tab === 'overview' && <Overview api={api} actor={actor} />}
      {tab === 'students' && <Students api={api} actor={actor} />}
      {tab === 'config' && <Config api={api} actor={actor} />}
      {tab === 'checkpoints' && <Checkpoints api={api} actor={actor} />}
      {tab === 'reconcile' && <Reconcile api={api} actor={actor} />}
    </main>
  );
}
