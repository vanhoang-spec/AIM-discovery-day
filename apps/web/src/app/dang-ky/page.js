'use client';

/**
 * Registration — one scrolling page, no wizard.
 *
 * The three decisions that shape this file:
 *   * Draft persists to localStorage on every change. A dropped connection or
 *     an accidental back-swipe must never lose typing.
 *   * The school picker is a diacritic-insensitive combobox over a served
 *     list — free text produces forty spellings of one university and ruins
 *     the report. "Trường khác" degrades to free text.
 *   * On success the QR appears IMMEDIATELY and is cached to localStorage
 *     before anything else — email and SMS are conveniences, the cached SVG is
 *     the artifact the event runs on.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { matchesQuery, scoreMatch } from '@atl/vn-text';

const DRAFT_KEY = 'atl_reg_draft_v1';
const PASS_KEY = 'atl_pass_v1';

const EMPTY = {
  event_id: '',
  full_name: '',
  email: '',
  phone: '',
  school_id: null,
  school_label: '',
  school_other: '',
  student_code: '',
  major: '',
  birth_year: '',
  province_code: '',
  gender: '',
  is_working: false,
  employer: '',
  consent_event: false,
  consent_sponsors: false,
};

export default function RegisterPage() {
  const [ref, setRef] = useState(null); // {events, schools, provinces}
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [topError, setTopError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // API response on success

  // ---- reference data (edge-cached, one shared payload) ----
  useEffect(() => {
    fetch('/api/refdata')
      .then((r) => r.json())
      .then(setRef)
      .catch(() => setTopError('Không tải được danh sách trường. Bạn tải lại trang giúp mình nhé.'));
  }, []);

  // ---- draft restore / persist ----
  useEffect(() => {
    try {
      const saved = localStorage.getItem(DRAFT_KEY);
      if (saved) setForm({ ...EMPTY, ...JSON.parse(saved) });
    } catch { /* a broken draft is not worth an error */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(form)); } catch {}
  }, [form]);

  const set = (k) => (v) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };

  function validate() {
    const e = {};
    if (!form.event_id) e.event_id = 'Chọn điểm bạn sẽ tham dự';
    if (form.full_name.trim().length < 2) e.full_name = 'Nhập họ và tên của bạn';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(form.email.trim()))
      e.email = 'Email chưa đúng định dạng';
    if (!/^(\+?84|0)\d{8,10}$/.test(form.phone.replace(/[\s.-]/g, '')))
      e.phone = 'Số điện thoại chưa đúng';
    if (!form.school_id && !form.school_other.trim())
      e.school_id = 'Chọn trường, hoặc chọn "Trường khác" và gõ tên';
    if (!form.student_code.trim()) e.student_code = 'Nhập mã số sinh viên';
    if (!form.birth_year) e.birth_year = 'Chọn năm sinh';
    if (!form.province_code) e.province_code = 'Chọn nơi bạn đang sống';
    if (!form.gender) e.gender = 'Chọn một mục';
    if (!form.consent_event) e.consent_event = 'Cần đồng ý để đăng ký';
    return e;
  }

  async function submit(ev) {
    ev.preventDefault();
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length > 0) {
      setTopError('Còn vài ô chưa xong — mình đã đánh dấu bên dưới.');
      document.querySelector('.has-err')?.scrollIntoView({ block: 'center' });
      return;
    }
    setTopError('');
    setBusy(true);
    try {
      // Retried on failure: the server treats a resubmit as the resend flow,
      // so retrying is always safe.
      let res, data;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          res = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event_id: Number(form.event_id),
              full_name: form.full_name,
              email: form.email,
              phone: form.phone,
              school_id: form.school_id,
              school_other: form.school_id ? null : form.school_other,
              student_code: form.student_code,
              major: form.major,
              birth_year: form.birth_year ? Number(form.birth_year) : null,
              province_code: form.province_code,
              employer: form.is_working ? form.employer : null,
              gender: form.gender,
              consent_event: form.consent_event,
              consent_sponsors: form.consent_sponsors,
            }),
          });
          data = await res.json();
          break;
        } catch (err) {
          if (attempt === 2) throw err;
          await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
        }
      }
      if (!res.ok) {
        setTopError(data.error || 'Không đăng ký được lúc này.');
        if (data.field) setErrors((prev) => ({ ...prev, [data.field]: data.error }));
        return;
      }
      // Cache the pass FIRST — this is what /toi renders offline for the rest
      // of the event.
      try {
        localStorage.setItem(PASS_KEY, JSON.stringify({
          token: data.token,
          qr_svg: data.qr_svg,
          lookup_code: data.lookup_code,
          full_name: data.full_name,
          event_id: data.event_id,
          saved_at: Date.now(),
        }));
        localStorage.removeItem(DRAFT_KEY);
      } catch {}
      setDone(data);
      window.scrollTo({ top: 0 });
    } catch {
      setTopError('Mạng đang chập chờn. Bạn bấm Đăng ký lại giúp mình — đăng ký lại không tạo bản trùng đâu.');
    } finally {
      setBusy(false);
    }
  }

  if (done) return <Success data={done} />;

  const years = [];
  for (let y = 2010; y >= 1998; y--) years.push(y);

  return (
    <main className="wrap">
      <h1>Đăng ký Discovery Day</h1>
      <p className="sub">Awaken The Lions 2026 · Thứ Bảy 12/09 · 8h–17h · miễn phí</p>

      {topError && <div className="banner-err" role="alert">{topError}</div>}

      <form onSubmit={submit} noValidate>
        <Field label="Bạn tham dự tại" error={errors.event_id} required>
          <div className="radio-row">
            {(ref?.events ?? [
              { id: 1, city: 'Hà Nội' }, { id: 2, city: 'TP.HCM' },
            ]).map((e) => (
              <label key={e.id}>
                <input
                  type="radio" name="event" value={e.id}
                  checked={String(form.event_id) === String(e.id)}
                  onChange={() => set('event_id')(e.id)}
                />
                {e.city}
              </label>
            ))}
          </div>
        </Field>

        <Field label="Họ và tên" error={errors.full_name} required>
          <input type="text" autoComplete="name" value={form.full_name}
                 onChange={(e) => set('full_name')(e.target.value)} />
        </Field>

        <Field label="Email" why="— mã QR gửi về đây" error={errors.email} required>
          <input type="email" autoComplete="email" inputMode="email" value={form.email}
                 onChange={(e) => set('email')(e.target.value)} />
        </Field>

        {/* Phone is the discriminator the PG uses to find someone whose phone
            is dead or whose name collides with a dozen others — that is what
            it is collected for, not SMS. */}
        <Field label="Số điện thoại" why="— để tra cứu tại quầy nếu cần" error={errors.phone} required>
          <input type="tel" autoComplete="tel" inputMode="tel" value={form.phone}
                 onChange={(e) => set('phone')(e.target.value)} />
        </Field>

        <SchoolCombo
          schools={ref?.schools ?? []}
          value={form}
          error={errors.school_id}
          onPick={(s) => setForm((f) => ({
            ...f, school_id: s?.id ?? null, school_label: s?.name ?? '', school_other: '',
          }))}
          onOther={(text) => setForm((f) => ({
            ...f, school_id: null, school_label: '', school_other: text,
          }))}
        />

        <Field label="Mã số sinh viên" error={errors.student_code} required>
          {/* text, not number: plenty of MSSV contain letters */}
          <input type="text" inputMode="text" autoComplete="off" value={form.student_code}
                 onChange={(e) => set('student_code')(e.target.value)} />
        </Field>

        <Field label="Ngành / Chương trình học">
          <input type="text" value={form.major}
                 onChange={(e) => set('major')(e.target.value)} />
        </Field>

        <Field label="Năm sinh" error={errors.birth_year} required>
          <select value={form.birth_year} onChange={(e) => set('birth_year')(e.target.value)}>
            <option value="">Chọn năm…</option>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </Field>

        <Field label="Nơi đang sống" error={errors.province_code} required>
          <select value={form.province_code} onChange={(e) => set('province_code')(e.target.value)}>
            <option value="">Chọn tỉnh / thành…</option>
            {(ref?.provinces ?? []).map((p) => (
              <option key={p.code} value={p.code}>{p.name}</option>
            ))}
          </select>
        </Field>

        <Field label="Giới tính" error={errors.gender} required>
          <div className="radio-row">
            {[['nam', 'Nam'], ['nu', 'Nữ'], ['khac', 'Khác']].map(([v, t]) => (
              <label key={v}>
                <input type="radio" name="gender" value={v}
                       checked={form.gender === v}
                       onChange={() => set('gender')(v)} />
                {t}
              </label>
            ))}
          </div>
        </Field>

        <label className="consent">
          <input type="checkbox" checked={form.is_working}
                 onChange={(e) => set('is_working')(e.target.checked)} />
          <span>Mình đang đi làm</span>
        </label>
        {form.is_working && (
          <Field label="Công ty đang làm việc">
            <input type="text" value={form.employer}
                   onChange={(e) => set('employer')(e.target.value)} />
          </Field>
        )}

        {/* Two consents, separate, never pre-ticked — a legal requirement,
            not a style choice. */}
        <label className={`consent ${errors.consent_event ? 'has-err' : ''}`}>
          <input type="checkbox" checked={form.consent_event}
                 onChange={(e) => set('consent_event')(e.target.checked)} />
          <span>
            Mình đồng ý để AIM Academy xử lý thông tin trên nhằm tổ chức sự kiện
            (gửi mã QR, nhắc lịch, vận hành ngày sự kiện). <span className="req">*</span>
          </span>
        </label>
        {errors.consent_event && <p className="err-text">{errors.consent_event}</p>}

        <label className="consent">
          <input type="checkbox" checked={form.consent_sponsors}
                 onChange={(e) => set('consent_sponsors')(e.target.checked)} />
          <span>
            Mình đồng ý nhận thông tin từ các nhà tài trợ của sự kiện
            (không bắt buộc).
          </span>
        </label>

        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Đang đăng ký…' : 'ĐĂNG KÝ NGAY'}
        </button>
        <p className="muted" style={{ textAlign: 'center', marginTop: 10 }}>
          Đã đăng ký rồi? Điền lại đúng email hoặc SĐT cũ — mình gửi lại mã QR, không tạo bản trùng.
        </p>
      </form>
    </main>
  );
}

function Field({ label, why, error, required, children }) {
  return (
    <div className={`field ${error ? 'has-err' : ''}`}>
      <label className="top">
        {label} {required && <span className="req">*</span>}{' '}
        {why && <span className="why">{why}</span>}
      </label>
      {children}
      {error && <p className="err-text">{error}</p>}
    </div>
  );
}

/**
 * School combobox. Typing "ngoai thuong" must find "Đại học Ngoại thương" —
 * matching runs on the folded search_key served with the list, ranked so the
 * closest name is first. "Trường khác" turns the field into free text.
 */
function SchoolCombo({ schools, value, error, onPick, onOther }) {
  const [text, setText] = useState(value.school_label || value.school_other || '');
  const [open, setOpen] = useState(false);
  const [other, setOther] = useState(!!value.school_other);
  const boxRef = useRef(null);

  useEffect(() => {
    const close = (e) => { if (!boxRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);

  const matches = useMemo(() => {
    const q = text.trim();
    if (!q) return schools.slice(0, 8);
    return schools
      .filter((s) => matchesQuery(s.search_key, q))
      .map((s) => ({ s, score: scoreMatch(s.search_key, q) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((x) => x.s);
  }, [schools, text]);

  if (other) {
    return (
      <Field label="Trường đang học" error={error} required>
        <input
          type="text" placeholder="Gõ tên trường của bạn"
          value={value.school_other}
          onChange={(e) => onOther(e.target.value)}
        />
        <p className="muted" style={{ marginTop: 4 }}>
          <a href="#" onClick={(e) => { e.preventDefault(); setOther(false); setText(''); onOther(''); }}>
            ← Quay lại chọn từ danh sách
          </a>
        </p>
      </Field>
    );
  }

  return (
    <Field label="Trường đang học" why="— gõ không dấu cũng tìm được" error={error} required>
      <div className="combo" ref={boxRef}>
        <input
          type="text"
          placeholder="Gõ để tìm, ví dụ: ngoai thuong"
          value={text}
          onFocus={() => setOpen(true)}
          onChange={(e) => { setText(e.target.value); setOpen(true); onPick(null); }}
          role="combobox" aria-expanded={open} aria-controls="school-list"
        />
        {open && (
          <div className="combo-list" id="school-list" role="listbox">
            {matches.map((s) => (
              <button type="button" key={s.id}
                      onClick={() => { onPick(s); setText(s.name); setOpen(false); }}>
                {s.name}
              </button>
            ))}
            <button type="button"
                    onClick={() => { setOther(true); setOpen(false); onOther(text); }}>
              Trường khác — tự gõ tên…
            </button>
          </div>
        )}
      </div>
    </Field>
  );
}

/** The success screen: QR first, save button second, everything else after. */
function Success({ data }) {
  const saveImage = async () => {
    // SVG → canvas → PNG download. Rendered at 800px so the saved photo scans
    // from another phone's screen without pinch-zooming.
    const blob = new Blob([data.qr_svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const canvas = document.createElement('canvas');
    const size = 800;
    canvas.width = size;
    canvas.height = size + 140;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, size, size);
    ctx.fillStyle = '#1a1d23';
    ctx.font = '700 64px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    const code = data.lookup_code.slice(0, 3) + '-' + data.lookup_code.slice(3);
    ctx.fillText(code, size / 2, size + 78);
    ctx.font = '400 34px system-ui, sans-serif';
    ctx.fillStyle = '#4a4e57';
    ctx.fillText(data.full_name, size / 2, size + 122);
    URL.revokeObjectURL(url);
    const a = document.createElement('a');
    a.download = `ATL2026-QR-${data.lookup_code}.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
  };

  const resent = data.status === 'already_registered';
  const code = data.lookup_code.slice(0, 3) + '-' + data.lookup_code.slice(3);

  return (
    <main className="wrap">
      <div className="ok-banner">
        {resent ? 'Bạn đã đăng ký từ trước — đây là mã của bạn!' : 'Đăng ký thành công!'}
      </div>

      <div className="qr-card">
        <div dangerouslySetInnerHTML={{ __html: data.qr_svg }} />
        <p className="lookup-code">{code}</p>
        <p className="qr-name">{data.full_name}</p>
      </div>

      <button className="primary" onClick={saveImage}>LƯU ẢNH MÃ QR</button>
      <a href="/toi" style={{ display: 'block' }}>
        <button className="ghost" type="button">Mở trang mã QR của mình</button>
      </a>

      <div className="notice">
        ⚠️ Ngày sự kiện sân trường rất đông, mạng có thể yếu. Hãy <b>lưu ảnh mã QR
        ngay bây giờ</b> để dùng được cả khi không có mạng. Mã cũng đã được gửi về
        email của bạn.
      </div>

      <p className="muted">
        Mã 6 ký tự <b>{code}</b> dùng khi máy bạn hết pin — đọc cho nhân viên tại
        quầy là được. Quên hết mọi thứ cũng không sao: nhân viên tra được bằng số
        điện thoại bạn vừa nhập. Hẹn gặp bạn ngày 12/09!
      </p>
    </main>
  );
}
