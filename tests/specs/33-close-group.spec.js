// 33-close-group — closing a whole tab group in one action.
//
// The feature exists twice: `group-close` on the group header's menu and `close-group` on any card
// inside a group (both in context-menu.js). Both end in `closeTabs(ids)`, which asks first when
// the number of ids it was ASKED to close reaches `settings.confirmCloseThreshold`, locked members
// included (spec-addendum A38).
//
// Until 2026-11-04 they got their ids at different moments: the header resolved them when the menu
// OPENED, the card when the item was CLICKED. Probe 14 (tests/probes/96-close-group-resolution-probe.spec.js,
// probe-results.md) measured it: with beta ungrouped while the menu was open, the header item closed
// alpha, beta and gamma and the card item alpha and gamma. The owner decided that both resolve at the
// click (A38, the answer to PR #12's question 2), and the v7 tests at the end of this file pin it for
// the card's Close group, the header's Close group and the header's Ungroup, under three membership
// changes (a member leaves, a tab joins, a member moves to another group). Also decided there, and
// pinned there: a card inside a multi-selection closes its GROUP, and the bar counts the tabs asked for.
//
// The layout every test builds is the point of this file. An earlier version used one
// group of two and a single loose tab, and that is too little to pin anything down:
// with only one group, "close every grouped tab in the window", "close the first
// group" and "close the active tab's group" are all indistinguishable from "close THIS
// group", and all three passed. With a two-member group, right-clicking its first
// member cannot tell "the whole group" from "this tab and the ones after it". So:
//
//   [ alpha beta gamma ] = "Work"   [ delta ] = "Other"   epsilon (loose)
//
// Three members, so the card menu can be opened on a middle one; a second group that
// is neither first nor holding the active tab; and a loose tab, because
// `tabIdsOfGroup(-1)` returns every ungrouped tab in the window: an item offered on a
// loose tab's menu would act on all of them, not only on the one that was right-clicked.
// There is just one loose tab here, so the test for it checks that the item is not
// offered; it does not exercise that reach.
'use strict';

const { test, expect } = require('../fixtures');
const { swEval, setSettings, createTab } = require('../helpers/chrome');

const MENU = '[data-testid="context-menu"]';
const HEADER = '[data-testid="group-header"]';
const CARD = '#tablist [data-testid="tab-card"]';
const BAR = '[data-testid="confirm-bar"]';

// The harness opens the panel page at the context's default viewport, 1280×800 (fixtures.js:47). Five
// cards and two headers do not fit there (measured: a list of 2297 px in a 719 px list area; at 400 px
// wide the same list fits even at 800 px high), and `context-menu.js` closes the menu when `#tablist`
// scrolls — so a card that has to be scrolled into view to be right-clicked opens a menu that shuts again
// before it can be used. The 400 is the width that makes the cards short; the 1500 is room to spare.
const PANEL_VIEWPORT = Object.freeze({ width: 400, height: 1500 });

test.beforeEach(async ({ harness, serviceWorker }) => {
  await harness.panel.setViewportSize(PANEL_VIEWPORT);
  await setSettings(serviceWorker, { refreshInterval: 'off' });
});

/**
 * Every tab id open in EVERY window.
 *
 * Scoping this to the panel's window would accept a "close" that merely moved the tabs
 * somewhere else; the panel would stop drawing them either way.
 */
const allOpenTabIds = (sw) => swEval(sw, async () => (await chrome.tabs.query({})).map((t) => t.id));

/** Builds `[alpha beta gamma]=Work [delta]=Other epsilon`, and proves it was built. */
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

  // Setup that silently did not take would make every assertion below vacuous. Ask
  // Chrome rather than the panel: the panel is what is under test.
  const placed = await swEval(serviceWorker, async (wid) => Object.fromEntries(
    (await chrome.tabs.query({ windowId: wid })).map((t) => [t.id, t.groupId])), w2);
  expect(placed, 'setup did not build the layout these tests assume').toEqual({
    [ids.alpha]: groups.work,
    [ids.beta]: groups.work,
    [ids.gamma]: groups.work,
    [ids.delta]: groups.other,
    [ids.epsilon]: -1,
  });
  // And the panel has drawn all of it, so a later "gone" is a change rather than a race
  // with the first paint.
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
const settle = (panel) => panel.evaluate(() => window.__vt.stateModule.resync());
const pollThreshold = (panel, n) => expect.poll(
  () => panel.evaluate(() => window.__vt.settings.confirmCloseThreshold),
  { message: `the threshold ${n} never reached the panel` }).toBe(n);

/**
 * Clicks a context-menu item once it is offered and enabled, and says what the user was owed
 * when it is not.
 *
 * A bare `.click()` on an item that was never offered, or is disabled, waits until the 90 s
 * test timeout (playwright.config.js:17; no `actionTimeout` is set) and then reports nothing
 * but the timeout: not which item, not why it should have been there. `why` is that
 * requirement in the user's terms.
 */
async function clickMenuItem(panel, itemId, why) {
  const item = panel.locator(`${MENU} [data-testid="menu-item-${itemId}"]`);
  await expect(item, why).toBeEnabled({ timeout: 10_000 });
  await item.click();
}
const closeGroupWhy = (menu) => `"Close group" must be offered and enabled in the ${menu}`;
const WHY_HEADER = closeGroupWhy('group-header menu');
const WHY_CARD = closeGroupWhy('card menu');
const WHY_LOCK = '"Lock this tab" must be offered and enabled in the card menu';

test('the group-header menu closes every member of THAT group and nothing else',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
    const { ids, work } = await buildLayout(harness, serviceWorker);

    await headerOf(panel, work).click({ button: 'right' });
    await expect(panel.locator(`${MENU} [data-testid="menu-item-group-close"]`),
      'the header menu must offer the item under its own name').toHaveText('Close group');
    await clickMenuItem(panel, 'group-close', WHY_HEADER);

    await expect(panel.locator(CARD)).toHaveCount(2, { timeout: 10_000 });
    await expectClosedExactly(serviceWorker, ids, WORK);
    await expect(panel.locator(HEADER), 'the other group should still be drawn').toHaveCount(1);
  });

test('the header menu of the OTHER group closes only that group',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
    const { ids, other } = await buildLayout(harness, serviceWorker);

    await headerOf(panel, other).click({ button: 'right' });
    await clickMenuItem(panel, 'group-close', WHY_HEADER);

    await expect(panel.locator(CARD)).toHaveCount(4, { timeout: 10_000 });
    await expectClosedExactly(serviceWorker, ids, ['delta']);
  });

test('close-group from the MIDDLE member takes the whole group, before it and after it',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
    const { ids } = await buildLayout(harness, serviceWorker);

    await panel.locator(`[data-tab-id="${ids.beta}"] .thumb`).click({ button: 'right' });
    await expect(panel.locator(`${MENU} [data-testid="menu-item-close-group"]`),
      'the card menu must offer the item under its own name').toHaveText('Close group');
    await clickMenuItem(panel, 'close-group', WHY_CARD);

    await expect(panel.locator(CARD)).toHaveCount(2, { timeout: 10_000 });
    await expectClosedExactly(serviceWorker, ids, WORK);
  });

test('close-group from a card of the OTHER group closes only that group',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
    const { ids } = await buildLayout(harness, serviceWorker);

    await panel.locator(`[data-tab-id="${ids.delta}"] .thumb`).click({ button: 'right' });
    await clickMenuItem(panel, 'close-group', WHY_CARD);

    await expect(panel.locator(CARD)).toHaveCount(4, { timeout: 10_000 });
    await expectClosedExactly(serviceWorker, ids, ['delta']);
  });

test('a loose tab is not offered "close group", which would mean every loose tab',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    const { ids } = await buildLayout(harness, serviceWorker);

    await panel.locator(`[data-tab-id="${ids.epsilon}"] .thumb`).click({ button: 'right' });
    // Chrome gives ungrouped tabs `groupId === -1` rather than null, so a `grouped`
    // test that only checks for null puts this item on a loose tab's menu, where
    // `tabIdsOfGroup(-1)` means every loose tab in the window. Assert the menu really
    // opened first, or the count of zero below is satisfied by no menu at all.
    await expect(panel.locator(`${MENU} [data-testid="menu-item-close"]`), 'the menu did not open')
      .toBeVisible();
    await expect(panel.locator(`${MENU} [data-testid="menu-item-close-group"]`)).toHaveCount(0);
  });

test('a collapsed group: the model keeps its members, the DOM hides them, close takes them',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
    const { ids, work } = await buildLayout(harness, serviceWorker);

    await swEval(serviceWorker, (id) => chrome.tabGroups.update(id, { collapsed: true }), work);
    await expect(panel.locator(`.group[data-group-id="${work}"].is-collapsed`))
      .toHaveCount(1, { timeout: 10_000 });

    // The premise, observed rather than asserted in a comment. The members are NOT
    // removed from the DOM — `.group.is-collapsed .group-body { display: none }`
    // (sidepanel.css:885) hides them — while `tabIdsOfGroup` reads the tab model. The
    // two can disagree, and only the model's answer is the right one here.
    // `toBeHidden()` alone also passes for a selector that matches nothing, so a member
    // that had been REMOVED from the DOM would satisfy it and the premise would go
    // unchecked. Count first: it is in the DOM, and then it is not painted.
    const member = panel.locator(`[data-tab-id="${ids.beta}"]`);
    await expect(member, 'a collapsed member must stay in the DOM, hidden by CSS, not be removed')
      .toHaveCount(1);
    await expect(member, 'a collapsed member must not be painted').toBeHidden();
    const inModel = await panel.evaluate((g) => [...window.__vt.state.tabs.values()]
      .filter((t) => t.groupId === g).map((t) => t.id), work);
    expect(inModel.sort(), 'the panel model lost the collapsed members')
      .toEqual([ids.alpha, ids.beta, ids.gamma].sort());

    await headerOf(panel, work).click({ button: 'right' });
    await clickMenuItem(panel, 'group-close', WHY_HEADER);

    await expect(panel.locator(CARD)).toHaveCount(2, { timeout: 10_000 });
    await expectClosedExactly(serviceWorker, ids, WORK);
  });

test('at the threshold the bar names the count; cancel keeps all, confirm closes the group',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 3 });
    const { ids, work } = await buildLayout(harness, serviceWorker);
    // The setting travels to the panel asynchronously. Without this the test could run
    // against the default of 5 and still look right.
    await expect.poll(() => panel.evaluate(() => window.__vt.settings.confirmCloseThreshold),
      { message: 'the threshold never reached the panel' }).toBe(3);

    await headerOf(panel, work).click({ button: 'right' });
    await clickMenuItem(panel, 'group-close', WHY_HEADER);
    const bar = panel.locator(BAR);
    await expect(bar, 'a bulk close went through without asking').toBeVisible({ timeout: 10_000 });
    // A bar that asks about the wrong number is worse than no bar: the user approves
    // something other than what happens.
    await expect(panel.locator('[data-testid="confirm-text"]'),
      'the bar must name how many tabs it is about to close').toContainText(/\b3\b/);

    await panel.locator('[data-testid="confirm-cancel"]').click();
    await expect(bar).toBeHidden();
    // The bar replaces the footer while it is up; a bar that closes without giving the
    // footer back leaves the panel without its toolbar.
    await expect(panel.locator('.bottombar'), 'the footer did not come back after Cancel')
      .toBeVisible();
    // A round trip through the panel's own resync is ordered after any close that the
    // cancel failed to stop, so reading now cannot pass by reading too early.
    await panel.evaluate(() => window.__vt.stateModule.resync());
    const afterCancel = await allOpenTabIds(serviceWorker);
    expect(afterCancel, 'cancelling the confirm bar still closed tabs')
      .toEqual(expect.arrayContaining(Object.values(ids)));
    await expect(panel.locator(CARD)).toHaveCount(5);

    await headerOf(panel, work).click({ button: 'right' });
    await clickMenuItem(panel, 'group-close', WHY_HEADER);
    await expect(bar).toBeVisible({ timeout: 10_000 });
    await panel.locator('[data-testid="confirm-ok"]').click();

    await expect(panel.locator(CARD)).toHaveCount(2, { timeout: 10_000 });
    await expectClosedExactly(serviceWorker, ids, WORK);
    // Asserted AFTER the close, so a bar that is still on screen is not read as a bar
    // that has not appeared yet.
    await expect(bar, 'the bar is still on screen after Confirm').toBeHidden();
    await expect(panel.locator('.bottombar'), 'the footer did not come back after Confirm')
      .toBeVisible();
  });

test('one tab below the threshold there is no bar and the group closes at once',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    // Three members against a threshold of four. The adjacent case is the one that
    // matters: a threshold compared with `ids.length + 1` would ask here, and a test
    // that only ever stays far below the threshold would not notice.
    await setSettings(serviceWorker, { confirmCloseThreshold: 4 });
    const { ids, work } = await buildLayout(harness, serviceWorker);
    await expect.poll(() => panel.evaluate(() => window.__vt.settings.confirmCloseThreshold),
      { message: 'the threshold never reached the panel' }).toBe(4);

    await headerOf(panel, work).click({ button: 'right' });
    await clickMenuItem(panel, 'group-close', WHY_HEADER);

    await expect(panel.locator(BAR), 'asked for confirmation below the threshold').toBeHidden();
    await expect(panel.locator(CARD)).toHaveCount(2, { timeout: 10_000 });
    await expectClosedExactly(serviceWorker, ids, WORK);
  });

test('above the threshold the bar names the COUNT, not the threshold, and cancel keeps all',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    // Three members against a threshold of two, a count ABOVE the threshold. Where the count
    // EQUALS it (`at the threshold the bar names the count`, `the CARD menu asks as well`),
    // `>=` and `===` agree and a message that prints the threshold prints the right number
    // by accident.
    await setSettings(serviceWorker, { confirmCloseThreshold: 2 });
    const { ids, work } = await buildLayout(harness, serviceWorker);
    await pollThreshold(panel, 2);

    await headerOf(panel, work).click({ button: 'right' });
    await clickMenuItem(panel, 'group-close', WHY_HEADER);
    await expect(panel.locator(BAR), 'above the threshold there must be a bar')
      .toBeVisible({ timeout: 10_000 });
    const text = panel.locator('[data-testid="confirm-text"]');
    await expect(text).toContainText(/\b3\b/);
    await expect(text, 'the bar names the threshold, not the count').not.toContainText(/\b2\b/);
    await panel.locator('[data-testid="confirm-cancel"]').click();
    await expect(panel.locator(BAR)).toBeHidden();
    await settle(panel);
    expect(await allOpenTabIds(serviceWorker), 'cancelling still closed tabs')
      .toEqual(expect.arrayContaining(Object.values(ids)));
  });

test('the CARD menu asks as well: bar at the threshold, cancel keeps all, confirm closes the group',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    // The bar tests above this one all go through the header item. The two items are
    // separate call sites, so a card item that skipped the bar would pass every one of
    // them. (The two loops further down also take the card item through the bar.)
    await setSettings(serviceWorker, { confirmCloseThreshold: 3 });
    const { ids } = await buildLayout(harness, serviceWorker);
    await pollThreshold(panel, 3);

    await panel.locator(`[data-tab-id="${ids.beta}"] .thumb`).click({ button: 'right' });
    await clickMenuItem(panel, 'close-group', WHY_CARD);
    await expect(panel.locator(BAR), 'the card menu closed a whole group without asking')
      .toBeVisible({ timeout: 10_000 });
    await expect(panel.locator('[data-testid="confirm-text"]')).toContainText(/\b3\b/);
    await panel.locator('[data-testid="confirm-cancel"]').click();
    await expect(panel.locator(BAR)).toBeHidden();
    await settle(panel);
    expect(await allOpenTabIds(serviceWorker), 'cancelling still closed tabs')
      .toEqual(expect.arrayContaining(Object.values(ids)));

    await panel.locator(`[data-tab-id="${ids.beta}"] .thumb`).click({ button: 'right' });
    await clickMenuItem(panel, 'close-group', WHY_CARD);
    await expect(panel.locator(BAR)).toBeVisible({ timeout: 10_000 });
    await panel.locator('[data-testid="confirm-ok"]').click();
    await expect(panel.locator(CARD)).toHaveCount(2, { timeout: 10_000 });
    await expectClosedExactly(serviceWorker, ids, WORK);
  });

test('Escape on the confirm bar cancels; it does not confirm',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 3 });
    const { ids, work } = await buildLayout(harness, serviceWorker);
    await pollThreshold(panel, 3);

    await headerOf(panel, work).click({ button: 'right' });
    await clickMenuItem(panel, 'group-close', WHY_HEADER);
    await expect(panel.locator(BAR)).toBeVisible({ timeout: 10_000 });
    await panel.keyboard.press('Escape');
    await expect(panel.locator(BAR)).toBeHidden();
    await settle(panel);
    expect(await allOpenTabIds(serviceWorker), 'Escape closed the group')
      .toEqual(expect.arrayContaining(Object.values(ids)));
  });

// `keyboard.js` is the SECOND way Escape reaches the confirm bar, and the test above never
// takes it. `confirmBar` puts focus on the OK button (toast.js:183-188; A17, spec-addendum.md:745),
// so that Escape starts inside `#confirm-bar`, where the bar's own listener (toast.js:58-61,
// 256-263) cancels and stops the event going any further. The bar is not modal: nothing in
// toast.js or the stylesheet makes the list inert while it is up, so focus can be elsewhere,
// and then the keydown never passes through the bar. Only the document-level handler
// (keyboard.js:56, 250-256 -> `onEscape`, 322-327) can cancel. A17 says "Escape = cancel" for
// this component without saying where focus has to be.
test('Escape with focus on a card, outside the confirm bar, cancels it; it does not confirm',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 3 });
    const { ids, work } = await buildLayout(harness, serviceWorker);
    await pollThreshold(panel, 3);

    await headerOf(panel, work).click({ button: 'right' });
    await clickMenuItem(panel, 'group-close', WHY_HEADER);
    const bar = panel.locator(BAR);
    await expect(bar).toBeVisible({ timeout: 10_000 });

    // By script, not by click: a click on a card activates that tab, which is state the
    // assertions below read. The loose tab, so the move cannot be read as touching the group
    // that is being closed. Every card carries a tabindex (-1, or 0 for the roving one:
    // keyboard.js:85-92, sidepanel.html:245), keyboard.js:619-625 focuses such cards the same
    // way, and 05-interactions.spec.js:94 does the same to alpha's card.
    await panel.locator(`${CARD}[data-tab-id="${ids.epsilon}"]`).focus();

    // The premise, observed rather than assumed. Without it this test could pass through the
    // bar's own listener (focus still on the OK button) and prove nothing about `onEscape`.
    await expect(bar, 'premise: the bar must still be up when Escape is pressed').toBeVisible();
    const focus = await panel.evaluate(() => {
      const el = document.activeElement;
      return {
        inBar: Boolean(el && el.closest('#confirm-bar')),
        onCard: Boolean(el && el.closest('[data-testid="tab-card"]')),
        what: el
          ? el.tagName.toLowerCase() + (el.dataset && el.dataset.testid ? '[' + el.dataset.testid + ']' : '')
          : 'nothing',
      };
    });
    expect(focus.inBar,
      `premise: focus is still inside the confirm bar (on ${focus.what}), so Escape would take the bar's own listener`)
      .toBe(false);
    expect(focus.onCard, `premise: focus should be on a tab card, but it is on ${focus.what}`).toBe(true);

    await panel.keyboard.press('Escape');
    await expect(bar, 'Escape with focus outside the bar left the bar up').toBeHidden();
    await settle(panel);
    expect(await allOpenTabIds(serviceWorker), 'Escape with focus outside the bar closed the group')
      .toEqual(expect.arrayContaining(Object.values(ids)));
  });

// spec-addendum.md:1226 — a bulk close is "filtered, not refused": a locked tab among the
// ones being closed stays open and the rest close. Both entry points end in `closeTabs`,
// but they reach it from different call sites, so each is checked.
for (const entry of [
  { name: 'card menu', open: (panel, ids) => panel.locator(`[data-tab-id="${ids.alpha}"] .thumb`).click({ button: 'right' }), item: 'close-group' },
  { name: 'group-header menu', open: (panel, ids, work) => headerOf(panel, work).click({ button: 'right' }), item: 'group-close' },
]) {
  test(`${entry.name}: close group keeps a LOCKED member and closes the rest`,
    async ({ harness, serviceWorker }) => {
      const { panel } = harness;
      await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
      const { ids, work } = await buildLayout(harness, serviceWorker);
      await pollThreshold(panel, 10);

      await panel.locator(`[data-tab-id="${ids.beta}"] .thumb`).click({ button: 'right' });
      await clickMenuItem(panel, 'lock', WHY_LOCK);
      await expect(panel.locator(`[data-tab-id="${ids.beta}"]`), 'setup: beta did not become locked')
        .toHaveClass(/is-locked/, { timeout: 10_000 });

      await entry.open(panel, ids, work);
      await clickMenuItem(panel, entry.item, closeGroupWhy(entry.name));
      await expect(panel.locator(CARD)).toHaveCount(3, { timeout: 10_000 });
      await expectClosedExactly(serviceWorker, ids, ['alpha', 'gamma']);
    });
}

// The two entry points again, for the loops below. The LOCKED loop above spells the same
// pair out inline.
const CLOSE_GROUP_ENTRIES = [
  { name: 'card menu', open: (panel, ids) => panel.locator(`[data-tab-id="${ids.alpha}"] .thumb`).click({ button: 'right' }), item: 'close-group' },
  { name: 'group-header menu', open: (panel, ids, work) => headerOf(panel, work).click({ button: 'right' }), item: 'group-close' },
];

// spec-addendum.md:1225-1226 — a lock is enforced in `ops.remove()`, "the single path every
// panel close takes", and a bulk close is filtered, not refused. The confirm bar is a second
// road into the same close: `closeTabs` asks first (context-menu.js:518-525) and only then
// reaches the shared `ops.remove(ids)` (:526). A confirm branch that removed the tabs itself
// would skip the filter, and the LOCKED tests above cannot see it, because their threshold is
// 10 and no bar ever appears. Here the threshold (2) is below the group size (3), so the bar
// appears, and the user presses Confirm with beta locked.
// The number the bar names is deliberately not asserted here. The threshold is 2 and not 3 on
// purpose: at 2 both readings of the threshold ask, so this test pins A33's promise and nothing
// else. Which reading is the spec was undecided when this was written; the owner decided on
// 2026-11-04 that the bar counts the tabs REQUESTED, the locked member included (A38); the v7 test
// "the confirm bar counts the tabs ASKED to close" pins that at a threshold of 3.
for (const entry of CLOSE_GROUP_ENTRIES) {
  test(`${entry.name}: after Confirm on the bar a LOCKED member is still kept, the rest are closed`,
    async ({ harness, serviceWorker }) => {
      const { panel } = harness;
      await setSettings(serviceWorker, { confirmCloseThreshold: 2 });
      const { ids, work } = await buildLayout(harness, serviceWorker);
      await pollThreshold(panel, 2);

      await panel.locator(`[data-tab-id="${ids.beta}"] .thumb`).click({ button: 'right' });
      await clickMenuItem(panel, 'lock', WHY_LOCK);
      await expect(panel.locator(`[data-tab-id="${ids.beta}"]`), 'setup: beta did not become locked')
        .toHaveClass(/is-locked/, { timeout: 10_000 });

      await entry.open(panel, ids, work);
      await clickMenuItem(panel, entry.item, closeGroupWhy(entry.name));
      await expect(panel.locator(BAR), 'a group of three at a threshold of two should ask before closing')
        .toBeVisible({ timeout: 10_000 });
      await panel.locator('[data-testid="confirm-ok"]').click();

      await expect(panel.locator(CARD), 'alpha and gamma should close, the locked beta should stay')
        .toHaveCount(3, { timeout: 10_000 });
      await expectClosedExactly(serviceWorker, ids, ['alpha', 'gamma']);
    });
}

// A Confirm pressed where the count EQUALS the threshold (`at the threshold the bar names the
// count`, `the CARD menu asks as well`) cannot tell "close the first <threshold> ids" from "close
// all of them": it is the same set (the Cancel tests never get that far). One member more than
// the threshold tells them apart. The LOCKED/Confirm loop above is also at three members and a
// threshold of two; this one isolates the claim by locking nothing.
for (const entry of CLOSE_GROUP_ENTRIES) {
  test(`${entry.name}: above the threshold, Confirm closes ALL of the group, not just threshold-many tabs`,
    async ({ harness, serviceWorker }) => {
      const { panel } = harness;
      await setSettings(serviceWorker, { confirmCloseThreshold: 2 });
      const { ids, work } = await buildLayout(harness, serviceWorker);
      await pollThreshold(panel, 2);

      await entry.open(panel, ids, work);
      await clickMenuItem(panel, entry.item, closeGroupWhy(entry.name));
      await expect(panel.locator(BAR), 'above the threshold there must be a bar')
        .toBeVisible({ timeout: 10_000 });
      await panel.locator('[data-testid="confirm-ok"]').click();

      await expect(panel.locator(CARD), 'Confirm must close every member of the group')
        .toHaveCount(2, { timeout: 10_000 });
      await expectClosedExactly(serviceWorker, ids, WORK);
    });
}

// ── v5: claims no test above could tell from a wrong implementation ─────────────────────────────
// Each block names the implementation it exists to catch. All of them go through Close group,
// which is the way a user reaches every one of these code paths.

// A group is its id and nothing else. Title and colour are free-form (rename, the colour picker) and
// every untitled group has the same empty title, so two groups the user cannot tell apart are an ordinary
// state. `tabIdsOfGroup` (context-menu.js:461-467) therefore has to compare `groupId`. One that compared
// title and colour would fold the second group into the one being closed, and every test above passes it:
// their groups are Work/blue and Other/red, so "same group" and "looks the same" agree on every input.
for (const entry of CLOSE_GROUP_ENTRIES) {
  test(`${entry.name}: a second group with the SAME title and colour is left alone by close group`,
    async ({ harness, serviceWorker }) => {
      const { panel } = harness;
      await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
      const { ids, work, other } = await buildLayout(harness, serviceWorker);
      await pollThreshold(panel, 10);

      await swEval(serviceWorker, (g) => chrome.tabGroups.update(g, { title: 'Work', color: 'blue' }), other);
      // The premise, in the model `tabIdsOfGroup` reads and not only in Chrome: until the panel has heard
      // about the rename the two groups still differ there, and a pass below would prove nothing.
      await expect.poll(() => panel.evaluate(([a, b]) => [a, b].map((id) => {
        const g = window.__vt.state.groups.get(id);
        return g ? `${g.title}/${g.color}` : 'missing';
      }), [work, other]), { message: 'the panel never saw two groups with the same title and colour' })
        .toEqual(['Work/blue', 'Work/blue']);
      await expect(headerOf(panel, other).locator('.group-title'),
        'the second group should now look exactly like the first').toHaveText('Work');

      await entry.open(panel, ids, work);
      await clickMenuItem(panel, entry.item, closeGroupWhy(entry.name));

      await expect(panel.locator(CARD), 'close group took members of the other, identical-looking group')
        .toHaveCount(2, { timeout: 10_000 });
      await expectClosedExactly(serviceWorker, ids, WORK);
    });
}

// A search filter only hides cards (`.tab-card.is-hidden { display: none }`, sidepanel.css:949); the tab
// model is untouched, and `tabIdsOfGroup` reads the model. spec.md:734 says Close group removes "the
// group's tabs", not the visible ones. A close that skipped members whose card is hidden would, with a
// filter typed, close one tab and leave the rest of the group standing.
for (const entry of CLOSE_GROUP_ENTRIES) {
  test(`${entry.name}: close group takes the members HIDDEN by the search filter too`,
    async ({ harness, serviceWorker }) => {
      const { panel } = harness;
      await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
      const { ids, work } = await buildLayout(harness, serviceWorker);
      await pollThreshold(panel, 10);

      // 'alp' matches Alpha's title and URL and nothing else in the layout (05-interactions.spec.js:62 does
      // the same with 'bet'). Alpha rather than Beta, so that the shared entries, which open on alpha's
      // card, still have a card to right-click.
      await panel.locator('#search-input').fill('alp');
      for (const name of ['beta', 'gamma']) {
        await expect(panel.locator(`[data-tab-id="${ids[name]}"]`), `premise: the filter must hide ${name}`)
          .toHaveClass(/is-hidden/, { timeout: 10_000 });
      }
      await expect(panel.locator(`[data-tab-id="${ids.alpha}"]`), 'premise: the filter must leave alpha showing')
        .not.toHaveClass(/is-hidden/);

      await entry.open(panel, ids, work);
      await clickMenuItem(panel, entry.item, closeGroupWhy(entry.name));

      // Hidden cards are still DOM nodes, so delta and epsilon count: five cards less the group's three.
      await expect(panel.locator(CARD), 'close group left behind the members that the filter hid')
        .toHaveCount(2, { timeout: 10_000 });
      await expectClosedExactly(serviceWorker, ids, WORK);
    });
}

/**
 * Records every text the panel's toast shows from now on.
 *
 * `#toast` is emptied after TOAST_MS (2.5 s, constants.js:365): a text assertion made late finds it
 * empty, one made early finds the previous toast, and on a loaded host a poll can fall on either side
 * of the window. The observer sees each text at the moment `toast()` writes it.
 */
const recordToasts = (panel) => panel.evaluate(() => {
  window.__toastTexts = [];
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) window.__toastTexts.push(n.textContent);
  }).observe(document.getElementById('toast'), { childList: true });
});
const toastTexts = (panel) => panel.evaluate(() => window.__toastTexts);

/**
 * Counts the `chrome.tabs.remove` calls the panel makes from now on and the ones Chrome has not answered yet.
 *
 * A close that goes wrong by asking twice shows its second toast only after Chrome has answered the first
 * call, in the same microtask chain as that answer. A test that reads the toasts as soon as the cards are gone
 * can therefore be a few milliseconds early; `removesAnswered` is true only after every call has been answered,
 * and since a poll runs as its own task, the toasts those answers cause are in the list by then.
 */
const watchRemoves = (panel) => panel.evaluate(() => {
  const real = chrome.tabs.remove;
  window.__removesMade = 0;
  window.__removesOpen = 0;
  chrome.tabs.remove = function (...args) {
    window.__removesMade += 1;
    window.__removesOpen += 1;
    const answer = real.apply(chrome.tabs, args);
    Promise.resolve(answer).then(() => { window.__removesOpen -= 1; }, () => { window.__removesOpen -= 1; });
    return answer;
  };
});
const removesAnswered = (panel) => panel.evaluate(() => window.__removesMade > 0 && window.__removesOpen === 0);

// spec-addendum.md:1225-1227 — a bulk close is "filtered, not refused" and "says what it kept". The
// toast is `lockedTabsKept` with the number of locked tabs KEPT (tab-ops.js:353). Every other test locks
// exactly one member, which takes the singular branch (`lockedTabKept`, no number), so nothing above
// reads the number: a toast that printed how many tabs WERE closed passes all of them. Locking two of
// three keeps 2 and closes 1, so the two readings differ. The threshold is 10, so no bar stands between
// the click and the close. The text is English because the harness launches Chromium with locale en-US
// (fixtures.js, launchExtensionContext).
for (const entry of CLOSE_GROUP_ENTRIES) {
  test(`${entry.name}: with TWO locked members, close group keeps both, closes the rest and says how many it kept`,
    async ({ harness, serviceWorker }) => {
      const { panel } = harness;
      await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
      const { ids, work } = await buildLayout(harness, serviceWorker);
      await pollThreshold(panel, 10);

      for (const name of ['beta', 'gamma']) {
        await panel.locator(`[data-tab-id="${ids[name]}"] .thumb`).click({ button: 'right' });
        await clickMenuItem(panel, 'lock', WHY_LOCK);
        await expect(panel.locator(`[data-tab-id="${ids[name]}"]`), `setup: ${name} did not become locked`)
          .toHaveClass(/is-locked/, { timeout: 10_000 });
      }
      await recordToasts(panel);
      await watchRemoves(panel);

      await entry.open(panel, ids, work);
      await clickMenuItem(panel, entry.item, closeGroupWhy(entry.name));

      await expect(panel.locator(CARD), 'alpha should close; the two locked members and the others stay')
        .toHaveCount(4, { timeout: 10_000 });
      await expectClosedExactly(serviceWorker, ids, ['alpha']);
      expect(await toastTexts(panel), 'the toast must say how many locked tabs were kept (two of the three)')
        .toContain('2 locked tabs were kept.');
      // `toContain` is satisfied by a list that has the line in it, so it cannot tell one close from two. Measured on a
      // `closeTabs` that calls `ops.remove` twice: the second `chrome.tabs.remove` of the already closed alpha is refused
      // ("No tab with id"), and the panel shows `lockedTabsKept` a second time, because the locks are partitioned again
      // before Chrome is asked, and then `operationFailed`. The whole list is the claim: one close, one toast.
      await expect.poll(() => removesAnswered(panel), { message: 'Chrome never answered the close' }).toBe(true);
      expect(await toastTexts(panel),
        'the close must show exactly one toast, what it kept; a second remove shows it again, then "Chrome could not complete that action"')
        .toEqual(['2 locked tabs were kept.']);
    });
}

/**
 * Whether the panel believes a confirm bar is waiting for an answer (toast.js:119-122). A hook that is
 * missing says so, instead of failing as a bare TypeError.
 */
const confirmPending = (panel) => panel.evaluate(() => {
  const toastModule = window.__vt.modules.toast;
  if (!toastModule || typeof toastModule.isConfirmOpen !== 'function') {
    throw new Error('window.__vt.modules.toast.isConfirmOpen is not exposed by the panel');
  }
  return toastModule.isConfirmOpen();
});

// What the confirm bar owes whoever pressed a Close group item. Three separate tests, one claim each,
// so that a failure names which part of the contract broke. All go through the header item: `closeTabs`
// is the one call site both items share.

// A17 (spec-addendum.md:745): the bar is "the same component" as the clear-cache confirm, whose focus is
// "moved to" the confirm button, and toast.js:183-188 does that. The Escape tests above cannot see it go
// missing: an Escape that starts outside the bar still cancels it, through keyboard.js:322-327.
test('the confirm bar opens with focus on its OK button',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 3 });
    const { work } = await buildLayout(harness, serviceWorker);
    await pollThreshold(panel, 3);

    await headerOf(panel, work).click({ button: 'right' });
    await clickMenuItem(panel, 'group-close', WHY_HEADER);
    await expect(panel.locator(BAR), 'a bulk close went through without asking').toBeVisible({ timeout: 10_000 });
    await expect(panel.locator('[data-testid="confirm-ok"]'),
      'A17: focus moves onto the confirm button when the bar opens').toBeFocused();
  });

// This test pinned the CSS class `confirm--danger` on the bar until PR #21. The specs are silent on the
// styling (A17 says only "same component"), and on 2026-11-04 the owner approved dropping that one
// assertion (decision 4 of the answers to PR #12's questions). Nothing replaces it; what is left is
// that a bulk close through the header menu raises the bar.
test('a bulk close through the header menu raises the confirm bar',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 3 });
    const { work } = await buildLayout(harness, serviceWorker);
    await pollThreshold(panel, 3);

    await headerOf(panel, work).click({ button: 'right' });
    await clickMenuItem(panel, 'group-close', WHY_HEADER);
    await expect(panel.locator(BAR), 'a bulk close went through without asking').toBeVisible({ timeout: 10_000 });
  });

// An answered bar must leave nothing pending. `isConfirmOpen()` (toast.js:119-122) is what keyboard.js:270
// reads to stop handling list shortcuts and keyboard.js:323 to spend every Escape on cancelling a bar; a
// bar that stays "open" in the toast module after Cancel or Confirm, while it is hidden on screen, leaves
// both stuck until the panel is reloaded. The first read, while the bar is up, is there so that "false"
// below means something: a probe that cannot say "true" would pass any implementation.
test('after Confirm and after Cancel the toast module has no confirm pending',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 3 });
    const { ids, work } = await buildLayout(harness, serviceWorker);
    await pollThreshold(panel, 3);
    const bar = panel.locator(BAR);

    await headerOf(panel, work).click({ button: 'right' });
    await clickMenuItem(panel, 'group-close', WHY_HEADER);
    await expect(bar, 'a bulk close went through without asking').toBeVisible({ timeout: 10_000 });
    expect(await confirmPending(panel), 'premise: isConfirmOpen() must be true while the bar is up').toBe(true);

    await panel.locator('[data-testid="confirm-cancel"]').click();
    await expect(bar).toBeHidden();
    expect(await confirmPending(panel), 'Cancel left a confirm pending in the toast module').toBe(false);
    // Cancel closed nothing, and the group was not closed before it was answered either. Read here, before the
    // next operation: a Cancel that closes the group anyway would otherwise show up only as the right-click below
    // waiting 90 s for a header that is no longer there, with nothing but the timeout to say why. The panel's
    // own resync is ordered after any close that was started, so reading now cannot pass by reading too early.
    await settle(panel);
    expect(await allOpenTabIds(serviceWorker), 'Cancel closed tabs, or the group was closed before the bar was answered')
      .toEqual(expect.arrayContaining(Object.values(ids)));

    await headerOf(panel, work).click({ button: 'right' });
    await clickMenuItem(panel, 'group-close', WHY_HEADER);
    await expect(bar).toBeVisible({ timeout: 10_000 });
    await panel.locator('[data-testid="confirm-ok"]').click();
    await expect(panel.locator(CARD), 'Confirm must close the group').toHaveCount(2, { timeout: 10_000 });
    await expect(bar).toBeHidden();
    expect(await confirmPending(panel), 'Confirm left a confirm pending in the toast module').toBe(false);
  });

// ── v6: the claim a mutant of round 3 still got past ────────────────────────────────────────────────────────

// The bar is not modal (the Escape test with focus on a card shows focus can be anywhere), so a second Close
// group can be asked for while the first bar is still up. toast.js:125-127 says what must follow: `confirmBar`
// "Resolves `true` when the confirm button is pressed, `false` on cancel / Escape / a second call replacing this
// one", and :149-150 settles the first with `false`. Nobody answered the first question, so the first group must
// not close. A supersede that settled the first request with `true` would close it on the strength of a bar that
// is no longer on screen, while the bar that is asks about the other group. No test above has two requests
// pending at once.
//
// Other holds two tabs here (epsilon joins delta): the lowest threshold the settings allow is 2
// (CONFIRM_CLOSE_MIN, settings-schema.js:94), so a group of one never asks. Three against two also makes the
// bar's text say which request it belongs to. Round one cancels and round two confirms, and each round takes
// both entry points, one as the first request and the other as the second, because they reach `closeTabs`
// from different call sites. CLOSE_GROUP_ENTRIES is aimed at Work; this is the same pair aimed at Other.
const CLOSE_OTHER_ENTRIES = [
  { name: 'card menu', open: (panel, ids) => panel.locator(`[data-tab-id="${ids.delta}"] .thumb`).click({ button: 'right' }), item: 'close-group' },
  { name: 'group-header menu', open: (panel, ids, work, other) => headerOf(panel, other).click({ button: 'right' }), item: 'group-close' },
];
const entryNamed = (entries, name) => entries.find((e) => e.name === name);

test('a second Close group while the bar is up replaces it: the first group is not closed, whichever answer follows',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 2 });
    const { ids, work, other } = await buildLayout(harness, serviceWorker);
    await pollThreshold(panel, 2);

    // epsilon joins Other. Asked of Chrome first and then of the panel. When the header menu opens it reads the
    // panel's model only for whether its items are enabled (context-menu.js:268); which tabs "Close group" takes
    // it reads from the model at the click (:281). The wait below is what lets that read see a group of two.
    await swEval(serviceWorker, (a) => chrome.tabs.group({ tabIds: [a.epsilon], groupId: a.other }),
      { epsilon: ids.epsilon, other });
    const placed = await swEval(serviceWorker, async (wid) => Object.fromEntries(
      (await chrome.tabs.query({ windowId: wid })).map((t) => [t.id, t.groupId])), harness.w2);
    expect(placed, 'setup did not put epsilon into the second group').toEqual({
      [ids.alpha]: work, [ids.beta]: work, [ids.gamma]: work, [ids.delta]: other, [ids.epsilon]: other,
    });
    await expect.poll(() => panel.evaluate(([a, b]) => [a, b].map((g) =>
      [...window.__vt.state.tabs.values()].filter((t) => t.groupId === g).length), [work, other]),
    { message: 'the panel never saw epsilon join the second group' }).toEqual([3, 2]);

    const bar = panel.locator(BAR);
    const barText = panel.locator('[data-testid="confirm-text"]');
    const rounds = [
      { first: entryNamed(CLOSE_GROUP_ENTRIES, 'group-header menu'), second: entryNamed(CLOSE_OTHER_ENTRIES, 'card menu'), answer: 'cancel' },
      { first: entryNamed(CLOSE_GROUP_ENTRIES, 'card menu'), second: entryNamed(CLOSE_OTHER_ENTRIES, 'group-header menu'), answer: 'confirm' },
    ];
    for (const { first, second, answer } of rounds) {
      const round = `${first.name} first, then ${second.name}, then ${answer}`;
      expect(await confirmPending(panel), `${round}: premise: nothing may be pending before the first request`).toBe(false);

      await first.open(panel, ids, work, other);
      await clickMenuItem(panel, first.item, closeGroupWhy(first.name));
      await expect(bar, `${round}: a group of three at a threshold of two should ask`).toBeVisible({ timeout: 10_000 });
      await expect(barText, `${round}: the first bar must name the first group's three tabs`).toContainText(/\b3\b/);

      await second.open(panel, ids, work, other);
      // Opening a menu must not itself have answered the bar, or what follows would not be a supersede at all.
      expect(await confirmPending(panel), `${round}: premise: the first bar must still be waiting when the second request is made`)
        .toBe(true);
      await clickMenuItem(panel, second.item, closeGroupWhy(second.name));

      await expect(barText, `${round}: the bar must now ask about the second group (two tabs)`).toContainText(/\b2\b/);
      await expect(barText, `${round}: the bar still names the first group (three tabs)`).not.toContainText(/\b3\b/);
      await settle(panel);
      expect(await allOpenTabIds(serviceWorker),
        `${round}: replacing the bar still closed the first group, which nobody had confirmed`)
        .toEqual(expect.arrayContaining(Object.values(ids)));

      if (answer === 'cancel') {
        await panel.locator('[data-testid="confirm-cancel"]').click();
        await expect(bar).toBeHidden();
        await settle(panel);
        expect(await allOpenTabIds(serviceWorker), `${round}: Cancel on the second bar closed tabs`)
          .toEqual(expect.arrayContaining(Object.values(ids)));
      } else {
        await panel.locator('[data-testid="confirm-ok"]').click();
        await expect(panel.locator(CARD), `${round}: Confirm should close the second group and nothing else`)
          .toHaveCount(3, { timeout: 10_000 });
        await expectClosedExactly(serviceWorker, ids, ['delta', 'epsilon']);
        await expect(bar, `${round}: the bar is still on screen after Confirm`).toBeHidden();
      }
    }
  });

// ── v7: the owner's decisions of 2026-11-04 on PR #12's questions (spec-addendum A38) ───────────────────────
// Measured first by probe 96 (probe-results.md, Probe 14), on the extension as it was: the header's items took
// their ids when the menu OPENED, so a member that had left the group was still closed (or ungrouped out of its
// NEW group) and a tab that had joined was missed. The card's Close group already took them at the click.

const thumbOf = (panel, id) => panel.locator(`[data-tab-id="${id}"] .thumb`);
const CARD_ENTRY = entryNamed(CLOSE_GROUP_ENTRIES, 'card menu');
const HEADER_ENTRY = entryNamed(CLOSE_GROUP_ENTRIES, 'group-header menu');
const WHY_UNGROUP = '"Ungroup" must be offered and enabled in the group-header menu';

/** What happens to the group while its menu is open. `tab` gets the group `to` (-1 = loose). */
async function changeMembership(panel, serviceWorker, { ids, work, other }, change) {
  const tab = change === 'join' ? 'epsilon' : 'beta';
  const to = change === 'leave' ? -1 : change === 'join' ? work : other;
  await swEval(serviceWorker, async (a) => {
    if (a.to === -1) await chrome.tabs.ungroup([a.id]);
    else await chrome.tabs.group({ tabIds: [a.id], groupId: a.to });
  }, { id: ids[tab], to });
  // The change has to be in the PANEL'S model before the click. Otherwise even an item that takes its ids at the
  // click would see the old group, and a green result would say nothing.
  await expect.poll(() => panel.evaluate((id) => window.__vt.state.tabs.get(id).groupId, ids[tab]),
    { message: `the panel's model never showed ${tab} in group ${to}` }).toBe(to);
}

/**
 * Opens `entry`'s menu, changes the group's membership, and clicks `entry.item`. Nothing is closed by a bar.
 * `beforeClick(panel)`, when given, runs after the change has reached the panel and right before the click.
 */
async function openChangeClick({ harness, serviceWorker }, entry, change, why, { beforeClick } = {}) {
  const { panel } = harness;
  await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
  const built = await buildLayout(harness, serviceWorker);
  await pollThreshold(panel, 10);
  await entry.open(panel, built.ids, built.work);
  await expect(panel.locator(MENU), 'the menu did not open').toBeVisible();
  await changeMembership(panel, serviceWorker, built, change);
  await expect(panel.locator(MENU), 'the menu closed when the group changed, so the click below would measure nothing')
    .toBeVisible();
  if (beforeClick) await beforeClick(panel);
  await clickMenuItem(panel, entry.item, why);
  return built;
}

// Close group takes the group's members as they are when the item is clicked, from either entry. Three changes,
// each of which a stale list gets wrong in a different way: a member that left is closed anyway (leave), a tab that
// joined is missed (join), and a member that moved to ANOTHER group is closed out of it (move; beta and delta
// both survive). `cards` is what the panel still draws, used as the point to read Chrome from.
const AFTER_CHANGE = {
  leave: { closed: ['alpha', 'gamma'], cards: 3, say: 'a member that LEFT the group while the menu was open stays open' },
  join: { closed: ['alpha', 'beta', 'gamma', 'epsilon'], cards: 1, say: 'a tab that JOINED the group while the menu was open is closed with it' },
  move: { closed: ['alpha', 'gamma'], cards: 3, say: 'a member that MOVED to another group while the menu was open stays open' },
};
for (const entry of [CARD_ENTRY, HEADER_ENTRY]) {
  for (const [change, want] of Object.entries(AFTER_CHANGE)) {
    test(`${entry.name}: Close group takes the group as it is at the click: ${want.say}`,
      async ({ harness, serviceWorker }) => {
        const { panel } = harness;
        const { ids } = await openChangeClick({ harness, serviceWorker }, entry, change, closeGroupWhy(entry.name));
        await expect(panel.locator(CARD),
          `${entry.name}: what was closed is not the group as it was when the item was clicked`)
          .toHaveCount(want.cards, { timeout: 10_000 });
        await expectClosedExactly(serviceWorker, ids, want.closed);
      });
  }
}

// Ungroup on the header uses the same ids, and a stale list does more damage there: a member that moved to another
// group would be pulled out of it. After the click every current member of the group is loose and nothing else has
// changed group; nothing is closed.
//
// The state Chrome ends in cannot tell a stale list from a fresh one when a member LEFT: ungrouping a tab that is
// already loose changes nothing, and Probe 14 measured that case PASS 3 of 3 on the extension before this PR
// (probe-results.md, header `group-ungroup`, `leave-loose`). So each test also records the ids that reach
// `chrome.tabs.ungroup` and requires one call carrying exactly the group's members at the click. `ops.ungroup` looks
// `chrome.tabs.ungroup` up when it calls (tab-ops.js:394-396), so the recording sees what reaches Chrome.
const groupIdsOf = (sw, ids) => swEval(sw, async (a) => {
  const out = {};
  for (const [name, id] of Object.entries(a)) out[name] = (await chrome.tabs.get(id)).groupId;
  return out;
}, ids);

/**
 * Records, from now on, every call the panel makes to `chrome.tabs.<name>` for each of `names`: the function name and
 * its ids, sorted, so the order the panel happened to list them in does not matter. Read with `tabsCalls`.
 */
const recordTabsCalls = (panel, names) => panel.evaluate((list) => {
  window.__tabsCalls = [];
  for (const name of list) {
    const real = chrome.tabs[name];
    chrome.tabs[name] = function (...args) {
      window.__tabsCalls.push({ name, ids: [].concat(args[0]).sort((a, b) => a - b) });
      return real.apply(chrome.tabs, args);
    };
  }
}, names);
const tabsCalls = (panel) => panel.evaluate(() => window.__tabsCalls);
const sortedIds = (ids, names) => names.map((n) => ids[n]).sort((a, b) => a - b);

// `members` = the tabs the group has at the click, which is what Ungroup has to ask Chrome to ungroup.
const AFTER_UNGROUP = {
  leave: { inOther: ['delta'], members: ['alpha', 'gamma'], say: 'a member that LEFT the group meanwhile stays loose' },
  join: { inOther: ['delta'], members: ['alpha', 'beta', 'gamma', 'epsilon'], say: 'a tab that JOINED the group meanwhile is ungrouped with it' },
  move: { inOther: ['beta', 'delta'], members: ['alpha', 'gamma'], say: 'a member that MOVED to another group meanwhile stays in that group' },
};
for (const [change, want] of Object.entries(AFTER_UNGROUP)) {
  test(`group-header menu: Ungroup takes the group as it is at the click: ${want.say}`,
    async ({ harness, serviceWorker }) => {
      const { panel } = harness;
      const ungroup = { ...HEADER_ENTRY, item: 'group-ungroup' };
      const { ids, other } = await openChangeClick({ harness, serviceWorker }, ungroup, change, WHY_UNGROUP,
        { beforeClick: (p) => recordTabsCalls(p, ['ungroup']) });
      const expected = Object.fromEntries(Object.keys(ids).map((n) => [n, want.inOther.includes(n) ? other : -1]));
      await expect.poll(() => groupIdsOf(serviceWorker, ids),
        { message: `Ungroup did not leave exactly ${want.inOther.join(' and ')} in the second group` })
        .toEqual(expected);
      await expectClosedExactly(serviceWorker, ids, []);
      // Read after the state above has changed, which cannot happen before the click's call was made.
      expect(await tabsCalls(panel),
        `Ungroup must make one chrome.tabs.ungroup call, with the group's members at the click: ${want.members.join(', ')}`)
        .toEqual([{ name: 'ungroup', ids: sortedIds(ids, want.members) }]);
    });
}

// The group is emptied while its header menu is open: Other has one member, delta, and it leaves. Both items were
// OFFERED when the menu opened (`hasTabs`, context-menu.js:268), so both can still be clicked, and the group has no
// members at the click. `ungroupGroup` and `closeTabs` then return before they call anything (context-menu.js:535,
// :515). Nothing is ungrouped or closed, no bar is raised and nothing is toasted. "Nothing happened" only means
// something if the click landed: the menu hides itself in its click handler (context-menu.js:657) before it runs the
// item, so a hidden menu is the sign that the handler ran. On the extension before this PR the header held [delta]
// from the moment the menu opened and acted on it.
for (const item of [
  { id: 'group-ungroup', name: 'Ungroup', why: WHY_UNGROUP },
  { id: 'group-close', name: 'Close group', why: WHY_HEADER },
]) {
  test(`group-header menu: ${item.name} on a group that is EMPTY at the click does nothing`,
    async ({ harness, serviceWorker }) => {
      const { panel } = harness;
      await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
      const { ids, work, other } = await buildLayout(harness, serviceWorker);
      await pollThreshold(panel, 10);
      const afterEmptied = { alpha: work, beta: work, gamma: work, delta: -1, epsilon: -1 };

      await headerOf(panel, other).click({ button: 'right' });
      await expect(panel.locator(MENU), 'the menu did not open').toBeVisible();
      await swEval(serviceWorker, (id) => chrome.tabs.ungroup([id]), ids.delta);
      expect(await groupIdsOf(serviceWorker, ids), 'setup: Chrome did not empty the second group').toEqual(afterEmptied);
      // In the PANEL'S model before the click, or the click below would still find the group as it was.
      await expect.poll(() => panel.evaluate((id) => window.__vt.state.tabs.get(id).groupId, ids.delta),
        { message: "the panel's model never showed delta loose" }).toBe(-1);
      await expect(panel.locator(MENU), 'the menu closed when the group was emptied, so the click below would measure nothing')
        .toBeVisible();
      await recordTabsCalls(panel, ['ungroup', 'remove']);
      await recordToasts(panel);

      await clickMenuItem(panel, item.id, item.why);
      await expect(panel.locator(MENU), 'the click did not reach the item: the menu is still open').toBeHidden();
      await settle(panel);

      expect(await tabsCalls(panel), `${item.name} on an emptied group must not call chrome.tabs.ungroup or chrome.tabs.remove`)
        .toEqual([]);
      expect(await toastTexts(panel), `${item.name} on an emptied group must not show a toast, an error least of all`)
        .toEqual([]);
      await expect(panel.locator(BAR), `${item.name} on an emptied group must not raise the confirm bar`).toBeHidden();
      await expectClosedExactly(serviceWorker, ids, []);
      expect(await groupIdsOf(serviceWorker, ids), `${item.name} on an emptied group must change no tab's group`)
        .toEqual(afterEmptied);
    });
}

// A card that is part of a multi-selection closes its GROUP from "Close group" (answer to PR #12's question 3). Not
// every item of the card menu reads the selection (A38 lists which do, taken from `openForTab`): `close` does, and its
// label says so ("Close N tabs", context-menu.js:222-226), while `close-group` reads the group (:247). The label is
// read first, so the selection is known to be in force when Close group is clicked. Selected tabs outside the group
// stay open, and a group member that is not selected closes. The selection is made the way a user makes it, with
// Ctrl+click; alpha is the window's active tab and is in it from the start.
const selectedNames = (panel, ids) => panel.evaluate((byName) => {
  const nameOf = Object.fromEntries(Object.entries(byName).map(([n, id]) => [id, n]));
  return [...window.__vt.state.highlighted].map((id) => nameOf[id] || `#${id}`).sort();
}, ids);
async function selectWithCtrl(panel, ids, names, expected) {
  for (const n of names) await thumbOf(panel, ids[n]).click({ modifiers: ['Control'] });
  await expect.poll(() => selectedNames(panel, ids), { message: 'the selection never reached the panel model' })
    .toEqual([...expected].sort());
}

test('a card inside a multi-selection: Close group closes the GROUP, not the selection that reaches outside it',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 10 });
    const { ids } = await buildLayout(harness, serviceWorker);
    await pollThreshold(panel, 10);

    await selectWithCtrl(panel, ids, ['beta', 'delta', 'epsilon'], ['alpha', 'beta', 'delta', 'epsilon']);
    await thumbOf(panel, ids.beta).click({ button: 'right' });
    await expect(panel.locator(`${MENU} [data-testid="menu-item-close"]`),
      'premise: the menu must be the one of a four-tab selection')
      .toHaveText('Close 4 tabs');
    await clickMenuItem(panel, 'close-group', WHY_CARD);

    await expect(panel.locator(CARD), 'Close group must close the three members of Work and nothing else')
      .toHaveCount(2, { timeout: 10_000 });
    await expectClosedExactly(serviceWorker, ids, WORK);
  });

test('a card inside a multi-selection that sits INSIDE the group: Close group still closes the unselected member, and the bar counts the group',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    // Three members against a threshold of three, and a selection of two: a close of the selection would not
    // ask at all, and a close of the group asks about three.
    await setSettings(serviceWorker, { confirmCloseThreshold: 3 });
    const { ids } = await buildLayout(harness, serviceWorker);
    await pollThreshold(panel, 3);

    await selectWithCtrl(panel, ids, ['beta'], ['alpha', 'beta']);
    await thumbOf(panel, ids.beta).click({ button: 'right' });
    await expect(panel.locator(`${MENU} [data-testid="menu-item-close"]`),
      'premise: the menu must be the one of a two-tab selection')
      .toHaveText('Close 2 tabs');
    await clickMenuItem(panel, 'close-group', WHY_CARD);

    await expect(panel.locator(BAR), 'a close of the group (three tabs, threshold three) must ask')
      .toBeVisible({ timeout: 10_000 });
    await expect(panel.locator('[data-testid="confirm-text"]'),
      'the bar must name the group (three), not the selection (two)').toHaveText('Close 3 tabs?');
    await panel.locator('[data-testid="confirm-ok"]').click();

    await expect(panel.locator(CARD), 'Confirm must close all three members, selected or not')
      .toHaveCount(2, { timeout: 10_000 });
    await expectClosedExactly(serviceWorker, ids, WORK);
  });

// The bar's threshold counts the tabs the user ASKED to close, a locked one included (spec.md §9.8, A38). The
// lock test above (threshold 2) cannot tell this from "the tabs that would close": at 2, both readings ask. Here
// the threshold is 3 and one of the three members is locked, so only the first reading raises the bar, and the
// number it names is the three that were asked for. Confirm then closes the two that are not locked.
test('the confirm bar counts the tabs ASKED to close, a locked one included',
  async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    await setSettings(serviceWorker, { confirmCloseThreshold: 3 });
    const { ids, work } = await buildLayout(harness, serviceWorker);
    await pollThreshold(panel, 3);

    await thumbOf(panel, ids.beta).click({ button: 'right' });
    await clickMenuItem(panel, 'lock', WHY_LOCK);
    await expect(panel.locator(`[data-tab-id="${ids.beta}"]`), 'setup: beta did not become locked')
      .toHaveClass(/is-locked/, { timeout: 10_000 });

    await headerOf(panel, work).click({ button: 'right' });
    await clickMenuItem(panel, 'group-close', WHY_HEADER);
    await expect(panel.locator(BAR), 'three were asked for at a threshold of three; the lock must not make the bar vanish')
      .toBeVisible({ timeout: 10_000 });
    await expect(panel.locator('[data-testid="confirm-text"]'),
      'the bar must name the three that were asked for, not the two that would close')
      .toHaveText('Close 3 tabs?');
    await panel.locator('[data-testid="confirm-ok"]').click();

    await expect(panel.locator(CARD), 'alpha and gamma should close, the locked beta should stay')
      .toHaveCount(3, { timeout: 10_000 });
    await expectClosedExactly(serviceWorker, ids, ['alpha', 'gamma']);
  });
