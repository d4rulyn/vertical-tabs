// 24-cross-window-search — finding a tab that is in a different window.
//
// The panel's list is one window by construction: its model is `tabs.query({windowId})`,
// and the filter is a DOM operation on top of what that model rendered. So searching
// could only ever find tabs in the window the reader is standing in, which is the wrong
// answer to "where did I leave that page". `#other-windows` asks Chrome for every tab
// while a search is running and lists the matches that live elsewhere.
//
// Those tabs stay OUT of the model on purpose: drag-and-drop, the keyboard map and the
// differential renderer all assume one window.
'use strict';

const { test, expect } = require('../fixtures');
const { swEval, setSettings, waitForTabsComplete, sleep } = require('../helpers/chrome');

const RESULTS = '[data-testid="other-window-result"]';

async function search(panel, text) {
  await panel.locator('#search-input').fill(text);
}

test('a match in another window is listed, and going to it focuses that window', async ({
  harness, serviceWorker, fixtures,
}) => {
  test.setTimeout(180_000);
  const { panel, w2 } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off', widgets: [] });

  const third = await swEval(serviceWorker, async (url) => {
    const w = await chrome.windows.create({ url, focused: false, width: 900, height: 700 });
    return { windowId: w.id, tabId: (w.tabs || [])[0].id };
  }, fixtures.delta);
  await waitForTabsComplete(serviceWorker, [third.tabId]);

  const section = panel.locator('#other-windows');
  await expect(section, 'nothing is listed before a search').toBeHidden();

  await search(panel, 'delta');
  await expect(section).toBeVisible();
  await expect(panel.locator(RESULTS)).toHaveCount(1);
  await expect(panel.locator(RESULTS).first()).toContainText('Delta');

  await panel.locator(RESULTS).first().click();
  await expect.poll(async () => swEval(serviceWorker, async (a) => {
    const w = await chrome.windows.get(a.windowId);
    const [active] = await chrome.tabs.query({ active: true, windowId: a.windowId });
    return { focused: w.focused, activeId: active ? active.id : null };
  }, third), { timeout: 15_000 }).toEqual({ focused: true, activeId: third.tabId });
});

test('tabs in this window stay in the list and are not repeated below it', async ({
  harness, serviceWorker,
}) => {
  test.setTimeout(180_000);
  const { panel } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off', widgets: [] });

  await search(panel, 'alpha');
  // The in-window match is the panel's own job and is still handled by the filter.
  await expect(panel.locator('.tab-card:not(.is-hidden)')).toHaveCount(1);
  // Give a cross-window query time to land before asserting it found nothing.
  await sleep(1500);
  await expect(panel.locator('#other-windows'), 'this window is not "another window"').toBeHidden();
});

test('the panel does not list its own documents', async ({ harness, serviceWorker }) => {
  test.setTimeout(180_000);
  const { panel } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off', widgets: [] });

  // The panel page itself lives in W1 — a different window from the one this panel is
  // scoped to — so without the filter it would match its own URL.
  await search(panel, 'sidepanel');
  await sleep(1500);
  await expect(panel.locator(RESULTS)).toHaveCount(0);
});

test('clearing the search takes the section away again', async ({
  harness, serviceWorker, fixtures,
}) => {
  test.setTimeout(180_000);
  const { panel } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off', widgets: [] });

  const third = await swEval(serviceWorker, async (url) => {
    const w = await chrome.windows.create({ url, focused: false, width: 900, height: 700 });
    return { windowId: w.id, tabId: (w.tabs || [])[0].id };
  }, fixtures.delta);
  await waitForTabsComplete(serviceWorker, [third.tabId]);

  await search(panel, 'delta');
  await expect(panel.locator('#other-windows')).toBeVisible();

  await panel.locator('#search-input').fill('');
  await expect(panel.locator('#other-windows')).toBeHidden();
});
