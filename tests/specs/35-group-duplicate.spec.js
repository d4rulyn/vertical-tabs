// 35-group-duplicate — closing tabs of a group must not leave the panel with a second container for it.
//
// The defect (Probe 10 and 11 in .agent/probe-results.md, Chromium 151): when a grouped tab closes,
// Chrome sends tabs.onUpdated a few ms before tabs.onRemoved with a payload of {index: -1, groupId: -1,
// status: 'unloaded'}. state.js stored it, and the onRemoved that follows ran shiftIndices(-1, -1) —
// every other tab "after index -1", i.e. all of them — so the survivors read -1, 0, 1 ... until the
// next resync() a couple of hundred ms later. When the closing tab sorts into the middle of a group,
// render.js's buildRows() emitted TWO rows with one key (g<id>), reconcile() created a second `.group`
// container for it, and every later render kept the stale one: it stayed until the panel was reopened.
//
// What each test pins down, and how:
//  * EVENT-DRIVEN (state.js layer). Real tabs are closed with chrome.tabs.remove. A probe listener,
//    registered after the panel's own listeners and therefore run after them, renders synchronously at
//    every tabs.onUpdated / tabs.onRemoved / tabGroups.onRemoved: a render landing at each point of the
//    window. After each one the panel model must hold no negative index, keep every tab's group and
//    stay in index order, and the DOM must have one container per group and one card per tab. Nothing
//    in the events is simulated; only the TIMING of the renders is forced. How often a render lands in
//    the window on its own is not what this measures (Probe 10: 0 of 23 closes).
//  * MODEL SPLICE (render.js layer). state.order is rewritten so that a group's tabs are not adjacent,
//    render() is called, then the true model is put back and rendered again. One container per group id
//    and one card per tab id must hold in the split render and after it.
//  * STALE TWIN (render.js layer, thumbs.js contract). A second container for the same group is put in
//    the DOM, as an older build left it; every card in it goes through thumbs.applyTo() so it holds its
//    own preview reference, the way a card the renderer built does. One render must remove it WITHOUT
//    giving back a reference the live card still holds (the spec 34 grace-timer spy: a count reaching
//    zero arms one OBJECT_URL_GRACE_MS timer), without a reference leaking, and without the live card
//    losing its registration (thumbs.refresh() still reaches it).
//  * NEGATIVE FROM (state.js shiftIndices). A cached negative index is planted in the model and that tab
//    is closed for real: the tabs before it must keep their indices.
//
// Not covered: the real capture pipeline for the preview refresh (the STALE TWIN test calls
// thumbs.refresh(), the function the vt/thumb-updated handler calls, not the service worker's capture),
// and layouts other than the two used here (a group of two closed next to a surviving group, one
// member closed from a group of three).
//
// Since Probe 12 the file also drives the OTHER operations that deliver the same payloads: ungrouping the middle
// member, adding a loose tab to a group (not next to it, and into its middle), a grouped tab leaving its window,
// closing a pinned tab and closing a member of a collapsed group. The block that starts "The other operations that
// reach the same code", further down, says what each of those does and what it leaves uncovered; the paragraph
// above is about the first four describes only.
'use strict';

const { test, expect } = require('../fixtures');
const { swEval, setSettings, createTab, keyOf, waitForThumb } = require('../helpers/chrome');
const { extConstant } = require('../helpers/ext-constants');

const GRACE_MS = extConstant('OBJECT_URL_GRACE_MS');
const PANEL_VIEWPORT = Object.freeze({ width: 400, height: 1500 });
const CARD = (tabId) => `#tablist [data-testid="tab-card"][data-tab-id="${tabId}"]`;

test.beforeEach(async ({ harness, serviceWorker }) => {
  await harness.panel.setViewportSize(PANEL_VIEWPORT);
  await setSettings(serviceWorker, { refreshInterval: 'off' });
});

/**
 * Installed into the panel page. `names` maps tab id -> a readable name for failure messages.
 * readDom() reads what a user sees; settle() is a real resync() followed by the render it schedules;
 * plantTwinAndRender() clones a group container the way an older build used to leave one behind and
 * renders once, all in one synchronous call so that no event or frame can run in between.
 */
async function installProbe(panel, names) {
  await panel.evaluate((nameOf) => {
    const name = (id) => nameOf[id] || String(id);
    const cardsIn = (root) => [...root.querySelectorAll('[data-testid="tab-card"]')]
      .map((c) => Number(c.dataset.tabId));
    window.__dup = {
      readDom() {
        const list = document.querySelector('#tablist');
        return {
          groups: [...list.querySelectorAll('.group')].map((g) => Number(g.dataset.groupId)),
          cards: cardsIn(list),
          shape: [...list.children].map((el) => (el.classList.contains('group')
            ? `g${el.dataset.groupId}[${cardsIn(el).map(name).join(',')}]`
            : `c${name(Number(el.dataset.tabId))}`)),
        };
      },
      async settle() {
        const sm = window.__vt.stateModule;
        let resynced = false;
        const rendered = new Promise((resolve) => {
          const off = sm.subscribe('rendered', () => { if (resynced) { off(); resolve(); } });
        });
        await sm.resync();
        resynced = true;
        await rendered;
      },
      plantTwinAndRender(groupId, registerTo) {
        const vt = window.__vt;
        const live = document.querySelector(`#tablist > .group[data-group-id="${groupId}"]`);
        const twin = live.cloneNode(true);
        // `data-thumb-key` is the card's record of the ONE reference it holds, and cloneNode copies it:
        // a bare clone would claim the original's reference. Each card of the twin takes its own, as a
        // card built by the renderer does, and applyTo() also registers it with thumbs.js.
        for (const card of twin.querySelectorAll('.tab-card')) {
          delete card.dataset.thumbKey;
          card.removeAttribute('id');
          vt.thumbs.applyTo(card, vt.state.tabs.get(Number(card.dataset.tabId)));
        }
        live.after(twin);
        if (registerTo === 'live') {
          for (const card of live.querySelectorAll('.tab-card')) {
            vt.thumbs.applyTo(card, vt.state.tabs.get(Number(card.dataset.tabId)));
          }
        }
        const planted = window.__dup.readDom();
        vt.render.render();
        return { planted, healed: window.__dup.readDom() };
      },
    };
  }, names);
}

/** Records every timer thumbs.js arms with the grace delay, i.e. every release() that took a count to zero. */
async function installGraceSpy(panel) {
  await panel.evaluate((grace) => {
    if (window.__graceSpy) return;
    const arms = [];
    const real = window.setTimeout;
    window.setTimeout = function patched(fn, delay, ...rest) {
      if (delay === grace) {
        arms.push(String(new Error().stack).split('\n').slice(2, 5)
          .map((line) => line.trim().replace(/^at /, '').replace(/ \(.*$/, '')).join(' < '));
      }
      return real.call(window, fn, delay, ...rest);
    };
    window.__graceSpy = { arms };
  }, GRACE_MS);
}

const readArms = (panel) => panel.evaluate(() => window.__graceSpy.arms.slice());

/**
 * alpha beta gamma = Work; delta = Other, with epsilon either alone (loose) or a second member of Other.
 * Returns the tab ids, the group ids and the names the failure messages use.
 */
async function buildLayout({ harness, serviceWorker }, { epsilonInOther = false } = {}) {
  const { w2, tabIds, urls, panel } = harness;
  const delta = await createTab(serviceWorker, w2, urls.delta, { active: false });
  const epsilon = await createTab(serviceWorker, w2, urls.page('ffff00', 'Epsilon'), { active: false });
  const ids = { alpha: tabIds.alpha, beta: tabIds.beta, gamma: tabIds.gamma, delta, epsilon };

  const groups = await swEval(serviceWorker, async (a) => {
    const work = await chrome.tabs.group({
      tabIds: [a.alpha, a.beta, a.gamma], createProperties: { windowId: a.windowId },
    });
    await chrome.tabGroups.update(work, { title: 'Work', color: 'blue' });
    const other = await chrome.tabs.group({
      tabIds: a.epsilonInOther ? [a.delta, a.epsilon] : [a.delta], createProperties: { windowId: a.windowId },
    });
    await chrome.tabGroups.update(other, { title: 'Other', color: 'red' });
    return { work, other };
  }, { ...ids, windowId: w2, epsilonInOther });

  const placed = await swEval(serviceWorker, async (wid) => Object.fromEntries(
    (await chrome.tabs.query({ windowId: wid })).map((t) => [t.id, t.groupId])), w2);
  expect(placed, 'setup did not build the layout').toEqual({
    [ids.alpha]: groups.work, [ids.beta]: groups.work, [ids.gamma]: groups.work,
    [ids.delta]: groups.other, [ids.epsilon]: epsilonInOther ? groups.other : -1,
  });
  await expect(panel.locator('#tablist .group'), 'the panel shows both groups').toHaveCount(2, { timeout: 15_000 });
  await expect(panel.locator('#tablist [data-testid="tab-card"]'), 'the panel shows five cards')
    .toHaveCount(5, { timeout: 15_000 });

  const names = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
  await installProbe(panel, names);
  return { ids, names, ...groups };
}

/** Duplicates in what the user sees: group ids rendered twice, tab ids with two cards. */
function duplicatesIn(dom) {
  const twice = (list) => [...new Set(list.filter((v, i) => list.indexOf(v) !== i))];
  return { groups: twice(dom.groups), cards: twice(dom.cards) };
}

function expectOneEach(dom, label, tabIds) {
  const dup = duplicatesIn(dom);
  expect.soft(
    dup.groups,
    `${label}: duplicate group container — group id(s) ${dup.groups.join(', ')} are in the DOM more than once ` +
    `(DOM: ${dom.shape.join(' ')})`,
  ).toEqual([]);
  expect.soft(
    dup.cards,
    `${label}: a tab has more than one card (DOM: ${dom.shape.join(' ')})`,
  ).toEqual([]);
  if (tabIds) {
    expect.soft(
      [...dom.cards].sort((a, b) => a - b),
      `${label}: every tab has exactly one card (DOM: ${dom.shape.join(' ')})`,
    ).toEqual([...tabIds].sort((a, b) => a - b));
  }
}

/**
 * From now on every tabs.onUpdated / tabs.onRemoved / tabGroups.onRemoved renders at once, after the
 * panel's own listener for the same event has updated the model, and records the model and the DOM.
 */
async function installEventProbe(panel, names) {
  await panel.evaluate((nameOf) => {
    const vt = window.__vt;
    const st = vt.state;
    const name = (id) => nameOf[id] || String(id);
    const frames = (window.__frames = []);
    const frame = (ev, tabId, payload) => {
      const model = st.order.map((id) => {
        const t = st.tabs.get(id);
        return { name: name(id), index: t ? t.index : null, groupId: t ? t.groupId : null };
      });
      vt.render.render();
      frames.push({ ev, tab: tabId == null ? null : name(tabId), payload, model, dom: window.__dup.readDom() });
    };
    chrome.tabs.onUpdated.addListener((tabId, info, tab) => frame(
      'tabs.onUpdated', tabId, tab ? { index: tab.index, groupId: tab.groupId } : null));
    chrome.tabs.onRemoved.addListener((tabId) => frame('tabs.onRemoved', tabId, null));
    chrome.tabGroups.onRemoved.addListener(() => frame('tabGroups.onRemoved', null, null));
  }, names);
}

/** Waits until Chrome and the panel model agree that exactly `count` tabs are left, then renders once for real. */
async function settleAfterClose({ harness, serviceWorker }, count) {
  const { panel, w2 } = harness;
  await expect.poll(
    () => swEval(serviceWorker, async (wid) => (await chrome.tabs.query({ windowId: wid })).length, w2),
    { message: `Chrome never reached ${count} tabs`, timeout: 20_000 },
  ).toBe(count);
  await expect.poll(
    () => panel.evaluate(() => window.__vt.state.tabs.size),
    { message: `the panel model never reached ${count} tabs`, timeout: 20_000 },
  ).toBe(count);
  await panel.evaluate(() => window.__dup.settle());
}

/** What the model and the DOM must satisfy after EVERY event of a close; one string per violation. */
function problemsInFrames(frames, { groupOf, tabsNeverLoose = [] }) {
  const problems = [];
  for (const f of frames) {
    const where = `after ${f.ev}${f.tab ? ` of ${f.tab}` : ''}`;
    const negative = f.model.filter((t) => t.index < 0);
    if (negative.length) {
      problems.push(`${where}: the model holds a negative index: ${negative.map((t) => `${t.name}:${t.index}`).join(' ')}`);
    }
    const indices = f.model.map((t) => t.index);
    if (!indices.every((v, i) => i === 0 || v > indices[i - 1])) {
      problems.push(`${where}: indices are not strictly increasing along the model's order: ` +
        f.model.map((t) => `${t.name}:${t.index}`).join(' '));
    }
    const drift = f.model.filter((t) => t.name in groupOf && t.groupId !== groupOf[t.name]);
    if (drift.length) {
      problems.push(`${where}: the model moved a tab out of its group: ` +
        drift.map((t) => `${t.name} is in ${t.groupId}, Chrome has it in ${groupOf[t.name]}`).join('; '));
    }
    for (const loose of tabsNeverLoose) {
      if (f.dom.shape.includes(`c${loose}`)) {
        problems.push(`${where}: ${loose} is drawn as a loose card above its group (DOM: ${f.dom.shape.join(' ')})`);
      }
    }
    const dup = duplicatesIn(f.dom);
    if (dup.groups.length || dup.cards.length) {
      problems.push(`${where}: duplicate DOM — groups ${dup.groups.join(',') || 'none'}, tabs ${dup.cards.join(',') || 'none'} ` +
        `(DOM: ${f.dom.shape.join(' ')})`);
    }
  }
  return problems;
}

const DEFECT = 'a closing tab\'s tabs.onUpdated (index -1, groupId -1; Probe 10/11) corrupted the panel';

test.describe('closing tabs of a group, with a render at every step of the events', () => {
  test('a group of two closed next to a surviving group leaves one container and a sane model', async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    const { ids, names, work, other } = await buildLayout({ harness, serviceWorker }, { epsilonInOther: true });
    await installEventProbe(panel, names);

    await swEval(serviceWorker, (close) => chrome.tabs.remove(close), [ids.delta, ids.epsilon]);
    await settleAfterClose({ harness, serviceWorker }, 3);

    const { frames, dom, model } = await panel.evaluate(() => ({
      frames: window.__frames,
      dom: window.__dup.readDom(),
      model: [...window.__vt.state.order].map((id) => window.__vt.state.tabs.get(id).index),
    }));
    expect(
      frames.some((f) => f.ev === 'tabs.onUpdated' && f.payload && f.payload.index < 0),
      'premise: no tabs.onUpdated with index < 0 reached the panel for a closing tab (Probe 10), so no render ' +
      'was forced into the window and this test proves nothing; events seen: ' +
      frames.map((f) => `${f.ev}${f.tab ? `(${f.tab})` : ''}`).join(' '),
    ).toBe(true);

    const groupOf = { alpha: work, beta: work, gamma: work, delta: other, epsilon: other };
    const problems = problemsInFrames(frames, { groupOf });
    expect.soft(problems, `${DEFECT} model or its rendering:\n${problems.join('\n')}`).toEqual([]);

    expectOneEach(dom, 'at the end of the close', [ids.alpha, ids.beta, ids.gamma]);
    expect.soft(dom.shape, 'at the end of the close the panel shows only Work, with its three tabs')
      .toEqual([`g${work}[alpha,beta,gamma]`]);
    expect.soft(model, 'at the end of the close the indices are 0, 1, 2 — Chrome\'s own').toEqual([0, 1, 2]);
  });

  test('one member closed from a group of three keeps its group, its neighbours\' indices and one container', async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    const { ids, names, work, other } = await buildLayout({ harness, serviceWorker });
    await installEventProbe(panel, names);

    await swEval(serviceWorker, (close) => chrome.tabs.remove(close), [ids.gamma]);
    await settleAfterClose({ harness, serviceWorker }, 4);

    const { frames, dom, model } = await panel.evaluate(() => ({
      frames: window.__frames,
      dom: window.__dup.readDom(),
      model: [...window.__vt.state.order].map((id) => window.__vt.state.tabs.get(id).index),
    }));
    expect(
      frames.some((f) => f.ev === 'tabs.onUpdated' && f.tab === 'gamma' && f.payload && f.payload.index < 0),
      'premise: no tabs.onUpdated with index < 0 reached the panel for the closing member (Probe 11), so no ' +
      'render was forced into the window and this test proves nothing; events seen: ' +
      frames.map((f) => `${f.ev}${f.tab ? `(${f.tab})` : ''}`).join(' '),
    ).toBe(true);

    const groupOf = { alpha: work, beta: work, gamma: work, delta: other, epsilon: -1 };
    const problems = problemsInFrames(frames, { groupOf, tabsNeverLoose: ['gamma'] });
    expect.soft(problems, `${DEFECT} model or its rendering:\n${problems.join('\n')}`).toEqual([]);

    expectOneEach(dom, 'at the end of the close', [ids.alpha, ids.beta, ids.delta, ids.epsilon]);
    expect.soft(dom.shape, 'at the end of the close Work has its two remaining tabs')
      .toEqual([`g${work}[alpha,beta]`, `g${other}[delta]`, 'cepsilon']);
    expect.soft(model, 'at the end of the close the indices are 0, 1, 2, 3 — Chrome\'s own').toEqual([0, 1, 2, 3]);
  });
});

test.describe('a model that splits a group', () => {
  // The same five tabs in an order in which a group is not adjacent. `index` is renumbered to match, so
  // the order is the only thing that differs from a model Chrome could have produced.
  const SPLITS = [
    { name: 'a loose tab sits between two members', order: ['alpha', 'epsilon', 'beta', 'gamma', 'delta'] },
    { name: 'a tab of another group sits between two members', order: ['alpha', 'beta', 'delta', 'gamma', 'epsilon'] },
  ];
  for (const split of SPLITS) {
    test(`still renders one container per group and one card per tab when ${split.name}`, async ({ harness, serviceWorker }) => {
      const { panel } = harness;
      const { ids, work, other } = await buildLayout({ harness, serviceWorker });
      const everyTab = Object.values(ids);
      const trueShape = [`g${work}[alpha,beta,gamma]`, `g${other}[delta]`, 'cepsilon'];

      // One synchronous evaluate: no event, resync or animation frame can run between the steps.
      const seen = await panel.evaluate(({ ids: byName, order }) => {
        const vt = window.__vt;
        const st = vt.state;
        const trueOrder = [...st.order];
        const trueTabs = new Map(st.tabs);
        const out = {};

        st.order = order.map((k) => byName[k]);
        st.order.forEach((id, i) => st.tabs.set(id, { ...trueTabs.get(id), index: i }));
        vt.render.render();
        out.split = window.__dup.readDom();

        st.order = trueOrder;
        for (const [id, tab] of trueTabs) st.tabs.set(id, tab);
        vt.render.render();
        out.restored = window.__dup.readDom();

        for (let i = 0; i < 3; i += 1) vt.render.render();
        out.again = window.__dup.readDom();
        return out;
      }, { ids, order: split.order });

      expectOneEach(seen.split, 'in the render of the split model', everyTab);
      expectOneEach(seen.restored, 'in the next render, with the true model back', everyTab);
      expect.soft(seen.restored.shape, 'the true model is drawn as it is in Chrome').toEqual(trueShape);
      expectOneEach(seen.again, 'after three more renders', everyTab);
      expect.soft(seen.again.shape, 'three more renders change nothing').toEqual(trueShape);

      await panel.evaluate(() => window.__dup.settle());
      const healed = await panel.evaluate(() => window.__dup.readDom());
      expectOneEach(healed, 'after a real resync() and the render it schedules', everyTab);
      expect.soft(healed.shape, 'a real resync() leaves the true shape').toEqual(trueShape);
    });
  }
});

test.describe('a duplicate container that is already in the DOM', () => {
  for (const registeredTo of ['stale', 'live']) {
    test(`is removed by one render without costing the live card its preview (thumbs.js registration points at the ${registeredTo === 'stale' ? 'stale twin' : 'live card'})`, async ({ harness, serviceWorker }) => {
      test.setTimeout(180_000);
      const { panel, urls } = harness;
      const { ids, work } = await buildLayout({ harness, serviceWorker });

      // alpha shows a preview, so its card holds one reference on the shared entry.
      const key = await keyOf(panel, urls.alpha);
      await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), ids.alpha);
      await waitForThumb(panel, key, { timeout: 40_000 });
      await expect.poll(
        () => panel.evaluate((id) => {
          const img = document.querySelector(`[data-testid="tab-card"][data-tab-id="${id}"] .thumb__img`);
          return img ? img.getAttribute('src') : null;
        }, ids.alpha),
        { message: 'precondition: alpha\'s card in the group shows its preview', timeout: 20_000 },
      ).toMatch(/^blob:/);
      await installGraceSpy(panel);
      await panel.evaluate(() => window.__graceSpy.arms.splice(0));

      const { planted, healed } = await panel.evaluate(
        ([group, to]) => window.__dup.plantTwinAndRender(group, to), [work, registeredTo]);
      expect(duplicatesIn(planted).groups, 'precondition: the twin is in the DOM next to the live Work container')
        .toEqual([work]);
      expect(
        duplicatesIn(healed).groups,
        `one render must remove a duplicate container, but it is still there (DOM: ${healed.shape.join(' ')}) — ` +
        'reconcile() keeps one element per key and never removed the other',
      ).toEqual([]);
      expectOneEach(healed, 'after the render', [ids.alpha, ids.beta, ids.gamma, ids.delta, ids.epsilon]);

      const afterHeal = await readArms(panel);
      expect.soft(
        afterHeal,
        'removing the twin gave back a reference the live card still holds: the shared entry\'s count reached ' +
        `zero while the live card shows it (grace timers armed by: ${afterHeal.join(' | ') || 'none'})`,
      ).toEqual([]);

      // The vt/thumb-updated handler calls thumbs.refresh(key); a live card that is no longer registered
      // is skipped by it and keeps the old object URL, and an entry whose count was driven to zero gets
      // no object URL at all.
      const swapped = await panel.evaluate(async ({ id, urlKey }) => {
        const img = () => document.querySelector(`[data-testid="tab-card"][data-tab-id="${id}"] .thumb__img`);
        const before = img().getAttribute('src');
        await window.__vt.thumbs.refresh(urlKey);
        return { before, after: img().getAttribute('src') };
      }, { id: ids.alpha, urlKey: key });
      expect.soft(swapped.before, 'precondition: the live card shows a blob: preview before the refresh').toMatch(/^blob:/);
      expect.soft(
        swapped.after,
        'after the render the live card no longer receives thumb updates (or lost its object URL): ' +
        `src before the refresh ${swapped.before}, after ${swapped.after}`,
      ).toMatch(/^blob:/);
      expect.soft(swapped.after, 'the live card still shows the object URL from before thumbs.refresh()')
        .not.toBe(swapped.before);

      // The last holder gives the reference back once: not never (a leak — the twin's reference stays), not twice.
      await swEval(serviceWorker, (id) => chrome.tabs.remove(id), ids.alpha);
      await expect(panel.locator(CARD(ids.alpha)), 'alpha\'s card leaves the list').toHaveCount(0, { timeout: 15_000 });
      const arms = await readArms(panel);
      expect(
        arms,
        'closing the last tab on the URL: exactly one release takes the shared entry\'s count to zero ' +
        `(armed by: ${arms.join(' | ') || 'none — a reference leaked'})`,
      ).toHaveLength(1);
    });
  }
});

test.describe('a negative index in the model', () => {
  test('never renumbers the strip when its tab is removed', async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    const { ids } = await buildLayout({ harness, serviceWorker });
    await panel.evaluate(() => window.__dup.settle());

    // A tab outside the strip reports index -1 and the model must not take that for a position. Plant the
    // value an older build stored, then close the (loose, last) tab for real: removeTab() runs
    // shiftIndices(-1, -1), which used to move every other tab down by one.
    await panel.evaluate(async ({ epsilon }) => {
      const st = window.__vt.state;
      window.__afterRemove = null;
      chrome.tabs.onRemoved.addListener((tabId) => {
        if (tabId !== epsilon || window.__afterRemove) return;
        window.__afterRemove = st.order.map((id) => ({ id, index: st.tabs.get(id).index }));
      });
      st.tabs.set(epsilon, { ...st.tabs.get(epsilon), index: -1 });
      await chrome.tabs.remove(epsilon);
    }, { epsilon: ids.epsilon });
    await panel.waitForFunction(() => window.__afterRemove !== null, null, { timeout: 15_000 });

    const after = await panel.evaluate(() => window.__afterRemove);
    expect(
      after.map((t) => t.index),
      'removing a tab whose cached index is -1 renumbered the tabs before it (state.js shiftIndices(-1, -1)); ' +
      'alpha, beta, gamma and delta were at 0, 1, 2, 3',
    ).toEqual([0, 1, 2, 3]);
  });
});

// ── The other operations that reach the same code (TODO 00065db6a78b32ca; Probe 12 in .agent/probe-results.md) ──
//
// PR #15's fix has two layers. state.js ignores a tabs.onUpdated whose tab says index < 0 and shiftIndices() ignores a
// negative `from`; render.js draws a group as ONE row at its first member (A36) and removes a second container. The
// tests above drive one close. These drive the other operations that deliver the same payloads, the same way: a real
// Chrome call from the service worker, a render forced after the panel's own listener at EVERY event it sends, and
// the model and the DOM checked at every step. Each test asserts an event sequence only where Probe 12 measured it
// (5 of 5 runs each, Chromium 151.0.7922.34), as a premise that fails loudly if Chrome stops sending it.
//  * A1 ungroup the middle member, A2 add a loose tab that is not next to the group, A3 move a loose tab into the
//    middle of a group: tabs.onUpdated carries the tab's NEW groupId and NEW index (A1 2, A2 3, A3 1; Probe 12)
//    BEFORE the tabs.onMoved that settles the strip. In A1 and A2 that leaves the model holding the group's members
//    apart at the onUpdated frame (and still at the onMoved frame, 5 of 5); keeping that to one container is
//    render.js's job. In A3 it does not: the model puts the moved tab between beta and gamma and keeps Work adjacent
//    at every step (Probe 12), so no render lands on a split group there. In all three the new index ties with a
//    neighbour's until the resync that follows, so they allow ties and still reject negatives and going backwards.
//    A3 is therefore not a guard for either layer of PR #15 (mutant runs of its first version: green with state.js from
//    before the fix, 0 of 5, and with render.js from before the fix, 0 of 5). What it pins is the model's re-order on a
//    tab update: with the `else if (indexChanged(tab)) reorderFromIndex();` branch of state.js upsertTab deleted it is
//    red 5 of 5 ("indices go backwards along the model's order: ... delta:3 epsilon:1").
//  * A4 a grouped tab leaves for another window (tabs.move, windows.create), A5 a pinned loose tab is closed, A6 a
//    member of a collapsed group is closed from the panel: tabs.onUpdated carries index -1 before tabs.onDetached /
//    tabs.onRemoved, as in a grouped close. For the moves the payload says status 'complete' and the OLD window, so it
//    passes the panel's window filter and a guard written for status 'unloaded' would let it through.
// The final model and DOM are compared with what Chrome holds at the end (tabs.query), not with a shape written from
// memory of what Chrome does.
//
// Not covered: a tab dragged between two real browser windows by the mouse, the header-menu "Close group" of a
// collapsed group (spec 33), closing the window itself (isWindowClosing), a tab that reaches the panel's window from
// another one (the onAttached side), and any Chromium other than the one pinned in tests/Dockerfile.
// Measured by Probe 12 but not driven here: A4 with alpha, the first member AND the active tab (tabs.onActivated
// arrives between onDetached and onAttached); A5 with p1, i.e. any close at index 0; A6 with alpha, the active member
// (Chrome expands the group mid-sequence: tabGroups.onUpdated {collapsed: false}); A6 through chrome.tabs.remove (the
// test closes through the panel's closeTab); the panel's other close paths for a pinned tile (middle click,
// sidepanel.js:741-748; the `.close` branch at :694-699 names .pinned-tile, but the tile markup has no .close button,
// sidepanel.html:283); and the leaving card being gone from the DOM right after onDetached / onRemoved (A4 and A6
// assert the DOM only after a forced resync, not at those frames).
// Every premise below rests on 5 runs per scenario on one Chromium build. A premise is an expect() and not a skip, so
// it fails the test, and a retry (playwright.config.js: retries 1) fails it again: that is intended.

const TIE = 'indices are not strictly increasing';

/**
 * Like installEventProbe, for every event these flows send: a render after the panel's own listener, then the model
 * (with `pinned`) and the DOM (with the pinned tiles and the collapsed groups) as they stand. Names are given for
 * every tab the test creates, so a tab drawn where it must not be shows up by name.
 */
async function installFrameProbe(panel, names) {
  await panel.evaluate((nameOf) => {
    const vt = window.__vt;
    const st = vt.state;
    const name = (id) => nameOf[id] || String(id);
    const frames = (window.__frames = []);
    const cardNames = (root) => [...root.querySelectorAll('[data-testid="tab-card"]')]
      .map((c) => name(Number(c.dataset.tabId)));
    window.__frameDom = () => {
      const list = document.querySelector('#tablist');
      const groups = [...list.querySelectorAll('.group')];
      return {
        groups: groups.map((g) => Number(g.dataset.groupId)),
        cards: [...list.querySelectorAll('[data-testid="tab-card"]')].map((c) => Number(c.dataset.tabId)),
        shape: [...list.children].map((el) => (el.classList.contains('group')
          ? `g${el.dataset.groupId}[${cardNames(el).join(',')}]`
          : `c${name(Number(el.dataset.tabId))}`)),
        collapsed: groups.filter((g) => g.classList.contains('is-collapsed')).map((g) => Number(g.dataset.groupId)),
        pinned: [...document.querySelectorAll('#pinned .pinned-tile')].map((el) => name(Number(el.dataset.tabId))),
      };
    };
    const frame = (ev, tabId, payload) => {
      const model = st.order.map((id) => {
        const t = st.tabs.get(id);
        return { name: name(id), index: t ? t.index : null, groupId: t ? t.groupId : null, pinned: t ? Boolean(t.pinned) : null };
      });
      vt.render.render();
      frames.push({ ev, tab: tabId == null ? null : name(tabId), payload, model, dom: window.__frameDom() });
    };
    chrome.tabs.onUpdated.addListener((tabId, info, tab) => frame('tabs.onUpdated', tabId,
      tab ? { index: tab.index, groupId: tab.groupId, windowId: tab.windowId, status: tab.status } : null));
    chrome.tabs.onRemoved.addListener((tabId, info) => frame('tabs.onRemoved', tabId, { windowId: info.windowId }));
    chrome.tabs.onDetached.addListener((tabId, info) => frame('tabs.onDetached', tabId, { windowId: info.oldWindowId }));
    chrome.tabs.onAttached.addListener((tabId, info) => frame('tabs.onAttached', tabId, { windowId: info.newWindowId }));
    chrome.tabs.onMoved.addListener((tabId, info) => frame('tabs.onMoved', tabId, { windowId: info.windowId }));
    chrome.tabs.onActivated.addListener((info) => frame('tabs.onActivated', info.tabId, { windowId: info.windowId }));
    for (const ev of ['onCreated', 'onUpdated', 'onMoved', 'onRemoved']) {
      chrome.tabGroups[ev].addListener(() => frame(`tabGroups.${ev}`, null, null));
    }
  }, names);
}

const readFrames = (panel) => panel.evaluate(() => window.__frames);

/**
 * Waits for the event the sequence ends with, so the check below never reads a half-delivered operation. The 20 s is
 * what settleAfterClose() uses for the same kind of wait (Chrome's events reaching the panel on a loaded machine).
 */
const waitForFrame = (panel, ev, tab) => expect.poll(
  () => panel.evaluate(([e, t]) => window.__frames.some((f) => f.ev === e && f.tab === t), [ev, tab]),
  { message: `${ev} of ${tab} never reached the panel (Probe 12 measured it in every run)`, timeout: 20_000 },
).toBe(true);

/** Group ids whose members are not next to each other in a frame's model order. */
function splitGroupsIn(model) {
  const closed = new Set();
  const split = new Set();
  let prev = null;
  for (const t of model) {
    if (t.groupId !== prev) {
      if (t.groupId !== -1 && closed.has(t.groupId)) split.add(t.groupId);
      if (prev !== null && prev !== -1) closed.add(prev);
      prev = t.groupId;
    }
  }
  return [...split];
}

/** problemsInFrames() for the three flows whose gap leaves tied indices: ties are allowed, going backwards is not. */
function problemsAllowingTies(frames, opts) {
  const problems = problemsInFrames(frames, opts).filter((p) => !p.includes(TIE));
  for (const f of frames) {
    const indices = f.model.map((t) => t.index);
    if (!indices.every((v, i) => i === 0 || v >= indices[i - 1])) {
      problems.push(`after ${f.ev}${f.tab ? ` of ${f.tab}` : ''}: indices go backwards along the model's order: ` +
        f.model.map((t) => `${t.name}:${t.index}`).join(' '));
    }
  }
  return problems;
}

/**
 * What Chrome holds for the window now, and the DOM shape buildRows() must make of it, by A36's rule: one row per
 * group id, at the group's first member in Chrome's order, a later member of the same group joining that row. This
 * does NOT check that Chrome keeps a group's tabs adjacent; the 0..n-1 assertion in expectPanelMatchesChrome() only
 * checks that Chrome's indices are the plain positions of a gapless strip, which is what the model's indices must
 * equal after a resync.
 */
async function chromeTruth(serviceWorker, windowId, names) {
  const tabs = await swEval(serviceWorker, async (wid) => (await chrome.tabs.query({ windowId: wid }))
    .sort((a, b) => a.index - b.index)
    .map((t) => ({ id: t.id, index: t.index, groupId: t.groupId, pinned: t.pinned })), windowId);
  const name = (id) => names[id] || String(id);
  const shape = [];
  const rows = new Map();
  for (const t of tabs.filter((x) => !x.pinned)) {
    if (t.groupId === -1) shape.push(`c${name(t.id)}`);
    else if (rows.has(t.groupId)) rows.get(t.groupId).push(name(t.id));
    else {
      rows.set(t.groupId, [name(t.id)]);
      shape.push(t.groupId);
    }
  }
  return {
    ids: tabs.map((t) => t.id),
    indices: tabs.map((t) => t.index),
    pinned: tabs.filter((t) => t.pinned).map((t) => name(t.id)),
    shape: shape.map((s) => (typeof s === 'string' ? s : `g${s}[${rows.get(s).join(',')}]`)),
  };
}

/** After the operation and a real resync: the panel's model and DOM are what Chrome holds. */
async function expectPanelMatchesChrome({ harness, serviceWorker }, names, label) {
  const { panel, w2 } = harness;
  const truth = await chromeTruth(serviceWorker, w2, names);
  expect(truth.indices, `${label}: Chrome's own strip is not numbered 0..n-1`).toEqual(truth.ids.map((_, i) => i));
  const seen = await panel.evaluate(() => {
    const st = window.__vt.state;
    return {
      ids: st.order.slice(),
      indices: st.order.map((id) => st.tabs.get(id).index),
      dom: window.__frameDom(),
    };
  });
  expect.soft(seen.ids, `${label}: the model lists the tabs in Chrome's order`).toEqual(truth.ids);
  expect.soft(seen.indices, `${label}: the model's indices are Chrome's own`).toEqual(truth.indices);
  expect.soft(seen.dom.shape, `${label}: the panel draws what Chrome holds`).toEqual(truth.shape);
  expect.soft(seen.dom.pinned, `${label}: the pinned tiles are Chrome's pinned tabs`).toEqual(truth.pinned);
  expectOneEach(seen.dom, label, truth.ids.filter((id) => !names[id] || !truth.pinned.includes(names[id])));
}

test.describe('a group change that Chrome announces before the move that settles it', () => {
  test('ungrouping the MIDDLE member of a group of three leaves one container for the group and the tab loose after it', async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    const { ids, names, work, other } = await buildLayout({ harness, serviceWorker });
    await panel.evaluate(() => window.__dup.settle());
    await installFrameProbe(panel, names);

    await swEval(serviceWorker, (id) => chrome.tabs.ungroup(id), ids.beta);
    await waitForFrame(panel, 'tabs.onMoved', 'beta');
    await panel.evaluate(() => window.__dup.settle());

    const frames = await readFrames(panel);
    const events = frames.map((f) => `${f.ev}${f.tab ? `(${f.tab})` : ''}`).join(' ');
    // The frame that carries the NEW group, not the first onUpdated of the tab: a favicon or title update may land first.
    const apart = frames.find((f) => f.ev === 'tabs.onUpdated' && f.tab === 'beta' && f.payload.groupId === -1);
    expect(
      apart && apart.payload.groupId === -1 && splitGroupsIn(apart.model).includes(work),
      'premise: beta\'s tabs.onUpdated (groupId -1) must reach the panel while beta still sits between alpha and ' +
      `gamma in the model (Probe 12, 5 of 5), or no render lands on a split group; events seen: ${events}`,
    ).toBe(true);

    const problems = problemsAllowingTies(frames, {
      groupOf: { alpha: work, beta: -1, gamma: work, delta: other, epsilon: -1 },
    });
    expect.soft(problems, `ungrouping the middle member corrupted the panel:\n${problems.join('\n')}`).toEqual([]);
    expect.soft(
      apart.dom.shape,
      'with beta ungrouped between its former neighbours the group is ONE row at its first member and beta is ' +
      'drawn after it (A36)',
    ).toEqual([`g${work}[alpha,gamma]`, 'cbeta', `g${other}[delta]`, 'cepsilon']);

    await expectPanelMatchesChrome({ harness, serviceWorker }, names, 'after the ungroup');
    expect.soft(await panel.locator('#tablist .group').count(), 'Work and Other, one container each').toBe(2);
  });

  test('adding a loose tab that is NOT next to a group puts it in the group\'s one container, at its first member', async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    const { ids, names, work, other } = await buildLayout({ harness, serviceWorker });
    await panel.evaluate(() => window.__dup.settle());
    await installFrameProbe(panel, names);

    await swEval(serviceWorker, (a) => chrome.tabs.group({ tabIds: [a.epsilon], groupId: a.work }),
      { epsilon: ids.epsilon, work });
    await waitForFrame(panel, 'tabs.onMoved', 'epsilon');
    await panel.evaluate(() => window.__dup.settle());

    const frames = await readFrames(panel);
    const events = frames.map((f) => `${f.ev}${f.tab ? `(${f.tab})` : ''}`).join(' ');
    // The frame that carries the NEW group, not the first onUpdated of the tab: a favicon or title update may land first.
    const apart = frames.find((f) => f.ev === 'tabs.onUpdated' && f.tab === 'epsilon' && f.payload.groupId === work);
    expect(
      apart && apart.payload.groupId === work && splitGroupsIn(apart.model).includes(work),
      'premise: epsilon\'s tabs.onUpdated (groupId Work) must reach the panel while delta, of another group, still ' +
      `sits between Work and epsilon in the model (Probe 12, 5 of 5); events seen: ${events}`,
    ).toBe(true);

    const problems = problemsAllowingTies(frames, {
      groupOf: { alpha: work, beta: work, gamma: work, delta: other, epsilon: work },
    });
    expect.soft(problems, `adding a loose tab to a group corrupted the panel:\n${problems.join('\n')}`).toEqual([]);
    expect.soft(
      apart.dom.shape,
      'with epsilon in Work but after delta in the model, Work is ONE row at its first member and holds epsilon (A36)',
    ).toEqual([`g${work}[alpha,beta,gamma,epsilon]`, `g${other}[delta]`]);

    await expectPanelMatchesChrome({ harness, serviceWorker }, names, 'after the group');
    expect.soft(await panel.locator('#tablist .group').count(), 'Work and Other, one container each').toBe(2);
  });

  test('moving a loose tab into the MIDDLE of a group makes it a member, in the group\'s one container, where Chrome put it', async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    const { ids, names, work, other } = await buildLayout({ harness, serviceWorker });
    await panel.evaluate(() => window.__dup.settle());
    await installFrameProbe(panel, names);

    await swEval(serviceWorker, (id) => chrome.tabs.move(id, { index: 1 }), ids.epsilon);
    await waitForFrame(panel, 'tabs.onMoved', 'epsilon');
    await panel.evaluate(() => window.__dup.settle());

    const frames = await readFrames(panel);
    const events = frames.map((f) => `${f.ev}${f.tab ? `(${f.tab})` : ''}`).join(' ');
    expect(
      frames.some((f) => f.ev === 'tabs.onUpdated' && f.tab === 'epsilon' && f.payload.groupId === work),
      'premise: Chrome reports the moved tab with groupId Work in its tabs.onUpdated, i.e. a tab moved into the ' +
      `middle of a group joins it (Probe 12, 5 of 5); events seen: ${events}`,
    ).toBe(true);

    const problems = problemsAllowingTies(frames, {
      groupOf: { alpha: work, beta: work, gamma: work, delta: other, epsilon: work },
    });
    expect.soft(problems, `moving a loose tab into a group corrupted the panel:\n${problems.join('\n')}`).toEqual([]);

    await expectPanelMatchesChrome({ harness, serviceWorker }, names, 'after the move');
    expect.soft(await panel.locator('#tablist .group').count(), 'Work and Other, one container each').toBe(2);
  });
});

test.describe('a grouped tab that leaves the window', () => {
  const WAYS = [
    {
      name: 'tabs.move to another window',
      run: (sw, a) => swEval(sw, (x) => chrome.tabs.move(x.id, { windowId: x.windowId, index: -1 }),
        { id: a.beta, windowId: a.w1 }),
    },
    {
      name: 'windows.create({tabId}) into a window of its own',
      run: (sw, a) => swEval(sw, async (x) => { await chrome.windows.create({ tabId: x.id, focused: false }); },
        { id: a.beta }),
    },
  ];
  for (const way of WAYS) {
    test(`the MIDDLE member sent away by ${way.name} leaves the group one container and its neighbours' indices alone`, async ({ harness, serviceWorker }) => {
      const { panel, w1, w2 } = harness;
      const { ids, names, work, other } = await buildLayout({ harness, serviceWorker });
      await panel.evaluate(() => window.__dup.settle());
      await installFrameProbe(panel, names);

      await way.run(serviceWorker, { beta: ids.beta, w1 });
      await waitForFrame(panel, 'tabs.onAttached', 'beta');
      await settleAfterClose({ harness, serviceWorker }, 4);

      const frames = await readFrames(panel);
      const events = frames.map((f) => `${f.ev}${f.tab ? `(${f.tab})` : ''}`).join(' ');
      const leaving = frames.findIndex((f) => f.ev === 'tabs.onUpdated' && f.tab === 'beta' && f.payload.index < 0);
      const detached = frames.findIndex((f) => f.ev === 'tabs.onDetached' && f.tab === 'beta');
      const payload = leaving >= 0 ? frames[leaving].payload : null;
      expect(
        leaving >= 0 && detached > leaving && payload.windowId === w2 && payload.groupId === -1 && payload.status === 'complete',
        'premise: beta\'s tabs.onUpdated {index < 0, groupId -1, status \'complete\'}, still naming the OLD window, must ' +
        'reach the panel before its tabs.onDetached (Probe 12, 5 of 5 for each way; it is the status \'complete\' that a ' +
        `guard written for the close payload, status 'unloaded', would not match); payload seen: ${JSON.stringify(payload)}; ` +
        `events seen: ${events}`,
      ).toBe(true);

      const problems = problemsInFrames(frames, {
        groupOf: { alpha: work, gamma: work, delta: other, epsilon: -1 },
        tabsNeverLoose: ['beta'],
      });
      expect.soft(
        problems,
        `a leaving tab's tabs.onUpdated (index -1, status complete; Probe 12) corrupted the panel model or its rendering:\n${problems.join('\n')}`,
      ).toEqual([]);

      await expectPanelMatchesChrome({ harness, serviceWorker }, names, 'after the tab left');
      expect.soft(await panel.locator('#tablist .group').count(), 'Work and Other, one container each').toBe(2);
    });
  }
});

test.describe('closing a tab that is not an ordinary loose tab', () => {
  test('a PINNED tab closed behind another pinned tab leaves no negative index and the pinned tiles and the list as Chrome has them', async ({ harness, serviceWorker }) => {
    const { panel, w2, urls } = harness;
    const base = await buildLayout({ harness, serviceWorker });
    const p1 = await createTab(serviceWorker, w2, urls.page('00ffff', 'P1'), { active: false });
    const p2 = await createTab(serviceWorker, w2, urls.page('00ff00', 'P2'), { active: false });
    for (const id of [p1, p2]) await swEval(serviceWorker, (tab) => chrome.tabs.update(tab, { pinned: true }), id);
    const names = { ...base.names, [p1]: 'p1', [p2]: 'p2' };
    await expect(panel.locator('#pinned .pinned-tile'), 'the panel shows both pinned tiles').toHaveCount(2, { timeout: 15_000 });
    const before = await chromeTruth(serviceWorker, w2, names);
    expect(before.pinned, 'setup: p1 is pinned first, p2 second, and both are in front').toEqual(['p1', 'p2']);
    expect(before.indices.slice(0, 2), 'setup: p1 and p2 are at indices 0 and 1').toEqual([0, 1]);
    await panel.evaluate(() => window.__dup.settle());
    await installFrameProbe(panel, names);

    await swEval(serviceWorker, (id) => chrome.tabs.remove(id), p2);
    await settleAfterClose({ harness, serviceWorker }, 6);

    const frames = await readFrames(panel);
    const events = frames.map((f) => `${f.ev}${f.tab ? `(${f.tab})` : ''}`).join(' ');
    const closing = frames.findIndex((f) => f.ev === 'tabs.onUpdated' && f.tab === 'p2' && f.payload.index < 0);
    const removed = frames.findIndex((f) => f.ev === 'tabs.onRemoved' && f.tab === 'p2');
    expect(
      closing >= 0 && removed > closing,
      'premise: the closing pinned tab\'s tabs.onUpdated with index < 0 must reach the panel before its ' +
      `tabs.onRemoved (Probe 12, 5 of 5); events seen: ${events}`,
    ).toBe(true);

    const problems = problemsInFrames(frames, {
      groupOf: { alpha: base.work, beta: base.work, gamma: base.work, delta: base.other, epsilon: -1, p1: -1, p2: -1 },
      tabsNeverLoose: ['p1', 'p2'],
    });
    // What each check below can catch: the negative-index, tile and loose-card checks fail as soon as the onUpdated
    // guard in state.js lets index -1 in. This one fails only when that guard has failed AND shiftIndices() then
    // takes the -1 as a position and moves p1 down. shiftIndices(from < 0) on its own is pinned by 'a negative index in
    // the model' above, and the removal of a second container by the stale-twin tests; not by this one.
    const neighbour = frames
      .filter((f) => f.model.some((t) => t.name === 'p1' && t.index !== 0))
      .map((f) => `after ${f.ev} of ${f.tab}: p1 is at ${f.model.find((t) => t.name === 'p1').index}`);
    const tiles = frames
      .map((f, i) => ({ f, i, want: i < removed ? ['p1', 'p2'] : ['p1'] }))
      .filter(({ f, want }) => JSON.stringify(f.dom.pinned) !== JSON.stringify(want))
      .map(({ f, want }) => `after ${f.ev} of ${f.tab}: pinned tiles ${f.dom.pinned.join(',') || 'none'}, expected ${want.join(',')}`);
    expect.soft(problems, `${DEFECT} model or its rendering:\n${problems.join('\n')}`).toEqual([]);
    expect.soft(neighbour, 'the pinned tab in front of the closing one was renumbered').toEqual([]);
    expect.soft(tiles, 'a pinned tile appeared or vanished at the wrong event').toEqual([]);

    await expectPanelMatchesChrome({ harness, serviceWorker }, names, 'after the pinned close');
  });

  test('a member of a COLLAPSED group closed from the panel leaves one container, still collapsed', async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    const { ids, names, work, other } = await buildLayout({ harness, serviceWorker });
    // Chrome collapses a group that holds the active tab and leaves that tab active inside it (Probe 12, first run),
    // and closing that tab opens the group again. Another tab is active first, so the group is hidden for real.
    await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), ids.epsilon);
    await swEval(serviceWorker, (g) => chrome.tabGroups.update(g, { collapsed: true }), work);
    await expect(panel.locator(`#tablist .group[data-group-id="${work}"].is-collapsed`), 'the panel shows Work collapsed')
      .toHaveCount(1, { timeout: 15_000 });
    await panel.evaluate(() => window.__dup.settle());
    await installFrameProbe(panel, names);

    // The panel's own close path: the same function the card's close button and the middle click call.
    await panel.evaluate((id) => window.__vt.closeTab(id), ids.beta);
    await settleAfterClose({ harness, serviceWorker }, 4);

    const frames = await readFrames(panel);
    const events = frames.map((f) => `${f.ev}${f.tab ? `(${f.tab})` : ''}`).join(' ');
    const closing = frames.findIndex((f) => f.ev === 'tabs.onUpdated' && f.tab === 'beta' && f.payload.index < 0);
    const removed = frames.findIndex((f) => f.ev === 'tabs.onRemoved' && f.tab === 'beta');
    expect(
      closing >= 0 && removed > closing,
      'premise: the closing member\'s tabs.onUpdated with index < 0 must reach the panel before its tabs.onRemoved, ' +
      `also when its group is collapsed (Probe 12, 5 of 5); events seen: ${events}`,
    ).toBe(true);

    const problems = problemsInFrames(frames, {
      groupOf: { alpha: work, beta: work, gamma: work, delta: other, epsilon: -1 },
      tabsNeverLoose: ['beta'],
    });
    expect.soft(problems, `${DEFECT} model or its rendering:\n${problems.join('\n')}`).toEqual([]);
    const expanded = frames
      .filter((f) => JSON.stringify(f.dom.collapsed) !== JSON.stringify([work]))
      .map((f) => `after ${f.ev}${f.tab ? ` of ${f.tab}` : ''}: collapsed groups ${f.dom.collapsed.join(',') || 'none'}`);
    expect.soft(expanded, 'Work was drawn expanded at some step although Chrome never expanded it').toEqual([]);

    await expectPanelMatchesChrome({ harness, serviceWorker }, names, 'after the close');
    expect.soft(
      await swEval(serviceWorker, async (g) => (await chrome.tabGroups.get(g)).collapsed, work),
      'Chrome still has Work collapsed (Probe 12, 5 of 5)',
    ).toBe(true);
    expect.soft(await panel.locator('#tablist .group.is-collapsed').count(), 'the panel has exactly one collapsed container').toBe(1);
  });
});
