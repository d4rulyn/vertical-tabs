// 17-columns — the vertical tab list shows exactly the number of columns the user picked.
//
// The user asked for a configurable column count, "default 1, maximum 5", which overrides
// spec-addendum A11's two-per-row grid default. What has to hold:
//
//   (a) a fresh profile is ONE column — no settings written, nothing to migrate;
//   (b) 1…5 are each honoured when the panel is wide enough for them;
//   (c) a panel too narrow degrades to as many columns as fit at `--vt-card-min` (96 px)
//       instead of producing hair-thin cards or clipping — and never overflows sideways;
//   (d) groups, the group body and pinned-as-cards follow the same count;
//   (e) the list still SCROLLS at every count. That is the blocker 15-list-scroll proved
//       for two layouts; there are five now, so all five are covered here.
'use strict';

const { test, expect } = require('../fixtures');
const {
  swEval, waitForTabsComplete, setSettings, shot,
} = require('../helpers/chrome');

const COUNTS = [1, 2, 3, 4, 5];

/** Mirrors `--vt-card-min` in sidepanel.css: the narrowest card still worth rendering. */
const CARD_MIN = 96;
/** Mirrors `--vt-gap`. */
const GAP = 6;

/** Content width a container needs before `n` columns each clear CARD_MIN. */
const widthFor = (n) => n * CARD_MIN + (n - 1) * GAP;

const PALETTE = ['1b3a5c', '5c1b3a', '3a5c1b', '5c5c1b', '1b5c5c'];

/** Waits for the panel to have applied `columns`, then for the paint that follows. */
async function useColumns(panel, sw, columns) {
  await setSettings(sw, { widgets: [], columns });
  await panel.waitForFunction(
    (c) => document.documentElement.dataset.columns === String(c),
    columns,
    { timeout: 15_000 },
  );
  await panel.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

/** Grid geometry of a container: how many tracks it resolved to, and how wide they are. */
async function tracksOf(panel, selector) {
  return panel.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const tracks = cs.gridTemplateColumns.trim().split(/\s+/).filter(Boolean);
    return {
      display: cs.display,
      count: cs.display === 'grid' ? tracks.length : 0,
      widths: tracks.map((w) => Math.round(parseFloat(w) * 100) / 100),
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
    };
  }, selector);
}

/** Rows the cards actually landed on — the ground truth behind the track count. */
async function cardRows(panel) {
  return panel.evaluate(() => {
    const cards = [...document.querySelectorAll('#tablist .tab-card')]
      .filter((c) => !c.classList.contains('is-hidden'));
    /** @type {Map<number, number>} */
    const byTop = new Map();
    for (const card of cards) {
      const top = Math.round(card.getBoundingClientRect().top);
      byTop.set(top, (byTop.get(top) || 0) + 1);
    }
    return {
      cards: cards.length,
      widest: cards.length ? Math.max(...cards.map((c) => c.getBoundingClientRect().width)) : 0,
      narrowest: cards.length ? Math.min(...cards.map((c) => c.getBoundingClientRect().width)) : 0,
      perRow: [...byTop.values()],
    };
  });
}

test('the column count the user picks is the column count the panel shows',
  async ({ harness, serviceWorker }) => {
    test.setTimeout(180_000);
    const { panel } = harness;
    await setSettings(serviceWorker, { refreshInterval: 'off', theme: 'dark' });

    // Wide enough that even five columns each clear `--vt-card-min` comfortably.
    await panel.setViewportSize({ width: 760, height: 900 });

    for (const columns of COUNTS) {
      await useColumns(panel, serviceWorker, columns);
      const list = await tracksOf(panel, '#tablist');
      const rows = await cardRows(panel);
      const summary = `columns=${columns} tracks=${list.count} [${list.widths.join(', ')}] `
        + `cards=${rows.cards} perRow=${rows.perRow.join('/')}`;

      expect(list.count, `#tablist must resolve to ${columns} tracks — ${summary}`).toBe(columns);
      // The tracks are equal and use the whole row: no stray leftover column.
      expect(Math.max(...list.widths) - Math.min(...list.widths),
        `tracks must be equal — ${summary}`).toBeLessThanOrEqual(1);
      expect(list.scrollWidth,
        `the list must never scroll sideways — ${summary}`).toBeLessThanOrEqual(list.clientWidth);
      // Three fixture tabs: with 1 column they stack, with 3+ they share one row.
      expect(Math.max(...rows.perRow),
        `no row may hold more than ${columns} cards — ${summary}`).toBeLessThanOrEqual(columns);
      // …and with three fixture tabs a count of 3+ has to put them all on one row.
      expect(rows.perRow[0],
        `${Math.min(columns, rows.cards)} cards belong on the first row — ${summary}`)
        .toBe(Math.min(columns, rows.cards));
      await shot(panel, `17-columns-${columns}.png`);
    }
  });

test('a fresh profile shows one column, and an old `layout` setting migrates onto a count',
  async ({ harness, serviceWorker }) => {
    test.setTimeout(120_000);
    const { panel } = harness;
    await panel.setViewportSize({ width: 380, height: 900 });

    // Nothing has ever written settings in this profile, so this is the real default.
    await expect(panel.locator('html')).toHaveAttribute('data-columns', '1');
    await expect(panel.locator('html')).toHaveAttribute('data-layout', 'list');
    expect((await tracksOf(panel, '#tablist')).count).toBe(1);
    await shot(panel, '17-columns-default-one.png');

    // A profile upgraded from the version that stored `layout` must not break: the old
    // three-way enum maps onto a column count in normalizeSettings.
    for (const [layout, columns] of [['grid', '2'], ['auto', '2'], ['list', '1']]) {
      await swEval(serviceWorker, async (value) => {
        // Written the way the previous version stored it — no `columns` key at all.
        await chrome.storage.local.set({
          settings: { version: 1, theme: 'dark', layout: value, showThumbnails: true },
        });
      }, layout);
      await expect(panel.locator('html'))
        .toHaveAttribute('data-columns', columns, { timeout: 10_000 });
    }
  });

test('a panel too narrow for the chosen count drops columns instead of thinning cards',
  async ({ harness, serviceWorker }) => {
    test.setTimeout(180_000);
    const { panel } = harness;
    await setSettings(serviceWorker, { refreshInterval: 'off', theme: 'dark' });

    // Chrome's minimum side-panel width. 5 columns cannot fit here; the panel must
    // pick the largest count that keeps every card at or above `--vt-card-min`.
    await panel.setViewportSize({ width: 360, height: 900 });
    await useColumns(panel, serviceWorker, 5);

    const list = await tracksOf(panel, '#tablist');
    const rows = await cardRows(panel);
    const summary = `content=${list.clientWidth}px tracks=${list.count} `
      + `[${list.widths.join(', ')}] narrowest card=${rows.narrowest}px`;

    // The setting is still 5 — only the rendering degraded.
    await expect(panel.locator('html')).toHaveAttribute('data-columns', '5');

    expect(list.count, `5 columns cannot fit in ${list.clientWidth}px — ${summary}`).toBeLessThan(5);
    expect(list.count, `at least one column must always render — ${summary}`).toBeGreaterThanOrEqual(1);
    // Exactly the count the documented rule predicts: as many CARD_MIN cards as fit.
    const expected = Math.floor((list.clientWidth + GAP) / (CARD_MIN + GAP));
    expect(list.count, `expected floor((${list.clientWidth} + ${GAP}) / ${CARD_MIN + GAP}) — ${summary}`)
      .toBe(expected);
    expect(rows.narrowest,
      `no card may be thinner than --vt-card-min (${CARD_MIN}px) — ${summary}`)
      .toBeGreaterThanOrEqual(CARD_MIN);
    expect(list.scrollWidth,
      `degrading must not clip or overflow — ${summary}`).toBeLessThanOrEqual(list.clientWidth);
    await shot(panel, '17-columns-degraded.png');

    // Widening the panel brings the chosen count back without touching the setting.
    await panel.setViewportSize({ width: widthFor(5) + 80, height: 900 });
    await expect.poll(async () => (await tracksOf(panel, '#tablist')).count, { timeout: 10_000 })
      .toBe(5);
    await shot(panel, '17-columns-five-wide.png');
  });

test('groups, the group body and pinned-as-cards follow the same column count',
  async ({ harness, serviceWorker }) => {
    test.setTimeout(180_000);
    const { panel, tabIds } = harness;
    await setSettings(serviceWorker, { refreshInterval: 'off', theme: 'dark' });
    await panel.setViewportSize({ width: 760, height: 900 });

    // Beta + Gamma in a group, Alpha pinned and rendered inline as a card.
    await swEval(serviceWorker, async (ids) => {
      await chrome.tabs.group({ tabIds: [ids.beta, ids.gamma] });
      await chrome.tabs.update(ids.alpha, { pinned: true });
    }, tabIds);
    await setSettings(serviceWorker, { pinnedGrid: false });
    await expect(panel.locator('[data-testid="group"]')).toHaveCount(1, { timeout: 15_000 });
    await expect(panel.locator(`#tablist [data-tab-id="${tabIds.alpha}"]`))
      .toHaveCount(1, { timeout: 15_000 });

    for (const columns of COUNTS) {
      await useColumns(panel, serviceWorker, columns);
      const body = await tracksOf(panel, '.group-body');
      expect(body, 'the group body must exist').not.toBeNull();
      expect(body.count, `.group-body must render ${columns} tracks, got ${body.count}`).toBe(columns);

      // The group section itself is a row-spanning container, never one card wide.
      const spans = await panel.evaluate(() => {
        const group = document.querySelector('#tablist .group');
        const list = document.getElementById('tablist');
        if (!group || !list) return null;
        const g = group.getBoundingClientRect();
        const l = list.getBoundingClientRect();
        const cs = getComputedStyle(list);
        return {
          groupW: Math.round(g.width),
          listInner: Math.round(l.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)),
        };
      });
      expect(spans.groupW, `the group must span the full row at ${columns} columns`)
        .toBeGreaterThanOrEqual(spans.listInner - 2);

      // The pinned tab renders as a card in #tablist and therefore sits in the same grid.
      const list = await tracksOf(panel, '#tablist');
      expect(list.count, `#tablist must render ${columns} tracks, got ${list.count}`).toBe(columns);
      const pinnedInGrid = await panel.evaluate((id) => {
        const card = document.querySelector(`#tablist > .tab-card[data-tab-id="${id}"]`);
        const host = document.getElementById('tablist');
        if (!card || !host) return null;
        return {
          parentIsList: card.parentElement === host,
          width: Math.round(card.getBoundingClientRect().width * 100) / 100,
        };
      }, tabIds.alpha);
      expect(pinnedInGrid, 'the pinned card must be a direct child of #tablist').not.toBeNull();
      expect(pinnedInGrid.parentIsList).toBe(true);
      // It occupies exactly one of the list's tracks, like any other card.
      expect(Math.abs(pinnedInGrid.width - list.widths[0]),
        `pinned card ${pinnedInGrid.width}px vs track ${list.widths[0]}px at ${columns} columns`)
        .toBeLessThanOrEqual(1);
    }
    await shot(panel, '17-columns-groups.png');
  });

test('the list still scrolls instead of squeezing its cards at every column count',
  async ({ harness, serviceWorker, fixtures }) => {
    test.setTimeout(300_000);
    const { panel, w2 } = harness;
    await setSettings(serviceWorker, { refreshInterval: 'off', theme: 'dark', showThumbnails: true });
    // The same shape 15-list-scroll uses, where the regression was originally measured.
    await panel.setViewportSize({ width: 380, height: 700 });

    // 5 columns × more than two screenfuls of rows.
    const extra = 27;
    const urls = Array.from({ length: extra }, (_, i) =>
      fixtures.page(PALETTE[i % PALETTE.length], `Tab ${i + 4}`));
    const created = await swEval(serviceWorker, async (a) => {
      const ids = [];
      for (const url of a.urls) {
        const t = await chrome.tabs.create({ windowId: a.wid, url, active: false });
        ids.push(t.id);
      }
      return ids;
    }, { wid: w2, urls });
    await waitForTabsComplete(serviceWorker, created, 90_000);

    const total = extra + 3;
    for (const columns of COUNTS) {
      await useColumns(panel, serviceWorker, columns);
      await expect(panel.locator('#tablist .tab-card')).toHaveCount(total, { timeout: 30_000 });

      const m = await panel.evaluate(() => {
        const round = (n) => Math.round(n * 100) / 100;
        const list = document.getElementById('tablist');
        const listBox = list.getBoundingClientRect();
        const rows = [...list.querySelectorAll('.tab-card')].map((card) => {
          const cb = card.getBoundingClientRect();
          const thumb = card.querySelector('.thumb');
          const tb = thumb ? thumb.getBoundingClientRect() : null;
          return {
            cardH: round(cb.height),
            thumbH: tb ? round(tb.height) : 0,
            thumbW: tb ? round(tb.width) : 0,
            // What survives the card's own overflow:hidden — the squeeze symptom.
            shownH: tb ? round(Math.max(0, Math.min(tb.bottom, cb.bottom) - Math.max(tb.top, cb.top))) : 0,
            onScreen: cb.bottom > listBox.top && cb.top < listBox.bottom,
          };
        });
        return {
          scrollHeight: list.scrollHeight,
          clientHeight: list.clientHeight,
          rows: rows.filter((r) => r.onScreen),
          allRows: rows.length,
        };
      });
      const summary = `columns=${columns} scrollH=${m.scrollHeight} clientH=${m.clientHeight} `
        + `onScreen=${m.rows.length}/${m.allRows}`;

      expect(m.scrollHeight,
        `#tablist must overflow with ${total} tabs — ${summary}`).toBeGreaterThan(m.clientHeight);
      expect(m.rows.length, `some card must be inside the scrollport — ${summary}`).toBeGreaterThan(0);
      expect(m.rows.length,
        `a scrolling list cannot show all ${total} cards at once — ${summary}`).toBeLessThan(m.allRows);

      for (const [i, row] of m.rows.entries()) {
        // The preview keeps its 8:3 box and none of it is clipped away.
        expect(row.thumbH, `preview ${i} collapsed to ${row.thumbH}px — ${summary}`).toBeGreaterThan(0);
        expect(row.shownH,
          `preview ${i} is clipped to ${row.shownH} of ${row.thumbH}px — ${summary}`)
          .toBeCloseTo(row.thumbH, 0);
      }
      await shot(panel, `17-columns-scroll-${columns}.png`);
    }
  });
