// 11-lifecycle — MV3 service workers are ephemeral (spec risk #4). The worker is
// stopped through CDP (an idle wait can never work here: the CDP attachment keeps the
// worker alive — measured at 45 s and 70 s of zero traffic), woken with a runtime
// message from the panel, and the rehydrated limiter/alarms are asserted.
'use strict';

const { test, expect } = require('../fixtures');
const {
  swEval, keyOf, waitForThumb, diagnostics, setSettings,
} = require('../helpers/chrome');

test('a service worker restart rehydrates the limiter, the alarms and the queue',
  async ({ context, serviceWorker, harness }) => {
    test.setTimeout(180_000);
    const { panel, tabIds, urls } = harness;
    await setSettings(serviceWorker, { refreshInterval: 'off' });

    const alphaKey = await keyOf(panel, urls.alpha);
    await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), tabIds.alpha);
    await waitForThumb(panel, alphaKey, { timeout: 40_000 });

    const before = await swEval(serviceWorker, () => performance.timeOrigin);
    const d0 = await diagnostics(panel); // through the PAGE: the only path that survives the stop
    expect(d0.lastCallAt).toBeGreaterThan(0);

    const cdp = await context.newCDPSession(panel); // a browser-level session reports "wasn't found"
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');

    // From here swEval() would queue forever until the worker is revived.
    // chrome.runtime.sendMessage() from an extension page is the deterministic wake.
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'vt/get-diagnostics' }).catch(() => {}));

    const after = await swEval(serviceWorker, () => performance.timeOrigin);
    expect(after).not.toBe(before); // a real restart; Playwright reuses the Worker object

    const d1 = await diagnostics(panel);
    expect(d1.lastCallAt).toBe(d0.lastCallAt); // hydrate() restored storage.session.captureState
    expect(d1.alarms.map((a) => a.name)).toEqual(expect.arrayContaining(['vt-maintenance']));

    // The pipeline still works after the restart.
    const betaKey = await keyOf(panel, urls.beta);
    await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), tabIds.beta);
    await waitForThumb(panel, betaKey, { timeout: 45_000 });

    await expect.poll(async () => (await diagnostics(panel)).lastCallAt, { timeout: 20_000 })
      .toBeGreaterThan(d0.lastCallAt);

    const d2 = await diagnostics(panel);
    expect(d2.captures.quotaRejections || 0).toBe(0);
    expect(d2.captures.byReason.quota || 0).toBe(0);
  });
