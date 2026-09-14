// 28-palette — everything the panel can do, by name.
//
// The panel has a right-click menu, a settings drawer, a trash popover, a tools column
// and a dozen shortcuts. The palette is one key and a few letters instead of
// remembering which of those a thing lives in. Nothing in it is new capability: every
// entry runs a path that already existed, which is what makes the list honest.
//
// Ctrl+K is NOT the key: it focuses the search box and has since the first release.
'use strict';

const { test, expect } = require('../fixtures');
const { swEval, setSettings, sleep } = require('../helpers/chrome');

const PANEL_VIEWPORT = Object.freeze({ width: 400, height: 900 });

test.beforeEach(async ({ harness }) => {
  await harness.panel.setViewportSize(PANEL_VIEWPORT);
});

async function openPalette(panel) {
  await panel.locator('#tablist').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await panel.keyboard.press('Control+Shift+P');
  await expect(panel.locator('#palette')).toBeVisible({ timeout: 10_000 });
}

test('the palette opens, filters, and runs the command that is chosen', async ({
  harness, serviceWorker,
}) => {
  test.setTimeout(180_000);
  const { panel, w2 } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off', widgets: [] });

  await expect(panel.locator('#palette')).toBeHidden();
  await openPalette(panel);

  const rows = panel.locator('[data-testid="palette-row"]');
  const all = await rows.count();
  expect(all, 'the palette lists what the panel can do').toBeGreaterThan(5);

  // Typing narrows it; the match is on the label, so it follows the UI language.
  await panel.locator('[data-testid="palette-input"]').fill('duplicate');
  await expect.poll(async () => rows.count(), { timeout: 5000 }).toBe(1);
  await expect(rows.first()).toHaveAttribute('data-cmd', 'duplicate');

  const before = await swEval(serviceWorker, async (id) => (await chrome.tabs.query({ windowId: id })).length, w2);
  await panel.keyboard.press('Enter');

  await expect(panel.locator('#palette'), 'a command is a one-shot').toBeHidden();
  await expect.poll(
    async () => swEval(serviceWorker, async (id) => (await chrome.tabs.query({ windowId: id })).length, w2),
    { timeout: 15_000 },
  ).toBe(before + 1);
});

test('a query that matches nothing says so instead of showing a stale list', async ({
  harness, serviceWorker,
}) => {
  test.setTimeout(180_000);
  const { panel } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off', widgets: [] });

  await openPalette(panel);
  await panel.locator('[data-testid="palette-input"]').fill('zzzz no such command');
  await expect(panel.locator('[data-testid="palette-empty"]')).toBeVisible();
  await expect(panel.locator('[data-testid="palette-row"]')).toHaveCount(0);

  await panel.keyboard.press('Escape');
  await expect(panel.locator('#palette')).toBeHidden();
});

test('Ctrl+K still focuses the search box, as it always has', async ({
  harness, serviceWorker,
}) => {
  test.setTimeout(180_000);
  const { panel } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off', widgets: [] });

  await panel.locator('#tablist').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await panel.keyboard.press('Control+k');
  await expect(panel.locator('#palette'), 'the palette did not steal the shortcut').toBeHidden();
  expect(await panel.evaluate(() => document.activeElement && document.activeElement.id)).toBe('search-input');
});

test('the palette reflects the state of the tab it will act on', async ({
  harness, serviceWorker,
}) => {
  test.setTimeout(180_000);
  const { panel, tabIds } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off', widgets: [] });

  // Lock the active tab through the palette, then reopen it: the same entry must now
  // offer the opposite, because a palette that lies about state is worse than no palette.
  await swEval(serviceWorker, async (id) => { await chrome.tabs.update(id, { active: true }); }, tabIds.gamma);
  await sleep(500);

  await openPalette(panel);
  await panel.locator('[data-testid="palette-input"]').fill('lock');
  await expect(panel.locator('[data-cmd="lock"]')).toHaveCount(1);
  const lockLabel = await panel.locator('[data-cmd="lock"]').textContent();
  await panel.keyboard.press('Enter');

  await expect(panel.locator(`[data-tab-id="${tabIds.gamma}"]`)).toHaveClass(/is-locked/, { timeout: 10_000 });

  await openPalette(panel);
  await panel.locator('[data-testid="palette-input"]').fill('lock');
  await expect(panel.locator('[data-cmd="lock"]')).toHaveCount(1);
  const unlockLabel = await panel.locator('[data-cmd="lock"]').textContent();
  expect(unlockLabel, 'the entry now offers the opposite').not.toBe(lockLabel);
});
