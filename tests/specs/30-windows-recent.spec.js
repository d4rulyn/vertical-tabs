// 30-windows-recent — the two tools that answer "where else am I" and "where was I".
//
// The panel lists ONE window, and Chrome shows nothing about the others: the taskbar has
// a title, Alt+Tab has a picture of whatever was last on screen, and neither says how
// many tabs are in there. And a vertical list is in the order tabs were OPENED, which
// stops helping around thirty tabs — the one you want is the one you were reading a
// minute ago, which is nowhere in particular.
'use strict';

const { test, expect } = require('../fixtures');
const { swEval, setSettings, waitForTabsComplete, sleep } = require('../helpers/chrome');

const WINDOW_ROWS = '[data-testid="widget-windows-row"]';
const RECENT_ROWS = '[data-testid="widget-recent-row"]';

test('the windows tool lists every window, marks this one, and goes to the others', async ({
  harness, serviceWorker, fixtures,
}) => {
  test.setTimeout(180_000);
  const { panel, w2 } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off', widgets: ['windows'] });

  // W1 (which hosts the panel page) and W2 (the fixtures) both exist already.
  await expect.poll(async () => panel.locator(WINDOW_ROWS).count(), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(2);

  const here = panel.locator(`${WINDOW_ROWS}[data-window-id="${w2}"]`);
  await expect(here, 'the window this panel drives is marked, not hidden').toHaveAttribute('data-current', '1');
  await expect(here).toBeDisabled();
  await expect(here, 'and says how many tabs it holds').toContainText('3');

  const third = await swEval(serviceWorker, async (url) => {
    const w = await chrome.windows.create({ url, focused: false, width: 900, height: 700 });
    return { windowId: w.id, tabId: (w.tabs || [])[0].id };
  }, fixtures.delta);
  await waitForTabsComplete(serviceWorker, [third.tabId]);

  const row = panel.locator(`${WINDOW_ROWS}[data-window-id="${third.windowId}"]`);
  await expect.poll(async () => row.count(), { timeout: 20_000 }).toBe(1);
  await expect(row, 'a window is named by what is on top of it').toContainText('Delta');

  await row.click();
  await expect.poll(
    async () => swEval(serviceWorker, async (id) => (await chrome.windows.get(id)).focused, third.windowId),
    { timeout: 15_000 },
  ).toBe(true);
});

test('the recently-used tool puts the last tab you were on at the top', async ({
  harness, serviceWorker,
}) => {
  test.setTimeout(180_000);
  const { panel, tabIds } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off', widgets: ['recent'] });

  // Visit them in a known order, with a gap so the access times cannot tie.
  for (const id of [tabIds.gamma, tabIds.alpha, tabIds.beta]) {
    await swEval(serviceWorker, async (tabId) => { await chrome.tabs.update(tabId, { active: true }); }, id);
    await sleep(1100);
  }

  // Beta is active, so it is not in the list; alpha was the one before it.
  await expect.poll(async () => panel.locator(RECENT_ROWS).first().getAttribute('data-recent-tab'),
    { timeout: 15_000 }).toBe(String(tabIds.alpha));
  await expect(panel.locator(RECENT_ROWS)).toHaveCount(2);
  await expect(panel.locator(RECENT_ROWS).nth(1)).toHaveAttribute('data-recent-tab', String(tabIds.gamma));
  await expect(panel.locator(`${RECENT_ROWS}[data-recent-tab="${tabIds.beta}"]`),
    'the tab you are looking at is not somewhere you might want to go').toHaveCount(0);

  // Clicking a row goes there, and the list re-orders around the new active tab.
  await panel.locator(RECENT_ROWS).first().click();
  await expect.poll(
    async () => swEval(serviceWorker, async () => {
      const [active] = await chrome.tabs.query({ active: true, windowId: (await chrome.windows.getLastFocused()).id });
      return active ? active.id : null;
    }),
    { timeout: 15_000 },
  ).toBe(tabIds.alpha);
  await expect.poll(async () => panel.locator(RECENT_ROWS).first().getAttribute('data-recent-tab'),
    { timeout: 15_000 }).toBe(String(tabIds.beta));
});

// The list is painted asynchronously from two sources — `tabs.onActivated` and the
// panel's `rendered` event — so two paints can be in flight at once. Whichever WRITES
// last wins, and that is not necessarily the one that READ last. When the loser wrote
// last the tool kept showing an older order for good: no further event fires, so
// nothing corrects it. That is what made `:64` above fail in whole-suite runs and never
// recover inside a 15 s poll (probe-results.md, Probe 9 — Chrome's own `lastAccessed`
// was measured correct in 135 of 135 activations, so the fault was never the platform).
//
// This holds ONE query — the one belonging to alpha's repaint — until after beta's
// repaint has finished and written the correct list, then lets it go. The guard in
// recent.js must make it drop its result instead of writing it.
test('a repaint that lost the race does not put its stale list on screen', async ({
  harness, serviceWorker,
}) => {
  test.setTimeout(180_000);
  const { panel, tabIds } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off', widgets: ['recent'] });
  await expect.poll(async () => panel.locator(RECENT_ROWS).count(), { timeout: 15_000 })
    .toBeGreaterThan(0);

  // Hold the next query that recent.js makes, and record what it saw, so the test can
  // prove it created the race it means to test rather than passing by accident.
  await panel.evaluate((holdMs) => {
    const real = chrome.tabs.query.bind(chrome.tabs);
    window.__vt = { arm: false, held: 0, released: 0, activeInHeldSnapshot: null };
    chrome.tabs.query = async (info) => {
      // Only the recently-used tool's own call: the tab list queries the same shape,
      // and delaying that one would measure nothing about this bug.
      const mine = window.__vt.arm && new Error().stack.includes('recent.js');
      if (mine) { window.__vt.arm = false; window.__vt.held += 1; }
      const tabs = await real(info);
      if (mine) {
        const active = tabs.find((tab) => tab.active);
        window.__vt.activeInHeldSnapshot = active ? active.id : null;
        await new Promise((r) => setTimeout(r, holdMs));
        window.__vt.released += 1;
      }
      return tabs;
    };
  }, 2500);

  const activate = (id) => swEval(serviceWorker,
    async (tabId) => { await chrome.tabs.update(tabId, { active: true }); }, id);

  await activate(tabIds.gamma);
  await sleep(1100);
  // Arm immediately before alpha so it is alpha's repaint that gets held.
  await panel.evaluate(() => { window.__vt.arm = true; });
  await activate(tabIds.alpha);
  await sleep(1100);
  await activate(tabIds.beta);

  // Let the held paint finish. Polling on the counter, not a fixed sleep: the point is
  // to wait until the stale write WOULD have happened, then look.
  await expect.poll(async () => panel.evaluate(() => window.__vt.released), { timeout: 30_000 })
    .toBe(1);

  const seen = await panel.evaluate(() => window.__vt);
  expect(seen.held, 'the hook never fired, so this test proved nothing — fix the test')
    .toBe(1);
  expect(seen.activeInHeldSnapshot,
    'the held snapshot must be the one taken while ALPHA was active: that is the read '
    + 'whose stale result is topped by gamma, and the whole point of the race')
    .toBe(tabIds.alpha);

  // Beta is active and excluded, so the truth is alpha on top. The held paint would put
  // gamma there, which is exactly the value the whole-suite failures reported.
  await expect(panel.locator(RECENT_ROWS).first())
    .toHaveAttribute('data-recent-tab', String(tabIds.alpha));
  await expect(panel.locator(RECENT_ROWS)).toHaveCount(2);
  await expect(panel.locator(RECENT_ROWS).nth(1))
    .toHaveAttribute('data-recent-tab', String(tabIds.gamma));
});

/*
 * The two tests below drive a paint race deliberately and then read a MutationObserver
 * history of the list, rather than asserting on the DOM with `expect()`.
 *
 * The reason is `playwright.config.js:17`: every `expect(locator)` retries for 15 s, so
 * "the list ends up right" is satisfied just as well by some LATER repaint that happened
 * to correct the screen as by the guard under test doing its job — and satisfied just as
 * well by a repaint that re-wrote the value the guard was supposed to produce. What is
 * under test here is whether one particular write happened at one particular moment, so
 * each test records every write to the list and reads that history ONCE, with no retry,
 * in the task turn immediately after the held paint is let go. The held paint is let go
 * through an explicit gate rather than after a fixed delay, so none of this depends on
 * guessing how long a read takes.
 */

// The windows tool carries the identical guard (`windows.js:62`) over
// `chrome.windows.getAll`, and until this test the only thing asserting it was reading
// the source. Its 400 ms timer is no protection: that timer coalesces SCHEDULING, not
// execution, so a paint whose read outlives the interval is still in flight when the
// next one starts and the two overlap exactly as they do in recent.js.
//
// Each row is named after its window's active tab, and that is what tells the two paints
// apart: the held one reads Alpha on top of W2, the one that supersedes it reads Gamma.
test('a windows repaint that lost the race does not put its stale list on screen', async ({
  harness, serviceWorker,
}) => {
  test.setTimeout(180_000);
  const { panel, w2, tabIds } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off', widgets: ['windows'] });
  await expect.poll(async () => panel.locator(WINDOW_ROWS).count(), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(2);

  const w2Name = panel.locator(`${WINDOW_ROWS}[data-window-id="${w2}"] .w-row__main`);
  await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), tabIds.alpha);
  await expect.poll(async () => w2Name.textContent(), { timeout: 20_000 }).toBe('Alpha');

  await panel.evaluate((windowId) => {
    const real = chrome.windows.getAll.bind(chrome.windows);
    // NOT on `window.__vt`, which the test above replaces wholesale: this one needs the
    // panel's own hooks left alone, because `__vt.render.render()` is how it makes the
    // tool repaint without touching a tab.
    const race = { arm: false, claimed: 0, holding: false, released: 0, heldActive: null, writes: [] };
    race.gate = new Promise((resolve) => { race.open = resolve; });
    window.__race = race;

    const list = document.querySelector('[data-testid="widget-windows-list"]');
    const shot = () => [...list.querySelectorAll('[data-testid="widget-windows-row"]')]
      .map((el) => `${el.dataset.windowId}=${el.querySelector('.w-row__main').textContent}`)
      .join(' ');
    // One entry per batch of writes, holding what the list said when that batch landed.
    // A paint rebuilds the whole list synchronously, so a batch is a paint.
    new MutationObserver(() => { race.writes.push(shot()); })
      .observe(list, { childList: true, subtree: true });

    chrome.windows.getAll = async (info) => {
      // Only the tool's own call. `capture.js` and `alarms.js` call `getAll` too, but
      // from the service worker; nothing else in the panel does, and the stack check
      // keeps it that way if something starts to.
      const mine = race.arm && new Error().stack.includes('widgets/windows.js');
      // Claimed synchronously, before the read: two paints that overlap must not both
      // be able to decide they are the held one.
      if (mine) { race.arm = false; race.claimed += 1; }
      const windows = await real(info);
      if (!mine) return windows;
      const here = windows.find((win) => win.id === windowId);
      const active = ((here && here.tabs) || []).find((tab) => tab.active);
      race.heldActive = active ? active.id : null;
      race.holding = true;
      await race.gate;
      race.holding = false;
      race.released += 1;
      return windows;
    };
  }, w2);

  // Arm and kick a repaint in the same turn. Any paint that fires from here on reads
  // the state this test just set up, so whichever one is claimed saw Alpha on top.
  await panel.evaluate(() => { window.__race.arm = true; window.__vt.render.render(); });
  await expect.poll(async () => panel.evaluate(() => window.__race.holding), { timeout: 30_000 })
    .toBe(true);

  const held = await panel.evaluate(() => ({
    claimed: window.__race.claimed, heldActive: window.__race.heldActive,
  }));
  expect(held.claimed, 'the hook never fired, so this test proved nothing — fix the test')
    .toBe(1);
  expect(held.heldActive,
    'the held paint must be the one that read ALPHA on top of W2: its result is the '
    + 'stale list, and a test holding any other paint is testing nothing')
    .toBe(tabIds.alpha);

  // Now supersede it. This paint reads Gamma and writes; the held one must not.
  await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), tabIds.gamma);
  await expect.poll(async () => w2Name.textContent(), { timeout: 20_000 }).toBe('Gamma');

  const after = await panel.evaluate(async () => {
    const race = window.__race;
    const from = race.writes.length;
    race.open();
    // The widget's continuation is a microtask off the hook's return and the observer
    // is delivered in the same checkpoint, so one task turn is strictly after both.
    // This is not waiting for anything to settle: when the timer fires, the stale write
    // has either already happened or been dropped, and there is no third outcome.
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    return { released: race.released, writes: race.writes.slice(from) };
  });
  expect(after.released, 'the held paint never resumed, so nothing was measured').toBe(1);
  // Named by content rather than by count: an unrelated repaint landing in the same
  // task turn would write Gamma again, which is harmless, while the bug writes Alpha.
  expect(after.writes.filter((w) => w.includes(`${w2}=Alpha`)),
    'the superseded paint wrote its stale list over the newer one, and nothing fires '
    + 'again to correct it')
    .toEqual([]);
  // Read once, with no retry, in that same turn: "the list is right now" rather than
  // "the list becomes right within 15 s".
  expect(await panel.evaluate((sel) => document.querySelector(sel).textContent,
    `${WINDOW_ROWS}[data-window-id="${w2}"] .w-row__main`)).toBe('Gamma');
});

// The other side of the same guard. The token is claimed BEFORE the read, so a paint
// whose read REJECTS has already taken the claim; leaving it taken makes an older paint
// whose read SUCCEEDED fail its own check and throw good data away, and nothing fires
// again. That is the same permanently stale screen the guard exists to prevent, reached
// from the opposite direction, which is why `recent.js` hands the claim back in its
// `catch`.
//
// The interleaving: A reads successfully and is held; B's read fails; A is let go and
// must still write. Every repaint other than A is made to fail for the whole of that
// window, which is both the B the test needs and the only way to be sure no OTHER paint
// quietly writes A's data for it — if it did, "A's data is on screen" would prove
// nothing at all.
test('a repaint whose read fails does not invalidate one whose read succeeded', async ({
  harness, serviceWorker,
}) => {
  test.setTimeout(180_000);
  const { panel, tabIds } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off', widgets: ['recent'] });
  await expect.poll(async () => panel.locator(RECENT_ROWS).count(), { timeout: 15_000 })
    .toBeGreaterThan(0);

  await panel.evaluate(() => {
    const real = chrome.tabs.query.bind(chrome.tabs);
    const race = {
      phase: 'idle', inflight: 0, claimed: 0, holding: false, released: 0,
      rejected: 0, heldActive: null, writes: [],
    };
    race.gate = new Promise((resolve) => { race.open = resolve; });
    window.__race = race;

    const list = document.querySelector('[data-testid="widget-recent-list"]');
    const shot = () => [...list.querySelectorAll('[data-testid="widget-recent-row"]')]
      .map((el) => Number(el.dataset.recentTab));
    new MutationObserver(() => { race.writes.push(shot()); })
      .observe(list, { childList: true, subtree: true });

    chrome.tabs.query = async (info) => {
      // Only the recently-used tool's own call: the tab list queries the same shape,
      // and failing that one would measure nothing about this bug.
      if (!new Error().stack.includes('widgets/recent.js')) return real(info);
      if (race.phase === 'arm') {
        // Synchronous, before the read: two overlapping paints must not both be held.
        race.phase = 'reject';
        race.claimed += 1;
        const tabs = await real(info);
        const active = tabs.find((tab) => tab.active);
        race.heldActive = active ? active.id : null;
        race.holding = true;
        await race.gate;
        race.holding = false;
        race.released += 1;
        return tabs;
      }
      if (race.phase === 'reject') {
        race.rejected += 1;
        throw new Error('vt-test: the read this repaint depends on failed');
      }
      race.inflight += 1;
      try {
        return await real(info);
      } finally {
        race.inflight -= 1;
      }
    };
  });

  // A known recency order, with gaps so the access times cannot tie. Gamma ends up
  // active and therefore off the list, leaving beta over alpha on screen.
  for (const id of [tabIds.beta, tabIds.gamma]) {
    await swEval(serviceWorker, async (tabId) => { await chrome.tabs.update(tabId, { active: true }); }, id);
    await sleep(1100);
  }
  await expect.poll(
    async () => panel.evaluate(() => [...document.querySelectorAll('[data-testid="widget-recent-row"]')]
      .map((el) => Number(el.dataset.recentTab))),
    { timeout: 20_000 },
  ).toEqual([tabIds.beta, tabIds.alpha]);
  // Nothing of the tool's may still be reading when the freeze goes on, or its write
  // could land after the state change below and put A's own answer on screen for free.
  await expect.poll(async () => panel.evaluate(() => window.__race.inflight), { timeout: 15_000 })
    .toBe(0);

  // Freeze the tool: from here every repaint but the held one fails its read, so the
  // screen keeps saying beta-over-alpha however many events arrive.
  await panel.evaluate(() => { window.__race.phase = 'reject'; });
  await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), tabIds.alpha);
  await expect.poll(async () => panel.evaluate(() => window.__race.rejected), { timeout: 20_000 })
    .toBeGreaterThan(0);

  // Alpha is active now, so the truth is gamma over beta — and the frozen screen still
  // says beta over alpha. Arm and repaint in one turn: `state.emit` is synchronous and
  // `paint` runs to its first await synchronously, so the claim is taken inside this
  // evaluate and no other paint can possibly take it.
  await panel.evaluate(() => { window.__race.phase = 'arm'; window.__vt.render.render(); });
  await expect.poll(async () => panel.evaluate(() => window.__race.holding), { timeout: 30_000 })
    .toBe(true);

  const held = await panel.evaluate(() => ({
    claimed: window.__race.claimed, heldActive: window.__race.heldActive,
  }));
  expect(held.claimed, 'the hook never fired, so this test proved nothing — fix the test')
    .toBe(1);
  expect(held.heldActive,
    'the held read must be the one taken while ALPHA was active: that is the read whose '
    + 'result differs from the screen, and the whole point of the race')
    .toBe(tabIds.alpha);

  // B: a repaint whose read fails, while A is still in flight.
  const rejectedByB = await panel.evaluate(async () => {
    const before = window.__race.rejected;
    window.__vt.render.render();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    return window.__race.rejected - before;
  });
  expect(rejectedByB,
    'no read failed while the held paint was in flight, so the interleaving this test '
    + 'exists for never happened')
    .toBeGreaterThan(0);

  const out = await panel.evaluate(async () => {
    const race = window.__race;
    const rows = () => [...document.querySelectorAll('[data-testid="widget-recent-row"]')]
      .map((el) => Number(el.dataset.recentTab));
    const before = { rows: rows(), from: race.writes.length };
    race.open();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    return { before, released: race.released, writes: race.writes.slice(before.from), rows: rows() };
  });
  expect(out.released, 'the held paint never resumed, so nothing was measured').toBe(1);
  expect(out.before.rows,
    'the screen already showed what the held paint was about to write, so a passing '
    + 'assertion below would not mean the held paint wrote anything')
    .not.toEqual([tabIds.gamma, tabIds.beta]);
  // Exactly one write, and it is A's: every other repaint is still failing its read, so
  // nothing else in this turn can touch the list. Read with no retry — a later corrective
  // paint must not be able to stand in for the write under test.
  expect(out.writes,
    'the paint whose read SUCCEEDED was invalidated by one whose read FAILED, so its '
    + 'result was thrown away and the screen keeps a list older than the one discarded')
    .toEqual([[tabIds.gamma, tabIds.beta]]);
  expect(out.rows).toEqual([tabIds.gamma, tabIds.beta]);
});
