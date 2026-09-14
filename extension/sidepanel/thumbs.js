/**
 * Panel-side thumbnail cache, object-URL lifecycle and per-card preview state.
 *
 * Contract: spec-addendum A9 (module surface, object-URL lifecycle) and A10
 * (`vt/thumb-failed` reason → visual state map). Nothing in this module throws:
 * IndexedDB failures are logged and treated as "no record", so a broken store
 * degrades to placeholders instead of an empty panel.
 *
 * The service worker owns capturing; this module only reads
 * `common/thumb-store.js`, keeps at most `MAX_CACHED_BLOBS` blobs alive and
 * hands `<img>` elements `blob:` URLs while their card is near the viewport.
 */

import * as thumbStore from '../common/thumb-store.js';
import * as urlKeyMod from '../common/url-key.js';
import * as i18n from '../common/i18n.js';
import * as log from '../common/log.js';
import {
  OBJECT_URL_GRACE_MS,
  SWAP_REVOKE_MS,
  MAX_CACHED_BLOBS,
  ASK_INTERVAL_MS,
  THUMB_IO_ROOT_MARGIN,
  TOUCH_DISPLAYED_INTERVAL_MS,
} from '../common/constants.js';

/* ── Interop shims ────────────────────────────────────────────────────────────
   Namespace imports never fail to link, so a sibling module that is still being
   written cannot take the whole panel down. Each helper below falls back to a
   behaviour-preserving default. */

const getThumbFn =
  typeof thumbStore.getThumb === 'function' ? thumbStore.getThumb : async () => null;
const getThumbsFn =
  typeof thumbStore.getThumbs === 'function' ? thumbStore.getThumbs : async () => new Map();
const touchFn = typeof thumbStore.touch === 'function' ? thumbStore.touch : async () => {};
const urlKey = typeof urlKeyMod.urlKey === 'function' ? urlKeyMod.urlKey : () => null;
const classifyUrl =
  typeof urlKeyMod.classifyUrl === 'function' ? urlKeyMod.classifyUrl : () => 'ok';
const t =
  typeof i18n.t === 'function'
    ? i18n.t
    : (key) => {
        try {
          return chrome.i18n.getMessage(key) || key;
        } catch {
          return key;
        }
      };

/* ── State ───────────────────────────────────────────────────────────────── */

/**
 * @typedef {object} Entry
 * @property {string} key
 * @property {Blob|null} blob
 * @property {string|null} objectUrl
 * @property {number} refCount
 * @property {number} capturedAt
 * @property {boolean} uniform
 * @property {[number, number, number]|null} avgColor
 * @property {number|null} revokeTimer
 * @property {number} lastUsedAt
 */

/** @type {Map<string, Entry>} urlKey → cached blob + object URL */
const cache = new Map();
/** @type {Map<number, string>} tabId → last key actually rendered for that tab */
const byTab = new Map();
/** @type {Map<number, { urlKey: string, reason: string, at: number }>} */
const failed = new Map();
/** @type {Map<number, number>} tabId → last 'visible-missing' request time */
const asked = new Map();
/** @type {Map<number, Element>} tabId → the card element currently rendering it */
const cards = new Map();

let io = null;
let lastTouchAt = 0;
let disposed = false;

/** Injected by `init()`; every field has a safe default. */
let ctx = {
  getSettings: () => ({ excludedHosts: [] }),
  getHostAccess: () => true,
  isPolicyActive: () => false,
  getFileAccess: () => false,
  ownOrigin: '',
  requestCapture: () => {},
  rerenderTab: () => {},
  getTab: () => null,
};

/**
 * Is this panel scoped to an incognito window? Captures are keyed by URL, not
 * by tab and not by profile, so without this an incognito card would be paired
 * with a screenshot taken during normal browsing. `stateFor()` already refuses
 * to *render* one (precedence step 2); this flag additionally keeps the blob
 * from ever being read out of the normal profile's IndexedDB into this
 * document. The extension is `spanning`, so the panel document itself reports
 * `chrome.extension.inIncognitoContext === false` even while it is showing an
 * incognito window — the hosting window is the only reliable signal, and it is
 * the same one `sidepanel.js` resolves the panel's `windowId` from.
 */
let incognitoWindow = false;
/** @type {Promise<boolean>|null} memoised: resolved at most once per `init()`. */
let incognitoProbe = null;

/** @returns {Promise<boolean>} resolves false when the answer cannot be obtained */
function probeIncognito() {
  if (incognitoProbe) return incognitoProbe;
  incognitoProbe = (async () => {
    try {
      if (typeof ctx.isIncognitoWindow === 'function') {
        incognitoWindow = Boolean(ctx.isIncognitoWindow());
        return incognitoWindow;
      }
      const win = await chrome.windows.getCurrent();
      incognitoWindow = Boolean(win && win.incognito);
    } catch (e) {
      // No `chrome` (unit tests) or the call failed. Falling back to "normal
      // window" only restores the pre-existing read behaviour; the terminal
      // 'excluded' verdict in stateFor() is per-tab and still applies, so a
      // failure here cannot put a normal-session image on an incognito card.
      log.warn('thumbs incognito probe (assuming a normal window)', e);
      incognitoWindow = false;
    }
    return incognitoWindow;
  })();
  return incognitoProbe;
}

/** `.thumb` classes managed by this module — exactly one is set at a time. */
const THUMB_CLASSES = [
  'thumb--loaded',
  'thumb--stale',
  'thumb--capturing',
  'thumb--empty',
  'thumb--restricted',
  'thumb--excluded',
  'thumb--policy',
  'thumb--no-access',
];

/**
 * state → { class, tooltip i18n key, label i18n key } (spec-addendum A10).
 *
 * `tooltip` is the full sentence and stays on the `.thumb` `title`. `label` is the
 * two-or-three-word version painted *inside* the placeholder, so a page that can
 * never be captured says so at a glance instead of looking like a preview that has
 * not arrived yet. Only the four terminal states carry one: the transient states
 * are legitimately "wait a moment", and labelling them would be noise.
 */
const STATE_INFO = {
  loaded: { cls: 'thumb--loaded', tooltip: '', label: '' },
  stale: { cls: 'thumb--stale', tooltip: 'previewStale', label: '' },
  capturing: { cls: 'thumb--capturing', tooltip: 'previewCapturing', label: '' },
  empty: { cls: 'thumb--empty', tooltip: 'previewPending', label: '' },
  restricted: { cls: 'thumb--restricted', tooltip: 'previewUnavailable', label: 'previewUnavailableShort' },
  excluded: { cls: 'thumb--excluded', tooltip: 'previewExcluded', label: 'previewExcludedShort' },
  // Same muted styling as `excluded`, different words: nothing was turned off by
  // the user here, previews are simply never taken in a private window.
  incognito: { cls: 'thumb--excluded', tooltip: 'previewIncognito', label: 'previewIncognitoShort' },
  policy: { cls: 'thumb--policy', tooltip: 'previewDisabledByPolicy', label: 'previewDisabledByPolicyShort' },
  'no-access': { cls: 'thumb--no-access', tooltip: 'previewNoSiteAccess', label: 'previewNoSiteAccessShort' },
};

/** `vt/thumb-failed` reason → panel state; `null` = leave the card as it is. */
const REASON_STATE = {
  restricted: 'restricted',
  policy: 'policy',
  'no-host-access': 'no-access',
  excluded: 'excluded',
  quota: 'empty',
  readback: 'empty',
  timeout: 'empty',
  unknown: 'empty',
  'not-active': null,
  minimized: null,
  discarded: null,
};

/** States whose placeholder is the lock glyph rather than the page favicon. */
const LOCK_STATES = new Set(['restricted', 'excluded', 'policy', 'no-access']);

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/**
 * True for icon sources that are served locally: a self-contained `data:` image
 * or Chrome's own `_favicon` database under this extension's origin. Anything
 * else would make the panel document fetch a page-chosen URL — with that
 * host's cookies attached, because `<all_urls>` is granted.
 * @param {string|null} src
 * @returns {boolean}
 */
function isInertIconSrc(src) {
  if (typeof src !== 'string' || src === '') return false;
  if (/^data:image\//i.test(src)) return true;
  return /^chrome-extension:\/\//i.test(src);
}

/** @param {chrome.tabs.Tab} tab @returns {string} url first, pendingUrl only when empty (A4) */
function urlOf(tab) {
  if (!tab) return '';
  return (tab.url && tab.url !== '' ? tab.url : tab.pendingUrl) || '';
}

/** @param {chrome.tabs.Tab} tab @returns {string|null} */
export function keyOfTab(tab) {
  return urlKey(urlOf(tab));
}

/** @param {object} record IndexedDB record @returns {Entry} */
function entryFrom(record) {
  return {
    key: record.urlKey,
    blob: record.blob || null,
    objectUrl: null,
    refCount: 0,
    capturedAt: Number(record.capturedAt) || 0,
    uniform: Boolean(record.uniform),
    avgColor: Array.isArray(record.avgColor) ? record.avgColor : null,
    revokeTimer: null,
    lastUsedAt: Date.now(),
  };
}

/**
 * Create (or re-create) the object URL for a key and take a reference.
 * @param {string|null} key
 */
function acquire(key) {
  if (!key) return;
  const entry = cache.get(key);
  if (!entry) return;
  entry.refCount += 1;
  entry.lastUsedAt = Date.now();
  if (entry.revokeTimer !== null) {
    clearTimeout(entry.revokeTimer);
    entry.revokeTimer = null;
  }
  if (!entry.objectUrl && entry.blob) {
    try {
      entry.objectUrl = URL.createObjectURL(entry.blob);
    } catch (e) {
      log.warn('thumbs createObjectURL', e);
      entry.objectUrl = null;
    }
  }
}

/**
 * Drop a reference; the URL is revoked after a grace period so scrolling a card
 * out and back does not churn object URLs.
 * @param {string|null} key
 */
function release(key) {
  if (!key) return;
  const entry = cache.get(key);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount > 0) return;
  entry.refCount = 0;
  if (entry.revokeTimer !== null) clearTimeout(entry.revokeTimer);
  entry.revokeTimer = setTimeout(() => revoke(entry), OBJECT_URL_GRACE_MS);
}

/** @param {Entry} entry */
function revoke(entry) {
  if (entry.revokeTimer !== null) {
    clearTimeout(entry.revokeTimer);
    entry.revokeTimer = null;
  }
  if (entry.objectUrl) {
    try {
      URL.revokeObjectURL(entry.objectUrl);
    } catch {
      /* already gone */
    }
  }
  entry.objectUrl = null;
}

/** Keep the blob cache bounded (spec-addendum A9). */
function evictIfNeeded() {
  if (cache.size <= MAX_CACHED_BLOBS) return;
  const candidates = [...cache.values()]
    .filter((e) => e.refCount <= 0)
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  let over = cache.size - MAX_CACHED_BLOBS;
  for (const entry of candidates) {
    if (over <= 0) break;
    revoke(entry);
    cache.delete(entry.key);
    over -= 1;
  }
}

/** @param {Element} cardEl @returns {number|null} */
function tabIdOf(cardEl) {
  const raw = cardEl && cardEl.dataset ? cardEl.dataset.tabId : null;
  const id = raw == null ? NaN : Number(raw);
  return Number.isFinite(id) ? id : null;
}

/* ── Public API ──────────────────────────────────────────────────────────── */

/**
 * Wire the module to the panel. Safe to call once per document.
 * @param {Partial<typeof ctx>} next
 */
export function init(next) {
  ctx = { ...ctx, ...(next || {}) };
  disposed = false;
  incognitoProbe = null;
  void probeIncognito(); // resolve before the bootstrap `loadFor()` needs it

  if (typeof document === 'undefined') return; // unit-test context: no DOM

  if (!io && typeof IntersectionObserver === 'function') {
    const root = document.getElementById('tablist');
    try {
      io = new IntersectionObserver(onIntersect, { root, rootMargin: THUMB_IO_ROOT_MARGIN, threshold: 0 });
    } catch (e) {
      log.warn('thumbs IntersectionObserver', e);
      io = null;
    }
  }

  if (typeof window !== 'undefined') window.addEventListener('pagehide', dispose, { once: true });
}

/**
 * Warm the cache from IndexedDB for the keys the panel is about to render.
 * One read-only transaction, no DOM work (spec-addendum A9).
 * @param {Array<string|null>} urlKeys
 * @returns {Promise<void>}
 */
export async function loadFor(urlKeys) {
  if (await probeIncognito()) return; // never warm an incognito panel from the normal profile
  const wanted = [...new Set((urlKeys || []).filter((k) => typeof k === 'string' && k))]
    .filter((k) => !cache.has(k));
  if (!wanted.length) return;
  let records = null;
  try {
    records = await getThumbsFn(wanted);
  } catch (e) {
    log.warn('thumbs loadFor', e);
    return;
  }
  if (!records) return;
  const iterable = typeof records.forEach === 'function' ? records : new Map(Object.entries(records));
  iterable.forEach((record, key) => {
    if (!record) return;
    if (!cache.has(key)) cache.set(key, entryFrom(record));
  });
  evictIfNeeded();
}

/**
 * Decide what a card should show. Pure: reads module state and the injected
 * getters only (spec-addendum A9 precedence list, amended so that the two
 * privacy verdicts outrank a cached capture — see steps 2 and 3).
 *
 * A9 originally numbered the cache hit first. That is wrong for privacy,
 * because the cache is keyed by URL alone: it knows nothing about which tab,
 * window or browsing session produced the screenshot. So the same URL opened
 * in an incognito window resolved to a picture taken during normal browsing,
 * and a host the user had just added to "Never capture previews on these
 * sites" kept showing the screenshot taken before they added it. Both are
 * terminal verdicts — no capture will ever be made for such a tab (see
 * background/capture.js) — so they belong above the lookup, not below it.
 * A10's step 4 existed only to stop the endless "capturing" shimmer; it was
 * never meant to sanction displaying such an image.
 *
 * Everything else keeps A9's relative order.
 *
 * @param {chrome.tabs.Tab} tab
 * @returns {{ state: string, key: string|null, tooltipKey: string,
 *             objectUrl: string|null, avgColor: number[]|null, renderKey: string|null }}
 */
export function stateFor(tab) {
  const url = urlOf(tab);
  const key = urlKey(url);
  const tabId = tab ? tab.id : null;

  const make = (state, renderKey = null) => {
    const entry = renderKey ? cache.get(renderKey) : null;
    return {
      state,
      key,
      tooltipKey: STATE_INFO[state] ? STATE_INFO[state].tooltip : '',
      objectUrl: entry ? entry.objectUrl : null,
      avgColor: entry ? entry.avgColor : null,
      renderKey: entry ? renderKey : null,
    };
  };

  // 2 — incognito tabs are never captured, and never show a capture from the
  //     normal session either. Ahead of the cache so no `loaded`/`stale` path
  //     can reach a normal-profile screenshot.
  if (tab && tab.incognito) return make('incognito');

  // 3 — local classification with the same inputs the SW uses (A10). The
  //     `excluded` verdict (the user's "never capture on these sites" list and
  //     the extension's own pages) also outranks the cache, so adding a host
  //     hides the previews already taken for it immediately.
  //     An uncommitted navigation has no key yet: never show a lock for it (A4).
  const settings = ctx.getSettings() || {};
  const cls = classifyUrl(url, {
    excludedHosts: settings.excludedHosts || [],
    fileAccess: Boolean(ctx.getFileAccess()),
    ownOrigin: ctx.ownOrigin,
  });
  // The extension's own pages classify as `excluded` too, but telling the user
  // "previews are turned off for this site" about the panel's own welcome page is
  // simply untrue — they never turned anything off. It reads as `restricted`,
  // which is what it is: a page no preview can be made of.
  if (key && cls === 'excluded') {
    return make(urlKeyMod.isOwnPanelUrl(url) || isOwnExtensionUrl(url) ? 'restricted' : 'excluded');
  }

  // 4 — a capture for exactly this URL is cached
  if (key && cache.has(key)) return make('loaded', key);

  // 5 — a failure reported for the URL the tab currently shows
  if (tabId != null) {
    const f = failed.get(tabId);
    if (f && f.urlKey && f.urlKey === key) {
      const mapped = REASON_STATE[f.reason];
      if (mapped) return make(mapped);
    }
  }

  // 6 — chrome://, the Web Store, file:// without file access …
  if (key && cls === 'restricted') return make('restricted');

  // 7 — a browser policy disabled screenshots
  if (ctx.isPolicyActive()) return make('policy');

  // 8 — Chrome is withholding host access from this extension (A7f)
  if (ctx.getHostAccess() === false && /^https?:$/.test(schemeOf(url))) return make('no-access');

  // 9 — navigated away from a captured URL: keep the old image, dimmed
  if (tabId != null && byTab.has(tabId) && byTab.get(tabId) !== key) {
    const prevKey = byTab.get(tabId);
    if (cache.has(prevKey)) return make('stale', prevKey);
  }

  // 10 — the SW can capture this tab right now
  if (tab && tab.active && !tab.discarded && tab.status === 'complete') return make('capturing');

  // 11
  return make('empty');
}

/**
 * Any page served by THIS extension, not only the panel document: the welcome
 * page, the options page and anything added later.
 * @param {string} url
 * @returns {boolean}
 */
function isOwnExtensionUrl(url) {
  try {
    return new URL(url).origin === urlKeyMod.getOwnOrigin();
  } catch {
    return false;
  }
}

/** @param {string} url @returns {string} */
function schemeOf(url) {
  try {
    return new URL(url).protocol;
  } catch {
    return '';
  }
}

/**
 * Apply the computed state to a card. Idempotent — safe to call on every render.
 * @param {Element} cardEl
 * @param {chrome.tabs.Tab} tab
 */
export function applyTo(cardEl, tab) {
  if (!cardEl || !tab) return;
  const thumbEl = cardEl.querySelector('.thumb');
  if (!thumbEl) return;
  const img = thumbEl.querySelector('.thumb__img');
  const info = stateFor(tab);
  const spec = STATE_INFO[info.state] || STATE_INFO.empty;

  cards.set(tab.id, cardEl);

  for (const cls of THUMB_CLASSES) thumbEl.classList.toggle(cls, cls === spec.cls);
  const tooltip = spec.tooltip ? t(spec.tooltip) : '';
  if (thumbEl.title !== tooltip) thumbEl.title = tooltip;

  // Average colour of the capture paints the box before the JPEG decodes.
  const bg = info.avgColor
    ? `rgb(${info.avgColor[0]}, ${info.avgColor[1]}, ${info.avgColor[2]})`
    : '';
  if (thumbEl.style.backgroundColor !== bg) thumbEl.style.backgroundColor = bg;

  if (info.state === 'loaded' && info.key) byTab.set(tab.id, info.key);

  // An object URL exists only while the card is near the viewport. A card the
  // observer has not reported on yet counts as visible so the first paint is
  // never delayed; the observer's initial callback corrects it immediately.
  const visible = cardEl.dataset.vtVisible !== '0';

  // Reference counting follows the key that is actually rendered.
  const prevKey = cardEl.dataset.thumbKey || null;
  const nextKey = visible ? info.renderKey : null;
  if (prevKey !== nextKey) {
    release(prevKey);
    acquire(nextKey);
    if (nextKey) cardEl.dataset.thumbKey = nextKey;
    else delete cardEl.dataset.thumbKey;
  }

  const entry = nextKey ? cache.get(nextKey) : null;
  if (img) {
    if (entry && entry.objectUrl) {
      if (img.getAttribute('src') !== entry.objectUrl) img.src = entry.objectUrl;
      img.hidden = false;
    } else {
      if (img.hasAttribute('src')) img.removeAttribute('src'); // never src="" (re-requests the document)
      img.hidden = true;
    }
  }

  updatePlaceholder(cardEl, thumbEl, info.state);
  maybeRequestCapture(tab);
}

/**
 * The placeholder shows the page favicon for the transient states, and a lock
 * glyph plus a short reason for the terminal ones (spec §8.4, spec-addendum A10).
 * @param {Element} cardEl
 * @param {Element} thumbEl
 * @param {string} state
 */
function updatePlaceholder(cardEl, thumbEl, state) {
  const favImg = thumbEl.querySelector('.thumb__favicon');
  const glyph = thumbEl.querySelector('.thumb__glyph');
  if (!favImg || !glyph) return;
  const spec = STATE_INFO[state] || STATE_INFO.empty;
  setLabel(thumbEl, spec.label ? t(spec.label) : '');

  if (state === 'loaded') {
    setHidden(favImg, true);
    setHidden(glyph, true);
    return;
  }

  if (LOCK_STATES.has(state)) {
    setHidden(favImg, true);
    setHidden(glyph, false);
    setGlyph(glyph, '#i-lock');
    return;
  }

  const headFav = cardEl.querySelector('.card-head .favicon');
  // Only ever mirror an icon that cannot cause a network request. render.js is
  // responsible for keeping page-declared favicon URLs out of the panel
  // document; this second check makes the placeholder incapable of
  // reintroducing the egress if that policy is ever loosened there.
  const headSrc = headFav && !headFav.hasAttribute('hidden') ? headFav.getAttribute('src') : '';
  const src = isInertIconSrc(headSrc) ? headSrc : '';
  if (src) {
    if (favImg.getAttribute('src') !== src) favImg.src = src;
    setHidden(favImg, false);
    setHidden(glyph, true);
  } else {
    setHidden(favImg, true);
    setHidden(glyph, false);
    setGlyph(glyph, '#i-globe');
  }
}

/**
 * Show or hide an element through the `hidden` **attribute**.
 *
 * `el.hidden = x` only works on `HTMLElement`: `hidden` is not part of
 * `SVGElement`, so assigning it to an inline `<svg>` silently creates an ordinary
 * JavaScript property and leaves the `hidden` attribute — and therefore
 * `[hidden] { display: none !important }` — in place. That is why the lock glyph
 * on a `chrome://` card never appeared at all (measured: `SVGElement.prototype`
 * has no `hidden`; the attribute survived `glyph.hidden = false` and the element
 * kept a 0 px box). `toggleAttribute` is correct for both element kinds.
 *
 * @param {Element} el
 * @param {boolean} hidden
 */
function setHidden(el, hidden) {
  if (!el) return;
  el.toggleAttribute('hidden', hidden);
}

/**
 * Write the placeholder's visible reason. The element only exists in the card
 * template, so a panel rendered from an older template simply has no label.
 * @param {Element} thumbEl
 * @param {string} text
 */
function setLabel(thumbEl, text) {
  const label = thumbEl.querySelector('.thumb__label');
  if (!label) return;
  if (label.textContent !== text) label.textContent = text;
}

/** @param {Element} svg @param {string} href */
function setGlyph(svg, href) {
  const use = svg.querySelector('use');
  if (use && use.getAttribute('href') !== href) use.setAttribute('href', href);
}

/** @param {Element} cardEl */
export function observe(cardEl) {
  if (!cardEl) return;
  const id = tabIdOf(cardEl);
  if (id != null) cards.set(id, cardEl);
  if (io) {
    try {
      io.observe(cardEl);
    } catch (e) {
      log.warn('thumbs observe', e);
    }
  }
}

/**
 * Stop tracking a card that is leaving the DOM.
 * @param {Element} cardEl
 * @param {number} [tabId]
 */
export function unobserve(cardEl, tabId) {
  if (!cardEl) return;
  if (io) {
    try {
      io.unobserve(cardEl);
    } catch {
      /* observer already disconnected */
    }
  }
  const img = cardEl.querySelector('.thumb__img');
  if (img) {
    img.removeAttribute('src');
    img.hidden = true;
  }
  release(cardEl.dataset.thumbKey || null);
  delete cardEl.dataset.thumbKey;
  const id = tabId != null ? tabId : tabIdOf(cardEl);
  if (id != null && cards.get(id) === cardEl) cards.delete(id);
}

/** @param {IntersectionObserverEntry[]} entries */
function onIntersect(entries) {
  for (const entry of entries) {
    const el = entry.target;
    const visible = entry.isIntersecting;
    const wasVisible = el.dataset.vtVisible !== '0';
    el.dataset.vtVisible = visible ? '1' : '0';
    if (visible === wasVisible && el.dataset.vtSeen === '1') continue;
    el.dataset.vtSeen = '1';
    const id = tabIdOf(el);
    if (id == null) continue;
    const tab = ctx.getTab(id);
    if (tab) applyTo(el, tab);
  }
}

/**
 * `vt/thumb-updated`: pull the new record, swap every `<img>` showing that key
 * and revoke the previous object URL once the swap has landed.
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function refresh(key) {
  if (!key) return;
  if (await probeIncognito()) return; // an incognito panel holds no normal-session blobs
  let record = null;
  try {
    record = await getThumbFn(key);
  } catch (e) {
    log.warn('thumbs refresh', e);
    return;
  }
  if (!record || disposed) return;

  const previous = cache.get(key) || null;
  const next = entryFrom(record);
  next.refCount = previous ? previous.refCount : 0;
  cache.set(key, next);
  if (next.refCount > 0 && next.blob) {
    try {
      next.objectUrl = URL.createObjectURL(next.blob);
    } catch (e) {
      log.warn('thumbs createObjectURL', e);
    }
  }
  evictIfNeeded();

  // A newer capture clears a stale failure for the same URL.
  for (const [tabId, f] of [...failed]) if (f.urlKey === key) failed.delete(tabId);

  const swapped = [];
  for (const [tabId, cardEl] of [...cards]) {
    if (!cardEl.isConnected) {
      cards.delete(tabId);
      continue;
    }
    const tab = ctx.getTab(tabId);
    const tabKey = tab ? keyOfTab(tab) : null;
    if (tabKey !== key && cardEl.dataset.thumbKey !== key) continue;
    if (tab) {
      applyTo(cardEl, tab);
      const img = cardEl.querySelector('.thumb__img');
      if (img && img.getAttribute('src') === next.objectUrl) swapped.push(img);
    } else {
      ctx.rerenderTab(tabId);
    }
  }

  if (!previous || !previous.objectUrl || previous.objectUrl === next.objectUrl) return;
  scheduleSwapRevoke(previous, swapped);
}

/**
 * Revoke the outgoing object URL on the first of: every swapped `<img>` firing
 * load/error, or `SWAP_REVOKE_MS` (spec-addendum A9).
 * @param {Entry} previous
 * @param {HTMLImageElement[]} images
 */
function scheduleSwapRevoke(previous, images) {
  let pending = images.length;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try {
      URL.revokeObjectURL(previous.objectUrl);
    } catch {
      /* already gone */
    }
    previous.objectUrl = null;
  };
  const timer = setTimeout(finish, SWAP_REVOKE_MS);
  if (!pending) return; // nothing rendered it: the timeout will do the work
  const onSettled = () => {
    pending -= 1;
    if (pending <= 0) finish();
  };
  for (const img of images) {
    img.addEventListener('load', onSettled, { once: true });
    img.addEventListener('error', onSettled, { once: true });
  }
}

/**
 * `tabs.onUpdated` with `info.url`, and the restore-by-URL path: look the new
 * key up in IndexedDB so a tab that navigates to (or is restored to) an
 * already-captured URL shows its preview without any capture.
 * @param {number} tabId
 * @param {string} url
 * @returns {Promise<void>}
 */
export async function onUrlChanged(tabId, url) {
  const key = urlKey(url || '');
  const f = failed.get(tabId);
  if (f && f.urlKey !== key) failed.delete(tabId);

  if (key === null) {
    ctx.rerenderTab(tabId);
    return;
  }
  const tab = ctx.getTab(tabId);
  if ((tab && tab.incognito) || incognitoWindow) {
    // Restoring "the capture we already hold for this URL" is exactly what must
    // not happen for an incognito tab: the record belongs to the normal
    // session. Leave `byTab`/`cache` untouched and let stateFor() say
    // 'excluded'.
    ctx.rerenderTab(tabId);
    return;
  }
  if (cache.has(key)) {
    byTab.set(tabId, key);
    ctx.rerenderTab(tabId);
    return;
  }
  let record = null;
  try {
    record = await getThumbFn(key);
  } catch (e) {
    log.warn('thumbs onUrlChanged', e);
  }
  if (record) {
    if (!cache.has(key)) cache.set(key, entryFrom(record));
    byTab.set(tabId, key);
    evictIfNeeded();
  }
  // else: byTab keeps the OLD key so the card renders 'stale' until a capture
  // arrives (or has no key at all and renders 'empty'/'capturing').
  ctx.rerenderTab(tabId);
}

/**
 * @param {chrome.tabs.Tab} tab
 * @returns {Promise<void>}
 */
export async function onTabAdded(tab) {
  if (!tab) return;
  // `ctx.getTab()` may not know this tab yet, so read the flag off the event.
  if (tab.incognito) {
    ctx.rerenderTab(tab.id);
    return;
  }
  await onUrlChanged(tab.id, urlOf(tab));
}

/** @param {number} tabId */
export function onTabRemoved(tabId) {
  const cardEl = cards.get(tabId);
  if (cardEl) release(cardEl.dataset.thumbKey || null);
  cards.delete(tabId);
  byTab.delete(tabId);
  failed.delete(tabId);
  asked.delete(tabId);
}

/** @param {number} addedTabId @param {number} removedTabId */
export function onTabReplaced(addedTabId, removedTabId) {
  if (byTab.has(removedTabId)) {
    byTab.set(addedTabId, byTab.get(removedTabId));
    byTab.delete(removedTabId);
  }
  if (failed.has(removedTabId)) {
    failed.set(addedTabId, failed.get(removedTabId));
    failed.delete(removedTabId);
  }
  asked.delete(removedTabId);
  cards.delete(removedTabId);
}

/**
 * `vt/thumb-failed`. A `null` key and the "no visual change" reasons are
 * ignored (spec-addendum A4, A10).
 * @param {number} tabId
 * @param {string|null} key
 * @param {string} reason
 */
export function markFailed(tabId, key, reason) {
  if (tabId == null || !key) return;
  if (!(reason in REASON_STATE)) return;
  if (REASON_STATE[reason] === null) return;
  failed.set(tabId, { urlKey: key, reason, at: Date.now() });
  ctx.rerenderTab(tabId);
}

/** @param {number} tabId */
export function clearFailed(tabId) {
  if (failed.delete(tabId)) ctx.rerenderTab(tabId);
}

/** `vt/thumbs-cleared`: drop every blob and re-render the visible cards. */
export function clear() {
  for (const entry of cache.values()) revoke(entry);
  cache.clear();
  byTab.clear();
  failed.clear();
  for (const [tabId, cardEl] of [...cards]) {
    delete cardEl.dataset.thumbKey;
    const img = cardEl.querySelector('.thumb__img');
    if (img) {
      img.removeAttribute('src');
      img.hidden = true;
    }
    ctx.rerenderTab(tabId);
  }
}

/** Keep the rendered previews out of the maintenance prune (throttled 30 s). */
export function touchDisplayed() {
  const now = Date.now();
  if (now - lastTouchAt < TOUCH_DISPLAYED_INTERVAL_MS) return;
  lastTouchAt = now;
  const keys = new Set();
  for (const cardEl of cards.values()) {
    const key = cardEl.dataset.thumbKey || cardEl.dataset.urlKey;
    if (key) keys.add(key);
  }
  if (!keys.size) return;
  Promise.resolve(touchFn([...keys], now)).catch((e) => log.warn('thumbs touch', e));
}

/**
 * Ask the service worker for a capture of a visible active tab that has no
 * preview yet — at most once per tab per `ASK_INTERVAL_MS`.
 * @param {chrome.tabs.Tab} tab
 */
export function maybeRequestCapture(tab) {
  if (!tab || !tab.active || tab.discarded) return;
  const info = stateFor(tab);
  if (info.state !== 'capturing' && info.state !== 'empty') return;
  const now = Date.now();
  if (now - (asked.get(tab.id) || 0) <= ASK_INTERVAL_MS) return;
  asked.set(tab.id, now);
  try {
    ctx.requestCapture({ tabId: tab.id, windowId: tab.windowId, reason: 'visible-missing' });
  } catch (e) {
    log.warn('thumbs requestCapture', e);
  }
}

/** `pagehide`: release everything this document holds. */
export function dispose() {
  disposed = true;
  for (const entry of cache.values()) revoke(entry);
  cache.clear();
  byTab.clear();
  failed.clear();
  asked.clear();
  cards.clear();
  if (io) {
    try {
      io.disconnect();
    } catch {
      /* already gone */
    }
    io = null;
  }
}

/** Test hook, exposed on `window.__vt` (spec-addendum A9). */
export function debugState() {
  return {
    cacheSize: cache.size,
    byTab: Object.fromEntries(byTab),
    failed: Object.fromEntries([...failed].map(([k, v]) => [k, { ...v }])),
    cards: cards.size,
  };
}
