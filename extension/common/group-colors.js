/**
 * Tab-group colours (spec.md §4.8).
 *
 * `chrome.tabGroups` exposes colour *names*, never hex values, and Chromium's
 * refresh palette (`tab_group_color_ids.h`) is not published as documentation —
 * these values approximate it, which the README lists as a known limitation.
 *
 * `dark` is the swatch/text colour used on the dark theme (light ink on a dark
 * card); `light` is the one used on the light theme.
 *
 * The same values are mirrored in `sidepanel.css` as the custom properties
 * `--vt-group-<color>`; `groupColorVarName()` builds that name so JS and CSS
 * cannot drift apart.
 */

/** @typedef {'grey'|'blue'|'red'|'yellow'|'green'|'pink'|'purple'|'cyan'|'orange'} GroupColor */

/** @type {Readonly<Record<GroupColor, {dark: string, light: string}>>} */
export const GROUP_COLORS = Object.freeze({
  grey: { dark: '#DFE2E9', light: '#5F6369' },
  blue: { dark: '#A8BCFF', light: '#436BD7' },
  red: { dark: '#FF928B', light: '#DB1B2B' },
  yellow: { dark: '#FFDD7A', light: '#FFD036' },
  green: { dark: '#87EB84', light: '#188129' },
  pink: { dark: '#FF96DE', light: '#C809A8' },
  purple: { dark: '#CB93FF', light: '#9D39F3' },
  cyan: { dark: '#88E3EB', light: '#007B83' },
  orange: { dark: '#FFB379', light: '#FF9436' },
});

/**
 * The `chrome.tabGroups.Color` enum in Chrome's own order — the order the
 * colour picker renders its nine swatches in.
 * @type {ReadonlyArray<GroupColor>}
 */
export const GROUP_COLOR_IDS = Object.freeze(
  /** @type {GroupColor[]} */ (Object.keys(GROUP_COLORS)),
);

/** Fallback for an unknown colour name from a future Chrome. */
export const DEFAULT_GROUP_COLOR = /** @type {GroupColor} */ ('grey');

/** i18n message key per colour, for the "Change color" submenu (spec.md §9.3). */
export const GROUP_COLOR_LABEL_KEYS = Object.freeze({
  grey: 'colorGrey',
  blue: 'colorBlue',
  red: 'colorRed',
  yellow: 'colorYellow',
  green: 'colorGreen',
  pink: 'colorPink',
  purple: 'colorPurple',
  cyan: 'colorCyan',
  orange: 'colorOrange',
});

/**
 * @param {unknown} color
 * @returns {GroupColor} `color` when Chrome knows it, otherwise `'grey'`
 */
export function normalizeGroupColor(color) {
  return typeof color === 'string' && color in GROUP_COLORS
    ? /** @type {GroupColor} */ (color)
    : DEFAULT_GROUP_COLOR;
}

/**
 * @param {unknown} color a `chrome.tabGroups.Color` value
 * @param {'dark'|'light'} [theme] the *resolved* theme, never `'system'`
 * @returns {string} `#RRGGBB`
 */
export function groupColorHex(color, theme = 'dark') {
  const entry = GROUP_COLORS[normalizeGroupColor(color)];
  return theme === 'light' ? entry.light : entry.dark;
}

/**
 * Name of the CSS custom property carrying this colour, e.g.
 * `--vt-group-blue`. The stylesheet defines one per colour and per theme, so
 * the renderer can set `style.setProperty('--vt-group-current', 'var(--vt-group-blue)')`
 * instead of hard-coding hex in JS.
 * @param {unknown} color
 * @returns {string}
 */
export function groupColorVarName(color) {
  return `--vt-group-${normalizeGroupColor(color)}`;
}

/**
 * `var(--vt-group-blue)` — ready to assign to a `style` property.
 * @param {unknown} color
 * @returns {string}
 */
export function groupColorVar(color) {
  return `var(${groupColorVarName(color)})`;
}

/**
 * Every custom property for one theme, for stylesheets generated at runtime or
 * for tests that compare CSS with this module.
 * @param {'dark'|'light'} theme
 * @returns {Record<string, string>}
 */
export function groupColorCustomProperties(theme) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const color of GROUP_COLOR_IDS) out[groupColorVarName(color)] = groupColorHex(color, theme);
  return out;
}
