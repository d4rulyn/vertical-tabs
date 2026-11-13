/**
 * The bookmark column's hover preview: rest the pointer on a bookmark and a card shows
 * the screenshot of that page — the SAME stored picture the page's tab card shows, because
 * both are the record under `urlKey(url)` and `thumbs.peekUrl()` reads it.
 *
 * Loaded lazily by `bookmarks.js` and by nothing else, once a list has been built: an
 * ungranted column never loads it, and `sidepanel.js` never imports it, so panel boot (which
 * `29-open-latency` measures) is untouched.
 *
 * ── What it never does ──────────────────────────────────────────────────────
 * It writes no bookmark, asks for no capture, makes no request and sends no message. The
 * only thing it writes is `lastUsedAt` of a record that already exists, and only when the
 * stamp it holds is older than `TOUCH_FRESH_MS` (see "Keeping the pictures" below). A
 * bookmark whose page has no screenshot shows a card that SAYS so, in the
 * words a tab card uses for the same reason, rather than nothing: nothing reads as a bug.
 *
 * ── The card ────────────────────────────────────────────────────────────────
 * One `div#bookmark-preview` under <body> while it is showing and nowhere else: position
 * fixed, pointer-events none, so it takes no part in the layout of the tab list, the column
 * or the row that holds them, and the pointer keeps hitting what is beneath it. It is built
 * fresh for each show and removed on hide; its `blob:` URL is made when it is shown and
 * revoked in the same breath it goes, so there is at most one alive.
 *
 * ── When ────────────────────────────────────────────────────────────────────
 * A link row (never a folder) under the pointer for SHOW_DELAY_MS, or at once when a card
 * went down within HURRY_WINDOW_MS (moving along the rows is one gesture, not many). It goes
 * the instant the pointer leaves the row, the rail scrolls, a drag starts, a context menu
 * opens, Escape is pressed, the window loses focus, the page is hidden, the row is replaced
 * by a repaint, a mouse button goes down on it, or previews are turned off or the site is
 * excluded in the settings. `showThumbnails === false` means no card at all.
 *
 * While a card is up the row's native tooltip is taken off (the card carries the title and
 * the host) and put back when the card goes, so there is never a bubble on top of the card.
 *
 * ── Keeping the pictures ────────────────────────────────────────────────────
 * The maintenance prune keeps only the screenshots of open tabs and of anything used in the
 * last 14 days. A bookmark is by definition a page that is often not open, so the keys of
 * the rows on screen are touched when the column is attached and after each paint chunk
 * (throttled to once per 30 s, like `touchDisplayed()` does for tab cards: a floor between
 * two runs, started by those events, not a period) and so is the one under the pointer
 * (once per 30 s per key). Touching refreshes `lastUsedAt` of a record that exists, and only
 * when the stamp it holds is older than `TOUCH_FRESH_MS`, so a row that stays on screen is
 * rewritten at most that often; for a record that does not exist it does nothing.
 *
 * Touching READS the record, blob and all, into this document, whether or not it writes it
 * back, so it is held to the same two privacy gates as the hover: nothing is touched in a
 * private window (or when that cannot be told), and nothing for a site on the exclusion list.
 * Which keys pass is decided by `thumbs.keysToKeep()`, the same code that backs `peekUrl()`,
 * not here.
 */

import * as i18n from '../common/i18n.js';
import * as log from '../common/log.js';
import { touch as touchThumbs } from '../common/thumb-store.js';
import {
  THUMB_ASPECT,
  FAVICON_SIZE,
  TOUCH_DISPLAYED_INTERVAL_MS,
  faviconUrl,
} from '../common/constants.js';
import { placePreview } from './bookmark-math.js';

const t = (key, subs) => i18n.t(key, subs);

/** How long the pointer rests on a row before its card shows. */
const SHOW_DELAY_MS = 350;

/** A card that went down this recently makes the next row's card immediate. */
const HURRY_WINDOW_MS = 400;

/** Hovered keys remembered for the touch throttle; more than any one sitting needs. */
const MAX_HOVER_KEYS = 500;

/**
 * Start watching a bookmark list.
 *
 * @param {object} args
 * @param {any} args.ctx the shared panel context (settings, `subscribe`, `thumbs`)
 * @param {HTMLElement} args.rail the scrolling column
 * @param {HTMLElement} args.list the flat list of rows
 * @returns {{ detach: () => void, rendered: () => void }}
 */
export function attach({ ctx, rail, list }) {
  const peek = ctx && ctx.thumbs && typeof ctx.thumbs.peekUrl === 'function'
    ? ctx.thumbs.peekUrl
    : null;
  // Without it nothing is kept: a touch that cannot be checked against the privacy gates is
  // not made.
  const keep = ctx && ctx.thumbs && typeof ctx.thumbs.keysToKeep === 'function'
    ? ctx.thumbs.keysToKeep
    : null;

  /** @type {HTMLElement|null} the link row the pointer is on */
  let row = null;
  /** @type {HTMLElement|null} the row a click dismissed the card for; quiet until the pointer leaves it */
  let quietRow = null;
  /** @type {HTMLElement|null} the row the card on screen describes */
  let shownRow = null;
  /** @type {HTMLElement|null} */
  let card = null;
  let objectUrl = '';
  /** @type {{ row: HTMLElement, title: string }|null} the native tooltip taken off a row */
  let stashed = null;
  let timer = 0;
  /** Rises whenever a pending or in-flight show must be forgotten. */
  let seq = 0;
  let hiddenAt = -Infinity;
  let detached = false;

  let lastRowsTouchAt = 0;
  let rowsTouchTimer = 0;
  /** @type {Map<string, number>} urlKey -> when the hover last touched it */
  const hoverTouched = new Map();

  const enabled = () => {
    const settings = ctx && typeof ctx.getSettings === 'function' ? ctx.getSettings() : null;
    return !(settings && settings.showThumbnails === false);
  };
  const settingsSig = (settings) => JSON.stringify([
    !(settings && settings.showThumbnails === false),
    (settings && settings.excludedHosts) || [],
  ]);
  let lastSig = settingsSig(ctx && typeof ctx.getSettings === 'function' ? ctx.getSettings() : null);

  /* ── The pointer ─────────────────────────────────────────────────────────── */

  /** @param {EventTarget|null} target @returns {HTMLElement|null} a link row, or null */
  function linkRowOf(target) {
    if (!(target instanceof Element)) return null;
    const el = target.closest('[data-bookmark-id]');
    return el instanceof HTMLElement && el.dataset.kind === 'link' && el.dataset.bookmarkUrl
      ? el
      : null;
  }

  /** @param {PointerEvent} event */
  function onOver(event) {
    if (event.pointerType === 'touch') return; // a finger has no hover, only a tap that opens
    const next = linkRowOf(event.target);
    if (next === row) return; // between the children of the row it is already on
    row = next;
    if (next && next !== quietRow) begin(next);
  }

  /** @param {PointerEvent} event */
  function onOut(event) {
    const from = linkRowOf(event.target);
    if (!from) return;
    if (linkRowOf(event.relatedTarget) === from) return; // still inside the row
    if (quietRow === from) quietRow = null;
    if (row === from) {
      row = null;
      hide();
    }
  }

  /** A mouse button went down: whatever it does, the card has done its job. */
  function onDown() {
    quietRow = row;
    hide();
  }

  /** @param {HTMLElement} next */
  function begin(next) {
    if (!enabled()) return;
    stashTooltip(next);
    clearTimeout(timer);
    const mine = (seq += 1);
    if (performance.now() - hiddenAt < HURRY_WINDOW_MS) {
      void show(next, mine);
    } else {
      timer = setTimeout(() => void show(next, mine), SHOW_DELAY_MS);
    }
  }

  /**
   * @param {HTMLElement} target
   * @param {number} mine the `seq` this show was started under
   */
  async function show(target, mine) {
    timer = 0;
    const stale = () => detached || mine !== seq || row !== target || !target.isConnected;
    if (stale() || !peek) return;
    const url = target.dataset.bookmarkUrl || '';
    let info;
    try {
      info = await peek(url);
    } catch (e) {
      log.warn('bookmark preview lookup', e);
      return;
    }
    // The pointer may have gone, the row been replaced or previews turned off while the
    // store was being read.
    if (stale() || !enabled()) return;
    render(target, url, info);
  }

  /* ── The card ────────────────────────────────────────────────────────────── */

  /**
   * @param {HTMLElement} target
   * @param {string} url
   * @param {{ state: string, key: string|null, blob: Blob|null, avgColor: number[]|null }} info
   */
  function render(target, url, info) {
    dropCard();
    const el = document.createElement('div');
    el.id = 'bookmark-preview';
    el.className = 'bmk-peek';
    el.dataset.testid = 'bookmark-preview';
    el.dataset.state = info.state;
    // The row already says all of this to assistive technology; a second reading of it,
    // positioned somewhere else, would only be noise.
    el.setAttribute('aria-hidden', 'true');

    const shot = document.createElement('div');
    shot.className = 'bmk-peek__shot';

    const img = document.createElement('img');
    img.className = 'bmk-peek__img';
    img.dataset.testid = 'bookmark-preview-img';
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;

    if (info.state === 'loaded' && info.blob) {
      try {
        objectUrl = URL.createObjectURL(info.blob);
        img.src = objectUrl;
      } catch (e) {
        log.warn('bookmark preview createObjectURL', e);
        objectUrl = '';
      }
    }
    if (objectUrl) {
      // The average colour paints the box before the JPEG decodes, as it does on a card.
      if (info.avgColor) {
        shot.style.backgroundColor = `rgb(${info.avgColor[0]}, ${info.avgColor[1]}, ${info.avgColor[2]})`;
      }
      shot.append(img);
    } else {
      // No picture: never an <img> with a src, and never src="" (which re-requests the
      // document). The slot stays, empty and hidden, so the card is the same size either way.
      img.hidden = true;
      el.dataset.state = info.state === 'loaded' ? 'none' : info.state;
      shot.append(img, noPicture(url, el.dataset.state));
    }

    const cap = document.createElement('div');
    cap.className = 'bmk-peek__cap';
    const title = document.createElement('div');
    title.className = 'bmk-peek__title';
    title.dataset.testid = 'bookmark-preview-title';
    const main = target.querySelector('.w-row__main');
    title.textContent = (main && main.textContent) || url;
    const host = document.createElement('div');
    host.className = 'bmk-peek__host';
    host.dataset.testid = 'bookmark-preview-host';
    host.textContent = hostOf(url);
    cap.append(title, host);

    el.append(shot, cap);
    document.body.append(el);
    card = el;
    shownRow = target;
    place(el, shot, cap, target);

    if (info.state === 'loaded' && info.key) touchHovered(info.key);
  }

  /**
   * The favicon and the reason, in the words a tab card uses for the same reason.
   * @param {string} url
   * @param {string} state
   */
  function noPicture(url, state) {
    const none = document.createElement('div');
    none.className = 'bmk-peek__none';
    const fav = document.createElement('span');
    fav.className = 'bmk-peek__fav';
    // A CSS background, not an <img>: the card has no image element with a src when there
    // is no screenshot, and the icon is decoration. `_favicon` answers in-process.
    const icon = faviconUrl(url, FAVICON_SIZE);
    if (icon) fav.style.backgroundImage = `url("${icon}")`;
    const hint = document.createElement('span');
    hint.className = 'bmk-peek__hint';
    hint.dataset.testid = 'bookmark-preview-hint';
    hint.textContent = hintFor(state);
    none.append(fav, hint);
    return none;
  }

  /**
   * Size and position the card. The picture's box comes from `placePreview`; the caption
   * under it is whatever height its text needs at that width, measured once, so the flip
   * above the row is decided on the whole card.
   */
  function place(el, shot, cap, target) {
    const rect = target.getBoundingClientRect();
    const viewport = { w: window.innerWidth, h: window.innerHeight };
    let box = placePreview({ rowRect: rect, viewport, aspect: THUMB_ASPECT });
    el.style.width = `${box.width}px`;
    shot.style.height = `${box.height}px`;
    box = placePreview({
      rowRect: rect, viewport, aspect: THUMB_ASPECT, extraHeight: cap.offsetHeight,
    });
    el.style.left = `${box.left}px`;
    el.style.top = `${box.top}px`;
  }

  /** Take the card down and give back its object URL. */
  function dropCard() {
    const gone = objectUrl;
    objectUrl = '';
    if (card) card.remove();
    card = null;
    shownRow = null;
    if (gone) {
      try {
        URL.revokeObjectURL(gone);
      } catch {
        /* already gone */
      }
    }
  }

  /** Everything that ends or forgets a card: nothing pending, nothing showing. */
  function hide() {
    clearTimeout(timer);
    timer = 0;
    seq += 1;
    if (card) {
      hiddenAt = performance.now();
      dropCard();
    }
    restoreTooltip();
  }

  /* ── The row's own tooltip ───────────────────────────────────────────────── */

  /** @param {HTMLElement} target */
  function stashTooltip(target) {
    if (stashed && stashed.row === target) return;
    restoreTooltip();
    const title = target.getAttribute('title');
    if (title === null) return;
    stashed = { row: target, title };
    target.removeAttribute('title');
  }

  function restoreTooltip() {
    const held = stashed;
    stashed = null;
    // A row a repaint replaced is gone; its successor was built with its own title.
    if (held && held.row.isConnected && held.row.getAttribute('title') === null) {
      held.row.setAttribute('title', held.title);
    }
  }

  /* ── Keeping the pictures ────────────────────────────────────────────────── */

  /** @param {string} key */
  function touchHovered(key) {
    const now = Date.now();
    if (now - (hoverTouched.get(key) || 0) < TOUCH_DISPLAYED_INTERVAL_MS) return;
    if (hoverTouched.size >= MAX_HOVER_KEYS) hoverTouched.clear();
    hoverTouched.set(key, now);
    void Promise.resolve(touchThumbs([key], now)).catch((e) => log.warn('bookmark preview touch', e));
  }

  /** Touch every rendered link row's key, at most once per 30 s, with a trailing run. */
  function scheduleRowsTouch() {
    if (detached || !enabled()) return;
    // Cheap "is there anything": a paint calls this once per chunk and a folder can be 5 000 rows.
    if (!list.querySelector('[data-bookmark-key]')) return;
    const wait = TOUCH_DISPLAYED_INTERVAL_MS - (Date.now() - lastRowsTouchAt);
    if (wait <= 0) {
      void runRowsTouch();
    } else if (!rowsTouchTimer) {
      rowsTouchTimer = setTimeout(() => {
        rowsTouchTimer = 0;
        void runRowsTouch();
      }, wait);
    }
  }

  async function runRowsTouch() {
    if (detached || !enabled() || !keep) return;
    const urls = new Set();
    for (const el of list.querySelectorAll('[data-bookmark-key]')) {
      if (el instanceof HTMLElement && el.dataset.bookmarkUrl) urls.add(el.dataset.bookmarkUrl);
    }
    if (!urls.size) return;
    // Stamped before the privacy check is awaited: the throttle counts a run, not its outcome,
    // and a paint calls `scheduleRowsTouch()` once per chunk while this is still pending.
    const at = Date.now();
    lastRowsTouchAt = at;
    let keys;
    try {
      keys = await keep([...urls]);
    } catch (e) {
      log.warn('bookmark preview keep', e);
      return;
    }
    // The panel may have been closed, or previews turned off, while the window was identified.
    if (detached || !enabled() || !keys.length) return;
    void Promise.resolve(touchThumbs(keys, at)).catch((e) => log.warn('bookmark preview touch', e));
  }

  /* ── Wiring ──────────────────────────────────────────────────────────────── */

  const onKeyDown = (event) => {
    if (event.key === 'Escape') hide();
  };
  const onSettings = (settings) => {
    const next = settingsSig(settings);
    if (next === lastSig) return;
    lastSig = next;
    hide();
  };
  // A repaint rebuilds every row. A pointer over a row that has been replaced gets no
  // `pointerout` for it, so the list itself is watched for the row going.
  const observer = typeof MutationObserver === 'function'
    ? new MutationObserver(() => {
      if (row && !row.isConnected) row = null;
      if (quietRow && !quietRow.isConnected) quietRow = null;
      if (shownRow && !shownRow.isConnected) hide();
      else if (stashed && !stashed.row.isConnected) stashed = null;
    })
    : null;

  list.addEventListener('pointerover', onOver);
  list.addEventListener('pointerout', onOut);
  list.addEventListener('pointerdown', onDown);
  list.addEventListener('contextmenu', hide);
  rail.addEventListener('scroll', hide, { passive: true });
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('dragstart', hide, true);
  window.addEventListener('blur', hide);
  window.addEventListener('pagehide', hide);
  if (observer) observer.observe(list, { childList: true });
  const offSettings = ctx && typeof ctx.subscribe === 'function'
    ? ctx.subscribe('settings', onSettings)
    : null;

  return {
    rendered: scheduleRowsTouch,
    detach() {
      if (detached) return;
      detached = true;
      hide();
      clearTimeout(rowsTouchTimer);
      rowsTouchTimer = 0;
      list.removeEventListener('pointerover', onOver);
      list.removeEventListener('pointerout', onOut);
      list.removeEventListener('pointerdown', onDown);
      list.removeEventListener('contextmenu', hide);
      rail.removeEventListener('scroll', hide);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('dragstart', hide, true);
      window.removeEventListener('blur', hide);
      window.removeEventListener('pagehide', hide);
      if (observer) observer.disconnect();
      if (typeof offSettings === 'function') offSettings();
    },
  };
}

/* ── Words ─────────────────────────────────────────────────────────────────── */

/**
 * The reason there is no picture, in the tab card's own sentence for the same reason.
 * Spelled out one `t('…')` at a time so the key scanners in the unit tests can see every one.
 * @param {string} state a `peekUrl` verdict other than `loaded`
 */
function hintFor(state) {
  switch (state) {
    case 'restricted': return t('previewUnavailable');
    case 'excluded': return t('previewExcluded');
    case 'incognito': return t('previewIncognito');
    case 'policy': return t('previewDisabledByPolicy');
    case 'no-access': return t('previewNoSiteAccess');
    default: return t('bookmarkPreviewNone');
  }
}

/**
 * Where the page lives, as short as is still true. A URL with no host (`javascript:`, `data:`,
 * `file:///…`, `about:`) says only its scheme: `javascript://` would be a made-up address.
 * `URL#host` carries no credentials, so a `user:password@` in a bookmark never reaches the card.
 */
function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.host;
    return u.host ? `${u.protocol}//${u.host}` : u.protocol;
  } catch {
    return url;
  }
}
