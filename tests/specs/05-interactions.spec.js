// 05-interactions — the pointer and keyboard contract of the panel.
'use strict';

const { test, expect } = require('../fixtures');
const { swEval, queryTabs, cardOrder } = require('../helpers/chrome');

async function activeTabId(sw, windowId) {
  return swEval(sw, async (wid) => {
    const t = (await chrome.tabs.query({ active: true, windowId: wid }))[0];
    return t ? t.id : null;
  }, windowId);
}

test('clicking a card activates that tab; the new-tab button opens one', async ({ harness, serviceWorker }) => {
  const { panel, w2, tabIds } = harness;

  await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), tabIds.alpha);
  await expect(panel.locator(`[data-tab-id="${tabIds.alpha}"]`)).toHaveClass(/is-active/, { timeout: 10_000 });

  await panel.locator(`[data-tab-id="${tabIds.gamma}"] .thumb`).click();
  await expect.poll(() => activeTabId(serviceWorker, w2), { timeout: 15_000 }).toBe(tabIds.gamma);
  await expect(panel.locator(`[data-tab-id="${tabIds.gamma}"]`)).toHaveClass(/is-active/);

  // ── new tab (left click → foreground, middle click → background)
  const before = (await queryTabs(serviceWorker, w2)).length;
  await panel.locator('[data-testid="new-tab-button"]').click();
  await expect.poll(async () => (await queryTabs(serviceWorker, w2)).length, { timeout: 15_000 })
    .toBe(before + 1);
  let tabs = await queryTabs(serviceWorker, w2);
  const created = tabs[tabs.length - 1];
  expect(created.active).toBe(true);

  await panel.locator('[data-testid="new-tab-button"]').click({ button: 'middle' });
  await expect.poll(async () => (await queryTabs(serviceWorker, w2)).length, { timeout: 15_000 })
    .toBe(before + 2);
  tabs = await queryTabs(serviceWorker, w2);
  expect(tabs.filter((t) => t.active)).toHaveLength(1);
  expect(tabs[tabs.length - 1].active).toBe(false);
});

test('the close button and middle click close tabs', async ({ harness, serviceWorker }) => {
  const { panel, w2, tabIds } = harness;

  // ── close button
  await panel.locator(`[data-tab-id="${tabIds.beta}"] [data-testid="close-button"]`).click();
  await expect(panel.locator(`[data-tab-id="${tabIds.beta}"]`)).toHaveCount(0, { timeout: 10_000 });
  let ids = (await queryTabs(serviceWorker, w2)).map((t) => t.id);
  expect(ids).not.toContain(tabIds.beta);
  expect(ids).toHaveLength(2);

  // ── middle click (settings.middleClickCloses defaults to true)
  await panel.locator(`[data-tab-id="${tabIds.gamma}"] .thumb`).click({ button: 'middle' });
  await expect(panel.locator(`[data-tab-id="${tabIds.gamma}"]`)).toHaveCount(0, { timeout: 10_000 });
  ids = (await queryTabs(serviceWorker, w2)).map((t) => t.id);
  expect(ids).toEqual([tabIds.alpha]);
  await expect(panel.locator('[data-testid="tab-card"]')).toHaveCount(1);
});

test('search filters the list and Enter activates the first match', async ({ harness, serviceWorker }) => {
  const { panel, w2, tabIds } = harness;

  await panel.locator('#search-input').fill('bet');
  await expect(panel.locator('[data-testid="tab-card"]:visible')).toHaveCount(1, { timeout: 10_000 });
  await expect(panel.locator(`[data-tab-id="${tabIds.beta}"]`)).toBeVisible();
  await expect(panel.locator(`[data-tab-id="${tabIds.alpha}"]`)).toBeHidden();
  await expect(panel.locator('#search-count')).toBeVisible();
  await expect(panel.locator('#search-count')).toHaveText('1 of 3 tabs');

  await panel.locator('#search-input').press('Enter');
  await expect.poll(() => activeTabId(serviceWorker, w2), { timeout: 15_000 }).toBe(tabIds.beta);

  await panel.locator('#search-input').press('Escape');
  await expect(panel.locator('[data-testid="tab-card"]:visible')).toHaveCount(3, { timeout: 10_000 });
  await expect(panel.locator('#search-count')).toBeHidden();

  // Nothing matches → the empty-state element appears.
  await panel.locator('#search-input').fill('zzzz-no-such-tab');
  await expect(panel.locator('#search-empty')).toBeVisible({ timeout: 10_000 });
  await expect(panel.locator('[data-testid="tab-card"]:visible')).toHaveCount(0);
  await panel.locator('#search-clear').click();
  await expect(panel.locator('[data-testid="tab-card"]:visible')).toHaveCount(3, { timeout: 10_000 });
});

test('keyboard: arrows move the roving focus, Enter activates, Delete closes',
  async ({ harness, serviceWorker }) => {
    const { panel, w2, tabIds } = harness;

    await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), tabIds.alpha);
    await expect(panel.locator(`[data-tab-id="${tabIds.alpha}"]`)).toHaveClass(/is-active/, { timeout: 10_000 });

    const order = await cardOrder(panel);
    expect(order).toEqual([tabIds.alpha, tabIds.beta, tabIds.gamma]);

    await panel.locator(`[data-tab-id="${tabIds.alpha}"]`).focus();
    await panel.keyboard.press('ArrowDown');
    await panel.keyboard.press('ArrowDown');
    await expect.poll(
      () => panel.evaluate(() => {
        const el = document.activeElement && document.activeElement.closest('[data-testid="tab-card"]');
        return el ? Number(el.getAttribute('data-tab-id')) : null;
      }),
      { timeout: 10_000 },
    ).toBe(tabIds.gamma);

    await panel.keyboard.press('Enter');
    await expect.poll(() => activeTabId(serviceWorker, w2), { timeout: 15_000 }).toBe(tabIds.gamma);

    await panel.keyboard.press('Delete');
    await expect(panel.locator(`[data-tab-id="${tabIds.gamma}"]`)).toHaveCount(0, { timeout: 10_000 });
    expect((await queryTabs(serviceWorker, w2)).map((t) => t.id)).not.toContain(tabIds.gamma);

    // Focus must survive the removal (addendum A15).
    const focusedTag = await panel.evaluate(() => document.activeElement && document.activeElement.tagName);
    expect(focusedTag).not.toBe('BODY');
  });
