/**
 * Classification of `chrome.tabs.captureVisibleTab` failures
 * (spec.md §4.2, amended by spec-addendum A7a).
 *
 * PURE and message-only: substring matches against the Chromium strings that
 * were verified in the source and/or measured by the probe. The classes are
 * never shown to users — they select a retry policy and a card state.
 *
 * The `host-access` class is deliberately *not* refined here: whether
 * "Cannot access contents of url …" means "this page can never be captured"
 * or "the user withheld site access" depends on the URL, and that decision
 * lives in `background/capture.js` (spec-addendum A7b).
 */

/** Every class this module can return, in the order the table below tests. */
export const CAPTURE_ERROR_CLASSES = [
  'quota',
  'policy',
  'restricted',
  'host-access',
  'dragging',
  'gone',
  'readback',
  'unknown',
];

/**
 * Ordered rules. Order matters where messages overlap:
 *  - the chrome:// failure text contains "activeTab" and must be `restricted`
 *    before the generic host-access rule can see it;
 *  - "ExtensionsSettings policy" is a per-extension block (`restricted`), while
 *    "Administrator policy" / "Taking screenshots has been disabled" are the
 *    browser-wide screenshot policy (`policy`).
 * @type {ReadonlyArray<[string, string[]]>}
 */
const RULES = [
  ['quota', ['max_capture_visible_tab_calls_per_second']],
  ['policy', ['taking screenshots has been disabled', 'administrator policy']],
  ['restricted', ['extensionssettings policy', 'activetab', 'cannot access a chrome']],
  ['host-access', ['cannot access contents', 'extension manifest must request permission']],
  ['dragging', ['user may be dragging a tab']],
  ['gone', ['no active web contents', 'no window with id', 'no current window', 'no tab with id']],
  ['readback', ['image readback failed', 'view is invisible', 'encoding failed', 'internal error']],
];

/**
 * @param {unknown} message the rejection's `message` (an Error is accepted too)
 * @returns {'quota'|'readback'|'host-access'|'restricted'|'policy'|'dragging'|'gone'|'unknown'}
 */
export function classifyCaptureError(message) {
  const text = String(
    message && typeof message === 'object' && 'message' in message
      ? /** @type {{message: unknown}} */ (message).message
      : (message ?? ''),
  ).toLowerCase();

  if (!text) return 'unknown';

  for (const [cls, needles] of RULES) {
    for (const needle of needles) {
      if (text.includes(needle)) return /** @type {any} */ (cls);
    }
  }
  return 'unknown';
}

/**
 * Classes worth retrying at all. `restricted`, `policy` and `gone` are terminal
 * for the job (spec.md §7.5); `no-host-access` (produced by the refinement in
 * `capture.js`) is terminal for the job too but recoverable later, when the user
 * grants access — `chrome.permissions.onAdded` re-schedules everything (A7d).
 * @type {ReadonlySet<string>}
 */
export const RETRYABLE_CLASSES = new Set(['quota', 'readback', 'timeout', 'unknown', 'dragging']);

/**
 * @param {string} cls
 * @returns {boolean}
 */
export function isRetryableClass(cls) {
  return RETRYABLE_CLASSES.has(cls);
}
