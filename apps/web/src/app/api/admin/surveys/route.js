/**
 * Admin survey builder API. The 8-question cap and hex-only accent are DB
 * constraints — this route just relays their refusals in Vietnamese. Editing
 * questions bumps schema_version automatically, so the 11:00-edit rule
 * (responses keep the version they answered) needs no admin discipline.
 */

import { getDb } from '@atl/db';
import { checkAdmin, adminError } from '../../../../lib/admin-auth.js';

export const dynamic = 'force-dynamic';

const TYPES = ['choice', 'multi', 'scale', 'text'];

function validateQuestions(qs) {
  if (!Array.isArray(qs)) return 'Danh sách câu hỏi không hợp lệ';
  if (qs.length > 8) return 'Tối đa 8 câu — khảo sát dài hơn sẽ bị bỏ dở trong hàng chờ';
  const ids = new Set();
  for (const q of qs) {
    if (!q.id || typeof q.id !== 'string' || ids.has(q.id)) return 'Mỗi câu cần id riêng';
    ids.add(q.id);
    if (!TYPES.includes(q.type)) return `Loại câu "${q.type}" không hỗ trợ`;
    if (!q.label || typeof q.label !== 'string' || q.label.length > 200) {
      return 'Mỗi câu cần nội dung, tối đa 200 ký tự';
    }
    if ((q.type === 'choice' || q.type === 'multi')
        && !(Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 8
             && q.options.every((o) => typeof o === 'string' && o.length <= 80))) {
      return 'Câu lựa chọn cần 2–8 phương án, mỗi phương án tối đa 80 ký tự';
    }
  }
  return null;
}

export async function GET(request) {
  const auth = checkAdmin(request);
  if (!auth.ok) return adminError(auth);
  const eventId = Number(new URL(request.url).searchParams.get('event') ?? 1);
  const db = await getDb();

  const [stats, full, booths] = await Promise.all([
    db.query(`select * from v_survey_stats where event_id = $1 order by survey_id`, [eventId]),
    db.query(
      `select id, checkpoint_id, title, intro, accent_hex, is_active, questions, schema_version
         from surveys where event_id = $1 order by id`, [eventId]),
    db.query(
      `select c.id, c.name from checkpoints c
        where c.event_id = $1 and c.kind in ('sponsor_booth', 'diamond_booth')
          and not exists (select 1 from surveys s where s.checkpoint_id = c.id)
        order by c.display_order, c.id`, [eventId]),
  ]);
  const byId = new Map(full.rows.map((r) => [r.id, r]));
  return Response.json({
    surveys: stats.rows.map((s) => ({ ...s, ...byId.get(s.survey_id) })),
    available_booths: booths.rows,
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function POST(request) {
  const auth = checkAdmin(request);
  if (!auth.ok) return adminError(auth);
  const body = await request.json().catch(() => ({}));
  const eventId = Number(body.event ?? 1);
  const actor = String(body.actor ?? '').trim();
  if (!actor) return Response.json({ error: 'Thiếu tên người thao tác' }, { status: 400 });
  const title = String(body.title ?? '').trim();
  if (!title) return Response.json({ error: 'Thiếu tiêu đề' }, { status: 400 });
  const qErr = validateQuestions(body.questions ?? []);
  if (qErr) return Response.json({ error: qErr }, { status: 400 });

  const db = await getDb();
  try {
    const r = await db.query(
      `insert into surveys (event_id, checkpoint_id, title, intro, accent_hex, questions)
       values ($1, $2, $3, $4, $5, $6::jsonb) returning id`,
      [eventId, Number(body.checkpoint_id), title, body.intro || null,
       body.accent_hex || null, JSON.stringify(body.questions ?? [])],
    );
    await db.query(
      `insert into audit_log (event_id, actor_type, actor_id, action, target_type, target_id)
       values ($1, 'super_admin', $2, 'create_survey', 'survey', $3::text)`,
      [eventId, actor, String(r.rows[0].id)]);
    return Response.json({ ok: true, id: r.rows[0].id });
  } catch (err) {
    const msg = /unique/i.test(err.message)
      ? 'Gian hàng này đã có khảo sát rồi — mỗi booth một khảo sát'
      : /check/i.test(err.message) ? 'Dữ liệu vi phạm ràng buộc (tối đa 8 câu, màu dạng #RRGGBB)'
      : err.message;
    return Response.json({ error: msg }, { status: 409 });
  }
}

export async function PATCH(request) {
  const auth = checkAdmin(request);
  if (!auth.ok) return adminError(auth);
  const body = await request.json().catch(() => ({}));
  const eventId = Number(body.event ?? 1);
  const id = Number(body.id);
  const actor = String(body.actor ?? '').trim();
  if (!id || !actor) return Response.json({ error: 'Thiếu id hoặc tên người thao tác' }, { status: 400 });

  const db = await getDb();
  const cur = (await db.query(
    `select questions, is_active from surveys where id = $1 and event_id = $2`,
    [id, eventId])).rows[0];
  if (!cur) return Response.json({ error: 'not_found' }, { status: 404 });

  let bumped = false;
  try {
    if (body.questions !== undefined) {
      const qErr = validateQuestions(body.questions);
      if (qErr) return Response.json({ error: qErr }, { status: 400 });
      const changed = JSON.stringify(cur.questions) !== JSON.stringify(body.questions);
      await db.query(
        `update surveys
            set questions = $3::jsonb,
                schema_version = schema_version + (case when $4 then 1 else 0 end),
                updated_at = now()
          where id = $1 and event_id = $2`,
        [id, eventId, JSON.stringify(body.questions), changed]);
      bumped = changed;
    }
    for (const [field, val] of [
      ['title', body.title != null ? String(body.title).trim() : undefined],
      ['intro', body.intro !== undefined ? (body.intro || null) : undefined],
      ['accent_hex', body.accent_hex !== undefined ? (body.accent_hex || null) : undefined],
      ['is_active', body.is_active !== undefined ? !!body.is_active : undefined],
    ]) {
      if (val === undefined) continue;
      await db.query(
        `update surveys set ${field} = $3, updated_at = now() where id = $1 and event_id = $2`,
        [id, eventId, val]);
    }
    await db.query(
      `insert into audit_log (event_id, actor_type, actor_id, action, target_type, target_id,
                              after_state)
       values ($1, 'super_admin', $2, 'update_survey', 'survey', $3::text, $4::jsonb)`,
      [eventId, actor, String(id),
       JSON.stringify({ bumped_version: bumped, is_active: body.is_active })]);
    return Response.json({ ok: true, version_bumped: bumped });
  } catch (err) {
    const msg = /check/i.test(err.message)
      ? 'Dữ liệu vi phạm ràng buộc (tối đa 8 câu, màu dạng #RRGGBB)' : err.message;
    return Response.json({ error: msg }, { status: 409 });
  }
}
