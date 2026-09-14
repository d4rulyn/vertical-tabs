/**
 * background/panels.js — which windows currently have our side panel open.
 *
 * Spec §7.9. Sources, in order of precision:
 *   1. chrome.sidePanel.onOpened / onClosed  (Chrome 141 / 142+, feature-detected)
 *   2. `vt/panel-ready` / `vt/panel-closing` messages from the panel document
 *   3. chrome.windows.onRemoved
 *   4. chrome.runtime.getContexts({contextTypes:['SIDE_PANEL']}) — coarse "some panel
 *      is open somewhere", because side-panel contexts report windowId -1
 *      (crbug 40925107, confirmed by the probe).
 *
 * No runtime ports: they go stale across service-worker restarts and opening one does
 * not keep the worker alive (Chrome 114+).
 *
 * State lives in memory and is mirrored to chrome.storage.session.openPanels, which is
 * cleared on browser restart, so a window id can never go stale. Because the mirror is a
 * whole-key replace, every mutation and every read is sequenced behind hydrate() — see
 * `opChain` below; on MV3 the first event of a worker generation is the normal case.
 */

import * as logMod from '../common/log.js';

const log = {
  warn: typeof logMod.warn === 'function' ? logMod.warn : (...a) => console.warn('[vt]', ...a),
};

const SESSION_KEY = 'openPanels';

/** @type {Set<number>} */
const open = new Set();
let hydratePromise = null;

/**
 * The tail of the mutation queue. MV3 restarts the worker for every event, so the FIRST
 * markOpen/markClosed of a worker generation normally arrives while `open` is still
 * empty and hydrate()'s storage.session.get() is still in flight. Mutating and
 * persisting there is destructive, because persist() is a whole-key replace:
 *   - markOpen wrote a ONE-element array and dropped every other window (measured 1/20
 *     cold wakes on Chromium 151), so after the next restart those windows stopped
 *     getting previews and were skipped by the refresh alarm;
 *   - markClosed found nothing to delete, took its early exit and never persisted
 *     (measured 6/20), leaving a panel that had just closed recorded as open for the
 *     rest of the browser session — and `captureWhenPanelClosed:false` then kept
 *     screenshotting that window, which is exactly what the setting promises not to do.
 * Every mutation therefore runs behind hydrate() and behind the mutation before it, so
 * the Set it edits is always the restored one and the writes land in issue order.
 */
let opChain = null;

/** Queues `fn` after hydration and after every mutation already queued. */
function runQueued(fn) {
  const next = (opChain ?? hydrate()).then(fn).catch((e) => log.warn('panels: update failed', e));
  opChain = next;
  return next;
}

/** Resolves once hydration and every mutation queued so far have been applied. */
function settled() {
  return opChain ?? hydrate();
}

/** True when Chrome gives us precise open/close events for the side panel. */
export function hasPreciseTracking() {
  return typeof chrome.sidePanel?.onClosed?.addListener === 'function';
}

export function hydrate() {
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    try {
      const got = await chrome.storage.session.get(SESSION_KEY);
      const saved = got?.[SESSION_KEY];
      if (Array.isArray(saved)) for (const id of saved) if (Number.isInteger(id)) open.add(id);
    } catch {
      /* ignore — an empty set only means "assume closed" for captureWhenPanelClosed */
    }
  })().catch(() => {});
  return hydratePromise;
}

async function persist() {
  try {
    await chrome.storage.session.set({ [SESSION_KEY]: [...open] });
  } catch (e) {
    log.warn('panels: persist failed', e);
  }
}

/**
 * Marks the panel of `windowId` as open. Idempotent.
 * Returns a promise that resolves once the change has been persisted; callers that
 * only fire and forget stay correct, because the reads below wait for the queue.
 */
export function markOpen(windowId) {
  if (!Number.isInteger(windowId) || windowId < 0) return Promise.resolve();
  return runQueued(async () => {
    if (open.has(windowId)) return;
    open.add(windowId);
    await persist();
  });
}

/** Marks the panel of `windowId` as closed. Idempotent. Same contract as markOpen. */
export function markClosed(windowId) {
  if (!Number.isInteger(windowId)) return Promise.resolve();
  return runQueued(async () => {
    if (!open.delete(windowId)) return;
    await persist();
  });
}

/** Window ids whose panel is known to be open (best effort). */
export async function openWindowIds() {
  await settled();
  return [...open];
}

/**
 * Best-effort "is our panel open in this window?".
 * On Chrome < 142 (no onClosed) this degrades to "is any panel open anywhere?",
 * which is documented as a known limitation (§15).
 */
export async function isPanelOpen(windowId) {
  await settled(); // a markClosed issued before this call must already have been applied
  if (open.has(windowId)) return true;
  if (hasPreciseTracking()) return false;
  if (typeof chrome.runtime.getContexts !== 'function') return false;
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] });
    return Array.isArray(contexts) && contexts.length > 0;
  } catch (e) {
    log.warn('panels: getContexts failed', e);
    return false;
  }
}
