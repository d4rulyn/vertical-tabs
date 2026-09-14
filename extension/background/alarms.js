/**
 * background/alarms.js — the two periodic jobs (§7.7, §7.8, addendum A3.4).
 *
 *  vt-refresh     : re-captures the active tab of the interesting windows so a preview
 *                   stays "as last seen" (Chrome cannot capture a tab at switch-away
 *                   time unless the switch came from our panel — see A12).
 *  vt-maintenance : prunes the thumbnail store and the volatile per-tab/per-url memory.
 *
 * Alarms are re-created on every service-worker start (they are cheap and `alarms.get`
 * tells us whether one already exists). `persistAcrossSessions` is never passed: it is a
 * Chrome 150+ field and pre-150 persistence is documented as unpredictable.
 */

import * as C from '../common/constants.js';
import * as schema from '../common/settings-schema.js';
import * as logMod from '../common/log.js';
import { loadSettings } from '../common/settings.js';
import { urlKey } from '../common/url-key.js';
import { prune } from '../common/thumb-store.js';
import * as capture from './capture.js';
import * as panels from './panels.js';

const log = {
  warn: typeof logMod.warn === 'function' ? logMod.warn : (...a) => console.warn('[vt]', ...a),
};

const ALARMS = C.ALARMS ?? { maintenance: 'vt-maintenance', refresh: 'vt-refresh' };
const MAINTENANCE_PERIOD_MIN = C.MAINTENANCE_PERIOD_MIN ?? 30;
const REFRESH_PERIODS = schema.REFRESH_PERIODS ?? { off: null, '30s': 0.5, '1m': 1, '5m': 5 };
const REFRESH_STALE_MS = C.REFRESH_STALE_MS ?? 20000;
const REFRESH_MAX_WINDOWS = C.REFRESH_MAX_WINDOWS ?? 4;
const PRUNE = C.PRUNE ?? { maxEntries: 1000, maxBytes: 120 * 1024 * 1024, maxAgeMs: 14 * 86400e3 };

/**
 * Creates the maintenance alarm if it is missing and reconciles the refresh alarm with
 * the current `refreshInterval` setting. Safe to call on every service-worker start,
 * on install, on startup and on every settings change.
 */
export async function ensureAlarms() {
  try {
    const maintenance = await chrome.alarms.get(ALARMS.maintenance);
    if (!maintenance) {
      await chrome.alarms.create(ALARMS.maintenance, { periodInMinutes: MAINTENANCE_PERIOD_MIN });
    }
  } catch (e) {
    log.warn('alarms: maintenance alarm failed', e);
  }

  try {
    const settings = await loadSettings();
    const period = REFRESH_PERIODS[settings.refreshInterval];
    const existing = await chrome.alarms.get(ALARMS.refresh);
    if (period == null) {
      if (existing) await chrome.alarms.clear(ALARMS.refresh);
      return;
    }
    if (!existing || existing.periodInMinutes !== period) {
      await chrome.alarms.create(ALARMS.refresh, { periodInMinutes: period });
    }
  } catch (e) {
    log.warn('alarms: refresh alarm failed', e);
  }
}

/**
 * A3.4 — refresh the last-focused window plus every window whose panel is open,
 * capped at REFRESH_MAX_WINDOWS so one period never costs more than ~4.4 s of the
 * 1100 ms-spaced capture budget.
 */
export async function runRefresh() {
  try {
    const settings = await loadSettings();
    if (REFRESH_PERIODS[settings.refreshInterval] == null) return;

    const all = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const windows = (all ?? []).filter((w) => w.state !== 'minimized');
    if (!windows.length) return;

    const open = new Set(await panels.openWindowIds());
    const last = await capture.lastFocusedWindowId();
    const ordered = windows.sort((a, b) => (b.id === last ? 1 : 0) - (a.id === last ? 1 : 0));
    const targets = ordered.filter((w) => w.id === last || open.has(w.id)).slice(0, REFRESH_MAX_WINDOWS);

    await Promise.all(
      targets.map((w) => capture.scheduleActiveOfWindow(w.id, 'refresh', { onlyIfOlderThan: REFRESH_STALE_MS })),
    );
  } catch (e) {
    log.warn('alarms: runRefresh failed', e);
  }
}

/**
 * §7.8 — prune only here (never at onStartup, which races Chrome's session restore).
 * Thumbnails of currently open tabs are protected regardless of age.
 */
export async function runMaintenance() {
  try {
    const tabs = await chrome.tabs.query({});
    const liveTabIds = new Set();
    const protectedSet = new Set();
    for (const tab of tabs ?? []) {
      if (Number.isInteger(tab.id)) liveTabIds.add(tab.id);
      const key = urlKey(tab.url && tab.url !== '' ? tab.url : tab.pendingUrl || '');
      if (key) protectedSet.add(key);
    }

    await capture.pruneVolatileState(liveTabIds);

    // An array is the plain reading of the spec ("urlKeys of all open tabs"); the extra
    // `has()` makes it work unchanged if thumb-store treats protectedKeys as a Set.
    const protectedKeys = [...protectedSet];
    Object.defineProperty(protectedKeys, 'has', {
      value: (key) => protectedSet.has(key),
      enumerable: false,
    });

    await prune({
      maxEntries: PRUNE.maxEntries,
      maxBytes: PRUNE.maxBytes,
      maxAgeMs: PRUNE.maxAgeMs,
      protectedKeys,
    });
  } catch (e) {
    log.warn('alarms: runMaintenance failed', e);
  }
}
