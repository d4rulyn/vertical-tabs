/**
 * Dragging the rows of the bookmark column (PR2, unit U5): put a bookmark or a folder somewhere else
 * in its folder, or inside another folder. The write is `bookmark-write.js`'s `moveToPosition`; this
 * file is the pointer half: which row the pointer is on, where a drop there would land, the line or
 * the outline that says so, and the cleanup when the drag ends, whichever way it ends.
 *
 * There is no `chrome.bookmarks` and no `bm()` in here. The only way to the tree is
 * `moveToPosition(host, ...)` through the write queue, and `tests/specs/38-bookmark-reorder-move.spec.js`
 * reads this file's source to keep it so. `bookmarks.js` calls `attach()` for every list it builds and
 * `detach()` before it throws that list away; `host` is the object it hands to every module that edits.
 *
 * ── What the browser does, measured (Probe 13 P8, Probe 17 PC; panel as a tab, injected drag) ──────
 *  - `getData` answers "" during `dragover`, so the dragged id, its parent, its index and the ids under
 *    it are read ONCE, at `dragstart`, and kept in `drag`. `dragover` then costs one `closest()`, one
 *    map lookup and one `getBoundingClientRect()` however many rows there are.
 *  - A press on the favicon `<img>` starts a NATIVE image drag unless the image has `draggable="false"`
 *    (set in `bookmarks.js`). The payload is the private type below and nothing else: with a
 *    `text/uri-list` the tab list's `acceptable()` would take the drop and open a tab.
 *  - If the dragged node leaves the DOM, `dragend` never reaches `document`, and the drop lands on
 *    whatever is under the pointer. So the repaint is held for the whole drag (`host.hold`), `drop`
 *    ends the drag as well as `dragend`, and a watchdog ends one whose end never came.
 *  - Blink fires `dragover` only for an update that leaves the element under the pointer the same;
 *    moving onto another element is `dragenter` + `dragleave`. A drop is accepted only if the LAST
 *    `dragenter` or `dragover` was cancelled, so both of them are.
 *  - On the 1 px between two rows `event.target` is the list itself. There the target of the last
 *    event stays, and is still accepted.
 *  - Blink scrolls the rail by itself when the pointer rests near its edge, and sends no drag event
 *    while it does. So there is no scrolling of our own (it would add to Blink's), the rail's `scroll`
 *    re-resolves the target at the last pointer position once per frame, and a drop is worked out from
 *    the drop event itself and never from what the last `dragover` said.
 *
 * ── The target ────────────────────────────────────────────────────────────────────────────────────
 * `resolveBookmarkDrop` (bookmark-math.js) is the rule; this file feeds it ONE hovered row. The model
 * behind a row (parent, index, depth, whether it may be written to) is `host.rows()`, indexed by id
 * once at `dragstart`; it cannot change during the drag because the repaint is held. Whatever the
 * model says about the tree is only what decides the picture: the write reads the tree again.
 */

import * as i18n from '../common/i18n.js';
import { descendantIds, resolveBookmarkDrop } from './bookmark-math.js';
import { moveToPosition, queue } from './bookmark-write.js';

/** The one type a drag from this column carries. */
const DRAG_TYPE = 'application/x-vt-bookmark';

/** No drag event for this long and the drag is treated as dead (its `dragend` was lost). */
const WATCHDOG_MS = 10_000;

/** A row, and the "Empty" line of an open empty folder (which means "inside that folder"). */
const ROW = '[data-bookmark-id]';
const MARKER = '[data-empty-of]';
const TARGETS = `${ROW}, ${MARKER}`;

/** The pointer is over the list but on no row, or over nothing that can take a drop. */
const GAP = Object.freeze({ kind: 'gap' });
const NONE = Object.freeze({ kind: 'none' });

/**
 * @typedef {object} Drag the drag in progress
 * @property {string} id the node being dragged
 * @property {HTMLElement} el its row
 * @property {object} dragged what `resolveBookmarkDrop` needs to know about it
 * @property {Map<string, any>} entries every node entry of the model by id
 * @property {{left: number, top: number, right: number, bottom: number}} railBox the rail, read once
 * @property {any} target the last answer that was valid and accepted: `{ kind: 'target', t, el, rect }`
 * @property {boolean} accepting the last `dragenter` / `dragover` we answered was cancelled, so the
 *   browser will deliver a `drop`. Only an event can change that, and only that decides whether a line
 *   may be shown after the rail has scrolled under a still pointer.
 * @property {number} x where the pointer was at the last drag event
 * @property {number} y
 * @property {number} at when (`performance.now()`) the last drag event came
 * @property {number} timer the watchdog
 * @property {number} frame the animation frame owed to a scroll, 0 when none
 */

/**
 * @param {object} args
 * @param {any} args.host the object `bookmarks.js` hands to modules that edit the tree
 * @param {HTMLElement} args.rail the scrolling column
 * @param {HTMLElement} args.list the list of rows, inside it
 * @returns {{ detach: () => void, active: () => boolean }}
 */
export function attach({ host, rail, list }) {
  /** @type {Drag|null} */
  let drag = null;
  /** @type {HTMLElement|null} */
  let line = null;
  /** @type {HTMLElement|null} */
  let outlined = null;
  let alive = true;

  rail.addEventListener('dragstart', onDragStart);
  rail.addEventListener('dragenter', onDragOver);
  rail.addEventListener('dragover', onDragOver);
  rail.addEventListener('dragleave', onDragLeave);
  rail.addEventListener('drop', onDrop);
  rail.addEventListener('dragend', onDragEnd);

  /* ── Starting ──────────────────────────────────────────────────────────── */

  /** @param {DragEvent} event */
  function onDragStart(event) {
    // A `dragstart` with no data store is not a drag the browser started (spec 39 dispatches a bare
    // one at a row): there is nothing to carry, and holding the repaint for it would never be undone.
    const dt = event.dataTransfer;
    if (!alive || !dt) return;
    const row = event.target instanceof Element ? event.target.closest(ROW) : null;
    if (!(row instanceof HTMLElement)) return;
    if (drag) end('a new drag started'); // the end of the last one never came

    const rows = host.rows();
    const wanted = row.dataset.bookmarkId || '';
    /** @type {Map<string, any>} */
    const entries = new Map();
    let at = -1;
    for (let i = 0; i < rows.length; i += 1) {
      const entry = rows[i];
      if (!entry.node || entry.empty || entry.pending) continue;
      const id = String(entry.node.id);
      entries.set(id, entry);
      if (id === wanted) at = i;
    }
    const entry = at < 0 ? null : rows[at];
    // A permanent folder cannot be moved, and a node that is not marked as writable is not moved. The
    // rows that cannot be are not `draggable`, so this is the model saying no where the markup did not:
    // the drag the browser has begun is cancelled rather than left to carry nothing.
    if (!entry || entry.editing || entry.depth === 0 || entry.modifiable !== true) {
      host.log(`dragstart refused: ${wanted} is not a row that can be moved`);
      event.preventDefault();
      return;
    }

    dt.setData(DRAG_TYPE, wanted);
    dt.effectAllowed = 'move';

    const d = {
      id: wanted,
      el: row,
      dragged: {
        id: wanted,
        parentId: entry.parentId,
        index: entry.index,
        isFolder: !('url' in entry.node),
        descendants: descendantIds(rows, at),
        siblings: entry.siblings,
      },
      entries,
      railBox: boxOf(rail),
      target: null,
      accepting: false,
      x: event.clientX,
      y: event.clientY,
      at: performance.now(),
      timer: 0,
      frame: 0,
    };
    drag = d;
    host.hold('drag');
    rail.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('blur', onBlur);
    d.timer = window.setTimeout(function watch() {
      d.timer = 0;
      if (drag !== d) return;
      const idle = performance.now() - d.at;
      if (idle >= WATCHDOG_MS) {
        end(`no drag event for ${Math.round(idle)} ms`);
        return;
      }
      d.timer = window.setTimeout(watch, WATCHDOG_MS - idle);
    }, WATCHDOG_MS);
    // After the browser has taken the picture of the row it carries, or the picture is dimmed too.
    requestAnimationFrame(() => {
      if (drag === d && d.el.isConnected) d.el.classList.add('is-bmk-dragging');
    });
  }

  /** @param {HTMLElement} el */
  function boxOf(el) {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }

  /* ── Over the column ───────────────────────────────────────────────────── */

  /**
   * `dragenter` and `dragover` alike: both have to be cancelled for a drop to be accepted, and a path
   * across rows is mostly `dragenter`. At most one `getBoundingClientRect()`, whatever the number of rows.
   * @param {DragEvent} event
   */
  function onDragOver(event) {
    const d = drag;
    if (!d) return; // not a drag of ours: a tab card, a file, a drag from another window's column
    d.at = performance.now();
    d.x = event.clientX;
    d.y = event.clientY;
    const v = resolve(d, event.target, event.clientY);
    if (v.kind === 'gap') {
      if (d.target) accept(event, d);
      return;
    }
    if (v.kind === 'target' && v.t.valid && !v.t.noop) {
      d.target = v;
      show(v);
      accept(event, d);
      return;
    }
    d.target = null;
    d.accepting = false;
    hide();
  }

  /**
   * @param {DragEvent} event
   * @param {Drag} d
   */
  function accept(event, d) {
    event.preventDefault();
    d.accepting = true;
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }

  /**
   * What is under the pointer, as far as a drop is concerned.
   * @param {Drag} d
   * @param {EventTarget|null} target
   * @param {number} pointerY
   * @returns {any} GAP, NONE, or `{ kind: 'target', t, el, rect }` with `t` from `resolveBookmarkDrop`
   */
  function resolve(d, target, pointerY) {
    if (!(target instanceof Element)) return NONE;
    const hit = target.closest(TARGETS);
    if (hit instanceof HTMLElement) {
      return judge(d, hit, hit.matches(MARKER) ? null : hit.getBoundingClientRect(), pointerY, false);
    }
    if (target === list) return GAP;
    if (target.closest('.bmk__head')) return NONE;
    // Not on a row, not on the header: the rest of the column. Under the last row it means "after it".
    const last = list.lastElementChild;
    if (!(last instanceof HTMLElement) || !last.matches(TARGETS)) return NONE;
    const rect = last.getBoundingClientRect();
    if (!(pointerY > rect.bottom)) return NONE;
    return judge(d, last, rect, pointerY, true);
  }

  /**
   * @param {Drag} d
   * @param {HTMLElement} el the row or the empty line the pointer is on
   * @param {DOMRect|null} rect its box (null for the empty line, whose zone needs no geometry)
   * @param {number} pointerY
   * @param {boolean} pastLast the pointer is below the last row of the list
   */
  function judge(d, el, rect, pointerY, pastLast) {
    /** @type {any} */
    let hovered;
    if (el.matches(MARKER)) {
      const folder = d.entries.get(el.dataset.emptyOf || '');
      if (!folder) return NONE;
      hovered = {
        id: String(folder.node.id), parentId: folder.parentId, index: folder.index, depth: folder.depth + 1,
        isFolder: true, expanded: true, modifiable: folder.modifiable, empty: true, rect,
      };
    } else {
      const entry = d.entries.get(el.dataset.bookmarkId || '');
      if (!entry) return NONE;
      hovered = {
        id: String(entry.node.id), parentId: entry.parentId, index: entry.index, depth: entry.depth,
        isFolder: el.dataset.kind === 'folder', expanded: el.getAttribute('aria-expanded') === 'true',
        modifiable: entry.modifiable, empty: false, rect,
      };
    }
    // Every entry of the model is one child of the list once it is drawn, so the count of children is
    // the count of rows drawn; the rest are in chunks not drawn yet (a bottom edge that is not the end).
    const t = resolveBookmarkDrop({
      hovered, pointerY, dragged: d.dragged, pastLast, allRendered: list.childElementCount >= host.rows().length,
    });
    return { kind: 'target', t, el, rect };
  }

  /** @param {DragEvent} event */
  function onDragLeave(event) {
    const d = drag;
    if (!d) return;
    // `dragleave` also fires on the way from one row to the next. Only a pointer that is outside the
    // column has left it (the box was read at `dragstart`; scrolling the content does not move it).
    const b = d.railBox;
    if (event.clientX >= b.left && event.clientX < b.right && event.clientY >= b.top && event.clientY < b.bottom) return;
    d.target = null;
    d.accepting = false;
    hide();
  }

  /**
   * The rail moved under a pointer that did not. The rows on screen are not the ones the line was
   * drawn for, and the browser sends no drag event for it, so look again where the pointer is.
   */
  function onScroll() {
    const d = drag;
    if (!d || d.frame) return;
    d.frame = requestAnimationFrame(() => {
      d.frame = 0;
      if (drag === d) refresh(d);
    });
  }

  /** @param {Drag} d */
  function refresh(d) {
    const v = resolve(d, document.elementFromPoint(d.x, d.y), d.y);
    if (v.kind === 'gap') return;
    if (v.kind === 'target' && v.t.valid && !v.t.noop) {
      // The browser was told "no" by the last event and keeps saying it until the next one: a line
      // drawn now would promise a drop that is never delivered.
      if (!d.accepting) return;
      d.target = v;
      show(v);
      return;
    }
    d.target = null;
    hide();
  }

  /* ── The picture ───────────────────────────────────────────────────────── */

  /** @param {{ t: any, el: HTMLElement, rect: DOMRect|null }} v */
  function show(v) {
    if (v.t.place === 'end') {
      lineOff();
      outline(intoOf(v.el));
      return;
    }
    outline(null);
    if (!v.rect) return; // a before / after always comes from a row, which has one
    const el = lineEl();
    el.style.left = `${v.rect.left}px`;
    el.style.width = `${v.rect.width}px`;
    el.style.top = `${v.t.place === 'before' ? v.rect.top - 1 : v.rect.bottom}px`;
    el.hidden = false;
  }

  function hide() {
    lineOff();
    outline(null);
  }

  function lineOff() {
    if (line) line.hidden = true;
  }

  /** The line is made when it is first needed and kept until `detach()`: it is not rebuilt per drag. */
  function lineEl() {
    if (line) return line;
    line = document.createElement('div');
    line.className = 'bmk-drop-indicator';
    line.dataset.testid = 'bookmark-drop-indicator';
    line.hidden = true;
    document.body.append(line);
    return line;
  }

  /** @param {HTMLElement|null} el */
  function outline(el) {
    if (outlined === el) return;
    if (outlined) outlined.classList.remove('is-bmk-drop-into');
    outlined = el;
    if (el) el.classList.add('is-bmk-drop-into');
  }

  /**
   * "Inside a folder" is shown on the folder's row; for its "Empty" line, which stands right under it,
   * that is the row before.
   * @param {HTMLElement} el
   * @returns {HTMLElement}
   */
  function intoOf(el) {
    if (!el.matches(MARKER)) return el;
    const folder = el.previousElementSibling;
    return folder instanceof HTMLElement && folder.dataset.bookmarkId === el.dataset.emptyOf ? folder : el;
  }

  /* ── Ending ────────────────────────────────────────────────────────────── */

  /** @param {DragEvent} event */
  function onDrop(event) {
    const d = drag;
    if (!d) return;
    event.preventDefault();
    // From the drop event, not from what the last `dragover` said: the rows may have moved under a
    // pointer that did not (Blink's own scroll sends no event). On the 1 px between rows the event
    // names the list, and the last target stands.
    const v = resolve(d, event.target, event.clientY);
    let t = null;
    let from = 'the drop';
    if (v.kind === 'target' && v.t.valid && !v.t.noop) t = v.t;
    else if (v.kind === 'gap' && d.target) {
      t = d.target.t;
      from = 'the last target, the pointer being on the gap between rows';
    }
    const id = d.id;
    const why = v.kind === 'target' ? v.t.reason : v.kind;
    end(); // the drag state first; the write is a queued task that may take a while
    if (!t) {
      host.log(`drop of ${id} ignored: no target (${why})`);
      return;
    }
    host.log(`drop of ${id}: ${t.place}${t.anchorId ? ` ${t.anchorId}` : ''} in ${t.parentId}, from ${from}`);
    void commit(id, t);
  }

  /** @param {DragEvent} event */
  function onDragEnd(event) {
    void event;
    if (drag) end('dragend');
  }

  function onBlur() {
    if (drag) end('the window lost focus');
  }

  /**
   * Put everything back: the picture, the timers, the listeners of the drag, and the hold, whose last
   * release runs the repaint that was owed meanwhile.
   * @param {string} [why] said when something other than the drop or the end of the drag ended it
   */
  function end(why) {
    const d = drag;
    if (!d) return;
    drag = null;
    if (why && why !== 'dragend') host.log(`drag of ${d.id} ended: ${why}`);
    if (d.timer) window.clearTimeout(d.timer);
    if (d.frame) cancelAnimationFrame(d.frame);
    rail.removeEventListener('scroll', onScroll);
    window.removeEventListener('blur', onBlur);
    hide();
    d.el.classList.remove('is-bmk-dragging');
    host.release('drag');
  }

  /* ── The move ──────────────────────────────────────────────────────────── */

  /**
   * @param {string} id
   * @param {{ place: any, anchorId: string|null, parentId: string }} t
   */
  async function commit(id, t) {
    let result;
    try {
      result = await queue(() => moveToPosition(host, {
        id, place: t.place, anchorId: t.anchorId, parentId: t.parentId,
      }));
    } catch (e) {
      host.log(`move of ${id} threw: ${e && e.message ? e.message : e}`);
      result = { ok: false, landed: null, reason: 'failed' };
    }
    if (!alive) return;
    // Nothing was written and nothing changed: not even a repaint (the write module's rule).
    if (result.reason === 'noop') return;
    if (result.reason === 'stale') host.toast(i18n.t('bookmarksStale'));
    else if (result.reason === 'failed') host.toast(i18n.t('operationFailed'));
    // Dropped on a folder: the reader has to see where it went. This opens the folder in the model
    // only; the bookmark button's target is a choice and stays where it was.
    if (result.ok && t.place === 'end') host.expand(t.parentId);
    const painted = await host.paintNow();
    // A paint that was held (the next drag has begun) or overtaken by a newer one leaves the rest to it.
    if (painted && result.ok && result.landed) host.focusRowById(result.landed.id);
  }

  /* ── Leaving ───────────────────────────────────────────────────────────── */

  function detach() {
    alive = false;
    end('the list was taken down');
    rail.removeEventListener('dragstart', onDragStart);
    rail.removeEventListener('dragenter', onDragOver);
    rail.removeEventListener('dragover', onDragOver);
    rail.removeEventListener('dragleave', onDragLeave);
    rail.removeEventListener('drop', onDrop);
    rail.removeEventListener('dragend', onDragEnd);
    if (line) line.remove();
    line = null;
  }

  return { detach, active: () => drag !== null };
}
