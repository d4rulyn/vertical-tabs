// 94-spec35-event-sequences-probe — Probe 12 in .agent/probe-results.md: which events Chrome sends, and in what
// order, for the three flows the review of PR #15 named and spec 35 did not cover.
//
//   A4  a grouped tab leaves its window: chrome.tabs.move({windowId}) and chrome.windows.create({tabId})
//   A5  a PINNED loose tab is closed
//   A6  a member of a COLLAPSED group is closed (chrome.tabs.remove, and the panel's own closeTab)
//
// Nothing here asserts a Chrome behaviour. A listener registered in the panel page AFTER the panel's own listeners
// logs every tabs.* / tabGroups.* event with its payload and the panel model right after the panel's handler ran,
// then renders once (so the DOM is read at every step, as spec 35's event probe does). One JSON line per run goes
// to $OUT_DIR/spec35-event-probe.jsonl and a one-line summary of each event goes to the console.
//
// Run (probes live outside testDir):
//   HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose -f tests/docker-compose.yml \
//     run --rm e2e env VT_TEST_DIR=./probes playwright test 94-spec35-event-sequences-probe.spec.js \
//     --reporter=line --retries=0 --repeat-each=5
'use strict';

const fs = require('fs');
const path = require('path');
const { test, expect } = require('../fixtures');
const { swEval, setSettings, createTab } = require('../helpers/chrome');

const OUT = process.env.OUT_DIR || path.resolve(__dirname, '../output');
const REPORT = path.join(OUT, 'spec35-event-probe.jsonl');
const PANEL_VIEWPORT = Object.freeze({ width: 400, height: 1500 });

test.beforeEach(async ({ harness, serviceWorker }) => {
  await harness.panel.setViewportSize(PANEL_VIEWPORT);
  await setSettings(serviceWorker, { refreshInterval: 'off' });
});

/** alpha beta gamma = Work; delta = Other; epsilon loose; with `pinned`, two pinned loose tabs p1 p2 in front. */
async function buildLayout({ harness, serviceWorker }, { pinned = false } = {}) {
  const { w2, tabIds, urls } = harness;
  const delta = await createTab(serviceWorker, w2, urls.delta, { active: false });
  const epsilon = await createTab(serviceWorker, w2, urls.page('ffff00', 'Epsilon'), { active: false });
  const ids = { alpha: tabIds.alpha, beta: tabIds.beta, gamma: tabIds.gamma, delta, epsilon };
  if (pinned) {
    for (const name of ['p1', 'p2']) {
      ids[name] = await createTab(serviceWorker, w2, urls.page('00ffff', name), { active: false });
      await swEval(serviceWorker, (id) => chrome.tabs.update(id, { pinned: true }), ids[name]);
    }
  }
  const groups = await swEval(serviceWorker, async (a) => {
    const work = await chrome.tabs.group({ tabIds: [a.alpha, a.beta, a.gamma], createProperties: { windowId: a.windowId } });
    await chrome.tabGroups.update(work, { title: 'Work', color: 'blue' });
    const other = await chrome.tabs.group({ tabIds: [a.delta], createProperties: { windowId: a.windowId } });
    await chrome.tabGroups.update(other, { title: 'Other', color: 'red' });
    return { work, other };
  }, { ...ids, windowId: w2 });
  return { ids, ...groups };
}

async function installRecorder(harness, ids, groups) {
  const { panel, w1, w2 } = harness;
  const names = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
  const gnames = { [groups.work]: 'Work', [groups.other]: 'Other' };
  await panel.evaluate(({ names: nameOf, gnames: groupName, w1: win1, w2: win2 }) => {
    const vt = window.__vt;
    const st = vt.state;
    const t0 = performance.now();
    const nm = (id) => nameOf[id] || `#${id}`;
    const win = (id) => (id === win1 ? 'W1' : id === win2 ? 'W2' : id == null ? null : `W?${id}`);
    const grp = (id) => (id === -1 ? -1 : groupName[id] || `g${id}`);
    const events = (window.__events = []);
    const model = () => st.order.map((id) => {
      const t = st.tabs.get(id);
      return `${nm(id)}:${t ? t.index : '?'}${t && t.groupId !== -1 ? `/${grp(t.groupId)}` : ''}${t && t.pinned ? 'P' : ''}`;
    }).join(' ');
    const cards = (root) => [...root.querySelectorAll('[data-testid="tab-card"]')].map((c) => nm(Number(c.dataset.tabId)));
    const dom = () => {
      const list = document.querySelector('#tablist');
      const pin = [...document.querySelectorAll('#pinned .pinned-tile')].map((c) => nm(Number(c.dataset.tabId)));
      const shape = [...list.children].map((el) => (el.classList.contains('group')
        ? `g${grp(Number(el.dataset.groupId))}${el.classList.contains('is-collapsed') ? '(collapsed)' : ''}[${cards(el).join(',')}]`
        : `c${nm(Number(el.dataset.tabId))}`));
      return `pinned[${pin.join(',')}] ${shape.join(' ')}`;
    };
    const frame = (ev, detail) => {
      const at = +(performance.now() - t0).toFixed(1);
      const m = model();
      vt.render.render();
      events.push({ at, ev, ...detail, model: m, dom: dom() });
    };
    chrome.tabs.onUpdated.addListener((id, info, tab) => frame('tabs.onUpdated', {
      tab: nm(id), info, payload: { index: tab.index, groupId: grp(tab.groupId), windowId: win(tab.windowId), status: tab.status, pinned: tab.pinned },
    }));
    chrome.tabs.onRemoved.addListener((id, info) => frame('tabs.onRemoved', {
      tab: nm(id), info: { windowId: win(info.windowId), isWindowClosing: info.isWindowClosing },
    }));
    chrome.tabs.onDetached.addListener((id, info) => frame('tabs.onDetached', {
      tab: nm(id), info: { oldWindowId: win(info.oldWindowId), oldPosition: info.oldPosition },
    }));
    chrome.tabs.onAttached.addListener((id, info) => frame('tabs.onAttached', {
      tab: nm(id), info: { newWindowId: win(info.newWindowId), newPosition: info.newPosition },
    }));
    chrome.tabs.onMoved.addListener((id, info) => frame('tabs.onMoved', {
      tab: nm(id), info: { windowId: win(info.windowId), from: info.fromIndex, to: info.toIndex },
    }));
    chrome.tabs.onActivated.addListener((info) => frame('tabs.onActivated', { tab: nm(info.tabId), info: { windowId: win(info.windowId) } }));
    chrome.tabGroups.onUpdated.addListener((g) => frame('tabGroups.onUpdated', { group: grp(g.id), info: { collapsed: g.collapsed, windowId: win(g.windowId) } }));
    chrome.tabGroups.onRemoved.addListener((g) => frame('tabGroups.onRemoved', { group: grp(g.id), info: { windowId: win(g.windowId) } }));
    chrome.tabGroups.onCreated.addListener((g) => frame('tabGroups.onCreated', { group: grp(g.id), info: { windowId: win(g.windowId) } }));
    chrome.tabGroups.onMoved.addListener((g) => frame('tabGroups.onMoved', { group: grp(g.id), info: { windowId: win(g.windowId) } }));
    window.__probeDom = dom;
    window.__probeModel = model;
  }, { names, gnames, w1, w2 });
}

async function settleAndRead(harness, serviceWorker, label, before, tabsLeft) {
  const { panel, w2 } = harness;
  // The tail of an event stream (favicon, title, a trailing resync) arrives for a few hundred ms.
  await expect.poll(
    () => swEval(serviceWorker, async (wid) => (await chrome.tabs.query({ windowId: wid })).length, w2),
    { timeout: 20_000 },
  ).toBe(tabsLeft);
  await panel.evaluate(() => window.__vt.stateModule.resync());
  await panel.waitForTimeout(1500);
  await panel.evaluate(() => window.__vt.stateModule.resync());
  const out = await panel.evaluate(() => ({ events: window.__events, modelEnd: window.__probeModel(), domEnd: window.__probeDom() }));
  const lines = out.events.map((e, i) => {
    const gap = i ? ` +${(e.at - out.events[i - 1].at).toFixed(1)}ms` : '';
    return `  ${e.ev}(${e.tab || e.group}) ${JSON.stringify(e.payload || e.info)}${gap}\n      model: ${e.model}\n      dom:   ${e.dom}`;
  });
  console.log(`PROBE12 ${label}\n  before: ${before.model}\n          ${before.dom}\n${lines.join('\n')}\n  end model: ${out.modelEnd}\n  end dom:   ${out.domEnd}`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.appendFileSync(REPORT, `${JSON.stringify({ label, before, ...out })}\n`);
  return out;
}

const readBefore = (panel) => panel.evaluate(() => ({ model: window.__probeModel(), dom: window.__probeDom() }));

test.describe('Probe 12: event sequences', () => {
  for (const [label, who] of [['A4 tabs.move(beta -> W1)', 'beta'], ['A4 tabs.move(alpha -> W1)', 'alpha']]) {
    test(label, async ({ harness, serviceWorker }) => {
      const { panel, w1 } = harness;
      const { ids, ...groups } = await buildLayout({ harness, serviceWorker });
      await expect(panel.locator('#tablist [data-testid="tab-card"]')).toHaveCount(5, { timeout: 15_000 });
      await installRecorder(harness, ids, groups);
      const before = await readBefore(panel);
      await swEval(serviceWorker, (a) => chrome.tabs.move(a.id, { windowId: a.w1, index: -1 }), { id: ids[who], w1 });
      await settleAndRead(harness, serviceWorker, label, before, 4);
    });
  }

  test('A4 windows.create({tabId: beta})', async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    const { ids, ...groups } = await buildLayout({ harness, serviceWorker });
    await expect(panel.locator('#tablist [data-testid="tab-card"]')).toHaveCount(5, { timeout: 15_000 });
    await installRecorder(harness, ids, groups);
    const before = await readBefore(panel);
    await swEval(serviceWorker, async (id) => { await chrome.windows.create({ tabId: id, focused: false }); }, ids.beta);
    await settleAndRead(harness, serviceWorker, 'A4 windows.create({tabId: beta})', before, 4);
  });

  // A1-A3 are not about a closing tab, but about the order in which Chrome announces a group change and the move
  // that makes the group contiguous again; the same recorder shows whether a split model is ever rendered.
  for (const [label, kind] of [
    ['A1 tabs.ungroup(beta), the MIDDLE member of Work', 'ungroup'],
    ['A2 tabs.group({tabIds: [epsilon], groupId: Work}), epsilon loose and not adjacent', 'group'],
    ['A3 tabs.move(epsilon, {index: 1}), into the middle of Work', 'move'],
  ]) {
    test(label, async ({ harness, serviceWorker }) => {
      const { panel } = harness;
      const { ids, ...groups } = await buildLayout({ harness, serviceWorker });
      await expect(panel.locator('#tablist [data-testid="tab-card"]')).toHaveCount(5, { timeout: 15_000 });
      await installRecorder(harness, ids, groups);
      const before = await readBefore(panel);
      await swEval(serviceWorker, async (a) => {
        if (a.kind === 'ungroup') await chrome.tabs.ungroup(a.ids.beta);
        else if (a.kind === 'group') await chrome.tabs.group({ tabIds: [a.ids.epsilon], groupId: a.work });
        else await chrome.tabs.move(a.ids.epsilon, { index: 1 });
      }, { kind, ids, work: groups.work });
      await settleAndRead(harness, serviceWorker, label, before, 5);
    });
  }

  for (const [label, who] of [['A5 close p2 (second pinned, index 1)', 'p2'], ['A5 close p1 (first pinned, index 0)', 'p1']]) {
    test(label, async ({ harness, serviceWorker }) => {
      const { panel } = harness;
      const { ids, ...groups } = await buildLayout({ harness, serviceWorker }, { pinned: true });
      await expect(panel.locator('#tablist [data-testid="tab-card"]')).toHaveCount(5, { timeout: 15_000 });
      await expect(panel.locator('#pinned .pinned-tile')).toHaveCount(2, { timeout: 15_000 });
      await installRecorder(harness, ids, groups);
      const before = await readBefore(panel);
      await swEval(serviceWorker, (id) => chrome.tabs.remove(id), ids[who]);
      await settleAndRead(harness, serviceWorker, label, before, 6);
    });
  }

  for (const [label, who, via] of [
    ['A6 collapsed Work, chrome.tabs.remove(beta)', 'beta', 'sw'],
    ['A6 collapsed Work, panel closeTab(beta)', 'beta', 'panel'],
    ['A6 collapsed Work, chrome.tabs.remove(alpha)', 'alpha', 'sw'],
  ]) {
    test(label, async ({ harness, serviceWorker }) => {
      const { panel } = harness;
      const { ids, ...groups } = await buildLayout({ harness, serviceWorker });
      await expect(panel.locator('#tablist [data-testid="tab-card"]')).toHaveCount(5, { timeout: 15_000 });
      // Chrome lets the API collapse a group that holds the active tab and leaves that tab active (first run of this
      // probe: alpha stayed active inside the collapsed Work), so the group is only really hidden once another tab is.
      await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), ids.epsilon);
      await swEval(serviceWorker, (g) => chrome.tabGroups.update(g, { collapsed: true }), groups.work);
      await expect(panel.locator(`.group[data-group-id="${groups.work}"].is-collapsed`)).toHaveCount(1, { timeout: 15_000 });
      await panel.evaluate(() => window.__vt.stateModule.resync());
      await installRecorder(harness, ids, groups);
      const before = await readBefore(panel);
      const active = await swEval(serviceWorker, async (wid) => (await chrome.tabs.query({ windowId: wid, active: true })).map((t) => t.id), harness.w2);
      console.log(`PROBE12 ${label}: active tab(s) before: ${active.map((a) => Object.entries(ids).find(([, v]) => v === a)?.[0] || a).join(',')}`);
      if (via === 'sw') await swEval(serviceWorker, (id) => chrome.tabs.remove(id), ids[who]);
      else await panel.evaluate((id) => window.__vt.closeTab(id), ids[who]);
      await settleAndRead(harness, serviceWorker, label, before, 4);
      const after = await swEval(serviceWorker, async (g) => (await chrome.tabGroups.get(g)).collapsed, groups.work);
      console.log(`PROBE12 ${label}: Chrome says Work collapsed=${after} afterwards`);
    });
  }
});
