// 34-duplicate-url-preview — two tabs on one URL share ONE preview, and closing one of them
// must not take the other's away (user requirement #2: every tab shows a preview).
//
// The panel keeps one cache entry per URL key with a reference count. Every card that renders the
// entry holds one reference, recorded on the card as `data-thumb-key`. A closed tab used to give its
// reference back TWICE: `thumbs.onTabRemoved` (from tabs.onRemoved) released the marker without
// clearing it, then `thumbs.unobserve` (from the next render's removeRow) released it again. The
// second release belonged to the surviving twin, so the count sat at zero while a card still showed
// the entry. The next capture of that URL then built an entry with no object URL and the survivor lost
// its <img src>; so did any repaint once the 60 s grace timer had revoked the URL.
//
// What these specs observe, and how:
//  * The outcome the user sees (S1): after a REAL second capture of the shared URL — the service
//    worker's own pipeline: tabs.update activation -> captureVisibleTab -> IndexedDB ->
//    vt/thumb-updated -> thumbs.refresh — the surviving card shows the fresh capture: a blob: src
//    that changed, decoded, carrying the page's own pixels. Nothing here calls thumbs.refresh itself.
//  * The invariant behind it (I1, I2): release() arms one grace timer exactly when a count reaches
//    zero. The panel's setTimeout is wrapped to record timers of OBJECT_URL_GRACE_MS, so "closing one
//    of two tabs must not arm one" and "closing the last one arms exactly one" are assertions on the
//    module's own side effect. No hook was added to the product, and a leak (zero timers where one is
//    due) fails as loudly as the double release (one timer too many).
//
// Not covered: that the object URL is really revoked when that timer fires, which takes 60 s of real
// time. The timer being armed exactly once is what this spec can pin down without sleeping.
'use strict';

const { test, expect } = require('../fixtures');
const {
  swEval, setSettings, keyOf, waitForThumb, getThumb, waitForTabsComplete,
} = require('../helpers/chrome');
const { PIXEL_RULE, tryStatsOfRenderedImg } = require('../helpers/pixels');
const { extConstant } = require('../helpers/ext-constants');

const GRACE_MS = extConstant('OBJECT_URL_GRACE_MS');
const CARD = (tabId) => `[data-testid="tab-card"][data-tab-id="${tabId}"]`;

/**
 * Records every timer thumbs.js arms with the grace delay, i.e. every release() that took a count to
 * zero. The caller names exist only so that a failure says which release it was.
 */
async function installReleaseSpy(panel) {
  await panel.evaluate((grace) => {
    if (window.__releaseSpy) return;
    const arms = [];
    const real = window.setTimeout;
    window.setTimeout = function patched(fn, delay, ...rest) {
      if (delay === grace) {
        const callers = String(new Error().stack).split('\n').slice(1)
          .map((line) => /at (?:async )?(\S+)/.exec(line))
          .filter(Boolean)
          .map((m) => m[1].replace(/^Module\./, ''))
          .filter((name) => name !== 'patched');
        arms.push(callers.slice(0, 3).join(' < '));
      }
      return real.call(window, fn, delay, ...rest);
    };
    window.__releaseSpy = { arms };
  }, GRACE_MS);
}

/** The grace timers armed since the last clear. */
function readArms(panel, { clear = false } = {}) {
  return panel.evaluate((doClear) => {
    const out = window.__releaseSpy.arms.slice();
    if (doClear) window.__releaseSpy.arms.length = 0;
    return out;
  }, clear);
}

/** What the user can see in a card's preview box, read from the DOM. */
function imgState(panel, tabId) {
  return panel.evaluate((id) => {
    const card = document.querySelector(`[data-testid="tab-card"][data-tab-id="${id}"]`);
    const img = card && card.querySelector('.thumb__img');
    const thumb = card && card.querySelector('.thumb');
    if (!img || !thumb) return null;
    return {
      src: img.getAttribute('src'),
      hidden: img.hidden,
      complete: img.complete,
      nw: img.naturalWidth,
      nh: img.naturalHeight,
      loaded: thumb.classList.contains('thumb--loaded'),
    };
  }, tabId);
}

/** Why a card does or does not show a usable preview right now; 'ok' when it does. */
function previewVerdict(s, staleSrc) {
  if (!s) return 'no such card';
  if (!s.src) return 'the <img> has no src: the preview is gone';
  if (!s.src.startsWith('blob:')) return `src is not a blob: URL (${s.src.slice(0, 40)})`;
  if (s.hidden) return 'the <img> is hidden';
  if (!s.loaded) return 'the card is not thumb--loaded';
  // Without this the poll could succeed on the very src the capture is about to replace, and a
  // card that is going to lose its preview would be judged before the panel had processed the capture.
  if (staleSrc && s.src === staleSrc) return 'still the src from before the capture: the refresh has not reached the card';
  if (!s.complete || s.nw !== 640 || s.nh !== 240) return `not decoded (${s.nw}x${s.nh}, complete=${s.complete})`;
  return 'ok';
}

/**
 * The card shows the page's own picture: a blob: src (different from `staleSrc` when given) that
 * decodes to the page's pixels, not a flat placeholder.
 */
async function expectPreview(panel, tabId, { color, staleSrc = null, label }) {
  await expect.poll(
    async () => previewVerdict(await imgState(panel, tabId), staleSrc),
    { message: label },
  ).toBe('ok');
  const px = await tryStatsOfRenderedImg(panel, tabId);
  expect(px.error, `${label}: reading the pixels of the rendered <img>`).toBeNull();
  expect(px.dominant, `${label}: the preview is the page's own colour`).toBe(color);
  expect(px.share[color], `${label}: share of ${color} pixels`).toBeGreaterThanOrEqual(0.80);
  expect(Math.max(...px.span), `${label}: a real screenshot, not a flat fill`)
    .toBeGreaterThanOrEqual(PIXEL_RULE.uniformSpanMin);
}

/** What Duplicate in the tab menu does (spec.md 9.3: tabs.duplicate), and waits for the copy to load. */
async function duplicate(sw, tabId) {
  const id = await swEval(sw, async (from) => (await chrome.tabs.duplicate(from)).id, tabId);
  await waitForTabsComplete(sw, [id]);
  return id;
}

/** Closes tabs and waits until their cards have left the DOM, i.e. until the render that unobserves them. */
async function closeAndSettle(sw, panel, tabIds) {
  await swEval(sw, (ids) => chrome.tabs.remove(ids), tabIds);
  for (const id of tabIds) {
    await expect(panel.locator(CARD(id)), `card of closed tab ${id} leaves the list`)
      .toHaveCount(0, { timeout: 15_000 });
  }
}

/**
 * A real second capture of `key`: leave the tab and come back, which the service worker answers
 * with an `activated` capture (same stimulus as spec 23). Resolves once it is stored, i.e. after the
 * `vt/thumb-updated` broadcast that the panel turns into thumbs.refresh().
 */
async function recapture(sw, panel, { key, tabId, otherId }) {
  const before = await getThumb(panel, key);
  expect(before, 'the shared URL already has a stored capture').not.toBeNull();
  await swEval(sw, async (a) => {
    await chrome.tabs.update(a.otherId, { active: true });
    await new Promise((r) => setTimeout(r, 250)); // two distinct activations, as spec 23's retrigger
    await chrome.tabs.update(a.tabId, { active: true });
  }, { tabId, otherId });
  await waitForThumb(panel, key, { timeout: 40_000, newerThan: before.capturedAt });
}

/**
 * S1 for every survivor: each shows the fresh capture of the shared URL after a real recapture.
 * `trigger` is the tab that gets re-activated; it must be one of the survivors.
 */
async function expectSurvivorsKeepPreview(env, { key, survivors, trigger, otherId, step }) {
  const { sw, panel } = env;
  const staleSrc = {};
  for (const id of survivors) {
    staleSrc[id] = (await imgState(panel, id) || {}).src || null;
    expect(staleSrc[id], `${step}: tab ${id} still shows a preview before the second capture`)
      .toMatch(/^blob:/);
  }
  await recapture(sw, panel, { key, tabId: trigger, otherId });
  for (const id of survivors) {
    await expectPreview(panel, id, {
      color: 'red', staleSrc: staleSrc[id], label: `${step}: surviving tab ${id} after a real recapture`,
    });
  }
}

/** I1: closing a tab whose URL another open tab still shows must not give the last reference back. */
function expectNoRelease(arms, what) {
  expect.soft(
    arms,
    `${what}: the shared entry's count reached zero while another tab still shows it ` +
    `(grace timers armed by: ${arms.join(' | ') || 'none'})`,
  ).toEqual([]);
}

/** I2: the last holder gives the reference back once — not never (leak), not twice. */
function expectReleasedOnce(arms, what) {
  expect(
    arms,
    `${what}: exactly one release takes the count to zero (armed by: ${arms.join(' | ') || 'none'})`,
  ).toHaveLength(1);
}

/** The common start: alpha is captured and shown, the spy is in place. */
async function prepare({ harness, serviceWorker }, { widgets = [] } = {}) {
  const { panel, tabIds, urls } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off', widgets });
  await panel.setViewportSize({ width: 460, height: 900 });
  const key = await keyOf(panel, urls.alpha);
  await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), tabIds.alpha);
  await waitForThumb(panel, key, { timeout: 40_000 });
  await expectPreview(panel, tabIds.alpha, { color: 'red', label: 'precondition: alpha shows its preview' });
  await installReleaseSpy(panel);
  return { sw: serviceWorker, panel, key, alpha: tabIds.alpha, beta: tabIds.beta, gamma: tabIds.gamma, urls, w2: harness.w2 };
}

/**
 * Holds the panel's animation frames while `on`. state.scheduleRender() hands the render to
 * requestAnimationFrame, so with frames held a tab can already be gone from the model
 * (tabs.onRemoved -> state.removeTab -> thumbs.onTabRemoved) while its card is still on screen.
 * `real` is kept so a caller can wait out frames that were queued before the hold began.
 */
async function installFrameHold(panel) {
  await panel.evaluate(() => {
    if (window.__frameHold) return;
    const real = window.requestAnimationFrame.bind(window);
    const hold = { on: false, held: [], real };
    window.requestAnimationFrame = (cb) => {
      if (!hold.on) return real(cb);
      hold.held.push(cb);
      return -1;
    };
    window.__frameHold = hold;
  });
}

/** Turns the hold on, after two real frames have run any render that was already queued. */
async function holdFrames(panel) {
  await panel.evaluate(() => new Promise((resolve, reject) => {
    // In a hidden document scheduleRender() uses setTimeout(0), which nothing here can hold.
    if (document.hidden) {
      reject(new Error('the panel document is hidden: its render does not wait for an animation frame'));
      return;
    }
    const hold = window.__frameHold;
    const giveUp = setTimeout(() => reject(new Error('no animation frame within 5 s')), 5000);
    hold.real(() => hold.real(() => { clearTimeout(giveUp); hold.on = true; resolve(); }));
  }));
}

/** Stops holding and runs what was held, in order. Resolves to how many frames were waiting. */
function releaseFrames(panel) {
  return panel.evaluate(() => {
    const hold = window.__frameHold;
    hold.on = false;
    const waiting = hold.held.splice(0);
    for (const cb of waiting) cb(performance.now());
    return waiting.length;
  });
}

test.describe('two tabs on one URL share a preview', () => {
  for (const closes of ['duplicate', 'original']) {
    test(`closing the ${closes} of two same-URL tabs leaves the other one its preview`, async ({ harness, serviceWorker }) => {
      test.setTimeout(180_000);
      const env = await prepare({ harness, serviceWorker });
      const { sw, panel, key, alpha, beta } = env;

      const twin = await duplicate(sw, alpha);
      await expectPreview(panel, twin, { color: 'red', label: 'the copy shows the shared preview at once' });

      const gone = closes === 'duplicate' ? twin : alpha;
      const survivor = closes === 'duplicate' ? alpha : twin;
      await readArms(panel, { clear: true });
      await closeAndSettle(sw, panel, [gone]);
      const arms = await readArms(panel);
      console.log(`[dup] close ${closes}: grace timers armed by the close = ${JSON.stringify(arms)}`);
      expectNoRelease(arms, `closing the ${closes}`);

      await expectSurvivorsKeepPreview(env, {
        key, survivors: [survivor], trigger: survivor, otherId: beta, step: `after closing the ${closes}`,
      });

      await readArms(panel, { clear: true });
      await closeAndSettle(sw, panel, [survivor]);
      expectReleasedOnce(await readArms(panel), 'closing the last tab on the URL');
    });
  }

  test('closing tabs one by one out of three: every survivor keeps its preview until the last one goes', async ({ harness, serviceWorker }) => {
    test.setTimeout(180_000);
    const env = await prepare({ harness, serviceWorker });
    const { sw, panel, key, alpha, beta } = env;

    const copyA = await duplicate(sw, alpha);
    const copyB = await duplicate(sw, alpha);
    await expectPreview(panel, copyA, { color: 'red', label: 'first copy shows the shared preview' });
    await expectPreview(panel, copyB, { color: 'red', label: 'second copy shows the shared preview' });

    // One of three closed: two survivors. (The count is 3-2 = 1 with the double release, still above
    // zero, so this step alone cannot show the defect; it is here so the second step has a baseline.)
    await readArms(panel, { clear: true });
    await closeAndSettle(sw, panel, [copyA]);
    expectNoRelease(await readArms(panel), 'closing the first copy (two tabs remain)');
    await expectSurvivorsKeepPreview(env, {
      key, survivors: [alpha, copyB], trigger: alpha, otherId: beta, step: 'one of three closed',
    });

    // Two of three closed: the last survivor. This is where the count used to reach zero.
    await readArms(panel, { clear: true });
    await closeAndSettle(sw, panel, [copyB]);
    const arms = await readArms(panel);
    console.log(`[dup] second of three closed: grace timers armed = ${JSON.stringify(arms)}`);
    expectNoRelease(arms, 'closing the second copy (one tab remains)');
    await expectSurvivorsKeepPreview(env, {
      key, survivors: [alpha], trigger: alpha, otherId: beta, step: 'two of three closed',
    });

    await readArms(panel, { clear: true });
    await closeAndSettle(sw, panel, [alpha]);
    expectReleasedOnce(await readArms(panel), 'closing the last tab on the URL');
  });

  test('closing the extra copies with the duplicates widget leaves the kept tab its preview', async ({ harness, serviceWorker }) => {
    test.setTimeout(180_000);
    // The widget is on by default: it keeps the oldest tab of each URL and closes the rest in one go.
    const env = await prepare({ harness, serviceWorker }, { widgets: ['duplicates'] });
    const { sw, panel, key, alpha, beta } = env;

    const copyA = await duplicate(sw, alpha);
    const copyB = await duplicate(sw, alpha);
    await expectPreview(panel, copyA, { color: 'red', label: 'first copy shows the shared preview' });
    await expectPreview(panel, copyB, { color: 'red', label: 'second copy shows the shared preview' });

    const button = panel.locator('[data-testid="widget-duplicates-close"]');
    await expect(button, 'the widget offers to close the two extra copies').toBeVisible({ timeout: 15_000 });
    await readArms(panel, { clear: true });
    await button.click();
    for (const id of [copyA, copyB]) {
      await expect(panel.locator(CARD(id)), `extra copy ${id} was closed`).toHaveCount(0, { timeout: 15_000 });
    }
    const arms = await readArms(panel);
    console.log(`[dup] duplicates widget: grace timers armed = ${JSON.stringify(arms)}`);
    expectNoRelease(arms, 'closing the extra copies with the widget');

    await expectSurvivorsKeepPreview(env, {
      key, survivors: [alpha], trigger: alpha, otherId: beta, step: 'after the widget closed the copies',
    });

    await readArms(panel, { clear: true });
    await closeAndSettle(sw, panel, [alpha]);
    expectReleasedOnce(await readArms(panel), 'closing the last tab on the URL');
  });

  test('closing both tabs of a pair gives the shared entry back exactly once', async ({ harness, serviceWorker }) => {
    test.setTimeout(180_000);
    const env = await prepare({ harness, serviceWorker });
    const { sw, panel, alpha } = env;

    const twin = await duplicate(sw, alpha);
    await expectPreview(panel, twin, { color: 'red', label: 'the copy shows the shared preview' });

    await readArms(panel, { clear: true });
    await closeAndSettle(sw, panel, [twin]);
    expectNoRelease(await readArms(panel), 'closing the first of the pair');

    // No clear: what counts is every release since the pair was whole, and the count may reach zero
    // once, at the very end.
    await closeAndSettle(sw, panel, [alpha]);
    const arms = await readArms(panel);
    console.log(`[dup] pair closed: grace timers armed in total = ${JSON.stringify(arms)}`);
    expectReleasedOnce(arms, 'closing both tabs of the pair');
  });

  test('control: a tab on a different URL closing does not touch this one\'s preview', async ({ harness, serviceWorker }) => {
    test.setTimeout(180_000);
    const env = await prepare({ harness, serviceWorker });
    const { sw, panel, key, alpha, beta, gamma, urls } = env;

    // beta gets its own entry (blue), so the tab that closes really did hold a reference of its own.
    const betaKey = await keyOf(panel, urls.beta);
    await swEval(sw, (id) => chrome.tabs.update(id, { active: true }), beta);
    await waitForThumb(panel, betaKey, { timeout: 40_000 });
    await expect.poll(async () => previewVerdict(await imgState(panel, beta), null), { message: 'beta shows its preview' })
      .toBe('ok');

    await closeAndSettle(sw, panel, [beta]);
    await expectSurvivorsKeepPreview(env, {
      key, survivors: [alpha], trigger: alpha, otherId: gamma, step: 'after closing a tab on another URL',
    });
  });

  test('a tab that moves into a group gives its old card\'s reference back once', async ({ harness, serviceWorker }) => {
    test.setTimeout(180_000);
    // Grouping makes render.js build a NEW card for the tab inside the group and unobserve the old
    // one afterwards, so here unobserve is the only release the old card will ever make. A fix that
    // stopped unobserve from releasing cards the module no longer tracks would leak the count and
    // pass every other case in this file.
    const env = await prepare({ harness, serviceWorker });
    const { sw, panel, alpha, w2 } = env;

    await swEval(sw, (a) => chrome.tabs.group({ tabIds: [a.id], createProperties: { windowId: a.windowId } }),
      { id: alpha, windowId: w2 });
    await expect(panel.locator(`.group ${CARD(alpha)}`), 'the tab now has a card inside a group')
      .toHaveCount(1, { timeout: 15_000 });
    await expect(panel.locator(CARD(alpha)), 'and only that one').toHaveCount(1);
    await expectPreview(panel, alpha, { color: 'red', label: 'the grouped card shows its preview' });

    await readArms(panel, { clear: true });
    await closeAndSettle(sw, panel, [alpha]);
    expectReleasedOnce(await readArms(panel), 'closing the only tab on the URL after it was grouped');
  });

  test('the last tab on a URL gives its reference back when the tab goes, not later when its card does', async ({ harness, serviceWorker }) => {
    test.setTimeout(180_000);
    // spec-addendum A9: onTabRemoved(tabId) release()s the tab's key. Every other test in this file reads
    // the grace timers only after the card has left the DOM, i.e. after render.js unobserve()d it, so a
    // build that moved the one release from onTabRemoved to unobserve() would pass all of them. Holding
    // the panel's frames pulls the two moments apart: the tab is gone from the model, its card is still
    // on screen. The release must already have happened at the first moment, and must not repeat at the
    // second.
    const env = await prepare({ harness, serviceWorker });
    const { sw, panel, alpha } = env;

    await installFrameHold(panel);
    await holdFrames(panel);
    await readArms(panel, { clear: true });
    await swEval(sw, (id) => chrome.tabs.remove(id), alpha);
    await expect.poll(
      () => panel.evaluate((id) => !window.__vt.state.tabs.has(id), alpha),
      { message: 'tabs.onRemoved reached the panel model' },
    ).toBe(true);
    await expect(panel.locator(CARD(alpha)), 'the card is still on screen: the render has not run')
      .toHaveCount(1);
    const atEvent = await readArms(panel);
    console.log(`[dup] frames held, tab removed, card still on screen: grace timers armed = ${JSON.stringify(atEvent)}`);
    expectReleasedOnce(atEvent, 'at the removal event, with the card still on screen');

    const waiting = await releaseFrames(panel);
    expect(waiting, 'a render was waiting for the frame').toBeGreaterThan(0);
    await expect(panel.locator(CARD(alpha)), 'the card leaves once the render runs').toHaveCount(0, { timeout: 15_000 });
    const after = await readArms(panel);
    console.log(`[dup] frames released, card gone: grace timers armed in total = ${JSON.stringify(after)}`);
    expectReleasedOnce(after, 'after the card has gone too: still the one release');
  });
});
