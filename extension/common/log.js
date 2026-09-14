/**
 * Prefixed console logging that never throws (spec.md §1, `common/log.js`).
 *
 * Every call is wrapped: a logging failure (detached context, console replaced
 * by a page, structured-clone error while serialising an argument) must never
 * break a capture job or a render pass.
 *
 * Usage: `import * as log from '../common/log.js'; log.warn('capture job', e);`
 */

export const PREFIX = '[vertical-tabs]';

let debugEnabled = false;

/**
 * Turn `debug()` output on or off. Off by default; `console.debug` is filtered
 * out by DevTools' default log level anyway, so this is only a second gate.
 * @param {boolean} on
 */
export function setDebug(on) {
  debugEnabled = Boolean(on);
}

/** @returns {boolean} */
export function isDebug() {
  return debugEnabled;
}

function emit(method, args) {
  try {
    const fn = (typeof console !== 'undefined' && console[method]) || null;
    if (!fn) return;
    fn.call(console, PREFIX, ...args);
  } catch {
    /* logging must never throw */
  }
}

/** @param {...unknown} args */
export function debug(...args) {
  if (!debugEnabled) return;
  emit('debug', args);
}

/** @param {...unknown} args */
export function info(...args) {
  emit('log', args);
}

/** @param {...unknown} args */
export function warn(...args) {
  emit('warn', args);
}

/** @param {...unknown} args */
export function error(...args) {
  emit('error', args);
}

/**
 * Log a rejected promise without changing the rejection semantics of the
 * caller. `void swallow(p, 'context')` is the idiom for fire-and-forget writes.
 * @template T
 * @param {Promise<T>} promise
 * @param {string} context
 * @returns {Promise<T|undefined>} never rejects
 */
export function swallow(promise, context) {
  return Promise.resolve(promise).catch((e) => {
    warn(context, e);
    return undefined;
  });
}

export default { PREFIX, setDebug, isDebug, debug, info, warn, error, swallow };
