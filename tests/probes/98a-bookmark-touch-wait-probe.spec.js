// 98a-bookmark-touch-wait-probe — where does a hover's wait go when the folder has 1 000 links?
//
// WHY. Probe 98 (G12) measured, on one host, side by side: with `touchThumbs` imported as it is, one FRESH
// hover in roughly every 60 took seconds to show its card (max 13153, 19277, 12170, 7509 ms); with the touch
// replaced by a no-op, the same tree's FRESH max was 193, 626, 78, 425, 292 ms. The control timer was not late
// by seconds, so the page was not blocked: the hover's read waits.
//
// HYPOTHESIS (not proven when this file was written). `bookmark-preview.js` `runRowsTouch()` calls
// `thumb-store.touch(keys, at)` once with every drawn row's key (up to 1 000). `touch()` opens ONE readwrite
// transaction on the `thumbs` store, `get`s every key and `put`s every record back, blob and all. A hover's
// `peekUrl()` read is a readonly transaction on the same store; IndexedDB runs it only after every transaction
// created before it, so a hover that arrives while the touch is open waits for all of it.
//
// ── PASS CRITERIA, written before the first run (2026-11-05 14:01 JST) and not changed to fit a number ──────
// Part A (store level; the real `thumbStore.touch()` and the real `thumbs.peekUrl()`, nothing of the preview):
//   1 000 urls, one in three has a stored JPEG. For K in {1,4,8,16,32,64,128,256,512,1000} (the first K urls),
//   one warm-up round and 7 measured rounds, K ascending inside a round:
//     idle   `peekUrl(url with a record)` with nothing in flight (taken twice; the second is the control)
//     touch  `thumbStore.touch(K keys, at)` started, then ONE macrotask later
//     read   `peekUrl(same url)`, the call the hover's `show()` awaits
//   H1  median idle read <= 20 ms (if not: INCONCLUSIVE, the host is too noisy to read the rest; repeat).
//   H2  for K >= 256, of the measured rounds where the read started while the touch was open, >= 90 % have
//       (read end - touch end) <= max(50 ms, 3 x the idle median): the read is released by the touch's end.
//   H3  median read wait at K=1000 >= 5 x the one at K=64 and >= 100 ms, and the medians for K in
//       {64,128,256,512,1000} never fall below 0.75 x the previous one: the wait scales with K.
// Part B (product path): the column with 1 000 links, every row drawn, 334 with a stored JPEG. A FRESH
//   `bookmark-preview.js` instance (a throttle that has never run) is attached to the drawn list and told
//   `rendered()`: the product's own `runRowsTouch()` runs over every row. One macrotask after its first readwrite
//   transaction is opened, `peekUrl()` is called. The transactions are recorded in the page by wrapping
//   `IDBDatabase.transaction`, `IDBObjectStore.get` and `.put` (helpers/bookmark-preview.js, installStoreRecorder).
//   5 rounds.
//   HB  (the product as it was) in every round exactly ONE readwrite transaction carries >= 90 % of the rows' keys
//       and the read ended at or after that transaction's end.
//   F4  (the product after the fix) in every round every key was touched, and the read waited no longer than the
//       longest single readwrite transaction of that round + 100 ms.
// H holds iff H1..H3 and HB hold. H1 true and any of H2, H3, HB false means the hypothesis is FALSE and no product
// code may be changed on it.
//
// ── RESULT OF THE FIRST RUN (2026-11-05 14:27-14:34 JST, host load 20-34 on 20 cores, the product as it was) ──
//   H1 PASS (median idle read 0.5 ms).  H2 PASS, narrowly (19 of 21 = 90.5 %; the two misses were reads released 6.6 s
//   and 16.3 s AFTER the touch's end).  H3 FAIL (median wait 69.5 ms at K=64, 321.9 ms at K=1000: ratio 4.6, the rule
//   needs 5; the medians did rise monotonically).  HB PASS (5 of 5: one readwrite transaction with 1 000 gets, the read
//   ended after it).  By the rule above that is "H is false": no product code is changed ON H, and H3 is not relabelled.
//   What the raw rows show beyond the medians: single transactions STALL. Part A: K=256 once took 113 146 ms and K=1000
//   once 70 834 ms (the read behind each waited 119 760 and 87 131 ms); every other touch of K <= 512 took <= 589 ms.
//   Part B: the product's one 1 000-key transaction took 17 413, 263, 32 677, 171 and 30 482 ms in rounds 1-5, and the
//   read behind it waited 17 411, 259, 38 599, 170 and 37 407 ms (it ended 5.1, 5.2, 5 931, 2.5 and 6 930 ms after
//   the transaction did). The neighbours of a stalled transaction in the same round were not slow (K=128: 117 ms, K=512:
//   119 ms). Stalls: 5 of 26 transactions with K >= 256, 0 of 70 with K <= 128. So the waits that matter are rare stalls
//   of a LARGE transaction, which medians do not show; whether small transactions avoid them is not established by
//   parts A and B. (A bug in part B's analysis of that run: the read's own transaction was looked up by tag across all
//   rounds, so rounds 2-5 reported round 1's `read.txCreated`/`txDone`; the verdicts did not use them. Fixed.)
//
// ── PART C: the second stage (criteria written 2026-11-05 14:38:45 JST, BEFORE part C ran) ────────────────────
// Designed after seeing the first run, which is why it is a second stage: it tests the remedy itself, and the product
// is changed only if it passes (not on H, which failed as registered). Store level, no product code. Setup as part A.
// Runs alternate (order flipped every round) between
//   single  `thumbStore.touch(all 1 000 keys, at)`, what `runRowsTouch` does today
//   batch   63 sequential `thumbStore.touch(16 keys, at)` calls, each awaited, one `setTimeout(0)` turn between two
//           (what the fix would do, the same `at`)
// and, three times (start, middle, end), `none` (reader only, 2 s). In every run a closed-loop reader calls the real
// `thumbs.peekUrl(url with a record)` back to back (10 ms apart) from the start of the run until it ends and every
// read's latency is recorded; before every run the store is settled (reads until 5 in a row take < 30 ms, cap 120 s,
// the time recorded). 20 single and 20 batch runs after one uncounted warm-up.
//   C0  control: the median of the control runs' read medians <= 20 ms and every control read <= 250 ms; else
//       INCONCLUSIVE.
//   C1  the defect reproduced: >= 4 of the 20 single runs have a read >= 5 000 ms; else INCONCLUSIVE (repeat).
//   C2  the remedy: >= 19 of the 20 batch runs have every read < 1 000 ms and no batch run has a read >= 5 000 ms.
// C0 and C1 true and C2 false: the remedy does not work, no product change. All three true: implement it with
// TOUCH_BATCH = 16 (part A: t(1)/t(16) = 18.5/71.1 ms = 0.26 < 0.5, the registered rule for 16 rather than 32).
//
// ── RESULT OF PART C (2026-11-05 14:49-15:05 JST, host load 44-54 on 20 cores, the product as it was) ────────
//   C0 PASS (control reads: median of medians 1.8 ms, slowest 30.9 ms). C1 PASS, exactly at its bar (4 of 20 single runs
//   stalled; the reader waited 94.7, 84.3, 97.4 and 113.3 s). C2 FAIL: 4 of the 20 batch runs stalled too, each with ONE
//   16-key transaction that took 72.4, 69.8, 78.8 and 85.0 s (the reads behind them waited 72.5, 70.5, 78.8, 85.2 s), and
//   only 14 of the 20 had every read under 1 000 ms. Both arms rewrote 6 680 blobs and stalled 4 times: the stall rate is
//   the same per blob rewritten, and a stall lasts about as long whether the transaction holds 16 keys or 1 000. Without a
//   stall the arms did not differ on the reader either: a single run took 532 ms (median), the read behind it waited 542 ms
//   (median of the runs' slowest read); a batch run took 6 636 ms, twelve times longer (63 transactions of about 100 ms
//   each under this load), and its slowest read waited 599 ms. By the rule above the remedy does not work, so the
//   product was NOT changed: the batching this probe was written to justify was not made.
//
// ── PART D: diagnosis (criteria written 2026-11-05 15:07:36 JST, BEFORE part D ran; no product decision rests on it) ──
// Part C says batching does not help; part D asks what a stalled transaction has in common. Store level, setup as part A,
// plus 334 records WITH NO blob and 666 keys that have no record at all. 12 rounds; in each, four arms in rotating order:
//   all-noread     touch(all 1 000 keys) and nothing else      (is a read queued behind it needed for the stall?)
//   all-read       the same, one `peekUrl` queued one macrotask later (as in parts A and B)
//   blobless-read  touch(the 334 blob-less records' keys), a read queued   (does the stall need a blob in the transaction?)
//   absent-read    touch(666 keys that have no record), a read queued      (gets only, no put at all)
// A stall is a touch that takes >= 5 000 ms. D0: all-read has >= 2 stalls, else INCONCLUSIVE. D1 and D2 are descriptive:
// D1 says whether all-noread stalls at all; D2 whether blobless-read or absent-read ever do. "NOT SEEN" in 12 runs is
// weaker than "does not happen": were the true rate all-read's (about 1 in 5), 12 runs would show none 7 % of the time.
//
// ── RESULT OF PART D (2026-11-05 15:13-15:22 JST, host load 61-66 on 20 cores; three e2e containers started within a
//    second of each other at 15:13:25, the runner's slot check having passed for all three) ──────────────────────────────
//   D0 PASS, at its bar (all-read: 2 of 12 stalled, 84.0 and 62.4 s).
//   D1 all-noread stalled too, with NO read queued behind it: 2 of 12 (50.3 and 52.5 s). The read is not what makes a
//      touch stall; it only has to wait for it.
//   D2 blobless-read (334 puts of records with no blob) 0 of 12 stalls, slowest touch 203 ms; absent-read (666 gets, no
//      put) 0 of 12, slowest 198 ms. NOT SEEN is weaker than "does not happen": 4 stalls among the 24 all-* runs and none
//      among the 24 others is p = 0.055 (Fisher, one-sided).
//   Also in the table: the SETTLE reads before a run (reads from this page, nothing of its own in flight; five quick ones in
//   a row end it) took 32.3, 94.6 and 57.6 s before three runs. The first came right after the stalled all-noread, the
//   other two after runs that had themselves been quick (all-read, 513 ms; absent-read, 62 ms). Of the test's 516 s, 434 s
//   went to such waits (the four stalled touches 249 s, the three settles 185 s).
//   Read together with part C: what stalls is the store, for 30-100 s at a time on this host; it seems to be entered by work
//   that carries blobs (D2, p = 0.055: only suggestive; and part C's 16-key transactions were caught by it as often per
//   run as the 1 000-key one), and whatever reads or writes while it lasts waits, whatever the size of the transaction.
//   Batching therefore cannot remove it. What would act on the cause is rewriting fewer blobs (a touch that leaves a record
//   alone when its lastUsedAt is already recent, or a lastUsedAt kept outside the record); that changes what "touch"
//   means and is a decision for the owner, not measured here. NOT established: what inside
//   Chromium takes that long (blob file I/O? post-commit cleanup of the old blob files? the disk of this host?), whether the
//   service worker's own writes took part, and whether the stall is as long on a quiet host (probe 98's own quiet-host
//   runs had tails of 0.5, 1.1 and 4.0 s, not minutes).
//
// The host is busy (other jobs share it): the load average is recorded with every result. A miss under a load
// average above the core count says as much about the host as about the code; it does not move a criterion.
// The probe's own exit status says only that the table is complete; the VERDICT lines say what held.
// Raw data: tests/output/bookmark-touch-wait-probe.json.
//
// Run:
//   HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose -f tests/docker-compose.yml \
//     run --rm e2e env VT_TEST_DIR=./probes playwright test 98a-bookmark-touch-wait-probe.spec.js \
//     --reporter=list --retries=0
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('../fixtures');
const { granted } = require('../helpers/bookmarks');
const P = require('../helpers/bookmark-preview');

const OUT = process.env.OUT_DIR || path.resolve(__dirname, '../output');
const REPORT = path.join(OUT, 'bookmark-touch-wait-probe.json');

const LINKS = 1000;
const KS = [1, 4, 8, 16, 32, 64, 128, 256, 512, 1000];
const REPEATS = 7; // measured rounds of part A, after one warm-up round
const ROUNDS_B = 5;
const ROWS = '[data-testid="bookmark-row"][data-kind="link"]';

const urlOf = (i) => `https://bulk.example.com/page/${i}`;
const URLS = Array.from({ length: LINKS }, (_, i) => urlOf(i));
// Every third url has a stored screenshot (i % 3 === 0); the read is for one that has.
const WITH_RECORD = URLS.filter((_, i) => i % 3 === 0);
const READ_URL = urlOf(3);

const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
const loadText = (a, b) => `${a.map((n) => n.toFixed(1)).join('/')} -> ${b.map((n) => n.toFixed(1)).join('/')} on ${os.cpus().length} cores`;

granted('part A: a read behind a K-key touch waits for it (store level)', async ({ harness }) => {
  granted.setTimeout(1_800_000);
  const { panel } = harness;
  const loadStart = os.loadavg();

  const seeded = await P.putFakeThumbs(panel, WITH_RECORD);

  const rows = await panel.evaluate(async (a) => {
    const store = window.__vt.thumbStore;
    const { thumbs } = window.__vt;
    const keysAll = a.urls.map((u) => window.__vt.urlKey(u));
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    const out = [];
    for (let round = 0; round <= a.repeats; round += 1) {
      for (const k of a.ks) {
        const keys = keysAll.slice(0, k);
        // The control: a read with nothing in flight. Twice, so that whatever the previous touch left
        // behind in the backend is paid by the first.
        await thumbs.peekUrl(a.readUrl);
        const i0 = performance.now();
        const idleInfo = await thumbs.peekUrl(a.readUrl);
        const idle = performance.now() - i0;

        const t0 = performance.now();
        const touching = store.touch(keys, Date.now()).then(() => performance.now());
        await tick(); // the touch's transaction is open and has all its requests queued
        const q0 = performance.now();
        const info = await thumbs.peekUrl(a.readUrl);
        const q1 = performance.now();
        const t1 = await touching;
        out.push({
          round, k, idle, idleState: idleInfo.state, touch: t1 - t0, wait: q1 - q0, afterTouchEnd: q1 - t1,
          state: info.state, inFlight: q0 < t1,
        });
      }
    }
    return out;
  }, { urls: URLS, ks: KS, repeats: REPEATS, readUrl: READ_URL });
  const loadEnd = os.loadavg();

  const measured = rows.filter((r) => r.round > 0);
  const at = (k, f) => measured.filter((r) => r.k === k).map(f);
  const table = KS.map((k) => ({
    k,
    touchMedian: r1(median(at(k, (r) => r.touch))),
    waitMedian: r1(median(at(k, (r) => r.wait))),
    waitMax: r1(Math.max(...at(k, (r) => r.wait))),
    afterTouchEndMedian: r1(median(at(k, (r) => r.afterTouchEnd))),
    inFlight: `${at(k, (r) => r.inFlight).filter(Boolean).length}/${at(k, (r) => r.inFlight).length}`,
    idleMedian: r1(median(at(k, (r) => r.idle))),
  }));

  const idleMedian = median(measured.map((r) => r.idle));
  const h1 = idleMedian <= 20;
  const big = measured.filter((r) => r.k >= 256 && r.inFlight);
  const releasedBy = Math.max(50, 3 * idleMedian);
  const h2share = big.length ? big.filter((r) => r.afterTouchEnd <= releasedBy).length / big.length : 0;
  const h2 = h2share >= 0.9;
  const w = (k) => median(at(k, (r) => r.wait));
  const chain = [64, 128, 256, 512, 1000];
  const monotone = chain.every((k, i) => i === 0 || w(k) >= 0.75 * w(chain[i - 1]));
  const h3 = w(1000) >= 5 * w(64) && w(1000) >= 100 && monotone;
  const verdicts = [
    `H1 median idle read ${r1(idleMedian)} ms (<= 20) -> ${h1 ? 'PASS' : 'FAIL (INCONCLUSIVE: host too noisy)'}`,
    `H2 ${r1(100 * h2share)} % of ${big.length} in-flight reads at K>=256 were released within ${r1(releasedBy)} ms of the touch's end (>= 90 %) -> ${h2 ? 'PASS' : 'FAIL'}`,
    `H3 median wait K=64 ${r1(w(64))} ms, K=1000 ${r1(w(1000))} ms (ratio ${r1(w(1000) / w(64))}, need >= 5 and >= 100 ms), medians monotone within 25 %: ${monotone} -> ${h3 ? 'PASS' : 'FAIL'}`,
  ];

  fs.mkdirSync(OUT, { recursive: true });
  const prior = fs.existsSync(REPORT) ? JSON.parse(fs.readFileSync(REPORT, 'utf8')) : {};
  fs.writeFileSync(REPORT, JSON.stringify({
    ...prior, partA: { seeded, hostLoadavg: { start: loadStart, end: loadEnd }, table, verdicts, rows },
  }, null, 2));
  // eslint-disable-next-line no-console
  console.log(`\nPART A ${LINKS} urls, ${seeded} with a stored screenshot; host load ${loadText(loadStart, loadEnd)}\n`
    + `  K     touch(med)  wait(med)  wait(max)  read-end minus touch-end (med)  in flight  idle(med)   [ms]\n`
    + `${table.map((t) => `  ${String(t.k).padEnd(5)} ${String(t.touchMedian).padStart(10)} ${String(t.waitMedian).padStart(10)} `
      + `${String(t.waitMax).padStart(10)} ${String(t.afterTouchEndMedian).padStart(30)} ${String(t.inFlight).padStart(10)} `
      + `${String(t.idleMedian).padStart(10)}`).join('\n')}\n${verdicts.join('\n')}\n`);

  expect(rows.length, 'every K was measured in every round').toBe((REPEATS + 1) * KS.length);
  expect(rows.every((r) => r.state === 'loaded' && r.idleState === 'loaded'),
    'every read found the stored picture, so each one is a real read of the record').toBe(true);
});

granted('part B: the product\'s own touch run, and a read that starts inside it (product path)', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(1_800_000);
  const { panel } = harness;
  const loadStart = os.loadavg();

  // The preview's one long timer (the trailing run of the 30 s throttle) is shortened to 100 ms from the start, so
  // the column's own early runs happen early and are over before the rounds begin.
  await P.shortenPreviewTimers(panel);
  await P.installStoreRecorder(panel);
  const links = URLS.map((url, i) => ({ title: `Link ${String(i).padStart(4, '0')}`, url }));
  await P.openColumn(harness, serviceWorker, links, { width: 460, height: 900 });
  const seeded = await P.putFakeThumbs(panel, WITH_RECORD);

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

  // Rest: nothing open and nothing new for 2 s, so the column's own early runs are over and a round starts alone.
  await expect.poll(() => panel.evaluate(() => {
    const { tx } = window.__idb;
    if (tx.some((e) => e.done === null)) return false;
    const last = tx.reduce((m, e) => Math.max(m, e.created, e.done), 0);
    return performance.now() - last > 2000;
  }), { timeout: 180_000, intervals: [500], message: 'the column\'s own touch runs are over' }).toBe(true);

  const rounds = [];
  for (let round = 1; round <= ROUNDS_B; round += 1) {
    const before = os.loadavg();
    const result = await panel.evaluate(async (a) => {
      const rec = window.__idb;
      const mod = await import(chrome.runtime.getURL('sidepanel/bookmark-preview.js'));
      const rail = document.getElementById('bookmark-rail');
      const list = document.querySelector('[data-testid="bookmark-list"]');
      const expected = new Set([...list.querySelectorAll('[data-bookmark-key]')].map((el) => el.dataset.bookmarkKey));
      const startN = rec.seq;
      const read = { scheduled: false, startedAt: null, endedAt: null, state: null };
      let reading = Promise.resolve();
      // One macrotask after the run's first readwrite transaction is opened, the hover's read.
      rec.onCreated = (entry) => {
        if (read.scheduled || entry.mode !== 'readwrite') return;
        read.scheduled = true;
        setTimeout(() => {
          read.startedAt = performance.now();
          rec.nextTag = 'probe-read';
          reading = window.__vt.thumbs.peekUrl(a.readUrl).then((info) => {
            read.endedAt = performance.now();
            read.state = info.state;
          });
        }, 0);
      };
      const mine = () => rec.tx.filter((e) => e.n > startN && e.mode === 'readwrite' && e.keys.length > 0
        && e.keys.every((k) => expected.has(k)));
      const t0 = performance.now();
      // A throttle that has never run: an immediate run over every row that is drawn.
      const preview = mod.attach({ ctx: window.__vt.ctx, rail, list });
      preview.rendered();
      const over = () => {
        const txs = mine();
        return txs.length > 0 && txs.every((e) => e.done !== null) && new Set(txs.flatMap((e) => e.keys)).size >= expected.size;
      };
      while (!over() && performance.now() - t0 < 240_000) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await reading;
      preview.detach();
      rec.onCreated = null;
      const txs = mine();
      // This round's read: the first tagged one after the round began (the first run of this probe took the
      // first tagged one of ALL rounds, so rounds 2-5 reported round 1's read transaction; no verdict used it).
      const readTx = rec.tx.find((e) => e.n > startN && e.tag === 'probe-read');
      const rel = (v) => (v == null ? null : v - t0);
      return {
        expectedKeys: expected.size,
        touchedKeys: new Set(txs.flatMap((e) => e.keys)).size,
        txs: txs.map((e) => ({ n: e.n, gets: e.gets, puts: e.puts, created: rel(e.created), done: rel(e.done) })),
        read: {
          startedAt: rel(read.startedAt), endedAt: rel(read.endedAt), state: read.state,
          txCreated: readTx ? rel(readTx.created) : null, txDone: readTx ? rel(readTx.done) : null,
        },
        hookErrors: rec.hookErrors,
      };
    }, { readUrl: READ_URL });
    const after = os.loadavg();
    const durations = result.txs.map((e) => e.done - e.created);
    const first = result.txs[0];
    const last = result.txs[result.txs.length - 1];
    rounds.push({
      round,
      load: loadText(before, after),
      ...result,
      txCount: result.txs.length,
      maxGets: Math.max(...result.txs.map((e) => e.gets)),
      longestTx: Math.max(...durations),
      runTotal: last.done - first.created,
      readWait: result.read.endedAt - result.read.startedAt,
      readEndMinusFirstTxEnd: result.read.endedAt - first.done,
    });
  }
  const loadEnd = os.loadavg();

  const hbRound = (x) => {
    const big = x.txs.filter((e) => e.gets >= 0.9 * x.expectedKeys);
    return big.length === 1 && x.txs.length >= 1 && x.read.endedAt >= big[0].done;
  };
  const hb = rounds.every(hbRound);
  const f4Round = (x) => x.touchedKeys >= x.expectedKeys && x.readWait <= x.longestTx + 100;
  const f4 = rounds.every(f4Round);
  const verdicts = [
    `HB the product as it was: in ${rounds.filter(hbRound).length}/${rounds.length} rounds exactly one readwrite transaction carried >= 90 % of the keys and the read ended at or after its end -> ${hb ? 'PASS' : 'FAIL'}`,
    `F4 the product after the fix: in ${rounds.filter(f4Round).length}/${rounds.length} rounds every key was touched and the read waited <= the longest single transaction + 100 ms -> ${f4 ? 'PASS' : 'FAIL'}`,
  ];

  fs.mkdirSync(OUT, { recursive: true });
  const prior = fs.existsSync(REPORT) ? JSON.parse(fs.readFileSync(REPORT, 'utf8')) : {};
  fs.writeFileSync(REPORT, JSON.stringify({
    ...prior, partB: { seeded, hostLoadavg: { start: loadStart, end: loadEnd }, verdicts, rounds },
  }, null, 2));
  // eslint-disable-next-line no-console
  console.log(`\nPART B ${LINKS} links, ${seeded} with a stored screenshot; host load ${loadText(loadStart, loadEnd)}\n`
    + '  round  keys  txs  max gets/tx  longest tx  run total  read starts  read wait  read end - first tx end   [ms]\n'
    + `${rounds.map((x) => `  ${String(x.round).padEnd(5)}  ${String(x.expectedKeys).padStart(4)} ${String(x.txCount).padStart(4)} `
      + `${String(x.maxGets).padStart(12)} ${String(r1(x.longestTx)).padStart(11)} ${String(r1(x.runTotal)).padStart(10)} `
      + `${String(r1(x.read.startedAt)).padStart(12)} ${String(r1(x.readWait)).padStart(10)} ${String(r1(x.readEndMinusFirstTxEnd)).padStart(24)}   load ${x.load}`).join('\n')}\n`
    + `${verdicts.join('\n')}\n`);

  // The probe's own pass: the table is complete.
  expect(rounds.length, 'every round ran').toBe(ROUNDS_B);
  expect(rounds.every((x) => x.touchedKeys === x.expectedKeys && x.read.state === 'loaded' && x.hookErrors.length === 0),
    'every round touched every key, and its read found the stored picture').toBe(true);
});

// ── Part C (added after the first run; criteria in the header, written before this part ran) ───────────────
const RUNS_C = 20; // single runs, and batch runs
const BATCH_C = 16;
const GAP_MS = 10;

granted('part C: all 1 000 keys in one transaction against 16 at a time, a reader reading throughout (store level)', async ({
  harness,
}) => {
  granted.setTimeout(2_700_000);
  const { panel } = harness;
  const loadStart = os.loadavg();
  const seeded = await P.putFakeThumbs(panel, WITH_RECORD);

  const runs = await panel.evaluate(async (a) => {
    const store = window.__vt.thumbStore;
    const { thumbs } = window.__vt;
    const keysAll = a.urls.map((u) => window.__vt.urlKey(u));
    const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const pct = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];

    // Reads until five in a row are quick, so that what the previous run left in the backend is not charged to
    // this one. The time it takes is recorded: it is the delay a stalled transaction leaves behind.
    async function settle() {
      const s0 = performance.now();
      let quiet = 0;
      while (quiet < 5 && performance.now() - s0 < 120_000) {
        const t = performance.now();
        await thumbs.peekUrl(a.readUrl);
        quiet = performance.now() - t < 30 ? quiet + 1 : 0;
        await tick(10);
      }
      return performance.now() - s0;
    }

    async function run(kind, index) {
      const settled = await settle();
      const at = Date.now();
      const reads = [];
      let going = true;
      const reader = (async () => {
        while (going) {
          const s = performance.now();
          const info = await thumbs.peekUrl(a.readUrl);
          reads.push({ at: s, ms: performance.now() - s, state: info.state });
          await tick(a.gapMs);
        }
      })();
      const t0 = performance.now();
      const batchMs = [];
      if (kind === 'single') {
        await store.touch(keysAll, at);
      } else if (kind === 'batch') {
        for (let from = 0; from < keysAll.length; from += a.batch) {
          if (from > 0) await tick(0);
          const b0 = performance.now();
          await store.touch(keysAll.slice(from, from + a.batch), at);
          batchMs.push(performance.now() - b0);
        }
      } else {
        await tick(a.controlMs);
      }
      const total = performance.now() - t0;
      going = false;
      await reader;
      const ms = reads.map((r) => r.ms).sort((x, y) => x - y);
      return {
        kind, index, settled, total, reads: reads.length, readP50: pct(ms, 0.5), readP95: pct(ms, 0.95), readMax: ms[ms.length - 1],
        allLoaded: reads.every((r) => r.state === 'loaded'),
        batches: batchMs.length, batchMax: batchMs.length ? Math.max(...batchMs) : null,
        batchesOver1s: batchMs.filter((m) => m > 1000).length,
      };
    }

    const out = [];
    out.push(await run('none', 0));
    await run('single', -1); // warm-up, not counted
    for (let i = 1; i <= a.runs; i += 1) {
      for (const kind of i % 2 ? ['single', 'batch'] : ['batch', 'single']) out.push(await run(kind, i));
      if (i === Math.ceil(a.runs / 2)) out.push(await run('none', i));
    }
    out.push(await run('none', a.runs + 1));
    return out;
  }, { urls: URLS, readUrl: READ_URL, runs: RUNS_C, batch: BATCH_C, gapMs: GAP_MS, controlMs: 2000 });
  const loadEnd = os.loadavg();

  const of = (kind) => runs.filter((r) => r.kind === kind);
  const control = of('none');
  const single = of('single');
  const batch = of('batch');
  const c0 = median(control.map((r) => r.readP50)) <= 20 && Math.max(...control.map((r) => r.readMax)) <= 250;
  const c1 = single.filter((r) => r.readMax >= 5000).length >= 4;
  const c2 = batch.filter((r) => r.readMax < 1000).length >= RUNS_C - 1 && batch.every((r) => r.readMax < 5000);
  const verdicts = [
    `C0 control: median of read medians ${r1(median(control.map((r) => r.readP50)))} ms (<= 20), slowest control read ${r1(Math.max(...control.map((r) => r.readMax)))} ms (<= 250) -> ${c0 ? 'PASS' : 'FAIL (INCONCLUSIVE)'}`,
    `C1 single runs with a read >= 5 000 ms: ${single.filter((r) => r.readMax >= 5000).length} of ${single.length} (need >= 4) -> ${c1 ? 'PASS (the defect reproduced)' : 'FAIL (INCONCLUSIVE)'}`,
    `C2 batch runs with every read < 1 000 ms: ${batch.filter((r) => r.readMax < 1000).length} of ${batch.length} (need >= ${RUNS_C - 1}), batch runs with a read >= 5 000 ms: ${batch.filter((r) => r.readMax >= 5000).length} (need 0) -> ${c2 ? 'PASS' : 'FAIL'}`,
  ];

  fs.mkdirSync(OUT, { recursive: true });
  const prior = fs.existsSync(REPORT) ? JSON.parse(fs.readFileSync(REPORT, 'utf8')) : {};
  fs.writeFileSync(REPORT, JSON.stringify({
    ...prior, partC: { seeded, hostLoadavg: { start: loadStart, end: loadEnd }, verdicts, runs },
  }, null, 2));
  // eslint-disable-next-line no-console
  console.log(`\nPART C ${LINKS} urls, ${seeded} with a stored screenshot; host load ${loadText(loadStart, loadEnd)}\n`
    + '  kind    #  settle(ms)  run total  reads  read p50  read p95  read max  batches  slowest batch  >1s   [ms]\n'
    + `${runs.map((r) => `  ${r.kind.padEnd(6)} ${String(r.index).padStart(2)} ${String(r1(r.settled)).padStart(10)} ${String(r1(r.total)).padStart(10)} `
      + `${String(r.reads).padStart(6)} ${String(r1(r.readP50)).padStart(9)} ${String(r1(r.readP95)).padStart(9)} ${String(r1(r.readMax)).padStart(9)} `
      + `${String(r.batches || '').padStart(8)} ${String(r1(r.batchMax) ?? '').padStart(14)} ${String(r.batches ? r.batchesOver1s : '').padStart(4)}`).join('\n')}\n`
    + `${verdicts.join('\n')}\n`);

  // The probe's own pass: the table is complete.
  expect(single.length, 'every single run ran').toBe(RUNS_C);
  expect(batch.length, 'every batch run ran').toBe(RUNS_C);
  expect(control.length, 'every control run ran').toBe(3);
  expect(runs.every((r) => r.allLoaded), 'every read found the stored picture').toBe(true);
});

// ── Part D (diagnostic, added after part C; criteria in the header, written before it ran) ──────────────────
const ROUNDS_D = 12;
const ARMS_D = ['all-noread', 'all-read', 'blobless-read', 'absent-read'];
const STALL_MS = 5000;

granted('part D: which touches stall, and does the stall need a read behind it or a blob in it (store level)', async ({
  harness,
}) => {
  granted.setTimeout(2_700_000);
  const { panel } = harness;
  const loadStart = os.loadavg();
  const seeded = await P.putFakeThumbs(panel, WITH_RECORD);
  // 334 records with NO blob, under keys of their own, and 666 keys that have no record at all.
  const blobless = Array.from({ length: 334 }, (_, i) => `https://noblob.example.com/page/${i}`);
  const absent = Array.from({ length: 666 }, (_, i) => `https://absent.example.com/page/${i}`);
  await panel.evaluate(async (urls) => {
    for (const url of urls) {
      await window.__vt.thumbStore.putThumb({
        urlKey: window.__vt.urlKey(url), url, title: 'seeded', capturedAt: Date.now(), lastUsedAt: 1,
        width: 640, height: 240, bytes: 0, blob: null, avgColor: [42, 93, 176], uniform: false,
        tabId: null, windowId: null, atTop: true,
      });
    }
  }, blobless);

  const runs = await panel.evaluate(async (a) => {
    const store = window.__vt.thumbStore;
    const { thumbs } = window.__vt;
    const keyOf = (urls) => urls.map((u) => window.__vt.urlKey(u));
    const keys = {
      'all-noread': keyOf(a.all), 'all-read': keyOf(a.all), 'blobless-read': keyOf(a.blobless), 'absent-read': keyOf(a.absent),
    };
    const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function settle() {
      const s0 = performance.now();
      let quiet = 0;
      while (quiet < 5 && performance.now() - s0 < 120_000) {
        const t = performance.now();
        await thumbs.peekUrl(a.readUrl);
        quiet = performance.now() - t < 30 ? quiet + 1 : 0;
        await tick(10);
      }
      return performance.now() - s0;
    }
    async function run(arm, round) {
      const settled = await settle();
      const at = Date.now();
      const t0 = performance.now();
      const touching = store.touch(keys[arm], at).then(() => performance.now());
      let wait = null;
      if (arm !== 'all-noread') {
        await tick(0); // the touch's transaction is open and has all its requests queued
        const q0 = performance.now();
        await thumbs.peekUrl(a.readUrl);
        wait = performance.now() - q0;
      }
      const t1 = await touching;
      return {
        arm, round, keys: keys[arm].length, settled, touch: t1 - t0, wait,
      };
    }
    const out = [];
    await run('all-read', 0); // warm-up, not counted
    for (let round = 1; round <= a.rounds; round += 1) {
      for (let j = 0; j < a.arms.length; j += 1) out.push(await run(a.arms[(round + j) % a.arms.length], round));
    }
    return out;
  }, {
    all: URLS, blobless, absent, readUrl: READ_URL, rounds: ROUNDS_D, arms: ARMS_D,
  });
  const loadEnd = os.loadavg();

  const stalls = (arm) => runs.filter((r) => r.arm === arm && r.touch >= STALL_MS);
  const count = (arm) => `${stalls(arm).length} of ${runs.filter((r) => r.arm === arm).length}`;
  const seen = (arm) => (stalls(arm).length ? `SEEN (${stalls(arm).map((r) => `${r1(r.touch / 1000)} s`).join(', ')})` : 'NOT SEEN');
  const d0 = stalls('all-read').length >= 2;
  const verdicts = [
    `D0 the defect reproduced: stalls (touch >= ${STALL_MS} ms) in all-read: ${count('all-read')} (need >= 2) -> ${d0 ? 'PASS' : 'FAIL (INCONCLUSIVE)'}`,
    `D1 a stall with NO read queued behind it (all-noread): ${count('all-noread')} -> ${seen('all-noread')}`,
    `D2 a stall with NO blob in the transaction: blobless-read ${count('blobless-read')} -> ${seen('blobless-read')}; absent-read (gets only) ${count('absent-read')} -> ${seen('absent-read')}`,
  ];

  fs.mkdirSync(OUT, { recursive: true });
  const prior = fs.existsSync(REPORT) ? JSON.parse(fs.readFileSync(REPORT, 'utf8')) : {};
  fs.writeFileSync(REPORT, JSON.stringify({
    ...prior, partD: { seeded, hostLoadavg: { start: loadStart, end: loadEnd }, verdicts, runs },
  }, null, 2));
  // eslint-disable-next-line no-console
  console.log(`\nPART D ${seeded} blob records, ${blobless.length} blob-less records, ${absent.length} absent keys; host load ${loadText(loadStart, loadEnd)}\n`
    + '  round  arm              keys  settle(ms)  touch(ms)  read wait(ms)\n'
    + `${runs.map((r) => `  ${String(r.round).padStart(5)}  ${r.arm.padEnd(14)} ${String(r.keys).padStart(5)} ${String(r1(r.settled)).padStart(11)} `
      + `${String(r1(r.touch)).padStart(10)} ${String(r.wait == null ? '-' : r1(r.wait)).padStart(13)}`).join('\n')}\n`
    + `${verdicts.join('\n')}\n`);

  // The probe's own pass: the table is complete.
  expect(runs.length, 'every arm ran in every round').toBe(ROUNDS_D * ARMS_D.length);
});
