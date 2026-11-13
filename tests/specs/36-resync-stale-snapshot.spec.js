// 36-resync-stale-snapshot — a full resync that was read BEFORE an event must not overwrite what the event did.
//
// The defect (H2, found while reviewing PR #15): state.js resyncNow() reads tabs.query() and then
// replaces state.tabs / state.order / state.groups wholesale, with no record of what happened while it
// was reading. Two things made that wrong:
//   * the resync timer is cleared BEFORE resyncNow() awaits, so a second resync can start while the
//     first is still in flight, and the OLDER of the two can finish LAST;
//   * an incremental event (tabs.onRemoved, onCreated, onUpdated ...) applied while a snapshot is in
//     flight is simply overwritten when the snapshot lands.
// A closed tab came back as a "ghost" card that nothing healed until the next structural event; a tab
// created or an update applied in the same window was lost the same way.
//
// How the snapshot is held, with no sleep standing in for ordering. The panel's own chrome.tabs.query is
// wrapped, and ONLY the calls whose stack contains resyncNow() are touched (reconcileTabStatuses() and
// the widgets also call tabs.query). The first such call after arming is held until the test releases it:
//   mode 'stale' reads Chrome NOW and delivers the result late. The snapshot is genuinely older than the
//                event that follows it. This is what a response overtaken by an event looks like.
//   mode 'late'  waits and reads Chrome only when released. The snapshot is NEWER than the events that
//                landed meanwhile; a fix that throws it away must still converge.
// The test then does its verb through the service worker, waits (on the panel model, never on a clock)
// for the panel to have applied the verb's events, releases the snapshot, and asserts the panel model and
// the DOM equal what Chrome reports.
//
// Two families:
//   S  (stale)  the explicit resync() is held; the verb lands while it is held. Closing a loose tab and
//               closing a grouped tab are the ghost of H2 itself; create / move / mute are the same race
//               in the other direction (a stale snapshot erasing what an event added or changed).
//   L  (late)   the resync that a tab MOVE triggers is held while it is still reading, so that resync is
//               the ONLY carrier of that move (onMoved updates nothing incrementally). A create / move /
//               mute lands meanwhile. The snapshot read after them is correct, so discarding it must be
//               followed by a fresh one: if the move never reaches the model, the discard lost it.
//               Measured with a mutant that discards and does NOT read again (x3): L create and L mute go red
//               every time, L move stays green. The move it makes asks for another resync of its own, so it
//               converges anyway: it is here as the one-test-per-verb case, not as the guard against that mutant.
//
// Not covered: the interleaving of two snapshots that both start before an event and land in either
// order (only one snapshot is held at a time), and how a very dense event stream delays a resync.
'use strict';

const { test, expect } = require('../fixtures');
const { swEval, setSettings, createTab, queryTabs, cardOrder } = require('../helpers/chrome');

const PANEL_VIEWPORT = Object.freeze({ width: 400, height: 1500 });
const WAIT = Object.freeze({ timeout: 15000 });

test.beforeEach(async ({ harness, serviceWorker }) => {
  await harness.panel.setViewportSize(PANEL_VIEWPORT);
  await setSettings(serviceWorker, { refreshInterval: 'off' });
});

/** What the panel model says, in the shape of `liveView()` so the two can be compared with toEqual. */
async function modelView(panel) {
  return panel.evaluate(() => {
    const s = window.__vt.state;
    return {
      tabs: s.order.map((id) => {
        const t = s.tabs.get(id);
        return t
          ? { id, index: t.index, groupId: t.groupId, muted: !!(t.mutedInfo && t.mutedInfo.muted) }
          : { id, missing: true };
      }),
      size: s.tabs.size,
    };
  });
}

/** What Chrome says about the panel's window. */
async function liveView(sw, w2) {
  const tabs = (await queryTabs(sw, w2)).map((t) => ({
    id: t.id, index: t.index, groupId: t.groupId, muted: t.muted,
  }));
  return { tabs, size: tabs.length };
}

async function expectModelEqualsChrome(panel, sw, w2, why) {
  const live = await liveView(sw, w2);
  const model = await modelView(panel);
  expect(model, `panel model vs Chrome ${why}`).toEqual(live);
  // The DOM follows the model through a scheduled render, so wait for it (a condition, not a delay).
  await expect.poll(() => cardOrder(panel), { message: `cards in the DOM vs Chrome ${why}`, timeout: 10000 })
    .toEqual(live.tabs.map((t) => t.id));
}

/**
 * Three loose tabs after one group of three: [alpha beta gamma](Work) delta epsilon zeta, then waits until the
 * panel model equals Chrome. Wrapped in the hold afterwards, so nothing here is held.
 */
async function layout({ harness, serviceWorker }) {
  const { w2, tabIds, urls, panel } = harness;
  const delta = await createTab(serviceWorker, w2, urls.delta, { active: false });
  const epsilon = await createTab(serviceWorker, w2, urls.page('ffff00', 'Epsilon'), { active: false });
  const zeta = await createTab(serviceWorker, w2, urls.page('00ffff', 'Zeta'), { active: false });
  const ids = { alpha: tabIds.alpha, beta: tabIds.beta, gamma: tabIds.gamma, delta, epsilon, zeta };
  await swEval(serviceWorker, async (a) => {
    const g = await chrome.tabs.group({ tabIds: [a.alpha, a.beta, a.gamma], createProperties: { windowId: a.w } });
    await chrome.tabGroups.update(g, { title: 'Work', color: 'blue' });
  }, { ...ids, w: w2 });
  await expect(panel.locator('#tablist [data-testid="tab-card"]')).toHaveCount(6, { timeout: 15000 });
  await expect.poll(async () => JSON.stringify(await modelView(panel)) === JSON.stringify(await liveView(serviceWorker, w2)),
    { message: 'layout settled: model equals Chrome', timeout: 15000 }).toBe(true);
  return ids;
}

/** Wraps the panel's tabs.query / tabGroups.query. Only calls made from resyncNow() are counted or held. */
async function installHold(panel) {
  await panel.evaluate(() => {
    const h = (window.__hold = {
      mode: null, held: false, release: null, promise: null,
      out: 0, // resync queries currently in flight (held or not)
      applied: 0, // 'resync' events (a snapshot reached the model) since the last arm()
    });
    const fromResync = () => /\bresyncNow\b/.test(new Error().stack || '');
    const realTabs = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = function (q) {
      if (!fromResync()) return realTabs(q);
      const mode = h.mode;
      h.mode = null;
      h.out += 1;
      return (async () => {
        try {
          let snap;
          if (mode === 'stale') snap = await realTabs(q);
          if (mode) {
            h.held = true;
            await new Promise((res) => { h.release = res; });
          }
          if (mode !== 'stale') snap = await realTabs(q);
          return snap;
        } finally {
          h.out -= 1;
        }
      })();
    };
    if (chrome.tabGroups && chrome.tabGroups.query) {
      const realGroups = chrome.tabGroups.query.bind(chrome.tabGroups);
      chrome.tabGroups.query = function (q) {
        if (!fromResync()) return realGroups(q);
        h.out += 1;
        return realGroups(q).finally(() => { h.out -= 1; });
      };
    }
    window.__vt.stateModule.subscribe('resync', () => { h.applied += 1; });
  });
}

/**
 * Arms the hold, optionally starting the held resync in the SAME synchronous page task (so no timer can fire
 * between the two). Returns once the hold is armed. First drains any resync already pending, then arms only
 * while nothing from resyncNow() is in flight: that is what makes the held snapshot the only one that straddles
 * the verb.
 */
async function arm(panel, mode, { startResync = false } = {}) {
  await panel.evaluate(() => window.__vt.stateModule.resync());
  for (;;) {
    const armed = await panel.evaluate(({ m, start }) => {
      const h = window.__hold;
      if (h.out !== 0) return false;
      h.mode = m; h.held = false; h.release = null; h.promise = null; h.applied = 0;
      if (start) h.promise = window.__vt.stateModule.resync();
      return true;
    }, { m: mode, start: startResync });
    if (armed) return;
    await panel.waitForFunction(() => window.__hold.out === 0, null, WAIT);
  }
}

const release = (panel) => panel.evaluate(() => window.__hold.release());
const waitHeld = (panel) => panel.waitForFunction(() => window.__hold.held === true, null, WAIT);

/**
 * The verbs. `run` does it in Chrome; `seen` resolves once the PANEL MODEL reflects it (events applied).
 * `lateRun` is the variant used while the resync of a move is held, where the moved tab differs.
 */
const VERBS = [
  {
    key: 'close-loose',
    title: 'a loose tab is closed',
    run: (c) => swEval(c.sw, (id) => chrome.tabs.remove(id), c.ids.epsilon),
    seen: (c) => c.panel.waitForFunction((id) => !window.__vt.state.tabs.has(id), c.ids.epsilon, WAIT),
  },
  {
    key: 'close-grouped',
    title: 'a grouped tab is closed (its own onUpdated(-1) resync has run first)',
    run: (c) => swEval(c.sw, (id) => chrome.tabs.remove(id), c.ids.beta),
    seen: (c) => c.panel.waitForFunction(
      (id) => !window.__vt.state.tabs.has(id) && window.__hold.applied >= 1, c.ids.beta, WAIT),
  },
  {
    key: 'create',
    title: 'a tab is created',
    run: async (c) => { c.ids.eta = await createTab(c.sw, c.w2, c.urls.page('ff8800', 'Eta'), { active: false, index: 4 }); },
    seen: (c) => c.panel.waitForFunction((id) => {
      const t = window.__vt.state.tabs.get(id);
      return !!t && t.status === 'complete';
    }, c.ids.eta, WAIT),
  },
  {
    key: 'move',
    title: 'a tab is moved',
    run: (c) => swEval(c.sw, (id) => chrome.tabs.move(id, { index: 3 }), c.ids.zeta),
    lateRun: (c) => swEval(c.sw, (id) => chrome.tabs.move(id, { index: 3 }), c.ids.epsilon),
    seen: (c) => c.panel.waitForFunction((a) => {
      const t = window.__vt.state.tabs.get(a.id);
      return !!t && t.index === 3 && window.__hold.applied >= 1;
    }, { id: c.moved }, WAIT),
  },
  {
    key: 'mute',
    title: 'a tab is updated (muted)',
    run: (c) => swEval(c.sw, (id) => chrome.tabs.update(id, { muted: true }), c.ids.delta),
    seen: (c) => c.panel.waitForFunction((id) => {
      const t = window.__vt.state.tabs.get(id);
      return !!t && !!(t.mutedInfo && t.mutedInfo.muted);
    }, c.ids.delta, WAIT),
  },
];

for (const verb of VERBS) {
  // S: the snapshot is read before the verb and delivered after it.
  test(`36 S ${verb.key}: ${verb.title} while a resync snapshot read before it is still held`,
    async ({ harness, serviceWorker }) => {
      test.setTimeout(120000);
      const { panel, w2, urls } = harness;
      const ids = await layout({ harness, serviceWorker });
      await installHold(panel);
      const c = { panel, sw: serviceWorker, w2, urls, ids, moved: ids.zeta };

      // 1. a resync whose snapshot is read now (everything still as laid out), delivered when released
      await arm(panel, 'stale', { startResync: true });
      await waitHeld(panel);

      // 2. the verb happens for real; wait until the panel has applied it
      await verb.run(c);
      await verb.seen(c);

      // 3. the old snapshot lands. resync() resolves when that resync is finished, the model converged or not.
      await release(panel);
      await panel.evaluate(() => window.__hold.promise);
      await expectModelEqualsChrome(panel, serviceWorker, w2, `after the held ${verb.key} snapshot landed`);
    });
}

for (const verb of VERBS.filter((v) => v.key !== 'close-loose' && v.key !== 'close-grouped')) {
  // L: the snapshot is still being read when the verb lands, and it is the only carrier of an earlier move.
  test(`36 L ${verb.key}: ${verb.title} while the resync of a move is still reading`,
    async ({ harness, serviceWorker }) => {
      test.setTimeout(120000);
      const { panel, w2, urls } = harness;
      const ids = await layout({ harness, serviceWorker });
      await installHold(panel);
      const c = { panel, sw: serviceWorker, w2, urls, ids, moved: verb.key === 'move' ? ids.epsilon : ids.zeta };

      // 1. X: a move. tabs.onMoved updates nothing by itself and asks for a resync, which is held while reading.
      await arm(panel, 'late');
      await swEval(serviceWorker, (id) => chrome.tabs.move(id, { index: 3 }), ids.zeta);
      await waitHeld(panel);
      // The model does not know about X yet: that resync is its only way in.
      expect(await modelView(panel), 'the held resync is the only carrier of the move')
        .not.toEqual(await liveView(serviceWorker, w2));

      // 2. V lands while it is held
      await (verb.lateRun || verb.run)(c);
      await verb.seen(c);

      // 3. the snapshot, read after X and V, is released. Whatever the fix does with it, X and V must be in the model.
      await release(panel);
      await expect.poll(async () => JSON.stringify(await modelView(panel)) === JSON.stringify(await liveView(serviceWorker, w2)),
        { message: `model converged on Chrome after ${verb.key} while a move's resync was reading`, timeout: 15000 }).toBe(true);
      await expectModelEqualsChrome(panel, serviceWorker, w2, `after ${verb.key} while a move's resync was reading`);
    });
}
