/**
 * background/unread.js — "opened in the background and not looked at yet" tracking.
 *
 * Addendum A13: the service worker owns this state so that tabs opened while the panel
 * is closed still show a dot when the panel is opened later. The panel is read-only for
 * unread state; it renders `storage.session.unreadTabs[windowId]` and subscribes to
 * chrome.storage.session.onChanged.
 *
 * Shape: `{ [windowId]: number[] }` (insertion order = age; capped per window).
 * storage.session is RAM-only and cleared on browser restart, so tab ids never go stale.
 * The mirror is a whole-key replace, so every mutation is sequenced behind hydrate() —
 * see `opChain` below; on MV3 the first event of a worker generation is the normal case.
 */

import * as C from '../common/constants.js';
import * as logMod from '../common/log.js';

const log = {
  warn: typeof logMod.warn === 'function' ? logMod.warn : (...a) => console.warn('[vt]', ...a),
};

const SESSION_KEY = 'unreadTabs';
const MAX_PER_WINDOW = Number.isFinite(C.MAX_UNREAD_PER_WINDOW) ? C.MAX_UNREAD_PER_WINDOW : 200;
const WRITE_DEBOUNCE_MS = 50;

/**
 * How long a removal stays available to a following move(). Chrome delivers
 * tabs.onDetached BEFORE tabs.onAttached (measured on Chromium 151), and A13 wires
 * onDetached to remove() — so by the time move() runs the id has already been spliced
 * out and it could never see the flag it is supposed to carry over. remove() leaves a
 * note behind and move() consumes it; the two run back to back in the same mutation
 * queue, microseconds apart, so this bound only has to exclude unrelated removals
 * (above all the one tabs.onActivated performs when the user simply reads a tab).
 */
const DETACH_HANDOFF_MS = 250;

/** @type {Map<number, number[]>} windowId → tabIds, oldest first */
const byWindow = new Map();
let hydratePromise = null;
let writeTimer = null;
/** @type {Map<number, number>} tabId → ms at which remove() dropped an unread flag */
const recentlyRemoved = new Map();

/**
 * The tail of the mutation queue. MV3 restarts the worker for every event, so the FIRST
 * add/remove/move/forgetWindow of a worker generation normally runs while `byWindow` is
 * still empty. persistSoon() writes toPlain(), a whole-key replace, so mutating there
 * destroys the stored map: add() persisted only the tab that woke the worker (measured:
 * {W:[t1,t2]} → {W:[t3]}, both dots vanishing from an open panel), while remove() found
 * nothing on the empty map and never persisted, so a tab the user had just read kept its
 * dot for the rest of the browser session. Every mutation therefore runs behind
 * hydrate() and behind the mutation before it.
 */
let opChain = null;

/** Queues `fn` after hydration and after every mutation already queued. */
function runQueued(fn) {
  const next = (opChain ?? hydrate()).then(fn).catch((e) => log.warn('unread: update failed', e));
  opChain = next;
  return next;
}

export function hydrate() {
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    try {
      const got = await chrome.storage.session.get(SESSION_KEY);
      const saved = got?.[SESSION_KEY];
      if (saved && typeof saved === 'object') {
        for (const [windowId, ids] of Object.entries(saved)) {
          const wid = Number(windowId);
          if (!Number.isInteger(wid) || !Array.isArray(ids)) continue;
          // Merge by addition (the diagnostics.js pattern): the mutation queue already
          // guarantees `byWindow` is empty here, so this only matters if a future caller
          // ever writes without queueing — it must not silently lose that tab.
          const merged = [];
          for (const id of ids) if (Number.isInteger(id) && !merged.includes(id)) merged.push(id);
          for (const id of byWindow.get(wid) ?? []) if (!merged.includes(id)) merged.push(id);
          byWindow.set(wid, merged.slice(-MAX_PER_WINDOW));
        }
      }
    } catch {
      /* ignore */
    }
  })().catch(() => {});
  return hydratePromise;
}

function toPlain() {
  const out = {};
  for (const [windowId, ids] of byWindow) if (ids.length) out[windowId] = [...ids];
  return out;
}

function persistSoon() {
  if (writeTimer != null) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    chrome.storage.session.set({ [SESSION_KEY]: toPlain() }).catch((e) => log.warn('unread: persist failed', e));
  }, WRITE_DEBOUNCE_MS);
}

/** Records that `tabId` lost its unread flag just now, for a move() that follows. */
function noteRemoved(tabId, at) {
  for (const [id, when] of recentlyRemoved) if (at - when > DETACH_HANDOFF_MS) recentlyRemoved.delete(id);
  recentlyRemoved.set(tabId, at);
}

/** Adds `tabId` to `windowId`. Callers are already inside the mutation queue. */
function addNow(windowId, tabId) {
  const ids = byWindow.get(windowId) ?? [];
  if (ids.includes(tabId)) return;
  ids.push(tabId);
  while (ids.length > MAX_PER_WINDOW) ids.shift();
  byWindow.set(windowId, ids);
  persistSoon();
}

/** Marks a tab as unread (created in the background). */
export function add(windowId, tabId) {
  if (!Number.isInteger(windowId) || !Number.isInteger(tabId)) return Promise.resolve();
  return runQueued(() => {
    recentlyRemoved.delete(tabId);
    addNow(windowId, tabId);
  });
}

/**
 * Clears the unread flag of a tab. `windowId` may be null/undefined (e.g. tabs.onRemoved
 * of a window that is closing) in which case every window is searched.
 */
export function remove(windowId, tabId) {
  if (!Number.isInteger(tabId)) return Promise.resolve();
  return runQueued(() => {
    let changed = false;
    const scan = Number.isInteger(windowId) && byWindow.has(windowId) ? [windowId] : [...byWindow.keys()];
    for (const wid of scan) {
      const ids = byWindow.get(wid);
      if (!ids) continue;
      const i = ids.indexOf(tabId);
      if (i < 0) continue;
      ids.splice(i, 1);
      if (!ids.length) byWindow.delete(wid);
      changed = true;
    }
    if (!changed) return;
    noteRemoved(tabId, Date.now()); // tabs.onDetached → a move() may be about to claim it
    persistSoon();
  });
}

/** A tab moved to another window (tabs.onAttached); keeps the unread flag if it had one. */
export function move(tabId, newWindowId) {
  if (!Number.isInteger(tabId) || !Number.isInteger(newWindowId)) return Promise.resolve();
  return runQueued(() => {
    let wasUnread = false;
    for (const [wid, ids] of byWindow) {
      const i = ids.indexOf(tabId);
      if (i < 0) continue;
      ids.splice(i, 1);
      if (!ids.length) byWindow.delete(wid);
      wasUnread = true;
    }
    // onDetached already removed it (A13 wires remove() to that event, and Chrome
    // delivers it first), so the flag is only recoverable from the hand-off note.
    const removedAt = recentlyRemoved.get(tabId);
    recentlyRemoved.delete(tabId);
    if (!wasUnread && removedAt != null && Date.now() - removedAt <= DETACH_HANDOFF_MS) wasUnread = true;
    if (wasUnread) addNow(newWindowId, tabId);
    else persistSoon();
  });
}

/** Drops every entry of a closed window. */
export function forgetWindow(windowId) {
  if (!Number.isInteger(windowId)) return Promise.resolve();
  return runQueued(() => {
    if (!byWindow.delete(windowId)) return;
    persistSoon();
  });
}

/** Test/diagnostics helper. */
export function snapshot() {
  return toPlain();
}
