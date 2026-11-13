/**
 * The menu of a row in the bookmark column, and the keys that do what it does (PR2, unit U6): a new
 * folder beside or inside the row, a rename, "Move up", "Move down" and "Move to…". It opens on a right
 * click, on the ContextMenu key and on Shift+F10. Alt+ArrowUp and Alt+ArrowDown move the focused row one
 * place without opening it. The menu is `context-menu.js`'s: the panel has one, `#context-menu`, and this
 * file only fills it.
 *
 * There is no `chrome.bookmarks` and no `bm()` in here, as in `bookmark-dnd.js`. The tree is reached by
 * `moveRelative` and `moveToPosition` of `bookmark-write.js`, each through its `queue`, and by the two
 * calls `bookmarks.js` offers for the name field (`host.beginCreate`, `host.beginRename`).
 * `tests/specs/41-bookmark-menu-keys.spec.js` reads this file's source to keep it so.
 *
 * ── What the menu offers, from the model and nothing else ──────────────────────────────────────────
 * What is disabled is decided from `host.rows()` when the menu opens, with no read and no await: the
 * first row has no "Move up", the last no "Move down". A permanent folder (depth 0) is offered only the
 * new folder, inside it; it can be neither renamed nor moved (Probe 13 P5). A node Chrome marks
 * `unmodifiable` is offered nothing it could do: every write is disabled and there is no rename, the
 * same fail-closed rule `resolveBookmarkDrop` follows. The model is what the last paint read, so it can be
 * out of date by the time an item is chosen; every action therefore looks the row up again by id, and the
 * write module reads the tree again when it runs.
 *
 * "Move to…" lists the folders of the model, collapsed ones included, the row itself and everything under
 * it left out. Choosing one appends the row to that folder with one `move` and no `index`
 * (Probe 13 P2: appending cannot go stale). A folder that has left the model between the opening of the menu
 * and the choice is not written to: the reader is told so (`bookmarksStale`).
 *
 * ── Focus ──────────────────────────────────────────────────────────────────────────────────────────
 * `openMenu` remembers what has focus and `close()` gives it back, but only if that node is still in the
 * document, and a repaint under an open menu replaces every row (the column's own repaint after a write is
 * enough, and so is one that a change made elsewhere arms 400 ms ahead). So the row is focused before the
 * menu opens (without scrolling: a scroll event right after it would close it), and by id, not by node:
 *   - after a move, once the repaint is done;
 *   - before a new folder is begun, which remembers where focus was to give it back on Escape;
 *   - when the menu is dismissed without a choice (Escape, a click elsewhere, a scroll), if focus did not
 *     go back to a row by itself.
 *
 * ── Why a key hook and not its own listener ───────────────────────────────────────────────────────
 * `bookmarks.js` calls `onKey` at the top of its list's `keydown` handler. Alt+ArrowDown has to be
 * answered before the plain arrows are, which would read it as "focus the next row".
 */

import * as i18n from '../common/i18n.js';
import { descendantIds } from './bookmark-math.js';
import { moveRelative, moveToPosition, queue } from './bookmark-write.js';
import { close, isOpen, openMenu } from './context-menu.js';

/** "Move to…" indents a folder by this much per level of depth, down to the column's own limit. */
const INDENT = '\u00a0\u00a0';
const MAX_INDENT_LEVELS = 5;

/** The ids of this file's menu items all start with this, which is how its menu is told from the tab list's. */
const ITEM_PREFIX = 'bm-';

/** A folder has no `url` key at all (measured, as in `bookmarks.js` `isFolder`). */
const isFolder = (node) => !('url' in node);

/**
 * @param {object} args
 * @param {any} args.host the object `bookmarks.js` hands to modules that edit the tree
 * @param {HTMLElement} args.rail the scrolling column
 * @param {HTMLElement} args.list the list of rows, inside it
 * @returns {{ detach: () => void, onKey: (event: KeyboardEvent, row: HTMLElement) => boolean }}
 */
export function attach({ host, rail, list }) {
  let alive = true;
  /**
   * The menu this file has open: the id of the row it belongs to, whether one of its items was chosen, and
   * the observer that notices it closing. Null when none is.
   * @type {{ id: string, chosen: boolean, observer: MutationObserver }|null}
   */
  let opened = null;

  list.addEventListener('contextmenu', onContextMenu);
  rail.addEventListener('scroll', onScroll, { passive: true });

  /* ── The model ─────────────────────────────────────────────────────────── */

  /**
   * The model's entry for node `id`, as the last paint left it. Not the "Empty" line and not the name
   * field's place: those have no node of their own.
   * @param {string} id
   */
  function entryOf(id) {
    return host.rows().find((e) => e.node && !e.empty && !e.pending && String(e.node.id) === id) || null;
  }

  /** A permanent folder cannot be moved (Probe 13 P5) and a node that is not marked as writable is not written to. */
  const movable = (entry) => entry.depth > 0 && entry.modifiable === true;

  /** Is `entry` the first / last of its folder, as far as the model knows? */
  function atEnd(entry, direction) {
    if (!Number.isInteger(entry.index) || !Number.isInteger(entry.siblings)) return false;
    return direction === 'up' ? entry.index <= 0 : entry.index >= entry.siblings - 1;
  }

  /* ── Opening ───────────────────────────────────────────────────────────── */

  /** @param {MouseEvent} event */
  function onContextMenu(event) {
    if (!alive) return;
    const row = event.target instanceof Element ? event.target.closest('[data-bookmark-id]') : null;
    const entry = row instanceof HTMLElement ? entryOf(row.dataset.bookmarkId || '') : null;
    // Anything else in the list (the name field, the "Empty" line) keeps the browser's own menu.
    if (!(row instanceof HTMLElement) || !entry) return;
    // Not `stopImmediatePropagation`: `bookmark-preview.js` hides its card from a `contextmenu` listener
    // on this same element. A bare synthetic event (spec 39 sends one) has no coordinates; the menu then
    // opens at the corner, which `openMenu` keeps inside the panel.
    event.preventDefault();
    openFor(row, entry, event.clientX, event.clientY);
  }

  /**
   * @param {HTMLElement} row
   * @param {any} entry the model's entry for it
   * @param {number} x
   * @param {number} y
   */
  function openFor(row, entry, x, y) {
    unwatch();
    // If a menu is already up (the key and a `contextmenu` event can both arrive), focus is on one of its
    // items, and `openMenu` would remember THAT as the place to go back to.
    row.focus({ preventScroll: true });
    openMenu(itemsFor(entry), x, y);
    watch(String(entry.node.id));
  }

  /**
   * Notice the menu closing. If nothing was chosen and focus is not on a row of the list, give it to the
   * row the menu was opened on: `close()` could only give it back to a node that is still in the document.
   * Whatever closes the menu hides its element, and the observer is told in the microtask after that, so
   * the choice (which runs in the same task, after `close()`) has already marked itself by then.
   * @param {string} id
   */
  function watch(id) {
    const menu = document.getElementById('context-menu');
    if (!menu) return;
    const mine = { id, chosen: false, observer: new MutationObserver(() => {
      if (!menu.hidden) return;
      mine.observer.disconnect();
      if (opened === mine) opened = null;
      const active = document.activeElement;
      if (alive && !mine.chosen && !(active instanceof HTMLElement && list.contains(active))) focusQuietly(id);
    }) };
    mine.observer.observe(menu, { attributes: true, attributeFilter: ['hidden'] });
    opened = mine;
  }

  /**
   * Focus the row of node `id` where it stands, if the list has it. Without scrolling to it: the menu may
   * have been dismissed by the reader scrolling the column away from the row, and that is not undone.
   * @param {string} id
   */
  function focusQuietly(id) {
    for (const row of list.querySelectorAll('[data-bookmark-id]')) {
      if (row instanceof HTMLElement && row.dataset.bookmarkId === id) {
        row.focus({ preventScroll: true });
        return;
      }
    }
  }

  /** Stop watching a menu that is being replaced, or that the list is being taken from. */
  function unwatch() {
    if (!opened) return;
    opened.observer.disconnect();
    opened = null;
  }

  /**
   * An item's action, marked as a choice: from here on the action looks after focus, not the dismissal.
   * @param {() => unknown} action
   */
  function choose(action) {
    return () => {
      if (opened) opened.chosen = true;
      return action();
    };
  }

  /**
   * @param {any} entry the model's entry for the row
   * @returns {Array<object>} items for `openMenu`
   */
  function itemsFor(entry) {
    const id = String(entry.node.id);
    const folder = isFolder(entry.node);
    const writable = entry.modifiable === true;

    const items = [{
      id: `${ITEM_PREFIX}new-folder`,
      label: folder ? i18n.t('bookmarksNewFolderIn', [entry.node.title || '']) : i18n.t('bookmarksNewFolder'),
      disabled: !writable,
      // Inside a folder at its end, or right after a bookmark. The row is focused first, by id: the field
      // remembers where focus was to give it back on Escape, and `close()` may have had no row to give it to.
      run: choose(() => {
        host.focusRowById(id);
        return folder ? host.beginCreate(id, null) : host.beginCreate(String(entry.parentId), id);
      }),
    }];
    if (entry.depth === 0) return items;

    if (writable) {
      items.push({ id: `${ITEM_PREFIX}rename`, label: i18n.t('bookmarksRename'), run: choose(() => host.beginRename(id)) });
    }
    const targets = writable ? destinationsFor(entry) : [];
    items.push(
      {
        id: `${ITEM_PREFIX}up`,
        label: i18n.t('bookmarksMoveUp'),
        disabled: !writable || atEnd(entry, 'up'),
        run: choose(() => moveRow(id, 'up')),
      },
      {
        id: `${ITEM_PREFIX}down`,
        label: i18n.t('bookmarksMoveDown'),
        disabled: !writable || atEnd(entry, 'down'),
        run: choose(() => moveRow(id, 'down')),
      },
      {
        id: `${ITEM_PREFIX}move-to`,
        label: i18n.t('bookmarksMoveTo'),
        disabled: targets.length === 0,
        submenu: targets,
      },
    );
    return items;
  }

  /**
   * The folders the row can be moved into: every folder of the model that is not the row itself or under
   * it, and that is writable (a permanent folder is: Probe 17 PB). The row's own folder is among them; moving
   * a row to the end of the folder it is in is a move like any other.
   * @param {any} entry
   */
  function destinationsFor(entry) {
    const rows = host.rows();
    const id = String(entry.node.id);
    const below = descendantIds(rows, rows.indexOf(entry));
    const out = [];
    for (const e of rows) {
      if (!e.node || e.empty || e.pending || !isFolder(e.node) || e.modifiable !== true) continue;
      const folderId = String(e.node.id);
      if (folderId === id || below.has(folderId)) continue;
      out.push({
        id: `${ITEM_PREFIX}moveto-${folderId}`,
        label: INDENT.repeat(Math.min(e.depth, MAX_INDENT_LEVELS)) + (e.node.title || ''),
        run: choose(() => moveInto(id, folderId)),
      });
    }
    return out;
  }

  /* ── The keys ──────────────────────────────────────────────────────────── */

  /**
   * Called by `bookmarks.js` for a key pressed on a row, before the plain arrows are looked at.
   * @param {KeyboardEvent} event
   * @param {HTMLElement} row
   * @returns {boolean} the key is this file's: the caller does nothing more with it
   */
  function onKey(event, row) {
    if (!alive) return false;
    const id = row.dataset.bookmarkId || '';
    const key = event.key;

    if (key === 'ArrowUp' || key === 'ArrowDown') {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
      // Alt+Arrow is "move this row", so it is never "focus another row", even where the row cannot move.
      const entry = entryOf(id);
      if (entry && movable(entry)) {
        event.preventDefault();
        void moveRow(id, key === 'ArrowUp' ? 'up' : 'down');
      }
      return true;
    }

    if ((key === 'ContextMenu' && !event.ctrlKey && !event.altKey && !event.metaKey)
      || (key === 'F10' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey)) {
      const entry = entryOf(id);
      if (!entry) return false;
      // `preventDefault` and then open it ourselves, as `keyboard.js` does for a tab card.
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      openFor(row, entry, rect.left + 8, rect.bottom);
      return true;
    }
    return false;
  }

  /* ── The moves ─────────────────────────────────────────────────────────── */

  /**
   * One place up or down inside the row's folder. At either end there is nothing to do and nothing is
   * called, not even a read; the write module would find that out as well, but only after reading.
   * @param {string} id
   * @param {'up'|'down'} direction
   */
  async function moveRow(id, direction) {
    const before = entryOf(id);
    if (before && !movable(before)) return;
    if (before && atEnd(before, direction)) {
      host.log(`move ${direction} of ${id} ignored: it is already the ${direction === 'up' ? 'first' : 'last'} of its ${before.siblings}`);
      return;
    }
    let result;
    try {
      result = await queue(() => moveRelative(host, { id, direction }));
    } catch (e) {
      host.log(`move ${direction} of ${id} threw: ${e && e.message ? e.message : e}`);
      result = { ok: false, landed: null, reason: 'failed' };
    }
    await conclude(result, id, before, null);
  }

  /**
   * To the end of the folder `folderId`: one `move`, no index.
   * @param {string} id
   * @param {string} folderId
   */
  async function moveInto(id, folderId) {
    const before = entryOf(id);
    if (before && !movable(before)) return;
    const folder = entryOf(folderId);
    if (!folder || !isFolder(folder.node) || folder.modifiable !== true) {
      host.log(`move of ${id} into ${folderId} refused: that folder is no longer in the list`);
      host.toast(i18n.t('bookmarksStale'));
      host.focusRowById(id);
      return;
    }
    let result;
    try {
      result = await queue(() => moveToPosition(host, { id, place: 'end', anchorId: null, parentId: folderId }));
    } catch (e) {
      host.log(`move of ${id} into ${folderId} threw: ${e && e.message ? e.message : e}`);
      result = { ok: false, landed: null, reason: 'failed' };
    }
    await conclude(result, id, before, folderId);
  }

  /**
   * What happens after the write module answered: the toast for a refusal, the repaint, the focus, and for
   * a move that landed, where it landed.
   * @param {{ ok: boolean, landed: any, reason: string|null }} result
   * @param {string} id the node that was to move
   * @param {any} before its entry when the action began, if it had one
   * @param {string|null} intoId the folder it was moved into, to be shown open
   */
  async function conclude(result, id, before, intoId) {
    // Nothing was written and nothing changed: not even a repaint (the write module's rule).
    if (!alive || result.reason === 'noop') return;
    if (result.reason === 'stale') host.toast(i18n.t('bookmarksStale'));
    else if (result.reason === 'failed') host.toast(i18n.t('operationFailed'));
    // The reader has to see where it went. This opens the folder in the model only: the bookmark button's
    // target is a choice, and stays where it was.
    if (result.ok && intoId) host.expand(intoId);
    const painted = await host.paintNow();
    if (!alive) return;
    const landed = result.ok ? result.landed : null;
    // Explicitly, and by id: the row that had focus may have been replaced under an open menu, and
    // `close()` then had nowhere to give focus back to.
    host.focusRowById(landed ? landed.id : id);
    if (!landed) return;
    const place = placeOf(landed, before, painted);
    if (place) host.toast(i18n.t('bookmarksMovedTo', [String(place.pos), String(place.total)]));
  }

  /**
   * "Position P of N" for a node that has just landed. From the model the repaint left, which is the tree
   * as Chrome has it now; if that repaint did not happen (a drag or an edit began, or a newer paint took
   * over), a move inside the row's own folder still knows: the place Chrome answered with, in the folder
   * as large as it was.
   * @param {{ id: string, parentId?: string, index?: number }} landed
   * @param {any} before
   * @param {boolean} painted
   * @returns {{ pos: number, total: number }|null}
   */
  function placeOf(landed, before, painted) {
    if (painted) {
      const now = entryOf(String(landed.id));
      if (now && now.parentId === landed.parentId && Number.isInteger(now.index) && Number.isInteger(now.siblings)) {
        return { pos: now.index + 1, total: now.siblings };
      }
    }
    if (before && before.parentId === landed.parentId && Number.isInteger(landed.index) && Number.isInteger(before.siblings)) {
      return { pos: landed.index + 1, total: before.siblings };
    }
    return null;
  }

  /* ── Scrolling ─────────────────────────────────────────────────────────── */

  /**
   * The rail scrolled: the rows under an open menu are not where it was opened. `context-menu.js` closes
   * on a scroll of the tab list only, so the rail's is closed here, and only if the open menu is this
   * file's.
   */
  function onScroll() {
    if (alive && ours()) close();
  }

  /** Is the menu that is open this file's? */
  function ours() {
    if (!isOpen()) return false;
    const menu = document.getElementById('context-menu');
    return Boolean(menu && menu.querySelector(`[data-id^="${ITEM_PREFIX}"]`));
  }

  /* ── Leaving ───────────────────────────────────────────────────────────── */

  function detach() {
    if (!alive) return;
    unwatch();
    if (ours()) close();
    alive = false;
    list.removeEventListener('contextmenu', onContextMenu);
    rail.removeEventListener('scroll', onScroll);
  }

  return { detach, onKey };
}
