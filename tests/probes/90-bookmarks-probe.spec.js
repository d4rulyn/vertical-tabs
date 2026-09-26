// 90-bookmarks-probe — THROWAWAY platform probe for the "bookmarks rail" request.
//
// This is NOT a regression test of Vertical Tabs. It loads two disposable MV3
// extensions (generated into tests/output/probe-ext/ at run time) and measures what
// Chromium 151.0.7922.34 actually does, because CLAUDE.md §7.2 forbids asserting
// Chrome API behaviour from memory.
//
// It answers, as measurements:
//   1. the shape of chrome.bookmarks.getTree() in a fresh profile          -> test A
//   2. whether "bookmarks" works as an OPTIONAL permission requested from the
//      panel document, with and without a user gesture                     -> B1/B2
//   3. whether permissions.contains()/onAdded/onRemoved behave there       -> B2/B3
//   4. whether bookmarks.on* are usable for a live list, and cost          -> A/B3
//
// Everything it learns is written to tests/output/bookmarks-probe.json and printed.
//
// Run:
//   HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose -f tests/docker-compose.yml \
//     run --rm e2e VT_TEST_DIR=./probes playwright test 90-bookmarks-probe.spec.js --reporter=line --retries=0
'use strict';

const fs = require('fs');
const path = require('path');
const { test, expect, chromium } = require('@playwright/test');

const OUT = process.env.OUT_DIR || path.resolve(__dirname, '../output');
const PROBE_ROOT = path.join(OUT, 'probe-ext');
const REPORT = path.join(OUT, 'bookmarks-probe.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function record(key, value) {
  fs.mkdirSync(OUT, { recursive: true });
  const prev = fs.existsSync(REPORT) ? JSON.parse(fs.readFileSync(REPORT, 'utf8')) : {};
  prev[key] = value;
  fs.writeFileSync(REPORT, JSON.stringify(prev, null, 2));
  console.log(`\n===== ${key} =====\n` + JSON.stringify(value, null, 2));
}

// ---------------------------------------------------------------------------
// Disposable extension sources. `variant` decides whether "bookmarks" is a
// REQUIRED permission (to measure the API itself) or an OPTIONAL one (to measure
// the grant flow, which is the crux of the design).
// ---------------------------------------------------------------------------

const PANEL_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>probe panel</title></head>
<body style="font:14px sans-serif;margin:8px">
<h1 id="h">probe</h1>
<button id="req" style="width:200px;height:40px">request bookmarks</button>
<button id="req2" style="width:200px;height:40px">request __probe.nextPerms</button>
<button id="rem" style="width:200px;height:40px">remove bookmarks</button>
<pre id="log"></pre>
<script type="module" src="panel.js"></script>
</body></html>`;

const PANEL_JS = `
const P = {
  ready: false,
  where: location.search.includes('as=tab') ? 'tab' : 'sidepanel',
  permEvents: [],
  bmEvents: [],
  clickRequest: null,
  clickRemove: null,
  evalRequest: null,
};
window.__probe = P;

// permissions.* is available to every extension context with no manifest entry.
try {
  chrome.permissions.onAdded.addListener((p) => P.permEvents.push({ kind: 'onAdded', at: Date.now(), p }));
  chrome.permissions.onRemoved.addListener((p) => P.permEvents.push({ kind: 'onRemoved', at: Date.now(), p }));
  P.permListeners = 'registered';
} catch (e) {
  P.permListeners = 'threw: ' + String(e && e.message || e);
}

// Bookmark listeners can only be registered when the API object exists.
P.bindBookmarkEvents = () => {
  if (!chrome.bookmarks) return 'chrome.bookmarks is undefined';
  if (P.bmBound) return 'already bound';
  const push = (kind) => (...args) => P.bmEvents.push({ kind, at: Date.now(), args });
  chrome.bookmarks.onCreated.addListener(push('onCreated'));
  chrome.bookmarks.onChanged.addListener(push('onChanged'));
  chrome.bookmarks.onRemoved.addListener(push('onRemoved'));
  chrome.bookmarks.onMoved.addListener(push('onMoved'));
  if (chrome.bookmarks.onChildrenReordered) chrome.bookmarks.onChildrenReordered.addListener(push('onChildrenReordered'));
  if (chrome.bookmarks.onImportBegan) chrome.bookmarks.onImportBegan.addListener(push('onImportBegan'));
  if (chrome.bookmarks.onImportEnded) chrome.bookmarks.onImportEnded.addListener(push('onImportEnded'));
  P.bmBound = true;
  return 'bound';
};

// Fire-and-forget: the caller polls P[slot] instead of awaiting, so a prompt that
// never resolves is RECORDED as "still pending" rather than hanging the probe.
P.fireRequest = (slot) => {
  const act = navigator.userActivation
    ? { isActive: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive }
    : null;
  P[slot] = { state: 'pending', calledAt: Date.now(), activationAtCall: act };
  let promise;
  try {
    promise = chrome.permissions.request({ permissions: ['bookmarks'] });
  } catch (e) {
    P[slot] = Object.assign({}, P[slot], { state: 'threw-sync', error: String(e && e.message || e) });
    return 'threw-sync';
  }
  P[slot].returnedType = Object.prototype.toString.call(promise);
  Promise.resolve(promise).then(
    (v) => { P[slot] = Object.assign({}, P[slot], { state: 'resolved', value: v, settledAt: Date.now() }); },
    (e) => { P[slot] = Object.assign({}, P[slot], { state: 'rejected', error: String(e && e.message || e), settledAt: Date.now() }); },
  );
  return 'fired';
};

// Same, for an arbitrary permission set chosen by the test before the click.
P.nextPerms = ['bookmarks'];
P.fireRequestPerms = (slot) => {
  const act = navigator.userActivation
    ? { isActive: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive } : null;
  P[slot] = { state: 'pending', perms: P.nextPerms.slice(), calledAt: Date.now(), activationAtCall: act };
  let promise;
  try {
    promise = chrome.permissions.request({ permissions: P.nextPerms });
  } catch (e) {
    P[slot] = Object.assign({}, P[slot], { state: 'threw-sync', error: String(e && e.message || e) });
    return 'threw-sync';
  }
  Promise.resolve(promise).then(
    (v) => { P[slot] = Object.assign({}, P[slot], { state: 'resolved', value: v, settledAt: Date.now() }); },
    (e) => { P[slot] = Object.assign({}, P[slot], { state: 'rejected', error: String(e && e.message || e), settledAt: Date.now() }); },
  );
  return 'fired';
};

// The whole point: request() is called SYNCHRONOUSLY as the first statement of a
// real click handler, so the user activation is still live.
document.getElementById('req').addEventListener('click', () => { P.fireRequest('clickRequest'); });
document.getElementById('req2').addEventListener('click', () => { P.fireRequestPerms('clickRequest2'); });

document.getElementById('rem').addEventListener('click', () => {
  P.clickRemove = { state: 'pending', calledAt: Date.now() };
  let promise;
  try {
    promise = chrome.permissions.remove({ permissions: ['bookmarks'] });
  } catch (e) {
    P.clickRemove = { state: 'threw-sync', error: String(e && e.message || e) };
    return;
  }
  Promise.resolve(promise).then(
    (v) => { P.clickRemove = Object.assign({}, P.clickRemove, { state: 'resolved', value: v, settledAt: Date.now() }); },
    (e) => { P.clickRemove = Object.assign({}, P.clickRemove, { state: 'rejected', error: String(e && e.message || e), settledAt: Date.now() }); },
  );
});

P.bindBookmarkEvents();
P.ready = true;
document.getElementById('log').textContent = P.where + ' ready';
`;

const SW_JS = `
// Top-level, synchronous listener registration (MV3 rule).
self.__swProbe = { permEvents: [], bmEvents: [] };
chrome.permissions.onAdded.addListener((p) => self.__swProbe.permEvents.push({ kind: 'onAdded', at: Date.now(), p }));
chrome.permissions.onRemoved.addListener((p) => self.__swProbe.permEvents.push({ kind: 'onRemoved', at: Date.now(), p }));
if (chrome.bookmarks) {
  const push = (kind) => (...args) => self.__swProbe.bmEvents.push({ kind, at: Date.now(), args });
  chrome.bookmarks.onCreated.addListener(push('onCreated'));
  chrome.bookmarks.onChanged.addListener(push('onChanged'));
  chrome.bookmarks.onRemoved.addListener(push('onRemoved'));
  chrome.bookmarks.onMoved.addListener(push('onMoved'));
  self.__swProbe.boundAtStartup = true;
} else {
  self.__swProbe.boundAtStartup = false;
}
chrome.runtime.onMessage.addListener(() => {});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
`;

function writeExtension(variant) {
  const dir = path.join(PROBE_ROOT, variant);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    manifest_version: 3,
    name: `bookmarks probe (${variant})`,
    version: '1.0.0',
    minimum_chrome_version: '120',
    side_panel: { default_path: 'panel.html' },
    action: { default_title: 'probe' },
    background: { service_worker: 'sw.js', type: 'module' },
    permissions: variant === 'required'
      ? ['sidePanel', 'tabs', 'storage', 'bookmarks']
      : ['sidePanel', 'tabs', 'storage'],
  };
  if (variant === 'optional') manifest.optional_permissions = ['bookmarks'];
  // A permission that carries NO user-visible warning, next to one that does: the
  // pair separates "the request plumbing is broken" from "the prompt is unanswerable".
  if (variant === 'optional-nowarn') manifest.optional_permissions = ['bookmarks', 'alarms', 'idle'];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'panel.html'), PANEL_HTML);
  fs.writeFileSync(path.join(dir, 'panel.js'), PANEL_JS);
  fs.writeFileSync(path.join(dir, 'sw.js'), SW_JS);
  return dir;
}

async function launch(dir, { userDataDir = '', headed = false } = {}) {
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !headed,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${dir}`,
      `--load-extension=${dir}`,
      ...(process.env.VT_CHROMIUM_NO_SANDBOX !== '0' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    ],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  return { context, sw, id: sw.url().split('/')[2] };
}

/**
 * Tries to obtain a Playwright Page for the REAL side panel document, and always
 * also opens panel.html as a tab (which is what the existing harness does).
 */
async function openPanels(context, sw, id) {
  const notes = {};
  // The tab copy carries ?as=tab so the two documents are distinguishable by URL.
  const tab = await context.newPage();
  await tab.goto(`chrome-extension://${id}/panel.html?as=tab`);
  await tab.waitForFunction(() => window.__probe && window.__probe.ready === true, null, { timeout: 15_000 });

  const w = await sw.evaluate(async () => (await chrome.windows.getLastFocused()).id);
  const before = context.pages().length;
  // Measured previously (probe-results.md): sidePanel.open() from an extension PAGE
  // context resolves in headless. Try it and see whether a Page appears for it.
  notes.sidePanelOpen = await tab.evaluate(async (wid) => {
    try { await chrome.sidePanel.open({ windowId: wid }); return 'resolved'; }
    catch (e) { return 'rejected: ' + String(e && e.message || e); }
  }, w);

  let sidepanel = null;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    sidepanel = context.pages().find((p) => p.url().endsWith('/panel.html')) || null;
    if (sidepanel) break;
    await sleep(200);
  }
  notes.pagesBefore = before;
  notes.pagesAfter = context.pages().length;
  notes.pageUrls = context.pages().map((p) => p.url());
  notes.contexts = await sw.evaluate(async () => {
    try {
      const cs = await chrome.runtime.getContexts({});
      return cs.map((c) => ({ contextType: c.contextType, documentUrl: c.documentUrl, windowId: c.windowId, tabId: c.tabId }));
    } catch (e) { return 'threw: ' + String(e && e.message || e); }
  });
  if (sidepanel) {
    await sidepanel.waitForFunction(() => window.__probe && window.__probe.ready === true, null, { timeout: 15_000 })
      .catch((e) => { notes.sidepanelReady = 'timeout: ' + String(e && e.message || e); });
  }
  return { sidepanel, tab, notes, windowId: w };
}

/** Polls window.__probe[slot] until it stops being 'pending', or the budget runs out. */
async function waitForSlot(page, slot, budgetMs) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < budgetMs) {
    last = await page.evaluate((s) => (window.__probe[s] ? JSON.parse(JSON.stringify(window.__probe[s])) : null), slot)
      .catch((e) => ({ state: 'poll-failed', error: String(e && e.message || e) }));
    if (last && last.state !== 'pending') break;
    await sleep(250);
  }
  return { waitedMs: Date.now() - t0, slot: last };
}

// ===========================================================================
// PART A — what chrome.bookmarks actually is, with bookmarks as a REQUIRED perm
// ===========================================================================
test('A: bookmarks API shape, default contents and live events (required permission)', async () => {
  test.setTimeout(180_000);
  const dir = writeExtension('required');
  const { context, sw, id } = await launch(dir);
  const out = { variant: 'required', extensionId: id };
  try {
    out.manifest = await sw.evaluate(() => chrome.runtime.getManifest());
    out.apiPresentInSW = await sw.evaluate(() => typeof chrome.bookmarks);
    out.swProbe = await sw.evaluate(() => ({ boundAtStartup: self.__swProbe.boundAtStartup }));

    // --- 1. the pristine tree, verbatim -----------------------------------
    out.treeFresh = await sw.evaluate(async () => {
      try { return JSON.parse(JSON.stringify(await chrome.bookmarks.getTree())); }
      catch (e) { return 'threw: ' + String(e && e.message || e); }
    });
    out.rootNodeKeys = await sw.evaluate(async () => {
      const t = await chrome.bookmarks.getTree();
      const keysOf = (n) => Object.keys(n).sort();
      return {
        root: keysOf(t[0]),
        children: (t[0].children || []).map((c) => ({ id: c.id, title: c.title, keys: keysOf(c), childCount: (c.children || []).length, hasUrl: 'url' in c })),
      };
    });
    out.apiSurface = await sw.evaluate(() => Object.keys(chrome.bookmarks).sort());
    out.constants = await sw.evaluate(() => ({
      ROOT_NODE_ID: chrome.bookmarks.ROOT_NODE_ID,
      MAX_WRITE_OPERATIONS_PER_HOUR: chrome.bookmarks.MAX_WRITE_OPERATIONS_PER_HOUR,
      MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE: chrome.bookmarks.MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE,
      FolderType: chrome.bookmarks.FolderType,
      BookmarkTreeNodeUnmodifiable: chrome.bookmarks.BookmarkTreeNodeUnmodifiable,
    }));

    // --- 2. create real data and re-read ----------------------------------
    const panels = await openPanels(context, sw, id);
    out.panelNotes = panels.notes;
    const target = panels.sidepanel || panels.tab;
    out.eventsObservedIn = panels.sidepanel ? 'real side panel document' : 'panel.html opened as a tab';
    out.bindResult = await target.evaluate(() => window.__probe.bindBookmarkEvents());

    out.created = await sw.evaluate(async () => {
      const roots = (await chrome.bookmarks.getTree())[0].children || [];
      const bar = roots.find((c) => c.id === '1') || roots[0];
      const folder = await chrome.bookmarks.create({ parentId: bar.id, title: 'Probe folder' });
      const a = await chrome.bookmarks.create({ parentId: folder.id, title: 'Alpha', url: 'http://127.0.0.1/alpha' });
      const b = await chrome.bookmarks.create({ parentId: folder.id, title: 'Beta', url: 'http://127.0.0.1/beta' });
      return { barId: bar.id, folder, a, b };
    });
    out.nodeKeys = {
      folder: Object.keys(out.created.folder).sort(),
      bookmark: Object.keys(out.created.a).sort(),
    };

    out.treeAfterCreate = await sw.evaluate(async () =>
      JSON.parse(JSON.stringify(await chrome.bookmarks.getTree())));
    out.getSubTree = await sw.evaluate(async (fid) =>
      JSON.parse(JSON.stringify(await chrome.bookmarks.getSubTree(fid))), out.created.folder.id);
    out.getChildren = await sw.evaluate(async (fid) =>
      JSON.parse(JSON.stringify(await chrome.bookmarks.getChildren(fid))), out.created.folder.id);
    out.search = await sw.evaluate(async () =>
      JSON.parse(JSON.stringify(await chrome.bookmarks.search('Alpha'))));

    // --- 3. mutate, so onChanged / onMoved / onRemoved can be seen ---------
    await sw.evaluate(async (ids) => {
      await chrome.bookmarks.update(ids.a, { title: 'Alpha renamed' });
      await chrome.bookmarks.move(ids.b, { parentId: ids.bar });
      await chrome.bookmarks.remove(ids.a);
    }, { a: out.created.a.id, b: out.created.b.id, bar: out.created.barId });
    await sleep(500);

    out.panelEvents = await target.evaluate(() => JSON.parse(JSON.stringify(window.__probe.bmEvents)));
    out.swEvents = await sw.evaluate(() => JSON.parse(JSON.stringify(self.__swProbe.bmEvents)));

    // --- 4. cost: 50 creates, and how long a full getTree() takes ----------
    out.cost = await sw.evaluate(async (parentId) => {
      const t0 = performance.now();
      const made = [];
      for (let i = 0; i < 50; i++) {
        made.push((await chrome.bookmarks.create({ parentId, title: 'bulk ' + i, url: 'http://127.0.0.1/b' + i })).id);
      }
      const tCreate = performance.now() - t0;
      const t1 = performance.now();
      const tree = await chrome.bookmarks.getTree();
      const tGetTree = performance.now() - t1;
      const count = (function walk(ns) { return ns.reduce((n, x) => n + 1 + walk(x.children || []), 0); })(tree);
      const t2 = performance.now();
      for (let i = 0; i < 20; i++) await chrome.bookmarks.getTree();
      const tGetTreeAvg = (performance.now() - t2) / 20;
      const t3 = performance.now();
      for (const bid of made) await chrome.bookmarks.remove(bid);
      const tRemove = performance.now() - t3;
      return {
        creates: 50, msForFiftyCreates: Math.round(tCreate), msPerCreate: +(tCreate / 50).toFixed(2),
        msFirstGetTreeAfter: +tGetTree.toFixed(2), msGetTreeAvgOf20: +tGetTreeAvg.toFixed(2),
        totalNodesInTree: count, msForFiftyRemoves: Math.round(tRemove),
        jsonBytesOfWholeTree: JSON.stringify(tree).length,
      };
    }, out.created.folder.id);
    await sleep(800);
    out.eventCountAfterBulk = await target.evaluate(() => window.__probe.bmEvents.length);

    out.permissionsContainsBookmarks = await sw.evaluate(() =>
      chrome.permissions.contains({ permissions: ['bookmarks'] }));
    out.permissionsGetAll = await sw.evaluate(() => chrome.permissions.getAll());
  } finally {
    record('A', out);
    await context.close();
  }
  expect(out.apiPresentInSW).toBe('object');
});

// ===========================================================================
// PART A2 — does a BIG bookmark tree stay cheap enough to re-read on every event?
// (The rail design hinges on whether getTree() can be the single source of truth.)
// ===========================================================================
test('A2: cost of a large bookmark tree', async () => {
  test.setTimeout(240_000);
  const dir = writeExtension('required');
  const { context, sw } = await launch(dir);
  const out = {};
  try {
    out.writeQuotaConstants = await sw.evaluate(() => ({
      MAX_WRITE_OPERATIONS_PER_HOUR: chrome.bookmarks.MAX_WRITE_OPERATIONS_PER_HOUR,
      MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE: chrome.bookmarks.MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE,
    }));
    out.bulk = await sw.evaluate(async () => {
      const roots = (await chrome.bookmarks.getTree())[0].children || [];
      const bar = roots[0];
      const report = { created: 0, errors: [], folders: 20, perFolder: 100 };
      const t0 = performance.now();
      for (let f = 0; f < report.folders; f++) {
        const folder = await chrome.bookmarks.create({ parentId: bar.id, title: 'Folder ' + f });
        for (let i = 0; i < report.perFolder; i++) {
          try {
            await chrome.bookmarks.create({
              parentId: folder.id,
              title: 'A reasonably long bookmark title number ' + (f * 100 + i),
              url: 'https://example.com/path/segment/' + f + '/' + i + '?q=probe',
            });
            report.created++;
          } catch (e) {
            if (report.errors.length < 3) report.errors.push(String(e && e.message || e));
          }
        }
      }
      report.msToCreateAll = Math.round(performance.now() - t0);
      return report;
    });
    out.reads = await sw.evaluate(async () => {
      const time = async (fn, n) => {
        const t = performance.now();
        let r;
        for (let i = 0; i < n; i++) r = await fn();
        return { msAvg: +((performance.now() - t) / n).toFixed(2), sample: r };
      };
      const full = await time(() => chrome.bookmarks.getTree(), 10);
      const tree = full.sample;
      const count = (function walk(ns) { return ns.reduce((n, x) => n + 1 + walk(x.children || []), 0); })(tree);
      const bar = tree[0].children[0];
      const children = await time(() => chrome.bookmarks.getChildren(bar.id), 10);
      const search = await time(() => chrome.bookmarks.search('number 5'), 10);
      return {
        totalNodes: count,
        jsonBytesOfWholeTree: JSON.stringify(tree).length,
        msGetTreeAvgOf10: full.msAvg,
        msGetChildrenOfBarAvgOf10: children.msAvg,
        msSearchAvgOf10: search.msAvg,
        searchHits: Array.isArray(search.sample) ? search.sample.length : null,
      };
    });
  } finally {
    record('A2', out);
    await context.close();
  }
  expect(out.reads.totalNodes).toBeGreaterThan(1000);
});

// ===========================================================================
// PART B1 — optional permission, request() WITHOUT a real click
// ===========================================================================
test('B1: permissions.request for an optional bookmarks permission, no click', async () => {
  test.setTimeout(150_000);
  const dir = writeExtension('optional');
  const { context, sw, id } = await launch(dir);
  const out = { variant: 'optional', extensionId: id, scenario: 'request() fired from page.evaluate (no click)' };
  try {
    out.manifest = await sw.evaluate(() => chrome.runtime.getManifest());
    out.swBoundBookmarksAtStartup = await sw.evaluate(() => self.__swProbe.boundAtStartup);
    out.apiInSWBeforeGrant = await sw.evaluate(() => typeof chrome.bookmarks);
    out.getAllBefore = await sw.evaluate(() => chrome.permissions.getAll());
    out.containsBefore = await sw.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] }));

    const panels = await openPanels(context, sw, id);
    out.panelNotes = panels.notes;
    const target = panels.sidepanel || panels.tab;
    out.requestedFrom = panels.sidepanel
      ? 'real side panel document (Playwright Page)'
      : 'panel.html opened as a tab — Playwright exposes no Page for the SIDE_PANEL context';

    out.panelApiBeforeGrant = await target.evaluate(() => typeof chrome.bookmarks);
    out.panelContainsBefore = await target.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] }));
    out.panelPermissionsApi = await target.evaluate(() => Object.keys(chrome.permissions).sort());

    // Does Playwright's page.evaluate carry a user activation? (It matters: if it
    // does, "no gesture" cannot be tested this way and the result must say so.)
    out.activationInsideEvaluate = await target.evaluate(() => (navigator.userActivation
      ? { isActive: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive }
      : 'navigator.userActivation unavailable'));

    out.fire = await target.evaluate(() => window.__probe.fireRequest('evalRequest'));
    out.result = await waitForSlot(target, 'evalRequest', 30_000);
    out.containsAfter = await sw.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] }));
    out.getAllAfter = await sw.evaluate(() => chrome.permissions.getAll());
    out.permEventsPanel = await target.evaluate(() => JSON.parse(JSON.stringify(window.__probe.permEvents)));
    out.permEventsSW = await sw.evaluate(() => JSON.parse(JSON.stringify(self.__swProbe.permEvents)));
    out.apiAfter = {
      panelTypeof: await target.evaluate(() => typeof chrome.bookmarks),
      swTypeof: await sw.evaluate(() => typeof chrome.bookmarks),
    };
    // Is a second request rejected while the first is outstanding?
    out.secondRequestWhileOutstanding = out.result.slot && out.result.slot.state === 'pending'
      ? await waitForSlot(
        await (async () => { await target.evaluate(() => window.__probe.fireRequest('second')); return target; })(),
        'second', 8_000)
      : 'skipped (first request settled)';

    // request() from the service worker — no document, so no gesture is possible.
    out.requestFromSW = await Promise.race([
      sw.evaluate(async () => {
        try { return { state: 'resolved', value: await chrome.permissions.request({ permissions: ['bookmarks'] }) }; }
        catch (e) { return { state: 'rejected', error: String(e && e.message || e) }; }
      }),
      sleep(10_000).then(() => ({ state: 'still pending after 10 s' })),
    ]);
  } finally {
    record('B1', out);
    await context.close();
  }
  expect(out.manifest.optional_permissions).toEqual(['bookmarks']);
});

// ===========================================================================
// PART B2 — optional permission, request() from a REAL click
// ===========================================================================
test('B2: permissions.request for an optional bookmarks permission, real click', async () => {
  test.setTimeout(150_000);
  const dir = writeExtension('optional');
  const { context, sw, id } = await launch(dir);
  const out = { variant: 'optional', extensionId: id, scenario: 'request() fired from a trusted click handler' };
  try {
    const panels = await openPanels(context, sw, id);
    out.panelNotes = { sidePanelOpen: panels.notes.sidePanelOpen, contexts: panels.notes.contexts };
    const target = panels.sidepanel || panels.tab;
    out.requestedFrom = panels.sidepanel
      ? 'real side panel document (Playwright Page)'
      : 'panel.html opened as a tab — Playwright exposes no Page for the SIDE_PANEL context';

    out.beforeClickActivation = await target.evaluate(() => (navigator.userActivation
      ? { isActive: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive } : null));
    await target.click('#req').catch((e) => { out.clickError = String(e && e.message || e); });
    out.result = await waitForSlot(target, 'clickRequest', 30_000);
    out.afterClickActivation = await target.evaluate(() => (navigator.userActivation
      ? { isActive: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive } : null));

    out.containsAfter = {
      fromSW: await sw.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] })),
      fromPanel: await target.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] })),
    };
    out.getAllAfter = await sw.evaluate(() => chrome.permissions.getAll());
    out.permEventsPanel = await target.evaluate(() => JSON.parse(JSON.stringify(window.__probe.permEvents)));
    out.permEventsSW = await sw.evaluate(() => JSON.parse(JSON.stringify(self.__swProbe.permEvents)));
    out.apiAfter = {
      panelTypeof: await target.evaluate(() => typeof chrome.bookmarks),
      swTypeof: await sw.evaluate(() => typeof chrome.bookmarks),
      panelBind: await target.evaluate(() => window.__probe.bindBookmarkEvents()),
    };
  } finally {
    record('B2', out);
    await context.close();
  }
  expect(true).toBe(true);
});

// ===========================================================================
// PART B3 — a profile where the optional permission is ALREADY granted
//
// The prompt itself cannot be answered in this harness, so the granted state is
// produced by patching the on-disk profile that Chrome writes the grant into, and
// the probe reports honestly whether that worked. Everything downstream of the
// grant (contains(), onAdded/onRemoved, whether the SW sees chrome.bookmarks at
// its next start, whether remove() needs a gesture) is then measurable.
// ===========================================================================
test('B3: behaviour once the optional bookmarks permission is granted in the profile', async () => {
  test.setTimeout(180_000);
  const dir = writeExtension('optional');
  const profile = path.join(OUT, 'probe-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  const out = { profile };

  // Pass 1: create the profile, then shut down so the prefs are flushed.
  {
    const { context, sw, id } = await launch(dir, { userDataDir: profile });
    out.extensionId = id;
    out.pass1 = {
      contains: await sw.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] })),
      getAll: await sw.evaluate(() => chrome.permissions.getAll()),
      swTypeofBookmarks: await sw.evaluate(() => typeof chrome.bookmarks),
    };
    await context.close();
  }

  // Patch whichever prefs file holds this extension's granted permissions.
  const candidates = ['Default/Preferences', 'Default/Secure Preferences', 'Preferences', 'Secure Preferences']
    .map((p) => path.join(profile, p)).filter((p) => fs.existsSync(p));
  out.prefsFilesPresent = candidates.map((p) => path.relative(profile, p));
  out.patched = [];
  for (const file of candidates) {
    let json;
    try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { out.patched.push({ file, error: String(e) }); continue; }
    const settings = json.extensions && json.extensions.settings && json.extensions.settings[out.extensionId];
    if (!settings) continue;
    const note = { file: path.relative(profile, file), keys: Object.keys(settings).sort() };
    for (const bucket of ['granted_permissions', 'active_permissions']) {
      if (!settings[bucket]) settings[bucket] = { api: [], explicit_host: [], manifest_permissions: [], scriptable_host: [] };
      const api = settings[bucket].api || (settings[bucket].api = []);
      note[bucket + '_before'] = [...api];
      if (!api.includes('bookmarks')) api.push('bookmarks');
      note[bucket + '_after'] = [...api];
    }
    fs.writeFileSync(file, JSON.stringify(json));
    out.patched.push(note);
  }

  // Pass 2: reopen the same profile and measure the granted world.
  const { context, sw, id } = await launch(dir, { userDataDir: profile });
  out.extensionIdPass2 = id;
  try {
    out.pass2 = {
      contains: await sw.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] })),
      getAll: await sw.evaluate(() => chrome.permissions.getAll()),
      swTypeofBookmarks: await sw.evaluate(() => typeof chrome.bookmarks),
      swBoundBookmarksAtStartup: await sw.evaluate(() => self.__swProbe.boundAtStartup),
    };
    out.grantTookEffect = out.pass2.contains === true;

    const panels = await openPanels(context, sw, id);
    const target = panels.sidepanel || panels.tab;
    out.panelObservedIn = panels.sidepanel ? 'real side panel document' : 'panel.html opened as a tab';
    out.panel = {
      typeofBookmarks: await target.evaluate(() => typeof chrome.bookmarks),
      contains: await target.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] })),
      bind: await target.evaluate(() => window.__probe.bindBookmarkEvents()),
      getTree: await target.evaluate(async () => {
        try {
          if (!chrome.bookmarks) return 'chrome.bookmarks undefined';
          const t = await chrome.bookmarks.getTree();
          return { ok: true, roots: (t[0].children || []).map((c) => ({ id: c.id, title: c.title })) };
        } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      }),
    };

    // Live events reaching a panel that only has the permission optionally.
    if (out.grantTookEffect) {
      const before = await target.evaluate(() => window.__probe.bmEvents.length);
      await sw.evaluate(async () => {
        const roots = (await chrome.bookmarks.getTree())[0].children || [];
        const n = await chrome.bookmarks.create({ parentId: roots[0].id, title: 'Live', url: 'http://127.0.0.1/live' });
        await chrome.bookmarks.update(n.id, { title: 'Live renamed' });
        await chrome.bookmarks.move(n.id, { parentId: roots[1].id });
        await chrome.bookmarks.remove(n.id);
      });
      await sleep(700);
      out.liveEvents = {
        before,
        after: await target.evaluate(() => window.__probe.bmEvents.length),
        events: await target.evaluate(() => JSON.parse(JSON.stringify(window.__probe.bmEvents))),
        swEvents: await sw.evaluate(() => JSON.parse(JSON.stringify(self.__swProbe.bmEvents))),
      };
    }

    // Does permissions.remove() need a gesture? Try it without one first.
    out.removeWithoutGesture = await Promise.race([
      target.evaluate(async () => {
        try { return { state: 'resolved', value: await chrome.permissions.remove({ permissions: ['bookmarks'] }) }; }
        catch (e) { return { state: 'rejected', error: String(e && e.message || e) }; }
      }),
      sleep(10_000).then(() => ({ state: 'still pending after 10 s' })),
    ]);
    await sleep(500);
    out.afterRemove = {
      contains: await sw.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] })),
      panelTypeof: await target.evaluate(() => typeof chrome.bookmarks),
      swTypeof: await sw.evaluate(() => typeof chrome.bookmarks),
      panelCall: await target.evaluate(async () => {
        try { if (!chrome.bookmarks) return 'chrome.bookmarks is undefined'; await chrome.bookmarks.getTree(); return 'call succeeded'; }
        catch (e) { return 'threw: ' + String(e && e.message || e); }
      }),
      permEventsPanel: await target.evaluate(() => JSON.parse(JSON.stringify(window.__probe.permEvents))),
      permEventsSW: await sw.evaluate(() => JSON.parse(JSON.stringify(self.__swProbe.permEvents))),
    };
  } finally {
    record('B3', out);
    await context.close();
  }
  expect(typeof out.grantTookEffect).toBe('boolean');
});

// ===========================================================================
// PART B5 — control: an optional permission that shows NO warning.
//
// If a warning-free optional permission is granted by the very same call that
// leaves "bookmarks" pending forever, then the request plumbing in the panel
// document works and the only unmeasurable part is the human answering the prompt.
// It also measures, for real, whether a grant makes the API usable in an
// already-loaded document with no reload.
// ===========================================================================
test('B5: control — a warning-free optional permission requested from the same button', async () => {
  test.setTimeout(150_000);
  const dir = writeExtension('optional-nowarn');
  const { context, sw, id } = await launch(dir);
  const out = { extensionId: id };
  try {
    out.manifest = await sw.evaluate(() => chrome.runtime.getManifest());
    const panels = await openPanels(context, sw, id);
    const target = panels.sidepanel || panels.tab;
    out.requestedFrom = panels.sidepanel ? 'real side panel document' : 'panel.html opened as a tab';

    out.before = {
      containsAlarms: await sw.evaluate(() => chrome.permissions.contains({ permissions: ['alarms'] })),
      panelTypeofAlarms: await target.evaluate(() => typeof chrome.alarms),
      swTypeofAlarms: await sw.evaluate(() => typeof chrome.alarms),
      getAll: await sw.evaluate(() => chrome.permissions.getAll()),
    };

    await target.evaluate(() => { window.__probe.nextPerms = ['alarms']; });
    await target.click('#req2').catch((e) => { out.clickError = String(e && e.message || e); });
    out.alarmsResult = await waitForSlot(target, 'clickRequest2', 20_000);

    out.afterAlarms = {
      containsAlarms: await sw.evaluate(() => chrome.permissions.contains({ permissions: ['alarms'] })),
      getAll: await sw.evaluate(() => chrome.permissions.getAll()),
      // The decisive one: no reload happened between `before` and here.
      panelTypeofAlarms: await target.evaluate(() => typeof chrome.alarms),
      swTypeofAlarms: await sw.evaluate(() => typeof chrome.alarms),
      panelCallWorks: await target.evaluate(async () => {
        try { if (!chrome.alarms) return 'chrome.alarms undefined'; await chrome.alarms.getAll(); return 'call succeeded'; }
        catch (e) { return 'threw: ' + String(e && e.message || e); }
      }),
      panelCanAddListener: await target.evaluate(() => {
        try { chrome.alarms.onAlarm.addListener(() => {}); return 'addListener ok'; }
        catch (e) { return 'threw: ' + String(e && e.message || e); }
      }),
      permEventsPanel: await target.evaluate(() => JSON.parse(JSON.stringify(window.__probe.permEvents))),
      permEventsSW: await sw.evaluate(() => JSON.parse(JSON.stringify(self.__swProbe.permEvents))),
    };

    // Now the warning-bearing one, from the identical code path.
    await target.evaluate(() => { window.__probe.nextPerms = ['bookmarks']; });
    await target.click('#req2').catch((e) => { out.clickError2 = String(e && e.message || e); });
    out.bookmarksResult = await waitForSlot(target, 'clickRequest2', 20_000);
    out.afterBookmarks = {
      contains: await sw.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] })),
      panelTypeof: await target.evaluate(() => typeof chrome.bookmarks),
    };
  } finally {
    record('B5', out);
    await context.close();
  }
  expect(out.manifest.optional_permissions).toContain('alarms');
});

// ===========================================================================
// PART B4 — the same click, but with a real X server (xvfb), in case the
// permission bubble behaves differently when there is somewhere to draw it.
//   HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose -f tests/docker-compose.yml \
//     run --rm e2e xvfb-run --auto-servernum --server-args='-screen 0 1920x1080x24' \
//     VT_TEST_DIR=./probes playwright test 90-bookmarks-probe.spec.js --reporter=line --retries=0 -g B4
// ===========================================================================
test('@headed B4: optional permission request under a real X server', async () => {
  test.skip(!process.env.DISPLAY, 'needs xvfb (DISPLAY unset)');
  test.setTimeout(150_000);
  const dir = writeExtension('optional');
  const { context, sw, id } = await launch(dir, { headed: true });
  const out = { display: process.env.DISPLAY, extensionId: id };
  try {
    const panels = await openPanels(context, sw, id);
    out.panelNotes = panels.notes;
    const target = panels.sidepanel || panels.tab;
    out.requestedFrom = panels.sidepanel ? 'real side panel document' : 'panel.html opened as a tab';
    await target.click('#req').catch((e) => { out.clickError = String(e && e.message || e); });
    out.result = await waitForSlot(target, 'clickRequest', 30_000);
    out.containsAfter = await sw.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] }));
    out.permEventsPanel = await target.evaluate(() => JSON.parse(JSON.stringify(window.__probe.permEvents)));
    out.apiAfter = {
      panelTypeof: await target.evaluate(() => typeof chrome.bookmarks),
      swTypeof: await sw.evaluate(() => typeof chrome.bookmarks),
    };
  } finally {
    record('B4', out);
    await context.close();
  }
  expect(true).toBe(true);
});
