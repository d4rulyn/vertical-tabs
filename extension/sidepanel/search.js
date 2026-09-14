/**
 * The search / filter box (spec.md §9.4, spec-addendum A15.8).
 *
 * Filtering is a pure DOM operation on top of whatever `render.js` produced:
 * non-matching cards get `.is-hidden`, groups without a visible card get
 * `.is-hidden`, pinned tiles are filtered too, and matches inside the title are
 * wrapped in `<mark>`. The model keeps the normalised query in `state.filter`.
 *
 * Normalisation is `NFKC` + lower case (P1 graft): with it, `ｇｍａｉｌ`,
 * `GMAIL` and `gmail` all match the same tabs, which matters for Japanese
 * full-width input.
 *
 * Filtering the panel's own list is therefore window-scoped by construction: the
 * model behind it is `tabs.query({ windowId })`. `#other-windows` is the answer to
 * the obvious next question — while a search is running it asks Chrome for EVERY
 * tab and lists the matches that live somewhere else, so "where did I leave that
 * page" stops depending on which window the reader is standing in. Those tabs are
 * deliberately NOT merged into the model: drag-and-drop, the keyboard map and the
 * differential renderer all assume one window, and a second window's tab in that
 * model would be a tab they could reorder into nowhere.
 *
 * DOM touched: `#search-input`, `#search-clear`, `#search-count`,
 * `#search-empty`, `#other-windows`, `.tab-card`, `.pinned-tile`, `.group`, `.title`.
 */

import * as log from '../common/log.js';
import {
  SEARCH_DEBOUNCE_MS,
  STORAGE_SESSION,
  PENDING_FOCUS_SEARCH_TTL_MS,
} from '../common/constants.js';
import * as ops from './tab-ops.js';
import { t, toast } from './toast.js';
import { faviconUrl, OTHER_WINDOW_RESULTS_MAX } from '../common/constants.js';

/* ── state ────────────────────────────────────────────────────────────────── */

/** @type {any} */
let ctx = null;
/** @type {HTMLInputElement|null} */
let input = null;
/** @type {HTMLElement|null} */
let clearBtn = null;
/** @type {HTMLElement|null} */
let countEl = null;
/** @type {HTMLElement|null} */
let emptyEl = null;
/** @type {HTMLElement|null} */
let tablist = null;
/** @type {HTMLElement|null} */
let pinnedEl = null;
/** @type {MutationObserver|null} */
let observer = null;
/** @type {HTMLElement|null} */
let otherEl = null;
/** @type {HTMLElement|null} */
let otherListEl = null;
/** @type {HTMLElement|null} */
let otherCountEl = null;
/** Bumped on every query so a slow answer cannot paint over a newer one. */
let otherEpoch = 0;

let filter = '';
let debounceTimer = 0;
let applying = false;
let bound = false;

/* ── public API ───────────────────────────────────────────────────────────── */

/**
 * `s => s.normalize('NFKC').toLowerCase().trim()`
 * @param {unknown} value
 * @returns {string}
 */
export function normalize(value) {
  if (typeof value !== 'string' || value === '') return '';
  try {
    return value.normalize('NFKC').toLowerCase().trim();
  } catch {
    return value.toLowerCase().trim();
  }
}

/** @param {any} context */
export function init(context) {
  ctx = ops.init(context) || context || null;

  input = /** @type {HTMLInputElement|null} */ (document.getElementById('search-input'));
  clearBtn = document.getElementById('search-clear');
  countEl = document.getElementById('search-count');
  emptyEl = document.getElementById('search-empty');
  tablist = document.getElementById('tablist');
  pinnedEl = document.getElementById('pinned');
  otherEl = document.getElementById('other-windows');
  otherListEl = otherEl ? otherEl.querySelector('.otherwin__list') : null;
  otherCountEl = otherEl ? otherEl.querySelector('.otherwin__count') : null;

  if (!bound) {
    bound = true;
    if (input) {
      input.addEventListener('input', onInput);
      input.addEventListener('keydown', onKeyDown);
      input.addEventListener('search', onInput); // the native clear "×" of <input type="search">
    }
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        clearSearch();
        focusSearch();
      });
    }
    observeRenders();
    try {
      chrome.storage.onChanged.addListener(onStorageChanged);
    } catch (e) {
      log.warn('search storage.onChanged', e);
    }
  }

  applyFilter();
  void consumePendingFocusSearch();
}

/** @returns {string} the normalised query (`''` when not filtering) */
export function getFilter() {
  return filter;
}

/** @returns {boolean} */
export function isFiltering() {
  return filter !== '';
}

/** Move keyboard focus into the search field and select what is there. */
export function focusSearch() {
  if (!input) input = /** @type {HTMLInputElement|null} */ (document.getElementById('search-input'));
  if (!input) return;
  try {
    input.focus({ preventScroll: true });
    input.select();
  } catch (e) {
    log.warn('focusSearch', e);
  }
}

/** Empty the query, drop every `.is-hidden`, hide the counter. */
export function clearSearch() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = 0;
  }
  if (input) input.value = '';
  setFilter('');
}

/**
 * Re-apply the current filter to the DOM. `sidepanel.js` may call this at the
 * end of a render pass; the built-in `MutationObserver` makes that optional.
 */
export function applyFilter() {
  if (!tablist) tablist = document.getElementById('tablist');
  if (!pinnedEl) pinnedEl = document.getElementById('pinned');
  if (!tablist) return;

  applying = true;
  try {
    const model = ops.model();
    let total = 0;
    let visible = 0;

    for (const card of tablist.querySelectorAll('.tab-card')) {
      const tabId = Number(card.getAttribute('data-tab-id'));
      const tab = model && model.tabs ? model.tabs.get(tabId) : null;
      const title = tab && typeof tab.title === 'string' ? tab.title : textOfTitle(card);
      const url = (tab && (tab.url || tab.pendingUrl)) || card.getAttribute('data-url-key') || '';
      const match = matchesText(title, url);
      total += 1;
      if (match) visible += 1;
      card.classList.toggle('is-hidden', !match);
      paintTitle(card, title, match);
    }

    if (pinnedEl) {
      for (const tile of pinnedEl.querySelectorAll('.pinned-tile')) {
        const tabId = Number(tile.getAttribute('data-tab-id'));
        const tab = model && model.tabs ? model.tabs.get(tabId) : null;
        const title = (tab && tab.title) || tile.getAttribute('title') || '';
        const url = (tab && (tab.url || tab.pendingUrl)) || tile.getAttribute('data-url-key') || '';
        const match = matchesText(title, url);
        total += 1;
        if (match) visible += 1;
        tile.classList.toggle('is-hidden', !match);
      }
    }

    for (const group of tablist.querySelectorAll('.group')) {
      const anyVisible = group.querySelector('.tab-card:not(.is-hidden)');
      group.classList.toggle('is-hidden', filter !== '' && !anyVisible);
    }

    if (countEl) {
      if (filter === '') {
        countEl.hidden = true;
        countEl.textContent = '';
      } else {
        countEl.hidden = false;
        countEl.textContent = total === 1
          ? t('searchCountOne', [String(visible), String(total)])
          : t('searchCount', [String(visible), String(total)]);
      }
    }
    if (emptyEl) emptyEl.hidden = !(filter !== '' && visible === 0);
  } catch (e) {
    log.warn('applyFilter', e);
  } finally {
    applying = false;
    // Discard the records our own writes just produced.
    if (observer) observer.takeRecords();
  }
}

/**
 * The first card the user would see — used by Enter in the search box and by
 * the keyboard module after a filter change.
 * @returns {HTMLElement|null}
 */
export function firstVisibleCard() {
  if (!tablist) tablist = document.getElementById('tablist');
  if (!tablist) return null;
  for (const card of tablist.querySelectorAll('.tab-card:not(.is-hidden)')) {
    if (isRendered(/** @type {HTMLElement} */ (card))) return /** @type {HTMLElement} */ (card);
  }
  return null;
}

/**
 * Consume `storage.session.pendingFocusSearch` written by the `search-tabs`
 * command (spec.md §6.3). The key is deleted immediately and honoured only
 * while it is fresh and addressed to this window (spec-addendum A15.8).
 * @returns {Promise<boolean>} whether the search box was focused
 */
export async function consumePendingFocusSearch() {
  let pending = null;
  try {
    const key = STORAGE_SESSION.pendingFocusSearch;
    const stored = await chrome.storage.session.get(key);
    pending = stored ? stored[key] : null;
    if (pending) await chrome.storage.session.remove(key);
  } catch (e) {
    log.warn('consumePendingFocusSearch', e);
    return false;
  }
  if (!pending || typeof pending !== 'object') return false;
  const at = Number(pending.at) || 0;
  if (Date.now() - at >= PENDING_FOCUS_SEARCH_TTL_MS) return false;
  const target = pending.windowId;
  if (target != null && Number.isInteger(target) && target !== ops.windowId()) return false;
  focusSearch();
  return true;
}

/* ── internals ────────────────────────────────────────────────────────────── */

function onInput() {
  if (debounceTimer) clearTimeout(debounceTimer);
  const value = input ? input.value : '';
  if (clearBtn) clearBtn.hidden = value === '';
  debounceTimer = setTimeout(() => {
    debounceTimer = 0;
    setFilter(value);
  }, SEARCH_DEBOUNCE_MS);
}

/**
 * @param {KeyboardEvent} event
 */
function onKeyDown(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = 0;
      setFilter(input ? input.value : '');
    }
    const card = firstVisibleCard();
    if (!card) return;
    const tabId = Number(card.getAttribute('data-tab-id'));
    if (Number.isInteger(tabId)) void ops.activate(tabId);
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    if (filter !== '' || (input && input.value !== '')) {
      clearSearch();
    }
    focusActiveCard();
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    const card = firstVisibleCard();
    if (card) card.focus();
  }
}

/**
 * @param {string} raw
 */
function setFilter(raw) {
  const next = normalize(raw);
  const changed = next !== filter;
  filter = next;
  if (clearBtn) clearBtn.hidden = (input ? input.value : '') === '';
  if (changed) {
    // `state.setFilter()` normalises again, stores the query and schedules the
    // render pass that repaints `.is-hidden` / `<mark>` from the same source.
    const stateModule = ctx && ctx.state;
    if (stateModule && typeof stateModule.setFilter === 'function') {
      stateModule.setFilter(next);
    } else {
      const model = ops.model();
      if (model) model.filter = next;
      ops.rerender();
    }
  }
  applyFilter();
  if (changed) void refreshOtherWindows();
}

/* ── other windows ────────────────────────────────────────────────────────── */

/**
 * Ask Chrome for every tab and list the matches that are not in this window.
 *
 * `chrome.tabs.query({})` is the only call in the panel that deliberately looks
 * past `windowId`. It runs on a changed query only, and its answer is discarded
 * unless it is still the newest one — a slow answer to "goo" must never paint
 * over the answer to "google".
 */
async function refreshOtherWindows() {
  if (!otherEl || !otherListEl) return;
  const epoch = (otherEpoch += 1);

  if (filter === '') {
    paintOtherWindows([], epoch);
    return;
  }

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (e) {
    log.warn('search: cross-window query', e);
    paintOtherWindows([], epoch);
    return;
  }

  const here = ops.windowId();
  const ownPrefix = ownPagePrefix();
  const hits = [];
  for (const tab of tabs) {
    if (!tab || tab.windowId === here) continue;
    // Incognito tabs are outside everything this extension shows or stores.
    if (tab.incognito) continue;
    const url = tab.url || tab.pendingUrl || '';
    // The panel's own documents — a popped-out list, another window's panel page —
    // are furniture, not results.
    if (ownPrefix && url.startsWith(ownPrefix)) continue;
    if (!matchesText(tab.title || '', url)) continue;
    hits.push(tab);
    if (hits.length >= OTHER_WINDOW_RESULTS_MAX) break;
  }
  paintOtherWindows(hits, epoch);
}

/** @returns {string} the extension's own origin, or '' when it cannot be read */
function ownPagePrefix() {
  try {
    return chrome.runtime.getURL('');
  } catch {
    return '';
  }
}

/**
 * @param {chrome.tabs.Tab[]} hits
 * @param {number} epoch
 */
function paintOtherWindows(hits, epoch) {
  if (epoch !== otherEpoch || !otherEl || !otherListEl) return;
  otherListEl.textContent = '';
  if (!hits.length) {
    otherEl.hidden = true;
    if (otherCountEl) otherCountEl.textContent = '';
    return;
  }
  for (const tab of hits) otherListEl.append(otherWindowRow(tab));
  if (otherCountEl) otherCountEl.textContent = String(hits.length);
  otherEl.hidden = false;
}

/**
 * One result. Activating it focuses the window FIRST and then the tab: the other
 * order leaves Chrome showing the right tab in a window still behind this one.
 * @param {chrome.tabs.Tab} tab
 * @returns {HTMLElement}
 */
function otherWindowRow(tab) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'otherwin__row';
  row.dataset.tabId = String(tab.id);
  row.dataset.testid = 'other-window-result';

  const img = document.createElement('img');
  img.className = 'otherwin__favicon';
  img.alt = '';
  img.width = 16;
  img.height = 16;
  // Chrome's own favicon database, never the page-declared URL: the panel must not
  // make a credentialed request to a host just because a tab is open on it.
  const icon = faviconUrl(tab.url || '');
  if (icon) img.src = icon;

  const text = document.createElement('span');
  text.className = 'otherwin__text';
  const title = document.createElement('span');
  title.className = 'otherwin__title-line';
  title.textContent = tab.title || tab.url || '';
  const host = document.createElement('span');
  host.className = 'otherwin__host';
  host.textContent = hostOf(tab.url || tab.pendingUrl || '');
  text.append(title, host);

  row.append(img, text);
  row.title = `${tab.title || ''}\n${tab.url || ''}`.trim();
  row.addEventListener('click', () => void revealTab(tab));
  return row;
}

/** @param {string} url */
function hostOf(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** @param {chrome.tabs.Tab} tab */
async function revealTab(tab) {
  try {
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
  } catch (e) {
    log.warn('search: reveal', e);
    toast(t('operationFailed'));
  }
}

/**
 * @param {string} title
 * @param {string} url
 * @returns {boolean}
 */
function matchesText(title, url) {
  if (filter === '') return true;
  return normalize(title).includes(filter) || normalize(url).includes(filter);
}

/**
 * @param {Element} card
 * @returns {string}
 */
function textOfTitle(card) {
  const el = card.querySelector('.title');
  return el && el.textContent ? el.textContent : '';
}

/**
 * Wrap the matched run of the title in `<mark>`. Built from DOM nodes, never
 * from an HTML string: tab titles are page-controlled text.
 * @param {Element} card
 * @param {string} title
 * @param {boolean} match
 */
function paintTitle(card, title, match) {
  const el = card.querySelector('.title');
  if (!el) return;
  // The renderer owns the text; the filter only ever adds or removes <mark>.
  const displayed = el.textContent || '';
  if (filter === '' || !match) {
    if (el.querySelector('mark')) el.textContent = displayed;
    return;
  }
  const source = title && title !== '' ? title : displayed;
  const haystack = normalize(source);
  const at = haystack.indexOf(filter);
  // NFKC can change string length (ﬁ → fi, ｇ → g), so an index found in the
  // normalised text is only usable when the lengths still line up.
  if (at < 0 || haystack.length !== source.length) {
    if (el.querySelector('mark')) el.textContent = displayed;
    return;
  }
  const before = source.slice(0, at);
  const hit = source.slice(at, at + filter.length);
  const after = source.slice(at + filter.length);
  const existing = el.querySelector('mark');
  if (existing && existing.textContent === hit && displayed === source) return;
  const fragment = document.createDocumentFragment();
  if (before) fragment.append(document.createTextNode(before));
  const mark = document.createElement('mark');
  mark.textContent = hit;
  fragment.append(mark);
  if (after) fragment.append(document.createTextNode(after));
  el.textContent = '';
  el.append(fragment);
}

/**
 * `render.js` rebuilds cards whenever Chrome fires an event; re-apply the
 * filter afterwards so freshly inserted cards obey it.
 */
function observeRenders() {
  if (observer || typeof MutationObserver !== 'function') return;
  observer = new MutationObserver((records) => {
    if (applying || filter === '') return;
    let relevant = false;
    for (const record of records) {
      if (record.type === 'childList' && (record.addedNodes.length || record.removedNodes.length)) {
        relevant = true;
        break;
      }
      if (record.type === 'characterData' || record.type === 'attributes') {
        relevant = true;
        break;
      }
    }
    if (relevant) applyFilter();
  });
  const options = {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-tab-id', 'data-url-key', 'data-group-id'],
  };
  if (tablist) observer.observe(tablist, options);
  if (pinnedEl) observer.observe(pinnedEl, options);
}

/**
 * @param {{ [key: string]: chrome.storage.StorageChange }} changes
 * @param {string} area
 */
function onStorageChanged(changes, area) {
  if (area !== 'session' || !changes) return;
  if (!changes[STORAGE_SESSION.pendingFocusSearch]) return;
  if (!changes[STORAGE_SESSION.pendingFocusSearch].newValue) return;
  void consumePendingFocusSearch();
}

/** Focus the card of the active tab (Escape's "focus back to the list"). */
function focusActiveCard() {
  const model = ops.model();
  const activeId = model && Number.isInteger(model.activeTabId) ? model.activeTabId : null;
  let card = null;
  if (activeId != null && tablist) {
    card = tablist.querySelector(`.tab-card[data-tab-id="${activeId}"]:not(.is-hidden)`);
  }
  if (!card) card = firstVisibleCard();
  if (card instanceof HTMLElement) {
    try {
      card.focus({ preventScroll: false });
      return;
    } catch (e) {
      log.warn('focusActiveCard', e);
    }
  }
  if (tablist) {
    try {
      tablist.focus({ preventScroll: true });
    } catch {
      /* #tablist is tabindex="-1"; failing to focus it is harmless */
    }
  }
}

/**
 * @param {HTMLElement} el
 * @returns {boolean} laid out (not inside a collapsed group)
 */
function isRendered(el) {
  return el.offsetParent !== null || el.getClientRects().length > 0;
}
