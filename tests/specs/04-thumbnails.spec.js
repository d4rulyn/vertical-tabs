// 04-thumbnails — user requirement #2. A preview is captured, cropped, stored in
// IndexedDB, broadcast, and RENDERED inside the card; it belongs to the right tab;
// restricted pages never spend a quota token; and the extension's own limiter never
// trips Chrome's MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.
'use strict';

const { test, expect } = require('../fixtures');
const {
  swEval, createTab, keyOf, waitForThumb, getThumb, diagnostics, setSettings, shot, sleep,
} = require('../helpers/chrome');
const { PIXEL_RULE, statsOfBlob, statsOfRenderedImg } = require('../helpers/pixels');

test.describe('previews', () => {
  test.beforeEach(async ({ serviceWorker }) => {
    // The periodic refresh alarm would make "captures.ok did not change" racy.
    await setSettings(serviceWorker, { refreshInterval: 'off' });
  });

  test('a preview is captured, stored, rendered, and never crosses tabs', async ({ harness, serviceWorker, fixtures }) => {
    test.setTimeout(180_000);
    const { panel, w2, tabIds, urls } = harness;

    const alphaKey = await keyOf(panel, urls.alpha);
    const betaKey = await keyOf(panel, urls.beta);

    // ── capture the active tab
    await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), tabIds.alpha);
    const alphaRec = await waitForThumb(panel, alphaKey, { timeout: 40_000 });

    expect(alphaRec.width).toBe(640);
    expect(alphaRec.height).toBe(240);
    expect(alphaRec.blobType).toBe('image/jpeg');
    expect(alphaRec.blobSize).toBeGreaterThan(500);
    expect(alphaRec.bytes).toBeGreaterThan(500);
    expect(alphaRec.bytes).toBeLessThan(60_000);
    expect(alphaRec.uniform).toBe(false);
    expect(Array.isArray(alphaRec.avgColor)).toBe(true);
    expect(alphaRec.avgColor).toHaveLength(3);

    // ── it is actually on screen (addendum A23)
    const card = panel.locator(`[data-tab-id="${tabIds.alpha}"]`);
    await expect(card.locator('.thumb')).toHaveClass(/thumb--loaded/, { timeout: 15_000 });

    const img = await card.locator('.thumb__img').evaluate((el) => ({
      complete: el.complete,
      nw: el.naturalWidth,
      nh: el.naturalHeight,
      blob: (el.currentSrc || el.src || '').startsWith('blob:'),
      hidden: el.hidden,
    }));
    expect(img.complete).toBe(true);
    expect(img.nw).toBe(640);
    expect(img.nh).toBe(240);
    expect(img.blob).toBe(true);
    expect(img.hidden).toBe(false);

    // avgColor is painted behind the image before it decodes.
    const bg = await card.locator('.thumb').evaluate((el) => el.style.backgroundColor);
    expect(bg).not.toBe('');

    // ── the rendered pixels are the page, not a placeholder
    const px = await statsOfRenderedImg(panel, tabIds.alpha);
    expect(px.natural).toEqual({ width: 640, height: 240 });
    expect(px.share.red).toBeGreaterThanOrEqual(0.80);
    expect(px.dominant).toBe('red');
    // A flat fill (placeholder / stretched 1x1) would have a span of ~0 on every channel.
    expect(Math.max(...px.span)).toBeGreaterThanOrEqual(PIXEL_RULE.uniformSpanMin);

    // ── switching tabs captures the new tab and leaves the old record alone
    await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), tabIds.beta);
    const betaRec = await waitForThumb(panel, betaKey, { timeout: 40_000 });
    const betaPx = await statsOfBlob(panel, betaKey);
    expect(betaPx.share.blue).toBeGreaterThanOrEqual(0.80);
    expect(betaPx.dominant).toBe('blue');
    expect(betaRec.uniform).toBe(false);

    const alphaAfter = await getThumb(panel, alphaKey);
    expect(alphaAfter.capturedAt).toBe(alphaRec.capturedAt); // no cross-contamination

    await expect(panel.locator(`[data-tab-id="${tabIds.beta}"] .thumb`))
      .toHaveClass(/thumb--loaded/, { timeout: 15_000 });

    // ── restore by URL: a NEW inactive tab on an already-captured URL shows the
    //    stored preview at once, without any capture at all.
    const before = await diagnostics(panel);
    const twinId = await createTab(serviceWorker, w2, urls.alpha, { active: false });
    await expect(panel.locator(`[data-tab-id="${twinId}"] .thumb`))
      .toHaveClass(/thumb--loaded/, { timeout: 15_000 });
    const after = await diagnostics(panel);
    expect(after.captures.ok).toBe(before.captures.ok);

    // The limiter must not have produced a single quota rejection.
    expect(after.captures.quotaRejections || 0).toBe(0);
    expect(after.captures.byReason.quota || 0).toBe(0);
    expect(String(after.lastError || '')).not.toContain('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND');

    await shot(panel, '04-thumbs.png');
  });

  test('restricted pages cost no quota, flat pages are re-checked, and the quota is real',
    async ({ harness, serviceWorker, fixtures }) => {
      test.setTimeout(180_000);
      const { panel, w2, tabIds, urls } = harness;

      const alphaKey = await keyOf(panel, urls.alpha);
      await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), tabIds.alpha);
      await waitForThumb(panel, alphaKey, { timeout: 40_000 });

      // ── a chrome:// page is classified BEFORE the API call: no capture, no token
      const beforeRestricted = await diagnostics(panel);
      const chromeTabId = await swEval(serviceWorker, async (wid) => {
        const t = await chrome.tabs.create({ windowId: wid, url: 'chrome://version', active: true });
        return t.id;
      }, w2);
      await panel.waitForSelector(`[data-tab-id="${chromeTabId}"]`, { timeout: 15_000 });
      await expect(panel.locator(`[data-tab-id="${chromeTabId}"] .thumb`))
        .toHaveClass(/thumb--restricted/, { timeout: 20_000 });

      await expect.poll(async () => (await diagnostics(panel)).captures.byReason.restricted || 0,
        { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
      const afterRestricted = await diagnostics(panel);
      expect(afterRestricted.captures.ok).toBe(beforeRestricted.captures.ok);

      // ── a genuinely flat page is stored as uniform and re-checked once
      const solidUrl = fixtures.solid('7040c0', 'SolidPage');
      const solidKey = await keyOf(panel, solidUrl);
      const solidId = await createTab(serviceWorker, w2, solidUrl, { active: true });
      const solidRec = await waitForThumb(panel, solidKey, { timeout: 45_000 });
      expect(solidRec.uniform).toBe(true);
      await expect.poll(async () => (await diagnostics(panel)).captures.rechecks || 0,
        { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
      expect(solidId).toBeGreaterThan(0);

      // ── no quota rejection reached a card during ordinary use …
      const beforeProbe = await diagnostics(panel);
      expect(beforeProbe.captures.byReason.quota || 0).toBe(0);

      /* … and the quota the limiter protects against is real.
       *
       * This used to require at least TWO rejections out of three synchronous calls,
       * from the original burst probe that read "ok, err, err". That burst is what
       * spec-addendum A29 corrected: it measures how many calls may be IN FLIGHT at
       * once, and the sustained limit is about two per second, so a burst of three
       * legitimately comes back "ok, ok, err" as well. Requiring two rejections was
       * asserting the measurement error, and it failed once the container was busy
       * enough to space the calls apart.
       *
       * What is true either way, and is the property this test exists for: three
       * calls issued with no spacing at all cannot all succeed.
       */
      const burst = await swEval(serviceWorker, async (wid) => {
        const settled = await Promise.allSettled([
          chrome.tabs.captureVisibleTab(wid, { format: 'jpeg' }),
          chrome.tabs.captureVisibleTab(wid, { format: 'jpeg' }),
          chrome.tabs.captureVisibleTab(wid, { format: 'jpeg' }),
        ]);
        return settled.map((s) => (s.status === 'fulfilled' ? 'ok' : String(s.reason && s.reason.message || s.reason)));
      }, w2);
      const quotaErrors = burst.filter((r) => r.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND'));
      expect(quotaErrors.length, `burst: ${burst.join(' | ')}`).toBeGreaterThanOrEqual(1);

      await sleep(1300); // give the bucket back before the fixture teardown
    });
});
