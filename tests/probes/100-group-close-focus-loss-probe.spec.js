// 100-group-close-focus-loss-probe — platform probe, extends "Probe 16" in .agent/probe-results.md (PR #20, round 3).
//
// NOT a regression test of Vertical Tabs. CLAUDE.md §7.2 forbids answering from memory, and round 3 of PR #20 needs
// these facts before it can say what a "focus loss while the group is still drawn" is (keyboard.js, `pendingFocus`
// with `awaitRemoval`, the entry that is left behind by a Cancelled close):
//   F1  Does removing, or moving, a focused element fire `blur` / `focusout` in this Chromium? When (inside the DOM call
//       or later), with what `relatedTarget`, is the target still connected in the handler, and what is
//       `document.activeElement` inside the handler and two frames later?   (test `toy`, then `removal`)
//   F2  Does a mouse press on the x inside the draggable header focus the x?  (test `mouse`)
//   F3  What do the focus events look like across the confirm bar (the x -> the bar's OK -> back to the x), for a
//       keyboard close and a mouse close, answered Yes and answered No?  (test `bar`)
//   F4  What does Escape on the x do after the bar was cancelled (`active.blur()` in keyboard.js onEscape)?  (test `bar`)
//   F5  Does a render that reorders the groups take focus off a group's x (the x's own group element moved)?  (test `reorder`)
// Nothing in the extension is changed. The page is instrumented from the test (group-close-focus-instrumentation.js
// plus `installExtra` below, which logs `focus`/`blur`/`focusin`/`focusout` with the target's `isConnected` at event
// time). Every fact is printed as a `FACT ` line with a JSON body; the spec asserts nothing but "the record exists".
//
// PASS criterion, written before the first run: every test printed its FACT lines (a record per variant).
//
// Run (probes live outside testDir; in the e2e container, never on the host):
//   env VT_TEST_DIR=./probes playwright test 100-group-close-focus-loss-probe.spec.js --reporter=list --retries=0
'use strict';

const { test, expect } = require('../fixtures');
const { swEval, setSettings, createTab } = require('../helpers/chrome');
const { install } = require('./group-close-focus-instrumentation');

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

const installExtra = () => {
  if (window.__ex) return;
  const ex = (window.__ex = { log: [], t0: performance.now() });
  const now = () => Math.round((performance.now() - ex.t0) * 10) / 10;
  const desc = (el) => {
    if (!el) return null;
    if (el === document.body) return 'BODY';
    if (el.nodeType !== 1) return el.nodeName;
    const d = el.dataset || {};
    return el.tagName.toLowerCase() + (d.testid ? `[${d.testid}]` : '')
      + (el.classList.contains('group') ? `.group#g${d.groupId}` : '')
      + (el.classList.contains('tab-card') ? `.card#t${d.tabId}` : '') + (el.id ? `#${el.id}` : '');
  };
  ex.desc = desc;
  ex.now = now;
  const L = (what, extra) => ex.log.push(Object.assign({ t: now(), what, active: desc(document.activeElement) }, extra));
  ex.L = L;
  for (const type of ['focusin', 'focusout', 'focus', 'blur']) {
    document.addEventListener(type, (e) => {
      const t = e.target;
      const grp = t && t.closest ? t.closest('.group') : null;
      L(type, {
        target: desc(t), related: desc(e.relatedTarget), connected: Boolean(t && t.isConnected),
        group: grp ? `g${grp.dataset.groupId}` : null, groupConnected: grp ? grp.isConnected : null,
      });
    }, true);
  }
  for (const type of ['click', 'keydown', 'keyup', 'mousedown', 'mouseup', 'pointerdown']) {
    document.addEventListener(type, (e) => L(type, { target: desc(e.target), detail: e.detail, key: e.key, repeat: e.repeat }), true);
  }
};

const dump = (label, entries) => {
  for (const e of entries) console.log(`FACT ${label} ${JSON.stringify(e)}`);
};

/** Entries of both logs from `since` (an `fd` log length and an `ex` log length), in time order of their own clocks (they share a t0 per install). */
const readLogs = (panel) => panel.evaluate(() => ({ fd: window.__fd.log, ex: window.__ex.log }));
const mark = (panel, text) => panel.evaluate((s) => { window.__fd.L(`=== ${s}`); window.__ex.L(`=== ${s}`); }, text);
const frames = (panel, n = 2) => panel.evaluate(async (k) => {
  for (let i = 0; i < k; i += 1) await new Promise((r) => (document.hidden ? setTimeout(r, 0) : requestAnimationFrame(r)));
}, n);
const activeDesc = (panel) => panel.evaluate(() => window.__ex.desc(document.activeElement));

const holdRemovals = (panel) => panel.evaluate(() => {
  const real = chrome.tabs.remove.bind(chrome.tabs);
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  window.__removals = { held: 0, open };
  chrome.tabs.remove = (...args) => { window.__removals.held += 1; return gate.then(() => real(...args)); };
});
const releaseRemovals = (panel) => panel.evaluate(() => window.__removals.open());

async function tabFromSwatch(panel, groupId) {
  await panel.locator(`.group[data-group-id="${groupId}"] ${HEADER} .group-swatch`).focus();
  await panel.keyboard.press('Tab');
  return activeDesc(panel);
}

async function prepare(harness, serviceWorker, threshold) {
  const { panel } = harness;
  await panel.setViewportSize(PANEL_VIEWPORT);
  await setSettings(serviceWorker, { refreshInterval: 'off', confirmCloseThreshold: threshold });
  const layout = await buildLayout(harness, serviceWorker);
  await expect.poll(() => panel.evaluate(() => window.__vt.settings.confirmCloseThreshold)).toBe(threshold);
  await panel.evaluate(install);
  await panel.evaluate(installExtra);
  return layout;
}

// F1, part 1: toy elements, so that what Chromium does is separated from what the panel's own code does.
test('toy: blur / focusout when a focused element is removed or moved', async ({ harness }) => {
  const { panel } = harness;
  await panel.evaluate(installExtra);
  const result = await panel.evaluate(async () => {
    const ex = window.__ex;
    const out = [];
    for (const kind of ['remove-self', 'remove-ancestor', 'removeChild', 'replaceChildren', 'move-ancestor-insertBefore', 'move-ancestor-append']) {
      const wrap = document.createElement('div');
      const btn = document.createElement('button');
      btn.textContent = 'toy';
      wrap.append(btn);
      const sib = document.createElement('div');
      document.body.append(sib, wrap);
      btn.focus();
      const events = [];
      const h = (e) => events.push({
        type: e.type, target: ex.desc(e.target), related: ex.desc(e.relatedTarget), connected: e.target.isConnected,
        activeInHandler: ex.desc(document.activeElement), t: ex.now(),
      });
      for (const type of ['blur', 'focusout']) document.addEventListener(type, h, true);
      const focusedBefore = document.activeElement === btn;
      const t0 = ex.now();
      if (kind === 'remove-self') btn.remove();
      else if (kind === 'remove-ancestor') wrap.remove();
      else if (kind === 'removeChild') wrap.removeChild(btn);
      else if (kind === 'replaceChildren') wrap.replaceChildren();
      else if (kind === 'move-ancestor-insertBefore') document.body.insertBefore(wrap, sib);
      else if (kind === 'move-ancestor-append') document.body.append(wrap);
      const syncEvents = events.length;
      const activeRightAfter = ex.desc(document.activeElement);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (const type of ['blur', 'focusout']) document.removeEventListener(type, h, true);
      out.push({
        kind, focusedBefore, eventsFiredInsideTheCall: syncEvents, eventsTotal: events.length, activeRightAfter,
        activeTwoFramesLater: ex.desc(document.activeElement), events: events.map((e) => ({ ...e, t: Math.round((e.t - t0) * 10) / 10 })),
      });
      wrap.remove(); sib.remove();
      document.body.focus();
    }
    return out;
  });
  dump('toy', result);
  expect(result.length).toBe(6);
});

// F1, part 2 + F4: the real thing. Keyboard close below the threshold; then a Cancelled close and Escape on the x.
test('removal: focus events when the group (and the x with it) goes', async ({ harness, serviceWorker }) => {
  const { panel } = harness;
  const { work } = await prepare(harness, serviceWorker, 10);
  const x = panel.locator(`.group[data-group-id="${work}"] ${X}`);
  await expect(x).toHaveCount(1, { timeout: 10_000 });
  expect(await tabFromSwatch(panel, work)).toBe('button[group-close]');
  await mark(panel, 'Enter on the x');
  await panel.keyboard.press('Enter');
  await expect(panel.locator(CARD)).toHaveCount(2, { timeout: 10_000 });
  await frames(panel, 3);
  await mark(panel, 'two cards left, three frames later');
  const logs = await readLogs(panel);
  const from = (arr) => arr.slice(arr.findIndex((e) => e.what === '=== Enter on the x'));
  dump('removal.ex', from(logs.ex).filter((e) => ['focus', 'blur', 'focusin', 'focusout', 'click', 'keydown', 'keyup', '=== Enter on the x', '=== two cards left, three frames later'].includes(e.what)));
  dump('removal.fd', from(logs.fd).filter((e) => !['MO', 'keyup', 'keydown', 'click'].includes(e.what)));
  dump('removal.fd.MO', from(logs.fd).filter((e) => e.what === 'MO'));
  console.log(`FACT removal.final ${JSON.stringify({ active: await activeDesc(panel) })}`);
});

// F2: does a mouse press focus the x? (the header is draggable)
for (const before of ['body', 'card']) {
  test(`mouse: a real press on the x, focus before = ${before}`, async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    const { work, ids } = await prepare(harness, serviceWorker, 10);
    await holdRemovals(panel);
    if (before === 'card') await panel.locator(`${CARD}[data-tab-id="${ids.epsilon}"]`).focus();
    else await panel.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
    const beforeDesc = await activeDesc(panel);
    await panel.locator(`.group[data-group-id="${work}"] ${HEADER}`).hover();
    const box = await panel.locator(`.group[data-group-id="${work}"] ${X}`).boundingBox();
    await panel.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await mark(panel, 'mouse down');
    await panel.mouse.down();
    const afterDown = await activeDesc(panel);
    await panel.mouse.up();
    const afterUp = await activeDesc(panel);
    await frames(panel, 2);
    const heldCalls = await panel.evaluate(() => window.__removals.held);
    console.log(`FACT mouse.${before} ${JSON.stringify({ beforeDesc, afterDown, afterUp, afterFrames: await activeDesc(panel), heldCalls })}`);
    const logs = await readLogs(panel);
    const i = logs.ex.findIndex((e) => e.what === '=== mouse down');
    dump(`mouse.${before}.ex`, logs.ex.slice(i).filter((e) => ['focus', 'blur', 'focusin', 'focusout', 'mousedown', 'mouseup', 'click', 'pointerdown', '=== mouse down'].includes(e.what)));
    // and the same press on the title (the header has tabindex -1)
    await mark(panel, 'mouse down on title');
    const tb = await panel.locator(`.group[data-group-id="${work}"] ${HEADER} .group-title`).boundingBox();
    await panel.mouse.move(tb.x + 4, tb.y + tb.height / 2);
    await panel.mouse.down();
    const titleDown = await activeDesc(panel);
    await panel.mouse.up();
    console.log(`FACT mouse.${before}.title ${JSON.stringify({ afterDown: titleDown, afterUp: await activeDesc(panel) })}`);
    await releaseRemovals(panel);
    await expect(panel.locator(CARD)).toHaveCount(2, { timeout: 10_000 });
  });
}

// F3 + F4: the confirm bar, by keyboard and by mouse.
test('bar: focus events across the confirm bar (Enter on the x, Escape; Enter on the x, Enter on OK; Escape on the x)', async ({ harness, serviceWorker }) => {
  const { panel } = harness;
  const { work } = await prepare(harness, serviceWorker, 3);
  const sel = (name) => [...['focus', 'blur', 'focusin', 'focusout', 'click', 'keydown'], '=== ' + name];
  const section = async (name) => {
    const logs = await readLogs(panel);
    const i = logs.ex.findIndex((e) => e.what === `=== ${name}`);
    dump(`bar.${name}`, logs.ex.slice(i).filter((e) => sel(name).includes(e.what)));
  };

  expect(await tabFromSwatch(panel, work)).toBe('button[group-close]');
  await mark(panel, 'A Enter on the x');
  await panel.keyboard.press('Enter');
  await expect(panel.locator(BAR)).toBeVisible({ timeout: 10_000 });
  console.log(`FACT bar.A.focusOnBar ${JSON.stringify({ active: await activeDesc(panel) })}`);
  await panel.keyboard.press('Escape');
  await expect(panel.locator(BAR)).toBeHidden();
  await frames(panel, 2);
  console.log(`FACT bar.A.afterEscape ${JSON.stringify({ active: await activeDesc(panel) })}`);
  await section('A Enter on the x');

  await mark(panel, 'B Escape on the x');
  await panel.keyboard.press('Escape');
  await frames(panel, 2);
  console.log(`FACT bar.B.afterSecondEscape ${JSON.stringify({ active: await activeDesc(panel) })}`);
  await section('B Escape on the x');

  // C: ask again, mouse path: click the x, then Cancel with the mouse.
  const x = panel.locator(`.group[data-group-id="${work}"] ${X}`);
  await panel.locator(`.group[data-group-id="${work}"] ${HEADER}`).hover();
  await mark(panel, 'C mouse click on the x');
  await x.click();
  await expect(panel.locator(BAR)).toBeVisible({ timeout: 10_000 });
  console.log(`FACT bar.C.focusOnBar ${JSON.stringify({ active: await activeDesc(panel) })}`);
  await panel.locator('[data-testid="confirm-cancel"]').click();
  await expect(panel.locator(BAR)).toBeHidden();
  await frames(panel, 2);
  console.log(`FACT bar.C.afterCancelClick ${JSON.stringify({ active: await activeDesc(panel) })}`);
  await section('C mouse click on the x');

  // D: ask again by keyboard and confirm with Enter on the OK.
  await panel.locator(`.group[data-group-id="${work}"] ${HEADER} .group-swatch`).focus();
  await panel.keyboard.press('Tab');
  await mark(panel, 'D Enter on the x, Enter on OK');
  await panel.keyboard.press('Enter');
  await expect(panel.locator(BAR)).toBeVisible({ timeout: 10_000 });
  await panel.keyboard.press('Enter');
  await expect(panel.locator(CARD)).toHaveCount(2, { timeout: 10_000 });
  await frames(panel, 3);
  console.log(`FACT bar.D.final ${JSON.stringify({ active: await activeDesc(panel) })}`);
  await section('D Enter on the x, Enter on OK');
  const logs = await readLogs(panel);
  const i = logs.fd.findIndex((e) => e.what === '=== D Enter on the x, Enter on OK');
  dump('bar.D.fd', logs.fd.slice(i).filter((e) => e.what.startsWith('DOM ') || e.what === 'frame: activeElement changed' || e.what === 'tabGroups.onRemoved'));
});

// F5: does a reorder render take focus off a group's x? The x is focused and a close is held; the SW moves the OTHER
// group in front of Work. Which element did the render move, and did the x keep focus?
for (const [label, move] of [
  ['Other moved in front of Work', 'other-first'],
  ['Work moved behind Other', 'work-last'],
  ['the group in front of Other (Work) is closed from outside: Other stands behind a stale element', 'stale-before'],
]) {
  test(`reorder: ${label}`, async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    const { work, other, ids } = await prepare(harness, serviceWorker, 10);
    // The x that holds focus belongs to Work, except in `stale-before`, where it is Other's (the second group).
    const focusGroup = move === 'stale-before' ? other : work;
    await holdRemovals(panel);
    expect(await tabFromSwatch(panel, focusGroup)).toBe('button[group-close]');
    await panel.keyboard.press('Enter');
    await expect.poll(() => panel.evaluate(() => window.__removals.held)).toBe(1);
    await mark(panel, 'reorder');
    await swEval(serviceWorker, async (a) => {
      if (a.move === 'other-first') await chrome.tabGroups.move(a.other, { index: 0 });
      else if (a.move === 'work-last') await chrome.tabGroups.move(a.work, { index: -1 });
      else await chrome.tabs.remove([a.alpha, a.beta, a.gamma]);
    }, { work, other, move, alpha: ids.alpha, beta: ids.beta, gamma: ids.gamma });
    if (move === 'stale-before') {
      await expect(panel.locator(CARD)).toHaveCount(2, { timeout: 10_000 });
    } else {
      await expect.poll(async () => panel.evaluate(() => [...document.querySelectorAll('#tablist .group')].map((g) => g.dataset.groupId).join(',')),
        { timeout: 10_000 }).toBe(`${other},${work}`);
    }
    await frames(panel, 3);
    console.log(`FACT reorder.${move}.final ${JSON.stringify({ active: await activeDesc(panel), order: await panel.evaluate(() => [...document.querySelectorAll('#tablist .group')].map((g) => g.dataset.groupId)) })}`);
    const logs = await readLogs(panel);
    const i = logs.fd.findIndex((e) => e.what === '=== reorder');
    dump(`reorder.${move}.fd`, logs.fd.slice(i).filter((e) => e.what.startsWith('DOM ') || e.what === 'frame: activeElement changed' || e.what === 'MO' || e.what === 'focusout' || e.what === 'focusin'));
    await releaseRemovals(panel);
    // what is left once the held close of the focused x's group lands
    await expect(panel.locator(CARD)).toHaveCount(move === 'stale-before' ? 1 : 2, { timeout: 10_000 });
    await frames(panel, 3);
    console.log(`FACT reorder.${move}.afterRelease ${JSON.stringify({ active: await activeDesc(panel) })}`);
  });
}
