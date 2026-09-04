/**
 * Which events a registration form may offer, per mode.
 *
 * This mirrors ONE server rule, and exists as a separate tested function
 * because the two drifted apart in production on 04/09/2026:
 *
 *   `0011_registration_gate` closes registration for `source = 'online'`
 *   ONLY. The walk-in desk at the gate keeps working after AIM closes online
 *   sign-ups — that asymmetry is the whole point of the gate.
 *
 * `/api/refdata` used to filter with `where is_registration_open`, so once
 * registration closed it returned `events: []`. The form's fallback was
 * `ref?.events ?? [Hà Nội, TP.HCM]`, and `??` does not fire on an empty
 * array — so the walk-in form rendered a required "Bạn tham dự tại" field
 * with zero radio buttons. Students could fill everything and never submit,
 * at the gate, on event day. The server would have accepted them.
 *
 * refdata now returns every event with its flag and the choice is made here.
 */

/** Offline fallback: refdata unreachable. No flag, so both stay selectable. */
export const FALLBACK_EVENTS = [
  { id: 1, city: 'Hà Nội' },
  { id: 2, city: 'TP.HCM' },
];

/**
 * @param {Array|null|undefined} events  rows from /api/refdata
 * @param {boolean} walkin               true for `/dang-ky?nhanh`
 */
export function choosableEvents(events, walkin) {
  const all = events?.length ? events : FALLBACK_EVENTS;
  if (walkin) return all;
  // `!== false` and not `=== true`: the fallback rows carry no flag, and a
  // student on bad 4G must still be able to submit rather than face an empty
  // form. Only an event the server explicitly reports as closed is removed.
  return all.filter((e) => e.is_registration_open !== false);
}

/**
 * Whether to replace the online form with "registration is closed".
 *
 * `refLoaded` gates it: before refdata answers we know nothing, and showing
 * the notice would make it flash on every page load.
 */
export function isOnlineClosed(events, walkin, refLoaded) {
  if (walkin || !refLoaded) return false;
  return choosableEvents(events, walkin).length === 0;
}
