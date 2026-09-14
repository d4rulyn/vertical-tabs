// 14-coverage — the paths that had no automated coverage at all: the production
// window resolution, own-page exclusion, excludedHosts, captureWhenPanelClosed, the
// welcome page, and capturing while the REAL side panel is open (addendum A26).
'use strict';

const { test, expect } = require('../fixtures');
const {
  swEval, createTab, queryTabs, keyOf, waitForThumb, getThumb, diagnostics, setSettings, cardOrder, sleep,
} = require('../helpers/chrome');
const { openPanelPage } = require('../helpers/windows');

test('opened without ?windowId= the panel scopes itself to its hosting window and hides itself',
  async ({ context, harness, serviceWorker }) => {
    const { w2, tabIds } = harness;

    // No query string: this is the production chrome.windows.getCurrent() path.
    const production = await openPanelPage(context, serviceWorker, {
      hostWindowId: w2, scopedWindowId: null,
    });

    await expect(production.locator('[data-testid="tab-card"]')).toHaveCount(3, { timeout: 20_000 });
    const asc = (a, b) => a - b;
    const rendered = (await cardOrder(production)).sort(asc);
    expect(rendered).toEqual([tabIds.alpha, tabIds.beta, tabIds.gamma].sort(asc));

    // A26(a): the window the panel scoped itself to is the one that hosts it, resolved
    // through `chrome.windows.getCurrent()` because there is no query string. This is the
    // assertion the unconditional `publishTestHooks()` in sidepanel.js exists for.
    expect(await production.evaluate(() => window.__vt.state.windowId)).toBe(w2);
    expect(await production.evaluate(() => window.__vt.testMode)).toBe(false);

    // W2 really does hold four tabs; the fourth is the panel document itself.
    const tabs = await queryTabs(serviceWorker, w2);
    expect(tabs).toHaveLength(4);
    expect(tabs.some((t) => t.url.includes('sidepanel/sidepanel.html'))).toBe(true);
  });

test('excluded hosts are never captured and say so on the card',
  async ({ harness, serviceWorker, fixtures }) => {
    test.setTimeout(150_000);
    const { panel, w2 } = harness;
    await setSettings(serviceWorker, { refreshInterval: 'off', excludedHosts: ['127.0.0.1'] });
    await sleep(500);

    const url = fixtures.page('20c020', 'Excluded');
    const key = await keyOf(panel, url);
    const before = await diagnostics(panel);

    const tabId = await createTab(serviceWorker, w2, url, { active: true });
    await panel.waitForSelector(`[data-tab-id="${tabId}"]`, { timeout: 15_000 });

    const thumb = panel.locator(`[data-tab-id="${tabId}"] .thumb`);
    await expect(thumb).toHaveClass(/thumb--excluded/, { timeout: 20_000 });
    await expect(thumb).toHaveAttribute('title', 'Previews are turned off for this site');

    await expect.poll(async () => (await diagnostics(panel)).captures.byReason.excluded || 0,
      { timeout: 20_000 }).toBeGreaterThanOrEqual(1);

    const after = await diagnostics(panel);
    expect(after.captures.ok).toBe(before.captures.ok);
    expect(await getThumb(panel, key)).toBeNull();
  });

test('captureWhenPanelClosed=false pauses captures while no panel is open',
  async ({ context, harness, serviceWorker }) => {
    test.setTimeout(150_000);
    const { panel, w1, w2, tabIds } = harness;
    await setSettings(serviceWorker, { refreshInterval: 'off', captureWhenPanelClosed: false });

    // pagehide sends vt/panel-closing, which removes W2 from openPanels.
    await panel.close();

    /* The baseline is taken AFTER the queue has drained, not before the close.
     *
     * The setting promises "no capture while no panel is open", and the worker can
     * only honour it once it KNOWS the panel is gone. A job that already held a
     * rate-limit slot when the page went away still completes, and since the
     * limiter now hands the second slot of a pair over in 450 ms rather than 1100,
     * that job wins the race often enough to matter. Sampling before the close
     * therefore measured the propagation delay rather than the guarantee.
     *
     * Wait for two consecutive identical `ok` counts — the queue is empty — and
     * measure from there.
     */
    let before = await diagnostics(serviceWorker);
    for (let i = 0; i < 15; i += 1) {
      await sleep(1000);
      const next = await diagnostics(serviceWorker);
      if (next.captures.ok === before.captures.ok) { before = next; break; }
      before = next;
    }

    await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), tabIds.gamma);
    await sleep(4000);

    const during = await diagnostics(serviceWorker);
    expect(during.captures.byReason['panel-closed'] || 0).toBeGreaterThanOrEqual(1);
    expect(during.captures.ok).toBe(before.captures.ok);

    // Reopening the panel schedules the window's active tab again.
    const reopened = await openPanelPage(context, serviceWorker, {
      hostWindowId: w1, scopedWindowId: w2,
    });
    await expect(reopened.locator('[data-testid="tab-card"]')).toHaveCount(3, { timeout: 20_000 });
    await expect.poll(async () => (await diagnostics(reopened)).captures.ok, { timeout: 45_000 })
      .toBeGreaterThan(before.captures.ok);
  });

test('the welcome page is localized and can open the panel itself',
  async ({ context, harness, serviceWorker }) => {
    test.setTimeout(120_000);
    const { panel, w1 } = harness;

    const welcomePromise = context.waitForEvent('page', {
      predicate: (p) => p.url().includes('welcome/welcome.html'),
      timeout: 30_000,
    });
    await swEval(serviceWorker, async (wid) => {
      await chrome.tabs.create({
        windowId: wid, active: true, url: chrome.runtime.getURL('welcome/welcome.html'),
      });
    }, w1);
    const welcome = await welcomePromise;
    await welcome.bringToFront();
    await welcome.waitForSelector('#open-now', { timeout: 20_000 });

    const texts = await welcome.$$eval('[data-i18n]', (els) => els.map((el) => el.textContent.trim()));
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) {
      expect(t.length).toBeGreaterThan(0);
      expect(t).not.toContain('__MSG_');
    }
    const body = await welcome.evaluate(() => document.body.innerText);
    expect(body).not.toContain('__MSG_');
    expect(body).not.toContain('$SHORTCUT$');

    // The "open the tab bar" line carries the real, current binding.
    const shortcut = await swEval(serviceWorker, async () => {
      const cmds = await chrome.commands.getAll();
      const c = cmds.find((x) => x.name === '_execute_action');
      return (c && c.shortcut) || '';
    });
    if (shortcut) {
      await expect(welcome.locator('#open-line')).toContainText(shortcut, { timeout: 10_000 });
    }

    await welcome.locator('#open-now').click();
    await expect.poll(() => diagnostics(panel).then((d) => d.openPanels), { timeout: 20_000 })
      .toContain(w1);
  });

test('captures still work while the real side panel is open in that window',
  async ({ harness, serviceWorker }) => {
    test.setTimeout(150_000);
    const { panel, w2, tabIds, urls } = harness;
    await setSettings(serviceWorker, { refreshInterval: 'off' });

    const alphaKey = await keyOf(panel, urls.alpha);
    await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), tabIds.alpha);
    const first = await waitForThumb(panel, alphaKey, { timeout: 45_000 });

    const opened = await panel.evaluate(
      (w) => chrome.sidePanel.open({ windowId: w }).then(() => true, () => false), w2);
    expect(opened).toBe(true);
    await sleep(1500);

    await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), tabIds.beta);
    await sleep(1500);
    await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), tabIds.alpha);

    // The raw capture shrinks to the page area when a panel is docked; only the
    // stored thumbnail geometry is asserted.
    const second = await waitForThumb(panel, alphaKey, { timeout: 60_000, newerThan: first.capturedAt });
    expect(second.width).toBe(640);
    expect(second.height).toBe(240);
  });
