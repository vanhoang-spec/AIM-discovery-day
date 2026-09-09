/**
 * CRUD hoạt động (AC34 — "admin tùy chỉnh tên, mô tả, thời gian hoạt động",
 * yêu cầu gốc #5 của AIM) + the three per-checkpoint flags of AC29–31.
 *
 * Toggling counts_toward_badges rewrites what SHOULD have counted, so both
 * denormalised counters must be rebuilt afterwards — otherwise every student
 * with a badge there lights up v_progress_drift and the drift tile stops
 * meaning "bug" and starts meaning "someone touched config". The rebuild is
 * one UPDATE over ~2.000 rows; done synchronously in the same request.
 */

import { getDb } from '@atl/db';
import { checkAdmin, adminError } from '../../../../lib/admin-auth.js';

export const dynamic = 'force-dynamic';

const KINDS = ['sponsor_booth', 'diamond_booth', 'hall_session', 'learning_class',
               'info_desk', 'gift_counter', 'entrance', 'bonus'];
const AWARD_MODES = ['pg_scan', 'survey_complete', 'either', 'both_required'];

function readPatch(body) {
  const out = {};
  if (body.name != null) {
    const v = String(body.name).trim();
    if (!v) return { error: 'Tên không được rỗng' };
    out.name = v;
  }
  if (body.description !== undefined) out.description = body.description || null;
  if (body.location_hint !== undefined) out.location_hint = body.location_hint || null;
  if (body.starts_at !== undefined) out.starts_at = body.starts_at || null;
  if (body.ends_at !== undefined) out.ends_at = body.ends_at || null;
  if (body.zone_id !== undefined) out.zone_id = body.zone_id ? Number(body.zone_id) : null;
  if (body.capacity !== undefined) {
    out.capacity = body.capacity ? Number(body.capacity) : null;
    if (out.capacity != null && (!Number.isInteger(out.capacity) || out.capacity <= 0)) {
      return { error: 'Sức chứa không hợp lệ' };
    }
  }
  if (body.display_order !== undefined) out.display_order = Number(body.display_order) || 0;
  if (body.counts_toward_badges !== undefined) out.counts_toward_badges = !!body.counts_toward_badges;
  if (body.badge_weight !== undefined && body.badge_weight !== '') {
    out.badge_weight = Number(body.badge_weight);
    if (!Number.isInteger(out.badge_weight) || out.badge_weight < 1 || out.badge_weight > 9) {
      return { error: 'Trọng số badge phải là số nguyên 1–9' };
    }
  }
  if (body.is_active !== undefined) out.is_active = !!body.is_active;
  if (body.badge_award_mode !== undefined) {
    if (!AWARD_MODES.includes(body.badge_award_mode)) return { error: 'badge_award_mode sai' };
    out.badge_award_mode = body.badge_award_mode;
  }
  if (body.kind !== undefined) {
    if (!KINDS.includes(body.kind)) return { error: 'kind sai' };
    out.kind = body.kind;
  }
  return { patch: out };
}

export async function POST(request) {
  const auth = checkAdmin(request);
  if (!auth.ok) return adminError(auth);
  const body = await request.json().catch(() => ({}));
  const eventId = Number(body.event ?? 1);
  const actor = String(body.actor ?? '').trim();
  if (!actor) return Response.json({ error: 'Thiếu tên người thao tác' }, { status: 400 });

  const { patch, error } = readPatch(body);
  if (error) return Response.json({ error }, { status: 400 });
  if (!patch.name || !patch.kind) {
    return Response.json({ error: 'Tạo mới cần tối thiểu tên và loại' }, { status: 400 });
  }

  const db = await getDb();
  // Lỗi DB phải trả CHỮ, không phải 500 câm: chiều 09/09 một POST hỏng trên
  // production mà thân phản hồi rỗng đã buộc phải deploy thêm một lần chỉ để
  // nhìn thấy thông điệp lỗi.
  let r;
  try {
  r = await db.query(
    `insert into checkpoints (event_id, zone_id, kind, name, description, location_hint,
                              starts_at, ends_at, capacity, counts_toward_badges,
                              badge_award_mode, is_active, display_order, badge_weight)
     values ($1, $2, $3::checkpoint_kind, $4, $5, $6, $7, $8, $9,
             coalesce($10, true), coalesce($11, 'pg_scan')::badge_award_mode,
             coalesce($12, true), coalesce($13, 0), coalesce($14, 1))
     returning id`,
    [eventId, patch.zone_id ?? null, patch.kind, patch.name, patch.description ?? null,
     patch.location_hint ?? null, patch.starts_at ?? null, patch.ends_at ?? null,
     // postgres.js CẤM undefined trong params (PGlite thì lặng lẽ coi là null
     // — vì thế bug này vô hình trên dev). Route chết 500 câm trên production
     // chiều 09/09 ngay lần đầu Layer B được bấm thật. Mọi trường tuỳ chọn
     // phải ?? null trước khi vào mảng.
     patch.capacity ?? null, patch.counts_toward_badges ?? null, patch.badge_award_mode ?? null,
     patch.is_active ?? null, patch.display_order ?? null, patch.badge_weight ?? null],
  );
  } catch (err) {
    console.error('create_checkpoint failed:', err);
    return Response.json({ error: `DB: ${err.message}` }, { status: 500 });
  }
  await db.query(
    `insert into audit_log (event_id, actor_type, actor_id, action, target_type, target_id, after_state)
     values ($1, 'super_admin', $2, 'create_checkpoint', 'checkpoint', $3::text, $4::jsonb)`,
    [eventId, actor, String(r.rows[0].id), JSON.stringify(patch)],
  );
  return Response.json({ ok: true, id: r.rows[0].id });
}

export async function PATCH(request) {
  const auth = checkAdmin(request);
  if (!auth.ok) return adminError(auth);
  const body = await request.json().catch(() => ({}));
  const eventId = Number(body.event ?? 1);
  const id = Number(body.id);
  const actor = String(body.actor ?? '').trim();
  if (!id) return Response.json({ error: 'Thiếu id' }, { status: 400 });
  if (!actor) return Response.json({ error: 'Thiếu tên người thao tác' }, { status: 400 });

  const { patch, error } = readPatch(body);
  if (error) return Response.json({ error }, { status: 400 });
  const keys = Object.keys(patch);
  if (keys.length === 0) return Response.json({ error: 'Không có gì để sửa' }, { status: 400 });

  const db = await getDb();
  const before = (await db.query(
    `select name, description, location_hint, starts_at, ends_at, zone_id, capacity,
            counts_toward_badges, badge_award_mode::text as badge_award_mode,
            is_active, display_order, kind::text as kind, badge_weight
       from checkpoints where id = $1 and event_id = $2`, [id, eventId])).rows[0];
  if (!before) return Response.json({ error: 'not_found' }, { status: 404 });

  const sets = keys.map((k, i) =>
    k === 'kind' ? `${k} = $${i + 3}::checkpoint_kind`
    : k === 'badge_award_mode' ? `${k} = $${i + 3}::badge_award_mode`
    : `${k} = $${i + 3}`).join(', ');
  await db.query(
    `update checkpoints set ${sets}, updated_at = now() where id = $1 and event_id = $2`,
    [id, eventId, ...keys.map((k) => patch[k])],
  );

  // Counting semantics changed → the stored counters are now stale by
  // definition. Rebuild both ladders so drift keeps meaning "bug".
  const countingChanged =
    ('counts_toward_badges' in patch && patch.counts_toward_badges !== before.counts_toward_badges)
    || ('kind' in patch && patch.kind !== before.kind)
    // [0012] Đổi trọng số cũng đổi số badge mọi SV đã quét mốc này đang giữ.
    || ('badge_weight' in patch && patch.badge_weight !== before.badge_weight);
  let rebuilt = 0;
  if (countingChanged) {
    rebuilt = (await db.query(
      `select rebuild_all_progress($1::smallint) as n`, [eventId])).rows[0].n;
  }

  await db.query(
    `insert into audit_log (event_id, actor_type, actor_id, action, target_type, target_id,
                            before_state, after_state)
     values ($1, 'super_admin', $2, 'update_checkpoint', 'checkpoint', $3::text, $4::jsonb, $5::jsonb)`,
    [eventId, actor, String(id), JSON.stringify(before), JSON.stringify(patch)],
  );
  return Response.json({ ok: true, rebuilt });
}
