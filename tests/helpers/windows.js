// Two-window harness (spec.md §13.2 as amended by spec-addendum.md A21).
//
//   W1 = the persistent context's initial window. It hosts the panel PAGE
//        (sidepanel/sidepanel.html?windowId=W2) as its visible active tab, so
//        requestAnimationFrame, IntersectionObserver, Playwright actionability and
//        page.screenshot() all keep working.
//   W2 = a second normal window holding the Alpha/Beta/Gamma fixtures. Captures
//        target W2 only, so the panel's own window is never screenshotted.
//
// Capturing a non-focused second window is measured to work (probe-results.md,
// "Multi-window capture — WORKS"); the preflight below is a regression guard, not a
// fork in the design. There is no fallback harness: if the preflight fails the run
// stops with a message pointing back at the probe.
'use strict';

const { swEval, waitForTabsComplete, sleep } = require('./chrome');

const PANEL_PART = 'sidepanel/sidepanel.html';
const WELCOME_PART = 'welcome/welcome.html';

/** Closes the first-run welcome tab that runtime.onInstalled opens in every fresh profile. */
async function removeWelcomeTabs(context, sw) {
  for (const p of context.pages()) {
    if (p.url().includes(WELCOME_PART)) await p.close().catch(() => {});
  }
  return swEval(sw, async () => {
    const ts = await chrome.tabs.query({ url: chrome.runtime.getURL('welcome/welcome.html') });
    if (ts.length) await chrome.tabs.remove(ts.map((t) => t.id));
    return ts.length;
  }).catch(() => 0);
}

async function settleWelcomeTab(context, sw, budgetMs = 2500) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const removed = await removeWelcomeTabs(context, sw);
    if (removed > 0) return removed;
    if (Date.now() > deadline) return 0;
    await sleep(250);
  }
}

/** Opens sidepanel/sidepanel.html as a tab and waits for its test hook. */
async function openPanelPage(context, sw, { hostWindowId, scopedWindowId }) {
  const panelPromise = context.waitForEvent('page', {
    predicate: (p) => p.url().includes(PANEL_PART),
    timeout: 30_000,
  });
  await swEval(sw, async (a) => {
    const url = a.scopedWindowId == null
      ? chrome.runtime.getURL('sidepanel/sidepanel.html')
      : chrome.runtime.getURL(`sidepanel/sidepanel.html?windowId=${a.scopedWindowId}`);
    await chrome.tabs.create({ windowId: a.hostWindowId, url, active: true });
  }, { hostWindowId, scopedWindowId: scopedWindowId ?? null });

  const panel = await panelPromise;
  await panel.bringToFront();
  // `?windowId=` only chooses HOW the panel resolves its window; it does not gate the test
  // hook. `boot()` calls `publishTestHooks()` unconditionally (sidepanel.js), so
  // `window.__vt` exists on the production path too — spec 14(a) reads
  // `__vt.state.windowId` there (addendum A26). `__vt.ready` is therefore the right
  // readiness signal on both branches; `#tablist` is static markup in sidepanel.html and
  // is present long before the model, the settings and the stored previews are.
  await panel.waitForFunction(() => window.__vt && window.__vt.ready === true, null, { timeout: 30_000 });
  return panel;
}

/**
 * @param {import('@playwright/test').BrowserContext} context
 * @param {import('@playwright/test').Worker} sw
 * @param {{alpha:string,beta:string,gamma:string}} fixtures
 */
async function setupTwoWindows(context, sw, fixtures) {
  // 1. onInstalled opens welcome.html on every fresh persistent context.
  await settleWelcomeTab(context, sw);

  // 2. W1 must be read BEFORE W2 exists: in headless getLastFocused() answers with
  //    the newest window, so "the initial window" is only knowable now.
  const w1 = await swEval(sw, async () => {
    const ws = await chrome.windows.getAll({ windowTypes: ['normal'] });
    if (ws.length !== 1) throw new Error(`expected 1 initial window, got ${ws.length}`);
    return ws[0].id;
  });

  // 3. W2 with the three HTTP fixtures.
  const created = await swEval(sw, async (urls) => {
    const w = await chrome.windows.create({ url: urls, focused: true, width: 1280, height: 800 });
    return { w2: w.id, tabIds: (w.tabs || []).map((t) => t.id) };
  }, [fixtures.alpha, fixtures.beta, fixtures.gamma]);
  const { w2 } = created;
  const tabIds = created.tabIds;
  if (tabIds.length !== 3) throw new Error(`expected 3 fixture tabs in W2, got ${tabIds.length}`);
  await waitForTabsComplete(sw, tabIds);
  // onInstalled may have fired late; a welcome tab created after step 1 would land in
  // whichever window is current and pollute the card counts.
  await removeWelcomeTabs(context, sw);

  // 4. Preflight: capturing W2 must succeed (measured: it does, focused or not).
  const pre = await swEval(sw, async (id) => {
    let last = '';
    for (let i = 0; i < 3; i++) {
      try {
        const d = await chrome.tabs.captureVisibleTab(id, { format: 'jpeg' });
        return { ok: true, len: d.length };
      } catch (e) {
        last = String((e && e.message) || e);
        await new Promise((r) => setTimeout(r, 1200)); // > MIN_CALL_SPACING_MS
      }
    }
    return { ok: false, error: last };
  }, w2);
  if (!pre.ok) {
    throw new Error(
      `two-window harness preflight failed: captureVisibleTab(W2) -> ${pre.error}. ` +
      'probe-results.md "Multi-window capture — WORKS" says this must succeed; ' +
      're-run the probe before editing specs.');
  }

  // 5. The panel page lives in W1 but is scoped to W2.
  const panel = await openPanelPage(context, sw, { hostWindowId: w1, scopedWindowId: w2 });

  // 6. The preflight spent a capture slot; give the limiter its spacing back.
  await panel.waitForTimeout(1200);

  return {
    w1,
    w2,
    panel,
    tabIds: { alpha: tabIds[0], beta: tabIds[1], gamma: tabIds[2] },
    order: tabIds.slice(),
    urls: fixtures,
    openPanelPage: (opts) => openPanelPage(context, sw, opts),
  };
}

module.exports = { setupTwoWindows, openPanelPage, removeWelcomeTabs, settleWelcomeTab, PANEL_PART, WELCOME_PART };
