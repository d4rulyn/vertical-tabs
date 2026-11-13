// 45-bookmark-window-blur — a name field that loses focus because the WINDOW lost it (Alt+Tab) is not a commit
// (PR2 unit A1; owner decision "A", 2026-11-12 16:32 JST). It reverses plan decision D1 for window blur only.
//
// THE RULE. While the name field of a new folder or of a rename (F2) is open, a `blur` that is only the window
// losing focus (`document.hasFocus()` is false while it is dispatched) writes nothing and leaves the field open,
// holding what was typed: Enter once the window is back commits it, Escape drops it. A `blur` INSIDE the page (a
// click on the heading or on a row, Tab) is exactly what D1 says: a changed name is written, once; an untouched
// or an empty one is not. A window blur followed by an in-page blur is one write, not two.
//
// HOW A WINDOW BLUR IS MADE. `windowFocus` in helpers/bookmark-edit.js: focus emulation is switched off on a
// second CDP session of the panel page, and another tab of the panel's window is brought to front. The field
// gets a REAL `blur` that sees `document.hasFocus() === false` while `document.visibilityState` stays 'visible'
// (probe 105, three runs alike); nothing is stubbed. Every window-blur test asserts that about the blur it caused
// (`blurOnField`) before it asserts anything about the product, so a test whose blur was not a window blur cannot pass.
// NOT exercised: an operating-system window losing focus (this is a tab switch in headless Chromium that gives the
// page the same events), and the real side panel, where `document.hasFocus()` is also false when focus moves to the
// page or the address bar of the same window (the owner's to look at, G11).
//
// STATUS ON THE EXTENSION BEFORE THE FIX (63a2a82 + these tests; the PR body lists it): the premise tests, which
// hold with or without the fix, are named "(premise: ...)": the helper's own test and every test of an in-page
// blur (D1 did not change). Every other test is red there by assertion.
//
// UNIT A3 (the last tests of the file, from "Focus moved off the field while the window has none"): the ignored
// blur is remembered, and when the window has focus again the edit ends as that blur would have if something moved
// focus off the field meanwhile (the browser sends no blur for such a move). STATUS ON 3f6cfa5 (A1's guard, no
// deferral) + these tests: the premises (a script focus move gives no blur; moved off and back) pass with the
// seven window-blur tests and everything above; the stranded tests (create, rename folder, rename link, untouched
// or emptied) and the two that look at what is listening for the window (Escape after an ignored blur, closing the
// column) are red there by assertion.
'use strict';

const { expect } = require('../fixtures');
const { swEval, setSettings } = require('../helpers/chrome');
const { granted, seedBookmarks, showBookmarks } = require('../helpers/bookmarks');
const E = require('../helpers/bookmark-edit');
const EN = require('../../extension/_locales/en/messages.json');

const NEW_FOLDER = '[data-testid="bookmark-new-folder"]';
const EDIT_ROW = '[data-testid="bookmark-edit-row"]';
const FIELD = '[data-testid="bookmark-rename-input"]';
/** The heading of the column: text with no handler, so a click on it is a blur and nothing else. */
const HEADING = '[data-testid="bookmark-title"]';
const FIELD_ID = 'bookmark-rename-input';
const DEFAULT_NAME = EN.bookmarksFolderDefaultName.message;
const HALF = 'Half-typed';

/* ── What every test below shares ─────────────────────────────────────────── */

/** The panel's uncaught errors, collected from now on. */
function watchErrors(panel) {
  const errors = [];
  panel.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
  return errors;
}

const bar = (panel) => panel.locator('[data-testid="bookmark-row"][data-depth="0"]').first();

/** Click a closed folder row open, if it is closed. */
async function openFolder(panel, row) {
  const target = typeof row === 'string' ? E.rowTitled(panel, row) : row;
  await expect(target).toBeVisible({ timeout: 15_000 });
  if ((await target.getAttribute('aria-expanded')) !== 'true') await target.click();
  await expect(target).toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 });
}

/** Seed `spec` under the bar, switch the column on, open the bar and then each folder of `open` (titles, outermost first). */
async function openColumn(harness, serviceWorker, spec, open = []) {
  const { panel } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });
  const { barId } = await seedBookmarks(serviceWorker, []);
  const { ids } = await E.seedTree(serviceWorker, barId, spec);
  await showBookmarks(panel, serviceWorker);
  await expect(bar(panel)).toBeVisible({ timeout: 15_000 });
  await openFolder(panel, bar(panel));
  for (const title of open) await openFolder(panel, title);
  return { barId, ids };
}

const link = (title) => ({ title, url: `https://${title.toLowerCase().replace(/[^a-z0-9]/g, '')}.example.com/` });
const links = (...titles) => titles.map(link);

/** The sequence number of the newest call the write spy has seen: a point to count from. */
const spyMark = async (panel) => (await E.readWriteSpy(panel)).at(-1)?.n ?? 0;
/** The calls since `mark` that change the tree. */
const writesSince = async (panel, mark) => (await E.readWriteSpy(panel, mark)).filter((c) => E.WRITE_METHODS.includes(c.method));
const createsSince = async (panel, mark) => (await writesSince(panel, mark)).filter((c) => c.method === 'create');
const updatesSince = async (panel, mark) => (await writesSince(panel, mark)).filter((c) => c.method === 'update');

/** What Chrome says is in a folder, as titles, in order. */
const titlesOf = async (sw, id) => (await E.childrenOf(sw, id)).map((n) => n.title);
/** What Chrome says about one node. */
const nodeOf = (sw, id) => swEval(sw, async (nodeId) => {
  const [node] = await chrome.bookmarks.get(nodeId);
  return { id: node.id, parentId: node.parentId, title: node.title, url: 'url' in node ? node.url : null };
}, id);

/**
 * Let `ms` of the PAGE's time pass. Only for "nothing happens", which cannot be waited for any other way; each use
 * says what the time is for. How long is enough was measured on the product WITHOUT the fix (63a2a82, host load
 * 28-32, 3 runs, a throwaway diagnostic): the commit a window blur caused had its `create` / `update` call in the
 * write spy 0.4-0.9 ms after the blur event, and its reads of the repaint within 70 ms. 800 ms is hundreds of times that.
 */
const observe = (panel, ms) => panel.evaluate((n) => new Promise((resolve) => { setTimeout(resolve, n); }), ms);
const OBSERVE_MS = 800;

/** Everything about the name field that a commit would change, read in one go. */
const fieldState = (panel) => panel.evaluate((sel) => {
  const fields = document.querySelectorAll(sel);
  const field = fields[0] || null;
  return {
    fields: fields.length,
    readOnly: field ? field.readOnly : null,
    holdsFocus: Boolean(field) && document.activeElement === field,
    value: field ? field.value : null,
    windowHasFocus: document.hasFocus(),
  };
}, FIELD);

/** The `blur` the name field got, among `events` of {@link E.readFocusLog}. */
const blursOnField = (events) => events.filter((e) => e.k === 'blur' && e.on === FIELD_ID);

/** Click the header button and wait for the name field to be up and holding focus. */
async function openField(panel) {
  const button = panel.locator(NEW_FOLDER);
  await expect(button, 'the new-folder button is there, and has a folder to put the new one in').toBeEnabled({ timeout: 10_000 });
  await button.click();
  await expect(panel.locator(FIELD)).toBeFocused({ timeout: 10_000 });
}

/** Put focus on a row and press F2. The field is asserted by the caller. */
async function pressF2On(panel, title) {
  await E.rowTitled(panel, title).focus();
  await panel.keyboard.press('F2');
}

/**
 * What every window-blur test asserts first: the blur the field got was the window's. `lost` is what
 * `focus.lose()` returned.
 */
function expectWindowBlur(lost, where) {
  const onField = blursOnField(lost);
  expect(onField, `${where}: the name field got exactly one blur`).toHaveLength(1);
  expect(onField[0], `${where}: it is a WINDOW blur: the page had lost focus when the field's handler ran, and was still visible`)
    .toMatchObject({ hasFocus: false, vis: 'visible', hidden: false });
  expect(lost.filter((e) => e.k === 'blur' && e.on === 'window'), `${where}: and the window got its own blur`).toHaveLength(1);
}

/**
 * The field is open, editable, holding focus (as the document's activeElement), with `value`; the window has no focus.
 * With `holdsFocus: false`: the same, but something has moved focus off the field since (unit A3).
 */
async function expectLeftOpen(panel, value, where, { holdsFocus = true } = {}) {
  expect(await fieldState(panel), `${where}: the name field is still open, editable, ${holdsFocus ? 'still the focused element' : 'no longer the focused element'}, with what was typed`)
    .toEqual({ fields: 1, readOnly: false, holdsFocus, value, windowHasFocus: false });
  await expect(panel.locator(EDIT_ROW), `${where}: one name field`).toHaveCount(1);
}

/* ── Premise: the stand-in for a window losing focus is a real blur ───────── */

granted('the helper gives a field a real window blur and a real focus back, and tells it from a blur inside the page (premise: passes without the feature)', async ({
  context, harness, serviceWorker,
}) => {
  granted.setTimeout(120_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  await panel.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'plain';
    document.body.append(input);
    input.focus();
  });
  const focus = await E.windowFocus({ context, panel, serviceWorker, windowId: harness.w1 });
  await focus.prepare();
  expect(await panel.evaluate(() => document.activeElement && document.activeElement.id), 'the plain field has focus').toBe('plain');

  const lost = await focus.lose();
  const onField = lost.filter((e) => e.k === 'blur' && e.on === '#plain');
  expect(onField, 'the field got one blur').toHaveLength(1);
  expect(onField[0], 'which saw the page without focus, and visible').toMatchObject({ hasFocus: false, vis: 'visible', hidden: false });
  expect(lost.filter((e) => e.k === 'blur' && e.on === 'window'), 'and so did the window').toHaveLength(1);
  expect(await panel.evaluate(() => ({
    hasFocus: document.hasFocus(), vis: document.visibilityState, activeIsField: document.activeElement.id === 'plain',
  })), 'after it: no focus, visible, and the field is still the active element').toEqual({ hasFocus: false, vis: 'visible', activeIsField: true });

  const back = await focus.regain();
  expect(back.filter((e) => e.k === 'focus').map((e) => e.on).sort(), 'back: the window and the field got `focus`')
    .toEqual(['#plain', 'window']);
  expect(back.every((e) => e.hasFocus), 'with the page having focus').toBe(true);

  // A blur inside the page, with the emulation off and the page focused, is told apart from the window's: hasFocus() is true.
  const since = (await E.readFocusLog(panel)).at(-1)?.n ?? 0;
  await panel.evaluate(() => document.getElementById('plain').blur());
  const inPage = await E.readFocusLog(panel, since);
  expect(inPage.map((e) => [e.k, e.on, e.hasFocus]), 'an in-page blur: the field only, and the page still has focus')
    .toEqual([['blur', '#plain', true]]);
  expect(errors).toEqual([]);
});

/* ── The window loses focus: a new folder ─────────────────────────────────── */

granted('create: the window losing focus makes no folder and leaves the field open with what was typed; Enter once it is back makes exactly one', async ({
  context, harness, serviceWorker,
}) => {
  granted.setTimeout(180_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Reading', children: links('A', 'B') }], ['Reading']);
  await E.installWriteSpy(panel);
  await E.recordToastTexts(panel);
  const focus = await E.windowFocus({ context, panel, serviceWorker, windowId: harness.w1 });
  await focus.prepare();
  await openField(panel);
  const field = panel.locator(FIELD);
  await field.fill(HALF);
  const mark = await spyMark(panel);

  const lost = await focus.lose();
  expectWindowBlur(lost, 'new folder');
  await expectLeftOpen(panel, HALF, 'new folder');
  // The time is for a write that a commit would have started: it shows itself within a few ms, so this is far more than enough.
  await observe(panel, OBSERVE_MS);
  expect(await writesSince(panel, mark), 'new folder: the window blur wrote nothing').toEqual([]);
  expect(await titlesOf(serviceWorker, ids.Reading), 'new folder: Chrome\'s folder is as it was').toEqual(['A', 'B']);
  await expectLeftOpen(panel, HALF, 'new folder, after the wait');
  expect(await E.readToastTexts(panel), 'new folder: nothing was said to the reader').toEqual([]);

  const back = await focus.regain();
  expect(back.filter((e) => e.k === 'focus' && e.on === FIELD_ID), 'back: the field got its focus again').toHaveLength(1);
  expect(await fieldState(panel), 'back: the field is as it was left').toEqual({
    fields: 1, readOnly: false, holdsFocus: true, value: HALF, windowHasFocus: true,
  });
  expect(await writesSince(panel, mark), 'back: still nothing written').toEqual([]);

  await field.press('Enter');
  await expect.poll(async () => (await createsSince(panel, mark)).length, { timeout: 10_000 }).toBe(1);
  const [made] = await createsSince(panel, mark);
  expect(made.args, 'Enter makes the folder with the name that was typed, in the folder it was opened for').toEqual([{ parentId: ids.Reading, title: HALF }]);
  expect(made.keys, 'and no `index` key').toEqual([['parentId', 'title']]);
  const kids = await E.childrenOf(serviceWorker, ids.Reading);
  expect(kids.map((n) => n.title), 'Chrome has exactly one new folder, last').toEqual(['A', 'B', HALF]);
  expect('url' in kids[2], 'a folder').toBe(false);
  await expect(E.rowTitled(panel, HALF)).toBeVisible({ timeout: 10_000 });
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  await observe(panel, OBSERVE_MS); // nothing writes it a second time
  expect(await createsSince(panel, mark), 'one create, not two').toHaveLength(1);
  expect(await titlesOf(serviceWorker, ids.Reading)).toEqual(['A', 'B', HALF]);
  expect(errors, 'the panel threw nothing').toEqual([]);
});

/* ── The window loses focus: a rename ─────────────────────────────────────── */

/**
 * The rename tests are one body for a folder and for a link: F2 on the row, a changed name, the window loses focus,
 * the title in Chrome is as it was and the field is open; once the window is back, Enter renames once.
 */
async function renameAcrossWindowBlur({ context, harness, serviceWorker }, { spec, title, kind }) {
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Reading', children: spec }], ['Reading']);
  const id = ids[title];
  const before = await nodeOf(serviceWorker, id);
  expect(before.title, `${kind}: the node starts with its title`).toBe(title);
  await E.installWriteSpy(panel);
  await E.recordToastTexts(panel);
  const focus = await E.windowFocus({ context, panel, serviceWorker, windowId: harness.w1 });
  await focus.prepare();
  const field = panel.locator(FIELD);
  await pressF2On(panel, title);
  await expect(field).toBeFocused({ timeout: 10_000 });
  await expect(field, `${kind}: the field opens with the title`).toHaveValue(title);
  await field.fill(HALF);
  const mark = await spyMark(panel);

  const lost = await focus.lose();
  expectWindowBlur(lost, kind);
  await expectLeftOpen(panel, HALF, kind);
  await observe(panel, OBSERVE_MS); // for the update a commit would have started
  expect(await writesSince(panel, mark), `${kind}: the window blur wrote nothing`).toEqual([]);
  expect(await nodeOf(serviceWorker, id), `${kind}: Chrome's node is as it was, title and address`).toEqual(before);
  await expectLeftOpen(panel, HALF, `${kind}, after the wait`);
  expect(await E.readToastTexts(panel), `${kind}: nothing was said to the reader`).toEqual([]);

  const back = await focus.regain();
  expect(back.filter((e) => e.k === 'focus' && e.on === FIELD_ID), `${kind}: back: the field got its focus again`).toHaveLength(1);
  expect(await fieldState(panel), `${kind}: back: the field is as it was left`).toEqual({
    fields: 1, readOnly: false, holdsFocus: true, value: HALF, windowHasFocus: true,
  });

  await field.press('Enter');
  await expect.poll(async () => (await updatesSince(panel, mark)).length, { timeout: 10_000 }).toBe(1);
  const [renamed] = await updatesSince(panel, mark);
  expect(renamed.args, `${kind}: Enter renames the node, with the name that was typed`).toEqual([id, { title: HALF }]);
  expect(renamed.keys, `${kind}: and sends nothing but the title`).toEqual([null, ['title']]);
  expect(await nodeOf(serviceWorker, id), `${kind}: Chrome has the new title, the address untouched`)
    .toEqual({ ...before, title: HALF });
  await expect(E.rowTitled(panel, HALF)).toHaveAttribute('data-bookmark-id', id, { timeout: 10_000 });
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  await observe(panel, OBSERVE_MS); // nothing writes it a second time
  expect(await updatesSince(panel, mark), `${kind}: one update, not two`).toHaveLength(1);
  expect((await writesSince(panel, mark)).length, `${kind}: and it is the only write`).toBe(1);
  expect(errors, 'the panel threw nothing').toEqual([]);
}

granted('rename a folder (F2): the window losing focus leaves its title and the field open; Enter once it is back renames it once', async ({
  context, harness, serviceWorker,
}) => {
  granted.setTimeout(180_000);
  await renameAcrossWindowBlur({ context, harness, serviceWorker }, {
    spec: [{ title: 'Sub', children: [] }, ...links('Link one')], title: 'Sub', kind: 'folder',
  });
});

granted('rename a link (F2): the window losing focus leaves its title and the field open; Enter once it is back renames it once', async ({
  context, harness, serviceWorker,
}) => {
  granted.setTimeout(180_000);
  await renameAcrossWindowBlur({ context, harness, serviceWorker }, {
    spec: [{ title: 'Sub', children: [] }, ...links('Link one')], title: 'Link one', kind: 'link',
  });
});

/* ── A blur inside the page is what D1 says (premise: unchanged by the fix) ─ */

granted('a changed name left by a click on the heading is written once, for a new folder (premise: D1 did not change, passes without the feature)', async ({
  context, harness, serviceWorker,
}) => {
  granted.setTimeout(180_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Reading', children: links('A', 'B') }], ['Reading']);
  await E.installWriteSpy(panel);
  const focus = await E.windowFocus({ context, panel, serviceWorker, windowId: harness.w1 });
  await focus.prepare(); // the page's focus is the real one: hasFocus() is what the guard reads
  await openField(panel);
  await panel.locator(FIELD).fill('Via heading');
  const mark = await spyMark(panel);
  const since = (await E.readFocusLog(panel)).at(-1)?.n ?? 0;

  await panel.locator(HEADING).click();

  await expect.poll(async () => (await createsSince(panel, mark)).length, { timeout: 10_000 }).toBe(1);
  const blurs = blursOnField(await E.readFocusLog(panel, since));
  expect(blurs.map((e) => e.hasFocus), 'the blur was inside the page: the page had focus when the field\'s handler ran').toEqual([true]);
  const [made] = await createsSince(panel, mark);
  expect(made.args).toEqual([{ parentId: ids.Reading, title: 'Via heading' }]);
  expect(await titlesOf(serviceWorker, ids.Reading)).toEqual(['A', 'B', 'Via heading']);
  await expect(E.rowTitled(panel, 'Via heading')).toBeVisible({ timeout: 10_000 });
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  await observe(panel, OBSERVE_MS); // nothing writes it a second time
  expect(await createsSince(panel, mark), 'once').toHaveLength(1);
  expect(errors).toEqual([]);
});

granted('a changed name left by a click on the heading is written once, for a rename (premise: D1 did not change, passes without the feature)', async ({
  context, harness, serviceWorker,
}) => {
  granted.setTimeout(180_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Reading', children: links('Link one', 'Link two') }], ['Reading']);
  await E.installWriteSpy(panel);
  const focus = await E.windowFocus({ context, panel, serviceWorker, windowId: harness.w1 });
  await focus.prepare();
  const field = panel.locator(FIELD);
  await pressF2On(panel, 'Link two');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.fill('Via heading');
  const mark = await spyMark(panel);
  const since = (await E.readFocusLog(panel)).at(-1)?.n ?? 0;

  await panel.locator(HEADING).click();

  await expect.poll(async () => (await updatesSince(panel, mark)).length, { timeout: 10_000 }).toBe(1);
  expect(blursOnField(await E.readFocusLog(panel, since)).map((e) => e.hasFocus), 'the blur was inside the page').toEqual([true]);
  expect((await updatesSince(panel, mark))[0].args).toEqual([ids['Link two'], { title: 'Via heading' }]);
  await expect(E.rowTitled(panel, 'Via heading')).toHaveAttribute('data-bookmark-id', ids['Link two'], { timeout: 10_000 });
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  await observe(panel, OBSERVE_MS);
  expect(await updatesSince(panel, mark), 'once').toHaveLength(1);
  expect(await titlesOf(serviceWorker, ids['Reading']), 'the other link is as it was').toEqual(['Link one', 'Via heading']);
  expect(errors).toEqual([]);
});

granted('an untouched or an emptied name left by a click on the heading writes nothing, for a new folder and for a rename (premise: D1 did not change, passes without the feature)', async ({
  context, harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Reading', children: links('Link one', 'Link two') }], ['Reading']);
  await E.installWriteSpy(panel);
  const focus = await E.windowFocus({ context, panel, serviceWorker, windowId: harness.w1 });
  await focus.prepare();
  const field = panel.locator(FIELD);
  const mark = await spyMark(panel);
  const leaveAndExpectNothing = async (why) => {
    const since = (await E.readFocusLog(panel)).at(-1)?.n ?? 0;
    await panel.locator(HEADING).click();
    await expect(panel.locator(EDIT_ROW), `${why}: the field is gone`).toHaveCount(0, { timeout: 10_000 });
    expect(blursOnField(await E.readFocusLog(panel, since)).map((e) => e.hasFocus), `${why}: it was a blur inside the page`).toEqual([true]);
    await observe(panel, OBSERVE_MS); // for the write a commit would have started
    expect(await writesSince(panel, mark), `${why}: nothing was written`).toEqual([]);
    expect(await titlesOf(serviceWorker, ids.Reading), `${why}: Chrome's folder is as it was`).toEqual(['Link one', 'Link two']);
    await expect(E.rowTitled(panel, 'Link one'), `${why}: and the list is whole`).toBeVisible();
  };

  await openField(panel);
  await expect(field).toHaveValue(DEFAULT_NAME);
  await leaveAndExpectNothing('a new folder, name untouched');

  await openField(panel);
  await field.fill('');
  await leaveAndExpectNothing('a new folder, name emptied');

  await pressF2On(panel, 'Link one');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await leaveAndExpectNothing('a rename, title untouched');
  await expect(E.rowTitled(panel, 'Link one'), 'the row is back with its title').toHaveAttribute('data-bookmark-id', ids['Link one']);

  await pressF2On(panel, 'Link one');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.fill('');
  await leaveAndExpectNothing('a rename, title emptied');
  expect(errors).toEqual([]);
});

granted('Tab out of the field is a blur inside the page: a changed name is written once, for a new folder and for a rename (premise: D1 did not change, passes without the feature)', async ({
  context, harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Reading', children: links('Link one') }], ['Reading']);
  await E.installWriteSpy(panel);
  const focus = await E.windowFocus({ context, panel, serviceWorker, windowId: harness.w1 });
  await focus.prepare();
  const field = panel.locator(FIELD);
  const mark = await spyMark(panel);

  await openField(panel);
  await field.fill('Via Tab');
  let since = (await E.readFocusLog(panel)).at(-1)?.n ?? 0;
  await field.press('Tab');
  await expect.poll(async () => (await createsSince(panel, mark)).length, { timeout: 10_000 }).toBe(1);
  expect(blursOnField(await E.readFocusLog(panel, since)).map((e) => e.hasFocus), 'Tab: a blur inside the page').toEqual([true]);
  expect((await createsSince(panel, mark))[0].args).toEqual([{ parentId: ids.Reading, title: 'Via Tab' }]);
  await expect(E.rowTitled(panel, 'Via Tab')).toBeVisible({ timeout: 10_000 });
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });

  await pressF2On(panel, 'Link one');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.fill('Renamed by Tab');
  since = (await E.readFocusLog(panel)).at(-1)?.n ?? 0;
  await field.press('Tab');
  await expect.poll(async () => (await updatesSince(panel, mark)).length, { timeout: 10_000 }).toBe(1);
  expect(blursOnField(await E.readFocusLog(panel, since)).map((e) => e.hasFocus), 'Tab: a blur inside the page').toEqual([true]);
  expect((await updatesSince(panel, mark))[0].args).toEqual([ids['Link one'], { title: 'Renamed by Tab' }]);
  await observe(panel, OBSERVE_MS);
  expect((await writesSince(panel, mark)).length, 'one create and one update, nothing twice').toBe(2);
  expect(await titlesOf(serviceWorker, ids.Reading)).toEqual(['Renamed by Tab', 'Via Tab']);
  expect(errors).toEqual([]);
});

granted('a changed name left by pressing on another row is written once inside the press, and the press still does its job, for a new folder and for a rename (premise: D1 did not change, passes without the feature)', async ({
  context, harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{
    title: 'Reading', children: [{ title: 'Sub', children: [] }, ...links('Link one')],
  }], ['Reading']);
  await E.installWriteSpy(panel);
  await E.installTimerHold(panel);
  const focus = await E.windowFocus({ context, panel, serviceWorker, windowId: harness.w1 });
  await focus.prepare();
  const field = panel.locator(FIELD);
  const sub = E.rowTitled(panel, 'Sub');
  const mark = await spyMark(panel);
  /**
   * Press the mouse button down on the row `Sub` and leave it down: the blur of the field is inside this press.
   *
   * The 400 ms timers of the page are kept in the test's hand from here until {@link letTheTimersRun}. The write's
   * own tree event arms the column's 400 ms repaint timer while the button is down, and `paintAfterPress` keeps back
   * only the commit's own paint until the release: a press held PAST 400 ms has that timer rebuild the row under the
   * pointer and loses its click. That was measured on the extension (a throwaway diagnostic, 5 holds: 0 and 150 ms
   * keep the click, 700 and 1500 ms lose it, 700 ms with the timers kept keeps it), and it is what made this test
   * fail once at host load ~190: the button is held for as long as the test takes to read the write, which is the
   * host's speed, not the product's. What this test claims is the product's design for a press (the paint waits
   * for the button), not the speed of the machine, so the one timer that decides it is not left to the host.
   */
  const pressOnSub = async () => {
    await E.holdTimers(panel, true);
    const box = await sub.boundingBox();
    await panel.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await panel.mouse.down();
  };
  /** The press is over: run what the 400 ms timers were keeping (the repaint the write's event asked for, the saved view). */
  const letTheTimersRun = async () => {
    await E.holdTimers(panel, false);
    await E.fireTimers(panel);
  };

  // A new folder. The write is asked for while the button is still down; the click that follows is not lost.
  await expect(sub, 'the press target starts closed').toHaveAttribute('aria-expanded', 'false');
  await openField(panel);
  await field.fill('Via row');
  let since = (await E.readFocusLog(panel)).at(-1)?.n ?? 0;
  await pressOnSub();
  await expect.poll(async () => (await createsSince(panel, mark)).length, { timeout: 10_000 }).toBe(1);
  expect(blursOnField(await E.readFocusLog(panel, since)).map((e) => e.hasFocus), 'a press on a row: a blur inside the page').toEqual([true]);
  expect((await createsSince(panel, mark))[0].args).toEqual([{ parentId: ids.Reading, title: 'Via row' }]);
  await panel.mouse.up();
  await expect(sub, 'and the press still opened the folder it was on').toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 });
  await expect(E.rowTitled(panel, 'Via row')).toBeVisible({ timeout: 10_000 });
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  await letTheTimersRun();

  // A rename, the same way: the row Sub is closed again by the press.
  await pressF2On(panel, 'Link one');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.fill('Renamed via row');
  since = (await E.readFocusLog(panel)).at(-1)?.n ?? 0;
  await pressOnSub();
  await expect.poll(async () => (await updatesSince(panel, mark)).length, { timeout: 10_000 }).toBe(1);
  expect(blursOnField(await E.readFocusLog(panel, since)).map((e) => e.hasFocus), 'a press on a row: a blur inside the page').toEqual([true]);
  expect((await updatesSince(panel, mark))[0].args).toEqual([ids['Link one'], { title: 'Renamed via row' }]);
  await panel.mouse.up();
  await expect(sub, 'and the press still closed the folder it was on').toHaveAttribute('aria-expanded', 'false', { timeout: 10_000 });
  await expect(E.rowTitled(panel, 'Renamed via row')).toHaveAttribute('data-bookmark-id', ids['Link one'], { timeout: 10_000 });
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  await letTheTimersRun();

  await observe(panel, OBSERVE_MS); // nothing writes either a second time
  expect((await writesSince(panel, mark)).length, 'one create and one update, nothing twice').toBe(2);
  expect(await titlesOf(serviceWorker, ids.Reading)).toEqual(['Sub', 'Renamed via row', 'Via row']);
  expect(errors).toEqual([]);
});

/* ── The window loses focus, then a blur inside the page ──────────────────── */

granted('create: a window blur and then a blur inside the page is one write, not two', async ({
  context, harness, serviceWorker,
}) => {
  granted.setTimeout(180_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Reading', children: links('A', 'B') }], ['Reading']);
  await E.installWriteSpy(panel);
  const focus = await E.windowFocus({ context, panel, serviceWorker, windowId: harness.w1 });
  await focus.prepare();
  await openField(panel);
  await panel.locator(FIELD).fill('Once only');
  const mark = await spyMark(panel);
  const since = (await E.readFocusLog(panel)).at(-1)?.n ?? 0;

  // The window loses focus twice, with the reader coming back in between: neither is a commit.
  for (const round of [1, 2]) {
    const lost = await focus.lose();
    expectWindowBlur(lost, `window blur ${round}`);
    await expectLeftOpen(panel, 'Once only', `window blur ${round}`);
    await observe(panel, OBSERVE_MS / 2); // for the write a commit would have started
    expect(await writesSince(panel, mark), `window blur ${round}: nothing written yet`).toEqual([]);
    await focus.regain();
  }

  await panel.locator(HEADING).click(); // the blur inside the page
  await expect.poll(async () => (await createsSince(panel, mark)).length, { timeout: 10_000 }).toBe(1);
  expect(blursOnField(await E.readFocusLog(panel, since)).map((e) => e.hasFocus),
    'the field got three blurs: the window\'s twice, and then one inside the page').toEqual([false, false, true]);
  await expect(E.rowTitled(panel, 'Once only')).toBeVisible({ timeout: 10_000 });
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  await observe(panel, OBSERVE_MS);
  expect(await createsSince(panel, mark), 'exactly one create').toHaveLength(1);
  expect((await createsSince(panel, mark))[0].args).toEqual([{ parentId: ids.Reading, title: 'Once only' }]);
  expect(await titlesOf(serviceWorker, ids.Reading), 'and exactly one folder').toEqual(['A', 'B', 'Once only']);
  expect(errors).toEqual([]);
});

granted('rename: a window blur and then a blur inside the page is one write, not two', async ({
  context, harness, serviceWorker,
}) => {
  granted.setTimeout(180_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Reading', children: links('Link one', 'Link two') }], ['Reading']);
  await E.installWriteSpy(panel);
  const focus = await E.windowFocus({ context, panel, serviceWorker, windowId: harness.w1 });
  await focus.prepare();
  const field = panel.locator(FIELD);
  await pressF2On(panel, 'Link one');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.fill('Once only');
  const mark = await spyMark(panel);
  const since = (await E.readFocusLog(panel)).at(-1)?.n ?? 0;

  const lost = await focus.lose();
  expectWindowBlur(lost, 'window blur');
  await expectLeftOpen(panel, 'Once only', 'window blur');
  await observe(panel, OBSERVE_MS / 2); // for the update a commit would have started
  expect(await writesSince(panel, mark), 'window blur: nothing written yet').toEqual([]);
  await focus.regain();

  await panel.locator(HEADING).click(); // the blur inside the page
  await expect.poll(async () => (await updatesSince(panel, mark)).length, { timeout: 10_000 }).toBe(1);
  expect(blursOnField(await E.readFocusLog(panel, since)).map((e) => e.hasFocus),
    'the field got two blurs: the window\'s, and then one inside the page').toEqual([false, true]);
  await expect(E.rowTitled(panel, 'Once only')).toHaveAttribute('data-bookmark-id', ids['Link one'], { timeout: 10_000 });
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  await observe(panel, OBSERVE_MS);
  expect(await updatesSince(panel, mark), 'exactly one update').toHaveLength(1);
  expect((await updatesSince(panel, mark))[0].args).toEqual([ids['Link one'], { title: 'Once only' }]);
  expect((await writesSince(panel, mark)).length, 'and it is the only write').toBe(1);
  expect(await titlesOf(serviceWorker, ids.Reading)).toEqual(['Once only', 'Link two']);
  expect(errors).toEqual([]);
});

/* ── Escape after the window lost focus ───────────────────────────────────── */

granted('create: Escape after a window blur closes the field and writes nothing, and focus goes back to the button', async ({
  context, harness, serviceWorker,
}) => {
  granted.setTimeout(180_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Reading', children: links('A', 'B') }], ['Reading']);
  await E.installWriteSpy(panel);
  const focus = await E.windowFocus({ context, panel, serviceWorker, windowId: harness.w1 });
  await focus.prepare();
  await openField(panel);
  const field = panel.locator(FIELD);
  await field.fill('Draft');
  const mark = await spyMark(panel);

  const lost = await focus.lose();
  expectWindowBlur(lost, 'new folder');
  await expectLeftOpen(panel, 'Draft', 'new folder');
  await focus.regain();
  expect(await fieldState(panel), 'back: the field is as it was left').toEqual({
    fields: 1, readOnly: false, holdsFocus: true, value: 'Draft', windowHasFocus: true,
  });

  await field.press('Escape');
  await expect(panel.locator(EDIT_ROW), 'Escape closes the field').toHaveCount(0, { timeout: 10_000 });
  await observe(panel, OBSERVE_MS); // for the write a commit would have started
  expect(await writesSince(panel, mark), 'and writes nothing').toEqual([]);
  expect(await titlesOf(serviceWorker, ids.Reading), 'Chrome\'s folder is as it was').toEqual(['A', 'B']);
  await expect(panel.locator(NEW_FOLDER), 'focus went back to the button that opened the field').toBeFocused();
  await expect(E.rowTitled(panel, 'B'), 'and the list is whole').toBeVisible();
  expect(errors).toEqual([]);
});

granted('rename: Escape after a window blur closes the field and writes nothing, and the row comes back with its title and focus', async ({
  context, harness, serviceWorker,
}) => {
  granted.setTimeout(180_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Reading', children: links('Link one', 'Link two') }], ['Reading']);
  const before = await nodeOf(serviceWorker, ids['Link one']);
  await E.installWriteSpy(panel);
  const focus = await E.windowFocus({ context, panel, serviceWorker, windowId: harness.w1 });
  await focus.prepare();
  const field = panel.locator(FIELD);
  await pressF2On(panel, 'Link one');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.fill('Draft');
  const mark = await spyMark(panel);

  const lost = await focus.lose();
  expectWindowBlur(lost, 'rename');
  await expectLeftOpen(panel, 'Draft', 'rename');
  await focus.regain();

  await field.press('Escape');
  await expect(panel.locator(EDIT_ROW), 'Escape closes the field').toHaveCount(0, { timeout: 10_000 });
  await observe(panel, OBSERVE_MS); // for the update a commit would have started
  expect(await writesSince(panel, mark), 'and writes nothing').toEqual([]);
  expect(await nodeOf(serviceWorker, ids['Link one']), 'Chrome\'s node is as it was').toEqual(before);
  await expect(E.rowTitled(panel, 'Link one'), 'the row is back with its title').toHaveAttribute('data-bookmark-id', ids['Link one'], { timeout: 10_000 });
  await expect.poll(() => panel.evaluate(() => document.activeElement && document.activeElement.dataset.bookmarkId), {
    timeout: 5_000, message: 'and has focus',
  }).toBe(ids['Link one']);
  expect(errors).toEqual([]);
});

/* ── Focus moved off the field while the window has none (unit A3) ────────────────────────────────────────────
   After a window blur that was ignored, the browser sends the field NO further `blur` for a focus move made while
   the page has no focus (probe 105). The panel's own code can make such a move: the "focus the search box" hand-off
   of the Alt+Shift+S shortcut calls `focusSearch()` on whatever panel document is there, focused or not. Before unit
   A3 that left the name field open for good: the edit hold stood, "New folder" and F2 did nothing, a change made from
   another context never showed, and nothing healed it.
   The decision: the window's next `focus` ends the edit exactly as the swallowed blur would have (a changed name is
   written once, an untouched or an emptied one is not), unless the field is still the active element, and then nothing
   happens (the tests above). Closing the column with the field open still writes nothing.
   NOT exercised: the real shortcut. The focus move is the panel's own `focusSearch()` fed by the key the shortcut
   writes (`focusSearchLikeTheShortcut`), or a plain script `focus()`; the command, `sidePanel.open()` and the key press
   are not. And, as above, the window blur is a tab switch in headless Chromium, not an OS window. */

/** The id of the page's active element, else its data-testid, else its tag. */
const activeThing = (panel) => panel.evaluate(() => {
  const el = document.activeElement;
  return el ? (el.id || (el.dataset && el.dataset.testid) || el.tagName) : null;
});

/** The sequence number of the newest focus event the page has logged: a point to count from. */
const focusMark = async (panel) => (await E.readFocusLog(panel)).at(-1)?.n ?? 0;

/** Move focus by plain script, as any code in the panel might: to the new-tab button, which is always there. */
async function focusByScript(panel) {
  await panel.evaluate(() => document.getElementById('btn-new-tab').focus());
  expect(await activeThing(panel), 'script moved focus to the new-tab button').toBe('btn-new-tab');
}

/**
 * Something has just moved focus off the open field while the window had none: the page got no `blur` and no `focus`
 * for that (probe 105; `since` is a {@link focusMark} taken before the move), and the field is still open and editable
 * with `value`, and no longer the active element.
 */
async function expectStranded(panel, since, value, where) {
  expect(await E.readFocusLog(panel, since), `${where}: the move gave the page no blur and no focus event`).toEqual([]);
  await expectLeftOpen(panel, value, where, { holdsFocus: false });
}

/**
 * The edit hold is gone and the column answers again: a bookmark added from another context shows up (it stays
 * unpainted while a hold stands), and the header's "New folder" opens a field and Escape closes it.
 */
async function expectColumnFree(panel, serviceWorker, parentId, title, where) {
  await E.externalWrite(serviceWorker, (a) => chrome.bookmarks.create(a), { parentId, title, url: 'https://ext.example.com/' });
  await expect(E.rowTitled(panel, title), `${where}: a bookmark added from another context shows up (no repaint hold is left)`)
    .toBeVisible({ timeout: 10_000 });
  await openField(panel);
  await panel.locator(FIELD).press('Escape');
  await expect(panel.locator(EDIT_ROW), `${where}: "New folder" opens a field again, and Escape closes it`).toHaveCount(0, { timeout: 10_000 });
}

/** F2 opens the field on the row `title` again, and Escape closes it. */
async function expectF2Works(panel, title, where) {
  await pressF2On(panel, title);
  await expect(panel.locator(FIELD), `${where}: F2 opens the field on "${title}" again`).toBeFocused({ timeout: 10_000 });
  await panel.locator(FIELD).press('Escape');
  await expect(panel.locator(EDIT_ROW), `${where}: and Escape closes it`).toHaveCount(0, { timeout: 10_000 });
}

granted('premise: a focus move by script while the window has none gives the field no blur, and the window\'s focus is what comes next (passes without the feature)', async ({
  context, harness, serviceWorker,
}) => {
  granted.setTimeout(120_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  await panel.evaluate(() => {
    for (const id of ['plain', 'other']) {
      const el = document.createElement('input');
      el.id = id;
      document.body.append(el);
    }
    document.getElementById('plain').focus();
  });
  const focus = await E.windowFocus({ context, panel, serviceWorker, windowId: harness.w1 });
  await focus.prepare();
  const lost = await focus.lose();
  expect(lost.filter((e) => e.k === 'blur' && e.on === '#plain').map((e) => e.hasFocus), 'the window blur: the field got one, with the page without focus')
    .toEqual([false]);

  const since = await focusMark(panel);
  await panel.evaluate(() => document.getElementById('other').focus());
  expect(await activeThing(panel), 'script moved focus to the other field').toBe('other');
  expect(await E.readFocusLog(panel, since), 'the move: no blur on the field that lost focus, no focus on the one that got it, nothing at all')
    .toEqual([]);

  const back = await focus.regain();
  expect(back.filter((e) => e.k === 'focus').map((e) => e.on).sort(), 'back: the window and the new active element get `focus`; the field that lost it before does not')
    .toEqual(['#other', 'window']);
  expect(await activeThing(panel)).toBe('other');
  expect(errors).toEqual([]);
});

granted('create: focus moved off the field by the panel itself while the window has none: the next window focus commits the changed name once and frees the column', async ({
  context, harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Reading', children: links('A', 'B') }], ['Reading']);
  await E.installWriteSpy(panel);
  await E.recordToastTexts(panel);
  await E.watchWindowFocusListeners(panel);
  const listeners = await E.countWindowFocusListeners(panel);
  const focus = await E.windowFocus({ context, panel, serviceWorker, windowId: harness.w1 });
  await focus.prepare();
  await openField(panel);
  await panel.locator(FIELD).fill(HALF);
  const mark = await spyMark(panel);

  const lost = await focus.lose();
  expectWindowBlur(lost, 'new folder');
  await expectLeftOpen(panel, HALF, 'new folder');
  const afterLose = await focusMark(panel);

  // The panel's own focusSearch(), as the Alt+Shift+S hand-off calls it, while the window has no focus.
  await E.focusSearchLikeTheShortcut(panel, serviceWorker, harness.w2);
  await expectStranded(panel, afterLose, HALF, 'new folder');
  await observe(panel, OBSERVE_MS); // the decision waits for the window: nothing is written meanwhile
  expect(await writesSince(panel, mark), 'new folder: nothing is written while the window has no focus').toEqual([]);
  await expectStranded(panel, afterLose, HALF, 'new folder, after the wait');

  await focus.regain();
  await expect.poll(async () => (await createsSince(panel, mark)).length, { timeout: 10_000 }).toBe(1);
  const [made] = await createsSince(panel, mark);
  expect(made.args, 'the window\'s focus commits the changed name, once, in the folder the field was opened for')
    .toEqual([{ parentId: ids.Reading, title: HALF }]);
  expect(made.keys, 'and no `index` key').toEqual([['parentId', 'title']]);
  expect(await titlesOf(serviceWorker, ids.Reading), 'Chrome has exactly one new folder, last').toEqual(['A', 'B', HALF]);
  await expect(E.rowTitled(panel, HALF)).toBeVisible({ timeout: 10_000 });
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  expect(await activeThing(panel), 'the commit did not take focus back from where the panel put it').toBe('search-input');
  expect(await E.countWindowFocusListeners(panel), 'and nothing listens for the window any more').toBe(listeners);
  await observe(panel, OBSERVE_MS); // nothing writes it a second time
  expect(await createsSince(panel, mark), 'one create, not two').toHaveLength(1);
  // The window loses and regains focus once more: the edit is over, so that cannot write it again.
  await focus.lose();
  await focus.regain();
  await observe(panel, OBSERVE_MS);
  expect(await createsSince(panel, mark), 'a later window focus does not write it again').toHaveLength(1);
  expect(await E.readToastTexts(panel), 'nothing was said to the reader').toEqual([]);
  await expectColumnFree(panel, serviceWorker, ids.Reading, 'Ext after the commit', 'new folder');
  expect(errors, 'the panel threw nothing').toEqual([]);
});

/**
 * The rename tests are one body for a folder and for a link: F2, a changed name, the window loses focus, focus is moved
 * off the field, the window comes back: the node is renamed once and the column answers again.
 */
async function renameStrandedThenRegained({ context, harness, serviceWorker }, { title, kind, moveFocus, activeAfter }) {
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{
    title: 'Reading', children: [{ title: 'Sub', children: [] }, ...links('Link one', 'Link two')],
  }], ['Reading']);
  const id = ids[title];
  const before = await nodeOf(serviceWorker, id);
  await E.installWriteSpy(panel);
  await E.recordToastTexts(panel);
  await E.watchWindowFocusListeners(panel);
  const listeners = await E.countWindowFocusListeners(panel);
  const focus = await E.windowFocus({ context, panel, serviceWorker, windowId: harness.w1 });
  await focus.prepare();
  const field = panel.locator(FIELD);
  await pressF2On(panel, title);
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.fill(HALF);
  const mark = await spyMark(panel);

  const lost = await focus.lose();
  expectWindowBlur(lost, kind);
  await expectLeftOpen(panel, HALF, kind);
  const afterLose = await focusMark(panel);
  await moveFocus(panel, serviceWorker, harness);
  await expectStranded(panel, afterLose, HALF, kind);
  await observe(panel, OBSERVE_MS);
  expect(await writesSince(panel, mark), `${kind}: nothing is written while the window has no focus`).toEqual([]);
  expect(await nodeOf(serviceWorker, id), `${kind}: Chrome's node is as it was`).toEqual(before);

  await focus.regain();
  await expect.poll(async () => (await updatesSince(panel, mark)).length, { timeout: 10_000 }).toBe(1);
  const [renamed] = await updatesSince(panel, mark);
  expect(renamed.args, `${kind}: the window's focus renames the node, with the name that was typed`).toEqual([id, { title: HALF }]);
  expect(renamed.keys, `${kind}: and sends nothing but the title`).toEqual([null, ['title']]);
  expect(await nodeOf(serviceWorker, id), `${kind}: Chrome has the new title, the address untouched`).toEqual({ ...before, title: HALF });
  await expect(E.rowTitled(panel, HALF)).toHaveAttribute('data-bookmark-id', id, { timeout: 10_000 });
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  expect(await activeThing(panel), `${kind}: the commit did not take focus back from where it was put`).toBe(activeAfter);
  expect(await E.countWindowFocusListeners(panel), `${kind}: and nothing listens for the window any more`).toBe(listeners);
  await observe(panel, OBSERVE_MS); // nothing writes it a second time
  expect(await updatesSince(panel, mark), `${kind}: one update, not two`).toHaveLength(1);
  expect((await writesSince(panel, mark)).length, `${kind}: and it is the only write`).toBe(1);
  // The window loses and regains focus once more: the edit is over, so that cannot write it again.
  await focus.lose();
  await focus.regain();
  await observe(panel, OBSERVE_MS);
  expect((await writesSince(panel, mark)).length, `${kind}: a later window focus does not write it again`).toBe(1);
  expect(await E.readToastTexts(panel), `${kind}: nothing was said to the reader`).toEqual([]);
  await expectColumnFree(panel, serviceWorker, ids.Reading, `Ext after the ${kind} commit`, kind);
  await expectF2Works(panel, 'Link two', kind);
  expect(errors, 'the panel threw nothing').toEqual([]);
}

granted('rename a folder (F2): focus moved off the field by script while the window has none: the next window focus renames it once and frees the column', async ({
  context, harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  await renameStrandedThenRegained({ context, harness, serviceWorker }, {
    title: 'Sub', kind: 'folder', activeAfter: 'btn-new-tab', moveFocus: (panel) => focusByScript(panel),
  });
});

granted('rename a link (F2): focus moved off the field by the panel itself while the window has none: the next window focus renames it once and frees the column', async ({
  context, harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  await renameStrandedThenRegained({ context, harness, serviceWorker }, {
    title: 'Link one', kind: 'link', activeAfter: 'search-input',
    moveFocus: (panel, sw, h) => E.focusSearchLikeTheShortcut(panel, sw, h.w2),
  });
});

granted('an untouched or an emptied name, with focus moved off the field while the window has none: the next window focus closes the field and writes nothing, for a new folder and for a rename', async ({
  context, harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Reading', children: links('Link one', 'Link two') }], ['Reading']);
  await E.installWriteSpy(panel);
  await E.watchWindowFocusListeners(panel);
  const listeners = await E.countWindowFocusListeners(panel);
  const focus = await E.windowFocus({ context, panel, serviceWorker, windowId: harness.w1 });
  await focus.prepare();
  const field = panel.locator(FIELD);
  const mark = await spyMark(panel);
  const strandAndComeBack = async (what, value) => {
    const lost = await focus.lose();
    expectWindowBlur(lost, what);
    await expectLeftOpen(panel, value, what);
    const afterLose = await focusMark(panel);
    await focusByScript(panel);
    await expectStranded(panel, afterLose, value, what);
    await focus.regain();
    await expect(panel.locator(EDIT_ROW), `${what}: the next window focus closes the field`).toHaveCount(0, { timeout: 10_000 });
    await observe(panel, OBSERVE_MS); // for the write a commit would have started
    expect(await writesSince(panel, mark), `${what}: and writes nothing`).toEqual([]);
    expect(await titlesOf(serviceWorker, ids.Reading), `${what}: Chrome's folder is as it was`).toEqual(['Link one', 'Link two']);
    await expect(E.rowTitled(panel, 'Link one'), `${what}: and the list is whole`).toHaveAttribute('data-bookmark-id', ids['Link one']);
    expect(await activeThing(panel), `${what}: focus stays where the script put it`).toBe('btn-new-tab');
    expect(await E.countWindowFocusListeners(panel), `${what}: and nothing listens for the window any more`).toBe(listeners);
  };

  await openField(panel);
  await expect(field).toHaveValue(DEFAULT_NAME);
  await strandAndComeBack('a new folder, name untouched', DEFAULT_NAME);

  await openField(panel); // the hold is gone: a new field opens
  await field.fill('');
  await strandAndComeBack('a new folder, name emptied', '');

  await pressF2On(panel, 'Link one');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await strandAndComeBack('a rename, title untouched', 'Link one');

  await pressF2On(panel, 'Link one');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.fill('');
  await strandAndComeBack('a rename, title emptied', '');

  await expectColumnFree(panel, serviceWorker, ids.Reading, 'Ext after the unchanged edits', 'unchanged');
  expect(errors).toEqual([]);
});

granted('focus moved off the field and back by script while the window has none: the field is the active element when the window is back, nothing is written, Enter commits once (premise: passes without the feature)', async ({
  context, harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Reading', children: links('A', 'B') }], ['Reading']);
  await E.installWriteSpy(panel);
  await E.watchWindowFocusListeners(panel);
  const listeners = await E.countWindowFocusListeners(panel);
  const focus = await E.windowFocus({ context, panel, serviceWorker, windowId: harness.w1 });
  await focus.prepare();
  await openField(panel);
  const field = panel.locator(FIELD);
  await field.fill(HALF);
  const mark = await spyMark(panel);

  const lost = await focus.lose();
  expectWindowBlur(lost, 'new folder');
  await focusByScript(panel);
  await expectLeftOpen(panel, HALF, 'new folder, focus moved away', { holdsFocus: false });
  await field.evaluate((el) => el.focus()); // and back, still while the window has none
  await expectLeftOpen(panel, HALF, 'new folder, focus moved back');

  await focus.regain();
  expect(await fieldState(panel), 'back: the field is the active element, so the window\'s focus changes nothing').toEqual({
    fields: 1, readOnly: false, holdsFocus: true, value: HALF, windowHasFocus: true,
  });
  await observe(panel, OBSERVE_MS);
  expect(await writesSince(panel, mark), 'back: nothing is written').toEqual([]);
  expect(await titlesOf(serviceWorker, ids.Reading), 'Chrome\'s folder is as it was').toEqual(['A', 'B']);

  await field.press('Enter');
  await expect.poll(async () => (await createsSince(panel, mark)).length, { timeout: 10_000 }).toBe(1);
  expect((await createsSince(panel, mark))[0].args).toEqual([{ parentId: ids.Reading, title: HALF }]);
  expect(await titlesOf(serviceWorker, ids.Reading)).toEqual(['A', 'B', HALF]);
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  expect(await E.countWindowFocusListeners(panel), 'the edit is over: nothing listens for the window').toBe(listeners);
  await observe(panel, OBSERVE_MS);
  expect(await createsSince(panel, mark), 'one create, not two').toHaveLength(1);
  expect(errors).toEqual([]);
});

granted('Escape after an ignored window blur ends the edit for good: nothing is listening when the window loses and regains focus again, and nothing is written', async ({
  context, harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Reading', children: links('A', 'B') }], ['Reading']);
  await E.installWriteSpy(panel);
  await E.watchWindowFocusListeners(panel);
  const listeners = await E.countWindowFocusListeners(panel);
  const focus = await E.windowFocus({ context, panel, serviceWorker, windowId: harness.w1 });
  await focus.prepare();
  await openField(panel);
  const field = panel.locator(FIELD);
  await field.fill(HALF);
  const mark = await spyMark(panel);

  const lost = await focus.lose();
  expectWindowBlur(lost, 'new folder');
  await expectLeftOpen(panel, HALF, 'new folder');
  expect(await E.countWindowFocusListeners(panel), 'the ignored blur is waiting for the window: something listens for its focus')
    .toBeGreaterThan(listeners);
  await focus.regain();
  expect(await fieldState(panel), 'back: the field kept focus, so the window\'s focus changed nothing').toEqual({
    fields: 1, readOnly: false, holdsFocus: true, value: HALF, windowHasFocus: true,
  });

  await field.press('Escape');
  await expect(panel.locator(EDIT_ROW), 'Escape closes the field').toHaveCount(0, { timeout: 10_000 });
  expect(await E.countWindowFocusListeners(panel), 'the edit is over: nothing listens for the window any more').toBe(listeners);
  expect(await writesSince(panel, mark), 'and nothing was written').toEqual([]);

  // The window loses and regains focus once more: with the edit over there is nothing for that to commit.
  await focus.lose();
  await focus.regain();
  await observe(panel, OBSERVE_MS);
  expect(await writesSince(panel, mark), 'a later window focus writes nothing').toEqual([]);
  expect(await titlesOf(serviceWorker, ids.Reading), 'Chrome\'s folder is as it was').toEqual(['A', 'B']);
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0);
  expect(await E.countWindowFocusListeners(panel), 'and still nothing listens').toBe(listeners);
  expect(errors).toEqual([]);
});

granted('closing the column with the field open and its blur ignored writes nothing when the window comes back, and leaves nothing listening', async ({
  context, harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Reading', children: links('A', 'B') }], ['Reading']);
  await E.installWriteSpy(panel);
  await E.watchWindowFocusListeners(panel);
  const listeners = await E.countWindowFocusListeners(panel);
  const focus = await E.windowFocus({ context, panel, serviceWorker, windowId: harness.w1 });
  await focus.prepare();
  await openField(panel);
  await panel.locator(FIELD).fill(HALF);
  const mark = await spyMark(panel);

  const lost = await focus.lose();
  expectWindowBlur(lost, 'new folder');
  await focusByScript(panel);
  await expectLeftOpen(panel, HALF, 'new folder', { holdsFocus: false });
  expect(await E.countWindowFocusListeners(panel), 'the ignored blur is waiting for the window: something listens for its focus')
    .toBeGreaterThan(listeners);

  // The column is taken down (the rail goes back to the tools) with the edit open: clearFrame() ends it without a write.
  await setSettings(serviceWorker, { railMode: 'tools' });
  await expect(panel.locator(EDIT_ROW), 'the column is gone, and the field with it').toHaveCount(0, { timeout: 10_000 });
  expect(await E.countWindowFocusListeners(panel), 'the edit is over: nothing listens for the window any more').toBe(listeners);

  await focus.regain();
  await observe(panel, OBSERVE_MS);
  expect(await writesSince(panel, mark), 'the window\'s focus writes nothing: closing the column with the field open saves nothing').toEqual([]);
  expect(await titlesOf(serviceWorker, ids.Reading), 'Chrome\'s folder is as it was').toEqual(['A', 'B']);
  expect(errors).toEqual([]);
});
