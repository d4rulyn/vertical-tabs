// 06-dnd — drag and drop. Uses real HTML5 drag events driven by the mouse, because
// that is what the panel listens to; the external-URL drop is dispatched
// synthetically because Playwright cannot originate a drag outside the page.
'use strict';

const { test, expect } = require('../fixtures');
const { swEval, queryTabs, cardOrder, setSettings } = require('../helpers/chrome');

/** A slow, multi-step HTML5 drag so dragenter/dragover counters see every phase. */
async function dragTo(panel, sourceSel, targetSel, targetPosition) {
  const src = panel.locator(sourceSel);
  const dst = panel.locator(targetSel);
  // Both ends have to be on screen before either box is measured: the pointer is
  // driven in viewport coordinates, so a target below the fold would be aimed at
  // from outside the viewport and the drop would never land on it.
  await dst.scrollIntoViewIfNeeded();
  await src.scrollIntoViewIfNeeded();
  const sb = await src.boundingBox();
  const db = await dst.boundingBox();
  if (!sb || !db) throw new Error(`drag needs visible elements: ${sourceSel} -> ${targetSel}`);

  const sx = sb.x + sb.width / 2;
  const sy = sb.y + sb.height / 2;
  const tx = db.x + (targetPosition ? targetPosition.x : db.width / 2);
  const ty = db.y + (targetPosition ? targetPosition.y : db.height / 2);

  await panel.mouse.move(sx, sy);
  await panel.mouse.down();
  await panel.mouse.move(sx + 6, sy + 6, { steps: 4 });
  await panel.mouse.move(tx, ty, { steps: 16 });
  await panel.waitForTimeout(120);
  await panel.mouse.move(tx, ty, { steps: 2 });
  await panel.waitForTimeout(120);
  await panel.mouse.up();
  await panel.waitForTimeout(200);
}

async function indexOfTab(sw, windowId, tabId) {
  const tabs = await queryTabs(sw, windowId);
  return tabs.findIndex((t) => t.id === tabId);
}

/**
 * The point inside a card that means "insert AFTER this card".
 *
 * spec.md §9.2 splits a card differently per layout:
 *   "list layout: before = pointerY < hovered.midY ; grid layout: before = pointerX < hovered.midX"
 * so "after" is the LOWER half in a list but the RIGHT half in a grid.
 *
 * spec.md §13's table spells the drop as `targetPosition:{ x:10, y: cardHeight-4 }`,
 * which is the list-layout "after".
 *
 * `display` is no longer the discriminator it was under spec-addendum A11: `#tablist`
 * is now a grid at EVERY column count, so a single column is a grid with one track.
 * What decides the axis is the number of tracks, which is exactly the measurement
 * `dnd.js` `effectiveColumns()` makes — one column splits a card above/below, two or
 * more split it left/right. Mirror that here so the drop keeps meaning what §13 says.
 */
async function afterCardPosition(panel, selector) {
  const box = await panel.locator(selector).boundingBox();
  if (!box) throw new Error(`no bounding box for ${selector}`);
  const multiColumn = await panel.evaluate(() => {
    const list = document.getElementById('tablist');
    if (!list) return false;
    const style = getComputedStyle(list);
    if (style.display !== 'grid' && style.display !== 'inline-grid') return false;
    return String(style.gridTemplateColumns || '').trim().split(/\s+/).filter(Boolean).length > 1;
  });
  // Several columns decide on X and a single column on Y, but the point is kept in
  // the "after" half of BOTH axes: if the layout were ever misdetected, the drop
  // still means "after" rather than landing on an ambiguous midpoint.
  return multiColumn
    ? { x: box.width - 4, y: box.height - 4 } // right half → after
    : { x: 10, y: box.height - 4 }; // lower half → after
}

/**
 * A side-panel-sized viewport for every test in this file.
 *
 * The default harness viewport is 1280 px wide, which is not a side panel. With the
 * default single column (`DEFAULTS.columns`) one card spans the whole 1264 px content
 * box and, keeping the preview's aspect ratio, stands 509 px tall — so three cards
 * need 1554 px inside a 719 px list and the third sits entirely below the fold, where
 * a pointer-driven drag cannot reach it. Chrome's side panel is 360 px at its
 * narrowest and a few hundred px at its widest (README, "Known limitations"); at
 * 400 px the same card is ~178 px tall and all three are visible at once, which is
 * the geometry these drops are actually about.
 */
const PANEL_VIEWPORT = Object.freeze({ width: 400, height: 900 });

test.beforeEach(async ({ harness }) => {
  await harness.panel.setViewportSize(PANEL_VIEWPORT);
  // Let the grid re-resolve its tracks before anything measures a card.
  await harness.panel.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
});

test('dragging a card past another reorders the tab strip', async ({ harness, serviceWorker }) => {
  const { panel, w2, tabIds } = harness;
  expect(await cardOrder(panel)).toEqual([tabIds.alpha, tabIds.beta, tabIds.gamma]);

  await dragTo(panel,
    `[data-tab-id="${tabIds.alpha}"]`,
    `[data-tab-id="${tabIds.gamma}"]`,
    await afterCardPosition(panel, `[data-tab-id="${tabIds.gamma}"]`)); // insert after Gamma

  await expect.poll(() => indexOfTab(serviceWorker, w2, tabIds.alpha), { timeout: 15_000 }).toBe(2);
  const tabs = await queryTabs(serviceWorker, w2);
  expect(tabs.map((t) => t.id)).toEqual([tabIds.beta, tabIds.gamma, tabIds.alpha]);
  expect(await cardOrder(panel)).toEqual(tabs.map((t) => t.id));
});

test('a multi-column list drops on the horizontal split, not the vertical one', async ({
  harness, serviceWorker,
}) => {
  // Every other drag test here runs at the default single column, where "after"
  // means the LOWER half of a card. With two or more columns the split turns
  // horizontal, and that branch had no browser-level coverage once the viewport
  // was pinned to a side-panel width — only dnd-math's unit tests exercised it.
  const { panel, w2, tabIds } = harness;
  await setSettings(serviceWorker, { widgets: [], columns: 3 });
  await expect(panel.locator('html')).toHaveAttribute('data-columns', '3', { timeout: 10_000 });
  await panel.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));

  const tracks = await panel.evaluate(
    () => getComputedStyle(document.getElementById('tablist')).gridTemplateColumns.split(' ').length,
  );
  expect(tracks).toBe(3); // otherwise the assertion below would prove nothing

  const box = await panel.locator(`[data-tab-id="${tabIds.gamma}"]`).boundingBox();
  expect(box).not.toBeNull();

  // The LOWER half of Gamma, which is "after" in a single column. With three
  // columns the pointer is on Gamma's LEFT half, so this must mean "before".
  await dragTo(panel,
    `[data-tab-id="${tabIds.alpha}"]`,
    `[data-tab-id="${tabIds.gamma}"]`,
    { x: 6, y: box.height - 4 });

  await expect.poll(() => indexOfTab(serviceWorker, w2, tabIds.alpha), { timeout: 15_000 }).toBe(1);
  const tabs = await queryTabs(serviceWorker, w2);
  expect(tabs.map((t) => t.id)).toEqual([tabIds.beta, tabIds.alpha, tabIds.gamma]);
});

test('dropping a card on the pinned grid pins it', async ({ harness, serviceWorker }) => {
  const { panel, w2, tabIds } = harness;

  // #pinned is hidden while nothing is pinned, so seed it through the API first.
  await swEval(serviceWorker, (id) => chrome.tabs.update(id, { pinned: true }), tabIds.alpha);
  await expect(panel.locator('#pinned')).toBeVisible({ timeout: 10_000 });

  await dragTo(panel, `[data-tab-id="${tabIds.gamma}"]`, '#pinned', { x: 8, y: 8 });

  await expect.poll(async () => {
    const t = (await queryTabs(serviceWorker, w2)).find((x) => x.id === tabIds.gamma);
    return t ? t.pinned : null;
  }, { timeout: 15_000 }).toBe(true);
  await expect(panel.locator(`#pinned [data-tab-id="${tabIds.gamma}"]`)).toHaveCount(1);
});

test('dropping into a group joins it, dropping below it leaves', async ({ harness, serviceWorker }) => {
  const { panel, w2, tabIds } = harness;

  const groupId = await swEval(serviceWorker, async (a) =>
    chrome.tabs.group({ tabIds: [a.beta], createProperties: { windowId: a.wid } }),
  { beta: tabIds.beta, wid: w2 });
  expect(groupId).toBeGreaterThan(-1);
  await expect(panel.locator(`[data-testid="group"][data-group-id="${groupId}"]`))
    .toHaveCount(1, { timeout: 10_000 });

  // ── into the group body
  await dragTo(panel,
    `[data-tab-id="${tabIds.alpha}"]`,
    `[data-testid="group"][data-group-id="${groupId}"] .group-body`,
    { x: 12, y: 8 });

  await expect.poll(async () => {
    const t = (await queryTabs(serviceWorker, w2)).find((x) => x.id === tabIds.alpha);
    return t ? t.groupId : null;
  }, { timeout: 15_000 }).toBe(groupId);

  // ── back out: drop outside the group, past the last free card
  await dragTo(panel,
    `[data-tab-id="${tabIds.alpha}"]`,
    `[data-tab-id="${tabIds.gamma}"]`,
    await afterCardPosition(panel, `[data-tab-id="${tabIds.gamma}"]`));

  await expect.poll(async () => {
    const t = (await queryTabs(serviceWorker, w2)).find((x) => x.id === tabIds.alpha);
    return t ? t.groupId : null;
  }, { timeout: 15_000 }).toBe(-1);
});

test('dragging a group header moves the whole group', async ({ harness, serviceWorker }) => {
  const { panel, w2, tabIds } = harness;

  const groupId = await swEval(serviceWorker, async (a) =>
    chrome.tabs.group({ tabIds: [a.alpha], createProperties: { windowId: a.wid } }),
  { alpha: tabIds.alpha, wid: w2 });
  await expect(panel.locator(`[data-testid="group-header"]`)).toHaveCount(1, { timeout: 10_000 });
  expect(await indexOfTab(serviceWorker, w2, tabIds.alpha)).toBe(0);

  await dragTo(panel,
    `[data-testid="group"][data-group-id="${groupId}"] [data-testid="group-header"]`,
    `[data-tab-id="${tabIds.gamma}"]`,
    await afterCardPosition(panel, `[data-tab-id="${tabIds.gamma}"]`)); // insert after Gamma

  await expect.poll(() => indexOfTab(serviceWorker, w2, tabIds.alpha), { timeout: 15_000 }).toBe(2);
  const tabs = await queryTabs(serviceWorker, w2);
  expect(tabs.find((t) => t.id === tabIds.alpha).groupId).toBe(groupId);
});

test('dropping an external link creates a background tab at that position',
  async ({ harness, serviceWorker, fixtures }) => {
    const { panel, w2, tabIds } = harness;
    const url = fixtures.page('00ffff', 'Dropped');
    const before = await queryTabs(serviceWorker, w2);

    await panel.evaluate(({ sel, href }) => {
      const target = document.querySelector(sel);
      const rect = target.getBoundingClientRect();
      const dt = new DataTransfer();
      dt.setData('text/uri-list', href);
      dt.setData('text/plain', href);
      const init = {
        bubbles: true, cancelable: true, composed: true, dataTransfer: dt,
        clientX: rect.left + 10, clientY: rect.top + 4,
      };
      target.dispatchEvent(new DragEvent('dragenter', init));
      target.dispatchEvent(new DragEvent('dragover', init));
      target.dispatchEvent(new DragEvent('drop', init));
    }, { sel: `[data-tab-id="${tabIds.beta}"]`, href: url });

    await expect.poll(async () => (await queryTabs(serviceWorker, w2)).length, { timeout: 15_000 })
      .toBe(before.length + 1);

    const after = await queryTabs(serviceWorker, w2);
    const dropped = after.find((t) => !before.some((b) => b.id === t.id));
    expect(dropped).toBeTruthy();
    expect(dropped.url).toBe(url);
    expect(dropped.active).toBe(false);
    // Dropped on the upper half of Beta → inserted before Beta.
    expect(dropped.index).toBeLessThanOrEqual(after.find((t) => t.id === tabIds.beta).index);
  });
