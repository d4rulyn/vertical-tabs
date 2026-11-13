/**
 * The "x" on a tab-group header row: closes the whole group.
 *
 * It is a third entry into a path that already exists twice — the header menu's
 * `group-close` and the card menu's `close-group` (context-menu.js). All three end in
 * `closeTabs(ids)`, which asks the confirm bar when the number of ids reaches
 * `settings.confirmCloseThreshold` and otherwise goes straight to `ops.remove` (locks,
 * the closed-tabs list and the error policy all live there). This module adds the button
 * and nothing else: it resolves the ids when the button is CLICKED, the way the card menu
 * does, so a tab that left the group since the last paint is not taken with it.
 *
 * The click is taken in the CAPTURE phase of `#tablist` and stopped there. The header
 * also owns "a click anywhere on me toggles the group" (context-menu.js
 * `onGroupHeaderClick`, bubble phase) and the list owns selection and activation
 * (sidepanel.js `onListClick`); neither may see a click that is meant to close.
 *
 * DOM touched: `.group`, `.group-header`, `.group-close`.
 */

import * as log from '../common/log.js';
import { closeTabs, tabIdsOfGroup } from './context-menu.js';

let bound = false;
/** The pointer press now in progress started on a `.group-close`. */
let pressedOnClose = false;

/** @param {any} [_context] */
export function init(_context) {
  if (bound) return;
  const tablist = document.getElementById('tablist');
  if (!tablist) return;
  bound = true;
  tablist.addEventListener('click', onClick, true);
  tablist.addEventListener('pointerdown', onPointerDown, true);
  tablist.addEventListener('pointerup', () => { pressedOnClose = false; }, true);
  tablist.addEventListener('dragstart', onDragStart, true);
}

/**
 * @param {PointerEvent} event
 */
function onPointerDown(event) {
  const el = event.target instanceof Element ? event.target : null;
  pressedOnClose = Boolean(el && el.closest('.group-close'));
}

/**
 * The header is `draggable`, and Probe 15 measured that a press on a button inside it
 * starts the header's drag all the same (also with `draggable="false"` on the button): so
 * a press on the x that wanders is a group being dragged, which is not what anyone who
 * pressed a close button meant. `dragstart` reports the header as its target, not the
 * button, hence the press is remembered. Taken in the capture phase so dnd.js, which
 * listens in the bubble phase, never sees a drag it would have to unwind.
 * @param {DragEvent} event
 */
function onDragStart(event) {
  if (!pressedOnClose) return;
  pressedOnClose = false;
  event.preventDefault();
  event.stopPropagation();
}

/**
 * @param {MouseEvent} event
 */
function onClick(event) {
  const el = event.target instanceof Element ? event.target : null;
  const button = el ? el.closest('.group-close') : null;
  if (!button) return;

  // Whatever happens next, this click is not a click on the header.
  event.preventDefault();
  event.stopPropagation();

  // The second click of a double-click is not a second request. The list reflows as soon
  // as the group is gone and the NEXT group's button slides under a pointer that has not
  // moved; closing that one too would turn a double-click into two closes. A click made
  // from the keyboard has `detail === 0`, so Enter and Space are unaffected.
  if (event.detail > 1) return;

  const section = button.closest('.group');
  const groupId = section ? Number(section.getAttribute('data-group-id')) : NaN;
  if (!Number.isInteger(groupId)) return;

  void closeGroup(groupId);
}

/**
 * @param {number} groupId
 */
async function closeGroup(groupId) {
  try {
    await closeTabs(tabIdsOfGroup(groupId));
  } catch (e) {
    // `ops.call` has already toasted and resynced; this only keeps the rejection from
    // surfacing as an unhandled one.
    log.warn('group close', e);
  }
}
