// 23-preview-moment — which part of a page a preview is a picture of.
//
// `captureVisibleTab` photographs the viewport, so without a rule a preview shows
// wherever the reader happened to be. Chrome restores the scroll offset on reload, so
// F5 half way down an article produces a thumbnail of that half way point — a band of
// body text that identifies nothing. `previewMoment` decides what happens then, and
// its default (`top`) keeps the header.
//
// The fixture is `/tall`: two viewports of one colour, then six of another. A preview
// taken at the top is entirely the first colour; one taken from the middle is entirely
// the second. That makes the assertion a pixel fact rather than a metadata fact.
'use strict';

const { test, expect } = require('../fixtures');
const { swEval, setSettings, waitForThumb, getThumb, keyOf, waitForTabsComplete, sleep } = require('../helpers/chrome');
const { statsOfBlob } = require('../helpers/pixels');

/** Puts the reader deep into the body colour, and proves the page went there. */
async function scrollInto(sw, tabId, y = 4000) {
  const at = await swEval(sw, async (a) => {
    await chrome.scripting.executeScript({
      target: { tabId: a.tabId },
      func: (to) => { window.scrollTo(0, to); },
      args: [a.y],
    });
    const [hit] = await chrome.scripting.executeScript({
      target: { tabId: a.tabId },
      func: () => Math.round(window.scrollY),
    });
    return hit && hit.result;
  }, { tabId, y });
  expect(at, 'the fixture must actually scroll').toBeGreaterThan(1000);
  return at;
}

/** Makes the extension want a fresh capture of `tabId`: leave the tab and come back. */
async function retrigger(sw, { tabId, otherId }) {
  await swEval(sw, async (a) => {
    await chrome.tabs.update(a.otherId, { active: true });
    await new Promise((r) => setTimeout(r, 250));
    await chrome.tabs.update(a.tabId, { active: true });
  }, { tabId, otherId });
}

async function openTall(sw, { windowId, fixtures, head, body, title }) {
  const url = fixtures.tall(head, body, title);
  const tabId = await swEval(sw, async (a) => {
    const t = await chrome.tabs.create({ windowId: a.windowId, url: a.url, active: true });
    return t.id;
  }, { windowId, url });
  await waitForTabsComplete(sw, [tabId]);
  return { tabId, url };
}

test('the default keeps the header once the reader has scrolled away', async ({
  harness, serviceWorker, fixtures,
}) => {
  test.setTimeout(180_000);
  const { panel, w2, tabIds } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off', previewMoment: 'top' });

  const { tabId, url } = await openTall(serviceWorker, {
    windowId: w2, fixtures, head: 'ff0000', body: '0000ff', title: 'TopMode',
  });
  const key = await keyOf(panel, url);

  const first = await waitForThumb(panel, key, { timeout: 40_000 });
  expect(first, 'the page is captured while it sits at the top').toBeTruthy();
  expect(first.atTop, 'and the record says so').toBe(true);
  const top = await statsOfBlob(panel, key);
  expect(top.dominant, 'a capture at the top is all header').toBe('red');

  await scrollInto(serviceWorker, tabId);
  await retrigger(serviceWorker, { tabId, otherId: tabIds.alpha });
  // Long enough for a capture to have been taken and stored had one been allowed:
  // the limiter spaces calls 1100 ms apart and `activated` bypasses every freshness
  // guard, so 6 s is several missed opportunities, not a race being papered over.
  await sleep(6000);

  const after = await getThumb(panel, key);
  expect(after.capturedAt, 'the scrolled view never replaced the header').toBe(first.capturedAt);
  const still = await statsOfBlob(panel, key);
  expect(still.dominant, 'the preview is still the header').toBe('red');
});

test('interval mode follows the reader down the page', async ({
  harness, serviceWorker, fixtures,
}) => {
  test.setTimeout(180_000);
  const { panel, w2, tabIds } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off', previewMoment: 'interval' });

  const { tabId, url } = await openTall(serviceWorker, {
    windowId: w2, fixtures, head: 'ff0000', body: '0000ff', title: 'IntervalMode',
  });
  const key = await keyOf(panel, url);
  const first = await waitForThumb(panel, key, { timeout: 40_000 });
  expect((await statsOfBlob(panel, key)).dominant).toBe('red');

  await scrollInto(serviceWorker, tabId);
  await retrigger(serviceWorker, { tabId, otherId: tabIds.alpha });

  await expect.poll(
    async () => (await statsOfBlob(panel, key)).dominant,
    { timeout: 30_000, message: 'interval mode lets the body replace the header' },
  ).toBe('blue');
  const after = await getThumb(panel, key);
  expect(after.capturedAt).toBeGreaterThan(first.capturedAt);
});

test('reload mode replaces the preview on a load and at no other time', async ({
  harness, serviceWorker, fixtures,
}) => {
  test.setTimeout(180_000);
  const { panel, w2, tabIds } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off', previewMoment: 'reload' });

  const { tabId, url } = await openTall(serviceWorker, {
    windowId: w2, fixtures, head: 'ff0000', body: '0000ff', title: 'ReloadMode',
  });
  const key = await keyOf(panel, url);
  const first = await waitForThumb(panel, key, { timeout: 40_000 });

  await scrollInto(serviceWorker, tabId);
  await retrigger(serviceWorker, { tabId, otherId: tabIds.alpha });
  await sleep(6000);
  expect(
    (await getThumb(panel, key)).capturedAt,
    'switching back to a tab is not a load',
  ).toBe(first.capturedAt);

  await swEval(serviceWorker, async (id) => { await chrome.tabs.reload(id); }, tabId);
  await waitForTabsComplete(serviceWorker, [tabId]);
  const reloaded = await waitForThumb(panel, key, { timeout: 40_000, newerThan: first.capturedAt });
  expect(reloaded.capturedAt, 'a load does replace it').toBeGreaterThan(first.capturedAt);
});

test('a page with no preview yet is captured wherever it sits', async ({
  harness, serviceWorker, fixtures,
}) => {
  test.setTimeout(180_000);
  const { panel, w2 } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off', previewMoment: 'top' });

  // Created in the background, so nothing captures it: only the active tab is.
  const url = fixtures.tall('ff0000', '0000ff', 'NeverAtTop');
  const tabId = await swEval(serviceWorker, async (a) => {
    const t = await chrome.tabs.create({ windowId: a.windowId, url: a.url, active: false });
    return t.id;
  }, { windowId: w2, url });
  await waitForTabsComplete(serviceWorker, [tabId]);
  const key = await keyOf(panel, url);
  expect(await getThumb(panel, key), 'a background tab is not captured').toBeNull();

  await scrollInto(serviceWorker, tabId);
  await swEval(serviceWorker, async (id) => { await chrome.tabs.update(id, { active: true }); }, tabId);

  const made = await waitForThumb(panel, key, { timeout: 40_000 });
  expect(made, 'a card is never left blank waiting for someone to scroll up').toBeTruthy();
  expect(made.atTop, 'and the record admits it is not the top').toBe(false);
  expect((await statsOfBlob(panel, key)).dominant).toBe('blue');
});
