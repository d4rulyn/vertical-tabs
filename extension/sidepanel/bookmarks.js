/**
 * The bookmark column — what the side column holds while `settings.railMode` is
 * `bookmarks`.
 *
 * READ-ONLY, with exactly one write: "bookmark the current tab". No rename, no delete,
 * no move, no reorder, no drag-and-drop with the tab list. That is a product decision,
 * not a limit of the API, and there is deliberately no dead code here for any of them.
 *
 * ── What this file owns and what it does not ────────────────────────────────
 * It fills `#bookmark-rail` and empties it again. It NEVER touches that element's
 * `hidden`: `tool-strip.js` sets it from `railMode`, so "is the column showing
 * bookmarks" has one answer in one place. A revoked permission therefore returns the
 * grant card — it does not silently rewrite the layout the user chose.
 *
 * ── The permission ──────────────────────────────────────────────────────────
 * `bookmarks` is OPTIONAL, so an update never disables an existing install. Three
 * measured facts shape everything below (.agent/probe-results.md, Probe 7 and 7b):
 *
 *   1. `permissions.request()` must be the first thing a click handler does, in the
 *      PANEL document. An `await` in front of it spends the user activation, and from
 *      the service worker it is rejected outright.
 *   2. The promise it returns stays PENDING for as long as Chrome's own bubble is
 *      unanswered. `permissions.onAdded` is what actually says "granted", ~5 ms after
 *      the fact, so the UI is driven from the event and not from the promise.
 *   3. After `permissions.remove()` `chrome.bookmarks` STAYS a live object whose every
 *      call throws `'bookmarks.getTree' is not available in this context.` So the gate
 *      is `permissions.contains()` plus `permissions.onRemoved`, never
 *      `if (chrome.bookmarks)`, and every call site catches that throw as a backstop.
 *
 * Because the service worker cannot register `bookmarks.on*` at startup while the
 * permission is ungranted, and this project registers `chrome.*` listeners only at the
 * worker's synchronous top level, the worker stays out of this feature completely:
 * every bookmark listener lives here, in the panel.
 *
 * ── Reading ─────────────────────────────────────────────────────────────────
 * `getChildren()` only. `getTree()` is never called: measured at 59 ms and 1 MB of JSON
 * on a 5 041-node tree, against 0.6–1.5 ms for one folder. One folder can still be big
 * — 5 000 children is 100 ms and 995 KB — so rows are appended in chunks of 150 behind
 * an `IntersectionObserver` sentinel.
 *
 * ── Why it belongs to a tab manager ─────────────────────────────────────────
 * Every bookmark URL is keyed with `urlKey()` against the panel's own tab model. A
 * bookmark whose page is already open gets an accent dot, and clicking it activates
 * that tab instead of opening a second copy of the same page. One Map lookup per row,
 * no permission, no I/O — and it is the thing a standalone bookmarks panel cannot do.
 */

import * as i18n from '../common/i18n.js';
import * as log from '../common/log.js';
import * as ops from './tab-ops.js';
import { urlKey } from '../common/url-key.js';
import { STORAGE_SESSION, faviconUrl, FAVICON_SIZE } from '../common/constants.js';

const t = (key, subs) => i18n.t(key, subs);

/* ── Tuning ──────────────────────────────────────────────────────────────── */

/** Rows appended per pass. Measured: one folder can hold 5 000 children. */
const CHUNK = 150;

/** A burst of bookmark events is one repaint, following `widgets/windows.js`. */
const REPAINT_DEBOUNCE_MS = 400;

/** The reader scrolls in bursts too; one `storage.session` write covers each. */
const VIEW_SAVE_DEBOUNCE_MS = 400;

/**
 * How long the in-panel prompt waits before offering a way round it. Measured: a real
 * grant lands in ~5 ms, so anything near this means Chrome's bubble was never answered
 * — it can be missed entirely when the panel does not have the window's attention.
 */
const GRANT_HINT_MS = 10000;

/**
 * The bookmark root. `chrome.bookmarks.ROOT_NODE_ID` says the same thing but is a
 * recent addition and `minimum_chrome_version` is 120, so the literal is what ships.
 */
const ROOT_ID = '0';

/** The permission this whole file is gated on. */
const NEEDS = Object.freeze({ permissions: ['bookmarks'] });

/* ── State ───────────────────────────────────────────────────────────────── */

const S = {
  /** @type {any} */ ctx: null,
  /** @type {HTMLElement|null} */ rail: null,
  /** `init()` has run. */ started: false,
  /**
   * `destroy()` has run. One-way: the document is going away, and anything still parked
   * on an `await` must NOT come back and register listeners on it. `phase` cannot say
   * this — a `start()` waiting on `contains()` is `'off'`, which is also the state the
   * column sits in for the whole of `tools` mode.
   */
  dead: false,
  /** @type {'off'|'grant'|'list'} what the column is showing right now. */ phase: 'off',
  /** Rising counter that makes an older, still-awaiting `start()` stand down. */ startSeq: 0,

  /** @type {string} the folder on screen. */ folderId: ROOT_ID,
  /** @type {any[]} its children, as `getChildren` returned them. */ nodes: [],
  /** How many of `nodes` have rows. */ rendered: 0,
  /** @type {string|null} the folder `path` was built for. */ pathId: null,
  /** @type {string} the folder the rows on screen belong to; `paint()` diffs on it. */ painted: '',
  /** @type {string[]} the breadcrumb, root first; the header's name is its last. */ path: [],
  /** @type {number} scrollTop waiting to be restored after the first chunk. */ pendingScroll: 0,
  /** Rising counter that makes a late `paint()` drop its result. */ paintToken: 0,

  /** @type {HTMLElement|null} */ head: null,
  /** @type {HTMLElement|null} */ title: null,
  /** @type {HTMLButtonElement|null} */ back: null,
  /** @type {HTMLButtonElement|null} */ add: null,
  /** @type {HTMLElement|null} */ list: null,
  /** @type {HTMLElement|null} */ empty: null,
  /** @type {HTMLElement|null} */ error: null,
  /** @type {HTMLButtonElement|null} */ more: null,
  /** @type {HTMLElement|null} */ pending: null,
  /** @type {HTMLElement|null} */ pendingText: null,
  /** @type {HTMLElement|null} */ escape: null,

  /** @type {IntersectionObserver|null} */ io: null,
  /** @type {Array<{ event: any, fn: Function }>} */ bound: [],
  repaintTimer: 0,
  viewTimer: 0,
  grantTimer: 0,
  /** @type {Function|null} */ offSettings: null,
  /** @type {Function|null} */ offRendered: null,
  /** @type {Function|null} */ onPermAdded: null,
  /** @type {Function|null} */ onPermRemoved: null,
};

/* ── Lifecycle ───────────────────────────────────────────────────────────── */

/**
 * Imported lazily by `sidepanel.js` the first time `railMode` is `bookmarks`, so a
 * profile that never asks for the column never pays for this file.
 *
 * @param {any} context the shared panel context
 * @returns {Promise<void>}
 */
export async function init(context) {
  if (S.started || S.dead) return;
  S.started = true;
  S.ctx = context || null;
  S.rail = document.getElementById('bookmark-rail');
  if (!S.rail) return;

  S.rail.addEventListener('scroll', onRailScroll, { passive: true });

  // The grant and the revoke both arrive as events. `onAdded` is the only reliable
  // "yes" (the request promise may never settle), and `onRemoved` is the only warning
  // before the API starts throwing.
  S.onPermAdded = (perms) => {
    if (!mentionsBookmarks(perms)) return;
    clearGrantTimer();
    void start();
  };
  S.onPermRemoved = (perms) => {
    if (!mentionsBookmarks(perms)) return;
    onLostPermission();
  };
  try {
    chrome.permissions.onAdded.addListener(S.onPermAdded);
    chrome.permissions.onRemoved.addListener(S.onPermRemoved);
  } catch (e) {
    log.warn('bookmarks permission events', e);
  }

  if (S.ctx && typeof S.ctx.subscribe === 'function') {
    S.offSettings = S.ctx.subscribe('settings', (settings) => void apply(settings));
    // The seven other tools already listen for this; here it is the cheapest possible
    // refresh of the open-tab dots — no bookmark is re-read.
    S.offRendered = S.ctx.subscribe('rendered', markOpenTabs);
  }

  await apply(S.ctx && typeof S.ctx.getSettings === 'function' ? S.ctx.getSettings() : null);
}

/**
 * Bring the column in line with `settings`. Called on every settings change, most of
 * which have nothing to do with this feature, so both branches are cheap no-ops once
 * the column is already in the right state.
 *
 * @param {any} settings
 * @returns {Promise<void>}
 */
async function apply(settings) {
  if (settings && settings.railMode === 'bookmarks') await start();
  else stop();
}

/**
 * Put the column on screen: the folder listing when the permission is there, the grant
 * card when it is not.
 * @returns {Promise<void>}
 */
async function start() {
  if (!S.rail || S.phase === 'list' || S.dead) return;
  // Two calls can be in flight at once: `permissions.onAdded` and a settings change can
  // land a millisecond apart and both get past the guard above while the first is parked
  // on `contains()`. Without this the column is built twice — and the first build's
  // sentinel is left in a live `IntersectionObserver`, holding a detached subtree for the
  // life of the panel. The newest call wins, so the column is built once, from the
  // freshest answer.
  const seq = (S.startSeq += 1);
  const granted = await contains();
  if (S.dead || seq !== S.startSeq) return;
  if (!inBookmarksMode()) return; // the mode changed while we were asking
  if (!granted) {
    // Already asking? Leave the card alone — rebuilding it would throw away the
    // "waiting for Chrome" line and the escape hatch under it.
    if (S.phase !== 'grant') showGrant();
    return;
  }
  S.phase = 'list';
  bindBookmarkEvents();
  buildFrame();
  await restoreView();
  // `pagehide` can land inside that read. Everything below builds DOM and arms an
  // observer on a document that is already gone.
  if (S.dead || seq !== S.startSeq) return;
  await paint();
}

/**
 * Take the column's CONTENTS down. Never touches `hidden` — that is `railMode`'s, and
 * `tool-strip.js` owns it.
 */
function stop() {
  // Ahead of the early return on purpose: a "where the reader was" write can be owed
  // whatever phase we are in, and `clearTimers()` flushes it rather than dropping it.
  clearTimers();
  if (S.phase === 'off') return;
  S.phase = 'off';
  unbindBookmarkEvents();
  clearFrame();
}

/**
 * Empty the rail and drop every reference into it. Whatever is built next starts from
 * nothing, and no timer or observer is left holding a node that is no longer on screen.
 */
function clearFrame() {
  disconnectObserver();
  if (S.rail) S.rail.textContent = '';
  S.head = null;
  S.title = null;
  S.back = null;
  S.add = null;
  S.list = null;
  S.empty = null;
  S.error = null;
  S.more = null;
  S.pending = null;
  S.pendingText = null;
  S.escape = null;
  S.nodes = [];
  S.rendered = 0;
  S.pathId = null;
  S.path = [];
  S.painted = '';
}

/**
 * `pagehide`. Timers and Chrome listeners must not outlive the document; the panel is
 * torn down and rebuilt every time it is closed and reopened.
 */
export function destroy() {
  // NOT routed through `stop()`. That returns early when the column is not listing, and
  // a `start()` parked on `contains()` is exactly that state: it would resume after this
  // ran and register five bookmark listeners, an observer and two timers on a document
  // that has already said good-bye. `S.dead` is what stops it coming back; the teardown
  // below runs unconditionally so there is nothing for it to come back to either.
  S.dead = true;
  S.phase = 'off';
  unbindBookmarkEvents();
  clearTimers();
  clearFrame();
  if (S.rail) S.rail.removeEventListener('scroll', onRailScroll);
  try {
    if (S.onPermAdded) chrome.permissions.onAdded.removeListener(S.onPermAdded);
    if (S.onPermRemoved) chrome.permissions.onRemoved.removeListener(S.onPermRemoved);
  } catch (e) {
    log.warn('bookmarks permission events', e);
  }
  S.onPermAdded = null;
  S.onPermRemoved = null;
  if (typeof S.offSettings === 'function') S.offSettings();
  if (typeof S.offRendered === 'function') S.offRendered();
  S.offSettings = null;
  S.offRendered = null;
  S.started = false;
}

function clearTimers() {
  if (S.repaintTimer) clearTimeout(S.repaintTimer);
  S.repaintTimer = 0;
  // Flushed rather than dropped: switching the column back to the tools within the
  // debounce would otherwise forget the folder the reader had just opened.
  flushView();
  clearGrantTimer();
}

function clearGrantTimer() {
  if (S.grantTimer) clearTimeout(S.grantTimer);
  S.grantTimer = 0;
}

/* ── The permission ──────────────────────────────────────────────────────── */

/** @param {any} perms a `permissions.onAdded` / `onRemoved` payload */
function mentionsBookmarks(perms) {
  return Boolean(perms) && Array.isArray(perms.permissions) && perms.permissions.includes('bookmarks');
}

/** @returns {Promise<boolean>} */
async function contains() {
  try {
    return await chrome.permissions.contains(NEEDS);
  } catch (e) {
    log.warn('bookmarks permission check', e);
    return false;
  }
}

/** @returns {boolean} */
function inBookmarksMode() {
  const settings = S.ctx && typeof S.ctx.getSettings === 'function' ? S.ctx.getSettings() : null;
  return Boolean(settings) && settings.railMode === 'bookmarks';
}

/**
 * The permission went away — revoked from `chrome://extensions`, or the API started
 * refusing calls. The column goes back to asking for it; `settings.railMode` is NOT
 * rewritten, because the layout is the user's choice and taking it back silently would
 * be us undoing something they did.
 */
function onLostPermission() {
  const wasListing = S.phase === 'list';
  stop();
  if (!inBookmarksMode()) return;
  showGrant();
  if (wasListing) toast(t('bookmarksDenied'));
}

/**
 * Ask Chrome for the optional permission.
 *
 * MEASURED, not a style preference (probe-results.md Probe 7): the call has to be the
 * FIRST thing this function does, with nothing awaited in front of it, and this
 * function has to be reached synchronously from the click. Anything else spends the
 * user activation and Chrome answers `This function must be called during a user
 * gesture`. The returned promise is deliberately NOT what drives the UI: it was
 * measured staying pending for the full 30 s budget while the native bubble sat
 * unanswered, so `permissions.onAdded` is the signal and this is only bookkeeping.
 */
function askForPermission() {
  const asked = chrome.permissions.request(NEEDS);
  showGrantPending();
  Promise.resolve(asked)
    .then((granted) => {
      // An explicit "no" is worth saying out loud; a "yes" arrives via `onAdded`, which
      // has usually already repainted this card out of existence by now.
      if (granted === false) showGrantDeclined();
    })
    .catch((e) => log.warn('bookmarks permission request', e));
}

/* ── The grant card ──────────────────────────────────────────────────────── */

function showGrant() {
  if (!S.rail) return;
  S.phase = 'grant';
  clearGrantTimer();
  clearFrame();

  const card = document.createElement('div');
  card.className = 'bmk-grant';
  card.dataset.testid = 'bookmark-grant';

  const heading = document.createElement('h2');
  heading.className = 'bmk-grant__title';
  heading.textContent = t('bookmarksGrantTitle');

  const body = document.createElement('p');
  body.className = 'w-muted bmk-grant__body';
  body.textContent = t('bookmarksGrantBody');

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'w-btn';
  button.dataset.testid = 'bookmark-grant-button';
  button.textContent = t('bookmarksGrantButton');
  // The wrapper holds the try, so that `askForPermission()`'s own first statement is
  // still the `permissions.request()` call itself.
  button.addEventListener('click', () => {
    try {
      askForPermission();
    } catch (e) {
      log.warn('bookmarks permission request', e);
    }
  });

  const pending = document.createElement('p');
  pending.className = 'bmk-grant__pending';
  pending.dataset.testid = 'bookmark-grant-pending';
  pending.hidden = true;

  const pendingText = document.createElement('span');
  pendingText.className = 'w-muted';

  // The way out when the bubble never appeared, or appeared somewhere the reader did
  // not see. `welcome/welcome.html` is `open_in_tab`, so this is a real page with room
  // to explain itself, not a second popup competing with Chrome's — and it carries the
  // same grant button (`welcome.js`), which is why the label names THIS extension's
  // settings page rather than Chrome's.
  const escape = document.createElement('button');
  escape.type = 'button';
  escape.className = 'bmk-grant__escape';
  escape.dataset.testid = 'bookmark-grant-options';
  escape.textContent = t('bookmarksGrantOpenSettings');
  escape.hidden = true;
  escape.addEventListener('click', () => {
    try {
      chrome.runtime.openOptionsPage();
    } catch (e) {
      log.warn('openOptionsPage', e);
    }
  });

  pending.append(pendingText, escape);
  card.append(heading, body, button, pending);
  S.rail.append(card);

  S.pending = pending;
  S.pendingText = pendingText;
  S.escape = escape;
}

function showGrantPending() {
  if (!S.pending || !S.pendingText) return;
  S.pending.hidden = false;
  S.pendingText.textContent = t('bookmarksGrantPending');
  // Armed once per card, not once per press. The reader who presses Allow again is the
  // one who saw no bubble — precisely the reader the way out exists for — and re-arming
  // would push it another ten seconds away every time they tried.
  if (S.grantTimer || (S.escape && !S.escape.hidden)) return;
  S.grantTimer = setTimeout(() => {
    S.grantTimer = 0;
    if (S.escape) S.escape.hidden = false;
  }, GRANT_HINT_MS);
}

function showGrantDeclined() {
  clearGrantTimer();
  if (!S.pending || !S.pendingText) return;
  S.pending.hidden = false;
  S.pendingText.textContent = t('bookmarksDenied');
  if (S.escape) S.escape.hidden = false;
}

/* ── Talking to chrome.bookmarks ─────────────────────────────────────────── */

/**
 * One call, with the revoke backstop on it.
 *
 * Measured: after `permissions.remove()` the namespace is still an object and every
 * call throws `… is not available in this context.` `permissions.onRemoved` normally
 * gets here first, but a call already in flight lands afterwards — so a throw is
 * checked against `permissions.contains()` rather than assumed to be a bug, and the
 * column falls back to the grant card instead of going blank. A throw with the
 * permission still in place is NOT a revoke and gets the retry state
 * (`showReadError()`), because offering a grant that is already granted is a dead end.
 *
 * @param {string} method a `chrome.bookmarks` method name
 * @param {...any} args
 * @returns {Promise<any|null>} `null` when the call failed
 */
async function bm(method, ...args) {
  try {
    return await chrome.bookmarks[method](...args);
  } catch (e) {
    log.warn(`bookmarks.${method}`, e);
    void verifyPermission();
    return null;
  }
}

/** A failed call is either a revoke or a real error; only `contains()` can say which. */
async function verifyPermission() {
  if (await contains()) return;
  onLostPermission();
}

/**
 * The Bookmarks bar.
 *
 * `getChildren('0')` rather than `folderType` or `ROOT_NODE_ID`: both are recent
 * additions and `minimum_chrome_version` is 120. The bar is the first root Chrome
 * returns, and every root is a folder.
 *
 * @returns {Promise<string>}
 */
async function bookmarksBarId() {
  const roots = await bm('getChildren', ROOT_ID);
  const bar = Array.isArray(roots) ? roots.find(isFolder) : null;
  return bar ? String(bar.id) : ROOT_ID;
}

/**
 * A folder has no `url` KEY at all — measured; it is absent rather than empty, and
 * `getChildren` results carry no `children` key to test instead.
 * @param {any} node
 */
function isFolder(node) {
  return Boolean(node) && !('url' in node);
}

/* ── The frame ───────────────────────────────────────────────────────────── */

function buildFrame() {
  if (!S.rail) return;
  // Before the nodes go: the sentinel about to be thrown away is still a target of the
  // observer, and an `IntersectionObserver` holds its targets strongly. `clearFrame()`
  // does this; a rebuild that skipped it would strand the whole detached subtree for the
  // life of the panel.
  disconnectObserver();
  S.rail.textContent = '';

  const wrap = document.createElement('div');
  wrap.className = 'bmk';

  const head = document.createElement('div');
  head.className = 'bmk__head';
  head.dataset.testid = 'bookmark-head';

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'iconbtn bmk__back';
  back.dataset.testid = 'bookmark-back';
  back.setAttribute('aria-label', t('bookmarksBack'));
  back.title = t('bookmarksBack');
  back.append(glyph('i-chevron', 'icon'));
  back.addEventListener('click', () => void goUp());

  const title = document.createElement('span');
  title.className = 'bmk__title';
  title.dataset.testid = 'bookmark-title';

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'iconbtn bmk__add';
  add.dataset.testid = 'bookmark-add';
  add.setAttribute('aria-label', t('bookmarksAddCurrentTab'));
  add.title = t('bookmarksAddCurrentTab');
  // The ribbon rather than a plus: the bottom bar's plus already means "new tab", and a
  // second plus a few pixels up meaning "new bookmark" is one glyph doing two jobs.
  add.append(glyph('i-bookmark', 'icon'));
  add.addEventListener('click', () => void addCurrentTab());

  head.append(back, title, add);

  // A flat list of one level, not a tree: `listbox`/`option` with a roving tabindex is
  // what that is. An indented tree in 176 px is unreadable, which is why the column
  // drills down instead.
  const list = document.createElement('div');
  list.className = 'w-rows bmk__list';
  list.dataset.testid = 'bookmark-list';
  list.setAttribute('role', 'listbox');
  list.addEventListener('click', onListClick);
  list.addEventListener('auxclick', onListAuxClick);
  list.addEventListener('mousedown', onListMouseDown);
  list.addEventListener('keydown', onListKeyDown);

  const empty = document.createElement('div');
  empty.className = 'w-muted bmk__empty';
  empty.dataset.testid = 'bookmark-empty';
  empty.textContent = t('bookmarksEmpty');
  empty.hidden = true;

  // Both the `IntersectionObserver` sentinel and the manual way to load the next chunk,
  // which is what a keyboard reaches and what still works if the observer cannot be
  // built at all.
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'w-btn bmk__more';
  more.dataset.testid = 'bookmark-more';
  more.hidden = true;
  more.addEventListener('click', () => renderChunk());

  // A read can fail while the permission is still there — a transient refusal, or a
  // namespace that has not been retrofitted into an already-loaded document. `bm()` has
  // checked `contains()` by the time this shows, so the grant card would be a lie; what
  // is left is to say so and offer the read again. Without it the column goes blank with
  // no heading, no message and nothing to press, and only a trip through the settings
  // drawer gets it back.
  const error = document.createElement('div');
  error.className = 'bmk__error';
  error.dataset.testid = 'bookmark-error';
  error.hidden = true;

  const errorText = document.createElement('p');
  errorText.className = 'w-muted bmk__error-text';
  errorText.textContent = t('bookmarksUnavailable');

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'w-btn';
  retry.dataset.testid = 'bookmark-retry';
  retry.textContent = t('bookmarksRetry');
  retry.addEventListener('click', () => void retryRead());

  error.append(errorText, retry);

  wrap.append(head, list, empty, error, more);
  S.rail.append(wrap);

  S.head = head;
  S.title = title;
  S.back = back;
  S.add = add;
  S.list = list;
  S.empty = empty;
  S.error = error;
  S.more = more;
}

/**
 * The failed read, again. Also re-arms Chrome's own events: `bindBookmarkEvents()` gives
 * up as a whole if reading the event objects throws, and a column that is deaf to them
 * has no other way of ever noticing that the API started working.
 * @returns {Promise<void>}
 */
async function retryRead() {
  if (S.phase !== 'list') return;
  bindBookmarkEvents();
  await paint();
}

/**
 * The column could not be read, and the permission is still granted. The heading is
 * painted anyway, so `back` and the add button are in the state the folder deserves
 * rather than the state a half-built frame left them in.
 */
function showReadError() {
  if (S.phase !== 'list') return;
  disconnectObserver();
  if (S.list) S.list.textContent = '';
  S.nodes = [];
  S.rendered = 0;
  S.painted = '';
  if (S.more) {
    S.more.hidden = true;
    S.more.textContent = '';
  }
  if (S.empty) S.empty.hidden = true;
  if (S.error) S.error.hidden = false;
  paintHeader(S.folderId);
}

/**
 * @param {string} href sprite symbol id, without the `#`
 * @param {string} className
 */
function glyph(href, className) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${href}`);
  svg.append(use);
  return svg;
}

/* ── Painting one folder ─────────────────────────────────────────────────── */

/**
 * Re-read the folder on screen and redraw it. Nothing but that folder is ever read.
 * @returns {Promise<void>}
 */
async function paint() {
  if (S.phase !== 'list' || !S.list || !S.rail) return;
  const token = (S.paintToken += 1);
  const folderId = S.folderId;

  const kids = await bm('getChildren', folderId);
  if (token !== S.paintToken || S.phase !== 'list' || !S.list) return;
  if (!kids) {
    // The folder is gone, or the call was refused. `bm()` has already decided which and
    // shown the grant card if the permission went; from here the only useful move is up.
    if (folderId !== ROOT_ID) {
      S.folderId = ROOT_ID;
      S.pathId = null;
      await paint();
      return;
    }
    // The roots themselves would not read, so there is nowhere above to fall back to.
    showReadError();
    return;
  }

  if (S.pathId !== folderId) {
    S.path = await folderPath(folderId);
    if (token !== S.paintToken || S.phase !== 'list' || !S.list) return;
    S.pathId = folderId;
  }

  // What to put back afterwards: the row that had focus, how far the list had grown and
  // where it was scrolled to. A repaint is usually an event about one bookmark, and
  // losing your place over it is worse than the stale row would have been.
  const sameFolder = folderId === S.painted;
  const keepRendered = sameFolder ? S.rendered : 0;
  const keepScroll = sameFolder ? S.rail.scrollTop : 0;
  const active = document.activeElement;
  const keepFocus = sameFolder && active instanceof HTMLElement && S.list.contains(active)
    ? active.dataset.bookmarkId || null
    : null;

  S.painted = folderId;
  S.nodes = kids;
  S.rendered = 0;
  S.list.textContent = '';
  S.list.setAttribute('aria-label', headingFor(folderId));
  if (S.empty) S.empty.hidden = kids.length > 0;
  if (S.error) S.error.hidden = true;

  do {
    renderChunk();
  } while (S.rendered < keepRendered && S.rendered < S.nodes.length);

  paintHeader(folderId);

  const scroll = S.pendingScroll || keepScroll;
  S.pendingScroll = 0;
  if (scroll > 0) S.rail.scrollTop = scroll;

  if (keepFocus) {
    const again = S.list.querySelector(`[data-bookmark-id="${cssEscape(keepFocus)}"]`);
    if (again instanceof HTMLElement) focusRow(again);
  }
}

/** @param {string} folderId */
function paintHeader(folderId) {
  if (!S.title || !S.back || !S.add) return;
  const atRoot = folderId === ROOT_ID;
  S.title.textContent = headingFor(folderId);
  // The name is ellipsized to fit; the whole path is one hover away.
  S.title.title = atRoot ? t('bookmarks') : S.path.join(' / ');
  S.back.hidden = atRoot;
  // Chrome refuses to create anything directly under the root, so the button says so
  // instead of failing when it is pressed.
  S.add.disabled = atRoot;
}

/**
 * The folder's own name — the last step of the path, not the path split on a separator:
 * a folder is free to be called "Work / Archive" and that must not read as two levels.
 * @param {string} folderId
 */
function headingFor(folderId) {
  if (folderId === ROOT_ID || S.path.length === 0) return t('bookmarks');
  return S.path[S.path.length - 1] || t('bookmarks');
}

/**
 * The breadcrumb, built by walking up with `get(parentId)` — measured at ~1 ms a level.
 * The tree is never read to find it.
 *
 * @param {string} folderId
 * @returns {Promise<string[]>} the names from the root down, this folder last
 */
async function folderPath(folderId) {
  const parts = [];
  let id = folderId;
  for (let hop = 0; hop < 32 && id && id !== ROOT_ID; hop += 1) {
    const got = await bm('get', id);
    const node = Array.isArray(got) ? got[0] : null;
    if (!node) break;
    parts.unshift(node.title || '');
    id = node.parentId ? String(node.parentId) : '';
  }
  return parts;
}

/* ── Rows, in chunks ─────────────────────────────────────────────────────── */

/** Append the next `CHUNK` rows and re-arm the sentinel. */
function renderChunk() {
  if (!S.list || !S.more) return;
  const open = openTabIndex();
  const end = Math.min(S.nodes.length, S.rendered + CHUNK);
  const frag = document.createDocumentFragment();
  for (let i = S.rendered; i < end; i += 1) frag.append(buildRow(S.nodes[i], open));
  S.list.append(frag);
  S.rendered = end;

  const remaining = S.nodes.length - S.rendered;
  if (remaining > 0) {
    S.more.hidden = false;
    S.more.textContent = t('bookmarksMore', [String(remaining)]);
    observeSentinel();
  } else {
    S.more.hidden = true;
    S.more.textContent = '';
    disconnectObserver();
  }
  ensureRoving();
}

function observeSentinel() {
  if (!S.more || !S.rail) return;
  if (!S.io) {
    if (typeof IntersectionObserver !== 'function') return;
    try {
      S.io = new IntersectionObserver(onSentinel, { root: S.rail, rootMargin: '200px', threshold: 0 });
    } catch (e) {
      log.warn('bookmarks IntersectionObserver', e);
      S.io = null;
      return;
    }
  }
  // Re-observing is how the observer is asked to look again. Appending a chunk under a
  // sentinel that is STILL on screen is not an intersection CHANGE, so nothing would
  // fire and a list taller than the panel would stop growing with rows left over.
  S.io.unobserve(S.more);
  S.io.observe(S.more);
}

function disconnectObserver() {
  if (!S.io) return;
  try {
    S.io.disconnect();
  } catch (e) {
    log.warn('bookmarks observer', e);
  }
  S.io = null;
}

/** @param {IntersectionObserverEntry[]} entries */
function onSentinel(entries) {
  if (S.phase !== 'list') return;
  if (!entries.some((entry) => entry.isIntersecting)) return;
  if (S.rendered >= S.nodes.length) return;
  renderChunk();
}

/**
 * @param {any} node
 * @param {Map<string, number>} open urlKey → the tab id already showing that page
 */
function buildRow(node, open) {
  const folder = isFolder(node);
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'w-row bmk-row';
  row.dataset.testid = 'bookmark-row';
  // NOT `data-tab-id`. That attribute means "this element IS the card for that tab" and
  // has exactly one owner; a second element carrying it made every `[data-tab-id]`
  // lookup in the panel match two nodes once already (22-widgets.spec.js).
  row.dataset.bookmarkId = String(node.id);
  row.dataset.kind = folder ? 'folder' : 'link';
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', 'false');
  row.tabIndex = -1;

  const aside = document.createElement('span');
  aside.className = 'w-row__aside';

  if (folder) {
    row.append(glyph('i-folder', 'icon bmk-row__glyph'));
    aside.append(glyph('i-chevron', 'icon bmk-row__chevron'));
    row.title = node.title || '';
  } else {
    // In-process: `chrome-extension://<id>/_favicon/` answers from the profile's own
    // icon store on the `favicon` permission the manifest already has. Measured 200 /
    // image/bmp / ~600 B even for a URL this profile never visited, and no network —
    // which is what keeps the "makes no requests at all" assertion true.
    row.append(favicon(node.url));
    row.dataset.bookmarkUrl = node.url;
    const key = urlKey(node.url);
    if (key) row.dataset.bookmarkKey = key;
    row.title = `${node.title || ''}\n${node.url}`.trim();
    const tabId = key ? open.get(key) : undefined;
    if (tabId != null) {
      row.dataset.openTab = String(tabId);
      aside.append(buildDot());
    }
  }

  const main = document.createElement('span');
  main.className = 'w-row__main';
  main.textContent = node.title || node.url || '';

  row.append(main, aside);
  return row;
}

/** @param {string} url */
function favicon(url) {
  const img = document.createElement('img');
  img.className = 'bmk-row__icon';
  img.width = 16;
  img.height = 16;
  img.alt = '';
  img.decoding = 'async';
  // The same size the cards ask for, so a bookmark and its tab share one cache entry.
  const src = faviconUrl(url, FAVICON_SIZE);
  if (src) img.src = src;
  return img;
}

function buildDot() {
  const dot = document.createElement('span');
  dot.className = 'bmk-row__dot';
  dot.dataset.testid = 'bookmark-open-dot';
  dot.setAttribute('role', 'img');
  dot.setAttribute('aria-label', t('bookmarksAlreadyOpen'));
  dot.title = t('bookmarksAlreadyOpen');
  return dot;
}

/* ── "You already have this open" ────────────────────────────────────────── */

/**
 * The panel's own tab model, keyed the way previews are keyed. No permission, no I/O,
 * one Map.
 * @returns {Map<string, number>}
 */
function openTabIndex() {
  const map = new Map();
  const model = S.ctx && typeof S.ctx.model === 'function' ? S.ctx.model() : null;
  const tabs = model && model.tabs;
  if (!tabs || typeof tabs.values !== 'function') return map;
  for (const tab of tabs.values()) {
    // `tab.url` is the page on screen and `pendingUrl` only the one on its way — the
    // same rule the preview keys follow (probe-results.md).
    const key = urlKey(tab.url || tab.pendingUrl || '');
    if (key && !map.has(key)) map.set(key, tab.id);
  }
  return map;
}

/** Re-decide the dots against the current tab model. Reads no bookmarks at all. */
function markOpenTabs() {
  if (S.phase !== 'list' || !S.list) return;
  const open = openTabIndex();
  for (const row of S.list.querySelectorAll('[data-bookmark-key]')) {
    const tabId = open.get(row.dataset.bookmarkKey || '');
    const aside = row.querySelector('.w-row__aside');
    const dot = row.querySelector('.bmk-row__dot');
    if (tabId != null) {
      row.dataset.openTab = String(tabId);
      if (!dot && aside) aside.append(buildDot());
    } else {
      delete row.dataset.openTab;
      if (dot) dot.remove();
    }
  }
}

/* ── Navigating ──────────────────────────────────────────────────────────── */

/**
 * @param {string} id
 * @returns {Promise<void>}
 */
async function openFolder(id) {
  if (!id || S.phase !== 'list' || !S.rail) return;
  const hadFocus = S.rail.contains(document.activeElement);
  S.folderId = String(id);
  S.pathId = null;
  S.pendingScroll = 0;
  S.rail.scrollTop = 0;
  S.painted = '';
  saveView();
  await paint();
  if (hadFocus) focusFirstRow();
}

/** Up one level; the root's children are the roots themselves. */
async function goUp() {
  if (S.folderId === ROOT_ID) return;
  const got = await bm('get', S.folderId);
  const node = Array.isArray(got) ? got[0] : null;
  await openFolder(node && node.parentId ? String(node.parentId) : ROOT_ID);
}

/* ── Opening ─────────────────────────────────────────────────────────────── */

/**
 * @param {HTMLElement} row
 * @param {boolean} background
 * @returns {Promise<void>}
 */
async function openBookmark(row, background) {
  const url = row.dataset.bookmarkUrl || '';
  if (!url) return;

  if (!background) {
    // The point of the dot: the page is already open, so go to it rather than making a
    // second copy of it.
    const tabId = Number(row.dataset.openTab);
    if (Number.isFinite(tabId) && tabId > 0 && S.ctx && typeof S.ctx.activate === 'function') {
      void S.ctx.activate(tabId);
      return;
    }
    await ops.openUrl(url);
    return;
  }

  try {
    await ops.create({ url, active: false });
  } catch (e) {
    log.warn('bookmarks background open', e);
  }
}

/* ── The one write ───────────────────────────────────────────────────────── */

/**
 * Save the window's active tab into the folder on screen. The ONLY write this file
 * makes; `onCreated` puts the new row on screen through the same path every other
 * change takes.
 * @returns {Promise<void>}
 */
async function addCurrentTab() {
  if (S.phase !== 'list' || S.folderId === ROOT_ID) return;
  const model = S.ctx && typeof S.ctx.model === 'function' ? S.ctx.model() : null;
  const tab = model && model.tabs && model.activeTabId != null
    ? model.tabs.get(model.activeTabId)
    : null;
  const url = tab ? (tab.url || tab.pendingUrl || '') : '';
  if (!url) {
    toast(t('operationFailed'));
    return;
  }
  const made = await bm('create', { parentId: S.folderId, title: tab.title || url, url });
  if (!made) {
    toast(t('operationFailed'));
    return;
  }
  toast(t('bookmarksAdded'));
}

/* ── Pointer ─────────────────────────────────────────────────────────────── */

/** @param {MouseEvent} event */
function onListClick(event) {
  const row = rowFrom(event.target);
  if (!row) return;
  event.preventDefault();
  focusRow(row);
  if (row.dataset.kind === 'folder') {
    void openFolder(row.dataset.bookmarkId || '');
    return;
  }
  void openBookmark(row, event.ctrlKey || event.metaKey);
}

/** Middle click: a background tab, the way the tab list already reads a middle click. */
function onListAuxClick(event) {
  if (event.button !== 1) return;
  const row = rowFrom(event.target);
  if (!row || row.dataset.kind === 'folder') return;
  event.preventDefault();
  void openBookmark(row, true);
}

/** Suppress the autoscroll a middle press would otherwise start. */
function onListMouseDown(event) {
  if (event.button !== 1) return;
  if (rowFrom(event.target)) event.preventDefault();
}

/** @param {EventTarget|null} target @returns {HTMLElement|null} */
function rowFrom(target) {
  if (!(target instanceof Element)) return null;
  const row = target.closest('[data-bookmark-id]');
  return row instanceof HTMLElement ? row : null;
}

/* ── Keyboard (roving tabindex over a flat list) ─────────────────────────── */

/** @param {KeyboardEvent} event */
function onListKeyDown(event) {
  const row = rowFrom(event.target);
  if (!row || !S.list) return;
  const rows = /** @type {HTMLElement[]} */ ([...S.list.querySelectorAll('[data-bookmark-id]')]);
  const index = rows.indexOf(row);

  switch (event.key) {
    case 'ArrowDown':
    case 'ArrowUp': {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = rows[Math.min(Math.max(index + step, 0), rows.length - 1)];
      if (next) focusRow(next);
      return;
    }
    case 'Home':
    case 'End': {
      event.preventDefault();
      const next = event.key === 'Home' ? rows[0] : rows[rows.length - 1];
      if (next) focusRow(next);
      return;
    }
    // Left, Backspace and Alt+Left all mean "back" — the last is what a browser has
    // trained the hand to reach for, and it arrives here as a plain ArrowLeft.
    case 'ArrowLeft':
    case 'Backspace':
      event.preventDefault();
      void goUp();
      return;
    case 'ArrowRight':
      if (row.dataset.kind !== 'folder') return;
      event.preventDefault();
      void openFolder(row.dataset.bookmarkId || '');
      return;
    case 'Enter':
      // On a <button> Enter would also fire a click; preventing the default keeps the
      // action from running twice.
      event.preventDefault();
      if (row.dataset.kind === 'folder') void openFolder(row.dataset.bookmarkId || '');
      else void openBookmark(row, false);
      return;
    default:
  }
}

/** Exactly one row is reachable with Tab; the arrows move which one that is. */
function ensureRoving() {
  if (!S.list) return;
  const rows = /** @type {HTMLElement[]} */ ([...S.list.querySelectorAll('[data-bookmark-id]')]);
  if (!rows.length) return;
  if (rows.some((row) => row.tabIndex === 0)) return;
  rows[0].tabIndex = 0;
}

/** @param {HTMLElement} row */
function focusRow(row) {
  if (!S.list) return;
  for (const other of S.list.querySelectorAll('[tabindex="0"]')) {
    /** @type {HTMLElement} */ (other).tabIndex = -1;
  }
  row.tabIndex = 0;
  try {
    row.focus();
  } catch (e) {
    log.warn('bookmarks focus', e);
  }
}

function focusFirstRow() {
  if (!S.list) return;
  const first = S.list.querySelector('[data-bookmark-id]');
  if (first instanceof HTMLElement) focusRow(first);
}

/* ── Where the reader was ────────────────────────────────────────────────── */

function onRailScroll() {
  if (S.phase === 'list') saveView();
}

function saveView() {
  if (S.viewTimer) clearTimeout(S.viewTimer);
  S.viewTimer = setTimeout(() => {
    S.viewTimer = 0;
    writeView();
  }, VIEW_SAVE_DEBOUNCE_MS);
}

/** Write the pending place now, if one is owed. */
function flushView() {
  if (!S.viewTimer) return;
  clearTimeout(S.viewTimer);
  S.viewTimer = 0;
  writeView();
}

function writeView() {
  const value = { folderId: S.folderId, scrollTop: Math.round(S.rail ? S.rail.scrollTop : 0) };
  try {
    void Promise.resolve(chrome.storage.session.set({ [STORAGE_SESSION.bookmarkView]: value }))
      .catch((e) => log.warn('bookmarks view save', e));
  } catch (e) {
    log.warn('bookmarks view save', e);
  }
}

/** @returns {Promise<void>} */
async function restoreView() {
  let stored = null;
  try {
    const bag = await chrome.storage.session.get(STORAGE_SESSION.bookmarkView);
    stored = bag ? bag[STORAGE_SESSION.bookmarkView] : null;
  } catch (e) {
    log.warn('bookmarks view load', e);
  }

  const wanted = stored && typeof stored.folderId === 'string' ? stored.folderId : '';
  S.pendingScroll = stored && Number.isFinite(stored.scrollTop) ? Math.max(0, stored.scrollTop) : 0;
  S.painted = '';

  if (wanted === ROOT_ID) {
    S.folderId = ROOT_ID;
    S.pathId = null;
    return;
  }
  if (wanted) {
    // The folder may have been deleted since; a stale id must not leave an empty column.
    const got = await bm('get', wanted);
    const node = Array.isArray(got) ? got[0] : null;
    if (isFolder(node)) {
      S.folderId = wanted;
      S.pathId = null;
      return;
    }
  }
  S.folderId = await bookmarksBarId();
  S.pathId = null;
  S.pendingScroll = 0;
}

/* ── Chrome's bookmark events, all of them in the panel ──────────────────── */

function bindBookmarkEvents() {
  if (S.bound.length) return;

  /** @param {unknown} parentId */
  const touchesFolder = (parentId) => parentId != null && String(parentId) === S.folderId;
  /** @param {unknown} id */
  const touchesRow = (id) => S.nodes.some((node) => String(node.id) === String(id));

  /** @type {Array<[any, Function]>} */
  const wanted = [];
  try {
    wanted.push(
      [chrome.bookmarks.onCreated, (id, node) => {
        if (touchesFolder(node && node.parentId)) scheduleRepaint();
      }],
      [chrome.bookmarks.onChanged, (id) => {
        if (String(id) === S.folderId) S.pathId = null; // the header's own name changed
        if (String(id) === S.folderId || touchesRow(id)) scheduleRepaint();
      }],
      [chrome.bookmarks.onMoved, (id, info) => {
        if (touchesFolder(info && info.parentId) || touchesFolder(info && info.oldParentId)) {
          scheduleRepaint();
        }
      }],
      [chrome.bookmarks.onRemoved, (id, info) => {
        // The folder being READ was the one deleted: there is nothing to repaint, so go
        // up to where it used to be.
        if (String(id) === S.folderId) {
          S.folderId = info && info.parentId ? String(info.parentId) : ROOT_ID;
          S.pathId = null;
          S.painted = '';
          saveView();
          scheduleRepaint();
          return;
        }
        if (touchesFolder(info && info.parentId) || touchesRow(id)) scheduleRepaint();
      }],
      [chrome.bookmarks.onChildrenReordered, (id) => {
        if (touchesFolder(id)) scheduleRepaint();
      }],
    );
  } catch (e) {
    log.warn('bookmarks events', e);
    return;
  }

  for (const [event, fn] of wanted) {
    if (!event || typeof event.addListener !== 'function') continue;
    try {
      event.addListener(fn);
      S.bound.push({ event, fn });
    } catch (e) {
      log.warn('bookmarks listener', e);
    }
  }
}

function unbindBookmarkEvents() {
  for (const { event, fn } of S.bound) {
    try {
      event.removeListener(fn);
    } catch (e) {
      log.warn('bookmarks listener', e);
    }
  }
  S.bound = [];
}

/**
 * One repaint per burst. An import, a sync or a folder of links dropped in at once all
 * fire a run of events; `widgets/windows.js` coalesces the same way for the same reason.
 */
function scheduleRepaint() {
  if (S.repaintTimer) return;
  S.repaintTimer = setTimeout(() => {
    S.repaintTimer = 0;
    void paint();
  }, REPAINT_DEBOUNCE_MS);
}

/* ── Small helpers ───────────────────────────────────────────────────────── */

/** @param {string} text */
function toast(text) {
  if (S.ctx && typeof S.ctx.showToast === 'function') S.ctx.showToast(text);
}

/**
 * Bookmark ids are decimal strings from Chrome, but the selector they end up in is
 * built by us, so they are escaped rather than trusted.
 * @param {string} value
 */
function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}
