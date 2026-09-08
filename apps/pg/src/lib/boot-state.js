'use client';

/**
 * Which screen the scanner may show, given what has finished loading.
 *
 * THE BUG THIS EXISTS TO PREVENT — hit on production 08/09/2026, on the one
 * path every PG takes every morning: reopen the app after the device is
 * already claimed and a checkpoint already chosen.
 *
 * The boot effect read four things in a row and set state as it went:
 *
 *     setSession(s);                       // ← render happens after this…
 *     rosterRef.current = await getRoster();
 *     keyRef.current = await importKey(…);
 *     const cp = await getActiveCheckpoint();
 *     if (cp) setCheckpoint(cp); else setPicking(true);
 *
 * React flushes a render at every `await`. In that window `session` is set,
 * `checkpoint` is still null and `picking` is still false — a combination the
 * JSX never expected, so it walked straight into `checkpoint.name` and threw
 * `Cannot read properties of null`. Next.js caught it and replaced the whole
 * screen with "Application error: a client-side exception has occurred".
 *
 * A scanner that white-screens on reopen is worse than one that is slow: the
 * PG cannot scan at all, and the fix ("clear site data") is not something a
 * PG can be walked through at a gate with a queue behind them.
 *
 * So the rule lives here, as a pure function over the three flags, and the
 * page asks it instead of guessing. Loading is the default: anything not
 * fully known yet renders nothing rather than a half-built screen.
 */

/** @returns {'loading' | 'picking' | 'scanning'} */
export function screenFor({ session, checkpoint, picking }) {
  if (!session) return 'loading';
  // Asking which checkpoint they are on is safe as soon as the session is
  // known — the list comes with it.
  if (picking) return 'picking';
  // The gap that broke production: session in, checkpoint not read yet.
  if (!checkpoint) return 'loading';
  return 'scanning';
}

/**
 * Can a badge be awarded right now? Manual lookup can reach `award()` from a
 * keystroke before `getActiveCheckpoint()` resolves; without this the queue
 * entry would be built from `checkpoint.id` on null.
 */
export function canAward({ session, checkpoint }) {
  return Boolean(session && checkpoint);
}
