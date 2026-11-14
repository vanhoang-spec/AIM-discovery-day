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
 *    (Only exception: the optional signature image of the AIM-style template,
 *    which is decoration — blocked, it degrades to its alt text.)
 *
 * Two template families. events.email_copy NULL → the original ATL2026
 * templates below, byte-for-byte (a test pins their sha256). email_copy set
 * (migration 0016) → the AIM-style templates further down, every
 * event-specific word coming from that JSON.
 *
 * 4. Everything here is pure: (row, deps) → message object. The Resend call
 *    is the only I/O and takes an injectable fetch, so tests never touch the
 *    network and the worker route stays four lines.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** Subject lines per template. Kept short — Vietnamese mobile mail clients
 *  truncate around 40 characters. */
export function subjectFor(template, ev) {
  const copy = parseEmailCopy(ev?.email_copy);
  if (copy) return aimSubject(template, copy);
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
export function renderConfirmEmail({ student, ev, qrPngBase64, agendaUrl, myUrl }) {
  const copy = parseEmailCopy(ev.email_copy);
  if (copy) return renderAimConfirm({ student, ev, copy, qrPngBase64, myUrl });

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
  const copy = parseEmailCopy(ev.email_copy);
  if (copy) return renderAimReminder({ template, student, ev, copy, myUrl });

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

// ---------------------------------------------------------------------------
// Mẫu kiểu AIM — dùng khi events.email_copy có giá trị (migration 0016)
// ---------------------------------------------------------------------------

/**
 * Đọc + kiểm events.email_copy. NULL/undefined → null (dùng mẫu cũ). Sai shape
 * → throw, liệt kê đủ mọi lỗi (worker đưa câu đó vào last_error của outbox).
 * Nhận cả object lẫn chuỗi JSON (driver nào cũng chạy).
 *
 * Mọi chữ RIÊNG của một sự kiện nằm trong JSON; code chỉ giữ phần chữ chung
 * của AIM (đoạn QR Code / badge / Quầy Quà Trung Tâm, câu "Lưu ý", "Trân trọng
 * cảm ơn."). Mọi trường là CHỮ THƯỜNG — không HTML, không markdown; mẫu tự
 * quyết chỗ in đậm và tự escape. (* = bắt buộc)
 *
 * Ví dụ đầy đủ (sự kiện 17/11/2026): test/fixtures/discovery-day-1711.json.
 *
 *   event_title*          Tên hiển thị, in đậm trong "Cảm ơn bạn đã đăng ký tham
 *                         gia **{event_title}**!"; cũng là dòng nhỏ đầu thư.
 *   short_title           Tên ngắn mở đầu thư nhắc: "**{short_title}** sẽ chính
 *                         thức bắt đầu." Vắng → event_title. VD "Discovery Day"
 *   subjects.confirm*     Tiêu đề thư xác nhận, nguyên văn
 *   subjects.morning*     Tiêu đề thư nhắc sáng ngày sự kiện, nguyên văn
 *   support_place*        "...liên hệ Ban Tổ chức tại **{support_place}.**"
 *   venue_line*           Dòng "Địa điểm:" của thư nhắc
 *   time_line             Dòng "Thời gian:" của thư nhắc. Vắng → dựng từ
 *                         starts_at/ends_at, dạng "8h - 16h30, thứ bảy, 12.09.2026"
 *   booth_opens           Dòng "Booth hoạt động từ:". Vắng → không in dòng đó
 *   see_you*              Câu hẹn gặp, nguyên văn ("Hẹn gặp bạn tại ...")
 *   organizer             Chữ ký "Ban tổ chức **{organizer}.**" Vắng → event_title
 *   signature_image_url   Ảnh chữ ký, phải là https. Vắng → không có ảnh. Ảnh
 *                         từ xa: Gmail chặn mặc định → chỉ hiện chữ alt.
 *   signature_image_width Độ rộng ảnh (px, số nguyên 40–504). Vắng → kích
 *                         thước gốc, co theo khung trên điện thoại.
 *
 * Dấu chấm cuối support_place / organizer có hay không đều được — mẫu tự thêm
 * đúng một dấu. Trường lạ bị bỏ qua. CHECK events_email_copy_valid (0016) giữ
 * cùng luật ở database; test chạy cùng bộ mẫu qua cả hai.
 *
 * Mẫu AIM chỉ có hai thư: 'confirm' và 'morning'.
 */
export function parseEmailCopy(raw) {
  if (raw === null || raw === undefined) return null;
  let c = raw;
  if (typeof c === 'string') {
    try {
      c = JSON.parse(c);
    } catch {
      throw new Error('email_copy không hợp lệ: không phải JSON');
    }
  }
  if (typeof c !== 'object' || c === null || Array.isArray(c)) {
    throw new Error('email_copy không hợp lệ: phải là một object JSON');
  }

  const problems = [];
  const at = (path) => path.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), c);
  for (const path of COPY_REQUIRED) {
    const v = at(path);
    if (typeof v !== 'string' || v.trim() === '') problems.push(`thiếu ${path.join('.')}`);
  }
  for (const k of COPY_OPTIONAL) {
    const v = c[k];
    if (v !== undefined && v !== null && typeof v !== 'string') problems.push(`${k} phải là chuỗi`);
  }
  const url = typeof c.signature_image_url === 'string' ? c.signature_image_url.trim() : '';
  if (url && !/^https:\/\//i.test(url)) problems.push('signature_image_url phải bắt đầu bằng https://');
  const w = c.signature_image_width;
  if (w !== undefined && w !== null && !(Number.isInteger(w) && w >= 40 && w <= 504)) {
    problems.push('signature_image_width phải là số nguyên 40–504');
  }
  if (problems.length) throw new Error(`email_copy không hợp lệ: ${problems.join(', ')}`);

  const opt = (k) => (typeof c[k] === 'string' && c[k].trim() !== '' ? c[k].trim() : null);
  const title = c.event_title.trim();
  return {
    eventTitle: title,
    shortTitle: opt('short_title') ?? title,
    subjects: { confirm: oneLine(c.subjects.confirm), morning: oneLine(c.subjects.morning) },
    supportPlace: c.support_place.trim(),
    venueLine: c.venue_line.trim(),
    timeLine: opt('time_line'),
    boothOpens: opt('booth_opens'),
    seeYou: c.see_you.trim(),
    organizer: opt('organizer') ?? title,
    signatureImageUrl: url || null,
    signatureImageWidth: w ?? null,
  };
}

const COPY_REQUIRED = [
  ['event_title'], ['subjects', 'confirm'], ['subjects', 'morning'],
  ['support_place'], ['venue_line'], ['see_you'],
];
const COPY_OPTIONAL = ['short_title', 'time_line', 'booth_opens', 'organizer', 'signature_image_url'];

/** Tiêu đề là một dòng header — xuống dòng trong JSON không được lọt vào. */
const oneLine = (s) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();
/** Bỏ dấu chấm cuối để mẫu tự thêm đúng một dấu. */
const noDot = (s) => s.replace(/[\s.]+$/, '');
/** esc() cũ không escape dấu nháy — đủ cho text node, không đủ cho thuộc tính. */
const escAttr = (s) => esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function aimSubject(template, copy) {
  if (template === 'confirm') return copy.subjects.confirm;
  if (template === 'morning') return copy.subjects.morning;
  throw new Error(`Unknown template for AIM email_copy: ${template} (chỉ có confirm và morning)`);
}

/** "8h - 16h30, thứ bảy, 12.09.2026" — giờ VN, cách AIM viết. */
function fmtTimeLine(startsAt, endsAt) {
  const s = new Date(startsAt);
  if (Number.isNaN(s.getTime())) {
    throw new Error('email_copy: không có time_line và starts_at không đọc được');
  }
  const vn = (d) => new Date(d.getTime() + 7 * 3600 * 1000);
  const hour = (d) => {
    const v = vn(d);
    const m = v.getUTCMinutes();
    return m ? `${v.getUTCHours()}h${String(m).padStart(2, '0')}` : `${v.getUTCHours()}h`;
  };
  const e = endsAt ? new Date(endsAt) : null;
  const hours = e && !Number.isNaN(e.getTime()) ? `${hour(s)} - ${hour(e)}` : hour(s);
  const days = ['chủ nhật', 'thứ hai', 'thứ ba', 'thứ tư', 'thứ năm', 'thứ sáu', 'thứ bảy'];
  const d = vn(s);
  const date = `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
  return `${hours}, ${days[d.getUTCDay()]}, ${date}`;
}

// Chữ chung của AIM — giống nhau ở mọi sự kiện dùng mẫu này.
const AIM_QR_HTML =
  'Đừng quên lưu và sử dụng <b>QR Code</b> đính kèm trong email này trong suốt quá trình tham gia sự kiện. ' +
  'QR Code sẽ giúp bạn ghi nhận lượt tham gia tại các gian hàng và hoạt động, thu thập <b>badge</b> ' +
  'và đổi quà khủng tại <b>Quầy Quà Trung Tâm</b> của Ban Tổ chức.';
const AIM_NOTE_HTML =
  '<b>Lưu ý:</b> Hãy đảm bảo bạn mang theo QR Code trong suốt sự kiện để không bỏ lỡ cơ hội thu thập badge và nhận quà đặc biệt.';
const AIM_REMINDER_LEAD =
  'sẽ chính thức bắt đầu. Bạn đã sẵn sàng cho một ngày đầy trải nghiệm, thử thách và những bất ngờ thú vị chưa?';
const AIM_REMINDER_KEEP =
  'Để không bỏ lỡ bất kỳ hoạt động nào, hãy lưu lại những thông tin quan trọng dưới đây:';
const stripTags = (s) => s.replace(/<[^>]+>/g, '');

const FONT = 'font-family:Arial,Helvetica,sans-serif;';
const para = (inner, pad = '8px 28px') =>
  `  <tr><td style="padding:${pad};${FONT}font-size:15px;line-height:1.6;color:#333;">
    ${inner}
  </td></tr>`;

function aimNoteBox() {
  return `  <tr><td style="padding:8px 28px 12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0e2da;border-left:4px solid #864c3c;">
      <tr><td style="padding:12px 16px;${FONT}font-size:14px;line-height:1.6;color:#5b3428;">
        ${AIM_NOTE_HTML}
      </td></tr>
    </table>
  </td></tr>`;
}

/** Đoạn cuối chung: hỗ trợ · hẹn gặp · cảm ơn · chữ ký (+ ảnh tuỳ chọn). */
function aimClosingHtml(copy) {
  const img = copy.signatureImageUrl
    ? `
  <tr><td style="padding:4px 28px 20px;">
    <img src="${escAttr(copy.signatureImageUrl)}"${copy.signatureImageWidth ? ` width="${copy.signatureImageWidth}"` : ''} alt="${escAttr(`Ban tổ chức ${noDot(copy.organizer)}`)}"
         style="display:block;border:0;${copy.signatureImageWidth ? `width:${copy.signatureImageWidth}px;` : ''}max-width:100%;height:auto;">
  </td></tr>`
    : '';
  return [
    para(`Nếu cần hỗ trợ hoặc có bất kỳ thắc mắc nào, vui lòng liên hệ Ban Tổ chức tại <b>${esc(noDot(copy.supportPlace))}.</b>`),
    para(esc(copy.seeYou)),
    para(`Trân trọng cảm ơn.<br>
    Ban tổ chức <b>${esc(noDot(copy.organizer))}.</b>`, '8px 28px 20px'),
  ].join('\n') + img;
}

function aimClosingText(copy) {
  return [
    `Nếu cần hỗ trợ hoặc có bất kỳ thắc mắc nào, vui lòng liên hệ Ban Tổ chức tại ${noDot(copy.supportPlace)}.`,
    ``,
    copy.seeYou,
    ``,
    `Trân trọng cảm ơn.`,
    `Ban tổ chức ${noDot(copy.organizer)}.`,
  ];
}

function aimDocument(copy, rows) {
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f1ee;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f1ee;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #e3d8d1;">
  <tr><td style="padding:28px 28px 4px;${FONT}">
    <div style="font-size:11px;letter-spacing:2px;color:#864c3c;text-transform:uppercase;font-weight:bold;">${esc(copy.eventTitle)}</div>
  </td></tr>
${rows}
  <tr><td style="padding:16px 28px;border-top:1px solid #e3d8d1;${FONT}font-size:12px;color:#7b8089;line-height:1.6;">
    Email này gửi vì bạn đã đăng ký tham dự sự kiện.
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

/**
 * [14/11, AIM yêu cầu] Nút mở trang điểm cá nhân. Đợt 12/09 SV phải điền lại
 * form đăng ký mới vào xem được điểm; `myUrl` giờ là link riêng từng người
 * (/toi#t=<mã QR>) nên bấm là thấy ngay badge + mã QR, máy nào cũng được.
 */
const AIM_MY_LABEL = 'Xem điểm và mã QR của bạn';

function aimButton(url, label) {
  if (!url) return '';
  return `  <tr><td style="padding:12px 28px 8px;">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td bgcolor="#864c3c" style="background:#864c3c;border-radius:4px;">
        <a href="${escAttr(url)}" style="display:inline-block;padding:12px 22px;${FONT}font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;">${esc(label)}</a>
      </td>
    </tr></table>
  </td></tr>`;
}

/** Thư xác nhận kiểu AIM. Vẫn đính kèm QR (cid) + mã dự phòng như mẫu cũ. */
function renderAimConfirm({ student, ev, copy, qrPngBase64, myUrl }) {
  const code = fmtCode(student.lookup_code);
  const name = esc(student.full_name);

  const text = [
    `Xin chào ${student.full_name},`,
    ``,
    `Cảm ơn bạn đã đăng ký tham gia ${copy.eventTitle}!`,
    ``,
    stripTags(AIM_QR_HTML),
    ``,
    `Nếu không mở được ảnh QR, đọc mã dự phòng này cho nhân viên: ${code}`,
    ``,
    ...(myUrl ? [`${AIM_MY_LABEL} (badge đã thu thập, quà đã đủ điều kiện): ${myUrl}`, ``] : []),
    stripTags(AIM_NOTE_HTML),
    ``,
    ...aimClosingText(copy),
  ].join('\n');

  const rows = [
    para(`Xin chào <b>${name}</b>,`, '16px 28px 8px'),
    para(`Cảm ơn bạn đã đăng ký tham gia <b>${esc(copy.eventTitle)}</b>!`),
    para(AIM_QR_HTML),
    `  <tr><td align="center" style="padding:16px 28px;">
    <img src="cid:qr-code" width="220" height="220" alt="Mã QR tham dự của bạn (trong file đính kèm)"
         style="display:block;border:1px solid #e3d8d1;padding:12px;background:#ffffff;">
    <div style="font-family:Courier,monospace;font-size:26px;font-weight:bold;letter-spacing:4px;color:#171a1f;padding-top:12px;">${esc(code)}</div>
    <div style="${FONT}font-size:12px;color:#7b8089;padding-top:4px;">Mã dự phòng — đọc cho nhân viên khi không quét được</div>
  </td></tr>`,
    aimButton(myUrl, AIM_MY_LABEL),
    aimNoteBox(),
    aimClosingHtml(copy),
  ].join('\n');

  return {
    subject: aimSubject('confirm', copy),
    html: aimDocument(copy, rows),
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

/** Thư nhắc kiểu AIM — chỉ 'morning'. Không đính kèm QR; có nút mở /toi. */
function renderAimReminder({ template, student, ev, copy, myUrl }) {
  const subject = aimSubject(template, copy);
  if (template !== 'morning') {
    throw new Error(`Unknown template for AIM email_copy: ${template} (chỉ có confirm và morning)`);
  }
  const name = esc(student.full_name);
  const timeLine = copy.timeLine ?? fmtTimeLine(ev.starts_at, ev.ends_at);
  const facts = [
    ['Địa điểm:', copy.venueLine],
    ['Thời gian:', timeLine],
    ...(copy.boothOpens ? [['Booth hoạt động từ:', copy.boothOpens]] : []),
  ];

  const text = [
    `Xin chào ${student.full_name},`,
    ``,
    `${copy.shortTitle} ${AIM_REMINDER_LEAD}`,
    ``,
    AIM_REMINDER_KEEP,
    ...facts.map(([k, v]) => `- ${k} ${v}`),
    ``,
    ...(myUrl ? [`${AIM_MY_LABEL}: ${myUrl}`, ``] : []),
    stripTags(AIM_NOTE_HTML),
    ``,
    ...aimClosingText(copy),
  ].join('\n');

  const button = aimButton(myUrl, AIM_MY_LABEL);

  const rows = [
    para(`Xin chào <b>${name}</b>,`, '16px 28px 8px'),
    para(`<b>${esc(copy.shortTitle)}</b> ${AIM_REMINDER_LEAD}`),
    para(`${AIM_REMINDER_KEEP}<br>
    ${facts.map(([k, v]) => `&bull; <b>${k}</b> ${esc(v)}`).join('<br>\n    ')}`),
    button,
    aimNoteBox(),
    aimClosingHtml(copy),
  ].filter(Boolean).join('\n');

  return { subject, html: aimDocument(copy, rows), text, attachments: [] };
}

/**
 * Send one message through Resend. Pure I/O wrapper: no retry logic here —
 * the outbox (claim/finish with backoff) owns retries, and a second retry
 * layer would double-send on the boundary between them.
 *
 * Returns { ok, id?, error? }; never throws on HTTP errors so the worker can
 * feed finish_outbox either way. Throws only on programmer errors.
 */
/**
 * List-Unsubscribe, as a `mailto:` only.
 *
 * A brand-new sending domain has no reputation, and corporate filters read
 * the absence of this header as "bulk sender who does not offer an exit".
 * Adding it is one of the few positive trust signals available on day one —
 * `mail.awakenthelions.net` published its DNS this morning.
 *
 * Deliberately NOT declaring `List-Unsubscribe-Post: One-Click`: that promises
 * an HTTPS endpoint which honours a POST, and we do not have one. Announcing a
 * capability we cannot serve is worse than omitting it — Gmail tests it.
 * One-click only becomes mandatory above 5.000 messages/day; this campaign
 * sends ~4.000 across a whole week.
 */
export function unsubscribeHeaders(mailbox) {
  if (!mailbox) return {};
  return {
    'List-Unsubscribe': `<mailto:${mailbox}?subject=Huy nhan email ATL2026>`,
  };
}

export async function sendViaResend(
  { from, to, subject, html, text, attachments = [], replyTo, headers },
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
        // Resend spells it snake_case. Omitted entirely when absent — sending
        // reply_to: undefined is fine in JS but an explicit null is not.
        ...(replyTo ? { reply_to: [replyTo] } : {}),
        ...(headers && Object.keys(headers).length ? { headers } : {}),
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
