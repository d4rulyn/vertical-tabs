// 21-popout — the tab list can be detached into a window of its own.
//
// Chrome pins the side panel's minimum inner width at 360 px and gives extensions no way
// to change it (verified: setOptions rejects `width`, and a Chrome engineer has confirmed
// on chromium-extensions that the floor is not exposed). A window this extension creates
// itself has no such floor, so detaching is the only route to a genuinely narrow strip.
'use strict';

const { test, expect } = require('../fixtures');
const { swEval, waitForCard, sleep } = require('../helpers/chrome');
const { extConstant } = require('../helpers/ext-constants');

const POPOUT_WIDTH = extConstant('POPOUT_WIDTH');

/** The popup window this extension opened, if any. */
function popoutWindows(sw) {
  return swEval(sw, async () => {
    const wins = await chrome.windows.getAll({ populate: true });
    return wins
      .filter((w) => w.type === 'popup'
        && (w.tabs || []).some((t) => (t.url || '').includes('popout=1')))
      .map((w) => ({ id: w.id, width: w.width, url: w.tabs[0].url }));
  });
}

test('the pop-out button opens one narrow window that lists the same tabs',
  async ({ context, harness, serviceWorker }) => {
    test.setTimeout(180_000);
    const { panel, w2, tabIds } = harness;

    expect(await popoutWindows(serviceWorker), 'none to begin with').toEqual([]);

    const opened = context.waitForEvent('page', { timeout: 20_000 });
    await panel.locator('[data-testid="popout-button"]').click();
    const detached = await opened;
    await detached.waitForLoadState('domcontentloaded');

    // It is our panel document, marked as detached and scoped to the ORIGINAL window.
    expect(detached.url()).toContain('popout=1');
    expect(detached.url()).toContain(`windowId=${w2}`);
    await expect(detached.locator('html')).toHaveAttribute('data-popout', '1');

    // Same tabs as the docked panel — it follows the window it was opened for, not
    // the popup it now lives in.
    for (const id of [tabIds.alpha, tabIds.beta, tabIds.gamma]) {
      await waitForCard(detached, id);
    }
    await expect(detached.locator('[data-testid="tab-card"]')).toHaveCount(3);

    // A real popup window, narrower than Chrome's 360 px side panel floor.
    const wins = await popoutWindows(serviceWorker);
    expect(wins.length, 'exactly one window').toBe(1);
    expect(POPOUT_WIDTH, 'the point of detaching').toBeLessThan(360);

    // The detached copy does not offer to detach itself again.
    await expect(detached.locator('[data-testid="popout-button"]')).toBeHidden();

    // Clicking again focuses the window it already opened rather than piling up copies.
    await panel.locator('[data-testid="popout-button"]').click();
    await sleep(1500);
    expect((await popoutWindows(serviceWorker)).length, 'still exactly one').toBe(1);

    // It drives the real window: activating a tab from the detached copy switches it.
    await detached.locator(`[data-tab-id="${tabIds.gamma}"]`).click();
    await expect.poll(() => swEval(serviceWorker,
      (w) => chrome.tabs.query({ active: true, windowId: w }).then((t) => t[0].id), w2),
    { timeout: 15_000 }).toBe(tabIds.gamma);
  });
