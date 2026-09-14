/**
 * The closed-tabs "trash" popover (spec.md §9.5).
 *
 * `chrome.sessions.getRecentlyClosed()` returns the browser's own recently
 * closed list, newest first, capped at `MAX_SESSION_RESULTS` (25 — the API's
 * own maximum). Entries are either a tab or a whole window; both are restored
 * by their `sessionId`.
 *
 * `Session.lastModified` is **seconds** since the epoch, so it is multiplied by
 * 1000 before any date maths (a classic source of "54 000 days ago" bugs).
 *
 * DOM touched: `#btn-trash`, `#trash-badge`, `#trash-popover`.
 */

import * as log from '../common/log.js';
import { MAX_SESSION_RESULTS, faviconUrl } from '../common/constants.js';
import * as ops from './tab-ops.js';
import { t, toast } from './toast.js';

/* ── state ────────────────────────────────────────────────────────────────── */

/** @type {any} */
let ctx = null;
/** @type {HTMLElement|null} */
let button = null;
/** @type {HTMLElement|null} */
let badge = null;
/** @type {HTMLElement|null} */
let popover = null;
/** @type {Element|null} */
let lastFocused = null;
let open = false;
let bound = false;

/* ── init ─────────────────────────────────────────────────────────────────── */

/** @param {any} context */
export function init(context) {
  ctx = ops.init(context) || context || null;
  button = document.getElementById('btn-trash');
  badge = document.getElementById('trash-badge');
  popover = document.getElementById('trash-popover');

  if (!bound) {
    bound = true;
    if (button) {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        void toggle();
      });
    }
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    window.addEventListener('resize', () => {
      if (open) positionPopover();
    });
    try {
      if (chrome.sessions && chrome.sessions.onChanged) {
        chrome.sessions.onChanged.addListener(onSessionsChanged);
      }
    } catch (e) {
      log.warn('sessions.onChanged', e);
    }
  }

  void refreshBadge();
}

/** @returns {boolean} */
export function isOpen() {
  return open;
}

/* ── open / close ─────────────────────────────────────────────────────────── */

/** @returns {Promise<void>} */
export async function toggle() {
  if (open) close();
  else await openPopover();
}

/** @returns {Promise<void>} */
export async function openPopover() {
  if (!popover) popover = document.getElementById('trash-popover');
  if (!popover) return;
  lastFocused = document.activeElement instanceof Element ? document.activeElement : null;
  open = true;
  popover.hidden = false;
  if (button) button.setAttribute('aria-expanded', 'true');
  await refresh();
  positionPopover();
  const first = popover.querySelector('.popover__item');
  if (first instanceof HTMLElement) {
    try {
      first.focus();
    } catch (e) {
      log.warn('trash focus', e);
    }
  }
}

export { openPopover as open };

/** Close the popover and restore focus to `#btn-trash` (spec-addendum A15.5). */
export function close() {
  if (!open) return;
  open = false;
  if (popover) {
    popover.hidden = true;
    popover.textContent = '';
  }
  if (button) button.setAttribute('aria-expanded', 'false');
  const target = lastFocused && lastFocused.isConnected ? lastFocused : button;
  lastFocused = null;
  try {
    if (target && typeof (/** @type {any} */ (target).focus) === 'function') {
      /** @type {any} */ (target).focus({ preventScroll: true });
    }
  } catch (e) {
    log.warn('trash restore focus', e);
  }
}

/* ── data ─────────────────────────────────────────────────────────────────── */

/**
 * @returns {Promise<chrome.sessions.Session[]>} newest first; `[]` on failure
 */
export async function getRecentlyClosed() {
  try {
    const sessions = await chrome.sessions.getRecentlyClosed({ maxResults: MAX_SESSION_RESULTS });
    return Array.isArray(sessions) ? sessions : [];
  } catch (e) {
    log.warn('sessions.getRecentlyClosed', e);
    return [];
  }
}

/** Re-read the list and repaint the popover when it is open. */
export async function refresh() {
  if (!open || !popover) return;
  const sessions = await getRecentlyClosed();
  renderList(sessions);
  updateBadge(sessions.length);
}

/** Keep the footer badge in sync even while the popover is closed. */
export async function refreshBadge() {
  const sessions = await getRecentlyClosed();
  updateBadge(sessions.length);
}

/**
 * @param {number} count
 */
function updateBadge(count) {
  if (!badge) badge = document.getElementById('trash-badge');
  if (!badge) return;
  if (count > 0) {
    badge.hidden = false;
    badge.textContent = String(count);
  } else {
    badge.hidden = true;
    badge.textContent = '';
  }
}

function onSessionsChanged() {
  void refreshBadge();
  if (open) void refresh();
}

/* ── rendering ────────────────────────────────────────────────────────────── */

/**
 * @param {chrome.sessions.Session[]} sessions
 */
function renderList(sessions) {
  if (!popover) return;
  popover.textContent = '';

  if (sessions.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'popover__empty';
    empty.dataset.testid = 'trash-empty';
    empty.textContent = t('closedTabsEmpty');
    popover.appendChild(empty);
    return;
  }

  const now = Date.now();
  for (const session of sessions) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'popover__item';
    row.dataset.testid = 'trash-item';
    row.tabIndex = -1;

    /** @type {string} */
    let label;
    /** @type {string|null} */
    let sessionId = null;

    if (session.tab) {
      const tab = session.tab;
      label = tab.title && tab.title !== '' ? tab.title : tab.url || '';
      sessionId = tab.sessionId || null;
      const icon = document.createElement('img');
      icon.className = 'popover__favicon';
      icon.alt = '';
      icon.width = 16;
      icon.height = 16;
      icon.draggable = false;
      // Never `tab.favIconUrl`: a closed tab's icon URL is page-controlled, so loading
      // it would send a credentialed request to that host every time the trash opens.
      // Chrome's own favicon database answers from cache without touching the network,
      // which is what spec.md §9.5 asks for here.
      const src = faviconUrl(tab.url || '');
      if (src) icon.src = src;
      icon.addEventListener('error', () => {
        icon.replaceWith(makeGlyph('#i-globe'));
      });
      row.appendChild(icon);
      row.dataset.url = tab.url || '';
    } else if (session.window) {
      const count = Array.isArray(session.window.tabs) ? session.window.tabs.length : 0;
      label = count === 1
        ? t('closedWindowOne', [String(count)])
        : t('closedWindow', [String(count)]);
      sessionId = session.window.sessionId || null;
      row.appendChild(makeGlyph('#i-window'));
      row.dataset.window = '1';
    } else {
      continue;
    }

    const text = document.createElement('span');
    text.className = 'popover__label';
    text.textContent = label;
    row.appendChild(text);

    const time = document.createElement('span');
    time.className = 'popover__time';
    time.textContent = relativeTime(Number(session.lastModified) * 1000, now);
    row.appendChild(time);

    const accessible = t('restoreTab', [label]);
    row.title = accessible;
    row.setAttribute('aria-label', accessible);
    if (sessionId) row.dataset.sessionId = sessionId;

    row.addEventListener('click', (event) => {
      event.preventDefault();
      void restore(sessionId);
    });
    row.addEventListener('keydown', onRowKeyDown);
    popover.appendChild(row);
  }
}

/**
 * @param {string} href a symbol id from the inline sprite, e.g. `#i-window`
 * @returns {SVGElement}
 */
function makeGlyph(href) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'popover__icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', href);
  svg.appendChild(use);
  return svg;
}

/**
 * `timeJustNow` / `timeMinutesAgo` / `timeHoursAgo` / `timeDaysAgo`.
 * @param {number} whenMs
 * @param {number} [nowMs]
 * @returns {string}
 */
export function relativeTime(whenMs, nowMs = Date.now()) {
  if (!Number.isFinite(whenMs) || whenMs <= 0) return '';
  const seconds = Math.max(0, Math.round((nowMs - whenMs) / 1000));
  if (seconds < 60) return t('timeJustNow');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('timeMinutesAgo', [String(minutes)]);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('timeHoursAgo', [String(hours)]);
  return t('timeDaysAgo', [String(Math.floor(hours / 24))]);
}

/* ── restore ──────────────────────────────────────────────────────────────── */

/**
 * @param {string|null} sessionId
 * @returns {Promise<void>}
 */
export async function restore(sessionId) {
  close();
  try {
    if (sessionId) await chrome.sessions.restore(sessionId);
    else await chrome.sessions.restore();
  } catch (e) {
    log.warn('sessions.restore', e);
    toast(t('restoreFailed'));
    return;
  }
  ops.resync();
  void refreshBadge();
}

/* ── geometry and keyboard ────────────────────────────────────────────────── */

function positionPopover() {
  if (!popover || !button) return;
  const anchor = button.getBoundingClientRect();
  popover.style.position = 'fixed';
  popover.style.visibility = 'hidden';
  const width = popover.offsetWidth || 260;
  const height = popover.offsetHeight || 200;
  let left = Math.min(anchor.right - width, window.innerWidth - width - 6);
  left = Math.max(6, left);
  let top = anchor.top - height - 6;
  if (top < 6) top = Math.min(anchor.bottom + 6, window.innerHeight - height - 6);
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(Math.max(6, top))}px`;
  popover.style.visibility = '';
}

/**
 * @param {PointerEvent} event
 */
function onDocumentPointerDown(event) {
  if (!open || !popover) return;
  const target = event.target instanceof Node ? event.target : null;
  if (target && (popover.contains(target) || (button && button.contains(target)))) return;
  close();
}

/**
 * @param {KeyboardEvent} event
 */
function onRowKeyDown(event) {
  if (!popover) return;
  const rows = /** @type {HTMLElement[]} */ ([...popover.querySelectorAll('.popover__item')]);
  const current = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  const index = current ? rows.indexOf(current) : -1;

  switch (event.key) {
    case 'ArrowDown': {
      event.preventDefault();
      const next = rows[(index + 1) % rows.length];
      if (next) next.focus();
      break;
    }
    case 'ArrowUp': {
      event.preventDefault();
      const prev = rows[(index - 1 + rows.length) % rows.length];
      if (prev) prev.focus();
      break;
    }
    case 'Home': {
      event.preventDefault();
      if (rows[0]) rows[0].focus();
      break;
    }
    case 'End': {
      event.preventDefault();
      if (rows[rows.length - 1]) rows[rows.length - 1].focus();
      break;
    }
    case 'Escape': {
      event.preventDefault();
      event.stopPropagation();
      close();
      break;
    }
    case 'Tab': {
      // Focus stays inside the popover while it is open (A15.5).
      event.preventDefault();
      const step = event.shiftKey ? -1 : 1;
      const next = rows[(index + step + rows.length) % rows.length];
      if (next) next.focus();
      break;
    }
    case ' ':
    case 'Enter': {
      event.preventDefault();
      if (current) current.click();
      break;
    }
    default:
      break;
  }
}
