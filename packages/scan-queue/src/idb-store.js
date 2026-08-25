/**
 * IndexedDB storage adapter for ScanQueue.
 *
 * Implements exactly the four methods `createMemoryStore()` provides, so the
 * queue logic never learns which one it is talking to and stays testable in
 * Node.
 *
 * Two browser realities shape this file:
 *
 *   * iOS evicts IndexedDB under storage pressure, and a PG's personal phone
 *     is often nearly full. `requestPersistence()` asks the browser not to —
 *     it is best-effort, but the ask costs nothing and the alternative is
 *     losing a queue.
 *   * The store must survive the app being backgrounded and killed. Nothing
 *     here holds state in memory beyond the open connection.
 */

const DB_NAME = 'atl_pg';
const DB_VERSION = 1;
const SCANS = 'scans';
const KV = 'kv';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SCANS)) {
        const s = db.createObjectStore(SCANS, { keyPath: 'scan_uid' });
        s.createIndex('state', 'state');
        // Used by the local duplicate check on every scan, so it must be an
        // index rather than a full scan of nine hours of rows.
        s.createIndex('student_checkpoint', ['student_seq', 'checkpoint_id']);
      }
      if (!db.objectStoreNames.contains(KV)) {
        db.createObjectStore(KV);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise;
function db() {
  if (!dbPromise) dbPromise = open();
  return dbPromise;
}

function tx(store, mode, fn) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req?.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

/** Storage adapter matching the ScanQueue contract. */
export function createIdbStore() {
  return {
    put: (item) => tx(SCANS, 'readwrite', (s) => s.put(item)),
    get: (uid) => tx(SCANS, 'readonly', (s) => s.get(uid)),
    all: () => tx(SCANS, 'readonly', (s) => s.getAll()).then((r) => r ?? []),
    delete: (uid) => tx(SCANS, 'readwrite', (s) => s.delete(uid)),
  };
}

/** Small key/value area for the device token, roster and config. */
export const kv = {
  get: (key) => tx(KV, 'readonly', (s) => s.get(key)),
  set: (key, value) => tx(KV, 'readwrite', (s) => s.put(value, key)),
  delete: (key) => tx(KV, 'readwrite', (s) => s.delete(key)),
};

/**
 * Ask the browser to keep this origin's storage. Returns whether persistence
 * is granted; the caller shows a warning at the briefing if it is not, because
 * that device is one storage-pressure event away from losing queued scans.
 */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
    /* not supported — nothing to do but carry on */
  }
  return false;
}
