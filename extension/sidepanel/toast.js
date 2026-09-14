/**
 * Toasts and the in-DOM confirm bar (spec.md §9.8, spec-addendum A15.5, A17).
 *
 * `window.confirm()` is forbidden in this extension: a modal browser dialog in
 * a side panel steals focus from the whole window and cannot be styled or
 * localised. `#confirm-bar` temporarily replaces the footer instead.
 *
 * DOM touched (spec.md §8.3): `#toast`, `#confirm-bar`, `.bottombar`.
 */

import * as i18n from '../common/i18n.js';
import * as log from '../common/log.js';
import { TOAST_MS } from '../common/constants.js';

/* ── i18n helper (never blank, never throws) ──────────────────────────────── */

/**
 * @param {string} key
 * @param {string[]} [subs]
 * @returns {string}
 */
export function t(key, subs) {
  try {
    if (typeof i18n.t === 'function') {
      const value = i18n.t(key, subs);
      if (typeof value === 'string' && value !== '') return value;
    }
  } catch (e) {
    log.warn('toast t()', e);
  }
  return key;
}

/* ── state ────────────────────────────────────────────────────────────────── */

/** @type {any} */
let ctx = null;
/** @type {HTMLElement|null} */
let toastEl = null;
/** @type {HTMLElement|null} */
let confirmEl = null;
/** @type {number} */
let toastTimer = 0;
/**
 * @type {{resolve:(v:boolean)=>void, returnFocusTo:Element|null, lastFocused:Element|null}|null}
 */
let pendingConfirm = null;

/**
 * Wire the module to the panel context. Idempotent — calling it twice only
 * refreshes the cached context.
 * @param {any} context
 */
export function init(context) {
  if (context) ctx = context;
  toastEl = document.getElementById('toast');
  confirmEl = document.getElementById('confirm-bar');
  if (confirmEl && !confirmEl.dataset.vtBound) {
    confirmEl.dataset.vtBound = '1';
    confirmEl.addEventListener('keydown', onConfirmKeyDown);
  }
  return { toast, confirm: confirmBar };
}

/* ── toast ────────────────────────────────────────────────────────────────── */

/**
 * Show a short status message. The text is already localised — call
 * `toastKey()` when you have a message key instead.
 *
 * @param {string} text
 * @param {{ duration?: number }} [options]
 */
export function toast(text, options = {}) {
  if (!toastEl) toastEl = document.getElementById('toast');
  if (!toastEl) {
    log.warn('toast: #toast missing', text);
    return;
  }
  const duration = Number.isFinite(options.duration) ? Number(options.duration) : TOAST_MS;
  toastEl.textContent = String(text ?? '');
  toastEl.hidden = false;
  toastEl.classList.add('is-visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, Math.max(500, duration));
}

/** `sidepanel.js` looks for `showToast` first; same function. */
export { toast as showToast };

/**
 * `toast(t(key, subs))`.
 * @param {string} key
 * @param {string[]} [subs]
 * @param {{ duration?: number }} [options]
 */
export function toastKey(key, subs, options) {
  toast(t(key, subs), options);
}

export function hideToast() {
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = 0;
  }
  if (!toastEl) return;
  toastEl.classList.remove('is-visible');
  toastEl.hidden = true;
  toastEl.textContent = '';
}

/** @returns {boolean} */
export function isToastVisible() {
  return Boolean(toastEl && !toastEl.hidden);
}

/* ── confirm bar ──────────────────────────────────────────────────────────── */

/** @returns {boolean} */
export function isConfirmOpen() {
  return pendingConfirm !== null;
}

/**
 * Ask for confirmation in the footer strip. Resolves `true` when the confirm
 * button is pressed, `false` on cancel / Escape / a second call replacing this
 * one. Never rejects.
 *
 * @param {Object} options
 * @param {string} options.message        already-localised question
 * @param {string} [options.confirmLabel] defaults to `confirmClose`
 * @param {string} [options.cancelLabel]  defaults to `cancel`
 * @param {Element|null} [options.returnFocusTo] focus target after closing
 * @param {boolean} [options.danger]      adds `.confirm--danger`
 * @returns {Promise<boolean>}
 */
export function confirmBar({
  message,
  confirmLabel,
  cancelLabel,
  returnFocusTo = null,
  danger = false,
} = {}) {
  if (!confirmEl) confirmEl = document.getElementById('confirm-bar');
  if (!confirmEl) {
    log.warn('confirmBar: #confirm-bar missing');
    return Promise.resolve(false);
  }
  // A second request supersedes the first, which resolves false.
  if (pendingConfirm) settleConfirm(false);

  const lastFocused = document.activeElement instanceof Element ? document.activeElement : null;

  confirmEl.textContent = '';
  confirmEl.classList.toggle('confirm--danger', Boolean(danger));

  const text = document.createElement('p');
  text.className = 'confirm__text';
  text.dataset.testid = 'confirm-text';
  text.textContent = String(message ?? '');

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'confirm__cancel';
  cancel.dataset.testid = 'confirm-cancel';
  cancel.textContent = cancelLabel || t('cancel');

  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'confirm__ok';
  ok.dataset.testid = 'confirm-ok';
  ok.textContent = confirmLabel || t('confirmClose');

  cancel.addEventListener('click', () => settleConfirm(false));
  ok.addEventListener('click', () => settleConfirm(true));

  confirmEl.append(text, cancel, ok);
  confirmEl.hidden = false;
  setFooterHidden(true);

  return new Promise((resolve) => {
    pendingConfirm = { resolve, returnFocusTo: returnFocusTo || null, lastFocused };
    // A15.5: focus moves into the dialog; A17 puts it on the destructive button.
    try {
      ok.focus();
    } catch (e) {
      log.warn('confirmBar focus', e);
    }
  });
}

/** Alias kept because `confirm` is a reserved-ish global name at call sites. */
export { confirmBar as confirm };

/**
 * Close the bar programmatically (Escape handling lives in `keyboard.js`).
 * @param {boolean} [result]
 */
export function closeConfirm(result = false) {
  settleConfirm(result);
}

/**
 * @param {boolean} result
 */
function settleConfirm(result) {
  const pending = pendingConfirm;
  pendingConfirm = null;
  if (confirmEl) {
    confirmEl.hidden = true;
    confirmEl.textContent = '';
    confirmEl.classList.remove('confirm--danger');
  }
  setFooterHidden(false);
  if (!pending) return;
  // A15.5: restore focus to the invoking control when it is still connected.
  const target =
    (pending.returnFocusTo && pending.returnFocusTo.isConnected && pending.returnFocusTo) ||
    (pending.lastFocused && pending.lastFocused.isConnected && pending.lastFocused) ||
    document.getElementById('tablist');
  try {
    if (target && typeof (/** @type {any} */ (target).focus) === 'function') {
      /** @type {any} */ (target).focus();
    }
  } catch (e) {
    log.warn('confirmBar restore focus', e);
  }
  try {
    pending.resolve(result);
  } catch (e) {
    log.warn('confirmBar resolve', e);
  }
}

/**
 * The confirm bar replaces the footer while it is open (spec.md §9.8). The
 * `data-confirm` attribute lets the stylesheet do the same thing declaratively.
 * @param {boolean} hidden
 */
function setFooterHidden(hidden) {
  try {
    const footer = document.querySelector('.bottombar');
    if (footer instanceof HTMLElement) footer.hidden = hidden;
    if (hidden) document.documentElement.setAttribute('data-confirm', 'open');
    else document.documentElement.removeAttribute('data-confirm');
  } catch (e) {
    log.warn('confirmBar footer', e);
  }
}

/**
 * Keep Tab inside the two buttons while the bar is open (A15.5) and treat
 * Escape as cancel.
 * @param {KeyboardEvent} event
 */
function onConfirmKeyDown(event) {
  if (!pendingConfirm || !confirmEl) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    settleConfirm(false);
    return;
  }
  if (event.key !== 'Tab') return;
  const focusables = /** @type {HTMLElement[]} */ ([
    ...confirmEl.querySelectorAll('button:not([disabled])'),
  ]);
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

/* ── shared convenience wrappers ──────────────────────────────────────────── */

/** `operationFailed` — every unexpected `chrome.tabs` error ends here. */
export function toastOperationFailed() {
  toast(t('operationFailed'));
}

/**
 * `openUrlManually` — shown when `chrome.tabs.create()` refuses a `chrome://`
 * target (some builds block extension-initiated navigations to settings).
 * @param {string} url
 */
export function toastOpenUrlManually(url) {
  toast(t('openUrlManually', [String(url)]), { duration: 6000 });
}

/** @returns {any} the panel context, when `init()` has been called */
export function getContext() {
  return ctx;
}
