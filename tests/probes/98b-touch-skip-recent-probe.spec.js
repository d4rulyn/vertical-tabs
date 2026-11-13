// 98b-touch-skip-recent-probe — what `thumb-store.touch()` writes and what it costs when every stamp is recent.
//
// WHY. Probe 98a showed that a hover's wait is the IndexedDB store stalling for 17-113 s at a time (host load
// 20-66), that batching does not remove it (4 of 20 stalled batched and unbatched), and that touches of records
// WITHOUT a blob never stalled (0 of 24; Fisher p = 0.055, suggestive only). `touch()` rewrites every drawn row's
// record, blob included, every 30 s, although `prune()` only cares about a stamp that is days old. The remedy under
// test: a record whose `lastUsedAt` is a number within TOUCH_FRESH_MS (constants.js) of `now` is left alone. X was 1 hour in
// runs 1-3 (the results below) and is 6 hours from round 2 on; the probe reads X from the tree it runs on.
//
// ── CRITERIA, written before the first run (2026-11-05 20:56 JST) and not changed to fit a number ─────────────
// Part B  (M-B, deterministic, no clock). Counter = installStoreRecorder (wraps transaction/get/put in the page).
//   S1 1000 records WITH blobs, stamped 30 s ago, touch(all 1000)       main: 1 tx, 1000 gets, 1000 puts
//                                                                      fix : 1 tx, 1000 gets,    0 puts
//   S2 200 records stamped X + 1 min ago                                both: 200 puts (one per stale row)
//   S3 200 records, half 30 s old, half stale                           fix : 100 puts, main: 200
//   S4 900 keys, 300 with a record (fresh), 600 with none               fix : 0 puts, main: 300; nothing is created
//   STOP if S1 on main is under 900 puts (the premise "touch rewrites every drawn row" would be wrong).
// Part A  (M-A / M-C, timing). 1000 records WITH blobs (the 640x240 JPEG q0.72 of putFakeThumbs, size printed).
//   Arm `main` = common/thumb-store.main.js, a byte copy of origin/main's thumb-store.js that the launcher puts into
//   the tree under test (NOT committed; its SHA-256 is compared with EXPECT_MAIN_SHA256 and a mismatch aborts).
//   Arm `fix` = the tree's own touch(). On the unchanged tree both arms are main's code: an A/A control.
//   Arm `index` (only when VT_ARMS says so) = a probe-local candidate that finds the stale rows through the
//   `byLastUsedAt` index and reads nothing else; it is not in the product and is measured only to tell whether the
//   1000 reads of the fix's steady state matter.
//   CYCLE = one touch(all keys, Date.now()) as the callers make it, with a closed-loop reader (thumbs.peekUrl of one
//   record, 10 ms apart, the first read one macrotask after the touch started) that goes on until the touch has
//   resolved AND five reads that started after that took < 30 ms each (the store is quiet again; cap 600 s, a capped
//   cycle is reported UNSETTLED). STALL = a cycle with a read over 500 ms. Also printed: stalls during the touch only.
//   N = 40 measured cycles per arm + 1 uncounted warm-up per arm; arms interleaved (the order inside a round was a fixed
//   rotation in run 1 and is a seeded random permutation from run 2 on, see "CHANGES AFTER RUN 1" below).
//   The rows are always fresh for the fix/index arms because the main arm keeps refreshing their stamps: the fix's
//   once-per-hour refresh burst is NOT in this measurement (Part B S2 counts it).
//   Fisher exact one-sided (H1: main stalls more than the arm) is printed per arm. Wording rule, unchanged from the
//   brief: >= 3 stalls in the main arm AND p < 0.05 -> "reduced stalls in this run"; < 3 -> "the stall effect was NOT
//   measured"; never "fixed" from this alone.
// Part A2 the same with 100 keys and N = 100 (the size of a heavy tab-card load).
// Part C  the tab-card path with real cards: 12 tabs in the scoped window, each with a seeded record (6 stamped 30 s
//   ago, 6 stamped 2 h ago); the real thumbs.touchDisplayed() is polled until its 30 s throttle opens; the
//   recorder counts its gets and puts.
//
// ── CHANGES AFTER RUN 1 (written 2026-11-06 10:34 JST, BEFORE run 2; run 1 had two identical arms, the unchanged touch()) ─
// Run 1 (A/A, 2026-11-05 21:17-22:17 JST) showed three things about the probe, not about the fix:
//   1. Stalls recur: at 1 000 keys a cycle with a read >= 5 s came every 3-4 cycles (about 3 250 record rewrites), at 100
//      keys every 19-21 cycles (about 1 956 rewrites), 38-186 s each, at host load 4-5. A fixed arm rotation aliases with
//      that (identical arms: 4 vs 11 stalled cycles at 100 keys). -> the order inside a round is a seeded random permutation
//      (VT_SEED, default = the start time in seconds; printed and stored).
//   2. Part A failed its own check from round 28 on: the 30-minute maintenance alarm pruned the reader's record, because the
//      store held the 1 000 seeded records + the capture of the active tab (1 001 > PRUNE.maxEntries). -> after seeding, every
//      other record is deleted, and the count is printed at the start and at the end of the part (and asserted equal).
//   3. A read that returns something other than `loaded` is now recorded with its state (`firstOtherState`).
// Fisher's test assumes independent cycles; stalls that are periodic in rewrites are not, so its p is descriptive here.
//
// ── CHANGES AFTER THE FIRST 20 ROUNDS OF RUN 2 (written 2026-11-06 10:45 JST, BEFORE the runs that use them) ───────
// Run 2 interleaves the arms main / fix / index in ONE store. In its first 20 rounds the main arm stalled after every second
// cycle (about 2 000 rewrites), the fix arm (1 000 reads of blob records, no write) stalled three times (21-32 s) in cycles that
// followed main-arm cycles, and the index arm (reads no record at all) never did: 0.5-0.9 ms in every cycle, next to stalled
// ones. A stall that one arm's writes cause and another arm's reads suffer cannot be told from the fix's own stall in an
// interleaved run, so two supplementary runs put ONE arm alone in a browser, 100 cycles, 2 s apart (VT_PAUSE_MS=2000;
// VT_ARMS=main or VT_ARMS=fix; -g "part A \(M-A"). Both wait, after seeding, until five reads in a row are quick (a stall right
// after the 1 000 seeding writes was seen in run 2's first measured cycle). They are NOT the interleaved comparison of the brief.
//
// ── RESULT OF RUN 1 (A/A: both arms are the unchanged touch(); f9d28d5; 2026-11-05 21:17-22:17 JST) ──────────────────────
//   load1 per cycle: 27-42 for the first cycles, then 4-5 (part A: 37 and 36 of the 40 cycles of the two arms were under 10).
//   B   S1 1 000 puts for 1 000 keys on both arms (the premise holds); S2 200/200, S3 200/200, S4 300/300.
//   A   K=1000, N=40: identical arms stalled (a read > 500 ms) in 22 and 23 of 40 cycles, 11 and 14 of them with a read >= 5 s
//       (Fisher p 0.67). The cycles with a read >= 5 s recur every 3-4 cycles (mean 3.25, about 3 250 rewrites) and last 41-164 s
//       (slowest read 186 s). From round 28 on every read returned `none`: the 30-minute maintenance prune had dropped the reader's
//       record, which is why the probe's own completeness check failed and why R7.2 above was made.
//   A2  K=100, N=100: identical arms stalled in 4 and 11 of 100 cycles (3 and 7 with a read >= 5 s), p(main > fix) 0.99 and
//       p(fix > main) 0.052; they recur every 19-21 cycles (about 1 956 rewrites), 33-47 s each, load1 3.9-4.9.
//   C   12 cards, 6 of them stale: the touchDisplayed() transaction carried 12 gets and 12 puts.
//
// ── RESULT OF RUN 2 (fix + baseline copy + index arm, interleaved in random order; 1363850; 2026-11-06 10:37-10:51 JST) ───
//   load1 per cycle 5.5-13.7 (other sessions were running their own e2e containers). Order seeds 1793929060 (A), 1793929061 (A2).
//   B   S1 main 1 000 puts, fix 0; S2 200/200; S3 200/100; S4 300/0 and no record created: the mechanism, counted.
//   A   K=1000, N=40 per arm, load1 5.5-13.4 (median 6.8). Cycles with a read > 500 ms (with a read >= 5 s), touch median:
//         main 29/40 (14)  663.9 ms     fix 6/40 (6)  73.5 ms     index 1/40 (1)  0.7 ms
//       Fisher one-sided: main vs fix p = 1.6e-7, main vs index p = 1.1e-11. By the rule of the brief that reads "reduced stalls
//       in this run". (Round 2: the > 500 ms count mostly measures a read queued behind main's own touch, which takes 608-664 ms at
//       the median; read the >= 5 s count, 14 against 6, p = 0.035, as the anomaly.) But 21 of the 120 cycles had a read >= 5 s, one per about 2 000 rewrites of the main arm (18 of the 20 gaps
//       between them are exactly 2 000, two are 1 000), and they fell on main 14 times, fix 6 and index once: the stall is set off by the main arm's
//       rewrites and is suffered by whichever transaction reads a blob-carrying record next. The index arm reads no record and was
//       never delayed (its one stall was its READER's, 27.8 s, while its own transaction took 7 ms). So in an interleaved run
//       the arm counts say who stood in the way, not who caused it; runs 3B and 3 take the arms apart.
//   A2  K=100, N=100 per arm, load1 9.9-13.7: main 7/100, fix 2/100 (all of them >= 5 s), p = 0.085: no reduction is shown by
//       the rule. 9 stalled cycles in 200, one per about 22 cycles (about 1 100 main-arm rewrites).
//   C   12 cards, 6 stale: touchDisplayed() 12 gets and 6 puts.
//
// ── RESULT OF RUNS 3B AND 3 (ONE arm alone in a fresh browser; 7f3201c; K=1000, N=100, 2 s between cycles) ────────────────
//   3B  main alone, 2026-11-06 10:52-11:18 JST, load1 4.8-11 (median 7.8): 81/100 cycles with a read > 500 ms, 29/100 with a read
//       >= 5 s, one every 3.3 cycles (about 3 300 rewrites), 30-55 s each, all inside the touch's own transaction; touch median 607.9 ms.
//   3   fix alone, 11:19-11:23 JST, load1 2.4-4.1 (median 3.0): 0/100, no read over 98 ms, touch median 33.1 ms, maximum 100.1 ms.
//   3B vs 3, 29 vs 0 of 100 with a read >= 5 s: p = 1.7e-10 (81 vs 0 with a read > 500 ms: 5e-38). Two browsers at different times and
//   at different load, and Fisher assumes independent cycles where these stalls are periodic: read it as description.
//
// ── WHAT THE RUNS SAY, AND WHAT THEY DO NOT ──────────────────────────────────────────────────────────────────────────
//   Said: with a 1 986-byte blob and this host's disk, the store stalls its readers for 8-186 s after every 2 000-3 300 record
//   rewrites; the period did not change as the load fell from 42 to 4 (run 1); the stall lands on whichever transaction reads a
//   blob-carrying record next; a browser that rewrote nothing after the seeding (run 3) did not stall in 100 cycles of 1 000 reads;
//   with the fix, a touch of 1 000 fresh rows writes none (part B) and a row is rewritten once per hour instead of every 30 s.
//   Round 2: runs 2, 3B and 3 were made with X = 1 h; X is now 6 h and none of them was repeated. The fix arm performs ZERO writes
//   whatever X is (its rows are seeded fresh and nothing in a run makes them stale), so 0 of 100 in run 3 shows "no writes, no stalls",
//   not the product's rate: the product rewrites a row once per X, and every row on screen goes stale together.
//   NOT said: that the hover tail of the product is gone (it was not re-measured; probe 98's session is far shorter than a stall
//   period); how long a stall lasts on another disk (this one is a WSL2 + Docker overlay); what a real capture (up to 120 KB, not
//   1 986 bytes) does to the period; that the once-per-hour burst, when every drawn row turns stale together and is rewritten in
//   one transaction, is free: it is one touch() of the old kind per hour.
//
// The host is shared and noisy: the load average is recorded per cycle and at the start and end of every part.
// The probe's own exit status says only that its table is complete; the printed lines say what held.
// Raw data: tests/output/touch-skip-recent-probe.json.
//
// Run (the launcher copies origin/main's thumb-store.js to extension/common/thumb-store.main.js first):
//   HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose -f tests/docker-compose.yml \
//     run --rm e2e env VT_TEST_DIR=./probes EXPECT_MAIN_SHA256=<sha256 of origin/main's thumb-store.js> \
//     playwright test 98b-touch-skip-recent-probe.spec.js --reporter=list --retries=0
// Knobs: VT_ARMS=main,fix[,index]  VT_N=40  VT_N_TAB=100  VT_SEED=<int>  VT_PAUSE_MS=0  VT_SMOKE=1 (3 cycles, 60 and 20 keys: wiring check).
// One arm alone (nothing else in that browser rewrites a record), e.g. the fix, 100 cycles of part A only, 2 s apart:
//   ... env VT_TEST_DIR=./probes VT_ARMS=fix VT_N=100 VT_PAUSE_MS=2000 playwright test 98b-touch-skip-recent-probe.spec.js -g "part A \(M-A"
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('../fixtures');
const P = require('../helpers/bookmark-preview');
const { createTab, queryTabs } = require('../helpers/chrome');
const {
  settled, loadMainStore, countedTouch, fisherOneSided,
} = require('../helpers/touch-count');

const OUT = process.env.OUT_DIR || path.resolve(__dirname, '../output');
const REPORT = path.join(OUT, 'touch-skip-recent-probe.json');

const SMOKE = process.env.VT_SMOKE === '1';
const ARMS = (process.env.VT_ARMS || 'main,fix').split(',').map((s) => s.trim()).filter(Boolean);
const N_BOOKMARK = Number(process.env.VT_N || (SMOKE ? 3 : 40));
const N_TAB = Number(process.env.VT_N_TAB || (SMOKE ? 3 : 100));
const K_BOOKMARK = SMOKE ? 60 : 1000;
const K_TAB = SMOKE ? 20 : 100;
const SEEDED = 1000;
/** A pause between two cycles (ms). 0 = back to back, as in runs 1 and 2; the runs of one arm alone use 2 000. */
const PAUSE_MS = Number(process.env.VT_PAUSE_MS || 0);

/**
 * The fix's X, read from the tree under test (constants.js) so that the "stale" ages of part B and the index arm follow it.
 * A tree that has none (origin/main, the A/A run) gets the value the fix has, so that "older than X" means the same thing
 * for both arms.
 */
const X_WHEN_ABSENT = 6 * 60 * 60e3;
function freshMsOf(panel) {
  return panel.evaluate(async (fallback) => {
    const constants = await import(chrome.runtime.getURL('common/constants.js'));
    return typeof constants.TOUCH_FRESH_MS === 'number' ? constants.TOUCH_FRESH_MS : fallback;
  }, X_WHEN_ABSENT);
}
const STALL_MS = 500;
const QUIET_MS = 30;
const QUIET_READS = 5;
const CAP_MS = 600_000;
const GAP_MS = 10;

/**
 * mulberry32, a small seeded generator: an arm order can be reproduced from the seed that is printed with it.
 * @param {number} seed
 * @returns {() => number} uniform in [0, 1)
 */
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** A copy of `list` in an order drawn with `rand` (Fisher-Yates). */
function shuffled(list, rand) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
const SEED = Number(process.env.VT_SEED || Math.floor(Date.now() / 1000));

const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
const load1 = () => r1(os.loadavg()[0]);
const loadText = (a, b) => `${a.map((n) => n.toFixed(1)).join('/')} -> ${b.map((n) => n.toFixed(1)).join('/')} on ${os.cpus().length} cores`;
const urlOf = (ns, i) => `https://${ns}.example.com/page/${i}`;
const urlsOf = (ns, n) => Array.from({ length: n }, (_, i) => urlOf(ns, i));

function saveReport(part, data) {
  fs.mkdirSync(OUT, { recursive: true });
  const prior = fs.existsSync(REPORT) ? JSON.parse(fs.readFileSync(REPORT, 'utf8')) : {};
  fs.writeFileSync(REPORT, JSON.stringify({ ...prior, [part]: data }, null, 2));
}

/**
 * Put the three arms into the page as `window.__arms`, and say which file each one is.
 * @returns {Promise<{mainSha: string, ownSha: string, aa: boolean, expected: string|null, verified: boolean}>}
 */
async function installArms(panel) {
  const { mainSha, ownSha } = await loadMainStore(panel);
  const expected = process.env.EXPECT_MAIN_SHA256 || null;
  if (expected && expected !== mainSha) {
    throw new Error(`the baseline copy is not origin/main's thumb-store.js: sha256 ${mainSha}, expected ${expected}`);
  }
  const freshMs = await freshMsOf(panel);
  await panel.evaluate((a) => {
    const own = window.__vt.thumbStore;
    window.__arms = {
      main: (keys, now) => window.__mainStore.touch(keys, now),
      fix: (keys, now) => own.touch(keys, now),
      // Candidate 2, probe-local: the stale rows come from the stamp index (keys only, no value read), and only
      // those that were asked for are read and rewritten. Rows with no stamp are not in the index; the product
      // would have to decide what to do about them, the probe does not.
      index: async (keys, now) => {
        const db = await own.openDb();
        const tx = db.transaction('thumbs', 'readwrite');
        const store = tx.objectStore('thumbs');
        const want = new Set(keys);
        const done = new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || new Error('index arm: transaction failed'));
          tx.onabort = () => reject(tx.error || new Error('index arm: transaction aborted'));
        });
        const cursor = store.index('byLastUsedAt').openKeyCursor(IDBKeyRange.upperBound(now - a.freshMs));
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c) return;
          if (want.has(c.primaryKey)) {
            const get = store.get(c.primaryKey);
            get.onsuccess = () => {
              const record = get.result;
              if (record) {
                record.lastUsedAt = now;
                store.put(record);
              }
            };
          }
          c.continue();
        };
        await done;
      },
    };
  }, { freshMs });
  return {
    mainSha, ownSha, aa: mainSha === ownSha, expected, verified: expected === mainSha,
  };
}

/** One cycle, in the page. See the header for what a cycle is. */
function runCycle(panel, a) {
  return panel.evaluate(async (c) => {
    const { thumbs } = window.__vt;
    const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const reads = [];
    let touchEnd = null;
    let quiet = 0;
    let unsettled = false;
    const t0 = performance.now();
    const at = Date.now();
    const touching = (async () => {
      await window.__arms[c.arm](c.keys, at);
      touchEnd = performance.now();
    })();
    await tick(0); // the touch's transaction is open and has its requests queued
    for (;;) {
      const s = performance.now();
      const afterTouch = touchEnd !== null;
      const info = await thumbs.peekUrl(c.readUrl);
      const ms = performance.now() - s;
      reads.push({ s: s - t0, ms, afterTouch, state: info.state });
      if (afterTouch) quiet = ms < c.quietMs ? quiet + 1 : 0;
      if (afterTouch && quiet >= c.quietReads) break;
      if (performance.now() - t0 > c.capMs) {
        unsettled = true;
        break;
      }
      await tick(c.gapMs);
    }
    await touching;
    const end = performance.now();
    const all = reads.map((r) => r.ms).sort((x, y) => x - y);
    const during = reads.filter((r) => !r.afterTouch);
    return {
      arm: c.arm,
      keys: c.keys.length,
      touchMs: touchEnd - t0,
      afterMs: end - touchEnd,
      reads: reads.length,
      readMax: all[all.length - 1],
      readP50: all[Math.min(all.length - 1, Math.ceil(0.5 * all.length) - 1)],
      duringMax: during.length ? Math.max(...during.map((r) => r.ms)) : 0,
      readsOverStall: all.filter((m) => m > c.stallMs).length,
      stallAny: all.some((m) => m > c.stallMs),
      stallDuring: during.some((r) => r.ms > c.stallMs),
      unsettled,
      allLoaded: reads.every((r) => r.state === 'loaded'),
      notLoaded: reads.filter((r) => r.state !== 'loaded').length,
      firstOtherState: (reads.find((r) => r.state !== 'loaded') || {}).state || null,
    };
  }, a);
}

/**
 * Interleaved cycles of every arm, one uncounted warm-up per arm first. The arms' order in a round is a seeded
 * random permutation (criteria-impl R7.1): run 1, whose two arms were identical, showed stalls that recur every
 * 3-4 cycles at 1 000 keys and every 19-21 at 100, and a fixed rotation of period 2 or 4 lines up with that.
 * One line per cycle goes to the log as it happens.
 */
async function measure(panel, { label, urls, n, arms, seed }) {
  const keys = await panel.evaluate((list) => list.map((u) => window.__vt.urlKey(u)), urls);
  const base = {
    keys, readUrl: urls[0], gapMs: GAP_MS, stallMs: STALL_MS, quietMs: QUIET_MS, quietReads: QUIET_READS, capMs: CAP_MS,
  };
  const rand = prng(seed);
  const started = Date.now();
  // eslint-disable-next-line no-console
  console.log(`${label}: arm order in each round is a random permutation, seed ${seed}`);
  for (const arm of arms) {
    const w = await runCycle(panel, { ...base, arm });
    // eslint-disable-next-line no-console
    console.log(`${label} warm-up ${arm.padEnd(5)} touch=${r1(w.touchMs)} ms after=${r1(w.afterMs)} ms readMax=${r1(w.readMax)} ms load=${load1()}`);
  }
  const cycles = [];
  for (let round = 1; round <= n; round += 1) {
    for (const arm of shuffled(arms, rand)) {
      if (PAUSE_MS && cycles.length) await new Promise((resolve) => { setTimeout(resolve, PAUSE_MS); });
      const load = load1();
      const c = await runCycle(panel, { ...base, arm });
      cycles.push({ round, load, ...c });
      // eslint-disable-next-line no-console
      console.log(`${label} round ${String(round).padStart(3)}/${n} ${arm.padEnd(5)} touch=${String(r1(c.touchMs)).padStart(8)} ms`
        + ` after=${String(r1(c.afterMs)).padStart(8)} ms reads=${String(c.reads).padStart(4)} readMax=${String(r1(c.readMax)).padStart(8)} ms`
        + ` stall=${c.stallAny ? (c.stallDuring ? 'DURING' : 'AFTER ') : 'no    '}${c.unsettled ? ' UNSETTLED' : ''}`
        + `${c.notLoaded ? ` NOT-LOADED(${c.notLoaded}, ${c.firstOtherState})` : ''}`
        + ` load=${load} elapsed=${Math.round((Date.now() - started) / 1000)} s`);
    }
  }
  return cycles;
}

/** Per-arm counts and the Fisher lines. Returns { lines, perArm }. */
function summarise(cycles, arms, n) {
  const perArm = {};
  for (const arm of arms) {
    const own = cycles.filter((c) => c.arm === arm);
    perArm[arm] = {
      cycles: own.length,
      stalls: own.filter((c) => c.stallAny).length,
      stallsDuring: own.filter((c) => c.stallDuring).length,
      stallsOver5s: own.filter((c) => c.readMax >= 5000).length,
      unsettled: own.filter((c) => c.unsettled).length,
      touchMedianMs: r1(median(own.map((c) => c.touchMs))),
      touchMaxMs: r1(Math.max(...own.map((c) => c.touchMs))),
      afterMedianMs: r1(median(own.map((c) => c.afterMs))),
      readMaxMs: r1(Math.max(...own.map((c) => c.readMax))),
      allLoaded: own.every((c) => c.allLoaded),
    };
  }
  const lines = arms.map((arm) => {
    const s = perArm[arm];
    return `  arm ${arm.padEnd(5)} cycles ${s.cycles}  stalls ${s.stalls}/${s.cycles} (during the touch ${s.stallsDuring}; with a read >= 5 s ${s.stallsOver5s})  unsettled ${s.unsettled}`
      + `  touch median ${s.touchMedianMs} ms max ${s.touchMaxMs} ms  quiet-wait median ${s.afterMedianMs} ms  slowest read ${s.readMaxMs} ms`;
  });
  for (const arm of arms) {
    if (arm === 'main' || !perArm.main) continue;
    const a = perArm.main.stalls;
    const b = perArm[arm].stalls;
    const p = fisherOneSided(a, n, b, n);
    const gate = a >= 3 && p < 0.05
      ? `p < 0.05 and the main arm stalled ${a} >= 3 times: "reduced stalls in this run" (and nothing more)`
      : (a < 3
        ? `the main arm stalled ${a} < 3 times: the baseline did not stall at this load, so the stall effect was NOT measured`
        : `p >= 0.05: no stall reduction is shown`);
    lines.push(`  main ${a}/${n} vs ${arm} ${b}/${n}: Fisher one-sided p = ${p.toFixed(4)} -> ${gate}`);
  }
  return { lines, perArm };
}

/* ── Part B: the counter ──────────────────────────────────────────────────────────────────────────── */

test('part B (M-B): what one touch() call writes, counted (store level)', async ({ harness, serviceWorker }) => {
  test.setTimeout(3_600_000);
  const { panel } = harness;
  await settled(harness, serviceWorker);
  const loadStart = os.loadavg();
  await P.installStoreRecorder(panel);
  const shas = await installArms(panel);
  // eslint-disable-next-line no-console
  console.log(`arms: baseline copy sha256 ${shas.mainSha} (expected ${shas.expected || 'NOT GIVEN: UNVERIFIED'}, verified ${shas.verified}); `
    + `tree's own thumb-store.js sha256 ${shas.ownSha}; A/A (the tree is main) ${shas.aa}`);

  const X = await freshMsOf(panel);
  // eslint-disable-next-line no-console
  console.log(`X (TOUCH_FRESH_MS) of this tree: ${X} ms`);
  const keysOf = (urls) => panel.evaluate((list) => list.map((u) => window.__vt.urlKey(u)), urls);
  const countRecords = () => panel.evaluate(async () => (await window.__vt.thumbStore.stats()).count);
  const rows = [];

  async function scenario(name, { fresh = 0, stale = 0, absent = 0 }) {
    for (const arm of ['main', 'fix']) {
      const ns = `mb-${name.toLowerCase()}-${arm}`;
      const freshUrls = urlsOf(`${ns}-fresh`, fresh);
      const staleUrls = urlsOf(`${ns}-stale`, stale);
      const absentUrls = urlsOf(`${ns}-absent`, absent);
      if (freshUrls.length) await P.putFakeThumbs(panel, freshUrls, { lastUsedAt: Date.now() - 30_000 });
      if (staleUrls.length) await P.putFakeThumbs(panel, staleUrls, { lastUsedAt: Date.now() - X - 60_000 });
      const keys = await keysOf([...freshUrls, ...staleUrls, ...absentUrls]);
      const before = await countRecords();
      const now = Date.now();
      const call = await countedTouch(panel, arm, keys, now);
      const after = await countRecords();
      const tx = call.txs;
      const row = {
        scenario: name, arm, keysAsked: keys.length, txs: tx.length,
        gets: tx.reduce((s, t) => s + t.gets, 0), puts: tx.reduce((s, t) => s + t.puts, 0),
        recordsBefore: before, recordsAfter: after, ret: call.ret,
        stampsAreNow: tx.every((t) => t.stamps.every((s) => s === now)),
      };
      rows.push(row);
      // eslint-disable-next-line no-console
      console.log(`  ${name} ${arm.padEnd(4)} asked ${String(row.keysAsked).padStart(4)}: read-write tx ${row.txs}, gets ${row.gets}, puts ${row.puts},`
        + ` records ${before} -> ${after}, every stamp written = now: ${row.stampsAreNow}, returned ${row.ret}`);
    }
  }
  // eslint-disable-next-line no-console
  console.log('PART B: puts per touch() call');
  await scenario('S1', { fresh: SMOKE ? 60 : 1000 });
  await scenario('S2', { stale: 200 });
  await scenario('S3', { fresh: 100, stale: 100 });
  await scenario('S4', { fresh: 300, absent: 600 });
  const loadEnd = os.loadavg();

  const at = (name, arm) => rows.find((r) => r.scenario === name && r.arm === arm);
  const verdicts = [
    `S1 main puts ${at('S1', 'main').puts} of ${at('S1', 'main').keysAsked} keys (premise: ~1000; STOP below 900 when 1000 keys) | fix puts ${at('S1', 'fix').puts} (target 0)`,
    `S2 main puts ${at('S2', 'main').puts} | fix puts ${at('S2', 'fix').puts} (both 200: one per stale row)`,
    `S3 main puts ${at('S3', 'main').puts} | fix puts ${at('S3', 'fix').puts} (target 100)`,
    `S4 main puts ${at('S4', 'main').puts} | fix puts ${at('S4', 'fix').puts} (target 0); records ${at('S4', 'fix').recordsBefore} -> ${at('S4', 'fix').recordsAfter} (unchanged)`,
  ];
  saveReport('partB', {
    shas, hostLoadavg: { start: loadStart, end: loadEnd }, rows, verdicts,
  });
  // eslint-disable-next-line no-console
  console.log(`${verdicts.join('\n')}\nhost load ${loadText(loadStart, loadEnd)}\n`);
  expect(rows.length, 'every scenario ran on both arms').toBe(8);
});

/* ── Part A and A2: the clock ─────────────────────────────────────────────────────────────────────── */

/**
 * Delete every record that is not one of `keepUrls` and say what the store holds. The capture of the active tab that
 * `settled()` waits for is one more record; with the 1 000 seeded ones that is over PRUNE.maxEntries, and the
 * maintenance alarm (every 30 min) then prunes the oldest unprotected record, which run 1 saw take the reader's.
 * @returns {Promise<{before: number, extra: number, after: number}>}
 */
function keepOnly(panel, keepUrls) {
  return panel.evaluate(async (urls) => {
    const store = window.__vt.thumbStore;
    const db = await store.openDb();
    const tx = db.transaction('thumbs', 'readonly');
    const keys = await new Promise((resolve, reject) => {
      const request = tx.objectStore('thumbs').getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const want = new Set(urls.map((u) => window.__vt.urlKey(u)));
    const extra = keys.filter((key) => !want.has(key));
    if (extra.length) await store.deleteThumbs(extra);
    return { before: keys.length, extra: extra.length, after: (await store.stats()).count };
  }, keepUrls);
}

/**
 * Read one stored record until five reads in a row take < 30 ms (cap 300 s): whatever the seeding's own writes left
 * behind in the backend is waited out before the first cycle, instead of being charged to it. Run 2 saw a stall right
 * after the seeding, in its first measured cycle.
 * @returns {Promise<{ms: number, reads: number, quiet: boolean}>}
 */
function settleStore(panel, readUrl) {
  return panel.evaluate(async (a) => {
    const { thumbs } = window.__vt;
    const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const s0 = performance.now();
    let quiet = 0;
    let reads = 0;
    while (quiet < a.quietReads && performance.now() - s0 < a.capMs) {
      const t = performance.now();
      await thumbs.peekUrl(a.readUrl);
      reads += 1;
      quiet = performance.now() - t < a.quietMs ? quiet + 1 : 0;
      await tick(a.gapMs);
    }
    return { ms: performance.now() - s0, reads, quiet: quiet >= a.quietReads };
  }, {
    readUrl, quietMs: QUIET_MS, quietReads: QUIET_READS, capMs: 300_000, gapMs: GAP_MS,
  });
}

async function timingPart(harness, serviceWorker, { part, k, n, arms, seed }) {
  test.setTimeout(10_800_000);
  const { panel } = harness;
  await settled(harness, serviceWorker);
  const loadStart = os.loadavg();
  const shas = await installArms(panel);
  // eslint-disable-next-line no-console
  console.log(`arms ${arms.join(',')}: baseline copy sha256 ${shas.mainSha} (verified ${shas.verified}); tree's own ${shas.ownSha}; A/A ${shas.aa}`);
  const all = urlsOf('bulk', SEEDED);
  const t0 = Date.now();
  await P.putFakeThumbs(panel, all);
  const blobBytes = await panel.evaluate(async (u) => (await window.__vt.thumbStore.getThumb(window.__vt.urlKey(u))).blob.size, all[0]);
  const storeStart = await keepOnly(panel, all);
  // eslint-disable-next-line no-console
  console.log(`${part}: ${SEEDED} records with a blob of ${blobBytes} bytes seeded in ${Math.round((Date.now() - t0) / 1000)} s; `
    + `store held ${storeStart.before} records, ${storeStart.extra} other deleted, now ${storeStart.after}; touched per cycle ${k}; N ${n} per arm; load ${load1()}`);
  expect(storeStart.after, 'the store holds exactly the seeded records').toBe(SEEDED);
  const calm = await settleStore(panel, all[0]);
  // eslint-disable-next-line no-console
  console.log(`${part}: after seeding, ${calm.reads} reads over ${r1(calm.ms)} ms until five in a row were quick (reached: ${calm.quiet}); pause between cycles ${PAUSE_MS} ms`);

  const cycles = await measure(panel, {
    label: part, urls: all.slice(0, k), n, arms, seed,
  });
  const storeEnd = await panel.evaluate(async () => (await window.__vt.thumbStore.stats()).count);
  const loadEnd = os.loadavg();
  const { lines, perArm } = summarise(cycles, arms, n);
  saveReport(part, {
    shas, k, n, arms, seed, pauseMs: PAUSE_MS, calm, blobBytes, storeStart, storeEnd, hostLoadavg: { start: loadStart, end: loadEnd }, perArm, cycles,
  });
  // eslint-disable-next-line no-console
  console.log(`\n${part.toUpperCase()} ${k} keys per cycle, ${SEEDED} records of ${blobBytes} bytes, N ${n}, order seed ${seed}; `
    + `store ${storeStart.after} -> ${storeEnd} records; host load ${loadText(loadStart, loadEnd)}\n${lines.join('\n')}\n`);

  expect(cycles.length, 'every cycle ran').toBe(n * arms.length);
  expect(storeEnd, 'the store held the same records at the end').toBe(storeStart.after);
  expect(cycles.every((c) => c.allLoaded), 'every read found the stored picture').toBe(true);
}

test('part A (M-A, M-C): 1000-key cycles, the bookmark column\'s touch (store level)', async ({ harness, serviceWorker }) => {
  await timingPart(harness, serviceWorker, {
    part: 'partA', k: K_BOOKMARK, n: N_BOOKMARK, arms: ARMS, seed: SEED,
  });
});

test('part A2: 100-key cycles, the size of a heavy tab-card touch (store level)', async ({ harness, serviceWorker }) => {
  await timingPart(harness, serviceWorker, {
    part: 'partA2', k: K_TAB, n: N_TAB, arms: ARMS.filter((a) => a !== 'index'), seed: SEED + 1,
  });
});

/* ── Part C: the tab-card path with real cards ────────────────────────────────────────────────────── */

test('part C: what the tab cards\' touchDisplayed() writes for 12 real cards', async ({ harness, serviceWorker, fixtures }) => {
  test.setTimeout(600_000);
  const { panel, w2 } = harness;
  await settled(harness, serviceWorker);
  const loadStart = os.loadavg();
  const extra = 9;
  for (let i = 0; i < extra; i += 1) {
    await createTab(serviceWorker, w2, fixtures.page('aa4400', `Card${i}`, { n: i }));
  }
  const tabs = await queryTabs(serviceWorker, w2);
  expect(tabs.length, 'the scoped window has the three fixture tabs and nine more').toBe(3 + extra);
  await expect.poll(() => panel.locator('[data-testid="tab-card"]').count(), { timeout: 30_000 }).toBe(tabs.length);

  // Half the cards get a record stamped 30 s ago, half one stamped 2 h ago. The service worker may have
  // captured some of these tabs already; the seeded record replaces it, so the counts do not depend on that.
  const keys = [];
  const stale = new Set();
  for (let i = 0; i < tabs.length; i += 1) {
    const isStale = i % 2 === 1;
    const key = await P.putFakeThumb(panel, tabs[i].url, { lastUsedAt: Date.now() - (isStale ? 2 * 3600e3 : 30_000) });
    keys.push(key);
    if (isStale) stale.add(key);
  }
  await P.installStoreRecorder(panel);
  const keySet = new Set(keys);
  const mine = (rec) => rec.tx.find((t) => t.mode === 'readwrite' && t.keys.length >= keys.length && t.keys.every((x) => keySet.has(x)));
  let seen = null;
  await expect.poll(async () => {
    await panel.evaluate(() => window.__vt.thumbs.touchDisplayed());
    seen = mine(await P.readStoreRecorder(panel));
    return Boolean(seen);
  }, { timeout: 60_000, intervals: [1000], message: 'touchDisplayed() ran for all the cards once its 30 s throttle opened' }).toBe(true);
  const stamps = await Promise.all(keys.map((key) => P.lastUsedAt(panel, key)));
  const refreshed = keys.filter((key, i) => stamps[i] > Date.now() - 600_000).length;
  const loadEnd = os.loadavg();
  const verdict = `cards ${tabs.length}, records ${keys.length} (${stale.size} stamped 2 h ago, ${keys.length - stale.size} stamped 30 s ago): `
    + `the touchDisplayed() transaction carried ${seen.gets} gets and ${seen.puts} puts; rows whose stamp is recent afterwards: ${refreshed}`
    + ` (unchanged code: puts = ${keys.length}; the fix: puts = ${stale.size})`;
  saveReport('partC', {
    hostLoadavg: { start: loadStart, end: loadEnd }, cards: tabs.length, records: keys.length, stale: stale.size, gets: seen.gets, puts: seen.puts, refreshed, verdict,
  });
  // eslint-disable-next-line no-console
  console.log(`PART C ${verdict}; host load ${loadText(loadStart, loadEnd)}\n`);
  expect(seen.gets, 'the call read every card').toBeGreaterThanOrEqual(keys.length);
});
