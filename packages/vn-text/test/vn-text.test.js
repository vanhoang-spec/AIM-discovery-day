import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  foldDiacritics,
  searchKey,
  matchesQuery,
  detectQueryKind,
  normalisePhone,
  searchRoster,
} from '../src/index.js';

describe('diacritic folding', () => {
  test('folds every Vietnamese vowel family', () => {
    const cases = [
      ['àáạảãâầấậẩẫăằắặẳẵ', 'aaaaaaaaaaaaaaaaa'],
      ['èéẹẻẽêềếệểễ', 'eeeeeeeeeee'],
      ['ìíịỉĩ', 'iiiii'],
      ['òóọỏõôồốộổỗơờớợởỡ', 'ooooooooooooooooo'],
      ['ùúụủũưừứựửữ', 'uuuuuuuuuuu'],
      ['ỳýỵỷỹ', 'yyyyy'],
    ];
    for (const [input, expected] of cases) {
      assert.equal(foldDiacritics(input), expected, `folding ${input}`);
    }
  });

  test('folds đ and Đ — the case NFD alone does not handle', () => {
    assert.equal(foldDiacritics('đ'), 'd');
    assert.equal(foldDiacritics('Đại học'), 'dai hoc');
    assert.equal(foldDiacritics('Đặng Đình Đức'), 'dang dinh duc');
  });

  test('the motivating case: typing without diacritics finds the school', () => {
    assert.equal(searchKey('Đại học Ngoại thương'), 'dai hoc ngoai thuong');
    assert.ok(matchesQuery(searchKey('Đại học Ngoại thương'), 'ngoai thuong'));
    assert.ok(matchesQuery(searchKey('Đại học Ngoại thương'), 'dai hoc'));
    assert.ok(matchesQuery(searchKey('Học viện Bưu chính Viễn thông'), 'buu chinh'));
  });

  test('handles real student names', () => {
    assert.equal(searchKey('Nguyễn Thị Minh An'), 'nguyen thi minh an');
    assert.equal(searchKey('Trần Quốc Tuấn'), 'tran quoc tuan');
    assert.equal(searchKey('Lê Hoàng Phương Uyên'), 'le hoang phuong uyen');
  });

  test('strips punctuation and collapses whitespace', () => {
    assert.equal(searchKey('  Nguyễn   Văn-A.  '), 'nguyen van a');
  });

  test('survives null and empty input rather than throwing mid-keystroke', () => {
    for (const v of [null, undefined, '']) {
      assert.equal(foldDiacritics(v), '');
      assert.equal(searchKey(v), '');
      assert.equal(matchesQuery('nguyen an', v), false);
    }
  });
});

describe('name matching', () => {
  const key = searchKey('Nguyễn Thị Minh An');

  test('matches partial tokens so a PG need not type the whole name', () => {
    for (const q of ['nguyen', 'an', 'nguyen an', 'ng an', 'minh an', 'n t m a']) {
      assert.ok(matchesQuery(key, q), `"${q}" should match`);
    }
  });

  test('matches with diacritics typed too — some PGs use a Vietnamese keyboard', () => {
    assert.ok(matchesQuery(key, 'Nguyễn An'));
    assert.ok(matchesQuery(key, 'Minh Ân'.normalize('NFC')));
  });

  test('every token must land, so unrelated names are not returned', () => {
    assert.equal(matchesQuery(key, 'nguyen binh'), false);
    assert.equal(matchesQuery(key, 'tran'), false);
  });
});

describe('query kind detection', () => {
  test('recognises the 6-character code printed under the QR', () => {
    assert.equal(detectQueryKind('K7M3QX'), 'lookup_code');
    assert.equal(detectQueryKind('K7M-3QX'), 'lookup_code');
    assert.equal(detectQueryKind('k7m3qx'), 'lookup_code');
  });

  test('recognises phone numbers, including the last-four shorthand', () => {
    assert.equal(detectQueryKind('0912345678'), 'phone');
    assert.equal(detectQueryKind('0912 345 678'), 'phone');
    assert.equal(detectQueryKind('+84912345678'), 'phone');
    assert.equal(detectQueryKind('5678'), 'phone_tail');
  });

  test('recognises student numbers', () => {
    assert.equal(detectQueryKind('2214810'), 'student_code');
    assert.equal(detectQueryKind('K58A1234'), 'student_code');
  });

  test('anything else is a name', () => {
    assert.equal(detectQueryKind('Nguyễn An'), 'name');
    assert.equal(detectQueryKind('nguyen'), 'name');
    assert.equal(detectQueryKind(''), 'empty');
    assert.equal(detectQueryKind('   '), 'empty');
  });
});

describe('phone normalisation', () => {
  test('reduces the ways one number gets written to a single form', () => {
    const forms = ['0912345678', '0912 345 678', '0912-345-678', '+84912345678', '84912345678'];
    const normalised = new Set(forms.map(normalisePhone));
    assert.equal(normalised.size, 1, [...normalised].join(' | '));
    assert.equal([...normalised][0], '0912345678');
  });
});

describe('roster search', () => {
  const roster = [
    { seq: 1001, lookup_code: 'K7M3QX', name: 'Nguyễn Thị Minh An', name_key: searchKey('Nguyễn Thị Minh An'), mssv: '2214810', phone: '0912345678', badge_count: 3 },
    { seq: 1002, lookup_code: 'P4R8TW', name: 'Nguyễn Văn An',      name_key: searchKey('Nguyễn Văn An'),      mssv: '2214811', phone: '0987654321', badge_count: 1 },
    { seq: 1003, lookup_code: 'B2C5DF', name: 'Trần Quốc Tuấn',     name_key: searchKey('Trần Quốc Tuấn'),     mssv: '2214812', phone: '0901112223', badge_count: 5 },
    { seq: 1004, lookup_code: 'H9J1KM', name: 'Lê Hoàng Phương Uyên', name_key: searchKey('Lê Hoàng Phương Uyên'), mssv: 'K58A1234', phone: '0933445566', badge_count: 0 },
  ];

  test('finds by the printed code, with or without the hyphen', () => {
    for (const q of ['K7M3QX', 'K7M-3QX', 'k7m3qx']) {
      const r = searchRoster(roster, q);
      assert.equal(r.kind, 'lookup_code');
      assert.equal(r.results.length, 1);
      assert.equal(r.results[0].seq, 1001);
    }
  });

  test('finds by full phone and by the last four digits', () => {
    assert.equal(searchRoster(roster, '0912345678').results[0].seq, 1001);
    const tail = searchRoster(roster, '4321');
    assert.equal(tail.kind, 'phone_tail');
    assert.equal(tail.results[0].seq, 1002);
  });

  test('finds by student number, exactly and by prefix', () => {
    assert.equal(searchRoster(roster, '2214812').results[0].seq, 1003);
    const partial = searchRoster(roster, '22148');
    assert.ok(partial.results.length >= 3, 'a partial MSSV still narrows the list');
  });

  test('finds by name without diacritics and ranks the closer match first', () => {
    const r = searchRoster(roster, 'nguyen an');
    assert.equal(r.kind, 'name');
    assert.equal(r.results.length, 2, 'both Ans match');
    // "Nguyễn Văn An" is the shorter name, so it is the more specific hit.
    assert.equal(r.results[0].seq, 1002);
  });

  test('a whole-word hit outranks a prefix of a longer word', () => {
    const r = searchRoster(roster, 'tuan');
    assert.equal(r.results[0].seq, 1003);
  });

  test('returns nothing rather than everything when there is no match', () => {
    assert.equal(searchRoster(roster, 'khong ton tai').results.length, 0);
    assert.equal(searchRoster(roster, 'ZZZZZZ').results.length, 0);
  });

  test('respects the result limit so the phone renders one screenful', () => {
    const big = Array.from({ length: 500 }, (_, i) => ({
      seq: 5000 + i,
      lookup_code: 'AAAAAA',
      name: `Nguyễn Văn ${i}`,
      name_key: searchKey(`Nguyễn Văn ${i}`),
      mssv: `99${i}`,
      phone: '0900000000',
    }));
    assert.equal(searchRoster(big, 'nguyen', { limit: 8 }).results.length, 8);
  });

  test('stays fast enough to run on every keystroke over a full roster', () => {
    const big = Array.from({ length: 2000 }, (_, i) => {
      const name = `Nguyễn Thị Minh ${i}`;
      return { seq: i, lookup_code: 'AAAAAA', name, name_key: searchKey(name),
               mssv: String(2214000 + i), phone: '09' + String(10000000 + i) };
    });
    const started = process.hrtime.bigint();
    for (let i = 0; i < 20; i++) searchRoster(big, 'nguyen minh');
    const msPerSearch = Number(process.hrtime.bigint() - started) / 1e6 / 20;
    assert.ok(msPerSearch < 25, `search took ${msPerSearch.toFixed(1)}ms over 2,000 rows`);
  });
});
