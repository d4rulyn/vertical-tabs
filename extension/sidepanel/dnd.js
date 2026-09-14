/**
 * Drag and drop: reorder, pin/unpin, group/ungroup, move between windows, and
 * accept links dropped from outside (spec.md §9.2, Appendix A.2, addendum A14).
 *
 * Chrome's own rules make the naive implementation wrong, so this module is
 * explicit about everything:
 *  - `tabs.move` silently **clamps** an index into the pinned or the unpinned
 *    region, so the drop zone decides `pinned` first and moves afterwards;
 *  - a move into the middle of a group implicitly **joins** it, so group
 *    membership is set with `tabs.group`/`tabs.ungroup` and verified in a short
 *    reconcile loop instead of being inferred;
 *  - indices always come from a fresh `tabs.query({ windowId })`, never from
 *    DOM order (the model hides the panel's own tab, so DOM order is not a
 *    Chrome index);
 *  - a cross-window move is appended first (`index: -1`), because inserting
 *    into the middle of a group across windows throws `disrupt group
 *    continuity`.
 *
 * DOM touched: `#tablist`, `#pinned`, `.tab-card`, `.pinned-tile`, `.group`,
 * `.group-body`, `.group-header`, `#drop-indicator`, class `.is-dragging`.
 */

import * as log from '../common/log.js';
import {
  DRAG_AUTOSCROLL_PX,
  DRAG_AUTOSCROLL_EDGE_PX,
  DROP_RECONCILE_PASSES,
} from '../common/constants.js';
import { groupColorVar } from '../common/group-colors.js';
import { resolveDrop, finalIndexForInsertBefore } from './dnd-math.js';
import * as ops from './tab-ops.js';
import { t, toast } from './toast.js';

/** Private drag payload type — only this extension reads it. */
export const PAYLOAD_TYPE = 'application/x-vertical-tabs';

const NONE = ops.TAB_GROUP_ID_NONE;
const EXTERNAL_SCHEMES = /^(https?|ftp|file):/i;

/* ── state ────────────────────────────────────────────────────────────────── */

/** @type {any} */
let ctx = null;
/** @type {HTMLElement|null} */
let tablist = null;
/** @type {HTMLElement|null} */
let pinnedEl = null;
/** @type {HTMLElement|null} */
let indicator = null;
let bound = false;

/**
 * Mirrors the payload for the duration of the drag: `getData()` is not
 * available during `dragover` (only in `drop`), so the indicator maths needs a
 * local copy.
 * @type {{kind:'tabs', tabIds:number[], windowId:number}|{kind:'group', groupId:number, windowId:number}|null}
 */
let dragState = null;
/** @type {HTMLElement[]} */
let draggedEls = [];
/** @type {Map<Element, number>} */
const enterCounts = new Map();
let scrollDir = 0;
let scrollRaf = 0;
/** `dragover` throttle: last measured pointer position and time. */
let lastOverAt = 0;
let lastOverX = -1;
let lastOverY = -1;

/* ── init ─────────────────────────────────────────────────────────────────── */

/** @param {any} context */
export function init(context) {
  ctx = ops.init(context) || context || null;
  tablist = document.getElementById('tablist');
  pinnedEl = document.getElementById('pinned');
  indicator = document.getElementById('drop-indicator');

  if (bound) return;
  bound = true;

  for (const root of [tablist, pinnedEl]) {
    if (!root) continue;
    root.addEventListener('dragstart', onDragStart);
    root.addEventListener('dragenter', onDragEnter);
    root.addEventListener('dragover', onDragOver);
    root.addEventListener('dragleave', onDragLeave);
    root.addEventListener('drop', onDrop);
  }
  document.addEventListener('dragend', onDragEnd);
  // A drag that ends outside any zone still has to clean up.
  window.addEventListener('blur', endDragVisuals);
}

/** @returns {boolean} true while this panel is the source of a drag */
export function isDragging() {
  return dragState !== null;
}

/* ── dragstart ────────────────────────────────────────────────────────────── */

/**
 * @param {DragEvent} event
 */
function onDragStart(event) {
  const el = eventElement(event);
  const dt = event.dataTransfer;
  if (!el || !dt) return;

  const card = el.closest('.tab-card');
  const tile = el.closest('.pinned-tile');
  const header = el.closest('.group-header');
  const node = /** @type {HTMLElement|null} */ (card || tile);

  if (node) {
    const tabId = Number(node.getAttribute('data-tab-id'));
    if (!Number.isInteger(tabId)) return;
    const tabIds = ops.selectionFor(tabId);
    const payload = { kind: /** @type {'tabs'} */ ('tabs'), tabIds, windowId: ops.windowId() };
    dragState = payload;
    dt.effectAllowed = 'move';
    setData(dt, PAYLOAD_TYPE, JSON.stringify(payload));
    if (tabIds.length === 1) {
      const tab = ops.getTab(tabId);
      const url = tab ? tab.url || tab.pendingUrl || '' : '';
      if (url && EXTERNAL_SCHEMES.test(url)) {
        // Lets a card be dragged out of the panel as a link.
        setData(dt, 'text/uri-list', url);
        setData(dt, 'text/plain', url);
      }
    }
    applyDragImage(dt, node, event);
    draggedEls = elementsForTabs(tabIds);
    markDragging();
    return;
  }

  if (header) {
    const section = header.closest('.group');
    const groupId = section ? Number(section.getAttribute('data-group-id')) : NaN;
    if (!Number.isInteger(groupId) || groupId === NONE) return;
    const payload = { kind: /** @type {'group'} */ ('group'), groupId, windowId: ops.windowId() };
    dragState = payload;
    dt.effectAllowed = 'move';
    setData(dt, PAYLOAD_TYPE, JSON.stringify(payload));
    applyDragImage(dt, /** @type {HTMLElement} */ (header), event);
    draggedEls = section instanceof HTMLElement ? [section] : [];
    markDragging();
  }
}

/**
 * @param {DataTransfer} dt
 * @param {string} type
 * @param {string} value
 */
function setData(dt, type, value) {
  try {
    dt.setData(type, value);
  } catch (e) {
    log.warn('dataTransfer.setData', type, e);
  }
}

/**
 * `setDragImage` needs an element that is currently rendered; the offset keeps
 * the ghost under the pointer where the user grabbed it.
 * @param {DataTransfer} dt
 * @param {HTMLElement} node
 * @param {DragEvent} event
 */
function applyDragImage(dt, node, event) {
  try {
    const rect = node.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
    dt.setDragImage(node, x, y);
  } catch (e) {
    log.warn('setDragImage', e);
  }
}

function markDragging() {
  requestAnimationFrame(() => {
    for (const el of draggedEls) el.classList.add('is-dragging');
  });
}

/**
 * @param {number[]} tabIds
 * @returns {HTMLElement[]}
 */
function elementsForTabs(tabIds) {
  /** @type {HTMLElement[]} */
  const out = [];
  for (const id of tabIds) {
    for (const el of document.querySelectorAll(`[data-tab-id="${id}"]`)) {
      if (el instanceof HTMLElement && (el.classList.contains('tab-card') || el.classList.contains('pinned-tile'))) {
        out.push(el);
      }
    }
  }
  return out;
}

/* ── dragenter / dragover / dragleave ─────────────────────────────────────── */

/**
 * @param {DragEvent} event
 */
function onDragEnter(event) {
  if (!acceptable(event)) return;
  // Both dragenter and dragover must preventDefault for a drop to be allowed.
  event.preventDefault();
  const zone = zoneElementOf(event);
  if (zone) enterCounts.set(zone, (enterCounts.get(zone) || 0) + 1);
}

/**
 * @param {DragEvent} event
 */
function onDragOver(event) {
  if (!acceptable(event)) return;
  // `dragover` fires continuously; re-measuring every card on each event is a
  // forced reflow per frame, which is felt with a few hundred tabs.
  const now = Date.now();
  const moved = Math.abs(event.clientX - lastOverX) + Math.abs(event.clientY - lastOverY);
  if (moved < 4 && now - lastOverAt < 40) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    autoScroll(event);
    return;
  }
  lastOverAt = now;
  lastOverX = event.clientX;
  lastOverY = event.clientY;

  const resolved = resolveFromEvent(event);
  if (!resolved || !resolved.target) {
    hideIndicator();
    return;
  }
  // A group cannot live among pinned tabs; refuse the drop outright so the
  // user gets the "no drop" cursor instead of an error toast (spec.md §9.2).
  if (dragState && dragState.kind === 'group' && resolved.zone === 'pinned') {
    hideIndicator();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
    return;
  }
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  positionIndicator(resolved);
  autoScroll(event);
}

/**
 * @param {DragEvent} event
 */
function onDragLeave(event) {
  const zone = zoneElementOf(event);
  if (zone && enterCounts.has(zone)) {
    const next = (enterCounts.get(zone) || 0) - 1;
    if (next <= 0) enterCounts.delete(zone);
    else enterCounts.set(zone, next);
  }
  if (enterCounts.size === 0) {
    hideIndicator();
    stopAutoScroll();
  }
}

/**
 * @param {DragEvent} event
 * @returns {boolean}
 */
function acceptable(event) {
  const dt = event.dataTransfer;
  if (!dt) return false;
  if (dragState) return true;
  const types = typesOf(dt);
  return types.includes(PAYLOAD_TYPE) || types.includes('text/uri-list');
}

/**
 * @param {DataTransfer} dt
 * @returns {string[]}
 */
function typesOf(dt) {
  try {
    return Array.from(dt.types || []);
  } catch {
    return [];
  }
}

/* ── drop ─────────────────────────────────────────────────────────────────── */

/**
 * @param {DragEvent} event
 */
function onDrop(event) {
  if (!acceptable(event)) return;
  // No `stopPropagation()`: `sidepanel.js` listens for `drop` on the document
  // to clear its "a drag is in progress" flag.
  event.preventDefault();
  const resolved = resolveFromEvent(event);
  const payload = readPayload(event);
  const url = payload ? null : externalUrlFrom(event.dataTransfer);
  endDragVisuals();
  if (!resolved || !resolved.target) return;
  const target = { ...resolved.target, windowId: ops.windowId() };

  void (async () => {
    try {
      if (payload && payload.kind === 'tabs') {
        await performDrop(payload, target);
      } else if (payload && payload.kind === 'group') {
        await performGroupDrop(payload, target);
      } else if (url) {
        await performExternalDrop(url, target);
      }
    } catch (e) {
      // `tab-ops` already logged, toasted and resynced.
      log.warn('drop', e);
    }
  })();
}

/**
 * @param {DragEvent} event
 * @returns {{kind:'tabs', tabIds:number[], windowId:number}|{kind:'group', groupId:number, windowId:number}|null}
 */
function readPayload(event) {
  const dt = event.dataTransfer;
  if (dt) {
    try {
      const raw = dt.getData(PAYLOAD_TYPE);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.kind === 'tabs' && Array.isArray(parsed.tabIds) && parsed.tabIds.length > 0) {
          return {
            kind: 'tabs',
            tabIds: parsed.tabIds.filter((id) => Number.isInteger(id)),
            windowId: Number.isInteger(parsed.windowId) ? parsed.windowId : ops.windowId(),
          };
        }
        if (parsed && parsed.kind === 'group' && Number.isInteger(parsed.groupId)) {
          return {
            kind: 'group',
            groupId: parsed.groupId,
            windowId: Number.isInteger(parsed.windowId) ? parsed.windowId : ops.windowId(),
          };
        }
      }
    } catch (e) {
      log.warn('readPayload', e);
    }
  }
  return dragState;
}

/**
 * @param {DataTransfer|null} dt
 * @returns {string|null}
 */
function externalUrlFrom(dt) {
  if (!dt) return null;
  let raw = '';
  try {
    raw = dt.getData('text/uri-list') || '';
  } catch {
    raw = '';
  }
  if (raw) {
    for (const line of raw.split(/\r?\n/)) {
      const value = line.trim();
      if (value && !value.startsWith('#') && EXTERNAL_SCHEMES.test(value)) return value;
    }
  }
  let plain = '';
  try {
    plain = (dt.getData('text/plain') || '').trim();
  } catch {
    plain = '';
  }
  if (plain && EXTERNAL_SCHEMES.test(plain)) {
    try {
      // Reject anything that is not a real absolute URL.
      const parsed = new URL(plain);
      return parsed.href;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * @param {DragEvent} [event]
 */
function onDragEnd(event) {
  void event;
  endDragVisuals();
}

function endDragVisuals() {
  for (const el of draggedEls) el.classList.remove('is-dragging');
  for (const el of document.querySelectorAll('.is-dragging')) el.classList.remove('is-dragging');
  draggedEls = [];
  dragState = null;
  enterCounts.clear();
  lastOverAt = 0;
  lastOverX = -1;
  lastOverY = -1;
  hideIndicator();
  stopAutoScroll();
}

/* ── target resolution ────────────────────────────────────────────────────── */

/**
 * @param {Event} event
 * @returns {Element|null}
 */
function eventElement(event) {
  const target = event.target;
  if (target instanceof Element) return target;
  if (target && /** @type {any} */ (target).parentElement instanceof Element) {
    return /** @type {any} */ (target).parentElement;
  }
  return null;
}

/**
 * @param {Event} event
 * @returns {Element|null} the `[data-drop-zone]` container under the pointer
 */
function zoneElementOf(event) {
  const el = eventElement(event);
  if (!el) return null;
  return el.closest('[data-drop-zone]');
}

/**
 * Measure the current layout and ask `dnd-math` where the drop would land.
 * @param {DragEvent} event
 * @returns {{zone:string, target:import('./dnd-math.js').DropTarget|null, items:any[], groups:any[], columns:number}|null}
 */
function resolveFromEvent(event) {
  const el = eventElement(event);
  if (!el) return null;
  const header = el.closest('.group-header');
  const zoneEl = el.closest('[data-drop-zone]');
  if (!header && !zoneEl) return null;

  const rawZone = header ? 'header' : String(zoneEl && zoneEl.getAttribute('data-drop-zone'));
  const zone = rawZone === 'pinned' || rawZone === 'list' || rawZone === 'group' || rawZone === 'header'
    ? rawZone
    : 'list';

  let zoneGroupId = null;
  if (zone === 'header' && header) {
    const section = header.closest('.group');
    if (section) {
      const id = Number(section.getAttribute('data-group-id'));
      if (Number.isInteger(id)) zoneGroupId = id;
    }
  } else if (zone === 'group' && zoneEl) {
    const section = zoneEl.closest('.group');
    if (section) {
      const id = Number(section.getAttribute('data-group-id'));
      if (Number.isInteger(id)) zoneGroupId = id;
    }
  }

  const items = zone === 'pinned' ? pinnedItems() : listItems();
  const groups = zone === 'pinned' ? [] : groupBoxes();
  // Measure the container the drop is actually happening in: a `.group-body` is
  // narrower than `#tablist` and may therefore be showing one column fewer.
  const columns = effectiveColumns(zone === 'group' && zoneEl ? zoneEl : tablist);

  const target = resolveDrop({
    zone,
    pointerX: event.clientX,
    pointerY: event.clientY,
    items,
    groups,
    columns,
    zoneGroupId,
  });

  return { zone, target, items, groups, columns };
}

/**
 * How many columns of cards `host` is *actually* rendering right now.
 *
 * The user's chosen count is only an upper bound: a panel too narrow to give
 * every column a usable card width shows fewer (see `--vt-track-min` in
 * sidepanel.css), and a `.group-body` is indented so it can drop a column before
 * the list does. Reading `grid-template-columns` back is the only honest answer,
 * and it is exactly what `keyboard.js` steps by.
 *
 * @param {Element|null} host
 * @returns {number} at least 1
 */
function effectiveColumns(host) {
  if (!host) return 1;
  try {
    const style = getComputedStyle(host);
    if (style.display !== 'grid' && style.display !== 'inline-grid') return 1;
    const tracks = String(style.gridTemplateColumns || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;
    return tracks > 0 ? tracks : 1;
  } catch {
    return 1;
  }
}

/**
 * @returns {any[]} every visible card in render order, measured
 */
function listItems() {
  /** @type {any[]} */
  const out = [];
  if (!tablist) return out;
  const model = ops.model();
  for (const card of tablist.querySelectorAll('.tab-card')) {
    if (card.classList.contains('is-hidden')) continue;
    const rect = card.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue; // inside a collapsed group
    const tabId = Number(card.getAttribute('data-tab-id'));
    if (!Number.isInteger(tabId)) continue;
    const tab = model && model.tabs ? model.tabs.get(tabId) : null;
    const attrGroup = Number(card.getAttribute('data-group-id'));
    out.push({
      tabId,
      rect,
      groupId: tab ? (tab.groupId ?? NONE) : Number.isInteger(attrGroup) ? attrGroup : NONE,
      pinned: tab ? tab.pinned === true : card.classList.contains('is-pinned-inline'),
    });
  }
  return out;
}

/**
 * @returns {any[]} every visible pinned tile in render order, measured
 */
function pinnedItems() {
  /** @type {any[]} */
  const out = [];
  if (!pinnedEl) return out;
  for (const tile of pinnedEl.querySelectorAll('.pinned-tile')) {
    if (tile.classList.contains('is-hidden')) continue;
    const tabId = Number(tile.getAttribute('data-tab-id'));
    if (!Number.isInteger(tabId)) continue;
    out.push({ tabId, rect: tile.getBoundingClientRect(), groupId: NONE, pinned: true });
  }
  return out;
}

/**
 * @returns {any[]} one entry per rendered group, with body and header geometry
 */
function groupBoxes() {
  /** @type {any[]} */
  const out = [];
  if (!tablist) return out;
  const ordered = ops.tabsInOrder();
  for (const section of tablist.querySelectorAll('.group')) {
    const groupId = Number(section.getAttribute('data-group-id'));
    if (!Number.isInteger(groupId)) continue;
    const body = section.querySelector('.group-body');
    const header = section.querySelector('.group-header');
    const firstCard = body ? body.querySelector('.tab-card:not(.is-hidden)') : null;
    let firstTabId = firstCard ? Number(firstCard.getAttribute('data-tab-id')) : null;
    if (!Number.isInteger(firstTabId)) {
      firstTabId = null;
      for (const tab of ordered) {
        if (tab.groupId === groupId) {
          firstTabId = tab.id ?? null;
          break;
        }
      }
    }
    out.push({
      groupId,
      rect: body ? body.getBoundingClientRect() : null,
      headerRect: header ? header.getBoundingClientRect() : null,
      firstTabId,
      collapsed: section.classList.contains('is-collapsed'),
    });
  }
  return out;
}

/* ── drop indicator ───────────────────────────────────────────────────────── */

/**
 * @param {{zone:string, target:any, items:any[], groups:any[], columns:number}} resolved
 */
function positionIndicator(resolved) {
  if (!indicator) indicator = document.getElementById('drop-indicator');
  if (!indicator) return;
  const { zone, target, items, columns } = resolved;
  // A single column splits above/below, so the caret is a horizontal rule; two or
  // more columns split left/right, so it is a vertical bar between cards.
  const vertical = zone === 'pinned' || columns > 1;

  const anchor = target.anchorTabId == null
    ? null
    : items.find((item) => item.tabId === target.anchorTabId) || null;
  const last = items.length > 0 ? items[items.length - 1] : null;

  /** @type {DOMRect|null} */
  let rect = null;
  let atEnd = false;
  if (anchor) {
    rect = anchor.rect;
  } else if (last) {
    rect = last.rect;
    atEnd = true;
  }

  if (!rect) {
    // Empty zone: draw at the top of its content box.
    const host = zone === 'pinned' ? pinnedEl : tablist;
    if (!host) {
      hideIndicator();
      return;
    }
    const hostRect = host.getBoundingClientRect();
    place(hostRect.left + 4, hostRect.top + 4, Math.max(0, hostRect.width - 8), 2);
  } else if (vertical) {
    const x = atEnd ? rect.right + 1 : rect.left - 1;
    place(x - 1, rect.top, 2, rect.height);
  } else {
    const y = atEnd ? rect.bottom + 1 : rect.top - 1;
    place(rect.left, y - 1, rect.width, 2);
  }

  indicator.style.background = colorForGroup(target.groupId);
  indicator.hidden = false;
}

/**
 * @param {number} left
 * @param {number} top
 * @param {number} width
 * @param {number} height
 */
function place(left, top, width, height) {
  if (!indicator) return;
  indicator.style.left = `${Math.round(left)}px`;
  indicator.style.top = `${Math.round(top)}px`;
  indicator.style.width = `${Math.round(width)}px`;
  indicator.style.height = `${Math.round(height)}px`;
}

/**
 * @param {number} groupId
 * @returns {string} a CSS colour: the group's colour when dropping into one
 */
function colorForGroup(groupId) {
  if (groupId == null || groupId === NONE) return 'var(--vt-accent)';
  const group = ops.groups().get(groupId);
  if (group && typeof group.color === 'string') return groupColorVar(group.color);
  return 'var(--vt-accent)';
}

function hideIndicator() {
  if (!indicator) indicator = document.getElementById('drop-indicator');
  if (indicator) indicator.hidden = true;
}

/* ── auto-scroll ──────────────────────────────────────────────────────────── */

/**
 * @param {DragEvent} event
 */
function autoScroll(event) {
  if (!tablist) return;
  const rect = tablist.getBoundingClientRect();
  let dir = 0;
  if (event.clientY < rect.top + DRAG_AUTOSCROLL_EDGE_PX) dir = -1;
  else if (event.clientY > rect.bottom - DRAG_AUTOSCROLL_EDGE_PX) dir = 1;
  // Only while the pointer is actually inside the scroller: the pinned strip
  // sits above it and must not drag-scroll the list.
  const inside =
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom;
  if (!inside) dir = 0;
  scrollDir = dir;
  if (dir === 0) {
    stopAutoScroll();
    return;
  }
  if (!scrollRaf) scrollRaf = requestAnimationFrame(scrollStep);
}

function scrollStep() {
  scrollRaf = 0;
  if (!tablist || scrollDir === 0) return;
  tablist.scrollTop += scrollDir * DRAG_AUTOSCROLL_PX;
  scrollRaf = requestAnimationFrame(scrollStep);
}

function stopAutoScroll() {
  scrollDir = 0;
  if (scrollRaf) {
    cancelAnimationFrame(scrollRaf);
    scrollRaf = 0;
  }
}

/* ── the actual moves ─────────────────────────────────────────────────────── */

/**
 * @param {number} tabId
 * @returns {Promise<chrome.tabs.Tab|null>}
 */
async function safeGet(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

/**
 * Move tabs to a resolved drop target (spec.md Appendix A.2).
 *
 * @param {{tabIds:number[], windowId:number}} payload
 * @param {{pinned:boolean, groupId:number, anchorTabId:number|null, windowId:number}} target
 */
export async function performDrop(payload, target) {
  const targetWindowId = Number.isInteger(target.windowId) ? target.windowId : ops.windowId();
  const sourceWindowId = Number.isInteger(payload.windowId) ? payload.windowId : targetWindowId;
  const tabIds = (payload.tabIds || []).filter((id) => Number.isInteger(id));
  if (tabIds.length === 0) return;

  // Appending first is the only cross-window move that cannot break group
  // contiguity (`…disrupt group continuity…`).
  if (sourceWindowId !== targetWindowId) {
    await ops.move(tabIds, { windowId: targetWindowId, index: -1 });
  }

  const wantGroup = target.pinned ? NONE : target.groupId;
  const ordered = await ops.sortedByIndex(tabIds, targetWindowId);

  for (const id of ordered) {
    let tab = await safeGet(id);
    if (!tab) continue;

    if (tab.pinned !== target.pinned) {
      await ops.update(id, { pinned: target.pinned });
      tab = await safeGet(id);
      if (!tab) continue;
    }

    for (let pass = 0; pass < DROP_RECONCILE_PASSES; pass += 1) {
      if (tab.groupId !== wantGroup) {
        if (wantGroup === NONE) await ops.ungroup(id);
        else await ops.group({ tabIds: [id], groupId: wantGroup });
      }

      // Indices ALWAYS from Chrome, never from the DOM.
      const list = await ops.queryTabs({ windowId: targetWindowId });
      const current = list.find((item) => item.id === id);
      if (!current) break;
      const anchor =
        target.anchorTabId == null ? null : list.find((item) => item.id === target.anchorTabId) || null;
      const wantIndex = anchor ? finalIndexForInsertBefore(current.index, anchor.index) : -1;

      if (wantIndex !== -1 && wantIndex !== current.index) {
        await ops.move(id, { index: wantIndex });
      } else if (wantIndex === -1 && current.index !== list.length - 1) {
        await ops.move(id, { index: -1 });
      }

      tab = await safeGet(id);
      if (!tab) break;
      // The index may still differ (Chrome clamps into the pinned/unpinned
      // region); membership is what we verify.
      if (tab.groupId === wantGroup && tab.pinned === target.pinned) break;
    }
  }

  if (sourceWindowId !== targetWindowId) {
    await ops.updateWindow(targetWindowId, { focused: true });
  }
  ops.resync();
}

/**
 * Move a whole group (spec.md Appendix A.2 `performGroupDrop`).
 *
 * @param {{groupId:number, windowId:number}} payload
 * @param {{pinned:boolean, groupId:number, anchorTabId:number|null, windowId:number}} target
 */
export async function performGroupDrop(payload, target) {
  if (target.pinned) {
    toast(t('groupMoveInvalid'));
    return;
  }
  const targetWindowId = Number.isInteger(target.windowId) ? target.windowId : ops.windowId();
  const sourceWindowId = Number.isInteger(payload.windowId) ? payload.windowId : targetWindowId;
  const crossWindow = sourceWindowId !== targetWindowId;

  const list = await ops.queryTabs({ windowId: crossWindow ? sourceWindowId : targetWindowId });
  const first = list.find((tab) => tab.groupId === payload.groupId) || null;
  const anchorList = crossWindow ? await ops.queryTabs({ windowId: targetWindowId }) : list;
  const anchor =
    target.anchorTabId == null ? null : anchorList.find((tab) => tab.id === target.anchorTabId) || null;

  // Dropping a group onto one of its own tabs is a no-op.
  if (!crossWindow && anchor && anchor.groupId === payload.groupId) {
    ops.resync();
    return;
  }

  const index = crossWindow ? -1 : anchor && first ? finalIndexForInsertBefore(first.index, anchor.index) : -1;
  const props = crossWindow ? { windowId: targetWindowId, index: -1 } : { index };

  await ops.moveGroup(payload.groupId, props, (message) => {
    if (/middle of another group|middle of pinned tabs/.test(message)) {
      toast(t('groupMoveInvalid'));
      return true;
    }
    return false;
  });
  ops.resync();
}

/**
 * A link dropped from outside the panel opens as a background tab at the drop
 * position (spec.md §9.2).
 *
 * @param {string} url
 * @param {{pinned:boolean, groupId:number, anchorTabId:number|null, windowId:number}} target
 */
export async function performExternalDrop(url, target) {
  if (!EXTERNAL_SCHEMES.test(url)) return;
  const targetWindowId = Number.isInteger(target.windowId) ? target.windowId : ops.windowId();
  const list = await ops.queryTabs({ windowId: targetWindowId });
  const anchor =
    target.anchorTabId == null ? null : list.find((tab) => tab.id === target.anchorTabId) || null;

  /** @type {chrome.tabs.CreateProperties} */
  const props = { url, windowId: targetWindowId, active: false };
  if (anchor) props.index = anchor.index;

  const created = await ops.create(props);
  const newId = created && Number.isInteger(created.id) ? created.id : null;
  if (newId == null) return;

  if (target.pinned) {
    await ops.update(newId, { pinned: true });
  } else if (target.groupId !== NONE) {
    await ops.group({ tabIds: [newId], groupId: target.groupId });
  }
  ops.resync();
}
