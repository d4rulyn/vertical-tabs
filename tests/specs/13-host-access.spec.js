// 13-host-access — withheld site access is a first-class, recoverable state
// (addendum A7). Chrome will not let a test revoke a REQUIRED host permission
// (permissions.remove only works on optional ones), so the state is injected and the
// panel's behaviour is what is under test; the real withheld case is manual check #2.
'use strict';

const { test, expect } = require('../fixtures');
const {
  swEval, createTab, keyOf, waitForThumb, setSettings, sleep,
} = require('../helpers/chrome');

const NO_ACCESS_TITLE_EN =
  'Chrome is not letting this extension read this site, so no preview can be made';

async function broadcastHostAccess(sw, hostAccess) {
  await swEval(sw, async (flag) => {
    await chrome.storage.session.set({ hostAccessState: { all: flag, at: Date.now() } });
    try {
      await chrome.runtime.sendMessage({
        type: 'vt/host-access', hostAccess: flag, origin: null, at: Date.now(),
      });
    } catch {
      /* no panel listening is not an error */
    }
  }, hostAccess);
}

test('the site-access banner appears, dismisses, and comes back when access flips',
  async ({ harness, serviceWorker, fixtures }) => {
    test.setTimeout(150_000);
    const { panel, w2 } = harness;
    await setSettings(serviceWorker, { refreshInterval: 'off' });

    const banner = panel.locator('[data-testid="host-access-banner"]');
    await expect(banner).toBeHidden();

    await broadcastHostAccess(serviceWorker, false);
    await expect(banner).toBeVisible({ timeout: 15_000 });

    // A never-captured http(s) card explains itself without waiting for a failure.
    const url = fixtures.page('0044ff', 'NoAccess');
    const tabId = await createTab(serviceWorker, w2, url, { active: false });
    const thumb = panel.locator(`[data-tab-id="${tabId}"] .thumb`);
    await expect(thumb).toHaveClass(/thumb--no-access/, { timeout: 15_000 });
    await expect(thumb).toHaveAttribute('title', NO_ACCESS_TITLE_EN);

    // ── dismissal survives a full model resync
    await panel.locator('#host-access-dismiss').click();
    await expect(banner).toBeHidden({ timeout: 10_000 });
    await swEval(serviceWorker, (id) => chrome.tabs.move(id, { index: 0 }), tabId);
    await sleep(1000);
    await expect(banner).toBeHidden();

    // ── access restored: banner stays hidden, the card recovers
    await broadcastHostAccess(serviceWorker, true);
    await expect(banner).toBeHidden({ timeout: 10_000 });
    await expect(thumb).not.toHaveClass(/thumb--no-access/, { timeout: 15_000 });

    // ── withheld again: a change clears the dismissal, so the banner returns
    await broadcastHostAccess(serviceWorker, false);
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(panel.locator('#host-access-open')).toBeVisible();
  });

test('a stale restrictedUrlKeys entry expires instead of pinning "no preview" forever',
  async ({ context, harness, serviceWorker }) => {
    test.setTimeout(180_000);
    const { panel, tabIds, urls } = harness;
    await setSettings(serviceWorker, { refreshInterval: 'off' });

    const alphaKey = await keyOf(panel, urls.alpha);
    await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), tabIds.alpha);
    const first = await waitForThumb(panel, alphaKey, { timeout: 45_000 });

    // Inject an entry older than RESTRICTED_TTL_MS (15 min) and force a rehydrate.
    await swEval(serviceWorker, async (a) => {
      await chrome.storage.session.set({
        restrictedUrlKeys: { [a.key]: { class: 'restricted', at: Date.now() - 16 * 60000 } },
      });
    }, { key: alphaKey });

    const cdp = await context.newCDPSession(panel);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'vt/get-diagnostics' }).catch(() => {}));

    // Switch away and back so the 'activated' reason (exempt from the freshness
    // guards) schedules a fresh capture of the very key we poisoned.
    await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), tabIds.beta);
    await sleep(1500);
    await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), tabIds.alpha);

    const second = await waitForThumb(panel, alphaKey, { timeout: 60_000, newerThan: first.capturedAt });
    expect(second.capturedAt).toBeGreaterThan(first.capturedAt);
  });
