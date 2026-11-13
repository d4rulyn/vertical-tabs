// 97-group-close-drag-probe — THROWAWAY platform probe, "Probe 15" in .agent/probe-results.md.
// (Written as 96 / Probe 14; renumbered before it was pushed, because fix/close-group-decisions claimed 96 / Probe 14
// first. The measurement was taken under the old name; only the name changed.)
//
// NOT a regression test of Vertical Tabs. It measures one Chromium 151.0.7922.34 fact that CLAUDE.md §7.2 forbids
// asserting from memory, because the group-header close button (group-close.js) depends on it: a group header is
// `draggable="true"`; does a press on a <button> INSIDE it, followed by a mouse move, start the header's HTML5 drag?
// Nothing in this file asserts what Chromium does. The test only checks that the complete record described by the
// PASS criterion was produced; what the numbers mean is decided afterwards, in probe-results.md.
//
// PASS criterion (written before the first run, and before the decision rule below was applied):
//   For each variant, on a fresh header: press the mouse at the centre of the element, move 40 px down in 8 steps,
//   release. Record how many `dragstart` events reached the document (capture phase) and how many `dragend`, and
//   the `event.target` tag of each `dragstart`. Variants:
//     a  the group-close button as built (default `<button>` inside the draggable header)
//     b  the same button with draggable="false"
//     c  the group title (reference: a header drag from its own text must start)
//   The probe is complete when all three records exist, each from a header that was present before the press.
//
// Decision rule, fixed before the run: a = 0 -> the template stays as it is. a >= 1 and b = 0 -> the button gets
// draggable="false". a >= 1 and b >= 1 -> group-close.js gets a dragstart guard.
//
// Run (probes live outside testDir; in the e2e container, never on the host):
//   VT_TEST_DIR=./probes playwright test 97-group-close-drag-probe.spec.js --reporter=list --retries=0
'use strict';

const fs = require('fs');
const path = require('path');
const { test, expect } = require('../fixtures');
const { swEval, setSettings, createTab } = require('../helpers/chrome');

const OUT = process.env.OUT_DIR || path.resolve(__dirname, '../output');
const REPORT = path.join(OUT, 'group-close-drag-probe.json');
const HEADER = '[data-testid="group-header"]';

test('drag start from a button inside a draggable group header', async ({ harness, serviceWorker }) => {
  const { w2, tabIds, urls, panel } = harness;
  await panel.setViewportSize({ width: 400, height: 1500 });
  await setSettings(serviceWorker, { refreshInterval: 'off' });

  const report = {};
  for (const variant of ['a', 'b', 'c']) {
    // A fresh group per variant: a drag that did start may have moved the previous header.
    const t1 = await createTab(serviceWorker, w2, urls.page('aa0000', `V${variant}1`), { active: false });
    const t2 = await createTab(serviceWorker, w2, urls.page('00aa00', `V${variant}2`), { active: false });
    const groupId = await swEval(serviceWorker, async (a) => {
      const g = await chrome.tabs.group({ tabIds: [a.t1, a.t2], createProperties: { windowId: a.wid } });
      await chrome.tabGroups.update(g, { title: `Probe ${a.variant}`, color: 'blue' });
      return g;
    }, { t1, t2, wid: w2, variant });
    const header = panel.locator(`.group[data-group-id="${groupId}"] ${HEADER}`);
    await expect(header, `header of group ${groupId} drawn`).toHaveCount(1, { timeout: 10_000 });

    const selector = variant === 'c' ? '.group-title' : '[data-testid="group-close"]';
    const target = header.locator(selector);
    await expect(target, `${selector} present in the header`).toHaveCount(1);
    await header.hover();
    if (variant === 'b') await target.evaluate((el) => el.setAttribute('draggable', 'false'));
    // The listeners go in ONCE per page and write to whatever `window.__probeDrag` is at the time. (A first run
    // added a pair of listeners per variant; each dragstart then reached all of them and the arrays read 1, 2, 3
    // for what was one dragstart each. The counts in probe-results.md come from the corrected run.)
    await panel.evaluate(() => {
      window.__probeDrag = { starts: [], ends: 0 };
      if (window.__probeInstalled) return;
      window.__probeInstalled = true;
      document.addEventListener('dragstart', (e) => window.__probeDrag.starts.push(e.target.tagName + '.' + e.target.className), true);
      document.addEventListener('dragend', () => { window.__probeDrag.ends += 1; }, true);
    });

    const box = await target.boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await panel.mouse.move(cx, cy);
    await panel.mouse.down();
    await panel.mouse.move(cx, cy + 40, { steps: 8 });
    await panel.mouse.up();

    report[variant] = {
      selector,
      draggableAttr: await target.evaluate((el) => el.getAttribute('draggable')),
      ...(await panel.evaluate(() => window.__probeDrag)),
    };
    // Put the panel back to a known state for the next variant.
    await panel.evaluate(() => window.__vt.stateModule.resync());
  }

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(`===== group-close drag probe: ${JSON.stringify(report)}`);
  expect(Object.keys(report).sort()).toEqual(['a', 'b', 'c']);
});
