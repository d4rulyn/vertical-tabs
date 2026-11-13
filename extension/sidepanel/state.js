/**
 * Window-scoped panel model (spec.md §8.2, spec-addendum A13/A15).
 *
 * Everything the panel draws is derived from Chrome: `tabs.query({windowId})`
 * plus `tabGroups.query({windowId})` at boot, then incremental updates from the
 * `chrome.tabs` / `chrome.tabGroups` events, each filtered by `windowId`. The
 * panel's own document, when it is opened as an ordinary tab (tests, debugging),
 * is excluded from the model.
 *
 * This module owns no DOM. It calls the renderer through `setRenderer()` so the
 * dependency graph stays acyclic (`render.js` imports `state.js`, never the
 * other way round), and notifies the bootstrap through `subscribe()`.
 */

import * as thumbs from './thumbs.js';
import * as urlKeyMod from '../common/url-key.js';
import * as settingsMod from '../common/settings.js';
import * as schema from '../common/settings-schema.js';
import * as messagesMod from '../common/messages.js';
import * as log from '../common/log.js';
import {
  RESYNC_THROTTLE_MS,
  LOADING_RECHECK_MS,
  STORAGE_SESSION,
  STORAGE_LOCAL,
} from '../common/constants.js';
import * as locks from './locks.js';

/* ── Interop shims (namespace imports never fail to link) ─────────────────── */

const isOwnPanelUrl =
  typeof urlKeyMod.isOwnPanelUrl === 'function' ? urlKeyMod.isOwnPanelUrl : () => false;
const urlKey = typeof urlKeyMod.urlKey === 'function' ? urlKeyMod.urlKey : () => null;
const normalizeSettings =
  typeof schema.normalizeSettings === 'function' ? schema.normalizeSettings : (raw) => ({ ...DEFAULTS_FALLBACK, ...(raw || {}) });
const loadSettings =
  typeof settingsMod.loadSettings === 'function'
    ? settingsMod.loadSettings
    : async () => normalizeSettings(undefined);

/** Only used if `settings-schema.js` were unavailable; keeps the panel usable. */
const DEFAULTS_FALLBACK = {
  version: 1,
  theme: 'system',
  columns: 1,
  showThumbnails: true,
  refreshInterval: '1m',
  captureWhenPanelClosed: true,
  captureBeforeSwitch: true,
  persistThumbnails: true,
  excludedHosts: [],
  pinnedGrid: true,
  middleClickCloses: true,
  doubleClickNewTab: true,
  showUnreadDot: true,
  clickActiveTabSwitchesBack: false,
  confirmCloseThreshold: 5,
};

/** Message types (spec §6). Merged with `common/messages.js` when it exports MSG. */
export const MSG = {
  PANEL_READY: 'vt/panel-ready',
  PANEL_CLOSING: 'vt/panel-closing',
  CAPTURE_REQUEST: 'vt/capture-request',
  CLEAR_THUMBS: 'vt/clear-thumbs',
  GET_DIAGNOSTICS: 'vt/get-diagnostics',
  THUMB_UPDATED: 'vt/thumb-updated',
  THUMB_FAILED: 'vt/thumb-failed',
  THUMBS_CLEARED: 'vt/thumbs-cleared',
  POLICY_CHANGED: 'vt/policy-changed',
  HOST_ACCESS: 'vt/host-access',
  ...(messagesMod && typeof messagesMod.MSG === 'object' ? messagesMod.MSG : null),
};

export const TAB_GROUP_ID_NONE = -1;

/* ── The model ───────────────────────────────────────────────────────────── */

export const state = {
  /** @type {number} the window this panel document belongs to */
  windowId: -1,
  /** @type {Map<number, chrome.tabs.Tab>} */
  tabs: new Map(),
  /** @type {number[]} tab ids ordered by `tab.index` */
  order: [],
  /** @type {Map<number, chrome.tabGroups.TabGroup>} */
  groups: new Map(),
  /** @type {number|null} */
  activeTabId: null,
  /** @type {Set<number>} */
  highlighted: new Set(),
  /** @type {Set<number>} tabs opened in the background, tracked by the SW (A13) */
  unread: new Set(),
  /** @type {string} normalised search filter */
  filter: '',
  /** @type {typeof DEFAULTS_FALLBACK} */
  settings: { ...DEFAULTS_FALLBACK },
  /** @type {'left'|'right'|'unknown'} */
  side: 'unknown',
  /** @type {boolean} `<all_urls>` currently granted (spec-addendum A7) */
  hostAccess: true,
  /** @type {number} ms timestamp; screenshots are policy-disabled until then */
  policyDisabledUntil: 0,
  /** @type {boolean} `chrome.extension.isAllowedFileSchemeAccess()` */
  fileAccess: false,
  /** @type {boolean} a drag is in progress (suppresses auto-scroll) */
  dragging: false,
  /** @type {boolean} the pointer is inside `#tablist` (suppresses auto-scroll) */
  pointerInList: false,
  /** @type {boolean} at least one `no-host-access` failure seen in this window */
  sawNoHostAccess: false,
  /** @type {boolean} */
  testMode: false,
};

/* ── Tiny event emitter (used by the bootstrap and sibling modules) ───────── */

/** @type {Map<string, Set<Function>>} */
const listeners = new Map();

/**
 * @param {string} event 'settings' | 'policy' | 'host-access' | 'thumbs-cleared'
 *                       | 'tab-removed' | 'active-changed' | 'rendered' | 'resync'
 * @param {Function} callback
 * @returns {() => void} unsubscribe
 */
export function subscribe(event, callback) {
  if (typeof callback !== 'function') return () => {};
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(callback);
  return () => {
    const set = listeners.get(event);
    if (set) set.delete(callback);
  };
}

/** @param {string} event @param {unknown} [payload] */
export function emit(event, payload) {
  const set = listeners.get(event);
  if (!set) return;
  for (const cb of [...set]) {
    try {
      cb(payload);
    } catch (e) {
      log.warn(`state listener ${event}`, e);
    }
  }
}

/* ── Rendering hand-off ──────────────────────────────────────────────────── */

let renderer = () => {};
let renderQueued = false;

/** @param {() => void} fn injected by the bootstrap (`render.render`) */
export function setRenderer(fn) {
  if (typeof fn === 'function') renderer = fn;
}

/**
 * Batch renders. `requestAnimationFrame` callbacks are paused in hidden
 * documents, so a hidden panel falls back to a macrotask (spec.md §0.2, A.1).
 */
export function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  const run = () => {
    renderQueued = false;
    try {
      renderer();
    } catch (e) {
      log.error('render', e);
    }
  };
  if (typeof document !== 'undefined' && document.hidden) setTimeout(run, 0);
  else requestAnimationFrame(run);
}

/* ── Derived helpers ─────────────────────────────────────────────────────── */

/** @param {chrome.tabs.Tab} tab @returns {string} url first, pendingUrl only when empty (A4) */
export function urlOf(tab) {
  if (!tab) return '';
  return (tab.url && tab.url !== '' ? tab.url : tab.pendingUrl) || '';
}

/** @param {chrome.tabs.Tab} tab @returns {string|null} */
export function keyOf(tab) {
  return urlKey(urlOf(tab));
}

/** @param {number} tabId @returns {chrome.tabs.Tab|null} */
export function getTab(tabId) {
  return state.tabs.get(tabId) || null;
}

/** @returns {chrome.tabs.Tab[]} every modelled tab, in `tab.index` order */
export function orderedTabs() {
  const out = [];
  for (const id of state.order) {
    const tab = state.tabs.get(id);
    if (tab) out.push(tab);
  }
  return out;
}

/** @returns {chrome.tabs.Tab[]} */
export function pinnedTabs() {
  return orderedTabs().filter((tab) => tab.pinned);
}

/** @returns {Array<string|null>} the url keys of every modelled tab */
export function allUrlKeys() {
  return orderedTabs().map((tab) => keyOf(tab)).filter((k) => k !== null);
}

/**
 * NFKC + lower-case so full-width Japanese input matches half-width titles
 * (spec §9.4, P1 graft).
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeFilter(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').toLowerCase().trim();
}

/**
 * @param {chrome.tabs.Tab} tab
 * @param {string} [filter] defaults to the current filter
 * @returns {boolean}
 */
export function matchesFilter(tab, filter = state.filter) {
  if (!filter) return true;
  if (!tab) return false;
  const title = normalizeFilter(tab.title || '');
  const url = normalizeFilter(urlOf(tab));
  return title.includes(filter) || url.includes(filter);
}

/**
 * Set the search filter. `search.js` owns the input and the counters; the
 * renderer owns `.is-hidden` and `<mark>`, so it must go through here.
 * @param {string} raw
 */
export function setFilter(raw) {
  const next = normalizeFilter(raw);
  if (next === state.filter) return;
  state.filter = next;
  scheduleRender();
}

/** @param {object} settings already normalised */
export function setSettings(settings) {
  state.settings = settings;
  emit('settings', settings);
  scheduleRender();
}

/* ── Bootstrap ───────────────────────────────────────────────────────────── */

/**
 * @param {number} windowId
 * @param {object} [settings] pre-loaded settings (avoids a second storage read)
 * @returns {Promise<typeof state>}
 */
export async function init(windowId, settings) {
  state.windowId = windowId;
  state.settings = settings || (await loadSettings());
  await Promise.all([resyncNow(), loadUnread(), loadFileAccess()]);
  bootstrapped = true;
  return state;
}

/** Read the SW-owned unread bookkeeping (spec-addendum A13). */
async function loadUnread() {
  try {
    const stored = await chrome.storage.session.get(STORAGE_SESSION.unreadTabs);
    applyUnread(stored ? stored[STORAGE_SESSION.unreadTabs] : null);
  } catch (e) {
    log.warn('loadUnread', e);
  }
}

/** @param {Record<string, number[]>|null|undefined} map */
function applyUnread(map) {
  const ids = map && Array.isArray(map[state.windowId]) ? map[state.windowId] : [];
  state.unread = new Set(ids.filter((id) => Number.isFinite(id)));
}

/** `file://` capture eligibility, mirrored by the SW into `storage.session`. */
async function loadFileAccess() {
  try {
    const stored = await chrome.storage.session.get(STORAGE_SESSION.fileAccess);
    if (stored && typeof stored[STORAGE_SESSION.fileAccess] === 'boolean') {
      state.fileAccess = stored[STORAGE_SESSION.fileAccess];
    }
  } catch (e) {
    log.warn('loadFileAccess', e);
  }
}

/**
 * Fold the `vt/panel-ready` response into the model.
 * @param {{policyDisabledUntil?: number, fileAccess?: boolean, hostAccess?: boolean}|null} ready
 */
export function applyReady(ready) {
  if (!ready) return;
  if (typeof ready.policyDisabledUntil === 'number') state.policyDisabledUntil = ready.policyDisabledUntil;
  if (typeof ready.fileAccess === 'boolean') state.fileAccess = ready.fileAccess;
  if (typeof ready.hostAccess === 'boolean') state.hostAccess = ready.hostAccess;
}

/* ── Full resynchronisation ──────────────────────────────────────────────── */

let resyncTimer = null;
/** @type {Array<() => void>} */
let resyncWaiters = [];
let lastResyncAt = 0;

/**
 * Throttled full refresh from Chrome (one pass per `RESYNC_THROTTLE_MS`).
 * @returns {Promise<void>}
 */
export function resync() {
  return new Promise((resolve) => {
    resyncWaiters.push(resolve);
    if (resyncTimer !== null) return;
    const delay = Math.max(0, lastResyncAt + RESYNC_THROTTLE_MS - Date.now());
    resyncTimer = setTimeout(async () => {
      resyncTimer = null;
      const waiters = resyncWaiters;
      resyncWaiters = [];
      try {
        await resyncNow();
      } catch (e) {
        log.warn('resync', e);
      }
      for (const done of waiters) done();
    }, delay);
  });
}

/** Tab ids already handed to `thumbs.onTabAdded()`. */
const announced = new Set();
/** The first pass is covered by the bootstrap's batched `thumbs.loadFor()`. */
let bootstrapped = false;

/**
 * Bumped by `applySnapshot()`, by `upsertTab()` when the tab is part of the model and by `removeTab()`
 * when it was. `onActivated` and `onHighlighted` write the model without bumping it. The pending-navigation
 * watch below snapshots it around its own async query so a result that raced one of those bumps is
 * dropped instead of possibly overwriting fresher data; an `onActivated` or `onHighlighted` does not drop it. The
 * snapshot clock below is a second clock with another job (ordering snapshots against events): it ticks
 * for every `noteEvent()`, which includes `onActivated`, `onHighlighted`, `onDetached` and `onRemoved`.
 * @type {number}
 */
let modelEpoch = 0;

/**
 * Ordering of full snapshots against everything else that writes the model (H2).
 *
 * `resyncNow()` reads Chrome and then replaces the whole model, but it reads over several awaits, and
 * the resync timer is cleared BEFORE it awaits, so a second `resyncNow()` can start while the first is
 * still in flight and the OLDER one can land LAST. A snapshot that was read before a `tabs.onRemoved`
 * and applied after it brought the closed tab back as a card that nothing healed until the next
 * structural event; a tab created, moved or updated in the same window was erased the same way.
 *
 * One clock orders all of it. It ticks when a snapshot STARTS and when an event writes the model:
 *  - `lastEventAt`     the clock at the newest event-driven write (`noteEvent()`);
 *  - `lastAppliedFrom` the clock at the START of the newest snapshot that was applied.
 * A snapshot that started at `t` is stale if an event wrote the model after `t` (it may predate that
 * event, and nothing tells it apart from one that does not) or if a snapshot that started after `t`
 * was applied before it. A stale snapshot is never applied. Nor is the model left to the events alone:
 * `onMoved`, `onAttached`, `onReplaced` and `tabGroups.*` write nothing to the tab model (`onReplaced` only
 * moves the `announced` set and the thumbs bookkeeping), and the structural half of `onUpdated` stores only
 * its payload (`upsertTab`), not the renumbering around it (Probe 12 A1: beta at index 2, tied with gamma,
 * until the resync); they rely on a resync for the new state. An `onUpdated` with `index < 0` writes nothing
 * either, but the removal that follows does and its resync is a backstop. So after an event-stale snapshot
 * `resyncNow()` reads again (waiting out the throttle) until one lands with no event in between. A snapshot
 * that lost to a NEWER snapshot is dropped without reading again: that one started later, so it supersedes
 * it (if `tabs.query` and `tabGroups.query` answer in call order, which no probe has measured), and each
 * event after it either wrote the model itself, started a resync of its own or had nothing to write.
 *
 * Applying a snapshot is not an event, so two snapshots that overlap do not invalidate each other.
 */
let snapshotClock = 0;
let lastEventAt = 0;
let lastAppliedFrom = 0;

/** Record that an event just wrote (or implies a write to) the model, so a snapshot read earlier is stale. */
function noteEvent() {
  lastEventAt = ++snapshotClock;
}

/**
 * What the ordering above has done, for diagnostics and for the tests that need to see it happen.
 * `retriesMax` is the largest number of snapshots one `resyncNow()` had to discard: a stream of events
 * denser than a read keeps discarding them, and this is the number that shows it.
 */
export const resyncStats = { applied: 0, discardedForEvent: 0, droppedForNewer: 0, retriesMax: 0 };

/**
 * Replace the model with a fresh snapshot of the panel's window. Normally resolves once the model reflects
 * Chrome: a snapshot that an event overtook is read again, so this never returns with a discarded one
 * standing in. Four exits apply nothing: `tabs.query` rejecting (logged, not retried), the panel's window
 * having changed during the read, a newer snapshot having been applied first (this one is dropped, see the
 * ordering above) and, after a discarded snapshot waited out the throttle, a snapshot that started after
 * the last event having landed meanwhile (not read again).
 * @returns {Promise<void>}
 */
async function resyncNow() {
  for (let attempt = 1; ; attempt += 1) {
    lastResyncAt = Date.now();
    const windowId = state.windowId;
    const startedAt = ++snapshotClock;
    let tabs = [];
    let groups = [];
    try {
      tabs = await chrome.tabs.query({ windowId });
    } catch (e) {
      log.warn('tabs.query', e);
      return;
    }
    if (chrome.tabGroups && typeof chrome.tabGroups.query === 'function') {
      try {
        groups = await chrome.tabGroups.query({ windowId });
      } catch (e) {
        log.warn('tabGroups.query', e);
        groups = [];
      }
    }
    if (state.windowId !== windowId) return; // window changed under us

    if (lastAppliedFrom > startedAt) {
      resyncStats.droppedForNewer += 1;
      log.debug('resync: snapshot dropped, a newer one was applied first', { startedAt, lastAppliedFrom, attempt });
      return;
    }
    if (lastEventAt > startedAt) {
      resyncStats.discardedForEvent += 1;
      resyncStats.retriesMax = Math.max(resyncStats.retriesMax, attempt);
      const detail = { startedAt, lastEventAt, attempt };
      if (attempt % 10 === 0) log.warn('resync: snapshot discarded again, events keep landing while it is read', detail);
      else log.debug('resync: snapshot discarded, an event wrote the model after it started', detail);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, lastResyncAt + RESYNC_THROTTLE_MS - Date.now())));
      // Another resync that started after the last event may have landed while this one waited.
      if (lastAppliedFrom > lastEventAt) return;
      continue;
    }
    lastAppliedFrom = startedAt;
    resyncStats.applied += 1;
    applySnapshot(tabs, groups);
    return;
  }
}

/**
 * @param {chrome.tabs.Tab[]} tabs
 * @param {chrome.tabGroups.TabGroup[]} groups
 */
function applySnapshot(tabs, groups) {
  const nextTabs = new Map();
  const nextOrder = [];
  const highlighted = new Set();
  let activeTabId = null;

  for (const tab of tabs.sort((a, b) => a.index - b.index)) {
    if (isOwnPanelUrl(urlOf(tab))) continue; // the panel never lists itself (P2 graft)
    nextTabs.set(tab.id, tab);
    nextOrder.push(tab.id);
    if (tab.active) activeTabId = tab.id;
    if (tab.highlighted) highlighted.add(tab.id);
  }

  const removed = [];
  for (const id of state.tabs.keys()) if (!nextTabs.has(id)) removed.push(id);

  state.tabs = nextTabs;
  state.order = nextOrder;
  state.groups = new Map(groups.map((g) => [g.id, g]));
  state.activeTabId = activeTabId;
  state.highlighted = highlighted;
  for (const id of [...state.unread]) if (!nextTabs.has(id)) state.unread.delete(id);

  for (const id of removed) {
    announced.delete(id);
    thumbs.onTabRemoved(id);
  }
  // Restore-by-URL: a tab new to the model may already have a stored preview.
  // During the very first pass the bootstrap's single `thumbs.loadFor()`
  // transaction covers every key, so the per-tab lookups are skipped.
  for (const tab of nextTabs.values()) {
    if (announced.has(tab.id)) continue;
    announced.add(tab.id);
    if (bootstrapped) void thumbs.onTabAdded(tab);
  }

  modelEpoch += 1;
  emit('resync');
  scheduleRender();
}

/* ── Incremental updates ─────────────────────────────────────────────────── */


/**
 * @param {chrome.tabs.Tab} tab
 * @param {boolean} [inserted] true only from `tabs.onCreated`, where Chrome has
 *   just renumbered every tab at or after `tab.index`
 * @returns {boolean} whether the tab is part of the model
 */
function upsertTab(tab, inserted = false) {
  if (!tab || tab.windowId !== state.windowId) return false;
  noteEvent();
  // Applied even for the panel's own tab: it is excluded from the model but
  // still occupies a Chrome index.
  if (inserted) shiftIndices(tab.index, 1, tab.id);
  if (isOwnPanelUrl(urlOf(tab))) {
    if (state.tabs.has(tab.id)) removeTab(tab.id);
    return false;
  }
  state.tabs.set(tab.id, tab);
  if (!state.order.includes(tab.id)) {
    state.order.push(tab.id);
    reorderFromIndex();
  } else if (indexChanged(tab)) {
    reorderFromIndex();
  }
  if (tab.active) state.activeTabId = tab.id;
  if (tab.highlighted) state.highlighted.add(tab.id);
  else state.highlighted.delete(tab.id);
  if (!announced.has(tab.id)) {
    announced.add(tab.id);
    void thumbs.onTabAdded(tab);
  }
  modelEpoch += 1;
  return true;
}

/** @param {chrome.tabs.Tab} tab */
function indexChanged(tab) {
  const position = state.order.indexOf(tab.id);
  if (position < 0) return true;
  const before = state.order[position - 1];
  const after = state.order[position + 1];
  const beforeTab = before != null ? state.tabs.get(before) : null;
  const afterTab = after != null ? state.tabs.get(after) : null;
  if (beforeTab && beforeTab.index > tab.index) return true;
  if (afterTab && afterTab.index < tab.index) return true;
  return false;
}

function reorderFromIndex() {
  state.order.sort((a, b) => {
    const ta = state.tabs.get(a);
    const tb = state.tabs.get(b);
    return (ta ? ta.index : 0) - (tb ? tb.index : 0);
  });
}

/**
 * Chrome renumbers the remaining tabs after an insertion or a removal but only
 * reports the one event, so the cached `tab.index` values are corrected here.
 * They are the input of Shift+click ranges and of the drop maths, so a stale
 * index would move the wrong tab.
 *
 * @param {number} from first affected index
 * @param {number} delta +1 after an insertion, −1 after a removal
 * @param {number} [exceptTabId]
 */
function shiftIndices(from, delta, exceptTabId) {
  // -1 is "not in the strip", not a position: `tab.index > -1` is true of every tab, so a removal
  // "at -1" would move the whole strip down by one (Probe 10/11).
  if (!Number.isInteger(from) || from < 0) return;
  for (const tab of state.tabs.values()) {
    if (tab.id === exceptTabId) continue;
    if (delta > 0 ? tab.index >= from : tab.index > from) tab.index += delta;
  }
}

/** @param {number} tabId */
function removeTab(tabId) {
  const removed = state.tabs.get(tabId);
  if (!removed) return false;
  state.tabs.delete(tabId);
  shiftIndices(removed.index, -1, tabId);
  const position = state.order.indexOf(tabId);
  if (position >= 0) state.order.splice(position, 1);
  state.highlighted.delete(tabId);
  state.unread.delete(tabId);
  announced.delete(tabId);
  if (state.activeTabId === tabId) state.activeTabId = null;
  thumbs.onTabRemoved(tabId);
  modelEpoch += 1;
  noteEvent();
  return true;
}

/* ── Pending-navigation watch ────────────────────────────────────────────── */

/**
 * Chrome does not push a `tabs.onUpdated` while a navigation is still
 * uncommitted, so `status` is the one field the panel cannot keep current from
 * events alone.
 *
 * Measured on Chromium 151.0.7922.34 (this repo's Playwright image), navigating
 * a tab to the `/slow?ms=4000` fixture:
 *
 *   t=21…4000 ms  `chrome.tabs.query()` → `status:'loading'`, `url` still the OLD
 *                 page, `pendingUrl` the target — for the whole four seconds.
 *   t=4029 ms     the FIRST `tabs.onUpdated` arrives: `{status:'loading', url}`.
 *   t=4037 ms     `{status:'complete'}`.
 *
 * The same holds for the active tab and for background tabs, and whether the
 * navigation is started by `tabs.update({url})` or from inside the page. An
 * event-only model therefore reports `status:'complete'` for the entire load:
 * `data-status` (spec §8.3) is wrong for seconds at a time, and the
 * `.is-loading` spinner of spec §9.1 flashes for ~10 ms at the END of a load
 * instead of covering it. Chrome will answer correctly whenever it is asked, so
 * the panel asks.
 *
 * Deliberately narrow, so it can never fight the event path:
 *  - runs only while the panel document is visible — a hidden panel costs nothing;
 *  - touches only tabs already in the model: it never adds, removes or reorders
 *    anything, which stays the job of the events and of `resync()`;
 *  - folds only the fields Chrome does not push (`status`, `pendingUrl`,
 *    `discarded`, `frozen`), so indices, grouping and activation are untouched;
 *  - drops its own result if a write that bumps `modelEpoch` landed while the query was in flight;
 *  - renders only when a value actually changed, so an idle window produces no
 *    DOM writes and no needless `search.js` mutation wake-ups.
 */

/** @type {ReturnType<typeof setInterval>|null} */
let statusTimer = null;
let statusBusy = false;
let statusVisibilityBound = false;

/**
 * @param {chrome.tabs.Tab} tab the modelled tab
 * @param {chrome.tabs.Tab} live the same tab as Chrome reports it now
 * @returns {chrome.tabs.Tab|null} a patched copy, or null when nothing changed
 */
function foldLiveStatus(tab, live) {
  const status = live.status || 'complete';
  const pendingUrl = live.pendingUrl || '';
  const discarded = Boolean(live.discarded);
  const frozen = Boolean(live.frozen);
  if (
    (tab.status || 'complete') === status &&
    (tab.pendingUrl || '') === pendingUrl &&
    Boolean(tab.discarded) === discarded &&
    Boolean(tab.frozen) === frozen
  ) {
    return null;
  }
  return { ...tab, status, pendingUrl, discarded, frozen };
}

/** One reconciliation pass. Safe to call at any time. @returns {Promise<void>} */
export async function reconcileTabStatuses() {
  if (statusBusy) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  const windowId = state.windowId;
  if (!Number.isInteger(windowId) || windowId < 0) return;
  statusBusy = true;
  const epoch = modelEpoch;
  try {
    const live = await chrome.tabs.query({ windowId });
    // A write that bumped modelEpoch (a snapshot, `upsertTab`, `removeTab`) landed while the query was in
    // flight and may be newer than what we just read (nothing tells which), so this snapshot is dropped
    // rather than written back.
    if (state.windowId !== windowId || modelEpoch !== epoch) return;
    let changed = false;
    for (const fresh of live) {
      const tab = state.tabs.get(fresh.id);
      if (!tab) continue; // structural drift belongs to the events / resync()
      const patched = foldLiveStatus(tab, fresh);
      if (!patched) continue;
      state.tabs.set(fresh.id, patched);
      changed = true;
    }
    if (changed) scheduleRender();
  } catch (e) {
    log.warn('reconcileTabStatuses', e);
  } finally {
    statusBusy = false;
  }
}

/** Begin watching for uncommitted navigations. Idempotent. */
export function startStatusWatch() {
  if (statusTimer !== null) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  statusTimer = setInterval(() => {
    void reconcileTabStatuses();
  }, LOADING_RECHECK_MS);
}

/** Stop watching (the document went hidden, or the panel is tearing down). */
export function stopStatusWatch() {
  if (statusTimer === null) return;
  clearInterval(statusTimer);
  statusTimer = null;
}

/* ── Chrome event registration ───────────────────────────────────────────── */

let registered = false;

/** Register every Chrome listener the panel needs. Idempotent. */
export function registerChromeEvents() {
  if (registered) return;
  registered = true;

  chrome.tabs.onCreated.addListener((tab) => {
    if (!tab || tab.windowId !== state.windowId) return;
    if (!upsertTab(tab, true)) {
      scheduleRender();
      return;
    }
    // The service worker owns the authoritative unread list (A13); this
    // optimistic add just avoids a visible lag and is replaced by the next
    // `storage.session` change.
    if (!tab.active) state.unread.add(tab.id);
    scheduleRender();
  });

  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (!tab || tab.windowId !== state.windowId) return;
    // A tab on its way out of the list can send tabs.onUpdated shortly before the event that removes it
    // (0.2-83 ms across Probe 10/11/12), with {index: -1, groupId: -1}. Measured, with every close made by
    // chrome.tabs.remove: a closing grouped tab, a closing pinned tab and a tab of a collapsed group (status
    // 'unloaded', then tabs.onRemoved), and, by tabs.move and windows.create (not by mouse drag), a tab moved
    // to another window (status 'complete', the OLD windowId, then tabs.onDetached). A closing unpinned loose
    // tab sends none (Probe 11). Neither value says where the tab WAS, and storing them would corrupt the
    // model: that tab sorts first at -1 when alone (Probe 11; next to a survivor that also reads -1 it ties,
    // Probe 10), and the removal that follows used to shift every later index by that -1 (shiftIndices now
    // ignores a negative `from`), so the survivors read -1, 0, 1, ... (Probe 10). Before buildRows drew a group
    // as one row (A36), a render in that window also split their group in two (Probe 10: Work at the left
    // edge, two tabs of another group closed in one call; other layouts unmeasured). The record the model
    // already holds is the better one and the event that follows is about to remove it; Chrome is asked again
    // in case it never does.
    if (tab.index < 0) {
      void resync();
      return;
    }
    // A tab the model has never seen (it was the panel's own page, or an event
    // was missed) needs Chrome's indices, not local arithmetic.
    const firstSight = !state.tabs.has(tabId);
    const structural = info.pinned !== undefined || info.groupId !== undefined || info.index !== undefined;
    if (!upsertTab(tab)) {
      scheduleRender();
      return;
    }
    if (info.url) void thumbs.onUrlChanged(tabId, urlOf(tab));
    if (structural || firstSight) void resync();
    else scheduleRender();
  });

  chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
    if (windowId !== state.windowId) return;
    noteEvent();
    state.activeTabId = tabId;
    state.unread.delete(tabId);
    const tab = state.tabs.get(tabId);
    if (tab) state.tabs.set(tabId, { ...tab, active: true });
    for (const [id, other] of state.tabs) {
      if (id !== tabId && other.active) state.tabs.set(id, { ...other, active: false });
    }
    emit('active-changed', tabId);
    scheduleRender();
  });

  chrome.tabs.onHighlighted.addListener(({ windowId, tabIds }) => {
    if (windowId !== state.windowId) return;
    noteEvent();
    state.highlighted = new Set((tabIds || []).filter((id) => state.tabs.has(id)));
    scheduleRender();
  });

  chrome.tabs.onMoved.addListener((tabId, info) => {
    if (info.windowId !== state.windowId) return;
    void resync();
  });

  chrome.tabs.onAttached.addListener((tabId, info) => {
    if (info.newWindowId !== state.windowId) return;
    void resync();
  });

  chrome.tabs.onDetached.addListener((tabId, info) => {
    if (info.oldWindowId !== state.windowId) return;
    noteEvent(); // even when the tab was never modelled: an older snapshot may still list it
    removeTab(tabId);
    scheduleRender();
  });

  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    if (!state.tabs.has(removedTabId)) return;
    thumbs.onTabReplaced(addedTabId, removedTabId);
    announced.delete(removedTabId);
    announced.add(addedTabId);
    void resync();
  });

  chrome.tabs.onRemoved.addListener((tabId, info) => {
    // A tab closed through Chrome's own UI takes its lock with it: ids are recycled,
    // and a stale lock would otherwise be handed to whatever tab inherits this one.
    locks.forget(tabId);
    if (info && info.windowId !== undefined && info.windowId !== state.windowId) return;
    noteEvent(); // even when the tab was never modelled: an older snapshot may still list it
    if (!removeTab(tabId)) return;
    emit('tab-removed', tabId);
    scheduleRender();
  });

  if (chrome.tabGroups) {
    const onGroup = (group) => {
      if (group && group.windowId !== undefined && group.windowId !== state.windowId) return;
      void resync();
    };
    if (chrome.tabGroups.onCreated) chrome.tabGroups.onCreated.addListener(onGroup);
    if (chrome.tabGroups.onUpdated) chrome.tabGroups.onUpdated.addListener(onGroup);
    if (chrome.tabGroups.onMoved) chrome.tabGroups.onMoved.addListener(onGroup);
    if (chrome.tabGroups.onRemoved) chrome.tabGroups.onRemoved.addListener(onGroup);
  }

  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  chrome.storage.onChanged.addListener(onStorageChanged);

  // A hidden panel cannot show a spinner, so it does not pay for one either;
  // becoming visible reconciles immediately rather than waiting out a tick.
  if (typeof document !== 'undefined' && !statusVisibilityBound) {
    statusVisibilityBound = true;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        stopStatusWatch();
        return;
      }
      void reconcileTabStatuses();
      startStatusWatch();
    });
  }
  startStatusWatch();
}

/**
 * Broadcasts from the service worker (spec §6.2). Thumbnail messages are keyed
 * by `urlKey` and apply to every window; the rest carry a `windowId`.
 * @param {any} msg
 * @param {chrome.runtime.MessageSender} sender
 */
function onRuntimeMessage(msg, sender) {
  if (!msg || typeof msg.type !== 'string') return;
  if (sender && sender.id && sender.id !== chrome.runtime.id) return;

  switch (msg.type) {
    case MSG.THUMB_UPDATED:
      void thumbs.refresh(msg.urlKey);
      break;
    case MSG.THUMB_FAILED:
      if (msg.reason === 'no-host-access' && msg.windowId === state.windowId) {
        state.sawNoHostAccess = true;
        emit('host-access', { hostAccess: state.hostAccess, origin: msg.origin || null, seenFailure: true });
      }
      thumbs.markFailed(msg.tabId, msg.urlKey, msg.reason);
      break;
    case MSG.THUMBS_CLEARED:
      thumbs.clear();
      emit('thumbs-cleared');
      scheduleRender();
      break;
    case MSG.POLICY_CHANGED:
      state.policyDisabledUntil = Number(msg.disabledUntil) || 0;
      emit('policy', state.policyDisabledUntil);
      scheduleRender();
      break;
    case MSG.HOST_ACCESS: {
      const changed = state.hostAccess !== Boolean(msg.hostAccess);
      state.hostAccess = Boolean(msg.hostAccess);
      if (state.hostAccess) state.sawNoHostAccess = false;
      emit('host-access', { hostAccess: state.hostAccess, origin: msg.origin || null, changed });
      scheduleRender();
      break;
    }
    default:
      break;
  }
  // Never return true: the panel does not answer service-worker broadcasts.
}

/**
 * @param {Record<string, chrome.storage.StorageChange>} changes
 * @param {string} area
 */
function onStorageChanged(changes, area) {
  if (area === 'local' && changes[STORAGE_LOCAL.settings]) {
    setSettings(normalizeSettings(changes[STORAGE_LOCAL.settings].newValue));
    return;
  }
  if (area === 'session' && changes[STORAGE_SESSION.unreadTabs]) {
    applyUnread(changes[STORAGE_SESSION.unreadTabs].newValue);
    scheduleRender();
  }
  if (area === 'session' && changes[STORAGE_SESSION.fileAccess]) {
    const next = changes[STORAGE_SESSION.fileAccess].newValue;
    if (typeof next === 'boolean' && next !== state.fileAccess) {
      state.fileAccess = next;
      scheduleRender();
    }
  }
}

/** @returns {boolean} true while a browser policy has screenshots disabled */
export function isPolicyActive() {
  return state.policyDisabledUntil > Date.now();
}
