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
