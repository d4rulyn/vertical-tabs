// 42-group-header-close — the "x" on a tab-group header row, which closes the whole group.
//
// The owner approved this one element on 2026-11-04 (PR #20). It is a third way into a path that
// spec 33 already pins from the two menus: `closeTabs(ids)` in context-menu.js, which asks the
// confirm bar when the number of ids reaches `settings.confirmCloseThreshold` and otherwise calls
// `ops.remove`. These tests therefore do not re-prove the close path; they prove that the BUTTON
// reaches it with the right ids, and that it does nothing else a click on a group header does.
//
// Every claim about what closed is read from Chrome (`chrome.tabs.query({})` in the service worker,
// all windows), never from the panel's cards: a panel that merely stopped drawing a tab would pass
// a DOM-only check. The layout is spec 33's, for the same reason it is there:
//
//   [ alpha beta gamma ] = "Work"   [ delta ] = "Other"   epsilon (loose)
//
// Three members, a second group that is neither first nor holding the active tab, and a loose tab
// that a "close every ungrouped tab" bug would take.
//
// Each test must fail on a tree without the button BY ASSERTION, with three exceptions that PASS on such a tree ON PURPOSE.
// Measured (review of PR #20, S14, log p20g-nobtn.log): this file's 48 tests on main's extension, which has no button, two
// repeats = 96 runs, 6 passed and 90 failed, that is 3 tests passed in both repeats and 45 failed in both. The 3 are:
//   'keyboard: Enter and Space on the header itself and on its chevron still collapse and expand the group' (section 10),
//   'keyboard: Enter and Space on the colour swatch still open the colour picker, and do not toggle the group' (section 10),
//   'a card's own hand-off (Delete) arms no re-check timer, even when the card it waits for is not drawn' (section 13).
// Each pins what the button must NOT change, so none of them needs the button. Nothing here calls `.click()` on
// the button before an `expect` has asked for it: a bare click on a missing element waits for the
// 90 s test timeout (playwright.config.js:17) and reports nothing but the timeout.
//
// Run this file with `--retries=0`. playwright.config.js:16 sets `retries: 1`, which turns a first failure into a
// pass: a count of passing tests that was not taken with `--retries=0` says nothing about the first attempt.
'use strict';

const fs = require('fs');
const path = require('path');
const { test, expect, EXT, launchExtensionContext } = require('../fixtures');
const { swEval, setSettings, createTab } = require('../helpers/chrome');
const { setupTwoWindows } = require('../helpers/windows');

const MENU = '[data-testid="context-menu"]';
const HEADER = '[data-testid="group-header"]';
const CARD = '#tablist [data-testid="tab-card"]';
const BAR = '[data-testid="confirm-bar"]';
const X = '[data-testid="group-close"]';

// 400 px wide makes the cards short enough for five of them and two headers to fit (see spec 33).
const PANEL_VIEWPORT = Object.freeze({ width: 400, height: 1500 });

test.beforeEach(async ({ harness, serviceWorker }) => {
  await harness.panel.setViewportSize(PANEL_VIEWPORT);
  await setSettings(serviceWorker, { refreshInterval: 'off' });
});

const allOpenTabIds = (sw) => swEval(sw, async () => (await chrome.tabs.query({})).map((t) => t.id));
const settle = (panel) => panel.evaluate(() => window.__vt.stateModule.resync());
const pollThreshold = (panel, n) => expect.poll(
  () => panel.evaluate(() => window.__vt.settings.confirmCloseThreshold),
  { message: `the threshold ${n} never reached the panel` }).toBe(n);

/** Builds `[alpha beta gamma]=Work [delta]=Other epsilon`, and proves it was built (spec 33's helper). */
async function buildLayout(harness, serviceWorker) {
  const { w2, tabIds, urls, panel } = harness;
  const delta = await createTab(serviceWorker, w2, urls.delta, { active: false });
  const epsilon = await createTab(serviceWorker, w2, urls.page('ffff00', 'Epsilon'), { active: false });
  const ids = { alpha: tabIds.alpha, beta: tabIds.beta, gamma: tabIds.gamma, delta, epsilon };

  const groups = await swEval(serviceWorker, async (a) => {
    const work = await chrome.tabs.group({
      tabIds: [a.alpha, a.beta, a.gamma], createProperties: { windowId: a.wid },
    });
    await chrome.tabGroups.update(work, { title: 'Work', color: 'blue' });
    const other = await chrome.tabs.group({ tabIds: [a.delta], createProperties: { windowId: a.wid } });
    await chrome.tabGroups.update(other, { title: 'Other', color: 'red' });
    return { work, other };
  }, { ...ids, wid: w2 });

  const placed = await swEval(serviceWorker, async (wid) => Object.fromEntries(
    (await chrome.tabs.query({ windowId: wid })).map((t) => [t.id, t.groupId])), w2);
  expect(placed, 'setup did not build the layout these tests assume').toEqual({
    [ids.alpha]: groups.work,
    [ids.beta]: groups.work,
    [ids.gamma]: groups.work,
    [ids.delta]: groups.other,
    [ids.epsilon]: -1,
  });
  await expect(panel.locator(HEADER)).toHaveCount(2, { timeout: 10_000 });
  await expect(panel.locator(CARD)).toHaveCount(5, { timeout: 10_000 });
  return { ids, ...groups };
}

/** Asserts exactly `closedKeys` are gone and every other tab in `ids` survived. */
async function expectClosedExactly(serviceWorker, ids, closedKeys) {
  const open = await allOpenTabIds(serviceWorker);
  for (const [name, id] of Object.entries(ids)) {
    if (closedKeys.includes(name)) {
      expect(open, `${name} should have been closed, in every window`).not.toContain(id);
    } else {
      expect(open, `${name} should have survived`).toContain(id);
    }
  }
}

const WORK = ['alpha', 'beta', 'gamma'];
const headerOf = (panel, groupId) => panel.locator(`.group[data-group-id="${groupId}"] ${HEADER}`);
const xOf = (panel, groupId) => panel.locator(`.group[data-group-id="${groupId}"] ${X}`);
const WHY_X = 'every group header must carry a close button (data-testid="group-close")';

/** Waits until the group's x exists (an assertion, with a reason), then clicks it as a user would: hover the row first. */
async function clickX(panel, groupId) {
  const x = xOf(panel, groupId);
  await expect(x, WHY_X).toHaveCount(1, { timeout: 10_000 });
  await headerOf(panel, groupId).hover();
  await x.click();
}

const collapsedInChrome = (sw, groupId) => swEval(sw, async (id) => (await chrome.tabGroups.get(id)).collapsed, groupId);
const activeTabIdOf = (sw, windowId) => swEval(sw, async (wid) => {
  const [t] = await chrome.tabs.query({ windowId: wid, active: true });
  return t ? t.id : null;
}, windowId);
const ariaSelectedMap = (panel) => panel.evaluate(() => Object.fromEntries(
  [...document.querySelectorAll('#tablist [data-testid="tab-card"]')]
    .map((c) => [c.dataset.tabId, c.getAttribute('aria-selected')])));
const watchToasts = (panel) => panel.evaluate(() => {
  window.__toastLog = [];
  const el = document.getElementById('toast');
  new MutationObserver(() => { if (el.textContent) window.__toastLog.push(el.textContent); })
    .observe(el, { childList: true, characterData: true, subtree: true });
});
const toastLog = (panel) => panel.evaluate(() => window.__toastLog);
const watchPageErrors = (panel) => {
  const errors = [];
  panel.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
  return errors;
};

// ── 1. where it is ─────────────────────────────────────────────────────────────────────────────

test('every group header carries a close button, and nothing else does', async ({ harness, serviceWorker }) => {
  const { panel } = harness;
  const { work, other } = await buildLayout(harness, serviceWorker);

  await expect(panel.locator(X), 'one x per group header: two groups, two buttons').toHaveCount(2, { timeout: 10_000 });
  for (const [name, id] of [['Work', work], ['Other', other]]) {
    await expect(headerOf(panel, id).locator(`:scope > ${X}`), `${name}'s x must be a direct child of its header`).toHaveCount(1);
  }
  // Not on the loose card, not on any card, not on a pinned tile.
  await expect(panel.locator(`[data-testid="tab-card"] ${X}, #pinned ${X}`), 'a card or pinned tile grew a group-close button')
    .toHaveCount(0);
  // A real <button type=button>, last in the row, so the Tab order and Enter/Space come for free.
  const shape = await xOf(panel, work).evaluate((el) => ({
    tag: el.tagName,
    type: el.getAttribute('type'),
    last: el.parentElement.lastElementChild === el,
    classes: [...el.classList],
  }));
  expect(shape).toEqual({ tag: 'BUTTON', type: 'button', last: true, classes: ['group-close', 'iconbtn'] });
});

// ── 2. what it closes ──────────────────────────────────────────────────────────────────────────

test('the x closes every member of THAT group, in Chrome, and nothing else; the closed tabs stay reopenable',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
    const { ids, work, other } = await buildLayout(harness, serviceWorker);
    await pollThreshold(panel, 10);

    await clickX(panel, work);

    await expect(panel.locator(CARD)).toHaveCount(2, { timeout: 10_000 });
    await expectClosedExactly(serviceWorker, ids, WORK);
    await expect(panel.locator(HEADER), 'the other group should still be drawn').toHaveCount(1);
    await expect(panel.locator(BAR), 'below the threshold nothing may ask').toBeHidden();
    expect(await collapsedInChrome(serviceWorker, other), 'the other group must not have been collapsed').toBe(false);

    // Same path as the menus: the tabs went through chrome.tabs.remove, so the browser can reopen them.
    const reopenable = await swEval(serviceWorker, async () => {
      const items = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
      return items.flatMap((s) => (s.tab ? [s.tab.url] : (s.window && s.window.tabs ? s.window.tabs.map((t) => t.url) : [])));
    });
    for (const key of ['alpha', 'beta', 'gamma']) {
      expect(reopenable.some((u) => u === harness.urls[key]), `${key} is not in the recently-closed list`).toBe(true);
    }
  });

test('the x of the OTHER group closes only that group', async ({ harness, serviceWorker }) => {
  const { panel } = harness;
  await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
  const { ids, other } = await buildLayout(harness, serviceWorker);

  await clickX(panel, other);

  await expect(panel.locator(CARD)).toHaveCount(4, { timeout: 10_000 });
  await expectClosedExactly(serviceWorker, ids, ['delta']);
});

test('a collapsed group is closed completely, including the members the panel does not draw',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
    const { ids, work } = await buildLayout(harness, serviceWorker);
    await swEval(serviceWorker, (id) => chrome.tabGroups.update(id, { collapsed: true }), work);
    await expect(panel.locator(`.group[data-group-id="${work}"]`), 'setup: the panel did not collapse Work')
      .toHaveClass(/is-collapsed/, { timeout: 10_000 });

    await clickX(panel, work);

    await expect(panel.locator(CARD)).toHaveCount(2, { timeout: 10_000 });
    await expectClosedExactly(serviceWorker, ids, WORK);
  });

// A search filter only hides cards; the tab model is untouched and `tabIdsOfGroup` reads the model, so the
// menus close the members the filter hid (spec 33 pins that for both of them). The x is the third entry and
// must not be the one that closes only what is drawn. The header stays while one member still matches.
test('the x takes the members HIDDEN by the search filter too', async ({ harness, serviceWorker }) => {
  const { panel } = harness;
  await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
  const { ids, work } = await buildLayout(harness, serviceWorker);
  await pollThreshold(panel, 10);

  // 'alp' matches Alpha's title and URL and nothing else in the layout (spec 33 and 05 rely on the same).
  await panel.locator('#search-input').fill('alp');
  for (const name of ['beta', 'gamma']) {
    await expect(panel.locator(`[data-tab-id="${ids[name]}"]`), `premise: the filter must hide ${name}`)
      .toHaveClass(/is-hidden/, { timeout: 10_000 });
  }
  await expect(panel.locator(`[data-tab-id="${ids.alpha}"]`), 'premise: the filter must leave alpha showing')
    .not.toHaveClass(/is-hidden/);

  await clickX(panel, work);

  // Hidden cards are still DOM nodes: five cards less the group's three.
  await expect(panel.locator(CARD), 'the x left behind the members that the filter hid').toHaveCount(2, { timeout: 10_000 });
  await expectClosedExactly(serviceWorker, ids, WORK);
});

// ── 3. the confirm bar: the same threshold as the menu path ───────────────────────────────────

test('at the threshold the x asks first and closes nothing until Confirm; Cancel closes nothing; below it, no question',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 3 });
    const { ids, work, other } = await buildLayout(harness, serviceWorker);
    await pollThreshold(panel, 3);
    const bar = panel.locator(BAR);

    // Three members, threshold three: asks. The question carries the number.
    await clickX(panel, work);
    await expect(bar, 'a three-tab close went through without asking').toBeVisible({ timeout: 10_000 });
    await expect(bar).toContainText('3');
    await settle(panel);
    expect(await allOpenTabIds(serviceWorker), 'a tab closed before the bar was answered')
      .toEqual(expect.arrayContaining(Object.values(ids)));

    await panel.locator('[data-testid="confirm-cancel"]').click();
    await expect(bar).toBeHidden();
    await settle(panel);
    expect(await allOpenTabIds(serviceWorker), 'Cancel closed tabs').toEqual(expect.arrayContaining(Object.values(ids)));
    await expect(xOf(panel, work), 'Cancel must leave the group and its button where they were').toHaveCount(1);

    // Ask again and confirm.
    await clickX(panel, work);
    await expect(bar).toBeVisible({ timeout: 10_000 });
    await panel.locator('[data-testid="confirm-ok"]').click();
    await expect(panel.locator(CARD), 'Confirm must close the group').toHaveCount(2, { timeout: 10_000 });
    await expectClosedExactly(serviceWorker, ids, WORK);
    await expect(bar).toBeHidden();

    // One member, threshold three: does not ask.
    await clickX(panel, other);
    await expect(panel.locator(CARD)).toHaveCount(1, { timeout: 10_000 });
    await expectClosedExactly(serviceWorker, ids, [...WORK, 'delta']);
    await expect(bar, 'a one-tab group asked for confirmation below the threshold').toBeHidden();
  });

// ── 4. what the click must not do ─────────────────────────────────────────────────────────────

test('the click does not toggle the group, activate a tab, or change the selection', async ({ harness, serviceWorker }) => {
  const { panel } = harness;
  // Threshold 3 keeps Work alive behind the bar, so "did it toggle" can be read from a group that still exists.
  await setSettings(serviceWorker, { confirmCloseThreshold: 3 });
  const { work, other } = await buildLayout(harness, serviceWorker);
  await pollThreshold(panel, 3);
  const cancel = panel.locator('[data-testid="confirm-cancel"]');

  // Expanded Work stays expanded, nothing is activated, no card's selection changes.
  const activeBefore = await activeTabIdOf(serviceWorker, harness.w2);
  const selectedBefore = await ariaSelectedMap(panel);
  await clickX(panel, work);
  await expect(panel.locator(BAR)).toBeVisible({ timeout: 10_000 });
  await cancel.click();
  await settle(panel);
  expect(await collapsedInChrome(serviceWorker, work), 'the click on the x collapsed the group').toBe(false);
  await expect(panel.locator(`.group[data-group-id="${work}"]`)).not.toHaveClass(/is-collapsed/);
  expect(await activeTabIdOf(serviceWorker, harness.w2), 'the click activated a tab').toBe(activeBefore);
  expect(await ariaSelectedMap(panel), 'the click changed which cards are selected').toEqual(selectedBefore);

  // Collapsed Work stays collapsed (a header click would have expanded it). Chrome itself moves the
  // active tab out of a group it collapses, so the active tab is read AFTER the collapse.
  await swEval(serviceWorker, (id) => chrome.tabGroups.update(id, { collapsed: true }), work);
  await expect(panel.locator(`.group[data-group-id="${work}"]`)).toHaveClass(/is-collapsed/, { timeout: 10_000 });
  await settle(panel);
  const activeCollapsed = await activeTabIdOf(serviceWorker, harness.w2);
  await clickX(panel, work);
  await expect(panel.locator(BAR)).toBeVisible({ timeout: 10_000 });
  await cancel.click();
  await settle(panel);
  expect(await collapsedInChrome(serviceWorker, work), 'the click on the x expanded a collapsed group').toBe(true);
  expect(await collapsedInChrome(serviceWorker, other), 'the other group was toggled').toBe(false);
  expect(await activeTabIdOf(serviceWorker, harness.w2), 'the click on a collapsed group\'s x activated a tab').toBe(activeCollapsed);
});

test('a press on the x that moves away starts no drag, closes nothing and toggles nothing', async ({ harness, serviceWorker }) => {
  const { panel } = harness;
  await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
  const { ids, work } = await buildLayout(harness, serviceWorker);
  const x = xOf(panel, work);
  await expect(x, WHY_X).toHaveCount(1, { timeout: 10_000 });
  await headerOf(panel, work).hover();
  const orderBefore = await swEval(serviceWorker, async (wid) =>
    (await chrome.tabs.query({ windowId: wid })).sort((a, b) => a.index - b.index).map((t) => [t.id, t.groupId]), harness.w2);
  // What counts as "a drag started" (Probe 15: a press on a button inside the draggable header starts the
  // header's drag, 1 dragstart and 1 dragend): the guard cancels `dragstart` in the capture phase of #tablist,
  // so a document listener in the CAPTURE phase sees the event either way and proves nothing. The two
  // below do: a bubble-phase `dragstart` listener only sees a drag the app was allowed to see, and
  // `dragend` only fires for a drag that actually began (a cancelled dragstart has none).
  await panel.evaluate(() => {
    window.__dragLog = { reachedApp: 0, ended: 0 };
    document.addEventListener('dragstart', () => { window.__dragLog.reachedApp += 1; }, false);
    document.addEventListener('dragend', () => { window.__dragLog.ended += 1; }, true);
  });
  const pressAndWander = async (locator) => {
    await headerOf(panel, work).hover();
    const box = await locator.boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await panel.mouse.move(cx, cy);
    await panel.mouse.down();
    await panel.mouse.move(cx, cy + 40, { steps: 8 });
    await panel.mouse.up();
  };

  await pressAndWander(x);
  await settle(panel);
  expect(await panel.evaluate(() => window.__dragLog), 'a drag started from the close button').toEqual({ reachedApp: 0, ended: 0 });
  await expectClosedExactly(serviceWorker, ids, []);
  expect(await collapsedInChrome(serviceWorker, work), 'the press toggled the group').toBe(false);
  const orderAfter = await swEval(serviceWorker, async (wid) =>
    (await chrome.tabs.query({ windowId: wid })).sort((a, b) => a.index - b.index).map((t) => [t.id, t.groupId]), harness.w2);
  expect(orderAfter, 'tabs or groups moved').toEqual(orderBefore);

  // Control, so that the zeros above mean something: the same gesture from the group's title does start a drag.
  await pressAndWander(headerOf(panel, work).locator('.group-title'));
  await expect.poll(() => panel.evaluate(() => window.__dragLog),
    { message: 'control: a press-and-move on the title should have started a drag in this harness' })
    .toEqual({ reachedApp: 1, ended: 1 });
});

test('a double-click closes one group: the second click, landing on the group that slid up, is ignored',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
    const { ids, work, other } = await buildLayout(harness, serviceWorker);
    await pollThreshold(panel, 10);
    const errors = watchPageErrors(panel);
    await watchToasts(panel);
    const x = xOf(panel, work);
    await expect(x, WHY_X).toHaveCount(1, { timeout: 10_000 });
    await headerOf(panel, work).hover();
    const box = await x.boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await panel.evaluate(() => {
      window.__clickDetails = [];
      document.addEventListener('click', (e) => { window.__clickDetails.push(e.detail); }, true);
    });

    // First click of the double-click: closes Work, the list reflows and Other's header moves up under the pointer.
    await panel.mouse.click(cx, cy);
    await expect(panel.locator(CARD)).toHaveCount(2, { timeout: 10_000 });
    const under = await panel.evaluate(([px, py]) => {
      const el = document.elementFromPoint(px, py);
      const btn = el && el.closest('.group-close');
      const section = btn && btn.closest('.group');
      return section ? Number(section.dataset.groupId) : null;
    }, [cx, cy]);
    expect(under, 'premise: after the reflow the other group\'s x is under the pointer').toBe(other);

    // Second click of the double-click: same place, click count 2.
    await panel.mouse.down({ clickCount: 2 });
    await panel.mouse.up({ clickCount: 2 });
    expect(await panel.evaluate(() => window.__clickDetails), 'premise: the second click carried detail 2').toEqual([1, 2]);

    await settle(panel);
    await expectClosedExactly(serviceWorker, ids, WORK);
    await expect(panel.locator(HEADER), 'the second click of a double-click closed the next group').toHaveCount(1);
    expect(await toastLog(panel), 'a toast appeared').toEqual([]);
    expect(errors, 'the panel raised an error').toEqual([]);
  });

// ── 5. the keyboard ───────────────────────────────────────────────────────────────────────────

/** Puts focus on the group's swatch and presses Tab once; returns what has focus. */
async function tabFromSwatch(panel, groupId) {
  await headerOf(panel, groupId).locator('.group-swatch').focus();
  await panel.keyboard.press('Tab');
  return panel.evaluate(() => {
    const el = document.activeElement;
    return { testid: el && el.dataset ? el.dataset.testid || null : null, groupId: el && el.closest('.group') ? el.closest('.group').dataset.groupId : null };
  });
}

for (const key of ['Enter', 'Space']) {
  test(`keyboard: Tab from the swatch reaches the x and ${key} closes the group; focus stays in the panel`,
    async ({ harness, serviceWorker }) => {
      const { panel } = harness;
      await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
      const { ids, work } = await buildLayout(harness, serviceWorker);
      await pollThreshold(panel, 10);
      await expect(xOf(panel, work), WHY_X).toHaveCount(1, { timeout: 10_000 });

      const focused = await tabFromSwatch(panel, work);
      expect(focused, 'Tab from the swatch must land on this group\'s close button').toEqual({ testid: 'group-close', groupId: String(work) });

      await panel.keyboard.press(key);
      await expect(panel.locator(CARD), `${key} on the x did not close the group`).toHaveCount(2, { timeout: 10_000 });
      await expectClosedExactly(serviceWorker, ids, WORK);

      // A15.4: a removed control that held focus must not leave it on <body>. Poll: the hand-off runs after the render.
      await expect.poll(() => panel.evaluate(() => {
        const el = document.activeElement;
        const card = el && el.closest('[data-testid="tab-card"]');
        return { onBody: !el || el === document.body, onCard: card ? Number(card.dataset.tabId) : null };
      }), { message: 'focus fell to <body> after the group closed', timeout: 10_000 })
        .toEqual({ onBody: false, onCard: ids.delta });
      await expectFocusSettled(panel, `card ${ids.delta}`, 'a render after the hand-off took focus off the card that follows the group (delta)');
    });
}

test('keyboard: Enter on the x asks at the threshold and does not collapse the group (it used to be a collapse toggle)',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 3 });
    const { ids, work } = await buildLayout(harness, serviceWorker);
    await pollThreshold(panel, 3);
    await expect(xOf(panel, work), WHY_X).toHaveCount(1, { timeout: 10_000 });

    expect(await tabFromSwatch(panel, work)).toEqual({ testid: 'group-close', groupId: String(work) });
    await panel.keyboard.press('Enter');
    await expect(panel.locator(BAR), 'Enter on the x did not ask').toBeVisible({ timeout: 10_000 });
    await settle(panel);
    expect(await collapsedInChrome(serviceWorker, work), 'Enter on the x collapsed the group').toBe(false);

    await panel.keyboard.press('Escape');
    await expect(panel.locator(BAR)).toBeHidden();
    await settle(panel);
    await expectClosedExactly(serviceWorker, ids, []);
    // Cancel hands focus back to the x it came from.
    await expect.poll(() => panel.evaluate(() => (document.activeElement && document.activeElement.dataset.testid) || null),
      { message: 'focus did not return to the x after Cancel' }).toBe('group-close');
  });

// keyboard.js hands focus to the card that takes the group's place, but only once the group has left the DOM
// (`awaitRemoval`): the click that asked may close nothing, and then focus belongs where it was. Without the
// wait, any render that lands after a Cancel pulls focus off the x onto the neighbouring card (the entry has no
// deadline while the group is drawn, so how long after does not matter). The render is one synthetic childList
// mutation of #tablist (what keyboard.js's observer watches), made in the same page task as the Escape that
// cancels the bar, so no clock and no machine load is involved. It is a synthetic Escape here; the real key is
// pinned by the test above.
test('keyboard: after Cancel on the bar, a render does not pull focus off the x', async ({ harness, serviceWorker }) => {
  const { panel } = harness;
  await setSettings(serviceWorker, { confirmCloseThreshold: 3 });
  const { ids, work } = await buildLayout(harness, serviceWorker);
  await pollThreshold(panel, 3);
  await expect(xOf(panel, work), WHY_X).toHaveCount(1, { timeout: 10_000 });

  expect(await tabFromSwatch(panel, work)).toEqual({ testid: 'group-close', groupId: String(work) });
  await panel.keyboard.press('Enter');
  await expect(panel.locator(BAR), 'Enter on the x did not ask').toBeVisible({ timeout: 10_000 });

  const after = await panel.evaluate(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const probe = document.createElement('div');
    document.getElementById('tablist').append(probe);
    probe.remove();
    // The observer defers its sync to the next frame (or to a 0 ms timer in a hidden page); wait for it.
    await new Promise((resolve) => (document.hidden ? setTimeout(resolve, 0) : requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const el = document.activeElement;
    return {
      barHidden: document.querySelector('[data-testid="confirm-bar"]').hidden,
      focus: el && el.dataset && el.dataset.testid ? el.dataset.testid : (el ? el.tagName : null),
    };
  });
  expect(after, 'a render after Cancel moved focus off the close button').toEqual({ barHidden: true, focus: 'group-close' });
  await settle(panel);
  await expectClosedExactly(serviceWorker, ids, []);
});

// ── 6. name, visibility, look ─────────────────────────────────────────────────────────────────

const messageOf = (locale) => JSON.parse(fs.readFileSync(path.join(EXT, '_locales', locale, 'messages.json'), 'utf8')).closeGroup.message;

test('the x has an accessible name and a tooltip: "Close group" in English', async ({ harness, serviceWorker }) => {
  const { panel } = harness;
  const { work, other } = await buildLayout(harness, serviceWorker);
  const en = messageOf('en');
  expect(en, 'premise: the English message is non-empty').toBe('Close group');
  for (const id of [work, other]) {
    await expect(xOf(panel, id), WHY_X).toHaveAttribute('aria-label', en, { timeout: 10_000 });
    await expect(xOf(panel, id)).toHaveAttribute('title', en);
  }
});

test('the x is named in Japanese when Chrome runs in Japanese', async ({ fixtures }) => {
  test.setTimeout(150_000);
  const { context, serviceWorker } = await launchExtensionContext({
    env: { ...process.env, LANGUAGE: 'ja', LC_ALL: 'ja_JP.UTF-8' },
    locale: 'ja',
  });
  try {
    const harness = await setupTwoWindows(context, serviceWorker, fixtures);
    await harness.panel.setViewportSize(PANEL_VIEWPORT);
    const { work } = await buildLayout(harness, serviceWorker);
    const ja = messageOf('ja');
    expect(ja, 'premise: the Japanese message is non-empty and not the English one').toBe('グループを閉じる');
    expect(ja).not.toBe(messageOf('en'));
    await expect(harness.panel.locator('html')).toHaveAttribute('lang', /^ja/);
    await expect(xOf(harness.panel, work), WHY_X).toHaveAttribute('aria-label', ja, { timeout: 10_000 });
    await expect(xOf(harness.panel, work)).toHaveAttribute('title', ja);
  } finally {
    await context.close();
  }
});

const opacityOf = (locator) => locator.evaluate((el) => getComputedStyle(el).opacity);

test('visibility: hidden at rest, shown on hover, shown when focus is in the row, and only for that row',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    const { work, other } = await buildLayout(harness, serviceWorker);
    const xWork = xOf(panel, work);
    const xOther = xOf(panel, other);
    await expect(xWork, WHY_X).toHaveCount(1, { timeout: 10_000 });

    await panel.mouse.move(2, 2);
    await expect.poll(() => opacityOf(xWork), { message: 'at rest the x should be invisible' }).toBe('0');

    await headerOf(panel, work).hover();
    await expect.poll(() => opacityOf(xWork), { message: 'on hover the x should show' }).toBe('1');
    expect(await opacityOf(xOther), 'hovering Work must not reveal Other\'s x').toBe('0');

    await panel.mouse.move(2, 2);
    await expect.poll(() => opacityOf(xWork)).toBe('0');
    expect(await tabFromSwatch(panel, work)).toEqual({ testid: 'group-close', groupId: String(work) });
    await expect.poll(() => opacityOf(xWork), { message: 'focused by keyboard, the x must be visible' }).toBe('1');
    expect(await opacityOf(xOther), 'focus in Work must not reveal Other\'s x').toBe('0');
  });

test('the header keeps its 24 px height and the x stays inside it at 360 and 400 px, with a long title', async ({ harness, serviceWorker }) => {
  const { panel } = harness;
  const { work } = await buildLayout(harness, serviceWorker);
  await swEval(serviceWorker, (id) => chrome.tabGroups.update(id, {
    title: 'A very long group title that cannot possibly fit in a narrow side panel',
  }), work);
  await expect(headerOf(panel, work).locator('.group-title')).toContainText('A very long', { timeout: 10_000 });
  await expect(xOf(panel, work), WHY_X).toHaveCount(1);

  for (const width of [400, 360]) {
    await panel.setViewportSize({ width, height: 1500 });
    const m = await headerOf(panel, work).evaluate((h) => {
      const hr = h.getBoundingClientRect();
      const xr = h.querySelector('.group-close').getBoundingClientRect();
      const title = h.querySelector('.group-title');
      return {
        height: hr.height,
        xInside: xr.left >= hr.left && xr.right <= hr.right + 0.5 && xr.top >= hr.top && xr.bottom <= hr.bottom,
        xW: xr.width, xH: xr.height,
        headerOverflows: h.scrollWidth > h.clientWidth,
        titleTruncated: title.scrollWidth > title.clientWidth,
      };
    });
    expect(m, `at ${width} px`).toEqual({ height: 24, xInside: true, xW: 18, xH: 18, headerOverflows: false, titleTruncated: true });
  }
});

test('the colours are theme tokens with a value in each palette', async ({ harness, serviceWorker }) => {
  const { panel } = harness;
  const { work } = await buildLayout(harness, serviceWorker);
  await expect(xOf(panel, work), WHY_X).toHaveCount(1, { timeout: 10_000 });
  const read = () => panel.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const x = document.querySelector('[data-testid="group-close"]');
    return {
      fg: cs.getPropertyValue('--vt-group-close-fg').trim(),
      hover: cs.getPropertyValue('--vt-group-close-hover-bg').trim(),
      size: cs.getPropertyValue('--vt-group-close-size').trim(),
      icon: cs.getPropertyValue('--vt-group-close-icon').trim(),
      color: getComputedStyle(x).color,
    };
  });

  await setSettings(serviceWorker, { theme: 'dark' });
  await expect(panel.locator('html')).toHaveAttribute('data-theme', 'dark', { timeout: 10_000 });
  expect(await read()).toEqual({
    fg: '#ececec', hover: 'rgba(255, 255, 255, .14)', size: '18px', icon: '12px', color: 'rgb(236, 236, 236)',
  });

  await setSettings(serviceWorker, { theme: 'light' });
  await expect(panel.locator('html')).toHaveAttribute('data-theme', 'light', { timeout: 10_000 });
  expect(await read()).toEqual({
    fg: '#202020', hover: 'rgba(0, 0, 0, .10)', size: '18px', icon: '12px', color: 'rgb(32, 32, 32)',
  });
});

// ── 7. odd groups ─────────────────────────────────────────────────────────────────────────────

test('an untitled one-tab group closes with its x', async ({ harness, serviceWorker }) => {
  const { panel } = harness;
  await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
  const { ids } = await buildLayout(harness, serviceWorker);
  const solo = await swEval(serviceWorker, async (a) =>
    chrome.tabs.group({ tabIds: [a.epsilon], createProperties: { windowId: a.wid } }), { epsilon: ids.epsilon, wid: harness.w2 });
  await expect(panel.locator(HEADER)).toHaveCount(3, { timeout: 10_000 });

  await clickX(panel, solo);

  await expect(panel.locator(HEADER)).toHaveCount(2, { timeout: 10_000 });
  await expectClosedExactly(serviceWorker, ids, ['epsilon']);
});

test('a header whose group has no tabs by the time of the click does nothing: no close, no toast, no error',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 2 });
    const { ids, work } = await buildLayout(harness, serviceWorker);
    await pollThreshold(panel, 2);
    const errors = watchPageErrors(panel);
    await watchToasts(panel);
    await expect(xOf(panel, work), WHY_X).toHaveCount(1, { timeout: 10_000 });

    // The stale paint: the header still stands for a group that Chrome no longer has any tab in.
    const ghost = 987654;
    await panel.evaluate(([from, to]) => {
      document.querySelector(`.group[data-group-id="${from}"]`).setAttribute('data-group-id', String(to));
    }, [work, ghost]);
    await headerOf(panel, ghost).hover();
    await xOf(panel, ghost).click();

    await settle(panel);
    await expectClosedExactly(serviceWorker, ids, []);
    await expect(panel.locator(BAR), 'an empty close asked for confirmation').toBeHidden();
    expect(await toastLog(panel), 'a toast appeared').toEqual([]);
    expect(errors, 'the panel raised an error').toEqual([]);
  });

test('a locked member survives the x: the rest of the group closes (same ops.remove as the menus)',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
    const { ids, work } = await buildLayout(harness, serviceWorker);
    await pollThreshold(panel, 10);

    await panel.locator(`[data-tab-id="${ids.beta}"] .thumb`).click({ button: 'right' });
    const lock = panel.locator(`${MENU} [data-testid="menu-item-lock"]`);
    await expect(lock, '"Lock this tab" must be offered and enabled in the card menu').toBeEnabled({ timeout: 10_000 });
    await lock.click();
    await expect(panel.locator(`[data-tab-id="${ids.beta}"]`), 'setup: beta did not become locked')
      .toHaveClass(/is-locked/, { timeout: 10_000 });

    await clickX(panel, work);

    await expect(panel.locator(CARD)).toHaveCount(3, { timeout: 10_000 });
    await expectClosedExactly(serviceWorker, ids, ['alpha', 'gamma']);
  });

// ── 8. the focus hand-off waits for the group, not for a stopwatch ────────────────────────────
//
// A15.4: closing a card hands focus to the card that takes its place. For the x on a group header the click and
// the close are far apart and nothing bounds the gap: the confirm bar waits for a person, `chrome.tabs.remove` for
// Chrome. keyboard.js used to give the hand-off 2 s from the CLICK. A close that took longer found it expired. What
// then happens depends on which render comes first after the deadline: one that does not remove the group (Chrome
// closes a group's tabs one render at a time) drops the hand-off with focus still on the x, and the group then goes
// with focus on <body> for good; if the render that removes the group is the first, `rescueFocus` runs and focuses
// the FIRST card of the list instead of the neighbour. On c0f5dd1 every slow close below ended on <body>; the
// first-card ending is read from the code, not seen in these runs.
//
// These tests do not wait for that gap, they make it: the panel's `chrome.tabs.remove` is held at a gate and its
// `Date.now()` (the only clock keyboard.js reads) is moved ahead, so the deadline is over before the close lands,
// whatever the machine is doing. The click and the close stay the real ones.

const LATE_MS = 10_000;

/** From here on every `chrome.tabs.remove` the PANEL makes waits for `releaseRemovals`. */
const holdRemovals = (panel) => panel.evaluate(() => {
  const real = chrome.tabs.remove.bind(chrome.tabs);
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  window.__removals = { held: 0, open };
  chrome.tabs.remove = (...args) => { window.__removals.held += 1; return gate.then(() => real(...args)); };
});
const heldRemovals = (panel) => panel.evaluate(() => window.__removals.held);
const releaseRemovals = (panel) => panel.evaluate(() => window.__removals.open());

/** Moves the panel's clock `ms` ahead for good. */
const skewClock = (panel, ms) => panel.evaluate((n) => {
  if (!window.__clockSkew) {
    const real = Date.now.bind(Date);
    window.__clockSkew = { ms: 0 };
    Date.now = () => real() + window.__clockSkew.ms;
  }
  window.__clockSkew.ms += n;
}, ms);

/** Stops the panel's clock: from here `Date.now()` keeps answering with the instant of this call. */
const freezeClock = (panel) => panel.evaluate(() => {
  const frozen = Date.now();
  Date.now = () => frozen;
});

/** A render that changes nothing: one childList mutation of #tablist, what keyboard.js's observer reacts to (test 13), then two frames. */
const renderNothing = (panel) => panel.evaluate(async () => {
  const probe = document.createElement('div');
  document.getElementById('tablist').append(probe);
  probe.remove();
  await new Promise((resolve) => (document.hidden ? setTimeout(resolve, 0) : requestAnimationFrame(() => requestAnimationFrame(resolve))));
});

/** What has focus, in words: 'body', 'card <tabId>', 'x', '#<id>' or the tag. */
const focusDesc = (panel) => panel.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return 'body';
  const card = el.closest('[data-testid="tab-card"]');
  if (card) return card === el ? `card ${card.dataset.tabId}` : `inside card ${card.dataset.tabId}: ${el.tagName.toLowerCase()}.${el.className}`;
  if (el.dataset && el.dataset.testid === 'group-close') return 'x';
  return el.id ? `#${el.id}` : el.tagName.toLowerCase();
});

/**
 * The SETTLED read that follows every hand-off assertion (sections 5, 8 and 9). `expect.poll(...).toBe(x)` passes at the
 * first sample that matches, so a hand-off that is undone a moment later (the next render, a late `blur()`) passes it. This
 * forces the next render with `renderNothing` (one `sync()` of keyboard.js, then two frames, no sleep) and reads again.
 */
async function expectFocusSettled(panel, expected, message) {
  await renderNothing(panel);
  expect(await focusDesc(panel), message).toBe(expected);
}

/**
 * Builds exactly this layout, from the three fixture tabs plus delta / epsilon where it names them, and proves it in Chrome:
 *   groups  in the order they stand in the list: { title, color, members: ['alpha', ...] }
 *   pinned  pinned tabs (the pinned strip, not the list)
 *   loose   ungrouped tabs, after the groups
 * alpha, beta and gamma must each appear once. Resolves to the tab ids by name and the group ids by title.
 */
async function arrange(harness, serviceWorker, { groups, pinned = [], loose = [] }) {
  const { w2, tabIds, urls, panel } = harness;
  const named = [...groups.flatMap((g) => g.members), ...pinned, ...loose];
  expect(new Set(named).size, 'a name appears twice in the layout').toBe(named.length);
  for (const fixture of ['alpha', 'beta', 'gamma']) expect(named, `the layout must place ${fixture}`).toContain(fixture);
  const ids = { alpha: tabIds.alpha, beta: tabIds.beta, gamma: tabIds.gamma };
  if (named.includes('delta')) ids.delta = await createTab(serviceWorker, w2, urls.delta, { active: false });
  if (named.includes('epsilon')) ids.epsilon = await createTab(serviceWorker, w2, urls.page('ffff00', 'Epsilon'), { active: false });

  const made = await swEval(serviceWorker, async (a) => {
    for (const id of a.pinned) await chrome.tabs.update(id, { pinned: true });
    const out = [];
    for (const g of a.groups) {
      const gid = await chrome.tabs.group({ tabIds: g.members, createProperties: { windowId: a.wid } });
      await chrome.tabGroups.update(gid, { title: g.title, color: g.color });
      out.push(gid);
    }
    // Stand them in the requested order, right after the pinned tabs.
    for (const gid of [...out].reverse()) await chrome.tabGroups.move(gid, { index: a.pinned.length });
    return out;
  }, {
    wid: w2,
    pinned: pinned.map((n) => ids[n]),
    groups: groups.map((g) => ({ title: g.title, color: g.color, members: g.members.map((n) => ids[n]) })),
  });

  const expected = [
    ...pinned.map((n) => [ids[n], -1]),
    ...groups.flatMap((g, i) => g.members.map((n) => [ids[n], made[i]])),
    ...loose.map((n) => [ids[n], -1]),
  ];
  const placed = await swEval(serviceWorker, async (wid) => (await chrome.tabs.query({ windowId: wid }))
    .sort((a, b) => a.index - b.index).map((t) => [t.id, t.groupId]), w2);
  expect(placed, 'setup did not build the layout this test assumes').toEqual(expected);
  await expect(panel.locator(HEADER)).toHaveCount(groups.length, { timeout: 10_000 });
  await expect(panel.locator(CARD)).toHaveCount(groups.flatMap((g) => g.members).length + loose.length, { timeout: 10_000 });
  return { ids, groupIds: Object.fromEntries(groups.map((g, i) => [g.title, made[i]])) };
}

/**
 * Closes the group with its x from the keyboard, the slow way: `chrome.tabs.remove` is held, the panel's clock is
 * moved past any deadline, optionally one unrelated render lands, and only then Chrome is let through.
 * Resolves once the close has been released; the caller waits for the panel.
 */
async function closeSlowly(panel, groupId, { renderBefore = false } = {}) {
  await holdRemovals(panel);
  expect(await tabFromSwatch(panel, groupId), 'Tab from the swatch must land on this group\'s close button')
    .toEqual({ testid: 'group-close', groupId: String(groupId) });
  await panel.keyboard.press('Enter');
  await expect.poll(() => heldRemovals(panel), { message: 'the x never asked Chrome to close the tabs' }).toBe(1);
  await skewClock(panel, LATE_MS);
  if (renderBefore) {
    await renderNothing(panel);
    expect(await focusDesc(panel), 'a render while the group is still drawn must not take focus off the x').toBe('x');
  }
  await releaseRemovals(panel);
}

// Other stands before Work, so the card that takes Work's place (epsilon) is not the first card of the list (delta):
// a hand-off that gave up and fell back to "the first card" is told apart from one that found the neighbour.
const OTHER_THEN_WORK = {
  groups: [
    { title: 'Other', color: 'red', members: ['delta'] },
    { title: 'Work', color: 'blue', members: ['alpha', 'beta', 'gamma'] },
  ],
  loose: ['epsilon'],
};

for (const [label, renderBefore] of [
  ['Chrome closes the tabs after the deadline', false],
  ['Chrome closes the tabs after the deadline and the list renders once before it does', true],
]) {
  test(`a slow close still hands focus to the card that takes the group's place: ${label}`,
    async ({ harness, serviceWorker }) => {
      const { panel } = harness;
      await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
      const { ids, groupIds } = await arrange(harness, serviceWorker, OTHER_THEN_WORK);
      await pollThreshold(panel, 10);

      await closeSlowly(panel, groupIds.Work, { renderBefore });

      await expect(panel.locator(CARD), 'the held close never landed').toHaveCount(2, { timeout: 10_000 });
      await expectClosedExactly(serviceWorker, ids, WORK);
      await expect.poll(() => focusDesc(panel), {
        message: 'after a slow close focus is not on the card that follows the group (epsilon)', timeout: 10_000,
      }).toBe(`card ${ids.epsilon}`);
      await expectFocusSettled(panel, `card ${ids.epsilon}`, 'a render after a slow close took focus off the card that follows the group (epsilon)');
    });
}

test('a confirm bar answered after the deadline still hands focus to the card that takes the group\'s place',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 3 });
    const { ids, groupIds } = await arrange(harness, serviceWorker, OTHER_THEN_WORK);
    await pollThreshold(panel, 3);

    expect(await tabFromSwatch(panel, groupIds.Work)).toEqual({ testid: 'group-close', groupId: String(groupIds.Work) });
    await panel.keyboard.press('Enter');
    await expect(panel.locator(BAR), 'three tabs at threshold three must ask').toBeVisible({ timeout: 10_000 });
    await skewClock(panel, LATE_MS); // whoever reads the bar takes their time; the bar has no deadline of its own
    await panel.locator('[data-testid="confirm-ok"]').click();

    await expect(panel.locator(CARD), 'Confirm must close the group').toHaveCount(2, { timeout: 10_000 });
    await expectClosedExactly(serviceWorker, ids, WORK);
    await expect.poll(() => focusDesc(panel), {
      message: 'after a late Confirm focus is not on the card that follows the group (epsilon)', timeout: 10_000,
    }).toBe(`card ${ids.epsilon}`);
    await expectFocusSettled(panel, `card ${ids.epsilon}`, 'a render after a late Confirm took focus off the card that follows the group (epsilon)');
  });

test('a slow close beside a folded group hands focus to the New tab button, not to a card nobody can see',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
    const { ids, groupIds } = await arrange(harness, serviceWorker, {
      groups: [
        { title: 'Folded', color: 'green', members: ['alpha'] },
        { title: 'Work', color: 'blue', members: ['beta', 'gamma', 'delta'] },
      ],
    });
    await pollThreshold(panel, 10);
    await swEval(serviceWorker, (id) => chrome.tabGroups.update(id, { collapsed: true }), groupIds.Folded);
    await expect(panel.locator(`.group[data-group-id="${groupIds.Folded}"]`), 'setup: the panel did not fold the first group')
      .toHaveClass(/is-collapsed/, { timeout: 10_000 });

    await closeSlowly(panel, groupIds.Work);

    await expectClosedExactly(serviceWorker, ids, ['beta', 'gamma', 'delta']);
    // The only card left in the list is inside the folded group; focusing it does nothing, and focus would stay on <body>.
    await expect.poll(() => focusDesc(panel), {
      message: 'with only a folded group left, focus is not on the New tab button', timeout: 10_000,
    }).toBe('#btn-new-tab');
    await expectFocusSettled(panel, '#btn-new-tab', 'a render took focus off the New tab button');
  });

// What the hand-off may not become once it has no deadline: a Cancelled close, or one that closes nothing (every
// member locked), leaves its record behind for as long as the group is drawn. When the group goes later, by any
// route, that record must not take the focus from wherever the user has put it since.
test('a cancelled close leaves nothing behind that takes focus when the group goes later', async ({ harness, serviceWorker }) => {
  const { panel } = harness;
  await setSettings(serviceWorker, { confirmCloseThreshold: 3 });
  const { ids, work } = await buildLayout(harness, serviceWorker);
  await pollThreshold(panel, 3);

  expect(await tabFromSwatch(panel, work)).toEqual({ testid: 'group-close', groupId: String(work) });
  await panel.keyboard.press('Enter');
  await expect(panel.locator(BAR), 'Enter on the x did not ask').toBeVisible({ timeout: 10_000 });
  await panel.keyboard.press('Escape');
  await expect(panel.locator(BAR)).toBeHidden();
  await skewClock(panel, LATE_MS);
  await panel.locator('#search-input').focus();
  expect(await focusDesc(panel), 'setup: the search box did not take focus').toBe('#search-input');

  // The group goes some other way (Chrome's own tab strip, another extension): the service worker closes its tabs.
  await swEval(serviceWorker, (tabIds) => chrome.tabs.remove(tabIds), WORK.map((name) => ids[name]));
  await expect(panel.locator(CARD)).toHaveCount(2, { timeout: 10_000 });
  await expectClosedExactly(serviceWorker, ids, WORK);
  await renderNothing(panel); // two frames after the removal: any hand-off has run by now
  expect(await focusDesc(panel), 'the group going took focus away from the search box').toBe('#search-input');
});

// ── 9. which card takes the group's place (successorOfGroup) ──────────────────────────────────
//
// Every case closes the slow way, so a hand-off that gives up falls back to "the first card" or to <body> and
// fails here; the answer each one expects is NOT the first card of the list.

test('successor: with a later group, focus goes to the first card of the next group', async ({ harness, serviceWorker }) => {
  const { panel } = harness;
  await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
  const { ids, groupIds } = await arrange(harness, serviceWorker, {
    groups: [
      { title: 'One', color: 'green', members: ['alpha'] },
      { title: 'Two', color: 'blue', members: ['beta', 'gamma'] },
      { title: 'Three', color: 'red', members: ['delta'] },
    ],
    loose: ['epsilon'],
  });
  await pollThreshold(panel, 10);

  await closeSlowly(panel, groupIds.Two, { renderBefore: true });

  await expect(panel.locator(CARD)).toHaveCount(3, { timeout: 10_000 });
  await expectClosedExactly(serviceWorker, ids, ['beta', 'gamma']);
  await expect.poll(() => focusDesc(panel), {
    message: 'focus is not on the first card of the group that follows (delta)', timeout: 10_000,
  }).toBe(`card ${ids.delta}`);
  await expectFocusSettled(panel, `card ${ids.delta}`, 'a render took focus off the first card of the group that follows (delta)');
});

test('successor: the last group has nothing after it, so focus goes to the last card before it', async ({ harness, serviceWorker }) => {
  const { panel } = harness;
  await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
  const { ids, groupIds } = await arrange(harness, serviceWorker, {
    groups: [
      { title: 'First', color: 'green', members: ['alpha', 'beta'] },
      { title: 'Last', color: 'blue', members: ['gamma', 'delta'] },
    ],
  });
  await pollThreshold(panel, 10);

  await closeSlowly(panel, groupIds.Last, { renderBefore: true });

  await expect(panel.locator(CARD)).toHaveCount(2, { timeout: 10_000 });
  await expectClosedExactly(serviceWorker, ids, ['gamma', 'delta']);
  await expect.poll(() => focusDesc(panel), {
    message: 'focus is not on the last card before the group (beta)', timeout: 10_000,
  }).toBe(`card ${ids.beta}`);
  await expectFocusSettled(panel, `card ${ids.beta}`, 'a render took focus off the last card before the group (beta)');
});

test('successor: when no card is left in the list, focus goes to the New tab button', async ({ harness, serviceWorker }) => {
  const { panel } = harness;
  await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
  const { ids, groupIds } = await arrange(harness, serviceWorker, {
    pinned: ['epsilon'],
    groups: [{ title: 'Only', color: 'blue', members: ['alpha', 'beta', 'gamma', 'delta'] }],
  });
  await pollThreshold(panel, 10);

  await closeSlowly(panel, groupIds.Only, { renderBefore: true });

  await expect(panel.locator(CARD)).toHaveCount(0, { timeout: 10_000 });
  await expectClosedExactly(serviceWorker, ids, ['alpha', 'beta', 'gamma', 'delta']);
  await expect.poll(() => focusDesc(panel), {
    message: 'with no card left, focus is not on the New tab button', timeout: 10_000,
  }).toBe('#btn-new-tab');
  await expectFocusSettled(panel, '#btn-new-tab', 'a render took focus off the New tab button');
});

// ── 10. the keys the x takes over, and only those ─────────────────────────────────────────────
//
// keyboard.js lets Enter and Space through when they land on the x, so the browser turns them into the click
// group-close.js listens for. That exception is one line (`onClose`); if it ever matched more than the x, Enter
// and Space on the rest of the header would silently stop collapsing the group.
//
// The two tests below are GUARDS, not tests of the button: 'keyboard: Enter and Space on the header itself and on its chevron
// still collapse and expand the group' and 'keyboard: Enter and Space on the colour swatch still open the colour picker, and do
// not toggle the group'. They PASS ON A TREE WITHOUT THE BUTTON (main), by design: they press keys on the header, its chevron
// and its swatch and never touch the x, so they cannot fail for want of it. They are not the only tests of this file that do.
// Measured (review of PR #20, S14, log p20g-nobtn.log): this file's tests on main's extension, two repeats = 96 runs, 6 passed
// and 90 failed, so 3 of the 48 tests pass and 45 fail; the third that passes is section 13's 'a card's own hand-off (Delete)
// arms no re-check timer, even when the card it waits for is not drawn'. What turns the two guards red is the exception above
// matching more than the x (A39 lists the two mutants that were used: `onClose` always true, and the pass-through placed above
// the swatch's branch). The file rule at the top names all three.

test('keyboard: Enter and Space on the header itself and on its chevron still collapse and expand the group',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    const { ids, work } = await buildLayout(harness, serviceWorker);
    const header = headerOf(panel, work);
    const section = panel.locator(`.group[data-group-id="${work}"]`);

    // Each step waits for the PANEL to draw the new state, not just for Chrome to hold it: the next key is
    // decoded against the panel's model, which follows Chrome by one event.
    await header.focus(); // tabindex -1: a script (or ArrowLeft from a card) puts focus here
    await panel.keyboard.press('Enter');
    await expect(section, 'Enter on the header did not collapse the group').toHaveClass(/is-collapsed/, { timeout: 10_000 });
    expect(await collapsedInChrome(serviceWorker, work)).toBe(true);
    await panel.keyboard.press('Space');
    await expect(section, 'Space on the header did not expand the group').not.toHaveClass(/is-collapsed/, { timeout: 10_000 });
    expect(await collapsedInChrome(serviceWorker, work)).toBe(false);

    // The chevron is a real <button>: the header's handler takes its Enter and cancels the browser's own click, so one press is one toggle.
    await header.locator('.group-toggle').focus();
    await panel.keyboard.press('Enter');
    await expect(section, 'Enter on the chevron did not collapse the group').toHaveClass(/is-collapsed/, { timeout: 10_000 });
    await settle(panel);
    expect(await collapsedInChrome(serviceWorker, work), 'Enter on the chevron toggled twice').toBe(true);

    await expectClosedExactly(serviceWorker, ids, []);
  });

test('keyboard: Enter and Space on the colour swatch still open the colour picker, and do not toggle the group',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    const { work } = await buildLayout(harness, serviceWorker);
    const swatch = headerOf(panel, work).locator('.group-swatch');
    const blue = panel.locator(`${MENU} [data-testid="menu-item-group-color-blue"]`);

    await swatch.focus();
    await panel.keyboard.press('Enter');
    await expect(blue, 'Enter on the swatch did not open the colour picker').toBeVisible({ timeout: 10_000 });
    await panel.keyboard.press('Escape');
    await expect(panel.locator(MENU)).toBeHidden();

    await swatch.focus();
    await panel.keyboard.press('Space');
    await expect(blue, 'Space on the swatch did not open the colour picker').toBeVisible({ timeout: 10_000 });
    await panel.keyboard.press('Escape');
    await expect(panel.locator(MENU)).toBeHidden();

    await settle(panel);
    expect(await collapsedInChrome(serviceWorker, work), 'a swatch key toggled the group').toBe(false);
  });

// ── 11. the group goes before its last tab ───────────────────────────────────────────────────
//
// Chrome closes a group's tabs one at a time, and it removes the GROUP before the last of them (Probe 16: in every
// close it measured, `tabGroups.onRemoved` came before the last `tabs.onRemoved`, 0.1 to 46.9 ms before it). Between the
// two the panel can draw that last tab LOOSE, in front of the next group, with the group's element gone, and the x and
// focus with it. If the hand-off puts focus on the next group's card at that moment, the last tab's own removal
// lays the list out once more, and `reconcile()` (render.js) drops the loose card by MOVING the next group's element
// in front of it; a node that is moved is removed first, and a removed node loses focus (Probe 16 logs the
// `insertBefore` that did it). So the hand-off has to wait for the tabs, not only for the group's element.
// The tests pull the two steps apart with real Chrome calls (take the last tab out of the group, then close it).

/**
 * Drives a close the way Chrome stretches it. The panel's own request is held for good and its clock stands still (so
 * no deadline can run out between the steps, whatever the machine is doing), unless `slow`: then it jumps once, after
 * the render that follows alpha and beta closing and before gamma leaves the group. The x is pressed from the keyboard;
 * then real Chrome calls close alpha and beta and take gamma OUT of the group. Resolves once the panel has drawn that
 * state (the group's element gone, gamma loose) and has run the sync that follows the render; gamma is still open.
 */
async function closeUpToTheLastTab(harness, serviceWorker, { slow = false } = {}) {
  const { panel } = harness;
  await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
  const { ids, work } = await buildLayout(harness, serviceWorker);
  await pollThreshold(panel, 10);
  await freezeClock(panel);
  await holdRemovals(panel);
  expect(await tabFromSwatch(panel, work)).toEqual({ testid: 'group-close', groupId: String(work) });
  await panel.keyboard.press('Enter');
  await expect.poll(() => heldRemovals(panel), { message: 'the x never asked Chrome to close the tabs' }).toBe(1);

  await swEval(serviceWorker, (a) => chrome.tabs.remove([a.alpha, a.beta]), ids);
  if (slow) {
    // Chrome was slow: the group is still drawn (gamma is in it), and everything that runs from the click or from
    // the first render after it has run out before the group goes.
    await expect(panel.locator(CARD)).toHaveCount(3, { timeout: 10_000 });
    await renderNothing(panel);
    await skewClock(panel, LATE_MS);
  }
  await swEval(serviceWorker, (a) => chrome.tabs.ungroup(a.gamma), ids);
  await expect(panel.locator(`.group[data-group-id="${work}"]`), 'setup: the group should be gone from the list')
    .toHaveCount(0, { timeout: 10_000 });
  await expect(panel.locator(`${CARD}[data-tab-id="${ids.gamma}"]`), 'setup: gamma should be drawn, loose').toHaveCount(1);
  await renderNothing(panel); // the sync that follows the render which removed the group has run by now
  return { ids };
}

for (const [label, slow] of [['', false], [', after a slow close (whatever runs from the click has run out)', true]]) {
  test(`focus handed to the neighbour survives the last tab of the group closing${label}`, async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    const { ids } = await closeUpToTheLastTab(harness, serviceWorker, { slow });

    await swEval(serviceWorker, (id) => chrome.tabs.remove(id), ids.gamma);
    await expect(panel.locator(CARD)).toHaveCount(2, { timeout: 10_000 });
    await renderNothing(panel); // two frames after the last render: any hand-off or re-focusing has run by now

    expect(await focusDesc(panel), 'the last tab closing left focus off the card that takes the group\'s place')
      .toBe(`card ${ids.delta}`);
  });
}

// The wait for the tabs has an end: a tab that outlives its group (here: never closed) must not keep focus on <body>.
test('a tab that outlives its group does not hold the hand-off back for ever', async ({ harness, serviceWorker }) => {
  const { panel } = harness;
  const { ids } = await closeUpToTheLastTab(harness, serviceWorker);
  await skewClock(panel, LATE_MS);

  await renderNothing(panel);

  expect(await focusDesc(panel), 'gamma is still open and focus was never handed over').toBe(`card ${ids.delta}`);
  await expect(panel.locator(`${CARD}[data-tab-id="${ids.gamma}"]`), 'premise: gamma is still open').toHaveCount(1);
});

// ── 12. touch ─────────────────────────────────────────────────────────────────────────────────
//
// The x is invisible at rest for a mouse, and a control that closes tabs must not be tappable while invisible: the
// stylesheet shows it for `(hover: none), (any-pointer: coarse)`. Touch emulation is how this harness gets a coarse pointer.

test('touch: with a coarse pointer the x is visible without hovering the row', async ({ harness, serviceWorker, context }) => {
  const { panel } = harness;
  const { work, other } = await buildLayout(harness, serviceWorker);
  const xWork = xOf(panel, work);
  const xOther = xOf(panel, other);
  await expect(xWork, WHY_X).toHaveCount(1, { timeout: 10_000 });
  await panel.mouse.move(2, 2);
  await expect.poll(() => opacityOf(xWork), { message: 'premise: with a fine pointer at rest the x is invisible' }).toBe('0');

  const cdp = await context.newCDPSession(panel);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await expect.poll(() => panel.evaluate(() => matchMedia('(hover: none), (any-pointer: coarse)').matches),
    { message: 'premise: touch emulation did not make the pointer coarse' }).toBe(true);

  await expect.poll(() => opacityOf(xWork), { message: 'with a coarse pointer the x must be visible at rest' }).toBe('1');
  expect(await opacityOf(xOther), 'every row\'s x, not only the first').toBe('1');
});

// ── 13. the hand-off's own clocks (round 3) ───────────────────────────────────────────────────
//
// `applyPendingFocus` is only called from `sync()`, and `sync()` runs when the list renders or takes focus. The
// hand-off of the x has two waits that a clock bounds and that end in a bare `return`: the CLOSING wait (the group's
// element is gone and a tab the click asked to close is still drawn: 2 s from the moment the element was seen gone) and
// the SUCCESSOR wait (the card chosen at click time is not drawn: 2 s from the moment the hand-off started). With nothing
// left to render nothing calls `sync()` again, the deadline passes unseen and focus stays on <body>. Both tests end in a
// state where NOTHING ELSE HAPPENS in the list, so the only thing that can run the hand-off again is the timer each wait
// arms for itself (keyboard.js `armRecheck`). The 2 s are real: the first test moves the clock only after the wait began
// (the timer was armed against the frozen one), the second does not touch it.

test('the wait for the closed group\'s tabs ends by itself: no render follows the deadline, focus still lands',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    const { ids } = await closeUpToTheLastTab(harness, serviceWorker);
    expect(await focusDesc(panel), 'setup: with gamma still drawn the hand-off waits and focus is on <body>').toBe('body');
    await expect(panel.locator(`${CARD}[data-tab-id="${ids.gamma}"]`), 'setup: gamma is still open and drawn').toHaveCount(1);

    await skewClock(panel, LATE_MS); // the deadline is over by the clock; nothing renders

    await expect.poll(() => focusDesc(panel), {
      message: 'the closing wait passed its deadline with nothing rendering and focus stayed on <body>', timeout: 10_000,
    }).toBe(`card ${ids.delta}`);
    await expectFocusSettled(panel, `card ${ids.delta}`, 'a render after the hand-off took focus off the card that follows the group (delta)');
    await expect(panel.locator(`${CARD}[data-tab-id="${ids.gamma}"]`), 'premise: gamma is still open').toHaveCount(1);
  });

test('the wait for a successor card that is not drawn ends by itself: no render follows, focus still lands',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
    const { ids, groupIds } = await arrange(harness, serviceWorker, OTHER_THEN_WORK);
    await pollThreshold(panel, 10);
    await holdRemovals(panel);
    expect(await tabFromSwatch(panel, groupIds.Work), 'Tab from the swatch must land on this group\'s close button')
      .toEqual({ testid: 'group-close', groupId: String(groupIds.Work) });
    await panel.keyboard.press('Enter');
    await expect.poll(() => heldRemovals(panel), { message: 'the x never asked Chrome to close the tabs' }).toBe(1);

    // The card the click chose to take the group's place (epsilon, the one after it) goes first and by itself; then the group.
    await swEval(serviceWorker, (id) => chrome.tabs.remove(id), ids.epsilon);
    await expect(panel.locator(CARD), 'setup: epsilon should be gone from the list').toHaveCount(4, { timeout: 10_000 });
    await swEval(serviceWorker, (a) => chrome.tabs.remove([a.alpha, a.beta, a.gamma]), ids);
    await expect(panel.locator(CARD), 'setup: the group\'s cards should be gone from the list').toHaveCount(1, { timeout: 10_000 });

    // Nothing renders from here on. The successor is gone, so the hand-off gives up after its 2 s and takes the list's first card.
    await expect.poll(() => focusDesc(panel), {
      message: 'the successor wait passed its deadline with nothing rendering and focus stayed on <body>', timeout: 10_000,
    }).toBe(`card ${ids.delta}`);
    await expectFocusSettled(panel, `card ${ids.delta}`, 'a render after the hand-off took focus off the list\'s first card (delta)');
  });

/**
 * Counts the timers `armRecheck` (keyboard.js) creates, told apart from the panel's other timers by the frame name in
 * the creating stack (the extension is plain, unminified ES modules): how many were armed, how many were alive at once
 * at most, and how many are alive now (a timer is alive until it fires or is cleared).
 */
const watchRechecks = (panel) => panel.evaluate(() => {
  const realSet = window.setTimeout.bind(window);
  const realClear = window.clearTimeout.bind(window);
  const live = new Set();
  const stats = (window.__rechecks = { armed: 0, maxLive: 0, live });
  window.setTimeout = (fn, ms, ...rest) => {
    if (!new Error().stack.includes('armRecheck')) return realSet(fn, ms, ...rest);
    const id = realSet(() => { live.delete(id); return fn(...rest); }, ms);
    live.add(id);
    stats.armed += 1;
    stats.maxLive = Math.max(stats.maxLive, live.size);
    return id;
  };
  window.clearTimeout = (id) => { live.delete(id); return realClear(id); };
});
const recheckStats = (panel) => panel.evaluate(() => ({
  armed: window.__rechecks.armed, maxLive: window.__rechecks.maxLive, live: window.__rechecks.live.size,
}));

test('the re-check timer is a single slot, and none is left once the hand-off has landed', async ({ harness, serviceWorker }) => {
  const { panel } = harness;
  await watchRechecks(panel);
  const { ids } = await closeUpToTheLastTab(harness, serviceWorker);
  const waiting = await recheckStats(panel);
  expect(waiting.live, 'premise: the closing wait must hold exactly one re-check timer while gamma is still drawn').toBe(1);

  await swEval(serviceWorker, (id) => chrome.tabs.remove(id), ids.gamma);
  await expect(panel.locator(CARD)).toHaveCount(2, { timeout: 10_000 });
  await expectFocusSettled(panel, `card ${ids.delta}`, 'the hand-off did not land on the card that follows the group (delta)');

  const done = await recheckStats(panel);
  expect(done.armed, 'premise: at least the closing wait armed a timer').toBeGreaterThanOrEqual(1);
  expect(done.maxLive, 'two re-check timers were alive at once: arming does not replace the previous one').toBe(1);
  expect(done.live, 'a re-check timer outlived the entry it was armed for').toBe(0);
});

// The card paths (a card's x, Delete, Backspace) are not touched by any of this: the entry of a card's own hand-off waits for its
// successor exactly as it did, with no timer. That is the claim "unchanged" made testable: the same wait branch, reached by
// Delete instead of by the x, must arm nothing. The clock is frozen so that the 2 s cannot run out and hand focus to the first
// card (which is what a later render would do with an entry that has waited that long), whatever the machine is doing.
test('a card\'s own hand-off (Delete) arms no re-check timer, even when the card it waits for is not drawn',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
    const { ids } = await buildLayout(harness, serviceWorker);
    await pollThreshold(panel, 10);
    await watchRechecks(panel);
    await freezeClock(panel);
    await holdRemovals(panel); // Delete's own request stays at the gate, so the card stays until the service worker closes it
    await panel.locator(`${CARD}[data-tab-id="${ids.epsilon}"]`).focus();
    expect(await focusDesc(panel), 'setup: epsilon\'s card did not take focus').toBe(`card ${ids.epsilon}`);
    await panel.keyboard.press('Delete');
    await expect.poll(() => heldRemovals(panel), { message: 'Delete never asked Chrome to close the card' }).toBe(1);

    // epsilon's successor is delta, the last card before it. Delta goes first, so the hand-off waits for a card that is not drawn.
    await swEval(serviceWorker, (id) => chrome.tabs.remove(id), ids.delta);
    await expect(panel.locator(CARD), 'setup: delta should have left the list').toHaveCount(4, { timeout: 10_000 });
    await renderNothing(panel);
    await swEval(serviceWorker, (id) => chrome.tabs.remove(id), ids.epsilon);
    await expect(panel.locator(CARD), 'setup: epsilon should have left the list').toHaveCount(3, { timeout: 10_000 });
    await renderNothing(panel);

    expect(await focusDesc(panel), 'premise: the card that held focus is gone and nothing has handed focus on (the wait is still on)').toBe('body');
    expect(await recheckStats(panel), 'a card path armed a re-check timer').toEqual({ armed: 0, maxLive: 0, live: 0 });
  });

// ── 14. what arms the hand-off (round 3) ──────────────────────────────────────────────────────
//
// group-close.js refuses the second click of a multi-click (`event.detail > 1`). keyboard.js records the hand-off in
// its own capture listener, which is not told that: it used to arm an entry for the refused click too, and a refused
// click on another group's x REPLACED the entry of the close in progress, so the group that did close handed nothing on.

test('a double-click\'s refused second click does not replace the hand-off of the close in progress',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
    const { ids, groupIds } = await arrange(harness, serviceWorker, OTHER_THEN_WORK);
    await pollThreshold(panel, 10);
    await panel.evaluate(() => {
      window.__clickDetails = [];
      document.addEventListener('click', (e) => { window.__clickDetails.push(e.detail); }, true);
    });
    await holdRemovals(panel);
    expect(await tabFromSwatch(panel, groupIds.Work), 'Tab from the swatch must land on this group\'s close button')
      .toEqual({ testid: 'group-close', groupId: String(groupIds.Work) });
    await panel.keyboard.press('Enter'); // detail 0: the real request, held at the gate
    await expect.poll(() => heldRemovals(panel), { message: 'the x never asked Chrome to close the tabs' }).toBe(1);

    // The second click of a double-click, landing on the OTHER group's x. Dispatched rather than pressed: a real press
    // would also move focus onto that x, and the question is what happens to the hand-off, not to the focus.
    await xOf(panel, groupIds.Other).dispatchEvent('click', { detail: 2 });
    expect(await panel.evaluate(() => window.__clickDetails), 'premise: one keyboard click, then one with detail 2').toEqual([0, 2]);
    expect(await heldRemovals(panel), 'premise: group-close.js must refuse the click with detail 2').toBe(1);

    await releaseRemovals(panel);
    await expect(panel.locator(CARD), 'the held close never landed').toHaveCount(2, { timeout: 10_000 });
    await expectClosedExactly(serviceWorker, ids, WORK);
    await expect.poll(() => focusDesc(panel), {
      message: 'the refused click replaced the hand-off of the close in progress: focus is not on the card that follows Work (epsilon)',
      timeout: 10_000,
    }).toBe(`card ${ids.epsilon}`);
    await expectFocusSettled(panel, `card ${ids.epsilon}`, 'a render took focus off the card that follows Work (epsilon)');
  });

// ── 15. an entry that outlives its focus (round 3) ────────────────────────────────────────────
//
// The click on the x records a hand-off before anyone knows whether the group will go (the bar may be answered No, every
// member may be locked), and while the group is drawn the entry has no deadline. It must not outlive the focus that
// justified it: once focus has left for <body> while the group is still drawn, somebody put it there (Escape on the
// focused x blurs it), and a group that goes later by another route (Chrome's own tab strip, another window, a menu) must
// not pull focus back to a card. And it must still work when focus left the x for a reason that is not the user's: the
// confirm bar takes it (to its OK button) and gives it back, and a render can move the group's own element, which takes
// it off the x as well.

test('a Cancelled close, then focus parked on <body>, then the group goes some other way: focus stays on <body>',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 3 });
    const { ids, work } = await buildLayout(harness, serviceWorker);
    await pollThreshold(panel, 3);

    expect(await tabFromSwatch(panel, work)).toEqual({ testid: 'group-close', groupId: String(work) });
    await panel.keyboard.press('Enter');
    await expect(panel.locator(BAR), 'Enter on the x did not ask').toBeVisible({ timeout: 10_000 });
    await panel.keyboard.press('Escape');
    await expect(panel.locator(BAR)).toBeHidden();
    await expect.poll(() => focusDesc(panel), { message: 'focus did not return to the x after Cancel' }).toBe('x');
    await panel.keyboard.press('Escape'); // keyboard.js onEscape blurs the focused control: focus is parked on <body>
    expect(await focusDesc(panel), 'setup: the second Escape did not leave focus on <body>').toBe('body');
    await renderNothing(panel); // two frames: whatever watches focus has run

    // The group goes some other way: the service worker closes its tabs.
    await swEval(serviceWorker, (tabIds) => chrome.tabs.remove(tabIds), WORK.map((name) => ids[name]));
    await expect(panel.locator(CARD)).toHaveCount(2, { timeout: 10_000 });
    await expectClosedExactly(serviceWorker, ids, WORK);
    await renderNothing(panel); // the sync that follows the render which removed the group has run by now
    expect(await focusDesc(panel), 'a Cancelled close took focus from <body> when its group went').toBe('body');
  });

// The rule above is about a group that is still DRAWN. Once the group's element is gone the close has happened, the entry is
// no longer a stale one, and focus is on <body> because the x went with the group: a user who moves focus somewhere and back
// to <body> during the (at most 2 s) wait for the group's last tab has changed nothing, and the hand-off still lands.
test('focus moved away and back to <body> while the group\'s last tab is still closing does not cost the hand-off',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    const { ids } = await closeUpToTheLastTab(harness, serviceWorker);
    expect(await focusDesc(panel), 'setup: with gamma still drawn the hand-off waits and focus is on <body>').toBe('body');

    await panel.locator('#search-input').focus();
    expect(await focusDesc(panel), 'setup: the search box did not take focus').toBe('#search-input');
    await panel.evaluate(() => document.activeElement.blur()); // a focus loss to <body>, which `onFocusOut` reads a frame later
    expect(await focusDesc(panel), 'setup: the blur did not leave focus on <body>').toBe('body');
    await renderNothing(panel); // the frame has come

    await swEval(serviceWorker, (id) => chrome.tabs.remove(id), ids.gamma);
    await expect(panel.locator(CARD)).toHaveCount(2, { timeout: 10_000 });
    await expect.poll(() => focusDesc(panel), {
      message: 'a focus loss after the group had gone ended the hand-off: focus is not on the card that follows the group (delta)',
      timeout: 10_000,
    }).toBe(`card ${ids.delta}`);
    await expectFocusSettled(panel, `card ${ids.delta}`, 'a render took focus off the card that follows the group (delta)');
  });

// The mouse path, through the bar. A real press on the x focuses it (Probe 16, Result 7), so the entry has the same focus
// to watch as in the keyboard path: the press focuses the x, the bar takes focus to its OK button and gives it back to the
// x, and the group's removal then takes it down with the group.
test('the mouse path: the x clicked and the bar answered with the mouse, focus still lands on the card that follows',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 3 });
    const { ids, groupIds } = await arrange(harness, serviceWorker, OTHER_THEN_WORK);
    await pollThreshold(panel, 3);

    await clickX(panel, groupIds.Work);
    await expect(panel.locator(BAR), 'three tabs at threshold three must ask').toBeVisible({ timeout: 10_000 });
    await panel.locator('[data-testid="confirm-ok"]').click();

    await expect(panel.locator(CARD), 'Confirm must close the group').toHaveCount(2, { timeout: 10_000 });
    await expectClosedExactly(serviceWorker, ids, WORK);
    await expect.poll(() => focusDesc(panel), {
      message: 'after a mouse close focus is not on the card that follows the group (epsilon)', timeout: 10_000,
    }).toBe(`card ${ids.epsilon}`);
    await expectFocusSettled(panel, `card ${ids.epsilon}`, 'a render took focus off the card that follows the group (epsilon)');
  });

// The question is still on screen. The bar's text cannot take focus, so a press on it blurs the OK button and leaves focus on
// <body> while the group is still drawn (the same shape as Escape on the x, which does mean "I am done with this close"). Here
// nobody has walked away from the close: answering Yes afterwards closes the group, and it still has to hand focus on.
test('a click on the confirm bar\'s text parks focus on <body>; answering Yes afterwards still hands focus on',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 3 });
    const { ids, groupIds } = await arrange(harness, serviceWorker, OTHER_THEN_WORK);
    await pollThreshold(panel, 3);

    expect(await tabFromSwatch(panel, groupIds.Work), 'Tab from the swatch must land on this group\'s close button')
      .toEqual({ testid: 'group-close', groupId: String(groupIds.Work) });
    await panel.keyboard.press('Enter');
    await expect(panel.locator(BAR), 'three tabs at threshold three must ask').toBeVisible({ timeout: 10_000 });

    await panel.locator('[data-testid="confirm-text"]').click();
    expect(await focusDesc(panel), 'premise: a click on the bar\'s text must leave focus on <body>').toBe('body');
    await renderNothing(panel); // two frames: the frame in which a focus loss is read has come
    await expect(panel.locator(BAR), 'premise: the click on the text must not answer the question').toBeVisible();
    expect(await focusDesc(panel), 'premise: nothing moved focus after the click').toBe('body');

    await panel.locator('[data-testid="confirm-ok"]').click();
    await expect(panel.locator(CARD), 'Confirm must close the group').toHaveCount(2, { timeout: 10_000 });
    await expectClosedExactly(serviceWorker, ids, WORK);
    await expect.poll(() => focusDesc(panel), {
      message: 'after a click on the bar\'s text and a Yes, focus is not on the card that follows the group (epsilon)', timeout: 10_000,
    }).toBe(`card ${ids.epsilon}`);
    await expectFocusSettled(panel, `card ${ids.epsilon}`, 'a render took focus off the card that follows the group (epsilon)');
  });

// Closing the group IN FRONT moves the next group's element (`reconcile()` places a kept element before a stale one, and a
// node that is moved is removed first), so the x that holds focus loses it while its own group is still drawn, with the
// close in flight. That is not the user parking focus: the hand-off has to survive it.
test('a render that moves the group\'s own element under the focused x does not cost the hand-off',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
    const { ids, groupIds } = await arrange(harness, serviceWorker, {
      groups: [
        { title: 'Gone', color: 'red', members: ['delta'] },
        { title: 'Stay', color: 'blue', members: ['alpha', 'beta', 'gamma'] },
      ],
      loose: ['epsilon'],
    });
    await pollThreshold(panel, 10);
    await holdRemovals(panel);
    expect(await tabFromSwatch(panel, groupIds.Stay), 'Tab from the swatch must land on this group\'s close button')
      .toEqual({ testid: 'group-close', groupId: String(groupIds.Stay) });
    await panel.keyboard.press('Enter');
    await expect.poll(() => heldRemovals(panel), { message: 'the x never asked Chrome to close the tabs' }).toBe(1);

    await swEval(serviceWorker, (id) => chrome.tabs.remove(id), ids.delta);
    await expect(panel.locator(CARD), 'setup: Gone should have left the list').toHaveCount(4, { timeout: 10_000 });
    await renderNothing(panel);
    expect(await focusDesc(panel), 'premise: the render that removed Gone must have moved Stay\'s element and taken focus off its x')
      .toBe('body');

    await releaseRemovals(panel);
    await expect(panel.locator(CARD), 'the held close never landed').toHaveCount(1, { timeout: 10_000 });
    await expectClosedExactly(serviceWorker, ids, ['delta', ...WORK]);
    await expect.poll(() => focusDesc(panel), {
      message: 'the group\'s close lost its hand-off because a render had moved the group under the focused x: focus is not on epsilon',
      timeout: 10_000,
    }).toBe(`card ${ids.epsilon}`);
    await expectFocusSettled(panel, `card ${ids.epsilon}`, 'a render took focus off the card that follows the group (epsilon)');
  });

// ── 16. a held key (round 3) ──────────────────────────────────────────────────────────────────
//
// Probe 16, Result 10, measured with Playwright's synthetic key repeat on an extension WITHOUT the rule: a held Enter repeats
// `keydown` (`event.repeat === true`) and Chromium 151 clicked the focused button once per repeat; Space clicked once, on keyup.
// A repeat from a real keyboard or the OS was not measured, and neither was a held Space WITH the rule: these tests hold Enter
// only. On the x that is a click, and a close request, per repeat. And when the first press has opened the confirm bar, focus
// has moved to its OK button by the time the first repeat comes, so the repeat lands THERE and answers the question before
// anyone could read it. The rules cancel the repeats on the x and inside #confirm-bar only; a held key anywhere else repeats as
// before. Playwright's `keyboard.down()` on a key that is already down sends `autoRepeat`, which the page reads as
// `repeat: true`; all three tests assert that, so that "no extra click" is never read from a keyboard that did not repeat.

const recordKeys = (panel) => panel.evaluate(() => {
  window.__keys = { repeats: 0, clicks: [] };
  document.addEventListener('keydown', (e) => { if (e.repeat) window.__keys.repeats += 1; }, true);
  document.addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target.closest('[data-testid]') : null;
    window.__keys.clicks.push(el ? el.dataset.testid : 'untagged');
  }, true);
});
const readKeys = (panel) => panel.evaluate(() => window.__keys);

/** Holds Enter: the press, then two repeats with the key still down, then the release. */
async function holdEnter(panel) {
  await panel.keyboard.down('Enter');
  await panel.keyboard.down('Enter');
  await panel.keyboard.down('Enter');
  await panel.keyboard.up('Enter');
}

test('a held Enter on the x closes once: the repeats of the key do not click it again', async ({ harness, serviceWorker }) => {
  const { panel } = harness;
  await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
  const { work } = await buildLayout(harness, serviceWorker);
  await pollThreshold(panel, 10);
  await recordKeys(panel);
  await holdRemovals(panel); // the group stays drawn and the x keeps focus, so every repeat lands on it
  expect(await tabFromSwatch(panel, work), 'Tab from the swatch must land on this group\'s close button')
    .toEqual({ testid: 'group-close', groupId: String(work) });

  await holdEnter(panel);

  const keys = await readKeys(panel);
  expect(keys.repeats, 'premise: the synthetic keyboard must produce keydowns with repeat === true').toBe(2);
  expect(keys.clicks, 'the repeats of a held Enter clicked the x again').toEqual(['group-close']);
  expect(await heldRemovals(panel), 'the repeats of a held Enter asked Chrome to close the same tabs again').toBe(1);
});

test('a held Enter that opens the confirm bar does not answer it: the repeats do not click OK', async ({ harness, serviceWorker }) => {
  const { panel } = harness;
  await setSettings(serviceWorker, { confirmCloseThreshold: 3 });
  const { work } = await buildLayout(harness, serviceWorker);
  await pollThreshold(panel, 3);
  await recordKeys(panel);
  await holdRemovals(panel);
  expect(await tabFromSwatch(panel, work), 'Tab from the swatch must land on this group\'s close button')
    .toEqual({ testid: 'group-close', groupId: String(work) });

  await holdEnter(panel);

  const keys = await readKeys(panel);
  expect(keys.repeats, 'premise: the synthetic keyboard must produce keydowns with repeat === true').toBe(2);
  expect(keys.clicks, 'the repeats of a held Enter answered the confirm bar, or asked it again').toEqual(['group-close']);
  await expect(panel.locator(BAR), 'the key that opened the bar answered it').toBeVisible();
  expect(await heldRemovals(panel), 'the held key confirmed the close before anyone could read the question').toBe(0);
  // The question is still there to be answered by a person.
  await panel.locator('[data-testid="confirm-cancel"]').click();
  await expect(panel.locator(BAR)).toBeHidden();
});

// The rule is on the bar (`#confirm-bar`), not on the group's x: the bar cannot tell who opened it, so it changes the key handling of EVERY
// confirm bar. The test above opens the bar through `closeTabs`, which every bulk close of tabs shares (the card menu, the header menu, the
// group's x). This is the other caller, which does not go through `closeTabs`: the settings drawer's "Clear preview cache" (settings-view.js).
test('a held Enter on the settings\' clear-cache button does not answer the question it asks: the repeats do not click OK',
  async ({ harness }) => {
    const { panel } = harness;
    await panel.locator('[data-testid="settings-button"]').click();
    await expect(panel.locator('[data-testid="settings-view"]')).toBeVisible({ timeout: 10_000 });
    const clear = panel.locator('[data-testid="settings-clear-cache"]');
    await expect(clear, 'the settings drawer must offer the clear-cache button').toHaveCount(1, { timeout: 10_000 });
    await clear.focus();
    expect(await focusDesc(panel), 'setup: the clear-cache button did not take focus').toBe('#settings-clear-cache');
    await recordKeys(panel);

    await holdEnter(panel);

    const keys = await readKeys(panel);
    expect(keys.repeats, 'premise: the synthetic keyboard must produce keydowns with repeat === true').toBe(2);
    expect(keys.clicks, 'the repeats of a held Enter answered the clear-cache question, or asked it again').toEqual(['settings-clear-cache']);
    await expect(panel.locator(BAR), 'the key that asked the question answered it').toBeVisible();
    // The question is still there to be answered with the keyboard, and this test answers it with Escape: the held Enter is what it
    // pins. History: when this test was written, the settings drawer covered the bar, so the mouse could not answer it (Playwright
    // found an element of the drawer on top of Cancel and retried the click until the test timed out). That was S15: #settings-view.drawer
    // at z-index 70 above #confirm-bar at 65, verified by hit-testing, not by pixels, and pre-existing (A39, Known, not changed, item 9).
    // The bar is now at 75, above the drawer, and spec 08 pins that a real click on Cancel and on Delete answers it.
    await panel.keyboard.press('Escape');
    await expect(panel.locator(BAR)).toBeHidden();
  });
