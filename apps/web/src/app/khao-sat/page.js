'use client';

/**
 * Khảo sát nhà tài trợ — filled IN THE QUEUE (lever #2 of the badge economy:
 * the only badge source that adds supply without adding station load).
 *
 * Written for a phone on congested venue 4G:
 *   * the list and each form render from one fetch; answers live in state;
 *   * response_uid is generated ONCE per attempt and reused across retries,
 *     so a flaky submit can be hammered safely — the server absorbs replays;
 *   * the COMPLETE screen shows name + code + a live pulse ring: a cheap
 *     liveness cue so booth staff can tell a live screen from a screenshot
 *     when the award mode requires showing it at the counter.
 *
 * The sponsor's brand shows as ONE accent colour on our layout. Their hex is
 * used only where accents go; text and grounds stay ours — a sponsor colour
 * must never make the form unreadable.
 */

import { useCallback, useEffect, useState } from 'react';

const PASS_KEY = 'atl_pass_v1';

const newUid = () =>
  crypto.randomUUID ? crypto.randomUUID()
    : `${Date.now().toString(16)}-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });

function Question({ q, value, onChange, accent }) {
  if (q.type === 'choice' || q.type === 'multi') {
    const multi = q.type === 'multi';
    const selected = multi ? (value ?? []) : value;
    return (
      <div className="sv-q">
        <p className="sv-label">{q.label}{q.required && <span className="req"> *</span>}</p>
        <div className="sv-opts">
          {q.options?.map((o) => {
            const on = multi ? selected.includes(o) : selected === o;
            return (
              <button key={o} type="button"
                className={`sv-opt ${on ? 'on' : ''}`}
                style={on && accent ? { background: accent, borderColor: accent, color: '#fff' } : undefined}
                onClick={() => {
                  if (multi) {
                    onChange(on ? selected.filter((x) => x !== o) : [...selected, o]);
                  } else onChange(on ? undefined : o);
                }}>
                {o}
              </button>
            );
          })}
        </div>
      </div>
    );
  }
  if (q.type === 'scale') {
    return (
      <div className="sv-q">
        <p className="sv-label">{q.label}{q.required && <span className="req"> *</span>}</p>
        <div className="sv-opts">
          {[1, 2, 3, 4, 5].map((v) => (
            <button key={v} type="button"
              className={`sv-opt sv-scale ${value === v ? 'on' : ''}`}
              style={value === v && accent ? { background: accent, borderColor: accent, color: '#fff' } : undefined}
              onClick={() => onChange(value === v ? undefined : v)}>
              {v}
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="sv-q">
      <p className="sv-label">{q.label}{q.required && <span className="req"> *</span>}</p>
      <textarea rows={3} maxLength={500} value={value ?? ''}
        onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export default function SurveyPage() {
  const [pass, setPass] = useState(undefined);
  const [surveys, setSurveys] = useState(null);
  const [open, setOpen] = useState(null);      // survey being answered
  const [answers, setAnswers] = useState({});
  const [attemptUid, setAttemptUid] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [complete, setComplete] = useState(null); // {survey, badge_status}

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PASS_KEY);
      setPass(raw ? JSON.parse(raw) : null);
    } catch { setPass(null); }
  }, []);

  const load = useCallback(async (token) => {
    try {
      const res = await fetch(`/api/khao-sat?t=${encodeURIComponent(token)}`);
      if (res.ok) setSurveys((await res.json()).surveys);
      else setSurveys([]);
    } catch { setSurveys([]); }
  }, []);

  useEffect(() => { if (pass?.token) load(pass.token); }, [pass, load]);

  const begin = (sv) => {
    setOpen(sv);
    setAnswers({});
    setAttemptUid(newUid());   // one uid per attempt — retries reuse it
    setErr(null);
  };

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const res = await fetch('/api/khao-sat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          t: pass.token, survey_id: open.id,
          response_uid: attemptUid, answers,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error); return; }
      setComplete({ survey: open, badge_status: data.badge_status, status: data.status });
      setOpen(null);
      load(pass.token);
    } catch {
      setErr('Mạng đang yếu — bấm gửi lại, câu trả lời không bị nhân đôi.');
    } finally {
      setBusy(false);
    }
  };

  if (pass === undefined) return null;
  if (pass === null) {
    return (
      <main className="wrap">
        <h1>Cần mã tham dự</h1>
        <p className="sub">Mở trang này trên đúng điện thoại đã đăng ký, hoặc lấy lại mã trước.</p>
        <a href="/dang-ky"><button className="primary" type="button">Lấy mã QR của mình</button></a>
      </main>
    );
  }

  // ---- COMPLETE — the screen shown at the booth ----
  if (complete) {
    return (
      <main className="wrap">
        <div className="sv-complete">
          <div className="sv-pulse" aria-hidden />
          <p className="sv-done-title">HOÀN THÀNH</p>
          <p className="sv-done-survey">{complete.survey.title}</p>
          <p className="sv-done-name">{pass.full_name}</p>
          <p className="sv-done-code">
            {pass.lookup_code.slice(0, 3)}-{pass.lookup_code.slice(3)}
          </p>
          {complete.badge_status === 'counted' && (
            <p className="sv-done-badge">+1 badge đã cộng vào tài khoản của bạn</p>
          )}
          {complete.badge_status === 'pending_other_condition' && (
            <p className="sv-done-badge">Đưa màn hình này cho nhân viên tại {complete.survey.booth_name} để nhận badge</p>
          )}
        </div>
        <button className="primary" type="button" onClick={() => setComplete(null)}>
          XONG
        </button>
      </main>
    );
  }

  // ---- answering ----
  if (open) {
    const accent = open.accent_hex ?? null;
    return (
      <main className="wrap">
        <p className="eyebrow" style={accent ? { color: accent } : undefined}>
          {open.booth_name}
        </p>
        <h1>{open.title}</h1>
        {open.intro && <p className="sub">{open.intro}</p>}
        {open.questions.map((q) => (
          <Question key={q.id} q={q} accent={accent}
            value={answers[q.id]}
            onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))} />
        ))}
        {err && <div className="banner-err" role="alert">{err}</div>}
        <button className="primary" type="button" disabled={busy}
          style={accent ? { background: accent } : undefined}
          onClick={submit}>
          {busy ? 'Đang gửi…' : 'GỬI KHẢO SÁT'}
        </button>
        <button className="ghost-btn" type="button" onClick={() => setOpen(null)}>Để sau</button>
      </main>
    );
  }

  // ---- list ----
  return (
    <main className="wrap">
      <h1>Khảo sát nhà tài trợ</h1>
      <p className="sub">
        Làm ngay trong lúc xếp hàng — mỗi khảo sát dưới 2 phút, nhiều khảo sát tặng badge.
      </p>
      {surveys === null && <p className="muted">Đang tải…</p>}
      {surveys?.length === 0 && (
        <p className="muted">Chưa có khảo sát nào đang mở. Quay lại sau bạn nhé.</p>
      )}
      <div className="sv-list">
        {surveys?.map((sv) => (
          <button key={sv.id} type="button" className="sv-card" disabled={sv.done}
            onClick={() => begin(sv)}>
            <span>
              <b>{sv.title}</b>
              <small>{sv.booth_name} · {sv.questions.length} câu</small>
            </span>
            <span className={sv.done ? 'sv-tag done' : 'sv-tag'}>
              {sv.done ? '✓ Đã làm' : 'Làm ngay'}
            </span>
          </button>
        ))}
      </div>
      <p className="muted" style={{ marginTop: 16 }}>
        <a href="/toi" style={{ color: 'var(--accent)' }}>← Mã QR của tôi</a>
      </p>
    </main>
  );
}
