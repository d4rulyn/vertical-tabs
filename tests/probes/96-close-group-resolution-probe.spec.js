// 96-close-group-resolution-probe — Probe 14 in .agent/probe-results.md: WHEN does each "close group" entry decide which
// tabs it acts on, and does a card inside a multi-selection close the group or the selection?
//
// Written for the owner's decisions of 2026-11-04 17:42 JST on PR #12's questions 2 and 3 (resume.md `# Waiting`, item B).
// The question was put as "the header menu fixes its ids when it OPENS, a card resolves them when the item is CLICKED".
// This file measures what the unmodified extension does; it does not assert a Chrome behaviour.
//
// ── CRITERIA, WRITTEN BEFORE THE FIRST RUN ────────────────────────────────────────────────────────────────────────────
// Layout (as spec 33): [alpha beta gamma] = Work, [delta] = Other, epsilon loose. The threshold is 10, so no confirm bar
// appears. Every scenario is one fresh browser. Order of events: (1) build the layout, (2) open the menu, (3) change the
// group's membership through the service worker, (4) wait until the PANEL'S MODEL shows the change, (5) read the group's
// members from CHROME, (6) click the item, (7) read Chrome until it has changed and then stayed the same for 2 s.
//
// A scenario is VALID only if all of these held; a scenario that violates one is INVALID, never PASS or FAIL:
//   V1  the layout was built as described (Chrome's groupIds, read before the menu was opened);
//   V2  the context menu was visible before the change AND still visible right before the click;
//   V3  the panel's model showed the changed membership before the click (so a click-time resolution would see it);
//   V4  the item was enabled and the click landed;
//   V5  the Chrome read after the click differed from the one before it within 15 s.
//
// PASS / FAIL for a valid scenario. `members` = the tabs Chrome reports in Work (groupId) at step 5.
//   header-close    PASS iff the tabs gone after the click are exactly `members`.      FAIL otherwise.
//   card-close      PASS iff the tabs gone after the click are exactly `members`.      FAIL otherwise. (opened on alpha)
//   header-ungroup  PASS iff every tab of `members` is loose afterwards AND every other tab kept the groupId it had at
//                   step 5.                                                            FAIL otherwise.
//   sel-*           PASS iff the tabs gone are exactly {alpha, beta, gamma} (the group of the card that was right-clicked,
//                   whatever the selection is).                                         FAIL otherwise.
// Changes applied at step 3 (header-* and card-close only):
//   leave-loose  chrome.tabs.ungroup([beta])                     members becomes {alpha, gamma}
//   join-loose   chrome.tabs.group({tabIds:[epsilon], groupId})  members becomes {alpha, beta, gamma, epsilon}
//   move-other   chrome.tabs.group({tabIds:[beta], groupId: Other})  members becomes {alpha, gamma}
// Selection scenarios (no change at step 3; the selection is made with Ctrl+click on the cards, the active tab alpha is in
// it from the start; the card right-clicked is beta, which is in the selection):
//   sel-spans    selection {alpha, beta, delta, epsilon}  (one tab of another group and one loose tab)
//   sel-subset   selection {alpha, beta}                  (inside the group, gamma not selected)
//   Each also records the label of the `close` item, which says "Close N tabs" when the selection is in effect; a label
//   that does not say 4 / 2 makes the scenario INVALID (V6: the selection was not live at the click).
//
// What the result means for the work:
//   header-close FAIL in at least one change scenario  -> the header entry decides at OPEN and the product has to change
//                                                         (item 2 of the decision record).
//   header-close PASS in all three                      -> nothing to change for the header entry; the record says so.
//   header-ungroup is measured because it uses the same ids as header-close (context-menu.js, `tabIds`); FAIL there is a
//   second defect of the same kind, not a prerequisite of the first.
//   sel-* FAIL in either                                -> the selection leaks into close-group and the code has to change
//                                                         to close the group (item 3). PASS in both -> the code already
//                                                         closes the group and the work is to pin it with a test.
// Prediction written before the run, from reading the code (context-menu.js:247, :263, :276) and PR #12's one-off probe:
// header-close FAIL x3; card-close PASS x3; header-ungroup FAIL in join-loose and move-other, PASS in leave-loose;
// sel-* PASS. A prediction that turns out wrong is reported as such.
// Those line numbers, and the `tabIds` above, are the ones of context-menu.js at ecf5711, the extension this probe was
// written against (the same extension as main 1f70e67): :247 is the card item's `run`, :263 the header menu's
// `const tabIds = tabIdsOfGroup(groupId)`, :276 the header's `group-close` item. The product change of PR #21
// (dbe30a8) removed `tabIds`; in that head the header's ids are read inside `run` (:280-281) and :268 only decides
// whether the items are enabled.
//
// Output: one line `PROBE96 {json}` per scenario on the console, and the same line in $OUT_DIR/close-group-resolution-probe.jsonl.
//
// Run (probes live outside testDir):
//   HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose -f tests/docker-compose.yml \
//     run --rm e2e env VT_TEST_DIR=./probes playwright test 96-close-group-resolution-probe.spec.js \
//     --reporter=list --retries=0
'use strict';

const fs = require('fs');
const path = require('path');
const { test, expect } = require('../fixtures');
const { swEval, setSettings, createTab } = require('../helpers/chrome');

const OUT = process.env.OUT_DIR || path.resolve(__dirname, '../output');
const REPORT = path.join(OUT, 'close-group-resolution-probe.jsonl');

const MENU = '[data-testid="context-menu"]';
const HEADER = '[data-testid="group-header"]';
const CARD = '#tablist [data-testid="tab-card"]';
const PANEL_VIEWPORT = Object.freeze({ width: 400, height: 1500 });
const WORK = ['alpha', 'beta', 'gamma'];

test.beforeEach(async ({ harness, serviceWorker }) => {
  await harness.panel.setViewportSize(PANEL_VIEWPORT);
  await setSettings(serviceWorker, { refreshInterval: 'off', confirmCloseThreshold: 10 });
});

const headerOf = (panel, groupId) => panel.locator(`.group[data-group-id="${groupId}"] ${HEADER}`);
const thumbOf = (panel, id) => panel.locator(`[data-tab-id="${id}"] .thumb`);

/** `{ name: groupId }` for every tab of the window, read from Chrome. */
const chromeGroups = (sw, windowId, names) => swEval(sw, async (a) => {
  const tabs = await chrome.tabs.query({ windowId: a.windowId });
  const out = {};
  for (const t of tabs) out[a.names[t.id] || `#${t.id}`] = t.groupId;
  return out;
}, { windowId, names });

/** Builds `[alpha beta gamma]=Work [delta]=Other epsilon`. */
async function buildLayout(harness, sw) {
  const { w2, tabIds, urls, panel } = harness;
  const delta = await createTab(sw, w2, urls.delta, { active: false });
  const epsilon = await createTab(sw, w2, urls.page('ffff00', 'Epsilon'), { active: false });
  const ids = { alpha: tabIds.alpha, beta: tabIds.beta, gamma: tabIds.gamma, delta, epsilon };
  const groups = await swEval(sw, async (a) => {
    const work = await chrome.tabs.group({ tabIds: [a.alpha, a.beta, a.gamma], createProperties: { windowId: a.wid } });
    await chrome.tabGroups.update(work, { title: 'Work', color: 'blue' });
    const other = await chrome.tabs.group({ tabIds: [a.delta], createProperties: { windowId: a.wid } });
    await chrome.tabGroups.update(other, { title: 'Other', color: 'red' });
    return { work, other };
  }, { ...ids, wid: w2 });
  await expect(panel.locator(HEADER)).toHaveCount(2, { timeout: 10_000 });
  await expect(panel.locator(CARD)).toHaveCount(5, { timeout: 10_000 });
  const names = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
  // V1: asked of Chrome, not of the panel.
  const placed = await chromeGroups(sw, w2, names);
  const v1 = Object.keys(placed).length === 5
    && WORK.every((n) => placed[n] === groups.work) && placed.delta === groups.other && placed.epsilon === -1;
  return { ids, names, ...groups, v1, placed };
}

/** The tab ids that are still open, in every window. */
const openIds = (sw) => swEval(sw, async () => (await chrome.tabs.query({})).map((t) => t.id));

/** Waits until Chrome's state (open ids + groupIds) differs from `before`, then stays the same for 2 s. */
async function settledAfter(sw, windowId, names, before) {
  const read = async () => {
    const open = await openIds(sw);
    const groups = await chromeGroups(sw, windowId, names);
    return JSON.stringify({ open: open.sort((a, b) => a - b), groups });
  };
  const deadline = Date.now() + 15_000;
  let last = await read();
  while (last === before && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    last = await read();
  }
  const changed = last !== before;
  let same = 0;
  while (same < 8) {
    await new Promise((r) => setTimeout(r, 250));
    const now = await read();
    if (now === last) same += 1; else { same = 0; last = now; }
  }
  return { changed, state: JSON.parse(last) };
}

const SCENARIOS = [];
for (const entry of ['header-close', 'card-close', 'header-ungroup']) {
  for (const change of ['leave-loose', 'join-loose', 'move-other']) SCENARIOS.push({ entry, change });
}
SCENARIOS.push({ entry: 'sel-spans', change: null }, { entry: 'sel-subset', change: null });

const SELECTION = {
  'sel-spans': { ctrl: ['beta', 'delta', 'epsilon'], expect: ['alpha', 'beta', 'delta', 'epsilon'], label: 'Close 4 tabs' },
  'sel-subset': { ctrl: ['beta'], expect: ['alpha', 'beta'], label: 'Close 2 tabs' },
};

for (const sc of SCENARIOS) {
  test(`probe 96: ${sc.entry}${sc.change ? ` / ${sc.change}` : ''}`, async ({ harness, serviceWorker }) => {
    const { panel, w2 } = harness;
    const sw = serviceWorker;
    const L = await buildLayout(harness, sw);
    const { ids, names } = L;
    const invalid = [];
    if (!L.v1) invalid.push(`V1: layout is ${JSON.stringify(L.placed)}`);

    // (selection scenarios) Ctrl+click until the model's highlighted set is the one the scenario names.
    const sel = SELECTION[sc.entry];
    let highlighted = null;
    if (sel) {
      for (const n of sel.ctrl) await thumbOf(panel, ids[n]).click({ modifiers: ['Control'] });
      const want = sel.expect.map((n) => ids[n]).sort((a, b) => a - b);
      await expect.poll(
        () => panel.evaluate(() => [...window.__vt.state.highlighted].sort((a, b) => a - b)),
        { message: 'the selection never reached the panel model', timeout: 15_000 }).toEqual(want);
      highlighted = sel.expect;
    }

    // (2) open the menu
    const item = sc.entry === 'header-close' ? 'group-close'
      : sc.entry === 'header-ungroup' ? 'group-ungroup' : 'close-group';
    if (sc.entry.startsWith('header-')) await headerOf(panel, L.work).click({ button: 'right' });
    else if (sc.entry === 'card-close') await thumbOf(panel, ids.alpha).click({ button: 'right' });
    else await thumbOf(panel, ids.beta).click({ button: 'right' });
    const menu = panel.locator(MENU);
    const v2a = await menu.isVisible();
    if (!v2a) invalid.push('V2: the menu was not visible after the right-click');
    const closeLabel = sel
      ? (await panel.locator(`${MENU} [data-testid="menu-item-close"]`).textContent().catch(() => null))
      : null;
    if (sel && closeLabel !== sel.label) invalid.push(`V6: close item reads ${JSON.stringify(closeLabel)}, wanted ${JSON.stringify(sel.label)}`);

    // (3) change the membership
    if (sc.change) {
      await swEval(sw, async (a) => {
        if (a.change === 'leave-loose') await chrome.tabs.ungroup([a.beta]);
        else if (a.change === 'join-loose') await chrome.tabs.group({ tabIds: [a.epsilon], groupId: a.work });
        else await chrome.tabs.group({ tabIds: [a.beta], groupId: a.other });
      }, { change: sc.change, beta: ids.beta, epsilon: ids.epsilon, work: L.work, other: L.other });
      // (4) the panel's model shows it
      const changedTab = sc.change === 'join-loose' ? ids.epsilon : ids.beta;
      const wantGroup = sc.change === 'leave-loose' ? -1 : sc.change === 'join-loose' ? L.work : L.other;
      await expect.poll(
        () => panel.evaluate((id) => window.__vt.state.tabs.get(id).groupId, changedTab),
        { message: 'V3: the panel model never showed the changed membership', timeout: 15_000 }).toBe(wantGroup);
    }
    const v2b = await menu.isVisible();
    if (!v2b) invalid.push('V2: the menu was gone right before the click');

    // (5) read Chrome, (6) click
    const beforeGroups = await chromeGroups(sw, w2, names);
    const members = Object.keys(beforeGroups).filter((n) => beforeGroups[n] === L.work).sort();
    const before = JSON.stringify({
      open: (await openIds(sw)).sort((a, b) => a - b), groups: beforeGroups,
    });
    const btn = panel.locator(`${MENU} [data-testid="menu-item-${item}"]`);
    let clicked = false;
    if (await btn.isEnabled().catch(() => false)) {
      await btn.click();
      clicked = true;
    } else {
      invalid.push(`V4: ${item} was not enabled`);
    }

    // (7) what happened
    const after = clicked ? await settledAfter(sw, w2, names, before) : { changed: false, state: null };
    if (clicked && !after.changed) invalid.push('V5: Chrome did not change within 15 s of the click');
    const idToName = Object.fromEntries(Object.entries(names).map(([id, n]) => [Number(id), n]));
    const openNames = after.state ? new Set(after.state.open.map((id) => idToName[id]).filter(Boolean)) : null;
    const gone = openNames ? Object.keys(ids).filter((n) => !openNames.has(n)).sort() : null;
    const groupsAfter = after.state ? after.state.groups : null;

    let verdict = 'INVALID';
    if (invalid.length === 0) {
      if (sc.entry === 'header-close' || sc.entry === 'card-close') {
        verdict = JSON.stringify(gone) === JSON.stringify(members) ? 'PASS' : 'FAIL';
      } else if (sc.entry === 'header-ungroup') {
        const loose = members.every((n) => groupsAfter[n] === -1);
        const others = Object.keys(beforeGroups).filter((n) => !members.includes(n))
          .every((n) => groupsAfter[n] === beforeGroups[n]);
        verdict = loose && others ? 'PASS' : 'FAIL';
      } else {
        verdict = JSON.stringify(gone) === JSON.stringify(WORK.slice().sort()) ? 'PASS' : 'FAIL';
      }
    }
    const rec = {
      scenario: sc.entry + (sc.change ? `/${sc.change}` : ''), verdict, invalid,
      membersAtClick: members, gone, groupsAfter, highlighted, closeLabel,
      groupIds: { work: L.work, other: L.other },
    };
    fs.mkdirSync(OUT, { recursive: true });
    fs.appendFileSync(REPORT, `${JSON.stringify(rec)}\n`);
    console.log(`PROBE96 ${JSON.stringify(rec)}`);
    // The probe fails only when it could not measure; FAIL and PASS are both measurements.
    expect(invalid, 'the scenario was not valid, so nothing was measured').toEqual([]);
  });
}
