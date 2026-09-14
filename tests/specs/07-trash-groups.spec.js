// 07-trash-groups — the closed-tabs trash, the in-DOM context menu and tab groups.
'use strict';

const { test, expect } = require('../fixtures');
const { swEval, queryTabs, keyOf, waitForThumb, setSettings } = require('../helpers/chrome');

/**
 * A side-panel-sized viewport for every test in this file.
 *
 * The default harness viewport is 1280 px wide, which no side panel ever is. With the
 * default single column (`DEFAULTS.columns`) a card spans the full content box and
 * stands ~509 px tall, so the third card falls below the fold. Right-clicking it then
 * makes Playwright scroll it into view first, and `context-menu.js` deliberately
 * closes the menu on a `#tablist` scroll — so the menu opened and shut again before it
 * could be asserted. At 400 px the cards are ~178 px tall and all three are visible,
 * which is the geometry a real panel has.
 */
const PANEL_VIEWPORT = Object.freeze({ width: 400, height: 900 });

test.beforeEach(async ({ harness }) => {
  await harness.panel.setViewportSize(PANEL_VIEWPORT);
  await harness.panel.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
});

test('a closed tab can be reopened from the trash and keeps its preview',
  async ({ harness, serviceWorker }) => {
    test.setTimeout(150_000);
    const { panel, w2, tabIds, urls } = harness;
    await setSettings(serviceWorker, { refreshInterval: 'off' });

    // Capture Beta first so the restored tab has something to show.
    const betaKey = await keyOf(panel, urls.beta);
    await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), tabIds.beta);
    await waitForThumb(panel, betaKey, { timeout: 40_000 });

    await swEval(serviceWorker, (id) => chrome.tabs.remove(id), tabIds.beta);
    await expect(panel.locator(`[data-tab-id="${tabIds.beta}"]`)).toHaveCount(0, { timeout: 10_000 });

    await panel.locator('[data-testid="trash-button"]').click();
    const popover = panel.locator('[data-testid="trash-popover"]');
    await expect(popover).toBeVisible({ timeout: 10_000 });
    await expect(popover).toContainText('Beta', { timeout: 10_000 });

    await popover.getByText('Beta', { exact: false }).first().click();

    const restored = await (async () => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const t = (await queryTabs(serviceWorker, w2)).find((x) => x.url === urls.beta);
        if (t) return t;
        if (Date.now() > deadline) throw new Error('the closed tab was never restored');
        await panel.waitForTimeout(300);
      }
    })();

    await panel.waitForSelector(`[data-tab-id="${restored.id}"]`, { timeout: 15_000 });
    // Thumbnails are keyed by URL, so the restored tab shows its old preview at once.
    await expect(panel.locator(`[data-tab-id="${restored.id}"] .thumb`))
      .toHaveClass(/thumb--loaded/, { timeout: 15_000 });
  });

test('the card context menu offers the documented items', async ({ harness }) => {
  const { panel, tabIds } = harness;

  await panel.locator(`[data-tab-id="${tabIds.alpha}"] .thumb`).click({ button: 'right' });
  const menu = panel.locator('[data-testid="context-menu"]');
  await expect(menu).toBeVisible({ timeout: 10_000 });

  for (const id of ['new-tab-after', 'reload', 'duplicate', 'pin', 'refresh-preview', 'group-new', 'close']) {
    await expect(menu.locator(`[data-testid="menu-item-${id}"]`)).toHaveCount(1);
  }
  // Refresh preview is only meaningful for the active tab.
  await expect(menu.locator('[data-testid="menu-item-refresh-preview"]')).toBeVisible();

  await panel.keyboard.press('Escape');
  await expect(menu).toBeHidden({ timeout: 10_000 });

  // The same menu on an inactive tab disables "refresh preview".
  await panel.locator(`[data-tab-id="${tabIds.gamma}"] .thumb`).click({ button: 'right' });
  await expect(menu).toBeVisible({ timeout: 10_000 });
  const disabled = await menu.locator('[data-testid="menu-item-refresh-preview"]').evaluate((el) =>
    el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' ||
    el.classList.contains('is-disabled'));
  expect(disabled).toBe(true);
  await panel.keyboard.press('Escape');
});

test('tabs can be grouped, collapsed and renamed from the panel', async ({ harness, serviceWorker }) => {
  const { panel, w2, tabIds } = harness;

  await panel.locator(`[data-tab-id="${tabIds.alpha}"] .thumb`).click({ button: 'right' });
  await expect(panel.locator('[data-testid="context-menu"]')).toBeVisible({ timeout: 10_000 });
  await panel.locator('[data-testid="menu-item-group-new"]').click();

  const header = panel.locator('[data-testid="group-header"]');
  await expect(header).toHaveCount(1, { timeout: 15_000 });
  await expect(header.locator('.group-swatch')).toHaveCount(1);

  const groupId = Number(await panel.locator('[data-testid="group"]').first().getAttribute('data-group-id'));
  expect(groupId).toBeGreaterThan(-1);
  const grouped = (await queryTabs(serviceWorker, w2)).find((t) => t.id === tabIds.alpha);
  expect(grouped.groupId).toBe(groupId);

  // ── collapse
  await header.locator('.group-title').click();
  await expect.poll(
    () => swEval(serviceWorker, (gid) => chrome.tabGroups.get(gid).then((g) => g.collapsed), groupId),
    { timeout: 15_000 },
  ).toBe(true);
  await expect(panel.locator(`[data-testid="group"][data-group-id="${groupId}"] [data-tab-id="${tabIds.alpha}"]`))
    .toBeHidden({ timeout: 10_000 });

  // ── expand again, then rename in place
  await header.locator('.group-title').click();
  await expect.poll(
    () => swEval(serviceWorker, (gid) => chrome.tabGroups.get(gid).then((g) => g.collapsed), groupId),
    { timeout: 15_000 },
  ).toBe(false);

  await header.locator('.group-title').dblclick();
  const input = header.locator('input');
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill('Reading');
  await input.press('Enter');

  await expect.poll(
    () => swEval(serviceWorker, (gid) => chrome.tabGroups.get(gid).then((g) => g.title), groupId),
    { timeout: 15_000 },
  ).toBe('Reading');
});
