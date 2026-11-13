// 99-group-close-reflow-touch-probe — platform probe, "Probe 16" in .agent/probe-results.md (PR #20, round 2).
// (Run under its first name, 99-group-close-touch-diag.spec.js; renamed before it was pushed. The code is the same.)
//
// NOT a regression test of Vertical Tabs. Two questions, each answered by a record and not by an assertion:
//   touch A / B  Can a test make `@media (hover: none), (any-pointer: coarse)` match in this harness, so that
//                removing sidepanel.css:914-916 turns a test red? A: CDP `Emulation.setTouchEmulationEnabled` on the
//                already-open panel page. B: a persistent context launched with `hasTouch: true`. Recorded for each:
//                `matchMedia` of the four pointer / hover features and the computed opacity of an AT-REST group x.
//   reflow       The focus hand-off of the x on a group header puts focus on the next group's card. When the group's
//                LAST tab then closes, is focus lost again, and which line does it? Real Chrome calls pull the two
//                steps apart (take the last tab out of the group, then close it); the instrumentation logs the DOM
//                mutator that carried focus, with its stack.
//   slow         A close that lands after the hand-off's 2 s deadline (the panel's `chrome.tabs.remove` is held, its
//                `Date.now()` is moved 10 s ahead, then the request is let through): what runs, and where does focus go?
//                The instrumentation logs every `focus()` call and the DOM mutator that removed the x.
//
// PASS criterion, written before the first run: each of the tests produced its record (the `TOUCHPROBE A` /
// `TOUCHPROBE B` lines, the `REFLOWPROBE` line with its `REFLOWLOG` lines, the `SLOWPROBE` line with its `SLOWLOG` lines).
//
// Run (in the e2e container, never on the host):
//   env VT_TEST_DIR=./probes playwright test 99-group-close-reflow-touch-probe.spec.js --retries=0
'use strict';

const { test, expect, chromium, launchArgs } = require('../fixtures');
const { swEval, setSettings, createTab } = require('../helpers/chrome');
const { setupTwoWindows } = require('../helpers/windows');
const { install } = require('./group-close-focus-instrumentation');

const HEADER = '[data-testid="group-header"]';
const X = '[data-testid="group-close"]';
const PANEL_VIEWPORT = { width: 400, height: 1500 };

async function oneGroup(harness, serviceWorker) {
  const { w2, tabIds, panel } = harness;
  const groupId = await swEval(serviceWorker, async (a) => {
    const g = await chrome.tabs.group({ tabIds: [a.alpha, a.beta], createProperties: { windowId: a.wid } });
    await chrome.tabGroups.update(g, { title: 'Work', color: 'blue' });
    return g;
  }, { alpha: tabIds.alpha, beta: tabIds.beta, wid: w2 });
  await expect(panel.locator(HEADER)).toHaveCount(1, { timeout: 10_000 });
  return groupId;
}

const readMedia = (panel) => panel.evaluate(() => {
  const x = document.querySelector('[data-testid="group-close"]');
  return {
    anyPointerCoarse: matchMedia('(any-pointer: coarse)').matches,
    pointerCoarse: matchMedia('(pointer: coarse)').matches,
    hoverNone: matchMedia('(hover: none)').matches,
    anyHoverNone: matchMedia('(any-hover: none)').matches,
    maxTouchPoints: navigator.maxTouchPoints,
    ontouchstart: 'ontouchstart' in window,
    opacityAtRest: x ? getComputedStyle(x).opacity : null,
  };
});

test('touch A: CDP Emulation.setTouchEmulationEnabled on the open panel', async ({ harness, serviceWorker, context }) => {
  const { panel } = harness;
  await panel.setViewportSize(PANEL_VIEWPORT);
  await setSettings(serviceWorker, { refreshInterval: 'off' });
  await oneGroup(harness, serviceWorker);
  await panel.mouse.move(2, 2);
  const before = await readMedia(panel);
  const cdp = await context.newCDPSession(panel);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  let after = await readMedia(panel);
  const samples = [after];
  for (let i = 0; i < 10 && JSON.stringify(samples[samples.length - 1]) === JSON.stringify(before); i += 1) {
    await panel.waitForTimeout(200);
    samples.push(await readMedia(panel));
  }
  after = samples[samples.length - 1];
  // Also try the mouse->touch bridge, which some Chromium builds tie to the pointer media features.
  await cdp.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
  const bridged = await readMedia(panel);
  await cdp.send('Emulation.setEmitTouchEventsForMouse', { enabled: false });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  const off = await readMedia(panel);
  console.log('TOUCHPROBE A ' + JSON.stringify({ before, after, samples: samples.length, bridged, off }));
});

test('touch B: a persistent context launched with hasTouch: true', async ({ fixtures }) => {
  test.setTimeout(150_000);
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true, colorScheme: 'dark', viewport: { width: 1280, height: 800 },
    locale: 'en-US', hasTouch: true, args: launchArgs({}),
  });
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
    const harness = await setupTwoWindows(context, sw, fixtures);
    await harness.panel.setViewportSize(PANEL_VIEWPORT);
    await oneGroup(harness, sw);
    await harness.panel.mouse.move(2, 2);
    const media = await readMedia(harness.panel);
    console.log('TOUCHPROBE B ' + JSON.stringify(media));
  } finally {
    await context.close();
  }
});


// ── reflow: is focus lost again when the LAST tab of the group closes, after the hand-off? (throwaway, hypothesis P) ──
const CARD = '#tablist [data-testid="tab-card"]';

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

test('reflow: Chrome ungroups the last tab of the group, then closes it, after the hand-off', async ({ harness, serviceWorker }) => {
  const { panel } = harness;
  await panel.setViewportSize(PANEL_VIEWPORT);
  await setSettings(serviceWorker, { refreshInterval: 'off', confirmCloseThreshold: 10 });
  const { ids, work } = await buildLayout(harness, serviceWorker);
  await expect.poll(() => panel.evaluate(() => window.__vt.settings.confirmCloseThreshold)).toBe(10);
  await panel.evaluate(install);
  // The panel's own chrome.tabs.remove is held for good: Chrome is driven by hand below.
  await panel.evaluate(() => {
    window.__held = 0;
    chrome.tabs.remove = () => { window.__held += 1; return new Promise(() => {}); };
  });
  await panel.locator(`.group[data-group-id="${work}"] ${HEADER} .group-swatch`).focus();
  await panel.keyboard.press('Tab');
  await panel.keyboard.press('Enter');
  await expect.poll(() => panel.evaluate(() => window.__held)).toBe(1);
  await panel.evaluate(() => window.__fd.L('=== SW: remove alpha beta, ungroup gamma'));
  await swEval(serviceWorker, async (a) => {
    await chrome.tabs.remove([a.alpha, a.beta]);
    await chrome.tabs.ungroup(a.gamma);
  }, ids);
  const focusOf = () => panel.evaluate(() => {
    const el = document.activeElement;
    const card = el && el.closest('[data-testid="tab-card"]');
    return el === document.body ? 'body' : (card ? `card ${card.dataset.tabId}` : (el.id || el.tagName));
  });
  let first = null;
  for (let i = 0; i < 50 && first !== `card ${ids.delta}`; i += 1) { first = await focusOf(); if (first !== `card ${ids.delta}`) await panel.waitForTimeout(100); }
  await panel.evaluate(() => window.__fd.L('=== after ungroup: hand-off state seen by the test'));
  await panel.evaluate(() => window.__fd.L('=== SW: remove gamma'));
  await swEval(serviceWorker, (id) => chrome.tabs.remove(id), ids.gamma);
  await expect(panel.locator(CARD)).toHaveCount(2, { timeout: 10_000 });
  await panel.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const finalFocus = await focusOf();
  const log = await panel.evaluate(() => window.__fd.log);
  console.log(`REFLOWPROBE afterUngroup=${first} afterRemoveGamma=${finalFocus}`);
  for (const e of log) console.log('REFLOWLOG ' + JSON.stringify(e));
});


// ── slow: a close that lands after the deadline (written after the first run of the three above; same instrumentation) ──
test('slow: the close lands after the hand-off deadline', async ({ harness, serviceWorker }) => {
  const { panel } = harness;
  await panel.setViewportSize(PANEL_VIEWPORT);
  await setSettings(serviceWorker, { refreshInterval: 'off', confirmCloseThreshold: 10 });
  const { ids, work } = await buildLayout(harness, serviceWorker);
  await expect.poll(() => panel.evaluate(() => window.__vt.settings.confirmCloseThreshold)).toBe(10);
  await panel.evaluate(install);
  await panel.evaluate(() => {
    const real = chrome.tabs.remove.bind(chrome.tabs);
    let open;
    const gate = new Promise((resolve) => { open = resolve; });
    window.__gateOpen = open;
    chrome.tabs.remove = (...args) => { window.__fd.L('tabs.remove HELD', { arg: JSON.stringify(args[0]) }); return gate.then(() => real(...args)); };
  });
  await panel.locator(`.group[data-group-id="${work}"] ${HEADER} .group-swatch`).focus();
  await panel.keyboard.press('Tab');
  await panel.keyboard.press('Enter');
  await expect.poll(() => panel.evaluate(() => window.__fd.log.some((e) => e.what === 'tabs.remove HELD'))).toBe(true);
  await panel.evaluate(() => {
    window.__fd.L('=== clock +10 s, request released');
    const real = Date.now.bind(Date);
    Date.now = () => real() + 10_000;
    window.__gateOpen();
  });
  await expect(panel.locator(CARD)).toHaveCount(2, { timeout: 10_000 });
  await panel.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const finalFocus = await panel.evaluate(() => {
    const el = document.activeElement;
    const card = el && el.closest('[data-testid="tab-card"]');
    return el === document.body ? 'body' : (card ? `card ${card.dataset.tabId}` : (el.id || el.tagName));
  });
  const log = await panel.evaluate(() => window.__fd.log);
  console.log(`SLOWPROBE final=${finalFocus} successor(delta)=card ${ids.delta}`);
  for (const e of log) console.log('SLOWLOG ' + JSON.stringify(e));
});
