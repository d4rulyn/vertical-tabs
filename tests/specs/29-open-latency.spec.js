// 29-open-latency — how long the reader waits to see their tabs.
//
// The tab list is what the panel is for, so anything put in front of the first paint is
// paid every time the panel opens. Three round trips used to be sequential there —
// settings, the hosting window, the locked-tab set — and none of the three depends on
// the others; they are now asked for together.
//
// The budget is deliberately loose compared to the measurement (~130 ms): this exists to
// catch a NEW await landing in front of the first paint, not to police tens of
// milliseconds on a shared CI box.
'use strict';

const { test, expect } = require('../fixtures');
const { setSettings, sleep } = require('../helpers/chrome');

const ROUNDS = 3;
const FIRST_CARD_P50_MS = 500;
const FIRST_CARD_MAX_MS = 1200;

/** Resolves with `performance.now()` at the moment the selector first exists. */
const waitForPaint = async (selector, budget) => {
  // Runs inside the panel document, so the clock is that document's own: the number is
  // "how long after this document started did the reader see something".
  return new Promise((resolve) => {
    if (document.querySelector(selector)) return resolve(performance.now());
    const observer = new MutationObserver(() => {
      if (!document.querySelector(selector)) return;
      observer.disconnect();
      resolve(performance.now());
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    setTimeout(() => { observer.disconnect(); resolve(-1); }, budget);
    return undefined;
  });
};

test('a freshly opened panel shows its tabs promptly', async ({ harness, serviceWorker }) => {
  test.setTimeout(180_000);
  const { w1, w2, openPanelPage } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off' });

  const samples = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const panel = await openPanelPage({ hostWindowId: w1, scopedWindowId: w2 });
    const firstCard = await panel.evaluate(waitForPaint, '.tab-card');
    expect(firstCard, 'the list appeared at all').toBeGreaterThan(0);
    samples.push(Math.round(firstCard));
    await panel.close();
    await sleep(400);
  }

  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length / 2)];
  const max = samples[samples.length - 1];
  console.log(`[open] firstCard p50=${p50}ms max=${max}ms samples=[${samples.join(',')}]`);

  expect(p50, `median time to the first card (${samples.join(', ')})`).toBeLessThanOrEqual(FIRST_CARD_P50_MS);
  expect(max, `worst time to the first card (${samples.join(', ')})`).toBeLessThanOrEqual(FIRST_CARD_MAX_MS);
});

test('the tools column does not hold the tab list back', async ({ harness, serviceWorker }) => {
  test.setTimeout(180_000);
  const { w1, w2, openPanelPage } = harness;

  // Every tool on: mounting them must not be something the list waits behind.
  await setSettings(serviceWorker, {
    refreshInterval: 'off',
    widgets: ['sessions', 'recent', 'windows', 'autoGroup', 'duplicates', 'staleTabs', 'listIO', 'nowPlaying', 'scratchpad'],
  });

  const panel = await openPanelPage({ hostWindowId: w1, scopedWindowId: w2 });
  const firstCard = await panel.evaluate(waitForPaint, '.tab-card');
  console.log(`[open] firstCard with every tool = ${Math.round(firstCard)}ms`);
  expect(firstCard).toBeGreaterThan(0);
  expect(Math.round(firstCard)).toBeLessThanOrEqual(FIRST_CARD_MAX_MS);
});
