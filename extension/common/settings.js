/**
 * Settings persistence on `chrome.storage.local` (spec.md §4.4, §10).
 *
 * `storage.local` — not `storage.sync` — because sync has an 8 KB per-item cap
 * and a 120-writes-per-minute quota, and a local fallback would create a
 * split brain (spec.md Appendix C).
 *
 * Writes are serialised through one promise chain so two concurrent
 * `saveSettings()` calls cannot lose each other's fields.
 */

import { STORAGE_LOCAL, HINTS_DEFAULTS } from './constants.js';
import { DEFAULTS, normalizeSettings } from './settings-schema.js';
import * as log from './log.js';

/** @type {Promise<unknown>} */
let writeChain = Promise.resolve();

/**
 * Read and validate the stored settings. Never rejects: a storage failure
 * yields the defaults so the UI can still render.
 * @returns {Promise<ReturnType<typeof normalizeSettings>>}
 */
export async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_LOCAL.settings);
    return normalizeSettings(stored ? stored[STORAGE_LOCAL.settings] : undefined);
  } catch (e) {
    log.warn('loadSettings', e);
    return normalizeSettings(undefined);
  }
}

/**
 * Read-merge-write of the single `settings` key. One call per user action —
 * text inputs save on `change` (debounced by the drawer), never per keystroke.
 *
 * @param {Partial<typeof DEFAULTS>} patch
 * @returns {Promise<ReturnType<typeof normalizeSettings>>} the settings actually stored
 */
export async function saveSettings(patch) {
  const run = async () => {
    const current = await loadSettings();
    const merged = normalizeSettings({ ...current, ...(patch || {}) });
    try {
      await chrome.storage.local.set({ [STORAGE_LOCAL.settings]: merged });
    } catch (e) {
      log.warn('saveSettings', e);
    }
    return merged;
  };
  // Chain even on failure so one rejected write cannot stall later ones.
  const next = writeChain.then(run, run);
  writeChain = next.catch(() => undefined);
  return next;
}

/**
 * Replace the whole settings object with the defaults.
 * @returns {Promise<ReturnType<typeof normalizeSettings>>}
 */
export async function resetSettings() {
  const run = async () => {
    const fresh = normalizeSettings(undefined);
    try {
      await chrome.storage.local.set({ [STORAGE_LOCAL.settings]: fresh });
    } catch (e) {
      log.warn('resetSettings', e);
    }
    return fresh;
  };
  const next = writeChain.then(run, run);
  writeChain = next.catch(() => undefined);
  return next;
}

/**
 * Subscribe to settings changes made by any context (the panel writes, the
 * service worker re-runs `ensureAlarms()`; spec.md §6.3).
 *
 * @param {(next: ReturnType<typeof normalizeSettings>, prev: ReturnType<typeof normalizeSettings>) => void} callback
 * @returns {() => void} unsubscribe
 */
export function onSettingsChange(callback) {
  if (typeof callback !== 'function') return () => {};

  const listener = (changes, area) => {
    if (area !== 'local' || !changes || !changes[STORAGE_LOCAL.settings]) return;
    const change = changes[STORAGE_LOCAL.settings];
    try {
      callback(normalizeSettings(change.newValue), normalizeSettings(change.oldValue));
    } catch (e) {
      log.warn('onSettingsChange callback', e);
    }
  };

  try {
    chrome.storage.onChanged.addListener(listener);
  } catch (e) {
    log.warn('onSettingsChange', e);
    return () => {};
  }

  return () => {
    try {
      chrome.storage.onChanged.removeListener(listener);
    } catch {
      /* context already gone */
    }
  };
}

/**
 * Read the one-time-hint bookkeeping (`chrome.storage.local.hints`,
 * spec.md §5.2 + spec-addendum A7e). Never rejects.
 * @returns {Promise<typeof HINTS_DEFAULTS>}
 */
export async function loadHints() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_LOCAL.hints);
    const raw = stored ? stored[STORAGE_LOCAL.hints] : undefined;
    return { ...HINTS_DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch (e) {
    log.warn('loadHints', e);
    return { ...HINTS_DEFAULTS };
  }
}

/**
 * Merge a patch into `chrome.storage.local.hints`.
 * @param {Partial<typeof HINTS_DEFAULTS>} patch
 * @returns {Promise<typeof HINTS_DEFAULTS>}
 */
export async function saveHints(patch) {
  const run = async () => {
    const current = await loadHints();
    const merged = { ...current, ...(patch || {}) };
    try {
      await chrome.storage.local.set({ [STORAGE_LOCAL.hints]: merged });
    } catch (e) {
      log.warn('saveHints', e);
    }
    return merged;
  };
  const next = writeChain.then(run, run);
  writeChain = next.catch(() => undefined);
  return next;
}

export { DEFAULTS, normalizeSettings };
