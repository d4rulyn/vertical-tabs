// 39-bookmark-preview — hovering a bookmark shows the screenshot of its page, and it is
// the SAME screenshot the tab card shows.
//
// WHAT "THE SAME" MEANS HERE. A tab card's picture and a bookmark's picture are both
// the record `common/thumb-store.js` holds under `urlKey(url)`. So the check is on
// BYTES: the SHA-256 of what the preview <img> is showing equals the SHA-256 of what the
// open tab's card is showing for the same URL (and, for a page that is not open at all,
// the SHA-256 of the stored record). A colour check would pass for a different
// screenshot of the same page.
//
// WHAT THIS FILE DOES NOT TEST, said plainly:
//   * A real incognito window. The extension cannot be allowed in incognito headlessly,
//     so the incognito verdict is exercised by telling `thumbs.js` that the hosting window
//     is incognito through the same `isIncognitoWindow` seam its own probe reads. That
//     proves `peekUrl` obeys the flag and ranks it above a stored record; it does not
//     prove that Chrome reports the flag for a real private window.
//   * The act of granting `bookmarks` (see the banner in 32-bookmarks-rail.spec.js): every
//     test here runs against the synthesised-grant copy of the extension.
//
// Every `granted(...)` test starts from a fresh profile with a two-window harness: the
// panel as a page in W1, driving the three fixture tabs of W2.
'use strict';

const fs = require('fs');
const path = require('path');
const { expect, launchExtensionContext } = require('../fixtures');
const {
  setSettings, keyOf, waitForThumb, activateTab, swEval,
} = require('../helpers/chrome');
const { granted } = require('../helpers/bookmarks');
const P = require('../helpers/bookmark-preview');

const LOCALES = path.resolve(__dirname, '../../extension/_locales');
/** A message exactly as the locale file spells it. */
function message(locale, key) {
  const table = JSON.parse(fs.readFileSync(path.join(LOCALES, locale, 'messages.json'), 'utf8'));
  return table[key].message;
}

const {
  openColumn, moveAway, hoverAndWait, imgsWithSrc,
} = P;

granted('the preview is the very image the tab card shows, byte for byte', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel, tabIds, urls } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });

  // A real capture of an open tab, by the service worker's own pipeline.
  const alphaKey = await keyOf(panel, urls.alpha);
  await activateTab(serviceWorker, tabIds.alpha);
  await waitForThumb(panel, alphaKey, { timeout: 40_000 });
  const cardThumb = panel.locator(`${P.CARD(tabIds.alpha)} .thumb`);
  await expect(cardThumb).toHaveClass(/thumb--loaded/, { timeout: 15_000 });
  await expect.poll(
    () => panel.locator(`${P.CARD(tabIds.alpha)} .thumb__img`)
      .evaluate((el) => el.complete && el.naturalWidth),
    { timeout: 15_000 },
  ).toBe(640);
  const cardHash = await P.sha256OfImg(panel, `${P.CARD(tabIds.alpha)} .thumb__img`);
  expect(cardHash, 'the tab card is showing a real picture').toMatch(/^[0-9a-f]{64}$/);

  await openColumn(harness, serviceWorker, [
    { title: 'Alpha, open', url: urls.alpha },
    { title: 'Never seen', url: 'https://nowhere.example.com/x' },
  ]);
  await P.installMonitor(panel);

  const row = P.linkRow(panel, 'Alpha, open');
  expect(await row.getAttribute('title'), 'before the hover the row has its native tooltip')
    .toContain('Alpha, open');

  await row.hover();
  const peek = panel.locator(P.PEEK);
  await expect(peek).toBeVisible({ timeout: 15_000 });
  await expect(peek).toHaveAttribute('data-state', 'loaded');

  const img = panel.locator(`${P.PEEK} ${P.PEEK_IMG}`);
  await expect(img).toBeVisible();
  await expect.poll(
    () => img.evaluate((el) => ({
      blob: (el.currentSrc || el.getAttribute('src') || '').startsWith('blob:'),
      complete: el.complete,
      size: `${el.naturalWidth}x${el.naturalHeight}`,
    })),
    { timeout: 15_000 },
  ).toEqual({ blob: true, complete: true, size: '640x240' });

  // THE claim: the bytes under the preview are the bytes under the tab card.
  expect(await P.sha256OfImg(panel, `${P.PEEK} ${P.PEEK_IMG}`),
    'the preview shows the tab card\'s own screenshot').toBe(cardHash);

  // What else the card says: the bookmark's title and where it lives.
  await expect(panel.locator(`${P.PEEK} ${P.PEEK_TITLE}`)).toHaveText('Alpha, open');
  const host = new URL(urls.alpha).host;
  await expect(panel.locator(`${P.PEEK} ${P.PEEK_HOST}`)).toHaveText(host);
  await expect(panel.locator(`${P.PEEK} ${P.PEEK_HINT}`), 'a real picture needs no apology')
    .toHaveCount(0);

  // The card carries the row's tooltip, so the native one is out of the way while it is up.
  expect(await row.getAttribute('title'), 'no native tooltip on top of the card').toBeNull();

  // It is not a tab card, and nothing in it looks like one to the rest of the panel.
  const impostor = await panel.evaluate((sel) => {
    const card = document.querySelector(sel);
    return {
      inside: card.querySelectorAll('.thumb, .thumb__img, [data-tab-id], [data-testid="thumb-img"]').length,
      ownAttr: card.hasAttribute('data-tab-id'),
      offenders: [...document.querySelectorAll('[data-tab-id]')]
        .filter((el) => !el.matches('.tab-card, .pinned-tile')).length,
      parent: card.parentElement && card.parentElement.tagName,
      ariaHidden: card.getAttribute('aria-hidden'),
    };
  }, P.PEEK);
  expect(impostor).toEqual({ inside: 0, ownAttr: false, offenders: 0, parent: 'BODY', ariaHidden: 'true' });

  // Leaving gives the tooltip back.
  await moveAway(panel);
  expect(await row.getAttribute('title')).toContain('Alpha, open');

  const mon = await P.readMonitor(panel);
  expect(mon.writes, 'hovering writes nothing to the bookmarks').toEqual([]);
});

granted('a bookmark whose page is not open is looked up without touching the tab machinery', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel, tabIds, urls } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });

  // Let the one real capture this test needs finish BEFORE the spies go in, so that what
  // they count is the hover and not the panel's own, unrelated, capture requests.
  const alphaKey = await keyOf(panel, urls.alpha);
  await activateTab(serviceWorker, tabIds.alpha);
  await waitForThumb(panel, alphaKey, { timeout: 40_000 });
  await expect(panel.locator(`${P.CARD(tabIds.alpha)} .thumb`))
    .toHaveClass(/thumb--loaded/, { timeout: 15_000 });

  // A stored screenshot for a page that is open in no tab: it is in IndexedDB and in no
  // cache the panel keeps, so only a lookup by URL can find it. `lastUsedAt` starts at 1,
  // a long time ago, so any touch is visible.
  const SEEDED = 'https://seeded.example.com/article?id=7';
  const seededKey = await P.putFakeThumb(panel, SEEDED, { lastUsedAt: 1 });
  const seededStoredHash = await P.sha256OfStored(panel, seededKey);
  expect(seededStoredHash).toMatch(/^[0-9a-f]{64}$/);

  const requests = [];
  const onRequest = (req) => {
    if (/^https?:/i.test(req.url())) requests.push(req.url());
  };
  panel.on('request', onRequest);

  await openColumn(harness, serviceWorker, [
    { title: 'Seeded, not open', url: SEEDED },
    { title: 'Never seen', url: 'https://nowhere.example.com/x' },
    { title: 'Settings page', url: 'chrome://settings/' },
  ]);

  // H5 (rendered rows): drawing the row is what keeps its screenshot out of the prune.
  await expect.poll(() => P.lastUsedAt(panel, seededKey), {
    timeout: 15_000, message: 'a rendered bookmark row refreshes lastUsedAt of its stored preview',
  }).toBeGreaterThan(1_000);

  await P.installMonitor(panel);
  const cacheBefore = await P.cacheSize(panel);

  // H5 (hovered row): reset the clock, then hover. The row's own render touch is a
  // separate, global throttle, so this one has to come from the hover.
  await P.setLastUsedAt(panel, seededKey, 1);
  expect(await P.lastUsedAt(panel, seededKey)).toBe(1);
  expect(await hoverAndWait(panel, 'Seeded, not open')).toBe('loaded');
  const hoverTouchedAt = Date.now();
  await expect.poll(() => P.lastUsedAt(panel, seededKey), {
    timeout: 15_000, message: 'hovering a bookmark touches its stored preview',
  }).toBeGreaterThan(1_000);

  // The same bytes as the stored record: the preview read the store, not a tab.
  await expect(panel.locator(`${P.PEEK} ${P.PEEK_IMG}`)).toBeVisible();
  expect(await P.sha256OfImg(panel, `${P.PEEK} ${P.PEEK_IMG}`)).toBe(seededStoredHash);

  // Throttled to once per 30 s per key: another hover right away must not touch it again.
  await moveAway(panel);
  await P.setLastUsedAt(panel, seededKey, 1);
  expect(await hoverAndWait(panel, 'Seeded, not open')).toBe('loaded');
  await P.observe(panel, 1_500);
  expect(Date.now() - hoverTouchedAt,
    'the premise of the throttle check: it ran inside the 30 s window').toBeLessThan(25_000);
  expect(await P.lastUsedAt(panel, seededKey), 'a second hover inside 30 s does not touch again')
    .toBe(1);

  // Every other kind of row too, so the totals below cover the miss and the refusal.
  await moveAway(panel);
  expect(await hoverAndWait(panel, 'Never seen')).toBe('none');
  await moveAway(panel);
  expect(await hoverAndWait(panel, 'Settings page')).toBe('restricted');
  await moveAway(panel);
  await expect(panel.locator(P.PEEK)).toHaveCount(0);

  panel.off('request', onRequest);
  expect(requests, `the preview must not fetch: ${requests.join(', ')}`).toEqual([]);

  const mon = await P.readMonitor(panel);
  expect(mon.sends.filter((type) => type === 'vt/capture-request'),
    'the preview never asks the service worker for a capture').toEqual([]);
  expect(mon.writes, 'and never writes to the bookmarks').toEqual([]);
  expect(await P.cacheSize(panel),
    'peeking at a stored record does not put it in the panel\'s cache (and so cannot evict a card\'s)')
    .toBe(cacheBefore);

  // Object URLs: bounded while the card is up, all given back once it is down.
  await expect.poll(async () => P.previewUrls(await P.readMonitor(panel)).live, {
    timeout: 5_000, message: 'every object URL the preview made is revoked after it hides',
  }).toBe(0);
  const urlsMade = P.previewUrls(await P.readMonitor(panel));
  expect(urlsMade.made, 'loaded cards were shown, so the counter really is watching the preview')
    .toBeGreaterThanOrEqual(1);
  // The code's contract, not a generous bound: the card owns one object URL, and `render()`
  // gives the old one back before it makes the next.
  expect(urlsMade.peak, 'never more than one object URL alive at once').toBe(1);

  // Last, because it takes the panel down with it: a card that is up when the page is hidden
  // goes with its object URL. (The panel's own pagehide handler runs as well and tears the
  // column down, which also detaches the preview; either way nothing may outlive the page.)
  await moveAway(panel);
  expect(await hoverAndWait(panel, 'Seeded, not open')).toBe('loaded');
  await panel.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect(panel.locator(P.PEEK), 'the card is gone with the page').toHaveCount(0, { timeout: 5_000 });
  await expect.poll(async () => P.previewUrls(await P.readMonitor(panel)).live, {
    timeout: 2_500, message: 'and so is its object URL',
  }).toBe(0);
});

granted('a bookmark with no screenshot says why, in the words the tab card uses', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });

  const SECRET = 'https://secret.example.org/p';
  const SEEDED = 'https://seeded.example.com/article?id=7';
  // The host is excluded, and a record for it is written AFTER the exclusion has purged
  // what was stored: the service worker's purge runs some time after the setting lands, so
  // the test waits for it (the record vanishing) before writing the one the verdict has to
  // outrank. Writing it earlier could let the purge swallow it and prove nothing.
  const secretKey = await P.putFakeThumb(panel, SECRET);
  await setSettings(serviceWorker, { refreshInterval: 'off', excludedHosts: ['secret.example.org'] });
  await expect.poll(() => P.lastUsedAt(panel, secretKey), {
    timeout: 20_000, message: 'excluding a host purges the previews already stored for it',
  }).toBeNull();
  await P.putFakeThumb(panel, SECRET);
  await P.putFakeThumb(panel, SEEDED);
  expect(await P.lastUsedAt(panel, secretKey), 'the excluded host does have a stored record again')
    .not.toBeNull();

  await openColumn(harness, serviceWorker, [
    { title: 'Never seen', url: 'https://nowhere.example.com/x' },
    { title: 'Settings page', url: 'chrome://settings/' },
    { title: 'Web Store', url: 'https://chromewebstore.google.com/detail/x/abcdefghijklmnop' },
    { title: 'Secret', url: SECRET },
    { title: 'Seeded, not open', url: SEEDED },
  ]);
  await P.installMonitor(panel);

  /** One row, one verdict: the card's state, its words, and that no picture is in it. */
  async function expectVerdict(title, state, key) {
    await moveAway(panel);
    expect(await hoverAndWait(panel, title), `${title}: state`).toBe(state);
    await expect(panel.locator(`${P.PEEK} ${P.PEEK_HINT}`), `${title}: words`)
      .toHaveText(message('en', key));
    expect(await imgsWithSrc(panel), `${title}: no <img> in the card has a src`).toBe(0);
    // `toBeHidden()` alone passes for a node that is not there at all. The card is meant to be
    // the same size with or without a picture, which is what the (empty, hidden) slot is for.
    const slot = panel.locator(`${P.PEEK} ${P.PEEK_IMG}`);
    await expect(slot, `${title}: the picture slot is in the card`).toHaveCount(1);
    await expect(slot, `${title}: and it is hidden`).toBeHidden();
    await expect(slot, `${title}: by the hidden attribute`).toHaveAttribute('hidden', '');
    await expect(slot, `${title}: with nothing to load`).not.toHaveAttribute('src');
    // It still says WHICH bookmark this is.
    await expect(panel.locator(`${P.PEEK} ${P.PEEK_TITLE}`)).toHaveText(title);
  }

  await expectVerdict('Never seen', 'none', 'bookmarkPreviewNone');
  // Says only that nothing is stored. It used to promise "one is saved the next time you view
  // this page", which is false for a page that redirects away from the bookmarked address.
  expect(message('en', 'bookmarkPreviewNone')).toBe('No saved preview for this page.');
  expect(message('en', 'bookmarkPreviewNone'), 'and promises nothing').not.toMatch(/next time|will|yet/i);
  await expectVerdict('Settings page', 'restricted', 'previewUnavailable');
  await expectVerdict('Web Store', 'restricted', 'previewUnavailable');
  await expectVerdict('Secret', 'excluded', 'previewExcluded');

  // The two states that are about the browser, not the page. Both are only reachable for a
  // page without a stored record, which is where the tab card ranks them too.
  await panel.evaluate(() => { window.__vt.state.hostAccess = false; });
  await expectVerdict('Never seen', 'no-access', 'previewNoSiteAccess');
  await panel.evaluate(() => { window.__vt.state.hostAccess = true; });
  await panel.evaluate(() => { window.__vt.state.policyDisabledUntil = Date.now() + 600_000; });
  await expectVerdict('Never seen', 'policy', 'previewDisabledByPolicy');
  await panel.evaluate(() => { window.__vt.state.policyDisabledUntil = 0; });
  await expectVerdict('Never seen', 'none', 'bookmarkPreviewNone');

  // Incognito, as far as it can be tested here (see the header): with a record on file the
  // verdict is still "private window" and no picture is read out of the normal profile.
  await panel.evaluate(() => window.__vt.thumbs.init({ isIncognitoWindow: () => true }));
  try {
    await expectVerdict('Seeded, not open', 'incognito', 'previewIncognito');
  } finally {
    await panel.evaluate(() => window.__vt.thumbs.init({ isIncognitoWindow: () => false }));
  }
  await moveAway(panel);
  expect(await hoverAndWait(panel, 'Seeded, not open'), 'and back to the picture once it is not').toBe('loaded');

  expect((await P.readMonitor(panel)).writes).toEqual([]);
});

granted('the card waits, hides at once on every trigger, and hurries between rows', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;

  // Enough links that the rail scrolls in a short panel.
  const links = Array.from({ length: 40 }, (_, i) => ({
    title: `Link ${String(i).padStart(2, '0')}`, url: `https://many.example.com/${i}`,
  }));
  await openColumn(harness, serviceWorker, links, { width: 460, height: 520 });
  await P.installMonitor(panel);

  // A fresh hover: no card at 100 ms, a card between the 350 ms delay and G4's 600 ms.
  await moveAway(panel);
  await P.linkRow(panel, 'Link 03').hover();
  await expect(panel.locator(P.PEEK)).toBeVisible({ timeout: 15_000 });
  let mon = await P.readMonitor(panel);
  const at100 = mon.log.filter((e) => e.k === 'at100').pop();
  expect(at100.present, 'no card 100 ms after the pointer arrived').toBe(false);
  const delay = P.showLag(mon);
  expect(delay, `the card came ${delay} ms after the pointer`).toBeGreaterThanOrEqual(345);
  expect(delay, `the card came ${delay} ms after the pointer`).toBeLessThanOrEqual(600);

  // Moving to the next row while a card is up: no second wait.
  await P.linkRow(panel, 'Link 04').hover();
  await expect(panel.locator(`${P.PEEK} ${P.PEEK_TITLE}`)).toHaveText('Link 04', { timeout: 15_000 });
  mon = await P.readMonitor(panel);
  const hurried = P.showLag(mon);
  expect(hurried, `switching rows took ${hurried} ms, which is the full delay again`).toBeLessThan(345);

  // Every trigger, each on a fresh card, each measured from its own event to the card going.
  //
  // Scroll, drag, context menu and blur are staged as the bare event, because the event is
  // what the card listens for. A REAL scroll cannot isolate it: it moves rows under a
  // stationary pointer, so the browser reports the pointer leaving the row, and that is
  // what takes the card down first. Both are run; the real scroll accepts either as the cause.
  const triggers = [
    ['leave', 'pointer leaves the row', () => panel.mouse.move(4, 4)],
    ['scroll', 'the rail fires a scroll event', () => panel.evaluate(() => {
      document.getElementById('bookmark-rail').dispatchEvent(new Event('scroll'));
    })],
    [['scroll', 'leave'], 'the rail really scrolls', () => panel.evaluate(() => {
      document.getElementById('bookmark-rail').scrollTop += 120;
    })],
    ['dragstart', 'a drag starts', () => panel.evaluate(() => {
      document.querySelector('[data-testid="bookmark-row"][data-kind="link"]')
        .dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }));
    })],
    ['contextmenu', 'a context menu opens', () => panel.evaluate(() => {
      document.querySelector('[data-testid="bookmark-row"][data-kind="link"]')
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    })],
    ['escape', 'Escape is pressed', () => panel.keyboard.press('Escape')],
    ['blur', 'the window loses focus', () => panel.evaluate(() => {
      window.dispatchEvent(new Event('blur'));
    })],
  ];
  for (const [trigger, what, perform] of triggers) {
    await moveAway(panel);
    await panel.evaluate(() => { document.getElementById('bookmark-rail').scrollTop = 0; });
    const state = await hoverAndWait(panel, 'Link 06');
    expect(state).toBe('none');
    await perform();
    await expect(panel.locator(P.PEEK), `${what}: the card goes`).toHaveCount(0, { timeout: 5_000 });
    const lag = P.hideLag(await P.readMonitor(panel), trigger);
    expect(lag, `${what}: none of ${[].concat(trigger)} was seen before the card went`).not.toBeNull();
    expect(lag, `${what}: the card took ${lag} ms to go`).toBeLessThanOrEqual(100);
  }

  // A hidden card stays hidden until the pointer comes back: nothing re-arms on its own.
  await P.observe(panel, 800);
  await expect(panel.locator(P.PEEK)).toHaveCount(0);

  expect((await P.readMonitor(panel)).writes).toEqual([]);
});

granted('showThumbnails off means no card at all, and turning it off takes a card down', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  await openColumn(harness, serviceWorker, [
    { title: 'First', url: 'https://one.example.com/a' },
    { title: 'Second', url: 'https://two.example.com/b' },
  ]);
  await P.installMonitor(panel);

  // The control: with the setting on, the same hover does show a card.
  expect(await hoverAndWait(panel, 'First')).toBe('none');

  // Off while it is showing: the card goes.
  await setSettings(serviceWorker, { showThumbnails: false });
  await expect(panel.locator(P.PEEK), 'turning previews off takes the card down')
    .toHaveCount(0, { timeout: 10_000 });

  // And stays off: hovering for longer than the show delay gives nothing, and no card was
  // even put in the DOM.
  const added = (await P.readMonitor(panel)).log.filter((e) => e.k === 'card+').length;
  await moveAway(panel);
  await P.linkRow(panel, 'Second').hover();
  await P.observe(panel, 1_200);
  await expect(panel.locator(P.PEEK)).toHaveCount(0);
  expect((await P.readMonitor(panel)).log.filter((e) => e.k === 'card+').length,
    'no card was created while the setting is off').toBe(added);
  expect(await P.linkRow(panel, 'Second').getAttribute('title'),
    'and the row keeps its own tooltip, since no card replaces it').toContain('Second');

  // On again: the next hover shows one.
  await setSettings(serviceWorker, { showThumbnails: true });
  await moveAway(panel);
  expect(await hoverAndWait(panel, 'Second')).toBe('none');
});

granted('the card stays inside the panel at 360 and 460, above the row when it must, and lets the pointer through', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const links = Array.from({ length: 30 }, (_, i) => ({
    title: `Link ${String(i).padStart(2, '0')}`, url: `https://many.example.com/${i}`,
  }));
  await openColumn(harness, serviceWorker, links, { width: 360, height: 700 });

  /** The card's box, the hovered row's box, and the panel, in one read. */
  const geometry = (title) => panel.evaluate(({ sel, text }) => {
    const card = document.querySelector(sel);
    const row = [...document.querySelectorAll('[data-testid="bookmark-row"][data-kind="link"]')]
      .find((el) => el.textContent.includes(text));
    const c = card.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const cs = getComputedStyle(card);
    const probe = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2);
    return {
      card: { left: c.left, top: c.top, right: c.right, bottom: c.bottom, width: c.width },
      row: { top: r.top, bottom: r.bottom },
      view: { w: window.innerWidth, h: window.innerHeight },
      position: cs.position,
      pointerEvents: cs.pointerEvents,
      zIndex: Number(cs.zIndex),
      probeIsCard: Boolean(probe && card.contains(probe)),
    };
  }, { sel: P.PEEK, text: title });

  for (const width of [360, 460]) {
    await panel.setViewportSize({ width, height: 700 });
    await P.settleFrames(panel);
    await moveAway(panel);
    await panel.evaluate(() => { document.getElementById('bookmark-rail').scrollTop = 0; });
    await hoverAndWait(panel, 'Link 02');
    const g = await geometry('Link 02');
    expect(g.card.left, `${width}: inside on the left`).toBeGreaterThanOrEqual(0);
    expect(g.card.right, `${width}: inside on the right`).toBeLessThanOrEqual(g.view.w);
    expect(g.card.top, `${width}: inside at the top`).toBeGreaterThanOrEqual(0);
    expect(g.card.bottom, `${width}: inside at the bottom`).toBeLessThanOrEqual(g.view.h);
    expect(g.card.width, `${width}: as wide as the panel allows, at most 300`)
      .toBe(Math.min(300, width - 16));
    expect(Math.round(g.card.right), `${width}: flush right, one margin in`).toBe(width - 8);
    expect(g.card.top, `${width}: just under the row`).toBeGreaterThanOrEqual(g.row.bottom);
    expect(g.position).toBe('fixed');
    expect(g.pointerEvents).toBe('none');
    expect(g.zIndex, 'below the context menu (60) and the confirm bar (75)').toBeLessThan(60);
    expect(g.probeIsCard, 'the pointer reaches what is under the card').toBe(false);
  }

  // Near the bottom of a short panel there is no room below: it goes above the row.
  await panel.setViewportSize({ width: 360, height: 420 });
  await P.settleFrames(panel);
  await moveAway(panel);
  await panel.evaluate(() => {
    const rail = document.getElementById('bookmark-rail');
    rail.scrollTop = rail.scrollHeight;
  });
  await P.settleFrames(panel);
  await hoverAndWait(panel, 'Link 29');
  const low = await geometry('Link 29');
  expect(low.card.bottom, 'above the row it describes').toBeLessThanOrEqual(low.row.top);
  expect(low.card.top, 'and still inside the panel').toBeGreaterThanOrEqual(0);
  expect(low.card.bottom).toBeLessThanOrEqual(low.view.h);
});

granted('what the column keeps obeys the privacy gates that decide what it shows: private window, unknown window, excluded host, previews off', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });

  // The claim, in the code's own words (thumbs.js, `keysToKeep`): `thumb-store.touch()` reads a
  // record, blob and all, into this document, and writes it back when its stamp is older than
  // `TOUCH_FRESH_MS` (every record here starts at `lastUsedAt` 1, so it does), so a record of
  // the normal profile, or of an excluded host, must not be touched from a private window or
  // for an excluded host, and nothing is touched when it cannot be told which window this is.
  //
  // The "nothing was touched" checks are soft: one run then reports every gate that does not hold,
  // not just the first. The controls (a touch that MUST happen) are hard, because without them
  // a "nothing" means nothing.
  //
  // How it is checked: both records start with `lastUsedAt` = 1, a long time ago. The column is
  // taken down and brought up again (a NEW preview, whose touch runs at once), and `lastUsedAt`
  // says what that run did. A "nothing was touched" is only believed because the same sequence,
  // in the same page, touches the record when nothing forbids it, before and after.
  const KEEP = 'https://keep.example.com/ok';
  const SECRET = 'https://secret.example.org/p';

  // The exclusion goes in with a record present, so the service worker's purge has run (the
  // record vanishes) before the record this test needs is written; written earlier it could
  // be swallowed by the purge, and the test would prove nothing.
  const secretKey = await P.putFakeThumb(panel, SECRET);
  await setSettings(serviceWorker, { refreshInterval: 'off', excludedHosts: ['secret.example.org'] });
  await expect.poll(() => P.lastUsedAt(panel, secretKey), {
    timeout: 20_000, message: 'excluding a host purges the previews already stored for it',
  }).toBeNull();
  const keepKey = await P.putFakeThumb(panel, KEEP, { lastUsedAt: 1 });
  await P.putFakeThumb(panel, SECRET, { lastUsedAt: 1 });
  expect(await P.lastUsedAt(panel, secretKey), 'the excluded host has a stored record again').toBe(1);

  await P.openColumn(harness, serviceWorker, [
    { title: 'Keep', url: KEEP },
    { title: 'Secret', url: SECRET },
  ]);

  /**
   * Both records back to "long ago", the column rebuilt, and what its run did. `touches` says
   * whether a touch is expected at all: then the test waits for it, otherwise for longer than
   * it would have taken (the control phases show how long that is, and it is well under this).
   */
  async function afresh(touches) {
    await P.setLastUsedAt(panel, keepKey, 1);
    await P.setLastUsedAt(panel, secretKey, 1);
    await P.recycleColumn(panel, serviceWorker, 'Keep');
    if (touches) {
      await expect.poll(() => P.lastUsedAt(panel, keepKey), {
        timeout: 20_000, message: 'the rebuilt column touches the preview of a rendered row',
      }).toBeGreaterThan(1_000);
    } else {
      await P.observe(panel, 2_500);
    }
    return { keep: await P.lastUsedAt(panel, keepKey), secret: await P.lastUsedAt(panel, secretKey) };
  }

  // A — control, the real window: a rendered row keeps its preview, an excluded host's is left alone
  // by the very run that kept the other. (First, from the column opened above.)
  await expect.poll(() => P.lastUsedAt(panel, keepKey), {
    timeout: 20_000, message: 'control: a rendered bookmark row keeps its stored preview',
  }).toBeGreaterThan(1_000);
  expect.soft(await P.lastUsedAt(panel, secretKey),
    'the run that kept the first did not touch the excluded host\'s preview').toBe(1);

  // B — a private window, through the real `chrome.windows.getCurrent().incognito`.
  await P.stubWindow(panel, 'incognito');
  expect.soft(await afresh(false), 'private window: nothing was touched').toEqual({ keep: 1, secret: 1 });
  expect.soft(await P.getCurrentCalls(panel), 'the run did ask which window this is, and was told').toBeGreaterThanOrEqual(1);
  expect.soft(await P.hoverAndWait(panel, 'Keep'), 'private window: a record is on file, and is not shown')
    .toBe('incognito');
  expect.soft(await imgsWithSrc(panel), 'and no <img> in the card has a src').toBe(0);
  await moveAway(panel);

  // C — a window that cannot be identified is treated as one that must not be read.
  await P.stubWindow(panel, 'fails');
  expect.soft(await afresh(false), 'unknown window: nothing was touched').toEqual({ keep: 1, secret: 1 });
  expect.soft(await P.getCurrentCalls(panel), 'the run did ask, and the question failed').toBeGreaterThanOrEqual(1);
  expect.soft(await P.hoverAndWait(panel, 'Keep'),
    'unknown window: a record is on file, and is not shown ("none", never "loaded")').toBe('none');
  expect.soft(await imgsWithSrc(panel)).toBe(0);
  await moveAway(panel);
  await P.stubWindow(panel, 'nothing');
  expect.soft(await P.hoverAndWait(panel, 'Keep'), 'no window in the answer at all: the same').toBe('none');
  await moveAway(panel);

  // D — control, a stubbed normal window: the same sequence touches the record again, so the
  // "nothing" above was the gate and not a sequence that cannot touch. The excluded host is
  // still left alone, and its card still says why.
  await P.stubWindow(panel, 'normal');
  const normal = await afresh(true);
  expect(normal.keep).toBeGreaterThan(1_000);
  expect.soft(normal.secret, 'excluded host: not touched even in a normal window').toBe(1);
  expect(await P.hoverAndWait(panel, 'Keep')).toBe('loaded');
  await moveAway(panel);
  expect(await P.hoverAndWait(panel, 'Secret')).toBe('excluded');
  await moveAway(panel);

  // E — previews off: nothing is touched, and turning them on again makes the same
  // sequence touch. The real `chrome.windows.getCurrent` is back from here on, so the
  // final control also shows that a real window answers with a boolean `incognito`.
  await P.stubWindow(panel, 'real');
  await setSettings(serviceWorker, { showThumbnails: false });
  expect.soft(await afresh(false), 'previews off: nothing was touched').toEqual({ keep: 1, secret: 1 });
  await setSettings(serviceWorker, { showThumbnails: true });
  const back = await afresh(true);
  expect(back.keep, 'previews on again, real window: touched').toBeGreaterThan(1_000);
  expect.soft(back.secret).toBe(1);
});

granted('a hover the privacy gates refuse leaves the stored preview alone: excluded host, private window, unknown window; one they allow touches it', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });

  // A hover touches the record under its card: it reads the record, blob and all, into this
  // document and writes it back. What keeps that away from an excluded host, a private window
  // and a window that cannot be identified is one condition in `render()` of bookmark-preview.js:
  // only a card that shows the picture touches. `peekUrl()` answers with the record's key in all
  // three cases, so with that condition gone the hover would read what the card refuses to show.
  // The test above cannot see it: it puts both records back to "long ago" before every read,
  // which erases whatever a hover did.
  //
  // So here nothing is written between a hover and the read of its record, and the read is made
  // as soon as the card is up. No wait is needed: `render()` puts the card up and starts the touch
  // in the same task, the touch opens its read-write transaction before that task's microtasks are
  // done (the connection is cached), and IndexedDB runs a transaction created later on the same
  // store only after that one has finished. The control measures that claim in this very sequence:
  // a hover that may touch is seen by the same read. The witness is a row that is drawn and never
  // hovered; a run over the drawn rows would stamp it too, so a witness left alone says that the
  // control's stamp is the hover's.
  const LONG_AGO = 1;
  const KEEP = 'https://keep.example.com/ok';
  const WITNESS = 'https://witness.example.com/w';
  const PRIV = 'https://private.example.com/p';
  const UNKNOWN = 'https://unknown.example.com/u';
  const SECRET = 'https://secret.example.org/p';

  // The exclusion goes in with a record present, and the record this test needs is written after
  // the service worker's purge has removed that one (the test above says why in that order).
  const secretKey = await P.putFakeThumb(panel, SECRET);
  await setSettings(serviceWorker, { refreshInterval: 'off', excludedHosts: ['secret.example.org'] });
  await expect.poll(() => P.lastUsedAt(panel, secretKey), {
    timeout: 20_000, message: 'excluding a host purges the previews already stored for it',
  }).toBeNull();
  const keys = {
    keep: await P.putFakeThumb(panel, KEEP, { lastUsedAt: LONG_AGO }),
    witness: await P.putFakeThumb(panel, WITNESS, { lastUsedAt: LONG_AGO }),
    priv: await P.putFakeThumb(panel, PRIV, { lastUsedAt: LONG_AGO }),
    unknown: await P.putFakeThumb(panel, UNKNOWN, { lastUsedAt: LONG_AGO }),
    secret: await P.putFakeThumb(panel, SECRET, { lastUsedAt: LONG_AGO }),
  };

  await P.openColumn(harness, serviceWorker, [
    { title: 'Control, kept', url: KEEP },
    { title: 'Witness, drawn only', url: WITNESS },
    { title: 'Private window case', url: PRIV },
    { title: 'Unknown window case', url: UNKNOWN },
    { title: 'Excluded host case', url: SECRET },
  ]);

  // The column's own first run stamps every drawn row that may be kept. Wait for it: the records
  // go back to "long ago" below, and none of that run may still be on its way when they do.
  const drawnAndKeepable = [keys.keep, keys.witness, keys.priv, keys.unknown];
  await expect.poll(
    async () => (await Promise.all(drawnAndKeepable.map((k) => P.lastUsedAt(panel, k))))
      .every((at) => at > 1_000),
    { timeout: 20_000, message: 'the first run over the drawn rows stamped every one whose preview may be kept' },
  ).toBe(true);

  /**
   * One hover on `title`, and the record under `key` read the moment its card is up. `LONG_AGO` is
   * written BEFORE the hover and never between it and the read, so what is read is what the hover
   * left behind.
   */
  async function hoverThenRead(title, key) {
    await moveAway(panel);
    await P.setLastUsedAt(panel, key, LONG_AGO);
    expect(await P.lastUsedAt(panel, key), `${title}: premise, a record is on file and untouched`)
      .toBe(LONG_AGO);
    const state = await hoverAndWait(panel, title);
    return { state, stamp: await P.lastUsedAt(panel, key) };
  }

  // Control: a normal window and a page that has a picture. The hover touches it, and the same
  // read sees that.
  await P.stubWindow(panel, 'normal');
  await P.setLastUsedAt(panel, keys.witness, LONG_AGO);
  const control = await hoverThenRead('Control, kept', keys.keep);
  expect(control.state, 'control: the card shows the stored picture').toBe('loaded');
  expect(control.stamp,
    'control: a hover the gates allow touches the stored preview, and the read made as soon as the card is up sees it')
    .toBeGreaterThan(1_000);
  expect(await P.lastUsedAt(panel, keys.witness),
    'control: the stamp is the hover\'s, a drawn row that was not hovered was left alone')
    .toBe(LONG_AGO);

  // The same window and the same sequence; the one difference is that the host is on the exclusion list.
  const excluded = await hoverThenRead('Excluded host case', keys.secret);
  expect(excluded.state, 'premise: the card refuses the excluded host a picture').toBe('excluded');
  expect.soft(excluded.stamp, 'excluded host: hovering does not touch its stored preview').toBe(LONG_AGO);

  await P.stubWindow(panel, 'incognito');
  const priv = await hoverThenRead('Private window case', keys.priv);
  expect(priv.state, 'premise: a record is on file, and the card says private window').toBe('incognito');
  expect.soft(priv.stamp, 'private window: hovering does not touch the stored preview').toBe(LONG_AGO);

  await P.stubWindow(panel, 'fails');
  const unknown = await hoverThenRead('Unknown window case', keys.unknown);
  expect(await P.getCurrentCalls(panel), 'premise: the lookup asked which window this is, and was not told')
    .toBeGreaterThanOrEqual(1);
  expect(unknown.state, 'premise: a record is on file, and the card shows none of it ("none", never "loaded")')
    .toBe('none');
  expect.soft(unknown.stamp, 'unknown window: hovering does not touch the stored preview').toBe(LONG_AGO);
});

// ── Paths the design relies on, each with the test that fails without it ───────────────────
//
// What follows exists because a review found that nothing here exercised them: deleting the
// guard from the code left every spec green. Each test names the code it guards; the
// mutation that removes that code is what shows the test is not decoration.

granted('a card goes with its row: a repaint that replaces the row under a resting pointer takes the card down', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const links = Array.from({ length: 8 }, (_, i) => ({
    title: `Link ${String(i).padStart(2, '0')}`, url: `https://many.example.com/${i}`,
  }));
  const { barId, ids } = await P.openColumn(harness, serviceWorker, links);
  await P.installMonitor(panel);

  // The pointer is NOT over the row for real (`pointerOverRow`): after a repaint Chrome sends
  // synthetic boundary events to what is under a real pointer, and one of them would put a new
  // card up (taking the old one down on the way), which is a different thing from "the card
  // goes when its row goes". The observer on the list is the only thing left to do it.
  const writes = [
    ['a bookmark is added', () => swEval(serviceWorker, (a) => chrome.bookmarks.create({
      parentId: a.barId, title: 'Added', url: 'https://added.example.com/',
    }), { barId })],
    ['a bookmark is removed', () => swEval(serviceWorker, (id) => chrome.bookmarks.remove(id), ids['Link 07'])],
  ];
  for (const [what, write] of writes) {
    await moveAway(panel);
    await P.pointerOverRow(panel, 'Link 03');
    await expect(panel.locator(P.PEEK), `${what}: the card for Link 03 is up`).toBeVisible({ timeout: 15_000 });
    await panel.evaluate((sel) => { window.__card = document.querySelector(sel); }, P.PEEK);

    await write();
    await expect.poll(() => P.rowReplaced(panel), {
      timeout: 15_000, message: `${what}: the repaint replaced the rows`,
    }).toBe(true);
    // The repaint and the card's removal are the same turn of the event loop (a mutation
    // observer's callback), so by the time the page can be asked, the card is already gone.
    expect(await panel.evaluate(() => window.__card.isConnected),
      `${what}: the card for the row that is gone is gone with it`).toBe(false);
    await expect(panel.locator(P.PEEK)).toHaveCount(0);
    await P.observe(panel, 700);
    await expect(panel.locator(P.PEEK), `${what}: and nothing brings it back on its own`).toHaveCount(0);

    // The rows that replaced it are ordinary rows again: their own tooltip, and a hover works.
    expect(await P.linkRow(panel, 'Link 03').getAttribute('title'),
      `${what}: the new row has its own tooltip`).toContain('Link 03');
    expect(await hoverAndWait(panel, 'Link 04'), `${what}: hovering the new rows shows a card`).toBe('none');
  }
});

granted('a show that is in flight when its row is replaced draws nothing', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const links = Array.from({ length: 8 }, (_, i) => ({
    title: `Link ${String(i).padStart(2, '0')}`, url: `https://many.example.com/${i}`,
  }));
  const { barId } = await P.openColumn(harness, serviceWorker, links);
  await P.installMonitor(panel);

  // The lookup is parked on the question "which window is this?", which this test answers
  // when it chooses: the show is in flight, for as long as the test wants it to be.
  await P.stubWindow(panel, 'gated');
  await moveAway(panel);
  await P.pointerOverRow(panel, 'Link 05');
  await expect.poll(() => P.getCurrentCalls(panel), {
    timeout: 10_000, message: 'the 350 ms delay passed and the show is waiting on its lookup',
  }).toBeGreaterThanOrEqual(1);
  await expect(panel.locator(P.PEEK), 'nothing is drawn while it waits').toHaveCount(0);

  // The row it is for goes.
  await swEval(serviceWorker, (a) => chrome.bookmarks.create({
    parentId: a.barId, title: 'Added', url: 'https://added.example.com/',
  }), { barId });
  await expect.poll(() => P.rowReplaced(panel), { timeout: 15_000, message: 'the repaint replaced the rows' })
    .toBe(true);

  // Now the lookup answers. The show finds its row gone, and draws nothing.
  await P.releaseWindow(panel);
  await P.observe(panel, 1_000);
  const mon = await P.readMonitor(panel);
  expect(mon.log.filter((e) => e.k === 'card+'),
    'no card was built, ever, for a row that was no longer in the page').toEqual([]);
  await expect(panel.locator(P.PEEK)).toHaveCount(0);

  // Control: with the window answering, a hover on the same title (now a new row) does draw one.
  await P.stubWindow(panel, 'normal');
  await moveAway(panel);
  expect(await hoverAndWait(panel, 'Link 05'), 'the nothing above was the guard, not a broken lookup').toBe('none');
});

granted('leaving the bookmarks column, or losing the permission, lets the preview go; coming back attaches exactly one', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });
  const links = Array.from({ length: 4 }, (_, i) => ({
    title: `Link ${String(i).padStart(2, '0')}`, url: `https://many.example.com/${i}`,
  }));

  // Before the column exists: what was added earlier is not known to the ledger.
  await P.installListenerLedger(panel);
  const { barId } = await P.openColumn(harness, serviceWorker, links);
  // The preview is attached by a dynamic import that resolves after the rows are drawn, so the
  // listeners are polled for, never read once.
  const listeners = () => P.readListeners(panel);
  await expect.poll(async () => Object.keys(await listeners()).length, {
    timeout: 15_000, message: 'the preview attached and registered its listeners',
  }).toBeGreaterThanOrEqual(5);
  const up = await listeners();
  expect(Object.values(up).every((n) => n === 1), `each of them once: ${JSON.stringify(up)}`).toBe(true);

  const down = async () => {
    await setSettings(serviceWorker, { railMode: 'tools' });
    await expect(panel.locator('[data-testid="bookmark-head"]')).toHaveCount(0, { timeout: 15_000 });
  };
  const bringUp = async () => {
    await setSettings(serviceWorker, { railMode: 'bookmarks' });
    await P.waitForLink(panel, 'Link 00');
  };

  // `railMode` to tools is `stop()`: the frame is emptied, and the preview with it.
  await down();
  await expect.poll(listeners, {
    timeout: 5_000, message: 'the column is down and the preview has let go of everything',
  }).toEqual({});

  // And back, three times over: the same set each time, never a second one on top of it.
  for (let round = 1; round <= 3; round += 1) {
    await bringUp();
    await expect.poll(listeners, { timeout: 15_000, message: `column up, round ${round}` }).toEqual(up);
    await down();
    await expect.poll(listeners, { timeout: 5_000, message: `column down, round ${round}` }).toEqual({});
  }

  // The permission goes while the list is up: the grant card replaces the list (another way
  // into the same teardown), staged the way 32-bookmarks-rail stages it.
  await bringUp();
  await expect.poll(listeners, { timeout: 15_000, message: 'up once more' }).toEqual(up);
  await panel.evaluate(() => {
    chrome.permissions.contains = () => Promise.resolve(false);
    const gone = (name) => () => Promise.reject(
      new Error(`'bookmarks.${name}' is not available in this context.`));
    chrome.bookmarks.getChildren = gone('getChildren');
    chrome.bookmarks.get = gone('get');
  });
  await swEval(serviceWorker, (id) => chrome.bookmarks.create({
    parentId: id, title: 'After', url: 'https://after.example.com/2',
  }), barId);
  await expect(panel.locator('[data-testid="bookmark-grant"]')).toBeVisible({ timeout: 15_000 });
  await expect.poll(listeners, {
    timeout: 5_000, message: 'the grant card is up and the preview let go',
  }).toEqual({});
});

granted('a bookmark added after the column is up gets its stored preview kept by the trailing run', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  const LATER = 'https://later.example.com/article';
  const FIRST = 'https://first.example.com/a';
  const laterKey = await P.putFakeThumb(panel, LATER, { lastUsedAt: 1 });
  const firstKey = await P.putFakeThumb(panel, FIRST, { lastUsedAt: 1 });

  const { barId } = await P.openColumn(harness, serviceWorker, [
    { title: 'First', url: FIRST },
    { title: 'Second', url: 'https://second.example.com/b' },
  ]);
  // The column touches what is on screen when it comes up, at once, and at most once per 30 s
  // from then on. Wait until that first run has happened: from here the throttle's clock is
  // running, and a row that arrives now has to wait for a trailing run.
  await expect.poll(() => P.lastUsedAt(panel, firstKey), {
    timeout: 20_000, message: 'the first run touched the row that was on screen',
  }).toBeGreaterThan(1_000);
  expect(await P.lastUsedAt(panel, laterKey), 'no bookmark points at the other one yet, so it is not touched')
    .toBe(1);

  // The trailing run is ~30 s away. Its delay is shortened (the code that runs when it fires
  // is not): what is under test is that the run is scheduled, and that it happens.
  await P.shortenPreviewTimers(panel);
  await swEval(serviceWorker, (a) => chrome.bookmarks.create({
    parentId: a.barId, title: 'Later', url: a.url,
  }), { barId, url: LATER });
  await expect(P.linkRow(panel, 'Later'), 'the repaint drew the new row').toBeVisible({ timeout: 15_000 });
  await expect.poll(() => P.lastUsedAt(panel, laterKey), {
    timeout: 20_000, message: 'the trailing run kept the preview of the row added later',
  }).toBeGreaterThan(1_000);
  const delays = await P.shortenedDelays(panel);
  expect(delays.length, 'it was the throttle\'s trailing timer that did it').toBeGreaterThanOrEqual(1);
  expect(delays[0], 'a delay left of the 30 s the throttle allows').toBeGreaterThan(0);
  expect(delays[0]).toBeLessThanOrEqual(30_000);
});

granted('every shape of URL gets an honest card: file:, javascript:, data:, credentials, fragments and case', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });

  const PLAIN = 'https://keys.example.com/a?x=1#frag';
  const CRED = 'https://user:hunter2@keys.example.com:443/a?x=1#frag';
  const plainKey = await P.putFakeThumb(panel, PLAIN);
  expect(await keyOf(panel, CRED), 'premise: the key drops the credentials and the default port')
    .toBe(plainKey);
  expect(await keyOf(panel, 'https://keys.example.com/a?x=1#other'), 'premise: another fragment is another key')
    .not.toBe(plainKey);
  const storedHash = await P.sha256OfStored(panel, plainKey);
  expect(storedHash).toMatch(/^[0-9a-f]{64}$/);

  await P.openColumn(harness, serviceWorker, [
    { title: 'Local file', url: 'file:///tmp/vt-preview-probe.html' },
    { title: 'Bookmarklet', url: 'javascript:void(0)' },
    { title: 'Data page', url: 'data:text/html,<p>hi</p>' },
    { title: 'With credentials', url: CRED },
    { title: 'Plain twin', url: PLAIN },
    { title: 'Other fragment', url: 'https://keys.example.com/a?x=1#other' },
    { title: 'Other query', url: 'https://keys.example.com/a?x=2#frag' },
  ]);
  await P.installMonitor(panel);
  const requests = [];
  const onRequest = (req) => { if (/^https?:/i.test(req.url())) requests.push(req.url()); };
  panel.on('request', onRequest);

  const hostLine = () => panel.locator(`${P.PEEK} ${P.PEEK_HOST}`).textContent();

  // No host: the card says the scheme and nothing it did not read. `javascript://` is not an
  // address. Whether a `file:` page can ever be captured is the user's "Allow access to file
  // URLs" switch (`state.fileAccess`), and the test profile has it ON, so it is set both ways.
  await panel.evaluate(() => { window.__vt.state.fileAccess = false; });
  for (const [title, scheme] of [['Local file', 'file:'], ['Bookmarklet', 'javascript:'], ['Data page', 'data:']]) {
    await moveAway(panel);
    expect(await hoverAndWait(panel, title), `${title}: no picture can ever be taken of it`).toBe('restricted');
    await expect(panel.locator(`${P.PEEK} ${P.PEEK_HINT}`)).toHaveText(message('en', 'previewUnavailable'));
    expect(await imgsWithSrc(panel), `${title}: no <img> with a src`).toBe(0);
    expect(await hostLine(), `${title}: where it lives, as short as is true`).toBe(scheme);
  }
  // With file access on, a file: page is one a tab card could show a picture of: nothing is
  // stored for it, which is "none", not "can never".
  await panel.evaluate(() => { window.__vt.state.fileAccess = true; });
  await moveAway(panel);
  expect(await hoverAndWait(panel, 'Local file'), 'file access on: capturable, nothing stored').toBe('none');
  await expect(panel.locator(`${P.PEEK} ${P.PEEK_HINT}`)).toHaveText(message('en', 'bookmarkPreviewNone'));
  expect(await hostLine(), 'and still no invented host').toBe('file:');

  // The same key, the same picture: credentials, a default port and the case of the host are
  // not part of the page's identity, so the bookmark with them shows the stored picture, and
  // the card does not print them.
  await moveAway(panel);
  expect(await hoverAndWait(panel, 'With credentials')).toBe('loaded');
  await expect.poll(
    () => panel.locator(`${P.PEEK} ${P.PEEK_IMG}`).evaluate((el) => el.complete && el.naturalWidth),
    { timeout: 15_000 },
  ).toBe(640);
  expect(await P.sha256OfImg(panel, `${P.PEEK} ${P.PEEK_IMG}`), 'the stored picture, byte for byte').toBe(storedHash);
  expect(await hostLine()).toBe('keys.example.com');
  const printed = await panel.locator(P.PEEK).textContent();
  expect(printed, 'the card does not print the credentials').not.toMatch(/hunter2|user:|@/);

  // The next picture while this one is still up. A real pointer leaving a row hides its card
  // first, so the card that is up when the next one is drawn only happens when no `pointerout`
  // came in between; the extension hears just `pointerover` on the next row, as it would
  // from rows that touch. One card then replaces the other, and one object URL at a time.
  await P.pointerOverRow(panel, 'Plain twin');
  await expect(panel.locator(`${P.PEEK} ${P.PEEK_TITLE}`)).toHaveText('Plain twin', { timeout: 15_000 });
  await expect(panel.locator(P.PEEK)).toHaveAttribute('data-state', 'loaded');
  await expect.poll(
    () => panel.locator(`${P.PEEK} ${P.PEEK_IMG}`).evaluate((el) => el.complete && el.naturalWidth),
    { timeout: 15_000 },
  ).toBe(640);
  expect(await P.sha256OfImg(panel, `${P.PEEK} ${P.PEEK_IMG}`)).toBe(storedHash);
  // That card belongs to the row the extension was told about, not to the one the real pointer
  // is still on, so it is taken down the way it was put up.
  await P.pointerOutRow(panel);
  await expect(panel.locator(P.PEEK), 'the card goes when the pointer leaves the row it is for')
    .toHaveCount(0, { timeout: 5_000 });

  // A different fragment or query is a different page, and gets no picture that is not its own.
  for (const title of ['Other fragment', 'Other query']) {
    await moveAway(panel);
    expect(await hoverAndWait(panel, title), `${title}: a different key`).toBe('none');
    expect(await imgsWithSrc(panel)).toBe(0);
  }
  await moveAway(panel);

  panel.off('request', onRequest);
  expect(requests, `nothing was fetched: ${requests.join(', ')}`).toEqual([]);
  const mon = await P.readMonitor(panel);
  expect(mon.writes, 'nothing was written to the bookmarks').toEqual([]);
  expect(mon.sends.filter((type) => type === 'vt/capture-request')).toEqual([]);
  await expect.poll(async () => P.previewUrls(await P.readMonitor(panel)).live, { timeout: 5_000 }).toBe(0);
  const urlsMade = P.previewUrls(await P.readMonitor(panel));
  expect(urlsMade.made, 'two loaded cards were shown').toBeGreaterThanOrEqual(2);
  expect(urlsMade.peak, 'and never more than one object URL was alive').toBe(1);
});

// The Japanese run. Same card, the locale's words. `LANGUAGE`/`LC_ALL` choose the application
// locale (`_locales/ja`) and `locale` the renderer's, and both are needed (09-i18n.spec.js).
const grantedJa = granted.extend({
  context: async ({ headed, grantedExt }, use) => {
    const { context } = await launchExtensionContext({
      headed,
      extDir: grantedExt,
      env: { ...process.env, LANGUAGE: 'ja', LC_ALL: 'ja_JP.UTF-8' },
      locale: 'ja',
    });
    await use(context);
    await context.close();
  },
});

grantedJa('in Japanese the card says it in Japanese', async ({ harness, serviceWorker }) => {
  grantedJa.setTimeout(240_000);
  const { panel } = harness;
  await openColumn(harness, serviceWorker, [
    { title: 'まだ見ていないページ', url: 'https://nowhere.example.com/x' },
    { title: '設定', url: 'chrome://settings/' },
  ]);

  expect(await hoverAndWait(panel, 'まだ見ていないページ')).toBe('none');
  await expect(panel.locator(`${P.PEEK} ${P.PEEK_HINT}`)).toHaveText(message('ja', 'bookmarkPreviewNone'));
  expect(message('ja', 'bookmarkPreviewNone'), 'and it really is Japanese').toMatch(/[぀-ヿ]/);
  expect(await imgsWithSrc(panel)).toBe(0);

  await moveAway(panel);
  expect(await hoverAndWait(panel, '設定')).toBe('restricted');
  await expect(panel.locator(`${P.PEEK} ${P.PEEK_HINT}`)).toHaveText(message('ja', 'previewUnavailable'));
});
