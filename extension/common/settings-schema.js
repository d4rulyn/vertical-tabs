/**
 * Settings shape, defaults and validation (spec.md §4.3 / §10, amended by
 * spec-addendum A12; A11's `layout` enum is superseded by `columns`).
 *
 * PURE: no `chrome.*`, no I/O — `tests/unit/settings-schema.test.mjs` imports it
 * directly. `settings.js` is the thin `chrome.storage.local` wrapper around it.
 */

/**
 * Bumped only when a migration becomes necessary.
 * 2 — the three-way `layout` enum became the integer `columns` (1…5).
 */
export const SETTINGS_VERSION = 2;

/**
 * The complete default settings object.
 *
 * `columns` replaces the old `layout` enum: the user picks how many columns of
 * cards the panel shows, 1 to 5, and **one** is the default because a single
 * full-width card per row is what a vertical tab bar is meant to look like. This
 * overrides spec-addendum A11, which had made the two-per-row compact grid the
 * default. `captureBeforeSwitch` is from spec-addendum A12.
 */
export const DEFAULTS = Object.freeze({
  version: SETTINGS_VERSION,
  theme: 'system',
  columns: 1,
  cardWidth: 0,
  // On by default. Chrome's 360 px floor means a single column of tabs leaves most of
  // the panel empty whatever the card size, so the choice is not "tabs or tools" but
  // "tools or nothing" — and at the default card size the tab column is still wider
  // than a conventional vertical tab strip. Each tool is switchable, and clearing
  // the list hides the column entirely.
  widgets: ['sessions', 'recent', 'windows', 'autoGroup', 'duplicates', 'staleTabs', 'scratchpad'],
  // Which of the two things the column beside the tabs is showing. `tools` is what
  // every install has had so far, so an update changes nothing until the user asks.
  railMode: 'tools',
  showThumbnails: true,
  previewMoment: 'top',
  refreshInterval: '1m',
  captureWhenPanelClosed: true,
  captureBeforeSwitch: true,
  persistThumbnails: true,
  excludedHosts: [],
  pinnedGrid: true,
  middleClickCloses: true,
  doubleClickNewTab: true,
  showUnreadDot: true,
  clickActiveTabSwitchesBack: false,
  confirmCloseThreshold: 5,
});

/** `chrome.alarms` period, in minutes, per `refreshInterval` (spec.md §4.3). */
export const REFRESH_PERIODS = Object.freeze({
  off: null,
  '30s': 0.5,
  '1m': 1,
  '5m': 5,
});

export const THEMES = Object.freeze(['system', 'dark', 'light']);
export const REFRESH_INTERVALS = Object.freeze(Object.keys(REFRESH_PERIODS));

/**
 * What a preview is allowed to show — the answer to "which moment of the page is
 * this a picture of".
 *
 * `captureVisibleTab` photographs the viewport, so a preview is only ever a picture
 * of wherever the reader happened to be. Chrome restores the scroll offset on
 * reload, so pressing F5 half way down an article produces a thumbnail of that half
 * way point: a strip of body text that identifies nothing. The header is what makes
 * a page recognisable at 160 px, which is why `top` is the default.
 *
 *  - `top`      keep the preview on the top of the page. A capture is taken while
 *               the viewport is at the top; when the reader has scrolled, an
 *               existing top-of-page preview is KEPT rather than overwritten. A page
 *               with no preview yet is captured wherever it sits, so a tab is never
 *               left blank waiting for someone to scroll up.
 *  - `reload`   the preview is whatever the page showed when it last loaded.
 *               Only a navigation (or an explicit refresh) replaces it.
 *  - `interval` the preview follows the reader: every capture replaces it, which is
 *               what `refreshInterval` and switching tabs already do.
 */
export const PREVIEW_MOMENTS = Object.freeze(['top', 'reload', 'interval']);

/**
 * @param {unknown} value
 * @returns {string} one of `PREVIEW_MOMENTS`; anything else becomes the default
 */
export function normalizePreviewMoment(value) {
  return enumOr(value, PREVIEW_MOMENTS, DEFAULTS.previewMoment);
}

export const CONFIRM_CLOSE_MIN = 2;
export const CONFIRM_CLOSE_MAX = 50;

/** The column count the user may choose. One is the default (see `DEFAULTS`). */
export const COLUMNS_MIN = 1;
export const COLUMNS_MAX = 5;
/** `[1, 2, 3, 4, 5]` — what the settings drawer offers, in order. */
export const COLUMN_CHOICES = Object.freeze(
  Array.from({ length: COLUMNS_MAX - COLUMNS_MIN + 1 }, (_, i) => COLUMNS_MIN + i),
);

/**
 * Migration for settings written before `columns` existed (`SETTINGS_VERSION` 1).
 *
 *  - `list` was one full-width card per row                       → 1
 *  - `grid` was `auto-fill` at a 158 px minimum, i.e. two columns
 *    at Chrome's 360 px minimum panel width                       → 2
 *  - `auto` was `grid` whenever two cards fit, which they do at
 *    every width the side panel can actually have                 → 2
 *
 * Anything else falls through to `DEFAULTS.columns`.
 */
export const LEGACY_LAYOUT_COLUMNS = Object.freeze({ list: 1, grid: 2, auto: 2 });

/**
 * The CSS layout family a column count belongs to, mirrored onto
 * `<html data-layout>` so styling and drag-and-drop can branch on "single
 * column" versus "several columns" without re-deriving the rule.
 * @param {unknown} columns
 * @returns {'list'|'grid'}
 */
export function layoutForColumns(columns) {
  return normalizeColumns(columns) > 1 ? 'grid' : 'list';
}

/**
 * Coerce anything to a valid column count: integers are clamped into
 * `[COLUMNS_MIN, COLUMNS_MAX]`, everything else becomes the default.
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeColumns(value) {
  return clampInt(value, COLUMNS_MIN, COLUMNS_MAX, DEFAULTS.columns);
}

/**
 * Card width cap, in CSS pixels. `0` means "fill the column", which is the default
 * and what the panel has always done.
 *
 * Chrome owns the side panel's own width — `sidePanel.setOptions({width})` is
 * rejected outright ("Unexpected property: 'width'"), `getLayout()` reports only which
 * side it is docked on, and the minimum inner width is hard-coded at 360 px (raised
 * from 320; a Chrome engineer has confirmed on chromium-extensions that extensions
 * cannot change it and no flag exists). Sizing the cards is therefore the only control
 * an extension has over how the strip looks, and a chosen size packs the row rather
 * than leaving a gutter: 160 px in the minimum panel gives two columns of the size a
 * vertical tab strip is usually drawn at.
 */
export const CARD_WIDTH_FILL = 0;
export const CARD_WIDTH_CHOICES = Object.freeze([CARD_WIDTH_FILL, 160, 200, 240, 280, 320]);

/**
 * A stored card width, or the default. Anything not offered in the drawer falls back
 * rather than being clamped: a width between two choices would not round-trip
 * through the select.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeCardWidth(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return CARD_WIDTH_CHOICES.includes(n) ? n : DEFAULTS.cardWidth;
}

/**
 * The tools the column can show, in the order the settings drawer offers them.
 *
 * The column exists because Chrome will not let the panel be narrower than 360 px: a
 * single column of tabs leaves most of that width idle, so it is spent on things that
 * help with the tabs. All of them work from data the extension already has — no tool
 * here reaches the network, and none should.
 */
export const WIDGET_IDS = Object.freeze([
  'sessions', 'recent', 'windows', 'autoGroup', 'duplicates', 'staleTabs', 'listIO',
  'nowPlaying', 'scratchpad',
]);

/**
 * An ordered list of enabled widget ids. Unknown ids are dropped rather than kept,
 * so a list written by a newer version degrades to what this one can actually build,
 * and duplicates collapse.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeWidgets(value) {
  if (!Array.isArray(value)) return [...DEFAULTS.widgets];
  const seen = new Set();
  const out = [];
  for (const id of value) {
    if (typeof id !== 'string' || !WIDGET_IDS.includes(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * What the column beside the tab list is for.
 *
 *  - `tools`     the widgets the user ticked, i.e. `widgets`. The default, because it
 *                is what every existing install already shows.
 *  - `bookmarks` the bookmark rail instead. The tool rail is hidden by being handed a
 *                DERIVED empty list; `widgets` itself is never rewritten, so flipping
 *                back restores the user's own set of tools exactly.
 */
export const RAIL_MODES = Object.freeze(['tools', 'bookmarks']);

/**
 * @param {unknown} value
 * @returns {string} one of `RAIL_MODES`; anything else becomes the default
 */
export function normalizeRailMode(value) {
  return enumOr(value, RAIL_MODES, DEFAULTS.railMode);
}

/** Keys whose value is a plain boolean. */
const BOOLEAN_KEYS = Object.freeze([
  'showThumbnails',
  'captureWhenPanelClosed',
  'captureBeforeSwitch',
  'persistThumbnails',
  'pinnedGrid',
  'middleClickCloses',
  'doubleClickNewTab',
  'showUnreadDot',
  'clickActiveTabSwitchesBack',
]);

/** Every recognised settings key; anything else in stored data is dropped. */
export const SETTINGS_KEYS = Object.freeze(Object.keys(DEFAULTS));

/**
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @param {string} fallback
 * @returns {string}
 */
function enumOr(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Lower-case, trim and de-duplicate the excluded-host patterns while preserving
 * what the user typed (IDN hosts stay in their unicode form; `hostMatches()`
 * converts to punycode at compare time).
 *
 * A newline-separated string is accepted as well as an array, because the
 * settings drawer edits this value in a `<textarea>`.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeExcludedHosts(value) {
  // `excludedHosts` is typed `string[]` (spec.md §10). The settings drawer splits
  // its textarea with `parseHosts()` before saving, so a bare string reaching here
  // is malformed input and normalises to an empty list rather than being guessed at.
  if (!Array.isArray(value)) return [];
  /** @type {unknown[]} */
  const list = value;

  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const host = raw.trim().toLowerCase();
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
  return out;
}

/**
 * Reduce a user-typed pattern or a hostname to a comparable form: strip an
 * accidental scheme/path, apply IDNA (the WHATWG URL parser does it for free in
 * both Chrome and Node) and drop a trailing root dot.
 * @param {string} value
 * @returns {string}
 */
function canonicalHost(value) {
  let host = value.trim().toLowerCase();
  if (!host) return '';
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // "https://example.com/x" → "example.com/x"
  host = host.split('/')[0];
  host = host.replace(/\.+$/, '');
  if (!host) return '';
  try {
    const parsed = new URL(`http://${host}`);
    return parsed.hostname.replace(/\.+$/, '');
  } catch {
    return host;
  }
}

/**
 * Match a hostname against the user's exclusion patterns (spec.md §4.1):
 * `example.com` matches exactly, `*.example.com` matches the apex **and** every
 * subdomain. Comparison is case-insensitive and done on punycode hostnames.
 *
 * @param {unknown} hostname
 * @param {unknown} patterns
 * @returns {boolean}
 */
export function hostMatches(hostname, patterns) {
  if (typeof hostname !== 'string' || !hostname) return false;
  if (!Array.isArray(patterns) || patterns.length === 0) return false;

  const host = canonicalHost(hostname);
  if (!host) return false;

  for (const raw of patterns) {
    if (typeof raw !== 'string') continue;
    const pattern = raw.trim().toLowerCase();
    if (!pattern) continue;

    if (pattern.startsWith('*.')) {
      const apex = canonicalHost(pattern.slice(2));
      if (!apex) continue;
      if (host === apex || host.endsWith(`.${apex}`)) return true;
    } else {
      const exact = canonicalHost(pattern);
      if (exact && host === exact) return true;
    }
  }
  return false;
}

/**
 * Resolve the column count of a raw stored object, migrating settings written
 * before `columns` existed.
 *
 * `columns` wins whenever it is present and numeric, because it is the key this
 * version writes; a stored `layout` is only ever read when there is no
 * `columns` to read instead. `normalizeSettings()` never emits `layout`, so a
 * settings object that still carries one has not been through this version yet
 * (or was hand-written by a test) and is migrated exactly once.
 *
 * @param {any} src raw stored settings
 * @returns {number}
 */
function migrateColumns(src) {
  if (src.columns != null) return normalizeColumns(src.columns);
  if (typeof src.layout === 'string') {
    const migrated = LEGACY_LAYOUT_COLUMNS[/** @type {'list'} */ (src.layout)];
    if (migrated != null) return migrated;
  }
  return DEFAULTS.columns;
}

/**
 * Merge stored data over the defaults: unknown keys are dropped, enums that do
 * not match fall back to their default, integers are clamped, and
 * `excludedHosts` is normalised. Never throws; always returns a complete,
 * self-consistent object that is safe to hand to the UI and the scheduler.
 *
 * @param {unknown} raw
 * @returns {typeof DEFAULTS & { excludedHosts: string[] }}
 */
export function normalizeSettings(raw) {
  /** @type {any} */
  const out = { ...DEFAULTS, excludedHosts: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;

  /** @type {any} */
  const src = raw;

  out.version = SETTINGS_VERSION;
  out.theme = enumOr(src.theme, THEMES, DEFAULTS.theme);
  out.columns = migrateColumns(src);
  out.cardWidth = normalizeCardWidth(src.cardWidth);
  out.widgets = normalizeWidgets(src.widgets);
  out.railMode = normalizeRailMode(src.railMode);
  out.refreshInterval = enumOr(src.refreshInterval, REFRESH_INTERVALS, DEFAULTS.refreshInterval);
  out.previewMoment = normalizePreviewMoment(src.previewMoment);

  for (const key of BOOLEAN_KEYS) {
    out[key] = typeof src[key] === 'boolean' ? src[key] : DEFAULTS[key];
  }

  out.confirmCloseThreshold = clampInt(
    src.confirmCloseThreshold,
    CONFIRM_CLOSE_MIN,
    CONFIRM_CLOSE_MAX,
    DEFAULTS.confirmCloseThreshold,
  );

  out.excludedHosts = normalizeExcludedHosts(src.excludedHosts);

  return out;
}

/**
 * The alarm period, in minutes, implied by a settings object — `null` means the
 * refresh alarm must be cleared (spec.md §7.7).
 * @param {{refreshInterval?: string}} settings
 * @returns {number|null}
 */
export function refreshPeriodMinutes(settings) {
  const key = settings && typeof settings.refreshInterval === 'string' ? settings.refreshInterval : '';
  const period = REFRESH_PERIODS[/** @type {keyof typeof REFRESH_PERIODS} */ (key)];
  return period === undefined ? REFRESH_PERIODS[DEFAULTS.refreshInterval] : period;
}
