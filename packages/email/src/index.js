/**
 * @atl/email — render + send confirmation and reminder emails.
 *
 * Design constraints, in order of how expensive they are to violate:
 *
 * 1. THE QR IS A REAL ATTACHMENT, never a hotlinked image. Gmail and most
 *    Vietnamese providers block remote images by default; an email whose QR
 *    is a dead grey box at the gate is worse than no email. The PNG rides in
 *    the message itself, so once the email is opened it works with zero
 *    network — same offline story as the /toi screen.
 *
 * 2. Email is a NICE-TO-HAVE lane, not the critical path. The student already
 *    has the QR on screen and saved to photos at registration time. Copy
 *    reflects that: the email is a backup, and it says so.
 *
 * 3. Plain tables + inline styles only. No external CSS, no web fonts, no
 *    images beyond the attached QR (referenced via cid:). Renders the same in
 *    Gmail, Outlook, Zalo Mail webview and a 2018 Samsung mail client.
 *
 * 4. Everything here is pure: (row, deps) → message object. The Resend call
 *    is the only I/O and takes an injectable fetch, so tests never touch the
 *    network and the worker route stays four lines.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** Subject lines per template. Kept short — Vietnamese mobile mail clients
 *  truncate around 40 characters. */
export function subjectFor(template, ev) {
  switch (template) {
    case 'confirm':
      return `Mã tham dự ${ev.name} của bạn`;
    case 'reminder_d3':
      return `Còn 3 ngày — ${ev.name}`;
    case 'reminder_d1':
      return `Ngày mai gặp nhé — ${ev.name}`;
    case 'morning':
      return `Hôm nay: ${ev.name} — nhớ mang mã QR`;
    default:
      throw new Error(`Unknown template: ${template}`);
  }
}

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** "K7M3QX" -> "K7M-3QX" — same grouping the /toi screen shows. */
const fmtCode = (c) => (c && c.length === 6 ? `${c.slice(0, 3)}-${c.slice(3)}` : c ?? '');

function fmtEventDate(startsAt) {
  const d = new Date(startsAt);
  // Fixed VN timezone — the server runs in UTC, the event does not.
  const days = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];
  const vn = new Date(d.getTime() + 7 * 3600 * 1000);
  return `${days[vn.getUTCDay()]} ${String(vn.getUTCDate()).padStart(2, '0')}/${String(vn.getUTCMonth() + 1).padStart(2, '0')}/${vn.getUTCFullYear()}`;
}

/**
 * The confirmation email. `student` needs full_name + lookup_code; `ev` needs
 * name, venue_name, city, starts_at; `qrPngBase64` is the raw base64 (no
 * data: prefix) of the QR PNG; `agendaUrl` links to /lich.
 */
export function renderConfirmEmail({ student, ev, qrPngBase64, agendaUrl }) {
  const code = fmtCode(student.lookup_code);
  const date = fmtEventDate(ev.starts_at);
  const name = esc(student.full_name);

  const text = [
    `Chào ${student.full_name},`,
    ``,
    `Bạn đã đăng ký thành công ${ev.name}.`,
    `${date} · 8h00–17h00 · ${ev.venue_name}, ${ev.city}.`,
    ``,
    `Mã QR của bạn nằm trong file đính kèm email này.`,
    `LƯU Ý QUAN TRỌNG: hãy lưu ảnh mã QR về máy ngay bây giờ.`,
    `Ngày sự kiện sân trường rất đông, mạng có thể yếu —`,
    `ảnh đã lưu dùng được cả khi không có mạng.`,
    ``,
    `Nếu không mở được ảnh, đọc mã dự phòng này cho nhân viên: ${code}`,
    ``,
    `Lịch hoạt động theo giờ và khu vực: ${agendaUrl}`,
    ``,
    `Hẹn gặp bạn,`,
    `AIM Academy · Awaken The Lions 2026`,
  ].join('\n');

  const html = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f1ee;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f1ee;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #e3d8d1;">
  <tr><td style="padding:28px 28px 8px;font-family:Arial,Helvetica,sans-serif;">
    <div style="font-size:11px;letter-spacing:2px;color:#864c3c;text-transform:uppercase;font-weight:bold;">Awaken The Lions 2026</div>
    <div style="font-size:24px;font-weight:bold;color:#171a1f;padding-top:8px;">Bạn đã đăng ký thành công</div>
  </td></tr>
  <tr><td style="padding:8px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#333;">
    Chào <b>${name}</b>,<br>
    Hẹn gặp bạn tại <b>${esc(ev.name)}</b>:<br>
    <b>${date} · 8h00–17h00</b><br>
    ${esc(ev.venue_name)}, ${esc(ev.city)}
  </td></tr>
  <tr><td align="center" style="padding:20px 28px;">
    <img src="cid:qr-code" width="220" height="220" alt="Mã QR tham dự của bạn (trong file đính kèm)"
         style="display:block;border:1px solid #e3d8d1;padding:12px;background:#ffffff;">
    <div style="font-family:Courier,monospace;font-size:26px;font-weight:bold;letter-spacing:4px;color:#171a1f;padding-top:12px;">${esc(code)}</div>
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#7b8089;padding-top:4px;">Mã dự phòng — đọc cho nhân viên khi không quét được</div>
  </td></tr>
  <tr><td style="padding:0 28px 20px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0e2da;border-left:4px solid #864c3c;">
      <tr><td style="padding:12px 16px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#5b3428;">
        <b>Hãy lưu ảnh mã QR về máy ngay bây giờ.</b><br>
        Ngày sự kiện sân trường rất đông, mạng có thể yếu. Ảnh QR đính kèm email này — mở ra và bấm lưu về máy, dùng được cả khi không có mạng.
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:0 28px 24px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.7;color:#333;">
    📅 <a href="${esc(agendaUrl)}" style="color:#864c3c;">Xem lịch hoạt động theo giờ và khu vực</a>
  </td></tr>
  <tr><td style="padding:16px 28px;border-top:1px solid #e3d8d1;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#7b8089;line-height:1.6;">
    AIM Academy · Đại diện chính thức Cannes Lions tại Việt Nam<br>
    Email này gửi vì bạn đã đăng ký tham dự sự kiện. Mọi thắc mắc, trả lời trực tiếp email này.
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  return {
    subject: subjectFor('confirm', ev),
    html,
    text,
    attachments: [
      {
        filename: 'ma-qr-tham-du.png',
        content: qrPngBase64,
        content_id: 'qr-code',
      },
    ],
  };
}

/** Reminder emails share one renderer — what changes is urgency and the one
 *  action asked of the reader. No QR attachment: the confirm email and the
 *  /toi screen already carry it; re-attaching trains people to dig through
 *  their inbox at the gate instead of opening the saved photo. */
export function renderReminderEmail({ template, student, ev, agendaUrl, myUrl }) {
  const date = fmtEventDate(ev.starts_at);
  const lead =
    template === 'reminder_d3' ? `Còn 3 ngày nữa là ${esc(ev.name)}.`
    : template === 'reminder_d1' ? `Ngày mai là ${esc(ev.name)} rồi.`
    : `Hôm nay là ngày sự kiện.`;
  const name = esc(student.full_name);

  const text = [
    `Chào ${student.full_name},`,
    ``,
    lead.replace(/<[^>]+>/g, ''),
    `${date} · 8h00–17h00 · ${ev.venue_name}, ${ev.city}.`,
    ``,
    `3 việc nên làm trước khi đến:`,
    `1. Mở ${myUrl} và LƯU ẢNH mã QR về máy (dùng được khi mất mạng).`,
    `2. Xem lịch hoạt động: ${agendaUrl}`,
    `3. Sạc đầy pin điện thoại.`,
    ``,
    `Đến trước 8h45 được thêm 1 badge Early Bird.`,
    ``,
    `AIM Academy · Awaken The Lions 2026`,
  ].join('\n');

  const html = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f1ee;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f1ee;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #e3d8d1;">
  <tr><td style="padding:28px 28px 8px;font-family:Arial,Helvetica,sans-serif;">
    <div style="font-size:11px;letter-spacing:2px;color:#864c3c;text-transform:uppercase;font-weight:bold;">Awaken The Lions 2026</div>
    <div style="font-size:22px;font-weight:bold;color:#171a1f;padding-top:8px;">${lead}</div>
  </td></tr>
  <tr><td style="padding:8px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#333;">
    Chào <b>${name}</b>,<br>
    <b>${date} · 8h00–17h00</b> · ${esc(ev.venue_name)}, ${esc(ev.city)}
  </td></tr>
  <tr><td style="padding:12px 28px 4px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.9;color:#333;">
    3 việc nên làm trước khi đến:<br>
    1. <a href="${esc(myUrl)}" style="color:#864c3c;"><b>Lưu ảnh mã QR về máy</b></a> — dùng được cả khi mất mạng<br>
    2. <a href="${esc(agendaUrl)}" style="color:#864c3c;">Xem lịch hoạt động theo giờ</a><br>
    3. Sạc đầy pin điện thoại
  </td></tr>
  <tr><td style="padding:12px 28px 24px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#245c44;">
    ⭐ Đến trước 8h45 được thêm 1 badge Early Bird.
  </td></tr>
  <tr><td style="padding:16px 28px;border-top:1px solid #e3d8d1;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#7b8089;">
    AIM Academy · Awaken The Lions 2026
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  return { subject: subjectFor(template, ev), html, text, attachments: [] };
}

/**
 * Send one message through Resend. Pure I/O wrapper: no retry logic here —
 * the outbox (claim/finish with backoff) owns retries, and a second retry
 * layer would double-send on the boundary between them.
 *
 * Returns { ok, id?, error? }; never throws on HTTP errors so the worker can
 * feed finish_outbox either way. Throws only on programmer errors.
 */
export async function sendViaResend(
  { from, to, subject, html, text, attachments = [] },
  { apiKey, fetchImpl = fetch } = {},
) {
  if (!apiKey) throw new Error('sendViaResend: apiKey is required');
  if (!from || !to) throw new Error('sendViaResend: from and to are required');

  let res;
  try {
    res = await fetchImpl(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        html,
        text,
        attachments: attachments.map((a) => ({
          filename: a.filename,
          content: a.content,
          content_id: a.content_id,
        })),
      }),
    });
  } catch (err) {
    return { ok: false, error: `network: ${err.message}` };
  }

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.message ?? ''; } catch { /* body optional */ }
    return { ok: false, error: `resend ${res.status}: ${detail}` };
  }
  const body = await res.json().catch(() => ({}));
  return { ok: true, id: body.id };
}
