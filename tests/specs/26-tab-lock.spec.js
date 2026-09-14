// 26-tab-lock — "nothing this panel does will close this tab".
//
// An extension cannot veto `tabs.onRemoved`; by the time it fires the tab is gone. So a
// lock is deliberately a narrow promise about the panel's own close paths, which is
// where the damage happens: close buttons stacked a few pixels apart, "close the other
// tabs", and a duplicate finder that closes several at once. The UI says exactly that
// much and no more.
//
// Everything the panel closes funnels through `ops.remove`, which is what makes one
// check enough.
'use strict';

const { test, expect } = require('../fixtures');
const { swEval, setSettings, createTab, waitForCard } = require('../helpers/chrome');

const MENU = '[data-testid="context-menu"]';

/**
 * A side-panel-sized viewport, for the reason 07-trash-groups.spec.js documents: at the
 * harness's 1280 px a single-column card stands ~509 px tall, the third falls below the
 * fold, and right-clicking it makes Playwright scroll first — which `context-menu.js`
 * deliberately treats as "close the menu". At 400 px all three cards are visible, which
 * is the geometry a real side panel has anyway.
 */
const PANEL_VIEWPORT = Object.freeze({ width: 400, height: 900 });

test.beforeEach(async ({ harness }) => {
  await harness.panel.setViewportSize(PANEL_VIEWPORT);
  await harness.panel.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
});

/**
 * Apply settings and wait until the panel has actually rendered them.
 *
 * `setSettings` returns as soon as storage is written; the panel re-renders when the
 * change event reaches it, and that render dismisses an open context menu. Right-
 * clicking before it lands opens a menu that is closed again a moment later. Waiting on
 * the rendered tool list is the real signal, not a guessed delay.
 */
async function applySettings(panel, sw, settings) {
  await setSettings(sw, settings);
  await expect.poll(
    async () => panel.evaluate(() => [...document.querySelectorAll('[data-widget]')].map((w) => w.dataset.widget)),
    { timeout: 15_000, message: 'the settings change reached the panel' },
  ).toEqual(settings.widgets || []);
}

async function openMenuOn(panel, tabId) {
  await panel.locator(`[data-tab-id="${tabId}"] .thumb`).click({ button: 'right' });
  await expect(panel.locator(MENU)).toBeVisible({ timeout: 10_000 });
}

function exists(sw, tabId) {
  return swEval(sw, async (id) => {
    try {
      await chrome.tabs.get(id);
      return true;
    } catch {
      return false;
    }
  }, tabId);
}

test('a locked tab loses its close button and survives "close tab"', async ({
  harness, serviceWorker,
}) => {
  test.setTimeout(180_000);
  const { panel, tabIds } = harness;
  await applySettings(panel, serviceWorker, { refreshInterval: 'off', widgets: [] });

  const card = panel.locator(`[data-tab-id="${tabIds.beta}"]`);
  await expect(card.locator('.close')).toBeVisible();
  await expect(card.locator('[data-testid="lock-badge"]')).toBeHidden();

  await openMenuOn(panel, tabIds.beta);
  await panel.locator(`${MENU} [data-testid="menu-item-lock"]`).click();

  await expect(card).toHaveClass(/is-locked/, { timeout: 10_000 });
  await expect(card.locator('[data-testid="lock-badge"]')).toBeVisible();
  await expect(card.locator('.close'), 'a button that does nothing reads as a bug').toBeHidden();

  // The menu can still ask; the choke point is what refuses.
  await openMenuOn(panel, tabIds.beta);
  await panel.locator(`${MENU} [data-testid="menu-item-close"]`).click();
  await expect(panel.locator('#toast')).toBeVisible({ timeout: 10_000 });
  expect(await exists(serviceWorker, tabIds.beta), 'the tab is still open').toBe(true);

  // Unlocking gives the tab back to every ordinary path.
  await openMenuOn(panel, tabIds.beta);
  await panel.locator(`${MENU} [data-testid="menu-item-lock"]`).click();
  await expect(card).not.toHaveClass(/is-locked/, { timeout: 10_000 });
  await expect(card.locator('.close')).toBeVisible();

  await card.locator('.close').click();
  await expect.poll(async () => exists(serviceWorker, tabIds.beta), { timeout: 15_000 }).toBe(false);
});

test('closing many tabs closes the unlocked ones and keeps the rest', async ({
  harness, serviceWorker,
}) => {
  test.setTimeout(180_000);
  const { panel, tabIds } = harness;
  await applySettings(panel, serviceWorker, { refreshInterval: 'off', widgets: [] });

  await openMenuOn(panel, tabIds.alpha);
  await panel.locator(`${MENU} [data-testid="menu-item-lock"]`).click();
  await expect(panel.locator(`[data-tab-id="${tabIds.alpha}"]`)).toHaveClass(/is-locked/, { timeout: 10_000 });

  // "Close the other tabs" from gamma asks for alpha and beta at once.
  await openMenuOn(panel, tabIds.gamma);
  await panel.locator(`${MENU} [data-testid="menu-item-close-others"]`).click();

  await expect.poll(async () => exists(serviceWorker, tabIds.beta), { timeout: 20_000 })
    .toBe(false);
  expect(await exists(serviceWorker, tabIds.alpha), 'the locked one is kept, not the request refused').toBe(true);
  expect(await exists(serviceWorker, tabIds.gamma)).toBe(true);
});

test('the duplicate finder keeps a locked copy', async ({
  harness, serviceWorker, fixtures,
}) => {
  test.setTimeout(180_000);
  const { panel, w2, tabIds } = harness;
  await applySettings(panel, serviceWorker, { refreshInterval: 'off', widgets: ['duplicates'] });

  // A second tab on alpha's URL: the finder would close the newer one.
  const copy = await createTab(serviceWorker, w2, fixtures.alpha, { active: false });
  await waitForCard(panel, copy);

  await openMenuOn(panel, copy);
  await panel.locator(`${MENU} [data-testid="menu-item-lock"]`).click();
  await expect(panel.locator(`[data-tab-id="${copy}"]`)).toHaveClass(/is-locked/, { timeout: 10_000 });

  await panel.locator('[data-testid="widget-duplicates-close"]').click();

  // The finder routes through the same choke point, so the lock holds there too.
  await expect.poll(async () => exists(serviceWorker, copy), { timeout: 20_000 }).toBe(true);
  expect(await exists(serviceWorker, tabIds.alpha), 'the original was never a candidate').toBe(true);
});
