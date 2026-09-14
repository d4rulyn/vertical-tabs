/**
 * Localisation helpers (spec.md §4.6, §11).
 *
 * `t()` never returns an empty string: a missing key yields the key itself plus
 * one `console.warn`, so a forgotten translation shows as `previewPending`
 * rather than as a blank label (spec.md §16 risk 11).
 */

import * as log from './log.js';

/** Keys already reported as missing, so the warning fires once per key. */
const warned = new Set();

/**
 * @param {unknown} subs
 * @returns {string[]|undefined} at most 9 substitution strings, per the API
 */
function toSubstitutions(subs) {
  if (subs === undefined || subs === null) return undefined;
  const list = Array.isArray(subs) ? subs : [subs];
  if (list.length === 0) return undefined;
  return list.slice(0, 9).map((value) => String(value));
}

/**
 * Look up a message from `_locales/<locale>/messages.json`.
 *
 * @param {string} key message name
 * @param {string|number|Array<string|number>} [subs] `$1`…`$9` substitutions
 * @returns {string} the localised message, or `key` when it is missing
 */
export function t(key, subs) {
  if (typeof key !== 'string' || key === '') return '';

  let message = '';
  try {
    if (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getMessage) {
      const substitutions = toSubstitutions(subs);
      message = substitutions
        ? chrome.i18n.getMessage(key, substitutions)
        : chrome.i18n.getMessage(key);
    }
  } catch (e) {
    message = '';
    if (!warned.has(key)) {
      warned.add(key);
      log.warn('i18n lookup failed for', key, e);
    }
  }

  if (!message) {
    if (!warned.has(key)) {
      warned.add(key);
      log.warn('missing i18n message:', key);
    }
    return key;
  }
  return message;
}

/**
 * The browser's UI language (`'en-US'`, `'ja'`, …) — the language `_locales`
 * actually resolved against, which is *not* affected by `navigator.language`.
 * @returns {string}
 */
export function getUILanguage() {
  try {
    if (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getUILanguage) {
      return chrome.i18n.getUILanguage() || '';
    }
  } catch {
    /* fall through */
  }
  return '';
}

/**
 * Parse `data-i18n-attr="attr:key;attr2:key2"`.
 * @param {string} spec
 * @returns {Array<[string, string]>}
 */
function parseAttrSpec(spec) {
  /** @type {Array<[string, string]>} */
  const pairs = [];
  for (const part of String(spec).split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf(':');
    if (index <= 0) continue;
    const attr = trimmed.slice(0, index).trim();
    const key = trimmed.slice(index + 1).trim();
    if (attr && key) pairs.push([attr, key]);
  }
  return pairs;
}

/**
 * Fill every `data-i18n` (as `textContent`) and every `data-i18n-attr` (as
 * attributes) below `root`, and stamp the UI language on `<html lang>`.
 *
 * Safe to call repeatedly and on freshly cloned `<template>` content — MV3's
 * CSP forbids inline scripts, so this is the only way strings reach the DOM.
 *
 * @param {ParentNode|Document|DocumentFragment|Element} [root]
 */
export function applyI18n(root = typeof document !== 'undefined' ? document : null) {
  if (!root || typeof root.querySelectorAll !== 'function') return;

  const self = /** @type {Element} */ (root);
  const hasAttr = typeof self.getAttribute === 'function';

  /** @type {Element[]} */
  const textNodes = [...root.querySelectorAll('[data-i18n]')];
  if (hasAttr && self.hasAttribute && self.hasAttribute('data-i18n')) textNodes.unshift(self);
  for (const el of textNodes) {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  }

  /** @type {Element[]} */
  const attrNodes = [...root.querySelectorAll('[data-i18n-attr]')];
  if (hasAttr && self.hasAttribute && self.hasAttribute('data-i18n-attr')) attrNodes.unshift(self);
  for (const el of attrNodes) {
    const spec = el.getAttribute('data-i18n-attr');
    if (!spec) continue;
    for (const [attr, key] of parseAttrSpec(spec)) el.setAttribute(attr, t(key));
  }

  try {
    const doc =
      /** @type {Document} */ (root).documentElement !== undefined
        ? /** @type {Document} */ (root)
        : /** @type {Element} */ (root).ownerDocument;
    const lang = getUILanguage();
    if (doc && doc.documentElement && lang) doc.documentElement.lang = lang;
  } catch {
    /* document fragments have no documentElement */
  }
}

/**
 * Keys reported missing so far — a test hook for the i18n parity checks.
 * @returns {string[]}
 */
export function missingKeys() {
  return [...warned];
}
