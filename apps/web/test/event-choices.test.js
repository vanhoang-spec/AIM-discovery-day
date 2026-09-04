/**
 * The client half of the registration gate.
 *
 * The server half is already covered — supabase/test/ops-admin.test.js:
 * "closed stops ONLINE and only online — walk-in keeps working". These tests
 * exist because the CLIENT disagreed with it in production on 04/09/2026 and
 * nothing caught it: `/api/refdata` filtered closed events away, so the
 * walk-in form rendered a required event field with zero options.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  choosableEvents,
  isOnlineClosed,
  FALLBACK_EVENTS,
} from '../src/lib/event-choices.js';

const OPEN = { id: 1, city: 'Hà Nội', is_registration_open: true };
const SHUT = { id: 2, city: 'TP.HCM', is_registration_open: false };

describe('choosableEvents', () => {
  test('online mode drops events the server has closed', () => {
    assert.deepEqual(choosableEvents([OPEN, SHUT], false), [OPEN]);
  });

  test('walk-in keeps closed events — the gate desk is exempt', () => {
    // The regression. Registration closed at 08:00 on event day must not
    // take the gate desk down with it.
    assert.deepEqual(choosableEvents([SHUT], true), [SHUT]);
    assert.equal(choosableEvents([OPEN, SHUT], true).length, 2);
  });

  test('everything closed: online has nothing, walk-in has everything', () => {
    assert.equal(choosableEvents([SHUT, { ...SHUT, id: 1 }], false).length, 0);
    assert.equal(choosableEvents([SHUT, { ...SHUT, id: 1 }], true).length, 2);
  });

  test('refdata unreachable falls back, in BOTH modes', () => {
    // The old bug in one line: `[] ?? fallback` is `[]`, not the fallback.
    for (const empty of [null, undefined, []]) {
      assert.deepEqual(choosableEvents(empty, false), FALLBACK_EVENTS);
      assert.deepEqual(choosableEvents(empty, true), FALLBACK_EVENTS);
    }
  });

  test('fallback rows carry no flag and stay selectable', () => {
    assert.ok(FALLBACK_EVENTS.every((e) => e.is_registration_open === undefined));
    assert.equal(choosableEvents(FALLBACK_EVENTS, false).length, 2);
  });
});

describe('isOnlineClosed', () => {
  test('true only when online mode has no open event left', () => {
    assert.equal(isOnlineClosed([SHUT], false, true), true);
    assert.equal(isOnlineClosed([OPEN, SHUT], false, true), false);
  });

  test('never true in walk-in mode', () => {
    assert.equal(isOnlineClosed([SHUT], true, true), false);
  });

  test('silent until refdata answers — no flash on page load', () => {
    // `ref` is null on first paint; claiming "closed" then would show the
    // notice to every visitor for a moment on a perfectly open event.
    assert.equal(isOnlineClosed(undefined, false, false), false);
  });

  test('a failed refdata fetch does not claim registration is closed', () => {
    // refLoaded true, events empty → the fallback applies, so there IS
    // something to pick and the form must render.
    assert.equal(isOnlineClosed([], false, true), false);
  });
});
