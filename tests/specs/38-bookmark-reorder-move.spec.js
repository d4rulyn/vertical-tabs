// 38-bookmark-reorder-move — dragging the rows of the bookmark column (PR2 unit U5, criteria B5-B8,
// B14.1): put a bookmark or a folder somewhere else in its folder, or inside another folder.
//
// WHAT THE COLUMN PROMISES (plan.md section 3.1, D4-D6, criteria B5-B8):
//   - every row that can be moved is draggable, with the real mouse and HTML5 drag; a permanent folder
//     is not, and neither is the favicon (a press on it drags the row, not the picture);
//   - a link has two zones (upper half = before it, lower half = after it); a folder has three (25 %
//     before, 50 % inside, 25 % after). "After" an open folder is its first child. A permanent folder
//     takes drops inside only. The line, or the outline of the folder, is on screen BEFORE the button
//     is released, and not at all where a drop would change nothing or is not allowed;
//   - what Chrome ends up with is what the picture said: for each of the 6 x 7 (source, gap) pairs of a
//     folder of six, spelled as the top of the row below the gap and as the bottom of the row above it,
//     the order equals a statement written from names (`orderOracle`), and the 12 no-op pairs write
//     nothing;
//   - a drop is one `move` after at most two reads (a folder going before or after a row of another
//     folder reads one more node per level of depth: the cycle check at write time, criteria
//     amendment 1);
//   - nothing else moves while a drag is on: the rows are the same nodes, whatever happens to the tree
//     meanwhile, and the change shows when the drag is over;
//   - a drag that ends any way leaves nothing behind: no dimmed row, no line, no outline, no hold on
//     the repaint.
//
// HOW IT DRIVES: the real mouse, through Playwright's HTML5-drag support (Input.dispatchDragEvent), in
// the panel opened as a tab with the synthesised permission (helpers/bookmarks.js says why). It is NOT
// a real side panel and NOT Chrome's native drag loop: Escape mid-drag, a drop outside the panel, a real
// window blur and the real pointer of a hand are not exercised. Where a stand-in is used the test says so.
//
// NO FIXED PAUSES: `dragRow` waits for the line or the outline to be visible before the button is
// released, and there is no `waitForTimeout` anywhere in this file. Waits are for evidence
// (`waitForFunction`, `expect.poll`). Time passes, in a timer of the PAGE (`observe`), only where the
// claim is that nothing happens in that time: a change made from outside is held for a second or
// more (B7.5, B8.1-B8.4, B7.5b, the lost-click test), a tab opened by a drop would be opened at once
// (B7.4, B7.6), a card would be sampled every 25 ms (B7.9); and where the claim is the length of a
// time: the watchdog (10 s without a drag event).
//
// TWO tests are premises, not features: B7.6 (a tab card over the column writes nothing) and B7.8 (a
// dragstart with no data store holds nothing back) held before this unit and have to keep holding.
// They pass on the extension of origin/feat/bookmark-folders, which has no drag and drop (measured:
// that extension plus this file gives 2 passed and every other test red, each by an assertion, none
// by a timeout or a load error; the PR body lists them). Every other test fails there.
'use strict';

const fs = require('fs');
const path = require('path');
const { test, expect } = require('../fixtures');
const { swEval } = require('../helpers/chrome');
const { granted, seedBookmarks, showBookmarks } = require('../helpers/bookmarks');
const E = require('../helpers/bookmark-edit');
const P = require('../helpers/bookmark-preview');
const EN = require('../../extension/_locales/en/messages.json');

const TOAST = '#toast';
/** The one type a drag from the column carries. Spelled out here, so a change in the product is caught. */
const PRIVATE_TYPE = 'application/x-vt-bookmark';

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

/** Click a closed folder row open, if it is closed. The folder opened last is where the header buttons write. */
async function openFolder(panel, row) {
  const target = typeof row === 'string' ? E.rowTitled(panel, row) : row;
  await expect(target).toBeVisible({ timeout: 15_000 });
  if ((await target.getAttribute('aria-expanded')) !== 'true') await target.click();
  await expect(target).toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 });
}

/**
 * Seed `spec` under the bar (or, with `root: 'other'`, under the second permanent folder), switch the
 * column on, open that permanent folder and then each folder of `open` (titles, outermost first).
 * Returns the id of every node by title, the id of the bar, and the id of the folder it seeded into.
 */
async function openColumn(harness, serviceWorker, spec, open = [], {
  viewport = { width: 460, height: 900 }, beforeShow = null, root = 'bar',
} = {}) {
  const { panel } = harness;
  await panel.setViewportSize(viewport);
  const { barId } = await seedBookmarks(serviceWorker, []);
  const rootId = root === 'other'
    ? await swEval(serviceWorker, async () => (await chrome.bookmarks.getChildren('0'))[1].id)
    : barId;
  const { ids } = await E.seedTree(serviceWorker, rootId, spec);
  if (beforeShow) await beforeShow(panel);
  await showBookmarks(panel, serviceWorker);
  await expect(bar(panel)).toBeVisible({ timeout: 15_000 });
  await openFolder(panel, root === 'other' ? otherRoot(panel) : bar(panel));
  for (const title of open) await openFolder(panel, title);
  return { barId, rootId, ids };
}

const link = (title) => ({ title, url: `https://${title.toLowerCase().replace(/[^a-z0-9]/g, '')}.example.com/` });

/** The sequence number of the newest call the write spy has seen: a point to count from. */
const spyMark = async (panel) => (await E.readWriteSpy(panel)).at(-1)?.n ?? 0;
/** Every call the panel made to chrome.bookmarks since `mark`. */
const callsSince = (panel, mark) => E.readWriteSpy(panel, mark);
/** The ones that change the tree. */
const writesSince = async (panel, mark) => (await callsSince(panel, mark))
  .filter((c) => E.WRITE_METHODS.includes(c.method));
/**
 * The reads a DROP made: the ones before its write. The write module reads (the node, a way up for a
 * folder, the children of the destination) and then writes, one task after the other; the repaint that
 * follows reads the roots and the open folders, and is not the drop's.
 */
const readsOfDrop = (calls) => {
  const write = calls.find((c) => E.WRITE_METHODS.includes(c.method));
  return calls.filter((c) => E.READ_METHODS.includes(c.method) && (!write || c.n < write.n));
};

/** What Chrome says is in a folder, as titles, in order. */
const titlesOf = async (sw, id) => (await E.childrenOf(sw, id)).map((n) => n.title);

/** Wait until the column has stopped repainting: nothing in the rail has changed for `ms`. */
const quiet = (panel, ms = 900) => panel.waitForFunction((wait) => {
  const spy = window.__bmRepaint;
  if (!spy) throw new Error('quiet: installRepaintSpy was not called on this page');
  spy.flush();
  const last = spy.records.length ? spy.records[spy.records.length - 1].t : 0;
  return performance.now() - last >= wait;
}, ms, { timeout: 30_000, polling: 100 });

/**
 * What the column draws for a drag that is held (button down) on the `edge` of the row titled `title`:
 * a line on that edge, as wide as the row, and no outline. A line "on the top edge" is the 2 px that
 * starts a pixel above the row; "on the bottom edge", the 2 px that start where the row ends.
 */
async function expectLineAt(panel, where, title, edge) {
  const fb = await E.railFeedback(panel);
  const box = await E.rowTitled(panel, title).boundingBox();
  expect(fb.into, `${where}: no outline`).toEqual([]);
  expect(fb.line, `${where}: the line is showing`).not.toBeNull();
  const want = edge === 'top' ? box.y - 1 : box.y + box.height;
  expect(Math.abs(fb.line.top - want), `${where}: the line is on the ${edge} edge of ${title} (top ${fb.line.top}, wanted ${want})`)
    .toBeLessThanOrEqual(1);
  expect(Math.abs(fb.line.left - box.x), `${where}: and starts where the row does`).toBeLessThanOrEqual(1);
  expect(Math.abs(fb.line.width - box.width), `${where}: and is as wide as the row`).toBeLessThanOrEqual(1);
  // It takes no part in layout and the pointer goes through it: no box of the panel moves while it
  // shows, and the drop is delivered to the row under the pointer, never to the line.
  expect(await panel.evaluate((sel) => {
    const style = getComputedStyle(document.querySelector(sel));
    return { position: style.position, pointerEvents: style.pointerEvents };
  }, E.DROP_INDICATOR), `${where}: the line is fixed and lets the pointer through`)
    .toEqual({ position: 'fixed', pointerEvents: 'none' });
}

/** What the column draws for a drag held on the inside of a folder: its row outlined, no line. */
async function expectOutline(panel, where, titles) {
  const fb = await E.railFeedback(panel);
  expect(fb.line, `${where}: no line`).toBeNull();
  expect(fb.into, `${where}: the outlined rows`).toEqual(titles);
}

/** The CSS selector of the one row of node `id` (for markNode / sameNode). */
const rowSelector = (id) => `[data-testid="bookmark-row"][data-bookmark-id="${id}"]`;

/**
 * Let `ms` of the PAGE's time pass, in a timer of the page. Only for "nothing happens in that time",
 * which cannot be waited for any other way; each use says what the time is for.
 */
const observe = (panel, ms) => panel.evaluate((n) => new Promise((resolve) => { setTimeout(resolve, n); }), ms);

/**
 * Record every text the toast shows from now on (the single #toast takes the newest and hides it
 * after 2.5 s, so a test that polls it can be too late to see a message that WAS shown).
 */
const recordToasts = (panel) => panel.evaluate(() => {
  const el = document.getElementById('toast');
  if (!window.__u5ToastWatch) {
    window.__u5Toasts = [];
    window.__u5ToastWatch = new MutationObserver(() => { if (!el.hidden && el.textContent) window.__u5Toasts.push(el.textContent); });
    window.__u5ToastWatch.observe(el, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  }
  window.__u5Toasts.length = 0; // each call starts a fresh record
});
/** The texts {@link recordToasts} saw, oldest first, without the repeats that a hide and a show make. */
const toastsShown = (panel) => panel.evaluate(() => window.__u5Toasts.filter((text, i, all) => text !== all[i - 1]));

/** From now on, note the moment (page clock) a row titled `title` first shows in the column. */
const watchForRow = (panel, title) => panel.evaluate((wanted) => {
  const seen = (window.__u5Appeared ||= {});
  const check = () => {
    if (seen[wanted] !== undefined) return;
    for (const el of document.querySelectorAll('[data-testid="bookmark-row"] .w-row__main')) {
      if (el.textContent === wanted) { seen[wanted] = performance.now(); return; }
    }
  };
  new MutationObserver(check).observe(document.getElementById('bookmark-rail'), { childList: true, subtree: true });
  check();
}, title);

/** The page-clock moment {@link watchForRow} saw the row, waiting for it; null if it never comes. */
const appearedAt = (panel, title, timeout = 15_000) => panel
  .waitForFunction((wanted) => window.__u5Appeared && window.__u5Appeared[wanted] !== undefined, title, { timeout, polling: 50 })
  .then(() => panel.evaluate((wanted) => window.__u5Appeared[wanted], title), () => null);

/** The page-clock moment of the last drag event of `kind` in the record of {@link E.installDragLog}. */
const lastEventAt = async (panel, kind) => {
  const log = await E.readDragLog(panel);
  const mine = log.filter((e) => e.k === kind);
  return mine.length ? mine[mine.length - 1].t : null;
};

/** Strip comments from JavaScript source: enough for a file that has no `//` inside a string. */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

/* ── The module itself (source scan): the only way to the tree is the write module ──── */

test('bookmark-dnd.js never names chrome or bm() and carries nothing but the private type (source scan)', () => {
  const file = path.resolve(__dirname, '../../extension/sidepanel/bookmark-dnd.js');
  expect(fs.existsSync(file), 'extension/sidepanel/bookmark-dnd.js exists').toBe(true);
  const raw = fs.readFileSync(file, 'utf8');
  const code = stripComments(raw);

  // The claim of the store text ("never deletes") rests on every call to chrome.bookmarks being a literal
  // method name at one call site (bookmarks.js) or inside bookmark-write.js. This module has neither.
  expect(code, 'no chrome.* at all').not.toMatch(/\bchrome\b/);
  expect(code, 'no bm in any form (bm(...), host.bm, host["bm"])').not.toMatch(/\bbm\b/);
  expect(code, 'no bracket access to the host, which could hide a call').not.toMatch(/host\s*\[/);

  // What the host is asked for: nothing that writes to the tree.
  const used = [...new Set([...code.matchAll(/\bhost\.(\w+)/g)].map((m) => m[1]))].sort();
  expect(used, 'the host methods this module calls').toEqual(
    ['expand', 'focusRowById', 'hold', 'log', 'paintNow', 'release', 'rows', 'toast'],
  );

  // The payload: the private type, once, and none of the types the tab list takes.
  expect(code.match(/application\/x-vt-bookmark/g) || [], 'the private type is named once').toHaveLength(1);
  expect(code, 'never text/uri-list (the tab list would take the drop and open a tab)').not.toContain('text/uri-list');
  expect(code, 'never text/plain').not.toContain('text/plain');
  expect([...code.matchAll(/setData\(([^,)]*)/g)].map((m) => m[1].trim()), 'the only setData').toEqual(['DRAG_TYPE']);

  // Other code reads these events too (sidepanel.js, bookmark-preview.js): this module lets them through.
  expect(code, 'stopPropagation on none of the drag events').not.toMatch(/stopPropagation|stopImmediatePropagation/);
  expect(code, 'neither the class nor the line of dnd.js, which strips the one on every dragend')
    .not.toMatch(/\bis-dragging\b|['"]drop-indicator['"]/);

  // What it imports: the pure maths, the write module and the translations. Nothing else.
  const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]).sort();
  expect(imports).toEqual(['../common/i18n.js', './bookmark-math.js', './bookmark-write.js']);
});

/* ── B5.1 / B5.2: the whole matrix of (source, gap), none sampled ─────────── */

/**
 * One source against every gap of a folder: gap j is "before child j" (j = n is after the last), spelled
 * as the TOP of row j and, for j >= 1, as the BOTTOM of row j-1. gap = s and gap = s + 1 change nothing.
 * Every drag starts from the order the folder was seeded in: after a move it is put back from the
 * service worker, and the test waits for the column to show it before it goes on.
 * @returns {Promise<number>} how many drags were made
 */
async function reorderMatrix(harness, serviceWorker, items, s) {
  const { panel } = harness;
  const errors = watchErrors(panel);
  const titles = items.map((item) => item.title);
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Group', children: items }], ['Group']);
  const group = ids.Group;
  const order = titles.map((title) => ids[title]);
  const source = titles[s];
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);

  let drags = 0;
  for (let gap = 0; gap <= titles.length; gap += 1) {
    /** @type {Array<[string, 'top'|'bottom']>} */
    const spellings = [];
    if (gap < titles.length) spellings.push([titles[gap], 'top']);
    if (gap > 0) spellings.push([titles[gap - 1], 'bottom']);
    for (const [target, zone] of spellings) {
      const where = `${source} -> gap ${gap} (the ${zone} of ${target})`;
      await quiet(panel);
      expect(await E.domChildren(panel, group), `${where}: the column starts from the seeded order`).toEqual(titles);
      const mark = await spyMark(panel);
      drags += 1;

      if (gap === s || gap === s + 1) {
        // B5.1 no-op cell, B7.3: the pointer is on the target with the button down, and nothing is drawn.
        const held = await E.dragRow(panel, source, target, zone, { drop: false, valid: false });
        expect(held.started, `${where}: a drag started`).toBe(true);
        expect(held.reached, `${where}: the column handled a dragover at the target`).toBe(true);
        expect(held.accepted, `${where}: a position that changes nothing is not accepted as a drop`).toBe(false);
        expect(await E.railFeedback(panel), `${where}: no line, no outline; the carried row is dimmed`)
          .toEqual({ line: null, into: [], dragging: 1 });
        await E.releaseDrag(panel);
        expect(await writesSince(panel, mark), `${where}: ZERO writes`).toEqual([]);
        expect(await titlesOf(serviceWorker, group), `${where}: the order is unchanged`).toEqual(titles);
        continue;
      }

      const held = await E.dragRow(panel, source, target, zone, { drop: false });
      expect(held.started && held.reached, `${where}: the drag started and the column saw the pointer`).toBe(true);
      // The picture says what is about to happen: a line on the edge of the row the pointer is on.
      await expectLineAt(panel, where, target, zone);
      const done = await E.releaseDrag(panel);
      expect(done.dropped, `${where}: the drop reached the column`).toBe(true);
      const expected = E.orderOracle(titles, source, gap);
      await expect.poll(() => titlesOf(serviceWorker, group), {
        timeout: 15_000, message: `${where}: Chrome's order, written from names`,
      }).toEqual(expected);

      // One move after at most two reads (a folder moved inside its own folder needs no cycle check).
      const calls = await callsSince(panel, mark);
      const writes = calls.filter((c) => E.WRITE_METHODS.includes(c.method));
      expect(writes.map((c) => c.method), `${where}: exactly one write, and it is a move`).toEqual(['move']);
      expect(writes[0].args[0], `${where}: it moves the dragged node`).toBe(ids[source]);
      expect(writes[0].args[1].parentId, `${where}: inside its own folder`).toBe(group);
      expect(writes[0].status, `${where}: it resolved`).toBe('resolved');
      expect(readsOfDrop(calls).length, `${where}: reads before the write: ${readsOfDrop(calls).map((c) => c.method)}`)
        .toBeLessThanOrEqual(2);

      // B5.3: the column shows what Chrome has.
      await expect.poll(() => E.domChildren(panel, group), {
        timeout: 15_000, message: `${where}: the rows on screen follow Chrome's order`,
      }).toEqual(expected);

      await E.restoreOrder(serviceWorker, group, order);
      await expect.poll(() => E.domChildren(panel, group), {
        timeout: 15_000, message: `${where}: the column shows the seeded order again`,
      }).toEqual(titles);
    }
  }
  expect(errors, 'the panel threw nothing').toEqual([]);
  return drags;
}

const SIX = ['A', 'B', 'C', 'D', 'E', 'F'];
for (let s = 0; s < SIX.length; s += 1) {
  granted(`B5.1 a link dragged to every gap of a folder of six: ${SIX[s]} (12 spellings, none sampled)`, async ({
    harness, serviceWorker,
  }) => {
    granted.setTimeout(900_000);
    const drags = await reorderMatrix(harness, serviceWorker, SIX.map(link), s);
    // gap 0: one spelling; gaps 1-5: two each; gap 6: one (the bottom of the last row).
    expect(drags, 'gap 0 one, gaps 1-5 two each, gap 6 one').toBe(12);
  });
}

/** Three folders and three links, in turn; the folders are shut and each has one child. */
const MIXED = [
  { title: 'Fa', children: [link('Fa child')] },
  link('Lb'),
  { title: 'Fc', children: [link('Fc child')] },
  link('Ld'),
  { title: 'Fe', children: [link('Fe child')] },
  link('Lf'),
];
for (let s = 0; s < MIXED.length; s += 1) {
  granted(`B5.2 the same matrix with three folders and three links: ${MIXED[s].title}`, async ({
    harness, serviceWorker,
  }) => {
    granted.setTimeout(900_000);
    const drags = await reorderMatrix(harness, serviceWorker, MIXED, s);
    expect(drags, 'gap 0 one, gaps 1-5 two each, gap 6 one').toBe(12);
  });
}

/* ── B5.4: a press and a release without moving is still a click ──────────── */

granted('B5.4 pressing a row and letting go without moving still opens a bookmark and toggles a folder', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(180_000);
  const { panel, tabIds, urls, w2 } = harness;
  const errors = watchErrors(panel);
  // Gamma is the active tab in W2; alpha is open and not active, so opening the bookmark activates it.
  await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), tabIds.gamma);
  const { ids } = await openColumn(harness, serviceWorker, [
    { title: 'Alpha, already open', url: urls.alpha },
    { title: 'Plain', children: [link('Inside plain')] },
  ]);

  const tabsBefore = await swEval(serviceWorker, (id) => chrome.tabs.query({ windowId: id }).then((ts) => ts.length), w2);
  await E.rowTitled(panel, 'Alpha, already open').click();
  await expect.poll(
    () => swEval(serviceWorker, (id) => chrome.tabs.query({ active: true, windowId: id })
      .then((ts) => (ts[0] ? ts[0].url : '')), w2),
    { timeout: 10_000, message: 'the click opened the bookmark: its tab is the active one' },
  ).toBe(urls.alpha);
  expect(await swEval(serviceWorker, (id) => chrome.tabs.query({ windowId: id }).then((ts) => ts.length), w2),
    'it activated the open copy; no second one').toBe(tabsBefore);

  const plain = E.rowTitled(panel, 'Plain');
  await expect(plain).toHaveAttribute('aria-expanded', 'false');
  await plain.click();
  await expect(plain).toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 });
  await plain.click();
  await expect(plain).toHaveAttribute('aria-expanded', 'false', { timeout: 10_000 });

  // And the rows are draggable all the same: this is the same row, not a different kind of row.
  expect(await panel.evaluate((id) => document.querySelector(`[data-bookmark-id="${id}"]`).getAttribute('draggable'),
    ids.Plain), 'a folder row is draggable').toBe('true');
  expect(await E.railFeedback(panel)).toEqual({ line: null, into: [], dragging: 0 });
  expect(errors).toEqual([]);
});

/* ── B6: into a folder, and between folders ───────────────────────────────── */

granted('B6.1 the middle of a shut folder puts the row last in it and opens it; the bookmark button keeps its folder', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [
    { title: 'Target', children: [link('T1'), link('T2')] },
    link('X'),
  ]);
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);
  const add = panel.locator('[data-testid="bookmark-add"]');
  const newFolder = panel.locator('[data-testid="bookmark-new-folder"]');
  const addTitle = await add.getAttribute('title');
  const newTitle = await newFolder.getAttribute('title');
  expect(addTitle, 'the bookmark button is aimed at the folder opened last, which is not Target').not.toContain('Target');
  const target = E.rowTitled(panel, 'Target');
  await expect(target).toHaveAttribute('aria-expanded', 'false');

  const mark = await spyMark(panel);
  const held = await E.dragRow(panel, 'X', 'Target', 'middle', { drop: false });
  expect(held.started && held.reached).toBe(true);
  await expectOutline(panel, 'B6.1 the middle of a shut folder', ['Target']);
  const done = await E.releaseDrag(panel);
  expect(done.dropped, 'the drop reached the column').toBe(true);
  await expect.poll(() => titlesOf(serviceWorker, ids.Target), {
    timeout: 15_000, message: 'X is the last child of Target',
  }).toEqual(['T1', 'T2', 'X']);

  const calls = await callsSince(panel, mark);
  const writes = calls.filter((c) => E.WRITE_METHODS.includes(c.method));
  expect(writes.map((c) => c.method), 'one write, a move').toEqual(['move']);
  expect(writes[0].args, 'into the folder, and no index: appending cannot go stale').toEqual([ids.X, { parentId: ids.Target }]);
  expect(writes[0].keys[1], 'the options object has no index key at all').toEqual(['parentId']);
  expect(readsOfDrop(calls).map((c) => c.method), 'a link going last into another folder reads only itself').toEqual(['get']);

  await expect(target, 'the folder it went into is open now').toHaveAttribute('aria-expanded', 'true', { timeout: 15_000 });
  await expect.poll(() => E.domChildren(panel, ids.Target), { timeout: 15_000 }).toEqual(['T1', 'T2', 'X']);
  expect(await add.getAttribute('title'), 'opening it by a drop does not change where the bookmark button writes').toBe(addTitle);
  expect(await newFolder.getAttribute('title'), 'nor the new-folder button').toBe(newTitle);
  expect(errors).toEqual([]);
});

granted('B6.2 an open folder: the middle puts the row last in it, the bottom quarter puts it first', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids, barId } = await openColumn(harness, serviceWorker, [
    { title: 'Open', children: [link('O1'), link('O2'), link('O3')] },
    link('X'),
    link('Y'),
  ], ['Open']);
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);

  let mark = await spyMark(panel);
  await E.dragRow(panel, 'X', 'Open', 'middle', { drop: false });
  await expectOutline(panel, 'B6.2 the middle of an open folder', ['Open']);
  await E.releaseDrag(panel);
  await expect.poll(() => titlesOf(serviceWorker, ids.Open), {
    timeout: 15_000, message: 'the middle: last child',
  }).toEqual(['O1', 'O2', 'O3', 'X']);
  let writes = await writesSince(panel, mark);
  expect(writes.map((c) => c.args), 'inside, with no index').toEqual([[ids.X, { parentId: ids.Open }]]);
  expect(writes[0].keys[1]).toEqual(['parentId']);

  await quiet(panel);
  mark = await spyMark(panel);
  await E.dragRow(panel, 'Y', 'Open', 'bottom', { drop: false });
  await expectLineAt(panel, 'B6.2 the bottom of an open folder', 'Open', 'bottom');
  await E.releaseDrag(panel);
  await expect.poll(() => titlesOf(serviceWorker, ids.Open), {
    timeout: 15_000, message: 'the bottom of an OPEN folder is its first child, where the next row on screen is',
  }).toEqual(['Y', 'O1', 'O2', 'O3', 'X']);
  writes = await writesSince(panel, mark);
  expect(writes.map((c) => c.args), 'first child: index 0').toEqual([[ids.Y, { parentId: ids.Open, index: 0 }]]);
  expect(await titlesOf(serviceWorker, barId), 'and not beside the folder').toEqual(['Open']);
  expect(errors).toEqual([]);
});

granted('B6.3 an empty open folder takes a drop on its row, on its "Empty" line and on the bottom of its row', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [
    { title: 'Void1', children: [] },
    { title: 'Void2', children: [] },
    { title: 'Void3', children: [] },
    link('X'),
    link('Y'),
    link('Z'),
  ], ['Void1', 'Void2', 'Void3']);
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);
  const markers = panel.locator('[data-testid="bookmark-folder-empty"]');
  await expect(markers, 'all three folders show their "Empty" line').toHaveCount(3);

  // 1. The row itself.
  let mark = await spyMark(panel);
  await E.dragRow(panel, 'X', 'Void1', 'middle', { drop: false });
  await expectOutline(panel, 'B6.3 the row of an empty folder', ['Void1']);
  await E.releaseDrag(panel);
  await expect.poll(() => titlesOf(serviceWorker, ids.Void1), {
    timeout: 15_000, message: 'the row of an empty open folder takes the drop inside',
  }).toEqual(['X']);
  expect((await writesSince(panel, mark)).map((c) => c.args), 'inside, no index').toEqual([[ids.X, { parentId: ids.Void1 }]]);

  // 2. The "Empty" line: the element right after the folder's row.
  await quiet(panel);
  const line = E.rowTitled(panel, 'Void2').locator('xpath=following-sibling::*[1]');
  await expect(line, 'the line under Void2 is its "Empty" line').toHaveAttribute('data-testid', 'bookmark-folder-empty');
  mark = await spyMark(panel);
  await E.dragRow(panel, 'Y', line, 'middle', { drop: false });
  await expectOutline(panel, 'B6.3 the "Empty" line', ['Void2']);
  await E.releaseDrag(panel);
  await expect.poll(() => titlesOf(serviceWorker, ids.Void2), {
    timeout: 15_000, message: 'the "Empty" line takes the drop inside its folder',
  }).toEqual(['Y']);
  let writes = await writesSince(panel, mark);
  expect(writes.map((c) => c.args), 'inside Void2, no index').toEqual([[ids.Y, { parentId: ids.Void2 }]]);
  expect(writes[0].keys[1]).toEqual(['parentId']);

  // 3. The bottom quarter of an OPEN folder's row is its first child, empty or not.
  await quiet(panel);
  mark = await spyMark(panel);
  await E.dragRow(panel, 'Z', 'Void3', 'bottom', { drop: false });
  await expectLineAt(panel, 'B6.3 the bottom of an empty open folder', 'Void3', 'bottom');
  await E.releaseDrag(panel);
  await expect.poll(() => titlesOf(serviceWorker, ids.Void3), {
    timeout: 15_000, message: 'the bottom of an empty open folder is inside it',
  }).toEqual(['Z']);
  writes = await writesSince(panel, mark);
  expect(writes.map((c) => c.args), 'inside Void3, as the first child').toEqual([[ids.Z, { parentId: ids.Void3, index: 0 }]]);
  expect(errors).toEqual([]);
});

granted('B6.4 before and after a row at depth 1, 2, 3 and 4 of a four-deep tree lands in that row\'s folder, in the place the oracle says', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids, barId } = await openColumn(harness, serviceWorker, [
    { title: 'D1', children: [
      link('a1'),
      { title: 'D2', children: [
        link('a2'),
        { title: 'D3', children: [link('a3'), link('b3')] },
      ] },
    ] },
    link('M1'), link('M2'), link('M3'), link('M4'),
  ], ['D1', 'D2', 'D3']);
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);
  const parents = { bar: barId, D1: ids.D1, D2: ids.D2, D3: ids.D3 };
  // Four rows at four depths: the bar's own (depth 1), the folder D1's (2), D2's (3), D3's (4).
  const cases = [
    { src: 'M1', dst: 'D1', zone: 'top', parent: 'bar' },
    { src: 'M2', dst: 'a1', zone: 'top', parent: 'D1' },
    { src: 'M3', dst: 'a2', zone: 'bottom', parent: 'D2' },
    { src: 'M4', dst: 'a3', zone: 'top', parent: 'D3' },
  ];
  for (const c of cases) {
    await quiet(panel);
    const parentId = parents[c.parent];
    const where = `${c.src} -> the ${c.zone} of ${c.dst} (in ${c.parent})`;
    const before = await titlesOf(serviceWorker, parentId);
    const expected = E.orderOracle(before, c.src, before.indexOf(c.dst) + (c.zone === 'bottom' ? 1 : 0));
    const mark = await spyMark(panel);
    const held = await E.dragRow(panel, c.src, c.dst, c.zone, { drop: false });
    expect(held.started && held.reached, `${where}: the drag started and the column saw the pointer`).toBe(true);
    await expectLineAt(panel, where, c.dst, c.zone);
    const done = await E.releaseDrag(panel);
    expect(done.dropped, `${where}: the drop reached the column`).toBe(true);
    await expect.poll(() => titlesOf(serviceWorker, parentId), {
      timeout: 15_000, message: `${where}: the order in ${c.parent}, from names`,
    }).toEqual(expected);
    const calls = await callsSince(panel, mark);
    const writes = calls.filter((x) => E.WRITE_METHODS.includes(x.method));
    expect(writes.map((x) => x.method), `${where}: one write, a move`).toEqual(['move']);
    expect(writes[0].args[0]).toBe(ids[c.src]);
    expect(writes[0].args[1].parentId, `${where}: the folder of the row it was dropped beside`).toBe(parentId);
    expect(readsOfDrop(calls).length, `${where}: at most two reads`).toBeLessThanOrEqual(2);
    await expect.poll(() => E.domChildren(panel, parentId), { timeout: 15_000 }).toEqual(expected);
  }
  expect(errors).toEqual([]);
});

granted('B6.5 a row goes inside the other permanent folder, into a folder under it, and back to the first', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids, barId } = await openColumn(harness, serviceWorker, [
    link('Xr'),
    { title: 'Rf', children: [link('r1')] },
  ]);
  // A folder under the second permanent folder: `seedBookmarks` puts everything under the first.
  const other = await swEval(serviceWorker, async () => {
    const roots = await chrome.bookmarks.getChildren('0');
    const made = await chrome.bookmarks.create({ parentId: roots[1].id, title: 'Of' });
    return { otherId: roots[1].id, ofId: made.id };
  });
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);
  await expect(otherRoot(panel)).toBeVisible();

  const rootTitle = (await otherRoot(panel).locator('.w-row__main').textContent()) || '';
  const barTitle = (await bar(panel).locator('.w-row__main').textContent()) || '';
  let mark = await spyMark(panel);
  await E.dragRow(panel, 'Xr', otherRoot(panel), 'middle', { drop: false });
  await expectOutline(panel, 'B6.5 the second permanent folder', [rootTitle]);
  await E.releaseDrag(panel);
  await expect.poll(() => titlesOf(serviceWorker, other.otherId), {
    timeout: 15_000, message: 'inside the second permanent folder, last',
  }).toEqual(['Of', 'Xr']);
  let writes = await writesSince(panel, mark);
  expect(writes.map((c) => c.args), 'inside the root, no index').toEqual([[ids.Xr, { parentId: other.otherId }]]);
  await expect(otherRoot(panel), 'and it is open now').toHaveAttribute('aria-expanded', 'true', { timeout: 15_000 });

  await quiet(panel);
  mark = await spyMark(panel);
  await E.dragRow(panel, 'Xr', 'Of', 'middle', { drop: false });
  await expectOutline(panel, 'B6.5 a folder under the second permanent folder', ['Of']);
  await E.releaseDrag(panel);
  await expect.poll(() => titlesOf(serviceWorker, other.ofId), {
    timeout: 15_000, message: 'into a folder under the second permanent folder',
  }).toEqual(['Xr']);
  writes = await writesSince(panel, mark);
  expect(writes.map((c) => c.args)).toEqual([[ids.Xr, { parentId: other.ofId }]]);

  await quiet(panel);
  mark = await spyMark(panel);
  await E.dragRow(panel, 'Xr', bar(panel), 'middle', { drop: false });
  await expectOutline(panel, 'B6.5 back to the first permanent folder', [barTitle]);
  await E.releaseDrag(panel);
  await expect.poll(() => titlesOf(serviceWorker, barId), {
    timeout: 15_000, message: 'and back inside the first, last',
  }).toEqual(['Rf', 'Xr']);
  writes = await writesSince(panel, mark);
  expect(writes.map((c) => c.args)).toEqual([[ids.Xr, { parentId: barId }]]);
  expect(errors).toEqual([]);
});

granted('B6.6 a folder with children moves whole: the same subtree, one onMoved, and it is still open', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids, barId } = await openColumn(harness, serviceWorker, [
    { title: 'Fm', children: [link('g1'), link('g2'), { title: 'Sub', children: [link('s1')] }] },
    { title: 'Dest', children: [link('d1')] },
  ], ['Fm']);
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);
  const before = await E.subtreeOf(serviceWorker, ids.Fm);
  expect(before.children.map((n) => n.title)).toEqual(['g1', 'g2', 'Sub']);
  expect(before.parentId).toBe(barId);

  // A recorder in the service worker: every move Chrome reports, from now on.
  await swEval(serviceWorker, () => {
    self.__u5Moved = [];
    chrome.bookmarks.onMoved.addListener((id, info) => {
      self.__u5Moved.push({ id, parentId: info.parentId, oldParentId: info.oldParentId });
    });
  });
  const mark = await spyMark(panel);
  const held = await E.dragRow(panel, 'Fm', 'Dest', 'middle', { drop: false });
  expect(held.started && held.reached).toBe(true);
  await expectOutline(panel, 'B6.6 a folder onto a folder', ['Dest']);
  const done = await E.releaseDrag(panel);
  expect(done.dropped, 'the drop reached the column').toBe(true);
  await expect.poll(() => titlesOf(serviceWorker, ids.Dest), {
    timeout: 15_000, message: 'the folder is the last child of Dest',
  }).toEqual(['d1', 'Fm']);

  const after = await E.subtreeOf(serviceWorker, ids.Fm);
  const strip = (node) => ({ ...node, parentId: undefined, index: undefined });
  expect(strip(after), 'the same subtree: ids, titles and the order of the children; only parentId and index differ')
    .toEqual(strip(before));
  expect(after.parentId, 'and it is in Dest').toBe(ids.Dest);
  expect(await swEval(serviceWorker, () => self.__u5Moved),
    'Chrome reported exactly one move, of the folder and not of what is in it')
    .toEqual([{ id: ids.Fm, parentId: ids.Dest, oldParentId: barId }]);

  const calls = await callsSince(panel, mark);
  expect(calls.filter((c) => E.WRITE_METHODS.includes(c.method)).map((c) => c.args))
    .toEqual([[ids.Fm, { parentId: ids.Dest }]]);
  expect(readsOfDrop(calls).map((c) => c.method),
    'the node, and the one node on the way up from the destination (criteria amendment 1)').toEqual(['get', 'get']);

  await expect(E.rowTitled(panel, 'Fm'), 'it was open, and it is open').toHaveAttribute('aria-expanded', 'true', { timeout: 15_000 });
  await expect.poll(() => E.domChildren(panel, ids.Fm), { timeout: 15_000 }).toEqual(['g1', 'g2', 'Sub']);
  await expect.poll(() => E.domChildren(panel, ids.Dest), { timeout: 15_000 }).toEqual(['d1', 'Fm']);
  expect(errors).toEqual([]);
});

granted('B6.8 below the last drawn row of a folder of 400 nothing is dropped; once every row is drawn it appends', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(600_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const names = Array.from({ length: 400 }, (_, i) => `Big ${String(i).padStart(3, '0')}`);
  // PREMISE: the infinite-scroll observer draws the next chunk the moment the end of the drawn rows
  // comes into view, so the boundary this test needs cannot be held still with it. It is replaced by
  // one that never fires; the column's own "Show more" button is the manual way to the next chunk.
  // Big is in the SECOND permanent folder, so that the last row of the list is the last of its
  // children: under a permanent folder nothing can be dropped, and that is another test (B7.2).
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Big', children: names.map(link) }], ['Big'], {
    root: 'other',
    beforeShow: (p) => p.evaluate(() => {
      window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
    }),
  });
  await E.installWriteSpy(panel);
  const more = panel.locator('[data-testid="bookmark-more"]');
  await expect(more, 'the first chunk is drawn and the rest waits behind a button').toBeVisible();
  // A chunk is 150 ENTRIES of the list: both permanent folders, Big, and 147 of its children.
  const rowsDrawn = () => panel.locator('[data-testid="bookmark-row"]');
  expect(await rowsDrawn().count(), 'the first chunk: 150 rows').toBe(150);
  await expect(E.rowTitled(panel, 'Big 146'), 'the last child drawn').toBeVisible();
  await expect(E.rowTitled(panel, 'Big 147'), 'and the next one is not').toHaveCount(0);
  const toBottom = () => panel.evaluate(() => { const r = document.getElementById('bookmark-rail'); r.scrollTop = r.scrollHeight; });

  // 1. The pointer on the button under the last drawn row: that is not the end of the folder.
  await toBottom();
  let mark = await spyMark(panel);
  const held = await E.dragRow(panel, 'Big 144', more, 'middle', { drop: false, valid: false });
  expect(held.started && held.reached, 'the drag started and the column saw the pointer on the button').toBe(true);
  expect(held.accepted, 'not accepted: there are rows nobody has seen below').toBe(false);
  expect(await E.railFeedback(panel)).toEqual({ line: null, into: [], dragging: 1 });
  await E.releaseDrag(panel);
  expect(await callsSince(panel, mark), 'ZERO calls to chrome.bookmarks').toEqual([]);
  expect(await titlesOf(serviceWorker, ids.Big)).toEqual(names);

  // 2. Draw the rest (another 150, then the last 103), and the same gesture appends.
  await more.click();
  await expect(rowsDrawn()).toHaveCount(300, { timeout: 15_000 });
  await more.click();
  await expect(more, 'nothing is left to draw').toBeHidden({ timeout: 15_000 });
  const roots = await panel.locator('[data-testid="bookmark-row"][data-depth="0"]').count();
  expect(await rowsDrawn().count(), 'every row is drawn').toBe(roots + 1 + 400);
  await expect(E.rowTitled(panel, 'Big 399'), 'and the last of them is the last row of the list').toBeVisible();
  await toBottom();
  const box = await panel.locator('#bookmark-rail').boundingBox();
  mark = await spyMark(panel);
  const began = await E.beginDrag(panel, 'Big 390');
  expect(began.started, 'the drag started').toBe(true);
  // 3 px above the bottom edge of the column: the padding under the last row.
  const reached = await E.steerTo(panel, box.x + 60, Math.floor(box.y + box.height) - 3);
  expect(reached, 'the column saw the pointer under the last row').toBe(true);
  await E.expectFeedback(panel, 'below the last row, every row drawn');
  await expectLineAt(panel, 'B6.8 under the last row', 'Big 399', 'bottom');
  await E.releaseDrag(panel);
  const expected = E.orderOracle(names, 'Big 390', 400);
  await expect.poll(() => titlesOf(serviceWorker, ids.Big), {
    timeout: 15_000, message: 'Big 390 is the last child',
  }).toEqual(expected);
  const writes = await writesSince(panel, mark);
  expect(writes.map((c) => c.method)).toEqual(['move']);
  expect(writes[0].args[0]).toBe(ids['Big 390']);
  expect(errors).toEqual([]);
});

/* ── B7: drops that must not happen ───────────────────────────────────────── */

granted('B7.1 a folder dragged onto itself, its own child or anything under it: no line, no outline, no write', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(600_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [
    { title: 'Top', children: [link('t1'), { title: 'Sub', children: [link('s1')] }] },
    link('Z'),
  ], ['Top', 'Sub']);
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);
  const before = await E.subtreeOf(serviceWorker, ids.Top);
  const targets = [
    ['Top', 'top'], ['Top', 'middle'], ['Top', 'bottom'],
    ['t1', 'top'], ['t1', 'bottom'],
    ['Sub', 'top'], ['Sub', 'middle'], ['Sub', 'bottom'],
    ['s1', 'top'], ['s1', 'bottom'],
  ];
  const mark = await spyMark(panel);
  for (const [target, zone] of targets) {
    const where = `Top -> the ${zone} of ${target}`;
    const held = await E.dragRow(panel, 'Top', target, zone, { drop: false, valid: false });
    expect(held.started && held.reached, `${where}: the drag started and the column saw the pointer`).toBe(true);
    expect(held.accepted, `${where}: not accepted`).toBe(false);
    expect(await E.railFeedback(panel), `${where}: nothing drawn`).toEqual({ line: null, into: [], dragging: 1 });
    await E.releaseDrag(panel);
    expect(await E.subtreeOf(serviceWorker, ids.Top), `${where}: the subtree is as it was`).toEqual(before);
  }
  expect(await writesSince(panel, mark), 'ZERO writes in all of it').toEqual([]);
  expect(errors).toEqual([]);
});

granted('B7.2 a permanent folder is not draggable and takes drops inside only', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { barId } = await openColumn(harness, serviceWorker, [link('X'), { title: 'Rf', children: [link('r1')] }]);
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);

  const draggable = await panel.evaluate(() => [...document.querySelectorAll('[data-testid="bookmark-row"]')]
    .map((el) => ({ depth: Number(el.dataset.depth), draggable: el.getAttribute('draggable') })));
  expect(draggable.filter((r) => r.depth === 0), 'two permanent folders').toHaveLength(2);
  for (const r of draggable) {
    expect(r.draggable === 'true', `a row at depth ${r.depth}: draggable only below the permanent folders`).toBe(r.depth > 0);
  }

  // A press and a move on a permanent folder starts no drag.
  const began = await E.beginDrag(panel, bar(panel));
  expect(began.started, 'no dragstart for a permanent folder').toBe(false);
  await panel.mouse.up();
  // A press that never became a drag is a click, and a click on a folder toggles it.
  await openFolder(panel, bar(panel));

  // The model says no as well, where the markup did not: a dragstart WITH a data store, aimed at a
  // permanent folder, is cancelled, carries nothing, and holds nothing back.
  const refused = await panel.evaluate(() => {
    const data = new DataTransfer();
    const root = document.querySelector('[data-testid="bookmark-row"][data-depth="0"]');
    const event = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data });
    return { notCancelled: root.dispatchEvent(event), types: Array.from(data.types) };
  });
  expect(refused, 'the drag is refused: cancelled, and nothing put in the data store').toEqual({ notCancelled: false, types: [] });
  await E.externalWrite(serviceWorker, (a) => chrome.bookmarks.create({
    parentId: a.barId, title: 'Fresh', url: 'https://fresh.example.com/',
  }), { barId });
  await expect.poll(() => E.domChildren(panel, barId), {
    timeout: 2_000, message: 'and no hold was left behind: a change from outside shows at once',
  }).toContain('Fresh');

  // Above and below one: nothing is drawn, nothing is written. Its middle is an "inside".
  const mark = await spyMark(panel);
  for (const zone of ['top', 'bottom']) {
    const held = await E.dragRow(panel, 'X', otherRoot(panel), zone, { drop: false, valid: false });
    expect(held.started && held.reached, `${zone} of the second permanent folder: the column saw the pointer`).toBe(true);
    expect(held.accepted, `${zone}: not accepted`).toBe(false);
    expect(await E.railFeedback(panel), `${zone}: nothing drawn`).toEqual({ line: null, into: [], dragging: 1 });
    await E.releaseDrag(panel);
  }
  expect(await writesSince(panel, mark), 'ZERO writes above and below a permanent folder').toEqual([]);
  expect(await titlesOf(serviceWorker, barId), 'nothing moved').toEqual(['X', 'Rf', 'Fresh']);

  const inside = await E.dragRow(panel, 'X', otherRoot(panel), 'middle', { drop: false });
  expect(inside.accepted, 'the middle of a permanent folder is accepted').toBe(true);
  expect((await E.railFeedback(panel)).into, 'and outlined').toHaveLength(1);
  await E.releaseDrag(panel);
  expect(errors).toEqual([]);
});

granted('a node Chrome marks unmodifiable is not draggable and nothing is dropped beside it (the flag is a stand-in: no managed bookmark can be made here)', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  // A node Chrome marks `unmodifiable` (a managed bookmark) cannot be written to. None can be made in this
  // harness (the flag has never been observed: Probe 13 P5 and P12), so the panel's own read is made to
  // report it for one bookmark, as 37-bookmark-folders does for F2. That is a STAND-IN for the flag, not
  // the real thing; what it shows is that the column reads the flag and acts on it.
  const { ids } = await openColumn(harness, serviceWorker, [
    { title: 'Work', children: [link('P'), link('Managed link'), link('Q')] },
  ], ['Work'], {
    beforeShow: (p) => p.evaluate(() => {
      const real = chrome.bookmarks.getChildren;
      chrome.bookmarks.getChildren = async (...args) => (await real.apply(chrome.bookmarks, args))
        .map((node) => (node.title === 'Managed link' ? { ...node, unmodifiable: 'managed' } : node));
    }),
  });
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);

  expect(await panel.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-testid="bookmark-row"][data-kind="link"]')]
    .map((el) => [el.querySelector('.w-row__main').textContent, el.getAttribute('draggable')]))),
  'the marked row is not draggable; the others are').toEqual({ P: 'true', 'Managed link': null, Q: 'true' });
  // The model says no as well, where the markup did not: a dragstart WITH a data store aimed at it is
  // cancelled and carries nothing.
  expect(await panel.evaluate((id) => {
    const data = new DataTransfer();
    const row = document.querySelector(`[data-bookmark-id="${id}"]`);
    const event = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data });
    return { notCancelled: row.dispatchEvent(event), types: Array.from(data.types) };
  }, ids['Managed link']), 'a dragstart at the marked row is refused').toEqual({ notCancelled: false, types: [] });

  // Nothing is dropped beside it: both of these would be real moves next to a row that may be written to.
  const before = await titlesOf(serviceWorker, ids.Work);
  const mark = await spyMark(panel);
  for (const [src, zone] of [['Q', 'top'], ['P', 'bottom']]) {
    const where = `${src} -> the ${zone} of the marked row`;
    const held = await E.dragRow(panel, src, 'Managed link', zone, { drop: false, valid: false });
    expect(held.started && held.reached, `${where}: the drag started and the column saw the pointer`).toBe(true);
    expect(held.accepted, `${where}: not accepted`).toBe(false);
    expect(await E.railFeedback(panel), `${where}: nothing drawn`).toEqual({ line: null, into: [], dragging: 1 });
    await E.releaseDrag(panel);
  }
  expect(await writesSince(panel, mark), 'ZERO writes').toEqual([]);
  expect(await titlesOf(serviceWorker, ids.Work), 'the order is unchanged').toEqual(before);

  // The control: the same kind of drag next to a row that is not marked is a move.
  const control = await E.dragRow(panel, 'P', 'Q', 'top', { drop: false });
  expect(control.started && control.reached).toBe(true);
  expect(control.accepted, 'next to a row that is not marked a drop is accepted').toBe(true);
  await E.releaseDrag(panel);
  await expect.poll(() => titlesOf(serviceWorker, ids.Work), {
    timeout: 15_000, message: 'and it moves',
  }).toEqual(E.orderOracle(before, 'P', 2));
  expect(errors).toEqual([]);
});

granted('B7.4 released over the tab list, the top bar or empty rail space: nothing is written, no tab is opened, no message is sent', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel, w2 } = harness;
  const errors = watchErrors(panel);
  await openColumn(harness, serviceWorker, [link('X'), link('Y')]);
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);
  await P.installMonitor(panel);
  const center = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  const railBox = await panel.locator('#bookmark-rail').boundingBox();
  const places = {
    'the tab list': async () => center(await panel.locator('[data-testid="tab-card"]').first().boundingBox()),
    'the top bar': async () => center(await panel.locator('#topbar').boundingBox()),
    // The last row is a permanent folder, and nothing can be put beside one: this space has no target.
    'empty rail space': async () => ({ x: railBox.x + 60, y: railBox.y + railBox.height - 40 }),
  };
  const tabCount = () => swEval(serviceWorker, (id) => chrome.tabs.query({ windowId: id }).then((ts) => ts.length), w2);
  const sendsSince = async (n) => (await P.readMonitor(panel)).sends.slice(n);

  for (const [name, where] of Object.entries(places)) {
    const point = await where();
    await quiet(panel);
    // What the same path sends with no drag on it.
    let n = (await P.readMonitor(panel)).sends.length;
    await panel.mouse.move(point.x, point.y, { steps: 8 });
    const plain = await sendsSince(n);
    await panel.mouse.move(4, 4);

    const tabs = await tabCount();
    const mark = await spyMark(panel);
    n = (await P.readMonitor(panel)).sends.length;
    const began = await E.beginDrag(panel, 'X');
    expect(began.started, `${name}: the drag started`).toBe(true);
    await E.steerTo(panel, point.x, point.y);
    expect(await E.railFeedback(panel), `${name}: nothing is drawn`).toMatchObject({ line: null, into: [] });
    await E.releaseDrag(panel);
    // A tab a drop opens is opened at once; this is time for it to show up if it were going to.
    await observe(panel, 1000);
    expect(await writesSince(panel, mark), `${name}: no bookmark written`).toEqual([]);
    expect(await tabCount(), `${name}: no tab opened`).toBe(tabs);
    expect((await sendsSince(n)).filter((type) => !plain.includes(type)),
      `${name}: no message beyond what the same pointer path sends without a drag`).toEqual([]);
  }
  expect(errors).toEqual([]);
});

granted('B7.5 after a completed drag, a cancelled one and a window blur nothing is left behind, and the repaint that was owed runs', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [
    { title: 'Fold', children: [link('c1'), link('c2')] },
    link('X'),
    link('Y'),
  ], ['Fold']);
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);
  const clean = { line: null, into: [], dragging: 0 };
  /** A change from outside, which the column hears of while the drag holds its repaint. */
  const later = (title) => E.externalWrite(serviceWorker, (a) => chrome.bookmarks.create({
    parentId: a.parentId, title: a.title, url: `https://${a.title.toLowerCase()}.example.com/`,
  }), { parentId: ids.Fold, title });

  // 1. A drag that ends in a drop.
  await watchForRow(panel, 'Late1');
  expect((await E.beginDrag(panel, 'X')).started, 'drag 1 started').toBe(true);
  const p = E.dropPoint(await E.rowTitled(panel, 'c2').boundingBox(), 'top');
  expect(await E.steerTo(panel, p.x, p.y), 'the column saw the pointer on c2').toBe(true);
  await E.expectFeedback(panel, 'completed drag');
  await later('Late1');
  // Two debounces of the repaint timer (400 ms each): the change has been heard and is being held.
  await observe(panel, 1000);
  expect(await E.domChildren(panel, ids.Fold), 'held: the column still shows the old picture').toEqual(['c1', 'c2']);
  await E.releaseDrag(panel);
  const dropped = await lastEventAt(panel, 'drop');
  const shown1 = await appearedAt(panel, 'Late1');
  expect(dropped, 'there was a drop').not.toBeNull();
  expect(shown1, 'the change that was owed shows').not.toBeNull();
  expect(shown1 - dropped, 'within 2 s of the drop (ms)').toBeLessThanOrEqual(2000);
  expect(await E.railFeedback(panel), 'completed: nothing dimmed, no line, no outline').toEqual(clean);

  // 2. A drag that ends where nothing is dropped: released on the row it was picked up from. This is the
  // stand-in for Escape (Playwright's drag is not Chrome's own drag loop): a `dragend` with no `drop`.
  await quiet(panel);
  await watchForRow(panel, 'Late2');
  expect((await E.beginDrag(panel, 'Y')).started, 'drag 2 started').toBe(true);
  await later('Late2');
  await observe(panel, 1000);
  expect(await E.domChildren(panel, ids.Fold), 'held again').not.toContain('Late2');
  await E.releaseDrag(panel);
  const ended = await lastEventAt(panel, 'dragend');
  expect((await E.readDragLog(panel)).filter((e) => e.k === 'drop'), 'no drop was delivered').toEqual([]);
  const shown2 = await appearedAt(panel, 'Late2');
  expect(shown2, 'the change that was owed shows').not.toBeNull();
  expect(shown2 - ended, 'within 2 s of the end of the drag (ms)').toBeLessThanOrEqual(2000);
  expect(await E.railFeedback(panel), 'cancelled: nothing left behind').toEqual(clean);

  // 3. The window loses focus with the button still down. A synthetic `blur` stands in for a real one.
  await quiet(panel);
  await watchForRow(panel, 'Late3');
  expect((await E.beginDrag(panel, 'Y')).started, 'drag 3 started').toBe(true);
  await later('Late3');
  await observe(panel, 1000);
  expect(await E.domChildren(panel, ids.Fold), 'held a third time').not.toContain('Late3');
  const blurredAt = await panel.evaluate(() => {
    const t = performance.now();
    window.dispatchEvent(new Event('blur'));
    return t;
  });
  const shown3 = await appearedAt(panel, 'Late3');
  expect(shown3, 'the change that was owed shows, with the button still down').not.toBeNull();
  expect(shown3 - blurredAt, 'within 2 s of the blur (ms)').toBeLessThanOrEqual(2000);
  expect(await E.railFeedback(panel), 'blurred: nothing left behind').toEqual(clean);
  await E.releaseDrag(panel);

  expect((await writesSince(panel, 0)).map((c) => c.method), 'the one drop was the one write').toEqual(['move']);
  expect(errors).toEqual([]);
});

granted('B7.5b the drop ends the drag even if the dragend that should follow it never arrives (Probe 13 P8)', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [
    { title: 'Fold', children: [link('c1'), link('c2')] },
    link('X'),
  ], ['Fold']);
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);
  await watchForRow(panel, 'Late4');

  expect((await E.beginDrag(panel, 'X')).started, 'the drag started').toBe(true);
  // After the recorders (they were registered at the press): every dragend is swallowed on its way down,
  // so that the column never hears of it. This is what a dragged node that left the DOM does to it.
  await panel.evaluate(() => {
    window.__u5Swallowed = 0;
    window.addEventListener('dragend', (e) => { window.__u5Swallowed += 1; e.stopImmediatePropagation(); }, true);
  });
  const p = E.dropPoint(await E.rowTitled(panel, 'c2').boundingBox(), 'top');
  expect(await E.steerTo(panel, p.x, p.y)).toBe(true);
  await E.expectFeedback(panel, 'the lost dragend');
  await E.externalWrite(serviceWorker, (a) => chrome.bookmarks.create({
    parentId: a.parentId, title: 'Late4', url: 'https://late4.example.com/',
  }), { parentId: ids.Fold });
  await observe(panel, 1000);
  expect(await E.domChildren(panel, ids.Fold)).toEqual(['c1', 'c2']);
  await E.releaseDrag(panel);

  const dropped = await lastEventAt(panel, 'drop');
  const shown = await appearedAt(panel, 'Late4');
  expect(shown, 'the change that was owed shows without a dragend').not.toBeNull();
  expect(shown - dropped, 'within 2 s of the drop (ms)').toBeLessThanOrEqual(2000);
  expect(await E.railFeedback(panel), 'and nothing is left behind').toEqual({ line: null, into: [], dragging: 0 });
  expect(await panel.evaluate(() => window.__u5Swallowed), 'the dragend came, and was swallowed before the column could hear of it').toBe(1);
  await expect.poll(() => titlesOf(serviceWorker, ids.Fold), { timeout: 15_000 }).toEqual(['c1', 'X', 'c2', 'Late4']);
  expect(errors).toEqual([]);
});

granted('B7.6 a tab card dragged over the bookmark column and dropped on a folder row writes nothing (premise: passes without the feature)', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel, w2 } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Target', children: [link('T1')] }, link('X')]);
  await E.installWriteSpy(panel);
  const tabs = () => swEval(serviceWorker, (id) => chrome.tabs.query({ windowId: id }).then((ts) => ts.length), w2);
  const tabsBefore = await tabs();
  const mark = await spyMark(panel);
  const card = panel.locator('[data-testid="tab-card"]').first();
  const held = await E.dragRow(panel, card, 'Target', 'middle', { drop: false, valid: false });
  expect(held.started, 'the tab card drag started').toBe(true);
  expect(held.reached, 'the pointer was over the folder row').toBe(true);
  expect(held.accepted, 'the column does not accept a drag that is not its own').toBe(false);
  expect(await E.railFeedback(panel), 'nothing drawn in the column').toEqual({ line: null, into: [], dragging: 0 });
  await E.releaseDrag(panel);
  await observe(panel, 800);
  expect(await callsSince(panel, mark), 'the column made no call to chrome.bookmarks at all').toEqual([]);
  expect(await titlesOf(serviceWorker, ids.Target)).toEqual(['T1']);
  expect(await tabs(), 'and no tab came or went').toBe(tabsBefore);
  expect(errors).toEqual([]);
});

granted('B7.7 a drag from the text of a row and a drag from its favicon carry exactly the private type', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  await openColumn(harness, serviceWorker, [link('P'), link('Q'), link('R')]);
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);

  expect(await panel.evaluate(() => [...document.querySelectorAll('[data-testid="bookmark-row"][data-kind="link"] img')]
    .map((img) => img.getAttribute('draggable'))), 'every favicon says it is not draggable').toEqual(['false', 'false', 'false']);

  const presses = [
    ['the text of P', 'P', (row) => row.locator('.w-row__main')],
    ['the favicon of Q', 'Q', (row) => row.locator('img')],
  ];
  for (const [what, title, part] of presses) {
    await quiet(panel);
    const row = E.rowTitled(panel, title);
    const began = await E.beginDrag(panel, part(row));
    expect(began.started, `${what}: a drag started`).toBe(true);
    const p = E.dropPoint(await E.rowTitled(panel, 'R').boundingBox(), 'bottom');
    expect(await E.steerTo(panel, p.x, p.y), `${what}: the column saw the pointer on R`).toBe(true);
    await E.expectFeedback(panel, what);
    await E.releaseDrag(panel);
    const log = await E.readDragLog(panel);
    const start = log.find((e) => e.k === 'dragstart');
    expect(start, `${what}: there was a dragstart`).toBeTruthy();
    expect(start.target.tag, `${what}: it started on the row's button, not on the image inside it`).toBe('BUTTON');
    expect(start.types, `${what}: types at dragstart, after the column's handler`).toEqual([PRIVATE_TYPE]);
    const over = log.find((e) => e.k === 'dragover' || e.k === 'dragenter');
    expect(over.types, `${what}: types at the first dragenter / dragover`).toEqual([PRIVATE_TYPE]);
    const drop = log.find((e) => e.k === 'drop');
    expect(drop, `${what}: the drop reached the column`).toBeTruthy();
    expect(drop.types, `${what}: types at the drop`).toEqual([PRIVATE_TYPE]);
  }
  expect(errors).toEqual([]);
});

granted('B7.8 a dragstart with no data store, as spec 39 dispatches, holds nothing back: the column still repaints (premise: passes without the feature)', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { barId } = await openColumn(harness, serviceWorker, [link('S1'), link('S2')]);
  await E.installRepaintSpy(panel);
  await panel.evaluate(() => {
    document.querySelector('[data-testid="bookmark-row"][data-kind="link"]')
      .dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }));
  });
  // Frames for whatever the column was going to do about it (the dimming is applied in a frame).
  await panel.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))));
  }));
  expect(await E.railFeedback(panel), 'no row is dimmed').toEqual({ line: null, into: [], dragging: 0 });
  await E.externalWrite(serviceWorker, (a) => chrome.bookmarks.create({
    parentId: a.barId, title: 'Fresh', url: 'https://fresh.example.com/',
  }), { barId });
  await expect.poll(() => E.domChildren(panel, barId), {
    timeout: 2_000, message: 'the change shows within 2 s: no hold was left behind',
  }).toContain('Fresh');
  expect(errors, 'and the handler threw nothing').toEqual([]);
});

granted('B7.9 no hover preview card at any moment of a real drag, and none after the drop', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  await openColumn(harness, serviceWorker, [link('A1'), link('A2'), link('A3')]);
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);
  await P.installMonitor(panel);

  // A card is up on the row about to be picked up, so that it is the drag that has to take it down.
  expect(await P.hoverAndWait(panel, 'A1'), 'a card for A1 is up before the press').not.toBeNull();
  const began = await E.beginDrag(panel, 'A1');
  expect(began.started, 'the drag started').toBe(true);
  await P.settleFrames(panel);
  // From two frames after dragstart to the end of the drag: a sample every 25 ms.
  await panel.evaluate((sel) => {
    const seen = { cards: [], n: 0 };
    window.__u5Cards = seen;
    seen.timer = setInterval(() => { seen.n += 1; seen.cards.push(document.querySelectorAll(sel).length); }, 25);
  }, P.PEEK);
  const p = E.dropPoint(await E.rowTitled(panel, 'A3').boundingBox(), 'bottom');
  expect(await E.steerTo(panel, p.x, p.y)).toBe(true);
  await E.expectFeedback(panel, 'B7.9');
  await observe(panel, 600);
  await E.releaseDrag(panel);
  // After the drop: the pointer leaves at once, as it would, and a card must not be up.
  await panel.mouse.move(4, 4);
  await observe(panel, 800);
  const seen = await panel.evaluate(() => {
    clearInterval(window.__u5Cards.timer);
    return { n: window.__u5Cards.n, max: Math.max(0, ...window.__u5Cards.cards) };
  });
  expect(seen.n, 'samples were taken all through the drag').toBeGreaterThan(20);
  expect(seen.max, 'no preview card at any of them').toBe(0);
  expect(errors).toEqual([]);
});

/* ── B8: the tree changes under a drag that is in progress ────────────────── */

const AE = ['A', 'B', 'C', 'D', 'E'].map(link);

granted('B8.1 changes made elsewhere during a drag wait: same nodes, nothing rebuilt; after the drop all of it shows and the drop landed where it was aimed', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Work', children: AE }], ['Work']);
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);
  const dragged = rowSelector(ids.A);
  await E.markNode(panel, dragged);
  const before = await E.readRepaintSpy(panel);

  const held = await E.dragRow(panel, 'A', 'D', 'top', { drop: false });
  expect(held.started && held.reached, 'the drag started and the line is on D').toBe(true);
  // A new bookmark, a rename and a move, all in the open folder, from outside the panel.
  await E.externalWrite(serviceWorker, async (a) => {
    await chrome.bookmarks.create({ parentId: a.work, title: 'X', url: 'https://x.example.com/' });
    await chrome.bookmarks.update(a.c, { title: 'C2' });
    await chrome.bookmarks.move(a.e, { parentId: a.work, index: 0 });
  }, { work: ids.Work, c: ids.C, e: ids.E });
  // 1.5 s is three times the repaint debounce (400 ms): a repaint that was going to happen has happened.
  await observe(panel, 1500);
  const during = await E.readRepaintSpy(panel);
  expect(during.removed, 'nothing was taken out of the rail during the drag').toBe(before.removed);
  expect(await E.sameNode(panel, dragged), 'the dragged row is the very node it was').toBe(true);
  expect(await E.domChildren(panel, ids.Work), 'and the column still shows the picture the drag began with').toEqual(['A', 'B', 'C', 'D', 'E']);
  expect((await E.railFeedback(panel)).line, 'the line is still on screen').not.toBeNull();

  await E.releaseDrag(panel);
  // Chrome's order at the drop was E A B C2 D X; the drop is "A before D", aimed at D by its id.
  const expected = E.orderOracle(['E', 'A', 'B', 'C2', 'D', 'X'], 'A', 4);
  expect(expected).toEqual(['E', 'B', 'C2', 'A', 'D', 'X']);
  await expect.poll(() => titlesOf(serviceWorker, ids.Work), {
    timeout: 15_000, message: 'the drop landed before D, whatever else had moved',
  }).toEqual(expected);
  await expect.poll(() => E.domChildren(panel, ids.Work), {
    timeout: 15_000, message: 'and the column shows all of it',
  }).toEqual(expected);
  expect(errors).toEqual([]);
});

granted('B8.2 a repaint already in flight when the drag starts does not rebuild the list when its reads come back', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Work', children: AE.slice(0, 4) }], ['Work']);
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);
  await E.installReadGate(panel);
  const dragged = rowSelector(ids.B);
  await E.markNode(panel, dragged);
  const before = await E.readRepaintSpy(panel);

  // A change from outside starts a repaint 400 ms later, whose first read the gate holds: the paint is
  // parked inside `await getChildren(...)` and will resume after the drag has begun.
  await E.armReadGate(panel);
  await E.externalWrite(serviceWorker, (a) => chrome.bookmarks.create({
    parentId: a.work, title: 'Late', url: 'https://late.example.com/',
  }), { work: ids.Work });
  await expect.poll(async () => (await E.readGate(panel)).held, {
    timeout: 15_000, message: 'the repaint is in flight: one of its reads is being held',
  }).toBeGreaterThan(0);

  const began = await E.beginDrag(panel, 'B');
  expect(began.started, 'the drag started while that repaint is in flight').toBe(true);
  expect(await E.openReadGate(panel), 'the held read(s) are answered now, in the middle of the drag').toBeGreaterThan(0);
  // The reads come back within milliseconds; a paint that was going to rebuild the list has done it
  // long before this ends.
  await observe(panel, 1200);
  expect(await E.sameNode(panel, dragged), 'the dragged row is still the very node it was').toBe(true);
  expect((await E.readRepaintSpy(panel)).removed, 'nothing was taken out of the rail').toBe(before.removed);
  expect(await E.domChildren(panel, ids.Work), 'the old picture, without the new row').toEqual(['A', 'B', 'C', 'D']);

  // The drag ends on its own row; the repaint that was owed runs now.
  await E.releaseDrag(panel);
  await expect.poll(() => E.domChildren(panel, ids.Work), {
    timeout: 5_000, message: 'the change shows once the drag is over',
  }).toEqual(['A', 'B', 'C', 'D', 'Late']);
  expect(errors).toEqual([]);
});

granted('B8.3 the row a drop was aimed at is removed during the drag: nothing is written, the reader is told, the row is gone', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Work', children: AE.slice(0, 4) }], ['Work']);
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);
  await recordToasts(panel);
  const held = await E.dragRow(panel, 'A', 'C', 'top', { drop: false });
  expect(held.started && held.reached).toBe(true);
  await E.externalWrite(serviceWorker, (a) => chrome.bookmarks.remove(a.c), { c: ids.C });
  await observe(panel, 1000);
  expect(await E.domChildren(panel, ids.Work), 'the column does not know yet: held').toEqual(['A', 'B', 'C', 'D']);
  expect((await E.railFeedback(panel)).line, 'the line is still on C').not.toBeNull();
  expect(await toastsShown(panel), 'nothing has been said yet').toEqual([]);

  const mark = await spyMark(panel);
  await E.releaseDrag(panel);
  await expect.poll(() => toastsShown(panel), { timeout: 10_000, message: 'the reader is told the bookmarks changed' })
    .toEqual([EN.bookmarksStale.message]);
  expect(await writesSince(panel, mark), 'ZERO writes: the anchor is not among the folder\'s children any more').toEqual([]);
  expect(await titlesOf(serviceWorker, ids.Work), 'the tree is as the outside change left it').toEqual(['A', 'B', 'D']);
  await expect.poll(() => E.domChildren(panel, ids.Work), {
    timeout: 15_000, message: 'and the anchor is gone from the rail',
  }).toEqual(['A', 'B', 'D']);
  expect(errors).toEqual([]);
});

granted('B8.4 the dragged row, or the folder it was dropped in, is removed during the drag: the reader is told, nothing throws, the rail catches up', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [
    { title: 'Work', children: AE.slice(0, 4) },
    { title: 'Dest', children: [link('d1')] },
  ], ['Work']);
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);

  // 1. The dragged row goes.
  await recordToasts(panel);
  let held = await E.dragRow(panel, 'A', 'C', 'top', { drop: false });
  expect(held.started && held.reached).toBe(true);
  await E.externalWrite(serviceWorker, (a) => chrome.bookmarks.remove(a.a), { a: ids.A });
  await observe(panel, 800);
  let mark = await spyMark(panel);
  await E.releaseDrag(panel);
  await expect.poll(() => toastsShown(panel), { timeout: 10_000, message: 'the dragged row is gone: operation failed' })
    .toEqual([EN.operationFailed.message]);
  expect(await writesSince(panel, mark), 'nothing was written').toEqual([]);
  await expect.poll(() => E.domChildren(panel, ids.Work), { timeout: 15_000, message: 'the rail caught up' }).toEqual(['B', 'C', 'D']);

  // 2. The folder it was dropped in goes.
  await quiet(panel);
  await recordToasts(panel);
  held = await E.dragRow(panel, 'B', 'Dest', 'middle', { drop: false });
  expect(held.started && held.reached).toBe(true);
  await E.externalWrite(serviceWorker, (a) => chrome.bookmarks.removeTree(a.dest), { dest: ids.Dest });
  await observe(panel, 800);
  mark = await spyMark(panel);
  await E.releaseDrag(panel);
  await expect.poll(() => toastsShown(panel), { timeout: 10_000, message: 'the destination is gone: operation failed' })
    .toEqual([EN.operationFailed.message]);
  const writes = await writesSince(panel, mark);
  expect(writes.map((c) => [c.method, c.status]), 'the one move was refused by Chrome').toEqual([['move', 'rejected']]);
  expect(await titlesOf(serviceWorker, ids.Work), 'and B is where it was').toEqual(['B', 'C', 'D']);
  await expect.poll(() => E.domChildren(panel, ids.Work), { timeout: 15_000 }).toEqual(['B', 'C', 'D']);
  await expect(E.rowTitled(panel, 'Dest'), 'the folder is gone from the rail').toHaveCount(0, { timeout: 15_000 });
  expect(errors).toEqual([]);
});

granted('B8.5 the permission goes before a move is made: the column returns to the grant card and nothing throws', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  await openColumn(harness, serviceWorker, [{ title: 'Work', children: AE.slice(0, 3) }], ['Work']);
  await E.installWriteSpy(panel);
  await recordToasts(panel);
  const held = await E.dragRow(panel, 'A', 'C', 'top', { drop: false });
  expect(held.started && held.reached).toBe(true);
  await E.staleGrant(panel);
  await E.releaseDrag(panel);

  await expect(panel.locator('[data-testid="bookmark-grant"]'), 'the grant card').toBeVisible({ timeout: 15_000 });
  await expect(panel.locator('[data-testid="bookmark-list"]')).toHaveCount(0);
  expect(await panel.evaluate(() => window.__vt.settings.railMode), 'the layout is the one the reader chose').toBe('bookmarks');
  expect(await panel.evaluate(() => document.getElementById('bookmark-rail').hidden)).toBe(false);
  await expect.poll(() => toastsShown(panel), { timeout: 10_000, message: 'the denial was said' })
    .toContain(EN.bookmarksDenied.message);
  // 2.5 s is how long a toast stays: after this nothing but the denial can have been the last word.
  await observe(panel, 3200);
  const said = await toastsShown(panel);
  expect(said.at(-1), 'the last word was the denial, not an "operation failed" that came after it').toBe(EN.bookmarksDenied.message);
  expect(['', EN.bookmarksDenied.message], 'nothing but the denial may be left on screen')
    .toContain((await panel.locator(TOAST).textContent()) || '');
  expect(await panel.evaluate(() => document.querySelectorAll('.is-bmk-dragging, .is-bmk-drop-into').length)).toBe(0);
  expect(errors).toEqual([]);
});

granted('B8.6 a second drag begins while the first one\'s write is still on its way: both writes land, in order', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const titles = ['A', 'B', 'C', 'D', 'E', 'F'];
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Work', children: titles.map(link) }], ['Work']);
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);
  await E.installReadGate(panel);

  // Drag 1: A before D. The write module reads the folder before it moves; that read is held, so the
  // write is on its way and has not landed when the second mouse-down comes.
  expect((await E.dragRow(panel, 'A', 'D', 'top', { drop: false })).started).toBe(true);
  await E.armReadGate(panel);
  await E.releaseDrag(panel);
  await expect.poll(async () => (await E.readGate(panel)).held, {
    timeout: 15_000, message: 'the first write is parked on its read of the folder',
  }).toBeGreaterThan(0);
  expect(await titlesOf(serviceWorker, ids.Work), 'nothing has landed yet').toEqual(titles);

  // Drag 2, at once: B after E. The picture on screen is still the old one; the target is E by its id.
  const second = await E.dragRow(panel, 'B', 'E', 'bottom', { drop: false });
  expect(second.started && second.reached, 'the second drag started and the line is on E').toBe(true);
  await E.openReadGate(panel);
  await E.releaseDrag(panel);

  const afterFirst = E.orderOracle(titles, 'A', 3);
  const expected = E.orderOracle(afterFirst, 'B', afterFirst.indexOf('E') + 1);
  expect(expected).toEqual(['C', 'A', 'D', 'E', 'B', 'F']);
  await expect.poll(() => titlesOf(serviceWorker, ids.Work), {
    timeout: 15_000, message: 'both moves landed, the first before the second',
  }).toEqual(expected);
  const moves = (await writesSince(panel, 0)).filter((c) => c.method === 'move');
  expect(moves.map((c) => c.args[0]), 'two moves, in the order of the drops').toEqual([ids.A, ids.B]);
  await expect.poll(() => E.domChildren(panel, ids.Work), { timeout: 15_000, message: 'and the column shows it' }).toEqual(expected);
  expect(errors).toEqual([]);
});

/* ── B14.1: what one dragover costs ───────────────────────────────────────── */

granted('B14.1 one dragover costs the same with 50 rows as with 1000: at most one rectangle read, no hit test; a drop reads at most twice', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(600_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const pad = (i) => String(i).padStart(4, '0');
  const small = Array.from({ length: 50 }, (_, i) => `S${pad(i)}`);
  const large = Array.from({ length: 1000 }, (_, i) => `L${pad(i)}`);
  // PREMISE: the 1000 rows are drawn by clicking "Show more", chunk by chunk. With the infinite-scroll
  // observer working, the next chunk is drawn while the click is being made, the button moves from
  // under the pointer, and the click waits for a button that is no longer there (seen: a 10 minute
  // timeout). The observer is replaced by one that never fires, as in B6.8; what is measured is the
  // cost of a dragover with the rows in the DOM, and that does not depend on how they got there.
  const { ids } = await openColumn(harness, serviceWorker, [
    { title: 'Small', children: small.map(link) },
    { title: 'Large', children: large.map(link) },
  ], ['Small'], {
    beforeShow: (p) => p.evaluate(() => {
      window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
    }),
  });
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);
  await E.installDragCostSpy(panel);

  /** Drag `src` to the bottom of `dst` and return what the events cost and what the drop read. */
  const measure = async (src, dst, folderId, titles) => {
    await quiet(panel);
    await E.resetDragCostSpy(panel);
    const mark = await spyMark(panel);
    const done = await E.dragRow(panel, src, dst, 'bottom');
    expect(done.dropped, `${src} -> the bottom of ${dst}: the drop reached the column`).toBe(true);
    const samples = await E.readDragCostSpy(panel);
    await expect.poll(() => titlesOf(serviceWorker, folderId), {
      timeout: 15_000, message: `${src} -> the bottom of ${dst}: the order, from names`,
    }).toEqual(E.orderOracle(titles, src, titles.indexOf(dst) + 1));
    const calls = await callsSince(panel, mark);
    return { samples, reads: readsOfDrop(calls).length, writes: calls.filter((c) => E.WRITE_METHODS.includes(c.method)).length };
  };
  const stats = (samples) => ({
    events: samples.length,
    missing: samples.filter((s) => s.missing).length,
    rect: [...new Set(samples.map((s) => s.rect))].sort(),
    rectMax: Math.max(...samples.map((s) => s.rect || 0)),
    rects: Math.max(...samples.map((s) => s.rects || 0)),
    point: Math.max(...samples.map((s) => s.point || 0)),
    points: Math.max(...samples.map((s) => s.points || 0)),
  });

  const few = await measure('S0010', 'S0020', ids.Small, small);
  // 1000 rows in the DOM: shut the small folder, open the large one, and draw it all.
  await openFolder(panel, 'Small'); // already open: this only asserts it
  await E.rowTitled(panel, 'Small').click();
  await expect(E.rowTitled(panel, 'Small')).toHaveAttribute('aria-expanded', 'false', { timeout: 10_000 });
  await openFolder(panel, 'Large');
  const more = panel.locator('[data-testid="bookmark-more"]');
  for (let i = 0; i < 12 && await more.isVisible(); i += 1) await more.click({ timeout: 15_000 });
  await expect(more, 'every row is drawn').toBeHidden({ timeout: 15_000 });
  expect(await panel.locator('[data-testid="bookmark-row"]').count(), '1000 rows of Large are in the DOM').toBeGreaterThanOrEqual(1000);
  const many = await measure('L0500', 'L0510', ids.Large, large);

  const a = stats(few.samples);
  const b = stats(many.samples);
  console.log(`MEASURED B14.1 (calls per dragenter/dragover, from the window capture to the window bubble): 50 rows ${JSON.stringify(a)}; 1000 rows ${JSON.stringify(b)}; reads per drop ${few.reads} and ${many.reads}`);
  for (const [what, s] of [['50 rows', a], ['1000 rows', b]]) {
    expect(s.events, `${what}: a path across ten rows is more than a few events`).toBeGreaterThan(10);
    expect(s.missing, `${what}: every dispatch reached window again`).toBe(0);
    expect(s.rectMax, `${what}: getBoundingClientRect calls per event`).toBeLessThanOrEqual(3);
    expect(s.point + s.points, `${what}: elementFromPoint / elementsFromPoint calls per event`).toBeLessThanOrEqual(3);
    expect(s.rects, `${what}: getClientRects calls per event`).toBeLessThanOrEqual(3);
  }
  expect(b.rectMax, 'the same number of rectangle reads per event with 1000 rows as with 50').toBe(a.rectMax);
  expect(b.point + b.points, 'and of hit tests').toBe(a.point + a.points);
  expect([few.reads, many.reads], 'a drop reads at most twice').toEqual([2, 2]);
  expect([few.writes, many.writes], 'and writes once').toEqual([1, 1]);
  expect(errors).toEqual([]);
});

/* ── What the measurements said to do, and the end of the drag ────────────── */

/** The page-clock moment of the last dragenter or dragover that was recorded. */
const lastOverAt = async (panel) => {
  const log = await E.readDragLog(panel);
  const over = log.filter((e) => e.k === 'dragenter' || e.k === 'dragover');
  return over.length ? over[over.length - 1].t : null;
};

granted('the watchdog: a drag that gets no drag event for 10 s lets go of the repaint and of its marks by itself', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(180_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Work', children: ['A', 'B', 'C'].map(link) }], ['Work']);
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);
  await watchForRow(panel, 'Late');
  expect((await E.beginDrag(panel, 'A')).started).toBe(true);
  const p = E.dropPoint(await E.rowTitled(panel, 'C').boundingBox(), 'top');
  expect(await E.steerTo(panel, p.x, p.y)).toBe(true);
  await E.expectFeedback(panel, 'the watchdog test');
  const last = await lastOverAt(panel);

  await E.externalWrite(serviceWorker, (a) => chrome.bookmarks.create({
    parentId: a.work, title: 'Late', url: 'https://late.example.com/',
  }), { work: ids.Work });
  // Time itself: after 3 s of a still pointer the watchdog (10 s) has not fired and the change is held.
  await observe(panel, 3000);
  expect(await E.domChildren(panel, ids.Work), 'held').not.toContain('Late');
  expect((await E.railFeedback(panel)).dragging, 'still dragging').toBe(1);

  const shown = await appearedAt(panel, 'Late', 25_000);
  expect(shown, 'the change was shown without the drag having ended').not.toBeNull();
  expect(shown - last, 'about 10 s after the last drag event (ms)').toBeGreaterThanOrEqual(9_500);
  expect(shown - last, 'and not much later').toBeLessThanOrEqual(20_000);
  expect(await E.railFeedback(panel), 'marks gone, with the button still down').toEqual({ line: null, into: [], dragging: 0 });

  await E.releaseDrag(panel);
  expect(await writesSince(panel, 0), 'the drag was over for the column, so letting go writes nothing').toEqual([]);
  expect(errors).toEqual([]);
});

granted('on the 1 px between two rows the last target stands: the line stays, the drop is accepted and lands there', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const titles = ['A', 'B', 'C', 'D', 'E', 'F'];
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Work', children: titles.map(link) }], ['Work']);
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);

  expect((await E.beginDrag(panel, 'A')).started).toBe(true);
  const box = await E.rowTitled(panel, 'D').boundingBox();
  const p = E.dropPoint(box, 'bottom');
  expect(await E.steerTo(panel, p.x, p.y), 'the pointer is on the lower part of D').toBe(true);
  await E.expectFeedback(panel, 'on D');
  const line = (await E.railFeedback(panel)).line;
  expect(line, 'the line is under D').not.toBeNull();

  // The one integer y at which the page sees the list itself, and not a row (Probe 17 PC e).
  const gapY = await panel.evaluate(({ x, edge }) => {
    for (let y = Math.floor(edge) - 2; y <= Math.ceil(edge) + 2; y += 1) {
      const el = document.elementFromPoint(x, y);
      if (el && el.matches('[data-testid="bookmark-list"]')) return y;
    }
    return null;
  }, { x: p.x, edge: box.y + box.height });
  expect(gapY, 'there is a point at the foot of D where the page sees the list, not a row').not.toBeNull();

  expect(await E.steerTo(panel, p.x, gapY), 'the column saw the pointer on the gap').toBe(true);
  const log = await E.readDragLog(panel);
  const onGap = log.filter((e) => e.k === 'dragenter' || e.k === 'dragover').at(-1);
  expect(onGap.target.isList, 'the last event named the list itself').toBe(true);
  expect(onGap.prevented, 'and it was accepted').toBe(true);
  expect(await E.railFeedback(panel), 'the line did not move or go').toMatchObject({ line, into: [] });

  await E.releaseDrag(panel);
  const drop = (await E.readDragLog(panel)).find((e) => e.k === 'drop');
  expect(drop && drop.target.isList, 'the drop was delivered to the list, not to a row').toBe(true);
  await expect.poll(() => titlesOf(serviceWorker, ids.Work), {
    timeout: 15_000, message: 'A went after D, where the line was',
  }).toEqual(E.orderOracle(titles, 'A', 4));
  expect(errors).toEqual([]);
});

granted('both dragenter and dragover are cancelled on a target where a drop would land, and neither where it would change nothing', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Work', children: ['A', 'B', 'C', 'D'].map(link) }], ['Work']);
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);
  expect((await E.beginDrag(panel, 'A')).started).toBe(true);
  const p = E.dropPoint(await E.rowTitled(panel, 'C').boundingBox(), 'top');
  expect(await E.steerTo(panel, p.x, p.y)).toBe(true);
  await E.expectFeedback(panel, 'on C');

  // Synthetic events at real positions, in the middle of a real drag, because which of the two the
  // browser sends for a path across rows is its own business (Probe 17 PC): both must be answered.
  // `dispatchEvent` answers false when the event was cancelled.
  const verdicts = await panel.evaluate(({ valid, noop }) => {
    const aim = (id, share) => {
      const row = document.querySelector(`[data-testid="bookmark-row"][data-bookmark-id="${id}"]`);
      const r = row.getBoundingClientRect();
      return { row, x: r.left + r.width / 2, y: r.top + r.height * share };
    };
    const send = (type, id, share) => {
      const at = aim(id, share);
      return !at.row.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y }));
    };
    return {
      enterValid: send('dragenter', valid, 0.12),
      overValid: send('dragover', valid, 0.12),
      // "A before B" leaves A where it is, and so does "A after A".
      enterNoop: send('dragenter', noop, 0.12),
      overNoop: send('dragover', noop, 0.12),
    };
  }, { valid: ids.C, noop: ids.B });
  expect(verdicts).toEqual({ enterValid: true, overValid: true, enterNoop: false, overNoop: false });
  await E.releaseDrag(panel);
  expect(errors).toEqual([]);
});

/**
 * Move the rows under a pointer that does not move, as Blink's own scroll of the column does: no drag
 * event and no scroll event. Two rows' worth of space (and the gap that goes with it) before the first
 * row. Returns the page's clock at that moment.
 */
const shiftRowsUnderPointer = (panel) => panel.evaluate(() => {
  const rows = document.querySelectorAll('[data-testid="bookmark-row"]');
  const pitch = rows[2].getBoundingClientRect().top - rows[1].getBoundingClientRect().top;
  const spacer = document.createElement('div');
  spacer.style.height = `${2 * pitch}px`;
  document.querySelector('[data-testid="bookmark-list"]').prepend(spacer);
  return performance.now();
});

/**
 * Start A over the bottom of D (the line is there), then move the rows under the pointer. `beforeShift`
 * runs in the page between the two. Resolves when the drop has been delivered, with what the test needs
 * to say where the drop should have landed: the row the drop event names, the half of it the pointer
 * was in, the order that puts A there (from names), and the order the line promised (after D).
 */
async function dropAfterRowsMoved(harness, serviceWorker, beforeShift) {
  const { panel } = harness;
  const titles = ['A', 'B', 'C', 'D', 'E', 'F'];
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Work', children: titles.map(link) }], ['Work']);
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);
  const byId = Object.fromEntries(titles.map((t) => [ids[t], t]));

  expect((await E.beginDrag(panel, 'A')).started).toBe(true);
  const p = E.dropPoint(await E.rowTitled(panel, 'D').boundingBox(), 'bottom');
  expect(await E.steerTo(panel, p.x, p.y), 'the pointer is on the lower part of D').toBe(true);
  await E.expectFeedback(panel, 'on D');
  await expectLineAt(panel, 'before the rows move', 'D', 'bottom');
  if (beforeShift) await panel.evaluate(beforeShift);
  const shiftedAt = await shiftRowsUnderPointer(panel);
  await E.releaseDrag(panel);

  // Whatever the browser named as the target of the drop and wherever the pointer was, the rule is the
  // same one: a link's upper half is "before it", the rest "after it" (a pointer outside the row counts
  // as the nearest edge). The expected order is worked out from the event, by names.
  const log = await E.readDragLog(panel);
  const drop = log.find((e) => e.k === 'drop');
  expect(drop && drop.target.row, 'the drop event names a row').toBeTruthy();
  const hit = byId[drop.target.row];
  const after = drop.y >= drop.rowRect.top + (drop.rowRect.bottom - drop.rowRect.top) / 2;
  const expected = E.orderOracle(titles, 'A', titles.indexOf(hit) + (after ? 1 : 0));
  const between = log.filter((e) => e.t >= shiftedAt && e.k !== 'drop' && e.k !== 'dragend')
    .map((e) => `${e.k} on ${e.target.row ? byId[e.target.row] : e.target.tag} at y=${Math.round(e.y)}`);
  return { ids, titles, hit, after, drop, expected, promised: E.orderOracle(titles, 'A', 4), between };
}

granted('the drop is worked out from the drop event: rows moved under a still pointer, with the dragenter or dragover Chromium sends at the pointer just before a drop', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const r = await dropAfterRowsMoved(harness, serviceWorker, null);
  console.log(`MEASURED drag events after the rows moved and before the drop: ${JSON.stringify(r.between)}; the drop named ${r.hit} at y=${r.drop.y}, its row ${JSON.stringify(r.drop.rowRect)} -> ${r.after ? 'after' : 'before'} ${r.hit}`);
  await expect.poll(() => titlesOf(serviceWorker, r.ids.Work), {
    timeout: 15_000, message: `the drop landed ${r.after ? 'after' : 'before'} ${r.hit}, which is where the event put it`,
  }).toEqual(r.expected);
  expect(r.expected, 'and that is not where the line had been (after D)').not.toEqual(r.promised);
  expect(errors).toEqual([]);
});

granted('the drop is worked out from the drop event: rows moved under a still pointer, with the column told of no dragenter or dragover after the move', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  // Chromium sends a dragenter (the element under the pointer changed with the rows) or a dragover at the
  // drop point just before a drop; the test above prints what it saw (a dragenter on the new row and a
  // dragleave on the old one). That event tells the column where the pointer is, so on that path "the
  // target of the last dragenter / dragover" and "the target of the drop" are the same row, and nothing
  // could tell a column that read the one from a column that read the other (a mutant that did the first
  // passed the test above, in two runs). This test takes the difference away: from the moment the rows
  // move, a listener on window in the capture phase answers every dragenter and dragover itself
  // (accepting it, so that the browser still delivers the drop) and stops it, so the column is told
  // nothing. The column's own last word is then the line it drew on D, and only the drop event can say
  // where the pointer is. This is a stand-in for a drag whose last position the page code did not hear
  // of; it is not a drag Chrome produces by itself.
  const r = await dropAfterRowsMoved(harness, serviceWorker, () => {
    window.__u5Withheld = [];
    const keep = (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      window.__u5Withheld.push(e.type);
      e.stopImmediatePropagation();
    };
    window.addEventListener('dragenter', keep, true);
    window.addEventListener('dragover', keep, true);
  });
  const withheld = await panel.evaluate(() => window.__u5Withheld);
  console.log(`MEASURED events withheld from the column after the rows moved: ${JSON.stringify(withheld)}; the drop named ${r.hit} at y=${r.drop.y} -> ${r.after ? 'after' : 'before'} ${r.hit}`);
  await expect.poll(() => titlesOf(serviceWorker, r.ids.Work), {
    timeout: 15_000, message: `the drop landed ${r.after ? 'after' : 'before'} ${r.hit}, where the drop event put it, and not after D, where the line was`,
  }).toEqual(r.expected);
  expect(r.expected, 'and that is not where the line had been (after D)').not.toEqual(r.promised);
  expect(errors).toEqual([]);
});

/**
 * Resolves, once the line sits on an edge of the row under (x, y), with which row and which edge; with
 * null if it never does (so that the caller's `expect` is what fails, and not a timeout).
 */
const lineOnRowUnder = (panel, x, y, timeout = 5_000) => panel.waitForFunction(({ px, py }) => {
  const line = document.querySelector('[data-testid="bookmark-drop-indicator"]');
  if (!line || line.hidden) return false;
  const el = document.elementFromPoint(px, py);
  const row = el && el.closest('[data-bookmark-id]');
  if (!row) return false;
  const r = row.getBoundingClientRect();
  const l = line.getBoundingClientRect();
  if (Math.abs(l.top - (r.top - 1)) <= 1) return { id: row.dataset.bookmarkId, edge: 'top' };
  if (Math.abs(l.top - r.bottom) <= 1) return { id: row.dataset.bookmarkId, edge: 'bottom' };
  return false;
}, { px: x, py: y }, { timeout, polling: 'raf' }).then((handle) => handle.jsonValue(), () => null);

const SIXTY = Array.from({ length: 60 }, (_, i) => `R${String(i).padStart(2, '0')}`);

granted('when the column scrolls under a pointer that does not move, the line follows the rows', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Work', children: SIXTY.map(link) }], ['Work']);
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);
  const byId = Object.fromEntries(SIXTY.map((t) => [ids[t], t]));

  expect((await E.beginDrag(panel, 'R10')).started).toBe(true);
  const p = E.dropPoint(await E.rowTitled(panel, 'R12').boundingBox(), 'top');
  expect(await E.steerTo(panel, p.x, p.y)).toBe(true);
  await E.expectFeedback(panel, 'on R12');
  const line0 = (await E.railFeedback(panel)).line;
  // 37 px is not a multiple of the rows' pitch (25 px): a line left where it was sits between two edges.
  await panel.evaluate(() => { document.getElementById('bookmark-rail').scrollTop += 37; });
  const where = await lineOnRowUnder(panel, p.x, p.y);
  expect(where, 'within a few frames the line is on an edge of the row that is now under the pointer').toBeTruthy();
  const line1 = (await E.railFeedback(panel)).line;
  expect(Math.abs(line1.top - line0.top), 'and it moved with the rows').toBeGreaterThan(5);

  await E.releaseDrag(panel);
  const hit = byId[where.id];
  const expected = E.orderOracle(SIXTY, 'R10', SIXTY.indexOf(hit) + (where.edge === 'bottom' ? 1 : 0));
  await expect.poll(() => titlesOf(serviceWorker, ids.Work), {
    timeout: 15_000, message: `R10 landed ${where.edge === 'top' ? 'before' : 'after'} ${hit}: where the line was`,
  }).toEqual(expected);
  expect(errors).toEqual([]);
});

granted('measured: Blink scrolls the column by itself at its edge and sends no drag event meanwhile; the line is on the row under the pointer when it stops', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  // In the second permanent folder, so that the rows the pointer ends up on are links and not a permanent folder.
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Work', children: SIXTY.map(link) }], ['Work'], { root: 'other' });
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);
  const byId = Object.fromEntries(SIXTY.map((t) => [ids[t], t]));
  await panel.evaluate(() => {
    const rail = document.getElementById('bookmark-rail');
    window.__u5Scroll = { events: [], start: rail.scrollTop };
    rail.addEventListener('scroll', () => window.__u5Scroll.events.push({ t: performance.now(), top: rail.scrollTop }), { passive: true });
  });

  expect((await E.beginDrag(panel, 'R05')).started).toBe(true);
  const box = await panel.locator('#bookmark-rail').boundingBox();
  const x = box.x + 60;
  const y = Math.floor(box.y + box.height) - 12;
  expect(await E.steerTo(panel, x, y), 'the pointer is 12 px inside the bottom edge of the column').toBe(true);
  const arrived = (await E.readDragLog(panel)).filter((e) => e.k === 'dragenter' || e.k === 'dragover').length;

  // The column moves by itself; wait until it has stopped (no scroll event for 500 ms).
  await panel.waitForFunction(() => {
    const s = window.__u5Scroll.events;
    return s.length > 1 && performance.now() - s[s.length - 1].t > 500;
  }, null, { timeout: 20_000, polling: 100 }).catch(() => null); // no scroll at all: the premise below says so
  const scroll = await panel.evaluate(() => {
    const rail = document.getElementById('bookmark-rail');
    const s = window.__u5Scroll;
    return { start: s.start, end: rail.scrollTop, max: rail.scrollHeight - rail.clientHeight, events: s.events.length };
  });
  const during = (await E.readDragLog(panel)).filter((e) => e.k === 'dragenter' || e.k === 'dragover').length - arrived;
  console.log(`MEASURED native auto-scroll at 12 px inside the bottom edge: scrollTop ${scroll.start} -> ${scroll.end} (max ${scroll.max}) in ${scroll.events} scroll events; ${during} dragenter/dragover events after the pointer arrived`);
  expect(scroll.end - scroll.start, 'premise: Blink scrolled the column by itself (Probe 17 PC a)').toBeGreaterThan(100);

  const where = await lineOnRowUnder(panel, x, y);
  expect(where, 'when the column has stopped, the line is on an edge of the row under the pointer').toBeTruthy();
  await E.releaseDrag(panel);
  const hit = byId[where.id];
  expect(hit, 'that row is one of the sixty').toBeTruthy();
  const expected = E.orderOracle(SIXTY, 'R05', SIXTY.indexOf(hit) + (where.edge === 'bottom' ? 1 : 0));
  await expect.poll(() => titlesOf(serviceWorker, ids.Work), {
    timeout: 15_000, message: `R05 landed ${where.edge === 'top' ? 'before' : 'after'} ${hit}: where the line was`,
  }).toEqual(expected);
  expect(errors).toEqual([]);
});

granted('a drag that ends with a change owed leaves the rows ready for the next click: the repaint of the end does not eat it', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { barId } = await openColumn(harness, serviceWorker, [
    link('X'),
    { title: 'Plain', children: [link('inside')] },
  ]);
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);
  const plain = E.rowTitled(panel, 'Plain');

  // A drag ends (on the row it began on, so it writes nothing) with a change owed to the column, and
  // the very next thing is a click on a folder. A drag swallows its own click, so there is no click for
  // the repaint at the end to eat; this is what that says in the one way that can be watched.
  for (let round = 1; round <= 3; round += 1) {
    await quiet(panel);
    expect((await E.beginDrag(panel, 'X')).started, `round ${round}: a drag started`).toBe(true);
    await E.externalWrite(serviceWorker, (a) => chrome.bookmarks.create({
      parentId: a.barId, title: a.title, url: `https://${a.title.toLowerCase()}.example.com/`,
    }), { barId, title: `Extra${round}` });
    await observe(panel, 700);
    expect(await E.domChildren(panel, barId), `round ${round}: held`).not.toContain(`Extra${round}`);
    await E.releaseDrag(panel);
    await plain.click();
    const want = round % 2 === 1 ? 'true' : 'false';
    await expect(plain, `round ${round}: the click right after the drag toggled the folder`)
      .toHaveAttribute('aria-expanded', want, { timeout: 10_000 });
    await expect.poll(() => E.domChildren(panel, barId), { timeout: 5_000, message: `round ${round}: the owed change shows` })
      .toContain(`Extra${round}`);
  }
  expect(await writesSince(panel, 0), 'no write at all').toEqual([]);
  expect(errors).toEqual([]);
});
