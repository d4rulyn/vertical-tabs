/**
 * Thumbnail storage: IndexedDB `vertical-tabs`, version 1, object store
 * `thumbs` (spec.md §4.5 / §5.1 / §7.8).
 *
 * Blobs live in IndexedDB rather than `storage.local` because the latter caps
 * at 10 MB and cannot hold a Blob; `unlimitedStorage` lifts the IndexedDB quota
 * and exempts the store from eviction. The database is shared between the
 * service worker and every side-panel document (same origin).
 *
 * Record shape (spec.md §5.1):
 * ```
 * { urlKey, url, title, capturedAt, lastUsedAt, width, height, bytes,
 *   blob, avgColor: [r,g,b], uniform, tabId, windowId }
 * ```
 *
 * Read paths never reject: a failure is logged and reported as "no record", so
 * a corrupted or blocked database degrades to "no previews" instead of breaking
 * the panel. Write paths reject so the caller can count the failure.
 */

import {
  DB_NAME,
  DB_VERSION,
  THUMB_STORE,
  IDX_LAST_USED,
  IDX_CAPTURED,
  PRUNE,
  TOUCH_FRESH_MS,
} from './constants.js';
import * as log from './log.js';

// The freshness window of `touch()` is defined beside PRUNE in constants.js, where the reason for its value is
// written. It is re-exported so that whoever already reads the store's names keeps reading this one from it.
export { TOUCH_FRESH_MS };

/** @type {Promise<IDBDatabase>|null} */
let dbPromise = null;

/**
 * Wrap an `IDBRequest` in a promise.
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function fromRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

/**
 * Resolve when the transaction commits, reject when it aborts or errors.
 * @param {IDBTransaction} tx
 * @returns {Promise<void>}
 */
function fromTransaction(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'));
  });
}

/**
 * Open (and cache) the database connection, creating the schema on first use.
 * A `versionchange` from another context closes our handle so the upgrade can
 * proceed; the next call reopens.
 * @returns {Promise<IDBDatabase>}
 */
export function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this context'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      /** @type {IDBObjectStore} */
      let store;
      if (db.objectStoreNames.contains(THUMB_STORE)) {
        store = /** @type {IDBTransaction} */ (request.transaction).objectStore(THUMB_STORE);
      } else {
        store = db.createObjectStore(THUMB_STORE, { keyPath: 'urlKey' });
      }
      if (!store.indexNames.contains(IDX_LAST_USED)) store.createIndex(IDX_LAST_USED, 'lastUsedAt');
      if (!store.indexNames.contains(IDX_CAPTURED)) store.createIndex(IDX_CAPTURED, 'capturedAt');
    };

    request.onblocked = () => log.warn('thumb-store: open blocked by another connection');

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        try {
          db.close();
        } catch {
          /* already closing */
        }
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      dbPromise = null;
      reject(request.error || new Error('Could not open the thumbnail database'));
    };
  });

  // A failed open must not be cached forever.
  dbPromise.catch(() => {
    dbPromise = null;
  });

  return dbPromise;
}

/**
 * Close the cached connection (used by tests and by `pagehide` clean-up).
 * @returns {Promise<void>}
 */
export async function closeDb() {
  const pending = dbPromise;
  dbPromise = null;
  if (!pending) return;
  try {
    (await pending).close();
  } catch {
    /* nothing to close */
  }
}

/**
 * @param {IDBTransactionMode} mode
 * @returns {Promise<{tx: IDBTransaction, store: IDBObjectStore}>}
 */
async function withStore(mode) {
  const db = await openDb();
  const tx = db.transaction(THUMB_STORE, mode);
  return { tx, store: tx.objectStore(THUMB_STORE) };
}

/**
 * De-duplicate and drop `null`/empty keys — `urlKey()` returns `null` for
 * uncommitted navigations and such a key must never reach storage
 * (spec-addendum A4).
 * @param {unknown} keys
 * @returns {string[]}
 */
function cleanKeys(keys) {
  if (!Array.isArray(keys)) return [];
  const out = [];
  const seen = new Set();
  for (const key of keys) {
    if (typeof key !== 'string' || key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Insert or replace one thumbnail record.
 * @param {object} record see the module header for the shape
 * @returns {Promise<void>} rejects when the write fails
 */
export async function putThumb(record) {
  if (!record || typeof record !== 'object') {
    throw new TypeError('putThumb: record must be an object');
  }
  if (typeof record.urlKey !== 'string' || record.urlKey === '') {
    throw new TypeError('putThumb: record.urlKey must be a non-empty string');
  }
  const { tx, store } = await withStore('readwrite');
  store.put(record);
  await fromTransaction(tx);
}

/**
 * @param {string|null} urlKey
 * @returns {Promise<object|null>} never rejects
 */
export async function getThumb(urlKey) {
  if (typeof urlKey !== 'string' || urlKey === '') return null;
  try {
    const { tx, store } = await withStore('readonly');
    const [record] = await Promise.all([fromRequest(store.get(urlKey)), fromTransaction(tx)]);
    return record ?? null;
  } catch (e) {
    log.warn('getThumb', urlKey, e);
    return null;
  }
}

/**
 * Batch read in a single read-only transaction — used once at panel bootstrap
 * for every visible card (spec.md §8.1 step 5).
 * @param {string[]} urlKeys
 * @returns {Promise<Map<string, object>>} never rejects; missing keys are absent
 */
export async function getThumbs(urlKeys) {
  const keys = cleanKeys(urlKeys);
  /** @type {Map<string, object>} */
  const out = new Map();
  if (keys.length === 0) return out;

  try {
    const { tx, store } = await withStore('readonly');
    const reads = keys.map((key) =>
      fromRequest(store.get(key)).then((record) => {
        if (record) out.set(key, record);
      }),
    );
    await Promise.all([...reads, fromTransaction(tx)]);
  } catch (e) {
    log.warn('getThumbs', e);
  }
  return out;
}

/**
 * Refresh `lastUsedAt` for the keys currently on screen so `prune()` keeps
 * them. One read-write transaction for the whole batch.
 *
 * Rewriting a record rewrites its screenshot, so a record whose stamp is a number within
 * `TOUCH_FRESH_MS` of `now` (on either side) is read and left as it is. A stamp of any other kind
 * (missing, null, a string, a BigInt, a Date, NaN, an infinity) is replaced by `now`, and is never
 * used in arithmetic. A key with no record costs nothing.
 *
 * Nothing calls this on a timer. The bookmark column touches the rows it draws when it attaches and
 * after each paint chunk, and the row under the pointer on hover; the tab cards touch at panel boot and
 * on `#tablist` scroll. Each caller keeps 30 s between two touches of its own, so 30 s is a floor, not a
 * period.
 *
 * Why it is worth the condition: rewriting one record per row at every touch was found to stall the
 * store for seconds to minutes. Probe 98a part C found the stall rate to follow the number of blobs
 * rewritten (transactions of 16 rows stalled as often, per blob, as one of 1000); part D, in which touches
 * of records without a blob never stalled (0 of 24 against 4 of 24), is suggestive only (Fisher p = 0.055).
 * Probe 98b (Probe 18) measured the rate per rewrite again. None of that is a measurement of the hover.
 * @param {string[]} urlKeys
 * @param {number} [now]
 * @returns {Promise<void>} never rejects
 */
export async function touch(urlKeys, now = Date.now()) {
  const keys = cleanKeys(urlKeys);
  if (keys.length === 0) return;

  try {
    const { tx, store } = await withStore('readwrite');
    for (const key of keys) {
      const request = store.get(key);
      request.onsuccess = () => {
        const record = request.result;
        // `typeof` comes first: a stored stamp of another kind is written, never subtracted (a BigInt
        // would throw in this handler and abort the whole batch). NaN and the infinities fail the `<`.
        if (record && !(typeof record.lastUsedAt === 'number' && Math.abs(now - record.lastUsedAt) < TOUCH_FRESH_MS)) {
          record.lastUsedAt = now;
          store.put(record);
        }
      };
    }
    await fromTransaction(tx);
  } catch (e) {
    log.warn('touch', e);
  }
}

/**
 * @param {string[]} urlKeys
 * @returns {Promise<number>} how many keys were requested for deletion
 */
export async function deleteThumbs(urlKeys) {
  const keys = cleanKeys(urlKeys);
  if (keys.length === 0) return 0;

  try {
    const { tx, store } = await withStore('readwrite');
    for (const key of keys) store.delete(key);
    await fromTransaction(tx);
    return keys.length;
  } catch (e) {
    log.warn('deleteThumbs', e);
    return 0;
  }
}

/**
 * Read every record's bookkeeping fields, oldest `lastUsedAt` first, without
 * holding on to the blobs.
 * @returns {Promise<Array<{urlKey: string, lastUsedAt: number, bytes: number}>>}
 */
async function readIndexMeta() {
  /** @type {Array<{urlKey: string, lastUsedAt: number, bytes: number}>} */
  const rows = [];
  const { tx, store } = await withStore('readonly');
  const request = store.index(IDX_LAST_USED).openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const value = cursor.value || {};
    rows.push({
      urlKey: String(value.urlKey ?? cursor.primaryKey),
      lastUsedAt: Number(value.lastUsedAt) || 0,
      bytes: Number(value.bytes) || Number(value.blob?.size) || 0,
    });
    cursor.continue();
  };
  await fromTransaction(tx);
  return rows;
}

/**
 * Cache size for the settings drawer (`settingsCacheStats`) and for tests.
 * @returns {Promise<{count: number, bytes: number}>} never rejects
 */
export async function stats() {
  try {
    const rows = await readIndexMeta();
    let bytes = 0;
    for (const row of rows) bytes += row.bytes;
    return { count: rows.length, bytes };
  } catch (e) {
    log.warn('stats', e);
    return { count: 0, bytes: 0 };
  }
}

/**
 * Bounded-size cache maintenance (spec.md §7.8). Runs **only** from the
 * maintenance alarm — never at `onStartup`, where it would race Chrome's
 * session restore and delete previews of tabs that are about to reappear.
 *
 * Order: (1) unprotected entries older than `maxAgeMs`; (2) while over
 * `maxEntries` or `maxBytes`, the oldest unprotected entries; (3) only if still
 * over, the oldest protected ones.
 *
 * @param {object} [options]
 * @param {number} [options.maxEntries]
 * @param {number} [options.maxBytes]
 * @param {number} [options.maxAgeMs]
 * @param {Iterable<string>} [options.protectedKeys] url keys of currently open tabs
 * @param {number} [options.now]
 * @returns {Promise<{deleted: number, count: number, bytes: number}>} never rejects
 */
export async function prune(options = {}) {
  const {
    maxEntries = PRUNE.maxEntries,
    maxBytes = PRUNE.maxBytes,
    maxAgeMs = PRUNE.maxAgeMs,
    protectedKeys = [],
    now = Date.now(),
  } = options || {};

  try {
    const rows = await readIndexMeta(); // ascending lastUsedAt = oldest first
    const guarded = new Set(cleanKeys([...protectedKeys]));

    /** @type {Set<string>} */
    const doomed = new Set();
    let count = rows.length;
    let bytes = 0;
    for (const row of rows) bytes += row.bytes;

    const drop = (row) => {
      if (doomed.has(row.urlKey)) return;
      doomed.add(row.urlKey);
      count -= 1;
      bytes -= row.bytes;
    };

    // (1) age
    if (Number.isFinite(maxAgeMs) && maxAgeMs > 0) {
      for (const row of rows) {
        if (guarded.has(row.urlKey)) continue;
        if (now - row.lastUsedAt > maxAgeMs) drop(row);
      }
    }

    // (2) size / count, unprotected
    for (const row of rows) {
      if (count <= maxEntries && bytes <= maxBytes) break;
      if (doomed.has(row.urlKey) || guarded.has(row.urlKey)) continue;
      drop(row);
    }

    // (3) size / count, protected as a last resort
    for (const row of rows) {
      if (count <= maxEntries && bytes <= maxBytes) break;
      if (doomed.has(row.urlKey)) continue;
      drop(row);
    }

    if (doomed.size) await deleteThumbs([...doomed]);
    return { deleted: doomed.size, count, bytes };
  } catch (e) {
    log.warn('prune', e);
    return { deleted: 0, count: 0, bytes: 0 };
  }
}

/**
 * Delete every stored preview whose URL host satisfies `matches`.
 *
 * Backs the promise the settings drawer makes: adding a host to "Never capture
 * previews on these sites" has to remove what was already captured for it, not
 * merely stop capturing from now on. Keys are `scheme//host[:port]/path`
 * (see `url-key.js`), so the host is read back off the key rather than reparsed.
 *
 * @param {(host: string) => boolean} matches
 * @returns {Promise<string[]>} the keys deleted; never rejects
 */
export async function deleteThumbsByHost(matches) {
  if (typeof matches !== 'function') return [];
  try {
    const rows = await readIndexMeta();
    const doomed = [];
    for (const row of rows) {
      const host = hostOfKey(row.urlKey);
      if (host && matches(host)) doomed.push(row.urlKey);
    }
    if (doomed.length) await deleteThumbs(doomed);
    return doomed;
  } catch (e) {
    log.warn('deleteThumbsByHost', e);
    return [];
  }
}

/**
 * The host inside a `urlKey`, or '' for an opaque key that has no authority.
 * @param {string} key
 * @returns {string}
 */
function hostOfKey(key) {
  if (typeof key !== 'string') return '';
  const marker = key.indexOf('//');
  if (marker < 0) return '';
  const rest = key.slice(marker + 2);
  const end = rest.search(/[/?#]/);
  const authority = end < 0 ? rest : rest.slice(0, end);
  const colon = authority.lastIndexOf(':');
  return (colon > 0 ? authority.slice(0, colon) : authority).toLowerCase();
}

/**
 * Delete every stored preview — "Clear preview cache" and the session-only mode
 * (`persistThumbnails === false`) at `runtime.onStartup`.
 * @returns {Promise<void>} never rejects
 */
export async function clearAll() {
  try {
    const { tx, store } = await withStore('readwrite');
    store.clear();
    await fromTransaction(tx);
  } catch (e) {
    log.warn('clearAll', e);
  }
}
