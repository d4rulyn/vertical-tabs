/**
 * Keyed DOM renderer for the tab list (spec.md §8.3/§8.4, spec-addendum A11/A15).
 *
 * Every pass reconciles the existing nodes against the model by key
 * (`c<tabId>` for cards, `g<groupId>` for group sections, `p<tabId>` for pinned
 * tiles) and patches them in place — the list is never rebuilt with
 * `innerHTML`, so scroll position, focus, drag state and decoded thumbnails all
 * survive a render.
 *
 * The module reads `state.js` and drives `thumbs.js`; it never talks to Chrome
 * except for `chrome.runtime.getURL()` through `common/constants.js`.
 */

import * as state from './state.js';
import * as thumbs from './thumbs.js';
import * as i18n from '../common/i18n.js';
import * as log from '../common/log.js';
import { faviconUrl, FAVICON_SIZE } from '../common/constants.js';
import { normalizeColumns, layoutForColumns, normalizeCardWidth, CARD_WIDTH_FILL } from '../common/settings-schema.js';
import * as locks from './locks.js';

const t =
  typeof i18n.t === 'function'
    ? i18n.t
    : (key, subs) => {
        try {
          return chrome.i18n.getMessage(key, subs) || key;
        } catch {
          return key;
        }
      };

/**
 * Localise a freshly cloned template node. `applyI18n()` is also run over every
 * `<template>` at boot, but a `DocumentFragment` root is an unusual argument, so
 * cloned cards localise themselves and never ship an empty `aria-label`.
 * @param {Element} root
 */
function localize(root) {
  for (const node of root.querySelectorAll('[data-i18n]')) {
    const value = t(node.dataset.i18n);
    if (value) node.textContent = value;
  }
  for (const node of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of String(node.dataset.i18nAttr).split(';')) {
      const [attr, key] = pair.split(':').map((part) => (part || '').trim());
      if (!attr || !key) continue;
      const value = t(key);
      if (value) node.setAttribute(attr, value);
    }
  }
}

/**
 * Write a data attribute only when it actually changes. Every write is a
 * MutationRecord, and `search.js` re-runs its filter whenever it sees one, so
 * an unconditional write on every render would wake it needlessly.
 * @param {HTMLElement} el
 * @param {string} key dataset key
 * @param {string|null} value `null` removes the attribute
 */
function setData(el, key, value) {
  if (value === null) {
    if (el.dataset[key] !== undefined) delete el.dataset[key];
    return;
  }
  if (el.dataset[key] !== value) el.dataset[key] = value;
}

/**
 * Write an attribute only when it changes (same reasoning as `setData`).
 * @param {Element} el
 * @param {string} name
 * @param {string} value
 */
function setAttr(el, name, value) {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/** Chromium's nine tab-group colours; anything else falls back to grey. */
const GROUP_COLORS = new Set([
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
]);

/** DOM references, filled by `init()`. */
export const refs = {
  /** @type {HTMLElement|null} */ tablist: null,
  /** @type {HTMLElement|null} */ pinned: null,
  /** @type {HTMLElement|null} */ searchEmpty: null,
  /** @type {HTMLTemplateElement|null} */ tplCard: null,
  /** @type {HTMLTemplateElement|null} */ tplGroup: null,
  /** @type {HTMLTemplateElement|null} */ tplPinned: null,
};

/** @type {number|null} the card that currently owns `tabindex="0"` */
let rovingTabId = null;
/** @type {number|null} the active tab at the end of the previous pass */
let lastScrolledActive = null;
/**
 * Where the search filter comes from. `search.js` owns the input and keeps its
 * own normalised query, so the bootstrap points this at `search.getFilter()`;
 * both modules then compute exactly the same `.is-hidden` / `<mark>` result and
 * cannot fight each other. Without that module the model's own filter is used.
 * @type {() => string}
 */
let filterSource = () => state.state.filter;
/** `keyboard.js` owns the roving `tabindex` when it is loaded. */
let rovingOwnedExternally = false;

/**
 * @param {() => string} fn returns the current normalised query
 */
export function setFilterSource(fn) {
  if (typeof fn === 'function') filterSource = fn;
}

/** @returns {string} the query the renderer is filtering by */
export function currentFilter() {
  try {
    const value = filterSource();
    return typeof value === 'string' ? value : '';
  } catch (e) {
    log.warn('filterSource', e);
    return '';
  }
}

/**
 * @param {boolean} owned true once `keyboard.js` manages `tabindex`
 */
export function setRovingOwner(owned) {
  rovingOwnedExternally = Boolean(owned);
}

/** Cache the DOM references and templates. Idempotent. */
export function init() {
  if (typeof document === 'undefined') return; // unit-test context: no DOM
  refs.tablist = document.getElementById('tablist');
  refs.pinned = document.getElementById('pinned');
  refs.searchEmpty = document.getElementById('search-empty');
  refs.tplCard = document.getElementById('tpl-card');
  refs.tplGroup = document.getElementById('tpl-group');
  refs.tplPinned = document.getElementById('tpl-pinned');
}

/**
 * Publish the settings that are pure attribute switches (spec §8.1 step 2).
 * `theme: 'system'` is resolved here through `prefers-color-scheme`.
 *
 * `data-columns` is the column count the user chose (1…5) and drives
 * `--vt-columns` in the stylesheet. `data-layout` stays as the derived
 * "single column" / "several columns" family, because that is the distinction
 * drag-and-drop, the card's intrinsic size and the group sections branch on.
 *
 * @param {object} settings
 */
export function applySettingsAttrs(settings) {
  const root = document.documentElement;
  const theme = settings && settings.theme ? settings.theme : 'system';
  root.dataset.theme = theme === 'system' ? resolveSystemTheme() : theme;
  const columns = normalizeColumns(settings ? settings.columns : undefined);
  root.dataset.columns = String(columns);
  root.dataset.layout = layoutForColumns(columns);
  root.dataset.thumbs = settings && settings.showThumbnails === false ? 'off' : 'on';

  /* Card width cap.
   *
   * Chrome owns the side panel's own width and will not let an extension set it
   * (`setOptions({width})` is rejected outright), and the panel has a ~360 px
   * minimum. Capping the cards is therefore the only way to get a narrower tab
   * strip. `fill` clears the property so the stylesheet's `none` applies and the
   * cards stretch as they always have.
   */
  const cardWidth = normalizeCardWidth(settings ? settings.cardWidth : undefined);
  root.dataset.cardWidth = String(cardWidth);
  if (cardWidth === CARD_WIDTH_FILL) root.style.removeProperty('--vt-card-max');
  else root.style.setProperty('--vt-card-max', `${cardWidth}px`);
}

/** @returns {'dark'|'light'} */
export function resolveSystemTheme() {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'dark';
  }
}

/* ── Element lookup ──────────────────────────────────────────────────────── */

/** @param {number} tabId @returns {HTMLElement|null} */
export function cardFor(tabId) {
  if (!refs.tablist) return null;
  return refs.tablist.querySelector(`.tab-card[data-tab-id="${tabId}"]`);
}

/** @param {number} tabId @returns {HTMLElement|null} */
export function tileFor(tabId) {
  if (!refs.pinned) return null;
  return refs.pinned.querySelector(`.pinned-tile[data-tab-id="${tabId}"]`);
}

/** @param {number} tabId @returns {HTMLElement|null} card first, then pinned tile */
export function elementFor(tabId) {
  return cardFor(tabId) || tileFor(tabId);
}

/** @param {number} groupId @returns {HTMLElement|null} */
export function groupSectionFor(groupId) {
  if (!refs.tablist) return null;
  return refs.tablist.querySelector(`.group[data-group-id="${groupId}"]`);
}

/** @returns {HTMLElement[]} cards a user can actually see, in DOM order */
export function visibleCards() {
  if (!refs.tablist) return [];
  return [...refs.tablist.querySelectorAll('.tab-card')].filter(
    (el) => !el.classList.contains('is-hidden') && !el.closest('.group.is-collapsed'),
  );
}

/** @returns {HTMLElement[]} */
export function visibleTiles() {
  if (!refs.pinned || refs.pinned.hidden) return [];
  return [...refs.pinned.querySelectorAll('.pinned-tile')].filter(
    (el) => !el.classList.contains('is-hidden'),
  );
}

/* ── Main pass ───────────────────────────────────────────────────────────── */

/** Reconcile the whole panel with the model. Cheap to call repeatedly. */
export function render() {
  if (!refs.tablist) init();
  if (!refs.tablist) return;

  const settings = state.state.settings || {};
  const pinnedInline = settings.pinnedGrid === false;

  renderPinned(pinnedInline);
  renderList(pinnedInline);
  updateRoving();
  maybeScrollActiveIntoView();
  state.emit('rendered');
}

/** Update exactly one card without a full pass (used by `thumbs.js`). */
export function rerenderTab(tabId) {
  const tab = state.getTab(tabId);
  if (!tab) return;
  const card = cardFor(tabId);
  if (card) updateCard(card, tab);
  const tile = tileFor(tabId);
  if (tile) updateTile(tile, tab);
  if (!card && !tile) state.scheduleRender();
}

/* ── Pinned grid ─────────────────────────────────────────────────────────── */

/** @param {boolean} pinnedInline */
function renderPinned(pinnedInline) {
  const host = refs.pinned;
  if (!host) return;
  const tabs = pinnedInline ? [] : state.pinnedTabs();
  host.hidden = tabs.length === 0;
  if (!tabs.length) {
    while (host.firstChild) removeTile(host.firstChild);
    return;
  }
  reconcile(host, tabs.map((tab) => ({ key: `p${tab.id}`, tab })), createTile, updateTileRow, removeTile);
}

/** @param {{tab: chrome.tabs.Tab}} row */
function createTile(row) {
  const el = refs.tplPinned.content.firstElementChild.cloneNode(true);
  el.dataset.tabId = String(row.tab.id);
  el.dataset.vtKey = `p${row.tab.id}`;
  localize(el);
  attachFaviconFallback(el);
  return el;
}

/** @param {HTMLElement} el @param {{tab: chrome.tabs.Tab}} row */
function updateTileRow(el, row) {
  updateTile(el, row.tab);
}

/** @param {HTMLElement} el */
function removeTile(el) {
  el.remove();
}

/**
 * @param {HTMLElement} el
 * @param {chrome.tabs.Tab} tab
 */
function updateTile(el, tab) {
  const s = state.state;
  setData(el, 'tabId', String(tab.id));
  setData(el, 'index', String(tab.index));
  setData(el, 'urlKey', state.keyOf(tab));

  const active = s.activeTabId === tab.id;
  const highlighted = s.highlighted.has(tab.id);
  el.classList.toggle('is-active', active);
  el.classList.toggle('is-highlighted', highlighted && !active);
  el.classList.toggle('is-discarded', Boolean(tab.discarded || tab.frozen));
  el.classList.toggle('is-unread', s.settings.showUnreadDot !== false && s.unread.has(tab.id));
  el.classList.toggle('is-hidden', !state.matchesFilter(tab, currentFilter()));
  setAttr(el, 'aria-selected', active || highlighted ? 'true' : 'false');
  setAttr(el, 'title', tooltipFor(tab));
  setAttr(el, 'aria-label', tab.title || state.urlOf(tab) || t('loading'));
  applyFavicon(el, tab);
}

/* ── Tab list ────────────────────────────────────────────────────────────── */

/**
 * Build the row plan: consecutive tabs sharing a group become one `.group`
 * section; everything else is a top-level card (spec §8.3).
 * @param {boolean} pinnedInline
 * @returns {Array<{key: string, kind: 'card'|'group', tab?: chrome.tabs.Tab, groupId?: number, tabs?: chrome.tabs.Tab[]}>}
 */
function buildRows(pinnedInline) {
  const rows = [];
  let current = null;
  for (const tab of state.orderedTabs()) {
    if (tab.pinned && !pinnedInline) continue;
    const groupId = tab.pinned ? state.TAB_GROUP_ID_NONE : tab.groupId;
    const grouped =
      groupId !== undefined && groupId !== state.TAB_GROUP_ID_NONE && state.state.groups.has(groupId);
    if (grouped) {
      if (current && current.groupId === groupId) {
        current.tabs.push(tab);
        continue;
      }
      current = { key: `g${groupId}`, kind: 'group', groupId, tabs: [tab] };
      rows.push(current);
      continue;
    }
    current = null;
    rows.push({ key: `c${tab.id}`, kind: 'card', tab });
  }
  return rows;
}

/** @param {boolean} pinnedInline */
function renderList(pinnedInline) {
  const rows = buildRows(pinnedInline);
  reconcile(refs.tablist, rows, createRow, updateRow, removeRow);
}

/** @param {{kind: string}} row */
function createRow(row) {
  return row.kind === 'group' ? createGroup(row) : createCard(row.tab);
}

/** @param {HTMLElement} el @param {object} row */
function updateRow(el, row) {
  if (row.kind === 'group') updateGroup(el, row);
  else updateCard(el, row.tab);
}

/** @param {HTMLElement} el */
function removeRow(el) {
  if (el.classList.contains('group')) {
    for (const card of el.querySelectorAll('.tab-card')) releaseCard(card);
  } else if (el.classList.contains('tab-card')) {
    releaseCard(el);
  }
  el.remove();
}

/** @param {HTMLElement} card */
function releaseCard(card) {
  const id = Number(card.dataset.tabId);
  thumbs.unobserve(card, Number.isFinite(id) ? id : undefined);
}

/* ── Groups ──────────────────────────────────────────────────────────────── */

/** @param {{groupId: number}} row */
function createGroup(row) {
  const el = refs.tplGroup.content.firstElementChild.cloneNode(true);
  el.dataset.groupId = String(row.groupId);
  el.dataset.vtKey = `g${row.groupId}`;
  localize(el);
  const body = el.querySelector('.group-body');
  if (body) body.dataset.groupId = String(row.groupId);
  const header = el.querySelector('.group-header');
  if (header) header.dataset.groupId = String(row.groupId);
  return el;
}

/** @param {HTMLElement} el @param {{groupId: number, tabs: chrome.tabs.Tab[]}} row */
function updateGroup(el, row) {
  const group = state.state.groups.get(row.groupId);
  const header = el.querySelector('.group-header');
  const body = el.querySelector('.group-body');
  const toggle = el.querySelector('.group-toggle');
  const swatch = el.querySelector('.group-swatch');
  const titleEl = el.querySelector('.group-title');
  const countEl = el.querySelector('.group-count');
  if (!header || !body) return;

  const color = group && GROUP_COLORS.has(group.color) ? group.color : 'grey';
  el.style.setProperty('--group-color', `var(--vt-group-${color})`);
  setData(el, 'color', color);

  const collapsed = Boolean(group && group.collapsed);
  el.classList.toggle('is-collapsed', collapsed);
  if (toggle) {
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    const label = t(collapsed ? 'groupExpand' : 'groupCollapse');
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
  }
  if (swatch) {
    swatch.setAttribute('aria-label', t('groupColor'));
    swatch.title = t('groupColor');
  }

  const named = Boolean(group && group.title);
  if (titleEl) {
    const label = named ? group.title : t('groupUntitled');
    if (titleEl.textContent !== label) titleEl.textContent = label;
    titleEl.classList.toggle('is-untitled', !named);
    titleEl.title = label;
  }
  if (countEl) {
    // `chrome.i18n` has no plural support, so the singular is a separate key.
    // Locales without plural inflection (ja) simply repeat the same string.
    const n = row.tabs.length;
    const count = n === 1 ? t('groupTabCountOne', [String(n)]) : t('groupTabCount', [String(n)]);
    if (countEl.textContent !== count) countEl.textContent = count;
  }
  el.setAttribute('aria-label', named ? group.title : t('groupUntitled'));

  reconcile(
    body,
    row.tabs.map((tab) => ({ key: `c${tab.id}`, kind: 'card', tab })),
    createRow,
    updateRow,
    removeRow,
  );

  // A group whose every card is filtered out disappears with them (spec §9.4).
  const anyVisible = row.tabs.some((tab) => state.matchesFilter(tab, currentFilter()));
  el.classList.toggle('is-hidden', !anyVisible);
}

/* ── Cards ───────────────────────────────────────────────────────────────── */

/** @param {chrome.tabs.Tab} tab */
function createCard(tab) {
  const el = refs.tplCard.content.firstElementChild.cloneNode(true);
  el.dataset.tabId = String(tab.id);
  el.dataset.vtKey = `c${tab.id}`;
  el.id = `vt-card-${tab.id}`;
  localize(el);
  attachFaviconFallback(el);
  thumbs.observe(el);
  return el;
}

/**
 * @param {HTMLElement} el
 * @param {chrome.tabs.Tab} tab
 */
function updateCard(el, tab) {
  const s = state.state;
  setData(el, 'tabId', String(tab.id));
  setData(el, 'index', String(tab.index));
  setData(el, 'status', tab.status || 'complete');
  setData(el, 'groupId', String(tab.groupId === undefined ? state.TAB_GROUP_ID_NONE : tab.groupId));
  setData(el, 'urlKey', state.keyOf(tab));

  const active = s.activeTabId === tab.id;
  const highlighted = s.highlighted.has(tab.id);
  const discarded = Boolean(tab.discarded || tab.frozen);
  const unread = s.settings.showUnreadDot !== false && s.unread.has(tab.id);
  const muted = Boolean(tab.mutedInfo && tab.mutedInfo.muted);
  const isLocked = locks.isLocked(tab.id);
  const audible = Boolean(tab.audible);

  el.classList.toggle('is-active', active);
  el.classList.toggle('is-highlighted', highlighted && !active);
  el.classList.toggle('is-loading', tab.status === 'loading');
  el.classList.toggle('is-discarded', discarded);
  el.classList.toggle('is-audible', audible && !muted);
  el.classList.toggle('is-muted', muted);
  el.classList.toggle('is-unread', unread);
  el.classList.toggle('is-locked', isLocked);
  el.classList.toggle('is-pinned-inline', Boolean(tab.pinned) && s.settings.pinnedGrid === false);
  el.classList.toggle('is-hidden', !state.matchesFilter(tab, currentFilter()));
  setAttr(el, 'aria-selected', active || highlighted ? 'true' : 'false');
  setAttr(el, 'title', tooltipFor(tab));
  // Without an explicit name the option's accessible name is computed from its
  // contents, which swept in the close and audio buttons' own labels: the
  // accessibility tree read "Beta Muted (click to unmute) Close tab" for every
  // card, and announced the buttons again as children on a full traversal. Naming
  // the card outright stops name-from-content, so the state that belongs to the
  // TAB is carried here instead — including the hibernated and unread states,
  // which otherwise reached a screen reader only through the `title` attribute
  // and the sr-only span respectively.
  setAttr(el, 'aria-label', cardLabel(tab, { unread, discarded, audible, muted }));

  const unreadLabel = el.querySelector('.unread-label');
  if (unreadLabel) unreadLabel.hidden = !unread;

  const pinBadge = el.querySelector('.pin-badge');
  if (pinBadge) pinBadge.hidden = !(tab.pinned && s.settings.pinnedGrid === false);

  const lockBadge = el.querySelector('.lock-badge');
  if (lockBadge) {
    lockBadge.hidden = !isLocked;
    if (isLocked) setAttr(lockBadge, 'title', t('lockedTabTooltip'));
  }
  // The close button is not merely refused, it is taken away: a button that is there
  // and does nothing reads as a bug, and the lock is meant to be visible.
  const closeBtn = el.querySelector('.close');
  if (closeBtn) closeBtn.hidden = isLocked;

  const titleEl = el.querySelector('.title');
  if (titleEl) setTitleText(titleEl, tab.title || state.urlOf(tab) || t('loading'), currentFilter());

  const audioBtn = el.querySelector('.audio');
  if (audioBtn) {
    const show = audible || muted;
    audioBtn.hidden = !show;
    if (show) {
      const label = t(muted ? 'audioMuted' : 'audioPlaying');
      audioBtn.setAttribute('aria-label', label);
      audioBtn.title = label;
      const use = audioBtn.querySelector('use');
      const href = muted ? '#i-muted' : '#i-audio';
      if (use && use.getAttribute('href') !== href) use.setAttribute('href', href);
    }
  }

  applyFavicon(el, tab);
  thumbs.applyTo(el, tab);
}

/**
 * The card's accessible name: what a screen reader should read for this ONE tab.
 *
 * Deliberately excludes the URL, which the `title` tooltip carries — a full URL
 * read aloud on every arrow-key move is noise — and excludes the close and audio
 * buttons, which are reachable on their own and are not part of the tab's name.
 *
 * @param {chrome.tabs.Tab} tab
 * @param {{unread: boolean, discarded: boolean, audible: boolean, muted: boolean}} flags
 * @returns {string}
 */
function cardLabel(tab, flags) {
  const parts = [];
  if (flags.unread) parts.push(t('unreadTab'));
  parts.push(tab.title || state.urlOf(tab) || t('loading'));
  if (flags.discarded) parts.push(t('hibernated'));
  if (flags.muted) parts.push(t('audioMuted'));
  else if (flags.audible) parts.push(t('audioPlaying'));
  return parts.join(' — ');
}

/**
 * Native tooltip: title, URL, and the hibernated marker (spec §9.1).
 * @param {chrome.tabs.Tab} tab
 * @returns {string}
 */
function tooltipFor(tab) {
  const url = state.urlOf(tab);
  const parts = [tab.title || url || t('loading')];
  if (url) parts.push(url);
  let text = parts.join('\n');
  if (tab.discarded || tab.frozen) text += ` — ${t('hibernated')}`;
  return text;
}

/**
 * Write the title, wrapping search matches in `<mark>` (spec §9.4).
 * @param {HTMLElement} el
 * @param {string} text
 * @param {string} filter already normalised
 */
function setTitleText(el, text, filter) {
  if (!filter) {
    if (el.textContent !== text || el.firstElementChild) el.textContent = text;
    return;
  }
  const haystack = state.normalizeFilter(text);
  const at = haystack.indexOf(filter);
  // The normalised string can differ in length from the original (NFKC), so
  // only highlight when the offsets are still trustworthy.
  if (at < 0 || haystack.length !== text.length) {
    if (el.textContent !== text || el.firstElementChild) el.textContent = text;
    return;
  }
  const before = text.slice(0, at);
  const match = text.slice(at, at + filter.length);
  const after = text.slice(at + filter.length);
  el.textContent = '';
  if (before) el.append(document.createTextNode(before));
  const mark = document.createElement('mark');
  mark.textContent = match;
  el.append(mark);
  if (after) el.append(document.createTextNode(after));
}

/* ── Favicons ────────────────────────────────────────────────────────────── */

/**
 * `tab.favIconUrl` is whatever the page put in its own `<link rel="icon">`, so
 * the page — not the user and not this extension — chooses the host, path and
 * query string. Handing that string to an `<img>` inside the panel document
 * makes the *extension* issue the request, and because `<all_urls>` is granted
 * the request carries that host's cookies: an uncredentialed browser favicon
 * fetch is upgraded into a credentialed cross-site one that fires whenever the
 * panel renders, needs no page script, and contradicts the "no network
 * requests" privacy promise (spec.md §14.8) used to justify the `<all_urls>`
 * warning. So a declared icon is used verbatim only when it is self-contained
 * (`data:image/…`, which cannot reach the network); every remote icon is
 * served instead by Chrome's own `_favicon` database — exactly what the
 * `favicon` permission is for.
 *
 * Measured in this project's Chromium 151 image: at the instant
 * `tabs.onUpdated` reports a new `favIconUrl`, `_favicon` already returns that
 * site's real icon (identical 119-byte payload) rather than the 601-byte
 * generic fallback, so the local source loses no fidelity — provided the
 * request is re-issued when the declared icon changes, which `favRev` below
 * does.
 *
 * @param {string} url
 * @returns {boolean} true when loading `url` cannot cause a network request
 */
function isInertIconUrl(url) {
  return /^data:image\//i.test(url);
}

/**
 * Short stable token for a declared favicon URL. It is appended to the
 * `_favicon` query so that "Chrome has just discovered this page's icon"
 * produces a *different* URL and the `<img>` re-requests it; the page-supplied
 * string itself never reaches the URL. Unknown query parameters are ignored by
 * the `_favicon` handler (measured: identical 200/119-byte response with and
 * without).
 * @param {string} declared
 * @returns {string}
 */
function favRev(declared) {
  let h = 5381;
  for (let i = 0; i < declared.length; i += 1) h = (h * 33) ^ declared.charCodeAt(i);
  return (h >>> 0).toString(36);
}

/**
 * Source order: a self-contained `data:` icon → the `_favicon` helper → the
 * globe glyph (spec §8.3 as amended by the privacy rule above). The stage is
 * advanced by the image's own `error` event.
 * @param {HTMLElement} el card or pinned tile
 */
function attachFaviconFallback(el) {
  const img = el.querySelector('.favicon');
  if (!img) return;
  img.addEventListener('error', () => {
    const stage = Number(img.dataset.favStage || '0');
    setFaviconStage(el, stage + 1);
  });
}

/**
 * @param {HTMLElement} el
 * @param {chrome.tabs.Tab} tab
 */
function applyFavicon(el, tab) {
  const img = el.querySelector('.favicon');
  if (!img) return;
  const declared = tab.favIconUrl && tab.favIconUrl !== '' ? tab.favIconUrl : '';
  // Only the inert form is kept; a remote icon is reduced to its change token,
  // so no page-chosen URL is ever written into the panel's DOM.
  const inert = isInertIconUrl(declared) ? declared : '';
  const rev = declared ? favRev(declared) : '';
  const pageUrl = state.urlOf(tab);
  if (img.dataset.favSrc !== inert || img.dataset.favRev !== rev || img.dataset.favPage !== pageUrl) {
    img.dataset.favSrc = inert;
    img.dataset.favRev = rev;
    img.dataset.favPage = pageUrl;
    setFaviconStage(el, inert ? 0 : 1);
  }
}

/**
 * @param {HTMLElement} el
 * @param {number} stage 0 = an inert (`data:`) `tab.favIconUrl`, 1 = `_favicon` helper, 2 = glyph
 */
function setFaviconStage(el, stage) {
  const img = el.querySelector('.favicon');
  const fallback = el.querySelector('.favicon-fallback');
  if (!img) return;
  const inert = img.dataset.favSrc || '';
  const rev = img.dataset.favRev || '';
  const pageUrl = img.dataset.favPage || '';
  let next = stage;
  if (next === 0 && !inert) next = 1;
  if (next === 1 && !pageUrl) next = 2;

  let src = '';
  if (next === 0) src = inert;
  else if (next === 1) {
    src = faviconUrl(pageUrl, FAVICON_SIZE);
    if (src && rev) src += `&r=${rev}`;
  }
  if (next === 1 && !src) next = 2;

  img.dataset.favStage = String(next);
  if (next >= 2) {
    img.removeAttribute('src');
    img.hidden = true;
    // `hidden` is an HTMLElement property; `.favicon-fallback` is an inline <svg>,
    // where assigning it creates a plain JS property and leaves the attribute (and
    // so `[hidden] { display: none !important }`) untouched. The globe never showed.
    if (fallback) fallback.toggleAttribute('hidden', false);
    return;
  }
  if (fallback) fallback.toggleAttribute('hidden', true);
  img.hidden = false;
  if (img.getAttribute('src') !== src) img.setAttribute('src', src);
}

/* ── Roving tabindex and scrolling (spec-addendum A15) ───────────────────── */

/** @returns {HTMLElement|null} the card that currently owns `tabindex="0"` */
export function focusedCard() {
  if (!refs.tablist) return null;
  return refs.tablist.querySelector('.tab-card[tabindex="0"]');
}

/** @returns {number|null} */
export function rovingTab() {
  return rovingTabId;
}

/**
 * Move the roving `tabindex` to a card (or tile) without a full render.
 * @param {HTMLElement|number|null} target element or tab id
 */
export function setRoving(target) {
  const tabId =
    typeof target === 'number'
      ? target
      : target && target.dataset
        ? Number(target.dataset.tabId)
        : null;
  rovingTabId = Number.isFinite(tabId) ? tabId : null;
  updateRoving();
}

/** Give exactly one card and one tile `tabindex="0"`. */
function updateRoving() {
  if (!refs.tablist) return;
  if (rovingOwnedExternally) return; // keyboard.js re-applies tabindex after every render
  const cards = visibleCards();
  let chosen = cards.find((el) => Number(el.dataset.tabId) === rovingTabId) || null;
  if (!chosen) chosen = cards.find((el) => Number(el.dataset.tabId) === state.state.activeTabId) || null;
  if (!chosen) chosen = cards[0] || null;
  rovingTabId = chosen ? Number(chosen.dataset.tabId) : null;
  for (const el of refs.tablist.querySelectorAll('.tab-card')) {
    el.tabIndex = el === chosen ? 0 : -1;
  }
  const tiles = visibleTiles();
  const activeTile = tiles.find((el) => Number(el.dataset.tabId) === state.state.activeTabId) || tiles[0] || null;
  for (const el of refs.pinned ? refs.pinned.querySelectorAll('.pinned-tile') : []) {
    el.tabIndex = el === activeTile ? 0 : -1;
  }
}

/** Keep the active card on screen, but never fight the user (A15.3). */
function maybeScrollActiveIntoView() {
  const activeId = state.state.activeTabId;
  if (activeId === lastScrolledActive) return;
  lastScrolledActive = activeId;
  if (activeId == null) return;
  if (state.state.dragging || state.state.pointerInList) return;
  scrollTabIntoView(activeId);
}

/** @param {number} tabId */
export function scrollTabIntoView(tabId) {
  const el = elementFor(tabId);
  if (!el) return;
  try {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
  } catch (e) {
    log.warn('scrollIntoView', e);
  }
}

/* ── Generic keyed reconciliation ────────────────────────────────────────── */

/**
 * Patch `container`'s children so they match `rows` in order, reusing existing
 * nodes by `row.key`. Nodes are moved, never re-created.
 *
 * @param {HTMLElement} container
 * @param {Array<{key: string}>} rows
 * @param {(row: any) => HTMLElement} create
 * @param {(el: HTMLElement, row: any) => void} update
 * @param {(el: HTMLElement) => void} remove
 */
function reconcile(container, rows, create, update, remove) {
  if (!container) return;
  /** @type {Map<string, HTMLElement>} */
  const existing = new Map();
  for (const child of [...container.children]) {
    const key = child.dataset ? child.dataset.vtKey : null;
    if (key) existing.set(key, child);
    else child.remove(); // stray node: not ours
  }

  let index = 0;
  for (const row of rows) {
    let el = existing.get(row.key);
    if (el) existing.delete(row.key);
    else el = create(row);
    const currentAt = container.children[index];
    if (currentAt !== el) container.insertBefore(el, currentAt || null);
    index += 1;
    try {
      update(el, row);
    } catch (e) {
      log.error('render row', e);
    }
  }

  for (const el of existing.values()) remove(el);
}
