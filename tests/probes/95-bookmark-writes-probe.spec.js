// 95-bookmark-writes-probe — THROWAWAY platform probe, "Probe 13" in .agent/probe-results.md.
//
// This is NOT a regression test of Vertical Tabs. It loads disposable MV3 extensions (generated into
// tests/output/probe-ext-95/ at run time) and measures what Chromium 151.0.7922.34 does for the chrome.bookmarks
// WRITE calls the bookmark-folders feature would make, because CLAUDE.md §7.2 forbids asserting Chrome API
// behaviour from memory. Nothing in this file asserts a Chrome behaviour: every test only checks that the
// complete record described by its PASS criterion was produced. What the numbers mean is decided afterwards,
// in probe-results.md, from tests/output/bookmark-writes-probe.json.
//
// PASS criteria (written before the first run; the long form is §D.4 of the design):
//   P1  move within one parent: folder [A,B,C,D]; every source s in 0..3 and argument k in
//       {0,1,2,3,4,9,omitted} = 4 x 7 = 28 rows: child order, onMoved payload, thrown message. None missing.
//       (§D.4 lists k in {0..4}+9, which is six values, and says 28 rows; `index omitted` is the seventh.)
//   P2  move into another folder (G=[X,Y,Z]) at index {0,1,2,3,omitted,9}, for a leaf and for a folder with three
//       children: final position, payload, id unchanged, subtree identical, onMoved once with the old values.
//   P3  create a folder at index {0,mid,len,len+5,omitted} in a 4-child folder; node has no `url` key;
//       create({parentId:'0'}) outcome with the exact message and whether the tree changed.
//   P4  create(folder), update(folder title), update(link title), move same parent, move cross parent,
//       removeTree(folder of 3): ordered events in the panel AND the SW, eventBeforeResolve, one onMoved per
//       move, number of onRemoved for removeTree, info.node.children, onChanged url key for a folder.
//   P5  ids '0','1','2': outcome of update(title), move(->folder), remove, removeTree; move(child->'0');
//       create under '0'; whether any node carries `unmodifiable`; value of BookmarkTreeNodeUnmodifiable.
//   P6  move(F,{parentId:F}) and move(F,{parentId:grandchild}): messages, and the tree before/after deep-equal.
//   P7  optional permission + synthesised grant, from the PANEL document: create/update/move(index)/removeTree
//       resolve; ungranted the API is unreachable; after permissions.remove() each call fails with a message
//       containing 'is not available in this context'.
//   P8  HTML5 drag of a <button draggable> with the real mouse: dragstart, getData inside drop, drop, dragend;
//       second variant removes the source node during dragover: does dragend / drop still fire.
//   P9  update with '', '   ', a 5 000-char string and a title with newlines, on a folder and on a link: stored title.
//   P10 500 sequential move and 500 sequential update: 0 errors, total time.
//   P11 after the P1/P2 operations, children[i].index === i in every folder (getChildren and getTree).
//   P12 managed bookmarks / EditBookmarksEnabled=false: behaviour with a policy file in the container, or the
//       declaration that the harness cannot apply one.
//
// Run (probes live outside testDir; this file must run in the e2e container, never on the host):
//   HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose -f tests/docker-compose.yml \
//     run --rm e2e env VT_TEST_DIR=./probes playwright test 95-bookmark-writes-probe.spec.js \
//     --reporter=list --retries=0
// One part only: add `-g "core:"`, `-g "P5:"`, `-g "P7:"`, `-g "P8:"` or `-g "P12:"`.
// P12 needs a managed-policy directory, which the default container user cannot write; see the P12 block. It ran in
// a container started as root: (a) directories made world-writable and the files written by the test process, and
// (b) files put there by root (root-owned, 0644, in a 0755 directory) with VT_P12_PREPLACED=<case name>.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect, chromium } = require('@playwright/test');

const OUT = process.env.OUT_DIR || path.resolve(__dirname, '../output');
const PROBE_ROOT = path.join(OUT, 'probe-ext-95');
const REPORT = path.join(OUT, 'bookmark-writes-probe.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Merges one record into the JSON report and prints a ONE-line summary (the raw JSON is in the report file). */
function record(key, value, summary) {
  fs.mkdirSync(OUT, { recursive: true });
  const prev = fs.existsSync(REPORT) ? JSON.parse(fs.readFileSync(REPORT, 'utf8')) : {};
  prev[key] = value;
  fs.writeFileSync(REPORT, JSON.stringify(prev, null, 2));
  console.log(`===== ${key}: ${summary || ''} (${JSON.stringify(value).length} bytes in ${path.basename(REPORT)})`);
}

// ---------------------------------------------------------------------------------------------------------
// In-page recorder. The SAME source runs in the service worker and in the panel document. It listens to every
// chrome.bookmarks event, and `call()` runs one chrome.bookmarks method and records: whether it threw
// synchronously or rejected, the exact message, the resolved value, how long it took, and every event that
// arrived from the moment of the call until 200 ms (`quiet`) after the last one. `seq` is one counter shared by
// event listeners and by "the promise resolved", so "event before resolve" is an ordering fact, not a clock
// comparison. No backticks and no dollar-brace inside: this text is embedded in a template literal.
// ---------------------------------------------------------------------------------------------------------
const RECORDER_JS = String.raw`
(function (g) {
  const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  const msg = (e) => String((e && e.message) || e);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const R = { seq: 0, events: [], bound: [], bindState: 'not-run', bootId: Math.random().toString(36).slice(2) };
  g.__rec = R;
  const mark = () => ++R.seq;
  const NAMES = ['onCreated', 'onChanged', 'onMoved', 'onRemoved', 'onChildrenReordered', 'onImportBegan', 'onImportEnded'];
  R.bind = () => {
    if (R.bindState === 'bound') return R.bindState;
    if (!g.chrome || !g.chrome.bookmarks) { R.bindState = 'chrome.bookmarks undefined'; return R.bindState; }
    for (const n of NAMES) {
      const ev = g.chrome.bookmarks[n];
      if (!ev || typeof ev.addListener !== 'function') continue;
      ev.addListener((...args) => { R.events.push({ kind: n, seq: mark(), wall: Date.now(), args: clone(args) }); });
      R.bound.push(n);
    }
    R.bindState = 'bound';
    return R.bindState;
  };
  R.quiet = async (quietMs, maxMs) => {
    const t0 = performance.now();
    let n = R.events.length;
    let last = t0;
    for (;;) {
      await wait(20);
      const now = performance.now();
      if (R.events.length !== n) { n = R.events.length; last = now; }
      if (now - last >= quietMs) return { ms: Math.round(now - t0), capped: false };
      if (now - t0 >= maxMs) return { ms: Math.round(now - t0), capped: true };
    }
  };
  R.call = async (label, method, args) => {
    const evStart = R.events.length;
    const t0 = performance.now();
    mark();
    let p; let threw = null; let error = null; let raw; let resolved = false;
    try { p = g.chrome.bookmarks[method].apply(g.chrome.bookmarks, args); }
    catch (e) { threw = 'sync'; error = msg(e); }
    if (!threw) {
      try { raw = await p; resolved = true; } catch (e) { threw = 'async'; error = msg(e); }
    }
    const resolveSeq = mark();
    const resolveMs = +(performance.now() - t0).toFixed(2);
    const quiet = await R.quiet(200, 3000);
    const evs = R.events.slice(evStart);
    return {
      label, method, args: clone(args), resolved, threw, error,
      resultType: Object.prototype.toString.call(raw), result: clone(raw), resolveMs, quiet,
      events: evs.map((e) => ({ kind: e.kind, args: e.args, beforeResolve: e.seq < resolveSeq })),
      nBeforeResolve: evs.filter((e) => e.seq < resolveSeq).length,
      nAfterResolve: evs.filter((e) => e.seq > resolveSeq).length,
      eventBeforeResolve: evs.length ? evs.every((e) => e.seq < resolveSeq) : null,
    };
  };
  const slim = (n) => ({ id: n.id, index: n.index, parentId: n.parentId, title: n.title, hasUrl: 'url' in n, url: n.url });
  R.children = async (id) => (await g.chrome.bookmarks.getChildren(id)).map(slim);
  R.get = async (ids) => clone(await g.chrome.bookmarks.get(ids));
  R.tree = async () => clone(await g.chrome.bookmarks.getTree());
  R.subtree = async (id) => clone(await g.chrome.bookmarks.getSubTree(id));
  async function mk(parentId, spec) {
    const out = [];
    for (const s of spec) {
      const a = { parentId, title: s.title };
      if (s.url) a.url = s.url;
      const n = await g.chrome.bookmarks.create(a);
      out.push({ id: n.id, title: n.title, children: s.children ? await mk(n.id, s.children) : [] });
    }
    return out;
  }
  // Setup helper (not a measurement). Waits until its own events have drained so they cannot leak into the
  // next measured call.
  R.make = async (parentId, spec) => { const out = await mk(parentId, spec); await R.quiet(150, 3000); return out; };
  R.audit = async () => {
    const tree = await g.chrome.bookmarks.getTree();
    const issues = []; let folders = 0; let children = 0;
    async function walk(n) {
      if (!n.children) return;
      folders++;
      const viaGetChildren = await g.chrome.bookmarks.getChildren(n.id);
      n.children.forEach((c, i) => {
        children++;
        if (c.index !== i) issues.push({ via: 'getTree', parentId: n.id, position: i, index: c.index, id: c.id });
        if (viaGetChildren[i] === undefined || viaGetChildren[i].id !== c.id) issues.push({ via: 'order', parentId: n.id, position: i, id: c.id });
      });
      viaGetChildren.forEach((c, i) => { if (c.index !== i) issues.push({ via: 'getChildren', parentId: n.id, position: i, index: c.index, id: c.id }); });
      if (viaGetChildren.length !== n.children.length) issues.push({ via: 'length', parentId: n.id, a: viaGetChildren.length, b: n.children.length });
      for (const c of n.children) await walk(c);
    }
    for (const r of tree) await walk(r);
    return { folders, children, issues };
  };
  R.bench = async (kind, n, ids, parentId) => {
    const times = []; const errors = [];
    // Every move is a REAL one: the child at the last position goes to index 0 (so an onMoved is owed for each),
    // never a no-op. (A first version cycled (i*7)%10 and converged to a fixed point after ~10 moves.)
    const order = ids.slice();
    const evStart = R.events.length;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      const a = performance.now();
      try {
        if (kind === 'move') { const id = order.pop(); order.unshift(id); await g.chrome.bookmarks.move(id, { parentId, index: 0 }); }
        else await g.chrome.bookmarks.update(ids[i % ids.length], { title: 'bench ' + i });
      } catch (e) { errors.push({ i, error: msg(e) }); }
      times.push(performance.now() - a);
    }
    const totalMs = performance.now() - t0;
    const quiet = await R.quiet(500, 5000);
    const evs = R.events.slice(evStart);
    const sorted = times.slice().sort((x, y) => x - y);
    const q = (p) => +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(2);
    const counts = {};
    for (const e of evs) counts[e.kind] = (counts[e.kind] || 0) + 1;
    return { kind, n, errors: errors.length, firstErrors: errors.slice(0, 3), totalMs: Math.round(totalMs),
      meanMs: +(totalMs / n).toFixed(2), p50Ms: q(0.5), p95Ms: q(0.95), maxMs: +sorted[sorted.length - 1].toFixed(2),
      eventCounts: counts, quiet };
  };
})(globalThis);
`;

const PANEL_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>probe panel</title></head>
<body style="font:14px sans-serif;margin:8px"><pre id="log"></pre>
<script type="module" src="panel.js"></script></body></html>`;

// Top-level and synchronous, as MV3 requires for listeners registered at service worker start.
const SW_JS = RECORDER_JS + `
self.__rec.bind();
chrome.runtime.onMessage.addListener(() => {});
`;

const PANEL_JS = RECORDER_JS + `
window.__rec.bind();
window.__rec.ready = true;
document.getElementById('log').textContent = 'ready ' + window.__rec.bindState;
`;

function writeExtension(variant) {
  const dir = path.join(PROBE_ROOT, variant);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    manifest_version: 3,
    name: `bookmark writes probe (${variant})`,
    version: '1.0.0',
    minimum_chrome_version: '120',
    side_panel: { default_path: 'panel.html' },
    action: { default_title: 'probe' },
    background: { service_worker: 'sw.js', type: 'module' },
    permissions: variant === 'required' ? ['sidePanel', 'tabs', 'storage', 'bookmarks'] : ['sidePanel', 'tabs', 'storage'],
  };
  if (variant === 'optional') manifest.optional_permissions = ['bookmarks'];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'panel.html'), PANEL_HTML);
  fs.writeFileSync(path.join(dir, 'panel.js'), PANEL_JS);
  fs.writeFileSync(path.join(dir, 'sw.js'), SW_JS);
  return dir;
}

// Copied from 90-bookmarks-probe.spec.js (not shared: the probes stay independent), with launch/SW timeouts raised
// because the host is heavily loaded.
async function launch(dir, { userDataDir = '' } = {}) {
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    timeout: 120_000,
    args: [
      `--disable-extensions-except=${dir}`,
      `--load-extension=${dir}`,
      ...(process.env.VT_CHROMIUM_NO_SANDBOX !== '0' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    ],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 90_000 });
  return { context, sw, id: sw.url().split('/')[2] };
}

/** The panel document as a TAB, which is what 90-bookmarks-probe and the e2e harness use (no Page exists for the real side panel in headless). */
async function openPanelTab(context, id) {
  const tab = await context.newPage();
  await tab.goto(`chrome-extension://${id}/panel.html?as=tab`);
  await tab.waitForFunction(() => window.__rec && window.__rec.ready === true, null, { timeout: 60_000 });
  return tab;
}

async function openEnv(variant, { userDataDir = '' } = {}) {
  const dir = writeExtension(variant);
  const { context, sw, id } = await launch(dir, { userDataDir });
  const page = await openPanelTab(context, id);
  const env = { variant, context, sw, id, page };
  env.userAgent = await sw.evaluate(() => navigator.userAgent);
  env.boot = await bootIds(env);
  env.roots = await rootsOf(env);
  const bar = env.roots.find((r) => r.folderType === 'bookmarks-bar');
  const other = env.roots.find((r) => r.folderType === 'other');
  env.bar = bar && bar.id;
  env.other = other && other.id;
  return env;
}

const ctxOf = (env, who) => (who === 'sw' ? env.sw : env.page);
const inCtx = (env, who, fn, arg) => ctxOf(env, who).evaluate(fn, arg);
const bootIds = async (env) => ({
  sw: await inCtx(env, 'sw', () => globalThis.__rec.bootId),
  page: await inCtx(env, 'page', () => globalThis.__rec.bootId),
});
const rootsOf = (env) => inCtx(env, 'page', async () => {
  const t = await chrome.bookmarks.getTree();
  return t[0].children.map((c) => ({
    id: c.id, title: c.title, folderType: c.folderType || null, keys: Object.keys(c).sort(),
    childCount: (c.children || []).length,
  }));
});
const make = (env, who, parentId, spec) => inCtx(env, who, ([p, s]) => globalThis.__rec.make(p, s), [parentId, spec]);
const kids = (env, who, id) => inCtx(env, who, (i) => globalThis.__rec.children(i), id);
const treeJson = async (env) => JSON.stringify(await inCtx(env, 'page', () => globalThis.__rec.tree()));

/** One measured chrome.bookmarks call in `who` ('page' = the panel document, 'sw'), plus the events the OTHER context saw. */
async function call(env, who, label, method, ...args) {
  const other = who === 'sw' ? 'page' : 'sw';
  const otherStart = await inCtx(env, other, () => globalThis.__rec.events.length);
  const rec = await inCtx(env, who, ([l, m, a]) => globalThis.__rec.call(l, m, a), [label, method, args]);
  const otherEvents = await inCtx(env, other, (s) => globalThis.__rec.events.slice(s).map((e) => ({ kind: e.kind, args: e.args })), otherStart);
  rec.writer = who === 'sw' ? 'service worker' : 'panel document';
  rec.panelEvents = who === 'page' ? rec.events.map((e) => ({ kind: e.kind, args: e.args })) : otherEvents;
  rec.swEvents = who === 'sw' ? rec.events.map((e) => ({ kind: e.kind, args: e.args })) : otherEvents;
  return rec;
}

const ord = (list) => list.map((c) => c.title).join('');
const idxs = (list) => list.map((c) => c.index);
const lnk = (t) => ({ title: t, url: 'http://127.0.0.1/' + encodeURIComponent(t) });
const fld = (t, children) => ({ title: t, children: children || [] });
const slimCall = (c) => ({
  writer: c.writer, resolved: c.resolved, threw: c.threw, error: c.error, resultType: c.resultType,
  result: c.result && typeof c.result === 'object'
    ? { id: c.result.id, index: c.result.index, parentId: c.result.parentId, title: c.result.title, keys: Object.keys(c.result).sort() }
    : c.result,
  resolveMs: c.resolveMs, quiet: c.quiet, eventBeforeResolve: c.eventBeforeResolve,
  nBeforeResolve: c.nBeforeResolve, nAfterResolve: c.nAfterResolve,
});
const ofKind = (events, kind) => events.filter((e) => e.kind === kind);
const movedPayloads = (events) => ofKind(events, 'onMoved').map((e) => ({ id: e.args[0], ...e.args[1] }));
const kinds = (events) => events.map((e) => e.kind);

// =========================================================================================================
// CORE — required `bookmarks`: P1 P2 P3 P4 P6 P9 P11 P10, in one browser so that P11 audits what P1/P2 left.
// Each part runs in its own try/catch: a part that throws is recorded as such and the rest still run.
// =========================================================================================================
const LETTERS = ['A', 'B', 'C', 'D'];
const P1_K = [0, 1, 2, 3, 4, 9, 'omitted'];

/** Both candidate rules, applied to the order before the move. M1: k is the index in the list AFTER the source was removed. M2: k is a position in the list BEFORE removal (final = k > s ? k - 1 : k). */
function predict(before, s, k) {
  const place = (to) => { const a = before.split(''); const [x] = a.splice(s, 1); a.splice(Math.min(to, a.length), 0, x); return a.join(''); };
  if (k === 'omitted') return { M1: place(before.length), M2: place(before.length), note: 'both rules read "omitted" as append' };
  if (typeof k !== 'number' || k < 0) return { M1: null, M2: null, note: 'no prediction for a negative index' };
  return { M1: place(k), M2: place(k > s ? k - 1 : k), note: null };
}

async function runP1(env, kind, ks, label) {
  const rows = [];
  for (const s of [0, 1, 2, 3]) {
    for (const k of ks) {
      const items = LETTERS.map((t) => (kind === 'link' ? lnk(t) : fld(t, [lnk(t + '-child')])));
      const [F] = await make(env, 'page', env.bar, [fld(`${label} ${kind} s${s} k${k}`, items)]);
      const before = await kids(env, 'page', F.id);
      const row = {
        kind, s, k, parentId: F.id, source: { id: F.children[s].id, title: LETTERS[s] },
        before: ord(before), beforeIndices: idxs(before),
      };
      row.beforeVerified = row.before === 'ABCD' && row.beforeIndices.join() === '0,1,2,3';
      const arg = k === 'omitted' ? { parentId: F.id } : { parentId: F.id, index: k };
      const c = await call(env, 'page', `${label} ${kind} s=${s} k=${k}`, 'move', row.source.id, arg);
      const after = await kids(env, 'page', F.id);
      row.args = arg;
      row.call = slimCall(c);
      row.after = ord(after);
      row.afterIndices = idxs(after);
      row.onMovedPanel = movedPayloads(c.panelEvents);
      row.onMovedSw = movedPayloads(c.swEvents);
      row.eventKindsPanel = kinds(c.panelEvents);
      row.eventKindsSw = kinds(c.swEvents);
      row.predicted = predict(row.before, s, k);
      row.fits = c.resolved && row.predicted.M1 !== null
        ? { M1: row.after === row.predicted.M1, M2: row.after === row.predicted.M2 }
        : null;
      rows.push(row);
      console.log(`${label} ${kind} s=${s} k=${k}: ${row.before} -> ${row.after} ${c.resolved ? 'resolved' : 'THREW(' + c.threw + '): ' + c.error} onMoved=${JSON.stringify(row.onMovedPanel.map((m) => [m.oldIndex, m.index]))}`);
    }
  }
  return rows;
}

function p1Verdict(rows) {
  const links = rows.filter((r) => r.kind === 'link' && typeof r.k === 'number');
  const complete = rows.length === 28 && rows.every((r) => r.beforeVerified && r.call && r.after !== undefined);
  const inRange = (maxK) => links.filter((r) => r.k <= maxK);
  const misses = (rule, maxK) => inRange(maxK).filter((r) => !(r.call.resolved && r.fits && r.fits[rule])).map((r) => `s${r.s}k${r.k}`);
  const m1 = misses('M1', 3);
  const m2 = misses('M2', 4);
  return {
    rowsRecorded: rows.length, complete,
    M1_cellsNotFitting_k0to3: m1, M2_cellsNotFitting_k0to4: m2,
    M1_fitsAllInRange: m1.length === 0, M2_fitsAllInRange: m2.length === 0,
    verdict: m1.length === 0 && m2.length > 0 ? 'M1' : m2.length === 0 && m1.length > 0 ? 'M2' : m1.length === 0 && m2.length === 0 ? 'both-fit(indistinguishable)' : 'neither',
    k4_M1_note: 'under M1 k=4 is out of range for a 4-child folder (max final index 3); the raw rows show what Chrome did',
  };
}

test('core: P1 P2 P3 P4 P6 P9 P10 P11 (required bookmarks permission; writes from the panel document and the service worker)', async () => {
  test.setTimeout(2_400_000);
  const env = await openEnv('required');
  const failed = [];
  const part = async (name, fn) => {
    try { await fn(); } catch (e) {
      failed.push(name);
      record(`${name}-ERROR`, { error: String((e && e.stack) || e) }, 'THREW');
    }
  };
  record('env', {
    userAgent: env.userAgent, roots: env.roots, startedAt: new Date().toISOString(),
    loadavgAtStart: os.loadavg(), node: process.version,
    note: 'the panel document is panel.html opened as a tab; writes come from it unless a row says "service worker"',
  }, env.userAgent);

  try {
    // ---------------------------------------------------------------- P1
    let p1Rows = null;
    await part('P1', async () => {
      p1Rows = await runP1(env, 'link', P1_K, 'P1');
      // Supplementary, not part of the 28: a negative index, and k = len+1 (the first value past "append").
      const sup = (await runP1(env, 'link', [-1, 5], 'P1sup'));
      const verdict = p1Verdict(p1Rows);
      record('P1', { verdict, rows: p1Rows, supplementaryMinus1AndLenPlus1: sup }, `rows=${p1Rows.length} verdict=${verdict.verdict}`);
      expect(p1Rows.length).toBe(28);
    });
    await part('P1b', async () => {
      // Supplementary: the same 28 cells with FOLDERS as the four items, to see whether item type matters.
      const rows = await runP1(env, 'folder', P1_K, 'P1b');
      const same = p1Rows ? rows.every((r) => {
        const l = p1Rows.find((x) => x.s === r.s && x.k === r.k);
        return !!l && l.after === r.after && l.call.resolved === r.call.resolved && l.call.error === r.call.error;
      }) : null;
      record('P1b', { rows, identicalToLinkGridInOrderAndOutcome: same }, `rows=${rows.length} identicalToLinks=${same}`);
    });

    // ---------------------------------------------------------------- P2
    await part('P2', async () => {
      const rows = [];
      for (const item of ['leaf', 'folder3']) {
        for (const index of [0, 1, 2, 3, 4, 'omitted', 9]) {
          const moveSpec = item === 'leaf' ? lnk('M') : fld('M', [lnk('m1'), lnk('m2'), lnk('m3')]);
          const [F, G] = await make(env, 'page', env.bar, [
            fld(`P2 ${item} i${index} F`, [lnk('p'), moveSpec, lnk('q')]),
            fld(`P2 ${item} i${index} G`, [lnk('X'), lnk('Y'), lnk('Z')]),
          ]);
          const moved = F.children[1];
          const strip = (n) => ({ id: n.id, title: n.title, index: n.index, parentId: n.parentId, children: (n.children || []).map(strip) });
          const subBefore = item === 'leaf' ? null : (await inCtx(env, 'page', (id) => globalThis.__rec.subtree(id), moved.id))[0];
          const fBefore = await kids(env, 'page', F.id);
          const gBefore = await kids(env, 'page', G.id);
          const arg = index === 'omitted' ? { parentId: G.id } : { parentId: G.id, index };
          const c = await call(env, 'page', `P2 ${item} index=${index}`, 'move', moved.id, arg);
          const fAfter = await kids(env, 'page', F.id);
          const gAfter = await kids(env, 'page', G.id);
          const nodeAfter = (await inCtx(env, 'page', (id) => globalThis.__rec.get([id]), moved.id).catch((e) => [{ error: String(e) }]))[0];
          const subAfter = item === 'leaf' ? null : (await inCtx(env, 'page', (id) => globalThis.__rec.subtree(id), moved.id).catch(() => [null]))[0];
          const moves = movedPayloads(c.panelEvents);
          rows.push({
            item, index, args: arg, call: slimCall(c),
            fBefore: ord(fBefore), gBefore: ord(gBefore), fAfter: ord(fAfter), gAfter: ord(gAfter),
            gAfterIndices: idxs(gAfter), movedFinalIndexInG: gAfter.findIndex((n) => n.id === moved.id),
            idUnchanged: !!nodeAfter && nodeAfter.id === moved.id, nodeAfterParentId: nodeAfter && nodeAfter.parentId, expectedParentId: G.id,
            subtreeChildrenIdentical: item === 'leaf' ? null
              : !!subAfter && JSON.stringify(strip(subBefore).children) === JSON.stringify(strip(subAfter).children),
            expectedOld: { oldParentId: F.id, oldIndex: 1 },
            onMovedPanel: moves, onMovedSw: movedPayloads(c.swEvents),
            onMovedOnceWithOldValues: c.resolved ? moves.length === 1 && moves[0].oldParentId === F.id && moves[0].oldIndex === 1 : null,
            eventKindsPanel: kinds(c.panelEvents), eventKindsSw: kinds(c.swEvents),
          });
          const r = rows[rows.length - 1];
          console.log(`P2 ${item} index=${index}: G ${r.gBefore} -> ${r.gAfter} (at ${r.movedFinalIndexInG}) ${c.resolved ? 'resolved' : 'THREW(' + c.threw + '): ' + c.error}`);
        }
      }
      record('P2', { rows }, `rows=${rows.length}`);
      expect(rows.length).toBe(14);
    });

    // ---------------------------------------------------------------- P3
    await part('P3', async () => {
      const rows = [];
      for (const index of [0, 1, 2, 3, 4, 5, 9, 'omitted']) {
        const [F] = await make(env, 'page', env.bar, [fld(`P3 i${index}`, LETTERS.map(lnk))]);
        const arg = index === 'omitted' ? { parentId: F.id, title: 'N' } : { parentId: F.id, title: 'N', index };
        const c = await call(env, 'page', `P3 create folder index=${index}`, 'create', arg);
        const after = await kids(env, 'page', F.id);
        rows.push({
          index, role: index === 2 ? 'mid' : index === 4 ? 'len' : index === 9 ? 'len+5' : index === 'omitted' ? 'omitted' : 'extra',
          args: arg, call: slimCall(c), hasUrlKey: c.result && typeof c.result === 'object' ? 'url' in c.result : null,
          after: ord(after), afterIndices: idxs(after),
          createdIndexInChildren: after.findIndex((n) => n.title === 'N'),
          onCreatedPanel: ofKind(c.panelEvents, 'onCreated').map((e) => e.args), onCreatedSw: ofKind(c.swEvents, 'onCreated').map((e) => e.args),
        });
        const r = rows[rows.length - 1];
        console.log(`P3 index=${index}: ${r.after} ${c.resolved ? 'resolved index=' + (c.result && c.result.index) : 'THREW(' + c.threw + '): ' + c.error}`);
      }
      const treeBefore = await treeJson(env);
      const root = await call(env, 'page', 'P3 create under root 0', 'create', { parentId: '0', title: 'P3 root child' });
      const treeAfter = await treeJson(env);
      const rootIdx = await call(env, 'page', 'P3 create under root 0 with index 0', 'create', { parentId: '0', title: 'P3 root child', index: 0 });
      const treeAfter2 = await treeJson(env);
      record('P3', {
        rows,
        createUnderRoot: { call: slimCall(root), treeChanged: treeBefore !== treeAfter, events: root.panelEvents },
        createUnderRootWithIndex0: { call: slimCall(rootIdx), treeChanged: treeAfter !== treeAfter2, events: rootIdx.panelEvents },
      }, `rows=${rows.length} createUnderRoot=${root.resolved ? 'RESOLVED' : root.error}`);
      expect(rows.length).toBe(8);
    });

    // ---------------------------------------------------------------- P3x (supplementary): stale ids
    await part('P3x', async () => {
      const [F] = await make(env, 'page', env.bar, [fld('P3x', [lnk('A'), lnk('B')])]);
      const cases = [
        ['move item -> nonexistent parent', 'move', F.children[0].id, { parentId: '99999' }],
        ['create under nonexistent parent', 'create', { parentId: '99999', title: 'x' }],
        ['update nonexistent id', 'update', '99999', { title: 'x' }],
        ['move nonexistent id', 'move', '99999', { parentId: F.id }],
        ['removeTree nonexistent id', 'removeTree', '99999'],
        ['move item to index -1 in same parent', 'move', F.children[1].id, { parentId: F.id, index: -1 }],
      ];
      const rows = [];
      for (const [label, method, ...args] of cases) {
        const before = await treeJson(env);
        const c = await call(env, 'page', `P3x ${label}`, method, ...args);
        rows.push({ label, call: slimCall(c), treeChanged: before !== (await treeJson(env)), events: kinds(c.panelEvents) });
      }
      record('P3x', { note: 'supplementary (not in the design D.4): the error strings a stale id produces', rows }, `rows=${rows.length}`);
    });

    // ---------------------------------------------------------------- P4
    await part('P4', async () => {
      const res = {};
      for (const who of ['page', 'sw']) {
        const tag = who === 'page' ? 'panel' : 'sw';
        const [F, G, T] = await make(env, who, env.bar, [
          fld(`P4-${tag} F`, LETTERS.map(lnk)),
          fld(`P4-${tag} G`, [lnk('X'), lnk('Y'), lnk('Z')]),
          fld(`P4-${tag} T`, [lnk('T1'), lnk('T2'), lnk('T3')]),
        ]);
        const ops = {};
        ops.createFolder = await call(env, who, 'P4 create(folder)', 'create', { parentId: F.id, title: 'P4 new folder' });
        ops.updateFolderTitle = await call(env, who, 'P4 update(folder title)', 'update', F.id, { title: `P4-${tag} F renamed` });
        ops.updateLinkTitle = await call(env, who, 'P4 update(link title)', 'update', F.children[0].id, { title: 'A renamed' });
        ops.moveSameParent = await call(env, who, 'P4 move same parent (B -> index 3)', 'move', F.children[1].id, { parentId: F.id, index: 3 });
        ops.moveCrossParent = await call(env, who, 'P4 move cross parent (C -> G index 0)', 'move', F.children[2].id, { parentId: G.id, index: 0 });
        ops.removeTree = await call(env, who, 'P4 removeTree(folder with 3 children)', 'removeTree', T.id);
        const out = {};
        for (const [name, c] of Object.entries(ops)) {
          const own = who === 'page' ? c.panelEvents : c.swEvents;
          out[name] = {
            call: slimCall(c), panelEvents: c.panelEvents, swEvents: c.swEvents,
            ownContext: who === 'page' ? 'panel' : 'service worker',
            eventBeforeResolveInWriter: c.eventBeforeResolve, nBeforeResolveInWriter: c.nBeforeResolve, nAfterResolveInWriter: c.nAfterResolve,
            kindsPanel: kinds(c.panelEvents), kindsSw: kinds(c.swEvents),
            onMovedCountPanel: ofKind(c.panelEvents, 'onMoved').length, onMovedCountSw: ofKind(c.swEvents, 'onMoved').length,
            onRemovedCountPanel: ofKind(c.panelEvents, 'onRemoved').length, onRemovedCountSw: ofKind(c.swEvents, 'onRemoved').length,
            ownEventCount: own.length,
          };
        }
        const rm = ofKind(ops.removeTree.panelEvents, 'onRemoved');
        out.removeTreeDetail = {
          onRemovedIdsPanel: rm.map((e) => e.args[0]), removedFolderId: T.id,
          firstOnRemovedInfoKeys: rm[0] ? Object.keys(rm[0].args[1]).sort() : null,
          firstOnRemovedNodeKeys: rm[0] && rm[0].args[1].node ? Object.keys(rm[0].args[1].node).sort() : null,
          firstOnRemovedNodeHasChildren: rm[0] && rm[0].args[1].node ? 'children' in rm[0].args[1].node : null,
          firstOnRemovedNodeChildCount: rm[0] && rm[0].args[1].node && rm[0].args[1].node.children ? rm[0].args[1].node.children.length : null,
          childIds: T.children.map((c) => c.id),
        };
        const ch = ofKind(ops.updateFolderTitle.panelEvents, 'onChanged');
        out.onChangedFolder = { argsPanel: ch.map((e) => e.args), changeInfoKeys: ch[0] ? Object.keys(ch[0].args[1]).sort() : null, hasUrlKey: ch[0] ? 'url' in ch[0].args[1] : null };
        res[tag] = out;
        console.log(`P4 ${tag}: ` + Object.entries(ops).map(([n, c]) => `${n}=[${kinds(who === 'page' ? c.panelEvents : c.swEvents)}] before=${c.eventBeforeResolve}`).join(' | '));
      }
      record('P4', res, 'writers: panel, sw');
      expect(Object.keys(res.panel).length).toBeGreaterThan(5);
    });

    // ---------------------------------------------------------------- P6
    await part('P6', async () => {
      const [F] = await make(env, 'page', env.bar, [fld('P6 F', [fld('C', [fld('G', [lnk('leaf')])]), lnk('L')])]);
      const C = F.children[0];
      const G = C.children[0];
      const cases = [
        ['move(F, parent F)', F.id, { parentId: F.id }],
        ['move(F, parent C = child of F)', F.id, { parentId: C.id }],
        ['move(F, parent G = grandchild of F)', F.id, { parentId: G.id }],
        ['move(F, parent G, index 0)', F.id, { parentId: G.id, index: 0 }],
        ['move(C, parent C)', C.id, { parentId: C.id }],
      ];
      const rows = [];
      for (const [label, id, arg] of cases) {
        const before = await treeJson(env);
        const sub0 = JSON.stringify(await inCtx(env, 'page', (i) => globalThis.__rec.subtree(i), env.bar));
        const c = await call(env, 'page', `P6 ${label}`, 'move', id, arg);
        const after = await treeJson(env);
        const sub1 = JSON.stringify(await inCtx(env, 'page', (i) => globalThis.__rec.subtree(i), env.bar));
        rows.push({ label, args: arg, call: slimCall(c), wholeTreeDeepEqualBeforeAfter: before === after, barSubtreeDeepEqualBeforeAfter: sub0 === sub1, events: kinds(c.panelEvents) });
        console.log(`P6 ${label}: ${c.resolved ? 'RESOLVED' : 'threw(' + c.threw + '): ' + c.error} treeEqual=${before === after}`);
      }
      record('P6', { rows }, `rows=${rows.length}`);
      expect(rows.length).toBe(5);
    });

    // ---------------------------------------------------------------- P9
    await part('P9', async () => {
      const inputs = [
        ['empty', ''], ['three spaces', '   '], ['5000 chars', '0123456789'.repeat(500)],
        ['newlines', 'line1\nline2\r\nline3'], ['tab', 'a\tb'],
        ['padded (supplementary)', '  padded  '], ['Japanese (supplementary)', '日本語のフォルダ'],
      ];
      const rows = [];
      for (const target of ['folder', 'link']) {
        for (const [label, value] of inputs) {
          const [N] = await make(env, 'page', env.bar, [target === 'folder' ? fld('orig') : lnk('orig')]);
          const c = await call(env, 'page', `P9 update ${target} title=${label}`, 'update', N.id, { title: value });
          const stored = (await inCtx(env, 'page', (i) => globalThis.__rec.get([i]), N.id))[0];
          const onChanged = ofKind(c.panelEvents, 'onChanged');
          rows.push({
            target, label, inputLength: value.length, inputJson: value.length <= 40 ? JSON.stringify(value) : null,
            call: slimCall(c), storedLength: stored.title.length, storedEqualsInput: stored.title === value,
            storedJson: stored.title.length <= 40 ? JSON.stringify(stored.title) : null,
            storedHead: stored.title.slice(0, 12), storedTail: stored.title.slice(-12),
            resultTitleLength: c.result && typeof c.result.title === 'string' ? c.result.title.length : null,
            onChangedTitleLength: onChanged[0] && onChanged[0].args[1] ? onChanged[0].args[1].title.length : null,
          });
          const r = rows[rows.length - 1];
          console.log(`P9 ${target} ${label}: ${c.resolved ? 'resolved' : 'threw: ' + c.error} storedLength=${r.storedLength} equal=${r.storedEqualsInput}`);
        }
      }
      record('P9', { rows }, `rows=${rows.length}`);
      expect(rows.length).toBe(14);
    });

    // ---------------------------------------------------------------- P11 (audit what P1..P9 left)
    await part('P11', async () => {
      const audit = await inCtx(env, 'page', () => globalThis.__rec.audit());
      const tree = JSON.parse(await treeJson(env));
      const count = (ns, pred) => ns.reduce((n, x) => n + (pred(x) ? 1 : 0) + count(x.children || [], pred), 0);
      const byPrefix = (p) => count(tree, (n) => n.children && n.title.startsWith(p));
      record('P11', {
        audit: { folders: audit.folders, children: audit.children, issueCount: audit.issues.length, issues: audit.issues.slice(0, 20) },
        foldersFromEarlierParts: { P1: byPrefix('P1 '), P1sup: byPrefix('P1sup'), P1b: byPrefix('P1b'), P2F: byPrefix('P2 '), P3: byPrefix('P3'), P4: byPrefix('P4'), P6: byPrefix('P6'), P9and_others: 'not counted' },
        note: 'checks getTree children[i].index, getChildren()[i].index and that both give the same order, for every folder in the profile',
      }, `folders=${audit.folders} children=${audit.children} issues=${audit.issues.length}`);
      expect(audit.folders).toBeGreaterThan(50);
    });

    // ---------------------------------------------------------------- P10
    await part('P10', async () => {
      const [F] = await make(env, 'page', env.bar, [fld('P10', Array.from({ length: 10 }, (_, i) => lnk('b' + i)))]);
      const ids = F.children.map((c) => c.id);
      const swStart = await inCtx(env, 'sw', () => globalThis.__rec.events.length);
      const moves = await inCtx(env, 'page', ([k, n, i, p]) => globalThis.__rec.bench(k, n, i, p), ['move', 500, ids, F.id]);
      const swMoves = await inCtx(env, 'sw', (s) => { const c = {}; for (const e of globalThis.__rec.events.slice(s)) c[e.kind] = (c[e.kind] || 0) + 1; return c; }, swStart);
      const swStart2 = await inCtx(env, 'sw', () => globalThis.__rec.events.length);
      const updates = await inCtx(env, 'page', ([k, n, i, p]) => globalThis.__rec.bench(k, n, i, p), ['update', 500, ids, F.id]);
      const swUpdates = await inCtx(env, 'sw', (s) => { const c = {}; for (const e of globalThis.__rec.events.slice(s)) c[e.kind] = (c[e.kind] || 0) + 1; return c; }, swStart2);
      const audit = await inCtx(env, 'page', () => globalThis.__rec.audit());
      record('P10', { moves, swEventCountsDuringMoves: swMoves, updates, swEventCountsDuringUpdates: swUpdates,
        everyWriteHadItsEventInPanelAndSw: {
          moves: moves.eventCounts.onMoved === 500 && swMoves.onMoved === 500,
          updates: updates.eventCounts.onChanged === 500 && swUpdates.onChanged === 500,
        },
        auditAfter: { folders: audit.folders, children: audit.children, issueCount: audit.issues.length, issues: audit.issues.slice(0, 10) },
        writer: 'panel document', pattern: 'move: the child at the last of 10 positions goes to index 0, every time (a real move, an onMoved owed each time); update(ids[i%10], {title:"bench "+i})' },
      `moves errors=${moves.errors} total=${moves.totalMs}ms | updates errors=${updates.errors} total=${updates.totalMs}ms`);
      expect(moves.n).toBe(500);
      expect(updates.n).toBe(500);
    });

    const bootNow = await bootIds(env);
    record('core-sw-restarts', { before: env.boot, after: bootNow, swSameInstance: env.boot.sw === bootNow.sw, panelSameInstance: env.boot.page === bootNow.page },
      `swSameInstance=${env.boot.sw === bootNow.sw}`);
  } finally {
    await env.context.close();
  }
  expect(failed, 'parts that threw (see *-ERROR records)').toEqual([]);
});

// =========================================================================================================
// P5 — the permanent nodes '0' (root), '1', '2'. Every attempted write is followed by a before/after tree
// comparison; if a write CHANGES the tree the browser is thrown away and a fresh profile is used for the next case
// (so a successful rename or removal of a root cannot colour the rest of the table).
// =========================================================================================================
test('P5: writes aimed at the permanent root nodes 0, 1, 2', async () => {
  test.setTimeout(1_800_000);
  let env = null;
  let fixture = null;
  const launches = [];
  const rows = [];
  let unmodifiableScan = null;
  const ensureEnv = async () => {
    if (env) return;
    env = await openEnv('required');
    fixture = null;
    launches.push({ n: launches.length + 1, userAgent: env.userAgent });
    if (!unmodifiableScan) {
      unmodifiableScan = await inCtx(env, 'page', async () => {
        const t = await chrome.bookmarks.getTree();
        const withKey = [];
        const keyUnion = new Set();
        (function walk(ns) { for (const n of ns) { Object.keys(n).forEach((k) => keyUnion.add(k)); if ('unmodifiable' in n) withKey.push({ id: n.id, value: n.unmodifiable }); walk(n.children || []); } })(t);
        return {
          nodesWithUnmodifiableKey: withKey, allNodeKeysSeen: Array.from(keyUnion).sort(),
          constantBookmarkTreeNodeUnmodifiable: chrome.bookmarks.BookmarkTreeNodeUnmodifiable,
          constantBookmarkTreeNodeUnmodifiableType: typeof chrome.bookmarks.BookmarkTreeNodeUnmodifiable,
          constantFolderType: chrome.bookmarks.FolderType, constantROOT_NODE_ID: chrome.bookmarks.ROOT_NODE_ID,
          getRoots: await chrome.bookmarks.get(['0', '1', '2']).then((r) => r.map((n) => ({ id: n.id, keys: Object.keys(n).sort(), folderType: n.folderType || null, title: n.title })), (e) => 'threw: ' + String(e && e.message || e)),
        };
      });
    }
  };
  const ensureFixture = async () => {
    await ensureEnv();
    if (fixture) return fixture;
    const [F] = await make(env, 'page', env.bar, [fld('P5 F (under 1)', [lnk('c1'), lnk('c2')])]);
    const [G] = await make(env, 'page', env.other, [fld('P5 G (under 2)', [lnk('g1')])]);
    fixture = { F, G };
    return fixture;
  };
  const attempt = async (id, name, needsFixture, build) => {
    // A case that is labelled "[roots empty]" must really run on a profile whose roots 1 and 2 are empty.
    if (!needsFixture && fixture && env) { await env.context.close(); env = null; }
    if (needsFixture) await ensureFixture(); else await ensureEnv();
    const t = JSON.parse(await treeJson(env));
    const rootNode = t[0].id === id ? t[0] : t[0].children.find((c) => c.id === id);
    const [method, ...args] = build(fixture);
    const before = await treeJson(env);
    const c = await call(env, 'page', `P5 ${name}`, method, ...args);
    const after = await treeJson(env);
    const row = {
      id, case: name, method, args, call: slimCall(c), treeChanged: before !== after,
      targetChildCountBefore: rootNode ? (rootNode.children || []).length : null,
      freshProfile: launches.length, events: c.panelEvents.map((e) => ({ kind: e.kind, args: e.args })),
    };
    rows.push(row);
    console.log(`P5 id=${id} ${name}: ${c.resolved ? 'RESOLVED' : 'threw(' + c.threw + '): ' + c.error} treeChanged=${row.treeChanged}`);
    if (row.treeChanged) { await env.context.close(); env = null; }
  };
  try {
    for (const id of ['0', '1', '2']) {
      const target = (fx) => (id === '1' ? fx.G.id : fx.F.id);
      await attempt(id, `update(${id}, title) [roots empty]`, false, () => ['update', id, { title: 'P5 renamed' }]);
      await attempt(id, `remove(${id}) [roots empty; for 0 it holds 1 and 2]`, false, () => ['remove', id]);
      await attempt(id, `move(${id} -> a folder) [fixture]`, true, (fx) => ['move', id, { parentId: target(fx) }]);
      await attempt(id, `remove(${id}) [non-empty]`, true, () => ['remove', id]);
      await attempt(id, `removeTree(${id})`, true, () => ['removeTree', id]);
    }
    await attempt('0', 'move(F child -> parent 0)', true, (fx) => ['move', fx.F.children[0].id, { parentId: '0' }]);
    await attempt('0', 'move(F child -> parent 0, index 0)', true, (fx) => ['move', fx.F.children[0].id, { parentId: '0', index: 0 }]);
    await attempt('0', 'create({parentId:0, title})', true, () => ['create', { parentId: '0', title: 'P5 under root' }]);
    await attempt('0', 'create({parentId:0, title, index:0})', true, () => ['create', { parentId: '0', title: 'P5 under root', index: 0 }]);
    await attempt('0', 'create({parentId:0, title, url})', true, () => ['create', { parentId: '0', title: 'P5 under root', url: 'http://127.0.0.1/root' }]);
    // Reference rows: the same kind of calls aimed at a permanent folder that IS a legal parent.
    await attempt('1', 'create({parentId:1, title}) [reference]', true, () => ['create', { parentId: '1', title: 'P5 under bar' }]);
    await attempt('2', 'create({parentId:2, title}) [reference]', true, () => ['create', { parentId: '2', title: 'P5 under other' }]);
  } finally {
    if (env) await env.context.close();
  }
  record('P5', { launches, unmodifiableScan, rows }, `rows=${rows.length} launches=${launches.length}`);
  expect(rows.length).toBe(3 * 5 + 5 + 2);
});

// =========================================================================================================
// P7 — the optional permission, a synthesised grant (profile patch, copied from 90 B3), writes from the PANEL.
// =========================================================================================================
test('P7: writes from the panel document under an optional grant, and after it is removed', async () => {
  test.setTimeout(900_000);
  const dir = writeExtension('optional');
  const profile = path.join(OUT, 'probe-profile-95-p7');
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  const out = { profile, grant: 'SYNTHESISED by patching Preferences; the act of granting through Chrome\'s bubble is NOT measured here' };

  {
    const { context, sw, id } = await launch(dir, { userDataDir: profile });
    out.extensionId = id;
    const page = await openPanelTab(context, id);
    out.ungranted = {
      contains: await sw.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] })),
      swTypeofBookmarks: await sw.evaluate(() => typeof chrome.bookmarks),
      panelTypeofBookmarks: await page.evaluate(() => typeof chrome.bookmarks),
      panelBindState: await page.evaluate(() => window.__rec.bindState),
      swBindState: await sw.evaluate(() => globalThis.__rec.bindState),
    };
    await context.close();
  }

  const candidates = ['Default/Preferences', 'Default/Secure Preferences', 'Preferences', 'Secure Preferences']
    .map((p) => path.join(profile, p)).filter((p) => fs.existsSync(p));
  out.patched = [];
  for (const file of candidates) {
    let json;
    try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { out.patched.push({ file, error: String(e) }); continue; }
    const settings = json.extensions && json.extensions.settings && json.extensions.settings[out.extensionId];
    if (!settings) continue;
    const note = { file: path.relative(profile, file) };
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

  const { context, sw, id } = await launch(dir, { userDataDir: profile });
  const page = await openPanelTab(context, id);
  const env = { variant: 'optional', context, sw, id, page };
  try {
    out.granted = {
      contains: await sw.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] })),
      swTypeofBookmarks: await sw.evaluate(() => typeof chrome.bookmarks),
      panelTypeofBookmarks: await page.evaluate(() => typeof chrome.bookmarks),
      panelBindState: await page.evaluate(() => window.__rec.bindState),
      swBindState: await sw.evaluate(() => globalThis.__rec.bindState),
    };
    const roots = await rootsOf(env);
    const bar = roots.find((r) => r.folderType === 'bookmarks-bar').id;
    const steps = {};
    steps.createFolder = await call(env, 'page', 'P7 create(folder)', 'create', { parentId: bar, title: 'P7 folder' });
    const F = steps.createFolder.result;
    const a = await call(env, 'page', 'P7 create(link a)', 'create', { parentId: F.id, title: 'a', url: 'http://127.0.0.1/a' });
    const b = await call(env, 'page', 'P7 create(link b)', 'create', { parentId: F.id, title: 'b', url: 'http://127.0.0.1/b' });
    const c = await call(env, 'page', 'P7 create(link c)', 'create', { parentId: F.id, title: 'c', url: 'http://127.0.0.1/c' });
    steps.update = await call(env, 'page', 'P7 update(a title)', 'update', a.result.id, { title: 'a renamed' });
    steps.moveWithIndex = await call(env, 'page', 'P7 move(c -> index 0)', 'move', c.result.id, { parentId: F.id, index: 0 });
    out.orderAfterMove = ord(await kids(env, 'page', F.id));
    steps.removeTree = await call(env, 'page', 'P7 removeTree(folder)', 'removeTree', F.id);
    out.granted.steps = Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, { ...slimCall(v), panelEvents: kinds(v.panelEvents), swEvents: kinds(v.swEvents) }]));
    out.granted.setupCalls = [a, b, c].map((x) => slimCall(x));

    // Fixture for the after-revoke calls, made while the grant still holds.
    const [R2] = await make(env, 'page', bar, [fld('P7 revoke-fixture', [lnk('r1'), lnk('r2')])]);
    out.revoke = {};
    out.revoke.permissionsRemove = await page.evaluate(async () => {
      try { return { state: 'resolved', value: await chrome.permissions.remove({ permissions: ['bookmarks'] }) }; }
      catch (e) { return { state: 'rejected', error: String(e && e.message || e) }; }
    });
    await sleep(500);
    out.revoke.after = {
      contains: await sw.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] })),
      panelTypeofBookmarks: await page.evaluate(() => typeof chrome.bookmarks),
      swTypeofBookmarks: await sw.evaluate(() => typeof chrome.bookmarks),
    };
    out.revoke.calls = {};
    const attempts = [
      ['create', 'create', { parentId: R2.id, title: 'after revoke' }],
      ['update', 'update', R2.children[0].id, { title: 'after revoke' }],
      ['moveWithIndex', 'move', R2.children[1].id, { parentId: R2.id, index: 0 }],
      ['removeTree', 'removeTree', R2.id],
    ];
    for (const [name, method, ...args] of attempts) {
      const r = await page.evaluate(async ([m, a]) => {
        const rec = { method: m, apiTypeof: typeof chrome.bookmarks, threw: null, error: null, resolved: false };
        let p;
        try { p = chrome.bookmarks[m].apply(chrome.bookmarks, a); } catch (e) { rec.threw = 'sync'; rec.error = String(e && e.message || e); return rec; }
        try { await p; rec.resolved = true; } catch (e) { rec.threw = 'async'; rec.error = String(e && e.message || e); }
        return rec;
      }, [method, args]);
      r.messageContainsIsNotAvailable = typeof r.error === 'string' && r.error.includes('is not available in this context');
      out.revoke.calls[name] = r;
    }
  } finally {
    record('P7', out, `granted writes: ${Object.entries(out.granted && out.granted.steps || {}).map(([k, v]) => k + '=' + v.resolved).join(' ')}`);
    await context.close();
  }
  expect(out.granted.steps && out.granted.steps.removeTree).toBeTruthy();
  expect(Object.keys(out.revoke.calls).length).toBe(4);
});

// =========================================================================================================
// P8 — HTML5 drag from a <button draggable="true"> with the REAL mouse (Playwright drives Chromium's input
// pipeline), in the panel document opened as a tab. The page under test is a small DOM injected into the panel
// document, not the real bookmarks column: this measures the platform, not our code.
// =========================================================================================================
// `mode` is what happens to the source node during the second dragover over the target:
//   'none'     nothing (V1)
//   'remove'   src.remove(): the rows below it reflow upwards by the height of the source (V2)
//   'spacer'   src is replaced by an empty div of the same size, so no row moves (V2b: separates "node removed" from "layout moved")
//   'rebuild'  every row is thrown away and re-created with the same ids, which is what a repaint that does
//              textContent='' and re-renders does to the list (V2c); the old source node stays referenced here
const DND_SETUP = ([tag, icon, mode]) => {
  const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const img = (id) => (icon === 'none' ? '' : '<img id="ico-' + id + '" width="16" height="16" alt="" ' + (icon === 'img-nodrag' ? 'draggable="false" ' : '') + 'src="' + GIF + '">');
  const row = (id, label) => '<' + tag + ' id="' + id + '" draggable="true" style="display:flex;align-items:center;gap:8px;height:32px;width:280px;margin:0;border:1px solid #888;font:14px sans-serif;text-align:left;background:#eee">' + img(id) + '<span>' + label + '</span></' + tag + '>';
  const rows = () => row('src', 'Source') + '<div style="height:12px"></div>' + row('mid', 'Middle') + '<div style="height:12px"></div>' + row('tgt', 'Target');
  document.body.innerHTML = '<div id="c" style="padding:16px">' + rows() + '</div>';
  const removeSource = mode !== 'none';
  const D = (window.__dnd = { log: [], counts: {}, removedSource: false, oldSourceConnected: null });
  const desc = (n) => (n && n.nodeType === 1 ? n.tagName + (n.id ? '#' + n.id : '') : n ? String(n.nodeName) : null);
  const info = (e) => ({
    types: Array.from(e.dataTransfer ? e.dataTransfer.types : []),
    custom: e.dataTransfer ? e.dataTransfer.getData('application/x-vt-bm') : null,
    effectAllowed: e.dataTransfer ? e.dataTransfer.effectAllowed : null,
    dropEffect: e.dataTransfer ? e.dataTransfer.dropEffect : null,
  });
  const bump = (k) => { D.counts[k] = (D.counts[k] || 0) + 1; return D.counts[k]; };
  for (const t of ['dragstart', 'drag', 'dragenter', 'dragover', 'dragleave', 'drop', 'dragend']) {
    document.addEventListener(t, (e) => {
      const n = bump(t + ' ' + desc(e.target));
      if (t === 'dragstart') {
        const r = e.target.closest ? e.target.closest('[draggable="true"]') : null;
        e.dataTransfer.setData('application/x-vt-bm', r ? r.id : 'none');
        e.dataTransfer.effectAllowed = 'move';
      }
      if (t === 'dragover') { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
      if (t === 'drop') e.preventDefault();
      if ((t !== 'drag' && t !== 'dragover') || n === 1) D.log.push({ type: t, target: desc(e.target), n, ...info(e) });
      if (removeSource && t === 'dragover' && e.target.closest && e.target.closest('#tgt') && !D.removedSource && n >= 2) {
        const src = document.getElementById('src');
        if (src) {
          if (mode === 'remove') src.remove();
          else if (mode === 'spacer') {
            const r = src.getBoundingClientRect();
            const sp = document.createElement('div');
            sp.id = 'spacer'; sp.style.cssText = 'width:' + r.width + 'px;height:' + r.height + 'px';
            src.replaceWith(sp);
          } else if (mode === 'rebuild') {
            document.getElementById('c').innerHTML = rows();
            const fresh = document.getElementById('src');
            fresh.addEventListener('dragend', (ev) => D.log.push({ type: 'dragend-direct-on-NEW-src', target: desc(ev.target), isConnected: ev.target.isConnected }));
          }
          D.removedSource = true; D.oldSourceConnected = src.isConnected;
          D.log.push({ type: 'source-replaced-during-dragover', mode, target: desc(e.target), n, oldSourceIsConnectedNow: src.isConnected });
        }
      }
    }, true);
  }
  const srcEl = document.getElementById('src');
  srcEl.addEventListener('dragend', (e) => D.log.push({ type: 'dragend-direct-on-src', target: desc(e.target), isConnected: e.target.isConnected, dropEffect: e.dataTransfer ? e.dataTransfer.dropEffect : null }));
  return true;
};

async function dndRun(page, label, { tag, icon, mode = 'none', pressOnIcon }) {
  await page.evaluate(DND_SETUP, [tag, icon, mode]);
  const src = await page.locator(pressOnIcon ? '#ico-src' : '#src').boundingBox();
  const dst = await page.locator('#tgt').boundingBox();
  const sx = src.x + src.width / 2; const sy = src.y + src.height / 2;
  const tx = dst.x + dst.width / 2; const ty = dst.y + dst.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 6, sy + 6, { steps: 4 });
  await page.mouse.move(tx, ty, { steps: 16 });
  await page.waitForTimeout(150);
  await page.mouse.move(tx, ty, { steps: 2 });
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(400);
  const d = await page.evaluate(() => ({ log: window.__dnd.log, counts: window.__dnd.counts, removedSource: window.__dnd.removedSource, sourceStillInDom: !!document.getElementById('src') }));
  const first = (type) => d.log.find((e) => e.type === type) || null;
  return {
    label, config: { tag, icon, mode, pressedOn: pressOnIcon ? 'the <img> inside the row' : 'the row itself' },
    dragstartFired: !!first('dragstart'), dragstartTarget: first('dragstart') && first('dragstart').target,
    firstDragoverCustomDataReadable: first('dragover') ? first('dragover').custom : null,
    firstDragoverTypes: first('dragover') ? first('dragover').types : null,
    dropFired: !!first('drop'), dropTarget: first('drop') && first('drop').target, dropCustomData: first('drop') && first('drop').custom, dropTypes: first('drop') && first('drop').types,
    dragendFiredAtDocument: !!first('dragend'), dragendTargetAtDocument: first('dragend') && first('dragend').target,
    dragendDirectOnSource: first('dragend-direct-on-src'),
    dragendDirectOnNewSource: first('dragend-direct-on-NEW-src'),
    removedSourceDuringDragover: d.removedSource, oldSourceConnectedAtReplace: d.oldSourceConnected, sourceStillInDom: d.sourceStillInDom,
    dropTargetIsTheTargetRow: !!first('drop') && first('drop').target === (tag === 'button' ? 'BUTTON#tgt' : 'DIV#tgt'),
    counts: d.counts, log: d.log,
  };
}

test('P8: HTML5 drag from a draggable <button> with the real mouse, and removal of the source node mid-drag', async () => {
  test.setTimeout(600_000);
  const env = await openEnv('required');
  const out = { harness: 'panel.html opened as a tab, real mouse via Playwright (CDP Input events); DOM injected into that document' };
  try {
    await env.page.setViewportSize({ width: 400, height: 600 });
    out.v1_button = await dndRun(env.page, 'V1 button -> button', { tag: 'button', icon: 'none' });
    out.v1_div_control = await dndRun(env.page, 'V1 control: div rows', { tag: 'div', icon: 'none' });
    out.v1_button_img_pressOnImg = await dndRun(env.page, 'control: button with an <img> icon, mouse pressed ON the img', { tag: 'button', icon: 'img', pressOnIcon: true });
    out.v1_button_img_nodrag_pressOnImg = await dndRun(env.page, 'control: same, img has draggable=false', { tag: 'button', icon: 'img-nodrag', pressOnIcon: true });
    out.v2_removeSource = await dndRun(env.page, 'V2 button, source node removed during dragover (rows below reflow upwards)', { tag: 'button', icon: 'none', mode: 'remove' });
    out.v2b_spacerInPlaceOfSource = await dndRun(env.page, 'V2b button, source node replaced by a same-size spacer (no row moves)', { tag: 'button', icon: 'none', mode: 'spacer' });
    out.v2c_rebuildAllRows = await dndRun(env.page, 'V2c button, every row re-created with the same ids during dragover (what a full repaint does)', { tag: 'button', icon: 'none', mode: 'rebuild' });
    for (const k of Object.keys(out).filter((x) => x !== 'harness')) {
      const r = out[k];
      console.log(`P8 ${k}: dragstart=${r.dragstartFired}(${r.dragstartTarget}) drop=${r.dropFired}(on ${r.dropTarget}, data=${JSON.stringify(r.dropCustomData)}) dragend@doc=${r.dragendFiredAtDocument} dragend@oldSrc=${r.dragendDirectOnSource ? 'yes isConnected=' + r.dragendDirectOnSource.isConnected : 'no'} dragend@newSrc=${r.dragendDirectOnNewSource ? 'yes' : 'no'}`);
    }
  } finally {
    record('P8', out, 'v1 button, controls, v2 removal');
    await env.context.close();
  }
  expect(Object.keys(out)).toContain('v2_removeSource');
});

// =========================================================================================================
// P12 — managed bookmarks and EditBookmarksEnabled=false.
// Chromium reads managed policy from a fixed directory (/etc/chromium/policies/managed, or
// /etc/opt/chrome/policies/managed for Google Chrome branding). The default container user cannot write there,
// so this test only produces a record when the policy directories are writable: it was run in a container
// started as root that makes those directories world-writable and then runs Playwright as the host user.
// If they are not writable the record says UNMEASURABLE and why; nothing is filled in.
// =========================================================================================================
const POLICY_DIRS = ['/etc/chromium/policies/managed', '/etc/opt/chrome/policies/managed', '/etc/chromium-browser/policies/managed'];
function writePolicy(file, obj) {
  return POLICY_DIRS.map((d) => {
    try { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, file), JSON.stringify(obj)); return { dir: d, ok: true }; }
    catch (e) { return { dir: d, ok: false, error: String(e && e.code || e) }; }
  });
}
function removePolicy(file) {
  for (const d of POLICY_DIRS) { try { fs.rmSync(path.join(d, file), { force: true }); } catch (e) { /* nothing to remove */ } }
}
/** What the test process itself sees in the policy directories (owner, mode), so the record says how the files were placed. */
function policyFilesSeen() {
  return POLICY_DIRS.map((d) => {
    try {
      const s = fs.statSync(d);
      return { dir: d, dirMode: (s.mode & 0o7777).toString(8), dirUid: s.uid, files: fs.readdirSync(d).map((f) => { const x = fs.statSync(path.join(d, f)); return { name: f, mode: (x.mode & 0o7777).toString(8), uid: x.uid, bytes: x.size }; }) };
    } catch (e) { return { dir: d, error: String(e && e.code || e) }; }
  });
}
// VT_P12_PREPLACED=<case name>: the policy file for that one case was put there by root (root-owned, 0644, in a 0755
// directory the test user cannot write to) before this test started; the test then neither writes nor removes files.
const P12_PREPLACED = process.env.VT_P12_PREPLACED || '';

test('P12: managed bookmarks and EditBookmarksEnabled=false', async () => {
  test.setTimeout(1_200_000);
  const out = {
    processUid: process.getuid(), processGid: process.getgid(),
    policyDirs: POLICY_DIRS.map((d) => { let writable = false; try { fs.accessSync(d, fs.constants.W_OK); writable = true; } catch (e) { /* not writable */ } return { dir: d, exists: fs.existsSync(d), writableByThisProcess: writable }; }),
    chromiumExecutable: chromium.executablePath(),
    cases: {},
  };
  out.placement = P12_PREPLACED ? `pre-placed by root for case "${P12_PREPLACED}"` : 'files written by the test process itself into world-writable directories';
  const allCases = [
    { name: 'ManagedBookmarks', file: 'vt-probe-managed-bookmarks.json', policy: { ManagedBookmarks: [
      { toplevel_name: 'Managed probe' },
      { name: 'Managed link', url: 'http://127.0.0.1/managed-link' },
      { name: 'Managed folder', children: [{ name: 'Inner', url: 'http://127.0.0.1/inner' }] },
    ] } },
    { name: 'EditBookmarksEnabled=false', file: 'vt-probe-edit-disabled.json', policy: { EditBookmarksEnabled: false } },
  ];
  const cases = P12_PREPLACED ? allCases.filter((c) => c.name === P12_PREPLACED) : allCases;
  for (const k of cases) {
    if (!P12_PREPLACED) for (const f of allCases) removePolicy(f.file);
    const profile = path.join(OUT, `probe-profile-95-p12-${k.name.replace(/\W+/g, '_')}`);
    fs.rmSync(profile, { recursive: true, force: true });
    fs.mkdirSync(profile, { recursive: true });
    const res = (out.cases[k.name] = { policy: k.policy });
    // Pass 1, no policy file present: build the user's own bookmarks, then shut down so they are flushed to disk.
    let fx;
    {
      const env1 = await openEnv('required', { userDataDir: profile });
      const [F, F2] = await make(env1, 'page', env1.bar, [fld('P12 F', [lnk('A'), lnk('B')]), fld('P12 F2', [lnk('X')])]);
      const [L] = await make(env1, 'page', env1.bar, [lnk('P12 link')]);
      fx = { F, F2, L };
      await sleep(3000);
      await env1.context.close();
    }
    res.policyFileWritten = P12_PREPLACED ? 'pre-placed (see policyFilesSeen)' : writePolicy(k.file, k.policy);
    res.policyFilesSeen = policyFilesSeen();
    if (!P12_PREPLACED && !res.policyFileWritten.some((w) => w.ok)) {
      res.status = 'UNMEASURABLE';
      res.reason = 'no managed-policy directory is writable by this process (uid ' + process.getuid() + '), so no policy could be applied';
      continue;
    }
    // Pass 2, same profile, policy file present from the start.
    const env = await openEnv('required', { userDataDir: profile });
    try {
      res.rootsAfterPolicy = env.roots;
      res.fullTree = await inCtx(env, 'page', () => globalThis.__rec.tree());
      const managedRoot = env.roots.find((r) => r.folderType === 'managed');
      res.managedRootPresent = !!managedRoot;
      res.unmodifiableKeysSeen = await inCtx(env, 'page', async () => {
        const t = await chrome.bookmarks.getTree(); const found = [];
        (function walk(ns) { for (const n of ns) { if ('unmodifiable' in n) found.push({ id: n.id, title: n.title, unmodifiable: n.unmodifiable }); walk(n.children || []); } })(t);
        return found;
      });
      // Best-effort evidence that the policy was or was not loaded at all.
      res.policyPage = await (async () => {
        try {
          const p = await env.context.newPage();
          await p.goto('chrome://policy', { timeout: 30_000 });
          await p.waitForTimeout(3000);
          const text = await p.evaluate(() => {
            const parts = [];
            (function deep(n) { if (n.nodeType === 3) { const t = n.textContent.trim(); if (t) parts.push(t); } if (n.shadowRoot) deep(n.shadowRoot); for (const c of n.childNodes) deep(c); })(document.documentElement);
            return parts.join(' | ');
          });
          await p.close();
          const name = Object.keys(k.policy)[0];
          const i = text.indexOf(name);
          return { ok: true, policyName: name, listedOnPage: i >= 0, textLength: text.length, snippetFromPolicyName: i >= 0 ? text.slice(i, i + 500) : null, textHead: text.slice(0, 600) };
        } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      })();
      const attempts = [];
      const A = async (label, method, ...args) => {
        const before = await treeJson(env);
        const c = await call(env, 'page', `P12 ${k.name}: ${label}`, method, ...args);
        attempts.push({ label, method, args, call: slimCall(c), treeChanged: before !== (await treeJson(env)), events: kinds(c.panelEvents) });
      };
      const bar = env.bar;
      await A('create folder under the bookmarks bar', 'create', { parentId: bar, title: 'P12 created' });
      await A('create link under the bookmarks bar', 'create', { parentId: bar, title: 'P12 created link', url: 'http://127.0.0.1/created' });
      await A('update(user folder, title)', 'update', fx.F.id, { title: 'P12 F renamed' });
      await A('update(user link, title)', 'update', fx.L.id, { title: 'P12 link renamed' });
      await A('move(A, index 1) within the user folder', 'move', fx.F.children[0].id, { parentId: fx.F.id, index: 1 });
      await A('move(X -> F, index 0)', 'move', fx.F2.children[0].id, { parentId: fx.F.id, index: 0 });
      if (managedRoot) {
        const managed = res.fullTree[0].children.find((c) => c.id === managedRoot.id);
        const mLink = (managed.children || []).find((c) => c.url);
        const mFolder = (managed.children || []).find((c) => c.children);
        res.managedNodes = { root: managedRoot, link: mLink && { id: mLink.id, keys: Object.keys(mLink).sort(), unmodifiable: mLink.unmodifiable }, folder: mFolder && { id: mFolder.id, keys: Object.keys(mFolder).sort(), unmodifiable: mFolder.unmodifiable } };
        if (mLink) {
          await A('update(managed link, title)', 'update', mLink.id, { title: 'renamed' });
          await A('move(managed link -> bookmarks bar)', 'move', mLink.id, { parentId: bar });
        }
        if (mFolder) {
          await A('create under the managed folder', 'create', { parentId: mFolder.id, title: 'P12 in managed' });
          await A('move(user link -> managed folder)', 'move', fx.L.id, { parentId: mFolder.id });
        }
        if (mLink) await A('remove(managed link)', 'remove', mLink.id);
        if (mFolder) await A('removeTree(managed folder)', 'removeTree', mFolder.id);
      }
      await A('remove(user link)', 'remove', fx.L.id);
      await A('removeTree(user folder F2)', 'removeTree', fx.F2.id);
      res.attempts = attempts;
      // Did the browser apply the policy at all? ManagedBookmarks: a managed root must appear. EditBookmarksEnabled=false:
      // writes must stop working. If neither happened the profile behaved exactly like an unmanaged one.
      res.policyApplied = k.name === 'ManagedBookmarks'
        ? !!managedRoot
        : attempts.some((a) => a.label.startsWith('create folder') && !a.call.resolved);
      res.status = res.policyApplied
        ? 'MEASURED (the policy took effect)'
        : 'UNMEASURABLE (the policy file was in place but the browser behaved as if unmanaged)';
    } finally {
      await env.context.close();
      if (!P12_PREPLACED) removePolicy(k.file);
    }
  }
  record(P12_PREPLACED ? `P12-preplaced-${P12_PREPLACED}` : 'P12', out, Object.entries(out.cases).map(([n, c]) => `${n}: ${c.status}`).join(' | '));
  expect(Object.keys(out.cases).length).toBe(cases.length);
});
