/**
 * Locked tabs — "do not close this one from here".
 *
 * ## What a lock can and cannot do
 *
 * An extension cannot veto `chrome.tabs.onRemoved`: by the time the event arrives the
 * tab is gone, and there is no API that asks first. Chrome's own close button, Ctrl+W
 * and the tab strip's context menu are therefore beyond reach, and always will be.
 *
 * A lock is exactly one promise: **nothing this panel does will close this tab.** That
 * is the thing worth having, because the panel is where the close buttons are stacked
 * a few pixels apart and where "close the other tabs" lives. The UI says so rather
 * than implying a protection that does not exist.
 *
 * ## Why tab ids, and why session storage
 *
 * A lock is about the tab in front of the reader, not about a URL: keying it by URL
 * would silently protect a tab they never locked, and stop the duplicate finder from
 * closing a copy they do not want. Tab ids do not survive a browser restart, so the
 * locks live in `storage.session` and go when the ids they name do. Ids for tabs that
 * closed while the panel was shut are pruned on load, so the set cannot grow forever
 * or hand a lock to whatever tab inherits a recycled id.
 */

import * as log from '../common/log.js';
import { STORAGE_SESSION } from '../common/constants.js';

/** @type {Set<number>} */
let locked = new Set();
/** @type {Set<Function>} */
const listeners = new Set();
let loaded = false;

/** @param {Function} fn @returns {Function} unsubscribe */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce() {
  for (const fn of listeners) {
    try {
      fn(new Set(locked));
    } catch (e) {
      log.warn('locks listener', e);
    }
  }
}

/**
 * Read the stored set and drop ids whose tabs are gone.
 * @returns {Promise<Set<number>>}
 */
export async function load() {
  try {
    const stored = await chrome.storage.session.get(STORAGE_SESSION.lockedTabs);
    const ids = stored && stored[STORAGE_SESSION.lockedTabs];
    const wanted = Array.isArray(ids) ? ids.filter((n) => Number.isInteger(n)) : [];
    const alive = [];
    for (const id of wanted) {
      try {
        await chrome.tabs.get(id);
        alive.push(id);
      } catch {
        /* closed while the panel was not watching */
      }
    }
    locked = new Set(alive);
    if (alive.length !== wanted.length) void persist();
  } catch (e) {
    log.warn('locks load', e);
    locked = new Set();
  }
  loaded = true;
  announce();
  return new Set(locked);
}

async function persist() {
  try {
    await chrome.storage.session.set({ [STORAGE_SESSION.lockedTabs]: [...locked] });
  } catch (e) {
    log.warn('locks persist', e);
  }
}

/** @param {number} tabId */
export function isLocked(tabId) {
  return locked.has(tabId);
}

/** @returns {Set<number>} a copy; the caller cannot mutate the real set */
export function all() {
  return new Set(locked);
}

/** @returns {boolean} whether anything has been read from storage yet */
export function ready() {
  return loaded;
}

/**
 * @param {number} tabId
 * @param {boolean} [next] force a state instead of toggling
 * @returns {boolean} the state the tab is now in
 */
export function set(tabId, next) {
  if (!Number.isInteger(tabId)) return false;
  const want = next === undefined ? !locked.has(tabId) : Boolean(next);
  if (want === locked.has(tabId)) return want;
  if (want) locked.add(tabId);
  else locked.delete(tabId);
  void persist();
  announce();
  return want;
}

/** A tab that closed anyway — through Chrome's own UI — takes its lock with it. */
export function forget(tabId) {
  if (!locked.delete(tabId)) return;
  void persist();
  announce();
}

/**
 * Split a close request into what may go and what may not.
 * @param {number[]} tabIds
 * @returns {{allowed: number[], blocked: number[]}}
 */
export function partition(tabIds) {
  const allowed = [];
  const blocked = [];
  for (const id of tabIds) (locked.has(id) ? blocked : allowed).push(id);
  return { allowed, blocked };
}
