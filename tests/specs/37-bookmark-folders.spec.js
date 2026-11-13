// 37-bookmark-folders — making a folder and renaming a node in the bookmark column (PR2 unit
// U4), and the helpers that every later PR2 spec leans on, exercised for the first time.
//
// WHAT THE COLUMN PROMISES (plan.md D1 and D3, criteria B4):
//   - the header button "New folder" is aimed at the folder opened last, like the bookmark
//     button beside it, and does nothing until there is one;
//   - it opens a NAME FIELD in the list, at the end of that folder; F2 opens the same field in
//     place of a bookmark or a folder, holding its title. Nothing is written until the name is
//     committed: Enter, or leaving the field with a name that is not the one it started with.
//     Escape, an empty name and leaving it untouched write nothing (delete is out of scope, so a
//     folder made "to be named afterwards" and abandoned could never be removed);
//   - the permanent folders are not renamed, and F2 does not claim the key there;
//   - the field survives everything the panel does around it: an external change to the same
//     folder, which would repaint the list, waits until the edit is over;
//   - Enter in the field opens nothing, and the click that ends an edit still does its job.
//
// NOT HERE: the menu entries for both (unit U6, spec 41) and the drag (spec 38).
//
// TWO tests are premises, not features: things that held before this unit and have to keep
// holding. They pass on main's extension with these tests (measured, not assumed: the PR body
// lists them): the ungranted column shows no new control (B12), and `orderOracle` ("the
// oracle"), which is a test of a helper and not of the product. Every other test in this file
// fails by assertion on main's extension.
//
// The panel is opened as a tab and the permission is the synthesised one (helpers/bookmarks.js
// says why); a real side panel, a real Allow prompt and a real IME are NOT exercised here.
// Where an input method is stood in for (the composition test), the stand-in is a synthetic
// event and says so.
'use strict';

const { test, expect, launchExtensionContext } = require('../fixtures');
const { setSettings, swEval, sleep } = require('../helpers/chrome');
const {
  granted, seedBookmarks, rows, showBookmarks,
} = require('../helpers/bookmarks');
const E = require('../helpers/bookmark-edit');
const EN = require('../../extension/_locales/en/messages.json');
const JA = require('../../extension/_locales/ja/messages.json');

const NEW_FOLDER = '[data-testid="bookmark-new-folder"]';
const EDIT_ROW = '[data-testid="bookmark-edit-row"]';
const FIELD = '[data-testid="bookmark-rename-input"]';
const TOAST = '#toast';

/* ── Small helpers every test below shares ────────────────────────────────── */

/** The panel's uncaught errors, collected from now on: B4.9 wants none in the whole spec. */
function watchErrors(panel) {
  const errors = [];
  panel.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
  return errors;
}

/** Seed `items` under the bar and switch the column on; nothing is opened yet. */
async function showColumn(harness, serviceWorker, items) {
  const { panel } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });
  const seeded = await seedBookmarks(serviceWorker, items);
  await showBookmarks(panel, serviceWorker);
  await expect(bar(panel)).toBeVisible({ timeout: 15_000 });
  return seeded;
}

/** The first root, which `seedBookmarks` puts everything under. By position: roots are named in the browser's language. */
const bar = (panel) => panel.locator('[data-testid="bookmark-row"][data-depth="0"]').first();

/** Click a closed folder row open. The folder opened last is the one the header buttons write into. */
async function openFolder(panel, row) {
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 });
}

/** The list's children in order (rows, markers, the edit row) with what each one says. */
const listOrder = (panel) => panel.evaluate(() => [
  ...document.querySelector('[data-testid="bookmark-list"]').children,
].map((el) => ({
  testid: el.dataset.testid,
  depth: Number(el.dataset.depth),
  text: el.dataset.testid === 'bookmark-edit-row'
    ? `[field:${el.querySelector('input').value}]`
    : ((el.querySelector('.w-row__main') || el).textContent || ''),
})));

/** The sequence number of the newest call the write spy has seen: a point to count from. */
const spyMark = async (panel) => (await E.readWriteSpy(panel)).at(-1)?.n ?? 0;
/** The calls that change the tree since `mark`. */
const writesSince = async (panel, mark) => (await E.readWriteSpy(panel, mark))
  .filter((c) => E.WRITE_METHODS.includes(c.method));
const createsSince = async (panel, mark) => (await writesSince(panel, mark))
  .filter((c) => c.method === 'create');

const titles = (nodes) => nodes.map((n) => n.title);

/** Two animation frames: whatever the panel was going to do after the last event, it has done. */
const settle = (panel) => panel.evaluate(() => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
}));

/**
 * Click the header button and wait for the name field to be up and holding focus. The button is
 * ASSERTED before it is clicked: a click on a button that does not exist would wait for the whole
 * test timeout, and a test that ends in a timeout is not one that failed by assertion.
 */
async function openField(panel) {
  const button = panel.locator(NEW_FOLDER);
  await expect(button, 'the new-folder button is there, and has a folder to put the new one in')
    .toBeEnabled({ timeout: 10_000 });
  await button.click();
  await expect(panel.locator(FIELD)).toBeFocused({ timeout: 10_000 });
}

/* ── Premises: they held before this unit and must keep holding ───────────── */

test('ungranted, the column shows no new control and so much as looks at nothing (premise: passes without the feature)', async ({
  harness, serviceWorker,
}) => {
  test.setTimeout(180_000);
  const { panel } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });

  // The getter of 32-bookmarks-rail's ungranted test, installed BEFORE the feature is switched
  // on so it is watching from the moment the modules are imported (the new write module too).
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

  expect(
    await panel.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] })),
    'the permission really is absent, or what follows proves nothing',
  ).toBe(false);
  await expect(panel.locator(NEW_FOLDER), 'no header, so no new-folder button').toHaveCount(0);
  await expect(panel.locator('[data-testid="bookmark-head"]')).toHaveCount(0);
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0);
  await expect(panel.locator(FIELD)).toHaveCount(0);

  await sleep(1500);
  expect(await panel.evaluate(() => window.__bookmarkTouches),
    'the ungranted column, with the editing code loaded, must not so much as look at chrome.bookmarks')
    .toBe(0);
});

test('the oracle: orderOracle against the literal Probe 13 tables, and dropPoint (premise: a helper test, passes without the feature)', () => {
  // The expected orders of every later drag spec are computed by `orderOracle`, which is meant to
  // be written from names and not from the index arithmetic it checks. This is its own test:
  // Probe 13 P1 (the 4 x 5 in-range rows, written as the probe printed them) and P2, as literals.
  const P1 = {
    A: { 0: 'ABCD', 1: 'ABCD', 2: 'BACD', 3: 'BCAD', 4: 'BCDA' },
    B: { 0: 'BACD', 1: 'ABCD', 2: 'ABCD', 3: 'ACBD', 4: 'ACDB' },
    C: { 0: 'CABD', 1: 'ACBD', 2: 'ABCD', 3: 'ABCD', 4: 'ABDC' },
    D: { 0: 'DABC', 1: 'ADBC', 2: 'ABDC', 3: 'ABCD', 4: 'ABCD' },
  };
  let compared = 0;
  for (const [source, row] of Object.entries(P1)) {
    for (const [k, expected] of Object.entries(row)) {
      expect(E.orderOracle(['A', 'B', 'C', 'D'], source, Number(k)).join(''), `P1 s=${source} k=${k}`).toBe(expected);
      compared += 1;
    }
    // "omitted" appends: the same as k = length
    expect(E.orderOracle(['A', 'B', 'C', 'D'], source, 4).join(''), `P1 s=${source} omitted`).toBe(row[4]);
    compared += 1;
  }
  expect(compared, 'P1: 4 sources x (5 positions + omitted)').toBe(24);
  const P2 = { 0: 'MXYZ', 1: 'XMYZ', 2: 'XYMZ', 3: 'XYZM' };
  for (const [k, expected] of Object.entries(P2)) {
    expect(E.orderOracle(['X', 'Y', 'Z'], 'M', Number(k)).join(''), `P2 k=${k}`).toBe(expected);
    compared += 1;
  }
  expect(E.orderOracle(['X', 'Y', 'Z'], 'M', 3).join(''), 'P2 omitted').toBe('XYZM');
  compared += 1;
  expect(compared, 'P1 24 rows + P2 5 rows = the 29 literal rows').toBe(29);
  // an empty destination and a one-child destination
  expect(E.orderOracle([], 'M', 0)).toEqual(['M']);
  expect(E.orderOracle(['X'], 'M', 0)).toEqual(['M', 'X']);
  expect(E.orderOracle(['X'], 'M', 1)).toEqual(['X', 'M']);
  // the guards: titles are names, and a gap is a position in the list
  expect(() => E.orderOracle(['A', 'A'], 'A', 0)).toThrow(/unique/);
  expect(() => E.orderOracle(['A', 'B'], 'A', 3)).toThrow(RangeError);
  expect(() => E.orderOracle(['A', 'B'], 'A', -1)).toThrow(RangeError);
  expect(() => E.orderOracle(['A', 'B'], 'A', 0.5)).toThrow(RangeError);

  // The whole 6 x 7 matrix of B5.1 against a statement written from names: 6 sources x 7 gaps,
  // of which 12 (gap = s, gap = s + 1) change nothing and 30 move the item right before the
  // original child at the gap, or last.
  const six = ['A', 'B', 'C', 'D', 'E', 'F'];
  let noops = 0;
  let cells = 0;
  for (let s = 0; s < 6; s += 1) {
    for (let gap = 0; gap <= 6; gap += 1) {
      cells += 1;
      const after = E.orderOracle(six, six[s], gap);
      if (gap === s || gap === s + 1) {
        noops += 1;
        expect(after, `s=${s} gap=${gap} is a no-op`).toEqual(six);
        continue;
      }
      const at = after.indexOf(six[s]);
      expect(after.filter((x) => x !== six[s]), `s=${s} gap=${gap}: the others keep their order`)
        .toEqual(six.filter((x) => x !== six[s]));
      expect(gap === 6 ? at === 5 : after[at + 1] === six[gap], `s=${s} gap=${gap}: ${after.join('')}`).toBe(true);
    }
  }
  expect([cells, noops]).toEqual([42, 12]);

  // where the pointer goes for each zone, as a fraction of the row's height
  expect(E.dropPoint({ x: 10, y: 100, width: 200, height: 40 }, 'top')).toEqual({ x: 110, y: 100 + 40 * 0.12 });
  expect(E.dropPoint({ x: 0, y: 0, width: 10, height: 100 }, 'middle').y).toBe(50);
  expect(E.dropPoint({ x: 0, y: 0, width: 10, height: 100 }, 'bottom').y).toBe(88);
  expect(() => E.dropPoint({ x: 0, y: 0, width: 1, height: 1 }, 'before')).toThrow(/zone must be/);
});

/* ── B4.1 / B4.10: the button, and the field it opens ─────────────────────── */

granted('the new-folder button waits for an open folder, names it, and opens a name field at the end of it, which writes nothing yet', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(180_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const seeded = await showColumn(harness, serviceWorker, [
    { title: 'Reading', children: [
      { title: 'A', url: 'https://a.example.com/' },
      { title: 'B', url: 'https://b.example.com/' },
      { title: 'C', url: 'https://c.example.com/' },
    ] },
  ]);
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);

  // Nothing is open, so there is no folder to put a new one in: the button is there but dead,
  // and says what it is.
  const button = panel.locator(NEW_FOLDER);
  await expect(button).toBeVisible();
  await expect(button, 'no folder is open').toBeDisabled();
  await expect(button).toHaveAttribute('title', 'New folder');
  await expect(button).toHaveAttribute('aria-label', 'New folder');
  // The glyph is a symbol of the sprite, and it has a size: a missing symbol draws an empty button.
  expect(await panel.evaluate(() => {
    const glyph = document.querySelector('[data-testid="bookmark-new-folder"] svg');
    const box = glyph.getBoundingClientRect();
    return {
      symbol: Boolean(document.getElementById('i-folder-plus')),
      href: glyph.querySelector('use').getAttribute('href'),
      drawn: box.width > 8 && box.height > 8,
    };
  }), 'the button draws the i-folder-plus symbol').toEqual({ symbol: true, href: '#i-folder-plus', drawn: true });

  // Opening a folder is how the reader says where things go; the button then names it.
  await bar(panel).click();
  await openFolder(panel, E.rowTitled(panel, 'Reading'));
  await expect(button).toBeEnabled();
  await expect(button).toHaveAttribute('title', 'New folder in “Reading”');
  await expect(button).toHaveAttribute('aria-label', 'New folder in “Reading”');
  await expect(panel.locator(FIELD), 'no field before the button is pressed').toHaveCount(0);

  const bookmarkRows = (await rows(panel)).length;
  const mark = await spyMark(panel);
  await button.click();

  // A text field, holding focus, in the list, with the default name selected so that typing
  // replaces it.
  const field = panel.locator(FIELD);
  await expect(field).toBeVisible({ timeout: 10_000 });
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('New folder');
  await expect(field).toHaveAttribute('aria-label', 'Name');
  expect(await field.evaluate((el) => ({ start: el.selectionStart, end: el.selectionEnd, length: el.value.length })),
    'the default name is selected').toEqual({ start: 0, end: 10, length: 10 });

  // At the END of Reading, one level inside it, right after its last child.
  const order = await listOrder(panel);
  const at = order.findIndex((entry) => entry.testid === 'bookmark-edit-row');
  expect(order.filter((entry) => entry.testid === 'bookmark-edit-row'), 'exactly one field').toHaveLength(1);
  expect(order[at - 1], 'right after the last child of Reading').toMatchObject({ text: 'C', depth: 2 });
  expect(order[at]).toMatchObject({ testid: 'bookmark-edit-row', depth: 2, text: '[field:New folder]' });
  expect(order[at - 4], 'and Reading is the folder it follows').toMatchObject({ text: 'Reading', depth: 1 });

  // The folder is made when the name is committed, not before: opening the field writes nothing.
  expect(await writesSince(panel, mark), 'opening the field changed nothing in Chrome').toEqual([]);
  expect(titles(await E.childrenOf(serviceWorker, seeded.ids.Reading))).toEqual(['A', 'B', 'C']);

  // B4.10: it is not a bookmark and not a tab card. It is not counted as a row, and it carries
  // none of the attributes by which the column (and the panel) find bookmarks and tab cards,
  // which is also what keeps Enter and clicks in it away from `onListKeyDown` and `onListClick`.
  expect((await rows(panel)).length, 'bookmark-row counts exclude the field').toBe(bookmarkRows);
  const attrs = await panel.evaluate(() => ({
    offenders: [...document.querySelectorAll('[data-tab-id]')]
      .filter((el) => !el.matches('.tab-card, .pinned-tile'))
      .map((el) => el.className || el.tagName),
    inField: ['data-tab-id', 'data-bookmark-id', 'data-bookmark-url', 'data-bookmark-key']
      .filter((name) => document.querySelector('[data-testid="bookmark-edit-row"]').hasAttribute(name)),
  }));
  expect(attrs.offenders, 'only cards and pinned tiles carry data-tab-id').toEqual([]);
  expect(attrs.inField, 'the field row carries no row attribute').toEqual([]);

  expect(errors, 'the panel threw nothing').toEqual([]);
});

/* ── B4.2 / B4.7: Enter commits, once, and opens nothing ──────────────────── */

granted('Enter makes the folder with exactly one create call, puts its row at the end with focus, and opens no page', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(180_000);
  const { panel, urls } = harness;
  const errors = watchErrors(panel);
  const seeded = await showColumn(harness, serviceWorker, [
    { title: 'Reading', children: [
      { title: 'Alpha, already open', url: urls.alpha },
      { title: 'B', url: 'https://b.example.com/' },
    ] },
  ]);
  await E.installWriteSpy(panel);
  await bar(panel).click();
  await openFolder(panel, E.rowTitled(panel, 'Reading'));

  // What opening a page would look like from the panel, recorded: a new tab, or an activation.
  await panel.evaluate(() => {
    window.__tabCalls = [];
    for (const [ns, name] of [['tabs', 'create'], ['tabs', 'update'], ['windows', 'update']]) {
      const real = chrome[ns][name].bind(chrome[ns]);
      chrome[ns][name] = (...args) => { window.__tabCalls.push(`${ns}.${name}`); return real(...args); };
    }
  });
  const tabCalls = () => panel.evaluate(() => window.__tabCalls.slice());
  const tabsInW2 = () => swEval(serviceWorker, (id) => chrome.tabs.query({ windowId: id }).then((ts) => ts.length), harness.w2);

  // The recorder can see an activation: clicking the row whose page is open is exactly one. (A
  // recorder that saw nothing would make "Enter opened nothing" below mean nothing.)
  await E.rowTitled(panel, 'Alpha, already open').click();
  await expect.poll(tabCalls, { timeout: 10_000 }).toContain('tabs.update');
  const tabsBefore = await tabsInW2();
  await panel.evaluate(() => { window.__tabCalls.length = 0; });

  await openField(panel);
  const field = panel.locator(FIELD);

  // A click in the field toggles nothing: the folder stays open, the field stays up and holds
  // focus (`onListClick` never sees it as a row).
  await field.click();
  await expect(E.rowTitled(panel, 'Reading')).toHaveAttribute('aria-expanded', 'true');
  await expect(field).toBeFocused();

  // An Enter that belongs to an input method (a composition being confirmed) is not a commit.
  // STAND-IN: a synthetic keydown with `isComposing` and keyCode 229, which is what Chrome
  // sends for it; a real IME is not exercised.
  await field.fill('Projects');
  const mark = await spyMark(panel);
  await field.evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true,
  })));
  await settle(panel);
  await expect(field, 'the composition\'s Enter committed nothing').toBeFocused();
  await expect(panel.locator(EDIT_ROW)).toHaveCount(1);
  expect(await createsSince(panel, mark)).toEqual([]);

  // The real Enter.
  await field.press('Enter');

  // Exactly one create, and its arguments are the parent and the name and nothing else: no
  // `index` key, because "at the end" is what omitting it means (Probe 13 P3).
  await expect.poll(async () => (await createsSince(panel, mark)).length, { timeout: 10_000 }).toBe(1);
  const [made] = await createsSince(panel, mark);
  expect(made.args, 'the arguments of the one create call').toEqual([{ parentId: seeded.ids.Reading, title: 'Projects' }]);
  expect(made.keys, 'and no `index` key').toEqual([['parentId', 'title']]);
  expect(made.status).not.toBe('rejected');

  // Chrome has it last, as a folder (no `url` key).
  const kids = await E.childrenOf(serviceWorker, seeded.ids.Reading);
  expect(titles(kids)).toEqual(['Alpha, already open', 'B', 'Projects']);
  expect('url' in kids[2], 'a folder has no url').toBe(false);

  // On screen with no further action, in place of the field, and holding focus.
  const row = E.rowTitled(panel, 'Projects');
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row).toHaveAttribute('data-kind', 'folder');
  await expect(row).toHaveAttribute('data-bookmark-id', kids[2].id);
  await expect(panel.locator(EDIT_ROW), 'the field is gone').toHaveCount(0);
  await expect.poll(() => panel.evaluate(() => document.activeElement && document.activeElement.dataset.bookmarkId),
    { timeout: 5_000 }).toBe(kids[2].id);

  // And through all of it nothing was opened: no new tab, no activation, no window update.
  expect(await tabCalls(), 'Enter in the field opened nothing').toEqual([]);
  expect(await tabsInW2(), 'and no tab appeared').toBe(tabsBefore);
  expect(await createsSince(panel, mark), 'one create, not two').toHaveLength(1);
  expect(errors).toEqual([]);
});

/* ── B4.3: what writes nothing, and what writes once ──────────────────────── */

granted('Escape, an empty name, an untouched blur and a click elsewhere write nothing; a changed name written on blur writes once', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const seeded = await showColumn(harness, serviceWorker, [
    { title: 'Reading', children: [
      { title: 'A', url: 'https://a.example.com/' },
      { title: 'B', url: 'https://b.example.com/' },
    ] },
  ]);
  await E.installWriteSpy(panel);
  await bar(panel).click();
  await openFolder(panel, E.rowTitled(panel, 'Reading'));
  const field = panel.locator(FIELD);
  const button = panel.locator(NEW_FOLDER);
  const mark = await spyMark(panel);
  const unchanged = async (why) => {
    expect(await createsSince(panel, mark), `${why}: no create call`).toEqual([]);
    expect(titles(await E.childrenOf(serviceWorker, seeded.ids.Reading)), `${why}: the folder is as it was`)
      .toEqual(['A', 'B']);
    await expect(panel.locator(EDIT_ROW), `${why}: the field is gone`).toHaveCount(0);
    await expect(E.rowTitled(panel, 'B'), `${why}: and the list is whole`).toBeVisible();
  };

  // Escape, even after the name was changed. `keyboard.js` answers an Escape that reaches
  // `document` by blurring whatever has focus, and a blur with a changed name is a commit: the
  // field has to stop that Escape.
  await openField(panel);
  await field.fill('Draft');
  await field.press('Escape');
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  await unchanged('Escape after typing');
  await expect(button, 'focus went back to the button that opened the field').toBeFocused();

  // An empty name, and one of spaces: Enter ends the edit and writes nothing.
  await openField(panel);
  await field.fill('');
  await field.press('Enter');
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  await unchanged('Enter on an empty name');
  await openField(panel);
  await field.fill('   ');
  await field.press('Enter');
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  await unchanged('Enter on a name of spaces');

  // Leaving the field with the default name untouched.
  await openField(panel);
  await panel.evaluate(() => document.activeElement.blur());
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  await unchanged('blur with the untouched default');

  // Clicking another row ends the edit, writes nothing, AND the click still does its job. The
  // mouse goes down on the row, and the field must be gone by then without the row under the
  // pointer having been rebuilt: if it had been, the button-up would land on a node that is no
  // longer there and no click would ever arrive. (Playwright's own click() presses and releases
  // in one go, which would not tell the two apart; this one waits in between.)
  await openField(panel);
  const reading = E.rowTitled(panel, 'Reading');
  const box = await reading.boundingBox();
  await panel.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await panel.mouse.down();
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  await unchanged('a click on another row');
  await panel.mouse.up();
  await expect(reading, 'and the click that ended the edit closed the folder it was on')
    .toHaveAttribute('aria-expanded', 'false', { timeout: 10_000 });

  // A changed name, left by clicking away rather than by Enter, is written exactly once.
  await openFolder(panel, reading);
  await openField(panel);
  await field.fill('Via blur');
  await panel.evaluate(() => document.activeElement.blur());
  await expect.poll(async () => (await createsSince(panel, mark)).length, { timeout: 10_000 }).toBe(1);
  const [made] = await createsSince(panel, mark);
  expect(made.args).toEqual([{ parentId: seeded.ids.Reading, title: 'Via blur' }]);
  await expect(E.rowTitled(panel, 'Via blur')).toBeVisible({ timeout: 10_000 });
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0);
  expect(titles(await E.childrenOf(serviceWorker, seeded.ids.Reading))).toEqual(['A', 'B', 'Via blur']);
  await sleep(600);
  expect(await createsSince(panel, mark), 'and nothing wrote it a second time').toHaveLength(1);
  expect(errors).toEqual([]);
});

/* ── The button again, while a field is open ──────────────────────────────── */

granted('the header button pressed while a field is open ends that edit and opens a fresh field; the field takes at most 255 characters', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(180_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const seeded = await showColumn(harness, serviceWorker, [
    { title: 'Reading', children: [{ title: 'A', url: 'https://a.example.com/' }] },
  ]);
  await E.installWriteSpy(panel);
  await bar(panel).click();
  await openFolder(panel, E.rowTitled(panel, 'Reading'));
  const mark = await spyMark(panel);
  await openField(panel);
  const field = panel.locator(FIELD);

  // A UI limit, not Chrome's (a title of 5 000 characters is stored whole, Probe 13 P9); and no
  // red underline under a folder's name, and no autofill list over the column.
  await expect(field).toHaveAttribute('maxlength', '255');
  await expect(field).toHaveAttribute('spellcheck', 'false');
  await expect(field).toHaveAttribute('autocomplete', 'off');

  // The press blurs the open field (untouched: no write), and the click that follows opens a new
  // one, with the default name again.
  await panel.locator(NEW_FOLDER).click();
  await expect(panel.locator(EDIT_ROW), 'one field, a fresh one').toHaveCount(1, { timeout: 10_000 });
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('New folder');
  await settle(panel);
  expect(await createsSince(panel, mark), 'and nothing was written for the first').toEqual([]);
  expect(titles(await E.childrenOf(serviceWorker, seeded.ids.Reading))).toEqual(['A']);
  expect(errors).toEqual([]);
});

/* ── B4.5: a folder longer than one chunk ─────────────────────────────────── */

granted('in a folder of 400 the field is at the end, in view and focused, and so is the new folder', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const seeded = await showColumn(harness, serviceWorker, [{ title: 'Long', children: [] }]);
  await swEval(serviceWorker, async (a) => {
    for (let i = 0; i < a.n; i += 1) {
      await chrome.bookmarks.create({
        parentId: a.parentId, title: `Item ${String(i).padStart(3, '0')}`, url: `https://bulk.example.com/${i}`,
      });
    }
  }, { parentId: seeded.ids.Long, n: 400 });
  await E.installWriteSpy(panel);
  await bar(panel).click();
  await openFolder(panel, E.rowTitled(panel, 'Long'));

  // The premise: the list is chunked (150), so the end of Long is not in the DOM yet.
  await expect(panel.locator('[data-testid="bookmark-more"]')).toBeVisible();
  await expect(E.rowTitled(panel, 'Item 399'), 'the last child is not rendered yet').toHaveCount(0);

  await openField(panel);
  const field = panel.locator(FIELD);
  const fieldBox = () => panel.evaluate(() => {
    const rail = document.getElementById('bookmark-rail').getBoundingClientRect();
    const head = document.querySelector('[data-testid="bookmark-head"]').getBoundingClientRect();
    const box = document.querySelector('[data-testid="bookmark-rename-input"]').getBoundingClientRect();
    return {
      aboveTheTop: Math.max(rail.top, head.bottom) - box.top,
      belowTheBottom: box.bottom - Math.min(rail.bottom, window.innerHeight),
    };
  });
  const placed = await fieldBox();
  expect(placed.aboveTheTop, 'not hidden under the header').toBeLessThanOrEqual(1);
  expect(placed.belowTheBottom, 'and not below the bottom of the column').toBeLessThanOrEqual(1);
  const order = await listOrder(panel);
  const at = order.findIndex((entry) => entry.testid === 'bookmark-edit-row');
  expect(order[at - 1], 'right after the last of the 400').toMatchObject({ text: 'Item 399', depth: 2 });
  await expect(panel.locator('[data-testid="bookmark-more"]'), 'everything up to the field was rendered').toBeHidden();

  const mark = await spyMark(panel);
  await field.fill('At the end');
  await field.press('Enter');
  await expect.poll(async () => (await createsSince(panel, mark)).length, { timeout: 10_000 }).toBe(1);
  const kids = await E.childrenOf(serviceWorker, seeded.ids.Long);
  expect(kids).toHaveLength(401);
  expect(kids.at(-1).title).toBe('At the end');
  const row = E.rowTitled(panel, 'At the end');
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => panel.evaluate(() => document.activeElement && document.activeElement.dataset.bookmarkId),
    { timeout: 5_000 }).toBe(kids.at(-1).id);
  // The row is found by the id of the node Chrome made and measured in the SAME page task. It is not
  // measured through `row.evaluate(...)`: that resolves the locator to a node in one step and measures
  // the node in a second, and the column's own repaint can land between the two (the one the create's
  // `onCreated` schedules REPAINT_DEBOUNCE_MS = 400 ms after the write). A repaint rebuilds every row,
  // so the node resolved a moment earlier has left the document and its rect is all zeros: "not in
  // view" for a row that is in view before the repaint and after it. Measured on failed runs: top =
  // bottom = 0 on a node with isConnected = false, rail 41..820, the live row at 763..786.
  const view = await panel.evaluate((id) => {
    const el = document.querySelector(`[data-bookmark-id="${CSS.escape(id)}"]`);
    if (!el) return { found: false };
    const rail = document.getElementById('bookmark-rail').getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return {
      found: true,
      inView: box.top >= rail.top - 1 && box.bottom <= rail.bottom + 1,
      row: [Math.round(box.top), Math.round(box.bottom)],
      rail: [Math.round(rail.top), Math.round(rail.bottom)],
    };
  }, kids.at(-1).id);
  expect(view.found, 'the new folder\'s row is in the list').toBe(true);
  expect(view.inView, `the new folder's row is in view (row ${view.row}, rail ${view.rail})`).toBe(true);
  expect(errors).toEqual([]);
});

/* ── An empty folder says so; the field takes that line's place ───────────── */

granted('in an empty folder the field stands where the empty line was, Escape gives the line back, and a name makes the first child', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(180_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const seeded = await showColumn(harness, serviceWorker, [{ title: 'Nothing here', children: [] }]);
  await E.installWriteSpy(panel);
  await bar(panel).click();
  await openFolder(panel, E.rowTitled(panel, 'Nothing here'));
  const marker = panel.locator('[data-testid="bookmark-folder-empty"]');
  await expect(marker, 'an open empty folder says so').toHaveCount(1);

  const shape = async () => (await listOrder(panel)).map((entry) => entry.text);
  const before = await shape();
  expect(before.filter((text) => text === 'Nothing saved here yet')).toHaveLength(1);

  // The field is where the line was: the line is not drawn beside it.
  await openField(panel);
  await expect(marker).toHaveCount(0);
  const during = await shape();
  expect(during, 'the field replaces the empty line, one for one').toEqual(
    before.map((text) => (text === 'Nothing saved here yet' ? '[field:New folder]' : text)),
  );

  // Escape writes nothing and the line is back where it was.
  const mark = await spyMark(panel);
  await panel.locator(FIELD).press('Escape');
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  await expect(marker).toHaveCount(1);
  expect(await shape(), 'the list is exactly as it was').toEqual(before);
  expect(await writesSince(panel, mark)).toEqual([]);

  // A name makes the first child, and the empty line goes for good.
  await openField(panel);
  await panel.locator(FIELD).fill('First');
  await panel.locator(FIELD).press('Enter');
  await expect(E.rowTitled(panel, 'First')).toBeVisible({ timeout: 10_000 });
  await expect(marker).toHaveCount(0);
  expect(titles(await E.childrenOf(serviceWorker, seeded.ids['Nothing here']))).toEqual(['First']);
  expect(errors).toEqual([]);
});

/* ── B4.8: a change from outside while the field is open ──────────────────── */

granted('a change made elsewhere while the field is open waits: same field, same text, focus, no write; then it shows', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const seeded = await showColumn(harness, serviceWorker, [
    { title: 'Reading', children: [
      { title: 'A', url: 'https://a.example.com/' },
      { title: 'B', url: 'https://b.example.com/' },
    ] },
  ]);
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);
  await bar(panel).click();
  await openFolder(panel, E.rowTitled(panel, 'Reading'));
  await openField(panel);
  const field = panel.locator(FIELD);
  await field.fill('Typed');

  const token = await E.markNode(panel, FIELD);
  const rebuilt = await E.readRepaintSpy(panel);
  const mark = await spyMark(panel);

  // A bookmark appears in the same open folder, from the service worker: Chrome's own bookmark
  // manager, a sync, another window. The panel hears of it within 400 ms and would repaint.
  await E.externalWrite(serviceWorker, (a) => chrome.bookmarks.create(a),
    { parentId: seeded.ids.Reading, title: 'Ext', url: 'https://ext.example.com/' });

  // Time has to pass for there to be anything to see: more than three of the 400 ms debounces.
  // This is the one wait in the file that is not waiting for the product.
  await panel.evaluate(() => new Promise((resolve) => { setTimeout(resolve, 1600); }));

  expect(await E.sameNode(panel, FIELD), 'the field is the very node it was, still connected').toBe(true);
  expect(await panel.locator(FIELD).getAttribute('data-bm-mark')).toBe(token);
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('Typed');
  expect((await E.readRepaintSpy(panel)).removed, 'nothing in the list or the rail was taken out').toBe(rebuilt.removed);
  expect(await writesSince(panel, mark), 'the panel wrote nothing of its own').toEqual([]);
  await expect(E.rowTitled(panel, 'Ext'), 'and the change is not on screen yet: it is owed, not lost').toHaveCount(0);

  // Enter commits the name, and the repaint that was owed is the one that follows: both the
  // folder just made and the bookmark made elsewhere are on screen.
  await field.press('Enter');
  await expect(E.rowTitled(panel, 'Typed')).toBeVisible({ timeout: 10_000 });
  await expect(E.rowTitled(panel, 'Ext')).toBeVisible({ timeout: 10_000 });
  expect(await createsSince(panel, mark), 'one create, the panel\'s own').toHaveLength(1);
  expect(titles(await E.childrenOf(serviceWorker, seeded.ids.Reading))).toEqual(['A', 'B', 'Ext', 'Typed']);
  expect(errors).toEqual([]);
});

/* ── The column goes away under the field ─────────────────────────────────── */

granted('taking the column down while a name is being typed writes nothing, leaves nothing held, and the column comes back whole', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const seeded = await showColumn(harness, serviceWorker, [
    { title: 'Reading', children: [{ title: 'A', url: 'https://a.example.com/' }] },
  ]);
  await E.installWriteSpy(panel);
  await bar(panel).click();
  await openFolder(panel, E.rowTitled(panel, 'Reading'));
  await openField(panel);
  await panel.locator(FIELD).fill('Half typed');
  const mark = await spyMark(panel);

  // The side column is switched back to the tools (what a permission that is taken away does as
  // well). The field is removed with the rest of the column; removing a focused field fires
  // `blur` inside that very call, while the field is still attached (Probe 16 Result 6), so the
  // edit has to be gone BEFORE the rail is emptied or the half-typed name is written.
  await setSettings(serviceWorker, { railMode: 'tools' });
  await expect(panel.locator('[data-testid="bookmark-head"]')).toHaveCount(0, { timeout: 15_000 });
  await expect(panel.locator(FIELD)).toHaveCount(0);
  await settle(panel);
  expect(await createsSince(panel, mark), 'the field going away is not a commit').toEqual([]);

  // Back: the folders that were open are open, and nothing is held behind the reader's back, so
  // a change made elsewhere reaches the screen on its own and the button works as before.
  await setSettings(serviceWorker, { railMode: 'bookmarks' });
  await expect(panel.locator('[data-testid="bookmark-head"]')).toBeVisible({ timeout: 15_000 });
  await expect(E.rowTitled(panel, 'A')).toBeVisible({ timeout: 15_000 });
  await E.externalWrite(serviceWorker, (a) => chrome.bookmarks.create(a),
    { parentId: seeded.ids.Reading, title: 'Late', url: 'https://late.example.com/' });
  await expect(E.rowTitled(panel, 'Late'), 'a repaint is not being held').toBeVisible({ timeout: 10_000 });
  await openField(panel);
  await expect(panel.locator(FIELD)).toHaveValue('New folder');
  await panel.locator(FIELD).press('Escape');
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0);
  expect(titles(await E.childrenOf(serviceWorker, seeded.ids.Reading))).toEqual(['A', 'Late']);
  expect(await createsSince(panel, mark)).toEqual([]);
  expect(errors).toEqual([]);
});

/* ── B4.9: it cannot be done any more ─────────────────────────────────────── */

granted('if the folder is removed elsewhere before the name is committed, the reader is told and nothing throws', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(180_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const seeded = await showColumn(harness, serviceWorker, [
    { title: 'Doomed', children: [{ title: 'A', url: 'https://a.example.com/' }] },
    { title: 'Safe', children: [] },
  ]);
  await E.installWriteSpy(panel);
  await bar(panel).click();
  await openFolder(panel, E.rowTitled(panel, 'Doomed'));
  await openField(panel);
  const field = panel.locator(FIELD);
  await field.fill('Orphan');
  const mark = await spyMark(panel);

  await swEval(serviceWorker, (id) => chrome.bookmarks.removeTree(id), seeded.ids.Doomed);
  await field.press('Enter');

  // Chrome refuses a folder in a parent that is gone, and the reader is told; the message is the
  // generic one, not the one for "the bookmarks changed", because the write was attempted.
  await expect(panel.locator(TOAST)).toHaveText(EN.operationFailed.message, { timeout: 10_000 });
  const created = await createsSince(panel, mark);
  expect(created, 'the create was attempted once').toHaveLength(1);
  expect(created[0].status, 'and Chrome refused it').toBe('rejected');
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  await expect(E.rowTitled(panel, 'Doomed'), 'the folder that is gone is gone from the column').toHaveCount(0, { timeout: 10_000 });
  await expect(E.rowTitled(panel, 'Safe')).toBeVisible();
  expect(titles(await E.childrenOf(serviceWorker, seeded.barId)), 'and no orphan was made anywhere').toEqual(['Safe']);
  expect(errors, 'no uncaught error in the panel').toEqual([]);
});

/* ── The permission goes between the field and the answer ─────────────────── */

/**
 * The state a revoke leaves behind, staged as 32-bookmarks-rail does it (a real revoke cannot be
 * made under the synthesised grant): `contains()` says no, and the writes throw the way an API
 * that is no longer available does.
 */
const staleGrant = (panel) => panel.evaluate(() => {
  chrome.permissions.contains = () => Promise.resolve(false);
  const gone = (name) => () => Promise.reject(new Error(`'bookmarks.${name}' is not available in this context.`));
  chrome.bookmarks.update = gone('update');
  chrome.bookmarks.create = gone('create');
});

/** The column is the grant card again, the layout is the one the reader chose, and the last word was the denial. */
async function expectGrantCardAfterRevoke(panel, errors, what) {
  await expect(panel.locator('[data-testid="bookmark-grant"]'), `${what}: the grant card`).toBeVisible({ timeout: 15_000 });
  await expect(panel.locator('[data-testid="bookmark-list"]')).toHaveCount(0);
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0);
  expect(await panel.evaluate(() => window.__vt.settings.railMode), `${what}: the layout is untouched`).toBe('bookmarks');
  expect(await panel.evaluate(() => document.getElementById('bookmark-rail').hidden)).toBe(false);
  // The denial is the last toast (the single #toast takes the newest), and an "operation failed"
  // from the write that found out is not left behind on screen.
  await expect(panel.locator(TOAST)).toHaveText(EN.bookmarksDenied.message, { timeout: 10_000 });
  await panel.evaluate(() => new Promise((resolve) => { setTimeout(resolve, 3200); }));
  const left = (await panel.locator(TOAST).textContent()) || '';
  expect(['', EN.bookmarksDenied.message], `${what}: nothing but the denial may be left on screen`).toContain(left);
  expect(errors, `${what}: nothing threw`).toEqual([]);
}

granted('if the permission goes before a rename is committed, the column returns to the grant card and nothing throws', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(180_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  await showReading(harness, serviceWorker, [{ title: 'Link one', url: 'https://one.example.com/' }]);
  const field = panel.locator(FIELD);
  await pressF2On(panel, 'Link one');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.fill('Renamed');
  await staleGrant(panel);
  await field.press('Enter');
  await expectGrantCardAfterRevoke(panel, errors, 'a rename');
});

granted('if the permission goes before a new folder is committed, the column returns to the grant card and nothing throws', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(180_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  await showColumn(harness, serviceWorker, [
    { title: 'Reading', children: [{ title: 'A', url: 'https://a.example.com/' }] },
  ]);
  await bar(panel).click();
  await openFolder(panel, E.rowTitled(panel, 'Reading'));
  await openField(panel);
  const field = panel.locator(FIELD);
  await field.fill('Too late');
  await staleGrant(panel);
  await field.press('Enter');
  await expectGrantCardAfterRevoke(panel, errors, 'a new folder');
});

/* ── B4.6 / B4.7 / B4.8 / B4.9: renaming (F2) ─────────────────────────────── */

/**
 * A column over the folder "Reading", which holds `spec` (any depth), with the bar and Reading
 * opened and the write spy installed. The tree is seeded BEFORE the column is shown.
 */
async function showReading(harness, serviceWorker, spec) {
  const { panel } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });
  const base = await seedBookmarks(serviceWorker, [{ title: 'Reading', children: [] }]);
  const tree = await E.seedTree(serviceWorker, base.ids.Reading, spec);
  await showBookmarks(panel, serviceWorker);
  await expect(bar(panel)).toBeVisible({ timeout: 15_000 });
  await E.installWriteSpy(panel);
  await bar(panel).click();
  await openFolder(panel, E.rowTitled(panel, 'Reading'));
  return { barId: base.barId, reading: base.ids.Reading, ids: tree.ids };
}

const updatesSince = async (panel, mark) => (await writesSince(panel, mark)).filter((c) => c.method === 'update');
const activeId = (panel) => panel.evaluate(() => document.activeElement && document.activeElement.dataset.bookmarkId);

/** Put focus on a row and press F2. The field is asserted by the caller. */
async function pressF2On(panel, title) {
  await E.rowTitled(panel, title).focus();
  await panel.keyboard.press('F2');
}

granted('F2 renames a folder and a link in place: one update with the trimmed title, and a line break or a tab never reaches the stored title', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const seeded = await showReading(harness, serviceWorker, [
    { title: 'Sub', children: [] },
    { title: 'Link one', url: 'https://one.example.com/' },
    { title: 'Link two', url: 'https://two.example.com/' },
  ]);
  const { ids } = seeded;
  const field = panel.locator(FIELD);
  const mark = await spyMark(panel);

  // A FOLDER. The field takes the place of the row (the row is not drawn beside it), holds the
  // title, selected, and writes nothing until it is committed.
  await pressF2On(panel, 'Sub');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await expect(field).toHaveValue('Sub');
  await expect(field).toHaveAttribute('aria-label', 'Rename');
  expect(await field.evaluate((el) => [el.selectionStart, el.selectionEnd]), 'the title is selected').toEqual([0, 3]);
  await expect(E.rowTitled(panel, 'Sub'), 'the row it stands for is not drawn beside it').toHaveCount(0);
  const order = await listOrder(panel);
  const at = order.findIndex((entry) => entry.testid === 'bookmark-edit-row');
  expect(order[at - 1]).toMatchObject({ text: 'Reading', depth: 1 });
  expect(order[at], 'in the place of Sub: first child of Reading, one level in').toMatchObject({ depth: 2, text: '[field:Sub]' });
  expect(order[at + 1]).toMatchObject({ text: 'Link one', depth: 2 });
  expect(await updatesSince(panel, mark), 'opening the field writes nothing').toEqual([]);

  await field.fill('  Archive  ');
  await field.press('Enter');
  await expect.poll(async () => (await updatesSince(panel, mark)).length, { timeout: 10_000 }).toBe(1);
  const [first] = await updatesSince(panel, mark);
  expect(first.args, 'the node and the trimmed title').toEqual([ids.Sub, { title: 'Archive' }]);
  expect(first.keys, 'and nothing else, not even a url').toEqual([null, ['title']]);
  expect((await E.childrenOf(serviceWorker, seeded.reading))[0]).toMatchObject({ id: ids.Sub, title: 'Archive' });
  await expect(E.rowTitled(panel, 'Archive')).toHaveAttribute('data-bookmark-id', ids.Sub, { timeout: 10_000 });
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0);
  await expect.poll(() => activeId(panel), { timeout: 5_000 }).toBe(ids.Sub);

  // A LINK, and a tab in the name: Chrome turns each into one space, and so does the panel
  // before asking (Probe 13 P9), so what is stored is what was shown.
  await pressF2On(panel, 'Link one');
  await expect(field).toHaveValue('Link one');
  await field.fill('One\tof\ttwo');
  await field.press('Enter');
  await expect.poll(async () => (await updatesSince(panel, mark)).length, { timeout: 10_000 }).toBe(2);
  const link = (await E.childrenOf(serviceWorker, seeded.reading)).find((node) => node.id === ids['Link one']);
  expect(link.title).toBe('One of two');
  expect(link.url, 'a rename leaves the address alone').toBe('https://one.example.com/');
  await expect(E.rowTitled(panel, 'One of two')).toBeVisible({ timeout: 10_000 });

  // A line break cannot be typed into a one-line field, and one that arrives (a paste) does not
  // reach the stored title either.
  await pressF2On(panel, 'Link two');
  await field.fill('Two\nlines');
  await field.press('Enter');
  await expect.poll(async () => (await updatesSince(panel, mark)).length, { timeout: 10_000 }).toBe(3);
  const stored = (await E.childrenOf(serviceWorker, seeded.reading)).find((node) => node.id === ids['Link two']).title;
  expect(stored.startsWith('Two')).toBe(true);
  for (const call of await updatesSince(panel, mark)) {
    expect(call.args[1].title, 'no line break and no tab in anything that was sent').not.toMatch(/[\r\n\t]/);
  }
  expect(stored).not.toMatch(/[\r\n\t]/);
  expect(errors).toEqual([]);
});

granted('renaming writes nothing for Escape, an unchanged or empty name, or leaving it untouched, and the row comes back as it was', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const seeded = await showReading(harness, serviceWorker, [
    { title: 'Sub', children: [{ title: 'Inner', url: 'https://inner.example.com/' }] },
    { title: 'Link one', url: 'https://one.example.com/' },
    { title: 'Link two', url: 'https://two.example.com/' },
  ]);
  const { ids } = seeded;
  const field = panel.locator(FIELD);
  const mark = await spyMark(panel);
  const asItWas = async (why, { focus } = {}) => {
    expect(await updatesSince(panel, mark), `${why}: no update call`).toEqual([]);
    expect(titles(await E.childrenOf(serviceWorker, seeded.reading)), `${why}: the titles are as they were`)
      .toEqual(['Sub', 'Link one', 'Link two']);
    await expect(panel.locator(EDIT_ROW), `${why}: the field is gone`).toHaveCount(0);
    await expect(E.rowTitled(panel, 'Link one'), `${why}: and the row is back`).toHaveAttribute('data-bookmark-id', ids['Link one']);
    if (focus) await expect.poll(() => activeId(panel), { message: `${why}: focus is on the row`, timeout: 5_000 }).toBe(focus);
  };

  // Escape, after the name was changed.
  await pressF2On(panel, 'Link one');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.fill('Changed');
  await field.press('Escape');
  await asItWas('Escape after typing', { focus: ids['Link one'] });

  // Enter on the title as it is: the write module's "unchanged", so no call.
  await pressF2On(panel, 'Link one');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.press('Enter');
  await asItWas('Enter on an unchanged name', { focus: ids['Link one'] });

  // Enter on an empty name, and on one of spaces.
  await pressF2On(panel, 'Link one');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.fill('');
  await field.press('Enter');
  await asItWas('Enter on an empty name', { focus: ids['Link one'] });
  await pressF2On(panel, 'Link one');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.fill('   ');
  await field.press('Enter');
  await asItWas('Enter on a name of spaces', { focus: ids['Link one'] });

  // Leaving the field untouched.
  await pressF2On(panel, 'Link one');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await panel.evaluate(() => document.activeElement.blur());
  await asItWas('blur with the title untouched');

  // Clicking another row: the edit ends without a write, the row it stood for is back, and the
  // click still does its job (as for a new folder: the row under the pointer is not rebuilt).
  await pressF2On(panel, 'Link one');
  await expect(field).toBeFocused({ timeout: 10_000 });
  const reading = E.rowTitled(panel, 'Reading');
  const box = await reading.boundingBox();
  await panel.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await panel.mouse.down();
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  expect(await updatesSince(panel, mark), 'a click on another row: no update call').toEqual([]);
  await expect(E.rowTitled(panel, 'Link one'), 'and the row is back').toBeVisible();
  await panel.mouse.up();
  await expect(reading, 'and the click closed the folder it was on').toHaveAttribute('aria-expanded', 'false', { timeout: 10_000 });
  await openFolder(panel, reading);

  // A folder that is open keeps being open: the field stands for it, and Escape gives it back
  // with its children still under it.
  await openFolder(panel, E.rowTitled(panel, 'Sub'));
  await expect(E.rowTitled(panel, 'Inner')).toBeVisible();
  await pressF2On(panel, 'Sub');
  await expect(field).toBeFocused({ timeout: 10_000 });
  expect(await panel.locator(EDIT_ROW).getAttribute('data-open'), 'the field wears the open state').toBe('1');
  await expect(E.rowTitled(panel, 'Inner'), 'its child stays where it was').toBeVisible();
  await field.press('Escape');
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  await expect(E.rowTitled(panel, 'Sub')).toHaveAttribute('aria-expanded', 'true');
  await expect(E.rowTitled(panel, 'Inner')).toBeVisible();
  await expect.poll(() => activeId(panel), { timeout: 5_000 }).toBe(ids.Sub);
  expect(await updatesSince(panel, mark)).toEqual([]);
  expect(errors).toEqual([]);

  // And a changed name left by clicking away rather than by Enter IS written, once.
  await pressF2On(panel, 'Link two');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.fill('Via blur');
  await panel.evaluate(() => document.activeElement.blur());
  await expect.poll(async () => (await updatesSince(panel, mark)).length, { timeout: 10_000 }).toBe(1);
  expect((await updatesSince(panel, mark))[0].args).toEqual([ids['Link two'], { title: 'Via blur' }]);
  await expect(E.rowTitled(panel, 'Via blur')).toBeVisible({ timeout: 10_000 });
  await sleep(600);
  expect(await updatesSince(panel, mark), 'once, and not again after the repaint').toHaveLength(1);
  expect(errors).toEqual([]);
});

granted('a rename ended by a click away leaves one row reachable with Tab, and from Enter to the answer the field is read-only and the repaint stays held', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const seeded = await showReading(harness, serviceWorker, [
    { title: 'Link one', url: 'https://one.example.com/' },
    { title: 'Link two', url: 'https://two.example.com/' },
  ]);
  const { ids } = seeded;
  const field = panel.locator(FIELD);
  const mark = await spyMark(panel);
  const tabStops = () => panel.evaluate(() => [...document.querySelectorAll('[data-testid="bookmark-row"]')]
    .filter((el) => el.tabIndex === 0).map((el) => el.dataset.bookmarkId));

  // The arrow keys move the one tab stop (a roving tabindex): bar, Reading, Link one.
  await bar(panel).focus();
  await panel.keyboard.press('ArrowDown');
  await panel.keyboard.press('ArrowDown');
  await expect.poll(() => activeId(panel), { timeout: 5_000 }).toBe(ids['Link one']);
  expect(await tabStops(), 'Link one is the tab stop').toEqual([ids['Link one']]);

  // F2 replaces that row with the field, and a click away (here: the blur of an untouched field)
  // draws a new row in its place. The list must still have a row that Tab reaches.
  await panel.keyboard.press('F2');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await panel.evaluate(() => document.activeElement.blur());
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  await expect(E.rowTitled(panel, 'Link one')).toBeVisible();
  expect((await tabStops()).length, 'one row is still reachable with Tab').toBe(1);

  // The write is held in the panel, so the time between Enter and the answer can be looked at.
  // The asks are counted HERE, at the wrapper that holds them: the write spy sits behind it and
  // only sees a call when it is released, so a second ask that is never released would go unseen.
  await panel.evaluate(() => {
    const real = chrome.bookmarks.update;
    window.__updateAsks = 0;
    chrome.bookmarks.update = (...args) => {
      window.__updateAsks += 1;
      return new Promise((resolve, reject) => {
        window.__release = () => Promise.resolve(real.apply(chrome.bookmarks, args)).then(resolve, reject);
      });
    };
  });
  await pressF2On(panel, 'Link two');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.fill('Two, renamed');
  await field.press('Enter');
  await expect.poll(() => panel.evaluate(() => typeof window.__release), { timeout: 10_000 }).toBe('function');
  expect(await field.evaluate((el) => el.readOnly), 'the name is final: the field no longer takes typing').toBe(true);
  await expect(panel.locator(EDIT_ROW), 'and it stays on screen until the answer').toHaveCount(1);

  // A click away in that window is a second "leave the field", and must not be a second write.
  await panel.evaluate(() => document.activeElement.blur());
  await settle(panel);
  await expect(panel.locator(EDIT_ROW), 'the field still waits for the answer').toHaveCount(1);

  // A change made elsewhere in that window waits too: the row that replaces the field comes from
  // the paint that follows the write, and it shows both. (Time has to pass for there to be
  // anything to see: more than two of the 400 ms debounces.)
  await E.externalWrite(serviceWorker, (a) => chrome.bookmarks.create(a),
    { parentId: seeded.reading, title: 'Ext', url: 'https://ext.example.com/' });
  await panel.evaluate(() => new Promise((resolve) => { setTimeout(resolve, 900); }));
  await expect(E.rowTitled(panel, 'Ext'), 'held').toHaveCount(0);
  await expect(panel.locator(EDIT_ROW)).toHaveCount(1);

  await panel.evaluate(() => window.__release());
  await expect(E.rowTitled(panel, 'Two, renamed')).toBeVisible({ timeout: 10_000 });
  await expect(E.rowTitled(panel, 'Ext'), 'and now shown').toBeVisible({ timeout: 10_000 });
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0);
  expect(await updatesSince(panel, mark)).toHaveLength(1);
  expect(await panel.evaluate(() => window.__updateAsks), 'and Chrome was asked once, not twice').toBe(1);
  expect(errors).toEqual([]);
});

granted('F2 renames only what can be renamed, only with no modifier, and claims no key it does not use', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(180_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const seeded = await showReading(harness, serviceWorker, [
    { title: 'Link one', url: 'https://one.example.com/' },
    { title: 'Managed link', url: 'https://managed.example.com/' },
  ]);
  const field = panel.locator(FIELD);
  const mark = await spyMark(panel);

  /** Send F2 to the row and say whether the column claimed the key (`preventDefault`). */
  const sendF2 = (locator, modifiers = {}) => locator.evaluate((el, mods) => {
    const event = new KeyboardEvent('keydown', { key: 'F2', code: 'F2', bubbles: true, cancelable: true, ...mods });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  }, modifiers);

  // A permanent folder (a child of the root): Chrome refuses every write to those, so the
  // column does not offer it, and it does not take the key either.
  const root = bar(panel);
  await root.focus();
  expect(await sendF2(root), 'F2 on a permanent folder is not claimed').toBe(false);
  await panel.keyboard.press('F2');
  await settle(panel);
  await expect(panel.locator(EDIT_ROW), 'and opens nothing').toHaveCount(0);

  // The chords that are not F2: they belong to the browser and the system.
  const link = E.rowTitled(panel, 'Link one');
  for (const mods of [{ ctrlKey: true }, { altKey: true }, { shiftKey: true }, { metaKey: true }]) {
    expect(await sendF2(link, mods), `${Object.keys(mods)[0]}+F2 is not claimed`).toBe(false);
  }
  await settle(panel);
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0);

  // Plain F2 on a row that can be renamed IS claimed, and opens the field; F2 inside the field
  // does nothing (the field is not a row).
  expect(await sendF2(link), 'plain F2 on a link is claimed').toBe(true);
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.fill('Half');
  await field.press('F2');
  await settle(panel);
  await expect(panel.locator(EDIT_ROW)).toHaveCount(1);
  await expect(field).toHaveValue('Half');
  await field.press('Escape');
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });

  // A node Chrome marks `unmodifiable` (a managed bookmark) is not renamed either. None can be
  // made in this harness (the flag has never been observed: Probe 13 P5 and P12), so the panel's
  // own read is made to report it for one bookmark. That is a STAND-IN for the flag, not the real
  // thing; what it shows is that the column reads the flag and acts on it.
  await panel.evaluate((id) => {
    const real = chrome.bookmarks.getChildren;
    chrome.bookmarks.getChildren = async (...args) => (await real.apply(chrome.bookmarks, args))
      .map((node) => (node.id === id ? { ...node, unmodifiable: 'managed' } : node));
  }, seeded.ids['Managed link']);
  await E.externalWrite(serviceWorker, (a) => chrome.bookmarks.create(a),
    { parentId: seeded.reading, title: 'Trigger', url: 'https://trigger.example.com/' });
  await expect(E.rowTitled(panel, 'Trigger'), 'a repaint that read the flag').toBeVisible({ timeout: 10_000 });
  expect(await sendF2(E.rowTitled(panel, 'Managed link')), 'F2 on an unmodifiable node is not claimed').toBe(false);
  await settle(panel);
  await expect(panel.locator(EDIT_ROW), 'and opens nothing').toHaveCount(0);
  expect(await sendF2(E.rowTitled(panel, 'Link one')), 'while a node that is not marked still is').toBe(true);
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.press('Escape');
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  expect(await updatesSince(panel, mark)).toEqual([]);
  expect(errors).toEqual([]);
});

granted('Enter in a rename field opens nothing, a click in it toggles nothing, and a folder keeps its open state through the edit', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel, urls } = harness;
  const errors = watchErrors(panel);
  const seeded = await showReading(harness, serviceWorker, [
    { title: 'Alpha, already open', url: urls.alpha },
    { title: 'Sub', children: [{ title: 'Inner', url: 'https://inner.example.com/' }] },
  ]);
  const field = panel.locator(FIELD);
  await panel.evaluate(() => {
    window.__tabCalls = [];
    for (const [ns, name] of [['tabs', 'create'], ['tabs', 'update'], ['windows', 'update']]) {
      const real = chrome[ns][name].bind(chrome[ns]);
      chrome[ns][name] = (...args) => { window.__tabCalls.push(`${ns}.${name}`); return real(...args); };
    }
  });
  const tabCalls = () => panel.evaluate(() => window.__tabCalls.slice());
  const tabsInW2 = () => swEval(serviceWorker, (id) => chrome.tabs.query({ windowId: id }).then((ts) => ts.length), harness.w2);

  // The recorder can see an activation (and so "nothing" below means something).
  await E.rowTitled(panel, 'Alpha, already open').click();
  await expect.poll(tabCalls, { timeout: 10_000 }).toContain('tabs.update');
  const tabsBefore = await tabsInW2();
  await panel.evaluate(() => { window.__tabCalls.length = 0; });
  const mark = await spyMark(panel);

  // The row of a page that is open: a rename and Enter. An Enter that reached the row's own
  // handler would activate that tab.
  await pressF2On(panel, 'Alpha, already open');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.fill('Alpha, renamed');
  await field.press('Enter');
  await expect.poll(async () => (await updatesSince(panel, mark)).length, { timeout: 10_000 }).toBe(1);
  await expect(E.rowTitled(panel, 'Alpha, renamed')).toBeVisible({ timeout: 10_000 });
  expect(await tabCalls(), 'Enter in the field opened and activated nothing').toEqual([]);
  expect(await tabsInW2(), 'and no tab appeared').toBe(tabsBefore);

  // An open folder, a click inside its field: it stays open, and the field stays.
  await openFolder(panel, E.rowTitled(panel, 'Sub'));
  await expect(E.rowTitled(panel, 'Inner')).toBeVisible();
  await pressF2On(panel, 'Sub');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.click();
  await settle(panel);
  await expect(field).toBeFocused();
  await expect(E.rowTitled(panel, 'Inner'), 'a click in the field did not close the folder').toBeVisible();
  await field.press('Escape');
  await expect(E.rowTitled(panel, 'Sub')).toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 });
  expect(await tabCalls()).toEqual([]);
  expect(titles(await E.childrenOf(serviceWorker, seeded.reading))).toEqual(['Alpha, renamed', 'Sub']);
  expect(errors).toEqual([]);
});

granted('a change made elsewhere while a rename is open waits: same field, same text, no write; then both show', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const seeded = await showReading(harness, serviceWorker, [
    { title: 'Link one', url: 'https://one.example.com/' },
    { title: 'Link two', url: 'https://two.example.com/' },
  ]);
  await E.installRepaintSpy(panel);
  await pressF2On(panel, 'Link one');
  const field = panel.locator(FIELD);
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.fill('Typed');
  const token = await E.markNode(panel, FIELD);
  const rebuilt = await E.readRepaintSpy(panel);
  const mark = await spyMark(panel);

  await E.externalWrite(serviceWorker, (a) => chrome.bookmarks.create(a),
    { parentId: seeded.reading, title: 'Ext', url: 'https://ext.example.com/' });
  await panel.evaluate(() => new Promise((resolve) => { setTimeout(resolve, 1600); }));

  expect(await E.sameNode(panel, FIELD), 'the very node it was, still connected').toBe(true);
  expect(await panel.locator(FIELD).getAttribute('data-bm-mark')).toBe(token);
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('Typed');
  expect((await E.readRepaintSpy(panel)).removed, 'nothing was taken out of the list or the rail').toBe(rebuilt.removed);
  expect(await writesSince(panel, mark), 'and the panel wrote nothing of its own: a half-typed name is not a commit').toEqual([]);
  await expect(E.rowTitled(panel, 'Ext'), 'owed, not lost').toHaveCount(0);

  await field.press('Enter');
  await expect(E.rowTitled(panel, 'Typed')).toBeVisible({ timeout: 10_000 });
  await expect(E.rowTitled(panel, 'Ext')).toBeVisible({ timeout: 10_000 });
  expect(await updatesSince(panel, mark)).toHaveLength(1);
  expect(titles(await E.childrenOf(serviceWorker, seeded.reading))).toEqual(['Typed', 'Link two', 'Ext']);
  expect(errors).toEqual([]);
});

granted('if the bookmark is removed elsewhere before its new name is committed, the reader is told, the row goes, nothing throws', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(180_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const seeded = await showReading(harness, serviceWorker, [
    { title: 'Doomed link', url: 'https://doomed.example.com/' },
    { title: 'Safe link', url: 'https://safe.example.com/' },
  ]);
  const field = panel.locator(FIELD);
  await pressF2On(panel, 'Doomed link');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.fill('Renamed too late');
  const mark = await spyMark(panel);

  await swEval(serviceWorker, (id) => chrome.bookmarks.remove(id), seeded.ids['Doomed link']);
  await field.press('Enter');

  await expect(panel.locator(TOAST)).toHaveText(EN.operationFailed.message, { timeout: 10_000 });
  const tried = await updatesSince(panel, mark);
  expect(tried, 'the update was attempted once').toHaveLength(1);
  expect(tried[0].status, 'and Chrome refused it').toBe('rejected');
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  await expect(E.rowTitled(panel, 'Doomed link'), 'the row is gone after the repaint').toHaveCount(0, { timeout: 10_000 });
  await expect(E.rowTitled(panel, 'Renamed too late'), 'and the new name is nowhere').toHaveCount(0);
  await expect(E.rowTitled(panel, 'Safe link')).toBeVisible();
  expect(titles(await E.childrenOf(serviceWorker, seeded.reading))).toEqual(['Safe link']);
  expect(errors, 'no uncaught error in the panel').toEqual([]);
});

/* ── CLAUDE.md section 4: colours from the palette, light and dark ────────── */

granted('the name field takes its colours from the palette: the same tokens, a different answer in light and in dark', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(180_000);
  const { panel } = harness;
  await showColumn(harness, serviceWorker, [
    { title: 'Reading', children: [{ title: 'A', url: 'https://a.example.com/' }] },
  ]);
  await setSettings(serviceWorker, { theme: 'dark' });
  await expect(panel.locator('html')).toHaveAttribute('data-theme', 'dark');
  await bar(panel).click();
  await openFolder(panel, E.rowTitled(panel, 'Reading'));
  await openField(panel);

  // What the field is drawn with, and what each palette token resolves to on this page now.
  const paint = () => panel.evaluate(() => {
    const resolve = (token) => {
      const probe = document.createElement('div');
      probe.style.backgroundColor = `var(${token})`;
      document.body.append(probe);
      const colour = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return colour;
    };
    const style = getComputedStyle(document.querySelector('[data-testid="bookmark-rename-input"]'));
    return {
      field: { background: style.backgroundColor, border: style.borderTopColor, text: style.color },
      tokens: { background: resolve('--vt-input-bg'), border: resolve('--vt-input-border'), text: resolve('--vt-text') },
    };
  });
  const dark = await paint();
  expect(dark.field, 'dark: drawn with the tokens').toEqual(dark.tokens);

  await setSettings(serviceWorker, { theme: 'light' });
  await expect(panel.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(panel.locator(FIELD), 'switching theme left the field alone').toBeFocused();
  const light = await paint();
  expect(light.field, 'light: drawn with the tokens').toEqual(light.tokens);
  expect(light.tokens.background, 'and the two palettes really differ, or the check above proves nothing')
    .not.toBe(dark.tokens.background);
  expect(light.tokens.text).not.toBe(dark.tokens.text);
});

/* ── B13: the words, in Japanese ──────────────────────────────────────────── */

// `LANGUAGE` / `LC_ALL` choose the application locale (`_locales/ja`) and `locale` the renderer's;
// both are needed (09-i18n.spec.js, 39-bookmark-preview.spec.js).
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

grantedJa('in Japanese the button, its tooltip, the field and the default name are the Japanese strings', async ({
  harness, serviceWorker,
}) => {
  grantedJa.setTimeout(240_000);
  const { panel } = harness;
  await showColumn(harness, serviceWorker, [
    { title: 'Reading', children: [{ title: 'A', url: 'https://a.example.com/' }] },
  ]);
  // The key is asserted to exist before its text is read: a table without it must fail an
  // assertion, not throw a TypeError.
  const ja = (key) => {
    expect(JA[key], `${key} is in the Japanese table`).toBeDefined();
    return JA[key].message;
  };
  for (const key of ['bookmarksNewFolder', 'bookmarksNewFolderIn', 'bookmarksFolderDefaultName', 'bookmarksRename', 'bookmarksRenameField']) {
    // Kana or a CJK ideograph: a name such as 名前 has no kana in it.
    expect(ja(key), `${key} really is Japanese`).toMatch(/[぀-ヿ㐀-鿿]/);
  }

  const button = panel.locator(NEW_FOLDER);
  await expect(button).toHaveAttribute('title', ja('bookmarksNewFolder'));
  await expect(button).toHaveAttribute('aria-label', ja('bookmarksNewFolder'));
  await bar(panel).click();
  await openFolder(panel, E.rowTitled(panel, 'Reading'));
  const named = ja('bookmarksNewFolderIn').replace('$FOLDER$', 'Reading');
  await expect(button).toHaveAttribute('title', named);
  await expect(button).toHaveAttribute('aria-label', named);

  await button.click();
  const field = panel.locator(FIELD);
  await expect(field).toBeFocused({ timeout: 10_000 });
  await expect(field).toHaveValue(ja('bookmarksFolderDefaultName'));
  await expect(field).toHaveAttribute('aria-label', ja('bookmarksRenameField'));

  // A rename names its field "Rename".
  await field.press('Escape');
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
  await E.rowTitled(panel, 'A').focus();
  await panel.keyboard.press('F2');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await expect(field).toHaveValue('A');
  await expect(field).toHaveAttribute('aria-label', ja('bookmarksRename'));
});

/* ── U4b: holes an independent mutation run found in the tests above ──────────
   Each of the five tests below is green on the extension as shipped and red, by its own
   assertion, on the one-line mutant it was written for (named in its comment). */

/**
 * Hear of a change made elsewhere (a bookmark made in the service worker) and wait until the
 * panel's own repaint debounce (400 ms) has certainly run its course, which with a field open means
 * been refused by the hold and owed. The wait is anchored on the panel hearing of the change: a
 * listener added here runs after the panel's own, the one that arms the 400 ms timer, and ends 700 ms
 * later on the same clock, so it cannot end before that timer has fired however long the event took
 * to arrive.
 */
async function changeElsewhere(panel, serviceWorker, item) {
  await panel.evaluate(() => {
    window.__heardOfIt = new Promise((resolve) => {
      chrome.bookmarks.onCreated.addListener(function once() {
        chrome.bookmarks.onCreated.removeListener(once);
        setTimeout(resolve, 700);
      });
    });
  });
  await E.externalWrite(serviceWorker, (a) => chrome.bookmarks.create(a), item);
  await panel.evaluate(() => window.__heardOfIt);
}

// O21: the name is trimmed on its way to Chrome (a create that sent the raw text survived).
granted('a new folder is made with the name as typed, without the spaces round it', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(180_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const seeded = await showColumn(harness, serviceWorker, [
    { title: 'Reading', children: [{ title: 'A', url: 'https://a.example.com/' }] },
  ]);
  await E.installWriteSpy(panel);
  await bar(panel).click();
  await openFolder(panel, E.rowTitled(panel, 'Reading'));
  const mark = await spyMark(panel);
  await openField(panel);
  await panel.locator(FIELD).fill('  Projects  ');
  await panel.locator(FIELD).press('Enter');
  await expect.poll(async () => (await createsSince(panel, mark)).length, { timeout: 10_000 }).toBe(1);
  const [made] = await createsSince(panel, mark);
  expect(made.args, 'the spaces round the name are not part of it').toEqual([
    { parentId: seeded.ids.Reading, title: 'Projects' },
  ]);
  expect(titles(await E.childrenOf(serviceWorker, seeded.ids.Reading))).toEqual(['A', 'Projects']);
  expect(errors).toEqual([]);
});

// O04: a name written because the reader moved focus elsewhere must not take that focus back.
granted('a name written because focus moved to another control leaves the focus where the reader put it', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const seeded = await showReading(harness, serviceWorker, [
    { title: 'Link one', url: 'https://one.example.com/' },
  ]);
  const field = panel.locator(FIELD);
  const search = panel.locator('#search-input');
  const focusedId = () => panel.evaluate(() => document.activeElement && document.activeElement.id);
  const mark = await spyMark(panel);

  // A new folder: the reader types a name and moves on to the search box.
  await openField(panel);
  await field.fill('Left by focus');
  await search.focus();
  await expect.poll(async () => (await createsSince(panel, mark)).length, { timeout: 10_000 }).toBe(1);
  await expect(E.rowTitled(panel, 'Left by focus')).toBeVisible({ timeout: 10_000 });
  await settle(panel);
  expect(await focusedId(), 'focus stayed on the search box, and did not go to the row that was made').toBe('search-input');

  // A rename, the same way.
  await pressF2On(panel, 'Link one');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.fill('Link one, renamed');
  await search.focus();
  await expect.poll(async () => (await updatesSince(panel, mark)).length, { timeout: 10_000 }).toBe(1);
  await expect(E.rowTitled(panel, 'Link one, renamed')).toBeVisible({ timeout: 10_000 });
  await settle(panel);
  expect(await focusedId(), 'and again for a rename').toBe('search-input');
  expect(titles(await E.childrenOf(serviceWorker, seeded.reading))).toEqual(['Link one, renamed', 'Left by focus']);
  expect(errors).toEqual([]);
});

// O13: after a write Chrome refuses, the field is released and the list repainted. Nothing in the
// tree changes and the permission stays, so no event follows that could repaint the list for it
// (the removal in the failure test above does, and hides a missing repaint).
granted('a write that Chrome refuses, with nothing changing in the tree, releases the field and brings the old row back', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const seeded = await showReading(harness, serviceWorker, [
    { title: 'Link one', url: 'https://one.example.com/' },
  ]);
  const field = panel.locator(FIELD);
  const refuse = (method) => panel.evaluate((name) => {
    chrome.bookmarks[name] = () => Promise.reject(new Error('Chrome would not do that'));
  }, method);

  // A rename.
  await pressF2On(panel, 'Link one');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.fill('Renamed');
  await refuse('update');
  await field.press('Enter');
  await expect(panel.locator(TOAST)).toHaveText(EN.operationFailed.message, { timeout: 10_000 });
  await expect(panel.locator(EDIT_ROW), 'the field is released').toHaveCount(0, { timeout: 10_000 });
  await expect(E.rowTitled(panel, 'Link one'), 'and the row is back with its old title').toBeVisible({ timeout: 10_000 });
  await expect(E.rowTitled(panel, 'Renamed')).toHaveCount(0);
  expect(titles(await E.childrenOf(serviceWorker, seeded.reading))).toEqual(['Link one']);

  // A new folder.
  await expect(panel.locator(TOAST), 'the first toast has gone').toBeHidden({ timeout: 10_000 });
  await openField(panel);
  await field.fill('Refused');
  await refuse('create');
  await field.press('Enter');
  await expect(panel.locator(TOAST)).toHaveText(EN.operationFailed.message, { timeout: 10_000 });
  await expect(panel.locator(EDIT_ROW), 'the field is released').toHaveCount(0, { timeout: 10_000 });
  await expect(E.rowTitled(panel, 'Refused')).toHaveCount(0);
  expect(titles(await E.childrenOf(serviceWorker, seeded.reading))).toEqual(['Link one']);

  // And nothing is held: a change made elsewhere reaches the screen on its own.
  await E.externalWrite(serviceWorker, (a) => chrome.bookmarks.create(a),
    { parentId: seeded.reading, title: 'Ext', url: 'https://ext.example.com/' });
  await expect(E.rowTitled(panel, 'Ext')).toBeVisible({ timeout: 10_000 });
  expect(errors).toEqual([]);
});

// O15: ending a new-folder field takes its row off the count of rows drawn. Opened last, the
// short folder is the one the field goes into, and it sits above a long open one, so the field is
// inside the first chunk of 150 rows and the chunks that are drawn later start where the count says.
granted('cancelling a new-folder field above a long open folder leaves no row of that folder undrawn', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const seeded = await showColumn(harness, serviceWorker, [
    { title: 'Short', children: [
      { title: 'S1', url: 'https://s1.example.com/' },
      { title: 'S2', url: 'https://s2.example.com/' },
    ] },
    { title: 'Long', children: [] },
  ]);
  await swEval(serviceWorker, async (a) => {
    for (let i = 0; i < a.n; i += 1) {
      await chrome.bookmarks.create({
        parentId: a.parentId, title: `Item ${String(i).padStart(3, '0')}`, url: `https://bulk.example.com/${i}`,
      });
    }
  }, { parentId: seeded.ids.Long, n: 400 });
  await bar(panel).click();
  await openFolder(panel, E.rowTitled(panel, 'Long'));
  await openFolder(panel, E.rowTitled(panel, 'Short'));
  // The premises: the list is chunked, and the folder the button writes into is the one on top.
  await expect(panel.locator('[data-testid="bookmark-more"]')).toBeVisible();
  await expect(E.rowTitled(panel, 'Item 399'), 'the end of the long folder is not drawn yet').toHaveCount(0);
  await expect(panel.locator(NEW_FOLDER)).toHaveAttribute('title', 'New folder in “Short”');

  await openField(panel);
  await panel.locator(FIELD).press('Escape');
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });

  // Scroll to the end until everything the list owes has been drawn: all 400, the row at the old
  // chunk boundary included.
  await expect.poll(async () => {
    await panel.evaluate(() => {
      const rail = document.getElementById('bookmark-rail');
      rail.scrollTop = rail.scrollHeight;
    });
    return (await rows(panel)).filter((row) => row.text.startsWith('Item ')).length;
  }, { timeout: 30_000, message: 'every one of the 400 rows is drawn once the list has been scrolled to its end' }).toBe(400);
  expect(errors).toEqual([]);
});

// O19: a change from elsewhere that arrived while a field was open is shown when the edit ends
// without a write, on Escape, for a new folder and for a rename (the held-edit tests above end
// theirs with Enter, which writes and so repaints anyway).
granted('a change made elsewhere during an edit is shown when the edit ends without a write: Escape on a new folder, Escape on a rename', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const seeded = await showReading(harness, serviceWorker, [
    { title: 'Link one', url: 'https://one.example.com/' },
  ]);
  const field = panel.locator(FIELD);
  const mark = await spyMark(panel);

  // A new folder, left with Escape.
  await openField(panel);
  await field.fill('Never made');
  await changeElsewhere(panel, serviceWorker,
    { parentId: seeded.reading, title: 'Ext one', url: 'https://e1.example.com/' });
  await expect(E.rowTitled(panel, 'Ext one'), 'owed, and not shown while the field is open').toHaveCount(0);
  await field.press('Escape');
  await expect(E.rowTitled(panel, 'Ext one'), 'shown once the edit is over').toBeVisible({ timeout: 10_000 });
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0);

  // A rename, left with Escape.
  await pressF2On(panel, 'Link one');
  await expect(field).toBeFocused({ timeout: 10_000 });
  await field.fill('Never saved');
  await changeElsewhere(panel, serviceWorker,
    { parentId: seeded.reading, title: 'Ext two', url: 'https://e2.example.com/' });
  await expect(E.rowTitled(panel, 'Ext two'), 'owed, and not shown while the field is open').toHaveCount(0);
  await field.press('Escape');
  await expect(E.rowTitled(panel, 'Ext two'), 'shown once the edit is over').toBeVisible({ timeout: 10_000 });
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0);
  expect(await writesSince(panel, mark), 'and the panel wrote nothing').toEqual([]);
  expect(errors).toEqual([]);
});

/* ── U4b: the click that ends an edit ─────────────────────────────────────────
   Leaving a field by pressing on another row ends the edit inside that press: the blur fires on the
   mousedown. A repaint started then rebuilds every row, the one under the pointer included, and the
   release finds nothing to click (Chrome sends no click when the node the button went down on has
   left the document). So no repaint may START while the button is down. A repaint begins with a read
   of the roots, which the write spy records the moment the call is made, so "none started" is checked
   at the instant the press has returned, with no waiting. */

/** Put the pointer on a row, press the button, and keep it down. */
async function pressOn(panel, row) {
  const box = await row.boundingBox();
  await panel.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await panel.mouse.down();
}

/** Every `getChildren` the panel asked since `mark`: a repaint starts with one. */
const readsSince = async (panel, mark) => (await E.readWriteSpy(panel, mark))
  .filter((c) => c.method === 'getChildren');

granted('a click that ends an edit is not lost to a repaint that was owed: nothing is rebuilt while the button is still down', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const seeded = await showColumn(harness, serviceWorker, [
    { title: 'Other', children: [{ title: 'X', url: 'https://x.example.com/' }] },
    { title: 'Reading', children: [
      { title: 'A', url: 'https://a.example.com/' },
      { title: 'B', url: 'https://b.example.com/' },
    ] },
  ]);
  await E.installWriteSpy(panel);
  await bar(panel).click();
  await openFolder(panel, E.rowTitled(panel, 'Reading'));
  await openField(panel);

  // A change from outside while the untouched field is open: the repaint it asks for is refused and owed.
  await changeElsewhere(panel, serviceWorker,
    { parentId: seeded.ids.Reading, title: 'Ext', url: 'https://ext.example.com/' });
  await expect(E.rowTitled(panel, 'Ext'), 'owed, and not shown while the field is open').toHaveCount(0);

  // Press on another row, closed, and keep the button down. It is ABOVE the field on purpose: when the
  // edit ends, the field's own row leaves the list, so a row below it would slide up from under the
  // pointer and the release would land on the list instead of on that row (measured: the click goes to
  // the list, 25 px of slide). That is a different loss from the one pinned here, a rebuild.
  const other = E.rowTitled(panel, 'Other');
  await expect(other).toHaveAttribute('aria-expanded', 'false');
  const mark = await spyMark(panel);
  await pressOn(panel, other);
  await expect(panel.locator(EDIT_ROW), 'the press ended the edit').toHaveCount(0, { timeout: 10_000 });
  expect(await readsSince(panel, mark), 'no repaint has started under the pointer').toEqual([]);

  // The release completes the click, and only then does the owed repaint show what was waiting.
  await panel.mouse.up();
  await expect(other, 'the click that ended the edit still did its job: it opened the row it was on')
    .toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 });
  await expect(E.rowTitled(panel, 'X')).toBeVisible({ timeout: 10_000 });
  await expect(E.rowTitled(panel, 'Ext'), 'and the change that was owed is shown now').toBeVisible({ timeout: 10_000 });
  expect(errors).toEqual([]);
});

granted('a click that ends an edit by writing a changed name is not lost either: the list waits for the button to come up', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const seeded = await showColumn(harness, serviceWorker, [
    { title: 'Reading', children: [
      { title: 'A', url: 'https://a.example.com/' },
      { title: 'B', url: 'https://b.example.com/' },
    ] },
    { title: 'Other', children: [{ title: 'X', url: 'https://x.example.com/' }] },
  ]);
  await E.installWriteSpy(panel);
  await bar(panel).click();
  await openFolder(panel, E.rowTitled(panel, 'Reading'));
  await openField(panel);
  await panel.locator(FIELD).fill('Clicked away');

  // The write that the press makes raises the panel's own event, which asks for a repaint 400 ms
  // later, and a press can outlast that on a slow host. The timer is swallowed here so that the one
  // repaint that can start under the pointer is the one the edit's end asks for (the count shows the
  // timer was there to swallow). Everything else about the panel is as shipped.
  await panel.evaluate(() => {
    const real = window.setTimeout.bind(window);
    window.__swallowed = 0;
    window.setTimeout = (fn, ms, ...rest) => {
      if (ms === 400) {
        window.__swallowed += 1;
        return 0;
      }
      return real(fn, ms, ...rest);
    };
  });

  const other = E.rowTitled(panel, 'Other');
  await expect(other).toHaveAttribute('aria-expanded', 'false');
  const mark = await spyMark(panel);
  await pressOn(panel, other);
  // The press wrote the name, and Chrome has answered.
  await expect.poll(async () => (await createsSince(panel, mark)).filter((c) => c.status === 'resolved').length,
    { timeout: 10_000 }).toBe(1);
  expect(await panel.evaluate(() => window.__swallowed), 'the write\'s own event asked for a repaint').toBeGreaterThan(0);
  expect(await readsSince(panel, mark), 'no repaint has started under the pointer').toEqual([]);

  await panel.mouse.up();
  await expect(other, 'the click that ended the edit still did its job: it opened the row it was on')
    .toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 });
  await expect(E.rowTitled(panel, 'Clicked away'), 'and the folder that was made is shown').toBeVisible({ timeout: 10_000 });
  expect(titles(await E.childrenOf(serviceWorker, seeded.ids.Reading))).toEqual(['A', 'B', 'Clicked away']);
  expect(errors).toEqual([]);
});

/* ── U4c: the repaint that waits for the button, told apart from the click's own ──────
   The two click tests above press a closed FOLDER, and the click of a folder runs `toggleFolder`,
   which ends in `await paint()`: a repaint of its own, which draws whatever the end of the edit owed
   all by itself. So they cannot tell "the owed repaint ran once the button was up" from "the click
   repainted": a tree where the end of the edit never repaints after the release passes both. The two
   tests below press a LINK. Its click is `onListClick` -> `focusRow` (tabindex and focus) ->
   `openBookmark`, and for a page that is already open that is `S.ctx.activate(tabId)`, which asks
   Chrome to switch to the tab. None of that calls `paint()`: the places that do are the init, the
   retry, `toggleFolder`, `collapseAll`, the start and the end of an edit, a bookmark event and
   `host.paintNow` (which nothing calls yet); the tab events that follow a switch only re-decide the
   dots (`markOpenTabs`, which reads no bookmarks at all). So what is drawn after the release is
   drawn by the repaint the end of the edit owes, or not at all. That the click WAS delivered shows
   at the recorder on `chrome.tabs.update`, which nothing else in these tests calls. The link sits
   above the field: when the edit ends the field's own row leaves the list, and a row below it would
   slide from under the pointer (see the first click test). */

/** What the panel asks Chrome to do with a page, recorded from now on: a tab made, a tab switched to, a window raised. */
async function recordTabCalls(panel) {
  await panel.evaluate(() => {
    window.__tabCalls = [];
    for (const [ns, name] of [['tabs', 'create'], ['tabs', 'update'], ['windows', 'update']]) {
      const real = chrome[ns][name].bind(chrome[ns]);
      chrome[ns][name] = (...args) => { window.__tabCalls.push(`${ns}.${name}`); return real(...args); };
    }
  });
  return () => panel.evaluate(() => window.__tabCalls.slice());
}

/**
 * Reading opened and holding a link whose page is open (its click switches to that tab) and one that
 * is not, with the name field open at the end of it, and the recorder of tab calls on.
 */
async function readingWithFieldOpen(harness, serviceWorker) {
  const { panel, urls } = harness;
  const seeded = await showColumn(harness, serviceWorker, [
    { title: 'Reading', children: [
      { title: 'Alpha, already open', url: urls.alpha },
      { title: 'B', url: 'https://b.example.com/' },
    ] },
  ]);
  await E.installWriteSpy(panel);
  await bar(panel).click();
  await openFolder(panel, E.rowTitled(panel, 'Reading'));
  const tabCalls = await recordTabCalls(panel);
  await openField(panel);
  const link = E.rowTitled(panel, 'Alpha, already open');
  await expect(link, 'the link is the one whose page is open, so its click is a switch to that tab')
    .toHaveAttribute('data-open-tab', /^\d+$/, { timeout: 10_000 });
  return { seeded, tabCalls, link };
}

granted('a click on a link that ends an edit is not lost, and the repaint the end of the edit owed runs once the button is up: an untouched field with a change made elsewhere', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { seeded, tabCalls, link } = await readingWithFieldOpen(harness, serviceWorker);

  // A change from outside while the untouched field is open: the repaint it asks for is refused and owed.
  await changeElsewhere(panel, serviceWorker,
    { parentId: seeded.ids.Reading, title: 'Ext', url: 'https://ext.example.com/' });
  await expect(E.rowTitled(panel, 'Ext'), 'owed, and not shown while the field is open').toHaveCount(0);

  const mark = await spyMark(panel);
  await pressOn(panel, link);
  await expect(panel.locator(EDIT_ROW), 'the press ended the edit').toHaveCount(0, { timeout: 10_000 });
  expect(await readsSince(panel, mark), 'no repaint has started under the pointer').toEqual([]);
  expect(await tabCalls(), 'and the click has not happened yet').toEqual([]);

  await panel.mouse.up();
  await expect.poll(tabCalls, {
    timeout: 10_000, message: 'the click of the link was delivered: Chrome was asked to switch to its tab',
  }).toContain('tabs.update');
  await expect(E.rowTitled(panel, 'Ext'),
    'the change that was owed is shown once the button is up (the click of a link repaints nothing, so this is the edit\'s own repaint)')
    .toBeVisible({ timeout: 10_000 });
  expect(errors).toEqual([]);
});

granted('a click on a link that ends an edit by writing a changed name is not lost, and the repaint that follows the write runs once the button is up', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { seeded, tabCalls, link } = await readingWithFieldOpen(harness, serviceWorker);
  await panel.locator(FIELD).fill('Clicked away');

  // The write the press makes raises the panel's own event, which asks for a repaint 400 ms later,
  // and that repaint would draw the made folder by itself (and a press that outlasts it is a hazard of
  // its own, not under test here). The timer is swallowed, and counted, so that the one repaint that
  // can draw the folder is the one the end of the edit owes. Everything else is as shipped.
  await panel.evaluate(() => {
    const real = window.setTimeout.bind(window);
    window.__swallowed = 0;
    window.setTimeout = (fn, ms, ...rest) => {
      if (ms === 400) {
        window.__swallowed += 1;
        return 0;
      }
      return real(fn, ms, ...rest);
    };
  });

  const mark = await spyMark(panel);
  await pressOn(panel, link);
  // The press wrote the name, and Chrome has answered.
  await expect.poll(async () => (await createsSince(panel, mark)).filter((c) => c.status === 'resolved').length,
    { timeout: 10_000 }).toBe(1);
  expect(await panel.evaluate(() => window.__swallowed), 'the write\'s own event asked for a repaint').toBeGreaterThan(0);
  expect(await readsSince(panel, mark), 'no repaint has started under the pointer').toEqual([]);
  expect(await tabCalls(), 'and the click has not happened yet').toEqual([]);

  await panel.mouse.up();
  await expect.poll(tabCalls, {
    timeout: 10_000, message: 'the click of the link was delivered: Chrome was asked to switch to its tab',
  }).toContain('tabs.update');
  await expect(E.rowTitled(panel, 'Clicked away'),
    'the folder that was made is shown once the button is up (the click of a link repaints nothing, so this is the edit\'s own repaint)')
    .toBeVisible({ timeout: 10_000 });
  expect(titles(await E.childrenOf(serviceWorker, seeded.ids.Reading))).toEqual(['Alpha, already open', 'B', 'Clicked away']);
  expect(errors).toEqual([]);
});

// O18: a repaint is what the end of an edit owes only if something asked for one while the field
// was open (O19 above pins that half). With nothing owed the list is patched and left alone. A
// repaint starts with a read of the roots, which the spy records the instant it is asked for, so
// it is asserted as soon as the key press or the focus call has returned, with no waiting.
granted('an edit that ends with no change owed leaves the list alone: Escape on a new folder, Escape on a rename, focus moved off an untouched field', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  await showReading(harness, serviceWorker, [{ title: 'Link one', url: 'https://one.example.com/' }]);
  const field = panel.locator(FIELD);

  await openField(panel);
  let mark = await spyMark(panel);
  await field.press('Escape');
  expect(await readsSince(panel, mark), 'Escape on a new folder reads nothing: no repaint').toEqual([]);
  await expect(panel.locator(EDIT_ROW), 'and the field is gone').toHaveCount(0);

  await pressF2On(panel, 'Link one');
  await expect(field).toBeFocused({ timeout: 10_000 });
  mark = await spyMark(panel);
  await field.press('Escape');
  expect(await readsSince(panel, mark), 'Escape on a rename reads nothing: no repaint').toEqual([]);
  await expect(panel.locator(EDIT_ROW), 'and the field is gone').toHaveCount(0);
  await expect(E.rowTitled(panel, 'Link one'), 'with the row it stood for back').toBeVisible();

  await openField(panel);
  mark = await spyMark(panel);
  await panel.evaluate(() => document.getElementById('search-input').focus());
  expect(await readsSince(panel, mark), 'focus off an untouched field reads nothing: no repaint').toEqual([]);
  await expect(panel.locator(EDIT_ROW), 'and the field is gone').toHaveCount(0);
  expect(errors).toEqual([]);
});
