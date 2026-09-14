/**
 * Pure drop-target geometry for the panel's drag and drop (spec.md §9.2,
 * Appendix A.2, amended by spec-addendum A14).
 *
 * PURE: no DOM, no `chrome.*`, no imports — `tests/unit/dnd-math.test.mjs`
 * imports this file directly under `node --test`.
 *
 * Everything the caller measures with `getBoundingClientRect()` is handed in;
 * the module only compares numbers. All coordinates are viewport coordinates
 * (client X/Y), which is what `DragEvent.clientX/clientY` reports.
 */

/**
 * A `.group-body` accepts a drop in the 6 px of bottom padding below its last
 * card, so dropping "just under" the last card of a group joins the group
 * instead of landing after it (spec.md §9.2).
 */
export const GROUP_BODY_BOTTOM_PAD = 6;

/** `chrome.tabGroups.TAB_GROUP_ID_NONE`, spelled out so this module stays pure. */
export const TAB_GROUP_ID_NONE = -1;

/**
 * @typedef {Object} RectLike
 * @property {number} top
 * @property {number} left
 * @property {number} [bottom]
 * @property {number} [right]
 * @property {number} [width]
 * @property {number} [height]
 */

/**
 * @typedef {Object} DropItem
 * @property {number} tabId
 * @property {RectLike} rect     bounding box of the card / tile
 * @property {number} [groupId]  `-1` when the tab is not grouped
 * @property {boolean} [pinned]  `tab.pinned`
 * @property {boolean} [hidden]  filtered out (search) — never a drop anchor
 */

/**
 * @typedef {Object} DropGroup
 * @property {number} groupId
 * @property {RectLike} [rect]        the `.group-body` box
 * @property {RectLike} [headerRect]  the `.group-header` box
 * @property {number|null} [firstTabId]
 * @property {boolean} [collapsed]
 */

/**
 * @typedef {Object} DropTarget
 * @property {boolean} pinned      the tab must end up pinned
 * @property {number} groupId      target group, or `-1` for "no group"
 * @property {number|null} anchorTabId  insert *before* this tab; `null` = append
 */

/* ── numeric helpers ──────────────────────────────────────────────────────── */

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Normalise a rect-like object: `DOMRect`, a plain `{top,left,width,height}`
 * or a plain `{top,left,bottom,right}` all work.
 * @param {RectLike|null|undefined} rect
 * @returns {{top:number,left:number,right:number,bottom:number,width:number,height:number}|null}
 */
function normRect(rect) {
  if (!rect || typeof rect !== 'object') return null;
  const top = num(rect.top);
  const left = num(rect.left);
  const height = rect.height != null ? num(rect.height) : num(rect.bottom) - top;
  const width = rect.width != null ? num(rect.width) : num(rect.right) - left;
  return {
    top,
    left,
    width,
    height,
    bottom: rect.bottom != null ? num(rect.bottom) : top + height,
    right: rect.right != null ? num(rect.right) : left + width,
  };
}

function contains(rect, x, y) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function containsWithBottomPad(rect, x, y, pad) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom + pad;
}

function midX(rect) {
  return rect.left + rect.width / 2;
}

function midY(rect) {
  return rect.top + rect.height / 2;
}

/**
 * Row-major "is this tile after the pointer?" used by the pinned grid: a tile
 * on a later row always counts, a tile on the same row only when the pointer
 * is left of its midpoint, a tile on an earlier row never.
 */
function isAfterPointerRowMajor(rect, x, y) {
  if (y < rect.top) return true;
  if (y > rect.bottom) return false;
  return x < midX(rect);
}

/**
 * Distance-ranked fallback when the pointer is inside the zone but not over a
 * card (the gaps between cards, or the padding on either side).
 */
function nearestItem(items, x, y, isGrid) {
  let best = null;
  let bestScore = Infinity;
  for (const item of items) {
    const r = item.rect;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    // Vertical distance dominates in both layouts; the horizontal distance is
    // the tie-breaker (and matters in a grid, where one row holds many cards).
    const score = dy * 1000 + (isGrid ? dx : dx * 0.001);
    if (score < bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return best;
}

/* ── public API ───────────────────────────────────────────────────────────── */

/**
 * Does the pointer split a card left/right (several columns) or above/below
 * (a single column)? `columns` is authoritative when it is a usable number;
 * `layout` is the legacy spelling of the same question.
 *
 * @param {unknown} columns
 * @param {unknown} layout
 * @returns {boolean}
 */
export function isMultiColumn(columns, layout) {
  const n = typeof columns === 'number' ? columns : Number(columns);
  if (Number.isFinite(n) && n >= 1) return n > 1;
  return layout === 'grid';
}

/**
 * The item that follows `item` in render order, or `null` at the end of the
 * list. `items` is expected to be pre-filtered to *visible* entries.
 *
 * @param {DropItem[]} items
 * @param {DropItem|null} item
 * @returns {DropItem|null}
 */
export function nextVisibleItem(items, item) {
  if (!item) return null;
  const i = items.indexOf(item);
  if (i < 0 || i + 1 >= items.length) return null;
  return items[i + 1];
}

/**
 * Chrome's `tabs.move` removes the tab before re-inserting it, so an anchor
 * that sits *after* the moving tab shifts one position to the left.
 *
 * @param {number} movingIndex current `tab.index` of the tab being moved
 * @param {number} anchorIndex `tab.index` of the tab it should end up before
 * @returns {number} the index to pass to `tabs.move`
 */
export function finalIndexForInsertBefore(movingIndex, anchorIndex) {
  return movingIndex < anchorIndex ? anchorIndex - 1 : anchorIndex;
}

/**
 * Resolve a pointer position inside a drop zone into `{ pinned, groupId,
 * anchorTabId }` (spec.md §9.2, spec-addendum A14).
 *
 * The caller (`dnd.js`) supplies:
 *  - `zone`: `'pinned' | 'list' | 'group' | 'header'` — from `data-drop-zone`
 *    on `#pinned` / `#tablist` / `.group-body`, or `'header'` when the pointer
 *    is over a `.group-header`.
 *  - `zoneGroupId`: the group id of the `.group-body` / `.group-header` under
 *    the pointer (only meaningful for `'group'` / `'header'`).
 *  - `items`: every **visible** card (or pinned tile, for `zone: 'pinned'`) in
 *    render order, with its measured rect.
 *  - `groups`: one entry per rendered `.group`, with the `.group-body` rect
 *    (`rect`), the `.group-header` rect (`headerRect`) and `firstTabId`.
 *  - `columns`: how many columns the container is *actually* rendering. One
 *    column splits a card above/below the pointer; two or more split it
 *    left/right, because that is the direction render order runs in. The caller
 *    measures this from `grid-template-columns`, never from the user's setting:
 *    a panel too narrow for the chosen count shows fewer.
 *  - `layout`: legacy alias for the same distinction (`'grid'` ≡ two or more
 *    columns). Only consulted when `columns` is not supplied.
 *
 * @param {Object} params
 * @param {'pinned'|'list'|'group'|'header'} [params.zone]
 * @param {number} [params.pointerX]
 * @param {number} [params.pointerY]
 * @param {DropItem[]} [params.items]
 * @param {DropGroup[]} [params.groups]
 * @param {number} [params.columns] effective column count, ≥ 1
 * @param {'list'|'grid'|'auto'} [params.layout] legacy alias for `columns`
 * @param {number|null} [params.zoneGroupId]
 * @param {number|null} [params.headerGroupId]
 * @returns {DropTarget}
 */
export function resolveDrop({
  zone = 'list',
  pointerX = 0,
  pointerY = 0,
  items = [],
  groups = [],
  columns = null,
  layout = 'list',
  zoneGroupId = null,
  headerGroupId = null,
} = {}) {
  const x = num(pointerX);
  const y = num(pointerY);

  const list = [];
  for (const raw of Array.isArray(items) ? items : []) {
    if (!raw || raw.hidden === true) continue;
    const rect = normRect(raw.rect);
    if (!rect) continue;
    list.push({
      tabId: raw.tabId,
      rect,
      groupId: raw.groupId == null ? TAB_GROUP_ID_NONE : raw.groupId,
      pinned: raw.pinned === true,
    });
  }

  const groupBoxes = [];
  for (const raw of Array.isArray(groups) ? groups : []) {
    if (!raw) continue;
    groupBoxes.push({
      groupId: raw.groupId,
      rect: normRect(raw.rect),
      headerRect: normRect(raw.headerRect),
      firstTabId: raw.firstTabId == null ? null : raw.firstTabId,
      collapsed: raw.collapsed === true,
    });
  }

  /* ── the pinned grid: row-major, never grouped ─────────────────────────── */
  if (zone === 'pinned') {
    const anchor = list.find((item) => isAfterPointerRowMajor(item.rect, x, y));
    return {
      pinned: true,
      groupId: TAB_GROUP_ID_NONE,
      anchorTabId: anchor ? anchor.tabId : null,
    };
  }

  /* ── a group header: insert at the start of that group ─────────────────── */
  let headerGid = headerGroupId;
  if (headerGid == null && zone === 'header') headerGid = zoneGroupId;
  if (headerGid == null) {
    const hit = groupBoxes.find((g) => g.headerRect && contains(g.headerRect, x, y));
    if (hit) headerGid = hit.groupId;
  }
  if (headerGid != null && headerGid !== TAB_GROUP_ID_NONE) {
    const group = groupBoxes.find((g) => g.groupId === headerGid) || null;
    let firstTabId = group ? group.firstTabId : null;
    if (firstTabId == null) {
      const first = list.find((item) => item.groupId === headerGid);
      firstTabId = first ? first.tabId : null;
    }
    return { pinned: false, groupId: headerGid, anchorTabId: firstTabId };
  }

  /* ── the tab list, or a group body inside it ───────────────────────────── */
  const isGrid = isMultiColumn(columns, layout);

  let hovered = list.find((item) => contains(item.rect, x, y)) || null;
  if (!hovered && list.length > 0) {
    let maxBottom = -Infinity;
    for (const item of list) if (item.rect.bottom > maxBottom) maxBottom = item.rect.bottom;
    // "null when below all" — the drop appends at the end of the list.
    if (y <= maxBottom) hovered = nearestItem(list, x, y, isGrid);
  }

  let before = false;
  let anchorTabId = null;
  if (hovered) {
    before = isGrid ? x < midX(hovered.rect) : y < midY(hovered.rect);
    if (before) {
      anchorTabId = hovered.tabId;
    } else {
      const next = nextVisibleItem(list, hovered);
      anchorTabId = next ? next.tabId : null;
    }
  }

  // A14: the pinned/unpinned region is inferred from the drop neighbourhood,
  // so re-ordering pinned cards rendered inline (pinnedGrid = false) does not
  // silently unpin them.
  const anchorItem = anchorTabId == null ? null : list.find((i) => i.tabId === anchorTabId) || null;
  const neighbour = before ? hovered : anchorItem;
  const pinned = neighbour ? neighbour.pinned === true : false;

  let groupId = TAB_GROUP_ID_NONE;
  if (!pinned) {
    if (zone === 'group' && zoneGroupId != null) {
      groupId = zoneGroupId;
    } else {
      const body = groupBoxes.find(
        (g) => g.rect && containsWithBottomPad(g.rect, x, y, GROUP_BODY_BOTTOM_PAD),
      );
      if (body) {
        groupId = body.groupId;
      } else if (
        hovered &&
        contains(hovered.rect, x, y) &&
        hovered.groupId !== TAB_GROUP_ID_NONE
      ) {
        // No `.group-body` geometry was supplied, but the pointer is squarely
        // on a grouped card — that card's group is the obvious target.
        groupId = hovered.groupId;
      }
    }
  }

  return { pinned, groupId, anchorTabId };
}

export default {
  resolveDrop,
  finalIndexForInsertBefore,
  nextVisibleItem,
  isMultiColumn,
  GROUP_BODY_BOTTOM_PAD,
};
