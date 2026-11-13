// 103-group-close-focus-park-probe — platform probe, extends "Probe 16" in .agent/probe-results.md (PR #20, round 3, gap b).
//
// NOT a regression test of Vertical Tabs. CLAUDE.md §7.2 forbids answering from memory. keyboard.js (round 3) drops the hand-off of a
// group's x when focus is lost to <body> while the group is still drawn (`onFocusOut`). Question: where does focus go, and what does the
// hand-off do afterwards, when the user PARKS focus while that entry is armed?
//   V1 text         the confirm bar is open (Enter on the x, threshold 3); a real mouse press on the bar's text (a <p>, no tabindex)
//   V2 bar-padding  the same, on the bar's own padding (no child under the pointer)
//   V3 list-empty   the same, on empty room inside #tablist (it has tabindex="-1", so it may take the focus itself)
//   V4 escape       no bar (threshold 10); the close is held at a gate (chrome.tabs.remove not yet answered); Escape on the focused x
// For each: what has focus after the press and two frames later, the focus events with their targets, and where focus ends once the
// group goes (V1-V3: the bar is answered Yes with the mouse; V4: the held close is let through).
// Nothing in the extension is changed. The spec asserts only its premises (the bar was up, the group went); the answer is in the `FACT ` lines.
//
// PASS criterion, written before the first run: every variant printed its record (the element under the pointer, focus after the press,
// focus after two frames, the focus events, focus at the end).
//
// Run (probes live outside testDir; in the e2e container, never on the host; EXT_DIR picks the extension under test):
//   env VT_TEST_DIR=./probes playwright test 103-group-close-focus-park-probe.spec.js --repeat-each=3 --retries=0 --reporter=list
'use strict';

const { test, expect } = require('../fixtures');
const { swEval, setSettings, createTab } = require('../helpers/chrome');

const HEADER = '[data-testid="group-header"]';
const CARD = '#tablist [data-testid="tab-card"]';
const BAR = '[data-testid="confirm-bar"]';
const PANEL_VIEWPORT = { width: 400, height: 1500 };

/** [Other: delta] [Work: alpha beta gamma] epsilon (loose): the card that follows Work is epsilon, which is not the first card of the list. */
async function layout(harness, serviceWorker) {
  const { w2, tabIds, urls, panel } = harness;
  const delta = await createTab(serviceWorker, w2, urls.delta, { active: false });
  const epsilon = await createTab(serviceWorker, w2, urls.page('ffff00', 'Epsilon'), { active: false });
  const ids = { alpha: tabIds.alpha, beta: tabIds.beta, gamma: tabIds.gamma, delta, epsilon };
  const groups = await swEval(serviceWorker, async (a) => {
    const work = await chrome.tabs.group({ tabIds: [a.alpha, a.beta, a.gamma], createProperties: { windowId: a.wid } });
    await chrome.tabGroups.update(work, { title: 'Work', color: 'blue' });
    const other = await chrome.tabs.group({ tabIds: [a.delta], createProperties: { windowId: a.wid } });
    await chrome.tabGroups.update(other, { title: 'Other', color: 'red' });
    await chrome.tabGroups.move(other, { index: 0 });
    return { work, other };
  }, { ...ids, wid: w2 });
  const order = await swEval(serviceWorker, async (wid) => (await chrome.tabs.query({ windowId: wid }))
    .sort((a, b) => a.index - b.index).map((t) => t.id), w2);
  expect(order, 'setup: the layout is Other, Work, epsilon').toEqual([ids.delta, ids.alpha, ids.beta, ids.gamma, ids.epsilon]);
  await expect(panel.locator(HEADER)).toHaveCount(2, { timeout: 10_000 });
  await expect(panel.locator(CARD)).toHaveCount(5, { timeout: 10_000 });
  return { ids, ...groups };
}

/** Page-side logger: focus events with the target's connectedness and what has focus at event time; pointer events. */
const installLog = () => {
  if (window.__pk) return;
  const pk = (window.__pk = { log: [], t0: performance.now() });
  const desc = (el) => {
    if (!el) return null;
    if (el === document.body) return 'BODY';
    if (el.nodeType !== 1) return el.nodeName;
    const d = el.dataset || {};
    return el.tagName.toLowerCase() + (d.testid ? `[${d.testid}]` : '') + (el.id ? `#${el.id}` : '')
      + (el.classList.contains('tab-card') ? `.card#t${d.tabId}` : '');
  };
  pk.desc = desc;
  const L = (what, extra) => pk.log.push(Object.assign({ t: Math.round((performance.now() - pk.t0) * 10) / 10, what, active: desc(document.activeElement) }, extra));
  pk.L = L;
  for (const type of ['focusin', 'focusout']) {
    document.addEventListener(type, (e) => L(type, {
      target: desc(e.target), related: desc(e.relatedTarget), connected: Boolean(e.target && e.target.isConnected),
    }), true);
  }
  for (const type of ['mousedown', 'mouseup', 'click', 'keydown']) {
    document.addEventListener(type, (e) => L(type, { target: desc(e.target), key: e.key }), true);
  }
};
const note = (panel, text) => panel.evaluate((s) => window.__pk.L(`=== ${s}`), text);
const activeDesc = (panel) => panel.evaluate(() => window.__pk.desc(document.activeElement));
const frames = (panel, n = 2) => panel.evaluate(async (k) => {
  for (let i = 0; i < k; i += 1) await new Promise((r) => (document.hidden ? setTimeout(r, 0) : requestAnimationFrame(r)));
}, n);
const holdRemovals = (panel) => panel.evaluate(() => {
  const real = chrome.tabs.remove.bind(chrome.tabs);
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  window.__removals = { held: 0, open };
  chrome.tabs.remove = (...args) => { window.__removals.held += 1; return gate.then(() => real(...args)); };
});

async function tabToTheX(panel, groupId) {
  await panel.locator(`.group[data-group-id="${groupId}"] ${HEADER} .group-swatch`).focus();
  await panel.keyboard.press('Tab');
  return activeDesc(panel);
}

/** A real press and release at (x, y); returns what has focus after each, and what is under the pointer. */
async function pressAt(panel, x, y) {
  const hit = await panel.evaluate(([px, py]) => window.__pk.desc(document.elementFromPoint(px, py)), [x, y]);
  await panel.mouse.move(x, y);
  await panel.mouse.down();
  const afterDown = await activeDesc(panel);
  await panel.mouse.up();
  const afterUp = await activeDesc(panel);
  return { hit, afterDown, afterUp };
}

const VARIANTS = ['text', 'bar-padding', 'list-empty'];
for (const variant of VARIANTS) {
  test(`park V: ${variant} (confirm bar open, then Yes)`, async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await panel.setViewportSize(PANEL_VIEWPORT);
    await setSettings(serviceWorker, { refreshInterval: 'off', confirmCloseThreshold: 3 });
    const { ids, work } = await layout(harness, serviceWorker);
    await expect.poll(() => panel.evaluate(() => window.__vt.settings.confirmCloseThreshold)).toBe(3);
    await panel.evaluate(installLog);

    expect(await tabToTheX(panel, work), 'setup: Tab from the swatch must land on the x').toBe('button[group-close]');
    await panel.keyboard.press('Enter');
    await expect(panel.locator(BAR), 'setup: three tabs at threshold three must ask').toBeVisible({ timeout: 10_000 });
    const onBar = await activeDesc(panel);

    let target;
    if (variant === 'text') {
      const b = await panel.locator('[data-testid="confirm-text"]').boundingBox();
      target = [b.x + b.width / 2, b.y + b.height / 2];
    } else if (variant === 'bar-padding') {
      const b = await panel.locator(BAR).boundingBox();
      target = [b.x + 2, b.y + b.height / 2];
    } else {
      const t = await panel.locator('#tablist').boundingBox();
      const bar = await panel.locator(BAR).boundingBox();
      target = [t.x + t.width / 2, Math.min(t.y + t.height, bar.y) - 60];
    }
    await note(panel, 'press');
    const press = await pressAt(panel, target[0], target[1]);
    await frames(panel, 2);
    const afterFrames = await activeDesc(panel);
    await expect(panel.locator(BAR), 'the press must not have answered the question').toBeVisible();

    await note(panel, 'Yes');
    await panel.locator('[data-testid="confirm-ok"]').click();
    await expect(panel.locator(CARD), 'Yes must close the group').toHaveCount(2, { timeout: 10_000 });
    await frames(panel, 3);
    const final = await activeDesc(panel);

    const log = await panel.evaluate(() => window.__pk.log);
    const from = log.findIndex((e) => e.what === '=== press');
    const until = log.findIndex((e) => e.what === '=== Yes');
    console.log(`FACT park.${variant} ${JSON.stringify({
      onBarBeforeThePress: onBar, hit: press.hit, afterDown: press.afterDown, afterUp: press.afterUp, afterTwoFrames: afterFrames,
      finalAfterYes: final, epsilon: `card#t${ids.epsilon}`,
    })}`);
    for (const e of log.slice(from, until).filter((x) => ['focusin', 'focusout', 'mousedown', 'mouseup', 'click'].includes(x.what))) {
      console.log(`FACT park.${variant}.event ${JSON.stringify(e)}`);
    }
  });
}

test('park V: escape (no bar, the close is held, Escape on the focused x)', async ({ harness, serviceWorker }) => {
  const { panel } = harness;
  await panel.setViewportSize(PANEL_VIEWPORT);
  await setSettings(serviceWorker, { refreshInterval: 'off', confirmCloseThreshold: 10 });
  const { ids, work } = await layout(harness, serviceWorker);
  await expect.poll(() => panel.evaluate(() => window.__vt.settings.confirmCloseThreshold)).toBe(10);
  await panel.evaluate(installLog);
  await holdRemovals(panel);

  expect(await tabToTheX(panel, work), 'setup: Tab from the swatch must land on the x').toBe('button[group-close]');
  await panel.keyboard.press('Enter');
  await expect.poll(() => panel.evaluate(() => window.__removals.held), { message: 'the x never asked Chrome to close the tabs' }).toBe(1);
  await note(panel, 'Escape');
  await panel.keyboard.press('Escape');
  const afterEscape = await activeDesc(panel);
  await frames(panel, 2);
  const afterFrames = await activeDesc(panel);

  await note(panel, 'release');
  await panel.evaluate(() => window.__removals.open());
  await expect(panel.locator(CARD), 'the held close must land').toHaveCount(2, { timeout: 10_000 });
  await frames(panel, 3);
  const final = await activeDesc(panel);

  const log = await panel.evaluate(() => window.__pk.log);
  const from = log.findIndex((e) => e.what === '=== Escape');
  const until = log.findIndex((e) => e.what === '=== release');
  console.log(`FACT park.escape ${JSON.stringify({ afterEscape, afterTwoFrames: afterFrames, finalAfterTheCloseLanded: final, epsilon: `card#t${ids.epsilon}` })}`);
  for (const e of log.slice(from, until).filter((x) => ['focusin', 'focusout', 'keydown'].includes(x.what))) {
    console.log(`FACT park.escape.event ${JSON.stringify(e)}`);
  }
});
