/**
 * Sponsor surveys, student side. Auth is the QR token — same trust boundary
 * as /api/toi: the phone that can show its QR can answer surveys as itself,
 * and nobody can answer as someone else without their token.
 *
 * GET  ?t=<token>            → active surveys for MY event + which I've done
 * POST {t, survey_id, response_uid, answers}
 *
 * Answers are validated against the survey's CURRENT questions server-side —
 * a hand-crafted payload cannot smuggle arbitrary keys into the report. The
 * response body is data, never rendered as markup anywhere.
 */

import { getDb } from '@atl/db';
import { verifyToken, importKey } from '@atl/qr-token';

export const dynamic = 'force-dynamic';

const DEV_KEY = 'atl2026-dev-key-do-not-use-in-production';
let keyPromise;
function getKey() {
  if (!keyPromise) {
    const secret = process.env.ATL_HMAC_KEY;
    if (!secret && process.env.NODE_ENV === 'production') {
      throw new Error('ATL_HMAC_KEY is required in production');
    }
    keyPromise = importKey(secret || DEV_KEY);
  }
  return keyPromise;
}

async function resolveStudent(token, db) {
  const claims = await verifyToken(token, await getKey());
  if (!claims.valid) return { error: 'invalid_token', status: 401 };
  const student = (await db.query(
    `select s.id from students s
      join registrations r on r.student_id = s.id and r.event_id = $2
     where s.seq = $1 and s.merged_into_id is null`,
    [claims.studentSeq, claims.eventInstance],
  )).rows[0];
  if (!student) return { error: 'not_registered', status: 404 };
  return { studentId: student.id, eventId: claims.eventInstance };
}

export async function GET(request) {
  const token = new URL(request.url).searchParams.get('t') ?? '';
  const db = await getDb();
  const who = await resolveStudent(token, db);
  if (who.error) return Response.json({ error: who.error }, { status: who.status });

  const surveys = (await db.query(
    `select sv.id, sv.title, sv.intro, sv.accent_hex, sv.questions,
            c.name as booth_name,
            c.badge_award_mode::text as award_mode,
            exists (select 1 from survey_responses r
                     where r.survey_id = sv.id and r.student_id = $2) as done
       from surveys sv
       join checkpoints c on c.id = sv.checkpoint_id and c.event_id = sv.event_id
      where sv.event_id = $1 and sv.is_active and c.is_active
      order by sv.id`,
    [who.eventId, who.studentId],
  )).rows;

  return Response.json(
    { surveys },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}

/** Server-side answer validation: shape follows the survey, nothing else. */
function validateAnswers(questions, answers) {
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) {
    return 'Câu trả lời không hợp lệ';
  }
  const byId = new Map(questions.map((q) => [q.id, q]));
  for (const key of Object.keys(answers)) {
    if (!byId.has(key)) return 'Câu trả lời chứa mục lạ';
  }
  for (const q of questions) {
    const a = answers[q.id];
    if (a == null || a === '' || (Array.isArray(a) && a.length === 0)) {
      if (q.required) return `Câu "${q.label}" là bắt buộc`;
      continue;
    }
    if (q.type === 'choice' && !q.options?.includes(a)) return 'Lựa chọn không hợp lệ';
    if (q.type === 'multi'
        && !(Array.isArray(a) && a.every((x) => q.options?.includes(x)))) {
      return 'Lựa chọn không hợp lệ';
    }
    if (q.type === 'scale' && !(Number.isInteger(a) && a >= 1 && a <= 5)) {
      return 'Thang điểm từ 1 đến 5';
    }
    if (q.type === 'text' && (typeof a !== 'string' || a.length > 500)) {
      return 'Câu trả lời quá dài (tối đa 500 ký tự)';
    }
  }
  return null;
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const db = await getDb();
  const who = await resolveStudent(String(body.t ?? ''), db);
  if (who.error) return Response.json({ error: who.error }, { status: who.status });

  const surveyId = Number(body.survey_id);
  const responseUid = String(body.response_uid ?? '');
  if (!surveyId || !/^[0-9a-f-]{36}$/i.test(responseUid)) {
    return Response.json({ error: 'Thiếu dữ liệu' }, { status: 400 });
  }

  const survey = (await db.query(
    `select questions, is_active from surveys where id = $1 and event_id = $2`,
    [surveyId, who.eventId],
  )).rows[0];
  if (!survey || !survey.is_active) {
    return Response.json({ error: 'Khảo sát đã đóng' }, { status: 409 });
  }
  const invalid = validateAnswers(survey.questions, body.answers);
  if (invalid) return Response.json({ error: invalid }, { status: 400 });

  const r = (await db.query(
    `select * from submit_survey_response($1::uuid, $2::smallint, $3, $4, $5::jsonb)`,
    [responseUid, who.eventId, surveyId, who.studentId, JSON.stringify(body.answers)],
  )).rows[0];

  if (r.status === 'closed') return Response.json({ error: 'Khảo sát đã đóng' }, { status: 409 });
  return Response.json({
    status: r.status,               // submitted | replay | already_submitted
    badge_status: r.badge_status,   // counted | pending_other_condition | ...
    badge_count: r.badge_count,
  });
}
