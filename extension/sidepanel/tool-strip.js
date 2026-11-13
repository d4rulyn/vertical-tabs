/**
 * The tool strip: where the tools go while the side column belongs to the bookmarks.
 *
 * The switch between the two is NOT here. It is `#btn-rail-mode` in the topbar, which
 * sits in the same place in both modes and is never hidden, so the one ALWAYS-VISIBLE
 * switch does not move or disappear when the mode changes. The settings drawer's
 * `railMode` select writes the same setting; that one is the way in, not a control the
 * user has to find their way back out with.
 *
 * `settings.railMode` decides what the column beside the tabs holds. In `tools` — what
 * every install has had so far — nothing here is on screen at all: the strip is
 * hidden, the bookmark rail is hidden, and the panel is byte-for-byte the one that
 * shipped. In `bookmarks` the column belongs to `#bookmark-rail`, and the tools the
 * user picked move into a horizontal strip of icon buttons directly above the bottom
 * bar. One click opens that tool in `#tool-sheet`, a popover anchored to its button.
 *
 * The tools are hidden from the rail by handing `widgets.apply()` a DERIVED empty list
 * (see `sidepanel.js`), never by rewriting `settings.widgets`: the ticks in the drawer
 * are the user's, so switching back restores exactly the set they had.
 *
 * What this file owns:
 *   - `#tool-strip` — its buttons, their order, and whether it is on screen
 *   - `#tool-sheet` — open/close, focus, and the ONE widget mounted in it
 *   - `#bookmark-rail`'s VISIBILITY. Not its contents: the bookmark code fills the
 *     rail and never touches `hidden`, so "is the column showing bookmarks" has one
 *     answer in one place, and it is `railMode`.
 *
 * What it must not do: reach into `#widget-rail`. That belongs to `widgets.js`, which
 * empties it, hides it and re-appends into it on its own schedule (spec-addendum A15.5
 * covers the focus rules the sheet follows).
 */

import * as i18n from '../common/i18n.js';
import * as log from '../common/log.js';
import * as widgets from './widgets.js';

const t = (key, subs) => i18n.t(key, subs);

/** Any widget that declares no `iconId`; a tool is still reachable without a glyph. */
const FALLBACK_ICON = 'i-tool';

/* ── state ────────────────────────────────────────────────────────────────── */

/** @type {any} */
let ctx = null;
/** @type {HTMLElement|null} */
let strip = null;
/** @type {HTMLElement|null} */
let sheet = null;
/** @type {HTMLElement|null} */
let bookmarkRail = null;
/** The ids currently drawn in the strip, in order. */
let order = [];
/**
 * The mode the strip was last built for, or `null` before the first build. Both
 * no-tick states now hide the strip, so this no longer separates them. It is kept for
 * the FIRST call: without it `sameOrder([], [])` early-returns and `strip.hidden` is
 * never written, leaving the markup's own `hidden` to be right by luck.
 * @type {boolean|null}
 */
let stripMode = null;
/** The tool open in the sheet, or `null`. */
let openId = null;
/** @type {Element|null} */
let lastFocused = null;
let bound = false;

/* ── init ─────────────────────────────────────────────────────────────────── */

/** @param {any} context the shared panel context */
export function init(context) {
  ctx = context || null;
  strip = document.getElementById('tool-strip');
  sheet = document.getElementById('tool-sheet');
  bookmarkRail = document.getElementById('bookmark-rail');

  if (!bound) {
    bound = true;
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    if (sheet) sheet.addEventListener('keydown', onSheetKeyDown);
    window.addEventListener('resize', () => {
      if (openId) positionSheet();
    });
    if (ctx && typeof ctx.subscribe === 'function') {
      ctx.subscribe('settings', (settings) => apply(settings));
    }
  }

  apply(ctx && typeof ctx.getSettings === 'function' ? ctx.getSettings() : null);
}

/* ── the switch ───────────────────────────────────────────────────────────── */

/**
 * Bring the strip, the sheet and the bookmark rail in line with `settings`.
 * Idempotent: called on every settings change, and settings change for reasons that
 * have nothing to do with this feature.
 *
 * @param {any} settings normalised settings, or null
 */
export function apply(settings) {
  const s = settings || {};
  const bookmarksMode = s.railMode === 'bookmarks';

  if (bookmarkRail) bookmarkRail.hidden = !bookmarksMode;

  // The strip carries the tools the user ticked — and only in bookmarks mode, where
  // the rail is not showing them. In `tools` mode it is off entirely, so the bottom bar
  // keeps the height it has always had.
  const wanted = bookmarksMode
    ? (Array.isArray(s.widgets) ? s.widgets : []).filter((id) => widgets.getWidget(id))
    : [];

  if (!strip) return;
  if (bookmarksMode === stripMode && sameOrder(wanted, order)) return;

  // Rebuilding replaces the button the sheet is anchored to, so the sheet goes first —
  // and `closeSheet()` hands focus back to a button the next lines then delete, dropping
  // focus onto <body>. Where that focus is headed is noted before it moves (A15.5).
  const refocus = focusedTool();
  closeSheet();
  order = wanted;
  stripMode = bookmarksMode;
  strip.textContent = '';
  for (const id of wanted) strip.append(buildButton(id));
  // Tools, and nothing else. The way back is `#btn-rail-mode` in the topbar, so the
  // strip no longer carries a switch of its own that would vanish the moment the column
  // changed. With no tool ticked there is nothing to put here, and an empty bar above
  // the bottom bar is only height — hide it and let the tab list have the rows.
  strip.hidden = !bookmarksMode || wanted.length === 0;
  if (refocus) restoreStripFocus(refocus);
}

/**
 * Which strip button should have focus after a rebuild, or `null` when focus is nowhere
 * near the strip and must not be moved.
 *
 * @returns {string|null} a `data-tool` id, or null
 */
function focusedTool() {
  if (!strip) return null;
  // `closeSheet()` is about to put focus on that tool's own button, so it counts as
  // being there already.
  if (openId) return openId;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !strip.contains(active)) return null;
  const button = active.closest('[data-tool]');
  return button instanceof HTMLElement ? (button.dataset.tool ?? null) : null;
}

/**
 * Put focus back on the rebuilt strip. A hidden or emptied strip has nothing to give
 * it to, so focus is left where the browser put it rather than moved somewhere
 * arbitrary. Switching to `tools` is that case and the tools are in the rail by then;
 * so is unticking the last tool while in bookmarks, where focus does land on <body>.
 *
 * @param {string} id a `data-tool` id
 */
function restoreStripFocus(id) {
  if (!strip || strip.hidden) return;
  const next = strip.querySelector(`[data-tool="${id}"]`) || strip.querySelector('button');
  if (!(next instanceof HTMLElement)) return;
  try {
    next.focus({ preventScroll: true });
  } catch (e) {
    log.warn('tool strip focus', e);
  }
}

/** @param {string[]} a @param {string[]} b */
function sameOrder(a, b) {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** @param {string} id @returns {HTMLButtonElement} */
function buildButton(id) {
  const widget = widgets.getWidget(id);
  const label = widget && widget.titleKey ? t(widget.titleKey) : id;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'iconbtn toolstrip__tool';
  button.dataset.testid = `tool-${id}`;
  button.dataset.tool = id;
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(glyph((widget && widget.iconId) || FALLBACK_ICON));
  button.addEventListener('click', (event) => {
    event.preventDefault();
    toggleSheet(id, button);
  });
  return button;
}

/** @param {string} href a symbol id from the inline sprite, without the `#` */
function glyph(href) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${href}`);
  svg.append(use);
  return svg;
}

/* ── the sheet ────────────────────────────────────────────────────────────── */

/** @returns {boolean} */
export function isOpen() {
  return openId !== null;
}

/**
 * @param {string} id
 * @param {HTMLElement} button
 */
function toggleSheet(id, button) {
  if (openId === id) closeSheet();
  else openSheet(id, button);
}

/**
 * @param {string} id
 * @param {HTMLElement} button
 */
export function openSheet(id, button) {
  if (!sheet) sheet = document.getElementById('tool-sheet');
  const widget = widgets.getWidget(id);
  if (!sheet || !widget) return;
  if (openId) closeSheet();

  // The invoking button wins over `document.activeElement`: opening tool B while tool
  // A's sheet is open closes A first, which puts focus back on A's button.
  const active = document.activeElement;
  lastFocused = button instanceof HTMLElement ? button : (active instanceof Element ? active : null);
  openId = id;
  sheet.hidden = false;
  // The dialog is named after the tool inside it, not after the strip.
  sheet.setAttribute('aria-label', widget.titleKey ? t(widget.titleKey) : t('toolStrip'));
  widgets.mountOne(id, sheet);
  if (button) button.setAttribute('aria-expanded', 'true');
  positionSheet();
  focusFirst();
}

/** Close the sheet, tear the tool down and give focus back (spec-addendum A15.5). */
export function closeSheet() {
  if (!openId) return;
  const id = openId;
  openId = null;
  // Before the node is hidden: the scratchpad commits its last edit from its teardown,
  // and a teardown that runs after the element is gone has nothing to read.
  widgets.unmountOne(id);
  if (sheet) {
    sheet.hidden = true;
    sheet.textContent = '';
  }
  const button = strip ? strip.querySelector(`[data-tool="${id}"]`) : null;
  if (button) button.setAttribute('aria-expanded', 'false');

  const target = lastFocused && lastFocused.isConnected ? lastFocused : button;
  lastFocused = null;
  try {
    if (target && typeof (/** @type {any} */ (target).focus) === 'function') {
      /** @type {any} */ (target).focus({ preventScroll: true });
    }
  } catch (e) {
    log.warn('tool sheet restore focus', e);
  }
}

/** Anchored above its button, clamped to the panel — the strip sits at the bottom. */
function positionSheet() {
  if (!sheet || !openId || !strip) return;
  const button = strip.querySelector(`[data-tool="${openId}"]`);
  if (!(button instanceof HTMLElement)) return;
  const anchor = button.getBoundingClientRect();
  sheet.style.position = 'fixed';
  sheet.style.visibility = 'hidden';
  const width = sheet.offsetWidth || 240;
  const height = sheet.offsetHeight || 200;
  let left = Math.min(anchor.left, window.innerWidth - width - 6);
  left = Math.max(6, left);
  let top = anchor.top - height - 6;
  if (top < 6) top = Math.min(anchor.bottom + 6, window.innerHeight - height - 6);
  sheet.style.left = `${Math.round(left)}px`;
  sheet.style.top = `${Math.round(Math.max(6, top))}px`;
  sheet.style.visibility = '';
}

/** @returns {HTMLElement[]} */
function focusables() {
  if (!sheet) return [];
  const nodes = sheet.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]),'
    + ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  return /** @type {HTMLElement[]} */ ([...nodes].filter((el) => el instanceof HTMLElement && !el.hidden));
}

function focusFirst() {
  const first = focusables()[0];
  if (!first) return;
  try {
    first.focus({ preventScroll: true });
  } catch (e) {
    log.warn('tool sheet focus', e);
  }
}

/** @param {KeyboardEvent} event */
function onSheetKeyDown(event) {
  if (!openId) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    // `keyboard.js` treats Escape as "back out of whatever is open" and would blur the
    // sheet's own field instead; the innermost thing open handles it, as the trash
    // popover does.
    event.stopPropagation();
    closeSheet();
    return;
  }
  if (event.key !== 'Tab') return;
  // Focus stays inside the dialog while it is open (A15.5).
  const items = focusables();
  if (items.length === 0) return;
  event.preventDefault();
  const current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const index = current ? items.indexOf(current) : -1;
  const step = event.shiftKey ? -1 : 1;
  const next = items[(index + step + items.length) % items.length];
  if (next) next.focus();
}

/** @param {PointerEvent} event */
function onDocumentPointerDown(event) {
  if (!openId || !sheet) return;
  const target = event.target instanceof Node ? event.target : null;
  if (!target) return;
  if (sheet.contains(target)) return;
  // The strip's own buttons run their own click handler, which toggles.
  if (strip && strip.contains(target)) return;
  closeSheet();
}
