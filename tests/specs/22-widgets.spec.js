// 22-widgets — the rail beside the tab list.
//
// Chrome will not let the side panel be narrower than 360 px, so a single column of
// tabs leaves most of that width idle. The rail spends it on widgets the user picks.
// Everything here works from data the extension already holds: no widget reaches the
// network, which is what keeps the README's "no network requests at all" true.
'use strict';

const { test, expect } = require('../fixtures');
const { swEval, setSettings, createTab, sleep } = require('../helpers/chrome');

const ALL = Object.freeze(['sessions', 'recent', 'windows', 'autoGroup', 'duplicates', 'staleTabs', 'listIO', 'nowPlaying', 'scratchpad']);

function railState(panel) {
  return panel.evaluate(() => {
    const rail = document.getElementById('widget-rail');
    return {
      hidden: rail.hidden,
      widgets: [...rail.querySelectorAll('[data-widget]')].map((w) => w.dataset.widget),
      railWidth: Math.round(rail.getBoundingClientRect().width),
      listWidth: Math.round(document.getElementById('tablist').getBoundingClientRect().width),
      overflows: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
}

test('widgets appear, reorder and disappear with the setting', async ({ harness, serviceWorker }) => {
  test.setTimeout(180_000);
  const { panel } = harness;
  await panel.setViewportSize({ width: 360, height: 720 });
  await setSettings(serviceWorker, { refreshInterval: 'off', cardWidth: 160, widgets: [] });

  await expect.poll(async () => (await railState(panel)).hidden, { timeout: 10_000 }).toBe(true);
  const noRail = await railState(panel);
  expect(noRail.railWidth, 'an empty rail takes no width').toBe(0);

  await setSettings(serviceWorker, { widgets: ALL });
  await expect.poll(async () => (await railState(panel)).widgets, { timeout: 10_000 }).toEqual(ALL);

  const shown = await railState(panel);
  expect(shown.hidden).toBe(false);
  expect(shown.railWidth, 'the rail takes real width').toBeGreaterThan(120);
  expect(shown.listWidth, 'and the tab list keeps the rest').toBeGreaterThan(120);
  expect(shown.overflows, 'the panel never scrolls sideways').toBe(false);

  // Each tool rendered something from local data.
  await expect(panel.locator('[data-testid="widget-sessions-empty"]')).toBeVisible();
  await expect(panel.locator('[data-testid="widget-duplicates-summary"]')).not.toBeEmpty();

  // A subset, in the order the list gives.
  await setSettings(serviceWorker, { widgets: ['nowPlaying', 'sessions'] });
  await expect.poll(async () => (await railState(panel)).widgets, { timeout: 10_000 })
    .toEqual(['nowPlaying', 'sessions']);
  await expect(panel.locator('[data-testid="widget-duplicates"]')).toHaveCount(0);

  // An id this build does not know is dropped rather than breaking the rail.
  await setSettings(serviceWorker, { widgets: ['sessions', 'fromTheFuture'] });
  await expect.poll(async () => (await railState(panel)).widgets, { timeout: 10_000 })
    .toEqual(['sessions']);

  await setSettings(serviceWorker, { widgets: [] });
  await expect.poll(async () => (await railState(panel)).hidden, { timeout: 10_000 }).toBe(true);
});

test('every tool mounts, and none of them touches the network', async ({
  harness, serviceWorker,
}) => {
  test.setTimeout(180_000);
  const { panel } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });

  /* This is the assertion the README's privacy wording rests on. A weather and a
   * calendar tool were built here and removed precisely because they would have made
   * "no network requests at all" false; this keeps that from creeping back in. */
  const requests = [];
  const onRequest = (req) => {
    // Only real egress counts. The panel's own document, its `blob:` preview URLs and
    // `data:` favicons never leave the machine.
    const url = req.url();
    if (/^https?:/i.test(url)) requests.push(url);
  };
  panel.on('request', onRequest);

  await setSettings(serviceWorker, { refreshInterval: 'off', widgets: ALL });
  await expect.poll(async () => (await railState(panel)).widgets, { timeout: 15_000 }).toEqual(ALL);

  // Each widget put something on screen rather than mounting empty.
  await expect(panel.locator('[data-testid="widget-sessions-empty"]')).toBeVisible();
  await expect(panel.locator('[data-testid="widget-duplicates-summary"]')).not.toBeEmpty();
  await expect(panel.locator('[data-testid="widget-stale-summary"]')).not.toBeEmpty();
  await expect(panel.locator('[data-testid="widget-scratchpad-text"]')).toBeVisible();

  await sleep(2000);
  panel.off('request', onRequest);
  expect(requests, `the panel must not fetch: ${requests.join(', ')}`).toEqual([]);
});

// `data-tab-id` means "this element IS the card for that tab". Three tools list tabs of
// their own, and one of them carried the same attribute on its rows: every
// `[data-tab-id="…"]` lookup in the panel and in the specs then matched two nodes, which
// broke rendering, events and drag-and-drop tests at once. The attribute has exactly one
// owner, and this is the assertion that says so.
test('no tool impersonates a tab card', async ({ harness, serviceWorker }) => {
  test.setTimeout(180_000);
  const { panel } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off', widgets: ALL });
  await expect.poll(async () => (await railState(panel)).widgets, { timeout: 15_000 }).toEqual(ALL);

  const counts = await panel.evaluate(() => ({
    withAttribute: document.querySelectorAll('[data-tab-id]').length,
    cardsAndTiles: document.querySelectorAll('.tab-card, .pinned-tile').length,
    offenders: [...document.querySelectorAll('[data-tab-id]')]
      .filter((el) => !el.matches('.tab-card, .pinned-tile'))
      .map((el) => el.className || el.tagName),
  }));
  expect(counts.offenders, 'only cards and pinned tiles carry data-tab-id').toEqual([]);
  expect(counts.withAttribute).toBe(counts.cardsAndTiles);
});

test('saved sets round-trip through storage', async ({ harness, serviceWorker }) => {
  test.setTimeout(180_000);
  const { panel } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });
  await setSettings(serviceWorker, { refreshInterval: 'off', widgets: ['sessions'] });

  await expect(panel.locator('[data-testid="widget-sessions-empty"]')).toBeVisible();
  await panel.locator('[data-testid="widget-sessions-save"]').click();

  const saved = panel.locator('[data-testid="widget-sessions-restore"]');
  await expect(saved).toHaveCount(1, { timeout: 10_000 });
  // The harness window holds three fixture pages.
  await expect(saved).toContainText('3');

  // It is a real record, not just a row: the store holds the urls.
  const stored = await swEval(serviceWorker, async () => {
    const s = await chrome.storage.local.get('sessions');
    return (s.sessions || []).map((x) => x.tabs.length);
  });
  expect(stored).toEqual([3]);

  await panel.locator('[data-testid="widget-sessions-delete"]').click();
  await expect(saved).toHaveCount(0, { timeout: 10_000 });
});

test('the duplicates widget finds and closes extra copies', async ({
  harness, serviceWorker, fixtures,
}) => {
  test.setTimeout(180_000);
  const { panel, w2 } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });
  await setSettings(serviceWorker, { refreshInterval: 'off', widgets: ['duplicates'] });

  const summary = panel.locator('[data-testid="widget-duplicates-summary"]');
  const button = panel.locator('[data-testid="widget-duplicates-close"]');
  await expect(button).toBeHidden();

  // Two more copies of a page already open.
  const url = fixtures.page('ff0000', 'Alpha');
  await createTab(serviceWorker, w2, url, { active: false });
  await createTab(serviceWorker, w2, url, { active: false });
  await expect(button).toBeVisible({ timeout: 15_000 });
  await expect(summary).toContainText('2');

  const before = (await swEval(serviceWorker, (w) => chrome.tabs.query({ windowId: w }), w2)).length;
  await button.click();
  await expect.poll(async () =>
    (await swEval(serviceWorker, (w) => chrome.tabs.query({ windowId: w }), w2)).length,
  { timeout: 15_000 }).toBe(before - 2);

  // The oldest copy is the one kept: it is the tab whose history the user built up.
  const urls = await swEval(serviceWorker, (w) =>
    chrome.tabs.query({ windowId: w }).then((tabs) => tabs.map((t) => t.url)), w2);
  expect(urls.filter((u) => u === url)).toHaveLength(1);
  await expect(button).toBeHidden();
});

test('the playing widget lists audible tabs and can mute them', async ({
  harness, serviceWorker, fixtures,
}) => {
  test.setTimeout(180_000);
  const { panel, w2 } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off', widgets: ['nowPlaying'] });

  await expect(panel.locator('[data-testid="widget-now-playing-empty"]')).toBeVisible();

  // `audible` cannot be forced from a test, so mute a tab: a muted tab is one the
  // widget must still list, which is the same code path.
  const tabId = await createTab(serviceWorker, w2, fixtures.page('123456', 'Loud'), { active: false });
  await swEval(serviceWorker, (id) => chrome.tabs.update(id, { muted: true }), tabId);
  await sleep(1500);

  const rows = panel.locator('[data-testid="widget-now-playing-list"] .w-np__row');
  await expect(rows).toHaveCount(1, { timeout: 15_000 });
  await expect(panel.locator('[data-testid="widget-now-playing-empty"]')).toBeHidden();

  // Unmuting from the widget reaches Chrome.
  await panel.locator('[data-testid="widget-now-playing-mute"]').first().click();
  await expect.poll(() => swEval(serviceWorker,
    (id) => chrome.tabs.get(id).then((t) => t.mutedInfo.muted), tabId),
  { timeout: 10_000 }).toBe(false);
});
