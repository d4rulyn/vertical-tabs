// 02-render — one card per tab of the scoped window, in tab-strip order, with the
// active tab marked. This is user requirement #1.
'use strict';

const { test, expect } = require('../fixtures');
const { swEval, queryTabs, cardOrder, shot } = require('../helpers/chrome');

test('the panel renders exactly one card per tab, in order, with the active one marked',
  async ({ harness, serviceWorker }) => {
    const { panel, w2, tabIds } = harness;

    const cards = panel.locator('[data-testid="tab-card"]');
    await expect(cards).toHaveCount(3);

    // Titles follow the tab strip order of W2.
    await expect(panel.locator('[data-testid="tab-card"] .title')).toHaveText(['Alpha', 'Beta', 'Gamma']);

    // DOM order equals chrome.tabs.query order.
    const tabs = await queryTabs(serviceWorker, w2);
    expect(await cardOrder(panel)).toEqual(tabs.map((t) => t.id));

    // Every card carries the documented data attributes.
    const attrs = await panel.$$eval('[data-testid="tab-card"]', (els) => els.map((el) => ({
      tabId: el.getAttribute('data-tab-id'),
      urlKey: el.getAttribute('data-url-key'),
      index: el.getAttribute('data-index'),
      status: el.getAttribute('data-status'),
      role: el.getAttribute('role'),
      ariaSelected: el.getAttribute('aria-selected'),
      favicon: (el.querySelector('.favicon') || {}).currentSrc || (el.querySelector('.favicon') || {}).src || '',
    })));
    for (const a of attrs) {
      expect(Number(a.tabId)).toBeGreaterThan(0);
      expect(a.urlKey).toBeTruthy();
      expect(a.index).not.toBeNull();
      expect(a.role).toBe('option');
      // aria-selected is written on every render, never omitted (addendum A15).
      expect(['true', 'false']).toContain(a.ariaSelected);
      expect(a.favicon.length).toBeGreaterThan(0);
    }
    expect(attrs.filter((a) => a.ariaSelected === 'true').length).toBeGreaterThanOrEqual(1);

    // The active card matches chrome's own idea of the active tab.
    const activeId = (await swEval(serviceWorker, async (wid) =>
      (await chrome.tabs.query({ active: true, windowId: wid }))[0].id, w2));
    await expect(panel.locator(`[data-tab-id="${activeId}"]`)).toHaveClass(/is-active/);
    await expect(panel.locator('.tab-card.is-active')).toHaveCount(1);

    // …and follows an activation made outside the panel.
    await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), tabIds.beta);
    await expect(panel.locator(`[data-tab-id="${tabIds.beta}"]`)).toHaveClass(/is-active/, { timeout: 5000 });
    await expect(panel.locator(`[data-tab-id="${tabIds.alpha}"]`)).not.toHaveClass(/is-active/);
    await expect(panel.locator(`[data-tab-id="${tabIds.beta}"]`)).toHaveAttribute('aria-selected', 'true');

    // Dark theme resolves from prefers-color-scheme (the context is colorScheme:'dark').
    await expect(panel.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(panel.locator('html')).toHaveAttribute('data-thumbs', 'on');

    await shot(panel, '02-list-dark.png');
  });

test('the panel never lists its own document', async ({ harness, serviceWorker }) => {
  const { panel, w2 } = harness;
  // Open a second copy of the panel document inside W2 itself.
  await swEval(serviceWorker, async (wid) => {
    await chrome.tabs.create({
      windowId: wid, active: false,
      url: chrome.runtime.getURL('sidepanel/sidepanel.html?windowId=' + wid),
    });
  }, w2);

  await expect.poll(async () => (await queryTabs(serviceWorker, w2)).length, { timeout: 15_000 }).toBe(4);
  // The extra tab is one of our own panel documents, so it is excluded from the model.
  await expect(panel.locator('[data-testid="tab-card"]')).toHaveCount(3);
});
