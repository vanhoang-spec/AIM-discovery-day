/**
 * Vietnamese text folding and offline roster search.
 *
 * This is load-bearing, not a convenience. PG staff use their own phones, and
 * there is no printed sticker fallback, so when a student's screen will not
 * scan — dim in sunlight, cracked, flat battery — typing is the only way the
 * student gets their badge. Manual lookup is a co-primary path, and it must be
 * as fast as the camera.
 *
 * No dependencies: this runs inside the PG scanner with no network.
 */

/** Combining marks left behind by NFD, plus the Vietnamese horn (U+031B). */
const COMBINING = /[̀-ͯ]/g;

/**
 * Fold Vietnamese text to lowercase ASCII.
 *
 * NFD decomposition handles every vowel — including ơ and ư, whose horn is a
 * combining mark — but đ/Đ is a distinct code point with no decomposition and
 * has to be replaced by hand. Miss that and "Đại học" never matches "dai hoc",
 * which is most of the school list.
 */
export function foldDiacritics(input) {
  if (input == null) return '';
  return String(input)
    .normalize('NFD')
    .replace(COMBINING, '')
    .replace(/[đĐ]/g, (c) => (c === 'đ' ? 'd' : 'D'))
    .toLowerCase();
}

/** Fold, strip punctuation, collapse whitespace. The form stored in the DB. */
export function searchKey(input) {
  return foldDiacritics(input)
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split a query into non-empty folded tokens. */
export function tokenize(input) {
  const key = searchKey(input);
  return key.length === 0 ? [] : key.split(' ');
}

/**
 * Does `candidate` match every token of `query`, each as a word prefix?
 *
 * Prefix rather than substring, and per token rather than whole-string, so a PG
 * can type "ng an" and reach "Nguyễn Thị Minh An" without typing the middle
 * names. Vietnamese names are long and queues are impatient.
 */
export function matchesQuery(candidateKey, query) {
  const tokens = tokenize(query);
  if (tokens.length === 0) return false;
  const words = String(candidateKey).split(' ');
  return tokens.every((t) => words.some((w) => w.startsWith(t)));
}

/**
 * Score a match so the likeliest student is first. Higher is better.
 * Exact and leading matches beat scattered ones; shorter names beat longer
 * ones on an equal match, because they are the more specific hit.
 */
export function scoreMatch(candidateKey, query) {
  const tokens = tokenize(query);
  const words = String(candidateKey).split(' ');
  if (tokens.length === 0) return 0;

  let score = 0;
  for (const t of tokens) {
    let best = 0;
    words.forEach((w, i) => {
      if (!w.startsWith(t)) return;
      // A whole-word hit is worth more than a prefix of a longer word.
      let s = w === t ? 100 : 60;
      // A hit on the first or last word of a Vietnamese name (họ or tên) is
      // more likely to be what was typed than a middle name.
      if (i === 0 || i === words.length - 1) s += 20;
      best = Math.max(best, s);
    });
    if (best === 0) return 0; // every token must land
    score += best;
  }
  return score - words.length; // tie-break toward the shorter name
}

/* ------------------------------------------------------------------ *
 * Roster search
 * ------------------------------------------------------------------ */

const LOOKUP_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{6}$/;

/**
 * Work out what the PG typed, so they never have to pick a search mode.
 * One box, four kinds of input.
 */
export function detectQueryKind(raw) {
  const trimmed = String(raw ?? '').trim();
  if (trimmed.length === 0) return 'empty';

  const compact = trimmed.replace(/[\s-]/g, '').toUpperCase();

  // 6 characters from the Crockford alphabet: the code printed under the QR.
  if (LOOKUP_CODE_RE.test(compact)) return 'lookup_code';

  const digits = trimmed.replace(/[\s.-]/g, '');
  if (/^\+?\d{4}$/.test(digits)) return 'phone_tail';   // last 4 digits
  if (/^\+?\d{8,15}$/.test(digits)) return 'phone';
  // 5-7 digits is most likely a student number, not a phone.
  if (/^\d{5,7}$/.test(digits)) return 'student_code';
  if (/^[a-zA-Z0-9]{6,12}$/.test(compact) && /\d/.test(compact)) return 'student_code';

  return 'name';
}

/** Digits only, so "0912 345 678" and "0912-345-678" compare equal. */
export function normalisePhone(input) {
  const d = String(input ?? '').replace(/\D/g, '');
  // Vietnamese numbers are written 0xxxxxxxxx locally and +84xxxxxxxxx abroad.
  if (d.startsWith('84') && d.length >= 11) return '0' + d.slice(2);
  return d;
}

/**
 * Search a cached roster.
 *
 * `roster` entries are the compact rows the PG device holds offline:
 *   { seq, lookup_code, name, name_key, mssv, phone, school, badge_count }
 *
 * Returns at most `limit` results, best first. Deliberately synchronous and
 * allocation-light: it runs on every keystroke on a five-year-old phone.
 */
export function searchRoster(roster, rawQuery, { limit = 8 } = {}) {
  const kind = detectQueryKind(rawQuery);
  if (kind === 'empty') return { kind, results: [] };

  const q = String(rawQuery).trim();

  if (kind === 'lookup_code') {
    const code = q.replace(/[\s-]/g, '').toUpperCase();
    return { kind, results: roster.filter((r) => r.lookup_code === code).slice(0, limit) };
  }

  if (kind === 'phone' || kind === 'phone_tail') {
    const digits = normalisePhone(q);
    const results = roster.filter((r) => {
      const p = normalisePhone(r.phone);
      if (!p) return false;
      return kind === 'phone' ? p === digits || p.endsWith(digits) : p.endsWith(digits);
    });
    return { kind, results: results.slice(0, limit) };
  }

  if (kind === 'student_code') {
    const code = q.replace(/[\s-]/g, '').toLowerCase();
    const exact = roster.filter((r) => String(r.mssv ?? '').toLowerCase() === code);
    if (exact.length > 0) return { kind, results: exact.slice(0, limit) };
    // Fall through to a prefix match: a PG reading a number aloud often stops
    // short, and a partial MSSV is still a useful filter.
    const partial = roster.filter((r) => String(r.mssv ?? '').toLowerCase().startsWith(code));
    if (partial.length > 0) return { kind, results: partial.slice(0, limit) };
    // Still nothing — it may have been a name with digits in it.
    return { kind: 'name', results: rankByName(roster, q, limit) };
  }

  return { kind: 'name', results: rankByName(roster, q, limit) };
}

function rankByName(roster, query, limit) {
  const scored = [];
  for (const r of roster) {
    const key = r.name_key ?? searchKey(r.name);
    const s = scoreMatch(key, query);
    if (s > 0) scored.push({ entry: r, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.entry);
}
