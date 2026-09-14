/**
 * The in-panel context menus (spec.md §9.3) plus the group-header editing they
 * share: inline rename and the colour picker.
 *
 * Chrome's `contextMenus` API cannot decorate extension pages, so the menu is
 * plain DOM inside `#context-menu`: `role="menu"` with `role="menuitem"`
 * buttons, `data-testid="menu-item-<id>"`, submenu chevrons, arrow-key
 * navigation and focus restoration (spec-addendum A15.5).
 *
 * DOM touched: `#context-menu`, `.tab-card`, `.pinned-tile`, `.group`,
 * `.group-header`, `.group-title`, `.group-swatch`.
 */

import * as log from '../common/log.js';
import {
  GROUP_COLOR_IDS,
  GROUP_COLOR_LABEL_KEYS,
  groupColorVar,
} from '../common/group-colors.js';
import * as locks from './locks.js';
import * as ops from './tab-ops.js';
import { t, toast, confirmBar } from './toast.js';
import * as settingsView from './settings-view.js';

const MSG = ops.MSG;
const NONE = ops.TAB_GROUP_ID_NONE;

/**
 * @typedef {Object} MenuItem
 * @property {string} [id]        `data-testid="menu-item-<id>"`
 * @property {string} [label]
 * @property {boolean} [separator]
 * @property {boolean} [disabled]
 * @property {string} [swatch]    a group colour name, drawn as a dot
 * @property {MenuItem[]} [submenu]
 * @property {() => unknown} [run]
 */

/* ── state ────────────────────────────────────────────────────────────────── */

/** @type {any} */
let ctx = null;
/** @type {HTMLElement|null} */
let menuEl = null;
/** @type {HTMLElement|null} */
let submenuEl = null;
/** @type {Element|null} */
let lastFocused = null;
let open = false;
let bound = false;

/* ── init ─────────────────────────────────────────────────────────────────── */

/** @param {any} context */
export function init(context) {
  ctx = ops.init(context) || context || null;
  menuEl = document.getElementById('context-menu');
  if (bound) return;
  bound = true;

  const tablist = document.getElementById('tablist');
  const pinnedEl = document.getElementById('pinned');
  for (const root of [tablist, pinnedEl]) {
    if (!root) continue;
    root.addEventListener('contextmenu', onContextMenu);
    // Group-header pointer interactions live with the menu because they share
    // the rename/colour implementations (spec.md §9.1).
    root.addEventListener('click', onGroupHeaderClick);
    root.addEventListener('dblclick', onGroupTitleDblClick);
  }

  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  window.addEventListener('blur', () => close());
  if (tablist) tablist.addEventListener('scroll', () => close(), { passive: true });
}

/** @returns {boolean} */
export function isOpen() {
  return open;
}

/* ── entry points ─────────────────────────────────────────────────────────── */

/**
 * @param {MouseEvent} event
 */
function onContextMenu(event) {
  const el = event.target instanceof Element ? event.target : null;
  if (!el) return;
  // Keep the native menu for text fields (copy/paste).
  if (el.closest('input, textarea, [contenteditable="true"]')) return;

  event.preventDefault();
  event.stopPropagation();

  const card = el.closest('.tab-card');
  const tile = el.closest('.pinned-tile');
  const header = el.closest('.group-header');
  const node = card || tile;

  if (node) {
    const tabId = Number(node.getAttribute('data-tab-id'));
    if (Number.isInteger(tabId)) {
      void openForTab(tabId, event.clientX, event.clientY);
      return;
    }
  }
  if (header) {
    const section = header.closest('.group');
    const groupId = section ? Number(section.getAttribute('data-group-id')) : NaN;
    if (Number.isInteger(groupId)) {
      openForGroup(groupId, event.clientX, event.clientY);
      return;
    }
  }
  openForEmpty(event.clientX, event.clientY);
}

/**
 * Card / pinned-tile menu.
 * @param {number} tabId
 * @param {number} x
 * @param {number} y
 * @returns {Promise<void>}
 */
export async function openForTab(tabId, x, y) {
  const tab = await ops.fetchTab(tabId);
  if (!tab) return;
  const selection = ops.selectionFor(tabId);
  const multi = selection.length > 1;
  const groupList = [...ops.groups().values()];
  const allTabs = ops.tabsInOrder();
  const unpinnedOthers = allTabs.filter((item) => item.id !== tabId && !item.pinned);
  const below = allTabs.filter((item) => !item.pinned && (item.index ?? 0) > (tab.index ?? 0));
  const grouped = tab.groupId != null && tab.groupId !== NONE;

  /** @type {MenuItem[]} */
  const items = [
    {
      id: 'new-tab-after',
      label: t('newTab'),
      run: () => ops.create({ windowId: ops.windowId(), index: (tab.index ?? 0) + 1, active: true }),
    },
    { id: 'reload', label: t('reload'), run: () => Promise.all(selection.map((id) => ops.reload(id))) },
    { id: 'duplicate', label: t('duplicate'), run: () => ops.duplicate(tabId) },
    { separator: true },
    tab.pinned
      ? { id: 'unpin', label: t('unpinTab'), run: () => setPinned(selection, false) }
      : { id: 'pin', label: t('pinTab'), run: () => setPinned(selection, true) },
    tab.mutedInfo && tab.mutedInfo.muted
      ? { id: 'unmute', label: t('unmuteTab'), run: () => setMuted(selection, false) }
      : { id: 'mute', label: t('muteTab'), run: () => setMuted(selection, true) },
    {
      id: 'hibernate',
      label: t('hibernateTab'),
      disabled: tab.active === true || tab.discarded === true,
      run: () => Promise.all(selection.map((id) => ops.discard(id))),
    },
    {
      id: 'refresh-preview',
      label: t('refreshPreview'),
      disabled: !(tab.active === true && tab.discarded !== true),
      run: () =>
        ops.request({
          type: MSG.CAPTURE_REQUEST,
          windowId: ops.windowId(),
          tabId,
          reason: 'manual-refresh',
        }),
    },
    { separator: true },
  ];

  if (!tab.pinned) {
    items.push({
      id: 'group-new',
      label: t('addToNewGroup'),
      run: () => ops.group({ tabIds: selection, createProperties: { windowId: ops.windowId() } }),
    });
    if (groupList.length > 0) {
      items.push({
        id: 'group-add',
        label: t('addToGroup'),
        submenu: groupList.map((group) => ({
          id: `group-add-${group.id}`,
          label: group.title && group.title !== '' ? group.title : t('groupUntitled'),
          swatch: group.color,
          run: () => ops.group({ tabIds: selection, groupId: group.id }),
        })),
      });
    }
  }
  if (grouped) {
    items.push({ id: 'group-remove', label: t('removeFromGroup'), run: () => ops.ungroup(selection) });
  }

  // A lock only ever means "nothing this panel does will close this tab" — Chrome's own
  // close button is out of reach for any extension. The label says lock, the README and
  // the tooltip say how far it goes.
  const allLocked = selection.every((id) => locks.isLocked(id));
  items.push(
    { separator: true },
    {
      id: 'lock',
      label: allLocked
        ? (multi ? t('unlockNTabs', [String(selection.length)]) : t('unlockTab'))
        : (multi ? t('lockNTabs', [String(selection.length)]) : t('lockTab')),
      run: () => {
        for (const id of selection) locks.set(id, !allLocked);
        ops.rerender();
      },
    },
    { separator: true },
    { id: 'move-new-window', label: t('moveToNewWindow'), run: () => moveToNewWindow(selection) },
    {
      id: 'copy-url',
      label: t('copyUrl'),
      disabled: !(tab.url || tab.pendingUrl),
      run: () => copyUrl(tab.url || tab.pendingUrl || ''),
    },
    { separator: true },
    {
      id: 'close',
      label: multi ? t('closeNTabs', [String(selection.length)]) : t('closeTab'),
      run: () => closeTabs(selection),
    },
  );

  if (unpinnedOthers.length > 0) {
    items.push({
      id: 'close-others',
      label: t('closeOtherTabs'),
      run: () => closeTabs(unpinnedOthers.map((item) => item.id).filter(isId)),
    });
  }
  if (below.length > 0) {
    items.push({
      id: 'close-below',
      label: t('closeTabsBelow'),
      run: () => closeTabs(below.map((item) => item.id).filter(isId)),
    });
  }
  if (grouped) {
    items.push({
      id: 'close-group',
      label: t('closeGroup'),
      run: () => closeTabs(tabIdsOfGroup(tab.groupId)),
    });
  }
  items.push({ separator: true }, { id: 'reopen', label: t('reopenClosedTab'), run: reopenLastClosed });

  openMenu(items, x, y);
}

/**
 * Group-header menu.
 * @param {number} groupId
 * @param {number} x
 * @param {number} y
 */
export function openForGroup(groupId, x, y) {
  const group = ops.groups().get(groupId);
  const tabIds = tabIdsOfGroup(groupId);
  const collapsed = group ? group.collapsed === true : false;

  /** @type {MenuItem[]} */
  const items = [
    { id: 'group-new-tab', label: t('groupNewTab'), run: () => newTabInGroup(groupId) },
    { id: 'group-rename', label: t('groupRename'), run: () => startGroupRename(groupId) },
    { id: 'group-color', label: t('groupColor'), submenu: colorItems(groupId) },
    collapsed
      ? { id: 'group-expand', label: t('groupExpand'), run: () => ops.updateGroup(groupId, { collapsed: false }) }
      : { id: 'group-collapse', label: t('groupCollapse'), run: () => ops.updateGroup(groupId, { collapsed: true }) },
    { separator: true },
    { id: 'group-ungroup', label: t('groupUngroup'), disabled: tabIds.length === 0, run: () => ops.ungroup(tabIds) },
    { id: 'group-close', label: t('closeGroup'), disabled: tabIds.length === 0, run: () => closeTabs(tabIds) },
  ];
  openMenu(items, x, y);
}

/**
 * Menu for the empty area of the list.
 * @param {number} x
 * @param {number} y
 */
export function openForEmpty(x, y) {
  /** @type {MenuItem[]} */
  const items = [
    { id: 'new-tab', label: t('newTab'), run: () => ops.create({ windowId: ops.windowId(), active: true }) },
    { id: 'reopen', label: t('reopenClosedTab'), run: reopenLastClosed },
    { separator: true },
    { id: 'settings', label: t('settings'), run: () => settingsView.open() },
  ];
  openMenu(items, x, y);
}

/**
 * Open the card menu from the keyboard (ContextMenu / Shift+F10), anchored to
 * the card itself (spec.md §9.6).
 * @param {HTMLElement} card
 */
export function openForElement(card) {
  const rect = card.getBoundingClientRect();
  const x = Math.round(rect.left + Math.min(24, rect.width / 2));
  const y = Math.round(rect.top + Math.min(24, rect.height / 2));
  const tabId = Number(card.getAttribute('data-tab-id'));
  if (Number.isInteger(tabId)) {
    void openForTab(tabId, x, y);
    return;
  }
  const section = card.closest('.group');
  const groupId = section ? Number(section.getAttribute('data-group-id')) : NaN;
  if (Number.isInteger(groupId)) openForGroup(groupId, x, y);
}

/* ── group header pointer interactions ────────────────────────────────────── */

/**
 * @param {MouseEvent} event
 */
function onGroupHeaderClick(event) {
  const el = event.target instanceof Element ? event.target : null;
  if (!el) return;
  const header = el.closest('.group-header');
  if (!header) return;
  if (el.closest('.group-rename')) return;

  const section = header.closest('.group');
  const groupId = section ? Number(section.getAttribute('data-group-id')) : NaN;
  if (!Number.isInteger(groupId)) return;

  if (el.closest('.group-swatch')) {
    event.preventDefault();
    event.stopPropagation();
    const rect = el.getBoundingClientRect();
    openGroupColorPicker(groupId, rect.left, rect.bottom + 2);
    return;
  }
  // The chevron and the rest of the header both toggle the group.
  const group = ops.groups().get(groupId);
  const collapsed = group ? group.collapsed === true : false;
  event.preventDefault();
  void ops.updateGroup(groupId, { collapsed: !collapsed });
}

/**
 * @param {MouseEvent} event
 */
function onGroupTitleDblClick(event) {
  const el = event.target instanceof Element ? event.target : null;
  if (!el) return;
  const title = el.closest('.group-title');
  if (!title) return;
  const section = title.closest('.group');
  const groupId = section ? Number(section.getAttribute('data-group-id')) : NaN;
  if (!Number.isInteger(groupId)) return;
  event.preventDefault();
  event.stopPropagation();
  startGroupRename(groupId);
}

/**
 * Replace the group title with an `<input>`; Enter or blur commits, Escape
 * cancels (spec.md §9.1).
 * @param {number} groupId
 */
export function startGroupRename(groupId) {
  close();
  const section = document.querySelector(`.group[data-group-id="${groupId}"]`);
  const header = section ? section.querySelector('.group-header') : null;
  const titleEl = header ? header.querySelector('.group-title') : null;
  if (!header || !(titleEl instanceof HTMLElement)) return;
  if (header.querySelector('.group-rename')) return;

  const group = ops.groups().get(groupId);
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'group-rename';
  input.dataset.testid = 'group-rename-input';
  input.value = group && typeof group.title === 'string' ? group.title : '';
  input.setAttribute('aria-label', t('groupRename'));
  input.maxLength = 200;

  titleEl.hidden = true;
  titleEl.after(input);
  try {
    input.focus();
    input.select();
  } catch (e) {
    log.warn('group rename focus', e);
  }

  let done = false;
  /** @param {boolean} commit */
  const finish = (commit) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    input.remove();
    titleEl.hidden = false;
    if (commit) void ops.updateGroup(groupId, { title: value });
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (event) => event.stopPropagation());
  input.addEventListener('dblclick', (event) => event.stopPropagation());
}

/**
 * The nine-swatch colour popover (spec.md §9.1: click on `.group-swatch`).
 * @param {number} groupId
 * @param {number} x
 * @param {number} y
 */
export function openGroupColorPicker(groupId, x, y) {
  openMenu(colorItems(groupId), x, y);
}

/**
 * @param {number} groupId
 * @returns {MenuItem[]}
 */
function colorItems(groupId) {
  return GROUP_COLOR_IDS.map((color) => ({
    id: `group-color-${color}`,
    label: t(GROUP_COLOR_LABEL_KEYS[color]),
    swatch: color,
    run: () => ops.updateGroup(groupId, { color: /** @type {any} */ (color) }),
  }));
}

/* ── actions ──────────────────────────────────────────────────────────────── */

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isId(value) {
  return Number.isInteger(value);
}

/**
 * @param {number} groupId
 * @returns {number[]}
 */
function tabIdsOfGroup(groupId) {
  return ops
    .tabsInOrder()
    .filter((tab) => tab.groupId === groupId)
    .map((tab) => tab.id)
    .filter(isId);
}

/**
 * @param {number[]} tabIds
 * @param {boolean} pinned
 */
async function setPinned(tabIds, pinned) {
  for (const id of tabIds) await ops.update(id, { pinned });
}

/**
 * @param {number[]} tabIds
 * @param {boolean} muted
 */
async function setMuted(tabIds, muted) {
  for (const id of tabIds) await ops.update(id, { muted });
}

/**
 * `windows.create({ tabId })` takes a single tab; the rest of a selection is
 * appended to the new window afterwards.
 * @param {number[]} tabIds
 */
async function moveToNewWindow(tabIds) {
  if (tabIds.length === 0) return;
  const [first, ...rest] = tabIds;
  const win = await ops.createWindow({ tabId: first });
  if (win && Number.isInteger(win.id) && rest.length > 0) {
    await ops.move(rest, { windowId: win.id, index: -1 });
  }
  ops.resync();
}

/**
 * @param {string} url
 */
async function copyUrl(url) {
  const ok = await ops.copyText(url);
  toast(ok ? t('copied') : t('copyFailed'));
}

/**
 * Bulk close with the confirm bar above the configured threshold
 * (spec.md §9.3, §9.8).
 * @param {number[]} tabIds
 */
export async function closeTabs(tabIds) {
  const ids = tabIds.filter(isId);
  if (ids.length === 0) return;
  const settings = ops.getSettings();
  const threshold = Number(settings.confirmCloseThreshold) || 5;
  if (ids.length >= threshold) {
    const ok = await confirmBar({
      message: t('confirmCloseMany', [String(ids.length)]),
      confirmLabel: t('confirmClose'),
      danger: true,
    });
    if (!ok) return;
  }
  await ops.remove(ids);
}

/**
 * @param {number} groupId
 */
async function newTabInGroup(groupId) {
  const groupTabs = ops.tabsInOrder().filter((tab) => tab.groupId === groupId);
  const lastIndex = groupTabs.length > 0 ? groupTabs[groupTabs.length - 1].index ?? 0 : undefined;
  const created = await ops.create({
    windowId: ops.windowId(),
    index: lastIndex == null ? undefined : lastIndex + 1,
    active: true,
  });
  if (created && Number.isInteger(created.id)) {
    await ops.group({ tabIds: [created.id], groupId });
  }
}

/** `sessions.restore()` with no argument reopens the most recent entry. */
export async function reopenLastClosed() {
  try {
    await chrome.sessions.restore();
  } catch (e) {
    log.warn('sessions.restore', e);
    toast(t('restoreFailed'));
  }
}

/* ── menu rendering ───────────────────────────────────────────────────────── */

/**
 * @param {MenuItem[]} items
 * @param {number} x
 * @param {number} y
 */
export function openMenu(items, x, y) {
  if (!menuEl) menuEl = document.getElementById('context-menu');
  if (!menuEl) return;
  closeSubmenu();
  lastFocused = document.activeElement instanceof Element ? document.activeElement : null;

  menuEl.textContent = '';
  menuEl.appendChild(buildList(items, false));
  menuEl.hidden = false;
  open = true;

  positionAt(menuEl, x, y);

  const first = firstEnabled(menuEl);
  if (first) {
    try {
      first.focus();
    } catch (e) {
      log.warn('menu focus', e);
    }
  }
}

/**
 * @param {MenuItem[]} items
 * @param {boolean} isSubmenu
 * @returns {DocumentFragment}
 */
function buildList(items, isSubmenu) {
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    if (!item) continue;
    if (item.separator) {
      const hr = document.createElement('div');
      hr.className = 'menu__separator';
      hr.setAttribute('role', 'separator');
      fragment.appendChild(hr);
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu__item';
    button.setAttribute('role', 'menuitem');
    button.tabIndex = -1;
    if (item.id) {
      button.dataset.id = item.id;
      button.dataset.testid = `menu-item-${item.id}`;
    }
    if (item.disabled) {
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
    }
    if (item.swatch) {
      const dot = document.createElement('span');
      dot.className = 'menu__swatch';
      dot.style.background = groupColorVar(item.swatch);
      button.appendChild(dot);
    }
    const label = document.createElement('span');
    label.className = 'menu__label';
    label.textContent = item.label || '';
    button.appendChild(label);

    if (item.submenu && item.submenu.length > 0) {
      button.classList.add('menu__item--parent');
      button.setAttribute('aria-haspopup', 'menu');
      button.setAttribute('aria-expanded', 'false');
      const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      chevron.setAttribute('class', 'menu__chevron');
      chevron.setAttribute('aria-hidden', 'true');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#i-chevron');
      chevron.appendChild(use);
      button.appendChild(chevron);
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleSubmenu(button, item.submenu || []);
      });
      button.addEventListener('mouseenter', () => toggleSubmenu(button, item.submenu || [], true));
    } else {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (button.disabled) return;
        close();
        try {
          const result = item.run ? item.run() : undefined;
          if (result && typeof (/** @type {any} */ (result).catch) === 'function') {
            /** @type {any} */ (result).catch((e) => log.warn('menu action', item.id, e));
          }
        } catch (e) {
          log.warn('menu action', item.id, e);
        }
      });
      if (!isSubmenu) button.addEventListener('mouseenter', () => closeSubmenu());
    }
    button.addEventListener('keydown', onMenuKeyDown);
    fragment.appendChild(button);
  }
  return fragment;
}

/**
 * @param {HTMLElement} parentItem
 * @param {MenuItem[]} items
 * @param {boolean} [onlyOpen]
 */
function toggleSubmenu(parentItem, items, onlyOpen = false) {
  if (submenuEl && submenuEl.dataset.owner === parentItem.dataset.id) {
    if (onlyOpen) return;
    closeSubmenu();
    return;
  }
  closeSubmenu();
  if (!menuEl) return;
  const el = document.createElement('div');
  el.className = 'menu menu__submenu';
  el.setAttribute('role', 'menu');
  el.dataset.owner = parentItem.dataset.id || '';
  el.dataset.testid = 'context-submenu';
  el.appendChild(buildList(items, true));
  menuEl.appendChild(el);
  submenuEl = el;
  parentItem.setAttribute('aria-expanded', 'true');

  const rect = parentItem.getBoundingClientRect();
  el.style.position = 'fixed';
  el.style.visibility = 'hidden';
  el.hidden = false;
  const width = el.offsetWidth || 180;
  const height = el.offsetHeight || 120;
  let left = rect.right - 2;
  if (left + width > window.innerWidth - 4) left = Math.max(4, rect.left - width + 2);
  let top = rect.top;
  if (top + height > window.innerHeight - 4) top = Math.max(4, window.innerHeight - height - 4);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.style.visibility = '';
}

function closeSubmenu() {
  if (!submenuEl) return;
  const owner = submenuEl.dataset.owner;
  submenuEl.remove();
  submenuEl = null;
  if (menuEl && owner) {
    const parent = menuEl.querySelector(`.menu__item--parent[data-id="${owner}"]`);
    if (parent) parent.setAttribute('aria-expanded', 'false');
  }
}

/**
 * Position a fixed-position menu at the pointer, clamped to the viewport.
 * @param {HTMLElement} el
 * @param {number} x
 * @param {number} y
 */
function positionAt(el, x, y) {
  el.style.position = 'fixed';
  el.style.left = '0px';
  el.style.top = '0px';
  el.style.visibility = 'hidden';
  const width = el.offsetWidth || 200;
  const height = el.offsetHeight || 200;
  const left = Math.max(4, Math.min(x, window.innerWidth - width - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - height - 4));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.style.visibility = '';
}

/** Close the menu and restore focus (spec-addendum A15.5). */
export function close() {
  if (!open) return;
  open = false;
  closeSubmenu();
  if (menuEl) {
    menuEl.hidden = true;
    menuEl.textContent = '';
  }
  const target = lastFocused && lastFocused.isConnected ? lastFocused : document.getElementById('tablist');
  lastFocused = null;
  try {
    if (target && typeof (/** @type {any} */ (target).focus) === 'function') {
      /** @type {any} */ (target).focus({ preventScroll: true });
    }
  } catch (e) {
    log.warn('menu restore focus', e);
  }
}

/**
 * @param {PointerEvent} event
 */
function onDocumentPointerDown(event) {
  if (!open || !menuEl) return;
  const target = event.target instanceof Node ? event.target : null;
  if (target && menuEl.contains(target)) return;
  close();
}

/**
 * Arrow keys navigate, Enter/Space activate, Right/Left open and close
 * submenus, Escape closes (spec.md §9.3).
 * @param {KeyboardEvent} event
 */
function onMenuKeyDown(event) {
  const current = event.currentTarget;
  if (!(current instanceof HTMLElement)) return;
  const list = current.parentElement;
  if (!list) return;
  const inSubmenu = list.classList.contains('menu__submenu');
  const enabled = enabledItems(list);
  const index = enabled.indexOf(current);

  switch (event.key) {
    case 'ArrowDown': {
      event.preventDefault();
      const next = enabled[(index + 1 + enabled.length) % enabled.length];
      if (next) next.focus();
      break;
    }
    case 'ArrowUp': {
      event.preventDefault();
      const prev = enabled[(index - 1 + enabled.length) % enabled.length];
      if (prev) prev.focus();
      break;
    }
    case 'Home': {
      event.preventDefault();
      if (enabled[0]) enabled[0].focus();
      break;
    }
    case 'End': {
      event.preventDefault();
      const last = enabled[enabled.length - 1];
      if (last) last.focus();
      break;
    }
    case 'ArrowRight': {
      if (current.classList.contains('menu__item--parent')) {
        event.preventDefault();
        current.click();
        if (submenuEl) {
          const first = firstEnabled(submenuEl);
          if (first) first.focus();
        }
      }
      break;
    }
    case 'ArrowLeft': {
      if (inSubmenu) {
        event.preventDefault();
        const owner = submenuEl ? submenuEl.dataset.owner : '';
        closeSubmenu();
        if (menuEl && owner) {
          const parent = menuEl.querySelector(`.menu__item--parent[data-id="${owner}"]`);
          if (parent instanceof HTMLElement) parent.focus();
        }
      }
      break;
    }
    case 'Escape': {
      event.preventDefault();
      event.stopPropagation();
      if (inSubmenu) {
        const owner = submenuEl ? submenuEl.dataset.owner : '';
        closeSubmenu();
        if (menuEl && owner) {
          const parent = menuEl.querySelector(`.menu__item--parent[data-id="${owner}"]`);
          if (parent instanceof HTMLElement) parent.focus();
        }
      } else {
        close();
      }
      break;
    }
    case 'Tab': {
      event.preventDefault();
      break;
    }
    case ' ':
    case 'Enter': {
      event.preventDefault();
      current.click();
      break;
    }
    default:
      break;
  }
}

/**
 * @param {Element} root
 * @returns {HTMLElement[]}
 */
function enabledItems(root) {
  return /** @type {HTMLElement[]} */ ([
    ...root.querySelectorAll(':scope > .menu__item:not([disabled])'),
  ]);
}

/**
 * @param {Element} root
 * @returns {HTMLElement|null}
 */
function firstEnabled(root) {
  const items = enabledItems(root);
  return items.length > 0 ? items[0] : null;
}
