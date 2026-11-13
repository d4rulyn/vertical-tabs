/**
 * Pure geometry for the bookmark column. No DOM, no `chrome`, no imports, so the unit
 * tests can load it straight into Node the way `dnd-math.js` is loaded.
 *
 * Two things live here: the hover preview's placement (`placePreview`) and, at the end of
 * the file, the drop-zone and `index` maths of the bookmark editing work. That is why the
 * module is split out from `bookmark-preview.js` (that one touches the DOM and is loaded
 * lazily).
 */

/** Keep this far from every edge of the panel. */
export const PEEK_MARGIN = 8;

/** The card is never wider than this, however wide the panel is. */
export const PEEK_MAX_WIDTH = 300;

/** Gap between the hovered row and the card. */
export const PEEK_GAP = 4;

/**
 * Where the hover preview goes.
 *
 * The card is as wide as the panel allows (at most {@link PEEK_MAX_WIDTH}, never closer
 * than {@link PEEK_MARGIN} to either side), flush with the panel's right edge, and sits
 * just under the hovered row. When it would run off the bottom it goes above the row
 * instead, and when neither side has room it takes the side with more of it and is
 * pushed back into the panel as far as the panel allows. It never covers the row it
 * describes unless the panel is too short to avoid it.
 *
 * `width` x `height` is the picture. `extraHeight` is whatever sits under the picture
 * (the title and host lines), so the flip is decided on the whole card; it only has to
 * be given when there is such a caption, and it is not part of the returned `height`.
 *
 * Every number is a whole pixel, so the card's box is the same on every machine.
 *
 * @param {object} args
 * @param {{ top: number, bottom: number }} args.rowRect the hovered row, in viewport pixels
 * @param {{ w: number, h: number }} args.viewport the panel's inner size
 * @param {number} args.aspect picture width / height (the thumbnails are 8 / 3)
 * @param {number} [args.extraHeight] height of the caption under the picture
 * @returns {{ left: number, top: number, width: number, height: number, flipped: boolean }}
 */
export function placePreview({ rowRect, viewport, aspect, extraHeight = 0 }) {
  const width = Math.max(0, Math.floor(Math.min(PEEK_MAX_WIDTH, viewport.w - 2 * PEEK_MARGIN)));
  const height = Math.floor(width / aspect);
  const total = height + Math.max(0, Math.floor(extraHeight));
  const left = Math.max(PEEK_MARGIN, Math.floor(viewport.w - width - PEEK_MARGIN));

  const below = Math.round(rowRect.bottom + PEEK_GAP);
  const above = Math.round(rowRect.top - PEEK_GAP - total);
  const floor = PEEK_MARGIN;
  const ceiling = viewport.h - PEEK_MARGIN - total; // the lowest `top` that still fits

  let top = below;
  let flipped = false;
  if (below > ceiling) {
    // Room under the row is what is left of the panel below it; room above is what is
    // left over it. Prefer the side that fits whole, else the roomier one.
    const roomBelow = viewport.h - PEEK_MARGIN - below;
    const roomAbove = above + total - floor;
    if (above >= floor || roomAbove > roomBelow) {
      top = above;
      flipped = true;
    }
  }
  // Inside the panel whichever way it fell: a card taller than the panel still starts at
  // the top margin rather than above the panel where nobody can see it.
  top = Math.min(Math.max(top, floor), Math.max(floor, ceiling));
  return { left, top, width, height, flipped };
}

// ---------------------------------------------------------------------------------------------
// Bookmark editing: where a dropped row lands, and the `index` Chrome has to be given for it.
//
// What this rests on is MEASURED, not remembered (`.agent/probe-results.md`): Probe 13 P1/P2 (same-
// parent lists of 4, move targets of 3) and Probe 17 PA/PB (lists of 1, 2, 3, 5 and 8, destinations of
// 0, 1, 2 and 5 children, the permanent folders as destinations). The unit test carries their tables as
// literal order strings (tests/unit/bookmark-math.test.mjs).
// ---------------------------------------------------------------------------------------------

/**
 * Drop zones, as shares of the hovered row's height counted from its top. UI constants chosen for
 * the editing work (plan D4), NOT measured: how Chrome's own bookmark manager splits a row is not
 * known here, so these are the numbers to adjust once somebody has held a real drag in them.
 *
 * A link has no inside, so its row is split in two: the upper `DROP_LINK_BEFORE` means "before it",
 * the rest "after it". A folder row is split in three: the top `DROP_FOLDER_BEFORE` is "before", the
 * bottom `DROP_FOLDER_AFTER` is "after", and the 50 % between them is "inside".
 */
export const DROP_LINK_BEFORE = 0.5;
export const DROP_FOLDER_BEFORE = 0.25;
export const DROP_FOLDER_AFTER = 0.25;

/**
 * The `index` to give `chrome.bookmarks.move` (or `create`, which behaves like a move from another
 * parent) for "put the item before / after row R", "as the first child" or "as the last child", and
 * whether the call can be left out altogether.
 *
 * `t` is the position, among the destination's CURRENT children, of the child the item goes before
 * (`count` = after the last one):
 *   'before' t = anchorIndex     'after' t = anchorIndex + 1     'start' t = 0     'end' t = count
 * `t` is clamped to 0..count first. A negative index throws synchronously and one above the child
 * count rejects with "Index out of bounds." at every size measured (Probe 13 P1, Probe 17 PA), so
 * neither ever leaves this function; a stale anchor therefore degrades to "first" or "last" instead
 * of to an error. (`'start'` needs no `count`: 0 is accepted by every folder, an empty one included.)
 *
 *  - Same parent: Chrome reads `index` against the list BEFORE the item is taken out, so the item
 *    lands at `t > s ? t - 1 : t`; `t === s` and `t === s + 1` are resolved no-ops that fire no event,
 *    so there is nothing to call (`skip`, and no `index` key). `final` is then the unchanged `s`.
 *  - Another parent (a new node counts as one): `index` is the final position, 0..count inclusive
 *    (an EMPTY destination takes 0), and the call is never skipped. 'end' leaves `index` out, so a
 *    child added meanwhile cannot make it stale (Probe 13 P2); `final` is `count`.
 * After a resolved call read the landing position from the node `move` resolves with; `final` is for
 * the unit table and for a toast.
 *
 * Choice (not in the plan's contract): `place: 'start'` is accepted too. "After an expanded folder"
 * means "as its first child" (plan D4) and there is no anchor row to say that with.
 * An unknown `place` throws: a write cannot be undone, so a typo must not become "append".
 *
 * @param {object} args
 * @param {boolean} args.sameParent the destination is the folder the item is already in
 * @param {number} [args.s] the item's current index (only read when `sameParent`)
 * @param {number} [args.anchorIndex] index of the row the item goes before / after
 * @param {'before'|'after'|'start'|'end'} args.place
 * @param {number} [args.count] children of the destination at drop time (a fresh read)
 * @returns {{ skip: boolean, index?: number, final: number }}
 */
export function bookmarkMoveArg({ sameParent, s, anchorIndex, place, count }) {
  let t;
  switch (place) {
    case 'before':
      t = anchorIndex;
      break;
    case 'after':
      t = anchorIndex + 1;
      break;
    case 'start':
      t = 0;
      break;
    case 'end':
      if (!sameParent) return { skip: false, final: count };
      t = count;
      break;
    default:
      throw new RangeError(`bookmarkMoveArg: unknown place ${String(place)}`);
  }
  if (place !== 'start') t = Math.min(Math.max(t, 0), count);
  if (!sameParent) return { skip: false, index: t, final: t };
  if (t === s || t === s + 1) return { skip: true, final: s };
  return { skip: false, index: t, final: t > s ? t - 1 : t };
}

/** The result of "this drop is not possible": nothing to show, nothing to write. */
function noTarget(reason) {
  return { place: null, anchorId: null, parentId: null, valid: false, noop: false, reason };
}

/**
 * Where a drag that is over ONE row would land. One row, not the list: the caller reads a single
 * `getBoundingClientRect()` per `dragover`, so the cost does not grow with the number of rows.
 *
 * `hovered` is the row under the pointer:
 *   { id, parentId, index, depth, isFolder, expanded, hasChildren, modifiable, empty, rect: {top, bottom} }
 * `id` is its bookmark id, except for the "Empty" marker row of an open empty folder (`empty: true`),
 * which carries that FOLDER's id and means "inside it". `depth` is 0 for a permanent folder.
 * `modifiable` is false for a node Chrome marks `unmodifiable` (managed bookmarks); a permanent
 * folder IS modifiable (Probe 17 PB: it is a destination like any other). `hasChildren` is carried for
 * the callers; the rules below do not need it. `rect` is in the same pixels as `pointerY`.
 *
 * `dragged` is the row being moved:
 *   { id, parentId, index, isFolder, descendants: Set<id>, siblings? }
 * `descendants` is built once at `dragstart` (see {@link descendantIds}); only `.has` is called on it.
 * `siblings` (optional) is how many children its folder has: with it, "dropped on its own folder
 * while already last" is known to be a no-op; without it that case is not flagged here (the write
 * re-reads the folder and skips it anyway).
 *
 * Result `{ place, anchorId, parentId, valid, noop, reason }`:
 *   place 'before' / 'after': next to the sibling row `anchorId`, in `parentId`
 *   place 'start': the first child of `parentId`;  place 'end': appended to `parentId`
 *   (`anchorId` is null for 'start' and 'end'.)  These are the words {@link bookmarkMoveArg} takes.
 * `valid` false means no target (all three of place / anchorId / parentId are null) and `reason` says
 * why: 'cycle' (into the dragged folder or anything under it), 'read-only', 'root-edge' (above or
 * below a permanent folder: nothing can be placed beside one), 'unrendered' (see `pastLast`),
 * 'no-row', 'no-drag', 'no-geometry' (a rect with no height or a pointer that is not a number).
 * `valid` true and `noop` true is a position that changes nothing (the dragged row's own place and
 * its two neighbouring gaps): no indicator, and the drop is not accepted. The reason is then 'noop',
 * else 'ok'. Only `valid && !noop` is worth an indicator and a `preventDefault()`.
 *
 * Rules (plan D4, D5):
 *  - A link: upper half before, lower half after. A folder: 25 % before, 50 % inside, 25 % after.
 *    A zone starts at its lower edge, so a pointer exactly ON a boundary belongs to the zone below
 *    it, and a pointer outside the rect counts as the nearest edge. (The plan does not say; chosen.)
 *  - "After" an EXPANDED folder, empty or not, is inside it as its first child ('start'), because that
 *    is where the next row on screen is. "After" a collapsed folder is the sibling after it.
 *  - The "Empty" marker row is one big "inside", whatever the pointer's height.
 *  - A permanent folder row (depth 0) takes drops inside only, from its middle 50 %; its outer
 *    quarters show nothing and write nothing (criteria B7.2; a permanent folder has no neighbours
 *    to be placed between and cannot be reordered).
 *  - Never into the dragged folder or any of its descendants.
 *
 * Choice (not in the plan's signature): `pastLast` says the pointer is below the LAST row of the list
 * and `hovered` is that row (the caller knows, the 1 px gap between rows is a different case and never
 * gets here: there the caller keeps its previous target, Probe 17 PC (e)). Then the drop appends after
 * that row, but only if `allRendered` (every row of the list is in the DOM, `S.rendered ===
 * S.rows.length`): the list is rendered in chunks, so the row that is last on screen is not the end.
 * If it is not, the answer is 'unrendered'. If the last row is a permanent folder it is 'root-edge'.
 *
 * @param {object} args
 * @param {object | null} args.hovered
 * @param {number} args.pointerY the pointer's `clientY`
 * @param {object} args.dragged
 * @param {boolean} [args.pastLast]
 * @param {boolean} [args.allRendered]
 * @returns {{ place: 'before'|'after'|'start'|'end'|null, anchorId: string|null, parentId: string|null,
 *   valid: boolean, noop: boolean, reason: string }}
 */
export function resolveBookmarkDrop({ hovered, pointerY, dragged, pastLast = false, allRendered = false }) {
  if (!dragged) return noTarget('no-drag');
  if (!hovered) return noTarget('no-row');
  // Fail closed: a row that does not say it can be written to is not written to.
  if (hovered.modifiable !== true) return noTarget('read-only');

  /** @type {'before'|'inside'|'after'} */
  let zone;
  if (pastLast) {
    // Checked before the marker row: a pointer below an unrendered tail is not "on" the marker.
    if (!allRendered) return noTarget('unrendered');
    zone = hovered.empty ? 'inside' : 'after';
  } else if (hovered.empty) {
    zone = 'inside';
  } else {
    const rect = hovered.rect;
    const height = rect ? rect.bottom - rect.top : NaN;
    if (!(height > 0) || !Number.isFinite(pointerY)) return noTarget('no-geometry');
    const offset = pointerY - rect.top;
    if (hovered.isFolder) {
      if (offset < height * DROP_FOLDER_BEFORE) zone = 'before';
      else if (offset >= height * (1 - DROP_FOLDER_AFTER)) zone = 'after';
      else zone = 'inside';
    } else {
      zone = offset < height * DROP_LINK_BEFORE ? 'before' : 'after';
    }
  }

  if (hovered.depth === 0 && zone !== 'inside') return noTarget('root-edge');

  /** @type {'before'|'after'|'start'|'end'} */
  let place;
  let anchorId = null;
  let parentId;
  if (zone === 'inside') {
    place = 'end';
    parentId = hovered.id;
  } else if (zone === 'before') {
    place = 'before';
    anchorId = hovered.id;
    parentId = hovered.parentId;
  } else if (hovered.isFolder && hovered.expanded) {
    place = 'start';
    parentId = hovered.id;
  } else {
    place = 'after';
    anchorId = hovered.id;
    parentId = hovered.parentId;
  }

  // The destination folder is `parentId` in every case, so one test covers dropping onto the dragged
  // folder, onto a row under it (before / after / inside) and onto its own "Empty" marker.
  if (parentId === dragged.id || (dragged.descendants && dragged.descendants.has(parentId))) {
    return noTarget('cycle');
  }

  let noop = false;
  if (parentId === dragged.parentId) {
    if (place === 'end') {
      noop = Number.isInteger(dragged.siblings)
        && bookmarkMoveArg({ sameParent: true, s: dragged.index, place, count: dragged.siblings }).skip;
    } else {
      // The anchor row exists in the destination, so it has at least `hovered.index + 1` children:
      // that is a `count` for which the clamp inside bookmarkMoveArg changes nothing.
      noop = bookmarkMoveArg({
        sameParent: true, s: dragged.index, anchorIndex: hovered.index, place, count: hovered.index + 1,
      }).skip;
    }
  }
  return { place, anchorId, parentId, valid: true, noop, reason: noop ? 'noop' : 'ok' };
}

/**
 * The ids of every row under the row at `idx` of `rows`, which is the flat list in reading order
 * (`S.rows`): the rows after it that are deeper than it, up to the first one that is not. Computed
 * once at `dragstart`; a drag is then answered with `Set.has`. Only the subtree is read, never the
 * rest of the list.
 *
 * A row is `{ id, depth }` or the `{ node: { id }, depth }` entry that `flatten()` builds. The "Empty"
 * marker entry of an open empty folder (`empty: true`) carries its folder's node, so it is skipped:
 * it is not a descendant, and counting it would put the folder itself among its own descendants.
 *
 * @param {Array<{ id?: string, node?: { id: string }, depth: number, empty?: boolean }>} rows
 * @param {number} idx
 * @returns {Set<string>}
 */
export function descendantIds(rows, idx) {
  /** @type {Set<string>} */
  const ids = new Set();
  const base = rows ? rows[idx] : undefined;
  if (!base) return ids;
  for (let i = idx + 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.depth <= base.depth) break;
    if (!row.empty) ids.add(row.node ? row.node.id : row.id);
  }
  return ids;
}
