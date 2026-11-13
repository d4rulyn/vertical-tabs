// 105-window-blur-probe — platform probe for unit A1 (the name field and a window that loses focus).
//
// NOT a regression test of Vertical Tabs. The question CLAUDE.md section 7.2 forbids answering from memory:
// in the headless Chromium of the specs (the panel opened as a TAB of window W1, a second window W2 beside
// it), is there a way to make the panel's page lose focus the way Alt+Tab does it, so that the focused
// <input> gets a real `blur` event while `document.hasFocus()` is false? And in that state, what is
// `document.visibilityState`? (The product's guard is `document.hasFocus()`; a guard on `visibilityState`
// is the wrong signal if the window stays 'visible' while it has lost focus, which is what Alt+Tab does.)
//
// Playwright switches focus emulation ON for every page it opens (`Emulation.setFocusEmulationEnabled`,
// sent on the page's own CDP session), so with the defaults a page believes it has focus for ever.
//
// PASS criteria, written before the runs they judge. Nothing here is asserted but that the page was armed
// (the input held focus at rest), so a silent harness failure cannot pass. The results of the runs, what they
// mean and what they do not measure are recorded in .agent/probe-results.md, section "Probe 105".
//   Round 1 (2026-11-12 16:36 JST), test "105 which ways ...": the probe prints, for each way of taking focus
//     away (another window to front by Page.bringToFront and by windows.update, a sibling tab of the same
//     window, element.blur(), with focus emulation on and off), the events the input and the window got and
//     hasFocus / visibilityState at each.
//   Round 2 (2026-11-12 16:55 JST), tests "105b" and "105c":
//     C1  a sibling tab of the panel's window brought to front gives the input a `blur` that saw
//         hasFocus() === false, and visibilityState stays 'visible' (the signals of Alt+Tab); the probe says
//         whether that needs the second CDP session's `enabled:false` (105c) or not (105b);
//     C2  bringing the panel back gives `focus` on the window and on the input, hasFocus() true, and the input
//         is document.activeElement again;
//     C3  while the page has lost focus, focus moved by script (another element .focus(), the input's own
//         .blur()) gives the input no second `blur` (what decides whether a field can be left stranded).
//   Each test is run 3 times in a row (--repeat-each=3); a mechanism counts as reliable only if all 3 agree.
//   (In 105c the probe puts focus back on the input itself before the panel comes back, so C2's "the input is
//   document.activeElement again" holds there by construction, and neither return line shows what happens when
//   focus was left on another element; the "Probe 105" section says so. The lines printed under the label
//   "unfocused" in 105b are not unfocused: there the emulation is on and the page has focus.)
//
// Run (probes live outside testDir; in the e2e container, never on the host):
//   env VT_TEST_DIR=./probes playwright test 105-window-blur-probe.spec.js --retries=0 --reporter=line --repeat-each=3
'use strict';

const { test, expect } = require('../fixtures');
const { swEval, sleep } = require('../helpers/chrome');

/** A text field in the panel page that records every focus event, and what the page believed at that moment. */
async function arm(panel) {
  await panel.evaluate(() => {
    const old = document.getElementById('probe-input');
    if (old) old.remove();
    const input = document.createElement('input');
    input.id = 'probe-input';
    document.body.append(input);
    window.__ev = [];
    const where = (e) => {
      if (e.target === input) return 'input';
      if (e.target === window) return 'window';
      if (e.target === document) return 'document';
      return String(e.target && e.target.nodeName);
    };
    const note = (name) => (e) => window.__ev.push({
      name, on: where(e), hasFocus: document.hasFocus(), vis: document.visibilityState,
      activeIsInput: document.activeElement === input,
    });
    input.addEventListener('focus', note('focus'));
    input.addEventListener('blur', note('blur'));
    window.addEventListener('focus', note('focus'));
    window.addEventListener('blur', note('blur'));
    document.addEventListener('visibilitychange', note('visibilitychange'));
    input.focus();
  });
}

const now = (panel) => panel.evaluate(() => ({
  hasFocus: document.hasFocus(),
  vis: document.visibilityState,
  hidden: document.hidden,
  activeIsInput: document.activeElement && document.activeElement.id === 'probe-input',
}));

/** Read and empty the event record. */
const take = (panel) => panel.evaluate(() => window.__ev.splice(0));

const show = (label, value) => console.log(`PROBE105 ${label} ${JSON.stringify(value)}`);

/** A tab of window `windowId` that comes to front: the panel's tab (in W1) is no longer the active one. */
const activateSibling = (sw, windowId) => swEval(sw, async (id) => {
  const tab = await chrome.tabs.create({ windowId: id, url: 'about:blank', active: true });
  return tab.id;
}, windowId);

test('105 which ways of taking focus away give the input a real blur with hasFocus() false', async ({
  context, harness, serviceWorker,
}) => {
  test.setTimeout(180_000);
  const { panel, w1, w2, urls } = harness;
  const other = context.pages().find((p) => p.url() === urls.alpha);
  expect(other, 'a page of the second window is there to bring to front').toBeTruthy();
  const cdp = await context.newCDPSession(panel);

  await panel.bringToFront();
  await arm(panel);
  await sleep(300);
  const rest = await now(panel);
  show('rest, defaults (focus emulation on)', rest);
  expect(rest.activeIsInput, 'the input holds focus at rest').toBe(true);
  await take(panel);

  // A. Defaults. Another window is brought to front.
  await other.bringToFront();
  await sleep(700);
  show('A: defaults, other.bringToFront() -> now', await now(panel));
  show('A: defaults, other.bringToFront() -> events', await take(panel));
  await panel.bringToFront();
  await sleep(500);
  show('A: back, panel.bringToFront() -> now', await now(panel));
  show('A: back -> events', await take(panel));

  // B. Focus emulation switched OFF through a second CDP session of the same page.
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await sleep(500);
  show('B: second session says enabled:false -> now', await now(panel));
  show('B: second session says enabled:false -> events', await take(panel));

  await other.bringToFront();
  await sleep(700);
  show('B1: emulation off, other.bringToFront() -> now', await now(panel));
  show('B1: emulation off, other.bringToFront() -> events', await take(panel));
  await panel.bringToFront();
  await sleep(700);
  show('B1: back, panel.bringToFront() -> now', await now(panel));
  show('B1: back -> events', await take(panel));

  // B2. The same through the extension API (what a user's click on the other window does to this one).
  await swEval(serviceWorker, (id) => chrome.windows.update(id, { focused: true }), w2);
  await sleep(700);
  show('B2: emulation off, windows.update(w2, focused) -> now', await now(panel));
  show('B2: emulation off, windows.update(w2, focused) -> events', await take(panel));
  await swEval(serviceWorker, (id) => chrome.windows.update(id, { focused: true }), w1);
  await sleep(700);
  show('B2: back, windows.update(w1, focused) -> now', await now(panel));
  show('B2: back -> events', await take(panel));

  // B3. A tab of the SAME window comes to front: the panel tab is not the active one any more.
  const sibling = await activateSibling(serviceWorker, w1);
  await sleep(700);
  show('B3: emulation off, a sibling tab of W1 activated -> now', await now(panel));
  show('B3: emulation off, a sibling tab of W1 activated -> events', await take(panel));
  await swEval(serviceWorker, (id) => chrome.tabs.remove(id), sibling);
  await panel.bringToFront();
  await sleep(700);
  show('B3: back -> now', await now(panel));
  show('B3: back -> events', await take(panel));

  // C. A programmatic blur() of the field, emulation off, the page itself still focused.
  await arm(panel);
  await sleep(200);
  await take(panel);
  await panel.evaluate(() => document.activeElement.blur());
  await sleep(200);
  show('C: emulation off, element.blur() -> now', await now(panel));
  show('C: emulation off, element.blur() -> events', await take(panel));

  // D. Emulation back ON through the same second session, then the other window to front: nothing may happen.
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await arm(panel);
  await sleep(200);
  await take(panel);
  await other.bringToFront();
  await sleep(700);
  show('D: emulation on again, other.bringToFront() -> now', await now(panel));
  show('D: emulation on again, other.bringToFront() -> events', await take(panel));
  await panel.bringToFront();
  await cdp.detach();
});

/** The sibling-tab way, as a fresh page each: with the defaults (`off` false) or with the second session's enabled:false. */
async function siblingRound({ context, harness, serviceWorker }, { off, label }) {
  const { panel, w1 } = harness;
  if (off) {
    const cdp = await context.newCDPSession(panel);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  }
  await panel.bringToFront();
  await arm(panel);
  await sleep(300);
  const rest = await now(panel);
  show(`${label}: rest`, rest);
  expect(rest.activeIsInput, 'the input holds focus at rest').toBe(true);
  await take(panel);

  const sibling = await activateSibling(serviceWorker, w1);
  await sleep(700);
  show(`${label}: sibling tab of W1 active -> now`, await now(panel));
  show(`${label}: sibling tab of W1 active -> events`, await take(panel));

  // C3: focus moved by script while the page has lost focus.
  await panel.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'probe-button';
    document.body.append(button);
    button.focus();
  });
  show(`${label}: unfocused, another element .focus() -> now`, await panel.evaluate(() => ({
    hasFocus: document.hasFocus(), activeId: document.activeElement && document.activeElement.id,
  })));
  show(`${label}: unfocused, another element .focus() -> events`, await take(panel));
  await panel.evaluate(() => document.getElementById('probe-input').focus());
  show(`${label}: unfocused, input .focus() again -> events`, await take(panel));
  await panel.evaluate(() => document.getElementById('probe-input').blur());
  show(`${label}: unfocused, input .blur() -> now`, await panel.evaluate(() => ({
    hasFocus: document.hasFocus(), activeIsBody: document.activeElement === document.body,
  })));
  show(`${label}: unfocused, input .blur() -> events`, await take(panel));
  await panel.evaluate(() => document.getElementById('probe-input').focus());
  await take(panel);

  // C2: the panel comes back.
  await swEval(serviceWorker, (id) => chrome.tabs.remove(id), sibling);
  await panel.bringToFront();
  await sleep(700);
  show(`${label}: back -> now`, await now(panel));
  show(`${label}: back -> events`, await take(panel));
}

test('105b sibling tab of the panel\'s window to front, focus emulation as Playwright sets it (defaults)', async ({
  context, harness, serviceWorker,
}) => {
  test.setTimeout(120_000);
  await siblingRound({ context, harness, serviceWorker }, { off: false, label: 'b-defaults' });
});

test('105c sibling tab of the panel\'s window to front, after a second CDP session said enabled:false', async ({
  context, harness, serviceWorker,
}) => {
  test.setTimeout(120_000);
  await siblingRound({ context, harness, serviceWorker }, { off: true, label: 'c-off' });
});
