/**
 * Admin student lookup (AC36, first half).
 *
 * One box, no mode picker: detectQueryKind classifies what the admin typed —
 * lookup code / phone / MSSV / name — the same brain the PG scanner uses, so
 * the two surfaces never disagree about what a query means. Name search hits
 * name_search_key (diacritic-folded, ~2.000 rows, trivially indexed); phone
 * matches full number or tail.
 */

import { getDb } from '@atl/db';
import { detectQueryKind, foldDiacritics, normalisePhone } from '@atl/vn-text';
import { checkAdmin, adminError } from '../../../../lib/admin-auth.js';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const auth = checkAdmin(request);
  if (!auth.ok) return adminError(auth);

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') ?? '').trim();
  const eventId = Number(url.searchParams.get('event') ?? 1);
  if (!q) return Response.json({ kind: 'empty', students: [] });

  const kind = detectQueryKind(q);
  const db = await getDb();

  const base = `
    select s.id, s.seq, s.full_name, s.lookup_code, s.phone, s.email,
           s.student_code, r.badge_count, r.core_badge_count
      from students s
      join registrations r on r.student_id = s.id and r.event_id = $1
     where s.merged_into_id is null and `;
  const tail = ` order by s.full_name limit 12`;

  let rows;
  if (kind === 'lookup_code') {
    rows = await db.query(base + `s.lookup_code = $2` + tail,
      [eventId, q.replace(/[\s-]/g, '').toUpperCase()]);
  } else if (kind === 'phone') {
    rows = await db.query(base + `s.phone = $2` + tail, [eventId, normalisePhone(q)]);
  } else if (kind === 'phone_tail') {
    rows = await db.query(base + `s.phone like '%' || $2` + tail,
      [eventId, q.replace(/\D/g, '')]);
  } else if (kind === 'student_code') {
    rows = await db.query(base + `upper(s.student_code) = upper($2)` + tail, [eventId, q]);
  } else {
    rows = await db.query(base + `s.name_search_key like '%' || $2 || '%'` + tail,
      [eventId, foldDiacritics(q)]);
  }

  return Response.json(
    { kind, students: rows.rows },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
