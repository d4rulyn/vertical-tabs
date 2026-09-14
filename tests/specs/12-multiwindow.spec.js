// 12-multiwindow — capturing a window that is NOT focused works (measured), the
// queue serialises calls ~1.1 s apart without starving a window, and non-normal
// windows (popups, DevTools, app windows) are never screenshotted.
'use strict';

const fs = require('fs');
const path = require('path');

const { test, expect, EXT } = require('../fixtures');
const {
  swEval, keyOf, waitForThumb, getThumb, diagnostics, setSettings, sleep,
} = require('../helpers/chrome');
const { extConstant } = require('../helpers/ext-constants');

const MIN_CALL_SPACING_MS = extConstant('MIN_CALL_SPACING_MS');

test('a second, non-focused window is captured', async ({ harness, serviceWorker }) => {
  test.setTimeout(180_000);
  const { panel, tabIds, urls } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off' });

  // The panel PAGE is the visible tab of W1; the fixtures live in W2.
  await panel.bringToFront();
  const before = await diagnostics(panel);

  const betaKey = await keyOf(panel, urls.beta);
  await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), tabIds.beta);
  const rec = await waitForThumb(panel, betaKey, { timeout: 45_000 });
  expect(rec.width).toBe(640);

  const after = await diagnostics(panel);
  expect(after.captures.ok).toBeGreaterThan(before.captures.ok);
  expect(after.captures.quotaRejections || 0).toBe(0);
  expect(after.captures.byReason.quota || 0).toBe(0);
});

test('two windows are captured one after the other, ~1.1 s apart and without starvation',
  async ({ harness, serviceWorker, fixtures }) => {
    test.setTimeout(180_000);
    const { panel, w2 } = harness;
    await setSettings(serviceWorker, { refreshInterval: 'off' });

    const w3FirstUrl = fixtures.page('c000c0', 'W3-First');
    const w3SecondUrl = fixtures.page('00c0c0', 'W3-Second');
    const w2NextUrl = fixtures.page('c0c000', 'W2-Next');

    const w3 = await swEval(serviceWorker, async (urlList) => {
      const w = await chrome.windows.create({ url: urlList, focused: false, width: 1024, height: 768 });
      return { id: w.id, tabIds: (w.tabs || []).map((t) => t.id) };
    }, [w3FirstUrl, w3SecondUrl]);

    // Give both windows a fresh, never-captured active tab, back to back.
    const w2NextId = await swEval(serviceWorker, async (a) => {
      const t = await chrome.tabs.create({ windowId: a.wid, url: a.url, active: false });
      return t.id;
    }, { wid: w2, url: w2NextUrl });

    await swEval(serviceWorker, async (a) => {
      await chrome.tabs.update(a.w2Tab, { active: true });
      await chrome.tabs.update(a.w3Tab, { active: true });
    }, { w2Tab: w2NextId, w3Tab: w3.tabIds[1] });

    const keyW2 = await keyOf(panel, w2NextUrl);
    const keyW3 = await keyOf(panel, w3SecondUrl);
    const recW2 = await waitForThumb(panel, keyW2, { timeout: 60_000 });
    const recW3 = await waitForThumb(panel, keyW3, { timeout: 60_000 });

    const d = await diagnostics(panel);

    // Serialisation is asserted on the quantity the limiter actually controls: the call
    // STARTS. `reserveSlot()` stamps `lastCallByWindow[windowId]` immediately before
    // `captureVisibleTab` and never between two awaits, and `vt/get-diagnostics` reports
    // those stamps, so the distance between two windows' stamps IS the spacing the queue
    // produced. Any two stamps under different window ids are two different calls, so the
    // queue's `>= MIN_CALL_SPACING_MS` invariant applies to them directly.
    //
    // Addendum A26 words this lower bound over the two `capturedAt` values instead. That
    // quantity is stamped after the call RESOLVES, so it measures
    // `spacing + (latency_second - latency_first)` — and the first capture of a serialised
    // pair is systematically the slower one (measured 52-113 ms against 23-66 ms), always
    // shrinking the gap. A loaded host produced 939 ms and turned the `>= 1000 ms` form of
    // this assertion red with no regression in the product. Deliberate deviation from
    // A26's literal wording: same property, measured where it is guaranteed.
    const stamps = JSON.stringify(d.lastCallByWindow);
    const startW2 = d.lastCallByWindow[w2];
    const startW3 = d.lastCallByWindow[w3.id];
    expect(typeof startW2, `no capture call recorded for W2=${w2} in ${stamps}`).toBe('number');
    expect(typeof startW3, `no capture call recorded for W3=${w3.id} in ${stamps}`).toBe('number');

    const spacing = Math.abs(startW2 - startW3);
    expect(spacing).toBeGreaterThanOrEqual(1000);                // A26: proves ~1 call/second
    expect(spacing).toBeGreaterThanOrEqual(MIN_CALL_SPACING_MS); // and the configured spacing

    // Fairness stays on the stored records: "both windows produced a preview within 15 s of
    // each other" is a completion property, and ~100 ms of capture latency is noise there.
    const gap = Math.abs(recW2.capturedAt - recW3.capturedAt);
    expect(gap).toBeLessThanOrEqual(15_000);   // per-window fairness: neither window starves

    expect(d.captures.quotaRejections || 0).toBe(0);
    expect(d.captures.byReason.quota || 0).toBe(0);
  });

test('popup windows are never captured', async ({ harness, serviceWorker, fixtures }) => {
  test.setTimeout(150_000);
  const { panel } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off' });

  const popupUrl = fixtures.page('303030', 'PopupOnly');
  const popupKey = await keyOf(panel, popupUrl);

  await swEval(serviceWorker, async (url) => {
    const w = await chrome.windows.create({ url, type: 'popup', focused: true, width: 500, height: 400 });
    // Focus changes and the load event both schedule a capture for that window.
    await chrome.windows.update(w.id, { focused: true });
    return w.id;
  }, popupUrl);

  await expect.poll(async () => (await diagnostics(panel)).captures.byReason['window-type'] || 0,
    { timeout: 30_000 }).toBeGreaterThanOrEqual(1);

  await sleep(3000);
  expect(await getThumb(panel, popupKey)).toBeNull();
});

test('the service worker never lets Chrome pick the window for it', async () => {
  const dir = path.join(EXT, 'background');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  expect(files.length).toBeGreaterThan(0);

  // Forbidden everywhere in background/: Chrome would silently pick the
  // last-focused window instead of the one the job is about (addendum A3).
  const forbidden = ['captureVisibleTab(undefined', 'captureVisibleTab()', 'windows.getCurrent()'];

  const offenders = [];
  for (const file of files) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    // Strip comments so a documentation mention is not a failure.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const needle of forbidden) {
      if (code.includes(needle)) offenders.push(`${file}: ${needle}`);
    }

    // WINDOW_ID_CURRENT (=-2) has exactly one sanctioned use: the documented
    // last resort of the search-tabs command handler (`?? chrome.windows.WINDOW_ID_CURRENT`,
    // addendum A3 step 5). Anywhere else it would leak into a capture job.
    for (const line of code.split('\n')) {
      if (!line.includes('WINDOW_ID_CURRENT')) continue;
      const sanctioned = /\?\?\s*chrome\.windows\.WINDOW_ID_CURRENT/.test(line) || line.includes('sidePanel.open');
      if (!sanctioned) offenders.push(`${file}: unsanctioned WINDOW_ID_CURRENT -> ${line.trim()}`);
    }
  }
  expect(offenders, 'the SW must always pass an explicit, validated windowId (addendum A3)').toEqual([]);
});
