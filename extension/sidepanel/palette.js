/**
 * The command palette — everything the panel can do, by name.
 *
 * The panel had grown a right-click menu, a settings drawer, a trash popover, a tools
 * column and a dozen keyboard shortcuts, which between them is more than anyone keeps
 * in their head. A palette is the usual answer: one key, type a few letters of what you
 * want, press Enter. Nothing here is new capability — every entry runs a path that
 * already existed, which is also why the list is honest about what the panel can do.
 *
 * `Ctrl/Cmd+Shift+P`, because `Ctrl+K` already focuses the search box (spec.md §9.6)
 * and taking a documented shortcut away to give it to a newer feature is a bad trade.
 *
 * Commands are matched on their label with the same NFKC + lower-case normalisation the
 * search box uses, so the Japanese UI is searchable by typing full-width or half-width.
 */

import * as log from '../common/log.js';
import * as ops from './tab-ops.js';
import * as locks from './locks.js';
import { t, toast } from './toast.js';
import { normalize } from './search.js';

/** @type {any} */
let ctx = null;
/** @type {HTMLElement|null} */
let root = null;
/** @type {HTMLInputElement|null} */
let input = null;
/** @type {HTMLElement|null} */
let listEl = null;
let open = false;
let bound = false;
/** @type {any[]} the commands currently shown, in display order */
let shown = [];
let cursor = 0;
/** Where focus was before the palette took it. */
let returnTo = null;

/* ── the commands ─────────────────────────────────────────────────────────── */

/**
 * Every command, in the order the palette lists them when nothing is typed.
 *
 * `when` decides whether a command is offered at all: a command that cannot work right
 * now is left out rather than shown greyed, because a palette is a list of things you
 * can do. `label` is resolved at build time so it follows the UI language.
 *
 * @returns {Array<{id: string, label: string, run: Function}>}
 */
function build() {
  const active = activeTab();
  const id = active ? active.id : null;
  const has = Boolean(active);
  const defs = [
    { id: 'new-tab', label: t('cmdNewTab'), run: () => call(ctx && ctx.newTab) },
    { id: 'search', label: t('cmdSearch'), run: () => call(ctx && ctx.focusSearch) },
    {
      id: 'reload',
      label: t('cmdReload'),
      when: has,
      run: () => ops.reload(id),
    },
    {
      id: 'duplicate',
      label: t('cmdDuplicate'),
      when: has,
      run: () => ops.duplicate(id),
    },
    {
      id: 'pin',
      label: active && active.pinned ? t('cmdUnpin') : t('cmdPin'),
      when: has,
      run: () => ops.update(id, { pinned: !(active && active.pinned) }),
    },
    {
      id: 'mute',
      label: muted(active) ? t('cmdUnmute') : t('cmdMute'),
      when: has,
      run: () => ops.update(id, { muted: !muted(active) }),
    },
    {
      id: 'lock',
      label: id !== null && locks.isLocked(id) ? t('cmdUnlock') : t('cmdLock'),
      when: has,
      run: () => {
        locks.set(id);
        ops.rerender();
      },
    },
    {
      id: 'copy-url',
      label: t('cmdCopyUrl'),
      when: has && Boolean(active.url || active.pendingUrl),
      run: async () => {
        const ok = await ops.copyText(active.url || active.pendingUrl || '');
        toast(ok ? t('copied') : t('copyFailed'));
      },
    },
    {
      id: 'move-new-window',
      label: t('cmdMoveToNewWindow'),
      when: has,
      run: () => chrome.windows.create({ tabId: id }),
    },
    {
      id: 'close',
      label: t('cmdCloseTab'),
      when: has,
      run: () => ops.remove(id),
    },
    { id: 'reopen', label: t('cmdReopenClosed'), run: () => reopenClosed() },
    { id: 'pop-out', label: t('cmdPopOut'), run: () => call(ctx && ctx.popOut) },
    // The drawer is an optional module like this one; reach it the way the panel does.
    { id: 'settings', label: t('cmdSettings'), run: () => openSettings() },
  ];
  return defs.filter((d) => d.when === undefined || d.when === true);
}

function activeTab() {
  const model = ops.model();
  if (!model || !model.tabs) return null;
  return model.tabs.get(model.activeTabId) || null;
}

function muted(tab) {
  return Boolean(tab && tab.mutedInfo && tab.mutedInfo.muted);
}

function openSettings() {
  const drawer = ctx && ctx.modules && ctx.modules.settingsView;
  if (drawer && typeof drawer.openDrawer === 'function') drawer.openDrawer();
}

/** @param {Function|undefined} fn */
function call(fn) {
  if (typeof fn === 'function') return fn();
  return undefined;
}

/** The most recently closed tab, which is what "reopen" means everywhere else. */
async function reopenClosed() {
  try {
    const sessions = await chrome.sessions.getRecentlyClosed({ maxResults: 1 });
    const entry = sessions && sessions[0];
    if (!entry) {
      toast(t('closedTabsEmpty'));
      return;
    }
    const sessionId = entry.tab ? entry.tab.sessionId : entry.window && entry.window.sessionId;
    if (sessionId) await chrome.sessions.restore(sessionId);
  } catch (e) {
    log.warn('palette reopen', e);
    toast(t('operationFailed'));
  }
}

/* ── wiring ───────────────────────────────────────────────────────────────── */

/** @param {any} context */
export function init(context) {
  ctx = ops.init(context) || context || null;
  root = document.getElementById('palette');
  input = /** @type {HTMLInputElement|null} */ (document.getElementById('palette-input'));
  listEl = root ? root.querySelector('.palette__list') : null;
  if (bound || !root || !input || !listEl) return;
  bound = true;

  input.addEventListener('input', () => paint());
  input.addEventListener('keydown', onKey);
  // A click outside is a dismissal, like every other overlay in the panel.
  root.addEventListener('pointerdown', (event) => {
    if (event.target === root) close();
  });
}

export function isOpen() {
  return open;
}

export function toggle() {
  if (open) close();
  else show();
}

export function show() {
  if (!root || !input) return;
  returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  open = true;
  root.hidden = false;
  input.value = '';
  cursor = 0;
  paint();
  input.focus();
}

export function close() {
  if (!root || !open) return;
  open = false;
  root.hidden = true;
  shown = [];
  if (listEl) listEl.textContent = '';
  // Give focus back where it was; a palette that swallows focus leaves the list dead.
  if (returnTo && document.contains(returnTo)) {
    try {
      returnTo.focus();
    } catch {
      /* the element may have been re-rendered away */
    }
  }
  returnTo = null;
}

function paint() {
  if (!listEl || !input) return;
  const query = normalize(input.value);
  shown = build().filter((cmd) => query === '' || normalize(cmd.label).includes(query));
  if (cursor >= shown.length) cursor = Math.max(0, shown.length - 1);

  listEl.textContent = '';
  shown.forEach((cmd, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'palette__row';
    row.dataset.testid = 'palette-row';
    row.dataset.cmd = cmd.id;
    row.textContent = cmd.label;
    row.setAttribute('aria-selected', i === cursor ? 'true' : 'false');
    row.addEventListener('click', () => run(i));
    listEl.append(row);
  });

  const empty = shown.length === 0;
  const emptyEl = root ? root.querySelector('.palette__empty') : null;
  if (emptyEl) emptyEl.hidden = !empty;
}

/** @param {KeyboardEvent} event */
function onKey(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!shown.length) return;
    const step = event.key === 'ArrowDown' ? 1 : -1;
    cursor = (cursor + step + shown.length) % shown.length;
    highlight();
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    run(cursor);
  }
}

function highlight() {
  if (!listEl) return;
  [...listEl.children].forEach((row, i) => {
    row.setAttribute('aria-selected', i === cursor ? 'true' : 'false');
    if (i === cursor) row.scrollIntoView({ block: 'nearest' });
  });
}

/** @param {number} index */
function run(index) {
  const cmd = shown[index];
  if (!cmd) return;
  // Closed first: a command that opens the drawer or the search box must not be fighting
  // the palette for focus, and every command is meant to be a one-shot.
  close();
  try {
    const result = cmd.run();
    if (result && typeof result.catch === 'function') {
      result.catch((e) => log.warn('palette command', cmd.id, e));
    }
  } catch (e) {
    log.warn('palette command', cmd.id, e);
  }
}
