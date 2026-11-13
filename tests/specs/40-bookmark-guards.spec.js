// 40-bookmark-guards — the two requirements that outrank every feature, checked with the
// bookmark preview IN USE:
//
//   1. the tab list sits on the right, beside the column  -> the boxes of #main-row,
//      #tablist and #bookmark-rail are the same to the pixel before, during and after a
//      preview, at the two panel widths the product is designed around (360 and 460);
//   2. every tab card shows its preview image            -> with a preview up, and after
//      hovering every kind of bookmark there is, every card of a four-tab window is still
//      `thumb--loaded` with a decoded blob: image.
//
// These live apart from 39-bookmark-preview on purpose: when one of them goes red it is a
// regression in the product's reason for existing, not in a feature, and the file name
// should say so.
//
// Not covered here, because it cannot be from inside a page: WHICH SIDE of the window
// Chrome puts the panel on is Chrome's own setting (`sidePanel.getLayout()`), untouched by
// this feature; spec 01 and the side-position hint tests cover the wiring, and the PR's
// `git diff --stat` shows none of it was edited.
'use strict';

const { expect } = require('../fixtures');
const {
  setSettings, keyOf, waitForThumb, activateTab, createTab,
} = require('../helpers/chrome');
const { granted } = require('../helpers/bookmarks');
const P = require('../helpers/bookmark-preview');

granted('with the preview in use every tab card still shows its preview, and the bytes agree', async ({
  harness, serviceWorker, fixtures,
}) => {
  granted.setTimeout(480_000);
  const { panel, w2, tabIds, urls } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });
  // The exclusion goes in FIRST, before there is anything stored to purge. A purge that deletes
  // something makes the service worker broadcast `vt/thumbs-cleared`, which makes every open
  // panel drop ALL its blobs and show every card empty until it is captured again (see
  // `thumbs.clear()`); doing it after the four captures would measure that, not the preview.
  await setSettings(serviceWorker, { refreshInterval: 'off', excludedHosts: ['secret.example.org'] });

  // A four-tab window, each tab really captured by the service worker's own pipeline.
  const deltaId = await createTab(serviceWorker, w2, fixtures.delta, { active: false });
  const tabs = [
    { name: 'alpha', id: tabIds.alpha, url: urls.alpha },
    { name: 'beta', id: tabIds.beta, url: urls.beta },
    { name: 'gamma', id: tabIds.gamma, url: urls.gamma },
    { name: 'delta', id: deltaId, url: fixtures.delta },
  ];
  for (const tab of tabs) {
    await activateTab(serviceWorker, tab.id);
    await waitForThumb(panel, await keyOf(panel, tab.url), { timeout: 60_000 });
  }
  await expect(panel.locator('#tablist [data-testid="tab-card"]')).toHaveCount(4);

  /** Every card of the window, and for any that is not showing a decoded screenshot, why. */
  const cardsOk = async () => {
    const verdicts = await P.cardVerdicts(panel);
    return {
      cards: Object.keys(verdicts).length,
      notOk: Object.entries(verdicts).filter(([, v]) => v !== 'ok'),
    };
  };
  await expect.poll(cardsOk, { timeout: 30_000, message: 'before anything is hovered' })
    .toEqual({ cards: 4, notOk: [] });

  // A stored screenshot for a page open in no tab; and one for the excluded host, written
  // long after the exclusion's purge (the four captures above take tens of seconds), so the
  // verdict has a record to outrank.
  await P.putFakeThumb(panel, 'https://seeded.example.com/article?id=7');
  await P.putFakeThumb(panel, 'https://secret.example.org/p');
  await P.openColumn(harness, serviceWorker, [
    { title: 'Alpha bookmark', url: urls.alpha },
    { title: 'Beta bookmark', url: urls.beta },
    { title: 'Seeded, not open', url: 'https://seeded.example.com/article?id=7' },
    { title: 'Never seen', url: 'https://nowhere.example.com/x' },
    { title: 'Secret', url: 'https://secret.example.org/p' },
    { title: 'Settings page', url: 'chrome://settings/' },
  ]);
  await P.installMonitor(panel);

  const requests = [];
  const onRequest = (req) => {
    if (/^https?:/i.test(req.url())) requests.push(req.url());
  };
  panel.on('request', onRequest);

  const cacheBefore = await P.cacheSize(panel);
  const byTabBefore = await panel.evaluate(() => window.__vt.debugState().byTab);
  expect(Object.keys(byTabBefore), 'the panel knows which key each of the four cards shows').toHaveLength(4);

  const expectations = [
    ['Alpha bookmark', 'loaded', tabs[0]],
    ['Beta bookmark', 'loaded', tabs[1]],
    ['Seeded, not open', 'loaded', null],
    ['Never seen', 'none', null],
    ['Secret', 'excluded', null],
    ['Settings page', 'restricted', null],
  ];
  for (const [title, state, tab] of expectations) {
    await P.moveAway(panel);
    expect(await P.hoverAndWait(panel, title), `${title}: the card's state`).toBe(state);

    // The card is up RIGHT NOW. Requirement 2 holds while it is.
    expect(await cardsOk(), `${title}: every card still shows its preview while the card is up`)
      .toEqual({ cards: 4, notOk: [] });

    if (tab) {
      // The same image as that tab's card, byte for byte.
      await expect.poll(
        () => panel.locator(`${P.PEEK} ${P.PEEK_IMG}`).evaluate((el) => el.complete && el.naturalWidth),
        { timeout: 15_000 },
      ).toBe(640);
      const peekHash = await P.sha256OfImg(panel, `${P.PEEK} ${P.PEEK_IMG}`);
      const cardHash = await P.sha256OfImg(panel, `${P.CARD(tab.id)} .thumb__img`);
      expect(peekHash, `${title}: SHA-256 of the preview`).toMatch(/^[0-9a-f]{64}$/);
      expect(peekHash, `${title}: the same bytes as the ${tab.name} tab card`).toBe(cardHash);
    }
  }
  await P.moveAway(panel);

  panel.off('request', onRequest);
  expect(requests, `nothing was fetched: ${requests.join(', ')}`).toEqual([]);

  // And once it is all over: nothing about the tab cards moved.
  expect(await cardsOk(), 'after the last card is gone').toEqual({ cards: 4, notOk: [] });
  expect(await P.cacheSize(panel), 'the panel\'s blob cache is exactly as it was').toBe(cacheBefore);
  expect(await panel.evaluate(() => window.__vt.debugState().byTab),
    'and so is its record of which key each card shows').toEqual(byTabBefore);

  const mon = await P.readMonitor(panel);
  expect(mon.sends.filter((type) => type === 'vt/capture-request'), 'no capture was asked for')
    .toEqual([]);
  expect(mon.writes, 'no bookmark was written').toEqual([]);
  await expect.poll(async () => P.previewUrls(await P.readMonitor(panel)).live, { timeout: 5_000 })
    .toBe(0);
});

granted('opening a preview moves nothing: #main-row, #tablist and #bookmark-rail keep their boxes at 360 and 460', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const links = Array.from({ length: 14 }, (_, i) => ({
    title: `Link ${String(i).padStart(2, '0')}`, url: `https://many.example.com/${i}`,
  }));
  await P.openColumn(harness, serviceWorker, links, { width: 360, height: 800 });

  for (const width of [360, 460]) {
    await panel.setViewportSize({ width, height: 800 });
    await P.settleFrames(panel);
    await P.moveAway(panel);
    await panel.evaluate(() => { document.getElementById('bookmark-rail').scrollTop = 0; });
    await P.settleFrames(panel);

    const before = await P.layoutBoxes(panel);
    // Sanity: the boxes are the real ones, the rail beside the list at this width.
    expect(before.mainRow.width, `${width}: the row spans the panel`).toBeGreaterThan(width - 40);
    expect(before.tablist.width, `${width}: the tab list has room`).toBeGreaterThan(100);
    expect(before.rail.width, `${width}: the column has room`).toBeGreaterThan(100);
    expect(before.overflowsSideways, `${width}: nothing scrolls sideways`).toBe(false);

    expect(await P.hoverAndWait(panel, 'Link 02')).toBe('none');
    await P.settleFrames(panel);
    const during = await P.layoutBoxes(panel);
    expect(during, `${width}: with a preview showing, every box is the same to the pixel`).toEqual(before);

    // The card is a bystander: not inside the row that holds the list and the column.
    expect(await panel.evaluate((sel) => document.getElementById('main-row')
      .contains(document.querySelector(sel)), P.PEEK), `${width}: the card is outside #main-row`)
      .toBe(false);

    await P.moveAway(panel);
    await P.settleFrames(panel);
    expect(await P.layoutBoxes(panel), `${width}: and after it goes`).toEqual(before);
  }
});

/* ══ The same two requirements with PR2 IN USE (bookmark folders, criteria B10) ════════════════════
   Appended with the editing feature (create, rename, drag, menu, Alt+Arrow); nothing above this line
   was changed. The three guards below drive the real flows through the real column (the panel opened
   as a tab, the synthesised grant; a real side panel is not exercised):

     B10.1  #main-row, #tablist and #bookmark-rail keep their boxes, to the pixel, at 360 and 460,
            before / during / after (a) a drag with the drop line (and with a folder outlined) showing,
            (b) the row menu and its "Move to…" list open, (c) the new-folder field and the rename
            field open, closed by Escape and by Enter;
     B10.2  a four-tab window: every card is `thumb--loaded` with a decoded blob: image during and
            after a drag, a rename, a new folder and a menu, and the panel's blob cache and its
            record of which key each card shows are exactly what they were;
     B10.3  across every flow (create; rename ended by Enter and by Escape; a drag inside a folder and
            into another; the menu's Move up / Move down / Move to…; Alt+ArrowUp / Alt+ArrowDown): no
            http(s) request from the panel, no `vt/capture-request` message, no uncaught error.

   Every test starts by asserting that PR2's controls are there (`draggable`, the new-folder button), so
   that on a tree without the feature it fails by an ASSERTION on the first line that matters.
   NOT here: B10.4 (the side-panel wiring files are untouched) is a `git diff --stat`, not a test. */

const E = require('../helpers/bookmark-edit');
const BM = require('../helpers/bookmarks');

const NEW_FOLDER = '[data-testid="bookmark-new-folder"]';
const EDIT_ROW = '[data-testid="bookmark-edit-row"]';
const FIELD = '[data-testid="bookmark-rename-input"]';

/** The panel's uncaught errors, collected from now on. */
function pageErrors(panel) {
  const errors = [];
  panel.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
  return errors;
}

/** The first permanent folder, which `seedBookmarks` puts everything under. By position: roots are named in the browser's language. */
const barRow = (panel) => panel.locator('[data-testid="bookmark-row"][data-depth="0"]').first();

const link = (title) => ({ title, url: `https://${title.toLowerCase().replace(/[^a-z0-9]/g, '')}.example.com/` });

/** Two folders of links and one loose link under the bar; titles are unique (the ids are keyed by title). */
const GUARD_TREE = [
  { title: 'Group A', children: ['Link A1', 'Link A2', 'Link A3', 'Link A4'].map(link) },
  { title: 'Group B', children: ['Link B1', 'Link B2'].map(link) },
  link('Link Loose'),
];
const A_TITLES = ['Link A1', 'Link A2', 'Link A3', 'Link A4'];

/** What Chrome says is in a folder, as titles, in order. */
const titlesIn = async (sw, id) => (await E.childrenOf(sw, id)).map((n) => n.title);

/** Wait until the column has stopped repainting: nothing in the rail has changed for `ms` (needs installRepaintSpy). */
const quiet = (panel, ms = 900) => panel.waitForFunction((wait) => {
  const spy = window.__bmRepaint;
  if (!spy) throw new Error('quiet: installRepaintSpy was not called on this page');
  spy.flush();
  const last = spy.records.length ? spy.records[spy.records.length - 1].t : 0;
  return performance.now() - last >= wait;
}, ms, { timeout: 30_000, polling: 100 });

/**
 * Seed GUARD_TREE under the bar, switch the column on, open the bar, Group A and then Group B (so the
 * header buttons write into Group B), install the write and repaint spies. Returns the id of every node by title.
 */
async function openGuardTree(harness, serviceWorker, viewport) {
  const { panel } = harness;
  await panel.setViewportSize(viewport);
  const { barId } = await BM.seedBookmarks(serviceWorker, []);
  const { ids } = await E.seedTree(serviceWorker, barId, GUARD_TREE);
  await BM.showBookmarks(panel, serviceWorker);
  await expect(barRow(panel)).toBeVisible({ timeout: 15_000 });
  for (const row of [barRow(panel), E.rowTitled(panel, 'Group A'), E.rowTitled(panel, 'Group B')]) {
    await expect(row).toBeVisible({ timeout: 15_000 });
    if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
    await expect(row).toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 });
  }
  await expect(E.rowTitled(panel, 'Link B2')).toBeVisible({ timeout: 15_000 });
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);
  return { barId, ids };
}

/** PR2 is there: the rows can be dragged and the header has its new-folder button. Fails by assertion without it. */
async function expectPr2Controls(panel, what) {
  await expect(E.rowTitled(panel, 'Link A1'), `${what}: a link row can be dragged (PR2)`)
    .toHaveAttribute('draggable', 'true', { timeout: 10_000 });
  await expect(panel.locator(NEW_FOLDER), `${what}: the header has its new-folder button (PR2)`)
    .toBeVisible({ timeout: 10_000 });
}

/**
 * A four-tab window, each tab really captured by the service worker's own pipeline (as the first test of
 * this file does it), at 460 wide. Returns `cardsOk()`: every card of the window, and for any that is not
 * showing a decoded screenshot, why.
 */
async function captureFourTabs(harness, serviceWorker, fixtures) {
  const { panel, w2, tabIds, urls } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });
  await setSettings(serviceWorker, { refreshInterval: 'off' });
  const deltaId = await createTab(serviceWorker, w2, fixtures.delta, { active: false });
  const tabs = [
    { id: tabIds.alpha, url: urls.alpha },
    { id: tabIds.beta, url: urls.beta },
    { id: tabIds.gamma, url: urls.gamma },
    { id: deltaId, url: fixtures.delta },
  ];
  for (const tab of tabs) {
    await activateTab(serviceWorker, tab.id);
    await waitForThumb(panel, await keyOf(panel, tab.url), { timeout: 60_000 });
  }
  await expect(panel.locator('#tablist [data-testid="tab-card"]')).toHaveCount(4);
  const cardsOk = async () => {
    const verdicts = await P.cardVerdicts(panel);
    return {
      cards: Object.keys(verdicts).length,
      notOk: Object.entries(verdicts).filter(([, v]) => v !== 'ok'),
    };
  };
  await expect.poll(cardsOk, { timeout: 30_000, message: 'four captured cards before anything is done' })
    .toEqual({ cards: 4, notOk: [] });
  return { cardsOk };
}

/** Right-click the row titled `title` and wait for the menu. */
async function rightClickRow(panel, title) {
  await E.rowTitled(panel, title).click({ button: 'right' });
  await expect(panel.locator(E.MENU), `the menu of ${title} is up`).toBeVisible({ timeout: 10_000 });
}

/** Wait for the column to draw `titles` as the children of folder `id`. */
const columnShows = (panel, id, titles, what) => expect.poll(() => E.domChildren(panel, id), {
  timeout: 15_000, message: what,
}).toEqual(titles);

/* ── B10.1: the boxes, at 360 and 460, before / during / after ───────────────── */

granted('PR2 in use: #main-row, #tablist and #bookmark-rail keep their boxes at 360 and 460 during a drag, a menu and an edit row', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(480_000);
  const { panel } = harness;
  const errors = pageErrors(panel);
  const { ids } = await openGuardTree(harness, serviceWorker, { width: 360, height: 800 });
  await expectPr2Controls(panel, 'B10.1');
  const aIds = A_TITLES.map((t) => ids[t]);
  const field = panel.locator(FIELD);

  for (const width of [360, 460]) {
    await panel.setViewportSize({ width, height: 800 });
    await P.settleFrames(panel);
    await P.moveAway(panel);
    await panel.evaluate(() => { document.getElementById('bookmark-rail').scrollTop = 0; });
    await P.settleFrames(panel);
    await quiet(panel);

    const before = await P.layoutBoxes(panel);
    // Sanity: the boxes are the real ones, the rail beside the list at this width.
    expect(before.mainRow.width, `${width}: the row spans the panel`).toBeGreaterThan(width - 40);
    expect(before.tablist.width, `${width}: the tab list has room`).toBeGreaterThan(100);
    expect(before.rail.width, `${width}: the column has room`).toBeGreaterThan(100);
    expect(before.overflowsSideways, `${width}: nothing scrolls sideways`).toBe(false);
    const same = async (what) => {
      await P.settleFrames(panel);
      expect(await P.layoutBoxes(panel), `${width}: ${what}: every box is the same to the pixel`).toEqual(before);
    };

    // (a1) A drag with the drop LINE showing, held with the button down, then dropped (a real move).
    const line = await E.dragRow(panel, 'Link A3', 'Link A1', 'top', { drop: false });
    expect(line.started && line.reached, `${width}: the drag started and the column handled it`).toBe(true);
    expect((await E.railFeedback(panel)).line, `${width}: the drop line is showing`).not.toBeNull();
    await same('during a drag, with the drop line showing');
    expect((await E.releaseDrag(panel)).dropped, `${width}: the drop reached the column`).toBe(true);
    await expect.poll(() => titlesIn(serviceWorker, ids['Group A']), {
      timeout: 15_000, message: `${width}: the drop moved Link A3 first`,
    }).toEqual(['Link A3', 'Link A1', 'Link A2', 'Link A4']);
    await columnShows(panel, ids['Group A'], ['Link A3', 'Link A1', 'Link A2', 'Link A4'], `${width}: the column shows it`);
    await quiet(panel);
    await same('after the drop');

    // (a2) A drag with a FOLDER outlined (inside), held, then dropped.
    const into = await E.dragRow(panel, 'Link A4', 'Group B', 'middle', { drop: false });
    expect(into.started && into.reached, `${width}: the second drag started and the column handled it`).toBe(true);
    expect((await E.railFeedback(panel)).into, `${width}: Group B is outlined`).toEqual(['Group B']);
    await same('during a drag, with a folder outlined');
    expect((await E.releaseDrag(panel)).dropped, `${width}: the second drop reached the column`).toBe(true);
    await expect.poll(() => titlesIn(serviceWorker, ids['Group B']), {
      timeout: 15_000, message: `${width}: Link A4 went last into Group B`,
    }).toEqual(['Link B1', 'Link B2', 'Link A4']);
    await columnShows(panel, ids['Group B'], ['Link B1', 'Link B2', 'Link A4'], `${width}: the column shows it`);
    await quiet(panel);
    await same('after the drop into a folder');

    // Put Group A back the way it was seeded, from outside the panel, and wait for the column to show it.
    await E.restoreOrder(serviceWorker, ids['Group A'], aIds);
    await columnShows(panel, ids['Group A'], A_TITLES, `${width}: Group A is as seeded again`);
    await columnShows(panel, ids['Group B'], ['Link B1', 'Link B2'], `${width}: and Group B`);
    await quiet(panel);
    await P.moveAway(panel);

    // (b) The row menu, then its "Move to…" list; Escape closes both.
    await rightClickRow(panel, 'Link A2');
    await same('with the row menu open');
    await E.menuItem(panel, 'bm-move-to').hover();
    await expect(panel.locator(E.SUBMENU), `${width}: the list of folders is up`).toBeVisible({ timeout: 10_000 });
    await same('with the "Move to…" list open');
    await panel.keyboard.press('Escape');
    await expect(panel.locator(E.MENU)).toBeHidden({ timeout: 10_000 });
    await P.moveAway(panel);
    await same('after the menu closed');

    // (c1) The new-folder field: open, a name as long as the field takes, given up with Escape.
    const newFolder = panel.locator(NEW_FOLDER);
    await expect(newFolder, `${width}: the new-folder button has a folder to write into`).toBeEnabled({ timeout: 10_000 });
    await newFolder.click();
    await expect(field).toBeFocused({ timeout: 10_000 });
    await same('with the new-folder field open');
    await field.fill('W'.repeat(250));
    await same('with a 250-character name in the new-folder field');
    await field.press('Escape');
    await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
    await quiet(panel);
    await same('after the new-folder field was given up');

    // (c2) The new-folder field again, ended by Enter: a folder is made, and the boxes are still the same.
    await newFolder.click();
    await expect(field).toBeFocused({ timeout: 10_000 });
    await field.fill(`Guard ${width}`);
    await field.press('Enter');
    await expect(E.rowTitled(panel, `Guard ${width}`)).toBeVisible({ timeout: 15_000 });
    await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
    await quiet(panel);
    await same('after the new folder was made');

    // (c3) The rename field: open, a name as long as the field takes, given up with Escape.
    await E.rowTitled(panel, 'Link A2').focus();
    await panel.keyboard.press('F2');
    await expect(field).toBeFocused({ timeout: 10_000 });
    await same('with the rename field open');
    await field.fill('W'.repeat(250));
    await same('with a 250-character name in the rename field');
    await field.press('Escape');
    await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
    await quiet(panel);
    await same('after the rename was given up');

    // (c4) The rename field again, ended by Enter.
    await E.rowTitled(panel, 'Link A2').focus();
    await panel.keyboard.press('F2');
    await expect(field).toBeFocused({ timeout: 10_000 });
    await field.fill(`Renamed ${width}`);
    await field.press('Enter');
    await expect(E.rowTitled(panel, `Renamed ${width}`)).toBeVisible({ timeout: 15_000 });
    await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
    await quiet(panel);
    await same('after the rename was written');

    // Tidy, from outside the panel: the folder removed, the link named as it was.
    const madeId = (await E.childrenOf(serviceWorker, ids['Group B'])).find((n) => n.title === `Guard ${width}`).id;
    await E.externalWrite(serviceWorker, async (a) => {
      await chrome.bookmarks.remove(a.madeId);
      await chrome.bookmarks.update(a.linkId, { title: a.title });
    }, { madeId, linkId: ids['Link A2'], title: 'Link A2' });
    await expect(E.rowTitled(panel, 'Link A2')).toBeVisible({ timeout: 15_000 });
    await expect(E.rowTitled(panel, `Guard ${width}`)).toHaveCount(0, { timeout: 15_000 });
    await quiet(panel);
    await P.moveAway(panel);
  }
  expect(errors, 'the panel threw nothing').toEqual([]);
});

/* ── B10.2: the previews of a four-tab window ───────────────────────────────── */

granted('PR2 in use: during and after a drag, a rename, a new folder and a menu every tab card keeps its preview, and the blob cache is as it was', async ({
  harness, serviceWorker, fixtures,
}) => {
  granted.setTimeout(600_000);
  const { panel } = harness;
  const errors = pageErrors(panel);
  const { cardsOk } = await captureFourTabs(harness, serviceWorker, fixtures);
  const { ids } = await openGuardTree(harness, serviceWorker, { width: 460, height: 900 });
  await expectPr2Controls(panel, 'B10.2');
  const aIds = A_TITLES.map((t) => ids[t]);
  const field = panel.locator(FIELD);

  const cacheBefore = await P.cacheSize(panel);
  const byTabBefore = await panel.evaluate(() => window.__vt.debugState().byTab);
  expect(Object.keys(byTabBefore), 'the panel knows which key each of the four cards shows').toHaveLength(4);
  /** Requirement 2, right now: every card a decoded blob: image, the cache and the keys as they were. */
  const holds = async (what) => {
    expect(await cardsOk(), `${what}: every tab card shows a decoded blob: screenshot`).toEqual({ cards: 4, notOk: [] });
    expect(await P.cacheSize(panel), `${what}: the panel's blob cache is exactly as it was`).toBe(cacheBefore);
    expect(await panel.evaluate(() => window.__vt.debugState().byTab),
      `${what}: and so is its record of which key each card shows`).toEqual(byTabBefore);
  };
  await holds('before anything is done');

  // A drag: the line showing, then dropped; a drag with a folder outlined, then dropped.
  const line = await E.dragRow(panel, 'Link A3', 'Link A1', 'top', { drop: false });
  expect(line.started && line.reached, 'the drag started and the column handled it').toBe(true);
  expect((await E.railFeedback(panel)).line, 'the drop line is showing').not.toBeNull();
  await holds('during a drag, with the drop line showing');
  expect((await E.releaseDrag(panel)).dropped).toBe(true);
  await expect.poll(() => titlesIn(serviceWorker, ids['Group A']), { timeout: 15_000, message: 'Link A3 went first' })
    .toEqual(['Link A3', 'Link A1', 'Link A2', 'Link A4']);
  await columnShows(panel, ids['Group A'], ['Link A3', 'Link A1', 'Link A2', 'Link A4'], 'the column shows it');
  await quiet(panel);
  await holds('after a drag');

  const into = await E.dragRow(panel, 'Link A4', 'Group B', 'middle', { drop: false });
  expect(into.started && into.reached, 'the second drag started and the column handled it').toBe(true);
  expect((await E.railFeedback(panel)).into, 'Group B is outlined').toEqual(['Group B']);
  await holds('during a drag, with a folder outlined');
  expect((await E.releaseDrag(panel)).dropped).toBe(true);
  await expect.poll(() => titlesIn(serviceWorker, ids['Group B']), { timeout: 15_000, message: 'Link A4 went last into Group B' })
    .toEqual(['Link B1', 'Link B2', 'Link A4']);
  await columnShows(panel, ids['Group B'], ['Link B1', 'Link B2', 'Link A4'], 'the column shows it');
  await quiet(panel);
  await holds('after a drag into a folder');
  await E.restoreOrder(serviceWorker, ids['Group A'], aIds);
  await columnShows(panel, ids['Group A'], A_TITLES, 'Group A is as seeded again');
  await quiet(panel);
  await P.moveAway(panel);

  // A rename, written with Enter.
  await E.rowTitled(panel, 'Link B1').focus();
  await panel.keyboard.press('F2');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await holds('during a rename');
  await field.fill('Link B1 renamed');
  await field.press('Enter');
  await expect(E.rowTitled(panel, 'Link B1 renamed')).toBeVisible({ timeout: 15_000 });
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  await quiet(panel);
  await holds('after a rename');

  // A new folder, written with Enter.
  await panel.locator(NEW_FOLDER).click();
  await expect(field).toBeFocused({ timeout: 10_000 });
  await holds('during a new-folder field');
  await field.fill('Made');
  await field.press('Enter');
  await expect(E.rowTitled(panel, 'Made')).toBeVisible({ timeout: 15_000 });
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  await quiet(panel);
  await holds('after a new folder');

  // The menu: open, its Move to… list open, closed with nothing chosen, then a choice that writes.
  await rightClickRow(panel, 'Link A2');
  await holds('during the row menu');
  await E.menuItem(panel, 'bm-move-to').hover();
  await expect(panel.locator(E.SUBMENU), 'the list of folders is up').toBeVisible({ timeout: 10_000 });
  await holds('with the Move to… list open');
  await panel.keyboard.press('Escape');
  await expect(panel.locator(E.MENU)).toBeHidden({ timeout: 10_000 });
  await holds('after the menu was closed with nothing chosen');
  await rightClickRow(panel, 'Link A2');
  await E.menuItem(panel, 'bm-down').click();
  await expect.poll(() => titlesIn(serviceWorker, ids['Group A']), { timeout: 15_000, message: 'Move down moved Link A2 down' })
    .toEqual(['Link A1', 'Link A3', 'Link A2', 'Link A4']);
  await columnShows(panel, ids['Group A'], ['Link A1', 'Link A3', 'Link A2', 'Link A4'], 'the column shows it');
  await quiet(panel);
  await holds('after a menu choice');

  expect(errors, 'the panel threw nothing').toEqual([]);
});

/* ── B10.3: no network, no capture request, no error, across every flow ────── */

granted('PR2 in use: create, rename (Enter and Escape), drags, the menu\'s Move up / down / to and Alt+Arrow fetch nothing, ask for no capture and throw nothing', async ({
  harness, serviceWorker, fixtures,
}) => {
  granted.setTimeout(600_000);
  const { panel } = harness;
  const errors = pageErrors(panel);
  await captureFourTabs(harness, serviceWorker, fixtures);
  const { ids } = await openGuardTree(harness, serviceWorker, { width: 460, height: 900 });
  await expectPr2Controls(panel, 'B10.3');
  await P.installMonitor(panel);

  const requests = [];
  const onRequest = (req) => {
    if (/^https?:/i.test(req.url())) requests.push(req.url());
  };
  panel.on('request', onRequest);

  const idA = ids['Group A'];
  const idB = ids['Group B'];
  const field = panel.locator(FIELD);
  const settled = async (id, titles, what) => {
    await expect.poll(() => titlesIn(serviceWorker, id), { timeout: 15_000, message: `${what}: Chrome's order` }).toEqual(titles);
    await columnShows(panel, id, titles, `${what}: the column shows it`);
    await quiet(panel);
  };

  // 1. Create: the header button, a name, Enter. The folder opened last is Group B.
  await expect(panel.locator(NEW_FOLDER), 'the new-folder button has a folder to write into').toBeEnabled({ timeout: 10_000 });
  await panel.locator(NEW_FOLDER).click();
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.fill('Made');
  await field.press('Enter');
  await settled(idB, ['Link B1', 'Link B2', 'Made'], 'create');

  // 2. Rename ended by Enter.
  await E.rowTitled(panel, 'Link B1').focus();
  await panel.keyboard.press('F2');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.fill('Link B1 renamed');
  await field.press('Enter');
  await settled(idB, ['Link B1 renamed', 'Link B2', 'Made'], 'rename with Enter');

  // 3. Rename ended by Escape: nothing changes.
  await E.rowTitled(panel, 'Made').focus();
  await panel.keyboard.press('F2');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.fill('Never written');
  await field.press('Escape');
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  await settled(idB, ['Link B1 renamed', 'Link B2', 'Made'], 'rename with Escape');

  // 4. A drag inside a folder, then into another.
  expect((await E.dragRow(panel, 'Link A3', 'Link A1', 'top')).dropped, 'the drag inside Group A reached the column').toBe(true);
  await settled(idA, ['Link A3', 'Link A1', 'Link A2', 'Link A4'], 'drag within a folder');
  expect((await E.dragRow(panel, 'Link A4', 'Group B', 'middle')).dropped, 'the drag into Group B reached the column').toBe(true);
  await settled(idB, ['Link B1 renamed', 'Link B2', 'Made', 'Link A4'], 'drag between folders');
  await settled(idA, ['Link A3', 'Link A1', 'Link A2'], 'drag between folders, the folder it left');

  // 5. The menu: Move up, Move down, Move to….
  await rightClickRow(panel, 'Link A2');
  await E.menuItem(panel, 'bm-up').click();
  await settled(idA, ['Link A3', 'Link A2', 'Link A1'], 'menu Move up');
  await rightClickRow(panel, 'Link A2');
  await E.menuItem(panel, 'bm-down').click();
  await settled(idA, ['Link A3', 'Link A1', 'Link A2'], 'menu Move down');
  await rightClickRow(panel, 'Link A3');
  await E.menuItem(panel, 'bm-move-to').hover();
  await expect(panel.locator(E.SUBMENU), 'the list of folders is up').toBeVisible({ timeout: 10_000 });
  await E.menuItem(panel, `bm-moveto-${idB}`).click();
  await settled(idB, ['Link B1 renamed', 'Link B2', 'Made', 'Link A4', 'Link A3'], 'menu Move to…');
  await settled(idA, ['Link A1', 'Link A2'], 'menu Move to…, the folder it left');

  // 6. Alt+ArrowUp and Alt+ArrowDown.
  await E.rowTitled(panel, 'Link A2').focus();
  await panel.keyboard.press('Alt+ArrowUp');
  await settled(idA, ['Link A2', 'Link A1'], 'Alt+ArrowUp');
  await E.rowTitled(panel, 'Link A2').focus();
  await panel.keyboard.press('Alt+ArrowDown');
  await settled(idA, ['Link A1', 'Link A2'], 'Alt+ArrowDown');

  // The flows really wrote (a guard that saw nothing would mean nothing): one create, one update, seven
  // moves, nothing else, and Chrome refused none of them.
  const calls = await E.readWriteSpy(panel);
  expect(calls.filter((c) => E.WRITE_METHODS.includes(c.method)).map((c) => c.method),
    'what the flows wrote: a create, an update, seven moves, and no remove')
    .toEqual(['create', 'update', 'move', 'move', 'move', 'move', 'move', 'move', 'move']);
  expect(calls.filter((c) => c.status === 'rejected').map((c) => `${c.method}: ${c.error}`), 'Chrome refused nothing').toEqual([]);

  // Let anything the last flow started show itself, in the page's own time.
  await P.observe(panel, 500); // nothing is going to happen; this is the time it would have had to
  panel.off('request', onRequest);
  expect(requests, `the panel fetched nothing over http(s): ${requests.join(', ')}`).toEqual([]);
  const mon = await P.readMonitor(panel);
  expect(mon.sends.filter((type) => type === 'vt/capture-request'),
    `no capture was asked for (the panel sent: ${[...new Set(mon.sends)].join(', ') || 'nothing'})`).toEqual([]);
  expect(errors, 'the panel threw nothing').toEqual([]);
});
