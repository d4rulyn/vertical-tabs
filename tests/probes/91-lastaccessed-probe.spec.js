// 91-lastaccessed-probe — why `30-windows-recent.spec.js:64` fails in full runs only.
//
// This is NOT a regression test. It measures Chromium 151.0.7922.34, because
// CLAUDE.md forbids asserting Chrome API behaviour from memory.
//
// The symptom: the "recently used" tool sorts a fresh `chrome.tabs.query` by
// `tab.lastAccessed` (extension/sidepanel/widgets/recent.js). The spec activates
// gamma, alpha, beta 1100 ms apart and expects the top row to be alpha. In whole-suite
// runs it is sometimes gamma — the tab activated FIRST. A 15 s poll does not rescue it,
// so the state is stably wrong rather than late: alpha's `lastAccessed` never overtook
// gamma's. Either the activation did not happen, or it happened without moving
// `lastAccessed`.
//
// The three tests differ only in which window has focus, because that is the one thing
// a whole-suite run changes about this scenario: earlier specs create and focus other
// windows, and nothing puts focus back.
//
//   A  leave focus wherever the harness left it (what the real spec does)
//   B  focus W1 first, so the tabs being activated are in a BACKGROUND window
//   C  focus W2 first, so they are in the FOREGROUND window
//
// Each round replays the spec's own sequence and records, per activation:
//   - did `tabs.update(id, {active:true})` actually set `active`?
//   - did `lastAccessed` move, immediately and after the 1100 ms gap?
//   - is the final order by `lastAccessed` the one the spec asserts?
//
// Output: tests/output/lastaccessed-probe.json, plus a printed summary.
//
// Run:
//   HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose -f tests/docker-compose.yml \
//     run --rm e2e env VT_TEST_DIR=./probes playwright test 91-lastaccessed-probe.spec.js \
//     --reporter=line --retries=0
'use strict';

const fs = require('fs');
const path = require('path');
const { test, expect } = require('../fixtures');
const { swEval, sleep } = require('../helpers/chrome');

const OUT = process.env.OUT_DIR || path.resolve(__dirname, '../output');
const REPORT = path.join(OUT, 'lastaccessed-probe.json');

/** The spec sleeps 1100 ms between activations so the access times cannot tie. */
const GAP_MS = 1100;
/** Enough rounds to see an intermittent miss without the probe outlasting the suite. */
const ROUNDS = 15;

/** Every tab in W2, with only the two fields this question is about. */
async function readTabs(sw, windowId) {
  return swEval(sw, async (id) => {
    const tabs = await chrome.tabs.query({ windowId: id });
    return tabs.map((t) => ({ id: t.id, active: t.active, lastAccessed: t.lastAccessed }));
  }, windowId);
}

async function focusedWindowId(sw) {
  return swEval(sw, async () => {
    try {
      return (await chrome.windows.getLastFocused()).id;
    } catch (e) {
      return null;
    }
  });
}

/**
 * One replay of the spec's sequence. Returns what happened, never asserts: a probe that
 * throws on the first anomaly measures nothing about how often the anomaly happens.
 */
async function round(sw, w2, order) {
  const steps = [];
  for (const tabId of order) {
    const before = (await readTabs(sw, w2)).find((t) => t.id === tabId) || null;

    const updated = await swEval(sw, async (id) => {
      try {
        const t = await chrome.tabs.update(id, { active: true });
        return { ok: true, active: t.active, lastAccessed: t.lastAccessed };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    }, tabId);

    // Immediately: does the value the update RESOLVED with already carry the new time?
    const immediate = (await readTabs(sw, w2)).find((t) => t.id === tabId) || null;
    await sleep(GAP_MS);
    const settled = (await readTabs(sw, w2)).find((t) => t.id === tabId) || null;

    steps.push({
      tabId,
      updated,
      beforeLastAccessed: before ? before.lastAccessed : null,
      immediate,
      settled,
      becameActive: !!(settled && settled.active),
      advancedImmediately: !!(before && immediate
        && typeof before.lastAccessed === 'number' && typeof immediate.lastAccessed === 'number'
        && immediate.lastAccessed > before.lastAccessed),
      advancedBySettle: !!(before && settled
        && typeof before.lastAccessed === 'number' && typeof settled.lastAccessed === 'number'
        && settled.lastAccessed > before.lastAccessed),
    });
  }

  const final = await readTabs(sw, w2);
  const byRecency = final
    .filter((t) => typeof t.lastAccessed === 'number')
    .sort((a, b) => b.lastAccessed - a.lastAccessed)
    .map((t) => t.id);

  return { steps, final, byRecency, focusedAtEnd: await focusedWindowId(sw) };
}

/** What the widget would show: everything but the active tab, most recent first. */
function widgetRows(final) {
  return final
    .filter((t) => !t.active && typeof t.lastAccessed === 'number')
    .sort((a, b) => b.lastAccessed - a.lastAccessed)
    .map((t) => t.id);
}

const results = {};

async function measure(name, { harness, serviceWorker }, prepare) {
  const { w2, tabIds } = harness;
  const order = [tabIds.gamma, tabIds.alpha, tabIds.beta];
  const expectedTop = tabIds.alpha;

  const focusBefore = await focusedWindowId(serviceWorker);
  const prepared = prepare ? await prepare(serviceWorker, harness) : null;

  const rounds = [];
  for (let i = 0; i < ROUNDS; i++) {
    // Re-assert the focus condition each round: activating a tab can move focus, and a
    // condition that only holds for round 1 is not the condition being measured.
    if (prepare) await prepare(serviceWorker, harness);
    rounds.push(await round(serviceWorker, w2, order));
  }

  const misses = rounds.filter((r) => widgetRows(r.final)[0] !== expectedTop);
  const notActivated = rounds.flatMap((r) => r.steps.filter((s) => !s.becameActive));
  const notAdvanced = rounds.flatMap((r) => r.steps.filter((s) => !s.advancedBySettle));
  const updateErrors = rounds.flatMap((r) => r.steps.filter((s) => !s.updated.ok));

  results[name] = {
    w2,
    tabIds: { alpha: tabIds.alpha, beta: tabIds.beta, gamma: tabIds.gamma },
    expectedTop,
    focusedWindowBeforePrepare: focusBefore,
    prepared,
    rounds: ROUNDS,
    wrongTopRow: misses.length,
    activationsThatDidNotStick: notActivated.length,
    activationsThatDidNotMoveLastAccessed: notAdvanced.length,
    updateCallsThatThrew: updateErrors.length,
    // Keep only the rounds that went wrong; 15 full traces of nothing happening is noise.
    failingRounds: misses.slice(0, 5),
    sampleRound: rounds[0],
  };

  console.log(`[lastAccessed:${name}] rounds=${ROUNDS} wrongTopRow=${misses.length} ` +
    `notActivated=${notActivated.length} lastAccessedDidNotMove=${notAdvanced.length} ` +
    `updateThrew=${updateErrors.length} focusBefore=${focusBefore} w2=${w2}`);
}

test.afterAll(() => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(results, null, 2));
  console.log(`[lastAccessed] wrote ${REPORT}`);
});

test('A: focus left where the harness put it — the real spec\'s conditions', async ({
  harness, serviceWorker,
}) => {
  test.setTimeout(600_000);
  await measure('A-harness-default-focus', { harness, serviceWorker }, null);
  expect(results['A-harness-default-focus'].rounds).toBe(ROUNDS);
});

test('B: the tabs are in a BACKGROUND window', async ({ harness, serviceWorker }) => {
  test.setTimeout(600_000);
  await measure('B-w2-in-background', { harness, serviceWorker }, async (sw) => swEval(sw, async () => {
    const ws = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const other = ws.map((w) => w.id).sort((a, b) => a - b)[0];
    await chrome.windows.update(other, { focused: true });
    return { focusedTo: other, windows: ws.map((w) => w.id) };
  }));
  expect(results['B-w2-in-background'].rounds).toBe(ROUNDS);
});

test('C: the tabs are in the FOREGROUND window', async ({ harness, serviceWorker }) => {
  test.setTimeout(600_000);
  await measure('C-w2-in-foreground', { harness, serviceWorker }, async (sw, h) => swEval(sw, async (id) => {
    await chrome.windows.update(id, { focused: true });
    return { focusedTo: id };
  }, h.w2));
  expect(results['C-w2-in-foreground'].rounds).toBe(ROUNDS);
});
