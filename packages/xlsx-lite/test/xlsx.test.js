/**
 * Round-trip proof: the test contains its own minimal zip READER (store +
 * deflate via node:zlib), so "the file is a valid zip whose XML carries the
 * exact Vietnamese text" is asserted structurally, not by eyeballing Excel.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { buildWorkbook } from '../src/index.js';

/** Parse a zip via its central directory — the same route Excel takes. */
function unzip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'thiếu End Of Central Directory');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'sai chữ ký central directory');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);

    assert.equal(buf.readUInt32LE(lho), 0x04034b50, 'sai chữ ký local header');
    const lnlen = buf.readUInt16LE(lho + 26);
    const lelen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnlen + lelen;
    const payload = buf.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(payload) : Buffer.from(payload);
    assert.equal(data.length, usize, `${name}: uncompressed size lệch`);
    files.set(name, { data, crc });
    p += 46 + nlen + elen + clen;
  }
  return files;
}

const SHEETS = [
  {
    name: 'Điểm danh theo giờ',
    rows: [
      ['Giờ', 'Lượt quét', 'Badge'],
      ['08:00', 120, 118],
      ['09:00', 340, 331],
    ],
  },
  {
    name: 'Sinh viên',
    rows: [
      ['Họ tên', 'Trường', 'Badge'],
      ['Nguyễn Thị Minh An', 'Đại học Ngoại thương', 3],
      ['Lê Hoàng Phương Uyên', 'Đại học Ngoại thương', 0],
    ],
  },
];

describe('xlsx-lite', () => {
  const wb = buildWorkbook(SHEETS);
  const files = unzip(wb);

  test('the container is a well-formed zip with every OOXML part', () => {
    for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
                        'xl/_rels/workbook.xml.rels', 'xl/styles.xml',
                        'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) {
      assert.ok(files.has(part), `thiếu ${part}`);
    }
    assert.equal(wb.readUInt32LE(0), 0x04034b50, 'file phải mở đầu bằng chữ ký zip (PK)');
  });

  test('Vietnamese text survives byte-exact — the whole reason this is not CSV', () => {
    const xml = files.get('xl/worksheets/sheet2.xml').data.toString('utf8');
    assert.match(xml, /Nguyễn Thị Minh An/);
    assert.match(xml, /Lê Hoàng Phương Uyên/);
    assert.match(xml, /Đại học Ngoại thương/);
  });

  test('numbers are numeric cells (SUM must work), strings are inline strings', () => {
    const xml = files.get('xl/worksheets/sheet1.xml').data.toString('utf8');
    assert.match(xml, /<c r="B2"><v>120<\/v><\/c>/);
    assert.match(xml, /t="inlineStr"/);
    assert.doesNotMatch(xml, /<v>08:00<\/v>/, 'chuỗi không được thành ô số');
  });

  test('header row is styled bold; body rows are not', () => {
    const xml = files.get('xl/worksheets/sheet1.xml').data.toString('utf8');
    assert.match(xml, /<c r="A1" s="1"/);
    assert.doesNotMatch(xml, /<c r="A2" s="1"/);
  });

  test('sheet names are registered and escaped', () => {
    const xml = files.get('xl/workbook.xml').data.toString('utf8');
    assert.match(xml, /name="Điểm danh theo giờ"/);
    assert.match(xml, /name="Sinh viên"/);
  });

  test('XML-hostile content is escaped, control chars stripped', () => {
    const evil = buildWorkbook([{
      name: 'x', rows: [['a<b&c"d', 'ok\x01bad']],
    }]);
    const xml = unzip(evil).get('xl/worksheets/sheet1.xml').data.toString('utf8');
    assert.match(xml, /a&lt;b&amp;c&quot;d/);
    assert.match(xml, /okbad/);
  });

  test('forbidden sheet-name characters and length are sanitised', () => {
    const wb2 = buildWorkbook([{ name: 'Báo cáo: [NTT]/2026 — bản đầy đủ chi tiết', rows: [['x']] }]);
    const xml = unzip(wb2).get('xl/workbook.xml').data.toString('utf8');
    const m = xml.match(/name="([^"]+)"/);
    assert.ok(m[1].length <= 31);
    assert.doesNotMatch(m[1], /[[\]:/\\?*]/);
  });

  test('an empty sheet list refuses loudly', () => {
    assert.throws(() => buildWorkbook([]), /ít nhất một sheet/);
  });
});
