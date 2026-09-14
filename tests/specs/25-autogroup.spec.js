// 25-autogroup — one tab group per site, and taking it back.
//
// Chrome has had tab groups since 2020 and has never had a way to fill one: every group
// is made by hand, which is why a browser with eighty tabs usually has none. The tool
// uses the hostname the panel already draws, and remembers exactly which tabs it touched
// so that undo puts those back rather than ungrouping whatever is grouped now.
'use strict';

const { test, expect } = require('../fixtures');
const { swEval, setSettings, waitForTabsComplete } = require('../helpers/chrome');

/** groupId per tab, straight from Chrome. */
function groupsOf(sw, tabIds) {
  return swEval(sw, async (ids) => {
    const out = {};
    for (const id of ids) {
      const t = await chrome.tabs.get(id).catch(() => null);
      out[id] = t ? t.groupId : 'gone';
    }
    return out;
  }, tabIds);
}

test('one group per site, named after the site, and undo puts the tabs back', async ({
  harness, serviceWorker,
}) => {
  test.setTimeout(180_000);
  const { panel, tabIds } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off', widgets: ['autoGroup'] });

  const ids = [tabIds.alpha, tabIds.beta, tabIds.gamma];
  const before = await groupsOf(serviceWorker, ids);
  for (const id of ids) expect(before[id], 'the fixtures start ungrouped').toBe(-1);

  const summary = panel.locator('[data-testid="widget-autogroup-summary"]');
  const run = panel.locator('[data-testid="widget-autogroup-run"]');
  const undo = panel.locator('[data-testid="widget-autogroup-undo"]');

  // All three fixtures are served from one host, so they are one group.
  await expect(summary).toContainText('3');
  await expect(run).toBeVisible();
  await expect(undo, 'nothing to undo before a run').toBeHidden();

  await run.click();

  await expect.poll(async () => {
    const g = await groupsOf(serviceWorker, ids);
    const values = [...new Set(Object.values(g))];
    return values.length === 1 && values[0] !== -1 ? 'one-group' : JSON.stringify(g);
  }, { timeout: 20_000 }).toBe('one-group');

  const after = await groupsOf(serviceWorker, ids);
  const groupId = after[ids[0]];
  const group = await swEval(serviceWorker, async (id) => {
    const g = await chrome.tabGroups.get(id);
    return { title: g.title, color: g.color };
  }, groupId);
  expect(group.title, 'the host is the reason these tabs are together').toContain('127.0.0.1');
  expect(group.color, 'a group Chrome will actually render').toBeTruthy();

  await expect(undo).toBeVisible();
  await undo.click();
  await expect.poll(async () => {
    const g = await groupsOf(serviceWorker, ids);
    return [...new Set(Object.values(g))];
  }, { timeout: 20_000 }).toEqual([-1]);
});

test('tabs that are already grouped, and pinned tabs, are left alone', async ({
  harness, serviceWorker,
}) => {
  test.setTimeout(180_000);
  const { panel, tabIds } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off', widgets: ['autoGroup'] });

  // Put alpha in a group by hand and pin beta: neither is a loose tab any more, which
  // leaves gamma alone on its host — and one tab is not a group.
  const handMade = await swEval(serviceWorker, async (id) => {
    const g = await chrome.tabs.group({ tabIds: [id] });
    await chrome.tabGroups.update(g, { title: 'by hand' });
    return g;
  }, tabIds.alpha);
  await swEval(serviceWorker, async (id) => { await chrome.tabs.update(id, { pinned: true }); }, tabIds.beta);

  const summary = panel.locator('[data-testid="widget-autogroup-summary"]');
  await expect.poll(async () => summary.textContent(), { timeout: 15_000 })
    .toMatch(/^(?!.*\d)/); // the "nothing to group" message carries no count
  await expect(panel.locator('[data-testid="widget-autogroup-run"]')).toBeHidden();

  const still = await swEval(serviceWorker, async (a) => {
    const alpha = await chrome.tabs.get(a.alpha);
    const beta = await chrome.tabs.get(a.beta);
    const g = await chrome.tabGroups.get(a.handMade);
    return { alphaGroup: alpha.groupId, betaPinned: beta.pinned, title: g.title };
  }, { alpha: tabIds.alpha, beta: tabIds.beta, handMade });
  expect(still.alphaGroup, 'a hand-made group is not re-made').toBe(handMade);
  expect(still.betaPinned, 'a pinned tab stays pinned and ungrouped').toBe(true);
  expect(still.title).toBe('by hand');
});
