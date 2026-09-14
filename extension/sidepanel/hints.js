/**
 * One-time hints and the two warning banners (spec.md §9.7, spec-addendum A7e).
 *
 *  - **Side position** — Chrome, not the extension, decides which edge the side
 *    panel lives on. When `sidePanel.getLayout()` reports `left`, a dismissible
 *    hint explains where to change it. `data-side` on `<html>` mirrors the side
 *    for CSS (the drawer slides in from the correct edge).
 *  - **Policy banner** — shown while the service worker reports
 *    `policyDisabledUntil > now` (a managed policy disables screenshots).
 *  - **Site-access banner** — shown when Chrome withholds `<all_urls>` from the
 *    extension, which silently disables every preview (A7).
 *
 * DOM touched: `#hint-banner`, `#hint-open-settings`, `#hint-dismiss`,
 * `#policy-banner`, `#host-access-banner`, `#host-access-open`,
 * `#host-access-dismiss`, `document.documentElement[data-side]`.
 */

import * as log from '../common/log.js';
import { loadHints, saveHints } from '../common/settings.js';
import { CHROME_APPEARANCE_URL, extensionDetailsUrl } from '../common/constants.js';
import * as ops from './tab-ops.js';
import { t, toast } from './toast.js';

const MSG = ops.MSG;

/* ── state ────────────────────────────────────────────────────────────────── */

/** @type {any} */
let ctx = null;
/** @type {'left'|'right'|'unknown'} */
let side = 'unknown';
/** @type {number} */
let policyDisabledUntil = 0;
/** @type {number} */
let policyTimer = 0;
/** @type {boolean|null} */
let hostAccess = null;
/** @type {boolean} */
let sawNoAccessFailure = false;
/** @type {number} */
let siteAccessDismissedAt = 0;
/** @type {boolean} */
let sidePositionDismissed = false;
let bound = false;

/* ── init ─────────────────────────────────────────────────────────────────── */

/**
 * @param {any} context panel context (see `tab-ops.js`)
 */
export function init(context) {
  ctx = ops.init(context) || context || null;

  if (!bound) {
    bound = true;
    on('hint-open-settings', 'click', () => {
      void ops.openUrl(CHROME_APPEARANCE_URL);
    });
    on('hint-dismiss', 'click', () => {
      void dismissSidePositionHint();
    });
    on('host-access-open', 'click', () => {
      let url = 'chrome://extensions/';
      try {
        url = extensionDetailsUrl(chrome.runtime.id);
      } catch (e) {
        log.warn('extensionDetailsUrl', e);
      }
      void ops.openUrl(url);
    });
    on('host-access-dismiss', 'click', () => {
      void dismissSiteAccessBanner();
    });

    // Own listener so the banners work even before `sidepanel.js` routes
    // messages; duplicate handling is harmless (both paths are idempotent).
    try {
      chrome.runtime.onMessage.addListener(onRuntimeMessage);
    } catch (e) {
      log.warn('hints onMessage', e);
    }
  }

  if (ctx && typeof ctx.hostAccess === 'boolean') hostAccess = ctx.hostAccess;
  if (ctx && Number.isFinite(ctx.policyDisabledUntil)) policyDisabledUntil = Number(ctx.policyDisabledUntil);

  void loadHints()
    .then((hints) => {
      sidePositionDismissed = hints.sidePositionHintDismissed === true;
      siteAccessDismissedAt = Number(hints.siteAccessBannerDismissedAt) || 0;
      renderSidePositionHint();
      renderHostAccessBanner();
    })
    .catch((e) => log.warn('hints load', e));

  renderPolicyBanner();
  renderHostAccessBanner();
}

/**
 * @param {string} id
 * @param {string} type
 * @param {(event: Event) => void} handler
 */
function on(id, type, handler) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(type, handler);
}

/**
 * @param {any} message
 */
function onRuntimeMessage(message) {
  if (!message || typeof message.type !== 'string') return undefined;
  if (message.type === MSG.POLICY_CHANGED) {
    applyPolicy(message.disabledUntil);
  } else if (message.type === MSG.HOST_ACCESS) {
    applyHostAccess(message);
  } else if (message.type === MSG.THUMB_FAILED && message.reason === 'no-host-access') {
    noteHostAccessFailure(message);
  }
  return undefined;
}

/* ── side position ────────────────────────────────────────────────────────── */

/**
 * Read the panel's side (Chrome 140+) and show the hint when it is docked on
 * the left. `getLayout()` takes **no arguments** (verified by the probe).
 * @returns {Promise<'left'|'right'|'unknown'>}
 */
export async function checkSidePosition() {
  side = 'unknown';
  try {
    if (chrome.sidePanel && typeof chrome.sidePanel.getLayout === 'function') {
      const layout = await chrome.sidePanel.getLayout();
      if (layout && (layout.side === 'left' || layout.side === 'right')) side = layout.side;
    }
  } catch (e) {
    log.warn('sidePanel.getLayout', e);
    side = 'unknown';
  }
  try {
    document.documentElement.setAttribute('data-side', side);
  } catch (e) {
    log.warn('data-side', e);
  }
  const m = ops.model();
  if (m) m.side = side;
  renderSidePositionHint();
  return side;
}

/** @returns {'left'|'right'|'unknown'} */
export function getSide() {
  return side;
}

function renderSidePositionHint() {
  const banner = document.getElementById('hint-banner');
  if (!banner) return;
  banner.hidden = !(side === 'left' && !sidePositionDismissed);
}

/** Remember the dismissal in `chrome.storage.local.hints` and hide the banner. */
export async function dismissSidePositionHint() {
  sidePositionDismissed = true;
  renderSidePositionHint();
  try {
    await saveHints({ sidePositionHintDismissed: true });
  } catch (e) {
    log.warn('dismissSidePositionHint', e);
  }
}

/* ── policy banner ────────────────────────────────────────────────────────── */

/**
 * @param {number|undefined|null} disabledUntil ms since epoch
 */
export function applyPolicy(disabledUntil) {
  policyDisabledUntil = Number.isFinite(Number(disabledUntil)) ? Number(disabledUntil) : 0;
  renderPolicyBanner();
}

/** @returns {boolean} */
export function isPolicyActive() {
  return policyDisabledUntil > Date.now();
}

/** @returns {number} */
export function getPolicyDisabledUntil() {
  return policyDisabledUntil;
}

function renderPolicyBanner() {
  const banner = document.getElementById('policy-banner');
  if (policyTimer) {
    clearTimeout(policyTimer);
    policyTimer = 0;
  }
  const active = isPolicyActive();
  if (banner) banner.hidden = !active;
  if (!active) return;
  // Auto-hide the moment the backoff expires (capped so a bogus far-future
  // value cannot schedule a timer beyond the 32-bit setTimeout limit).
  const wait = Math.min(policyDisabledUntil - Date.now() + 250, 10 * 60000);
  policyTimer = setTimeout(() => {
    policyTimer = 0;
    renderPolicyBanner();
    ops.rerender();
  }, Math.max(250, wait));
}

/* ── site-access banner (spec-addendum A7) ────────────────────────────────── */

/**
 * Handle a `vt/host-access` broadcast, or the `hostAccess` field of the
 * `vt/panel-ready` response.
 * @param {{ hostAccess?: boolean, origin?: string|null }} info
 */
export function applyHostAccess(info) {
  if (!info || typeof info.hostAccess !== 'boolean') return;
  const changed = hostAccess !== null && hostAccess !== info.hostAccess;
  hostAccess = info.hostAccess;
  if (hostAccess === true) sawNoAccessFailure = false;
  if (changed) {
    // A7e: a flip clears the dismissal, so a later withdrawal re-shows it.
    siteAccessDismissedAt = 0;
    void saveHints({ siteAccessBannerDismissedAt: 0 }).catch((e) => log.warn('hints clear dismiss', e));
  }
  renderHostAccessBanner();
  ops.rerender();
}

/**
 * A `vt/thumb-failed { reason: 'no-host-access' }` for this window is enough to
 * show the banner even when `permissions.contains()` still reports `true`
 * (enterprise `runtime_blocked_hosts`).
 * @param {{ windowId?: number }} [message]
 */
export function noteHostAccessFailure(message) {
  if (message && Number.isInteger(message.windowId) && message.windowId !== ops.windowId()) return;
  sawNoAccessFailure = true;
  renderHostAccessBanner();
}

/** @returns {boolean} `false` only when Chrome is known to withhold host access */
export function getHostAccess() {
  return hostAccess !== false;
}

function renderHostAccessBanner() {
  const banner = document.getElementById('host-access-banner');
  if (!banner) return;
  const dismissed = siteAccessDismissedAt > 0;
  banner.hidden = !((hostAccess === false || sawNoAccessFailure) && !dismissed);
}

/** Hide the site-access banner until the access state changes again. */
export async function dismissSiteAccessBanner() {
  siteAccessDismissedAt = Date.now();
  renderHostAccessBanner();
  try {
    await saveHints({ siteAccessBannerDismissedAt: siteAccessDismissedAt });
  } catch (e) {
    log.warn('dismissSiteAccessBanner', e);
  }
}

/* ── panel-ready hand-off ─────────────────────────────────────────────────── */

/**
 * Apply everything the `vt/panel-ready` response carries in one call.
 * @param {{ policyDisabledUntil?: number, hostAccess?: boolean }|null} ready
 */
export function applyPanelReady(ready) {
  if (!ready) return;
  if ('policyDisabledUntil' in ready) applyPolicy(ready.policyDisabledUntil);
  if (typeof ready.hostAccess === 'boolean') {
    hostAccess = ready.hostAccess;
    if (hostAccess === true) sawNoAccessFailure = false;
    renderHostAccessBanner();
  }
}

/**
 * Show the "open this address manually" toast. Exported because the welcome
 * page and the settings drawer share the same fallback wording.
 * @param {string} url
 */
export function showOpenUrlManually(url) {
  toast(t('openUrlManually', [String(url)]), { duration: 6000 });
}
