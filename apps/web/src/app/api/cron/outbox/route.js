/**
 * Outbox drain — the only place email actually leaves the system.
 *
 * Vercel Cron hits this every minute. The route claims a batch with
 * FOR UPDATE SKIP LOCKED (claim_outbox_batch, 0004), so an overlapping run —
 * cron firing while the previous invocation is still sending — takes
 * DIFFERENT rows instead of double-sending the same student.
 *
 * Retries belong to the outbox alone: finish_outbox(ok=false) reschedules
 * with 1→2→4… minute backoff and parks the row as 'failed' after 8 attempts.
 * This route never retries in-process, and sendViaResend never throws on
 * HTTP errors — one retry owner, no double-send seams.
 *
 * The QR is re-minted per send, not stored: mintToken is deterministic
 * (HMAC over event + seq), so a retry attaches a byte-identical PNG.
 *
 * The template is chosen at SEND time from events.email_copy (0016), not at
 * queue time: set the event's copy before its first confirmation goes out.
 */

import { getDb } from '@atl/db';
import { mintToken, importKey } from '@atl/qr-token';
import { renderPNGDataURL } from '@atl/qr-render';
import { renderConfirmEmail, renderReminderEmail, sendViaResend, unsubscribeHeaders } from '@atl/email';
import { BRAND } from '@atl/brand';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BATCH = 40; // 40/min = 2.400/giờ — dư cho burst đăng ký sau một bài post

const DEV_KEY = 'atl2026-dev-key-do-not-use-in-production';

async function studentToken(eventId, seq) {
  const secret = process.env.ATL_HMAC_KEY;
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('ATL_HMAC_KEY is required in production');
  }
  const key = await importKey(secret || DEV_KEY);
  return mintToken({ eventInstance: eventId, studentSeq: seq }, key);
}

async function qrPngBase64(token) {
  const dataUrl = await renderPNGDataURL(token, { scale: 8 });
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

/**
 * [14/11, AIM] Link riêng mở thẳng trang điểm: /toi#t=<mã QR>. Mã nằm sau dấu
 * # nên không đi qua máy chủ/CDN/nhật ký; /toi đọc nó, đổi lấy thẻ tham dự
 * (lib/toi-link.js) rồi xoá khỏi thanh địa chỉ. Ranh giới tin cậy y như ảnh QR
 * đính kèm cùng thư — ai cầm được mã QR vốn đã xem được điểm của người đó.
 */
function myUrlFor(site, token) {
  return `${site}/toi#t=${encodeURIComponent(token)}`;
}

export async function GET(request) {
  // Vercel Cron authenticates with CRON_SECRET; anyone else gets nothing.
  const auth = request.headers.get('authorization');
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) {
    // Do NOT claim rows we cannot send — claiming bumps `attempts`, and eight
    // no-op claims would park every row as failed before a key ever arrives.
    return Response.json({ skipped: 'RESEND_API_KEY / EMAIL_FROM not configured' });
  }

  // [14/11] atl.aimacademy.vn đã không còn trên DNS; tên miền đang chạy là
  // app.awakenthelions.net. Biến môi trường vẫn thắng nếu có.
  const site = (process.env.NEXT_PUBLIC_SITE_URL || 'https://app.awakenthelions.net').replace(/\/+$/, '');
  const db = await getDb();

  const batch = await db.query(`select * from claim_outbox_batch($1)`, [BATCH]);
  let sent = 0;
  let failed = 0;

  for (const row of batch.rows) {
    try {
      if (row.channel !== 'email') {
        // SMS was cut on 25/08; a row can only exist if someone re-enabled
        // events.sms_enabled without building a sender. Park it visibly.
        await db.query(`select finish_outbox($1, false, $2)`, [row.id, 'no sender for channel']);
        failed++;
        continue;
      }

      // email_copy (0016): NULL → mẫu ATL2026 cũ; có giá trị → mẫu kiểu AIM.
      // Cột này phải có trên production TRƯỚC khi deploy bản code này —
      // thiếu cột là mọi thư trong outbox nổ ở đây và lùi lịch thử lại.
      const evR = await db.query(
        `select name, venue_name, city, starts_at, ends_at, email_copy from events where id = $1`,
        [row.event_id],
      );
      const stR = await db.query(
        `select s.full_name, s.lookup_code, s.seq from students s where s.id = $1`,
        [row.student_id],
      );
      const ev = evR.rows[0];
      const student = stR.rows[0];
      if (!ev || !student) {
        await db.query(`select finish_outbox($1, false, $2)`, [row.id, 'student or event missing']);
        failed++;
        continue;
      }

      const token = await studentToken(row.event_id, student.seq);
      const urls = { agendaUrl: `${site}/lich`, myUrl: myUrlFor(site, token) };
      const msg = row.template === 'confirm'
        ? renderConfirmEmail({
            student, ev, ...urls,
            qrPngBase64: await qrPngBase64(token),
          })
        : renderReminderEmail({ template: row.template, student, ev, ...urls });

      const r = await sendViaResend(
        {
          from,
          to: row.recipient,
          replyTo: BRAND.email.replyTo,
          headers: unsubscribeHeaders(BRAND.email.replyTo),
          ...msg,
        },
        { apiKey },
      );
      await db.query(`select finish_outbox($1, $2, $3)`, [row.id, r.ok, r.error ?? null]);
      r.ok ? sent++ : failed++;
    } catch (err) {
      // A render/mint bug must not wedge the whole batch.
      await db.query(`select finish_outbox($1, false, $2)`, [row.id, String(err.message)]);
      failed++;
    }
  }

  return Response.json({ claimed: batch.rows.length, sent, failed });
}
