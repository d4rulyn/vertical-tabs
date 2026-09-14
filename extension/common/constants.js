/**
 * Shared constants for the service worker, the side panel and the welcome page.
 *
 * This module is PURE DATA (plus a few pure string helpers): it never touches
 * `chrome.*` at import time, so `node --test` can import it and, transitively,
 * every other pure module (`url-key.js`, `settings-schema.js`, `capture-errors.js`).
 *
 * Sources: spec.md §7.1 / §5 / §9 / §12, spec-addendum.md A1, A2, A3, A6, A7,
 * A8, A9, A11, A12, A13. Where the addendum amends spec.md, the addendum value
 * is used and the change is noted inline.
 */

/* ── Thumbnails ───────────────────────────────────────────────────────────── */

/** Stored thumbnail size in device-independent pixels (spec §5.1, §7.4). */
export const THUMB_W = 640;
export const THUMB_H = 240;
/** 640 / 240 — the top-cropped preview aspect ratio used by CSS as well. */
export const THUMB_ASPECT = 8 / 3;

/** Options passed to `chrome.tabs.captureVisibleTab` (spec §7.1). */
export const CAPTURE_OPTS = { format: 'jpeg', quality: 80 };
/** Quality of the re-encoded 640x240 thumbnail (spec §7.1). */
export const THUMB_JPEG_QUALITY = 0.72;

/** Uniform-frame analysis (spec §7.6): sample size and per-channel span limit. */
export const ANALYZE_W = 32;
export const ANALYZE_H = 12;
export const UNIFORM_SPAN_MAX = 8;

/* ── Capture scheduling ───────────────────────────────────────────────────── */

/**
 * Debounce applied between the triggering event and the capture attempt, keyed
 * by `reason` (spec-addendum A1 — supersedes the spec.md §7.1 table).
 * Reasons absent from this map fall back to DEFAULT_DELAY_MS.
 *
 * `activated` is 300, not the 450 of A1. Measured (Chromium 151, headless, six
 * repetitions at each of 0/30/60/100/150/200/300/450 ms after
 * `tabs.update({active:true})`): the frame `captureVisibleTab` returns already
 * belongs to the INCOMING tab at every delay including 0 ms — 48/48 captures
 * showed the incoming tab's colour, 0 showed the outgoing tab's. 300 ms is kept
 * as headroom for a real compositor swap (a few frames) on a machine slower than
 * the test container; the delay is the single largest fixed cost on the path the
 * user complained about, and it is paid on every switch. If a user ever reports a
 * preview showing the PREVIOUS tab, this is the number to raise back to 450.
 */
export const DELAY_MS = {
  activated: 300,
  complete: 350,
  url: 1200,
  replaced: 350,
  focus: 500,
  'panel-opened': 100,
  startup: 1500,
  refresh: 0,
  'manual-refresh': 0,
  'before-switch': 0,
  'visible-missing': 100,
  retry: 1200,
  'uniform-recheck': 1500,
};
/** Fallback for reasons not listed in DELAY_MS (e.g. 'permissions', A7d). */
export const DEFAULT_DELAY_MS = 300;

/**
 * Ordinary minimum spacing between any two `captureVisibleTab` calls (A1/A2), and
 * the invariant tests/specs/12-multiwindow.spec.js asserts. Every call obeys it
 * except the switch handoff described under CALL_MIN_GAP_MS below.
 *
 * It is not, however, the whole story. A1 read "only ~1 capture lands per
 * second" out of a BURST measurement (three simultaneous calls -> ok, err, err),
 * which measures how many calls may be in flight at once, not the sustained rate.
 * Re-measured (Chromium 151, same container, serialized calls at a fixed spacing):
 *
 *     spacing  calls  quota rejections
 *      500 ms    25    2
 *      550 ms    60    0
 *      600 ms    85    1
 *      650 ms    60    0
 *      700 ms    25    0
 *      750 ms   180    1
 *      800-1100  25    0  (each)
 *   two windows interleaved 375 ms apart: 13/40, pattern `..X..X..X`
 *
 * The repeating "two land, the third is rejected" pattern is a limit of roughly
 * TWO calls per second for the whole extension, which is also what the error name
 * (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND) says. The two constants below spend
 * that budget without ever putting a third call inside one second.
 */
export const MIN_CALL_SPACING_MS = 1100;

/**
 * The switch handoff (`capture.js` `isSwitchHandoff`).
 *
 * When the user clicks a card, the panel asks the worker to capture the tab being
 * LEFT while it is still on screen (A12) and only then switches. Under a flat
 * 1100 ms spacing the capture of the tab the user just moved TO had to wait behind
 * it, which measured 1200 ms to a stored preview against 568 ms for the same switch
 * with no outgoing capture — the largest single component of the lag reported.
 *
 * Those two captures are one user action, and Chrome's budget has room for both
 * inside one second, so the activation that follows a `before-switch` may take the
 * second slot after only CALL_MIN_GAP_MS. After any two calls, nothing runs until
 * CALL_WINDOW_MS from the FIRST of them, so any three consecutive calls span at
 * least 1600 ms and at most two can ever fall inside one second — the property
 * Chrome's quota cares about — no matter how the scheduler slips.
 *
 * Verified with the exact emitted pattern (a pair 450 ms apart, the next pair
 * 1600 ms after the first of the previous one): 0 quota rejections in 60 calls, and
 * the neighbouring 400/1500 shape 0 in 180 calls over three rounds and two windows.
 * A probe run whose own timer slipped and put three calls inside one second was
 * rejected at once, which is why the limiter keys off recorded call times rather
 * than planned ones.
 *
 * `CALL_WINDOW_MAX` is how many call timestamps the limiter has to remember; it is
 * 2 because the rule above only ever looks at the previous two calls.
 */
export const CALL_MIN_GAP_MS = 450;
export const CALL_WINDOW_MS = 1600;
export const CALL_WINDOW_MAX = 2;

/** Measured recovery after a REJECTED call is ~1.2 s (spec-addendum A1). */
export const QUOTA_RETRY_MS = 1300;
export const QUOTA_MAX_RETRIES = 3;

export const CAPTURE_TIMEOUT_MS = 6000;
/** readback / timeout retries (spec-addendum A1). */
export const RETRY_DELAYS_MS = [1200, 2400];
export const UNKNOWN_MAX_RETRIES = 1;
export const DRAG_RETRY_MS = 1200;
export const DRAG_MAX_RETRIES = 3;
/** Hard wall-clock cap per job including every wait; then dropped as 'timeout'. */
export const JOB_MAX_MS = 20000;

export const BACKOFF_AFTER_FAILURES = 3;
export const BACKOFF_MS = 30000;
export const POLICY_BACKOFF_MS = 10 * 60000;

/** Per-tab guard for non-exempt reasons (spec-addendum A6). */
export const PER_TAB_MIN_INTERVAL_MS = 2000;
/** Same-URL guard for the same window (spec §7.4 step 3o). */
export const SAME_URL_MIN_INTERVAL_MS = 5000;
/** `windows.onFocusChanged` only recaptures when the last one is older (spec §7.2). */
export const FRESH_ON_FOCUS_MS = 10000;
/** The refresh alarm only recaptures when the last one is older (spec §7.7). */
export const REFRESH_STALE_MS = 20000;
/** Windows served by one refresh tick (spec-addendum A3). */
export const REFRESH_MAX_WINDOWS = 4;

/** Uncommitted navigation recheck (spec §7.1, spec-addendum A4 step 3g). */
export const LOADING_RECHECK_MS = 500;
export const LOADING_MAX_RECHECKS = 6;

/** Longest the SW may make the panel wait for a 'before-switch' capture (A12). */
/**
 * Width of the detached panel window.
 *
 * Chrome pins the side panel's minimum inner width at 360 px and gives extensions no
 * way to change it, but a window this extension creates itself has no such floor —
 * which is the whole point of detaching. 260 px holds a 160 px preview plus the
 * card's chrome with room to spare.
 */
export const POPOUT_WIDTH = 260;

/**
 * How far down a page still counts as "the top", in CSS pixels, for
 * `previewMoment: 'top'`. A few pixels of slack absorbs a sticky header settling and
 * anchor jumps that land a pixel or two in; anything more is a reader who has
 * scrolled, and their position is not what the preview should keep.
 */
export const PREVIEW_TOP_EPSILON_PX = 8;

/**
 * How long a scroll-position question may take before the answer is treated as unknown.
 *
 * `runJob` is strictly serial, so a slow answer blocks every capture behind it, and
 * `executeScript` into a tab that is mid-navigation can wait for a frame for seconds.
 * Measured: removing this bound took the contended two-window case from a 1456 ms worst
 * case to 14676 ms against a 6700 ms budget.
 */
export const PREVIEW_SCROLL_TIMEOUT_MS = 250;

export const SWITCH_CAPTURE_MAX_WAIT_MS = 300;
/** Hard ceiling the panel puts on the same round trip so a click never lags (A12). */
export const SWITCH_CAPTURE_UI_TIMEOUT_MS = 400;

/** Ready-job queue depth (spec §7.3). */
export const QUEUE_MAX = 8;
/** `captureState.byTab` LRU cap (spec-addendum A6). */
export const CAPTURE_BY_TAB_MAX = 200;

/**
 * Reasons that bypass the per-tab and same-URL freshness guards
 * (spec-addendum A4). `capture.js` imports the Set; `isExemptReason()` is the
 * convenience reader.
 */
export const EXEMPT_REASONS = new Set([
  'activated',
  'manual-refresh',
  'panel-opened',
  'before-switch',
  'complete',
]);

/** @param {string} reason */
export function isExemptReason(reason) {
  return EXEMPT_REASONS.has(reason);
}

/**
 * Reasons whose target is the tab the user is looking at right now, as opposed to
 * batch work over windows they may not even be able to see. Used to order the
 * capture queue: a preview the user is waiting for must not sit behind four
 * refresh jobs, each of which costs a full rate-limit slot.
 */
export const INTERACTIVE_REASONS = new Set([
  'activated',
  'before-switch',
  'manual-refresh',
  'visible-missing',
  'panel-opened',
  'complete',
  'url',
  'replaced',
  'focus',
]);

/**
 * Queue rank, lowest first (`capture.js` `takeNextJob`).
 *  0 `before-switch` — now or never: the outgoing tab stops being visible the
 *    moment the switch lands, and the panel is holding the click for it.
 *  1 an interactive reason in the window the user last focused.
 *  2 an interactive reason in another window.
 *  3 background work (`refresh`, `startup`, `uniform-recheck`, `permissions`).
 *
 * @param {string} reason
 * @param {number} windowId
 * @param {number|null} focusedWindowId
 * @returns {0|1|2|3}
 */
export function queueRank(reason, windowId, focusedWindowId) {
  if (reason === 'before-switch') return 0;
  if (!INTERACTIVE_REASONS.has(reason)) return 3;
  return windowId === focusedWindowId ? 1 : 2;
}

/* ── Sticky "no preview" memory ───────────────────────────────────────────── */

/** FIFO cap of `storage.session.restrictedUrlKeys` (spec §7.1). */
export const RESTRICTED_KEYS_MAX = 500;
/** Restricted entries expire so a transient failure cannot pin a URL (A8). */
export const RESTRICTED_TTL_MS = 15 * 60000;
/** Withheld-host memory, per origin (spec-addendum A7c). */
export const NO_HOST_ACCESS_TTL_MS = 15 * 60000;
export const NO_HOST_ACCESS_MAX = 200;

/* ── Storage ──────────────────────────────────────────────────────────────── */

/** IndexedDB database holding the thumbnail blobs (spec §5.1). */
export const DB_NAME = 'vertical-tabs';
export const DB_VERSION = 1;
export const THUMB_STORE = 'thumbs';
export const IDX_LAST_USED = 'byLastUsedAt';
export const IDX_CAPTURED = 'byCapturedAt';

/** Maintenance prune budget (spec §7.1 / §7.8). */
export const PRUNE = {
  maxEntries: 1000,
  maxBytes: 120 * 1024 * 1024,
  maxAgeMs: 14 * 86400e3,
};

/** `chrome.storage.local` keys (spec §5.2). */
export const STORAGE_LOCAL = {
  /** Named tab sets the user saved on purpose (sessions widget). */
  sessions: 'sessions',
  /** Free text the scratchpad widget keeps. */
  scratchpad: 'scratchpad',
  settings: 'settings',
  hints: 'hints',
};

/** `chrome.storage.session` keys (spec §5.3 + spec-addendum A3, A7g). */
export const STORAGE_SESSION = {
  /** `<key>:<windowId>` → the id of the detached panel window for that window. */
  popoutWindow: 'popoutWindow',
  captureState: 'captureState',
  captureFailures: 'captureFailures',
  restrictedUrlKeys: 'restrictedUrlKeys',
  policyDisabledUntil: 'policyDisabledUntil',
  openPanels: 'openPanels',
  fileAccess: 'fileAccess',
  pendingFocusSearch: 'pendingFocusSearch',
  unreadTabs: 'unreadTabs',
  /** Tab ids the user has locked; see sidepanel/locks.js for why ids and why session. */
  lockedTabs: 'lockedTabs',
  diagnostics: 'diagnostics',
  hostAccessState: 'hostAccessState',
  noHostAccessOrigins: 'noHostAccessOrigins',
  lastFocusedWindowId: 'lastFocusedWindowId',
};

/** Shape of `chrome.storage.local.hints` (spec §5.2 + spec-addendum A7e). */
export const HINTS_DEFAULTS = {
  installedAt: 0,
  sidePositionHintDismissed: false,
  siteAccessBannerDismissedAt: 0,
};

/** Unread bookkeeping cap per window (spec-addendum A13). */
export const MAX_UNREAD_PER_WINDOW = 200;

/* ── Alarms ───────────────────────────────────────────────────────────────── */

export const ALARMS = { maintenance: 'vt-maintenance', refresh: 'vt-refresh' };
export const MAINTENANCE_PERIOD_MIN = 30;

/* ── Panel timings ────────────────────────────────────────────────────────── */

/** Thumbnail object-URL lifecycle and cache caps (spec-addendum A9). */
export const OBJECT_URL_GRACE_MS = 60000;
export const SWAP_REVOKE_MS = 2000;
export const MAX_CACHED_BLOBS = 300;
/** At most one 'visible-missing' request per tab per this interval (A9). */
export const ASK_INTERVAL_MS = 10000;
/** `IntersectionObserver` root margin for lazy thumbnail attachment (spec §8.5). */
export const THUMB_IO_ROOT_MARGIN = '400px';
/** `touchDisplayed()` throttle (spec-addendum A9). */
export const TOUCH_DISPLAYED_INTERVAL_MS = 30000;

/** `state.resync()` throttle (spec §8.2). */
export const RESYNC_THROTTLE_MS = 50;
/** Search input debounce (spec §9.4). */
export const SEARCH_DEBOUNCE_MS = 60;

/**
 * How many matches from other windows the panel lists at once.
 *
 * The cross-window section exists to answer "where did I leave that page", which a
 * handful of rows answers; a reader with 300 tabs matching "docs" is better served by
 * a narrower query than by 300 rows of DOM in a 360 px panel.
 */
export const OTHER_WINDOW_RESULTS_MAX = 40;

/**
 * How many links one paste may open at once.
 *
 * Opening a list is a single click with no undo, and every tab is a page load. Fifty is
 * generous for a reading list and small enough that a mis-paste of a whole document is
 * an annoyance rather than a stalled browser.
 */
export const BULK_OPEN_MAX = 50;
/** Text inputs in the settings drawer save debounced (spec §4.4). */
export const SETTINGS_TEXT_DEBOUNCE_MS = 400;
/** Toast lifetime (spec §9.8). */
export const TOAST_MS = 2500;
/** `tab-ops.js` retry on "Tabs cannot be edited right now" (spec §9.1). */
export const TAB_OPS_RETRY_MS = 300;
export const TAB_OPS_MAX_RETRIES = 3;
/** Drag auto-scroll (spec §9.2). */
export const DRAG_AUTOSCROLL_PX = 8;
export const DRAG_AUTOSCROLL_EDGE_PX = 40;
/** `pendingFocusSearch` is ignored when older than this (spec-addendum A15.8). */
export const PENDING_FOCUS_SEARCH_TTL_MS = 10000;
/** `sessions.getRecentlyClosed` maximum (spec §9.5). */
export const MAX_SESSION_RESULTS = 25;
/** Group-membership reconcile passes after a drop (spec §9.2 / Appendix A.2). */
export const DROP_RECONCILE_PASSES = 3;

/* ── Layout ───────────────────────────────────────────────────────────────── */

/** Chrome's hard minimum side-panel content width (spec §0.2). */
export const PANEL_MIN_WIDTH_PX = 360;
/** `grid-template-columns: repeat(auto-fill, minmax(158px, 1fr))` (A11). */
export const GRID_MIN_CARD_PX = 158;
/** Favicon size requested from the `_favicon` helper (spec §8.3). */
export const FAVICON_SIZE = 32;

/* ── URL keys ─────────────────────────────────────────────────────────────── */

/** `urlKey()` truncates its result to this many characters (spec §4.1). */
export const URL_KEY_MAX_LENGTH = 2048;

/** Path of the side-panel document, used by `isOwnPanelUrl()` (spec §4.1). */
export const PANEL_PATH = 'sidepanel/sidepanel.html';

/* ── URLs ─────────────────────────────────────────────────────────────────── */

/** Opened by the About section's `settingsReadme` link (spec-addendum A16). */
export const REPOSITORY_URL = 'https://github.com/d4rulyn/vertical-tabs';
/** Target of `sidePositionOpenSettings` (spec §9.7). */
export const CHROME_APPEARANCE_URL = 'chrome://settings/appearance';
/** Target of `shortcutsOpenSettings` (spec §9.6). */
export const CHROME_SHORTCUTS_URL = 'chrome://extensions/shortcuts';

/**
 * Target of `bannerSiteAccessOpen` (spec-addendum A7e).
 * @param {string} extensionId `chrome.runtime.id`
 * @returns {string}
 */
export function extensionDetailsUrl(extensionId) {
  return `chrome://extensions/?id=${extensionId}`;
}

/**
 * `chrome-extension://<id>/_favicon/?pageUrl=…&size=…` — the fallback favicon
 * source used by cards and by the closed-tabs list (spec §8.3, §9.5).
 * Touches `chrome` only when called, so importing this module stays pure.
 *
 * @param {string} pageUrl
 * @param {number} [size]
 * @returns {string} empty string when the `favicon` permission is unavailable
 */
export function faviconUrl(pageUrl, size = FAVICON_SIZE) {
  if (typeof pageUrl !== 'string' || pageUrl === '') return '';
  try {
    const base = chrome.runtime.getURL('/_favicon/');
    return `${base}?pageUrl=${encodeURIComponent(pageUrl)}&size=${size}`;
  } catch {
    return '';
  }
}
