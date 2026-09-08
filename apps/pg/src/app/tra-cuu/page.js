'use client';

/**
 * Manual lookup — the co-primary path, not a fallback.
 *
 * There is no thermal printer at the venue, so when a student's screen will
 * not scan — dim in sunlight, cracked, flat battery — typing is the only way
 * they get their badge. It runs entirely off the cached roster, so it works
 * with no signal at all.
 *
 * One design decision matters more than the rest: results show the phone
 * number, not just the name. Vietnamese names have low entropy — typing
 * "nguyen an" in a roster of two thousand returns a dozen people — and handing
 * a badge to the wrong one is worse than making the PG ask for four digits.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { searchRoster } from '@atl/vn-text';
import { getQueue, getRoster, getActiveCheckpoint, getSession } from '@/lib/session';
import { feedback } from '@/lib/scanner';
import { canAward } from '@/lib/boot-state';

const KIND_LABEL = {
  lookup_code: 'mã 6 ký tự',
  phone: 'số điện thoại',
  phone_tail: '4 số cuối',
  student_code: 'mã số sinh viên',
  name: 'tên',
};

export default function LookupPage() {
  const router = useRouter();
  const [roster, setRoster] = useState([]);
  const [checkpoint, setCheckpoint] = useState(null);
  const [session, setSession] = useState(null);
  const [query, setQuery] = useState('');
  const [done, setDone] = useState(null);

  // Read first, publish once — same discipline as the scanner's boot after the
  // 08/09 crash (lib/boot-state.js).
  useEffect(() => {
    (async () => {
      const s = await getSession();
      if (!s) { router.replace('/'); return; }
      const [r, cp] = [await getRoster(), await getActiveCheckpoint()];
      setRoster(r);
      setCheckpoint(cp ?? null);
      setSession(s);
    })();
  }, [router]);

  // Runs on every keystroke over the whole roster. ~1.8ms at 2,000 rows, so
  // there is no reason to debounce and every reason not to — a PG typing with
  // a queue in front of them should see the list narrow as they go.
  const { kind, results } = useMemo(
    () => (query.trim() ? searchRoster(roster, query, { limit: 8 }) : { kind: 'empty', results: [] }),
    [roster, query],
  );

  async function award(student) {
    // A PG can type a name and tap a result before getActiveCheckpoint()
    // resolves; the queue item is built from checkpoint.id. Same family of
    // bug as the 08/09 crash, quieter symptom: a badge that goes nowhere.
    if (!canAward({ session, checkpoint })) return;
    const q = getQueue();
    const { duplicate, item } = await q.enqueue({
      student_seq: student.seq,
      checkpoint_id: checkpoint.id,
      student_name: student.name,
    });
    feedback(duplicate ? 'amber' : 'ok');
    setDone({ student, duplicate, item });
    q.flush().catch(() => {});
  }

  if (done) {
    return (
      <main className="screen">
        <div className={`result ${done.duplicate ? 'amber' : 'ok'}`} style={{ padding: 22 }}>
          <p className="verdict">{done.duplicate ? 'ĐÃ CÓ BADGE NÀY' : 'ĐÃ GHI NHẬN'}</p>
          <p className="name">{done.student.name}</p>
          <p className="meta">
            {done.student.mssv ?? ''} · {checkpoint?.name}
            {!done.duplicate && <span className="tilde"> · ~ chờ đồng bộ</span>}
          </p>
        </div>
        <div className="pad">
          <button
            className="primary"
            onClick={() => { setDone(null); setQuery(''); }}
          >
            TRA CỨU NGƯỜI TIẾP THEO
          </button>
          <button className="ghost" style={{ marginTop: 10 }} onClick={() => router.push('/quet')}>
            QUAY LẠI MÀN QUÉT
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="screen">
      <div className="cpbar">
        <span>Tra cứu · {checkpoint?.name ?? '—'}</span>
        <small>không cần mạng</small>
      </div>

      <div className="pad">
        <input
          type="text" inputMode="text" autoFocus autoComplete="off"
          placeholder="Mã 6 ký tự, SĐT, MSSV, hoặc tên"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query.trim() && (
          <p className="muted" style={{ marginTop: 6 }}>
            Đang tìm theo <b>{KIND_LABEL[kind] ?? 'tên'}</b> · {results.length} kết quả
          </p>
        )}

        <div className="list" style={{ marginTop: 12 }}>
          {results.map((s) => (
            <button key={s.seq} className="hit" onClick={() => award(s)}>
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

        {query.trim() && results.length === 0 && (
          <div className="alert warn" style={{ marginTop: 12 }}>
            <b>Không tìm thấy</b>
            Thử 4 số cuối điện thoại — chính xác hơn tên nhiều. Nếu sinh viên vừa đăng ký
            tại cổng, danh sách trên máy có thể chưa kịp cập nhật; báo giám sát.
          </div>
        )}

        {results.length > 3 && (
          <div className="alert warn" style={{ marginTop: 12 }}>
            <b>Nhiều kết quả trùng tên</b>
            Hỏi thêm 4 số cuối điện thoại trước khi trao badge.
          </div>
        )}

        <button className="ghost" style={{ marginTop: 16 }} onClick={() => router.push('/quet')}>
          QUAY LẠI MÀN QUÉT
        </button>
      </div>
    </main>
  );
}

/** Show enough to confirm identity, not enough to be a contact list. */
function maskPhone(phone) {
  if (!phone) return null;
  const d = String(phone).replace(/\D/g, '');
  return d.length >= 4 ? `••••${d.slice(-4)}` : null;
}
