/**
 * Offline scan queue — the piece the event actually rests on.
 *
 * A PG scans, sees a result in under 150 ms, and walks on. Whether the network
 * existed at that moment is not their problem and must never become the
 * student's problem either. So the queue is the source of truth on the device,
 * and the server is something it reconciles with later.
 *
 * The storage layer is injected rather than imported, for two reasons: the
 * logic below is then testable in Node without a browser or a fake IndexedDB,
 * and the same code runs against IndexedDB in the app and against a Map in the
 * tests. Anything genuinely browser-specific lives in `idb-store.js`.
 *
 * States a queued scan moves through:
 *
 *   pending  ─┬─► sending ─┬─► confirmed   server accepted it
 *             │            ├─► duplicate   server already had it (not an error)
 *             │            └─► rejected    server refused, needs a human
 *             └─► pending             (send failed; retry after backoff)
 */

export const STATE = Object.freeze({
  PENDING: 'pending',
  SENDING: 'sending',
  CONFIRMED: 'confirmed',
  DUPLICATE: 'duplicate',
  REJECTED: 'rejected',
});

/** Server statuses that mean "this is settled, stop retrying". */
const TERMINAL = Object.freeze({
  counted: STATE.CONFIRMED,
  repeat_not_counted: STATE.DUPLICATE,
  replay: STATE.DUPLICATE,
  pending_other_condition: STATE.CONFIRMED,
  rejected_unknown_student: STATE.REJECTED,
  rejected_checkpoint_closed: STATE.REJECTED,
  rejected_not_registered: STATE.REJECTED,
  rejected_device: STATE.REJECTED,
  rejected_out_of_scope: STATE.REJECTED,
});

export const MAX_BATCH = 200;

/**
 * Backoff for a failed flush: 1s, 2s, 4s, 8s, 16s, capped at 30s.
 *
 * The jitter is not decoration. Forty devices that lost signal together will
 * regain it together, and without jitter they retry in lockstep — a
 * self-inflicted thundering herd at exactly the moment the network is
 * recovering. Spreading them over ±40% removes it.
 */
export function backoffMs(attempt, random = Math.random) {
  const base = Math.min(30_000, 1000 * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = 0.6 + random() * 0.8; // 0.6x – 1.4x
  return Math.round(base * jitter);
}

/**
 * UUIDv7: time-ordered, so a queue drained after an outage replays in the
 * order the scans actually happened rather than in random order. Generated on
 * the DEVICE — that is what makes a resend a no-op instead of a second badge,
 * because the server uses it as the ledger's primary key.
 */
export function uuidv7(now = Date.now(), randomBytes) {
  const bytes = randomBytes
    ? randomBytes(16)
    : (globalThis.crypto?.getRandomValues?.(new Uint8Array(16)) ?? fallbackRandom());
  const ts = BigInt(now);
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function fallbackRandom() {
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  return b;
}

/**
 * Minimal in-memory store, used by the tests and as the reference for what
 * `idb-store.js` must implement.
 */
export function createMemoryStore() {
  const rows = new Map();
  return {
    async put(item) { rows.set(item.scan_uid, { ...item }); },
    async get(uid) { const r = rows.get(uid); return r ? { ...r } : undefined; },
    async all() { return [...rows.values()].map((r) => ({ ...r })); },
    async delete(uid) { rows.delete(uid); },
  };
}

export class ScanQueue {
  /**
   * @param {object} opts
   * @param {object} opts.store       storage adapter (memory or IndexedDB)
   * @param {Function} opts.send      async (batch) => results[]
   * @param {Function} [opts.now]     clock, injectable for tests
   * @param {Function} [opts.random]  RNG, injectable for deterministic jitter
   */
  constructor({ store, send, now = () => Date.now(), random = Math.random }) {
    this.store = store;
    this.send = send;
    this.now = now;
    this.random = random;
    this._flushing = false;
  }

  /**
   * Record a scan. Returns immediately after the local write — the caller
   * shows its result from this return value, never from a network response.
   *
   * Local duplicate suppression: if this device already holds an unsettled or
   * confirmed scan for the same student at the same checkpoint, the second tap
   * is reported as a duplicate without queueing anything. The server would
   * reject it anyway; catching it here saves a round trip and, more
   * importantly, shows the PG the amber screen instantly.
   */
  async enqueue({ student_seq, checkpoint_id, student_name, source = 'pg_scan' }) {
    const existing = (await this.store.all()).find(
      (r) => r.student_seq === student_seq && r.checkpoint_id === checkpoint_id,
    );
    if (existing) {
      return { duplicate: true, local: true, item: existing };
    }

    const item = {
      scan_uid: uuidv7(this.now()),
      student_seq,
      checkpoint_id,
      student_name: student_name ?? null,
      source,
      client_ts: new Date(this.now()).toISOString(),
      state: STATE.PENDING,
      attempts: 0,
      next_attempt_at: 0,
      server_status: null,
      badge_count: null,
      error: null,
    };
    await this.store.put(item);
    return { duplicate: false, local: true, item };
  }

  /** One item by uid — the scan screen re-reads its last scan after a flush
   *  to swap "~ chờ đồng bộ" for the server's verdict and the student's name. */
  async get(scanUid) {
    return this.store.get(scanUid);
  }

  /** Items still needing the network, oldest first. */
  async pending() {
    const all = await this.store.all();
    return all
      .filter((r) => r.state === STATE.PENDING || r.state === STATE.SENDING)
      .sort((a, b) => a.scan_uid.localeCompare(b.scan_uid));
  }

  /** Counts for the sync chip in the header. */
  async stats() {
    const all = await this.store.all();
    const count = (s) => all.filter((r) => r.state === s).length;
    return {
      total: all.length,
      pending: count(STATE.PENDING),
      sending: count(STATE.SENDING),
      confirmed: count(STATE.CONFIRMED),
      duplicate: count(STATE.DUPLICATE),
      rejected: count(STATE.REJECTED),
      unsent: count(STATE.PENDING) + count(STATE.SENDING),
    };
  }

  /**
   * Push whatever is due to the server.
   *
   * Two properties matter more than throughput here. It never runs twice
   * concurrently, because two in-flight batches carrying the same scan turn a
   * retry into a race. And a failed flush never loses an item: everything goes
   * back to `pending` with a longer backoff, so the worst case is that a scan
   * arrives late, never that it disappears.
   */
  async flush({ limit = MAX_BATCH } = {}) {
    if (this._flushing) return { skipped: 'already-flushing' };
    this._flushing = true;
    try {
      const now = this.now();
      const due = (await this.pending())
        .filter((r) => r.next_attempt_at <= now)
        .slice(0, limit);
      if (due.length === 0) return { sent: 0, results: [] };

      for (const item of due) {
        await this.store.put({ ...item, state: STATE.SENDING });
      }

      let results;
      try {
        results = await this.send(
          due.map((r) => ({
            scan_uid: r.scan_uid,
            student_seq: r.student_seq,
            checkpoint_id: r.checkpoint_id,
            client_ts: r.client_ts,
            source: r.source,
          })),
        );
      } catch (err) {
        // Network or server failure: every item goes back to pending with a
        // longer wait. Nothing is dropped.
        for (const item of due) {
          const attempts = item.attempts + 1;
          await this.store.put({
            ...item,
            state: STATE.PENDING,
            attempts,
            next_attempt_at: now + backoffMs(attempts, this.random),
            error: String(err?.message ?? err),
          });
        }
        return { sent: 0, failed: due.length, error: String(err?.message ?? err) };
      }

      const byUid = new Map((results ?? []).map((r) => [r.scan_uid, r]));
      let settled = 0;
      for (const item of due) {
        const res = byUid.get(item.scan_uid);
        if (!res) {
          // The server answered but said nothing about this item. Treat it as
          // unsent rather than assume success — assuming success is how scans
          // silently vanish.
          const attempts = item.attempts + 1;
          await this.store.put({
            ...item,
            state: STATE.PENDING,
            attempts,
            next_attempt_at: now + backoffMs(attempts, this.random),
            error: 'no result returned for this scan',
          });
          continue;
        }
        const state = TERMINAL[res.status] ?? STATE.PENDING;
        if (state === STATE.PENDING) {
          const attempts = item.attempts + 1;
          await this.store.put({
            ...item,
            state,
            attempts,
            next_attempt_at: now + backoffMs(attempts, this.random),
            server_status: res.status,
          });
          continue;
        }
        settled++;
        await this.store.put({
          ...item,
          state,
          server_status: res.status,
          // The server's count always wins. A local optimistic number is
          // advisory and is overwritten here, so a PG can never quote a stale
          // badge total from a device that has not synced.
          badge_count: res.badge_count ?? item.badge_count,
          student_name: res.student_name ?? item.student_name,
          error: null,
        });
      }
      return { sent: settled, results: results ?? [] };
    } finally {
      this._flushing = false;
    }
  }

  /** Drop settled rows so storage does not grow without bound over nine hours. */
  async prune({ keep = 500 } = {}) {
    const all = await this.store.all();
    const settled = all
      .filter((r) => r.state === STATE.CONFIRMED || r.state === STATE.DUPLICATE)
      .sort((a, b) => a.scan_uid.localeCompare(b.scan_uid));
    const excess = settled.length - keep;
    for (let i = 0; i < excess; i++) await this.store.delete(settled[i].scan_uid);
    return { pruned: Math.max(0, excess) };
  }

  /** Put a rejected item back in line — the supervisor's "try again" action. */
  async retry(scanUid) {
    const item = await this.store.get(scanUid);
    if (!item) return null;
    const next = { ...item, state: STATE.PENDING, next_attempt_at: 0, error: null };
    await this.store.put(next);
    return next;
  }
}
