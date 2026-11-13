// 41-bookmark-menu-keys — the menu of a row of the bookmark column and the keys that move it (PR2 unit
// U6, criteria B9, B4.4, the menu half of B4.6, B12, B13): a right click, the ContextMenu key and Shift+F10
// open the same menu; Alt+ArrowUp / Alt+ArrowDown move the focused row one place without it.
//
// WHAT THE COLUMN PROMISES (plan.md section 3.3, D7, D8, D14):
//   - the menu of a bookmark or a folder offers a new folder (after the bookmark, inside the folder), a
//     rename, Move up, Move down and "Move to…"; a permanent folder offers the new folder only. The
//     first row's Move up and the last row's Move down are disabled, decided from what is on screen;
//   - "Move to…" lists the folders on screen, the row and everything under it left out; choosing one
//     appends the row to it with one `move` and no index, opens the folder and focuses the row;
//   - Alt+Arrow moves a row one place, writes nothing at either end, says "Moved to position P of N",
//     and leaves focus on the row (never on the row below, which is what the plain arrow does);
//   - what Chrome ends up with is what a statement written from names says (`orderOracle`), for EVERY
//     position of a folder of five and both directions, with links and with folders;
//   - the menu is the panel's own: the `contextmenu` event is cancelled, the menu closes when the rail
//     scrolls, a choice ends with focus on the affected row by id, and the keys that the name field
//     takes are not read as keys of a row.
//
// HOW IT DRIVES: the real mouse (right click, clicks on the items) and the real keyboard, in the panel
// opened as a tab with the synthesised permission (helpers/bookmarks.js says why). It is NOT a real side
// panel: whether Chrome reserves Alt+Arrow there, what its native menu does with the ContextMenu key and
// a real window blur are not exercised. Where a stand-in is used the test says so.
//
// NO FIXED PAUSES: waits are for evidence (`expect.poll`, `toBeVisible`). Time passes, in a timer of the
// PAGE (`observe`), only where the claim is that nothing happens in that time.
//
// Several tests are premises, not features: the ungranted column shows no new control and never reads
// chrome.bookmarks (B12), and the keys inside the name field (B9.7) held before this unit and have to
// keep holding. They pass on the extension of origin/feat/bookmark-folders, which has no menu; the PR
// body lists them from a measurement (t24old).
'use strict';

const fs = require('fs');
const path = require('path');
const { test, expect, launchExtensionContext } = require('../fixtures');
const { setSettings } = require('../helpers/chrome');
const { granted, seedBookmarks, showBookmarks } = require('../helpers/bookmarks');
const E = require('../helpers/bookmark-edit');
const EN = require('../../extension/_locales/en/messages.json');
const JA = require('../../extension/_locales/ja/messages.json');

const EDIT_ROW = '[data-testid="bookmark-edit-row"]';
const FIELD = '[data-testid="bookmark-rename-input"]';
const NBSP = '\u00a0';

/* ── What every test below shares ─────────────────────────────────────────── */

/** The panel's uncaught errors, collected from now on. */
function watchErrors(panel) {
  const errors = [];
  panel.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
  return errors;
}

/** The first and the second permanent folder. By position: the roots are named in the browser's language. */
const bar = (panel) => panel.locator('[data-testid="bookmark-row"][data-depth="0"]').first();
const otherRoot = (panel) => panel.locator('[data-testid="bookmark-row"][data-depth="0"]').nth(1);

/** Click a closed folder row open, if it is closed. */
async function openFolder(panel, row) {
  const target = typeof row === 'string' ? E.rowTitled(panel, row) : row;
  await expect(target).toBeVisible({ timeout: 15_000 });
  if ((await target.getAttribute('aria-expanded')) !== 'true') await target.click();
  await expect(target).toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 });
}

/**
 * Seed `spec` under the bar, switch the column on, open the bar and then each folder of `open` (titles,
 * outermost first). Returns the id of every node by title, and the id of the bar.
 */
async function openColumn(harness, serviceWorker, spec, open = [], { viewport = { width: 460, height: 900 } } = {}) {
  const { panel } = harness;
  await panel.setViewportSize(viewport);
  const { barId } = await seedBookmarks(serviceWorker, []);
  const { ids } = await E.seedTree(serviceWorker, barId, spec);
  await showBookmarks(panel, serviceWorker);
  await expect(bar(panel)).toBeVisible({ timeout: 15_000 });
  await openFolder(panel, bar(panel));
  for (const title of open) await openFolder(panel, title);
  return { barId, ids };
}

const link = (title) => ({ title, url: `https://${title.toLowerCase().replace(/[^a-z0-9]/g, '')}.example.com/` });

/** The sequence number of the newest call the write spy has seen: a point to count from. */
const spyMark = async (panel) => (await E.readWriteSpy(panel)).at(-1)?.n ?? 0;
/** Every call the panel made to chrome.bookmarks since `mark`. */
const callsSince = (panel, mark) => E.readWriteSpy(panel, mark);
/** The ones that change the tree. */
const writesSince = async (panel, mark) => (await callsSince(panel, mark))
  .filter((c) => E.WRITE_METHODS.includes(c.method));

/** What Chrome says is in a folder, as titles, in order. */
const titlesOf = async (sw, id) => (await E.childrenOf(sw, id)).map((n) => n.title);

/** The CSS selector of the one row of node `id` (for markNode / sameNode). */
const rowSelector = (id) => `[data-testid="bookmark-row"][data-bookmark-id="${id}"]`;

/**
 * Let `ms` of the PAGE's time pass, in a timer of the page. Only for "nothing happens", which cannot be
 * waited for any other way; each use says what the time is for.
 */
const observe = (panel, ms) => panel.evaluate((n) => new Promise((resolve) => { setTimeout(resolve, n); }), ms);

/** The list's children in order (rows, markers, the edit row) with what each one says. */
const listOrder = (panel) => panel.evaluate(() => [
  ...document.querySelector('[data-testid="bookmark-list"]').children,
].map((el) => ({
  testid: el.dataset.testid,
  text: el.dataset.testid === 'bookmark-edit-row'
    ? `[field:${el.querySelector('input').value}]`
    : ((el.querySelector('.w-row__main') || el).textContent || ''),
})));

/** The text the toast shows for a message with `$POS$` / `$TOTAL$` (or any other) placeholders. */
const fill = (message, values) => Object.entries(values).reduce((text, [name, value]) => text.replace(`$${name}$`, String(value)), message);

/** Right-click the row titled `title` and wait for the menu. */
async function rightClick(panel, title) {
  await E.rowTitled(panel, title).click({ button: 'right' });
  await expect(panel.locator(E.MENU), `the menu of ${title} is up`).toBeVisible({ timeout: 10_000 });
}

/** Focus the row titled `title`, press `key` and wait for the menu. */
async function keyMenu(panel, title, key) {
  await E.rowTitled(panel, title).focus();
  await panel.keyboard.press(key);
  await expect(panel.locator(E.MENU), `${key} on ${title} opens the menu`).toBeVisible({ timeout: 10_000 });
}

/** Close the menu with Escape and wait for it to go. */
async function closeMenu(panel) {
  await panel.keyboard.press('Escape');
  await expect(panel.locator(E.MENU)).toBeHidden({ timeout: 10_000 });
}

/** Strip comments from JavaScript source: enough for a file that has no `//` inside a string. */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
/** The same with the text of every string literal taken out, so that 'bm-new-folder' is not read as the name bm. */
const stripStrings = (code) => code.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");

/* ── The module itself (source scan): the only way to the tree is the write module ──── */

test('bookmark-menu.js never names chrome or bm(), reaches the tree only through the write queue, and stops no event (source scan)', () => {
  const file = path.resolve(__dirname, '../../extension/sidepanel/bookmark-menu.js');
  expect(fs.existsSync(file), 'extension/sidepanel/bookmark-menu.js exists').toBe(true);
  const code = stripComments(fs.readFileSync(file, 'utf8'));
  const bare = stripStrings(code);

  // The claim of the store text ("never deletes") rests on every call to chrome.bookmarks being a literal
  // method name at one call site (bookmarks.js) or inside bookmark-write.js. This module has neither.
  expect(bare, 'no chrome.* at all').not.toMatch(/\bchrome\b/);
  expect(bare, 'no bm in any form (bm(...), host.bm, host["bm"])').not.toMatch(/\bbm\b/);
  expect(bare, 'no bracket access to the host, which could hide a call').not.toMatch(/host\s*\[/);

  // What the host is asked for: the name field, the paint and the focus, the model, the toast. Nothing that writes.
  const used = [...new Set([...bare.matchAll(/\bhost\.(\w+)/g)].map((m) => m[1]))].sort();
  expect(used, 'the host methods this module calls').toEqual(
    ['beginCreate', 'beginRename', 'expand', 'focusRowById', 'log', 'paintNow', 'rows', 'toast'],
  );

  // The writes it starts: the two of the write module, each one inside the queue.
  const writes = [...bare.matchAll(/\b(createFolder|renameNode|moveToPosition|moveRelative)\s*\(/g)].map((m) => m[1]).sort();
  expect(writes, 'the write-module functions it calls').toEqual(['moveRelative', 'moveToPosition']);
  expect(bare, 'moveRelative only inside queue()').toMatch(/queue\(\(\) => moveRelative\(host,/);
  expect(bare, 'moveToPosition only inside queue()').toMatch(/queue\(\(\) => moveToPosition\(host,/);

  // Other code reads these events too (bookmark-preview.js hides its card on the list's contextmenu).
  expect(bare, 'stopPropagation on none of the events').not.toMatch(/stopPropagation|stopImmediatePropagation/);
  expect(bare, 'the native menu is cancelled').toMatch(/event\.preventDefault\(\)/);

  // What it imports: the translations, the pure maths, the write module and the panel's menu. Nothing else.
  const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]).sort();
  expect(imports).toEqual(['../common/i18n.js', './bookmark-math.js', './bookmark-write.js', './context-menu.js']);
});

/* ── B9.1: Alt+Arrow, every position, both directions ─────────────────────── */

/**
 * A folder of `kids`, each moved with Alt+ArrowDown and with Alt+ArrowUp from every position it can be at.
 * At the end of the folder nothing may be called at all; elsewhere the order Chrome ends with is the
 * oracle's, the one `move` has the index the rule of Probe 13 names (the gap), the toast says where the
 * row is now, and focus is on that row. Every cell starts from the seeded order, put back from the service
 * worker, and none is sampled.
 */
async function keyMatrix(harness, serviceWorker, kids) {
  const { panel } = harness;
  const errors = watchErrors(panel);
  const titles = kids.map((k) => k.title);
  const n = titles.length;
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Group', children: kids }], ['Group']);
  await E.installWriteSpy(panel);
  await E.recordToastTexts(panel);
  const seeded = titles.map((title) => ids[title]);
  let moves = 0;
  let ends = 0;

  for (let s = 0; s < n; s += 1) {
    for (const key of ['ArrowDown', 'ArrowUp']) {
      const down = key === 'ArrowDown';
      const source = titles[s];
      const where = `${source} (position ${s + 1} of ${n}) with Alt+${key}`;
      await E.rowTitled(panel, source).focus();
      expect(await E.activeRowId(panel), `${where}: the row has focus before the key`).toBe(ids[source]);
      const mark = await spyMark(panel);
      await E.recordToastTexts(panel);
      await panel.keyboard.press(`Alt+${key}`);

      if (down ? s === n - 1 : s === 0) {
        // The end of the folder: not a call of any kind (not even a read), no toast, no move of focus.
        await observe(panel, 300); // nothing is going to happen; this is the time it would have had to
        expect(await callsSince(panel, mark), `${where}: not one call at the end of the folder`).toEqual([]);
        expect(await E.readToastTexts(panel), `${where}: nothing is said`).toEqual([]);
        expect(await E.activeRowId(panel), `${where}: focus stays on the row, it did not step to a neighbour`).toBe(ids[source]);
        expect(await titlesOf(serviceWorker, ids.Group), `${where}: the folder is as it was`).toEqual(titles);
        ends += 1;
        continue;
      }

      // The item is to be placed BEFORE the child that is at `gap` now (n = after the last one): the row
      // below it is one place down, which is the child two places on.
      const gap = down ? s + 2 : s - 1;
      const expected = E.orderOracle(titles, source, gap);
      await expect.poll(() => titlesOf(serviceWorker, ids.Group), {
        timeout: 15_000, message: `${where}: Chrome's order is the oracle's`,
      }).toEqual(expected);
      const writes = await writesSince(panel, mark);
      expect(writes.map((c) => c.method), `${where}: one write, a move`).toEqual(['move']);
      expect(writes[0].args, `${where}: into the same folder at the index of the gap`)
        .toEqual([ids[source], { parentId: ids.Group, index: gap }]);

      const position = expected.indexOf(source) + 1;
      await expect.poll(() => E.readToastTexts(panel), {
        timeout: 10_000, message: `${where}: the toast says where the row is now`,
      }).toEqual([`Moved to position ${position} of ${n}`]);
      await expect.poll(() => E.activeRowId(panel), {
        timeout: 10_000, message: `${where}: focus is on the row that moved`,
      }).toBe(ids[source]);
      await expect.poll(() => E.domChildren(panel, ids.Group), {
        timeout: 15_000, message: `${where}: the rows on screen follow Chrome's order`,
      }).toEqual(expected);
      moves += 1;

      await E.restoreOrder(serviceWorker, ids.Group, seeded);
      await expect.poll(() => E.domChildren(panel, ids.Group), {
        timeout: 15_000, message: `${where}: the column shows the seeded order again`,
      }).toEqual(titles);
    }
  }
  expect({ moves, ends }, 'of 2 x 5 cells, 8 move and the 2 at the ends do not').toEqual({ moves: 8, ends: 2 });
  expect(errors, 'the panel threw nothing').toEqual([]);
}

granted('B9.1 Alt+ArrowDown and Alt+ArrowUp on every position of a folder of five links: the oracle\'s order, nothing at the ends, the toast, the focus', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(420_000);
  await keyMatrix(harness, serviceWorker, ['A', 'B', 'C', 'D', 'E'].map(link));
});

granted('B9.1 the same with folders among the links: a folder moves like a link, closed, with what is in it', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(420_000);
  await keyMatrix(harness, serviceWorker, [
    link('A'),
    { title: 'B', children: [link('B child')] },
    link('C'),
    { title: 'D', children: [link('D child one'), link('D child two')] },
    { title: 'E', children: [] },
  ]);
});

/* ── B9.2: the menu's Move up and Move down ───────────────────────────────── */

granted('B9.2 the menu\'s Move up and Move down give the same results, are disabled at the ends, and a disabled one writes nothing', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(420_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const titles = ['A', 'B', 'C', 'D', 'E'];
  const n = titles.length;
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Group', children: titles.map(link) }], ['Group']);
  await E.installWriteSpy(panel);
  await E.recordToastTexts(panel);
  const seeded = titles.map((title) => ids[title]);
  let moves = 0;
  let refusals = 0;

  for (let s = 0; s < n; s += 1) {
    for (const which of ['up', 'down']) {
      const up = which === 'up';
      const source = titles[s];
      const where = `${source} (position ${s + 1} of ${n}) with Move ${which}`;
      await rightClick(panel, source);
      const item = E.menuItem(panel, `bm-${which}`);
      const disabled = up ? s === 0 : s === n - 1;
      const menu = await E.readMenu(panel);
      const entry = menu.items.find((i) => i.id === `bm-${which}`);
      expect(entry, `${where}: the item is in the menu`).toBeDefined();
      expect(entry.disabled, `${where}: disabled as the property`).toBe(disabled);
      expect(entry.ariaDisabled, `${where}: and as aria-disabled`).toBe(disabled ? 'true' : null);
      expect(menu.items.filter((i) => ['bm-up', 'bm-down'].includes(i.id)).map((i) => i.disabled),
        `${where}: the other one of the pair is judged by its own end`)
        .toEqual([s === 0, s === n - 1]);

      const mark = await spyMark(panel);
      await E.recordToastTexts(panel);
      if (disabled) {
        // A click on it: the browser delivers none to a disabled button, so nothing happens and the menu stays.
        await item.click({ force: true });
        await observe(panel, 300); // nothing is going to happen; this is the time it would have had to
        expect(await callsSince(panel, mark), `${where}: a click on the disabled item calls nothing`).toEqual([]);
        expect((await E.readMenu(panel)).open, `${where}: and does not close the menu`).toBe(true);
        // And if it were not disabled, the choice itself still finds the end and does nothing: the
        // write module's reads are calls too, so there are none of those either.
        await item.evaluate((el) => { el.disabled = false; el.click(); });
        await observe(panel, 300);
        expect(await callsSince(panel, mark), `${where}: chosen all the same, it still calls nothing`).toEqual([]);
        expect(await E.readToastTexts(panel), `${where}: and says nothing`).toEqual([]);
        expect(await titlesOf(serviceWorker, ids.Group), `${where}: the folder is as it was`).toEqual(titles);
        refusals += 1;
        continue;
      }

      await item.click();
      const gap = up ? s - 1 : s + 2;
      const expected = E.orderOracle(titles, source, gap);
      await expect.poll(() => titlesOf(serviceWorker, ids.Group), {
        timeout: 15_000, message: `${where}: Chrome's order is the oracle's`,
      }).toEqual(expected);
      const writes = await writesSince(panel, mark);
      expect(writes.map((c) => c.method), `${where}: one write, a move`).toEqual(['move']);
      expect(writes[0].args, `${where}: the same call as the key makes`)
        .toEqual([ids[source], { parentId: ids.Group, index: gap }]);
      await expect.poll(() => E.readToastTexts(panel), {
        timeout: 10_000, message: `${where}: the toast`,
      }).toEqual([`Moved to position ${expected.indexOf(source) + 1} of ${n}`]);
      await expect.poll(() => E.activeRowId(panel), {
        timeout: 10_000, message: `${where}: focus is on the row that moved`,
      }).toBe(ids[source]);
      expect((await E.readMenu(panel)).open, `${where}: the menu is closed`).toBe(false);
      moves += 1;

      await E.restoreOrder(serviceWorker, ids.Group, seeded);
      await expect.poll(() => E.domChildren(panel, ids.Group), {
        timeout: 15_000, message: `${where}: the column shows the seeded order again`,
      }).toEqual(titles);
    }
  }
  expect({ moves, refusals }, 'of 2 x 5 cells, 8 move and the 2 at the ends are refused').toEqual({ moves: 8, refusals: 2 });
  expect(errors, 'the panel threw nothing').toEqual([]);
});

/* ── B9.3: what the menu offers, for each kind of row ─────────────────────── */

granted('B9.3 the menu of a link, of a folder and of a permanent folder: their items, in order, in the panel\'s own menu; the contextmenu event is cancelled', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [
    { title: 'Group', children: [link('Link one'), { title: 'Sub', children: [link('Sub child')] }, link('Link two')] },
  ], ['Group']);
  await E.watchContextMenuEvents(panel);
  await E.installWriteSpy(panel);
  const mark = await spyMark(panel);

  const all = ['bm-new-folder', 'bm-rename', 'bm-up', 'bm-down', 'bm-move-to'];
  // `disabled`: Link one is the first of its folder (no Move up), Link two the last (no Move down).
  const cases = [
    { what: 'a link', row: E.rowTitled(panel, 'Link one'), kind: 'link', items: all, disabled: ['bm-up'] },
    { what: 'a folder', row: E.rowTitled(panel, 'Sub'), kind: 'folder', items: all, disabled: [] },
    { what: 'the last link', row: E.rowTitled(panel, 'Link two'), kind: 'link', items: all, disabled: ['bm-down'] },
    { what: 'a permanent folder', row: bar(panel), kind: 'root', items: ['bm-new-folder'], disabled: [] },
    { what: 'the other permanent folder', row: otherRoot(panel), kind: 'root', items: ['bm-new-folder'], disabled: [] },
  ];
  for (const c of cases) {
    const where = c.what;
    const rowId = await c.row.getAttribute('data-bookmark-id');
    const title = await c.row.locator('.w-row__main').textContent();
    await c.row.click({ button: 'right' });
    await expect(panel.locator(E.MENU), `${where}: the panel's own menu is up`).toBeVisible({ timeout: 10_000 });
    const events = await E.readContextMenuEvents(panel);
    expect(events.at(-1), `${where}: the contextmenu event was cancelled, so the browser's menu is not what is shown`)
      .toEqual({ prevented: true, on: rowId });

    const menu = await E.readMenu(panel);
    expect(menu.menus, `${where}: exactly one menu`).toBe(1);
    expect(menu.items.map((i) => i.id), `${where}: the items, in order`).toEqual(c.items);
    expect(menu.items.filter((i) => i.disabled).map((i) => i.id), `${where}: what is disabled`).toEqual(c.disabled);
    const labels = Object.fromEntries(menu.items.map((i) => [i.id, i.label]));
    expect(labels['bm-new-folder'], `${where}: the new-folder item: plain after a link, naming the folder inside a folder`)
      .toBe(c.kind === 'link' ? EN.bookmarksNewFolder.message : fill(EN.bookmarksNewFolderIn.message, { FOLDER: title }));
    if (c.items.length > 1) {
      expect(labels, `${where}: the other labels`).toMatchObject({
        'bm-rename': EN.bookmarksRename.message,
        'bm-up': EN.bookmarksMoveUp.message,
        'bm-down': EN.bookmarksMoveDown.message,
        'bm-move-to': EN.bookmarksMoveTo.message,
      });
      expect(menu.items.find((i) => i.id === 'bm-move-to').parent, `${where}: Move to… opens a submenu`).toBe(true);
    }
    await closeMenu(panel);
    expect(await E.activeRowId(panel), `${where}: Escape gives the row its focus back`).toBe(rowId);
  }

  // A right click on the name field keeps the browser's own menu (copy and paste): the event is not
  // cancelled and nothing of ours opens.
  await E.rowTitled(panel, 'Link one').focus();
  await panel.keyboard.press('F2');
  await expect(panel.locator(FIELD)).toBeFocused({ timeout: 10_000 });
  await E.watchContextMenuEvents(panel);
  await panel.locator(FIELD).click({ button: 'right' });
  const onField = await E.readContextMenuEvents(panel);
  expect(onField.length, 'one contextmenu event, on the field').toBe(1);
  expect(onField[0].prevented, 'and not cancelled: the browser\'s menu stays for the text').toBe(false);
  expect((await E.readMenu(panel)).open, 'no menu of ours on the field').toBe(false);
  await panel.locator(FIELD).press('Escape');
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });

  expect(await writesSince(panel, mark), 'looking at menus wrote nothing').toEqual([]);
  expect(errors).toEqual([]);
});

granted('a node Chrome marks unmodifiable gets a menu with every write disabled and no rename, and neither it nor a permanent folder moves with Alt+Arrow (the flag is a stand-in: no managed bookmark can be made here)', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [
    { title: 'Group', children: [link('Plain one'), link('Managed link'), link('Plain two')] },
  ], ['Group']);
  await E.installWriteSpy(panel);
  // Chrome has never been seen to set the flag (Probe 13 P5, P12), so the panel's own read is made to
  // report it for one bookmark. That is a STAND-IN for the flag; what it shows is that the menu reads the
  // flag and acts on it, as the drag and the F2 rename already do.
  await panel.evaluate((id) => {
    const real = chrome.bookmarks.getChildren;
    chrome.bookmarks.getChildren = async (...args) => (await real.apply(chrome.bookmarks, args))
      .map((node) => (node.id === id ? { ...node, unmodifiable: 'managed' } : node));
  }, ids['Managed link']);
  await E.externalWrite(serviceWorker, (a) => chrome.bookmarks.create(a),
    { parentId: ids.Group, title: 'Trigger', url: 'https://trigger.example.com/' });
  await expect(E.rowTitled(panel, 'Trigger'), 'a repaint that read the flag').toBeVisible({ timeout: 10_000 });

  await rightClick(panel, 'Managed link');
  const managed = await E.readMenu(panel);
  expect(managed.items.map((i) => i.id), 'no rename; the rest is there').toEqual(['bm-new-folder', 'bm-up', 'bm-down', 'bm-move-to']);
  expect(managed.items.map((i) => i.disabled), 'and all of it is disabled').toEqual([true, true, true, true]);
  await closeMenu(panel);

  // Alt+Arrow on it: nothing is called, focus does not step to a neighbour, and the key is not claimed.
  await E.rowTitled(panel, 'Managed link').focus();
  await panel.evaluate(() => {
    window.__u6Keys = [];
    document.addEventListener('keydown', (e) => { if (e.altKey && e.key.startsWith('Arrow')) window.__u6Keys.push(e.defaultPrevented); });
  });
  const mark = await spyMark(panel);
  await panel.keyboard.press('Alt+ArrowDown');
  await observe(panel, 300); // nothing is going to happen; this is the time it would have had to
  expect(await callsSince(panel, mark), 'no call at all').toEqual([]);
  expect(await E.activeRowId(panel), 'focus stayed on the row').toBe(ids['Managed link']);
  expect(await panel.evaluate(() => window.__u6Keys), 'the key was not claimed').toEqual([false]);

  // A permanent folder cannot move either: nothing is called and focus does not step to the next row.
  await bar(panel).focus();
  const markRoot = await spyMark(panel);
  await panel.keyboard.press('Alt+ArrowDown');
  await observe(panel, 300); // nothing is going to happen; this is the time it would have had to
  expect(await callsSince(panel, markRoot), 'a permanent folder: no call at all').toEqual([]);
  expect(await E.activeRowId(panel), 'and focus stayed on it').toBe(await bar(panel).getAttribute('data-bookmark-id'));

  // A row that is not marked still has the whole menu.
  await rightClick(panel, 'Plain two');
  expect((await E.readMenu(panel)).items.map((i) => i.id)).toEqual(['bm-new-folder', 'bm-rename', 'bm-up', 'bm-down', 'bm-move-to']);
  await closeMenu(panel);
  expect(errors).toEqual([]);
});

/* ── B9.4: the ContextMenu key and Shift+F10 ──────────────────────────────── */

granted('B9.4 the ContextMenu key and Shift+F10 open the same menu at the row, one menu; Escape closes it and gives the row its focus back', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [
    { title: 'Group', children: [link('Link one'), { title: 'Sub', children: [link('Sub child')] }, link('Link two')] },
  ], ['Group']);
  await E.installWriteSpy(panel);
  await E.watchContextMenuEvents(panel);
  await panel.evaluate(() => {
    window.__u6KeyLog = [];
    document.addEventListener('keydown', (e) => window.__u6KeyLog.push({ key: e.key, shift: e.shiftKey, prevented: e.defaultPrevented }));
  });
  const mark = await spyMark(panel);

  let first = null;
  for (const [key, title] of [['ContextMenu', 'Link one'], ['Shift+F10', 'Link one'], ['ContextMenu', 'Sub'], ['Shift+F10', 'Sub']]) {
    const where = `${key} on ${title}`;
    await keyMenu(panel, title, key);
    const menu = await E.readMenu(panel);
    expect(menu.menus, `${where}: exactly one menu`).toBe(1);
    expect(menu.items.map((i) => i.id), `${where}: the items of the row's kind`)
      .toEqual(['bm-new-folder', 'bm-rename', 'bm-up', 'bm-down', 'bm-move-to']);
    if (title === 'Link one') {
      first ||= menu;
      expect(menu.items, `${where}: the same menu both keys open`).toEqual(first.items);
    }
    // At the row: its bottom edge, and over its width.
    const rowBox = await E.rowTitled(panel, title).boundingBox();
    expect(Math.abs(menu.box.y - (rowBox.y + rowBox.height)), `${where}: the menu hangs from the row's bottom edge`).toBeLessThanOrEqual(2);
    expect(menu.box.x < rowBox.x + rowBox.width && menu.box.x + menu.box.width > rowBox.x, `${where}: and is over the row`).toBe(true);
    const log = await panel.evaluate(() => window.__u6KeyLog.filter((e) => e.key === 'ContextMenu' || e.key === 'F10'));
    expect(log.at(-1).prevented, `${where}: the key was claimed (the browser's own menu is not asked for)`).toBe(true);
    await closeMenu(panel);
    expect(await E.activeRowId(panel), `${where}: Escape gives the row its focus back`).toBe(ids[title]);
  }

  // A permanent folder: its single item.
  await bar(panel).focus();
  await panel.keyboard.press('Shift+F10');
  await expect(panel.locator(E.MENU)).toBeVisible({ timeout: 10_000 });
  expect((await E.readMenu(panel)).items.map((i) => i.id), 'a permanent folder: the new folder only').toEqual(['bm-new-folder']);
  await closeMenu(panel);

  // Chrome can follow the key with a contextmenu event of its own: one menu still, and Escape still
  // gives the ROW its focus back (the second opening must not take a menu item for the place to return to).
  await keyMenu(panel, 'Link two', 'Shift+F10');
  await panel.evaluate((id) => {
    document.querySelector(`[data-bookmark-id="${id}"]`).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }));
  }, ids['Link two']);
  const twice = await E.readMenu(panel);
  expect(twice.menus, 'a second event: still exactly one menu').toBe(1);
  expect(twice.items.map((i) => i.id)).toEqual(['bm-new-folder', 'bm-rename', 'bm-up', 'bm-down', 'bm-move-to']);
  await closeMenu(panel);
  expect(await E.activeRowId(panel), 'and Escape returns to the row, not to a menu item that is gone').toBe(ids['Link two']);

  // F10 alone is not a menu key, and Ctrl+ContextMenu is not ours either.
  await E.rowTitled(panel, 'Link one').focus();
  await panel.evaluate(() => { window.__u6KeyLog.length = 0; });
  await panel.keyboard.press('F10');
  await panel.keyboard.press('Control+ContextMenu');
  await observe(panel, 300); // nothing is going to happen; this is the time it would have had to
  expect((await E.readMenu(panel)).open, 'F10 on its own and Ctrl+ContextMenu open nothing').toBe(false);
  expect((await panel.evaluate(() => window.__u6KeyLog)).filter((e) => e.prevented), 'and neither key was claimed').toEqual([]);
  expect(await writesSince(panel, mark), 'opening menus wrote nothing').toEqual([]);
  expect(errors).toEqual([]);
});

granted('Escape gives focus back to the row the menu was opened on, also when the event that opened it moved no focus (a long press may not)', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [
    { title: 'Group', children: ['A', 'B', 'C'].map(link) },
  ], ['Group']);
  await E.rowTitled(panel, 'A').focus();
  expect(await E.activeRowId(panel), 'focus starts on A').toBe(ids.A);
  // A `contextmenu` aimed at C. Nothing about it moves focus: that is what a real pointer's press does,
  // and a script (or a touch screen's long press) may not.
  await panel.evaluate((id) => {
    document.querySelector(`[data-bookmark-id="${id}"]`)
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }));
  }, ids.C);
  await expect(panel.locator(E.MENU)).toBeVisible({ timeout: 10_000 });
  expect((await E.readMenu(panel)).items.filter((i) => i.disabled).map((i) => i.id), 'it is the menu of C, the last one: no Move down')
    .toEqual(['bm-down']);
  await closeMenu(panel);
  expect(await E.activeRowId(panel), 'Escape: focus is on C, the row the menu belongs to, not on A where it was').toBe(ids.C);
  expect(errors).toEqual([]);
});

granted('only plain Alt+Arrow moves a row: with Ctrl, Shift or Meta as well nothing is called', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [
    { title: 'Group', children: ['A', 'B', 'C'].map(link) },
  ], ['Group']);
  await E.installWriteSpy(panel);
  const mark = await spyMark(panel);
  for (const chord of ['Control+Alt+ArrowDown', 'Shift+Alt+ArrowDown', 'Meta+Alt+ArrowDown', 'Control+Alt+ArrowUp', 'Shift+Alt+ArrowUp', 'Meta+Alt+ArrowUp']) {
    await E.rowTitled(panel, 'B').focus();
    await panel.keyboard.press(chord);
    await observe(panel, 200); // nothing is going to be called; this is the time it would have had to
    expect(await callsSince(panel, mark), `${chord}: not one call`).toEqual([]);
  }
  expect(await titlesOf(serviceWorker, ids.Group), 'the folder is as it was').toEqual(['A', 'B', 'C']);
  expect(errors).toEqual([]);
});

/* ── B9.5: Move to… ───────────────────────────────────────────────────────── */

/**
 * The folders on screen that "Move to…" may offer for the row `id`, read from the DOM: every folder row
 * except that row and the rows under it (the ones after it that are deeper). `depth` is the row's.
 */
const offeredFolders = (panel, id) => panel.evaluate((rowId) => {
  const rows = [...document.querySelectorAll('[data-testid="bookmark-row"]')];
  const at = rows.findIndex((r) => r.dataset.bookmarkId === rowId);
  const depth = Number(rows[at].dataset.depth);
  let end = at + 1;
  while (end < rows.length && Number(rows[end].dataset.depth) > depth) end += 1;
  return rows
    .map((r, i) => ({ r, i }))
    .filter(({ r, i }) => r.dataset.kind === 'folder' && (i < at || i >= end))
    .map(({ r }) => ({ id: r.dataset.bookmarkId, depth: Number(r.dataset.depth), title: r.querySelector('.w-row__main').textContent }));
}, id);

/**
 * Open the menu of the row `title`, then its "Move to…" list, and read both. The list opens when the pointer is
 * on the item, as it does for a person; a click on the item AFTER that closes it again (`context-menu.js`
 * toggles on a click, for every submenu of the panel), so the item is hovered and not clicked.
 */
async function openMoveTo(panel, title) {
  await rightClick(panel, title);
  await E.menuItem(panel, 'bm-move-to').hover();
  await expect(panel.locator(E.SUBMENU), 'the list of folders is up').toBeVisible({ timeout: 10_000 });
  return E.readMenu(panel);
}

/** The tree for the Move to… tests: folders three deep, a collapsed one with something in it, an empty one. */
/** `V` is open and empty: its "Empty" line is a row of the model that must not be offered as a second folder V. */
const MOVE_TREE = [{
  title: 'P',
  children: [
    link('P1'),
    { title: 'Q', children: [link('Q1'), { title: 'R', children: [link('R1')] }] },
    { title: 'S', children: [link('S1')] },
  ],
}, {
  title: 'T', children: [link('T1')],
}, {
  title: 'U', children: [],
}, {
  title: 'V', children: [],
}, link('L')];

granted('B9.5 Move to… lists the folders on screen, the row and what is under it left out; choosing one is one move with no index, opens the folder and focuses the row', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(420_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, MOVE_TREE, ['P', 'Q', 'V']);
  await E.installWriteSpy(panel);
  await E.recordToastTexts(panel);
  const add = panel.locator('[data-testid="bookmark-add"]');
  const addTitle = await add.getAttribute('title');

  // 1. A folder with folders under it (one of them open, one shut): they are not offered, and neither is it.
  const expectedP = await offeredFolders(panel, ids.P);
  expect(expectedP.map((f) => f.depth), 'the two permanent folders and, between them, T, U and V (P, Q, R and S are P\'s own)')
    .toEqual([0, 1, 1, 1, 0]);
  expect(expectedP.slice(1, 4).map((f) => f.title)).toEqual(['T', 'U', 'V']);
  await expect(panel.locator('.bmk-empty-row'), 'V is open and shows its Empty line, which is not a folder').toHaveCount(1);
  let menu = await openMoveTo(panel, 'P');
  expect(menu.menus, 'the menu and its list: two menu elements').toBe(2);
  expect(menu.submenu.map((i) => i.id), 'P: the folders offered, in the column\'s order')
    .toEqual(expectedP.map((f) => `bm-moveto-${f.id}`));
  expect(menu.submenu.map((i) => i.label), 'and indented by depth, two no-break spaces a level')
    .toEqual(expectedP.map((f) => NBSP.repeat(2 * f.depth) + f.title));
  for (const gone of ['P', 'Q', 'R', 'S']) {
    expect(menu.submenu.map((i) => i.id), `${gone} is not offered`).not.toContain(`bm-moveto-${ids[gone]}`);
  }
  expect(menu.submenu.every((i) => !i.disabled), 'all of them are choices').toBe(true);
  await closeMenu(panel);

  // 2. A link: every folder on screen, nested ones included, its own folder too.
  const expectedL = await offeredFolders(panel, ids.L);
  menu = await openMoveTo(panel, 'L');
  expect(menu.submenu.map((i) => i.id), 'L: every folder on screen').toEqual(expectedL.map((f) => `bm-moveto-${f.id}`));
  for (const shown of ['P', 'Q', 'R', 'S', 'T', 'U', 'V']) {
    expect(menu.submenu.map((i) => i.id), `${shown} is offered to a link`).toContain(`bm-moveto-${ids[shown]}`);
  }
  await closeMenu(panel);

  // 3. Choose a shut folder with a child: one move, appended, no index; the folder opens; the row is under it.
  const before = await E.subtreeOf(serviceWorker, ids.P);
  const mark = await spyMark(panel);
  await openMoveTo(panel, 'P');
  await E.menuItem(panel, `bm-moveto-${ids.T}`).click();
  await expect.poll(() => titlesOf(serviceWorker, ids.T), { timeout: 15_000, message: 'P is the last child of T' }).toEqual(['T1', 'P']);
  const writes = await writesSince(panel, mark);
  expect(writes.map((c) => c.method), 'one write, a move').toEqual(['move']);
  expect(writes[0].args, 'into T, and no index: appending cannot go stale').toEqual([ids.P, { parentId: ids.T }]);
  expect(writes[0].keys[1], 'the options object has no index key at all').toEqual(['parentId']);
  const after = await E.subtreeOf(serviceWorker, ids.P);
  const bare = (node) => ({ ...node, parentId: undefined, index: undefined });
  expect(bare(after), 'P moved whole: the same ids, titles and order under it').toEqual(bare(before));
  await expect(E.rowTitled(panel, 'T'), 'T is open now').toHaveAttribute('aria-expanded', 'true', { timeout: 15_000 });
  await expect.poll(() => E.domChildren(panel, ids.T), { timeout: 15_000 }).toEqual(['T1', 'P']);
  await expect.poll(() => E.activeRowId(panel), { timeout: 10_000, message: 'focus is on the row that moved' }).toBe(ids.P);
  await expect.poll(() => E.readToastTexts(panel), { timeout: 10_000 }).toEqual(['Moved to position 2 of 2']);
  expect(await add.getAttribute('title'), 'opening T by a move does not change where the bookmark button writes').toBe(addTitle);

  // 4. A link into an EMPTY folder, and into a permanent folder that is shut.
  await E.recordToastTexts(panel);
  await openMoveTo(panel, 'L');
  await E.menuItem(panel, `bm-moveto-${ids.U}`).click();
  await expect.poll(() => titlesOf(serviceWorker, ids.U), { timeout: 15_000, message: 'L is U\'s only child' }).toEqual(['L']);
  await expect(E.rowTitled(panel, 'U')).toHaveAttribute('aria-expanded', 'true', { timeout: 15_000 });
  await expect.poll(() => E.readToastTexts(panel), { timeout: 10_000 }).toEqual(['Moved to position 1 of 1']);
  await expect.poll(() => E.activeRowId(panel), { timeout: 10_000 }).toBe(ids.L);

  const otherId = await otherRoot(panel).getAttribute('data-bookmark-id');
  await expect(otherRoot(panel)).toHaveAttribute('aria-expanded', 'false');
  const menuOfL = await openMoveTo(panel, 'L');
  expect(menuOfL.submenu.map((i) => i.id), 'a permanent folder is a destination').toContain(`bm-moveto-${otherId}`);
  await E.menuItem(panel, `bm-moveto-${otherId}`).click();
  await expect.poll(() => titlesOf(serviceWorker, otherId), { timeout: 15_000, message: 'L is in Other bookmarks' }).toEqual(['L']);
  await expect(otherRoot(panel), 'and the permanent folder is open').toHaveAttribute('aria-expanded', 'true', { timeout: 15_000 });
  await expect.poll(() => E.activeRowId(panel), { timeout: 10_000 }).toBe(ids.L);

  // 5. Its own folder is a destination like any other: the last row asked to go to the end of its folder
  //    changes nothing, and says nothing.
  await E.recordToastTexts(panel);
  const mark5 = await spyMark(panel);
  await openMoveTo(panel, 'L');
  await E.menuItem(panel, `bm-moveto-${otherId}`).click();
  await observe(panel, 400); // nothing is going to be written; this is the time it would have had to
  expect(await writesSince(panel, mark5), 'already last in that folder: no write').toEqual([]);
  expect(await E.readToastTexts(panel)).toEqual([]);
  expect((await E.readMenu(panel)).open, 'the menu closed').toBe(false);
  expect(errors).toEqual([]);
});

granted('B9.5 a folder that has gone between the opening of the menu and the choice is not written to: the reader is told, nothing throws', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [
    { title: 'Group', children: [link('X'), { title: 'Gone', children: [link('Gone child')] }, { title: 'Kept', children: [] }] },
  ], ['Group']);
  await E.installWriteSpy(panel);
  await E.recordToastTexts(panel);
  await openMoveTo(panel, 'X');
  const goneItem = E.menuItem(panel, `bm-moveto-${ids.Gone}`);
  await expect(goneItem, 'it is offered').toBeVisible();

  await E.externalWrite(serviceWorker, (id) => chrome.bookmarks.removeTree(id), ids.Gone);
  await expect(E.rowTitled(panel, 'Gone'), 'the column has heard of it').toHaveCount(0, { timeout: 15_000 });
  await expect(goneItem, 'the open menu still offers it: it was built before').toBeVisible();

  const mark = await spyMark(panel);
  await goneItem.click();
  await expect.poll(() => E.readToastTexts(panel), { timeout: 10_000, message: 'the reader is told' }).toEqual([EN.bookmarksStale.message]);
  await observe(panel, 400); // nothing is going to be written; this is the time it would have had to
  expect(await callsSince(panel, mark), 'no call of any kind: the folder is not in the list any more').toEqual([]);
  expect(await titlesOf(serviceWorker, ids.Group), 'X is where it was').toEqual(['X', 'Kept']);
  expect(await E.activeRowId(panel), 'and focus is still on it').toBe(ids.X);
  expect(errors).toEqual([]);
});

granted('B9.5 if the column has not heard yet that the folder is gone, Chrome refuses the move and the reader is told so: nothing is written, nothing throws', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [
    { title: 'Group', children: [link('X'), { title: 'Gone', children: [link('Gone child')] }, { title: 'Kept', children: [] }] },
  ], ['Group']);
  await E.installWriteSpy(panel);
  await E.installReadGate(panel);
  await E.recordToastTexts(panel);
  await openMoveTo(panel, 'X');

  // The panel's repaint after the removal is held at its first read, so what the panel knows stays as it was.
  await E.armReadGate(panel);
  await E.externalWrite(serviceWorker, (id) => chrome.bookmarks.removeTree(id), ids.Gone);
  await expect.poll(async () => (await E.readGate(panel)).held, { timeout: 15_000, message: 'the repaint is waiting for its read' }).toBeGreaterThan(0);
  await expect(E.rowTitled(panel, 'Gone'), 'the column still shows the folder').toHaveCount(1);

  const mark = await spyMark(panel);
  await E.menuItem(panel, `bm-moveto-${ids.Gone}`).click();
  await expect.poll(() => E.readToastTexts(panel), { timeout: 10_000, message: 'the reader is told' }).toEqual([EN.operationFailed.message]);
  const moves = (await callsSince(panel, mark)).filter((c) => c.method === 'move');
  expect(moves.map((c) => [c.status, c.args]), 'one move, which Chrome refused').toEqual([['rejected', [ids.X, { parentId: ids.Gone }]]]);
  expect(await titlesOf(serviceWorker, ids.Group), 'X is where it was').toEqual(['X', 'Kept']);

  await E.openReadGate(panel);
  await expect(E.rowTitled(panel, 'Gone'), 'and once the column hears, the folder is gone from it').toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => E.activeRowId(panel), { timeout: 10_000, message: 'focus is on the row that did not move' }).toBe(ids.X);
  expect(errors).toEqual([]);
});

granted('B9.5 Move to… is reachable without a pointer: the menu key, End, Right, the arrows, Enter', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [
    { title: 'Group', children: [link('X'), link('Y'), link('Z'), { title: 'Dest', children: [link('Dest child')] }] },
  ], ['Group']);
  await E.installWriteSpy(panel);
  await E.recordToastTexts(panel);
  const mark = await spyMark(panel);

  await keyMenu(panel, 'Y', 'Shift+F10');
  await panel.keyboard.press('End'); // the last item of the menu is Move to…
  await panel.keyboard.press('ArrowRight'); // and Right opens its list and takes focus into it
  const menu = await E.readMenu(panel);
  expect(menu.submenu, 'the list is up').not.toBeNull();
  const at = menu.submenu.findIndex((i) => i.id === `bm-moveto-${ids.Dest}`);
  expect(at, 'Dest is in it').toBeGreaterThanOrEqual(0);
  for (let i = 0; i < at; i += 1) await panel.keyboard.press('ArrowDown');
  await panel.keyboard.press('Enter');

  await expect.poll(() => titlesOf(serviceWorker, ids.Dest), { timeout: 15_000, message: 'Y is the last child of Dest' }).toEqual(['Dest child', 'Y']);
  const writes = await writesSince(panel, mark);
  expect(writes.map((c) => [c.method, c.args]), 'one move, appended, no index').toEqual([['move', [ids.Y, { parentId: ids.Dest }]]]);
  await expect.poll(() => E.activeRowId(panel), { timeout: 10_000, message: 'focus is on the row that moved' }).toBe(ids.Y);
  await expect.poll(() => E.readToastTexts(panel), { timeout: 10_000 }).toEqual(['Moved to position 2 of 2']);
  expect(errors).toEqual([]);
});

granted('Move to… indents by two no-break spaces a level and stops at the five levels the column itself indents to', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  // Deep is at depth 1; n1 .. n6 go down to depth 7. The column stops indenting a row after 5 levels
  // (MAX_INDENT_LEVELS in bookmarks.js), and the list is held to the same limit.
  const MAX_LEVELS = 5;
  const chain = (names) => (names.length
    ? [{ title: names[0], children: chain(names.slice(1)).concat(names.length === 1 ? [link('Bottom')] : []) }]
    : []);
  const { ids } = await openColumn(harness, serviceWorker,
    [{ title: 'Deep', children: chain(['n1', 'n2', 'n3', 'n4', 'n5', 'n6']) }, link('Mover')],
    ['Deep', 'n1', 'n2', 'n3', 'n4', 'n5']);
  const folders = await offeredFolders(panel, ids.Mover);
  expect(folders.map((f) => f.depth), 'the permanent folders, Deep and n1 to n6 on their way down').toEqual([0, 1, 2, 3, 4, 5, 6, 7, 0]);

  const menu = await openMoveTo(panel, 'Mover');
  expect(menu.submenu.map((i) => i.id)).toEqual(folders.map((f) => `bm-moveto-${f.id}`));
  expect(menu.submenu.map((i) => i.label), 'two no-break spaces a level, and no more than the limit').toEqual(
    folders.map((f) => NBSP.repeat(2 * Math.min(f.depth, MAX_LEVELS)) + f.title),
  );
  const indentOf = (title) => menu.submenu.find((i) => i.label.trim() === title).label.length - title.length;
  expect([indentOf('n3'), indentOf('n4'), indentOf('n5'), indentOf('n6')],
    'depths 4, 5, 6 and 7: 8, 10, 10 and 10 no-break spaces').toEqual([8, 10, 10, 10]);
  expect(errors).toEqual([]);
});

/* ── B9.6: the menu closes when the rail scrolls ──────────────────────────── */

granted('B9.6 the menu closes when the column scrolls, however it was opened, and gives the row its focus back', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const kids = Array.from({ length: 60 }, (_, i) => link(`Row ${String(i + 1).padStart(2, '0')}`));
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Long', children: kids }], ['Long'], { viewport: { width: 460, height: 600 } });
  const scroll = (by) => panel.evaluate((n) => {
    const rail = document.getElementById('bookmark-rail');
    const before = rail.scrollTop;
    rail.scrollTop += n;
    return { before, after: rail.scrollTop };
  }, by);
  expect((await scroll(0)).before, 'the column starts at the top').toBe(0);

  // By the mouse, scrolled by script.
  await rightClick(panel, 'Row 03');
  const moved = await scroll(200);
  expect(moved.after, 'the column really scrolled').toBeGreaterThan(moved.before);
  await expect(panel.locator(E.MENU), 'the menu closed with it').toBeHidden({ timeout: 10_000 });
  expect(await E.activeRowId(panel), 'focus is back on the row').toBe(ids['Row 03']);

  // By the keyboard, scrolled with the wheel over the column.
  await panel.evaluate(() => { document.getElementById('bookmark-rail').scrollTop = 0; });
  await keyMenu(panel, 'Row 04', 'Shift+F10');
  // Low in the column, below the menu, which hangs from a row near the top.
  const box = await panel.locator('#bookmark-rail').boundingBox();
  await panel.mouse.move(box.x + box.width / 2, box.y + box.height - 40);
  await panel.mouse.wheel(0, 240);
  await expect(panel.locator(E.MENU), 'the wheel closed it').toBeHidden({ timeout: 10_000 });
  expect((await scroll(0)).before, 'and the column did scroll').toBeGreaterThan(0);

  // The menu of a tab card is the same element, and the column's scroll is not its to close.
  await panel.evaluate(() => { document.getElementById('bookmark-rail').scrollTop = 0; });
  await panel.locator(`[data-tab-id="${harness.tabIds.alpha}"] .thumb`).click({ button: 'right' });
  await expect(panel.locator(E.MENU), 'the tab card\'s menu is up').toBeVisible({ timeout: 10_000 });
  expect((await E.readMenu(panel)).items.filter((i) => (i.id || '').startsWith('bm-')), 'and it is not the row menu').toEqual([]);
  expect((await scroll(200)).after, 'the column scrolls').toBeGreaterThan(0);
  await observe(panel, 400); // nothing is going to close it; this is the time a scroll event would have had to
  expect((await E.readMenu(panel)).open, 'the tab card\'s menu is still up').toBe(true);
  await closeMenu(panel);
  expect(errors).toEqual([]);
});

granted('taking the column down closes its menu and throws nothing', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  await openColumn(harness, serviceWorker, [{ title: 'Group', children: ['A', 'B'].map(link) }], ['Group']);
  await rightClick(panel, 'A');
  await setSettings(serviceWorker, { railMode: 'tools' });
  await expect(panel.locator(E.MENU), 'the menu goes with the list it belongs to').toBeHidden({ timeout: 10_000 });
  await observe(panel, 400); // anything that was going to throw has had its time
  expect(errors).toEqual([]);
});

/* ── B9.7: keys inside the name field belong to the field ─────────────────── */

granted('B9.7 inside the name field F2, Backspace, the arrows, Alt+Arrow and the menu keys do nothing to the rows (premise: passes without the feature)', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  await openColumn(harness, serviceWorker, [
    { title: 'Group', children: [link('First'), { title: 'Sub', children: [link('Sub child')] }, link('Last')] },
  ], ['Group', 'Sub']);
  await E.installWriteSpy(panel);
  const field = panel.locator(FIELD);
  const group = E.rowTitled(panel, 'Group');
  const before = await listOrder(panel);

  /** Press `keys` one after the other in the open field and check nothing else moved or was called. */
  const pressAll = async (what, keys) => {
    // From here: opening the field read the folders to repaint (reads are calls too); what follows must not.
    const mark = await spyMark(panel);
    for (const key of keys) {
      await panel.keyboard.press(key);
      await expect(field, `${what}: ${key} leaves focus in the field`).toBeFocused();
    }
    await observe(panel, 300); // nothing is going to happen to the rows; this is the time it would have had to
    await expect(group, `${what}: the open folder stays open`).toHaveAttribute('aria-expanded', 'true');
    await expect(E.rowTitled(panel, 'Sub'), `${what}: and so does the one inside it`).toHaveAttribute('aria-expanded', 'true');
    expect(await E.readMenu(panel), `${what}: no menu`).toMatchObject({ open: false });
    expect(await callsSince(panel, mark), `${what}: not one call`).toEqual([]);
  };

  // A rename on a link inside an open folder.
  await E.rowTitled(panel, 'First').focus();
  await panel.keyboard.press('F2');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.fill('Half typed');
  await pressAll('rename', ['F2', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Backspace', 'Backspace',
    'Alt+ArrowDown', 'Alt+ArrowUp', 'ContextMenu', 'Shift+F10', 'Shift+F10']);
  await expect(field, 'Backspace only deleted').toHaveValue('Half typ');
  await panel.keyboard.press('Escape');
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  expect(await listOrder(panel), 'the rows are as they were').toEqual(before);

  // A new folder in the folder opened last (the header button's, so this part needs no menu).
  await panel.locator('[data-testid="bookmark-new-folder"]').click();
  await expect(field).toBeFocused({ timeout: 10_000 });
  await pressAll('new folder', ['ArrowLeft', 'ArrowDown', 'ArrowUp', 'Backspace', 'F2', 'Alt+ArrowUp', 'Alt+ArrowDown', 'ContextMenu']);
  await panel.keyboard.press('Escape');
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  expect(await listOrder(panel), 'Escape wrote nothing and the rows are as they were').toEqual(before);
  expect(errors).toEqual([]);
});

/* ── B4.4: a new folder from the menu ─────────────────────────────────────── */

granted('B4.4 the menu\'s new folder: after a bookmark, at the end of a folder (which opens), inside a permanent folder; Escape writes nothing', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(420_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [
    { title: 'Group', children: [link('L1'), link('L2'), link('L3'), { title: 'Sub', children: [link('S1'), link('S2')] }, link('L4')] },
  ], ['Group']);
  await E.installWriteSpy(panel);
  const field = panel.locator(FIELD);
  const creates = async (mark) => (await writesSince(panel, mark)).filter((c) => c.method === 'create');

  // 1. On a bookmark: the field is right after it, and the folder is made right after it.
  let mark = await spyMark(panel);
  await rightClick(panel, 'L2');
  await E.menuItem(panel, 'bm-new-folder').click();
  await expect(field).toBeFocused({ timeout: 10_000 });
  await expect(field, 'it starts with the default name').toHaveValue(EN.bookmarksFolderDefaultName.message);
  const shown = await listOrder(panel);
  const at2 = shown.findIndex((e) => e.text === 'L2');
  expect(shown.slice(at2, at2 + 3).map((e) => e.text), 'the field is directly after L2, not at the end of the folder')
    .toEqual(['L2', `[field:${EN.bookmarksFolderDefaultName.message}]`, 'L3']);
  expect(shown[at2 + 1].testid, 'and it is the edit row').toBe('bookmark-edit-row');
  expect(await creates(mark), 'nothing is written while the field is open').toEqual([]);
  await field.fill('Fresh');
  await field.press('Enter');
  await expect.poll(() => titlesOf(serviceWorker, ids.Group), { timeout: 15_000, message: 'the folder is right after L2 in Chrome' })
    .toEqual(['L1', 'L2', 'Fresh', 'L3', 'Sub', 'L4']);
  let made = await creates(mark);
  expect(made.map((c) => c.args), 'one create, with the index right after the bookmark').toEqual([[{ parentId: ids.Group, title: 'Fresh', index: 2 }]]);
  const freshId = (await E.childrenOf(serviceWorker, ids.Group))[2].id;
  await expect.poll(() => E.activeRowId(panel), { timeout: 10_000, message: 'focus is on the new folder' }).toBe(freshId);
  await expect.poll(() => E.domChildren(panel, ids.Group), { timeout: 15_000 }).toEqual(['L1', 'L2', 'Fresh', 'L3', 'Sub', 'L4']);

  // 2. On the LAST bookmark of the folder: after it, which is the end, still with the index.
  mark = await spyMark(panel);
  await rightClick(panel, 'L4');
  await E.menuItem(panel, 'bm-new-folder').click();
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.fill('Tail');
  await field.press('Enter');
  await expect.poll(() => titlesOf(serviceWorker, ids.Group), { timeout: 15_000 }).toEqual(['L1', 'L2', 'Fresh', 'L3', 'Sub', 'L4', 'Tail']);
  made = await creates(mark);
  expect(made.map((c) => c.args), 'after the last one: index 6').toEqual([[{ parentId: ids.Group, title: 'Tail', index: 6 }]]);

  // 3. On a shut folder: inside it, at its end; the folder opens; no index.
  mark = await spyMark(panel);
  await expect(E.rowTitled(panel, 'Sub')).toHaveAttribute('aria-expanded', 'false');
  await rightClick(panel, 'Sub');
  expect((await E.readMenu(panel)).items[0].label, 'the item names the folder').toBe(fill(EN.bookmarksNewFolderIn.message, { FOLDER: 'Sub' }));
  await E.menuItem(panel, 'bm-new-folder').click();
  await expect(field).toBeFocused({ timeout: 10_000 });
  await expect(E.rowTitled(panel, 'Sub'), 'the folder opened').toHaveAttribute('aria-expanded', 'true');
  const order = (await listOrder(panel)).map((e) => e.text);
  const at = order.indexOf('Sub');
  expect(order.slice(at, at + 4), 'the field is after its last child').toEqual(['Sub', 'S1', 'S2', `[field:${EN.bookmarksFolderDefaultName.message}]`]);
  await field.fill('Inner');
  await field.press('Enter');
  await expect.poll(() => titlesOf(serviceWorker, ids.Sub), { timeout: 15_000 }).toEqual(['S1', 'S2', 'Inner']);
  made = await creates(mark);
  expect(made.map((c) => c.args), 'one create, in the folder, and no index key').toEqual([[{ parentId: ids.Sub, title: 'Inner' }]]);
  expect(made[0].keys[0], 'the options object has no index key at all').toEqual(['parentId', 'title']);

  // 4. On a permanent folder that is shut: inside it.
  mark = await spyMark(panel);
  const otherId = await otherRoot(panel).getAttribute('data-bookmark-id');
  await expect(otherRoot(panel)).toHaveAttribute('aria-expanded', 'false');
  await otherRoot(panel).click({ button: 'right' });
  await expect(panel.locator(E.MENU)).toBeVisible({ timeout: 10_000 });
  await E.menuItem(panel, 'bm-new-folder').click();
  await expect(field).toBeFocused({ timeout: 10_000 });
  await expect(otherRoot(panel), 'the permanent folder opened').toHaveAttribute('aria-expanded', 'true');
  await field.fill('Top');
  await field.press('Enter');
  await expect.poll(() => titlesOf(serviceWorker, otherId), { timeout: 15_000 }).toEqual(['Top']);
  made = await creates(mark);
  expect(made.map((c) => c.args), 'one create, in the permanent folder').toEqual([[{ parentId: otherId, title: 'Top' }]]);

  // 5. Escape, from a menu-opened field, writes nothing and gives the row its focus back.
  mark = await spyMark(panel);
  await rightClick(panel, 'L3');
  await E.menuItem(panel, 'bm-new-folder').click();
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.fill('Never');
  await field.press('Escape');
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  expect(await creates(mark), 'Escape: nothing written').toEqual([]);
  expect(await E.activeRowId(panel), 'focus is back on L3').toBe(ids.L3);
  expect(await titlesOf(serviceWorker, ids.Group)).toEqual(['L1', 'L2', 'Fresh', 'L3', 'Sub', 'L4', 'Tail']);
  expect(errors).toEqual([]);
});

/* ── B4.6 (menu half): rename ─────────────────────────────────────────────── */

granted('B4.6 the menu\'s Rename on a bookmark and on a folder opens the field with the title; Enter is one update; Escape writes nothing', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [
    { title: 'Group', children: [link('Link one'), { title: 'Sub', children: [link('Sub child')] }] },
  ], ['Group']);
  await E.installWriteSpy(panel);
  const field = panel.locator(FIELD);
  const updates = async (mark) => (await writesSince(panel, mark)).filter((c) => c.method === 'update');

  let mark = await spyMark(panel);
  await rightClick(panel, 'Link one');
  await E.menuItem(panel, 'bm-rename').click();
  await expect(field).toBeFocused({ timeout: 10_000 });
  await expect(field, 'the field holds the title').toHaveValue('Link one');
  await expect(field).toHaveAttribute('aria-label', EN.bookmarksRename.message);
  await field.fill('  Renamed  ');
  await field.press('Enter');
  await expect.poll(() => titlesOf(serviceWorker, ids.Group), { timeout: 15_000 }).toEqual(['Renamed', 'Sub']);
  expect((await updates(mark)).map((c) => c.args), 'one update, with the trimmed title').toEqual([[ids['Link one'], { title: 'Renamed' }]]);
  await expect.poll(() => E.activeRowId(panel), { timeout: 10_000, message: 'focus is on the renamed row' }).toBe(ids['Link one']);

  mark = await spyMark(panel);
  await rightClick(panel, 'Sub');
  await E.menuItem(panel, 'bm-rename').click();
  await expect(field).toBeFocused({ timeout: 10_000 });
  await expect(field, 'a folder too').toHaveValue('Sub');
  await field.fill('Gone in a moment');
  await field.press('Escape');
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  expect(await updates(mark), 'Escape: nothing written').toEqual([]);
  expect(await titlesOf(serviceWorker, ids.Group)).toEqual(['Renamed', 'Sub']);
  expect(await E.activeRowId(panel), 'focus is back on the folder').toBe(ids.Sub);

  // A folder renamed from the menu, in one update.
  mark = await spyMark(panel);
  await rightClick(panel, 'Sub');
  await E.menuItem(panel, 'bm-rename').click();
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.fill('Sub two');
  await field.press('Enter');
  await expect.poll(() => titlesOf(serviceWorker, ids.Group), { timeout: 15_000 }).toEqual(['Renamed', 'Sub two']);
  expect((await updates(mark)).map((c) => c.args)).toEqual([[ids.Sub, { title: 'Sub two' }]]);
  expect(errors).toEqual([]);
});

/* ── What an action ends with: focus, by id, after the repaint ─────────────── */

/**
 * Change something elsewhere (a bookmark made in the service worker) while a menu is open, and wait until the
 * column has rebuilt every row under it: the row the menu remembers is then gone from the page, and
 * `context-menu.js` has nothing to give focus back to.
 */
async function rebuildUnderMenu(panel, serviceWorker, parentId, rowId, title) {
  const selector = rowSelector(rowId);
  await E.markNode(panel, selector);
  await E.externalWrite(serviceWorker, (a) => chrome.bookmarks.create(a),
    { parentId, title, url: `https://${title.toLowerCase()}.example.com/` });
  await expect.poll(() => E.sameNode(panel, selector), {
    timeout: 15_000, message: 'the column rebuilt the rows under the open menu',
  }).toBe(false);
  await expect(E.rowTitled(panel, title)).toBeVisible();
  expect((await E.readMenu(panel)).open, 'and the menu is still up').toBe(true);
}

granted('a menu that was opened before the rows were rebuilt still gives focus back to the row, by id: on Escape, after a move, after a cancelled new folder', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [
    { title: 'Group', children: ['A', 'B', 'C', 'D'].map(link) },
  ], ['Group']);
  await E.installWriteSpy(panel);
  const field = panel.locator(FIELD);

  // 1. Dismissed: nobody chose anything, and the row it was opened on is a new node.
  await keyMenu(panel, 'C', 'Shift+F10');
  await rebuildUnderMenu(panel, serviceWorker, ids.Group, ids.C, 'Z1');
  await closeMenu(panel);
  expect(await E.activeRowId(panel), 'Escape: focus is on the row, found by its id in the rows built after the menu opened').toBe(ids.C);

  // 2. A move.
  await keyMenu(panel, 'C', 'Shift+F10');
  await rebuildUnderMenu(panel, serviceWorker, ids.Group, ids.C, 'Z2');
  await E.menuItem(panel, 'bm-up').click();
  await expect.poll(() => titlesOf(serviceWorker, ids.Group), { timeout: 15_000 }).toEqual(['A', 'C', 'B', 'D', 'Z1', 'Z2']);
  await expect.poll(() => E.activeRowId(panel), {
    timeout: 10_000, message: 'a move: focus is on the row that moved',
  }).toBe(ids.C);

  // 3. A new folder that is begun and cancelled: the field remembers where focus was, to give it back.
  await rightClick(panel, 'D');
  await rebuildUnderMenu(panel, serviceWorker, ids.Group, ids.D, 'Z3');
  const mark = await spyMark(panel);
  await E.menuItem(panel, 'bm-new-folder').click();
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.press('Escape');
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  expect((await writesSince(panel, mark)).filter((c) => c.method === 'create'), 'Escape: nothing written').toEqual([]);
  expect(await E.activeRowId(panel), 'a new folder: Escape gives the row its focus back').toBe(ids.D);
  expect(errors).toEqual([]);
});

/* ── Failures ─────────────────────────────────────────────────────────────── */

granted('Alt+Arrow and the menu on a bookmark that was removed meanwhile: the reader is told, nothing throws, the column catches up', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [
    { title: 'Group', children: ['A', 'B', 'C'].map(link) },
  ], ['Group']);
  await E.installWriteSpy(panel);
  await E.installReadGate(panel);
  await E.recordToastTexts(panel);

  // The panel's repaint after the removal is held, so the row is still on screen when the key is pressed.
  await E.armReadGate(panel);
  await E.externalWrite(serviceWorker, (id) => chrome.bookmarks.remove(id), ids.B);
  await expect.poll(async () => (await E.readGate(panel)).held, { timeout: 15_000 }).toBeGreaterThan(0);
  await expect(E.rowTitled(panel, 'B'), 'the column still shows the row').toHaveCount(1);

  const mark = await spyMark(panel);
  await E.rowTitled(panel, 'B').focus();
  await panel.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => E.readToastTexts(panel), { timeout: 10_000, message: 'the reader is told' }).toEqual([EN.operationFailed.message]);
  expect(await writesSince(panel, mark), 'nothing was written: the row could not be read').toEqual([]);
  await E.openReadGate(panel);
  await expect(E.rowTitled(panel, 'B'), 'and once the column hears, the row is gone').toHaveCount(0, { timeout: 15_000 });
  expect(await titlesOf(serviceWorker, ids.Group)).toEqual(['A', 'C']);
  expect(errors).toEqual([]);
});

granted('the permission going while a key or a menu choice moves a row ends in the grant card and throws nothing', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  await openColumn(harness, serviceWorker, [{ title: 'Group', children: ['A', 'B', 'C'].map(link) }], ['Group']);
  await E.installWriteSpy(panel);

  // The key.
  await E.staleGrant(panel);
  await E.rowTitled(panel, 'B').focus();
  await panel.keyboard.press('Alt+ArrowDown');
  await expect(panel.locator('[data-testid="bookmark-grant"]'), 'the grant card is back').toBeVisible({ timeout: 15_000 });
  await expect(panel.locator('[data-testid="bookmark-list"]')).toHaveCount(0);
  expect((await E.readMenu(panel)).open, 'no menu is left over').toBe(false);
  await observe(panel, 400); // anything that was going to throw has had its time
  expect(errors, 'the key: no uncaught error').toEqual([]);
});

granted('the permission going while the menu is open closes it and throws nothing', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  await openColumn(harness, serviceWorker, [{ title: 'Group', children: ['A', 'B', 'C'].map(link) }], ['Group']);
  await E.installWriteSpy(panel);
  await rightClick(panel, 'B');
  await E.staleGrant(panel);
  await E.menuItem(panel, 'bm-down').click();
  await expect(panel.locator('[data-testid="bookmark-grant"]'), 'the grant card is back').toBeVisible({ timeout: 15_000 });
  expect((await E.readMenu(panel)).open, 'the menu is closed').toBe(false);
  await observe(panel, 400); // anything that was going to throw has had its time
  expect(errors, 'the menu choice: no uncaught error').toEqual([]);
});

/* ── Spec 39 sends a bare contextmenu ─────────────────────────────────────── */

granted('a bare synthetic contextmenu on a row, as spec 39 sends it, opens the menu in the corner without throwing; Escape closes it', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Group', children: [link('Only')] }], ['Group']);
  await E.watchContextMenuEvents(panel);
  const prevented = await panel.evaluate(() => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.querySelector('[data-testid="bookmark-row"][data-kind="link"]').dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented, 'the event is cancelled').toBe(true);
  await expect(panel.locator(E.MENU)).toBeVisible({ timeout: 10_000 });
  const menu = await E.readMenu(panel);
  const view = await panel.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  expect(menu.box.x >= 0 && menu.box.y >= 0 && menu.box.x + menu.box.width <= view.w && menu.box.y + menu.box.height <= view.h,
    `the menu is inside the panel (${JSON.stringify(menu.box)} in ${view.w} x ${view.h})`).toBe(true);
  expect(menu.items.map((i) => i.id)).toEqual(['bm-new-folder', 'bm-rename', 'bm-up', 'bm-down', 'bm-move-to']);
  await closeMenu(panel);
  expect(await E.activeRowId(panel), 'Escape returns to the row').toBe(ids.Only);
  expect(errors).toEqual([]);
});

/* ── B12: ungranted ───────────────────────────────────────────────────────── */

test('ungranted, the column has no menu and no new control, and the new modules never look at chrome.bookmarks (premise: passes without the feature)', async ({
  harness, serviceWorker,
}) => {
  test.setTimeout(180_000);
  const { panel } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });

  // The getter of 32-bookmarks-rail's ungranted test, installed BEFORE the column is switched on, so that
  // it is watching from the moment the modules (bookmark-menu.js among them) are imported.
  const watching = await panel.evaluate(() => {
    window.__bookmarkTouches = 0;
    try {
      Object.defineProperty(chrome, 'bookmarks', {
        configurable: true,
        enumerable: true,
        get() {
          window.__bookmarkTouches += 1;
          return undefined;
        },
      });
    } catch {
      return false;
    }
    const d = Object.getOwnPropertyDescriptor(chrome, 'bookmarks');
    return Boolean(d && typeof d.get === 'function');
  });
  expect(watching, 'the probe must be able to watch chrome.bookmarks, or it proves nothing').toBe(true);

  await setSettings(serviceWorker, { refreshInterval: 'off', railMode: 'bookmarks' });
  await expect(panel.locator('[data-testid="bookmark-grant"]')).toBeVisible({ timeout: 15_000 });
  expect(await panel.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] })),
    'the permission really is absent, or what follows proves nothing').toBe(false);

  // Right click and the menu keys on the card: no menu of ours, no row to have one.
  await panel.locator('[data-testid="bookmark-grant"]').click({ button: 'right' });
  await panel.keyboard.press('Shift+F10');
  await panel.keyboard.press('Alt+ArrowDown');
  await observe(panel, 1500); // nothing is going to happen; this is the time it would have had to
  expect((await E.readMenu(panel)).items.filter((i) => (i.id || '').startsWith('bm-')), 'no item of the row menu').toEqual([]);
  await expect(panel.locator('[data-testid="bookmark-new-folder"]'), 'no new-folder control').toHaveCount(0);
  await expect(panel.locator(FIELD)).toHaveCount(0);
  expect(await panel.evaluate(() => window.__bookmarkTouches),
    'the ungranted column, with the menu code loaded, must not so much as look at chrome.bookmarks').toBe(0);
});

/* ── B13: the words, in Japanese ──────────────────────────────────────────── */

// `LANGUAGE` / `LC_ALL` choose the application locale (`_locales/ja`) and `locale` the renderer's;
// both are needed (09-i18n.spec.js, 37-bookmark-folders.spec.js).
const grantedJa = granted.extend({
  context: async ({ headed, grantedExt }, use) => {
    const { context } = await launchExtensionContext({
      headed,
      extDir: grantedExt,
      env: { ...process.env, LANGUAGE: 'ja', LC_ALL: 'ja_JP.UTF-8' },
      locale: 'ja',
    });
    await use(context);
    await context.close();
  },
});

grantedJa('in Japanese the menu items, the list of folders and the toast are the Japanese strings', async ({
  harness, serviceWorker,
}) => {
  grantedJa.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [
    { title: 'Group', children: ['A', 'B', 'C'].map(link).concat([{ title: 'Sub', children: [] }]) },
  ], ['Group']);
  // The key is asserted to exist before its text is read: a table without it must fail an assertion,
  // not throw a TypeError.
  const ja = (key) => {
    expect(JA[key], `${key} is in the Japanese table`).toBeDefined();
    return JA[key].message;
  };
  for (const key of ['bookmarksNewFolder', 'bookmarksNewFolderIn', 'bookmarksRename', 'bookmarksMoveUp', 'bookmarksMoveDown', 'bookmarksMoveTo', 'bookmarksMovedTo']) {
    // Kana or a CJK ideograph.
    expect(ja(key), `${key} really is Japanese`).toMatch(/[぀-ヿ㐀-鿿]/);
  }
  expect(EN.bookmarksMovedTo.message, 'the English one the other tests read').toBe('Moved to position $POS$ of $TOTAL$');

  await E.recordToastTexts(panel);
  await rightClick(panel, 'B');
  const menu = await E.readMenu(panel);
  expect(menu.items.map((i) => i.label), 'the items of a bookmark, in Japanese').toEqual([
    ja('bookmarksNewFolder'), ja('bookmarksRename'), ja('bookmarksMoveUp'), ja('bookmarksMoveDown'), ja('bookmarksMoveTo'),
  ]);
  await closeMenu(panel);
  await rightClick(panel, 'Sub');
  expect((await E.readMenu(panel)).items[0].label, 'the new-folder item of a folder names it').toBe(fill(ja('bookmarksNewFolderIn'), { FOLDER: 'Sub' }));
  await closeMenu(panel);

  // A move by the menu, and the toast it ends with, in Japanese, with the numbers in their places.
  await rightClick(panel, 'B');
  await E.menuItem(panel, 'bm-down').click();
  await expect.poll(() => titlesOf(serviceWorker, ids.Group), { timeout: 15_000 }).toEqual(['A', 'C', 'B', 'Sub']);
  await expect.poll(() => E.readToastTexts(panel), { timeout: 10_000 }).toEqual([fill(ja('bookmarksMovedTo'), { POS: 3, TOTAL: 4 })]);
  expect(errors).toEqual([]);
});
