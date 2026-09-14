// 03-events — every chrome.tabs / chrome.tabGroups event the panel listens to is
// reflected in the DOM without a reload.
'use strict';

const { test, expect, chromium, launchArgs } = require('../fixtures');
const { setupTwoWindows } = require('../helpers/windows');
const { swEval, createTab, queryTabs, cardOrder, keyOf, waitForCard } = require('../helpers/chrome');

test('created / removed / moved / updated tabs patch the list', async ({ harness, serviceWorker, fixtures }) => {
  const { panel, w2, tabIds } = harness;

  // ── created inactive → unread dot (tracked by the service worker, addendum A13)
  const deltaId = await createTab(serviceWorker, w2, fixtures.delta, { active: false });
  await waitForCard(panel, deltaId);
  await expect(panel.locator(`[data-tab-id="${deltaId}"]`)).toHaveClass(/is-unread/, { timeout: 10_000 });
  // The dot itself is aria-hidden, so screen readers need the visually hidden label.
  await expect(panel.locator(`[data-tab-id="${deltaId}"] .sr-only`).first()).toBeAttached();
  await expect(panel.locator('[data-testid="tab-card"]')).toHaveCount(4);

  // Activating it clears the dot.
  await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), deltaId);
  await expect(panel.locator(`[data-tab-id="${deltaId}"]`)).not.toHaveClass(/is-unread/, { timeout: 10_000 });

  // ── navigation updates the title and the url key
  const beforeKey = await panel.getAttribute(`[data-tab-id="${tabIds.gamma}"]`, 'data-url-key');
  const nextUrl = fixtures.page('00ffff', 'Renamed');
  await swEval(serviceWorker, (a) => chrome.tabs.update(a.id, { url: a.url }), { id: tabIds.gamma, url: nextUrl });
  await expect(panel.locator(`[data-tab-id="${tabIds.gamma}"] .title`)).toHaveText('Renamed', { timeout: 15_000 });
  const afterKey = await panel.getAttribute(`[data-tab-id="${tabIds.gamma}"]`, 'data-url-key');
  expect(afterKey).not.toBe(beforeKey);
  expect(afterKey).toBe(await keyOf(panel, nextUrl));

  // ── moved → DOM order follows chrome's index order
  await swEval(serviceWorker, (id) => chrome.tabs.move(id, { index: 0 }), tabIds.gamma);
  await expect.poll(async () => (await cardOrder(panel))[0], { timeout: 10_000 }).toBe(tabIds.gamma);
  const tabs = await queryTabs(serviceWorker, w2);
  expect(await cardOrder(panel)).toEqual(tabs.map((t) => t.id));

  // ── removed → card gone
  await swEval(serviceWorker, (id) => chrome.tabs.remove(id), deltaId);
  await expect(panel.locator(`[data-tab-id="${deltaId}"]`)).toHaveCount(0, { timeout: 10_000 });
  await expect(panel.locator('[data-testid="tab-card"]')).toHaveCount(3);
});

test('pinned, muted and loading states are rendered', async ({ harness, serviceWorker, fixtures }) => {
  const { panel, w2, tabIds } = harness;

  // ── pinned → moves into the pinned grid
  await swEval(serviceWorker, (id) => chrome.tabs.update(id, { pinned: true }), tabIds.alpha);
  await expect(panel.locator(`#pinned [data-testid="pinned-tile"][data-tab-id="${tabIds.alpha}"]`))
    .toHaveCount(1, { timeout: 10_000 });
  await expect(panel.locator('#pinned')).toBeVisible();
  await expect(panel.locator(`#tablist [data-tab-id="${tabIds.alpha}"]`)).toHaveCount(0);

  await swEval(serviceWorker, (id) => chrome.tabs.update(id, { pinned: false }), tabIds.alpha);
  await expect(panel.locator(`#tablist [data-tab-id="${tabIds.alpha}"]`)).toHaveCount(1, { timeout: 10_000 });

  // ── muted
  await swEval(serviceWorker, (id) => chrome.tabs.update(id, { muted: true }), tabIds.beta);
  await expect(panel.locator(`[data-tab-id="${tabIds.beta}"]`)).toHaveClass(/is-muted/, { timeout: 10_000 });
  await swEval(serviceWorker, (id) => chrome.tabs.update(id, { muted: false }), tabIds.beta);
  await expect(panel.locator(`[data-tab-id="${tabIds.beta}"]`)).not.toHaveClass(/is-muted/, { timeout: 10_000 });

  // ── slow navigation → is-loading, then cleared.
  //
  // The four seconds this fixture withholds its response are four seconds in which
  // chrome.tabs.query() answers `status:'loading'` (+ pendingUrl) but NO
  // tabs.onUpdated is delivered: measured on Chromium 151, the first event of a
  // navigation is `{status:'loading', url}` at COMMIT, with `{status:'complete'}`
  // ~8 ms behind it. The panel closes that gap itself (state.js, "Pending-navigation
  // watch"), which is what makes the spinner of spec §9.1 visible at all — so this
  // assertion is the regression guard for that watch, not a race against 8 ms.
  const slow = fixtures.slow(4000, 'SlowPage');
  await swEval(serviceWorker, (a) => chrome.tabs.update(a.id, { url: a.url }),
    { id: tabIds.gamma, url: slow });
  await expect(panel.locator(`[data-tab-id="${tabIds.gamma}"]`)).toHaveClass(/is-loading/, { timeout: 10_000 });
  await expect(panel.locator(`[data-tab-id="${tabIds.gamma}"]`)).toHaveAttribute('data-status', 'loading');
  await expect(panel.locator(`[data-tab-id="${tabIds.gamma}"]`)).not.toHaveClass(/is-loading/, { timeout: 30_000 });
  await expect(panel.locator(`[data-tab-id="${tabIds.gamma}"]`)).toHaveAttribute('data-status', 'complete');
});

// This one owns its browser instead of using the shared `harness` fixture, because
// chrome.tabs.discard() cannot be called under Playwright's viewport emulation.
//
// Measured (Chromium 151.0.7922.34, this repo's Playwright image) — 19 crashes in 19
// runs across 8 configurations, and none once `viewport` was dropped:
// discard() destroys the tab's WebContents and puts a rendererless placeholder in its
// place. Playwright auto-attaches to that new target and, whenever a `viewport` is
// configured, applies Emulation.setDeviceMetricsOverride to it — Chromium then
// dereferences the placeholder's absent RenderWidgetHostView and the BROWSER PROCESS
// dies with SIGSEGV ~2.5 s later ("Received signal 11 SEGV_MAPERR 000000000000", with
// the configured viewport visible in the crash registers). It is the emulation, not
// the discard: the crash reproduces with a do-nothing extension (no listeners, no
// captureVisibleTab, no panel) and with every discard variant tried — focused and
// unfocused windows, minimised windows, 1280x800 and 400x300 windows, about:blank and
// still-loading tabs, discard(id) and no-arg discard(). It disappears, and only
// disappears, with `viewport: null`, which is what this context launches with.
test('a hibernated tab is dimmed', async ({ fixtures }) => {
  test.setTimeout(120_000);

  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    colorScheme: 'dark',
    locale: 'en-US',
    viewport: null, // see above: any viewport override makes tabs.discard() fatal
    args: launchArgs(),
  });

  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
    const { panel, w2, tabIds } = await setupTwoWindows(context, sw, fixtures);

    // Never the active tab: chrome.tabs.discard rejects for it.
    await swEval(sw, (id) => chrome.tabs.update(id, { active: true }), tabIds.alpha);
    await expect(panel.locator(`[data-tab-id="${tabIds.alpha}"]`)).toHaveClass(/is-active/, { timeout: 10_000 });

    const discardedUrl = (await queryTabs(sw, w2)).find((t) => t.id === tabIds.gamma).url;
    await swEval(sw, (id) => chrome.tabs.discard(id), tabIds.gamma);

    // chrome.tabs.discard may hand back a NEW tab id, so re-resolve by URL.
    let newId = null;
    const deadline = Date.now() + 20_000;
    while (newId == null) {
      const tabs = await queryTabs(sw, w2);
      const t = tabs.find((x) => x.url === discardedUrl && x.discarded);
      if (t) { newId = t.id; break; }
      if (Date.now() > deadline) throw new Error('chrome.tabs.discard never produced a discarded tab');
      await panel.waitForTimeout(300);
    }

    await expect(panel.locator(`[data-tab-id="${newId}"]`)).toHaveClass(/is-discarded/, { timeout: 15_000 });
  } finally {
    await context.close();
  }
});
