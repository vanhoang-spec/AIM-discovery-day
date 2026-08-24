/**
 * Reference data for the registration form: events open for registration,
 * the school list, and the 34 provinces.
 *
 * One payload, cached at the edge for an hour — every student shares the same
 * copy, so this endpoint costs the origin roughly one query per hour per
 * region regardless of attendance.
 */

import { getDb } from '@/lib/db';

export async function GET() {
  const db = await getDb();
  const [events, schools, provinces] = await Promise.all([
    db.query(
      `select id, slug, name, venue_name, city
         from events where is_registration_open order by id`),
    db.query(
      `select id, name, search_key from ref_schools where is_active order by name`),
    db.query(
      `select code, name, search_key from ref_provinces order by name`),
  ]);

  return Response.json(
    { events: events.rows, schools: schools.rows, provinces: provinces.rows },
    {
      headers: {
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      },
    },
  );
}
