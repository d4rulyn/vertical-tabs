/**
 * background/capture.js — the whole preview pipeline: scheduler, serial queue, rate
 * limiter, job prechecks, capture, postcheck, decode/crop/downscale, store, broadcast.
 *
 * Binding sources, in order: .agent/probe-results.md → .agent/spec-addendum.md → .agent/spec.md.
 *
 * Measured platform facts this module is built around (probe, Chromium 151):
 *  - captureVisibleTab allows about TWO calls per second for the whole extension, and
 *    rejects the third one inside a second; recovery is ~1.2 s after a REJECTED call.
 *    A1's "once per second" came from a BURST probe (three simultaneous calls -> ok,
 *    err, err), which measures concurrency, not rate; re-measured serially, spacings
 *    from 550 ms up run clean and two windows interleaved 375 ms apart produce the
 *    repeating `..X..X` of a 2-per-second limit (numbers in common/constants.js).
 *    → one global serial queue and MIN_CALL_SPACING_MS (1100 ms) between calls, as A1
 *    and A2 require. The one place the second half of the budget is spent is the
 *    switch handoff: the `before-switch` capture of the tab being left and the
 *    `activated` capture of the tab being switched to are one user action and may be
 *    CALL_MIN_GAP_MS apart, after which nothing runs until CALL_WINDOW_MS from the
 *    first of the two — so no three calls ever share a second. A rejected call
 *    charges the limiter too, and adds the measured recovery on top (A1, A2).
 *  - A non-focused normal window CAN be captured, but the service worker must always pass
 *    an explicit window id: with no argument Chrome captures the last-focused window (A3).
 *  - `tab.url` is what is on screen (the OLD url during a slow navigation); `pendingUrl`
 *    is only a fallback for an uncommitted new tab (A4).
 *  - "Cannot access contents of url …" is also what a WITHHELD host permission produces,
 *    so on http(s)/file it is the recoverable `no-host-access` state, not `restricted` (A7).
 */

import * as C from '../common/constants.js';
import * as messagesMod from '../common/messages.js';
import * as logMod from '../common/log.js';
import { urlKey, classifyUrl } from '../common/url-key.js';
import { classifyCaptureError } from '../common/capture-errors.js';
import { loadSettings } from '../common/settings.js';
import { putThumb, getThumb } from '../common/thumb-store.js';
import { normalizePreviewMoment } from '../common/settings-schema.js';
import { decidePreview, AT_TOP_PENDING } from '../common/preview-moment.js';
import * as panels from './panels.js';
import * as unread from './unread.js';
import * as diag from './diagnostics.js';

/* ────────────────────────────────────────────────────────────────────────────
 * Module wiring that must never break the service worker
 * ──────────────────────────────────────────────────────────────────────────── */

const log = {
  warn: typeof logMod.warn === 'function' ? logMod.warn : (...a) => console.warn('[vt]', ...a),
  info: typeof logMod.info === 'function' ? logMod.info : () => {},
};

const MSG = messagesMod.MSG ?? {};
const broadcast =
  typeof messagesMod.broadcast === 'function'
    ? messagesMod.broadcast
    : (message) => {
        try {
          const p = chrome.runtime.sendMessage(message);
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch {
          /* no receiver — expected while no panel is open */
        }
      };

/** Wire strings are authoritative (spec §6); the MSG constants are only nicer names. */
const TYPE = {
  THUMB_UPDATED: MSG.THUMB_UPDATED ?? 'vt/thumb-updated',
  THUMB_FAILED: MSG.THUMB_FAILED ?? 'vt/thumb-failed',
  POLICY_CHANGED: MSG.POLICY_CHANGED ?? 'vt/policy-changed',
  HOST_ACCESS: MSG.HOST_ACCESS ?? 'vt/host-access',
};

/* Constants: values are pinned by the addendum; the fallbacks keep the measured
 * behaviour even if common/constants.js drifts. */
const THUMB_W = C.THUMB_W ?? 640;
const THUMB_H = C.THUMB_H ?? 240;
const CAPTURE_OPTS = C.CAPTURE_OPTS ?? { format: 'jpeg', quality: 80 };
const THUMB_JPEG_QUALITY = C.THUMB_JPEG_QUALITY ?? 0.72;
const DELAY_MS = C.DELAY_MS ?? {
  activated: 450, complete: 350, url: 1200, replaced: 350, focus: 500, 'panel-opened': 100,
  startup: 1500, refresh: 0, 'manual-refresh': 0, 'before-switch': 0, 'visible-missing': 100,
  retry: 1200, 'uniform-recheck': 1500,
};
const MIN_CALL_SPACING_MS = C.MIN_CALL_SPACING_MS ?? 1100;
const CALL_MIN_GAP_MS = C.CALL_MIN_GAP_MS ?? 450;
const CALL_WINDOW_MS = C.CALL_WINDOW_MS ?? 1600;
const CALL_WINDOW_MAX = C.CALL_WINDOW_MAX ?? 2;
const queueRank =
  typeof C.queueRank === 'function'
    ? C.queueRank
    : (reason, windowId, focusedWindowId) => {
        if (reason === 'before-switch') return 0;
        if (!(C.INTERACTIVE_REASONS instanceof Set) || !C.INTERACTIVE_REASONS.has(reason)) return 3;
        return windowId === focusedWindowId ? 1 : 2;
      };
const QUOTA_RETRY_MS = C.QUOTA_RETRY_MS ?? 1300;
const QUOTA_MAX_RETRIES = C.QUOTA_MAX_RETRIES ?? 3;
const CAPTURE_TIMEOUT_MS = C.CAPTURE_TIMEOUT_MS ?? 6000;
const RETRY_DELAYS_MS = C.RETRY_DELAYS_MS ?? [1200, 2400];
const UNKNOWN_MAX_RETRIES = C.UNKNOWN_MAX_RETRIES ?? 1;
const DRAG_RETRY_MS = C.DRAG_RETRY_MS ?? 1200;
const DRAG_MAX_RETRIES = C.DRAG_MAX_RETRIES ?? 3;
const JOB_MAX_MS = C.JOB_MAX_MS ?? 20000;
const LOADING_RECHECK_MS = C.LOADING_RECHECK_MS ?? 500;
const LOADING_MAX_RECHECKS = C.LOADING_MAX_RECHECKS ?? 6;
const SAME_URL_MIN_INTERVAL_MS = C.SAME_URL_MIN_INTERVAL_MS ?? 5000;
const PER_TAB_MIN_INTERVAL_MS = C.PER_TAB_MIN_INTERVAL_MS ?? 2000;
const PREVIEW_TOP_EPSILON_PX = C.PREVIEW_TOP_EPSILON_PX ?? 8;
const PREVIEW_SCROLL_TIMEOUT_MS = C.PREVIEW_SCROLL_TIMEOUT_MS ?? 250;
const SWITCH_CAPTURE_MAX_WAIT_MS = C.SWITCH_CAPTURE_MAX_WAIT_MS ?? 300;
const BACKOFF_AFTER_FAILURES = C.BACKOFF_AFTER_FAILURES ?? 3;
const BACKOFF_MS = C.BACKOFF_MS ?? 30000;
const POLICY_BACKOFF_MS = C.POLICY_BACKOFF_MS ?? 10 * 60000;
const RESTRICTED_KEYS_MAX = C.RESTRICTED_KEYS_MAX ?? 500;
const RESTRICTED_TTL_MS = C.RESTRICTED_TTL_MS ?? 15 * 60000;
const NO_HOST_ACCESS_TTL_MS = C.NO_HOST_ACCESS_TTL_MS ?? 15 * 60000;
const NO_HOST_ACCESS_MAX = C.NO_HOST_ACCESS_MAX ?? 200;
const QUEUE_MAX = C.QUEUE_MAX ?? 8;
const BY_TAB_MAX = C.CAPTURE_BY_TAB_MAX ?? 200;

/** Reasons that bypass the per-tab and same-url freshness guards (A4). */
const EXEMPT_REASONS = new Set(['activated', 'manual-refresh', 'panel-opened', 'before-switch', 'complete']);

/** How long the `before-switch` request waits for the capture call to return. */
const SWITCH_INLINE_TIMEOUT_MS = 1500;

/**
 * How long after a `before-switch` capture the activation it belongs to may still
 * claim the second slot of that second. The panel switches as soon as the capture
 * returns (or after SWITCH_CAPTURE_UI_TIMEOUT_MS), and the activation is then
 * debounced by DELAY_MS.activated, so a real handoff lands a few hundred ms later;
 * anything slower than this is a different user action.
 */
const SWITCH_HANDOFF_MS = 2000;

/* ────────────────────────────────────────────────────────────────────────────
 * State (in memory; mirrored to chrome.storage.session, which is cleared on
 * browser restart so tab / window ids can never go stale)
 * ──────────────────────────────────────────────────────────────────────────── */

/** windowId → { tabId, reason, opts, timer } — one debounce slot per window (§7.3). */
const pending = new Map();
/** Ready jobs, FIFO with per-window fairness (A2). */
const queue = [];
/** windowId → ms of the last capture ATTEMPT (successful or rejected). */
const lastCallByWindow = new Map();
/** windowId → activation generation; bumped by tabs.onActivated (§7.3). */
const gen = new Map();
/** tabId → number of loading rechecks so far (A4, 3g). */
const recheckCount = new Map();
/** tabId → the last urlKey a job looked at, so a navigation can clear its memory (A8.3). */
const lastKeyByTab = new Map();
const LAST_KEY_MAX = 200;

let lastCallAt = 0;
/**
 * Timestamps of the last CALL_WINDOW_MAX capture ATTEMPTS, oldest first. The
 * limiter reads the calls that really happened rather than the ones it planned:
 * a slow capture must push the next one out, never let two pile up behind it.
 */
let recentCalls = [];
/** No call before this: set when Chrome rejected one with the quota error. */
let quotaFloorAt = 0;
/**
 * The `before-switch` capture the panel asked for while the user's click was still
 * being held (A12), and whether the activation that follows it has already claimed
 * the second half of that second. See `isSwitchHandoff`.
 */
let switchHandoffAt = 0;
let switchHandoffWindow = null;
let switchHandoffUsed = true;
let draining = false;

/** `{ [windowId]: { tabId, urlKey, capturedAt } }` — freshness per window. */
let byWindow = {};
/** `{ [tabId]: ms }` — last successful capture per tab (A6), LRU-capped. */
let byTab = {};
/** `{ [tabId]: { count, lastClass, nextAllowedAt } }`. */
let captureFailures = {};
/** `{ [urlKey]: { class: 'restricted'|'policy', at: number } }` (A8). */
let restrictedUrlKeys = {};
/** `{ [origin]: expiryMs }` (A7). */
let noHostAccessOrigins = {};
let policyDisabledUntil = 0;
let hostAccess = true;
let fileAccess = false;
let lastFocusedWindow = null;

let hydratePromise = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

function ownOrigin() {
  try {
    return chrome.runtime.getURL('/');
  } catch {
    return '';
  }
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function schemeOf(url) {
  try {
    return new URL(url).protocol;
  } catch {
    return '';
  }
}

/** `tab.url` first, `pendingUrl` only when it is empty (A4, measured Tab semantics). */
function displayUrlOf(tab) {
  if (!tab) return '';
  return tab.url && tab.url !== '' ? tab.url : tab.pendingUrl || '';
}

function trimFifo(obj, max) {
  const keys = Object.keys(obj);
  if (keys.length <= max) return;
  for (const key of keys.slice(0, keys.length - max)) delete obj[key];
}

/* ────────────────────────────────────────────────────────────────────────────
 * Hydration and persistence (storage.session)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Reads the bookkeeping a restarted service worker must not lose — above all
 * `captureState.lastCallAt`, so a restart cannot exceed the ~1/s quota (§7.3, A2).
 * Memoised: every job awaits the same promise; never awaited at the top level.
 *
 * `unread.hydrate()` is started from here because service-worker.js's one worker-start
 * hook is `capture.hydrate()`; unread's own mutators queue behind the same promise, so
 * this only makes the storage read start at boot rather than at the first tab event.
 */
export function hydrate() {
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    await Promise.all([panels.hydrate(), diag.hydrate(), unread.hydrate()]);
    try {
      const got = await chrome.storage.session.get([
        'captureState',
        'captureFailures',
        'restrictedUrlKeys',
        'policyDisabledUntil',
        'noHostAccessOrigins',
        'hostAccessState',
        'lastFocusedWindowId',
      ]);
      const state = got?.captureState;
      if (state && typeof state === 'object') {
        if (Number.isFinite(state.lastCallAt)) lastCallAt = Math.max(lastCallAt, state.lastCallAt);
        // The rate limiter must survive a worker restart, or the first job after one
        // could fire a third call into a second Chrome has already half-spent.
        if (Array.isArray(state.recentCalls)) {
          const saved = state.recentCalls.filter((at) => Number.isFinite(at)).sort((a, b) => a - b);
          recentCalls = [...saved, ...recentCalls].sort((a, b) => a - b).slice(-CALL_WINDOW_MAX);
        }
        if (Number.isFinite(state.quotaFloorAt)) quotaFloorAt = Math.max(quotaFloorAt, state.quotaFloorAt);
        if (state.byWindow && typeof state.byWindow === 'object') byWindow = { ...state.byWindow };
        if (state.byTab && typeof state.byTab === 'object') byTab = { ...state.byTab };
        if (state.lastCallByWindow && typeof state.lastCallByWindow === 'object') {
          for (const [windowId, at] of Object.entries(state.lastCallByWindow)) {
            if (Number.isFinite(at)) lastCallByWindow.set(Number(windowId), at);
          }
        }
        // Pairs, not an object: integer-like object keys would be reordered numerically
        // and this map's insertion order IS its eviction order. Restored oldest-first,
        // and never overwriting a key a job of this generation has already recorded.
        if (Array.isArray(state.lastKeyByTab)) {
          for (const pair of state.lastKeyByTab) {
            if (!Array.isArray(pair)) continue;
            const [tabId, key] = pair;
            if (!Number.isInteger(tabId) || typeof key !== 'string' || !key) continue;
            if (!lastKeyByTab.has(tabId)) lastKeyByTab.set(tabId, key);
          }
          while (lastKeyByTab.size > LAST_KEY_MAX) {
            lastKeyByTab.delete(lastKeyByTab.keys().next().value);
          }
        }
      }
      if (got?.captureFailures && typeof got.captureFailures === 'object') captureFailures = { ...got.captureFailures };
      if (got?.restrictedUrlKeys && typeof got.restrictedUrlKeys === 'object') restrictedUrlKeys = { ...got.restrictedUrlKeys };
      if (Number.isFinite(got?.policyDisabledUntil)) policyDisabledUntil = got.policyDisabledUntil;
      if (got?.noHostAccessOrigins && typeof got.noHostAccessOrigins === 'object') noHostAccessOrigins = { ...got.noHostAccessOrigins };
      if (got?.hostAccessState && typeof got.hostAccessState.all === 'boolean') hostAccess = got.hostAccessState.all;
      if (Number.isInteger(got?.lastFocusedWindowId)) lastFocusedWindow = got.lastFocusedWindowId;
      // A record written before `recentCalls` existed still carries `lastCallAt`;
      // treat it as one spent call so the restart cannot burst against it.
      if (!recentCalls.length && lastCallAt > 0) recentCalls = [lastCallAt];
    } catch (e) {
      log.warn('capture: hydrate failed', e);
    }
    // Fresh readings of the two host-side flags the panel needs (§5.3, A7d).
    await Promise.all([refreshFileAccess(), refreshHostAccess()]);
  })().catch((e) => log.warn('capture: hydrate failed', e));
  return hydratePromise;
}

function persistCaptureState() {
  const lastByWindow = {};
  for (const [windowId, at] of lastCallByWindow) lastByWindow[windowId] = at;
  // A8.3 needs `lastKeyByTab` after a worker restart: without it a navigation that is
  // itself the waking event cannot tell which urlKey to drop from restrictedUrlKeys.
  const lastKeys = [...lastKeyByTab].slice(-LAST_KEY_MAX);
  return chrome.storage.session
    .set({
      captureState: {
        lastCallAt,
        recentCalls: [...recentCalls],
        quotaFloorAt,
        byWindow,
        byTab,
        lastCallByWindow: lastByWindow,
        lastKeyByTab: lastKeys,
      },
    })
    .catch((e) => log.warn('capture: persist captureState failed', e));
}

function persistFailures() {
  return chrome.storage.session.set({ captureFailures }).catch((e) => log.warn('capture: persist failures failed', e));
}

function persistRestricted() {
  return chrome.storage.session.set({ restrictedUrlKeys }).catch((e) => log.warn('capture: persist restricted failed', e));
}

function persistPolicy() {
  return chrome.storage.session.set({ policyDisabledUntil }).catch((e) => log.warn('capture: persist policy failed', e));
}

function persistHostAccess() {
  return chrome.storage.session
    .set({ hostAccessState: { all: hostAccess, at: Date.now() }, noHostAccessOrigins })
    .catch((e) => log.warn('capture: persist hostAccess failed', e));
}

async function refreshFileAccess() {
  let allowed = false;
  try {
    if (typeof chrome.extension?.isAllowedFileSchemeAccess === 'function') {
      allowed = await chrome.extension.isAllowedFileSchemeAccess();
    }
  } catch {
    allowed = false;
  }
  fileAccess = allowed === true;
  try {
    await chrome.storage.session.set({ fileAccess });
  } catch {
    /* ignore */
  }
  return fileAccess;
}

/** A7d: `<all_urls>` can be withheld by the user or by policy; this is recoverable. */
export async function refreshHostAccess() {
  let granted = true;
  try {
    if (typeof chrome.permissions?.contains === 'function') {
      granted = await chrome.permissions.contains({ origins: ['<all_urls>'] });
    }
  } catch {
    granted = true; // unknown → assume granted; a real capture failure will correct it
  }
  hostAccess = granted !== false;
  await persistHostAccess();
  return hostAccess;
}

/** Top-level handler for chrome.permissions.onAdded / onRemoved (A7d). */
export async function onPermissionsChanged() {
  const granted = await refreshHostAccess();
  noHostAccessOrigins = {};
  restrictedUrlKeys = {};
  try {
    await chrome.storage.session.set({
      hostAccessState: { all: granted, at: Date.now() },
      noHostAccessOrigins: {},
      restrictedUrlKeys: {},
    });
  } catch {
    /* ignore */
  }
  broadcast({ type: TYPE.HOST_ACCESS, hostAccess: granted, origin: null, at: Date.now() });
  await scheduleAllWindowsActive('permissions');
}

/* ────────────────────────────────────────────────────────────────────────────
 * Focused-window tracking (A3.5) — the worker never asks Chrome for "the current
 * window"; it remembers the last focused one instead.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Called synchronously from windows.onFocusChanged and from `vt/panel-ready`. */
export function noteFocusedWindow(windowId) {
  if (!Number.isInteger(windowId) || windowId < 0) return;
  if (lastFocusedWindow === windowId) return;
  lastFocusedWindow = windowId;
  chrome.storage.session.set({ lastFocusedWindowId: windowId }).catch(() => {});
}

/** Synchronous best guess — safe to use inside a gesture-sensitive handler. */
export function getLastFocusedWindowId() {
  return lastFocusedWindow;
}

/** Async resolution used by the refresh alarm; falls back to Chrome's own answer. */
export async function lastFocusedWindowId() {
  await hydrate();
  if (Number.isInteger(lastFocusedWindow)) return lastFocusedWindow;
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (Number.isInteger(win?.id)) {
      lastFocusedWindow = win.id;
      return win.id;
    }
  } catch {
    /* no window at all */
  }
  return null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Per-tab / per-url bookkeeping
 * ──────────────────────────────────────────────────────────────────────────── */

function restrictedFresh(key) {
  if (!key) return false;
  const entry = restrictedUrlKeys[key];
  if (!entry) return false;
  if (Date.now() - (entry.at ?? 0) > RESTRICTED_TTL_MS) {
    delete restrictedUrlKeys[key];
    void persistRestricted();
    return false;
  }
  return true;
}

function rememberRestricted(key, cls) {
  if (!key) return; // A4: a null key is never stored
  restrictedUrlKeys[key] = { class: cls, at: Date.now() };
  trimFifo(restrictedUrlKeys, RESTRICTED_KEYS_MAX);
  void persistRestricted();
}

function forgetRestricted(key) {
  if (!key || !(key in restrictedUrlKeys)) return;
  delete restrictedUrlKeys[key];
  void persistRestricted();
}

function noHostAccessFresh(url) {
  const origin = originOf(url);
  if (!origin) return false;
  const until = noHostAccessOrigins[origin];
  if (!until) return false;
  if (Date.now() > until) {
    delete noHostAccessOrigins[origin];
    void persistHostAccess();
    return false;
  }
  return true;
}

function rememberNoHostAccess(url) {
  const origin = originOf(url);
  if (!origin) return null;
  noHostAccessOrigins[origin] = Date.now() + NO_HOST_ACCESS_TTL_MS;
  trimFifo(noHostAccessOrigins, NO_HOST_ACCESS_MAX);
  return origin;
}

/**
 * Clears backoff/failure memory for a tab (navigation, success, removal).
 *
 * Awaits hydrate() first: the tabs.onUpdated / onReplaced / onRemoved listeners call
 * this synchronously, and when the event is what WOKE the worker `captureFailures` is
 * still `{}` — the old code returned early and hydrate() then restored the very entry
 * the navigation was supposed to clear. Callers fire and forget; the storage write it
 * issues keeps the worker alive long enough to land.
 */
export async function resetFailures(tabId) {
  if (!Number.isInteger(tabId)) return;
  await hydrate();
  if (!(tabId in captureFailures)) return;
  delete captureFailures[tabId];
  void persistFailures();
}

export function resetRecheckCount(tabId) {
  recheckCount.delete(tabId);
}

/**
 * A8.3 — a tab that navigates away drops the "no preview" memory of the page it was
 * showing, so a transient failure (redirect race, temporarily blocked host) cannot
 * outlive the navigation that caused it.
 *
 * The key is read eagerly (a warm worker already has it, and a job running concurrently
 * must not move it out from under us) and again after hydrate(), because when the
 * navigation is what woke the worker `lastKeyByTab` is only restored by hydrate() — and
 * so is `restrictedUrlKeys`, which would otherwise keep dropping every job for the page
 * the user has just come back to as `restricted-cached` until the 15-minute TTL expires.
 */
export async function forgetRestrictedForTab(tabId) {
  const eager = lastKeyByTab.get(tabId);
  await hydrate();
  const key = eager ?? lastKeyByTab.get(tabId);
  if (key) forgetRestricted(key);
}

function rememberTabKey(tabId, key) {
  if (!key) return;
  lastKeyByTab.delete(tabId);
  lastKeyByTab.set(tabId, key);
  while (lastKeyByTab.size > LAST_KEY_MAX) {
    const oldest = lastKeyByTab.keys().next().value;
    lastKeyByTab.delete(oldest);
  }
}

function noteFailure(tabId, cls) {
  const entry = captureFailures[tabId] ?? { count: 0, lastClass: null, nextAllowedAt: 0 };
  entry.count += 1;
  entry.lastClass = cls;
  if (entry.count >= BACKOFF_AFTER_FAILURES) entry.nextAllowedAt = Date.now() + BACKOFF_MS;
  captureFailures[tabId] = entry;
  void persistFailures();
}

function noteTabCaptured(tabId, at) {
  byTab[tabId] = at;
  const keys = Object.keys(byTab);
  if (keys.length > BY_TAB_MAX) {
    keys
      .sort((a, b) => (byTab[a] ?? 0) - (byTab[b] ?? 0))
      .slice(0, keys.length - BY_TAB_MAX)
      .forEach((k) => delete byTab[k]);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Scheduling entry points (§7.3, Appendix A.3)
 * ──────────────────────────────────────────────────────────────────────────── */

function makeJob({ windowId, tabId, reason, isUniformRecheck = false, exempt = false, priority = false }) {
  return {
    windowId,
    tabId,
    reason,
    isUniformRecheck,
    exempt,
    priority,
    tries: 0,
    quotaTries: 0,
    dragTries: 0,
    postcheckRetried: false,
    startedAt: Date.now(),
    onCaptured: null,
    resolved: false, // the `before-switch` deferred has been answered
    requeued: false, // a retry timer is pending → drain() must not answer it yet
    cancelled: false, // evicted from the queue; a pending retry must not resurrect it
  };
}

/**
 * Debounces one job per window: a newer schedule() for the same window replaces the
 * older one, which coalesces rapid Ctrl+Tab cycling into a single capture.
 *
 * `followUp: true` marks a re-check scheduled from INSIDE a job that has already spent
 * its awaits (the 3g loading re-check and the step 9 uniform re-check). Such a job must
 * never evict a pending entry for a DIFFERENT tab: every scheduler targets the tab that
 * was active for its window, so a different tab in the slot means the user has switched,
 * the pending job is the capture they are waiting for, and the re-check could only end in
 * step 3a `not-active`. Without this guard the re-check silently cancelled that capture
 * and the tab just switched to kept its old image (measured 10/20 panel-driven switches).
 * A user-driven schedule() still replaces a pending re-check, which is the intended
 * direction of the debounce.
 */
export function schedule({ windowId, tabId, reason, delay, followUp = false, ...opts }) {
  if (!Number.isInteger(windowId) || windowId < 0 || !Number.isInteger(tabId)) return;
  const prev = pending.get(windowId);
  if (prev && followUp && prev.tabId !== tabId) return;
  if (prev) clearTimeout(prev.timer);
  const ms = delay ?? DELAY_MS[reason] ?? 300;
  const timer = setTimeout(() => {
    pending.delete(windowId);
    enqueue(makeJob({ windowId, tabId, reason, ...opts }));
  }, ms);
  pending.set(windowId, { tabId, reason, opts, timer });
}

/** Schedules the active tab of one window, optionally only when the preview is stale. */
export async function scheduleActiveOfWindow(windowId, reason, { onlyIfOlderThan } = {}) {
  if (!Number.isInteger(windowId) || windowId < 0) return;
  await hydrate();
  let tabs;
  try {
    tabs = await chrome.tabs.query({ active: true, windowId });
  } catch {
    return; // window gone
  }
  const tab = tabs?.[0];
  if (!tab || !Number.isInteger(tab.id)) return;
  if (onlyIfOlderThan) {
    const record = byWindow[windowId];
    const key = urlKey(displayUrlOf(tab));
    if (record && key && record.urlKey === key && Date.now() - (record.capturedAt ?? 0) < onlyIfOlderThan) return;
  }
  schedule({ windowId, tabId: tab.id, reason });
}

/** Schedules the active tab of every non-minimized normal window (A3.3). */
export async function scheduleAllWindowsActive(reason) {
  await hydrate();
  let windows;
  try {
    windows = await chrome.windows.getAll({ windowTypes: ['normal'], populate: true });
  } catch (e) {
    log.warn('capture: getAll failed', e);
    return;
  }
  for (const win of windows ?? []) {
    if (!Number.isInteger(win.id) || win.state === 'minimized') continue;
    const active = (win.tabs ?? []).find((t) => t.active);
    if (active && Number.isInteger(active.id)) schedule({ windowId: win.id, tabId: active.id, reason });
  }
}

/** tabs.onActivated bumps the generation so an in-flight capture can be invalidated. */
export function bumpGeneration(windowId) {
  if (!Number.isInteger(windowId)) return;
  gen.set(windowId, (gen.get(windowId) ?? 0) + 1);
}

/** windows.onRemoved: forget everything about a window. */
export function forgetWindow(windowId) {
  const prev = pending.get(windowId);
  if (prev) clearTimeout(prev.timer);
  pending.delete(windowId);
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].windowId === windowId) {
      cancelJob(queue[i]);
      queue.splice(i, 1);
    }
  }
  gen.delete(windowId);
  lastCallByWindow.delete(windowId);
  if (windowId in byWindow) {
    delete byWindow[windowId];
    void persistCaptureState();
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * The serial queue and the rate limiter (A2)
 * ──────────────────────────────────────────────────────────────────────────── */

function enqueue(job) {
  if (queue.length >= QUEUE_MAX) {
    // Drop the least valuable job: the highest rank (background before interactive),
    // preferring one for the same window so a single window cannot fill the queue.
    let index = -1;
    let worst = -1;
    for (let i = 0; i < queue.length; i += 1) {
      const candidate = queue[i];
      if (candidate.priority) continue;
      const rank = queueRank(candidate.reason, candidate.windowId, lastFocusedWindow) * 2 +
        (candidate.windowId === job.windowId ? 1 : 0);
      if (rank > worst) {
        worst = rank;
        index = i;
      }
    }
    if (index < 0) index = 0;
    cancelJob(queue[index]);
    queue.splice(index, 1);
  }
  queue.push(job);
  void drain();
}

/**
 * Picks the job the user is most likely to be waiting for, then keeps A2's
 * per-window fairness inside that group.
 *
 * The rank comes first because every job in the queue costs a rate-limit slot: four
 * queued `refresh` jobs used to push the capture of the tab the user just switched to
 * out by several seconds, which is the "lag" they reported. `before-switch` still wins
 * outright — the outgoing tab stops being visible the instant the switch lands.
 */
function takeNextJob() {
  const focused = lastFocusedWindow;
  let best = -1;
  let bestRank = Infinity;
  const now = Date.now();
  for (let i = 0; i < queue.length; i += 1) {
    const job = queue[i];
    const rank = job.priority ? 0 : queueRank(job.reason, job.windowId, focused);
    if (rank > bestRank) continue;
    if (rank < bestRank) {
      bestRank = rank;
      best = i;
      continue;
    }
    // Same rank: prefer a window that has not just been served (A2 round-robin).
    const bestHot = (lastCallByWindow.get(queue[best].windowId) ?? 0) + MIN_CALL_SPACING_MS > now;
    const jobHot = (lastCallByWindow.get(job.windowId) ?? 0) + MIN_CALL_SPACING_MS > now;
    if (bestHot && !jobHot) best = i;
  }
  if (best < 0) best = 0;
  return queue.splice(best, 1)[0];
}

/** Strictly serial: at most one captureVisibleTab in flight, ever. */
async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const job = takeNextJob();
      try {
        await runJob(job);
      } catch (e) {
        log.warn('capture job', e);
        diag.setLastError(String(e?.message ?? e));
      } finally {
        if (!job.requeued) settleJob(job, null);
      }
    }
  } finally {
    draining = false;
  }
}

/**
 * The earliest moment the next `captureVisibleTab` may be made, computed from the
 * calls that were actually issued:
 *
 *  - the ordinary spacing is MIN_CALL_SPACING_MS, exactly as A2 requires;
 *  - a SWITCH HANDOFF may take the second slot of the same second after only
 *    CALL_MIN_GAP_MS (see `isSwitchHandoff`);
 *  - after any pair, nothing until CALL_WINDOW_MS from the FIRST of the two, so
 *    three consecutive calls always span >= 1600 ms and can never share a second;
 *  - nothing at all until a quota rejection has had its measured recovery.
 *
 * Reading recorded times rather than a planned schedule is what makes the
 * one-second property hold under a slow capture or a stalled worker: a late call
 * pushes its successors out instead of letting them bunch up behind it. (Measured:
 * a probe that planned its times instead produced three calls inside a second and
 * was rejected; the same pattern anchored on real times was not.)
 */
function nextSlotAt(handoff) {
  const last = recentCalls.length ? recentCalls[recentCalls.length - 1] : 0;
  const oldest = recentCalls.length >= CALL_WINDOW_MAX ? recentCalls[recentCalls.length - CALL_WINDOW_MAX] : 0;
  const gap = handoff ? CALL_MIN_GAP_MS : MIN_CALL_SPACING_MS;
  return Math.max(last + gap, oldest + CALL_WINDOW_MS, quotaFloorAt);
}

/**
 * Is this job the second half of one user action?
 *
 * When the user clicks a card, the panel first asks the worker to capture the tab
 * being LEFT (A12) and only then switches. Chrome's quota is about two calls per
 * second, so both frames of that single gesture fit in one second — and making the
 * incoming tab wait a full spacing behind the outgoing one was the largest part of
 * the lag the user reported (measured: 1200 ms to the incoming preview against
 * 568 ms for the same switch with no outgoing capture).
 *
 * Deliberately narrow. Only the activation that immediately follows a
 * `before-switch` capture of the same window may use it, and only once, so the
 * sustained call rate outside a switch is unchanged.
 */
function isSwitchHandoff(job) {
  if (!job || job.reason !== 'activated') return false;
  if (!switchHandoffAt || switchHandoffUsed) return false;
  if (switchHandoffWindow !== job.windowId) return false;
  return Date.now() - switchHandoffAt <= SWITCH_HANDOFF_MS;
}

/* ────────────────────────────────────────────────────────────────────────────
 * What moment of the page a preview is allowed to show (settings.previewMoment)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Where the reader is on the page, read from the page itself.
 *
 * `chrome.scripting.executeScript` is the only way to learn a scroll offset — no
 * `tabs` field carries it — and it is cheap enough for the capture path: measured at
 * 5 ms on the first call into a tab and 1 ms after that, against a capture the limiter
 * already spaces 1100 ms apart.
 *
 * Anything that refuses (a PDF viewer, a withheld origin, a tab that navigated while
 * we asked) reports `known: false`, and the caller treats an unknown position as "not
 * at the top but not worth protecting" — a preview the reader can see beats a correct
 * refusal to take one.
 *
 * The timeout is load-bearing, not defensive. `runJob` is strictly serial, so anything
 * that blocks here blocks every pending capture behind it, and a tab that is mid
 * navigation can leave `executeScript` waiting for a frame for seconds: measured
 * without the bound, the contended two-window case went from a 1456 ms worst case to
 * 14676 ms against a 6700 ms budget (tests/specs/18-latency.spec.js).
 *
 * @param {number} tabId
 * @returns {Promise<{known: boolean, atTop: boolean, y: number}>}
 */
async function viewportPosition(tabId) {
  try {
    const [hit] = await withTimeout(chrome.scripting.executeScript({
      target: { tabId },
      func: () => Math.round(window.scrollY || document.documentElement.scrollTop || 0),
    }), PREVIEW_SCROLL_TIMEOUT_MS);
    const y = typeof hit?.result === 'number' ? hit.result : NaN;
    if (!Number.isFinite(y)) return { known: false, atTop: false, y: -1 };
    return { known: true, atTop: y <= PREVIEW_TOP_EPSILON_PX, y };
  } catch {
    return { known: false, atTop: false, y: -1 };
  }
}

/**
 * Gathers what `decidePreview` needs and applies its answer.
 *
 * The policy itself is in `common/preview-moment.js` with no Chrome in it, because
 * every combination of mode, stored record and answer — including the answers that
 * never arrive — is worth pinning down in a unit test.
 *
 * The page is only asked BEFORE the capture when its answer can change the decision,
 * which is when a protected top-of-page record already exists. Otherwise the capture
 * happens either way and only the record's flag depends on the answer, so `runJob`
 * resolves it alongside `captureVisibleTab` where it costs no wall-clock time.
 *
 * @param {{moment: string, tabId: number, key: string, reason: string, manual: boolean}} a
 * @returns {Promise<{ok: boolean, why?: string, atTop?: boolean|string}>}
 */
async function previewMomentVerdict({ moment, tabId, key, reason, manual }) {
  if (moment === 'interval') return decidePreview({ moment, reason, manual, held: null, position: null });

  const held = await getThumb(key);
  const needsAnswer = moment === 'top' && held && held.atTop === true;
  const position = needsAnswer ? await viewportPosition(tabId) : null;
  return decidePreview({ moment, reason, manual, held, position });
}


/** Records a capture ATTEMPT (successful or rejected) against the limiter. */
function noteCall(windowId, at, reason) {
  recentCalls.push(at);
  if (recentCalls.length > CALL_WINDOW_MAX) recentCalls.splice(0, recentCalls.length - CALL_WINDOW_MAX);
  lastCallAt = Math.max(lastCallAt, at);
  lastCallByWindow.set(windowId, at);
  if (reason === 'before-switch') {
    switchHandoffAt = at;
    switchHandoffWindow = windowId;
    switchHandoffUsed = false;
  } else {
    // Any other call closes the handoff: the pair has to be adjacent to stay
    // inside one second's worth of budget.
    switchHandoffAt = 0;
    switchHandoffWindow = null;
    switchHandoffUsed = true;
  }
}

/**
 * Called immediately before captureVisibleTab, after every other await, so the
 * reservation cannot be invalidated by another awaited step.
 */
async function reserveSlot(job) {
  await hydrate();
  const windowId = job.windowId;
  for (;;) {
    // Re-evaluated each pass: another job may have closed the handoff meanwhile.
    const wait = nextSlotAt(isSwitchHandoff(job)) - Date.now();
    if (!(wait > 0)) break;
    await sleep(Math.min(wait, 2000));
  }
  if (isSwitchHandoff(job)) switchHandoffUsed = true;
  noteCall(windowId, Date.now(), job.reason);
  void persistCaptureState(); // fire and forget; never awaited before the API call
}

/** A rejected call ALSO consumed the bucket (measured): charge the limiter for it. */
function noteQuotaRejection(windowId) {
  const at = Date.now();
  noteCall(windowId, at, 'quota-rejected');
  // Measured recovery is ~1.2 s from the REJECTED call, which is longer than the
  // ordinary spacing; hold everything until then rather than only this job.
  quotaFloorAt = Math.max(quotaFloorAt, at + QUOTA_RETRY_MS);
  void persistCaptureState();
}

/** Answers a pending `before-switch` request exactly once. */
function settleJob(job, capturedAt) {
  if (!job || job.resolved) return;
  job.resolved = true;
  if (typeof job.onCaptured === 'function') {
    const resolve = job.onCaptured;
    job.onCaptured = null;
    try {
      resolve(capturedAt ?? null);
    } catch {
      /* ignore */
    }
  }
}

/** Cancels a job that will never run (queue eviction, window closed). */
function cancelJob(job) {
  if (!job) return;
  job.cancelled = true;
  settleJob(job, null);
}

/** A retry re-enters through enqueue(), so the serial invariant and spacing still hold. */
function requeue(job, delayMs) {
  job.requeued = true;
  setTimeout(() => {
    job.requeued = false;
    if (job.cancelled) {
      settleJob(job, null);
      return;
    }
    enqueue(job);
  }, Math.max(0, delayMs));
}

/* ────────────────────────────────────────────────────────────────────────────
 * Broadcast helpers
 * ──────────────────────────────────────────────────────────────────────────── */

/** `vt/thumb-failed` is never broadcast with a null urlKey (A4). */
function broadcastFailure(job, key, reason, retryable) {
  diag.failed(reason);
  if (!key) return;
  broadcast({
    type: TYPE.THUMB_FAILED,
    urlKey: key,
    tabId: job.tabId,
    windowId: job.windowId,
    reason,
    retryable,
  });
}

function dropSilently(reason) {
  diag.skipped(reason);
}

/* ────────────────────────────────────────────────────────────────────────────
 * The capture job (§7.4 as amended by A4/A5/A6/A7)
 * ──────────────────────────────────────────────────────────────────────────── */

async function runJob(job) {
  const { windowId, tabId, reason } = job;
  await hydrate();

  if (Date.now() - job.startedAt > JOB_MAX_MS) {
    broadcastFailure(job, null, 'timeout', true);
    return;
  }

  // 1 — never undefined, never the "current window" sentinel (A3/A4).
  if (!Number.isInteger(windowId) || windowId < 0) return dropSilently('bad-window');

  // 2 — the tab must still exist.
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return dropSilently('gone');
  }

  const url = displayUrlOf(tab);
  const key = urlKey(url);
  rememberTabKey(tabId, key);

  // 3a
  if (!tab.active || tab.windowId !== windowId) return dropSilently('not-active');
  // 3b
  const settings = await loadSettings();
  if (settings.showThumbnails === false) return dropSilently('thumbnails-off');
  // 3c — incognito is never captured (privacy).
  if (tab.incognito) {
    broadcastFailure(job, key, 'excluded', false);
    return;
  }
  // 3d — window type and minimized state.
  let win;
  try {
    win = await chrome.windows.get(windowId);
  } catch {
    return dropSilently('gone');
  }
  if (win.type !== 'normal') return dropSilently('window-type');
  if (win.state === 'minimized') {
    broadcastFailure(job, key, 'minimized', true);
    return;
  }
  // 3f — a discarded/frozen tab has no live view to read back.
  if (tab.discarded || tab.frozen === true) {
    broadcastFailure(job, key, 'discarded', true);
    return;
  }
  // 3g — nothing committed yet: re-check later, never classify, never store a null key.
  if (key === null || tab.status !== 'complete') {
    const attempts = (recheckCount.get(tabId) ?? 0) + 1;
    if (attempts > LOADING_MAX_RECHECKS) {
      recheckCount.delete(tabId);
      return dropSilently('never-committed');
    }
    recheckCount.set(tabId, attempts);
    schedule({ windowId, tabId, reason: 'complete', delay: LOADING_RECHECK_MS, followUp: true });
    return;
  }
  // 3h — classification, before any quota token is spent.
  const cls = classifyUrl(url, {
    excludedHosts: settings.excludedHosts ?? [],
    fileAccess,
    ownOrigin: ownOrigin(),
  });
  if (cls === 'excluded') {
    broadcastFailure(job, key, 'excluded', false);
    return;
  }
  if (cls === 'restricted') {
    broadcastFailure(job, key, 'restricted', false);
    rememberRestricted(key, 'restricted');
    return;
  }
  const now = Date.now();
  const manual = reason === 'manual-refresh';
  // 3i
  if (policyDisabledUntil > now) {
    broadcastFailure(job, key, 'policy', false);
    return;
  }
  // 3j — a recently withheld origin (A7); recoverable, so it expires.
  if (!manual && noHostAccessFresh(url)) return dropSilently('no-host-access');
  // 3k
  if (!manual && restrictedFresh(key)) return dropSilently('restricted-cached');
  // 3l
  if (settings.captureWhenPanelClosed === false && !manual && !(await panels.isPanelOpen(windowId))) {
    return dropSilently('panel-closed');
  }
  // 3m
  if (!manual && (captureFailures[tabId]?.nextAllowedAt ?? 0) > now) return dropSilently('backoff');
  const exempt = EXEMPT_REASONS.has(reason) || job.exempt === true;
  // 3n
  if (!exempt && (byTab[tabId] ?? 0) + PER_TAB_MIN_INTERVAL_MS > now) return dropSilently('per-tab-interval');
  // 3o
  const windowRecord = byWindow[windowId];
  if (
    !exempt &&
    windowRecord &&
    windowRecord.urlKey === key &&
    (windowRecord.capturedAt ?? 0) + SAME_URL_MIN_INTERVAL_MS > now
  ) {
    return dropSilently('same-url');
  }

  // 3p — which moment of the page this preview is allowed to show. Last of the free
  // checks: everything above is cheaper, and this one may ask the page a question.
  const moment = normalizePreviewMoment(settings.previewMoment);
  const verdict = await previewMomentVerdict({ moment, tabId, key, reason, manual });
  if (!verdict.ok) return dropSilently(verdict.why ?? 'preview-moment');
  let atTop = verdict.atTop;

  // 4 / 5 / 6 — reserve the global slot, then call Chrome.
  const genAtStart = gen.get(windowId) ?? 0;
  await reserveSlot(job);

  // Re-check 3l now that the slot is held. reserveSlot() blocks for up to
  // MIN_CALL_SPACING_MS, and the panel can close inside that window, so a job that was
  // admissible when it was dequeued would otherwise still screenshot the page.
  // `captureWhenPanelClosed: false` means "no capture while no panel is open", which has
  // to hold at the moment of the call. Re-reading it here costs one already-reserved slot
  // in the rare case it fires, which is the correct trade against an unwanted capture.
  if (settings.captureWhenPanelClosed === false && !manual && !(await panels.isPanelOpen(windowId))) {
    return dropSilently('panel-closed');
  }

  // Started before the capture is awaited so the two overlap; `viewportPosition` never
  // rejects, so this cannot become an unhandled rejection if the capture throws.
  const pendingPosition = atTop === AT_TOP_PENDING ? viewportPosition(tabId) : null;

  let dataUrl;
  try {
    dataUrl = await withTimeout(chrome.tabs.captureVisibleTab(windowId, CAPTURE_OPTS), CAPTURE_TIMEOUT_MS);
  } catch (error) {
    await handleCaptureError(job, key, url, error);
    return;
  }
  if (pendingPosition) atTop = (await pendingPosition).atTop;

  const capturedAt = Date.now();
  settleJob(job, capturedAt); // A12: `before-switch` resolves as soon as the call returns

  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    noteFailure(tabId, 'readback');
    broadcastFailure(job, key, 'readback', true);
    return;
  }

  // 5 (postcheck) — the image must still belong to this tab.
  if (!(await postcheckPasses(job, key, genAtStart))) {
    if (!job.postcheckRetried) {
      job.postcheckRetried = true;
      job.exempt = true; // the freshness guards must not drop the re-check
      requeue(job, DELAY_MS.retry ?? 1200);
    } else {
      dropSilently('postcheck');
    }
    return;
  }

  // 6–8 — decode, crop, downscale, store, broadcast.
  try {
    await storeThumbnail(job, { tab, url, key, capturedAt, dataUrl, atTop });
  } catch (e) {
    log.warn('capture: encode/store failed', e);
    diag.setLastError(String(e?.message ?? e));
    noteFailure(tabId, 'readback');
    broadcastFailure(job, key, 'readback', true);
  }
}

async function postcheckPasses(job, key, genAtStart) {
  const { windowId, tabId } = job;
  let after;
  try {
    after = await chrome.tabs.get(tabId);
  } catch {
    return false;
  }
  if (!after.active || after.windowId !== windowId || after.status !== 'complete') return false;
  if (urlKey(displayUrlOf(after)) !== key) return false;
  try {
    const active = await chrome.tabs.query({ active: true, windowId });
    if (active?.[0]?.id !== tabId) return false;
  } catch {
    return false;
  }
  return (gen.get(windowId) ?? 0) === genAtStart;
}

/** Steps 6–9: decode + crop + downscale, write the record, tell the panels. */
async function storeThumbnail(job, { tab, url, key, capturedAt, dataUrl, atTop }) {
  const { windowId, tabId, reason } = job;
  const { blob, uniform, avgColor } = await encodeThumbnail(dataUrl);

  const record = {
    urlKey: key,
    url,
    title: tab.title ?? '',
    capturedAt,
    lastUsedAt: capturedAt,
    width: THUMB_W,
    height: THUMB_H,
    bytes: blob.size,
    blob,
    avgColor,
    uniform,
    tabId,
    windowId,
    // Whether this picture is of the top of the page. `undefined` in the modes that
    // never ask, so an old record cannot masquerade as a protected top-of-page shot.
    atTop: atTop === true ? true : (atTop === false ? false : undefined),
  };
  await putThumb(record);

  byWindow[windowId] = { tabId, urlKey: key, capturedAt };
  noteTabCaptured(tabId, capturedAt);
  void persistCaptureState();
  resetFailures(tabId);
  resetRecheckCount(tabId);
  forgetRestricted(key); // a successful capture proves the page is not restricted
  diag.ok();

  broadcast({
    type: TYPE.THUMB_UPDATED,
    urlKey: key,
    tabId,
    windowId,
    capturedAt,
    width: THUMB_W,
    height: THUMB_H,
    uniform,
  });

  // 9 — a flat frame usually means the page had not painted yet: look once more.
  if (uniform && !job.isUniformRecheck && reason !== 'manual-refresh') {
    diag.recheck();
    schedule({
      windowId,
      tabId,
      reason: 'uniform-recheck',
      delay: DELAY_MS['uniform-recheck'] ?? 1500,
      isUniformRecheck: true,
      exempt: true, // the freshness guards would otherwise drop the re-check itself
      followUp: true, // …but it must not evict the capture of a tab switched to meanwhile
    });
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Image pipeline (§7.4 steps 6–9, §7.6) — all worker-native
 * ──────────────────────────────────────────────────────────────────────────── */

async function encodeThumbnail(dataUrl) {
  const sourceBlob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(sourceBlob, { resizeWidth: THUMB_W, resizeQuality: 'high' });
  const canvas = new OffscreenCanvas(THUMB_W, THUMB_H);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  const bitmapHeight = bitmap.height; // read BEFORE close(): a closed bitmap reports 0×0
  if (bitmapHeight >= THUMB_H) {
    ctx.drawImage(bitmap, 0, 0); // TOP crop, no stretch: the page's own top edge, never squashed
  } else {
    // Viewport wider than 8:3 (rare): cover from the top-left corner.
    const sliceWidth = Math.max(1, Math.round((bitmapHeight * THUMB_W) / THUMB_H));
    ctx.drawImage(bitmap, 0, 0, sliceWidth, bitmapHeight, 0, 0, THUMB_W, THUMB_H);
  }
  bitmap.close(); // nothing reads the bitmap after this point
  const { uniform, avgColor } = analyze(canvas);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: THUMB_JPEG_QUALITY });
  return { blob, uniform, avgColor };
}

/**
 * §7.6 — a 32×12 downsample decides whether the capture is a single flat colour
 * (a page that has not painted yet) and yields the average colour the panel paints
 * behind the <img> while it decodes.
 */
export function analyze(canvas) {
  const small = new OffscreenCanvas(32, 12);
  const ctx = small.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, 32, 12);
  const { data } = ctx.getImageData(0, 0, 32, 12);
  let minR = 255, maxR = 0, sumR = 0;
  let minG = 255, maxG = 0, sumG = 0;
  let minB = 255, maxB = 0, sumB = 0;
  const pixels = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
    if (g < minG) minG = g;
    if (g > maxG) maxG = g;
    if (b < minB) minB = b;
    if (b > maxB) maxB = b;
    sumR += r; sumG += g; sumB += b;
  }
  return {
    uniform: maxR - minR < 8 && maxG - minG < 8 && maxB - minB < 8,
    avgColor: [Math.round(sumR / pixels), Math.round(sumG / pixels), Math.round(sumB / pixels)],
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Error handling (§7.5 as amended by A1/A2/A7)
 * ──────────────────────────────────────────────────────────────────────────── */

const TIMEOUT_MARKER = 'vt:capture-timeout';

function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(TIMEOUT_MARKER)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer != null) clearTimeout(timer);
  });
}

async function handleCaptureError(job, key, url, error) {
  const { windowId, tabId } = job;
  const message = String(error?.message ?? error ?? '');
  diag.setLastError(message);

  let cls = message === TIMEOUT_MARKER ? 'timeout' : classifyCaptureError(message);

  // A7b — the same Chromium string means two different things depending on the URL.
  if (cls === 'host-access') {
    const scheme = schemeOf(url);
    cls = scheme === 'http:' || scheme === 'https:' || scheme === 'file:' ? 'no-host-access' : 'restricted';
  }

  switch (cls) {
    case 'quota': {
      noteQuotaRejection(windowId);
      diag.quotaRejection();
      if (job.quotaTries < QUOTA_MAX_RETRIES) {
        job.quotaTries += 1;
        // Re-enter immediately and let `reserveSlot` do the waiting. The measured
        // ~1.2 s recovery is ALREADY held by `quotaFloorAt`, which `nextSlotAt`
        // enforces as a hard floor for every job, so sleeping QUOTA_RETRY_MS here
        // too spent the same recovery twice, end to end: the job sat outside the
        // queue for 1300 ms and only then began waiting for a slot. Measured on the
        // panel-rapid switch path, that double count put the worst preview at
        // 4194 ms against a ~1100 ms median. Waiting inside reserveSlot instead
        // keeps the recovery exactly once and keeps the limiter authoritative in
        // one place.
        requeue(job, 0);
        return;
      }
      broadcastFailure(job, key, 'quota', true); // not counted in captureFailures
      return;
    }
    case 'readback':
    case 'timeout': {
      if (job.tries < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[job.tries];
        job.tries += 1;
        requeue(job, delay);
        return;
      }
      noteFailure(tabId, cls);
      broadcastFailure(job, key, cls, true);
      return;
    }
    case 'gone': {
      // The tab or the window disappeared while we were waiting for the slot.
      dropSilently('gone');
      return;
    }
    case 'dragging': {
      if (job.dragTries < DRAG_MAX_RETRIES) {
        job.dragTries += 1;
        requeue(job, DRAG_RETRY_MS);
        return;
      }
      diag.skipped('dragging');
      return;
    }
    case 'restricted': {
      rememberRestricted(key, 'restricted');
      broadcastFailure(job, key, 'restricted', false);
      return;
    }
    case 'no-host-access': {
      const granted = await refreshHostAccess();
      const origin = rememberNoHostAccess(url);
      await persistHostAccess();
      broadcast({ type: TYPE.HOST_ACCESS, hostAccess: granted, origin, at: Date.now() });
      broadcastFailure(job, key, 'no-host-access', true);
      return;
    }
    case 'policy': {
      policyDisabledUntil = Date.now() + POLICY_BACKOFF_MS; // browser-wide, not per URL
      void persistPolicy();
      broadcast({ type: TYPE.POLICY_CHANGED, disabledUntil: policyDisabledUntil });
      broadcastFailure(job, key, 'policy', false);
      return;
    }
    case 'unknown':
    default: {
      // Anything we do not recognise gets one retry, then a visible (retryable) failure —
      // never a silent disappearance.
      if (job.tries < UNKNOWN_MAX_RETRIES) {
        job.tries += 1;
        requeue(job, RETRY_DELAYS_MS[0] ?? 1200);
        return;
      }
      noteFailure(tabId, 'unknown');
      broadcastFailure(job, key, 'unknown', true);
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Requests from the panel (§6.1, A12)
 * ──────────────────────────────────────────────────────────────────────────── */

export async function requestCapture({ windowId, tabId, reason }) {
  await hydrate();
  if (!Number.isInteger(windowId) || windowId < 0 || !Number.isInteger(tabId)) {
    return { accepted: false, reason: 'not-active' };
  }
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { accepted: false, reason: 'not-active' };
  }
  if (!tab.active || tab.windowId !== windowId) return { accepted: false, reason: 'not-active' };
  if (policyDisabledUntil > Date.now()) return { accepted: false, reason: 'policy' };

  const url = displayUrlOf(tab);
  const key = urlKey(url);

  if (reason === 'manual-refresh') {
    // Bypasses the freshness skips and the sticky restricted memory (§6.1, A8.3).
    forgetRestricted(key);
    resetFailures(tabId);
    resetRecheckCount(tabId);
    schedule({ windowId, tabId, reason, delay: 0 });
    return { accepted: true };
  }

  if (reason === 'before-switch') {
    const settings = await loadSettings();
    if (settings.captureBeforeSwitch === false) return { accepted: false, reason: 'disabled' };
    // Asked of the limiter that will actually serve the job, so the panel is never
    // told "busy" for a slot that is in fact free — and, more importantly, is never
    // made to hold the click for a slot that is not.
    const wait = Math.max(0, nextSlotAt(false) - Date.now());
    if (wait > SWITCH_CAPTURE_MAX_WAIT_MS) {
      diag.skipped('busy');
      return { accepted: false, reason: 'busy' };
    }
    const job = makeJob({ windowId, tabId, reason, priority: true });
    const captured = new Promise((resolve) => {
      job.onCaptured = resolve;
    });
    enqueue(job);
    const capturedAt = await Promise.race([captured, sleep(SWITCH_INLINE_TIMEOUT_MS).then(() => null)]);
    return { accepted: true, capturedAt };
  }

  // 'visible-missing' and anything else: normal scheduling with the cheap guards applied
  // up front so the panel gets a useful answer instead of silence.
  if (restrictedFresh(key)) return { accepted: false, reason: 'restricted' };
  if ((captureFailures[tabId]?.nextAllowedAt ?? 0) > Date.now()) return { accepted: false, reason: 'backoff' };
  schedule({ windowId, tabId, reason: reason ?? 'visible-missing' });
  return { accepted: true };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Read-only accessors (handlers.js / alarms.js / diagnostics)
 * ──────────────────────────────────────────────────────────────────────────── */

export function getPolicyDisabledUntil() {
  return policyDisabledUntil;
}

export function getHostAccess() {
  return hostAccess;
}

export function getFileAccess() {
  return fileAccess;
}

export function getQueueState() {
  const lastByWindow = {};
  for (const [windowId, at] of lastCallByWindow) lastByWindow[windowId] = at;
  return {
    queueLength: queue.length,
    pendingWindows: [...pending.keys()],
    lastCallAt,
    lastCallByWindow: lastByWindow,
  };
}

/** Maintenance alarm (§7.7): drop stale per-tab, per-url and per-origin memory. */
export async function pruneVolatileState(liveTabIds) {
  await hydrate();
  const now = Date.now();
  let failuresChanged = false;
  for (const tabId of Object.keys(captureFailures)) {
    if (!liveTabIds.has(Number(tabId))) {
      delete captureFailures[tabId];
      failuresChanged = true;
    }
  }
  let restrictedChanged = false;
  for (const [key, entry] of Object.entries(restrictedUrlKeys)) {
    if (now - (entry?.at ?? 0) > RESTRICTED_TTL_MS) {
      delete restrictedUrlKeys[key];
      restrictedChanged = true;
    }
  }
  let originsChanged = false;
  for (const [origin, until] of Object.entries(noHostAccessOrigins)) {
    if (!(until > now)) {
      delete noHostAccessOrigins[origin];
      originsChanged = true;
    }
  }
  let stateChanged = false;
  for (const tabId of Object.keys(byTab)) {
    if (!liveTabIds.has(Number(tabId))) {
      delete byTab[tabId];
      stateChanged = true;
    }
  }
  const promises = [];
  if (failuresChanged) promises.push(persistFailures());
  if (restrictedChanged) promises.push(persistRestricted());
  if (originsChanged) promises.push(persistHostAccess());
  if (stateChanged) promises.push(persistCaptureState());
  await Promise.all(promises);
}

/** Test hook / settings drawer support: forget every "no preview" memory. */
export async function clearNegativeMemory() {
  await hydrate();
  restrictedUrlKeys = {};
  noHostAccessOrigins = {};
  captureFailures = {};
  await Promise.all([persistRestricted(), persistHostAccess(), persistFailures()]);
}
