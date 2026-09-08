/**
 * The scanner's boot states — written from a production crash, 08/09/2026.
 *
 * A PG reopened the scanner on a device that was already claimed and already
 * assigned to a checkpoint, and got a blank screen reading "Application
 * error: a client-side exception has occurred". The cause was a render that
 * happened between two awaits, with `session` loaded and `checkpoint` not.
 *
 * These cases pin the whole state space, so the combination that broke it can
 * never be rendered as a scan screen again.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { screenFor, canAward } from '../src/lib/boot-state.js';

const SESSION = { token: 't', device: { label: 'PG-01', staff_name: 'An' }, checkpoints: [] };
const CHECKPOINT = { id: 7, name: 'Booth A', zone_id: 2 };

describe('screenFor', () => {
  test('THE 08/09 CRASH: session loaded, checkpoint not yet — must not be the scan screen', () => {
    // Exactly the mid-boot state: setSession has run, getActiveCheckpoint has
    // not resolved, so `picking` is still its initial false. Rendering
    // 'scanning' here reads checkpoint.name on null and white-screens the app.
    assert.equal(screenFor({ session: SESSION, checkpoint: null, picking: false }), 'loading');
  });

  test('nothing loaded yet', () => {
    assert.equal(screenFor({ session: null, checkpoint: null, picking: false }), 'loading');
  });

  test('a device with no checkpoint chosen asks which one', () => {
    assert.equal(screenFor({ session: SESSION, checkpoint: null, picking: true }), 'picking');
  });

  test('fully loaded — scan', () => {
    assert.equal(screenFor({ session: SESSION, checkpoint: CHECKPOINT, picking: false }), 'scanning');
  });

  test('changing checkpoint mid-shift shows the picker, not the scanner', () => {
    // The PG taps the checkpoint bar while already scanning.
    assert.equal(screenFor({ session: SESSION, checkpoint: CHECKPOINT, picking: true }), 'picking');
  });

  test('no session always wins, whatever else is set', () => {
    // Session gone (revoked, cleared) — the page redirects to claim; it must
    // never paint a scanner from leftover state.
    assert.equal(screenFor({ session: null, checkpoint: CHECKPOINT, picking: false }), 'loading');
    assert.equal(screenFor({ session: null, checkpoint: CHECKPOINT, picking: true }), 'loading');
  });

  test('every combination returns a known screen and never throws', () => {
    for (const session of [null, SESSION]) {
      for (const checkpoint of [null, CHECKPOINT]) {
        for (const picking of [false, true]) {
          const s = screenFor({ session, checkpoint, picking });
          assert.ok(['loading', 'picking', 'scanning'].includes(s), `${s} không hợp lệ`);
          // The invariant that matters: 'scanning' implies both are present,
          // so the JSX may read checkpoint.name and session.device freely.
          if (s === 'scanning') { assert.ok(session); assert.ok(checkpoint); }
        }
      }
    }
  });
});

describe('canAward', () => {
  test('manual lookup cannot queue a badge before the checkpoint is known', () => {
    // tra-cuu builds the queue item from checkpoint.id; a keystroke can reach
    // award() before getActiveCheckpoint() resolves.
    assert.equal(canAward({ session: SESSION, checkpoint: null }), false);
  });

  test('allowed once both are loaded', () => {
    assert.equal(canAward({ session: SESSION, checkpoint: CHECKPOINT }), true);
  });

  test('never without a session', () => {
    assert.equal(canAward({ session: null, checkpoint: CHECKPOINT }), false);
  });
});
