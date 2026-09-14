// 18-latency — how long the user waits between switching to a tab and that tab's
// preview being stored.
//
// User report 3: "プレビューの更新にラグがあるの気になる" (the lag before a preview
// updates is noticeable).
//
// What is measured: wall-clock milliseconds from the moment the tab is activated to
// the moment a thumbnail for THAT tab's urlKey exists in IndexedDB. The clock starts
// inside the panel page immediately before the activation call and stops when the
// panel receives the `vt/thumb-updated` broadcast, which background/capture.js sends
// strictly AFTER `putThumb()` has resolved, so the number is an upper bound on
// "stored", not a lower one. Both timestamps are `Date.now()` in the same renderer,
// so no cross-process clock skew is involved.
//
// Five scenarios, because the budget is completely different in each:
//   idle              deliberate switching; the limiter has been free for >2 s
//   rapid             the next switch starts the instant the previous preview lands
//   panel-deliberate  a switch through the panel's own A12 path after a pause, so the
//                     OUTGOING tab really is captured first and the incoming capture
//                     has to share the second with it
//   panel-rapid       the same path, clicked through without pausing
//   contended         a second window switches tabs in the same tick
//
// Every scenario also asserts that no activation went without a preview and that the
// quota was never hit: the point of the work behind these bounds was to spend the
// existing capture budget better, not to ask Chrome for more of it.
'use strict';

const { test, expect } = require('../fixtures');
const {
  swEval, waitForCard, waitForThumb, diagnostics, setSettings, thumbStats, sleep,
} = require('../helpers/chrome');
const { extConstant } = require('../helpers/ext-constants');

const CALL_MIN_GAP_MS = extConstant('CALL_MIN_GAP_MS');
const CALL_WINDOW_MS = extConstant('CALL_WINDOW_MS');
const MIN_CALL_SPACING_MS = extConstant('MIN_CALL_SPACING_MS');
const QUOTA_RETRY_MS = extConstant('QUOTA_RETRY_MS');
const ACTIVATED_DELAY_MS = 300; // DELAY_MS.activated — not a top-level numeric export

/* ── Bounds (ms) ───────────────────────────────────────────────────────────────
 * Every bound is written as the constant that produces the floor plus explicit
 * slack, so changing the limiter moves the bound with it instead of silently
 * invalidating it. Observed values (10-12 repetitions each, container run):
 *
 *   scenario           before             after (four runs)
 *   idle               p50 568  p90 597    p50 379-461   p90 427-737
 *   rapid              p50 1071 p90 1114   p50 1044-1074 p90 1072-1172
 *   panel-deliberate   p50 1200 p90 1293   p50 504-579   p90 526-660
 *   panel-rapid        p50 1058 p90 1177   p50 1006-1089 p90 1117-2176
 *   contended          p50 1651 p90 4999   p50 1498-1573 p90 1547-1676
 *
 * The one that answers the report is panel-deliberate — clicking a card in the list
 * after a pause, which is what using this extension looks like: 1200 ms -> ~550 ms.
 *
 * `panelDeliberateP90` is the bound that pins the fix: at 1450 ms it is BELOW
 * `MIN_CALL_SPACING_MS + PIPELINE_MS`, so it cannot be satisfied by making the
 * incoming capture wait a whole spacing behind the outgoing one.
 *
 * The strict guarantees are asserted on p50 and p90. `max` gets the same bound plus
 * STALL_ALLOWANCE_MS, because roughly one repetition in ten loses several seconds
 * somewhere below the extension — the pre-change run showed exactly the same thing
 * (maxima 4474 / 4618 / 4624 / 4999 against medians of 568-1651), and the broadcast
 * trace printed for such a sample contains no capture activity at all, just a gap.
 * A systematic regression moves p50 and p90 and is caught; a host hiccup is not
 * dressed up as one.
 */
const PIPELINE_MS = 500;        // capture + decode + crop + JPEG encode + IndexedDB write
const STALL_ALLOWANCE_MS = 3500; // one host stall per run, measured before and after
const BOUND = {
  // Delay-bound: nothing else is in the way.
  idleP50: ACTIVATED_DELAY_MS + PIPELINE_MS,
  idleP90: ACTIVATED_DELAY_MS + 2 * PIPELINE_MS,
  // Quota-bound: back-to-back switching cannot beat one capture per spacing.
  rapidP50: MIN_CALL_SPACING_MS + PIPELINE_MS,
  rapidP90: MIN_CALL_SPACING_MS + 2 * PIPELINE_MS,
  // The switch handoff: the outgoing capture takes the first slot of the second and
  // the incoming one takes the second slot CALL_MIN_GAP_MS later, NOT a whole extra
  // spacing later.
  panelDeliberateP50: CALL_MIN_GAP_MS + PIPELINE_MS,
  panelDeliberateP90: CALL_MIN_GAP_MS + 2 * PIPELINE_MS,
  // Clicked through without pausing, this is the one saturated scenario: each click
  // asks for TWO captures (the tab being left and the tab being entered) at a rate
  // faster than any budget of ~2 calls per second can serve, so the worker refuses
  // some outgoing captures as `busy` and the rest of the time the incoming preview
  // lands a spacing behind an outgoing one that itself waited for a slot. The median
  // is still one spacing; the tail is that pair, and it is bounded, not open-ended.
  panelRapidP50: MIN_CALL_SPACING_MS + PIPELINE_MS,
  panelRapidP90: MIN_CALL_SPACING_MS + CALL_WINDOW_MS,
  // The other window's capture is debounced too, then holds the full spacing. The p90
  // additionally carries ONE quota retry, because this is the scenario spec-addendum
  // A29 says will occasionally be refused: two windows asking in the same tick is the
  // densest demand the limiter ever sees, a refusal costs exactly QUOTA_RETRY_MS, and
  // the preview still arrives (`missing` is asserted separately and stays 0).
  // Measured: medians 1495-1667 with refused samples landing at 3093 and 3895.
  contendedP50: ACTIVATED_DELAY_MS + MIN_CALL_SPACING_MS + PIPELINE_MS,
  contendedP90: ACTIVATED_DELAY_MS + MIN_CALL_SPACING_MS + PIPELINE_MS + QUOTA_RETRY_MS,
};

/**
 * Asserts one scenario: no activation went without a preview, and the distribution
 * sits under the bounds above.
 * @param {ReturnType<typeof summarize>} stats
 * @param {number} p50 @param {number} p90
 */
function expectWithin(stats, p50, p90) {
  expect(stats.missing, `${stats.label}: every activation stored a preview`).toBe(0);
  expect(stats.p50, `${stats.label} median`).toBeLessThanOrEqual(p50);
  expect(stats.p90, `${stats.label} p90`).toBeLessThanOrEqual(p90);
  expect(stats.max, `${stats.label} worst case`).toBeLessThanOrEqual(p90 + STALL_ALLOWANCE_MS);
}

/* ── Measurement primitives ───────────────────────────────────────────────────── */

/**
 * Runs one activation inside the panel page and returns the wall-clock time until
 * the thumbnail for that tab is stored.
 *
 * `mode: 'panel'` uses `window.__vt.activate()` — the panel's real click path,
 * including the A12 `before-switch` capture of the outgoing tab. `mode: 'native'`
 * calls `chrome.tabs.update({active:true})` directly, which is what Ctrl+Tab and
 * the native tab strip do.
 */
const MEASURE_IN_PANEL = async (arg) => {
  const { tabId, urlKey, mode, timeoutMs, alsoActivate } = arg;
  let t0 = 0;
  // Every worker broadcast seen while waiting, so an outlier can be explained
  // instead of guessed at.
  const events = [];
  const landed = new Promise((resolve) => {
    const onMessage = (msg) => {
      if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('vt/')) return;
      events.push({
        t: Date.now() - t0,
        type: msg.type.replace('vt/', ''),
        tabId: msg.tabId ?? null,
        reason: msg.reason ?? null,
      });
      if (msg.type !== 'vt/thumb-updated') return;
      if (msg.urlKey !== urlKey || msg.tabId !== tabId) return;
      if (!(msg.capturedAt >= t0)) return; // a broadcast from an earlier repetition
      chrome.runtime.onMessage.removeListener(onMessage);
      resolve({ at: Date.now(), capturedAt: msg.capturedAt });
    };
    chrome.runtime.onMessage.addListener(onMessage);
    setTimeout(() => {
      chrome.runtime.onMessage.removeListener(onMessage);
      resolve(null);
    }, timeoutMs);
  });

  t0 = Date.now();
  // A competing switch in another window, fired in the same tick so both jobs are
  // in the queue together.
  if (Number.isInteger(alsoActivate)) chrome.tabs.update(alsoActivate, { active: true }).catch(() => {});
  if (mode === 'panel') await window.__vt.activate(tabId);
  else await chrome.tabs.update(tabId, { active: true });
  const switched = Date.now() - t0;

  const hit = await landed;
  if (!hit) return { stored: null, captured: null, switched, events };
  return { stored: hit.at - t0, captured: hit.capturedAt - t0, switched, events };
};

/** @param {number[]} values @param {number} p */
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

function summarize(label, samples) {
  const stored = samples.map((s) => s.stored);
  const missing = stored.filter((v) => v == null).length;
  const values = stored.filter((v) => v != null);
  const captured = samples.map((s) => s.captured).filter((v) => v != null);
  const stats = {
    label,
    n: samples.length,
    missing,
    min: values.length ? Math.min(...values) : null,
    p50: values.length ? percentile(values, 0.5) : null,
    p90: values.length ? percentile(values, 0.9) : null,
    max: values.length ? Math.max(...values) : null,
    mean: values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null,
    capturedP50: captured.length ? percentile(captured, 0.5) : null,
    all: values,
  };
  // Printed so the distribution is in the run log, not only in the assertion text.
  const switched = samples.map((s) => s.switched).filter((v) => v != null);
  console.log(`[latency] ${label} n=${stats.n} missing=${stats.missing} ` +
    `min=${stats.min} p50=${stats.p50} p90=${stats.p90} max=${stats.max} mean=${stats.mean} ` +
    `capturedP50=${stats.capturedP50} switchP50=${switched.length ? percentile(switched, 0.5) : null} ` +
    `samples=${JSON.stringify(values)}`);
  // Any sample far off the median gets its broadcast trace printed, so a slow run
  // can be attributed rather than explained away.
  const limit = stats.p50 == null ? Infinity : Math.max(2 * stats.p50, stats.p50 + 800);
  samples.forEach((s, i) => {
    if (s.stored != null && s.stored <= limit) return;
    console.log(`[outlier] ${label}#${i} stored=${s.stored} switched=${s.switched} ` +
      `events=${JSON.stringify(s.events || [])}`);
  });
  return stats;
}

function logVolume(label, before, after, thumbs) {
  const delta = (key) => (after.captures[key] || 0) - (before.captures[key] || 0);
  const reasons = {};
  for (const [key, value] of Object.entries(after.captures.byReason || {})) {
    const d = value - ((before.captures.byReason || {})[key] || 0);
    if (d) reasons[key] = d;
  }
  console.log(`[volume] ${label} ok=+${delta('ok')} failed=+${delta('failed')} ` +
    `skipped=+${delta('skipped')} rechecks=+${delta('rechecks')} ` +
    `quotaRejections=${after.captures.quotaRejections || 0} ` +
    `byReason.quota=${after.captures.byReason.quota || 0} ` +
    `reasonDelta=${JSON.stringify(reasons)} ` +
    `storedThumbs=${thumbs.count} bytes=${thumbs.bytes} ` +
    `lastError=${JSON.stringify(String(after.lastError || ''))}`);
}

/** Long enough that the limiter is idle and no follow-up job is still pending. */
const IDLE_GAP_MS = 2500;

/** urlKey of each tab, as the extension computes it. */
async function keysOf(panel, tabIds) {
  const keys = {};
  for (const id of tabIds) {
    keys[id] = await panel.evaluate(async (tabId) => {
      const tab = await chrome.tabs.get(tabId);
      return window.__vt.urlKey(tab.url || tab.pendingUrl || '');
    }, id);
  }
  return keys;
}

/**
 * Gives every tab a preview and leaves a known tab active.
 *
 * Without this the panel asks for the missing previews itself (`visible-missing`,
 * 100 ms) and the first measurements time a different code path than the one under
 * test. It also returns the rotation to start from, so the first repetition never
 * "switches" to the tab that is already active — which fires no `tabs.onActivated`
 * at all and would look like a lost preview.
 */
async function warmUp(panel, serviceWorker, windowId, tabIds, keys) {
  for (const id of tabIds) {
    await swEval(serviceWorker, (tabId) => chrome.tabs.update(tabId, { active: true }), id);
    await waitForThumb(panel, keys[id], { timeout: 45_000 });
    await sleep(IDLE_GAP_MS);
  }
  const activeId = await swEval(serviceWorker, async (wid) => {
    const [tab] = await chrome.tabs.query({ active: true, windowId: wid });
    return tab ? tab.id : null;
  }, windowId);
  const start = tabIds.indexOf(activeId);
  // Rotate so index 0 is the tab AFTER the one that is active now.
  const from = start >= 0 ? start + 1 : 0;
  return tabIds.map((_, i) => tabIds[(from + i) % tabIds.length]);
}

/* ── Tests ────────────────────────────────────────────────────────────────────── */

test.describe('preview latency', () => {
  test.beforeEach(async ({ serviceWorker }) => {
    // The periodic refresh alarm would inject captures the measurement did not ask
    // for; the contention scenario below creates its competition explicitly.
    await setSettings(serviceWorker, { refreshInterval: 'off' });
  });

  test('switching to a tab stores its preview quickly, idle and back-to-back', async ({ harness, serviceWorker }) => {
    test.setTimeout(300_000);
    const { panel, w2, tabIds } = harness;
    const tabs = [tabIds.alpha, tabIds.beta, tabIds.gamma];
    for (const id of tabs) await waitForCard(panel, id);

    const keys = await keysOf(panel, tabs);
    const rotation = await warmUp(panel, serviceWorker, w2, tabs, keys);
    const before = await diagnostics(panel);

    // ── idle: the limiter has been free for >2 s before every activation
    const idle = [];
    for (let i = 0; i < 10; i += 1) {
      const tabId = rotation[i % rotation.length];
      await sleep(IDLE_GAP_MS);
      idle.push(await panel.evaluate(MEASURE_IN_PANEL, {
        tabId, urlKey: keys[tabId], mode: 'native', timeoutMs: 25_000, alsoActivate: null,
      }));
    }
    const idleStats = summarize('idle', idle);

    await sleep(IDLE_GAP_MS);

    // ── rapid: the next switch starts as soon as the previous preview lands
    const rapid = [];
    for (let i = 0; i < 12; i += 1) {
      const tabId = rotation[(i + 1) % rotation.length];
      rapid.push(await panel.evaluate(MEASURE_IN_PANEL, {
        tabId, urlKey: keys[tabId], mode: 'native', timeoutMs: 25_000, alsoActivate: null,
      }));
    }
    const rapidStats = summarize('rapid', rapid);

    const after = await diagnostics(panel);
    logVolume('idle+rapid', before, after, await thumbStats(panel));

    // Every activation produced a preview: the latency work never trades away a
    // capture the user was waiting for.
    expectWithin(idleStats, BOUND.idleP50, BOUND.idleP90);
    expectWithin(rapidStats, BOUND.rapidP50, BOUND.rapidP90);

    /* What the quota guarantee is, and what it is not.
     *
     * `quotaRejections` counts calls Chrome refused. It is NOT asserted to be zero,
     * and the honest reason is that it is no longer structurally zero: measured over
     * three isolated runs of this file, one run in three produced exactly one
     * rejection in ~22 calls while the emitted spacing was unchanged. The old flat
     * 1100 ms spacing had none, so this IS a real change, taken deliberately —
     * halving the switch latency the user reported is worth an occasional refusal
     * that costs one retry, and the panel-switch test below asserts the property
     * this extension actually controls (never three calls inside one second).
     *
     * The two guarantees that DO stay absolute are the ones a user can perceive:
     * a rejection must never survive its retries and reach a card
     * (`byReason.quota`), and `expectWithin` above has already required that every
     * single activation ended with a stored preview. A rejection is therefore a
     * delay of one retry for one capture, never a preview the user does not get.
     */
    expect(after.captures.byReason.quota || 0).toBe(0);
  });

  test('a switch made from the panel is not starved by the outgoing capture', async ({ harness, serviceWorker }) => {
    test.setTimeout(300_000);
    const { panel, w2, tabIds } = harness;
    const tabs = [tabIds.alpha, tabIds.beta, tabIds.gamma];
    for (const id of tabs) await waitForCard(panel, id);

    const keys = await keysOf(panel, tabs);
    const rotation = await warmUp(panel, serviceWorker, w2, tabs, keys);

    // Record when the worker ACTUALLY calls captureVisibleTab, so the scheduling
    // invariant can be asserted directly instead of being inferred from whether
    // Chrome happened to reject a call. Installed after the warm-up so only the
    // measured switches are counted. `capture.js` resolves the method off
    // `chrome.tabs` at each call, so wrapping the property is enough.
    await swEval(serviceWorker, () => {
      if (self.__vtCalls) { self.__vtCalls.length = 0; return; }
      self.__vtCalls = [];
      const original = chrome.tabs.captureVisibleTab.bind(chrome.tabs);
      chrome.tabs.captureVisibleTab = (...args) => {
        self.__vtCalls.push(Date.now());
        return original(...args);
      };
    });

    const before = await diagnostics(panel);

    // `window.__vt.activate()` is the panel's own click path: it asks the worker to
    // capture the OUTGOING tab first (A12) and only then switches. After a pause the
    // limiter is free, so that capture really happens and the incoming tab has to
    // share the second with it — the case the user is most likely to notice, because
    // it is what clicking through a vertical tab list looks like.
    const deliberate = [];
    for (let i = 0; i < 10; i += 1) {
      const tabId = rotation[i % rotation.length];
      await sleep(IDLE_GAP_MS);
      deliberate.push(await panel.evaluate(MEASURE_IN_PANEL, {
        tabId, urlKey: keys[tabId], mode: 'panel', timeoutMs: 25_000, alsoActivate: null,
      }));
    }
    const deliberateStats = summarize('panel-deliberate', deliberate);

    await sleep(IDLE_GAP_MS);

    const rapid = [];
    for (let i = 0; i < 10; i += 1) {
      const tabId = rotation[(i + 1) % rotation.length];
      rapid.push(await panel.evaluate(MEASURE_IN_PANEL, {
        tabId, urlKey: keys[tabId], mode: 'panel', timeoutMs: 25_000, alsoActivate: null,
      }));
    }
    const rapidStats = summarize('panel-rapid', rapid);

    const after = await diagnostics(panel);
    logVolume('panel-switch', before, after, await thumbStats(panel));

    expectWithin(deliberateStats, BOUND.panelDeliberateP50, BOUND.panelDeliberateP90);
    expectWithin(rapidStats, BOUND.panelRapidP50, BOUND.panelRapidP90);

    /* The scheduling invariant, asserted on the calls the worker really made.
     *
     * This replaces a bare `quotaRejections === 0` here, which asserted a property of
     * CHROME rather than of this extension. Measured: three consecutive isolated runs
     * of this test made ~85 calls with zero rejections, while two full-suite runs —
     * where the container has been busy for nine minutes — each produced exactly one,
     * with the same spacing being emitted. There is exactly one `captureVisibleTab`
     * call site (`capture.js`, guarded by `reserveSlot`), and `reserveSlot` re-reads
     * the wall clock in a loop, so the worker cannot issue a call early no matter how
     * badly a timer slips; a rejection under host load is Chrome charging its bucket
     * on its own schedule, which no amount of spacing on this side can guarantee away.
     *
     * So assert what this extension controls — the emitted pattern — and keep the
     * user-visible guarantees strict: `byReason.quota` (a rejection that survived the
     * retries and reached the card) must still be zero, and `expectWithin` above has
     * already required that every switch stored its preview.
     */
    const callTimes = await swEval(serviceWorker, () => (self.__vtCalls || []).slice());
    expect(callTimes.length, 'the measured switches issued captures').toBeGreaterThan(10);

    /* Two checks, and they are not equally strong.
     *
     * The spacing check below is written against `CALL_MIN_GAP_MS`, so it moves when
     * that constant moves and cannot catch a change to the constant itself — what it
     * catches is a SCHEDULER that ignores its own spacing (a `reserveSlot` that stops
     * waiting would emit gaps near zero while the constant still read 450).
     *
     * The calls-per-second check that follows is the absolute one: "no more than two
     * inside any one second" is Chrome's rule, not ours, so it is written as a literal
     * and holds whatever the constants say. Verified by mutation — dropping the
     * spacing to 300 ms and the window to 600 ms made the worker emit three calls a
     * second and produced nine quota rejections and a failing run.
     */
    const gaps = callTimes.slice(1).map((t, i) => t - callTimes[i]);
    // Timer resolution and the `Date.now()` read inside the wrapper, not scheduling slack.
    const CLOCK_SLOP_MS = 20;
    expect(Math.min(...gaps), `closest two calls (gaps: ${gaps.join(', ')})`)
      .toBeGreaterThanOrEqual(CALL_MIN_GAP_MS - CLOCK_SLOP_MS);

    let worstPerSecond = 0;
    for (let i = 0; i < callTimes.length; i += 1) {
      let n = 0;
      for (let j = i; j < callTimes.length && callTimes[j] - callTimes[i] < 1000; j += 1) n += 1;
      if (n > worstPerSecond) worstPerSecond = n;
    }
    expect(worstPerSecond, 'most calls inside any one second').toBeLessThanOrEqual(2);

    expect(after.captures.byReason.quota || 0).toBe(0);
  });

  test('a second window switching at the same moment does not double the wait', async ({ harness, serviceWorker, fixtures }) => {
    test.setTimeout(300_000);
    const { panel, w2, tabIds } = harness;
    const tabs = [tabIds.alpha, tabIds.beta, tabIds.gamma];
    for (const id of tabs) await waitForCard(panel, id);

    const keys = await keysOf(panel, tabs);
    const rotation = await warmUp(panel, serviceWorker, w2, tabs, keys);

    // A third window with two pages of its own, so it can switch tabs too.
    const third = await swEval(serviceWorker, async (urls) => {
      const w = await chrome.windows.create({ url: urls, focused: false, width: 900, height: 700 });
      return { windowId: w.id, tabIds: (w.tabs || []).map((t) => t.id) };
    }, [fixtures.page('202080', 'Third-A'), fixtures.page('208020', 'Third-B')]);
    expect(third.tabIds).toHaveLength(2);

    await sleep(IDLE_GAP_MS * 2);
    const before = await diagnostics(panel);

    // Twelve, not eight. `percentile` indexes at `ceil(p * n) - 1`, so at n = 8 the
    // 90th percentile IS the maximum (index 7 of 8) and the single host stall this
    // file documents — roughly one repetition in ten losing several seconds below the
    // extension, with no capture activity in the trace — lands squarely on p90 instead
    // of on `max`, where STALL_ALLOWANCE_MS is meant to absorb it. That defeats the
    // split this file is built on: p50/p90 catch a systematic regression, `max` tolerates
    // one hiccup. At n = 12 p90 is the 11th value, so one stall stays above it, exactly
    // as it already does for the n = 10 and n = 12 scenarios above. More samples, same
    // bounds — the assertion is strengthened, not relaxed.
    const samples = [];
    for (let i = 0; i < 12; i += 1) {
      const tabId = rotation[i % rotation.length];
      // Alternates, so the competing window really switches tabs every time.
      const competitor = third.tabIds[(i + 1) % 2];
      await sleep(IDLE_GAP_MS);
      samples.push(await panel.evaluate(MEASURE_IN_PANEL, {
        tabId, urlKey: keys[tabId], mode: 'native', timeoutMs: 25_000, alsoActivate: competitor,
      }));
    }
    const stats = summarize('contended', samples);

    const after = await diagnostics(panel);
    logVolume('contended', before, after, await thumbStats(panel));

    expectWithin(stats, BOUND.contendedP50, BOUND.contendedP90);

    // As in the idle test: a refusal Chrome charges under load is tolerated because
    // it is retried, but one that reaches a card is not, and every switch above had
    // to end with a stored preview.
    expect(after.captures.byReason.quota || 0).toBe(0);
  });
});
