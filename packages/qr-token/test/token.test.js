import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mintToken,
  verifyToken,
  parseTokenUnverified,
  importKey,
  encodeBase32,
  decodeBase32,
  generateLookupCode,
  formatLookupCode,
  normaliseLookupCode,
  TOKEN_LENGTH,
  PAYLOAD_BYTES,
} from '../src/index.js';

const KEY = 'atl2026-test-key-do-not-use-in-production';
const OTHER_KEY = 'atl2026-different-key-also-for-tests-only';

describe('Base32 (Crockford)', () => {
  test('round-trips arbitrary bytes', () => {
    for (const len of [1, 5, 6, 16, 31]) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) & 0xff);
      assert.deepEqual(decodeBase32(encodeBase32(bytes), len), bytes);
    }
  });

  test('16 bytes encode to exactly 26 characters', () => {
    assert.equal(encodeBase32(new Uint8Array(PAYLOAD_BYTES)).length, TOKEN_LENGTH);
    assert.equal(encodeBase32(new Uint8Array(PAYLOAD_BYTES).fill(0xff)).length, TOKEN_LENGTH);
  });

  test('uses no ambiguous letters (I, L, O, U)', () => {
    const all = encodeBase32(Uint8Array.from({ length: 32 }, (_, i) => i * 8));
    for (const ch of 'ILOU') assert.ok(!all.includes(ch), `alphabet must not contain ${ch}`);
  });

  test('decoding tolerates lowercase, hyphens and O/I/L confusion', () => {
    const bytes = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x01]);
    const canonical = encodeBase32(bytes);
    assert.deepEqual(decodeBase32(canonical.toLowerCase(), 5), bytes);
    assert.deepEqual(decodeBase32(canonical.split('').join('-'), 5), bytes);
    // A human typing O for 0 and I for 1 still resolves.
    assert.deepEqual(decodeBase32('O'.repeat(8), 5), decodeBase32('0'.repeat(8), 5));
    assert.deepEqual(decodeBase32('I'.repeat(8), 5), decodeBase32('1'.repeat(8), 5));
  });

  test('rejects characters outside the alphabet', () => {
    assert.throws(() => decodeBase32('ABC$EF', 3), /Invalid Base32 character/);
  });
});

describe('token mint & verify', () => {
  test('round-trips and preserves all fields', async () => {
    const token = await mintToken({ eventInstance: 2, studentSeq: 1337 }, KEY);
    assert.equal(token.length, TOKEN_LENGTH);
    assert.match(token, /^[0-9A-HJKMNP-TV-Z]{26}$/);

    const result = await verifyToken(token, KEY);
    assert.equal(result.valid, true);
    assert.equal(result.eventInstance, 2);
    assert.equal(result.studentSeq, 1337);
  });

  test('is deterministic — the same input always yields the same token', async () => {
    const a = await mintToken({ eventInstance: 1, studentSeq: 42 }, KEY);
    const b = await mintToken({ eventInstance: 1, studentSeq: 42 }, KEY);
    assert.equal(a, b);
  });

  test('handles the boundary sequence numbers', async () => {
    for (const studentSeq of [0, 1, 0xffff, 0x7fffffff, 0xffffffff]) {
      const token = await mintToken({ eventInstance: 3, studentSeq }, KEY);
      const result = await verifyToken(token, KEY);
      assert.equal(result.valid, true, `seq ${studentSeq} should verify`);
      assert.equal(result.studentSeq, studentSeq, `seq ${studentSeq} should round-trip`);
    }
  });

  test('accepts a pre-imported CryptoKey (the scan-path fast case)', async () => {
    const key = await importKey(KEY);
    const token = await mintToken({ eventInstance: 1, studentSeq: 99 }, key);
    assert.equal((await verifyToken(token, key)).valid, true);
  });

  test('distinct students and distinct events produce distinct tokens', async () => {
    const seen = new Set();
    for (const eventInstance of [1, 2, 3]) {
      for (let studentSeq = 0; studentSeq < 50; studentSeq++) {
        seen.add(await mintToken({ eventInstance, studentSeq }, KEY));
      }
    }
    assert.equal(seen.size, 150);
  });

  test('rejects out-of-range field values', async () => {
    await assert.rejects(() => mintToken({ eventInstance: 256, studentSeq: 1 }, KEY), RangeError);
    await assert.rejects(() => mintToken({ eventInstance: 1, studentSeq: -1 }, KEY), RangeError);
    await assert.rejects(
      () => mintToken({ eventInstance: 1, studentSeq: 2 ** 32 }, KEY),
      RangeError,
    );
  });

  test('refuses a secret that is too short to be worth signing with', async () => {
    await assert.rejects(() => importKey('short'), /at least 16 bytes/);
  });
});

describe('token rejection paths', () => {
  test('a forged signature is rejected', async () => {
    const token = await mintToken({ eventInstance: 1, studentSeq: 500 }, KEY);
    // Mutate inside the tag. Deliberately not the final character: it carries
    // only 3 significant bits, so changing it can land on the canonical-form
    // check instead and report 'malformed' — a different rejection path.
    const i = 20;
    const flipped = token.slice(0, i) + (token[i] === 'Z' ? 'Y' : 'Z') + token.slice(i + 1);
    const result = await verifyToken(flipped, KEY);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'bad_signature');
  });

  test('a non-canonical encoding of a real token is refused', async () => {
    // The last character has 2 unused low bits. Setting them must not yield a
    // second string that resolves to the same student.
    const token = await mintToken({ eventInstance: 1, studentSeq: 500 }, KEY);
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const lastIndex = alphabet.indexOf(token.at(-1));
    const smuggled = token.slice(0, -1) + alphabet[lastIndex | 0b11];
    assert.notEqual(smuggled, token);
    const result = await verifyToken(smuggled, KEY);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'malformed');
  });

  test('a token minted with another key is rejected', async () => {
    const token = await mintToken({ eventInstance: 1, studentSeq: 500 }, OTHER_KEY);
    const result = await verifyToken(token, KEY);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'bad_signature');
  });

  test('every single-character mutation is caught', async () => {
    const token = await mintToken({ eventInstance: 1, studentSeq: 777 }, KEY);
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let checked = 0;
    for (let i = 0; i < token.length; i++) {
      for (const ch of alphabet) {
        if (ch === token[i]) continue;
        const mutated = token.slice(0, i) + ch + token.slice(i + 1);
        const result = await verifyToken(mutated, KEY);
        assert.equal(result.valid, false, `mutation at ${i} -> ${ch} must not verify`);
        checked++;
      }
    }
    assert.equal(checked, token.length * 31);
  });

  test('garbage input reports malformed rather than throwing', async () => {
    for (const bad of ['', 'hello', '!!!', 'ABC', 'A'.repeat(40)]) {
      const result = await verifyToken(bad, KEY);
      assert.equal(result.valid, false);
      assert.ok(
        ['malformed', 'unsupported_version', 'bad_signature'].includes(result.reason),
        `unexpected reason ${result.reason} for ${JSON.stringify(bad)}`,
      );
    }
  });

  test('a token for another venue is refused when the event is pinned', async () => {
    const hanoi = await mintToken({ eventInstance: 1, studentSeq: 10 }, KEY);
    const pinned = await verifyToken(hanoi, KEY, { expectedEventInstance: 2 });
    assert.equal(pinned.valid, false);
    assert.equal(pinned.reason, 'wrong_event');
    assert.equal(pinned.eventInstance, 1);
    // Without pinning, the same token is fine.
    assert.equal((await verifyToken(hanoi, KEY)).valid, true);
  });

  test('an unsupported version is reported distinctly, not as a bad signature', async () => {
    const token = await mintToken({ version: 0x02, eventInstance: 1, studentSeq: 5 }, KEY);
    const result = await verifyToken(token, KEY);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'unsupported_version');
    assert.equal(result.version, 2);
  });
});

describe('parseTokenUnverified', () => {
  test('reads the routing fields without a key', async () => {
    const token = await mintToken({ eventInstance: 3, studentSeq: 123456 }, KEY);
    const parsed = parseTokenUnverified(token);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.eventInstance, 3);
    assert.equal(parsed.studentSeq, 123456);
    assert.equal(parsed.tag.length, 10);
  });

  test('will happily parse a forgery — it is not an authorisation check', async () => {
    const token = await mintToken({ eventInstance: 1, studentSeq: 1 }, OTHER_KEY);
    assert.equal(parseTokenUnverified(token).studentSeq, 1);
    assert.equal((await verifyToken(token, KEY)).valid, false);
  });
});

describe('lookup code', () => {
  test('is 6 characters from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      assert.match(generateLookupCode(), /^[0-9A-HJKMNP-TV-Z]{6}$/);
    }
  });

  test('formats as three-three for printing', () => {
    assert.equal(formatLookupCode('K7M3QX'), 'K7M-3QX');
    assert.equal(formatLookupCode('k7m-3qx'), 'K7M-3QX');
  });

  test('normalises what a tired PG actually types', () => {
    assert.equal(normaliseLookupCode('K7M-3QX'), 'K7M3QX');
    assert.equal(normaliseLookupCode(' k7m 3qx '), 'K7M3QX');
    // O read as zero, I and L read as one.
    assert.equal(normaliseLookupCode('OIL234'), '011234');
  });

  test('rejects wrong lengths and stray characters instead of querying garbage', () => {
    for (const bad of ['', 'ABC', 'ABCDEFG', 'ABC$EF', null, undefined]) {
      assert.equal(normaliseLookupCode(bad), null, `${JSON.stringify(bad)} should not normalise`);
    }
  });

  test('collides rarely enough for a 2,000-student event', () => {
    const codes = new Set();
    for (let i = 0; i < 5000; i++) codes.add(generateLookupCode());
    // Birthday bound over a 1.07e9 space predicts ~0.01 collisions at n=5000;
    // allow a couple so the suite is not flaky, but catch a broken generator.
    assert.ok(codes.size >= 4995, `expected near-unique codes, got ${codes.size}/5000`);
  });
});
