// 10-showcase — produces the screenshots referenced by README.md / README.ja.md.
// Copy them into docs/screenshots/ after a run.
//
// The lead image must show the DEFAULT the user gets on a fresh profile, which is
// now a single column, so these drive `columns` rather than the retired `layout`
// enum. Shipping a two-column lead image while the default is one column is how the
// docs went stale the last time the default moved.
'use strict';

const { test, expect } = require('../fixtures');
const {
  swEval, createTab, keyOf, waitForThumb, setSettings, shot,
} = require('../helpers/chrome');

test('renders a full panel with pinned tabs, a group and previews', async ({ harness, serviceWorker, fixtures }) => {
  test.setTimeout(240_000);
  const { panel, w2, tabIds, urls } = harness;

  await setSettings(serviceWorker, { refreshInterval: 'off', theme: 'dark', columns: 1 });
  await panel.setViewportSize({ width: 380, height: 900 });

  const docsUrl = fixtures.page('7a3cff', 'Docs');
  const mailUrl = fixtures.page('ff9436', 'Mail');
  const pinUrl = fixtures.page('00b3b3', 'Dashboard');

  const docsId = await createTab(serviceWorker, w2, docsUrl, { active: false });
  const mailId = await createTab(serviceWorker, w2, mailUrl, { active: false });
  const pinId = await createTab(serviceWorker, w2, pinUrl, { active: false });

  const groupId = await swEval(serviceWorker, async (a) => {
    const gid = await chrome.tabs.group({ tabIds: [a.docsId, a.mailId], createProperties: { windowId: a.wid } });
    await chrome.tabGroups.update(gid, { title: 'Work', color: 'blue' });
    return gid;
  }, { docsId, mailId, wid: w2 });
  expect(groupId).toBeGreaterThan(-1);

  await swEval(serviceWorker, (id) => chrome.tabs.update(id, { pinned: true }), pinId);
  await expect(panel.locator('#pinned')).toBeVisible({ timeout: 10_000 });
  await expect(panel.locator(`[data-testid="group"][data-group-id="${groupId}"]`)).toHaveCount(1);

  // Capture a preview for every tab, one activation at a time (~1 capture/second).
  const plan = [
    { id: pinId, url: pinUrl },
    { id: docsId, url: docsUrl },
    { id: mailId, url: mailUrl },
    { id: tabIds.gamma, url: urls.gamma },
    { id: tabIds.beta, url: urls.beta },
    { id: tabIds.alpha, url: urls.alpha },
  ];
  for (const step of plan) {
    const key = await keyOf(panel, step.url);
    await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), step.id);
    await waitForThumb(panel, key, { timeout: 45_000 });
  }
  // The pinned tab renders as an icon tile without a thumbnail, so five cards carry one.
  await expect(panel.locator('.thumb--loaded')).toHaveCount(5, { timeout: 20_000 });

  await shot(panel, '10-showcase-dark.png');

  await setSettings(serviceWorker, { theme: 'light' });
  await expect(panel.locator('html')).toHaveAttribute('data-theme', 'light', { timeout: 10_000 });
  await panel.waitForTimeout(300);
  await shot(panel, '10-showcase-light.png');

  await setSettings(serviceWorker, { theme: 'dark', columns: 2 });
  await expect(panel.locator('html')).toHaveAttribute('data-columns', '2', { timeout: 10_000 });
  await panel.waitForTimeout(300);
  await shot(panel, '10-showcase-list.png');

  await setSettings(serviceWorker, { columns: 3 });
  await panel.setViewportSize({ width: 560, height: 900 });
  await expect(panel.locator('html')).toHaveAttribute('data-columns', '3', { timeout: 10_000 });
  await panel.waitForTimeout(300);
  await shot(panel, '10-showcase-grid.png');
});
