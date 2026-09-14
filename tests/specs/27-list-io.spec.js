// 27-list-io — getting a window's tabs out as text, and a list of links back in.
//
// The string work itself is unit-tested (tests/unit/tab-list-text.test.mjs); what needs
// a browser is the other half: that a paste of links really does become tabs, in a
// window of their own rather than dumped into the one someone is working in.
'use strict';

const { test, expect } = require('../fixtures');
const { swEval, setSettings, sleep } = require('../helpers/chrome');

test('a pasted list of links opens as tabs in a new window', async ({
  harness, serviceWorker, fixtures,
}) => {
  test.setTimeout(180_000);
  const { panel, w2 } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off', widgets: ['listIO'] });

  const box = panel.locator('[data-testid="widget-listio-input"]');
  const open = panel.locator('[data-testid="widget-listio-open"]');
  await expect(box).toBeVisible();
  await expect(open, 'nothing to open until there is something to open').toBeDisabled();

  const before = await swEval(serviceWorker, async () => (await chrome.windows.getAll()).map((w) => w.id));

  // Prose around the links, and one duplicate: the box takes what it is given.
  await box.fill(`Have a look at ${fixtures.alpha} and ${fixtures.beta}.\nAgain: ${fixtures.alpha}`);
  await expect(open).toBeEnabled();
  await open.click();

  const made = await expect.poll(async () => swEval(serviceWorker, async (known) => {
    const all = await chrome.windows.getAll({ populate: true });
    const fresh = all.filter((w) => !known.includes(w.id));
    return fresh.length === 1 ? (fresh[0].tabs || []).map((t) => t.pendingUrl || t.url) : null;
  }, before), { timeout: 20_000 }).not.toBeNull();

  const urls = await swEval(serviceWorker, async (known) => {
    const all = await chrome.windows.getAll({ populate: true });
    const fresh = all.filter((w) => !known.includes(w.id));
    return (fresh[0].tabs || []).map((t) => t.pendingUrl || t.url);
  }, before);
  expect(urls, 'the duplicate was opened once').toHaveLength(2);

  // The window the panel drives was not touched.
  const here = await swEval(serviceWorker, async (id) => (await chrome.tabs.query({ windowId: id })).length, w2);
  expect(here, 'links do not land in the window someone is working in').toBe(3);

  await expect(box, 'the box empties once its links are open').toHaveValue('');
});

test('text with no links leaves the button alone', async ({ harness, serviceWorker }) => {
  test.setTimeout(180_000);
  const { panel } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off', widgets: ['listIO'] });

  const box = panel.locator('[data-testid="widget-listio-input"]');
  await box.fill('chrome://settings and some prose, but nothing anyone can open');
  await sleep(300);
  await expect(panel.locator('[data-testid="widget-listio-open"]')).toBeDisabled();
});
