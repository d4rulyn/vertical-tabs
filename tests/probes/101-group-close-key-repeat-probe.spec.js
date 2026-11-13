// 101-group-close-key-repeat-probe — platform probe, extends "Probe 16" in .agent/probe-results.md (PR #20, round 3).
//
// NOT a regression test of Vertical Tabs. Question (CLAUDE.md §7.2, nothing about Chromium from memory): keyboard.js
// lets Enter and Space through when they land on the x (`onGroupHeaderKey`, `onClose`), so the browser turns them into
// the click group-close.js listens for. Does a REPEATED Enter keydown (`event.repeat === true`, a held key) make
// Chromium fire a click on a focused button again, and when the first click has opened the confirm bar (focus now on
// its OK button), does the OK receive one?  Space is measured alongside, since it clicks on keyup.
//   K1  does Playwright's synthetic keyboard reproduce a repeat? (`keyboard.down` on a key that is already down sends
//       `autoRepeat: true`; the page's `keydown` listener reads `event.repeat`)
//   K2  a plain button: clicks per held Enter / held Space
//   K3  the real x, threshold 10 (no bar): clicks on the x, `chrome.tabs.remove` calls, for held Enter / held Space
//   K4  the real x, threshold 3 (the bar opens): clicks and their targets, whether the bar was answered Yes, whether a
//       tab closed, for held Enter / held Space
// Nothing in the extension is changed. Each fact is printed as a `FACT ` line with a JSON body; the spec asserts only
// that each premise held (the repeat flag was seen), so that "no click" is not read from a keyboard that never repeated.
//
// PASS criterion, written before the first run: each variant printed its record, and in every variant the page saw at
// least one keydown with `repeat === true` (otherwise the variant says nothing about a held key).
//
// Run (probes live outside testDir; in the e2e container, never on the host):
//   env VT_TEST_DIR=./probes playwright test 101-group-close-key-repeat-probe.spec.js --reporter=list --retries=0
'use strict';

const { test, expect } = require('../fixtures');
const { swEval, setSettings, createTab } = require('../helpers/chrome');

const HEADER = '[data-testid="group-header"]';
const CARD = '#tablist [data-testid="tab-card"]';
const BAR = '[data-testid="confirm-bar"]';
const X = '[data-testid="group-close"]';
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

const frames = (panel, n = 2) => panel.evaluate(async (k) => {
  for (let i = 0; i < k; i += 1) await new Promise((r) => (document.hidden ? setTimeout(r, 0) : requestAnimationFrame(r)));
}, n);

/** Page-side recorder: every keydown / keypress / keyup / click in the document (capture), with target, key, repeat and detail. */
const installRecorder = () => {
  const desc = (el) => {
    if (!el) return null;
    if (el === document.body) return 'BODY';
    const d = el.dataset || {};
    return el.tagName.toLowerCase() + (d.testid ? `[${d.testid}]` : '') + (el.id ? `#${el.id}` : '');
  };
  window.__rec = { events: [], desc };
  for (const type of ['keydown', 'keypress', 'keyup', 'click']) {
    document.addEventListener(type, (e) => window.__rec.events.push({
      type, target: desc(e.target), key: e.key, repeat: e.repeat, detail: e.detail,
    }), true);
  }
};
const resetRecorder = (panel) => panel.evaluate(() => { window.__rec.events.length = 0; });
const readRecorder = (panel) => panel.evaluate(() => window.__rec.events.slice());
const summarise = (events) => {
  const count = (type, extra = () => true) => events.filter((e) => e.type === type && extra(e)).length;
  return {
    keydowns: count('keydown'), repeatKeydowns: count('keydown', (e) => e.repeat === true), keypresses: count('keypress'),
    keyups: count('keyup'), clicks: events.filter((e) => e.type === 'click').map((e) => `${e.target}/detail${e.detail}`),
  };
};

const holdRemovals = (panel) => panel.evaluate(() => {
  const real = chrome.tabs.remove.bind(chrome.tabs);
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  window.__removals = { held: 0, open };
  chrome.tabs.remove = (...args) => { window.__removals.held += 1; return gate.then(() => real(...args)); };
});
const heldCalls = (panel) => panel.evaluate(() => window.__removals.held);

/** Holds `key`: a first keydown, then `extra` more keydowns with the key still down (Playwright sends autoRepeat for those), then keyup. */
async function hold(panel, key, extra = 2) {
  await panel.keyboard.down(key);
  await frames(panel, 1);
  for (let i = 0; i < extra; i += 1) await panel.keyboard.down(key);
  await frames(panel, 2);
  await panel.keyboard.up(key);
  await frames(panel, 2);
}

for (const key of ['Enter', 'Space']) {
  test(`K1/K2: a plain button, ${key} held`, async ({ harness }) => {
    const { panel } = harness;
    await panel.evaluate(installRecorder);
    await panel.evaluate(() => {
      const b = document.createElement('button');
      b.id = 'toyk';
      b.textContent = 'k';
      b.style.cssText = 'position:fixed;left:0;top:0;z-index:99999';
      document.body.append(b);
      b.focus();
    });
    await resetRecorder(panel);
    await hold(panel, key, 2);
    const events = await readRecorder(panel);
    const s = summarise(events);
    console.log(`FACT K2.toy.${key} ${JSON.stringify(s)}`);
    for (const e of events) console.log(`FACT K2.toy.${key}.event ${JSON.stringify(e)}`);
    expect(s.repeatKeydowns, 'premise: the synthetic keyboard must produce keydowns with repeat === true').toBeGreaterThan(0);
  });
}

for (const [threshold, label] of [[10, 'no bar'], [3, 'the bar opens']]) {
  for (const key of ['Enter', 'Space']) {
    test(`K3/K4: the x, threshold ${threshold} (${label}), ${key} held`, async ({ harness, serviceWorker }) => {
      const { panel } = harness;
      await panel.setViewportSize(PANEL_VIEWPORT);
      await setSettings(serviceWorker, { refreshInterval: 'off', confirmCloseThreshold: threshold });
      const { work, ids } = await buildLayout(harness, serviceWorker);
      await expect.poll(() => panel.evaluate(() => window.__vt.settings.confirmCloseThreshold)).toBe(threshold);
      await panel.evaluate(installRecorder);
      await holdRemovals(panel); // the group stays drawn, so that what the repeat does is read from a live panel
      await panel.locator(`.group[data-group-id="${work}"] ${HEADER} .group-swatch`).focus();
      await panel.keyboard.press('Tab');
      const onX = await panel.evaluate(() => window.__rec.desc(document.activeElement));
      expect(onX, 'setup: Tab from the swatch must land on the x').toBe('button[group-close]');
      await resetRecorder(panel);
      await hold(panel, key, 2);
      const events = await readRecorder(panel);
      const s = summarise(events);
      const bar = await panel.locator(BAR).isVisible();
      const open = await swEval(serviceWorker, async () => (await chrome.tabs.query({})).map((t) => t.id));
      console.log(`FACT K34.t${threshold}.${key} ${JSON.stringify({
        ...s, tabsRemoveCalls: await heldCalls(panel), barStillVisible: bar,
        active: await panel.evaluate(() => window.__rec.desc(document.activeElement)),
        closedInChrome: Object.entries(ids).filter(([, id]) => !open.includes(id)).map(([n]) => n),
      })}`);
      for (const e of events) console.log(`FACT K34.t${threshold}.${key}.event ${JSON.stringify(e)}`);
      expect(s.repeatKeydowns, 'premise: the synthetic keyboard must produce keydowns with repeat === true').toBeGreaterThan(0);
    });
  }
}
