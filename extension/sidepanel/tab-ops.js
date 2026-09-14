/**
 * `chrome.tabs` / `chrome.tabGroups` / `chrome.windows` wrappers with retry,
 * toast and resync (spec.md §8.1 "tab-ops.js", §9.1 last paragraph).
 *
 * Rules from the spec:
 *  - an error containing `Tabs cannot be edited right now` (a native tab drag
 *    is in progress) is retried after 300 ms, at most 3 times;
 *  - any other error is logged, shows the `operationFailed` toast and triggers
 *    `state.resync()` so the panel cannot drift from Chrome.
 *
 * This module also owns the **shared panel context** for the interaction
 * modules (`dnd`, `context-menu`, `search`, `trash`, `keyboard`,
 * `settings-view`, `hints`): whichever of them is initialised first calls
 * `init(ctx)` here, and the rest read it back through `getContext()` and the
 * small accessors below. That keeps every interaction module independent of
 * how `sidepanel.js` happens to name things.
 *
 * Expected `ctx` (every field optional except `windowId`):
 * ```js
 * {
 *   windowId,                  // number — the window this panel is scoped to
 *   state,                     // the state.js model (tabs/order/groups/…)
 *   getSettings(),             // → settings object   (falls back to state.settings)
 *   resync(),                  // → Promise           (falls back to state.resync())
 *   scheduleRender() | render(),
 *   rerenderTab(tabId),
 *   testMode, ownOrigin, fileAccess, hostAccess, policyDisabledUntil,
 * }
 * ```
 */

import * as i18n from '../common/i18n.js';
import * as log from '../common/log.js';
import * as messages from '../common/messages.js';
import { TAB_OPS_RETRY_MS, TAB_OPS_MAX_RETRIES } from '../common/constants.js';
import { toast, t } from './toast.js';
import * as locks from './locks.js';

export { t };
export { log };

/** Message types (spec.md §6). Literals so a rename in `messages.js` cannot break the wire protocol. */
export const MSG = {
  PANEL_READY: 'vt/panel-ready',
  PANEL_CLOSING: 'vt/panel-closing',
  CAPTURE_REQUEST: 'vt/capture-request',
  CLEAR_THUMBS: 'vt/clear-thumbs',
  GET_DIAGNOSTICS: 'vt/get-diagnostics',
  THUMB_UPDATED: 'vt/thumb-updated',
  THUMB_FAILED: 'vt/thumb-failed',
  THUMBS_CLEARED: 'vt/thumbs-cleared',
  POLICY_CHANGED: 'vt/policy-changed',
  HOST_ACCESS: 'vt/host-access',
  ...(messages && typeof messages.MSG === 'object' ? messages.MSG : null),
};

/** `chrome.tabGroups.TAB_GROUP_ID_NONE` (−1), feature-detected. */
export const TAB_GROUP_ID_NONE = (() => {
  try {
    if (typeof chrome !== 'undefined' && chrome.tabGroups) {
      const value = chrome.tabGroups.TAB_GROUP_ID_NONE;
      if (Number.isInteger(value)) return value;
    }
  } catch {
    /* not a Chrome context */
  }
  return -1;
})();

const DRAG_ERROR = 'Tabs cannot be edited right now';

/* ── shared context ───────────────────────────────────────────────────────── */

/** @type {any} */
let ctx = null;

/**
 * Store the panel context. Every interaction module calls this from its own
 * `init()`, so the first one wins and later calls are no-ops with the same
 * object.
 * @param {any} context
 * @returns {any} the stored context
 */
export function init(context) {
  if (context && context !== ctx) ctx = context;
  return ctx;
}

/** @returns {any} */
export function getContext() {
  return ctx;
}

/**
 * The state model. Accepts either the model object itself or a module
 * namespace that exposes it as `.state`.
 * @returns {any}
 */
export function model() {
  const s = ctx && ctx.state;
  if (!s) return null;
  if (s.tabs) return s;
  if (s.state && s.state.tabs) return s.state;
  return s;
}

/** @returns {number} the window this panel is scoped to (`-1` when unknown) */
export function windowId() {
  if (ctx && Number.isInteger(ctx.windowId)) return ctx.windowId;
  const m = model();
  if (m && Number.isInteger(m.windowId)) return m.windowId;
  return -1;
}

/** @returns {any} the current settings object (defaults are already normalised upstream) */
export function getSettings() {
  try {
    if (ctx && typeof ctx.getSettings === 'function') {
      const s = ctx.getSettings();
      if (s) return s;
    }
  } catch (e) {
    log.warn('getSettings', e);
  }
  const m = model();
  return (m && m.settings) || (ctx && ctx.settings) || {};
}

/** Ask the panel to re-read Chrome's tab/group state. Never throws. */
export function resync() {
  try {
    if (ctx && typeof ctx.resync === 'function') return ctx.resync();
    const m = model();
    if (m && typeof m.resync === 'function') return m.resync();
    if (ctx && ctx.state && typeof ctx.state.resync === 'function') return ctx.state.resync();
  } catch (e) {
    log.warn('resync', e);
  }
  return undefined;
}

/** Ask the panel to re-render. Never throws. */
export function rerender() {
  try {
    if (ctx && typeof ctx.scheduleRender === 'function') return ctx.scheduleRender();
    if (ctx && typeof ctx.render === 'function') return ctx.render();
    const m = model();
    if (m && typeof m.scheduleRender === 'function') return m.scheduleRender();
  } catch (e) {
    log.warn('rerender', e);
  }
  return undefined;
}

/**
 * The model's copy of a tab. Synchronous; use `fetchTab()` when the model may
 * not know about it yet.
 * @param {number} tabId
 * @returns {chrome.tabs.Tab|null}
 */
export function getTab(tabId) {
  const m = model();
  if (m && m.tabs && typeof m.tabs.get === 'function') {
    const tab = m.tabs.get(tabId);
    if (tab) return tab;
  }
  return null;
}

/**
 * The model's copy of a tab, falling back to `chrome.tabs.get`.
 * @param {number} tabId
 * @returns {Promise<chrome.tabs.Tab|null>}
 */
export async function fetchTab(tabId) {
  const known = getTab(tabId);
  if (known) return known;
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

/**
 * Every tab of this window, in `tab.index` order, from the model.
 * @returns {chrome.tabs.Tab[]}
 */
export function tabsInOrder() {
  const m = model();
  if (!m || !m.tabs) return [];
  /** @type {chrome.tabs.Tab[]} */
  const out = [];
  if (Array.isArray(m.order)) {
    for (const id of m.order) {
      const tab = m.tabs.get(id);
      if (tab) out.push(tab);
    }
    if (out.length > 0) return out;
  }
  for (const tab of m.tabs.values()) out.push(tab);
  out.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return out;
}

/** @returns {Map<number, chrome.tabGroups.TabGroup>} */
export function groups() {
  const m = model();
  if (m && m.groups && typeof m.groups.get === 'function') return m.groups;
  return new Map();
}

/**
 * The tab ids a command should apply to: the whole highlighted selection when
 * the target tab is part of it, otherwise just the target (spec.md §9.3).
 * @param {number} tabId
 * @returns {number[]} ascending `tab.index` order
 */
export function selectionFor(tabId) {
  const m = model();
  const highlighted = m && m.highlighted;
  if (highlighted && typeof highlighted.has === 'function' && highlighted.has(tabId) && highlighted.size > 1) {
    const ids = [...highlighted];
    ids.sort((a, b) => (getTab(a)?.index ?? 0) - (getTab(b)?.index ?? 0));
    return ids;
  }
  return [tabId];
}

/**
 * `applyI18n(root)` from `common/i18n.js`, with a local implementation as a
 * safety net so generated markup is never left blank.
 * @param {ParentNode} root
 */
export function applyI18n(root) {
  try {
    if (typeof i18n.applyI18n === 'function') {
      i18n.applyI18n(root);
      return;
    }
  } catch (e) {
    log.warn('applyI18n', e);
  }
  try {
    for (const el of root.querySelectorAll('[data-i18n]')) {
      const key = el.getAttribute('data-i18n');
      if (key) el.textContent = t(key);
    }
    for (const el of root.querySelectorAll('[data-i18n-attr]')) {
      const spec = el.getAttribute('data-i18n-attr') || '';
      for (const pair of spec.split(';')) {
        const [attr, key] = pair.split(':').map((s) => s.trim());
        if (attr && key) el.setAttribute(attr, t(key));
      }
    }
  } catch (e) {
    log.warn('applyI18n fallback', e);
  }
}

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/* ── the retrying call wrapper ────────────────────────────────────────────── */

/**
 * Run one `chrome.*` mutation with the spec's error policy.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {Object} [options]
 * @param {string} [options.label]      logged with the error
 * @param {boolean} [options.silent]    suppress the `operationFailed` toast
 * @param {boolean} [options.noResync]  suppress `state.resync()`
 * @param {(message: string) => boolean} [options.handled]
 *        return `true` to claim the error (no toast, no resync, no rethrow)
 * @returns {Promise<T|undefined>} `undefined` when `handled` claimed the error
 * @throws the original error after logging/toasting
 */
export async function call(fn, options = {}) {
  const { label = 'tab-ops', silent = false, noResync = false, handled } = options;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const message = String((error && error.message) || error || '');
      if (message.includes(DRAG_ERROR) && attempt < TAB_OPS_MAX_RETRIES) {
        await sleep(TAB_OPS_RETRY_MS);
        continue;
      }
      if (typeof handled === 'function') {
        let claimed = false;
        try {
          claimed = handled(message) === true;
        } catch (e) {
          log.warn('tab-ops handled()', e);
        }
        if (claimed) {
          if (!noResync) resync();
          return undefined;
        }
      }
      log.warn(label, message);
      if (!silent) toast(t('operationFailed'));
      if (!noResync) resync();
      try {
        /** @type {any} */ (error).vtHandled = true;
      } catch {
        /* frozen error objects are fine */
      }
      throw error;
    }
  }
}

/* ── chrome.tabs ──────────────────────────────────────────────────────────── */

/**
 * @param {number} tabId
 * @param {chrome.tabs.UpdateProperties} props
 */
export function update(tabId, props) {
  return call(() => chrome.tabs.update(tabId, props), { label: `tabs.update(${tabId})` });
}

/**
 * @param {number|number[]} tabIds
 * @param {chrome.tabs.MoveProperties} props
 */
export function move(tabIds, props) {
  return call(() => chrome.tabs.move(/** @type {any} */ (tabIds), props), { label: 'tabs.move' });
}

/**
 * Close tabs — the ONE place the panel closes anything.
 *
 * Every close in the panel funnels through here: the card's button, the context menu,
 * "close the other tabs", the duplicate finder. That is what makes a lock enforceable:
 * a locked tab is removed from the request rather than the request being refused, so
 * "close 9 tabs" with one locked closes the other eight and says what it kept.
 *
 * A lock cannot reach Chrome's own close button — see sidepanel/locks.js — and this
 * function is not where that limitation could be fixed.
 *
 * @param {number|number[]} tabIds
 */
export function remove(tabIds) {
  const wanted = Array.isArray(tabIds) ? tabIds : [tabIds];
  const { allowed, blocked } = locks.partition(wanted.filter((n) => Number.isInteger(n)));
  if (blocked.length) {
    toast(blocked.length === 1 ? t('lockedTabKept') : t('lockedTabsKept', [String(blocked.length)]));
  }
  if (!allowed.length) return Promise.resolve(undefined);
  const arg = Array.isArray(tabIds) ? allowed : allowed[0];
  return call(() => chrome.tabs.remove(/** @type {any} */ (arg)), { label: 'tabs.remove' });
}

/** @param {chrome.tabs.CreateProperties} props */
export function create(props) {
  return call(() => chrome.tabs.create(props), { label: 'tabs.create' });
}

/** @param {number} tabId */
export function reload(tabId) {
  return call(() => chrome.tabs.reload(tabId), { label: 'tabs.reload' });
}

/** @param {number} tabId */
export function duplicate(tabId) {
  return call(() => chrome.tabs.duplicate(tabId), { label: 'tabs.duplicate' });
}

/** @param {number} tabId */
export function discard(tabId) {
  return call(() => chrome.tabs.discard(tabId), { label: 'tabs.discard' });
}

/**
 * `tabs.highlight` takes **indices**, not tab ids (spec.md §9.1).
 * @param {{ windowId?: number, tabs: number[] }} info
 */
export function highlight(info) {
  return call(() => chrome.tabs.highlight(info), { label: 'tabs.highlight' });
}

/** @param {{ tabIds: number[]|number, groupId?: number, createProperties?: { windowId?: number } }} options */
export function group(options) {
  return call(() => chrome.tabs.group(options), { label: 'tabs.group' });
}

/** @param {number|number[]} tabIds */
export function ungroup(tabIds) {
  return call(() => chrome.tabs.ungroup(/** @type {any} */ (tabIds)), { label: 'tabs.ungroup' });
}

/**
 * A read, so it neither toasts nor resyncs; returns `[]` on failure.
 * @param {chrome.tabs.QueryInfo} query
 * @returns {Promise<chrome.tabs.Tab[]>}
 */
export async function queryTabs(query) {
  try {
    return await chrome.tabs.query(query);
  } catch (e) {
    log.warn('tabs.query', e);
    return [];
  }
}

/* ── chrome.tabGroups ─────────────────────────────────────────────────────── */

/**
 * @param {number} groupId
 * @param {chrome.tabGroups.UpdateProperties} props
 */
export function updateGroup(groupId, props) {
  return call(() => chrome.tabGroups.update(groupId, props), { label: 'tabGroups.update' });
}

/**
 * `tabGroups.move` throws on the two structurally impossible targets; the
 * caller maps them to the `groupMoveInvalid` toast (spec.md §9.2).
 * @param {number} groupId
 * @param {{ index: number, windowId?: number }} props
 * @param {(message: string) => boolean} [handled]
 */
export function moveGroup(groupId, props, handled) {
  return call(() => chrome.tabGroups.move(groupId, props), { label: 'tabGroups.move', handled });
}

/* ── chrome.windows ───────────────────────────────────────────────────────── */

/** @param {chrome.windows.CreateData} props */
export function createWindow(props) {
  return call(() => chrome.windows.create(props), { label: 'windows.create' });
}

/**
 * Best effort — focusing a window is never worth an error toast.
 * @param {number} id
 * @param {chrome.windows.UpdateInfo} props
 */
export async function updateWindow(id, props) {
  try {
    return await chrome.windows.update(id, props);
  } catch (e) {
    log.warn('windows.update', e);
    return undefined;
  }
}

/* ── higher-level helpers ─────────────────────────────────────────────────── */

/**
 * Send a request to the service worker. Resolves `null` when no receiver
 * answers (the SW is starting, or the message is not handled).
 * @param {any} message
 * @returns {Promise<any>}
 */
export async function request(message) {
  try {
    if (typeof messages.request === 'function') return await messages.request(message);
    return await chrome.runtime.sendMessage(message);
  } catch (e) {
    log.warn('request', message && message.type, e);
    return null;
  }
}

/**
 * Activate a tab from inside the panel (spec-addendum A12).
 *
 * The panel is the one place that knows *before* the switch which tab is being
 * left, so it asks the service worker to refresh that tab's preview while it is
 * still on screen. The request is capped at 400 ms so the click never feels
 * delayed, and the SW itself refuses when the capture limiter is busy.
 *
 * @param {number} tabId
 * @returns {Promise<unknown>}
 */
export async function activate(tabId) {
  const settings = getSettings();
  const m = model();
  const prev = m && Number.isInteger(m.activeTabId) ? m.activeTabId : null;
  // Paint the new selection now rather than when `tabs.onActivated` comes back.
  // Chrome's round trip is what made the click feel unresponsive even once the
  // switch itself was fast: the card the user just clicked stayed unhighlighted
  // for the whole of it. If the update below fails, its catch resyncs and the
  // model is corrected from Chrome, so this can only ever be briefly optimistic.
  markActiveLocally(tabId);
  if (settings.captureBeforeSwitch !== false && prev != null && prev !== tabId) {
    /* Fire and forget — deliberately NOT awaited.
     *
     * Blocking the switch on this capture is what made a card click feel slow:
     * measured click-to-switch p50 218 ms with the wait against 122 ms without it,
     * with a tail to 576 ms, and that was a warm worker in a container. Switching
     * tabs is the panel's primary job, so it does not queue behind a screenshot.
     *
     * Correctness does not depend on winning the race. `capture.js` step 3a drops a
     * job whose tab is no longer active, so a capture that arrives after the switch
     * is discarded rather than filed against the wrong tab; the outgoing card simply
     * keeps the preview it already had. When the worker is warm it usually still
     * wins, which is the freshness A12 was after.
     */
    Promise.resolve(request({
      type: MSG.CAPTURE_REQUEST,
      windowId: windowId(),
      tabId: prev,
      reason: 'before-switch',
    })).catch(() => {});
  }
  return update(tabId, { active: true });
}

/**
 * Mark `tabId` active in the local model and repaint, without waiting for Chrome.
 *
 * Mirrors what `state.js`'s `tabs.onActivated` handler does, so the confirming
 * event is a no-op rather than a second visible change.
 *
 * @param {number} tabId
 */
function markActiveLocally(tabId) {
  const m = model();
  if (!m || !m.tabs || typeof m.tabs.get !== 'function') return;
  if (!m.tabs.has(tabId)) return;
  try {
    m.activeTabId = tabId;
    if (m.unread && typeof m.unread.delete === 'function') m.unread.delete(tabId);
    for (const [id, tab] of m.tabs) {
      if (id === tabId) m.tabs.set(id, { ...tab, active: true });
      else if (tab.active) m.tabs.set(id, { ...tab, active: false });
    }
    rerender();
  } catch (e) {
    log.warn('markActiveLocally', e);
  }
}

/**
 * Open a URL Chrome may refuse to navigate to from an extension
 * (`chrome://settings/appearance`, `chrome://extensions/shortcuts`, …). On
 * rejection the address is shown in a toast so the user can paste it.
 * @param {string} url
 * @returns {Promise<boolean>} whether the tab was created
 */
export async function openUrl(url) {
  try {
    await chrome.tabs.create({ url });
    return true;
  } catch (e) {
    log.warn('openUrl', url, e);
    toast(t('openUrlManually', [String(url)]), { duration: 6000 });
    return false;
  }
}

/**
 * Tab ids sorted by their **current** `tab.index` in `windowId` — indices must
 * always come from a fresh `tabs.query`, never from the DOM (spec.md §9.2).
 * @param {number[]} tabIds
 * @param {number} [inWindow]
 * @returns {Promise<number[]>}
 */
export async function sortedByIndex(tabIds, inWindow) {
  const list = await queryTabs({ windowId: inWindow ?? windowId() });
  const index = new Map(list.map((tab) => [tab.id, tab.index]));
  return [...tabIds].sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
}

/**
 * Copy text to the clipboard, falling back to the `execCommand` textarea trick
 * when the async Clipboard API is unavailable (spec.md §9.3 `copy-url`).
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyText(text) {
  const value = String(text ?? '');
  if (value === '') return false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (e) {
    log.warn('clipboard.writeText', e);
  }
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok === true;
  } catch (e) {
    log.warn('execCommand copy', e);
    return false;
  }
}
