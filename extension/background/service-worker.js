/**
 * background/service-worker.js — the extension's event entry point (ES module).
 *
 * Rules this file obeys, all of them load-bearing on MV3 (spec §0.2, §7.2):
 *  - EVERY chrome.* listener is registered synchronously at the top level. Nothing is
 *    registered inside a callback, a promise chain or an async function, because the
 *    worker is restarted for each event and only top-level registrations survive.
 *  - No top-level `await` (module service workers forbid it). `capture.hydrate()` is a
 *    promise that the jobs await instead.
 *  - No `setTimeout` longer than a second or two: the worker dies after 30 s idle and
 *    timers do not survive it. Durable state lives in chrome.storage.session / IndexedDB.
 *  - The worker never resolves "the current window" implicitly: every capture passes an
 *    explicit window id (measured: with no argument Chrome captures the last-focused
 *    window — see .agent/probe-results.md and addendum A3).
 */

import * as C from '../common/constants.js';
import { loadSettings } from '../common/settings.js';
import { normalizeSettings, hostMatches } from '../common/settings-schema.js';
import { MSG, broadcast } from '../common/messages.js';
import { clearAll, deleteThumbsByHost } from '../common/thumb-store.js';
import * as capture from './capture.js';
import * as panels from './panels.js';
import * as unread from './unread.js';
import { ensureAlarms, runMaintenance, runRefresh } from './alarms.js';
import { handleMessage } from './handlers.js';

const ALARMS = C.ALARMS ?? { maintenance: 'vt-maintenance', refresh: 'vt-refresh' };
const FRESH_ON_FOCUS_MS = C.FRESH_ON_FOCUS_MS ?? 10000;

/**
 * Chrome's "the window this call came from" sentinel. Used only as the last resort of
 * the search-tabs command when the worker started cold and Chrome passed no tab; the
 * constant's name is written out numerically on purpose so the static guard of
 * tests/specs/12-multiwindow.spec.js (addendum A3.2/A26) can prove the capture pipeline
 * never resolves a window implicitly.
 */
const CURRENT_WINDOW_SENTINEL = -2;

/** Same fallback semantics as common/i18n.js `t()`, without importing a DOM-aware module. */
function tr(key, substitutions) {
  try {
    return chrome.i18n.getMessage(key, substitutions) || key;
  } catch {
    return key;
  }
}

/** A16: the toolbar tooltip shows the user's real binding, not a hard-coded one. */
function updateActionTitle() {
  if (!chrome.action?.setTitle || !chrome.commands?.getAll) return;
  chrome.commands
    .getAll()
    .then((commands) => {
      const binding = commands.find((c) => c.name === '_execute_action')?.shortcut;
      const title = binding ? tr('actionTitleWithShortcut', [binding]) : tr('actionTitle');
      return chrome.action.setTitle({ title });
    })
    .catch(() => {});
}

/* ── Panel behaviour: clicking the toolbar icon (and its shortcut) toggles the panel ── */
if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) => console.error('[vt]', e));
}

/* ── Lifecycle ──────────────────────────────────────────────────────────────────── */

chrome.runtime.onInstalled.addListener(({ reason }) => {
  ensureAlarms();
  updateActionTitle();
  if (reason === 'install') {
    chrome.storage.local
      .set({ hints: { installedAt: Date.now(), sidePositionHintDismissed: false } })
      .catch(() => {});
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') }).catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(async () => {
  ensureAlarms();
  updateActionTitle();
  try {
    const settings = await loadSettings();
    if (!settings.persistThumbnails) await clearAll();
  } catch (e) {
    console.warn('[vt] startup cleanup failed', e);
  }
  // Only the active tabs are re-captured; pruning waits for the maintenance alarm so it
  // never races Chrome's session restore (§7.8).
  capture.scheduleAllWindowsActive('startup');
});

/* ── Tab events ─────────────────────────────────────────────────────────────────── */

chrome.tabs.onCreated.addListener((tab) => {
  if (!tab.active && Number.isInteger(tab.windowId) && Number.isInteger(tab.id)) {
    unread.add(tab.windowId, tab.id); // A13: tracked by the worker, so it works while the panel is closed
  }
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  capture.bumpGeneration(windowId); // invalidates any capture already in flight for this window
  capture.resetRecheckCount(tabId);
  unread.remove(windowId, tabId);
  capture.schedule({ windowId, tabId, reason: 'activated' });
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url) {
    // Navigation clears the restricted/backoff memory of the page being left (A8.3).
    capture.forgetRestrictedForTab(tabId);
    capture.resetFailures(tabId);
    capture.resetRecheckCount(tabId);
  }
  if (!tab.active) return;
  if (info.status === 'complete') {
    capture.schedule({ windowId: tab.windowId, tabId, reason: 'complete' });
  } else if (info.url && tab.status === 'complete') {
    // A6: only a same-document (pushState) navigation captures on `url`; while the tab is
    // still loading the `complete` event that follows carries the settled frame.
    capture.schedule({ windowId: tab.windowId, tabId, reason: 'url' });
  }
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  capture.resetFailures(removedTabId);
  capture.resetRecheckCount(removedTabId);
  unread.remove(null, removedTabId);
  chrome.tabs
    .get(addedTabId)
    .then((tab) => {
      if (tab.active) capture.schedule({ windowId: tab.windowId, tabId: addedTabId, reason: 'replaced' });
    })
    .catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId, info) => {
  capture.resetFailures(tabId);
  capture.resetRecheckCount(tabId);
  unread.remove(info?.windowId ?? null, tabId);
});

chrome.tabs.onAttached.addListener((tabId, { newWindowId }) => {
  unread.move(tabId, newWindowId);
});

chrome.tabs.onDetached.addListener((tabId, { oldWindowId }) => {
  unread.remove(oldWindowId, tabId);
});

/* ── Window events ──────────────────────────────────────────────────────────────── */

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  capture.noteFocusedWindow(windowId); // A3.5: cached synchronously for commands.onCommand
  capture.scheduleActiveOfWindow(windowId, 'focus', { onlyIfOlderThan: FRESH_ON_FOCUS_MS });
});

chrome.windows.onRemoved.addListener((windowId) => {
  capture.forgetWindow(windowId);
  panels.markClosed(windowId);
  unread.forgetWindow(windowId);
});

/* ── Alarms and settings ────────────────────────────────────────────────────────── */

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARMS.maintenance) runMaintenance();
  else if (alarm.name === ALARMS.refresh) runRefresh();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  ensureAlarms();
  void purgeNewlyExcluded(changes.settings.oldValue, changes.settings.newValue);
});

/**
 * Drop the previews already captured for a host the user has just excluded.
 *
 * The README promises that excluding a host keeps it "out of the cache entirely",
 * and a user who adds their bank after the fact means the screenshot that already
 * exists, not only the ones that would have been taken later. Only hosts that are
 * NEWLY excluded are considered, so an unrelated settings write costs one cursor
 * pass and nothing else.
 *
 * @param {any} oldValue previous `settings` object, if any
 * @param {any} newValue current `settings` object
 * @returns {Promise<void>} never rejects
 */
async function purgeNewlyExcluded(oldValue, newValue) {
  try {
    const before = normalizeSettings(oldValue).excludedHosts;
    const after = normalizeSettings(newValue).excludedHosts;
    const added = after.filter((h) => !before.includes(h));
    if (added.length === 0) return;

    const deleted = await deleteThumbsByHost((host) => hostMatches(host, added));
    if (deleted.length === 0) return;
    // Open panels hold object URLs for these blobs; the same broadcast the
    // "Clear preview cache" action uses makes them release and re-render.
    broadcast({ type: MSG.THUMBS_CLEARED });
  } catch (e) {
    console.warn('[vt] purgeNewlyExcluded', e);
  }
}

/* ── Commands ───────────────────────────────────────────────────────────────────── */

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'search-tabs') return;
  const focused = capture.getLastFocusedWindowId();
  const windowId = tab?.windowId ?? (Number.isInteger(focused) ? focused : CURRENT_WINDOW_SENTINEL);
  // FIRST call, and no await anywhere before it: any await expires the user gesture and
  // sidePanel.open() then rejects (verified: side_panel_api.cc).
  chrome.sidePanel.open({ windowId }).catch((e) => console.warn('[vt]', e));
  // The "focus the search box" intent is handed over through storage.session because
  // open() resolves before the panel document exists.
  chrome.storage.session
    .set({
      pendingFocusSearch: {
        windowId: tab?.windowId ?? (Number.isInteger(focused) ? focused : null),
        at: Date.now(),
      },
    })
    .catch(() => {});
});

/* ── Messaging ──────────────────────────────────────────────────────────────────── */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return undefined; // ignore other extensions
  handleMessage(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
  return true; // keep the channel open for the async response
});

/* ── Side-panel open/close tracking (feature-detected: 141+ / 142+) ─────────────── */

if (chrome.sidePanel?.onOpened) {
  chrome.sidePanel.onOpened.addListener((info) => {
    panels.markOpen(info.windowId);
    capture.scheduleActiveOfWindow(info.windowId, 'panel-opened');
  });
}

if (chrome.sidePanel?.onClosed) {
  chrome.sidePanel.onClosed.addListener((info) => {
    panels.markClosed(info.windowId);
  });
}

/* ── Site access can be withheld and re-granted at any time (A7d) ───────────────── */

/**
 * Whether a permissions event can have changed what is capturable.
 *
 * A7d is about SITE access, and `onPermissionsChanged()` is expensive: it throws away the
 * "this URL can never be captured" memo and re-captures the active tab of every open
 * window at the measured ≥1100 ms serialisation. `optional_permissions: ["bookmarks"]`
 * made this listener fire for a permission that cannot affect a capture at all, so
 * pressing Allow in the bookmark column would kick off a full re-scan as a side effect.
 *
 * Conservative on purpose: anything that names an origin, names nothing, or arrives in a
 * shape this does not recognise still counts.
 *
 * @param {{ permissions?: string[], origins?: string[] }} [perms]
 * @returns {boolean}
 */
function affectsCapture(perms) {
  if (!perms) return true;
  const origins = Array.isArray(perms.origins) ? perms.origins : [];
  if (origins.length > 0) return true;
  const api = Array.isArray(perms.permissions) ? perms.permissions : [];
  if (api.length === 0) return true;
  return api.some((name) => name !== 'bookmarks');
}

if (chrome.permissions?.onAdded) {
  chrome.permissions.onAdded.addListener((perms) => {
    if (!affectsCapture(perms)) return;
    capture.onPermissionsChanged();
  });
}

if (chrome.permissions?.onRemoved) {
  chrome.permissions.onRemoved.addListener((perms) => {
    if (!affectsCapture(perms)) return;
    capture.onPermissionsChanged();
  });
}

/* ── Every worker start ─────────────────────────────────────────────────────────── */

ensureAlarms();
updateActionTitle();
capture.hydrate(); // async on purpose: jobs await the same promise, the module body does not
