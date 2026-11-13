// Shared by 39-bookmark-preview and 40-bookmark-guards: how to find the hover preview,
// how to put a stored screenshot where only the preview can reach it, and an in-page
// recorder that timestamps what the preview does against what provoked it.
//
// The recorder lives IN the page on purpose. A hide that is "within 100 ms of the
// Escape key" has to be measured from the key event to the node leaving the DOM, both
// read off the same clock inside the panel; measured from Playwright it would be
// measuring Playwright's round trip on a machine whose load average is 50.
'use strict';

const { expect } = require('../fixtures');
const { setSettings } = require('./chrome');
const { seedBookmarks, showBookmarks } = require('./bookmarks');

/** The card. It is a node under <body> only while it is showing. */
const PEEK = '[data-testid="bookmark-preview"]';
const PEEK_IMG = '[data-testid="bookmark-preview-img"]';
const PEEK_HINT = '[data-testid="bookmark-preview-hint"]';
const PEEK_TITLE = '[data-testid="bookmark-preview-title"]';
const PEEK_HOST = '[data-testid="bookmark-preview-host"]';

/** The card of one tab in the list. */
const CARD = (tabId) => `[data-testid="tab-card"][data-tab-id="${tabId}"]`;

/** The link row (never a folder) whose label contains `text`. */
function linkRow(panel, text) {
  return panel.locator('[data-testid="bookmark-row"][data-kind="link"]')
    .filter({ has: panel.locator('.w-row__main', { hasText: text }) })
    .first();
}

/**
 * Seed the bookmarks under the Bookmarks bar, switch the column on and open the bar, so
 * the first item is on screen as a row.
 * @param {{ panel: import('@playwright/test').Page }} harness
 */
async function openColumn(harness, serviceWorker, items, viewport = { width: 460, height: 900 }) {
  const { panel } = harness;
  await panel.setViewportSize(viewport);
  const seeded = await seedBookmarks(serviceWorker, items);
  await showBookmarks(panel, serviceWorker);
  // The first root IS the bar (`seedBookmarks` puts everything under it). Found by position,
  // not by name: Chrome names the roots in the browser's language, and the Japanese run
  // has no "Bookmarks bar" to click.
  const bar = panel.locator('[data-testid="bookmark-row"][data-depth="0"]').first();
  await expect(bar).toBeVisible({ timeout: 15_000 });
  await bar.click();
  await expect(linkRow(panel, items[0].title)).toBeVisible({ timeout: 15_000 });
  return seeded;
}

/**
 * Take the column down (`railMode` tools) and bring it back (bookmarks). That is a real
 * `stop()` and `start()`: the frame is rebuilt and a NEW preview is attached, whose touch
 * throttle starts from zero, so a "was anything touched?" question gets a fresh answer.
 * The folders that were open are restored by the panel, so the first link is back on screen.
 * @param {string} firstTitle a link that is on screen when the column is up
 */
async function recycleColumn(panel, serviceWorker, firstTitle) {
  await setSettings(serviceWorker, { railMode: 'tools' });
  await expect(panel.locator('[data-testid="bookmark-head"]'), 'the column was taken down')
    .toHaveCount(0, { timeout: 15_000 });
  await setSettings(serviceWorker, { railMode: 'bookmarks' });
  await waitForLink(panel, firstTitle);
}

/**
 * Wait for a link row to be on screen after the column has been (re)built. The panel restores
 * the folders that were open, so it is normally there on its own; if the restore did not happen
 * the bar is opened by hand, once. (A bar that IS open is never clicked: that would close it.)
 * 32-bookmarks-rail is what tests the restore itself.
 */
async function waitForLink(panel, title) {
  const row = linkRow(panel, title);
  try {
    await expect(row).toBeVisible({ timeout: 8_000 });
    return;
  } catch {
    /* not restored: open the bar below */
  }
  const bar = panel.locator('[data-testid="bookmark-row"][data-depth="0"]').first();
  if ((await bar.getAttribute('aria-expanded')) === 'false') await bar.click();
  await expect(row, `the link "${title}" is on screen`).toBeVisible({ timeout: 20_000 });
}

/** Take the pointer off the rail altogether, so the next hover is a fresh entry. */
async function moveAway(panel) {
  await panel.mouse.move(4, 4);
  await expect(panel.locator(PEEK)).toHaveCount(0, { timeout: 5_000 });
}

/** Put the pointer on a link row and wait for its card. Returns the card's data-state. */
async function hoverAndWait(panel, title) {
  await linkRow(panel, title).hover();
  const peek = panel.locator(PEEK);
  await expect(peek, `a card for "${title}"`).toBeVisible({ timeout: 15_000 });
  return peek.getAttribute('data-state');
}

/** How many <img> inside the card carry a src attribute. */
function imgsWithSrc(panel) {
  return panel.evaluate((sel) => document.querySelectorAll(`${sel} img[src]`).length, PEEK);
}

/**
 * SHA-256 of the bytes a rendered <img> is showing, read back through its own blob: URL.
 * Only valid while that URL is alive, i.e. while the preview is up.
 * @returns {Promise<string|null>} null when the element has no src
 */
function sha256OfImg(panel, selector) {
  return panel.evaluate(async (sel) => {
    const img = document.querySelector(sel);
    const src = img && (img.currentSrc || img.getAttribute('src'));
    if (!src) return null;
    const bytes = await (await fetch(src)).arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }, selector);
}

/** SHA-256 of the blob stored in IndexedDB for a key, read the way the panel reads it. */
function sha256OfStored(panel, key) {
  return panel.evaluate(async (k) => {
    const record = await window.__vt.thumbStore.getThumb(k);
    if (!record || !record.blob) return null;
    const digest = await crypto.subtle.digest('SHA-256', await record.blob.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }, key);
}

/**
 * Write a stored screenshot for `url` straight into the extension's store, from the panel,
 * the way the service worker writes one. A real JPEG (an <img> has to decode it), not flat,
 * so a preview of it is recognisably a picture.
 * @returns {Promise<string>} the urlKey it was stored under
 */
function putFakeThumb(panel, url, { lastUsedAt = Date.now(), color = '#2a5db0' } = {}) {
  return panel.evaluate(async (a) => {
    const key = window.__vt.urlKey(a.url);
    const canvas = new OffscreenCanvas(640, 240);
    const g = canvas.getContext('2d');
    g.fillStyle = a.color;
    g.fillRect(0, 0, 640, 240);
    g.fillStyle = '#f4f4f4';
    g.fillRect(0, 0, 640, 36);
    g.fillStyle = '#c0392b';
    g.fillRect(40, 90, 200, 70);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
    const now = Date.now();
    await window.__vt.thumbStore.putThumb({
      urlKey: key, url: a.url, title: 'seeded', capturedAt: now, lastUsedAt: a.lastUsedAt,
      width: 640, height: 240, bytes: blob.size, blob, avgColor: [42, 93, 176], uniform: false,
      tabId: null, windowId: null, atTop: true,
    });
    return key;
  }, { url, lastUsedAt, color });
}

/**
 * One JPEG written under every URL in `urls` (the same blob, one record each), from the panel,
 * the way `putFakeThumb` writes one. For a test that needs many records and does not need them
 * to differ.
 * @returns {Promise<number>} how many records were written
 */
function putFakeThumbs(panel, urls, { lastUsedAt = Date.now() } = {}) {
  return panel.evaluate(async (a) => {
    const canvas = new OffscreenCanvas(640, 240);
    const g = canvas.getContext('2d');
    g.fillStyle = '#2a5db0';
    g.fillRect(0, 0, 640, 240);
    g.fillStyle = '#c0392b';
    g.fillRect(40, 90, 200, 70);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
    for (const url of a.urls) {
      await window.__vt.thumbStore.putThumb({
        urlKey: window.__vt.urlKey(url), url, title: 'seeded', capturedAt: Date.now(), lastUsedAt: a.lastUsedAt,
        width: 640, height: 240, bytes: blob.size, blob, avgColor: [42, 93, 176], uniform: false,
        tabId: null, windowId: null, atTop: true,
      });
    }
    return a.urls.length;
  }, { urls, lastUsedAt });
}

/** `lastUsedAt` of the stored record, or null when there is none. */
function lastUsedAt(panel, key) {
  return panel.evaluate(async (k) => {
    const record = await window.__vt.thumbStore.getThumb(k);
    return record ? record.lastUsedAt : null;
  }, key);
}

/** Rewrite `lastUsedAt` on an existing record without touching anything else in it. */
function setLastUsedAt(panel, key, value) {
  return panel.evaluate(async (a) => {
    const record = await window.__vt.thumbStore.getThumb(a.key);
    if (!record) throw new Error(`no stored preview for ${a.key}`);
    record.lastUsedAt = a.value;
    await window.__vt.thumbStore.putThumb(record);
  }, { key, value });
}

/** How many blobs the panel's own cache holds (what a tab card can lose to eviction). */
function cacheSize(panel) {
  return panel.evaluate(() => window.__vt.debugState().cacheSize);
}

/** Wait inside the page, so "nothing happened" is observed over a window that is really that long. */
function observe(panel, ms) {
  return panel.evaluate((n) => new Promise((resolve) => setTimeout(resolve, n)), ms);
}

/** Two animation frames: layout has been recomputed for whatever changed before this call. */
function settleFrames(panel) {
  return panel.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
  }));
}

/**
 * Start recording, in the panel, everything the preview does and everything that could
 * make it do something. Idempotent. Everything is read back with {@link readMonitor}.
 *
 *   log    ordered events with `performance.now()` stamps:
 *            card+ / card-    the card entered / left the DOM
 *            enter / leave    the pointer crossed a bookmark row's boundary
 *            escape, contextmenu, dragstart, scroll, blur   the hide triggers
 *            at100            100 ms after an `enter`: was the card there yet?
 *   made / revoked   every object URL created / revoked, `by` = whether the preview made it,
 *                    `n` = their order of happening (a timestamp can tie; a counter cannot)
 *   sends            the `type` of every runtime message the panel sent
 *   writes           every chrome.bookmarks write call (there must be none)
 *
 * `sends` and `writes` work by replacing `chrome.runtime.sendMessage` and the five write
 * methods of `chrome.bookmarks` with recording wrappers. "Nothing was recorded" only means
 * something if a call WOULD have been, so before returning, each wrapper is exercised once
 * with its forwarding switched off (nothing reaches the service worker or the bookmarks), the
 * records are checked, and they are cleared. A page where the assignment did not take, or
 * where the wrapper does not record, fails here, in every spec that uses the monitor.
 */
async function installMonitor(panel) {
  const canary = await panel.evaluate((sel) => {
    if (window.__peekMon) return null;
    const mon = { log: [], made: [], revoked: [], sends: [], writes: [], seq: 0 };
    window.__peekMon = mon;
    const now = () => performance.now();
    const isCard = (n) => n.nodeType === 1 && n.matches && n.matches(sel);
    const rowOf = (el) => (el && el.closest ? el.closest('[data-bookmark-id]') : null);

    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (isCard(n)) mon.log.push({ k: 'card+', t: now(), state: n.dataset.state || '' });
        }
        for (const n of r.removedNodes) if (isCard(n)) mon.log.push({ k: 'card-', t: now() });
      }
    }).observe(document.body, { childList: true });

    // Capture phase on WINDOW, so these are stamped before any handler of the extension's
    // runs. On `document` that is not true: the extension's own capture listeners there were
    // registered when the column was built, before this recorder, so for Escape and dragstart
    // they ran first and the card's removal was stamped before the key that caused it.
    window.addEventListener('pointerover', (e) => {
      const row = rowOf(e.target);
      if (!row || (e.relatedTarget && row.contains(e.relatedTarget))) return;
      mon.log.push({ k: 'enter', t: now(), id: row.dataset.bookmarkId });
      setTimeout(() => {
        mon.log.push({ k: 'at100', t: now(), present: Boolean(document.querySelector(sel)) });
      }, 100);
    }, true);
    window.addEventListener('pointerout', (e) => {
      const row = rowOf(e.target);
      if (!row || (e.relatedTarget && row.contains(e.relatedTarget))) return;
      mon.log.push({ k: 'leave', t: now(), id: row.dataset.bookmarkId });
    }, true);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') mon.log.push({ k: 'escape', t: now() });
    }, true);
    window.addEventListener('contextmenu', () => mon.log.push({ k: 'contextmenu', t: now() }), true);
    window.addEventListener('dragstart', () => mon.log.push({ k: 'dragstart', t: now() }), true);
    window.addEventListener('scroll', (e) => {
      if (e.target && e.target.id === 'bookmark-rail') mon.log.push({ k: 'scroll', t: now() });
    }, true);
    window.addEventListener('blur', () => mon.log.push({ k: 'blur', t: now() }), true);

    const realCreate = URL.createObjectURL.bind(URL);
    const realRevoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = realCreate(blob);
      mon.made.push({
        url, by: String(new Error().stack).includes('bookmark-preview'), t: now(), n: (mon.seq += 1),
      });
      return url;
    };
    URL.revokeObjectURL = (url) => {
      mon.revoked.push({ url, t: now(), n: (mon.seq += 1) });
      return realRevoke(url);
    };

    // `forward` is off only while the canary below runs.
    let forward = true;
    const realSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (...args) => {
      mon.sends.push(args[0] && args[0].type ? args[0].type : String(typeof args[0]));
      return forward ? realSend(...args) : Promise.resolve();
    };
    const wrapped = [];
    if (chrome.bookmarks) {
      for (const name of ['create', 'update', 'move', 'remove', 'removeTree']) {
        if (typeof chrome.bookmarks[name] !== 'function') continue;
        const real = chrome.bookmarks[name].bind(chrome.bookmarks);
        chrome.bookmarks[name] = (...args) => {
          mon.writes.push(name);
          return forward ? real(...args) : Promise.resolve();
        };
        wrapped.push(name);
      }
    }

    // The canary. The calls go through the PROPERTIES, the way the product calls them.
    forward = false;
    try {
      chrome.runtime.sendMessage({ type: '__canary__' });
      for (const name of wrapped) chrome.bookmarks[name]('__canary__');
    } finally {
      forward = true;
    }
    const seen = { sends: [...mon.sends], writes: [...mon.writes], wrapped };
    mon.sends.length = 0;
    mon.writes.length = 0;
    return seen;
  }, PEEK);

  if (canary) {
    expect(canary.sends, 'the message recorder records a message sent through chrome.runtime.sendMessage')
      .toEqual(['__canary__']);
    expect(canary.wrapped.length, 'there are bookmark write methods to watch').toBeGreaterThan(0);
    expect(canary.writes, 'the write recorder records a call to every bookmark write method it wraps')
      .toEqual(canary.wrapped);
  }
}

/** A copy of what the recorder has seen so far. */
function readMonitor(panel) {
  return panel.evaluate(() => JSON.parse(JSON.stringify(window.__peekMon)));
}

/**
 * Preview object URLs alive at the end of the log, and the most that were alive at once.
 * A URL counts as the preview's when its creator's stack names bookmark-preview.
 */
function previewUrls(mon) {
  const live = new Set();
  let peak = 0;
  const events = [
    ...mon.made.filter((m) => m.by).map((m) => ({ ...m, kind: 'make' })),
    ...mon.revoked.map((m) => ({ ...m, kind: 'revoke' })),
  ].sort((a, b) => a.n - b.n);
  const ours = new Set(mon.made.filter((m) => m.by).map((m) => m.url));
  for (const e of events) {
    if (e.kind === 'make') {
      live.add(e.url);
      peak = Math.max(peak, live.size);
    } else if (ours.has(e.url)) {
      live.delete(e.url);
    }
  }
  return { made: ours.size, live: live.size, peak };
}

/**
 * Milliseconds from the last event of the kind(s) `trigger` before the card's last removal
 * to that removal. Null when the card was never removed or nothing of that kind preceded it.
 * @param {object} mon
 * @param {string|string[]} trigger one kind, or several when any of them may be the cause
 */
function hideLag(mon, trigger) {
  const kinds = new Set(Array.isArray(trigger) ? trigger : [trigger]);
  const out = [...mon.log].reverse().find((e) => e.k === 'card-');
  if (!out) return null;
  const cause = [...mon.log].reverse().find((e) => kinds.has(e.k) && e.t <= out.t);
  return cause ? out.t - cause.t : null;
}

/** Milliseconds from the pointer entering a row to the card appearing, for the last card. */
function showLag(mon) {
  const shown = [...mon.log].reverse().find((e) => e.k === 'card+');
  if (!shown) return null;
  const entered = [...mon.log].reverse().find((e) => e.k === 'enter' && e.t <= shown.t);
  return entered ? shown.t - entered.t : null;
}

/** The boxes that make up the two top requirements, as the browser laid them out. */
function layoutBoxes(panel) {
  return panel.evaluate(() => {
    const box = (id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const main = document.getElementById('main-row');
    return {
      mainRow: box('main-row'),
      tablist: box('tablist'),
      rail: box('bookmark-rail'),
      mainRowOrder: main ? [...main.children].map((c) => c.id || c.tagName) : null,
      pageScroll: { x: window.scrollX, y: window.scrollY },
      overflowsSideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}

/**
 * One verdict per tab card: 'ok' when it shows a decoded blob: screenshot, else why not.
 * @returns {Promise<Record<string, string>>} tab id -> verdict
 */
function cardVerdicts(panel) {
  return panel.evaluate(() => {
    const out = {};
    for (const card of document.querySelectorAll('#tablist [data-testid="tab-card"]')) {
      const thumb = card.querySelector('.thumb');
      const img = card.querySelector('.thumb__img');
      let verdict = 'ok';
      if (!thumb || !img) verdict = 'no thumb box';
      else if (!thumb.classList.contains('thumb--loaded')) verdict = `class is ${thumb.className}`;
      else if (img.hidden) verdict = 'img hidden';
      else if (!(img.getAttribute('src') || '').startsWith('blob:')) verdict = 'img has no blob src';
      else if (!img.complete || img.naturalWidth !== 640 || img.naturalHeight !== 240) {
        verdict = `img not decoded (${img.naturalWidth}x${img.naturalHeight})`;
      } else {
        const r = img.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) verdict = 'img has no box';
      }
      out[card.dataset.tabId] = verdict;
    }
    return out;
  });
}

/**
 * Make the panel's thumbnail module ask `chrome.windows.getCurrent()` again, with that call
 * replaced. This is how the REAL branch of the private-window check is reached: the module's
 * own seam (`isIncognitoWindow`) replaces the answer, this replaces what the module asks.
 *
 *   incognito  a private window            normal   a normal window
 *   fails      the call rejects            nothing  the call resolves with no window at all
 *   gated      the call stays pending until `window.__releaseWindow()` (a normal window then)
 *   real       the real `chrome.windows.getCurrent`
 *
 * Each call to the stub is counted in `window.__getCurrentCalls`, zeroed here after `init()`
 * has made its own (fail-open) call, so the count is what the bookmark side asked.
 * `init()` also forgets a seam an earlier test installed and every answer held for the old
 * window. Checks that the assignment took: a stub that did not replace the call would make
 * every "private window" test below a test of a normal one.
 */
async function stubWindow(panel, mode) {
  const took = await panel.evaluate((how) => {
    const api = chrome.windows;
    if (!window.__realGetCurrent) window.__realGetCurrent = api.getCurrent;
    window.__getCurrentCalls = 0;
    window.__gate = [];
    window.__releaseWindow = () => {
      for (const release of window.__gate.splice(0)) release({ id: 1, incognito: false, type: 'normal' });
    };
    if (how === 'real') {
      api.getCurrent = window.__realGetCurrent;
    } else {
      api.getCurrent = () => {
        window.__getCurrentCalls += 1;
        if (how === 'fails') return Promise.reject(new Error('stubbed: windows.getCurrent fails'));
        if (how === 'nothing') return Promise.resolve(undefined);
        if (how === 'gated') return new Promise((resolve) => window.__gate.push(resolve));
        return Promise.resolve({ id: 1, incognito: how === 'incognito', type: 'normal' });
      };
    }
    const assigned = how === 'real'
      ? api.getCurrent === window.__realGetCurrent
      : api.getCurrent !== window.__realGetCurrent;
    window.__vt.thumbs.init({ isIncognitoWindow: undefined });
    window.__getCurrentCalls = 0;
    return assigned;
  }, mode);
  expect(took, `chrome.windows.getCurrent really is the "${mode}" one now`).toBe(true);
}

/** How many times the stubbed `chrome.windows.getCurrent` has been called since `stubWindow`. */
function getCurrentCalls(panel) {
  return panel.evaluate(() => window.__getCurrentCalls);
}

/** Let a `gated` window answer. */
function releaseWindow(panel) {
  return panel.evaluate(() => window.__releaseWindow());
}

/**
 * Put the pointer on a link row WITHOUT the real pointer: the extension hears `pointerover`
 * on that row and nothing else. A real hover also makes Chrome send synthetic boundary events
 * to whatever is under the pointer after every layout, which is a second thing that can put a
 * card up or take it down; a test of "the card goes when its row goes" needs the pointer out
 * of it. The row element is kept as `window.__row`, to be asked later whether it is still
 * in the page.
 */
function pointerOverRow(panel, title) {
  return panel.evaluate((text) => {
    const row = [...document.querySelectorAll('[data-testid="bookmark-row"][data-kind="link"]')]
      .find((el) => el.textContent.includes(text));
    if (!row) throw new Error(`no link row "${text}"`);
    window.__row = row;
    row.dispatchEvent(new PointerEvent('pointerover', {
      bubbles: true, cancelable: true, composed: true, pointerType: 'mouse',
    }));
  }, title);
}

/**
 * The other half of `pointerOverRow`: the extension hears `pointerout` from that row, to nowhere.
 * A card shown through `pointerOverRow` is tracked against THAT row, so only this takes it down;
 * the real pointer leaving some other row does not.
 */
function pointerOutRow(panel) {
  return panel.evaluate(() => {
    window.__row.dispatchEvent(new PointerEvent('pointerout', {
      bubbles: true, cancelable: true, composed: true, pointerType: 'mouse', relatedTarget: null,
    }));
  });
}

/** Has the row `pointerOverRow` found been taken out of the page (a repaint replaced it)? */
function rowReplaced(panel) {
  return panel.evaluate(() => !window.__row.isConnected);
}

/**
 * Count, from now on, the listeners that `bookmark-preview.js` adds and removes, by target,
 * type and phase. A listener the module forgets to remove stays in the count, so a preview
 * that is not detached when its column is torn down shows up as a count that does not go back
 * to zero. Install it BEFORE the column is built: what was added earlier is not known.
 */
function installListenerLedger(panel) {
  return panel.evaluate(() => {
    if (window.__ledger) return;
    const live = new Map();
    window.__ledger = live;
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    const name = (t) => {
      if (t === window) return 'window';
      if (t === document) return 'document';
      if (t && t.id) return `#${t.id}`;
      return (t && t.dataset && t.dataset.testid) || (t && t.nodeName) || 'target';
    };
    const key = (t, type, opts) => {
      const capture = typeof opts === 'boolean' ? opts : Boolean(opts && opts.capture);
      return `${type}@${name(t)}${capture ? ':capture' : ''}`;
    };
    EventTarget.prototype.addEventListener = function patchedAdd(type, fn, opts) {
      if (typeof fn === 'function' && String(new Error().stack).includes('bookmark-preview')) {
        const k = key(this, type, opts);
        if (!live.has(k)) live.set(k, new Set());
        live.get(k).add(fn);
      }
      return add.call(this, type, fn, opts);
    };
    EventTarget.prototype.removeEventListener = function patchedRemove(type, fn, opts) {
      const set = live.get(key(this, type, opts));
      if (set) set.delete(fn);
      return remove.call(this, type, fn, opts);
    };
  });
}

/** `{ "type@target": how many are still registered }`, for what the ledger has seen. */
function readListeners(panel) {
  return panel.evaluate(() => {
    const out = {};
    for (const [k, set] of window.__ledger) if (set.size) out[k] = set.size;
    return out;
  });
}

/**
 * Shorten, to 100 ms, every timer of `bookmark-preview.js` that is longer than a second, and
 * remember what it was. The preview has exactly one such timer, the trailing run of the
 * "once per 30 s" touch; this lets a test see that run happen without waiting 30 s for it.
 * Only the delay is changed: what the timer does when it fires is the real code.
 */
function shortenPreviewTimers(panel) {
  return panel.evaluate(() => {
    if (window.__shrunk) return;
    window.__shrunk = [];
    const real = window.setTimeout.bind(window);
    window.setTimeout = (fn, ms, ...rest) => {
      if (ms > 1000 && String(new Error().stack).includes('bookmark-preview')) {
        window.__shrunk.push(ms);
        return real(fn, 100, ...rest);
      }
      return real(fn, ms, ...rest);
    };
  });
}

/** The delays `shortenPreviewTimers` has replaced, in order. */
function shortenedDelays(panel) {
  return panel.evaluate(() => window.__shrunk);
}

/**
 * The clock the recorder's own `touch` runs at. The record it touches is stamped 1, and `touch()` leaves a
 * stamp that is a number within TOUCH_FRESH_MS of `now` alone, so the touch has to come more than that after
 * the stamp for the canary to see a write. TOUCH_FRESH_MS is at most a day (constants.js), and this is a day and
 * four seconds after the stamp, so it is outside it for any value the constant may have.
 */
const CANARY_NOW = 4242 + 86_400_000;

/**
 * Record, in the panel, every IndexedDB transaction that is opened from now on, and what each one
 * does: `window.__idb.tx` is one entry per transaction, in the order they were opened.
 *
 *   n        its place in that order (a timestamp can tie; a counter cannot)
 *   mode     'readonly' | 'readwrite'
 *   created  `performance.now()` when `db.transaction()` returned
 *   done     `performance.now()` when it completed or aborted (null while it is open)
 *   gets     `store.get()` calls made on it    keys    the keys of those calls, in order
 *   puts     `store.put()` calls made on it    stamps  the `lastUsedAt` of each record put
 *   tag      what the page set in `window.__idb.nextTag` just before the call that opened it
 *
 * It works by wrapping `IDBDatabase.prototype.transaction`, `IDBObjectStore.prototype.get` and
 * `.put` in the page, so it sees what `thumb-store.js` really asks of the database whichever
 * function asked, and it is blind to nothing in this document (the service worker's own
 * transactions are another document's). Two hooks let a test act at exact moments:
 *   `window.__idb.onCreated(entry)`  inside `transaction()`, before the caller has a transaction
 *   `window.__idb.onDone(entry)`     inside the transaction's `complete`/`abort` listener, which was
 *                                    added when it was opened and so runs BEFORE the listeners
 *                                    the caller adds afterwards (`tx.oncomplete = ...`)
 * A hook that throws is caught and its message kept in `window.__idb.hookErrors`.
 *
 * "No transaction carried more than N keys" only means something if a transaction WOULD have been
 * recorded, so before returning, the recorder is exercised against the real store (a read, a write
 * of a record, a `touch` of it, a delete), the records are checked, and they are cleared. A recorder
 * that does not see a call fails here, in every spec that uses it. The canary's four transactions are
 * picked out by tag, so the panel's own traffic that lands in the same moment is ignored (and counted
 * in `window.__idb.ignoredDuringCanary`). Install it BEFORE the code whose transactions are to be
 * seen runs.
 * @param {import('@playwright/test').Page} panel
 */
async function installStoreRecorder(panel) {
  const canary = await panel.evaluate(async (canaryNow) => {
    if (window.__idb) return null;
    const rec = {
      tx: [], seq: 0, nextTag: null, onCreated: null, onDone: null, hookErrors: [],
    };
    window.__idb = rec;
    const entryOf = new WeakMap();
    const hook = (name, entry) => {
      if (typeof rec[name] !== 'function') return;
      try {
        rec[name](entry);
      } catch (e) {
        rec.hookErrors.push(`${name}: ${String(e)}`);
      }
    };

    const realTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function recordedTransaction(...args) {
      const tx = realTransaction.apply(this, args);
      const entry = {
        n: (rec.seq += 1),
        mode: tx.mode,
        created: performance.now(),
        done: null,
        how: null,
        gets: 0,
        puts: 0,
        keys: [],
        stamps: [],
        tag: rec.nextTag,
      };
      rec.nextTag = null;
      entryOf.set(tx, entry);
      rec.tx.push(entry);
      const finish = (how) => () => {
        if (entry.done !== null) return;
        entry.done = performance.now();
        entry.how = how;
        hook('onDone', entry);
      };
      tx.addEventListener('complete', finish('complete'));
      tx.addEventListener('abort', finish('abort'));
      hook('onCreated', entry);
      return tx;
    };

    const realGet = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function recordedGet(...args) {
      const entry = entryOf.get(this.transaction);
      if (entry) {
        entry.gets += 1;
        entry.keys.push(String(args[0]));
      }
      return realGet.apply(this, args);
    };
    const realPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function recordedPut(...args) {
      const entry = entryOf.get(this.transaction);
      if (entry) {
        entry.puts += 1;
        entry.stamps.push(args[0] && args[0].lastUsedAt);
      }
      return realPut.apply(this, args);
    };

    // The canary, through the real store. Each call is tagged and only the transactions that carry a canary tag are
    // compared below: the panel's own traffic (a late refresh of a card after a second capture of the active tab, say)
    // can land in this window, and it says nothing about whether the recorder sees what the store does. A tag taken by
    // such a transaction instead of the canary's own call leaves the list short and fails the comparison, loudly.
    const store = window.__vt.thumbStore;
    const key = '__recorder-canary__';
    const tagged = async (tag, call) => {
      rec.nextTag = tag;
      await call();
    };
    await tagged('canary-1', () => store.putThumb({ urlKey: key, lastUsedAt: 1 }));
    await tagged('canary-2', () => store.getThumb(key));
    await tagged('canary-3', () => store.touch([key], canaryNow));
    await tagged('canary-4', () => store.deleteThumbs([key]));
    rec.nextTag = null;
    const own = rec.tx
      .filter((t) => typeof t.tag === 'string' && t.tag.startsWith('canary-'))
      .sort((a, b) => a.n - b.n);
    // How many transactions that were not the canary's were recorded while it ran (a test can read this).
    rec.ignoredDuringCanary = rec.tx.length - own.length;
    const seen = own.map(({
      mode, gets, puts, keys, stamps, done,
    }) => ({
      mode, gets, puts, keys, stamps, done: done !== null,
    }));
    rec.tx.length = 0;
    return seen;
  }, CANARY_NOW);

  if (canary) {
    const key = '__recorder-canary__';
    expect(canary, 'the transaction recorder sees a write, a read, a touch and a delete made through the real store')
      .toEqual([
        {
          mode: 'readwrite', gets: 0, puts: 1, keys: [], stamps: [1], done: true,
        },
        {
          mode: 'readonly', gets: 1, puts: 0, keys: [key], stamps: [], done: true,
        },
        {
          mode: 'readwrite', gets: 1, puts: 1, keys: [key], stamps: [CANARY_NOW], done: true,
        },
        {
          mode: 'readwrite', gets: 0, puts: 0, keys: [], stamps: [], done: true,
        },
      ]);
  }
}

/** A copy of what the transaction recorder has seen so far, hook errors included. */
function readStoreRecorder(panel) {
  return panel.evaluate(() => JSON.parse(JSON.stringify({ tx: window.__idb.tx, hookErrors: window.__idb.hookErrors })));
}

module.exports = {
  PEEK, PEEK_IMG, PEEK_HINT, PEEK_TITLE, PEEK_HOST, CARD, linkRow,
  openColumn, recycleColumn, waitForLink, moveAway, hoverAndWait, imgsWithSrc,
  sha256OfImg, sha256OfStored, putFakeThumb, putFakeThumbs, lastUsedAt, setLastUsedAt, cacheSize,
  observe, settleFrames, installMonitor, readMonitor, previewUrls, hideLag, showLag,
  layoutBoxes, cardVerdicts,
  stubWindow, getCurrentCalls, releaseWindow, pointerOverRow, pointerOutRow, rowReplaced,
  installListenerLedger, readListeners, shortenPreviewTimers, shortenedDelays,
  installStoreRecorder, readStoreRecorder,
};
