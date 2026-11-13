// 93-recent-guard-probe — does the paintToken guard actually DROP the stale write?
//
// Probe 92 showed two recent.js paints per activation, issued 15-40 ms apart, with
// resolve times that vary enough to invert. So overlapping paints are real. What is not
// established is why adding `paintToken` to recent.js did not stop the stale row: the
// guard was in place and `30-windows-recent.spec.js` still reported gamma.
//
// Three outcomes are possible and they need different fixes, so this distinguishes them
// by watching WHEN the rendered row set changes:
//
//   (i)  a write lands ~2500 ms after alpha with alpha-era rows -> the guard did not drop
//        the superseded paint; the token is not doing what it looks like it does
//   (ii) no write lands at beta time at all -> the beta repaint never ran or was itself
//        dropped, and the screen simply kept the alpha-era list
//   (iii) writes land correctly and the final list is right -> the scenario did not
//        reproduce here and the earlier failure came from something else
//
// Run:
//   HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose -f tests/docker-compose.yml \
//     run --rm e2e env VT_TEST_DIR=./probes playwright test 93-recent-guard-probe.spec.js \
//     --reporter=line --retries=0
'use strict';

const fs = require('fs');
const path = require('path');
const { test, expect } = require('../fixtures');
const { swEval, setSettings, sleep } = require('../helpers/chrome');

const OUT = process.env.OUT_DIR || path.resolve(__dirname, '../output');
const REPORT = path.join(OUT, 'recent-guard-probe.json');
const RECENT_ROWS = '[data-testid="widget-recent-row"]';
const HOLD_MS = 2500;

test('does the guard drop a superseded paint', async ({ harness, serviceWorker }) => {
  test.setTimeout(300_000);
  const { panel, tabIds } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off', widgets: ['recent'] });
  await expect.poll(async () => panel.locator(RECENT_ROWS).count(), { timeout: 15_000 })
    .toBeGreaterThan(0);

  await panel.evaluate((holdMs) => {
    const T0 = performance.now();
    const w = {
      t0: T0, queries: [], writes: [], arm: false, held: 0, released: 0,
      activeInHeldSnapshot: null, heldIssuedAt: null, heldReleasedAt: null,
    };
    window.__probe = w;

    const real = chrome.tabs.query.bind(chrome.tabs);
    let n = 0;
    chrome.tabs.query = async (info) => {
      const id = (n += 1);
      const stack = new Error().stack || '';
      const fromRecent = stack.includes('recent.js');
      const mine = w.arm && fromRecent;
      if (mine) { w.arm = false; w.held += 1; w.heldIssuedAt = Math.round(performance.now() - T0); }
      const issued = Math.round(performance.now() - T0);
      const tabs = await real(info);
      const active = tabs.find((t) => t.active);
      if (mine) {
        w.activeInHeldSnapshot = active ? active.id : null;
        await new Promise((r) => setTimeout(r, holdMs));
        w.released += 1;
        w.heldReleasedAt = Math.round(performance.now() - T0);
      }
      w.queries.push({
        id, fromRecent, held: mine, issued,
        resolved: Math.round(performance.now() - T0),
        activeInResult: active ? active.id : null,
      });
      return tabs;
    };

    const signature = () => Array.from(
      document.querySelectorAll('[data-testid="widget-recent-row"]'),
    ).map((el) => el.dataset.recentTab).join(',');
    let last = signature();
    w.writes.push({ at: 0, rows: last });
    new MutationObserver(() => {
      const now = signature();
      if (now === last) return;
      last = now;
      w.writes.push({ at: Math.round(performance.now() - T0), rows: now });
    }).observe(document.body, { childList: true, subtree: true });
  }, HOLD_MS);

  const activate = (id) => swEval(serviceWorker,
    async (tabId) => { await chrome.tabs.update(tabId, { active: true }); }, id);

  await activate(tabIds.gamma);
  await sleep(1100);
  await panel.evaluate(() => { window.__probe.arm = true; });
  await activate(tabIds.alpha);
  await sleep(1100);
  await activate(tabIds.beta);
  // Past the hold, with room to spare.
  await sleep(HOLD_MS + 3000);

  const data = await panel.evaluate(() => window.__probe);
  const report = {
    tabIds: { alpha: tabIds.alpha, beta: tabIds.beta, gamma: tabIds.gamma },
    expectedFirstRow: tabIds.alpha,
    finalRows: await panel.$$eval(RECENT_ROWS, (els) => els.map((e) => e.dataset.recentTab)),
    held: data.held,
    released: data.released,
    activeInHeldSnapshot: data.activeInHeldSnapshot,
    heldIssuedAt: data.heldIssuedAt,
    heldReleasedAt: data.heldReleasedAt,
    recentQueries: data.queries.filter((q) => q.fromRecent),
    writes: data.writes,
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));

  console.log('[guard] alpha=%s beta=%s gamma=%s', tabIds.alpha, tabIds.beta, tabIds.gamma);
  console.log('[guard] held=%s released=%s heldSnapshotActive=%s issuedAt=%s releasedAt=%s',
    report.held, report.released, report.activeInHeldSnapshot,
    report.heldIssuedAt, report.heldReleasedAt);
  console.log('[guard] finalRows=[%s]  expectedFirst=%s', report.finalRows.join(','), tabIds.alpha);
  console.log('[guard] recent.js queries:');
  for (const q of report.recentQueries) {
    console.log(`   #${q.id} held=${q.held} issued=${q.issued} resolved=${q.resolved} active=${q.activeInResult}`);
  }
  console.log('[guard] row-set changes:');
  for (const wr of report.writes) console.log(`   at=${wr.at} rows=[${wr.rows}]`);
  console.log(`[guard] wrote ${REPORT}`);
});
