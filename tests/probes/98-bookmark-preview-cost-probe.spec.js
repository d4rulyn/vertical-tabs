// 98-bookmark-preview-cost-probe — what a hover costs when the folder has 1 000 links (G12).
//
// ── PASS CRITERIA, written before the first run ────────────────────────────────────────────
// The number is DESIGN.md's G12, unchanged: "With 1 000 seeded links in one open folder: ...
// hover-to-card <= 50 ms p95 after the 350 ms delay". Nothing below was chosen after seeing a
// measurement, and nothing may be changed to fit one.
//
//   Setup   one folder (the Bookmarks bar) with 1 000 links, ALL of them rendered as rows (the
//           column draws 150 at a time as the rail is scrolled); one in three has a stored
//           screenshot, so both kinds of lookup (`loaded`, `none`) are in the sample.
//   Clock   `performance.now()` inside the panel, read at the `pointerover` that enters a link
//           row and when the card enters the DOM. Playwright's round trips are not in it.
//   (1) FRESH     60 hovers, each on a different row spread over the whole list, each started
//                 from a pointer that has been away for more than the 400 ms hurry window, so
//                 the card waits the full SHOW_DELAY_MS = 350 ms.
//                 cost = (card time - pointerover time) - 350.   PASS iff p95(cost) <= 50 ms.
//   (2) HURRIED   40 moves from one row straight onto the next, within the hurry window, so the
//                 card is immediate.   cost = card time - pointerover time.   PASS iff p95 <= 50 ms.
//   Complete      60 and 40 samples, 1 000 rows in the DOM, and every sample answered with a
//                 card; otherwise the probe has not produced its table and says so.
//
// What this probe does NOT measure, said plainly: DESIGN G12 also lists "one `getChildren` per
// drop" and "`dragover` handler <= 4 ms p95". Both belong to the drag-and-drop part of the
// bookmark editing design; PR #22 has no drag and no drop, so there is nothing to measure.
//
// The host is busy (other jobs share it), so the load average is recorded with the result, at
// the start and the end. A miss under a load average above the core count says as much about
// the host as about the code, and the report must say so; it does not move the criterion.
//
// The probe's own exit status says only that the table is complete. The VERDICT lines it
// prints say whether the criteria held. Raw samples: tests/output/bookmark-preview-cost-probe.json.
//
// DIAGNOSTIC (added after the first run; NOT a criterion, and the verdicts above are unchanged):
// the first run's FRESH numbers were dominated by how late the host ran a 350 ms timer, which
// says nothing about the extension. Every sample therefore also carries `timerLate`: how late a
// control `setTimeout(350)`, started at the same `pointerover` (and so fired just before the
// preview's own), actually fired, on the same clock. `own = cost - timerLate` is the cost with
// the host's scheduling lateness taken out. It is reported next to the verdict, never instead of it.
//
// PROCEDURE FIX (2026-11-05, after the first quiet-host run; the criterion, the 350 ms delay, the
// sample counts and the verdict rule are unchanged): `rowAt(i).hover()` scrolls the row into view and
// moves the mouse in the same frame, and the rail's `scroll` event is dispatched on the NEXT frame,
// after `pointerover` has armed the card's timer. bookmark-preview.js hides the card and clears that
// timer on a rail scroll (by design, `rail.addEventListener('scroll', hide)`), so on a quiet host the
// first hover that needed a scroll (row 33) never got a card: 3 of 3 runs, 20 s timeout, not a G12
// verdict. Under heavy load the scroll event happened to land first, which is why the earlier loaded
// runs did produce numbers. `reveal(i)` now scrolls the row to the middle of the rail and lets two
// frames pass before the pointer arrives. Predicted before the re-run: no hover waits 20 s for a card.
//
// RESULT on a quiet host (load 1.1-2.2 on 20 cores, control timer p95 0.2 ms), the probe alone, 3 runs,
// 2026-11-05 12:15-12:22 JST: FRESH p95 2.5 / 2.8 / 3.0 ms, HURRIED p95 5.6 / 4.6 / 5.0 ms, so G12
// PASSES in each run. NOT a criterion and NOT explained: one FRESH hover per run took far longer
// (max 528, 1100 and 3979.8 ms; the last was row 423, state `loaded`, its control timer 0.1 ms late, so
// the page was not blocked at 350 ms). One in 60 stays under the p95 rule; the cause is not known.
// The earlier runs at host load 63-106 had failed (p95 547-806 ms, control timer p95 351 ms).
//
// Run:
//   HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose -f tests/docker-compose.yml \
//     run --rm e2e env VT_TEST_DIR=./probes playwright test 98-bookmark-preview-cost-probe.spec.js \
//     --reporter=line --retries=0
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('../fixtures');
const { granted } = require('../helpers/bookmarks');
const P = require('../helpers/bookmark-preview');

const OUT = process.env.OUT_DIR || path.resolve(__dirname, '../output');
const REPORT = path.join(OUT, 'bookmark-preview-cost-probe.json');

const LINKS = 1000;
const FRESH_SAMPLES = 60;
const HURRIED_SAMPLES = 40;
const SHOW_DELAY_MS = 350; // bookmark-preview.js SHOW_DELAY_MS: the delay the criterion is "after"
const HURRY_WINDOW_MS = 400; // bookmark-preview.js HURRY_WINDOW_MS
const P95_LIMIT_MS = 50;

const ROWS = '[data-testid="bookmark-row"][data-kind="link"]';

/** Nearest-rank percentile of a list of numbers. */
function percentile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

function summary(values) {
  const r = (n) => (n == null ? null : Math.round(n * 10) / 10);
  return {
    n: values.length, p50: r(percentile(values, 0.5)), p95: r(percentile(values, 0.95)),
    max: r(values.length ? Math.max(...values) : null),
  };
}

granted('what a hover costs with 1 000 links in the open folder', async ({ harness, serviceWorker }) => {
  granted.setTimeout(900_000);
  const { panel } = harness;
  const loadStart = os.loadavg();

  const links = Array.from({ length: LINKS }, (_, i) => ({
    title: `Link ${String(i).padStart(4, '0')}`, url: `https://bulk.example.com/page/${i}`,
  }));
  await P.openColumn(harness, serviceWorker, links, { width: 460, height: 900 });

  // One in three has a stored screenshot: one JPEG, written under 334 keys by the panel, the
  // way the service worker writes them.
  const seeded = await panel.evaluate(async (a) => {
    const canvas = new OffscreenCanvas(640, 240);
    const g = canvas.getContext('2d');
    g.fillStyle = '#2a5db0';
    g.fillRect(0, 0, 640, 240);
    g.fillStyle = '#c0392b';
    g.fillRect(40, 90, 200, 70);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
    let n = 0;
    for (let i = 0; i < a.links; i += 3) {
      const url = `https://bulk.example.com/page/${i}`;
      await window.__vt.thumbStore.putThumb({
        urlKey: window.__vt.urlKey(url), url, title: 'seeded', capturedAt: Date.now(), lastUsedAt: Date.now(),
        width: 640, height: 240, bytes: blob.size, blob, avgColor: [42, 93, 176], uniform: false,
        tabId: null, windowId: null, atTop: true,
      });
      n += 1;
    }
    return n;
  }, { links: LINKS });

  // Draw all 1 000 rows: the column adds 150 whenever the sentinel under the list scrolls into view.
  const rows = panel.locator(ROWS);
  await expect.poll(async () => {
    await panel.evaluate(() => {
      const rail = document.getElementById('bookmark-rail');
      rail.scrollTop = rail.scrollHeight;
    });
    return rows.count();
  }, { timeout: 120_000, intervals: [500], message: `all ${LINKS} rows are in the DOM` }).toBe(LINKS);
  await panel.evaluate(() => { document.getElementById('bookmark-rail').scrollTop = 0; });

  // The recorder, in the page.
  await panel.evaluate((sel) => {
    const rec = { enters: [], cards: [], gone: [] };
    window.__g12 = rec;
    const isCard = (n) => n.nodeType === 1 && n.matches && n.matches(sel);
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) if (isCard(n)) rec.cards.push({ t: performance.now(), state: n.dataset.state || '' });
        for (const n of r.removedNodes) if (isCard(n)) rec.gone.push(performance.now());
      }
    }).observe(document.body, { childList: true });
    window.addEventListener('pointerover', (e) => {
      const row = e.target && e.target.closest ? e.target.closest('[data-bookmark-id][data-kind="link"]') : null;
      if (!row || (e.relatedTarget && row.contains(e.relatedTarget))) return;
      const enter = { t: performance.now(), id: row.dataset.bookmarkId, timerLate: null };
      rec.enters.push(enter);
      // The control timer (see the header): same delay, started first, so it fires first.
      setTimeout(() => { enter.timerLate = performance.now() - enter.t - 350; }, 350);
    }, true);
  }, P.PEEK);

  /** Everything the recorder has so far, cleared. */
  const drain = () => panel.evaluate(() => {
    const out = JSON.parse(JSON.stringify(window.__g12));
    window.__g12.enters.length = 0;
    window.__g12.cards.length = 0;
    window.__g12.gone.length = 0;
    return out;
  });

  const samples = [];
  const rowAt = (i) => rows.nth(i);
  // Bring row i to the middle of the rail and let the rail's `scroll` event land BEFORE the pointer
  // arrives (see PROCEDURE FIX in the header). Only the procedure changes; the criterion, the delay
  // and the sample counts do not.
  const reveal = async (i) => {
    await rowAt(i).evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await panel.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  };

  // (1) FRESH. A pointer that has been away for longer than the hurry window.
  const freshIdx = Array.from({ length: FRESH_SAMPLES }, (_, k) => Math.floor((k * (LINKS - 1)) / (FRESH_SAMPLES - 1)));
  for (const i of freshIdx) {
    await P.moveAway(panel);
    await P.observe(panel, HURRY_WINDOW_MS + 100);
    await reveal(i);
    await drain();
    await rowAt(i).hover();
    await expect(panel.locator(P.PEEK)).toBeVisible({ timeout: 20_000 });
    const rec = await drain();
    const enter = rec.enters[rec.enters.length - 1];
    const card = rec.cards.find((c) => enter && c.t >= enter.t);
    if (enter && card) {
      samples.push({
        kind: 'fresh', index: i, state: card.state, lag: card.t - enter.t, cost: card.t - enter.t - SHOW_DELAY_MS,
        timerLate: enter.timerLate, own: enter.timerLate == null ? null : card.t - enter.t - SHOW_DELAY_MS - enter.timerLate,
      });
    }
  }

  // (2) HURRIED. Straight from one row onto the next while a card is up.
  const hurriedIdx = Array.from({ length: HURRIED_SAMPLES }, (_, k) => 5 + k * 23);
  for (const i of hurriedIdx) {
    await P.moveAway(panel);
    await P.observe(panel, HURRY_WINDOW_MS + 100);
    await reveal(i);
    await rowAt(i).hover();
    await expect(panel.locator(P.PEEK)).toBeVisible({ timeout: 20_000 });
    await drain();
    await rowAt(i + 1).hover();
    await expect(panel.locator(P.PEEK)).toBeVisible({ timeout: 20_000 });
    // Wait for the NEW card, the one that follows the old one's removal.
    await expect.poll(async () => {
      const r = await panel.evaluate(() => ({ c: window.__g12.cards.length, e: window.__g12.enters.length }));
      return r.c >= 1 && r.e >= 1;
    }, { timeout: 20_000 }).toBe(true);
    const rec = await drain();
    const enter = rec.enters[rec.enters.length - 1];
    const card = rec.cards.find((c) => enter && c.t >= enter.t);
    const hurried = enter && rec.gone.some((t) => t <= enter.t + 5 && enter.t - t < HURRY_WINDOW_MS);
    if (enter && card && hurried) {
      samples.push({ kind: 'hurried', index: i + 1, state: card.state, lag: card.t - enter.t, cost: card.t - enter.t });
    }
  }
  await P.moveAway(panel);

  const loadEnd = os.loadavg();
  const fresh = samples.filter((s) => s.kind === 'fresh');
  const hurried = samples.filter((s) => s.kind === 'hurried');
  const costs = (list) => list.map((s) => s.cost);
  const byState = (list, state) => costs(list.filter((s) => s.state === state));
  const report = {
    criteria: {
      links: LINKS, freshSamples: FRESH_SAMPLES, hurriedSamples: HURRIED_SAMPLES, showDelayMs: SHOW_DELAY_MS,
      p95LimitMs: P95_LIMIT_MS, source: 'DESIGN.md G12, unchanged',
    },
    storedRecords: seeded,
    hostLoadavg: { cores: os.cpus().length, start: loadStart, end: loadEnd },
    fresh: { all: summary(costs(fresh)), loaded: summary(byState(fresh, 'loaded')), none: summary(byState(fresh, 'none')) },
    diagnostic: {
      note: 'NOT a criterion. timerLate = how late a control 350 ms timer fired; own = cost - timerLate.',
      freshTimerLate: summary(fresh.map((s) => s.timerLate).filter((v) => v != null)),
      freshOwn: summary(fresh.map((s) => s.own).filter((v) => v != null)),
    },
    hurried: { all: summary(costs(hurried)), loaded: summary(byState(hurried, 'loaded')), none: summary(byState(hurried, 'none')) },
    samples,
  };
  const verdict = (name, stats) => `${name}: p50 ${stats.p50} ms, p95 ${stats.p95} ms, max ${stats.max} ms over ${stats.n} -> `
    + `${stats.p95 != null && stats.p95 <= P95_LIMIT_MS ? 'PASS' : 'FAIL'} (criterion: p95 <= ${P95_LIMIT_MS} ms)`;
  report.verdicts = [
    verdict('G12 FRESH hover, cost after the 350 ms delay', report.fresh.all),
    verdict('G12 HURRIED hover, no delay', report.hurried.all),
  ];
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  // eslint-disable-next-line no-console
  console.log(`\nG12 ${LINKS} links, ${seeded} with a stored screenshot; host load ${loadStart.map((n) => n.toFixed(1)).join('/')}`
    + ` -> ${loadEnd.map((n) => n.toFixed(1)).join('/')} on ${os.cpus().length} cores\n${report.verdicts.join('\n')}\n`
    + `  fresh by state: loaded ${JSON.stringify(report.fresh.loaded)}  none ${JSON.stringify(report.fresh.none)}\n`
    + `  hurried by state: loaded ${JSON.stringify(report.hurried.loaded)}  none ${JSON.stringify(report.hurried.none)}\n`
    + `  DIAGNOSTIC (not a criterion): control-timer lateness ${JSON.stringify(report.diagnostic.freshTimerLate)}\n`
    + `                                fresh cost minus that lateness ${JSON.stringify(report.diagnostic.freshOwn)}\n`);

  // The probe's own pass: the table is complete. Whether the criteria held is the verdict above.
  expect(await rows.count(), 'all 1 000 rows were in the DOM').toBe(LINKS);
  expect(fresh.length, 'every fresh hover was answered with a card').toBe(FRESH_SAMPLES);
  expect(hurried.length, 'every hurried hover was answered with a card inside the hurry window').toBe(HURRIED_SAMPLES);
});
