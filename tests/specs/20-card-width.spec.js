// 20-card-width — the card size is the only handle an extension has on the strip.
//
// Chrome fixes the side panel's own width: `setOptions({width})` is rejected with
// "Unexpected property: 'width'", `getLayout()` reports only the side, and the minimum
// inner width is hard-coded at 360 px (raised from 320; confirmed on chromium-extensions
// that extensions cannot change it and no flag exists). So `settings.cardWidth` sizes the
// CARDS, and the row is packed with as many of them as fit rather than leaving a gutter —
// a narrow card in a wide panel used to mean one column beside a large empty margin.
'use strict';

const { test, expect } = require('../fixtures');
const { setSettings, sleep } = require('../helpers/chrome');

/** Chrome's real floor, which is the case that matters most here. */
const MIN_PANEL = { width: 360, height: 900 };

function measure(panel) {
  return panel.evaluate(() => {
    const list = document.getElementById('tablist');
    const cards = [...list.querySelectorAll('[data-testid="tab-card"]')];
    const style = getComputedStyle(list);
    const pad = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const tracks = style.gridTemplateColumns.split(' ').filter(Boolean);
    return {
      attr: document.documentElement.dataset.cardWidth,
      tracks: tracks.length,
      trackPx: tracks.map((t) => Math.round(parseFloat(t))),
      cardWidth: cards.length ? Math.round(cards[0].getBoundingClientRect().width) : null,
      contentWidth: Math.round(list.clientWidth - pad),
      overflowsSideways: list.scrollWidth > list.clientWidth + 1,
    };
  });
}

async function apply(panel, sw, settings) {
  await setSettings(sw, settings);
  if (settings.cardWidth !== undefined) {
    await panel.waitForFunction((w) => document.documentElement.dataset.cardWidth === String(w),
      settings.cardWidth, { timeout: 10_000 });
  }
  await panel.evaluate(() => new Promise((r) => {
    requestAnimationFrame(() => requestAnimationFrame(() => r()));
  }));
  return measure(panel);
}

test('a chosen card size fills the panel instead of leaving a gutter',
  async ({ harness, serviceWorker }) => {
    test.setTimeout(180_000);
    const { panel } = harness;
    await panel.setViewportSize(MIN_PANEL);
    await setSettings(serviceWorker, { widgets: [], refreshInterval: 'off', columns: 1 });

    const filled = await apply(panel, serviceWorker, { cardWidth: 0 });
    expect(filled.tracks, 'fill honours the column count').toBe(1);
    const full = filled.contentWidth;
    expect(filled.cardWidth, `one card spans the content box (${full})`)
      .toBeGreaterThanOrEqual(full - 2);

    // 160 px in Chrome's minimum panel is the density a vertical tab strip is usually
    // drawn at: two columns, no gutter.
    const small = await apply(panel, serviceWorker, { cardWidth: 160 });
    expect(small.tracks, 'two cards of that size fit').toBe(2);
    expect(small.cardWidth, `card near the chosen size (got ${small.cardWidth})`)
      .toBeGreaterThanOrEqual(160);
    expect(small.cardWidth).toBeLessThan(full - 60);
    // The row is closed: the tracks plus their gap account for the whole content box.
    const spanned = small.trackPx.reduce((a, b) => a + b, 0);
    expect(spanned, `tracks span the content box (${small.trackPx.join('+')} vs ${full})`)
      .toBeGreaterThanOrEqual(full - 12);
    expect(small.overflowsSideways).toBe(false);

    // A size the panel cannot fit twice falls back to one column rather than overflowing.
    const wide = await apply(panel, serviceWorker, { cardWidth: 320 });
    expect(wide.tracks).toBe(1);
    expect(wide.overflowsSideways).toBe(false);

    // More room, same size: more columns, still no gutter.
    await panel.setViewportSize({ width: 720, height: 900 });
    const roomy = await apply(panel, serviceWorker, { cardWidth: 160 });
    expect(roomy.tracks, 'a wider panel packs more of the same card').toBeGreaterThan(2);
    expect(roomy.overflowsSideways).toBe(false);
    const roomySpan = roomy.trackPx.reduce((a, b) => a + b, 0);
    expect(roomySpan).toBeGreaterThanOrEqual(roomy.contentWidth - 24);

    // Back to fill: the column count is in charge again.
    const back = await apply(panel, serviceWorker, { cardWidth: 0, columns: 2 });
    expect(back.tracks).toBe(2);
  });

test('an unrecognised stored size falls back instead of rendering a broken strip',
  async ({ harness, serviceWorker }) => {
    test.setTimeout(120_000);
    const { panel } = harness;
    await setSettings(serviceWorker, { cardWidth: 9999 });
    await sleep(500);
    const m = await measure(panel);
    expect(m.attr, 'an off-list size normalises to the default').toBe('0');
    expect(m.overflowsSideways).toBe(false);
  });
