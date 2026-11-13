// 104-bookmark-folders-probe — THROWAWAY platform probe, "Probe 17" in .agent/probe-results.md.
//
// NOT a regression test of Vertical Tabs. It measures the Chromium 151.0.7922.34 facts that CLAUDE.md §7.2 forbids
// asserting from memory and that PR2 (bookmark folders: create, rename, reorder, move) depends on: probes PA, PB and
// PC of the PR2 plan (§11). Nothing in this file asserts a Chrome behaviour: every test only checks that the complete
// record described by its PASS criterion was produced. What the numbers mean is decided afterwards, in
// probe-results.md, by applying the decision rules below. They are fixed HERE, before the first run (Probe 15's
// discipline), and are not re-chosen from the numbers. A rule that turns out to be unusable (a probe bug, a premise
// that cannot be built) is amended in a LATER commit with its reason written next to it; the amendment is reported
// as an amendment, never folded in silently.
//
// Written 2026-11-05, before any run of this probe. This commit holds the header only; the measurement body is
// added in the next commit.
//
// ── PASS CRITERION (the probe has produced its table) ─────────────────────────────────────────────────────────
//   PA  259 cell records under PA.cells, plus PA.audit
//   PB  134 cell records under PB.cells, plus PB.audit
//   PC   18 cell records under PC.cells
// A record is MEASURED (premiseOk: true: the fixture, or the DOM, was in the state the cell says it was in before the
// call or the press, checked from a read taken before it) or NOT MEASURED (premiseOk: false, with the reason). A
// not-measured cell is written up as "not measured"; it is never skipped, and it never counts as fitting a rule. The
// tests assert only that the number of records is complete. Anything the spec computes (`fits`, classes) exists to
// make the record readable; the rules below are what is applied.
//
// ── CELLS ─────────────────────────────────────────────────────────────────────────────────────────────────────
// PA (a throwaway MV3 extension with `bookmarks` required, the harness of Probe 13: writes come from the panel
//    document, events are recorded in the panel AND in the service worker, a fresh folder per cell under the
//    Bookmarks bar)
//   PA.same.n<N>.s<S>.k<K>      same-parent move. A list of N links (titles A, B, C ...), the child at position S moved
//       with `index` K in {0 .. N, N+1, "omitted"} (N+3 values). N in {1, 2, 3, 5, 8}: the sizes Probe 13 did not
//       measure = 4 + 10 + 18 + 40 + 88 = 160 cells; plus N = 4 as a CONTROL against Probe 13 P1 = 28 cells (K = 0 .. 4,
//       5, "omitted"; Probe 13 used 9 where this uses 5, and recorded 5 in its supplementary rows). 188 cells.
//   PA.cross.m<M>.<leaf|folder3>.i<I>   cross-parent move. F = [p, X, q] with X (index 1) a link, or a folder holding
//       three links, moved into G, a folder holding M links (M in {0, 1, 2, 5}; 0 is an EMPTY folder) with `index` I in
//       {0 .. M, M+1, "omitted"}. 2 x (3 + 4 + 5 + 8) = 40 cells.
//   PA.create.m<M>.i<I>         create({parentId, title: "N", index}) in a folder holding M links, M in {0, 1, 2, 5, 8},
//       I in {0 .. M, M+1, "omitted"} = 3 + 4 + 5 + 8 + 11 = 31 cells. (The plan lists the EMPTY and the 1-child folder;
//       2, 5 and 8 are added.)
//   188 + 40 + 31 = 259 cells. Not in PA: a negative `index` at other sizes (Probe 13 measured it at N = 4: it throws
//   synchronously, "Value must be at least 0."; argument validation does not depend on the list).
//
// PB (the same extension; the two permanent folders start EMPTY in the fresh profile and every cell ends with both
//    emptied again, by removeTree/remove of their children: setup, not measured. So the destination's child count at
//    call time is known by construction. `bar` = the bookmarks-bar folder (id "1"), `other` = "Other bookmarks" ("2"))
//   PB.into.<bar|other>.m<M>.<leaf|folder3>.i<I>   move of X (a link, or a folder with three links) from a normal folder
//       that sits under the OTHER permanent folder, INTO the permanent folder, which holds M links (M in {0, 3}; 0 is an
//       EMPTY permanent folder), `index` I in {0 .. M, M+1, "omitted"}. 4 x (3 + 6) = 36 cells.
//   PB.cross.<bar-other|other-bar>.<leaf|folder3>.i<I>.<forth|back>   X is the LAST child of one permanent folder (three
//       links in front of it) and the other holds three links: "forth" moves X across with `index` I in {0, 3, "omitted"},
//       "back" moves it home again with the same I (the home folder then holds three links). 2 x 2 x 3 x 2 = 24 cells.
//   PB.create.<bar|other>.m<M>.i<I>   create a folder directly under the permanent folder (M links in it, M in {0, 3}),
//       I in {0 .. M, M+1, "omitted"}. 2 x (3 + 6) = 18 cells.
//   PB.same.<bar|other>.s<S>.k<K>     same-parent move INSIDE a permanent folder holding four links A B C D, S in 0..3,
//       K in {0 .. 4, 5, "omitted"}. 2 x 28 = 56 cells. NOT in the plan's list: "a root as a destination" also means
//       reordering the children of a root, which is a same-parent move whose parent is a root; the reorder feature does
//       exactly that at depth 1, so it is measured here rather than assumed.
//   36 + 24 + 18 + 56 = 134 cells. Probe 13 P5 only moved the permanent folders themselves and created under them
//   without an `index`.
//
// PC (the REAL extension through the e2e `granted` fixture: the shipped extension with `bookmarks` moved into
//    `permissions`; the panel opened as a tab, 460 x 700; the Bookmarks bar open: 2 depth-0 rows and 58 children, 60 rows
//    in #bookmark-rail, which scrolls. The rail does not make rows draggable yet, so the PROBE sets draggable="true" on
//    every depth > 0 row and draggable="false" on the favicons (what PR2 plans, plan §3.1). The drag is Playwright's
//    page.mouse. A page-side logger is installed once; it calls preventDefault on dragenter/dragover/drop so a drop is
//    possible, and swallows every `click` at the window's capture phase, so a press that does not start a drag cannot
//    toggle a folder or open a tab.)
//   PC.setup                    rows, depth-0 rows, whether the rail scrolls, the list's row gap; and, as a diagnostic,
//                               what the installed playwright-core does for a mouse drag (read from its source, not assumed)
//   PC.a.bottom / PC.a.top / PC.a.middle   (a) the pointer stationary, drag in progress, 3000 ms: inside the bottom edge
//       zone (12 px above the rail's bottom, the zone is DRAG_AUTOSCROLL_EDGE_PX = 40), inside the top edge zone, and in
//       the middle of the rail (control). 3 cells.
//   PC.b                        (b) a link row is hovered until its preview card shows (control), pressed, dragged over
//       three other link rows, held 900 ms on the last one, dropped, then another link row is hovered (control). 1 cell.
//   PC.c.<variant>              (c) and (d): a press at the centre of the element, 40 px down in 8 steps, release. Variants
//       with the dragstart handler setting ONLY "application/x-vt-bookmark": folder-twisty (the 10 px chevron svg),
//       folder-glyph (the 15 px folder svg), folder-main (.w-row__main), link-favicon-nodrag (img, draggable="false"),
//       link-favicon-control (img without the attribute), link-main (.w-row__main), row-padding (the row itself, reference);
//       and with a handler that sets NOTHING: link-main-notype, link-favicon-notype. 9 cells.
//   PC.e.gap1 / gap2 / gap3 / row   (e) a drag from the first link row, dropped on the 1 px gap between two link rows
//       (three different pairs), and on the centre of a row (reference). 4 cells.
//   1 + 3 + 1 + 9 + 4 = 18 cells.
//
// ── DECISION RULES (fixed before the first run) ───────────────────────────────────────────────────────────────
// Rule M2, for a same-parent move of the child at position S with `index` K in a list of N, T = K (N when omitted):
//   T > N    rejects, the message contains "Index out of bounds.", the order is unchanged, no event of any kind.
//   T <= N   resolves. FINAL = T > S ? T - 1 : T. The order after is the list with that child removed and re-inserted at
//            FINAL. The resolved node's `index` is FINAL. FINAL != S: exactly one onMoved in the panel and exactly one in
//            the SW, each {oldIndex: S, index: FINAL, oldParentId == parentId}. FINAL == S: no event of any kind.
// Cross-parent move of X (at oldIndex in F) into G (M children) with `index` I, T = I (M when omitted):
//   T > M    rejects "Index out of bounds.", F and G unchanged, no event.
//   T <= M   resolves. The resolved node's `index` is T. G after = G before with X inserted at T. F after = F before
//            without X. Exactly one onMoved per context {oldParentId: F, oldIndex, parentId: G, index: T}. X keeps its id;
//            for a folder its children are identical (ids, order, titles).
// create with `index` I in a folder of M children, T = I (M when omitted):
//   T > M    rejects "Index out of bounds.", nothing changes, no event.
//   T <= M   resolves. The resolved node's `index` is T, it sits at position T, it has no `url` key, and there is exactly
//            one onCreated per context, with index T.
// Every cell also needs getChildren()[i].index === i for every i of the folders it touched, after the call. A cell FITS
// iff every line that applies to it holds.
//
// PA verdict. All 259 cells measured and fitting: "M2 holds at every size measured", `bookmarkMoveArg` is the plan's §1
//   contract and U1's unit table is these rows as literal order strings. A measured cell that does not fit: STOP; list
//   the cells; the helper is redesigned from the measured table before U1 is finished, not patched. A cell not measured:
//   that size and kind is "not established", never "holds". The N = 4 cells are a control: they must reproduce
//   Probe 13 P1 (K = 0 .. 4 and "omitted"; K = 5 as in its supplementary rows). A control cell that does not fit while
//   Probe 13 says it did means the harness differs from Probe 13's, and nothing in PA is established until that is explained.
// PB verdict. The same rules, with a permanent folder as the parent: all 134 cells measured and fitting: "a permanent
//   folder is a destination like an ordinary folder", so root rows are "inside" drop targets, "New folder inside <root>"
//   is allowed with and without an index, and the children of a root are reordered by M2. A measured cell that does not
//   fit: STOP; "a root cannot be a destination" for the cells listed, and which cells it is decides what the UI may offer
//   (the generic toast is the text for them). A cell not measured: not established.
//
// PC (a). T0 = the page clock read right after the last pointer move returned; E = the number of `dragover` events whose
//   page time is later than T0 + 100 ms, in the 3000 ms window. A control move of 2 px afterwards must produce at least
//   one `dragover` (otherwise the cell is not measured). E == 0 in all three cells: "dragover does not repeat while the
//   pointer is stationary, in this harness"; auto-scroll then needs its own interval, started by `dragover` and stopped
//   by `dragleave` / `drop` / `dragend` (the plan's rule). E >= 1 in any cell: "dragover repeats"; the cadence (every
//   interval, min, median, max) is recorded and the interval design stays the default, because the native drag loop is
//   not measured here and a `dragover`-driven step would need the owner's real-Chrome check (G11).
// PC (b). The drag window is from the first `dragstart` to the `drop`. Counted in it: pointerover, pointerout, pointermove,
//   mouseover, mouseout, mousemove, pointerenter/leave, mouseenter/leave, anywhere and on link rows, and the preview
//   card (`[data-testid="bookmark-preview"]`) sampled every 50 ms. The cell is measured only if the hover control showed
//   a card before the press and a `dragstart` happened. No `pointerover` on a link row in the window AND no card sampled in
//   it: `bookmark-preview.js` stays untouched (B1.2). At least one `pointerover` on a link row in the window, whether or
//   not a card showed: `bookmark-preview.js` gets the <= 5-line drag guard and a test that fails without it (B1.2's
//   exception). The "after" hover is the control that the same listeners work once the drag is over.
// PC (c). Class of the first `dragstart`'s target: "row" = the row <button> itself; "inside:<TAG>" = a descendant of a row;
//   "none" = no `dragstart` within 1500 ms after the 40 px move (the 1500 ms is the wait: an absence needs time to
//   pass); anything else = "other:<TAG>". For folder-twisty and folder-glyph: "none" -> `pointer-events: none` on
//   `.bmk-row__twisty` and `.bmk-row__glyph`; "row" -> no CSS rule, the dragstart handler resolves the row with
//   `event.target.closest('[data-bookmark-id]')`; "inside:*" -> the handler resolves through `closest` and the svg gets
//   `draggable="false"` or `pointer-events: none`. link-favicon-nodrag: "row" expected (Probe 13 P8); anything else ->
//   `pointer-events: none` on `.bmk-row__icon`. link-favicon-control: only confirms in the real rail that
//   draggable="false" on the favicon is what keeps the drag on the row (Probe 13 P8 expects "inside:IMG" with
//   text/uri-list and text/html). folder-main and link-main: "row" expected; "none" or "inside:*" means the plan must change
//   (a press on the row's text has to start the row's drag). row-padding is the reference.
// PC (d). `dataTransfer.types` read three times per drag: at `dragstart` right after the handler's setData, at the first
//   `dragover`, at `drop` (the last two are what the rail's own handlers will see). Every variant with the private-type
//   handler lists exactly ["application/x-vt-bookmark"] at all three moments, and the two "notype" variants list []:
//   no default type exists, and B7.7's assertion "types equals exactly ['application/x-vt-bookmark']" is valid as written.
//   Any other type in any of them (text/plain, text/uri-list, text/html, ...): `setData` of an empty text/plain is NOT
//   enough, B7.7 asserts equality with the private type only, and the handler has to call `dataTransfer.clearData()`
//   first; whether `clearData()` removes the defaults is NOT measured by this probe (a follow-up would be needed).
//   A moment at which the private type is missing from the list is recorded as such: the rail's dragover handler could
//   not recognise its own drag from `types` there and must use module state (`S.drag`) instead. A "notype" drag that
//   stops after `dragstart` has only its first moment. link-favicon-control is a control and is excluded from this rule.
// PC (e). The drop point is 0.5 px below the bottom of the upper row (0.25 and 0.75 are tried if 0.5 does not resolve);
//   the cell is measured only if `document.elementFromPoint` there is the list container (`bookmark-list`) before the
//   drag. Class of the LAST `dragover` target and of the `drop` target: "list" (the container), "rail", "row" (a row or a
//   descendant), other. "list" or "rail": the plan's sticky-target rule (D5, keep the previous valid target on a gap)
//   is needed. "row": Blink resolves the gap to a row, and no such rule is needed.
//
// What this probe cannot say, by construction (stated now, not after): the drag is Playwright's page.mouse in headless
// Chromium with the panel opened as a TAB. (a) and (b) measure what THAT drag does (PC.setup records how the installed
// playwright-core drives it); what Chrome's native drag loop does with a stationary pointer or with pointer events in a
// real side panel is not measured here and stays on the owner's real-Chrome list (G11). Likewise Escape mid-drag, a drop
// outside the panel, Alt+Arrow in Chrome, managed/unmodifiable nodes, a signed-in profile's extra roots, un-awaited
// write bursts, index rules for list sizes other than those above.
//
// ── TWO RUNS ────────────────────────────────────────────────────────────────────────────────────────────────
// The probe is run twice, each on its own `git archive` copy of the same commit, in separate containers. The two JSON
// reports are compared cell by cell: for every key under PA.cells, PB.cells and PC.cells, the cell with node ids
// (`id`, `parentId`, `oldParentId`, `ids`, `rowId`), timings (keys ending in `Ms`), timestamps (keys ending in `At`,
// `startedAt`, `t`), the host load, and the `raw` and `diag` sub-records removed. Everything else (strings, booleans,
// counts, class names) is compared exactly. The number of cells compared and the number that differ (a cell missing
// from one report counts as differing) are written into probe-results.md.
//
// Run (probes live outside testDir; in the e2e container, never on the host; ALWAYS --retries=0, the repo config says
// retries: 1 and that would turn a first failure into a pass):
//   HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose -f tests/docker-compose.yml \
//     run --rm e2e env VT_TEST_DIR=./probes playwright test 104-bookmark-folders-probe.spec.js \
//     --reporter=list --retries=0
// One part only: add `-g "PA:"`, `-g "PB:"` or `-g "PC:"`. The report is tests/output/bookmark-folders-probe.json.
'use strict';

// ── NOTE added with the body (2026-11-06) and amended the same day after run 0 ─────────────────────────────────
// Every comment line above this note is byte-identical to the header-only commit d733d60 ("Probe 17 header: PASS
// criterion and decision rules, before any run"), which was committed and pushed before any run; its sentence "This
// commit holds the header only" refers to that commit.
//
// RUN 0 (this file as committed in de05b4a; 2026-11-06 10:34:47 to 10:39:37 JST; log and JSON kept with the run): PA 259
// of 259 cells measured, 259 fit; PB 134 of 134 measured, 134 fit; PC 11 of 18 measured. The DECISION RULES of the header
// were not changed after that. Seven PC cells were refused by their own PREMISES, and the premises of three groups of
// them were wrong for reasons that say nothing about Chromium, so they were amended in the commit that carries this note.
// The amendments, each marked "AMENDED after run 0" where it is used:
//   1. PC (a), all three cells: run 0 demanded a `dragover` after a 2 px VERTICAL control move. At the bottom edge that
//      move changed the element under the pointer, which makes Blink fire `dragenter`/`dragleave` instead of `dragover`,
//      so PC.a.bottom was refused. The control is now a 2 px HORIZONTAL move that must produce a `dragenter` or a
//      `dragover`. E (`dragover` events later than T0 + 100 ms) and its rule are unchanged.
//   2. PC (c), the two `svg` variants: run 0 demanded that the element at the press point be the svg. It never is
//      (`svg.icon { pointer-events: none }`, sidepanel.css:346-352), so both cells were refused. The press is now made at
//      the svg's centre whatever the hit test returns, and the cell records what it returned.
//   3. PC (e), the three gap cells: run 0 looked for a point 0.5, 0.25 or 0.75 px below the upper row whose
//      `elementFromPoint` is the list container and found none. The amended probe scans integer coordinates around the
//      edge and a 0.25 px grid and records the scan.
//   4. PC (e), all four cells: run 0 demanded >= 4 `dragover` before the release; Blink fires `dragover` only when the
//      element under the pointer did not change, so PC.e.row (3 of them, then 3 s of waiting) was refused. The premise is
//      now that a `dragenter` or `dragover` arrived within 1 px of the release point; the class of the last
//      `dragenter`/`dragover` is recorded next to the pre-registered class of the last `dragover`.
// Added as DIAGNOSTICS only (in `diag`, which the two-run comparison excludes; no rule attached): the rail's scrollTop,
// sampled every 100 ms, in PC (a) (run 0 showed the rail scrolling by itself while the pointer was still); the raw
// drop data and the dragged id in PC (c); the scan of PC (e); where playwright-core keeps its drag module (run 0 looked at
// a path that does not exist in 1.62.1). Renamed for clarity: PC.b `duringDrag.cardSamples` -> `cardSamplesTaken` (it
// said that samples were taken, which reads like "a card was sampled"; `maxCardsSampled` carries the fact). New
// bookkeeping fields: PC (a) `stationaryDragEvents`, `controlMoveDragenters`; PC (c) `svg.*`; PC (e) `chosen*`, `lastEnterOrOver*`.
// The expectation helpers below (`expectSame`, `expectCross`, `expectCreate`) turn the header's rule M2 and its
// counterparts into strings for the `fits` field; they decide nothing, and the tests never assert them.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect, chromium } = require('@playwright/test');
const { granted } = require('../helpers/bookmarks');
const P = require('../helpers/bookmark-preview');

const OUT = process.env.OUT_DIR || path.resolve(__dirname, '../output');
const PROBE_ROOT = path.join(OUT, 'probe-ext-104');
const REPORT = path.join(OUT, 'bookmark-folders-probe.json');

const PA_EXPECTED = 259;
const PB_EXPECTED = 134;
const PC_EXPECTED = 18;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Merges one record into the JSON report and prints a ONE-line summary (the raw JSON is in the report file). */
function record(key, value, summary) {
  fs.mkdirSync(OUT, { recursive: true });
  const prev = fs.existsSync(REPORT) ? JSON.parse(fs.readFileSync(REPORT, 'utf8')) : {};
  prev[key] = value;
  fs.writeFileSync(REPORT, JSON.stringify(prev, null, 2));
  console.log(`===== ${key}: ${summary || ''} (${JSON.stringify(value).length} bytes in ${path.basename(REPORT)})`);
}

// ---------------------------------------------------------------------------------------------------------
// PA / PB harness: copied from 95-bookmark-writes-probe.spec.js (Probe 13), not shared, so the probes stay
// independent. The recorder runs in the service worker AND in the panel document; `call()` runs one
// chrome.bookmarks method and records whether it threw synchronously or rejected, the message, the resolved value,
// and every event that arrived from the call until 200 ms after the last one. No backticks and no dollar-brace
// inside RECORDER_JS: it is embedded in a template literal.
// ---------------------------------------------------------------------------------------------------------
const RECORDER_JS = String.raw`
(function (g) {
  const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  const msg = (e) => String((e && e.message) || e);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const R = { seq: 0, events: [], bound: [], bindState: 'not-run', bootId: Math.random().toString(36).slice(2) };
  g.__rec = R;
  const mark = () => ++R.seq;
  const NAMES = ['onCreated', 'onChanged', 'onMoved', 'onRemoved', 'onChildrenReordered', 'onImportBegan', 'onImportEnded'];
  R.bind = () => {
    if (R.bindState === 'bound') return R.bindState;
    if (!g.chrome || !g.chrome.bookmarks) { R.bindState = 'chrome.bookmarks undefined'; return R.bindState; }
    for (const n of NAMES) {
      const ev = g.chrome.bookmarks[n];
      if (!ev || typeof ev.addListener !== 'function') continue;
      ev.addListener((...args) => { R.events.push({ kind: n, seq: mark(), wall: Date.now(), args: clone(args) }); });
      R.bound.push(n);
    }
    R.bindState = 'bound';
    return R.bindState;
  };
  R.quiet = async (quietMs, maxMs) => {
    const t0 = performance.now();
    let n = R.events.length;
    let last = t0;
    for (;;) {
      await wait(20);
      const now = performance.now();
      if (R.events.length !== n) { n = R.events.length; last = now; }
      if (now - last >= quietMs) return { ms: Math.round(now - t0), capped: false };
      if (now - t0 >= maxMs) return { ms: Math.round(now - t0), capped: true };
    }
  };
  R.call = async (label, method, args) => {
    const evStart = R.events.length;
    const t0 = performance.now();
    mark();
    let p; let threw = null; let error = null; let raw; let resolved = false;
    try { p = g.chrome.bookmarks[method].apply(g.chrome.bookmarks, args); }
    catch (e) { threw = 'sync'; error = msg(e); }
    if (!threw) {
      try { raw = await p; resolved = true; } catch (e) { threw = 'async'; error = msg(e); }
    }
    const resolveSeq = mark();
    const resolveMs = +(performance.now() - t0).toFixed(2);
    const quiet = await R.quiet(200, 3000);
    const evs = R.events.slice(evStart);
    return {
      label, method, args: clone(args), resolved, threw, error,
      resultType: Object.prototype.toString.call(raw), result: clone(raw), resolveMs, quiet,
      events: evs.map((e) => ({ kind: e.kind, args: e.args, beforeResolve: e.seq < resolveSeq })),
      nBeforeResolve: evs.filter((e) => e.seq < resolveSeq).length,
      nAfterResolve: evs.filter((e) => e.seq > resolveSeq).length,
      eventBeforeResolve: evs.length ? evs.every((e) => e.seq < resolveSeq) : null,
    };
  };
  const slim = (n) => ({ id: n.id, index: n.index, parentId: n.parentId, title: n.title, hasUrl: 'url' in n, url: n.url });
  R.children = async (id) => (await g.chrome.bookmarks.getChildren(id)).map(slim);
  R.get = async (ids) => clone(await g.chrome.bookmarks.get(ids));
  R.tree = async () => clone(await g.chrome.bookmarks.getTree());
  R.subtree = async (id) => clone(await g.chrome.bookmarks.getSubTree(id));
  async function mk(parentId, spec) {
    const out = [];
    for (const s of spec) {
      const a = { parentId, title: s.title };
      if (s.url) a.url = s.url;
      const n = await g.chrome.bookmarks.create(a);
      out.push({ id: n.id, title: n.title, children: s.children ? await mk(n.id, s.children) : [] });
    }
    return out;
  }
  // Setup helper (not a measurement). Waits until its own events have drained so they cannot leak into the
  // next measured call.
  R.make = async (parentId, spec) => { const out = await mk(parentId, spec); await R.quiet(150, 3000); return out; };
  R.audit = async () => {
    const tree = await g.chrome.bookmarks.getTree();
    const issues = []; let folders = 0; let children = 0;
    async function walk(n) {
      if (!n.children) return;
      folders++;
      const viaGetChildren = await g.chrome.bookmarks.getChildren(n.id);
      n.children.forEach((c, i) => {
        children++;
        if (c.index !== i) issues.push({ via: 'getTree', parentId: n.id, position: i, index: c.index, id: c.id });
        if (viaGetChildren[i] === undefined || viaGetChildren[i].id !== c.id) issues.push({ via: 'order', parentId: n.id, position: i, id: c.id });
      });
      viaGetChildren.forEach((c, i) => { if (c.index !== i) issues.push({ via: 'getChildren', parentId: n.id, position: i, index: c.index, id: c.id }); });
      if (viaGetChildren.length !== n.children.length) issues.push({ via: 'length', parentId: n.id, a: viaGetChildren.length, b: n.children.length });
      for (const c of n.children) await walk(c);
    }
    for (const r of tree) await walk(r);
    return { folders, children, issues };
  };
})(globalThis);
`;

const PANEL_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>probe panel</title></head>
<body style="font:14px sans-serif;margin:8px"><pre id="log"></pre>
<script type="module" src="panel.js"></script></body></html>`;

// Top-level and synchronous, as MV3 requires for listeners registered at service worker start.
const SW_JS = RECORDER_JS + `
self.__rec.bind();
chrome.runtime.onMessage.addListener(() => {});
`;

const PANEL_JS = RECORDER_JS + `
window.__rec.bind();
window.__rec.ready = true;
document.getElementById('log').textContent = 'ready ' + window.__rec.bindState;
`;

function writeExtension() {
  const dir = path.join(PROBE_ROOT, 'required');
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    manifest_version: 3,
    name: 'bookmark folders probe (required)',
    version: '1.0.0',
    minimum_chrome_version: '120',
    side_panel: { default_path: 'panel.html' },
    action: { default_title: 'probe' },
    background: { service_worker: 'sw.js', type: 'module' },
    permissions: ['sidePanel', 'tabs', 'storage', 'bookmarks'],
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'panel.html'), PANEL_HTML);
  fs.writeFileSync(path.join(dir, 'panel.js'), PANEL_JS);
  fs.writeFileSync(path.join(dir, 'sw.js'), SW_JS);
  return dir;
}

// Copied from 95 (itself from 90-bookmarks-probe.spec.js), with launch/SW timeouts raised because the host is busy.
async function launch(dir) {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    timeout: 120_000,
    args: [
      `--disable-extensions-except=${dir}`,
      `--load-extension=${dir}`,
      ...(process.env.VT_CHROMIUM_NO_SANDBOX !== '0' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    ],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 90_000 });
  return { context, sw, id: sw.url().split('/')[2] };
}

/** The panel document as a TAB (no Page exists for the real side panel in headless). */
async function openPanelTab(context, id) {
  const tab = await context.newPage();
  await tab.goto(`chrome-extension://${id}/panel.html?as=tab`);
  await tab.waitForFunction(() => window.__rec && window.__rec.ready === true, null, { timeout: 60_000 });
  return tab;
}

async function openEnv() {
  const dir = writeExtension();
  const { context, sw, id } = await launch(dir);
  const page = await openPanelTab(context, id);
  const env = { context, sw, id, page };
  env.userAgent = await sw.evaluate(() => navigator.userAgent);
  env.roots = await rootsOf(env);
  const bar = env.roots.find((r) => r.folderType === 'bookmarks-bar');
  const other = env.roots.find((r) => r.folderType === 'other');
  env.bar = bar && bar.id;
  env.other = other && other.id;
  return env;
}

const ctxOf = (env, who) => (who === 'sw' ? env.sw : env.page);
const inCtx = (env, who, fn, arg) => ctxOf(env, who).evaluate(fn, arg);
const rootsOf = (env) => inCtx(env, 'page', async () => {
  const t = await chrome.bookmarks.getTree();
  return t[0].children.map((c) => ({
    id: c.id, title: c.title, folderType: c.folderType || null, childCount: (c.children || []).length,
  }));
});
const make = (env, who, parentId, spec) => inCtx(env, who, ([p, s]) => globalThis.__rec.make(p, s), [parentId, spec]);
const kids = (env, who, id) => inCtx(env, who, (i) => globalThis.__rec.children(i), id);
/** Both contexts quiet: a write made in the panel reaches the service worker a moment later, and must not leak into the next call. */
const drain = (env) => Promise.all([
  inCtx(env, 'page', () => globalThis.__rec.quiet(120, 3000)),
  inCtx(env, 'sw', () => globalThis.__rec.quiet(120, 3000)),
]);
/** Setup, not a measurement: build a fixture and let both contexts' events finish. */
async function makeDrained(env, parentId, spec) {
  const out = await make(env, 'page', parentId, spec);
  await drain(env);
  return out;
}

/** One measured chrome.bookmarks call in the panel document, plus the events the service worker saw. */
async function call(env, label, method, ...args) {
  const otherStart = await inCtx(env, 'sw', () => globalThis.__rec.events.length);
  const rec = await inCtx(env, 'page', ([l, m, a]) => globalThis.__rec.call(l, m, a), [label, method, args]);
  const swEvents = await inCtx(env, 'sw', (s) => globalThis.__rec.events.slice(s).map((e) => ({ kind: e.kind, args: e.args })), otherStart);
  rec.panelEvents = rec.events.map((e) => ({ kind: e.kind, args: e.args }));
  rec.swEvents = swEvents;
  return rec;
}

const ord = (list) => list.map((c) => c.title).join('');
const idxs = (list) => list.map((c) => c.index);
const idxOk = (list) => idxs(list).every((v, i) => v === i);
const lnk = (t) => ({ title: t, url: 'http://127.0.0.1/' + encodeURIComponent(t) });
const fld = (t, children) => ({ title: t, children: children || [] });
const slimCall = (c) => ({
  resolved: c.resolved, threw: c.threw, error: c.error, resultType: c.resultType,
  result: c.result && typeof c.result === 'object'
    ? { id: c.result.id, index: c.result.index, parentId: c.result.parentId, title: c.result.title, keys: Object.keys(c.result).sort() }
    : c.result,
  resolveMs: c.resolveMs, quiet: c.quiet, eventBeforeResolve: c.eventBeforeResolve,
  nBeforeResolve: c.nBeforeResolve, nAfterResolve: c.nAfterResolve,
});
const ofKind = (events, kind) => events.filter((e) => e.kind === kind);
const movedPayloads = (events) => ofKind(events, 'onMoved').map((e) => ({ id: e.args[0], ...e.args[1] }));
const kinds = (events) => events.map((e) => e.kind);
const outcomeOf = (c) => (c.resolved ? 'resolved' : c.threw === 'sync' ? 'throws-sync' : 'rejects');

// ---------------------------------------------------------------------------------------------------------
// The expectations of the decision rules in the header (rule M2 and its cross-parent and create counterparts).
// They only make the record readable; the tests never assert them.
// ---------------------------------------------------------------------------------------------------------
const INDEX_OOB = 'Index out of bounds.';
const hasOob = (c) => !c.resolved && String(c.error || '').includes(INDEX_OOB);
const LET = 'ABCDEFGH';
const insertAt = (s, ch, pos) => s.slice(0, pos) + ch + s.slice(pos);
const removeAt = (s, pos) => s.slice(0, pos) + s.slice(pos + 1);
const upTo = (n) => Array.from({ length: n + 1 }, (_, i) => i);
/** `index` values of a list of n: 0 .. n, n + 1 (the first value past "append"), "omitted". */
const specs = (n) => [...upTo(n), n + 1, 'omitted'];

function expectSame(before, s, k) {
  const n = before.length;
  const t = k === 'omitted' ? n : k;
  if (t > n) return { rejects: true, final: null, order: before, noop: null, m1: null };
  const final = t > s ? t - 1 : t;
  const rest = removeAt(before, s);
  return { rejects: false, final, order: insertAt(rest, before[s], final), noop: final === s, m1: insertAt(rest, before[s], Math.min(t, n - 1)) };
}
function expectCross(gBefore, i) {
  const t = i === 'omitted' ? gBefore.length : i;
  if (t > gBefore.length) return { rejects: true, final: null, gOrder: gBefore };
  return { rejects: false, final: t, gOrder: insertAt(gBefore, 'M', t) };
}
function expectCreate(before, i) {
  const t = i === 'omitted' ? before.length : i;
  if (t > before.length) return { rejects: true, final: null, order: before };
  return { rejects: false, final: t, order: insertAt(before, 'N', t) };
}

const notMeasured = (base, reason) => ({ ...base, premiseOk: false, notMeasured: reason, fits: { all: false } });

/** Same-parent move: the fixture (children of `parentId`, titles `titles`) is already built. */
async function cellSame(env, { key, group, parentId, titles, children, s, k }) {
  const exp = expectSame(titles, s, k);
  const before = await kids(env, 'page', parentId);
  const base = { group, n: titles.length, s, k, before: ord(before) };
  if (!(ord(before) === titles && idxOk(before))) return notMeasured(base, `fixture not as expected: ${ord(before)} indices ${idxs(before)}`);
  const arg = k === 'omitted' ? { parentId } : { parentId, index: k };
  const c = await call(env, key, 'move', children[s].id, arg);
  const after = await kids(env, 'page', parentId);
  const panelMoved = movedPayloads(c.panelEvents);
  const swMoved = movedPayloads(c.swEvents);
  const oneMove = (list) => list.length === 1 && list[0].oldIndex === s && list[0].index === exp.final
    && list[0].oldParentId === parentId && list[0].parentId === parentId;
  const noEvents = c.panelEvents.length === 0 && c.swEvents.length === 0;
  const oneEach = kinds(c.panelEvents).join() === 'onMoved' && kinds(c.swEvents).join() === 'onMoved'
    && oneMove(panelMoved) && oneMove(swMoved);
  const fits = {
    outcome: exp.rejects ? hasOob(c) : c.resolved,
    order: ord(after) === exp.order,
    resultIndex: exp.rejects ? null : (!!c.result && c.result.index === exp.final),
    events: exp.rejects || exp.noop ? noEvents : oneEach,
    indexAudit: idxOk(after),
  };
  fits.all = fits.outcome && fits.order && fits.resultIndex !== false && fits.events && fits.indexAudit;
  return {
    ...base, premiseOk: true, after: ord(after), afterIndices: idxs(after),
    outcome: outcomeOf(c), error: c.error || null,
    resultIndex: c.result && typeof c.result === 'object' ? c.result.index : null,
    onMoved: {
      panel: panelMoved.map((m) => [m.oldIndex, m.index, m.oldParentId === m.parentId]),
      sw: swMoved.map((m) => [m.oldIndex, m.index, m.oldParentId === m.parentId]),
    },
    eventKinds: { panel: kinds(c.panelEvents), sw: kinds(c.swEvents) },
    expected: { rejects: exp.rejects, final: exp.final, order: exp.order, noop: exp.noop, m1Order: exp.m1, m1DiffersFromM2: exp.m1 !== null && exp.m1 !== exp.order },
    fits, raw: slimCall(c),
  };
}

/** Cross-parent move of the node titled "M" out of F (at `oldIndex`) into G. */
async function cellCross(env, { key, group, fId, gId, fBefore, gBefore, movedId, oldIndex, index, itemKind }) {
  const exp = expectCross(gBefore, index);
  const base = { group, item: itemKind, index, fBefore, gBefore, oldIndex };
  const subOf = async () => ((await inCtx(env, 'page', (id) => globalThis.__rec.subtree(id), movedId).catch(() => [null]))[0]);
  const strip = (n) => ({ id: n.id, title: n.title, index: n.index, parentId: n.parentId, children: (n.children || []).map(strip) });
  const fB = await kids(env, 'page', fId);
  const gB = await kids(env, 'page', gId);
  if (!(oldIndex >= 0 && fBefore[oldIndex] === 'M' && ord(fB) === fBefore && ord(gB) === gBefore && idxOk(fB) && idxOk(gB))) {
    return notMeasured(base, `fixture not as expected: F ${ord(fB)} (${idxs(fB)}) G ${ord(gB)} (${idxs(gB)})`);
  }
  const subBefore = itemKind === 'folder3' ? await subOf() : null;
  const arg = index === 'omitted' ? { parentId: gId } : { parentId: gId, index };
  const c = await call(env, key, 'move', movedId, arg);
  const fA = await kids(env, 'page', fId);
  const gA = await kids(env, 'page', gId);
  const nodeAfter = ((await inCtx(env, 'page', (id) => globalThis.__rec.get([id]), movedId).catch(() => [null]))[0]);
  const subAfter = itemKind === 'folder3' ? await subOf() : null;
  const T = exp.final;
  const oneMove = (events) => {
    const m = movedPayloads(events);
    return kinds(events).join() === 'onMoved' && m.length === 1 && m[0].oldParentId === fId && m[0].parentId === gId
      && m[0].oldIndex === oldIndex && m[0].index === T;
  };
  const noEvents = c.panelEvents.length === 0 && c.swEvents.length === 0;
  const fits = {
    outcome: exp.rejects ? hasOob(c) : c.resolved,
    order: ord(fA) === (exp.rejects ? fBefore : removeAt(fBefore, oldIndex)) && ord(gA) === exp.gOrder,
    resultIndex: exp.rejects ? null : (!!c.result && c.result.index === T),
    events: exp.rejects ? noEvents : oneMove(c.panelEvents) && oneMove(c.swEvents),
    idUnchanged: !!nodeAfter && nodeAfter.id === movedId && nodeAfter.parentId === (exp.rejects ? fId : gId),
    subtree: itemKind === 'folder3' && !exp.rejects
      ? !!subAfter && !!subBefore && JSON.stringify(strip(subBefore).children) === JSON.stringify(strip(subAfter).children)
      : null,
    indexAudit: idxOk(fA) && idxOk(gA),
  };
  fits.all = fits.outcome && fits.order && fits.resultIndex !== false && fits.events && fits.idUnchanged
    && fits.subtree !== false && fits.indexAudit;
  const moved = (events) => movedPayloads(events).map((m) => ({ oldIndex: m.oldIndex, index: m.index, fromF: m.oldParentId === fId, toG: m.parentId === gId }));
  return {
    ...base, premiseOk: true, fAfter: ord(fA), gAfter: ord(gA), gAfterIndices: idxs(gA),
    outcome: outcomeOf(c), error: c.error || null,
    resultIndex: c.result && typeof c.result === 'object' ? c.result.index : null,
    onMoved: { panel: moved(c.panelEvents), sw: moved(c.swEvents) },
    eventKinds: { panel: kinds(c.panelEvents), sw: kinds(c.swEvents) },
    expected: { rejects: exp.rejects, final: T, gOrder: exp.gOrder },
    fits, raw: slimCall(c),
  };
}

/** create({parentId, title: "N", index}) in a folder whose children (titles `before`) already exist. */
async function cellCreate(env, { key, group, parentId, before, index }) {
  const exp = expectCreate(before, index);
  const kB = await kids(env, 'page', parentId);
  const base = { group, index, before: ord(kB) };
  if (!(ord(kB) === before && idxOk(kB))) return notMeasured(base, `fixture not as expected: ${ord(kB)} indices ${idxs(kB)}`);
  const arg = index === 'omitted' ? { parentId, title: 'N' } : { parentId, title: 'N', index };
  const c = await call(env, key, 'create', arg);
  const after = await kids(env, 'page', parentId);
  const oneCreated = (events) => {
    const cr = ofKind(events, 'onCreated').map((e) => e.args);
    return kinds(events).join() === 'onCreated' && cr.length === 1 && cr[0][1].index === exp.final
      && cr[0][1].parentId === parentId && cr[0][1].title === 'N';
  };
  const noEvents = c.panelEvents.length === 0 && c.swEvents.length === 0;
  const fits = {
    outcome: exp.rejects ? hasOob(c) : c.resolved,
    order: ord(after) === exp.order,
    resultIndex: exp.rejects ? null : (!!c.result && c.result.index === exp.final),
    noUrlKey: exp.rejects ? null : (!!c.result && !('url' in c.result)),
    events: exp.rejects ? noEvents : oneCreated(c.panelEvents) && oneCreated(c.swEvents),
    indexAudit: idxOk(after),
  };
  fits.all = fits.outcome && fits.order && fits.resultIndex !== false && fits.noUrlKey !== false && fits.events && fits.indexAudit;
  return {
    ...base, premiseOk: true, after: ord(after), afterIndices: idxs(after),
    outcome: outcomeOf(c), error: c.error || null,
    resultIndex: c.result && typeof c.result === 'object' ? c.result.index : null,
    hasUrlKey: c.result && typeof c.result === 'object' ? 'url' in c.result : null,
    eventKinds: { panel: kinds(c.panelEvents), sw: kinds(c.swEvents) },
    expected: { rejects: exp.rejects, final: exp.final, order: exp.order },
    fits, raw: slimCall(c),
  };
}

function summarize(cells) {
  const keys = Object.keys(cells);
  const measured = keys.filter((k) => cells[k].premiseOk);
  const fit = keys.filter((k) => cells[k].fits && cells[k].fits.all);
  return {
    cells: keys.length, measured: measured.length, notMeasured: keys.filter((k) => !cells[k].premiseOk),
    fit: fit.length, measuredButNotFit: measured.filter((k) => cells[k].fits && !cells[k].fits.all),
  };
}
const line = (key, rec) => {
  if (!rec.premiseOk) return `${key}: NOT MEASURED (${rec.notMeasured})`;
  const shown = rec.after !== undefined ? `${rec.before} -> ${rec.after}` : `F ${rec.fBefore}->${rec.fAfter} G ${rec.gBefore}->${rec.gAfter}`;
  return `${key}: ${shown} ${rec.outcome}${rec.error ? ' (' + rec.error + ')' : ''} fits=${rec.fits.all}`;
};
async function guarded(cells, key, fn) {
  try { cells[key] = await fn(); } catch (e) { cells[key] = notMeasured({}, `the cell threw: ${String((e && e.stack) || e).slice(0, 400)}`); }
  console.log(line(key, cells[key]));
}
const loadavg = () => os.loadavg().map((n) => +n.toFixed(2));

// =========================================================================================================
// PA — the index rule at other sizes, in an EMPTY destination, and create at an index.
// =========================================================================================================
const PA_SAME_SIZES = [1, 2, 3, 4, 5, 8]; // 4 is the control against Probe 13 P1

async function runPA(env) {
  const cells = {};
  for (const n of PA_SAME_SIZES) {
    for (let s = 0; s < n; s++) {
      for (const k of specs(n)) {
        const key = `PA.same.n${n}.s${s}.k${k}`;
        await guarded(cells, key, async () => {
          const titles = LET.slice(0, n);
          const [F] = await makeDrained(env, env.bar, [fld(key, titles.split('').map(lnk))]);
          return cellSame(env, { key, group: n === 4 ? 'PA-same-control' : 'PA-same', parentId: F.id, titles, children: F.children, s, k });
        });
      }
    }
  }
  for (const m of [0, 1, 2, 5]) {
    for (const item of ['leaf', 'folder3']) {
      for (const i of specs(m)) {
        const key = `PA.cross.m${m}.${item}.i${i}`;
        await guarded(cells, key, async () => {
          const gT = 'XYZUV'.slice(0, m);
          const moveSpec = item === 'leaf' ? lnk('M') : fld('M', [lnk('m1'), lnk('m2'), lnk('m3')]);
          const [F, G] = await makeDrained(env, env.bar, [
            fld(`${key} F`, [lnk('p'), moveSpec, lnk('q')]),
            fld(`${key} G`, gT.split('').map(lnk)),
          ]);
          return cellCross(env, {
            key, group: 'PA-cross', fId: F.id, gId: G.id, fBefore: 'pMq', gBefore: gT,
            movedId: F.children[1].id, oldIndex: 1, index: i, itemKind: item,
          });
        });
      }
    }
  }
  for (const m of [0, 1, 2, 5, 8]) {
    for (const i of specs(m)) {
      const key = `PA.create.m${m}.i${i}`;
      await guarded(cells, key, async () => {
        const before = LET.slice(0, m);
        const [F] = await makeDrained(env, env.bar, [fld(key, before.split('').map(lnk))]);
        return cellCreate(env, { key, group: 'PA-create', parentId: F.id, before, index: i });
      });
    }
  }
  return cells;
}

test.describe('Probe 17', () => {
  // The host is busy (load 50-800 from other sessions): the default 90 s covers neither a browser launch nor 259 cells.
  test.describe.configure({ timeout: 3_600_000 });

  test('PA: the index rule at other sizes, an EMPTY destination, create at an index', async () => {
    const env = await openEnv();
    try {
      record('env-PA', {
        userAgent: env.userAgent, roots: env.roots, startedAt: new Date().toISOString(), loadavgStart: loadavg(),
        node: process.version, harness: 'the Probe 13 harness: panel.html opened as a tab; writes from the panel document',
      }, env.userAgent);
      const cells = await runPA(env);
      const audit = await inCtx(env, 'page', () => globalThis.__rec.audit());
      const summary = summarize(cells);
      record('PA', {
        cells, summary,
        audit: { folders: audit.folders, children: audit.children, issueCount: audit.issues.length, issues: audit.issues.slice(0, 20) },
        diag: { loadavgEnd: loadavg(), finishedAt: new Date().toISOString() },
      }, `cells=${summary.cells} measured=${summary.measured} fit=${summary.fit} notFit=${summary.measuredButNotFit.length} notMeasured=${summary.notMeasured.length} audit.issues=${audit.issues.length}`);
      expect(Object.keys(cells).length, 'PA records every cell').toBe(PA_EXPECTED);
    } finally {
      await env.context.close();
    }
  });

  // =======================================================================================================
  // PB — the permanent folders as destinations and as parents.
  // =======================================================================================================
  /** Setup, not a measurement: remove every child of both permanent folders, so the next cell starts from known counts. */
  const emptyRoots = (env) => inCtx(env, 'page', async (ids) => {
    const out = { removed: 0, errors: [], left: [] };
    for (const root of ids) {
      for (const c of await chrome.bookmarks.getChildren(root)) {
        try {
          if ('url' in c) await chrome.bookmarks.remove(c.id); else await chrome.bookmarks.removeTree(c.id);
          out.removed++;
        } catch (e) { out.errors.push(String((e && e.message) || e)); }
      }
    }
    await globalThis.__rec.quiet(150, 3000);
    for (const root of ids) out.left.push((await chrome.bookmarks.getChildren(root)).length);
    return out;
  }, [env.bar, env.other]);

  /** One PB cell (or a pair of cells sharing one fixture): baseline empty -> fixture -> measured call(s) -> back to empty. */
  async function pbCells(env, cells, keys, fn) {
    let recs = {};
    try {
      const pre = await emptyRoots(env);
      const out = await fn();
      recs = Object.fromEntries(keys.map((k) => [k, out[k]]));
      for (const k of keys) {
        if (!recs[k]) recs[k] = notMeasured({}, 'the cell produced no record');
        if (pre.removed > 0 && recs[k].premiseOk) Object.assign(recs[k], { premiseOk: false, notMeasured: `the permanent folders were not empty at the start (${pre.removed} items removed)`, fits: { all: false } });
      }
    } catch (e) {
      recs = Object.fromEntries(keys.map((k) => [k, notMeasured({}, `the cell threw: ${String((e && e.stack) || e).slice(0, 400)}`)]));
    }
    let post = null;
    try { post = await emptyRoots(env); } catch (e) { post = { removed: 0, errors: [String((e && e.message) || e)], left: ['?'] }; }
    const restored = post.left.every((n) => n === 0) && post.errors.length === 0;
    for (const k of keys) {
      recs[k].baselineRestored = restored;
      cells[k] = recs[k];
      console.log(line(k, recs[k]) + (restored ? '' : ' [BASELINE NOT RESTORED]'));
    }
  }

  async function runPB(env) {
    const cells = {};
    const movedSpec = (item) => (item === 'leaf' ? lnk('M') : fld('M', [lnk('m1'), lnk('m2'), lnk('m3')]));
    // B1: move INTO a permanent folder from a normal folder that sits under the other one.
    for (const dest of ['bar', 'other']) {
      for (const m of [0, 3]) {
        for (const item of ['leaf', 'folder3']) {
          for (const i of specs(m)) {
            const key = `PB.into.${dest}.m${m}.${item}.i${i}`;
            await pbCells(env, cells, [key], async () => {
              const destRoot = env[dest];
              const srcRoot = dest === 'bar' ? env.other : env.bar;
              const gT = 'XYZ'.slice(0, m);
              const [S] = await makeDrained(env, srcRoot, [fld(`${key} src`, [lnk('p'), movedSpec(item), lnk('q')])]);
              if (m > 0) await makeDrained(env, destRoot, gT.split('').map(lnk));
              return {
                [key]: await cellCross(env, {
                  key, group: 'PB-into', fId: S.id, gId: destRoot, fBefore: 'pMq', gBefore: gT,
                  movedId: S.children[1].id, oldIndex: 1, index: i, itemKind: item,
                }),
              };
            });
          }
        }
      }
    }
    // B2: across the two permanent folders and back.
    for (const dir of ['bar-other', 'other-bar']) {
      for (const item of ['leaf', 'folder3']) {
        for (const i of [0, 3, 'omitted']) {
          const [a, b] = dir.split('-');
          const keyF = `PB.cross.${dir}.${item}.i${i}.forth`;
          const keyB = `PB.cross.${dir}.${item}.i${i}.back`;
          await pbCells(env, cells, [keyF, keyB], async () => {
            const srcRoot = env[a];
            const dstRoot = env[b];
            const [, , , M] = await makeDrained(env, srcRoot, [lnk('P'), lnk('Q'), lnk('R'), movedSpec(item)]);
            await makeDrained(env, dstRoot, ['X', 'Y', 'Z'].map(lnk));
            const forth = await cellCross(env, {
              key: keyF, group: 'PB-cross-forth', fId: srcRoot, gId: dstRoot, fBefore: 'PQRM', gBefore: 'XYZ',
              movedId: M.id, oldIndex: 3, index: i, itemKind: item,
            });
            // "Back" is built from what is really there after "forth", not from what was expected.
            const dNow = await kids(env, 'page', dstRoot);
            const sNow = await kids(env, 'page', srcRoot);
            const back = await cellCross(env, {
              key: keyB, group: 'PB-cross-back', fId: dstRoot, gId: srcRoot, fBefore: ord(dNow), gBefore: ord(sNow),
              movedId: M.id, oldIndex: ord(dNow).indexOf('M'), index: i, itemKind: item,
            });
            return { [keyF]: forth, [keyB]: back };
          });
        }
      }
    }
    // B3: create a folder directly under a permanent folder, at an index.
    for (const root of ['bar', 'other']) {
      for (const m of [0, 3]) {
        for (const i of specs(m)) {
          const key = `PB.create.${root}.m${m}.i${i}`;
          await pbCells(env, cells, [key], async () => {
            const before = 'XYZ'.slice(0, m);
            if (m > 0) await makeDrained(env, env[root], before.split('').map(lnk));
            return { [key]: await cellCreate(env, { key, group: 'PB-create', parentId: env[root], before, index: i }) };
          });
        }
      }
    }
    // B4: a same-parent move inside a permanent folder holding four links.
    for (const root of ['bar', 'other']) {
      for (let s = 0; s < 4; s++) {
        for (const k of specs(4)) {
          const key = `PB.same.${root}.s${s}.k${k}`;
          await pbCells(env, cells, [key], async () => {
            const titles = 'ABCD';
            const children = await makeDrained(env, env[root], titles.split('').map(lnk));
            return { [key]: await cellSame(env, { key, group: 'PB-same', parentId: env[root], titles, children, s, k }) };
          });
        }
      }
    }
    return cells;
  }

  test('PB: moving into, across and inside the permanent folders; create under them', async () => {
    const env = await openEnv();
    try {
      const startRoots = await rootsOf(env);
      record('env-PB', {
        userAgent: env.userAgent, roots: startRoots, startedAt: new Date().toISOString(), loadavgStart: loadavg(),
        rootsEmptyAtStart: startRoots.filter((r) => r.folderType === 'bookmarks-bar' || r.folderType === 'other').every((r) => r.childCount === 0),
      }, env.userAgent);
      const cells = await runPB(env);
      const audit = await inCtx(env, 'page', () => globalThis.__rec.audit());
      const summary = summarize(cells);
      const baselineNotRestored = Object.keys(cells).filter((k) => cells[k].baselineRestored === false);
      record('PB', {
        cells, summary: { ...summary, baselineNotRestored },
        audit: { folders: audit.folders, children: audit.children, issueCount: audit.issues.length, issues: audit.issues.slice(0, 20) },
        diag: { loadavgEnd: loadavg(), finishedAt: new Date().toISOString() },
      }, `cells=${summary.cells} measured=${summary.measured} fit=${summary.fit} notFit=${summary.measuredButNotFit.length} notMeasured=${summary.notMeasured.length} baselineNotRestored=${baselineNotRestored.length}`);
      expect(Object.keys(cells).length, 'PB records every cell').toBe(PB_EXPECTED);
    } finally {
      await env.context.close();
    }
  });

  // =======================================================================================================
  // PC — HTML5 drag mechanics in the real bookmark rail (the real extension, `bookmarks` granted).
  // =======================================================================================================
  const ROW = '[data-testid="bookmark-row"]';
  const rowByTitle = (panel, kind, title) => panel.locator(`${ROW}[data-kind="${kind}"]`)
    .filter({ has: panel.locator('.w-row__main', { hasText: new RegExp(`^${title}$`) }) }).first();

  // Installed ONCE per page (Probe 15 found that installing per variant counts every event once per listener). It
  // makes the page accept drops, swallows clicks, and logs every drag, pointer and mouse event with the page clock.
  const PC_INSTALL = () => {
    if (window.__pc) return 'already installed';
    const S = { mode: 'private', phase: 'before', log: [], counts: {}, cards: [], marks: {} };
    window.__pc = S;
    const CAP = 3000;
    const desc = (n) => {
      if (!n) return null;
      if (n.nodeType !== 1) return { tag: '#' + String(n.nodeName) };
      const row = n.closest(ROW_SEL);
      return {
        tag: n.tagName, cls: String(n.getAttribute('class') || ''), isRow: n === row, inRow: !!row,
        rowKind: row ? row.dataset.kind : null,
        rowTitle: row ? ((row.querySelector('.w-row__main') || {}).textContent || '') : null,
        isList: n.getAttribute('data-testid') === 'bookmark-list', isRail: n.id === 'bookmark-rail',
      };
    };
    const ROW_SEL = '[data-testid="bookmark-row"]';
    const TYPES = ['dragstart', 'drag', 'dragenter', 'dragover', 'dragleave', 'drop', 'dragend',
      'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave',
      'mousedown', 'mousemove', 'mouseup', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave', 'click'];
    const handler = (e) => {
      const extra = {};
      if (e.type === 'dragstart') {
        S.phase = 'drag';
        S.marks.dragstart = performance.now();
        const row = e.target && e.target.closest ? e.target.closest(ROW_SEL) : null;
        S.marks.draggedId = row ? row.dataset.bookmarkId : null;
        // `mode: 'none'` sets nothing at all: it shows what `types` lists when the page does not touch the data store.
        if (S.mode === 'private' && e.dataTransfer) {
          e.dataTransfer.setData('application/x-vt-bookmark', row ? row.dataset.bookmarkId : 'none');
          e.dataTransfer.effectAllowed = 'move';
        }
      } else if (e.type === 'dragenter' || e.type === 'dragover') {
        e.preventDefault();
      } else if (e.type === 'drop') {
        e.preventDefault();
        extra.data = e.dataTransfer ? e.dataTransfer.getData('application/x-vt-bookmark') : null;
        extra.dataMatchesDraggedId = extra.data !== null && extra.data === S.marks.draggedId;
        S.phase = 'dropped';
        S.marks.drop = performance.now();
      } else if (e.type === 'dragend') {
        S.phase = 'after';
        S.marks.dragend = performance.now();
      } else if (e.type === 'click') {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
      S.counts[e.type] = (S.counts[e.type] || 0) + 1;
      if (S.log.length >= CAP) return;
      const rec = { type: e.type, t: performance.now(), phase: S.phase, target: desc(e.target), x: e.clientX, y: e.clientY };
      if (e.dataTransfer) rec.types = Array.from(e.dataTransfer.types);
      S.log.push(Object.assign(rec, extra));
    };
    for (const t of TYPES) window.addEventListener(t, handler, true);
    // The preview card is sampled on its own clock, so "no card during the drag" is a reading and not an assumption.
    setInterval(() => {
      S.cards.push({ t: performance.now(), n: document.querySelectorAll('[data-testid="bookmark-preview"]').length });
      if (S.cards.length > 30000) S.cards.shift();
    }, 50);
    // The rail's scrollTop on its own clock: does the rail move while the pointer is still? (PC (a), diagnostic only.)
    S.scrollSeries = [];
    setInterval(() => {
      const rail = document.getElementById('bookmark-rail');
      if (!rail) return;
      S.scrollSeries.push([performance.now(), rail.scrollTop]);
      if (S.scrollSeries.length > 30000) S.scrollSeries.shift();
    }, 100);
    S.reset = (mode) => {
      S.mode = mode || 'private'; S.phase = 'before'; S.log = []; S.counts = {}; S.cards = []; S.marks = {}; S.scrollSeries = [];
    };
    return 'installed';
  };

  // What PR2 plans for the rows (plan §3.1): depth > 0 rows draggable, favicons draggable="false". `controlTitle` names
  // ONE link whose favicon is left without the attribute (the control of M8).
  const PC_MAKE_DRAGGABLE = (controlTitle) => {
    let rows = 0; let imgs = 0; let controls = 0;
    for (const row of document.querySelectorAll('[data-testid="bookmark-row"]')) {
      if (row.dataset.depth === '0') { row.removeAttribute('draggable'); continue; }
      row.setAttribute('draggable', 'true');
      rows++;
      const img = row.querySelector('img.bmk-row__icon');
      if (!img) continue;
      const title = (row.querySelector('.w-row__main') || {}).textContent || '';
      if (controlTitle && title === controlTitle) { img.removeAttribute('draggable'); controls++; }
      else { img.setAttribute('draggable', 'false'); imgs++; }
    }
    return { rows, imgs, controls };
  };

  const pcReset = (panel, mode) => panel.evaluate((m) => window.__pc.reset(m), mode);
  const pcRead = (panel) => panel.evaluate(() => JSON.parse(JSON.stringify({
    log: window.__pc.log, counts: window.__pc.counts, cards: window.__pc.cards, marks: window.__pc.marks,
    scrollSeries: window.__pc.scrollSeries,
  })));
  const pcWait = (panel, type, n, timeout) => panel.waitForFunction(([t, c]) => (window.__pc.counts[t] || 0) >= c, [type, n], { timeout })
    .then(() => true, () => false);
  const setScroll = async (panel, where) => {
    await panel.evaluate((w) => {
      const r = document.getElementById('bookmark-rail');
      r.scrollTop = w === 'top' ? 0 : Math.floor((r.scrollHeight - r.clientHeight) / 2);
    }, where);
    await P.settleFrames(panel);
  };
  const centerOf = async (locator) => {
    const b = await locator.boundingBox();
    if (!b) throw new Error('no bounding box');
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, box: b };
  };
  const classify = (e) => {
    if (!e) return 'none';
    const t = e.target;
    if (!t) return 'other:null';
    if (t.isRow) return 'row';
    if (t.inRow) return `inside:${t.tag}`;
    if (t.isList) return 'list';
    if (t.isRail) return 'rail';
    return `other:${t.tag}`;
  };
  const classifyGap = (e) => { const c = classify(e); return c.startsWith('inside:') ? 'row' : c; };
  const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const PEEK_COUNT = (panel) => panel.evaluate((sel) => document.querySelectorAll(sel).length, P.PEEK);
  const cardShows = (panel, timeout) => panel.waitForFunction((sel) => document.querySelectorAll(sel).length > 0, P.PEEK, { timeout })
    .then(() => true, () => false);

  /**
   * What Playwright's own drag code is, read from the installed playwright-core (a diagnostic of the harness, not a
   * measurement of Chromium). Run 0 looked for lib/server/chromium/crDragDrop.js, which does not exist in 1.62.1: the
   * server code is one bundle, lib/coreBundle.js, which holds the module "crDragDrop.ts" (class DragManager).
   */
  function dragMechanism() {
    try {
      const pkgFile = require.resolve('playwright-core/package.json');
      const dir = path.dirname(pkgFile);
      const file = path.join(dir, 'lib', 'coreBundle.js');
      const text = fs.readFileSync(file, 'utf8');
      const count = (re) => (text.match(re) || []).length;
      return {
        playwrightCoreVersion: JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version, file: path.relative(dir, file), bytes: text.length,
        crDragDropModulePresent: text.includes('packages/playwright-core/src/server/chromium/crDragDrop.ts'),
        setInterceptDrags: count(/setInterceptDrags/g), dispatchDragEvent: count(/dispatchDragEvent/g), dragIntercepted: count(/dragIntercepted/g),
        dragOverTypeLiterals: count(/type: "dragOver"/g),
      };
    } catch (e) { return { error: String((e && e.message) || e) }; }
  }

  const PC_ITEMS = [
    { title: 'L00', url: 'https://pc.example.com/0' },
    { title: 'F1', children: [1, 2, 3].map((i) => ({ title: `F1-${i}`, url: `https://pc.example.com/f1/${i}` })) },
    { title: 'F2', children: [1, 2, 3].map((i) => ({ title: `F2-${i}`, url: `https://pc.example.com/f2/${i}` })) },
    ...Array.from({ length: 55 }, (_, i) => ({ title: `L${String(i + 1).padStart(2, '0')}`, url: `https://pc.example.com/${i + 1}` })),
  ];

  // (a) the pointer stationary during a drag, near an edge of the rail and in the middle.
  // AMENDED after run 0 (de05b4a), PREMISE ONLY (see the note at the top of the file): the control that proves the
  // listener is alive is now a 2 px HORIZONTAL move that must produce a `dragenter` or a `dragover`. Run 0 required a
  // `dragover` after a 2 px VERTICAL move; at the bottom edge that move changed the element under the pointer, which
  // makes Blink fire `dragenter`/`dragleave` instead, so PC.a.bottom was "not measured" for a reason that says
  // nothing about Chromium. The quantity the decision rule uses, E (`dragover` events later than T0 + 100 ms), is unchanged.
  async function cellA(panel, where) {
    await setScroll(panel, 'mid');
    await panel.evaluate(PC_MAKE_DRAGGABLE, null);
    const geom = await panel.evaluate(() => {
      const rail = document.getElementById('bookmark-rail');
      const rr = rail.getBoundingClientRect();
      const top = Math.max(rr.top, 0);
      const bottom = Math.min(rr.bottom, window.innerHeight);
      const mid = (top + bottom) / 2;
      let best = null;
      for (const r of document.querySelectorAll('[data-testid="bookmark-row"][data-kind="link"]')) {
        const b = r.getBoundingClientRect();
        if (b.top < top + 4 || b.bottom > bottom - 4) continue;
        const d = Math.abs((b.top + b.bottom) / 2 - mid);
        if (!best || d < best.d) best = { d, x: b.left + b.width / 2, y: (b.top + b.bottom) / 2, draggable: r.getAttribute('draggable') };
      }
      return { top, bottom, left: rr.left, width: rr.width, src: best };
    });
    const x = geom.left + geom.width / 2;
    const ty = where === 'bottom' ? geom.bottom - 12 : where === 'top' ? geom.top + 12 : Math.min(geom.bottom - 12, (geom.top + geom.bottom) / 2 + 80);
    const base = { position: where };
    if (!geom.src || geom.src.draggable !== 'true') return notMeasured(base, 'no draggable link row inside the rail to start from');
    await pcReset(panel, 'private');
    await panel.mouse.move(geom.src.x, geom.src.y);
    await panel.mouse.down();
    await panel.mouse.move(geom.src.x, geom.src.y + 12, { steps: 3 });
    const started = await pcWait(panel, 'dragstart', 1, 3000);
    if (!started) { await panel.mouse.up(); return notMeasured(base, 'the drag did not start'); }
    await panel.mouse.move(x, ty, { steps: 12 });
    const T0 = await panel.evaluate(() => performance.now());
    const scrollBefore = await panel.evaluate(() => document.getElementById('bookmark-rail').scrollTop);
    await panel.waitForTimeout(3000); // the window itself: time has to pass for a repeat to be seen
    const L = await pcRead(panel);
    const scrollAfter = await panel.evaluate(() => document.getElementById('bookmark-rail').scrollTop);
    const FAMILY = ['drag', 'dragenter', 'dragover', 'dragleave'];
    const inWindow = L.log.filter((e) => e.t > T0 + 100);
    const stationary = inWindow.filter((e) => e.type === 'dragover');
    const stationaryFamily = inWindow.filter((e) => FAMILY.includes(e.type));
    const dragovers = L.log.filter((e) => e.type === 'dragover');
    const enBefore = L.counts.dragenter || 0;
    const ovBefore = L.counts.dragover || 0;
    await panel.mouse.move(x + 2, ty, { steps: 1 });
    const controlSeen = await panel.waitForFunction(
      ([n]) => ((window.__pc.counts.dragenter || 0) + (window.__pc.counts.dragover || 0)) >= n, [enBefore + ovBefore + 1], { timeout: 2000 },
    ).then(() => true, () => false);
    const c2 = await panel.evaluate(() => ({ en: window.__pc.counts.dragenter || 0, ov: window.__pc.counts.dragover || 0 }));
    await panel.mouse.up();
    await pcWait(panel, 'dragend', 1, 3000);
    const times = stationary.map((e) => e.t);
    const intervals = times.slice(1).map((t, i) => +(t - times[i]).toFixed(1));
    const series = (L.scrollSeries || []).filter((s) => s[0] >= T0).filter((_, i) => i % 3 === 0).map((s) => [Math.round(s[0] - T0), s[1]]);
    return {
      ...base, premiseOk: controlSeen, ...(controlSeen ? {} : { notMeasured: 'the 2 px horizontal control move produced neither a dragenter nor a dragover within 2 s' }),
      dragstartSeen: true, controlMoveDragenters: c2.en - enBefore, controlMoveDragovers: c2.ov - ovBefore,
      stationaryDragovers: stationary.length, repeatsWhileStationary: stationary.length >= 1,
      stationaryDragEvents: stationaryFamily.length,
      windowMs: 3000,
      diag: {
        targetY: ty, dragoversUntilStationary: dragovers.filter((e) => e.t <= T0 + 100).length,
        stationaryOffsetsMs: stationary.map((e) => +(e.t - T0).toFixed(0)), intervalsMs: intervals,
        minIntervalMs: intervals.length ? Math.min(...intervals) : null, medianIntervalMs: median(intervals),
        maxIntervalMs: intervals.length ? Math.max(...intervals) : null, counts: L.counts,
        // NOT a pre-registered cell, no decision rule attached (found in run 0): does the rail scroll by itself while the
        // pointer is still? `railScrollTop` is read before and after the window; the series is the rail's scrollTop
        // sampled every 100 ms in the page, thinned to every 300 ms: [ms after T0, scrollTop].
        railScrollTop: { beforeWindow: scrollBefore, afterWindow: scrollAfter }, railScrollSeries: series,
        railScrollHeight: await panel.evaluate(() => document.getElementById('bookmark-rail').scrollHeight),
      },
    };
  }

  // (b) pointer and mouse events, and the preview card, during a drag.
  async function cellB(panel) {
    await setScroll(panel, 'top');
    await panel.evaluate(PC_MAKE_DRAGGABLE, null);
    await panel.mouse.move(4, 4);
    await pcReset(panel, 'private');
    const s = await centerOf(rowByTitle(panel, 'link', 'L03'));
    const targets = [];
    for (const t of ['L06', 'L09', 'L12']) targets.push(await centerOf(rowByTitle(panel, 'link', t)));
    const after = await centerOf(rowByTitle(panel, 'link', 'L16'));
    await panel.mouse.move(s.x, s.y, { steps: 4 });
    const cardBefore = await cardShows(panel, 5000);
    await panel.mouse.down();
    await panel.mouse.move(s.x, s.y + 14, { steps: 3 });
    const started = await pcWait(panel, 'dragstart', 1, 3000);
    await P.settleFrames(panel);
    const cardAtDragstart = await PEEK_COUNT(panel);
    if (started) {
      for (const t of targets) await panel.mouse.move(t.x, t.y, { steps: 6 });
      await panel.waitForTimeout(900); // time has to pass: the card's own delay is 350 ms
    }
    await panel.mouse.up();
    await pcWait(panel, 'dragend', 1, 3000);
    await panel.mouse.move(after.x, after.y, { steps: 4 });
    const cardAfter = await cardShows(panel, 5000);
    const L = await pcRead(panel);
    const t0 = L.marks.dragstart;
    const t1 = L.marks.drop !== undefined ? L.marks.drop : L.marks.dragend;
    const win = started && t0 !== undefined && t1 !== undefined ? L.log.filter((e) => e.t > t0 && e.t < t1) : [];
    const COUNT = ['pointerover', 'pointerout', 'pointermove', 'pointerenter', 'pointerleave', 'mouseover', 'mouseout', 'mousemove', 'mouseenter', 'mouseleave'];
    const duringDrag = Object.fromEntries(COUNT.map((ty) => [ty, win.filter((e) => e.type === ty).length]));
    const overOnLinkRow = win.filter((e) => e.type === 'pointerover' && e.target && e.target.inRow && e.target.rowKind === 'link').length;
    const cardsInWindow = started && t0 !== undefined && t1 !== undefined ? L.cards.filter((c) => c.t > t0 && c.t < t1) : [];
    const afterWin = t1 !== undefined ? L.log.filter((e) => e.t > t1) : [];
    const premiseOk = cardBefore && started;
    return {
      premiseOk, ...(premiseOk ? {} : { notMeasured: `premise failed: hover control card before the press = ${cardBefore}, dragstart seen = ${started}` }),
      hoverControlCardBeforePress: cardBefore, dragstartSeen: started,
      cardCountTwoFramesAfterDragstart: cardAtDragstart,
      // `cardSamplesTaken` says the 50 ms sampler produced samples in the window; `maxCardsSampled` is the largest number of
      // preview cards seen in any of them (0 = no card at any sample).
      duringDrag: { ...duringDrag, pointeroverOnLinkRow: overOnLinkRow, cardSamplesTaken: cardsInWindow.length > 0, maxCardsSampled: Math.max(0, ...cardsInWindow.map((c) => c.n)) },
      afterDrag: { cardShownOnHover: cardAfter, pointeroverEvents: afterWin.filter((e) => e.type === 'pointerover').length > 0 },
      clickEvents: L.counts.click || 0, pointercancelEvents: L.counts.pointercancel || 0,
      diag: { counts: L.counts, windowEvents: win.slice(0, 40), cardSamplesInWindow: cardsInWindow.length },
    };
  }

  // (c) and (d): where does the drag start for a press on each part of a row, and what do `dataTransfer.types` list.
  // AMENDED after run 0, PREMISE ONLY, for the two `svg: true` variants: run 0 required that the element at the press
  // point be the svg, and it never is: `svg.icon { pointer-events: none }` (sidepanel.css:346-352) makes every icon
  // transparent to hit testing, so the press lands on the row's <button>. The press is now made at the svg's centre
  // anyway, and the cell records what the hit test said (`svg.hitTestReachesSvg`) next to what the drag did.
  const PC_VARIANTS = [
    { v: 'folder-twisty', mode: 'private', sel: 'svg.bmk-row__twisty', kind: 'folder', title: 'F1', svg: true },
    { v: 'folder-glyph', mode: 'private', sel: 'svg.bmk-row__glyph', kind: 'folder', title: 'F1', svg: true },
    { v: 'folder-main', mode: 'private', sel: '.w-row__main', kind: 'folder', title: 'F2' },
    { v: 'link-favicon-nodrag', mode: 'private', sel: 'img.bmk-row__icon', kind: 'link', title: 'L00' },
    { v: 'link-favicon-control', mode: 'private', sel: 'img.bmk-row__icon', kind: 'link', title: 'L01', control: 'L01' },
    { v: 'link-main', mode: 'private', sel: '.w-row__main', kind: 'link', title: 'L02' },
    { v: 'row-padding', mode: 'private', sel: null, kind: 'link', title: 'L04' },
    { v: 'link-main-notype', mode: 'none', sel: '.w-row__main', kind: 'link', title: 'L05' },
    { v: 'link-favicon-notype', mode: 'none', sel: 'img.bmk-row__icon', kind: 'link', title: 'L06' },
  ];

  async function cellPress(panel, spec) {
    await setScroll(panel, 'top');
    await panel.evaluate(PC_MAKE_DRAGGABLE, spec.control || null);
    const row = rowByTitle(panel, spec.kind, spec.title);
    const base = { variant: spec.v, mode: spec.mode };
    let x; let y;
    if (spec.sel) {
      const c = await centerOf(row.locator(spec.sel).first());
      x = c.x; y = c.y;
    } else {
      const c = await centerOf(row);
      x = c.box.x + 4; y = c.y;
    }
    const pre = await panel.evaluate(([px, py, sel]) => {
      const el = document.elementFromPoint(px, py);
      const r = el ? el.closest('[data-testid="bookmark-row"]') : null;
      const img = r ? r.querySelector('img.bmk-row__icon') : null;
      const svgEl = r && sel ? r.querySelector(sel) : null;
      return {
        tag: el ? el.tagName : null, cls: el ? String(el.getAttribute('class') || '') : null, inRow: !!r,
        rowDraggable: r ? r.getAttribute('draggable') : null,
        isTheIntendedElement: sel ? !!(el && el.closest(sel)) : (!!el && el === r),
        imgDraggableAttr: img ? img.getAttribute('draggable') : undefined,
        svgComputedPointerEvents: svgEl ? getComputedStyle(svgEl).pointerEvents : null,
      };
    }, [x, y, spec.sel]);
    const imgOk = !/favicon/.test(spec.v) || (spec.control ? pre.imgDraggableAttr === null : pre.imgDraggableAttr === 'false');
    const rowRec = {
      pressedElement: { tag: pre.tag, cls: pre.cls }, rowDraggableAttr: pre.rowDraggable,
      imgDraggableAttr: pre.imgDraggableAttr === undefined ? null : pre.imgDraggableAttr,
      ...(spec.svg ? { svg: { hitTestReachesSvg: pre.isTheIntendedElement, computedPointerEvents: pre.svgComputedPointerEvents } } : {}),
    };
    const premiseOk = pre.inRow && pre.rowDraggable === 'true' && imgOk && (spec.svg ? true : pre.isTheIntendedElement);
    if (!premiseOk) return notMeasured({ ...base, ...rowRec }, `premise failed: ${JSON.stringify(pre)}`);
    await pcReset(panel, spec.mode);
    await panel.mouse.move(x, y);
    await panel.mouse.down();
    await panel.mouse.move(x, y + 40, { steps: 8 });
    const started = await pcWait(panel, 'dragstart', 1, 1500);
    if (started) await pcWait(panel, 'dragover', 1, 1500);
    await panel.mouse.up();
    if (started) await pcWait(panel, 'dragend', 1, 2000);
    const L = await pcRead(panel);
    const starts = L.log.filter((e) => e.type === 'dragstart');
    const firstOver = L.log.find((e) => e.type === 'dragover') || null;
    const drops = L.log.filter((e) => e.type === 'drop');
    return {
      ...base, ...rowRec, premiseOk: true,
      dragstart: { n: starts.length, targetClass: classify(starts[0]), types: starts[0] ? starts[0].types : null },
      firstDragover: firstOver ? { types: firstOver.types, targetClass: classify(firstOver) } : null,
      drop: drops.length ? { n: drops.length, targetClass: classify(drops[0]), types: drops[0].types, dataMatchesDraggedId: drops[0].dataMatchesDraggedId } : null,
      dragendN: L.counts.dragend || 0, dragenterSeen: (L.counts.dragenter || 0) > 0,
      diag: { counts: L.counts, dropData: drops.length ? drops[0].data : null, draggedId: L.marks.draggedId, pressPoint: [x, y] },
    };
  }

  // (e) a drop on the 1 px gap between two rows.
  // AMENDED after run 0, PREMISES ONLY, and the classification gains one column:
  //  - run 0 looked for a point 0.5 / 0.25 / 0.75 px below the upper row's bottom edge whose `elementFromPoint` is the list
  //    container and found none in any of the three gaps (the layout gap itself measured 1 px). The amended probe scans
  //    `elementFromPoint` over the integer coordinates around that edge (what a mouse at a device scale factor of 1 can
  //    produce) and over a 0.25 px grid from 2 px above to 4 px below it, prefers an integer hit on the list container,
  //    then a grid hit, and records the whole scan in `diag`; with no hit at all the cell stays "not measured" and says so.
  //  - run 0 required >= 4 `dragover` events before the release. Blink fires `dragover` only for an update that does not
  //    change the element under the pointer and `dragenter` when it does, so a path across many rows produces few
  //    `dragover`s (PC.e.row got 3 in 3 s of waiting and was refused). The premise is now that a `dragenter` or a
  //    `dragover` arrived AT the release point (within 1 px) before the release.
  //  - the class of the last `dragenter`/`dragover` is recorded next to the pre-registered class of the last `dragover`.
  async function cellE(panel, name, pair) {
    await setScroll(panel, 'top');
    await panel.evaluate(PC_MAKE_DRAGGABLE, null);
    const src = await centerOf(rowByTitle(panel, 'link', 'L00'));
    const base = { drop: name };
    let tx; let ty; let gapPx = null; let scan = null; let chosen = null;
    if (pair) {
      const ub = (await centerOf(rowByTitle(panel, 'link', pair[0]))).box;
      const lb = (await centerOf(rowByTitle(panel, 'link', pair[1]))).box;
      tx = ub.x + ub.width / 2;
      const bottom = ub.y + ub.height;
      gapPx = +(lb.y - bottom).toFixed(3);
      scan = await panel.evaluate(([px, edge, titles]) => {
        const what = (py) => {
          const el = document.elementFromPoint(px, py);
          if (!el) return null;
          if (el.getAttribute('data-testid') === 'bookmark-list') return 'list';
          if (el.matches('[data-testid="bookmark-row"]')) return 'row';
          return el.tagName;
        };
        const integers = [];
        for (let j = -3; j <= 5; j++) { const py = Math.floor(edge) + j; integers.push({ y: py, offsetFromEdge: +(py - edge).toFixed(3), hit: what(py) }); }
        const grid = [];
        for (let i = -8; i <= 16; i++) { const py = edge + i * 0.25; grid.push({ y: py, offsetFromEdge: +(i * 0.25).toFixed(2), hit: what(py) }); }
        // The page's own numbers for the two rows (Playwright's boundingBox is the other source), and the whole stack of
        // elements under the middle of the gap, top first: what is in the gap if it is not the list container.
        const rowRect = (title) => {
          const r = [...document.querySelectorAll('[data-testid="bookmark-row"]')]
            .find((n) => ((n.querySelector('.w-row__main') || {}).textContent || '') === title);
          if (!r) return null;
          const b = r.getBoundingClientRect();
          const cs = getComputedStyle(r);
          return { top: b.top, bottom: b.bottom, height: b.height, marginTop: cs.marginTop, marginBottom: cs.marginBottom };
        };
        const stack = document.elementsFromPoint(px, edge + 0.5).map((el) => `${el.tagName}.${String(el.getAttribute('class') || '').split(' ')[0]}`);
        return { edge, integers, grid, pageRects: { upper: rowRect(titles[0]), lower: rowRect(titles[1]) }, stackAtMidGap: stack };
      }, [tx, bottom, pair]);
      const intHit = scan.integers.find((s) => s.hit === 'list');
      const gridHit = scan.grid.find((s) => s.hit === 'list');
      chosen = intHit ? { ...intHit, integer: true } : gridHit ? { ...gridHit, integer: false } : null;
      if (!chosen) {
        return { ...notMeasured({ ...base, gapPx }, 'no integer coordinate within -3..+5 px of the upper row\'s bottom edge and no point on a 0.25 px grid from -2 to +4 px resolves to the list container'), diag: { scan } };
      }
      ty = chosen.y;
    } else {
      const c = await centerOf(rowByTitle(panel, 'link', 'L12'));
      tx = c.x; ty = c.y;
    }
    await pcReset(panel, 'private');
    await panel.mouse.move(src.x, src.y);
    await panel.mouse.down();
    await panel.mouse.move(src.x, src.y + 14, { steps: 3 });
    const started = await pcWait(panel, 'dragstart', 1, 3000);
    if (!started) { await panel.mouse.up(); return notMeasured({ ...base, gapPx }, 'the drag did not start'); }
    await panel.mouse.move(tx, ty, { steps: 16 });
    const arrived = await panel.waitForFunction(
      ([px, py]) => window.__pc.log.some((e) => (e.type === 'dragenter' || e.type === 'dragover') && Math.abs(e.x - px) <= 1 && Math.abs(e.y - py) <= 1),
      [tx, ty], { timeout: 3000 },
    ).then(() => true, () => false);
    await panel.mouse.up();
    await pcWait(panel, 'dragend', 1, 3000);
    const L = await pcRead(panel);
    const lastOver = [...L.log].reverse().find((e) => e.type === 'dragover') || null;
    const lastEnterOrOver = [...L.log].reverse().find((e) => e.type === 'dragenter' || e.type === 'dragover') || null;
    const drop = L.log.find((e) => e.type === 'drop') || null;
    const detail = (e) => (e && e.target ? `${e.target.tag}.${e.target.cls}` : null);
    return {
      ...base, premiseOk: arrived, ...(arrived ? {} : { notMeasured: 'no dragenter or dragover arrived within 1 px of the release point before the release' }),
      gapPx, chosenIsInteger: chosen ? chosen.integer : null, chosenOffsetFromUpperBottomPx: chosen ? chosen.offsetFromEdge : null,
      elementFromPointBeforeDrag: chosen ? chosen.hit : null,
      lastDragoverTargetClass: classifyGap(lastOver), lastDragoverTargetDetail: detail(lastOver),
      lastEnterOrOverKind: lastEnterOrOver ? lastEnterOrOver.type : null, lastEnterOrOverTargetClass: classifyGap(lastEnterOrOver), lastEnterOrOverTargetDetail: detail(lastEnterOrOver),
      dropFired: !!drop, dropTargetClass: classifyGap(drop), dropTargetDetail: detail(drop),
      diag: { counts: L.counts, scan, releasePoint: [tx, ty], lastEnterOrOverXY: lastEnterOrOver ? [lastEnterOrOver.x, lastEnterOrOver.y] : null },
    };
  }

  granted('PC: drag mechanics in the real rail: stationary dragover, pointer events, press targets, types, the gap', async ({ harness, serviceWorker }) => {
    const { panel } = harness;
    const cells = {};
    await P.openColumn(harness, serviceWorker, PC_ITEMS, { width: 460, height: 700 });
    await panel.evaluate(PC_INSTALL);
    record('env-PC', {
      userAgent: await panel.evaluate(() => navigator.userAgent), startedAt: new Date().toISOString(), loadavgStart: loadavg(),
      node: process.version, harness: 'the e2e `granted` fixture: the shipped extension with bookmarks in permissions; panel opened as a tab; page.mouse',
    });

    cells['PC.setup'] = await panel.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="bookmark-row"]')];
      const rail = document.getElementById('bookmark-rail');
      const list = rail.querySelector('[data-testid="bookmark-list"]');
      const rr = rail.getBoundingClientRect();
      return {
        premiseOk: rows.length >= 60 && rail.scrollHeight > rail.clientHeight,
        rows: rows.length, depth0Rows: rows.filter((r) => r.dataset.depth === '0').length,
        folderRowsBelowRoot: rows.filter((r) => r.dataset.kind === 'folder' && r.dataset.depth !== '0').length,
        linkRows: rows.filter((r) => r.dataset.kind === 'link').length,
        railScrolls: rail.scrollHeight > rail.clientHeight, listRowGap: getComputedStyle(list).rowGap,
        diag: { railClientHeight: rail.clientHeight, railScrollHeight: rail.scrollHeight, railRect: [rr.left, rr.top, rr.width, rr.height], viewport: [window.innerWidth, window.innerHeight] },
      };
    });
    cells['PC.setup'].diag.harnessDrag = dragMechanism();
    console.log(`PC.setup: ${JSON.stringify({ ...cells['PC.setup'], diag: undefined })}`);

    const run = async (key, fn) => {
      try { cells[key] = await fn(); } catch (e) { cells[key] = notMeasured({}, `the cell threw: ${String((e && e.stack) || e).slice(0, 400)}`); }
      const c = cells[key];
      console.log(`${key}: ${c.premiseOk ? JSON.stringify({ ...c, diag: undefined, raw: undefined }) : `NOT MEASURED (${c.notMeasured})`}`);
    };
    for (const where of ['bottom', 'top', 'middle']) await run(`PC.a.${where}`, () => cellA(panel, where));
    await run('PC.b', () => cellB(panel));
    for (const spec of PC_VARIANTS) await run(`PC.c.${spec.v}`, () => cellPress(panel, spec));
    for (const [name, pair] of [['gap1', ['L07', 'L08']], ['gap2', ['L10', 'L11']], ['gap3', ['L13', 'L14']], ['row', null]]) {
      await run(`PC.e.${name}`, () => cellE(panel, name, pair));
    }
    const measured = Object.keys(cells).filter((k) => cells[k].premiseOk);
    record('PC', {
      cells, summary: { cells: Object.keys(cells).length, measured: measured.length, notMeasured: Object.keys(cells).filter((k) => !cells[k].premiseOk) },
      diag: { loadavgEnd: loadavg(), finishedAt: new Date().toISOString() },
    }, `cells=${Object.keys(cells).length} measured=${measured.length}`);
    expect(Object.keys(cells).length, 'PC records every cell').toBe(PC_EXPECTED);
  });
});
