/**
 * background/handlers.js — request/response handlers for chrome.runtime.onMessage.
 *
 * Protocol: spec §6.1 (panel → service worker), amended by A7 (`hostAccess` in the
 * `vt/panel-ready` response) and A12 (`before-switch` capture requests).
 *
 * Every handler resolves with a JSON-serialisable object; `service-worker.js` turns a
 * rejection into `{ ok:false, error }` so a panel promise never hangs.
 */

import * as messagesMod from '../common/messages.js';
import * as logMod from '../common/log.js';
import { clearAll } from '../common/thumb-store.js';
import * as capture from './capture.js';
import * as panels from './panels.js';
import * as diag from './diagnostics.js';

const log = {
  warn: typeof logMod.warn === 'function' ? logMod.warn : (...a) => console.warn('[vt]', ...a),
};

const MSG = messagesMod.MSG ?? {};
const broadcast =
  typeof messagesMod.broadcast === 'function'
    ? messagesMod.broadcast
    : (message) => {
        try {
          const p = chrome.runtime.sendMessage(message);
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch {
          /* no receiver */
        }
      };

/** Wire strings are authoritative (spec §6); MSG only supplies nicer names. */
const TYPE = {
  PANEL_READY: MSG.PANEL_READY ?? 'vt/panel-ready',
  PANEL_CLOSING: MSG.PANEL_CLOSING ?? 'vt/panel-closing',
  CAPTURE_REQUEST: MSG.CAPTURE_REQUEST ?? 'vt/capture-request',
  CLEAR_THUMBS: MSG.CLEAR_THUMBS ?? 'vt/clear-thumbs',
  GET_DIAGNOSTICS: MSG.GET_DIAGNOSTICS ?? 'vt/get-diagnostics',
  THUMBS_CLEARED: MSG.THUMBS_CLEARED ?? 'vt/thumbs-cleared',
};

function version() {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return '0.0.0';
  }
}

async function onPanelReady(msg) {
  const windowId = Number.isInteger(msg?.windowId) ? msg.windowId : null;
  if (windowId != null) {
    panels.markOpen(windowId);
    capture.noteFocusedWindow(windowId); // A3.5: keeps the search-tabs command aimed correctly
  }
  await capture.hydrate();
  const hostAccess = await capture.refreshHostAccess(); // A7d: detection at rest
  if (windowId != null) {
    // Fire and forget: the response must not wait for a capture.
    void capture.scheduleActiveOfWindow(windowId, 'panel-opened');
  }
  return {
    ok: true,
    version: version(),
    policyDisabledUntil: capture.getPolicyDisabledUntil(),
    fileAccess: capture.getFileAccess(),
    hostAccess,
  };
}

async function onPanelClosing(msg) {
  if (Number.isInteger(msg?.windowId)) panels.markClosed(msg.windowId);
  return { ok: true };
}

async function onCaptureRequest(msg) {
  return capture.requestCapture({
    windowId: msg?.windowId,
    tabId: msg?.tabId,
    reason: msg?.reason ?? 'visible-missing',
  });
}

async function onClearThumbs() {
  try {
    await clearAll();
  } catch (e) {
    log.warn('handlers: clearAll failed', e);
    return { ok: false, error: String(e?.message ?? e) };
  }
  broadcast({ type: TYPE.THUMBS_CLEARED });
  return { ok: true };
}

async function onGetDiagnostics() {
  await capture.hydrate();
  const [alarms, openPanels] = await Promise.all([
    chrome.alarms.getAll().catch(() => []),
    panels.openWindowIds(),
  ]);
  const queue = capture.getQueueState();
  const counters = diag.snapshot();
  return {
    ok: true,
    version: version(),
    queueLength: queue.queueLength,
    pendingWindows: queue.pendingWindows,
    lastCallAt: queue.lastCallAt,
    lastCallByWindow: queue.lastCallByWindow,
    captures: counters.captures,
    // Also exposed at the top level: the addendum references both
    // `diagnostics.captures.byReason.…` (A23) and `diagnostics.byReason.…` (A26).
    byReason: counters.captures.byReason,
    lastError: counters.lastError,
    alarms: (alarms ?? []).map((a) => ({ name: a.name, periodInMinutes: a.periodInMinutes })),
    openPanels,
    hostAccess: capture.getHostAccess(),
    fileAccess: capture.getFileAccess(),
    policyDisabledUntil: capture.getPolicyDisabledUntil(),
  };
}

/**
 * @param {any} msg
 * @param {chrome.runtime.MessageSender} _sender  already checked against runtime.id
 * @returns {Promise<object>}
 */
export async function handleMessage(msg, _sender) {
  switch (msg?.type) {
    case TYPE.PANEL_READY:
      return onPanelReady(msg);
    case TYPE.PANEL_CLOSING:
      return onPanelClosing(msg);
    case TYPE.CAPTURE_REQUEST:
      return onCaptureRequest(msg);
    case TYPE.CLEAR_THUMBS:
      return onClearThumbs();
    case TYPE.GET_DIAGNOSTICS:
      return onGetDiagnostics();
    default:
      return { ok: false, error: 'unknown-message', type: msg?.type ?? null };
  }
}
