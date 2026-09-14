/**
 * Keyboard navigation and in-panel shortcuts (spec.md §9.6, addendum A15).
 *
 * `#tablist` is the focus root and uses a roving `tabindex`: exactly one card
 * (or pinned tile) is in the tab order, the arrow keys move it. The global
 * shortcuts (`_execute_action`, `search-tabs`) are Chrome `commands` and are
 * handled by the service worker — they never reach this document.
 *
 * DOM touched: `#tablist`, `#pinned`, `.tab-card`, `.pinned-tile`,
 * `.group-header`, `.close`, `#btn-new-tab`.
 */

import * as log from '../common/log.js';
import * as ops from './tab-ops.js';
import * as search from './search.js';
import * as contextMenu from './context-menu.js';
import * as settingsView from './settings-view.js';
import * as trash from './trash.js';
import * as palette from './palette.js';
import * as toastMod from './toast.js';

const NONE = ops.TAB_GROUP_ID_NONE;

/* ── state ────────────────────────────────────────────────────────────────── */

/** @type {any} */
let ctx = null;
/** @type {HTMLElement|null} */
let tablist = null;
/** @type {HTMLElement|null} */
let pinnedEl = null;
/** @type {number|null} */
let focusedTabId = null;
/** @type {number|null} */
let lastTileTabId = null;
/** @type {{ successorTabId: number|null, mode: 'close'|'card', at: number }|null} */
let pendingFocus = null;
/** A pending focus hand-off is abandoned when its card never shows up. */
const PENDING_FOCUS_TTL_MS = 2000;
/** @type {MutationObserver|null} */
let observer = null;
let syncQueued = false;
let bound = false;

/* ── init ─────────────────────────────────────────────────────────────────── */

/** @param {any} context */
export function init(context) {
  ctx = ops.init(context) || context || null;
  tablist = document.getElementById('tablist');
  pinnedEl = document.getElementById('pinned');

  if (!bound) {
    bound = true;
    document.addEventListener('keydown', onKeyDown);
    for (const root of [tablist, pinnedEl]) {
      if (!root) continue;
      root.addEventListener('focusin', onFocusIn);
      // A15.4: a close button removes the card it lives in, so the successor
      // has to be picked before the DOM changes.
      root.addEventListener('click', onClickCapture, true);
    }
    observeRenders();
  }
  sync();
}

/** @returns {number|null} the tab whose card currently holds the roving focus */
export function getFocusedTabId() {
  return focusedTabId;
}

/**
 * Re-apply the roving `tabindex` after a render. Safe to call at any time; it
 * never moves focus on its own.
 */
export function sync() {
  if (!tablist) tablist = document.getElementById('tablist');
  if (!pinnedEl) pinnedEl = document.getElementById('pinned');
  applyPendingFocus();

  const cards = visibleCards();
  if (cards.length > 0) {
    let target = focusedTabId != null ? cardFor(focusedTabId) : null;
    if (!target || !cards.includes(target)) {
      const model = ops.model();
      const activeId = model && Number.isInteger(model.activeTabId) ? model.activeTabId : null;
      target = (activeId != null && cards.find((card) => tabIdOf(card) === activeId)) || cards[0];
      focusedTabId = tabIdOf(target);
    }
    for (const card of cards) card.tabIndex = card === target ? 0 : -1;
  } else {
    focusedTabId = null;
  }

  const tiles = visibleTiles();
  if (tiles.length > 0) {
    let target = lastTileTabId != null ? tiles.find((tile) => tabIdOf(tile) === lastTileTabId) : null;
    if (!target) target = tiles[0];
    for (const tile of tiles) tile.tabIndex = tile === target ? 0 : -1;
  }
}

/**
 * Move focus to a specific tab's card (used by `sidepanel.js` after a
 * programmatic activation).
 * @param {number} tabId
 * @returns {boolean}
 */
export function focusTab(tabId) {
  const card = cardFor(tabId);
  if (!card) return false;
  focusedTabId = tabId;
  sync();
  try {
    card.focus({ preventScroll: false });
  } catch (e) {
    log.warn('focusTab', e);
    return false;
  }
  return true;
}

/* ── event plumbing ───────────────────────────────────────────────────────── */

/**
 * @param {Event} event
 */
function onFocusIn(event) {
  const el = event.target instanceof Element ? event.target : null;
  if (!el) return;
  const card = el.closest('.tab-card');
  if (card) {
    const id = tabIdOf(card);
    if (id != null) {
      focusedTabId = id;
      sync();
    }
    return;
  }
  const tile = el.closest('.pinned-tile');
  if (tile) {
    const id = tabIdOf(tile);
    if (id != null) {
      lastTileTabId = id;
      sync();
    }
  }
}

/**
 * @param {MouseEvent} event
 */
function onClickCapture(event) {
  const el = event.target instanceof Element ? event.target : null;
  if (!el) return;
  const closeBtn = el.closest('.close');
  if (!closeBtn) return;
  const card = closeBtn.closest('.tab-card') || closeBtn.closest('.pinned-tile');
  if (!card) return;
  const tabId = tabIdOf(card);
  if (tabId == null) return;
  pendingFocus = { successorTabId: successorOf(tabId), mode: 'close', at: Date.now() };
}

function observeRenders() {
  if (observer || typeof MutationObserver !== 'function') return;
  observer = new MutationObserver(() => {
    if (syncQueued) return;
    syncQueued = true;
    const run = () => {
      syncQueued = false;
      sync();
    };
    if (document.hidden) setTimeout(run, 0);
    else requestAnimationFrame(run);
  });
  const options = { childList: true, subtree: true };
  if (tablist) observer.observe(tablist, options);
  if (pinnedEl) observer.observe(pinnedEl, options);
}

/** A15.4: focus the successor once the removed card is actually gone. */
function applyPendingFocus() {
  if (!pendingFocus) return;
  const { successorTabId, mode, at } = pendingFocus;
  if (Date.now() - at > PENDING_FOCUS_TTL_MS) {
    // Giving up on the successor must not mean giving up on focus. The deadline is a
    // wall clock racing a render, so a loaded machine can blow through it while the
    // card that HELD focus is already gone — leaving `document.activeElement` on
    // `<body>`, which is exactly the state addendum A15 says must never happen (seen
    // once in a full-suite run, never in this spec on its own).
    pendingFocus = null;
    rescueFocus();
    return;
  }
  if (successorTabId != null) {
    const card = cardFor(successorTabId);
    if (!card) return; // the render has not caught up yet
    pendingFocus = null;
    focusedTabId = successorTabId;
    const target = mode === 'close' ? card.querySelector('.close') : card;
    try {
      if (target instanceof HTMLElement) target.focus({ preventScroll: false });
      else card.focus({ preventScroll: false });
    } catch (e) {
      log.warn('applyPendingFocus', e);
    }
    return;
  }
  pendingFocus = null;
  const newTab = document.getElementById('btn-new-tab');
  if (newTab instanceof HTMLElement) {
    try {
      newTab.focus({ preventScroll: true });
    } catch (e) {
      log.warn('applyPendingFocus new tab', e);
    }
  }
}

/**
 * Put focus back inside the panel when it has fallen out of it.
 *
 * Only acts when focus is genuinely lost — on `<body>` or detached — so it can never
 * take focus away from something the user moved to themselves.
 */
function rescueFocus() {
  const active = document.activeElement;
  const lost = !active || active === document.body || !active.isConnected;
  if (!lost) return;
  const card = tablist && tablist.querySelector('.tab-card:not(.is-hidden)');
  const fallback = card || document.getElementById('btn-new-tab');
  if (!(fallback instanceof HTMLElement)) return;
  try {
    fallback.focus({ preventScroll: true });
    const id = tabIdOf(fallback);
    if (id != null) focusedTabId = id;
  } catch (e) {
    log.warn('rescueFocus', e);
  }
}

/* ── the key handler ──────────────────────────────────────────────────────── */

/**
 * @param {KeyboardEvent} event
 */
function onKeyDown(event) {
  if (event.defaultPrevented) return;

  if (event.key === 'Escape') {
    onEscape(event);
    return;
  }

  // The command palette: Ctrl/Cmd+Shift+P, from anywhere including the search box.
  // Not Ctrl+K — that focuses the search box (spec.md §9.6) and has since the first
  // release; taking a documented shortcut away to give it to a newer feature is a bad
  // trade for anyone who already has the old one in their fingers.
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'p' || event.key === 'P')) {
    event.preventDefault();
    palette.toggle();
    return;
  }

  // Menus, the drawer, the palette and the popover handle their own keys.
  if (palette.isOpen()) return;
  if (contextMenu.isOpen() || settingsView.isOpen() || trash.isOpen() || toastMod.isConfirmOpen()) return;

  const target = event.target instanceof Element ? event.target : null;
  const inEditable = isEditable(target);

  // Focus the search box: `/`, Ctrl+K, Ctrl+F (spec.md §9.6).
  if (!inEditable) {
    if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      search.focusSearch();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === 'k' || event.key === 'K' || event.key === 'f' || event.key === 'F')) {
      event.preventDefault();
      search.focusSearch();
      return;
    }
  }

  if (inEditable) return;

  const header = target ? target.closest('.group-header') : null;
  if (header) {
    onGroupHeaderKey(event, /** @type {HTMLElement} */ (header));
    return;
  }

  const tile = target ? target.closest('.pinned-tile') : null;
  if (tile) {
    onTileKey(event, /** @type {HTMLElement} */ (tile));
    return;
  }

  const card = target ? target.closest('.tab-card') : null;
  if (!card) {
    // ArrowDown from the search box or the top bar enters the list.
    if (event.key === 'ArrowDown' && target && target.closest('.topbar')) {
      const first = visibleCards()[0];
      if (first) {
        event.preventDefault();
        first.focus();
      }
    }
    return;
  }
  onCardKey(event, /** @type {HTMLElement} */ (card));
}

/**
 * @param {KeyboardEvent} event
 */
function onEscape(event) {
  if (toastMod.isConfirmOpen()) {
    event.preventDefault();
    toastMod.closeConfirm(false);
    return;
  }
  if (contextMenu.isOpen()) {
    event.preventDefault();
    contextMenu.close();
    return;
  }
  if (trash.isOpen()) {
    event.preventDefault();
    trash.close();
    return;
  }
  if (settingsView.isOpen()) {
    event.preventDefault();
    settingsView.close();
    return;
  }
  if (search.isFiltering()) {
    event.preventDefault();
    search.clearSearch();
    return;
  }
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) {
    event.preventDefault();
    active.blur();
  }
}

/**
 * @param {KeyboardEvent} event
 * @param {HTMLElement} card
 */
function onCardKey(event, card) {
  const tabId = tabIdOf(card);
  if (tabId == null) return;
  const cards = visibleCards();
  const index = cards.indexOf(card);
  const columns = columnCountFor(card);

  switch (event.key) {
    case 'ArrowDown': {
      event.preventDefault();
      if (event.altKey) {
        void moveFocusedTab(tabId, 1);
        return;
      }
      const next = cards[Math.min(cards.length - 1, index + columns)];
      focusCardEl(next, event.shiftKey);
      break;
    }
    case 'ArrowUp': {
      event.preventDefault();
      if (event.altKey) {
        void moveFocusedTab(tabId, -1);
        return;
      }
      if (index - columns < 0) {
        // A15.6: leaving the top of the list returns to the pinned strip.
        const tiles = visibleTiles();
        if (tiles.length > 0) {
          const tile = (lastTileTabId != null && tiles.find((item) => tabIdOf(item) === lastTileTabId)) || tiles[tiles.length - 1];
          tile.focus();
          return;
        }
        return;
      }
      focusCardEl(cards[index - columns], event.shiftKey);
      break;
    }
    case 'ArrowRight': {
      if (columns > 1) {
        event.preventDefault();
        focusCardEl(cards[Math.min(cards.length - 1, index + 1)], event.shiftKey);
      }
      break;
    }
    case 'ArrowLeft': {
      if (columns > 1) {
        event.preventDefault();
        focusCardEl(cards[Math.max(0, index - 1)], event.shiftKey);
        return;
      }
      // In a single column, ArrowLeft on a grouped card focuses its header.
      const section = card.closest('.group');
      const groupHeader = section ? section.querySelector('.group-header') : null;
      if (groupHeader instanceof HTMLElement) {
        event.preventDefault();
        groupHeader.focus();
      }
      break;
    }
    case 'Home': {
      event.preventDefault();
      focusCardEl(cards[0], event.shiftKey);
      break;
    }
    case 'End': {
      event.preventDefault();
      focusCardEl(cards[cards.length - 1], event.shiftKey);
      break;
    }
    case 'Enter':
    case ' ': {
      event.preventDefault();
      void ops.activate(tabId);
      break;
    }
    case 'Delete':
    case 'Backspace': {
      event.preventDefault();
      pendingFocus = { successorTabId: successorOf(tabId), mode: 'card', at: Date.now() };
      void ops.remove(tabId);
      break;
    }
    case 'ContextMenu': {
      event.preventDefault();
      contextMenu.openForElement(card);
      break;
    }
    case 'F10': {
      if (event.shiftKey) {
        event.preventDefault();
        contextMenu.openForElement(card);
      }
      break;
    }
    default:
      break;
  }
}

/**
 * @param {KeyboardEvent} event
 * @param {HTMLElement} tile
 */
function onTileKey(event, tile) {
  const tabId = tabIdOf(tile);
  if (tabId == null) return;
  const tiles = visibleTiles();
  const index = tiles.indexOf(tile);

  switch (event.key) {
    case 'ArrowRight': {
      event.preventDefault();
      const next = tiles[Math.min(tiles.length - 1, index + 1)];
      if (next) next.focus();
      break;
    }
    case 'ArrowLeft': {
      event.preventDefault();
      const prev = tiles[Math.max(0, index - 1)];
      if (prev) prev.focus();
      break;
    }
    case 'Home': {
      event.preventDefault();
      if (tiles[0]) tiles[0].focus();
      break;
    }
    case 'End': {
      event.preventDefault();
      const last = tiles[tiles.length - 1];
      if (last) last.focus();
      break;
    }
    case 'ArrowDown': {
      event.preventDefault();
      const first = visibleCards()[0];
      if (first) first.focus();
      break;
    }
    case 'Enter':
    case ' ': {
      event.preventDefault();
      void ops.activate(tabId);
      break;
    }
    case 'Delete':
    case 'Backspace': {
      event.preventDefault();
      pendingFocus = { successorTabId: successorOf(tabId), mode: 'card', at: Date.now() };
      void ops.remove(tabId);
      break;
    }
    case 'ContextMenu': {
      event.preventDefault();
      void contextMenu.openForTab(tabId, tile.getBoundingClientRect().left, tile.getBoundingClientRect().bottom);
      break;
    }
    default:
      break;
  }
}

/**
 * @param {KeyboardEvent} event
 * @param {HTMLElement} header
 */
function onGroupHeaderKey(event, header) {
  const section = header.closest('.group');
  const groupId = section ? Number(section.getAttribute('data-group-id')) : NaN;
  if (!Number.isInteger(groupId)) return;
  const group = ops.groups().get(groupId);
  const collapsed = group ? group.collapsed === true : false;

  // The colour swatch is its own control inside the header (`role="button"`).
  const onSwatch = event.target instanceof Element && event.target.closest('.group-swatch') !== null;
  if (onSwatch && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    const rect = /** @type {Element} */ (event.target).getBoundingClientRect();
    contextMenu.openGroupColorPicker(groupId, rect.left, rect.bottom + 2);
    return;
  }

  switch (event.key) {
    case 'ArrowRight': {
      event.preventDefault();
      if (collapsed) void ops.updateGroup(groupId, { collapsed: false });
      break;
    }
    case 'ArrowLeft': {
      event.preventDefault();
      if (!collapsed) void ops.updateGroup(groupId, { collapsed: true });
      break;
    }
    case 'ArrowDown': {
      event.preventDefault();
      const cards = visibleCards();
      const first = cards.find((card) => card.closest('.group') === section) || null;
      if (first) first.focus();
      else {
        const after = cards.find((card) => header.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING);
        if (after) after.focus();
      }
      break;
    }
    case 'ArrowUp': {
      event.preventDefault();
      const cards = visibleCards();
      let previous = null;
      for (const card of cards) {
        if (header.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_PRECEDING) previous = card;
      }
      if (previous) previous.focus();
      break;
    }
    case 'Enter':
    case ' ': {
      event.preventDefault();
      void ops.updateGroup(groupId, { collapsed: !collapsed });
      break;
    }
    case 'F2': {
      event.preventDefault();
      contextMenu.startGroupRename(groupId);
      break;
    }
    case 'ContextMenu': {
      event.preventDefault();
      const rect = header.getBoundingClientRect();
      contextMenu.openForGroup(groupId, rect.left + 8, rect.bottom);
      break;
    }
    case 'F10': {
      if (event.shiftKey) {
        event.preventDefault();
        const rect = header.getBoundingClientRect();
        contextMenu.openForGroup(groupId, rect.left + 8, rect.bottom);
      }
      break;
    }
    default:
      break;
  }
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

/**
 * @param {HTMLElement|undefined|null} card
 * @param {boolean} extendSelection Shift+Arrow adds the tab to the selection
 */
function focusCardEl(card, extendSelection) {
  if (!card) return;
  try {
    card.focus({ preventScroll: false });
  } catch (e) {
    log.warn('focusCardEl', e);
  }
  if (!extendSelection) return;
  const tabId = tabIdOf(card);
  if (tabId != null) void ops.update(tabId, { highlighted: true });
}

/**
 * Alt+Arrow moves the focused tab one position inside its pinned/unpinned
 * region and then reconciles the group membership Chrome may have changed.
 * @param {number} tabId
 * @param {number} delta
 */
async function moveFocusedTab(tabId, delta) {
  const windowId = ops.windowId();
  const list = await ops.queryTabs({ windowId });
  const current = list.find((tab) => tab.id === tabId);
  if (!current) return;
  const region = list.filter((tab) => tab.pinned === current.pinned);
  const position = region.findIndex((tab) => tab.id === tabId);
  const nextPosition = position + delta;
  if (position < 0 || nextPosition < 0 || nextPosition >= region.length) return;

  const before = current.groupId ?? NONE;
  await ops.move(tabId, { index: region[nextPosition].index });

  const after = await ops.queryTabs({ windowId });
  const moved = after.find((tab) => tab.id === tabId);
  if (moved && (moved.groupId ?? NONE) !== before) {
    const prev = after[moved.index - 1];
    const next = after[moved.index + 1];
    const interior =
      prev && next && prev.groupId === moved.groupId && next.groupId === moved.groupId;
    if (!interior) {
      if (before === NONE) await ops.ungroup(tabId);
      else await ops.group({ tabIds: [tabId], groupId: before });
    }
  }
  ops.resync();
  focusedTabId = tabId;
  pendingFocus = null;
}

/**
 * The card that should receive focus once `tabId`'s card disappears
 * (A15.4: next, else previous, else `null` for `#btn-new-tab`).
 * @param {number} tabId
 * @returns {number|null}
 */
function successorOf(tabId) {
  const cards = visibleCards();
  const index = cards.findIndex((card) => tabIdOf(card) === tabId);
  if (index < 0) return cards.length > 0 ? tabIdOf(cards[0]) : null;
  if (index + 1 < cards.length) return tabIdOf(cards[index + 1]);
  if (index - 1 >= 0) return tabIdOf(cards[index - 1]);
  return null;
}

/**
 * @param {Element} el
 * @returns {number|null}
 */
function tabIdOf(el) {
  const raw = Number(el.getAttribute('data-tab-id'));
  return Number.isInteger(raw) ? raw : null;
}

/**
 * @param {number} tabId
 * @returns {HTMLElement|null}
 */
function cardFor(tabId) {
  if (!tablist) return null;
  const el = tablist.querySelector(`.tab-card[data-tab-id="${tabId}"]`);
  return el instanceof HTMLElement ? el : null;
}

/**
 * @returns {HTMLElement[]} cards the user can actually see, in DOM order
 */
function visibleCards() {
  if (!tablist) tablist = document.getElementById('tablist');
  if (!tablist) return [];
  /** @type {HTMLElement[]} */
  const out = [];
  for (const card of tablist.querySelectorAll('.tab-card')) {
    if (!(card instanceof HTMLElement)) continue;
    if (card.classList.contains('is-hidden')) continue;
    if (card.offsetParent === null && card.getClientRects().length === 0) continue; // collapsed group
    out.push(card);
  }
  return out;
}

/**
 * @returns {HTMLElement[]}
 */
function visibleTiles() {
  if (!pinnedEl) pinnedEl = document.getElementById('pinned');
  if (!pinnedEl || pinnedEl.hidden) return [];
  /** @type {HTMLElement[]} */
  const out = [];
  for (const tile of pinnedEl.querySelectorAll('.pinned-tile')) {
    if (!(tile instanceof HTMLElement)) continue;
    if (tile.classList.contains('is-hidden')) continue;
    out.push(tile);
  }
  return out;
}

/**
 * Column count of the grid a card sits in — cards inside a group body use the
 * group's own grid (spec.md §9.6, P2 graft).
 * @param {HTMLElement} card
 * @returns {number}
 */
function columnCountFor(card) {
  const parent = card.parentElement;
  if (!parent) return 1;
  try {
    const style = getComputedStyle(parent);
    if (style.display !== 'grid' && style.display !== 'inline-grid') return 1;
    const tracks = String(style.gridTemplateColumns || '')
      .trim()
      .split(/\s+/)
      .filter((value) => value !== '' && value !== 'none');
    return Math.max(1, tracks.length);
  } catch {
    return 1;
  }
}

/**
 * @param {Element|null} el
 * @returns {boolean}
 */
function isEditable(el) {
  if (!el) return false;
  const editable = el.closest('input, textarea, select, [contenteditable="true"]');
  return editable !== null;
}
