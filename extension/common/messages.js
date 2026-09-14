/**
 * The `chrome.runtime.sendMessage` protocol between the side panels and the
 * service worker (spec.md §6, spec-addendum A7h, A12).
 *
 * Every message is `{ type, ...payload }` and JSON-only. The service worker
 * ignores messages whose `sender.id !== chrome.runtime.id`; panels ignore
 * broadcasts carrying a `windowId` for a different window (thumbnail broadcasts
 * are keyed by `urlKey` and apply to every window).
 *
 * No `runtime.connect` ports: a port goes stale across service-worker restarts
 * and holding one open does not keep the worker alive (Chrome 114+).
 */

import * as log from './log.js';

/** Message types. Panel → SW are requests; SW → panels are broadcasts. */
export const MSG = Object.freeze({
  // panel → service worker (request/response)
  PANEL_READY: 'vt/panel-ready',
  PANEL_CLOSING: 'vt/panel-closing',
  CAPTURE_REQUEST: 'vt/capture-request',
  CLEAR_THUMBS: 'vt/clear-thumbs',
  GET_DIAGNOSTICS: 'vt/get-diagnostics',

  // service worker → panels (broadcast, no response)
  THUMB_UPDATED: 'vt/thumb-updated',
  THUMB_FAILED: 'vt/thumb-failed',
  THUMBS_CLEARED: 'vt/thumbs-cleared',
  POLICY_CHANGED: 'vt/policy-changed',
  HOST_ACCESS: 'vt/host-access',
});

/** Why a capture was scheduled (`DELAY_MS` is keyed by these). */
export const CAPTURE_REASON = Object.freeze({
  ACTIVATED: 'activated',
  COMPLETE: 'complete',
  URL: 'url',
  REPLACED: 'replaced',
  FOCUS: 'focus',
  PANEL_OPENED: 'panel-opened',
  STARTUP: 'startup',
  REFRESH: 'refresh',
  MANUAL_REFRESH: 'manual-refresh',
  BEFORE_SWITCH: 'before-switch',
  VISIBLE_MISSING: 'visible-missing',
  RETRY: 'retry',
  UNIFORM_RECHECK: 'uniform-recheck',
  PERMISSIONS: 'permissions',
});

/**
 * `vt/thumb-failed` reasons (spec.md §6.2 + spec-addendum A7, A10). `gone` is
 * never broadcast — it is a silent drop.
 */
export const FAIL_REASON = Object.freeze({
  RESTRICTED: 'restricted',
  POLICY: 'policy',
  NO_HOST_ACCESS: 'no-host-access',
  EXCLUDED: 'excluded',
  QUOTA: 'quota',
  READBACK: 'readback',
  TIMEOUT: 'timeout',
  UNKNOWN: 'unknown',
  NOT_ACTIVE: 'not-active',
  MINIMIZED: 'minimized',
  DISCARDED: 'discarded',
});

/**
 * Fire-and-forget message to every listening context. Rejects with
 * "Receiving end does not exist" whenever no panel is open, which is the normal
 * case — the rejection is swallowed on purpose.
 *
 * @param {{type: string} & Record<string, unknown>} message
 * @returns {Promise<void>} never rejects
 */
export function broadcast(message) {
  try {
    const sent = chrome.runtime.sendMessage(message);
    return sent && typeof sent.then === 'function'
      ? sent.then(
          () => undefined,
          () => undefined,
        )
      : Promise.resolve();
  } catch (e) {
    log.debug('broadcast failed', e);
    return Promise.resolve();
  }
}

/**
 * Request/response call. Rejects when no receiver is listening (the service
 * worker is always a receiver, so this only happens while it is starting) —
 * callers decide whether to retry or degrade.
 *
 * @param {{type: string} & Record<string, unknown>} message
 * @returns {Promise<any>}
 */
export function request(message) {
  return chrome.runtime.sendMessage(message);
}

/**
 * True when a broadcast is addressed to this window: messages without a
 * `windowId` are global (thumbnail updates apply to every panel).
 * @param {{windowId?: unknown}} message
 * @param {number} windowId
 * @returns {boolean}
 */
export function isForWindow(message, windowId) {
  if (!message || message.windowId === undefined || message.windowId === null) return true;
  return message.windowId === windowId;
}
