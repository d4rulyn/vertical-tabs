// 102-group-close-focus-probe — platform probe, "Probe 16" in .agent/probe-results.md (PR #20, round 2). Numbered 98 until round 3.
// (Run under its first name, 98-group-close-focus-diag.spec.js, with the instrumentation inline; renamed, and the
// instrumentation moved to group-close-focus-instrumentation.js, before it was pushed. The code is the same.)
//
// NOT a regression test of Vertical Tabs. Two questions that CLAUDE.md §7.2 forbids answering from memory, both
// about the focus hand-off after the x on a group header (keyboard.js):
//   (1) In what order does Chrome tell the panel about a close: `tabs.onRemoved` per tab, `tabGroups.onRemoved`?
//   (2) Does the hand-off lose focus by itself in a plain keyboard close? (spec 42, test "Tab from the swatch reaches
//       the x and Space closes the group": focus was on <body> for the whole 10 s predicate in 1 of 5 repeats.)
// Nothing in the extension is changed; the page is instrumented from the test (group-close-focus-instrumentation.js).
//
// PASS criterion, written before the first run: every iteration produced its record, that is the key press, the click,
// `tabs.remove`, every `tabs.onRemoved` / `tabGroups.onRemoved`, every `focus()` with its stack, every DOM mutator that
// carried focus, and the final focus owner. What the numbers mean is decided afterwards, in probe-results.md. (The final
// `expect` fails the run when an iteration ended with focus away from the successor card; that is how a lost iteration
// is flagged, not a claim about Chromium.)
//
// Environment: KEY=Space|Enter, ITER=<iterations per test>, THRESHOLD=<confirmCloseThreshold, default 10>,
// DUMP=1 (print the whole log of every iteration, not only of lost ones), HAMMER=<ms> (request a `resync()` every
// <ms> while the close runs: a stress amplifier, 0 = off).
//
// Run (probes live outside testDir; in the e2e container, never on the host):
//   env KEY=Space ITER=5 VT_TEST_DIR=./probes playwright test 102-group-close-focus-probe.spec.js --repeat-each=12 --retries=0
'use strict';

const { test, expect } = require('../fixtures');
const { swEval, setSettings, createTab } = require('../helpers/chrome');

const HEADER = '[data-testid="group-header"]';
const CARD = '#tablist [data-testid="tab-card"]';
const X = '[data-testid="group-close"]';
const KEY = process.env.KEY || 'Space';
const ITER = Number(process.env.ITER || 1);
const HAMMER = Number(process.env.HAMMER || 0); // ms between resync() requests while the close runs (stress amplifier, 0 = off)
const THRESHOLD = Number(process.env.THRESHOLD || 10);
const PANEL_VIEWPORT = { width: 400, height: 1500 };

async function buildLayout(harness, serviceWorker) {
  const { w2, tabIds, urls, panel } = harness;
  const delta = await createTab(serviceWorker, w2, urls.delta, { active: false });
  const epsilon = await createTab(serviceWorker, w2, urls.page('ffff00', 'Epsilon'), { active: false });
  const ids = { alpha: tabIds.alpha, beta: tabIds.beta, gamma: tabIds.gamma, delta, epsilon };
  const groups = await swEval(serviceWorker, async (a) => {
    const work = await chrome.tabs.group({ tabIds: [a.alpha, a.beta, a.gamma], createProperties: { windowId: a.wid } });
    await chrome.tabGroups.update(work, { title: 'Work', color: 'blue' });
    const other = await chrome.tabs.group({ tabIds: [a.delta], createProperties: { windowId: a.wid } });
    await chrome.tabGroups.update(other, { title: 'Other', color: 'red' });
    return { work, other };
  }, { ...ids, wid: w2 });
  await expect(panel.locator(HEADER)).toHaveCount(2, { timeout: 10_000 });
  await expect(panel.locator(CARD)).toHaveCount(5, { timeout: 10_000 });
  return { ids, ...groups };
}

const { install } = require('./group-close-focus-instrumentation');


// A fresh `Work` (3 tabs) at the FRONT of the window, so the layout is the one the first iteration had:
// [Work][Other: delta] epsilon. The previous Work is gone (the iteration before closed it).
async function rebuildWork(harness, serviceWorker, previous) {
  const { w2, urls, panel } = harness;
  const a = await createTab(serviceWorker, w2, urls.page('aa0000', 'A2'), { active: false, index: 0 });
  const b = await createTab(serviceWorker, w2, urls.page('00aa00', 'B2'), { active: false, index: 1 });
  const g = await createTab(serviceWorker, w2, urls.page('0000aa', 'G2'), { active: false, index: 2 });
  const work = await swEval(serviceWorker, async (x) => {
    const id = await chrome.tabs.group({ tabIds: [x.a, x.b, x.g], createProperties: { windowId: x.wid } });
    await chrome.tabGroups.update(id, { title: 'Work', color: 'blue' });
    return id;
  }, { a, b, g, wid: w2 });
  await expect(panel.locator(HEADER)).toHaveCount(2, { timeout: 10_000 });
  await expect(panel.locator(CARD)).toHaveCount(5, { timeout: 10_000 });
  return { ids: { ...previous.ids, alpha: a, beta: b, gamma: g }, work, other: previous.other };
}

async function once(panel, layout, it) {
  const { ids, work } = layout;
  const x = panel.locator(`.group[data-group-id="${work}"] ${X}`);
  await expect(x).toHaveCount(1, { timeout: 10_000 });
  const startAt = (await panel.evaluate(() => window.__fd.log.length));
  await panel.evaluate((n) => window.__fd.L(`=== iteration ${n}: swatch focus + Tab`), it);
  await panel.locator(`.group[data-group-id="${work}"] ${HEADER} .group-swatch`).focus();
  await panel.keyboard.press('Tab');
  const focused = await panel.evaluate(() => (document.activeElement && document.activeElement.dataset.testid) || null);
  expect(focused).toBe('group-close');
  if (HAMMER) await panel.evaluate((ms) => { window.__hammer = setInterval(() => { window.__vt.stateModule.resync(); }, ms); }, HAMMER);
  await panel.evaluate(() => window.__fd.L('=== pressing the key from the test'));
  await panel.keyboard.press(KEY);
  await expect(panel.locator(CARD)).toHaveCount(2, { timeout: 10_000 });
  await panel.evaluate(() => window.__fd.L('=== test saw 2 cards'));
  let last = null;
  for (let i = 0; i < 30; i += 1) {
    last = await panel.evaluate(() => {
      const el = document.activeElement;
      const card = el && el.closest('[data-testid="tab-card"]');
      return { onBody: !el || el === document.body, onCard: card ? Number(card.dataset.tabId) : null };
    });
    if (last.onCard === ids.delta) break;
    await panel.waitForTimeout(100);
  }
  if (HAMMER) await panel.evaluate(() => clearInterval(window.__hammer));
  const verdict = last.onCard === ids.delta ? 'FOCUS-OK' : 'FOCUS-LOST';
  {
    const ev = (await panel.evaluate(() => window.__fd.log)).slice(startAt);
    const tabsGone = ev.filter((e) => e.what === 'tabs.onRemoved').map((e) => e.t);
    const groupGone = (ev.find((e) => e.what === 'tabGroups.onRemoved') || {}).t;
    console.log(`EVENTORDER it=${it} tabsRemoved=${JSON.stringify(tabsGone)} groupRemoved=${groupGone} `
      + `groupBeforeLastTab=${groupGone !== undefined && tabsGone.length > 0 && groupGone < tabsGone[tabsGone.length - 1]} `
      + `gapMs=${groupGone !== undefined && tabsGone.length > 0 ? Math.round((tabsGone[tabsGone.length - 1] - groupGone) * 10) / 10 : 'n/a'}`);
  }
  const log = (await panel.evaluate(() => window.__fd.log)).slice(startAt);
  const t = (what) => (log.find((e) => e.what === what) || {}).t;
  console.log(`PROBE ${verdict} it=${it} key=${KEY} threshold=${THRESHOLD} final=${JSON.stringify(last)} `
    + `keyAt=${t('=== pressing the key from the test')} click=${(log.find((e) => e.what === 'click') || {}).t}`);
  if (verdict === 'FOCUS-LOST' || process.env.DUMP === '1') {
    for (const e of log) console.log(`PROBELOG it=${it} ` + JSON.stringify(e));
  }
  return verdict;
}

test('diag: where does focus go after the group x', async ({ harness, serviceWorker }) => {
  const { panel } = harness;
  await panel.setViewportSize(PANEL_VIEWPORT);
  await setSettings(serviceWorker, { refreshInterval: 'off', confirmCloseThreshold: THRESHOLD });
  let layout = await buildLayout(harness, serviceWorker);
  await expect.poll(() => panel.evaluate(() => window.__vt.settings.confirmCloseThreshold)).toBe(THRESHOLD);
  await panel.evaluate(install);
  const verdicts = [];
  for (let it = 0; it < ITER; it += 1) {
    if (it > 0) layout = await rebuildWork(harness, serviceWorker, layout);
    verdicts.push(await once(panel, layout, it));
  }
  console.log(`PROBESUMMARY key=${KEY} ok=${verdicts.filter((v) => v === 'FOCUS-OK').length} lost=${verdicts.filter((v) => v === 'FOCUS-LOST').length}`);
  expect(verdicts.filter((v) => v === 'FOCUS-LOST').length, 'iterations that lost focus').toBe(0);
});
