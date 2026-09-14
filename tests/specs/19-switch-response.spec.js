// 19-switch-response — clicking a card must feel immediate.
//
// Two things used to sit between the click and any visible response:
//
//   1. `activate()` awaited a capture of the OUTGOING tab (spec-addendum A12) before
//      calling `tabs.update`, for up to 400 ms. Measured against the pre-fix tree:
//      click-to-switch p50 135 ms, and p50 218 ms when the harness's own click
//      overhead was included, with a tail past half a second.
//   2. The clicked card only gained `is-active` when `tabs.onActivated` came back
//      from Chrome, so the card the user had just clicked stayed unhighlighted for
//      the whole round trip: measured p50 87 ms, max 212 ms.
//
// Both are gone: the capture request is fired and not awaited (a late capture is
// dropped by `capture.js` step 3a as `not-active`, so it can never be filed against
// the wrong tab), and the model is painted optimistically. Measured after: highlight
// p50 4 ms, switch p50 53 ms.
//
// The bounds below are deliberately far above those numbers — this spec exists to
// catch a re-introduced round trip, not to police millisecond drift on a shared CI box.
'use strict';

const { test, expect } = require('../fixtures');
const { swEval, setSettings, sleep } = require('../helpers/chrome');

const REPS = 9;

/** The highlight must be a local repaint, not a round trip through Chrome. */
const HIGHLIGHT_P50_MAX_MS = 40;
/** A capture must never be able to hold the switch for its 400 ms UI timeout. */
const SWITCH_P50_MAX_MS = 300;

const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];

/** Clicks the card in-page and times the repaint from inside the document. */
function clickAndTimePaint(panel, tabId) {
  return panel.evaluate((id) => new Promise((resolve, reject) => {
    const el = document.querySelector(`[data-tab-id="${id}"]`);
    if (!el) { reject(new Error(`no card for tab ${id}`)); return; }
    const start = performance.now();
    el.click();
    const deadline = start + 5000;
    const check = () => {
      if (el.classList.contains('is-active')) { resolve(Math.round(performance.now() - start)); return; }
      if (performance.now() > deadline) { reject(new Error('card never became active')); return; }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }), tabId);
}

test('clicking a card highlights it at once and switches without waiting on a capture',
  async ({ harness, serviceWorker }) => {
    test.setTimeout(240_000);
    const { panel, w2, tabIds } = harness;
    const ids = [tabIds.alpha, tabIds.beta, tabIds.gamma];

    // The pre-switch capture is ON, which is the default and the case that used to block.
    await setSettings(serviceWorker, { refreshInterval: 'off', captureBeforeSwitch: true });

    const paints = [];
    const switches = [];
    for (let i = 0; i < REPS; i += 1) {
      const target = ids[i % ids.length];
      const active = await swEval(serviceWorker,
        (w) => chrome.tabs.query({ active: true, windowId: w }).then((t) => t[0].id), w2);
      if (active === target) continue;

      const t0 = Date.now();
      paints.push(await clickAndTimePaint(panel, target));
      await expect.poll(() => swEval(serviceWorker,
        (w) => chrome.tabs.query({ active: true, windowId: w }).then((t) => t[0].id), w2),
      { timeout: 10_000, intervals: [10, 10, 10, 20] }).toBe(target);
      switches.push(Date.now() - t0);

      await sleep(1500); // let the capture limiter refill so each sample starts alike
    }

    const paintP50 = pct(paints, 0.5);
    const switchP50 = pct(switches, 0.5);
    console.log(`[switch-response] n=${paints.length} highlight p50=${paintP50} `
      + `p90=${pct(paints, 0.9)} max=${Math.max(...paints)} all=[${paints.join(',')}] `
      + `| switch p50=${switchP50} p90=${pct(switches, 0.9)}`);

    expect(paints.length, 'the loop must have produced samples').toBeGreaterThanOrEqual(5);
    expect(paintP50, `highlight p50 (all: ${paints.join(', ')})`)
      .toBeLessThanOrEqual(HIGHLIGHT_P50_MAX_MS);
    expect(switchP50, `switch p50 (all: ${switches.join(', ')})`)
      .toBeLessThanOrEqual(SWITCH_P50_MAX_MS);

    // The optimistic paint must not be able to leave a lie on screen: Chrome and the
    // panel agree on the active tab once everything has settled.
    const finalActive = await swEval(serviceWorker,
      (w) => chrome.tabs.query({ active: true, windowId: w }).then((t) => t[0].id), w2);
    await expect(panel.locator(`[data-tab-id="${finalActive}"]`)).toHaveClass(/is-active/);
    await expect(panel.locator('.tab-card.is-active')).toHaveCount(1);
  });
