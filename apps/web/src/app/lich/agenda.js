/**
 * Shared renderer for the two agenda views (AC32).
 *
 * Two ROUTES instead of one route + ?xem= : reading searchParams makes a page
 * fully dynamic in Next, so every student would hit the origin. As two static
 * routes, each is ISR-rendered once per minute and the CDN serves everyone —
 * origin load independent of attendance, which is the whole point of AC32.
 */

import { getDb } from '@atl/db';
import Link from 'next/link';

const VN_TZ_MS = 7 * 3600 * 1000;

function hhmm(ts) {
  if (!ts) return null;
  const d = new Date(new Date(ts).getTime() + VN_TZ_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

const KIND_LABEL = {
  sponsor_booth: 'Gian hàng',
  diamond_booth: 'Gian hàng Kim cương',
  hall_session: 'Sân khấu chính',
  learning_class: 'Lớp học',
};

/** Empty agenda — what the page renders when the database cannot be read. */
const EMPTY = { events: [], rows: [], busyBy: new Map(), anyScans: false, degraded: true };

export async function loadAgenda() {
  try {
    return await readAgenda();
  } catch (err) {
    // These two pages are ISR: Next prerenders them AT BUILD TIME. Letting a
    // database hiccup throw here means a bad connection string — or a
    // thirty-second Supabase blip — fails the entire deployment, including
    // the registration form that has nothing to do with the agenda.
    // Degrade instead: ship the shell, let the next revalidation fill it in.
    // The deploy's real database gate is the /api/refdata smoke check.
    console.error('loadAgenda failed, rendering empty agenda:', err.message);
    return EMPTY;
  }
}

async function readAgenda() {
  const db = await getDb();
  const events = (await db.query(
    `select id, slug, name, venue_name, city, starts_at
       from events
      where is_registration_open
      order by id`,
  )).rows;

  const rows = (await db.query(
    `select c.id, c.event_id, c.kind::text as kind, c.name, c.description,
            c.location_hint, c.starts_at, c.ends_at, c.display_order,
            z.name as zone_name
       from checkpoints c
       left join zones z on z.id = c.zone_id and z.event_id = c.event_id
      where c.is_active
        and c.kind not in ('bonus', 'gift_counter', 'entrance', 'info_desk')
      order by c.event_id, c.starts_at nulls last, c.display_order, c.id`,
  )).rows;

  // Busyness: scans in the last 15 minutes from the rollup table — never
  // COUNT(*) on the ledger. Before the event this is empty and the chips
  // stay hidden: an agenda full of "Vắng" three weeks out reads as a bug.
  const busy = (await db.query(
    `select event_id, checkpoint_id, sum(scan_count)::int as n
       from checkpoint_minute_counts
      where minute_ts >= now() - interval '15 minutes'
      group by event_id, checkpoint_id`,
  )).rows;
  const busyBy = new Map(busy.map((b) => [`${b.event_id}:${b.checkpoint_id}`, b.n]));
  return { events, rows, busyBy, anyScans: busy.length > 0 };
}

function crowdChip(n) {
  if (n >= 20) return { label: 'Đông', cls: 'crowd-high' };
  if (n >= 6) return { label: 'Vừa', cls: 'crowd-mid' };
  return { label: 'Vắng', cls: 'crowd-low' };
}

function Activity({ cp, busyBy, anyScans }) {
  const chip = anyScans ? crowdChip(busyBy.get(`${cp.event_id}:${cp.id}`) ?? 0) : null;
  const time = cp.starts_at
    ? `${hhmm(cp.starts_at)}${cp.ends_at ? `–${hhmm(cp.ends_at)}` : ''}`
    : 'Cả ngày';
  return (
    <li className="agenda-item">
      <div className="agenda-time">{time}</div>
      <div className="agenda-body">
        <div className="agenda-name">
          {cp.name}
          {chip && <span className={`crowd ${chip.cls}`}>{chip.label}</span>}
        </div>
        <div className="agenda-meta">
          {[KIND_LABEL[cp.kind] ?? cp.kind, cp.zone_name, cp.location_hint]
            .filter(Boolean).join(' · ')}
        </div>
        {cp.description && <div className="agenda-desc">{cp.description}</div>}
      </div>
    </li>
  );
}

export async function AgendaView({ view }) {
  const { events, rows, busyBy, anyScans } = await loadAgenda();

  return (
    <main className="wrap agenda">
      <header className="agenda-head">
        <p className="eyebrow">Awaken The Lions 2026 · Discovery Day</p>
        <h1>Lịch hoạt động</h1>
        <p className="muted">8h00–17h00 · Thứ bảy 12/09/2026</p>
        <nav className="agenda-tabs" aria-label="Chế độ xem">
          <Link href="/lich" className={view === 'time' ? 'tab on' : 'tab'}>Theo giờ</Link>
          <Link href="/lich/khu-vuc" className={view === 'zone' ? 'tab on' : 'tab'}>
            Theo khu vực
          </Link>
        </nav>
      </header>

      {events.map((ev) => {
        const evRows = rows.filter((r) => r.event_id === ev.id);
        if (evRows.length === 0) {
          return (
            <section key={ev.id} className="agenda-event">
              <h2>{ev.name}</h2>
              <p className="muted">
                Chương trình chi tiết sẽ cập nhật tại đây — quay lại sau bạn nhé.
              </p>
            </section>
          );
        }

        const by = new Map();
        for (const r of evRows) {
          const k = view === 'zone'
            ? (r.zone_name ?? 'Khu vực chung')
            : (r.starts_at ? hhmm(r.starts_at) : 'Diễn ra cả ngày');
          if (!by.has(k)) by.set(k, []);
          by.get(k).push(r);
        }

        return (
          <section key={ev.id} className="agenda-event">
            <h2>{ev.name}</h2>
            <p className="muted">{ev.venue_name}, {ev.city}</p>
            {[...by.entries()].map(([label, items]) => (
              <div key={label} className="agenda-group">
                <h3>{label}</h3>
                <ul className="agenda-list">
                  {items.map((cp) => (
                    <Activity key={cp.id} cp={cp} busyBy={busyBy} anyScans={anyScans} />
                  ))}
                </ul>
              </div>
            ))}
          </section>
        );
      })}

      <footer className="agenda-foot">
        <Link href="/toi">← Mã QR của tôi</Link>
      </footer>
    </main>
  );
}
