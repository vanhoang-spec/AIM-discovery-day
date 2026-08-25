'use client';

/**
 * Device session, roster cache, and the singleton scan queue.
 *
 * Everything the scanner needs lives in IndexedDB, so a reload — or the phone
 * killing the tab to reclaim memory — costs nothing. Nothing here is held only
 * in React state.
 */

import { ScanQueue } from '@atl/scan-queue';
import { createIdbStore, kv, requestPersistence } from '@atl/scan-queue/idb-store';

const K = {
  session: 'session',
  roster: 'roster',
  rosterVersion: 'roster_version',
  checkpoint: 'active_checkpoint',
};

let queue;

/** One queue per page, created lazily so it never runs during SSR. */
export function getQueue() {
  if (!queue) {
    queue = new ScanQueue({
      store: createIdbStore(),
      send: async (batch) => {
        const session = await getSession();
        const stats = await queue.stats();
        const res = await fetch('/api/pg/sync', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.token}`,
          },
          body: JSON.stringify({
            scans: batch,
            queue_depth: stats.unsent,
            battery_pct: await batteryPct(),
          }),
        });
        if (!res.ok) throw new Error(`sync ${res.status}`);
        const data = await res.json();
        return data.results;
      },
    });
  }
  return queue;
}

async function batteryPct() {
  try {
    const b = await navigator.getBattery?.();
    return b ? Math.round(b.level * 100) : null;
  } catch {
    return null;
  }
}

export const getSession = () => kv.get(K.session);
export const setSession = (s) => kv.set(K.session, s);
export const clearSession = () => kv.delete(K.session);

export const getActiveCheckpoint = () => kv.get(K.checkpoint);
export const setActiveCheckpoint = (cp) => kv.set(K.checkpoint, cp);

export const getRoster = async () => (await kv.get(K.roster)) ?? [];

/**
 * Pull roster changes since the last sync.
 *
 * Merging by `seq` rather than replacing means a delta covering three walk-ins
 * costs three rows, not two thousand — which is the difference between a
 * ten-minute refresh being free and being something a PG notices.
 */
export async function refreshRoster({ full = false } = {}) {
  const session = await getSession();
  if (!session) return { ok: false, reason: 'no-session' };

  const since = full ? null : await kv.get(K.rosterVersion);
  const url = '/api/pg/roster' + (since ? `?since=${encodeURIComponent(since)}` : '');

  const res = await fetch(url, { headers: { Authorization: `Bearer ${session.token}` } });
  if (!res.ok) return { ok: false, status: res.status };
  const data = await res.json();

  const current = data.full ? [] : await getRoster();
  const bySeq = new Map(current.map((r) => [r.seq, r]));
  for (const row of data.students) bySeq.set(row.seq, row);

  const merged = [...bySeq.values()];
  await kv.set(K.roster, merged);
  await kv.set(K.rosterVersion, data.version);
  return { ok: true, total: merged.length, changed: data.students.length };
}

export async function claimDevice({ claimCode, pin }) {
  // Asking for persistent storage before anything is written gives the browser
  // the best chance of granting it — and an unpersisted queue is one storage
  // squeeze away from losing scans.
  await requestPersistence();

  const res = await fetch('/api/pg/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ claim_code: claimCode, pin, app_version: 'pg-0.1.0' }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'Không nhận diện được thiết bị');

  await setSession({
    token: data.token,
    device: data.device,
    event: data.event,
    checkpoints: data.checkpoints,
    claimed_at: Date.now(),
  });
  await refreshRoster({ full: true });
  return data;
}
