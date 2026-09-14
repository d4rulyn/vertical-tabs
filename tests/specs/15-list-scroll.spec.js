// 15-list-scroll — a tab list that is longer than the panel must SCROLL. It must not buy
// the extra room by shrinking its rows, because the only thing a card has to give is the
// preview (user requirement #2), and the compression is silent: the preview box keeps its
// aspect ratio while the card's `overflow: hidden` clips it away to nothing.
//
// Every other spec runs with at most six tabs, which is why nothing caught this. Measured
// at 380x700 before the fix: 13 tabs squeezed a grid card from 101.9 px to 81 px, 28 tabs
// left 0 px of preview visible, and `#tablist.scrollHeight` never once exceeded
// `clientHeight` until 60 tabs in list layout.
'use strict';

const { test, expect } = require('../fixtures');
const {
  swEval, waitForTabsComplete, setSettings, shot,
} = require('../helpers/chrome');
const { extConstant } = require('../helpers/ext-constants');

/** 640 / 240 — the stored thumbnail geometry the CSS `--vt-thumb-aspect` mirrors. */
const THUMB_ASPECT = extConstant('THUMB_W') / extConstant('THUMB_H');

/**
 * Both shapes squeezed, in different ways: several columns via the grid's auto rows,
 * a single column via the flex fallback. Driven by `columns` now that the `layout`
 * enum is retired (spec-addendum A28) — passing `layout` here silently resolved to
 * the default one column instead, which is how this spec started failing.
 */
const COLUMN_COUNTS = [2, 1];

/** `data-layout` is still derived from the count, and it is what the rows key on. */
const layoutName = (columns) => (columns > 1 ? 'grid' : 'list');

/** More than 15, and more than two screenfuls at 380x700 in either layout. */
const TOTAL_TABS = 18;

const PALETTE = ['1b3a5c', '5c1b3a', '3a5c1b', '5c5c1b', '1b5c5c'];
const round2 = (n) => Math.round(n * 100) / 100;

/** Geometry of `#tablist` and of every card in it, read in one pass. */
async function measurePanel(panel) {
  return panel.evaluate(() => {
    const round = (n) => Math.round(n * 100) / 100;
    const list = document.getElementById('tablist');
    const listBox = list.getBoundingClientRect();
    const cards = Array.from(list.querySelectorAll('[data-testid="tab-card"]'));
    const rows = cards.map((card, index) => {
      const cb = card.getBoundingClientRect();
      const thumb = card.querySelector('.thumb');
      const tb = thumb ? thumb.getBoundingClientRect() : null;
      return {
        index,
        tabId: Number(card.getAttribute('data-tab-id')),
        cardH: round(cb.height),
        cardW: round(cb.width),
        thumbW: tb ? round(tb.width) : null,
        thumbH: tb ? round(tb.height) : null,
        // What survives the card's own `overflow: hidden`. This is the symptom: the box
        // still reports its full aspect-ratio height while none of it is on screen.
        thumbShownH: tb
          ? round(Math.max(0, Math.min(tb.bottom, cb.bottom) - Math.max(tb.top, cb.top)))
          : null,
        // `content-visibility: auto` lets Chrome answer with `contain-intrinsic-size` for
        // cards far outside the scrollport, so only the ones overlapping it carry
        // measurements worth asserting on.
        onScreen: cb.bottom > listBox.top && cb.top < listBox.bottom,
      };
    });
    return {
      layout: document.documentElement.dataset.layout || null,
      thumbs: document.documentElement.dataset.thumbs || null,
      cards: rows.length,
      scrollHeight: list.scrollHeight,
      clientHeight: list.clientHeight,
      clientWidth: list.clientWidth,
      rows,
    };
  });
}

/** Resolves after the style and layout produced by the last change have been painted. */
async function afterNextPaint(panel) {
  await panel.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

/** Switches the panel to `columns`, waits for it to settle on `cards` cards, measures. */
async function measureLayout(panel, sw, columns, cards) {
  await setSettings(sw, { widgets: [], columns });
  await panel.waitForFunction((c) => document.documentElement.dataset.columns === String(c),
    columns, { timeout: 15_000 });
  await expect(panel.locator('#tablist [data-testid="tab-card"]'))
    .toHaveCount(cards, { timeout: 30_000 });
  await afterNextPaint(panel);
  return measurePanel(panel);
}

test('a tab list longer than the panel scrolls instead of squeezing the cards',
  async ({ harness, serviceWorker, fixtures }) => {
    test.setTimeout(240_000);
    const { panel, w2 } = harness;

    await setSettings(serviceWorker, {
      refreshInterval: 'off', theme: 'dark', columns: 2, showThumbnails: true,
    });
    // A real side panel is narrow. 380x700 is the shape spec 10 renders the README
    // screenshots at: above Chrome's 360 px minimum and two grid columns wide (A11).
    await panel.setViewportSize({ width: 380, height: 700 });

    // 1 — natural card geometry, measured while the three harness tabs comfortably fit.
    const baseline = {};
    for (const columns of COLUMN_COUNTS) {
      const layout = layoutName(columns);
      const m = await measureLayout(panel, serviceWorker, columns, 3);
      expect(m.thumbs, 'previews must be on for this spec to mean anything').toBe('on');
      expect(m.scrollHeight,
        `the ${layout} baseline must not overflow yet (3 cards)`).toBeLessThanOrEqual(m.clientHeight);
      const first = m.rows[0];
      expect(first.thumbH, `the ${layout} baseline card must have a preview box`).toBeGreaterThan(0);
      baseline[layout] = {
        cardH: first.cardH,
        thumbH: first.thumbH,
        // Everything in a card except the preview: border, padding, the head row and the
        // preview's top margin. None of it depends on the panel's width, so it stays
        // valid once a scrollbar appears and narrows the cards.
        chromeH: round2(first.cardH - first.thumbH),
      };
    }

    // 2 — fill the window until the list cannot possibly fit.
    const urls = Array.from({ length: TOTAL_TABS - 3 }, (_, i) =>
      fixtures.page(PALETTE[i % PALETTE.length], `Tab ${i + 4}`));
    const created = await swEval(serviceWorker, async (a) => {
      const ids = [];
      for (const url of a.urls) {
        const t = await chrome.tabs.create({ windowId: a.wid, url, active: false });
        ids.push(t.id);
      }
      return ids;
    }, { wid: w2, urls });
    expect(created).toHaveLength(TOTAL_TABS - 3);
    await waitForTabsComplete(serviceWorker, created, 60_000);

    // 3 — the same measurements, now with more cards than the panel can show.
    for (const columns of COLUMN_COUNTS) {
      const layout = layoutName(columns);
      const base = baseline[layout];
      const m = await measureLayout(panel, serviceWorker, columns, TOTAL_TABS);
      await shot(panel, `15-list-scroll-${layout}.png`);

      const first = m.rows[0];
      const summary =
        `${layout}: cards=${m.cards} scrollH=${m.scrollHeight} clientH=${m.clientHeight} ` +
        `card0=${first.cardH}px (natural ${round2(base.chromeH + first.thumbH)}px) ` +
        `preview=${first.thumbW}x${first.thumbH} shown=${first.thumbShownH}px`;

      // (a) The list scrolls. A panel that cannot scroll has to make room by shrinking
      //     its rows, and the preview is the only part of a card that can give.
      expect(m.scrollHeight,
        `#tablist must overflow with ${TOTAL_TABS} tabs — ${summary}`).toBeGreaterThan(m.clientHeight);

      const onScreen = m.rows.filter((r) => r.onScreen);
      expect(onScreen.length, `no card is inside the scrollport — ${summary}`).toBeGreaterThan(0);
      expect(onScreen.length,
        `a scrolling list cannot show all ${TOTAL_TABS} cards at once — ${summary}`).toBeLessThan(m.cards);

      for (const row of onScreen) {
        // (b) Each card keeps the height a single card takes on its own.
        expect(row.cardH,
          `card ${row.index} is ${row.cardH}px, natural is ${round2(base.chromeH + row.thumbH)}px — ${summary}`)
          .toBeCloseTo(base.chromeH + row.thumbH, 0);

        // (c) The preview keeps the 8:3 box the stored thumbnails are cropped to …
        expect(row.thumbH,
          `preview ${row.index} is ${row.thumbW}x${row.thumbH}, expected ${THUMB_ASPECT.toFixed(3)}:1 — ${summary}`)
          .toBeCloseTo(row.thumbW / THUMB_ASPECT, 0);
        // … and all of it is on screen, not clipped off by the card's overflow:hidden.
        expect(row.thumbShownH,
          `preview ${row.index} is clipped to ${row.thumbShownH} of ${row.thumbH}px — ${summary}`)
          .toBeCloseTo(row.thumbH, 0);
      }
    }
  });
