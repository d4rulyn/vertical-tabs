// 92-recent-paint-probe — WHICH write puts the stale list on screen.
//
// Probe 9 ruled out the platform: Chrome's `lastAccessed` was correct in 135 of 135
// activations. The remaining question is inside the panel. Adding a `paintToken` guard to
// `recent.js` did NOT stop the stale row appearing, so the write is not coming from the
// path that guard covers, and guessing again would be the third guess in a row.
//
// This records, for one run of the failing sequence:
//   - every `chrome.tabs.query` the panel makes: who called it, which tab was active in
//     the result, and when it was issued vs. when it resolved
//   - every time the rendered recent-row set actually CHANGES, with the new first row
//   - how many recent-list containers exist (a second, leaked mount would explain a write
//     that no token in the live closure can stop)
//
// Run:
//   HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose -f tests/docker-compose.yml \
//     run --rm e2e env VT_TEST_DIR=./probes playwright test 92-recent-paint-probe.spec.js \
//     --reporter=line --retries=0
'use strict';

const fs = require('fs');
const path = require('path');
const { test, expect } = require('../fixtures');
const { swEval, setSettings, sleep } = require('../helpers/chrome');

const OUT = process.env.OUT_DIR || path.resolve(__dirname, '../output');
const REPORT = path.join(OUT, 'recent-paint-probe.json');
const RECENT_ROWS = '[data-testid="widget-recent-row"]';

test('where the stale recent list is written from', async ({ harness, serviceWorker }) => {
  test.setTimeout(300_000);
  const { panel, tabIds } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off', widgets: ['recent'] });
  await expect.poll(async () => panel.locator(RECENT_ROWS).count(), { timeout: 15_000 })
    .toBeGreaterThan(0);

  await panel.evaluate(() => {
    const T0 = performance.now();
    const w = { queries: [], writes: [], mounts: [] };
    window.__probe = w;

    const real = chrome.tabs.query.bind(chrome.tabs);
    let n = 0;
    chrome.tabs.query = async (info) => {
      const id = (n += 1);
      const stack = new Error().stack || '';
      const caller = (stack.split('\n').slice(1).find((l) => l.includes('sidepanel')) || '?').trim();
      const issued = performance.now() - T0;
      const tabs = await real(info);
      const active = tabs.find((t) => t.active);
      w.queries.push({
        id,
        fromRecentJs: stack.includes('recent.js'),
        caller,
        issued: Math.round(issued),
        resolved: Math.round(performance.now() - T0),
        activeInResult: active ? active.id : null,
      });
      return tabs;
    };

    const signature = () => Array.from(
      document.querySelectorAll('[data-testid="widget-recent-row"]'),
    ).map((el) => el.dataset.recentTab).join(',');

    let last = signature();
    w.writes.push({ at: 0, rows: last, lists: document.querySelectorAll('[data-testid="widget-recent-list"]').length });
    new MutationObserver(() => {
      const now = signature();
      if (now === last) return;
      last = now;
      w.writes.push({
        at: Math.round(performance.now() - T0),
        rows: now,
        lists: document.querySelectorAll('[data-testid="widget-recent-list"]').length,
      });
    }).observe(document.body, { childList: true, subtree: true });
  });

  const activate = (id) => swEval(serviceWorker,
    async (tabId) => { await chrome.tabs.update(tabId, { active: true }); }, id);

  for (const id of [tabIds.gamma, tabIds.alpha, tabIds.beta]) {
    await activate(id);
    await sleep(1100);
  }
  // Well past anything the panel could still be waiting on.
  await sleep(4000);

  const data = await panel.evaluate(() => window.__probe);
  const report = {
    tabIds: { alpha: tabIds.alpha, beta: tabIds.beta, gamma: tabIds.gamma },
    expectedFirstRow: tabIds.alpha,
    finalRows: await panel.$$eval(RECENT_ROWS, (els) => els.map((e) => e.dataset.recentTab)),
    listContainers: await panel.$$eval('[data-testid="widget-recent-list"]', (els) => els.length),
    recentQueries: data.queries.filter((q) => q.fromRecentJs),
    otherQueries: data.queries.filter((q) => !q.fromRecentJs).length,
    writes: data.writes,
  };

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log('[recent-paint] alpha=%s beta=%s gamma=%s', tabIds.alpha, tabIds.beta, tabIds.gamma);
  console.log('[recent-paint] finalRows=%s listContainers=%s',
    report.finalRows.join(','), report.listContainers);
  console.log('[recent-paint] recent.js queries:');
  for (const q of report.recentQueries) {
    console.log(`   #${q.id} issued=${q.issued} resolved=${q.resolved} active=${q.activeInResult}`);
  }
  console.log('[recent-paint] row-set changes:');
  for (const wr of report.writes) console.log(`   at=${wr.at} lists=${wr.lists} rows=[${wr.rows}]`);
  console.log(`[recent-paint] wrote ${REPORT}`);
});
