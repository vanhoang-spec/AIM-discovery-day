/**
 * @atl/xlsx-lite — a real .xlsx writer in ~200 lines, zero dependencies.
 *
 * Why not CSV: Excel's Vietnamese builds open a BOM-less CSV as the system
 * codepage and render "Nguyễn Văn A" as "Nguyá»…n VÄƒn A" — the client then
 * reports "sai dữ liệu" (AC33). Why not exceljs: it is a megabyte of
 * dependency for what is, at our size, a zip of five small XML files.
 *
 * Scope is deliberately tiny — the 20% that covers 100% of event reports:
 *   - multiple sheets, first row bold as a header
 *   - strings (inline, UTF-8 — diacritics exact by construction)
 *   - numbers stay numbers (so SUM works in Excel), dates passed as strings
 *   - column widths auto-fit to content, capped
 * Nothing else: no formulas, no styles beyond the header, no merged cells.
 *
 * The zip container uses DEFLATE via node:zlib — which also gives the test
 * suite a native way to unzip and round-trip the workbook.
 */

import { deflateRawSync } from 'node:zlib';

/* ------------------------------------------------------------------ zip -- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build a zip from [{ name, data: Buffer }] — enough of APPNOTE.TXT for
 *  every xlsx consumer: local headers, central directory, EOCD. */
function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 6 });
    // Store when deflate does not help (tiny files).
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);            // time
    local.writeUInt16LE(0x21, 12);         // date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/* ----------------------------------------------------------------- xlsx -- */

const escXml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Control chars are illegal in XML 1.0 and Excel refuses the file.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

function colName(i) {
  let s = '';
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
  return s;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function sheetXml(rows) {
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      const len = String(cell ?? '').length;
      if (!widths[i] || len > widths[i]) widths[i] = len;
    });
  }
  const cols = widths.map((w, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${Math.min(50, Math.max(8, (w ?? 8) + 2))}" customWidth="1"/>`).join('');

  const body = rows.map((row, r) => {
    const cells = row.map((v, c) => {
      if (v == null || v === '') return '';
      const ref = `${colName(c)}${r + 1}`;
      const style = r === 0 ? ' s="1"' : '';
      return isNum(v)
        ? `<c r="${ref}"${style}><v>${v}</v></c>`
        : `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escXml(v)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${cols}</cols><sheetData>${body}</sheetData></worksheet>`;
}

/**
 * Build a workbook.
 * @param {Array<{name: string, rows: Array<Array<string|number|null>>}>} sheets
 *   First row of each sheet renders bold. Sheet names are trimmed to Excel's
 *   31-char limit and stripped of the characters it forbids.
 * @returns {Buffer} the .xlsx file
 */
export function buildWorkbook(sheets) {
  if (!sheets?.length) throw new Error('buildWorkbook: cần ít nhất một sheet');
  const names = sheets.map((s, i) => {
    const clean = String(s.name ?? `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31);
    return clean || `Sheet${i + 1}`;
  });

  const sheetRefs = names.map((n, i) =>
    `<sheet name="${escXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  const relRefs = names.map((_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('');
  const typeRefs = names.map((_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');

  const entries = [
    { name: '[Content_Types].xml', data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${typeRefs}</Types>`) },
    { name: '_rels/.rels', data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: 'xl/workbook.xml', data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetRefs}</sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relRefs}<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) },
    { name: 'xl/styles.xml', data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`) },
    ...sheets.map((s, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: Buffer.from(sheetXml(s.rows)),
    })),
  ];

  return zip(entries);
}
