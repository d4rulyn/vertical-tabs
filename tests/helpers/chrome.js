// Thin wrappers around "run this in the extension's service worker / panel page".
'use strict';

const path = require('path');
const fs = require('fs');

const OUT = process.env.OUT_DIR || path.resolve(__dirname, '../output');
const SCREENSHOT_DIR = path.join(OUT, 'screenshots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "Target page, context or browser has been closed" is what a *stale Worker handle*
// reports: an MV3 worker Chrome tore down (11-lifecycle and 13-host-access stop it on
// purpose with ServiceWorker.stopAllWorkers) leaves the old Playwright object bound to
// a target that no longer exists. The same string is also what a dead browser reports,
// which is why the retry below re-resolves the worker from the context rather than
// simply calling again: if the browser really is gone the second call fails with the
// identical error and it is rethrown, so a crash never turns into a silent hang.
const TRANSIENT_SW_ERRORS =
  /Service worker restarted|Execution context was destroyed|Target closed|Target crashed|Most likely the worker has been closed|Target page, context or browser has been closed/i;

/**
 * The BrowserContext that owns a service-worker Worker. Playwright has no public
 * accessor for it (the Worker prototype is only url/evaluate/evaluateHandle/
 * waitForEvent), so the internal field is read defensively and a miss simply costs
 * the retry its re-resolution.
 * @param {import('@playwright/test').Worker} sw
 * @returns {import('@playwright/test').BrowserContext|null}
 */
function contextOf(sw) {
  const ctx = sw && sw._context;
  return ctx && typeof ctx.serviceWorkers === 'function' ? ctx : null;
}

/**
 * The worker handle that is actually live now. After Chrome restarts an extension's
 * service worker, Playwright hands out a NEW Worker object and every call on the old
 * one throws; `serviceWorkers()` always lists the current ones.
 * @param {import('@playwright/test').Worker} sw
 * @returns {import('@playwright/test').Worker}
 */
function liveWorker(sw) {
  const ctx = contextOf(sw);
  if (!ctx) return sw;
  const workers = ctx.serviceWorkers();
  if (!workers.length) return sw; // nothing to fall back to: let the retry report it
  const url = sw.url();
  return workers.find((w) => w !== sw && w.url() === url) || workers[0];
}

/**
 * Evaluates `fn` inside the extension service worker, retrying once against a
 * freshly resolved worker when Chrome recycled it between the call and its execution.
 * @template T
 * @param {import('@playwright/test').Worker} sw
 * @param {Function} fn
 * @param {any} [arg]
 * @returns {Promise<T>}
 */
async function swEval(sw, fn, arg) {
  try {
    return await sw.evaluate(fn, arg);
  } catch (err) {
    if (!TRANSIENT_SW_ERRORS.test(String(err && err.message))) throw err;
    await sleep(300);
    return liveWorker(sw).evaluate(fn, arg);
  }
}

/** Waits until every tab id reports status === 'complete'. */
async function waitForTabsComplete(sw, tabIds, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const states = await swEval(sw, async (ids) => {
      const out = [];
      for (const id of ids) {
        try {
          const t = await chrome.tabs.get(id);
          out.push({ id, status: t.status, url: t.url || t.pendingUrl || '' });
        } catch {
          out.push({ id, status: 'gone', url: '' });
        }
      }
      return out;
    }, tabIds);
    if (states.every((s) => s.status === 'complete' || s.status === 'gone')) return states;
    if (Date.now() > deadline) {
      throw new Error(`tabs did not reach status=complete: ${JSON.stringify(states)}`);
    }
    await sleep(200);
  }
}

/** Creates a tab through the service worker and waits for it to finish loading. */
async function createTab(sw, windowId, url, { active = false, index } = {}) {
  const id = await swEval(sw, async (a) => {
    const props = { windowId: a.windowId, url: a.url, active: a.active };
    if (a.index != null) props.index = a.index;
    const t = await chrome.tabs.create(props);
    return t.id;
  }, { windowId, url, active, index: index ?? null });
  await waitForTabsComplete(sw, [id]);
  return id;
}

/** Activates a tab through the service worker (no panel involvement). */
async function activateTab(sw, tabId) {
  await swEval(sw, (id) => chrome.tabs.update(id, { active: true }), tabId);
}

async function queryTabs(sw, windowId) {
  return swEval(sw, async (wid) => {
    const tabs = await chrome.tabs.query({ windowId: wid });
    return tabs
      .sort((a, b) => a.index - b.index)
      .map((t) => ({
        id: t.id, index: t.index, url: t.url || t.pendingUrl || '', title: t.title || '',
        active: !!t.active, pinned: !!t.pinned, groupId: t.groupId, status: t.status,
        discarded: !!t.discarded, muted: !!(t.mutedInfo && t.mutedInfo.muted),
        highlighted: !!t.highlighted,
      }));
  }, windowId);
}

/** urlKey() as the extension itself computes it (exposed on window.__vt in test mode). */
async function keyOf(panel, url) {
  return panel.evaluate((u) => window.__vt.urlKey(u), url);
}

/** Waits for a card with that tab id to exist in the panel DOM. */
async function waitForCard(panel, tabId, timeout = 15_000) {
  await panel.waitForSelector(`[data-testid="tab-card"][data-tab-id="${tabId}"]`, { timeout });
}

/**
 * Polls IndexedDB (through the panel's window.__vt.thumbStore) for a thumbnail record.
 * Blobs cannot cross the evaluate boundary, so only the scalar fields are returned.
 */
async function waitForThumb(panel, urlKey, { timeout = 30_000, newerThan = null } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  for (;;) {
    last = await panel.evaluate(async (k) => {
      try {
        const r = await window.__vt.thumbStore.getThumb(k);
        if (!r) return null;
        return {
          urlKey: r.urlKey, url: r.url, title: r.title ?? '',
          capturedAt: r.capturedAt, lastUsedAt: r.lastUsedAt,
          width: r.width, height: r.height, bytes: r.bytes,
          uniform: !!r.uniform, avgColor: r.avgColor || null,
          blobType: r.blob ? r.blob.type : null, blobSize: r.blob ? r.blob.size : null,
          tabId: r.tabId ?? null, windowId: r.windowId ?? null, atTop: r.atTop ?? null,
        };
      } catch {
        return null;
      }
    }, urlKey).catch(() => null);
    if (last && (newerThan == null || last.capturedAt > newerThan)) return last;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeout} ms waiting for a thumbnail of ${urlKey}` +
        (newerThan ? ` newer than ${newerThan}` : '') +
        (last ? ` (last record capturedAt=${last.capturedAt})` : ' (no record at all)'));
    }
    await sleep(250);
  }
}

/** Reads a thumbnail record without waiting (null when absent). */
async function getThumb(panel, urlKey) {
  return panel.evaluate(async (k) => {
    try {
      const r = await window.__vt.thumbStore.getThumb(k);
      if (!r) return null;
      return { urlKey: r.urlKey, capturedAt: r.capturedAt, width: r.width, height: r.height,
        bytes: r.bytes, uniform: !!r.uniform, atTop: r.atTop ?? null };
    } catch {
      return null;
    }
  }, urlKey);
}

async function thumbStats(panel) {
  return panel.evaluate(async () => {
    try {
      return await window.__vt.thumbStore.stats();
    } catch (e) {
      return { count: -1, bytes: -1, error: String(e) };
    }
  });
}

function normalizeDiagnostics(d) {
  const captures = (d && d.captures) || {};
  return {
    queueLength: d && d.queueLength != null ? d.queueLength : null,
    pendingWindows: (d && d.pendingWindows) || [],
    lastCallAt: (d && d.lastCallAt) || 0,
    lastCallByWindow: (d && d.lastCallByWindow) || {},
    openPanels: (d && d.openPanels) || [],
    alarms: (d && d.alarms) || [],
    lastError: (d && d.lastError) || null,
    captures: {
      ok: captures.ok || 0,
      failed: captures.failed || 0,
      skipped: captures.skipped || 0,
      rechecks: captures.rechecks || 0,
      quotaRejections: captures.quotaRejections || 0,
      byReason: captures.byReason || {},
    },
    byReason: captures.byReason || {},
    raw: d || null,
  };
}

const DIAG_FROM_STORAGE = async () => {
  const s = await chrome.storage.session.get(['diagnostics', 'captureState', 'openPanels']);
  const alarms = await chrome.alarms.getAll();
  const d = s.diagnostics || {};
  const cs = s.captureState || {};
  return {
    queueLength: null,
    pendingWindows: [],
    lastCallAt: cs.lastCallAt || 0,
    lastCallByWindow: cs.lastCallByWindow || {},
    openPanels: s.openPanels || [],
    alarms: alarms.map((a) => ({ name: a.name, periodInMinutes: a.periodInMinutes })),
    lastError: d.lastError || null,
    captures: d.captures || {},
  };
};

/**
 * Reads the extension's capture diagnostics.
 * `target` may be the panel Page (uses the vt/get-diagnostics message — the only
 * path that works while the service worker is stopped, see addendum A24) or the
 * service worker Worker (reads storage.session directly, since a worker cannot
 * receive its own runtime message).
 */
async function diagnostics(target) {
  const isPage = typeof target.evaluate === 'function' && typeof target.waitForSelector === 'function';
  if (isPage) {
    const viaMessage = await target.evaluate(async () => {
      try {
        return await chrome.runtime.sendMessage({ type: 'vt/get-diagnostics' });
      } catch {
        return null;
      }
    });
    if (viaMessage && typeof viaMessage === 'object') {
      const merged = normalizeDiagnostics(viaMessage);
      if (!merged.alarms.length || !Object.keys(merged.captures.byReason).length) {
        const fromStorage = await target.evaluate(DIAG_FROM_STORAGE).catch(() => null);
        if (fromStorage) {
          if (!merged.alarms.length) merged.alarms = fromStorage.alarms || [];
          const cs = normalizeDiagnostics(fromStorage);
          if (!Object.keys(merged.captures.byReason).length) {
            merged.captures.byReason = cs.captures.byReason;
            merged.byReason = cs.captures.byReason;
          }
        }
      }
      return merged;
    }
    return normalizeDiagnostics(await target.evaluate(DIAG_FROM_STORAGE));
  }
  return normalizeDiagnostics(await swEval(target, DIAG_FROM_STORAGE));
}

/** Reads the normalized settings object as the extension stores it. */
async function getSettings(sw) {
  return swEval(sw, async () => (await chrome.storage.local.get('settings')).settings || null);
}

/**
 * Merges a patch into chrome.storage.local.settings. The full object is written so
 * a panel that does not normalize partial writes still sees a valid shape.
 */
async function setSettings(sw, patch) {
  return swEval(sw, async (p) => {
    const DEFAULTS = {
      version: 1, theme: 'system', columns: 1, showThumbnails: true, refreshInterval: '1m',
      captureWhenPanelClosed: true, captureBeforeSwitch: true, persistThumbnails: true,
      excludedHosts: [], pinnedGrid: true, middleClickCloses: true, doubleClickNewTab: true,
      showUnreadDot: true, clickActiveTabSwitchesBack: false, confirmCloseThreshold: 5,
    };
    const cur = (await chrome.storage.local.get('settings')).settings || {};
    const next = { ...DEFAULTS, ...cur, ...p };
    await chrome.storage.local.set({ settings: next });
    return next;
  }, patch);
}

/** Saves a PNG under tests/output/screenshots/. */
async function shot(page, name, opts = {}) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const file = path.join(SCREENSHOT_DIR, name.endsWith('.png') ? name : `${name}.png`);
  await page.screenshot({ path: file, ...opts });
  return file;
}

/** DOM order of the cards currently rendered in #tablist. */
async function cardOrder(panel) {
  return panel.$$eval('#tablist [data-testid="tab-card"]', (els) =>
    els.map((el) => Number(el.getAttribute('data-tab-id'))));
}

module.exports = {
  OUT,
  SCREENSHOT_DIR,
  sleep,
  swEval,
  waitForTabsComplete,
  createTab,
  activateTab,
  queryTabs,
  keyOf,
  waitForCard,
  waitForThumb,
  getThumb,
  thumbStats,
  diagnostics,
  normalizeDiagnostics,
  getSettings,
  setSettings,
  shot,
  cardOrder,
};
