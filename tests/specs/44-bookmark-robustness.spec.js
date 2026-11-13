// 44-bookmark-robustness — defects an adversarial review of the whole PR found in the bookmark EDITING
// code (the new-folder / rename field, the writes, and the repaint that follows them). Each test names
// its finding. The panel is opened as a tab with the synthesised grant, as in 37..41; a real side panel
// and a real keyboard are not exercised.
//
//   F1  Holding Enter on a "New folder" control (the header button, or the row menu's item) clicks it
//       once; the field it opens takes focus; and the auto-repeat keydowns of the same Enter (`repeat`
//       is true) then land IN the field. They were a commit: a folder the reader never named got made.
//   F3  Every write of the column's own is followed by Chrome's tree event, which arms the repaint
//       debounce (400 ms) before the write's promise resolves; the column then repainted at once, for
//       itself, and AGAIN 400 ms later for the event: two rebuilds of every row, the second one under
//       whatever the reader had started in between (a press whose node leaves the document gets no click).
//       The tests count the rebuilds with no quiet-wait in front of the reading. They also pin what the
//       repaint must NOT lose: a change made outside the panel is still repainted, once and after the
//       debounce, and an event that arrives while a repaint is already reading is repainted afterwards.
//   F4  (a pin, not a fix) Holding Alt+ArrowDown / Alt+ArrowUp delivers auto-repeat keydowns, and each
//       one queues a move. What Chrome ends up with, and that the writes were serialised, is recorded.
//   F9  The menu's "New folder" after a bookmark can answer 'stale' (its anchor was removed meanwhile).
//
// Premise-passes on the shape without the fixes (named in the report): F4 and F9, which pin behaviour
// that exists either way. Everything else is red there by assertion.
'use strict';

const { expect } = require('../fixtures');
const { granted, seedBookmarks, showBookmarks } = require('../helpers/bookmarks');
const E = require('../helpers/bookmark-edit');
const EN = require('../../extension/_locales/en/messages.json');

const NEW_FOLDER = '[data-testid="bookmark-new-folder"]';
const EDIT_ROW = '[data-testid="bookmark-edit-row"]';
const FIELD = '[data-testid="bookmark-rename-input"]';
const DEFAULT_NAME = EN.bookmarksFolderDefaultName.message;

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

/** What Chrome says is in a folder, as titles, in order. */
const titlesOf = async (sw, id) => (await E.childrenOf(sw, id)).map((n) => n.title);

/** Right-click the row titled `title` and wait for the menu. */
async function rightClick(panel, title) {
  await E.rowTitled(panel, title).click({ button: 'right' });
  await expect(panel.locator(E.MENU), `the menu of ${title} is up`).toBeVisible({ timeout: 10_000 });
}

/**
 * Let `ms` of the PAGE's time pass. Only for "nothing happens", which cannot be waited for any other way;
 * each use says what the time is for.
 */
const observe = (panel, ms) => panel.evaluate((n) => new Promise((resolve) => { setTimeout(resolve, n); }), ms);

/** Record every keydown the page gets, from now on: the key, whether it is an auto-repeat, and where it landed. */
const recordKeydowns = (panel) => panel.evaluate(() => {
  window.__f44Keys = [];
  if (window.__f44Hooked) return; // one listener for the life of the page: a second would record every key twice
  window.__f44Hooked = true;
  document.addEventListener('keydown', (e) => {
    const el = e.target instanceof Element ? e.target : null;
    window.__f44Keys.push({
      key: e.key, repeat: e.repeat, alt: e.altKey,
      on: el ? (el.dataset.testid || el.tagName) : null,
      row: el && el.closest('[data-bookmark-id]') ? el.closest('[data-bookmark-id]').dataset.bookmarkId : null,
    });
  }, true);
});
const readKeydowns = (panel) => panel.evaluate(() => window.__f44Keys.map((k) => ({ ...k })));

/* ── F1: a held Enter is not a commit ─────────────────────────────────────── */

/**
 * The part of F1 the two routes share. The caller has pressed Enter DOWN on the control (that keydown is the
 * click, `repeat` false) and has not released it. The field is waited for, then three more Enter keydowns are
 * sent without a keyup in between: Playwright sends a key that is already down with `repeat: true`, which is
 * what an OS auto-repeat looks like to the page. The wait for the field is the OS's own: a real keyboard
 * starts to repeat a quarter of a second after the first press at the earliest.
 */
async function holdEnterInTheField(panel, serviceWorker, { ids, before, mark, where, expectedArgs }) {
  const field = panel.locator(FIELD);
  await expect(field, 'the first Enter of the hold opened the field and took focus').toBeFocused({ timeout: 10_000 });
  await expect(field, 'it starts with the default name').toHaveValue(DEFAULT_NAME);

  await recordKeydowns(panel);
  for (let i = 0; i < 3; i += 1) await panel.keyboard.down('Enter');

  // What the three keydowns did, read at once and in one go. A commit makes the field read-only inside the
  // keydown handler itself, so this is the answer to them and not a race with them: after a commit the field is
  // read-only, or already gone with the paint that follows the write.
  const state = await panel.evaluate((sel) => {
    const fields = document.querySelectorAll(sel);
    const f = fields[0] || null;
    return { fields: fields.length, readOnly: f ? f.readOnly : null, focused: Boolean(f) && document.activeElement === f, value: f ? f.value : null };
  }, FIELD);
  expect(state, `${where}: after three auto-repeat Enters the name field is still open, editable, focused, and has its name`)
    .toEqual({ fields: 1, readOnly: false, focused: true, value: DEFAULT_NAME });
  // The premise of the test: what reached the page were Enter keydowns with `repeat` true, and in the field.
  const keys = (await readKeydowns(panel)).filter((k) => k.key === 'Enter');
  expect(keys.map((k) => [k.on, k.repeat]), `${where}: three auto-repeat Enter keydowns reached the name field`)
    .toEqual([['bookmark-rename-input', true], ['bookmark-rename-input', true], ['bookmark-rename-input', true]]);
  await expect(panel.locator(EDIT_ROW), 'one name field, no more').toHaveCount(1);

  await panel.keyboard.up('Enter');
  // Time for a write that was started to have shown itself: a create is one `get` and one `create`, a few ms.
  await observe(panel, 800);
  expect(await createsSince(panel, mark), `${where}: nothing was created by the repeats`).toEqual([]);
  expect(await titlesOf(serviceWorker, ids.Group), `${where}: Chrome's folder is as it was`).toEqual(before);
  await expect(field, `${where}: the field is still open after the key came up`).toBeFocused();

  // The reader names it and presses Enter once: that is exactly one folder.
  await field.fill('Held name');
  await field.press('Enter');
  await expect.poll(async () => (await titlesOf(serviceWorker, ids.Group)).filter((t) => t === 'Held name'), {
    timeout: 15_000, message: `${where}: the named folder is made`,
  }).toEqual(['Held name']);
  const made = await createsSince(panel, mark);
  expect(made.map((c) => c.args), `${where}: exactly one create, with the name that was typed`).toEqual([[expectedArgs]]);
  await expect(panel.locator(EDIT_ROW)).toHaveCount(0, { timeout: 10_000 });
}

granted('F1 holding Enter on the header "New folder" button opens the field once; the repeats that land in it make nothing', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Group', children: links('L1', 'L2', 'L3') }], ['Group']);
  await E.installWriteSpy(panel);
  const before = await titlesOf(serviceWorker, ids.Group);
  const mark = await spyMark(panel);

  await expect(panel.locator(NEW_FOLDER), 'the header button has a folder to write into').toBeEnabled({ timeout: 10_000 });
  await panel.locator(NEW_FOLDER).focus();
  await panel.keyboard.down('Enter'); // the click
  await holdEnterInTheField(panel, serviceWorker, {
    ids, before, mark, where: 'header button', expectedArgs: { parentId: ids.Group, title: 'Held name' },
  });
  expect(errors, 'the panel threw nothing').toEqual([]);
});

granted('F1 holding Enter on the row menu\'s "New folder" item opens the field once; the repeats that land in it make nothing', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Group', children: links('L1', 'L2', 'L3') }], ['Group']);
  await E.installWriteSpy(panel);
  const before = await titlesOf(serviceWorker, ids.Group);
  const mark = await spyMark(panel);

  await rightClick(panel, 'L2');
  await E.menuItem(panel, 'bm-new-folder').focus();
  await panel.keyboard.down('Enter'); // the item's click; the menu closes
  await holdEnterInTheField(panel, serviceWorker, {
    ids, before, mark, where: 'row menu', expectedArgs: { parentId: ids.Group, title: 'Held name', index: 2 },
  });
  expect(await titlesOf(serviceWorker, ids.Group), 'the folder is right after the bookmark the menu was opened on')
    .toEqual(['L1', 'L2', 'Held name', 'L3']);
  expect(errors, 'the panel threw nothing').toEqual([]);
});

/* ── F3: one rebuild per write of the column's own ────────────────────────── */

/**
 * Make ONE write of the panel's own (`act`) and count how often the column rebuilt every row from just before it
 * until 1.5 s after the write settled. There is no quiet-wait between the write and the reading: the 400 ms
 * debounce of the tree event is inside the window. The set-up is waited out first (the column at rest), so what
 * is counted is what `act` caused.
 * @returns {Promise<{ n: number, at: number[], settledAfter: number }>} `at`: when each rebuild happened, in ms
 *   after `act` began; `settledAfter`: when the write settled, the same way
 */
async function rebuildsAfter(panel, act) {
  await E.columnRests(panel);
  const mark = await spyMark(panel);
  const t0 = await E.pageNow(panel);
  await act();
  let settled = null;
  await expect.poll(async () => {
    const writes = await writesSince(panel, mark);
    settled = writes.length > 0 && writes.every((c) => c.status !== 'pending') ? Math.max(...writes.map((c) => c.tEnd)) : null;
    return settled !== null;
  }, { timeout: 20_000, message: 'the panel\'s write has settled' }).toBe(true);
  const writes = await writesSince(panel, mark);
  expect(writes.map((c) => c.status), 'the write was accepted').toEqual(writes.map(() => 'resolved'));
  await E.waitPageClock(panel, settled + 1500);
  const { n, at } = await E.rebuildsSince(panel, t0);
  return { n, at, settledAfter: Math.round(settled - t0) };
}

/** The measurement, for the report: one line per case. */
const say = (what, m) => console.log(`F3-MEASURE ${what}: rebuilds=${m.n} at(ms after the act began)=${JSON.stringify(m.at)} write settled at=${m.settledAfter}`);

const OWN_WRITES = [
  {
    name: 'a drop on another row',
    shown: ['L4', 'L1', 'L2', 'L3'],
    act: async (panel) => { await E.dragRow(panel, 'L4', 'L1', 'top'); },
  },
  {
    name: 'the row menu\'s Move down',
    prepare: async (panel) => { await rightClick(panel, 'L2'); },
    shown: ['L1', 'L3', 'L2', 'L4'],
    act: async (panel) => { await E.menuItem(panel, 'bm-down').click(); },
  },
  {
    name: 'Alt+ArrowDown on a row',
    prepare: async (panel) => { await E.rowTitled(panel, 'L2').focus(); },
    shown: ['L1', 'L3', 'L2', 'L4'],
    act: async (panel) => { await panel.keyboard.press('Alt+ArrowDown'); },
  },
  {
    name: 'a new folder (Enter in the name field)',
    prepare: async (panel) => {
      await rightClick(panel, 'L2');
      await E.menuItem(panel, 'bm-new-folder').click();
      await expect(panel.locator(FIELD)).toBeFocused({ timeout: 10_000 });
      await panel.locator(FIELD).fill('Fresh');
    },
    shown: ['L1', 'L2', 'Fresh', 'L3', 'L4'],
    act: async (panel) => { await panel.locator(FIELD).press('Enter'); },
  },
  {
    name: 'a rename (Enter in the name field)',
    prepare: async (panel) => {
      await E.rowTitled(panel, 'L2').focus();
      await panel.keyboard.press('F2');
      await expect(panel.locator(FIELD)).toBeFocused({ timeout: 10_000 });
      await panel.locator(FIELD).fill('Two');
    },
    shown: ['L1', 'Two', 'L3', 'L4'],
    act: async (panel) => { await panel.locator(FIELD).press('Enter'); },
  },
];

for (const own of OWN_WRITES) {
  granted(`F3 ${own.name} rebuilds the rows ONCE in the 1.5 s after it, not twice`, async ({ harness, serviceWorker }) => {
    granted.setTimeout(240_000);
    const { panel } = harness;
    const errors = watchErrors(panel);
    const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Group', children: links('L1', 'L2', 'L3', 'L4') }], ['Group']);
    await E.installWriteSpy(panel);
    await E.installRepaintSpy(panel);
    if (own.prepare) await own.prepare(panel);

    const m = await rebuildsAfter(panel, () => own.act(panel));
    say(own.name, m);
    expect(m.n, `${own.name}: every row was rebuilt ${m.n} time(s) (at ${JSON.stringify(m.at)} ms; the write settled at ${m.settledAfter} ms)`).toBe(1);
    await expect.poll(() => E.domChildren(panel, ids.Group), { timeout: 15_000, message: 'and the column shows what was written' }).toEqual(own.shown);
    expect(await titlesOf(serviceWorker, ids.Group), 'which is what Chrome has').toEqual(own.shown);
    expect(errors, 'the panel threw nothing').toEqual([]);
  });
}

granted('F3 a change made OUTSIDE the panel is still repainted exactly once, after the debounce; a burst of five is one rebuild', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Group', children: links('L1', 'L2', 'L3', 'L4') }], ['Group']);
  await E.installRepaintSpy(panel);

  // After a write of the panel's own (whose event armed the debounce, and whose repaint has since taken that
  // over) the column must still hear about the next change from outside: nothing may be left "armed" for ever.
  await E.rowTitled(panel, 'L1').focus();
  await panel.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => E.domChildren(panel, ids.Group), { timeout: 15_000, message: 'the panel\'s own move is drawn' })
    .toEqual(['L2', 'L1', 'L3', 'L4']);

  // One change.
  await E.columnRests(panel);
  let t0 = await E.pageNow(panel);
  await E.externalWrite(serviceWorker, (a) => chrome.bookmarks.update(a.id, { title: 'Outside' }), { id: ids.L2 });
  await expect(E.rowTitled(panel, 'Outside'), 'the column shows the change made outside').toBeVisible({ timeout: 10_000 });
  await E.waitPageClock(panel, t0 + 1500);
  let m = await E.rebuildsSince(panel, t0);
  say('one external change', { ...m, settledAfter: 0 });
  expect(m.n, `one change from outside: every row was rebuilt ${m.n} time(s), at ${JSON.stringify(m.at)} ms`).toBe(1);
  expect(m.at[0], 'and not before the debounce has run out (a burst has to coalesce)').toBeGreaterThanOrEqual(350);

  // A burst: five changes in one call of the service worker.
  await E.columnRests(panel);
  t0 = await E.pageNow(panel);
  await E.externalWrite(serviceWorker, async (a) => {
    for (let i = 1; i <= 5; i += 1) await chrome.bookmarks.update(a.id, { title: `Burst ${i}` });
  }, { id: ids.L3 });
  await expect(E.rowTitled(panel, 'Burst 5'), 'the column shows the last of them').toBeVisible({ timeout: 10_000 });
  await E.waitPageClock(panel, t0 + 1500);
  m = await E.rebuildsSince(panel, t0);
  say('a burst of five external changes', { ...m, settledAfter: 0 });
  expect(m.n, `five changes in a burst: every row was rebuilt ${m.n} time(s), at ${JSON.stringify(m.at)} ms`).toBe(1);
  expect(errors, 'the panel threw nothing').toEqual([]);
});

granted('F3 an event that arrives while a repaint is already reading is repainted afterwards: the column ends on the newer title, in two rebuilds', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Group', children: links('L1', 'L2', 'L3', 'L4') }], ['Group']);
  await E.installRepaintSpy(panel);
  await E.installAnswerGate(panel);
  await E.installTimerHold(panel);
  await E.columnRests(panel);
  const t0 = await E.pageNow(panel);

  // 1. A first change from outside. Its event arms the repaint debounce, which is kept in the test's hand.
  await E.holdTimers(panel, true);
  await E.externalWrite(serviceWorker, (a) => chrome.bookmarks.update(a.id, { title: 'Two (first)' }), { id: ids.L2 });
  await expect.poll(() => E.heldTimers(panel), { timeout: 10_000, message: 'the first event armed the repaint' }).toBe(1);

  // 2. The debounce runs out: a repaint starts and reads the folder. It has the folder's children as they are
  //    now (the first title) and is made to wait for the answer.
  await E.armAnswerGate(panel, ids.Group);
  expect(await E.fireTimers(panel), 'the repaint was started').toBe(1);
  await expect.poll(() => E.answersHeld(panel), { timeout: 10_000, message: 'the repaint has read the folder and is waiting' }).toBe(1);

  // 3. A second change arrives while it waits: the repaint already reading cannot have seen it.
  await E.externalWrite(serviceWorker, (a) => chrome.bookmarks.update(a.id, { title: 'Two (second)' }), { id: ids.L2 });
  await expect.poll(() => E.heldTimers(panel), {
    timeout: 10_000, message: 'the second event armed a repaint of its own, while the first one was reading',
  }).toBe(1);

  // 4. The first repaint gets its answer and finishes: it draws the first title. The event that arrived
  //    meanwhile must STILL be owed a repaint.
  expect(await E.openAnswerGate(panel), 'one answer was held').toBe(1);
  await expect(E.rowTitled(panel, 'Two (first)'), 'the repaint that was reading draws what it read').toBeVisible({ timeout: 10_000 });
  expect(await E.heldTimers(panel), 'the repaint for the late event is still armed when the one it arrived in is done').toBe(1);

  // 5. Its debounce runs out: the column catches up.
  expect(await E.fireTimers(panel), 'the late event\'s repaint was started').toBe(1);
  await E.holdTimers(panel, false);
  await expect(E.rowTitled(panel, 'Two (second)'), 'the column ends on the newer title').toBeVisible({ timeout: 10_000 });
  await expect(E.rowTitled(panel, 'Two (first)')).toHaveCount(0);
  expect(await E.heldTimers(panel), 'and nothing is left armed').toBe(0);
  const m = await E.rebuildsSince(panel, t0);
  expect(m.n, `two repaints, one for each of the two events (at ${JSON.stringify(m.at)} ms)`).toBe(2);
  expect(errors, 'the panel threw nothing').toEqual([]);
});

/* ── F4: Alt+Arrow held (a pin) ───────────────────────────────────────────── */

/**
 * Hold Alt and `key` for `presses` keydowns: the first has `repeat` false, the others are auto-repeats (a key
 * that is already down is sent as one). `gap` is the pause between keydowns in ms; 0 is as fast as the browser
 * takes them, 33 is about what a keyboard repeats at.
 */
async function holdChord(panel, key, presses, gap) {
  await panel.keyboard.down('Alt');
  for (let i = 0; i < presses; i += 1) {
    if (i > 0 && gap > 0) await observe(panel, gap); // the keyboard's repeat rate, not a wait for the panel
    await panel.keyboard.down(key);
  }
  await panel.keyboard.up(key);
  await panel.keyboard.up('Alt');
}

/**
 * The calls that go through the write queue, by the time they were made: `get` and `move` (the paint reads
 * `getChildren` only, beside the queue, which is allowed). No two may overlap.
 */
function queuedCalls(calls) {
  return calls.filter((c) => c.method === 'get' || c.method === 'move').sort((a, b) => a.t - b.t);
}

const HELD_CHORDS = [
  { name: 'Alt+ArrowDown x4 as fast as the browser takes them', key: 'ArrowDown', start: 'A1', presses: 4, gap: 0, folder: 'GA', kids: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'] },
  { name: 'Alt+ArrowDown x8 at a keyboard\'s rate, past the end of the folder', key: 'ArrowDown', start: 'B1', presses: 8, gap: 33, folder: 'GB', kids: ['B1', 'B2', 'B3', 'B4', 'B5', 'B6'] },
  { name: 'Alt+ArrowUp x4 as fast as the browser takes them', key: 'ArrowUp', start: 'C6', presses: 4, gap: 0, folder: 'GC', kids: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'] },
];

granted('F4 (pin) holding Alt+Arrow: what Chrome ends up with, no write rejected, the writes one after the other, nothing thrown', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(420_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker,
    HELD_CHORDS.map((c) => ({ title: c.folder, children: links(...c.kids) })), HELD_CHORDS.map((c) => c.folder));
  await E.installWriteSpy(panel);
  await E.installRepaintSpy(panel);

  for (const c of HELD_CHORDS) {
    const where = c.name;
    await E.columnRests(panel);
    const mark = await spyMark(panel);
    await recordKeydowns(panel);
    await E.rowTitled(panel, c.start).focus();
    await holdChord(panel, c.key, c.presses, c.gap);

    // What the oracle says: each keydown that was a move moves the row one place, clamped at the end of the folder.
    const places = c.key === 'ArrowDown' ? c.presses : -c.presses;
    const at = c.kids.indexOf(c.start);
    const to = Math.min(Math.max(at + places, 0), c.kids.length - 1);
    const rest = c.kids.filter((k) => k !== c.start);
    const expected = [...rest.slice(0, to), c.start, ...rest.slice(to)];

    await expect.poll(() => titlesOf(serviceWorker, ids[c.folder]), {
      timeout: 30_000, message: `${where}: Chrome's order`,
    }).toEqual(expected);
    await expect.poll(async () => (await E.readWriteSpy(panel, mark)).every((x) => x.status !== 'pending'), {
      timeout: 30_000, message: `${where}: every call has settled`,
    }).toBe(true);
    await E.columnRests(panel);
    await expect.poll(() => E.domChildren(panel, ids[c.folder]), { timeout: 15_000, message: `${where}: and the column shows it` }).toEqual(expected);

    // What the page saw: a hold. The keys are sent as one (a key that is already down goes out as an auto-repeat).
    const keys = (await readKeydowns(panel)).filter((k) => k.key === c.key);
    expect(keys.map((k) => k.repeat), `${where}: the first keydown is a press, the rest are auto-repeats`)
      .toEqual(Array.from({ length: c.presses }, (_, i) => i > 0));
    expect(keys.every((k) => k.alt), `${where}: with Alt down`).toBe(true);

    const calls = await E.readWriteSpy(panel, mark);
    expect(calls.filter((x) => x.status === 'rejected').map((x) => [x.method, x.error]), `${where}: no call was rejected`).toEqual([]);
    const moves = calls.filter((x) => x.method === 'move');
    expect(moves.length, `${where}: one move per place the row went (${Math.abs(to - at)})`).toBe(Math.abs(to - at));
    const queued = queuedCalls(calls);
    for (let i = 1; i < queued.length; i += 1) {
      expect(queued[i].t, `${where}: call ${queued[i].n} (${queued[i].method}) began after call ${queued[i - 1].n} (${queued[i - 1].method}) was answered`)
        .toBeGreaterThanOrEqual(queued[i - 1].tEnd);
    }
  }
  expect(errors, 'the panel threw nothing').toEqual([]);
});

/* ── F9: the menu's "New folder" after a bookmark that has gone ───────────── */

granted('F9 the menu\'s "New folder" after a bookmark that is removed while the field is open: Enter says bookmarksStale and makes nothing', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const errors = watchErrors(panel);
  const { ids } = await openColumn(harness, serviceWorker, [{ title: 'Group', children: links('L1', 'L2', 'L3', 'L4') }], ['Group']);
  await E.installWriteSpy(panel);
  await E.recordToastTexts(panel);
  const field = panel.locator(FIELD);

  await rightClick(panel, 'L2');
  await E.menuItem(panel, 'bm-new-folder').click();
  await expect(field, 'the field is open, after L2').toBeFocused({ timeout: 10_000 });
  const mark = await spyMark(panel);

  // From outside the panel the bookmark the field is anchored on is removed.
  await E.externalWrite(serviceWorker, (a) => chrome.bookmarks.remove(a.id), { id: ids.L2 });
  expect(await titlesOf(serviceWorker, ids.Group), 'Chrome no longer has it').toEqual(['L1', 'L3', 'L4']);
  await observe(panel, 800); // the column's own repaint for that event is due now; the open field holds it
  await expect(field, 'the field is still open and still has focus').toBeFocused();

  await field.fill('Orphan');
  await field.press('Enter');
  await expect.poll(() => E.readToastTexts(panel), { timeout: 10_000, message: 'the reader is told the place is gone' })
    .toContain(EN.bookmarksStale.message);
  await expect(panel.locator(EDIT_ROW), 'the field is gone').toHaveCount(0, { timeout: 10_000 });
  expect(await createsSince(panel, mark), 'nothing was created').toEqual([]);
  const reads = (await E.readWriteSpy(panel, mark)).filter((c) => c.method === 'get');
  expect(reads.map((c) => [c.args[0], c.status]), 'the anchor was read once, and could not be').toEqual([[ids.L2, 'rejected']]);
  expect(await titlesOf(serviceWorker, ids.Group), 'Chrome has no new folder').toEqual(['L1', 'L3', 'L4']);
  await expect.poll(() => E.domChildren(panel, ids.Group), { timeout: 15_000, message: 'the column catches up with the removal' })
    .toEqual(['L1', 'L3', 'L4']);
  expect(await E.readToastTexts(panel), 'and says nothing else').toEqual([EN.bookmarksStale.message]);
  expect(errors, 'the panel threw nothing').toEqual([]);
});
