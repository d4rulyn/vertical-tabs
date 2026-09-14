/**
 * The in-panel settings drawer (spec.md §10, spec-addendum A12/A16/A17).
 *
 * Settings live in `chrome.storage.local` (not `sync`: an 8 KB per-item cap and
 * a 120-writes-per-minute quota would make the excluded-hosts textarea a
 * hazard). Every control writes exactly one `saveSettings(patch)` per user
 * action; the textarea is additionally debounced so typing is not a write per
 * keystroke. The service worker reacts to `storage.onChanged` by re-running
 * `ensureAlarms()`, and every open panel re-applies theme/layout attributes.
 *
 * DOM touched: `#settings-view`, `#btn-settings`.
 */

import * as log from '../common/log.js';
import * as thumbStore from '../common/thumb-store.js';
import { loadSettings, saveSettings, onSettingsChange } from '../common/settings.js';
import { DEFAULTS, COLUMN_CHOICES, CARD_WIDTH_CHOICES, CARD_WIDTH_FILL, WIDGET_IDS } from '../common/settings-schema.js';
import {
  SETTINGS_TEXT_DEBOUNCE_MS,
  CHROME_SHORTCUTS_URL,
  REPOSITORY_URL,
} from '../common/constants.js';
import * as ops from './tab-ops.js';
import { t, toast, confirmBar } from './toast.js';

const MSG = ops.MSG;

/* ── state ────────────────────────────────────────────────────────────────── */

/** @type {any} */
let ctx = null;
/** @type {HTMLElement|null} */
let drawer = null;
/** @type {HTMLElement|null} */
let button = null;
/** @type {Element|null} */
let lastFocused = null;
/** @type {any} */
let settings = { ...DEFAULTS };
let open = false;
let built = false;
let bound = false;
let textTimer = 0;

/* ── the control table (spec.md §10) ──────────────────────────────────────── */

/**
 * @typedef {Object} Row
 * @property {string} key
 * @property {'select'|'checkbox'|'number'|'textarea'} type
 * @property {string} labelKey
 * @property {string} [helpKey]
 * @property {[string, string][]} [options] `[value, i18nKey]`
 * @property {boolean} [numeric] a `select` whose value is stored as a number
 * @property {number} [min]
 * @property {number} [max]
 */

/** @type {{ titleKey: string, rows: Row[] }[]} */
const SECTIONS = [
  {
    titleKey: 'settingsAppearance',
    rows: [
      {
        key: 'theme',
        type: 'select',
        labelKey: 'settingsTheme',
        options: [
          ['system', 'themeSystem'],
          ['dark', 'themeDark'],
          ['light', 'themeLight'],
        ],
      },
      {
        key: 'columns',
        type: 'select',
        numeric: true,
        labelKey: 'settingsColumns',
        helpKey: 'settingsColumnsHelp',
        options: COLUMN_CHOICES.map((n) => [String(n), `columns${n}`]),
      },
      {
        key: 'cardWidth',
        type: 'select',
        numeric: true,
        labelKey: 'settingsCardWidth',
        helpKey: 'settingsCardWidthHelp',
        options: CARD_WIDTH_CHOICES.map((px) => [
          String(px),
          px === CARD_WIDTH_FILL ? 'cardWidthFill' : `cardWidth${px}`,
        ]),
      },
      { key: 'showThumbnails', type: 'checkbox', labelKey: 'settingsShowThumbnails' },
      { key: 'pinnedGrid', type: 'checkbox', labelKey: 'settingsPinnedGrid' },
    ],
  },
  {
    titleKey: 'settingsWidgets',
    helpKey: 'settingsWidgetsHelp',
    rows: WIDGET_IDS.map((id) => ({
      key: `widget-${id}`,
      type: 'widget',
      widgetId: id,
      labelKey: `widget${id.charAt(0).toUpperCase()}${id.slice(1)}`,
    })),
  },
  {
    titleKey: 'settingsBehavior',
    rows: [
      { key: 'middleClickCloses', type: 'checkbox', labelKey: 'settingsMiddleClick' },
      { key: 'doubleClickNewTab', type: 'checkbox', labelKey: 'settingsDoubleClickNewTab' },
      { key: 'clickActiveTabSwitchesBack', type: 'checkbox', labelKey: 'settingsClickActiveSwitchesBack' },
      { key: 'showUnreadDot', type: 'checkbox', labelKey: 'settingsUnreadDot' },
      { key: 'confirmCloseThreshold', type: 'number', labelKey: 'settingsConfirmThreshold', min: 2, max: 50 },
    ],
  },
  {
    titleKey: 'settingsPreviews',
    rows: [
      {
        key: 'previewMoment',
        type: 'select',
        labelKey: 'settingsPreviewMoment',
        helpKey: 'settingsPreviewMomentHelp',
        options: [
          ['top', 'previewMomentTop'],
          ['reload', 'previewMomentReload'],
          ['interval', 'previewMomentInterval'],
        ],
      },
      {
        key: 'refreshInterval',
        type: 'select',
        labelKey: 'settingsRefresh',
        options: [
          ['off', 'refreshOff'],
          ['30s', 'refresh30s'],
          ['1m', 'refresh1m'],
          ['5m', 'refresh5m'],
        ],
      },
      { key: 'captureWhenPanelClosed', type: 'checkbox', labelKey: 'settingsCaptureWhenClosed' },
      { key: 'captureBeforeSwitch', type: 'checkbox', labelKey: 'settingsCaptureBeforeSwitch' },
      { key: 'persistThumbnails', type: 'checkbox', labelKey: 'settingsPersistThumbs' },
      {
        key: 'excludedHosts',
        type: 'textarea',
        labelKey: 'settingsExcludedHosts',
        helpKey: 'settingsExcludedHostsHelp',
      },
    ],
  },
];

/* ── init ─────────────────────────────────────────────────────────────────── */

/** @param {any} context */
export function init(context) {
  ctx = ops.init(context) || context || null;
  drawer = document.getElementById('settings-view');
  button = document.getElementById('btn-settings');

  const known = ops.getSettings();
  if (known && typeof known === 'object' && Object.keys(known).length > 0) {
    settings = { ...DEFAULTS, ...known };
  }

  if (!bound) {
    bound = true;
    if (button) {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        toggle();
      });
    }
    onSettingsChange((next) => {
      settings = { ...DEFAULTS, ...next };
      if (built) syncControls();
    });
    void loadSettings().then((loaded) => {
      settings = { ...DEFAULTS, ...loaded };
      if (built) syncControls();
    });
  }
}

/** @returns {boolean} */
export function isOpen() {
  return open;
}

export function toggle() {
  if (open) close();
  else openDrawer();
}

/** Open the drawer, moving focus inside it (spec-addendum A15.5). */
export function openDrawer() {
  if (!drawer) drawer = document.getElementById('settings-view');
  if (!drawer) return;
  build();
  lastFocused = document.activeElement instanceof Element ? document.activeElement : null;
  open = true;
  drawer.hidden = false;
  drawer.setAttribute('aria-modal', 'true');
  if (button) button.setAttribute('aria-expanded', 'true');
  syncControls();
  void refreshCacheStats();
  void refreshShortcuts();
  const first = firstFocusable();
  if (first) {
    try {
      first.focus();
    } catch (e) {
      log.warn('settings focus', e);
    }
  }
}

export { openDrawer as open };

/** Close the drawer and restore focus to `#btn-settings`. */
export function close() {
  if (!open) return;
  open = false;
  if (drawer) {
    drawer.hidden = true;
    drawer.removeAttribute('aria-modal');
  }
  if (button) button.setAttribute('aria-expanded', 'false');
  const target = lastFocused && lastFocused.isConnected ? lastFocused : button;
  lastFocused = null;
  try {
    if (target && typeof (/** @type {any} */ (target).focus) === 'function') {
      /** @type {any} */ (target).focus({ preventScroll: true });
    }
  } catch (e) {
    log.warn('settings restore focus', e);
  }
}

/* ── build ────────────────────────────────────────────────────────────────── */

function build() {
  if (built || !drawer) return;
  built = true;
  drawer.textContent = '';

  /* header */
  const header = document.createElement('header');
  header.className = 'drawer__head';
  const title = document.createElement('h2');
  title.className = 'drawer__title';
  title.textContent = t('settings');
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'iconbtn drawer__close';
  closeBtn.dataset.testid = 'settings-close';
  closeBtn.setAttribute('aria-label', t('dismiss'));
  closeBtn.appendChild(glyph('#i-close'));
  closeBtn.addEventListener('click', () => close());
  header.append(title, closeBtn);
  drawer.appendChild(header);

  const body = document.createElement('div');
  body.className = 'drawer__body';
  drawer.appendChild(body);

  /* the generated sections */
  for (const section of SECTIONS) {
    body.appendChild(buildSection(section));
  }

  /* previews: cache stats + clear */
  const previews = body.querySelector('[data-section="settingsPreviews"]');
  if (previews) {
    const stats = document.createElement('p');
    stats.className = 'drawer__stats';
    stats.id = 'settings-cache-stats';
    stats.dataset.testid = 'settings-cache-stats';
    stats.textContent = t('settingsCacheStats', ['0', '0.0']);

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'drawer__button';
    clear.id = 'settings-clear-cache';
    clear.dataset.testid = 'settings-clear-cache';
    clear.textContent = t('settingsClearCache');
    clear.addEventListener('click', () => void onClearCache(clear));

    previews.append(stats, clear);
  }

  /* shortcuts */
  const shortcuts = document.createElement('section');
  shortcuts.className = 'drawer__section';
  shortcuts.dataset.section = 'settingsShortcuts';
  const shortcutsTitle = document.createElement('h3');
  shortcutsTitle.className = 'drawer__section-title';
  shortcutsTitle.textContent = t('settingsShortcuts');
  const shortcutsList = document.createElement('dl');
  shortcutsList.className = 'drawer__shortcuts';
  shortcutsList.id = 'settings-shortcuts';
  shortcutsList.dataset.testid = 'settings-shortcuts';
  const shortcutsLink = document.createElement('button');
  shortcutsLink.type = 'button';
  shortcutsLink.className = 'drawer__link';
  shortcutsLink.dataset.testid = 'settings-shortcuts-link';
  shortcutsLink.textContent = t('shortcutsOpenSettings');
  shortcutsLink.addEventListener('click', () => void ops.openUrl(CHROME_SHORTCUTS_URL));
  shortcuts.append(shortcutsTitle, shortcutsList, shortcutsLink);
  body.appendChild(shortcuts);

  /* about */
  const about = document.createElement('section');
  about.className = 'drawer__section';
  about.dataset.section = 'settingsAbout';
  const aboutTitle = document.createElement('h3');
  aboutTitle.className = 'drawer__section-title';
  aboutTitle.textContent = t('settingsAbout');
  const version = document.createElement('p');
  version.className = 'drawer__version';
  version.dataset.testid = 'settings-version';
  version.textContent = t('version', [manifestVersion()]);
  const readme = document.createElement('button');
  readme.type = 'button';
  readme.className = 'drawer__link';
  readme.dataset.testid = 'settings-readme';
  readme.textContent = t('settingsReadme');
  readme.addEventListener('click', () => void ops.openUrl(REPOSITORY_URL));
  about.append(aboutTitle, version, readme);
  body.appendChild(about);

  drawer.addEventListener('keydown', onDrawerKeyDown);
  ops.applyI18n(drawer);
}

/**
 * @param {{ titleKey: string, rows: Row[] }} section
 * @returns {HTMLElement}
 */
function buildSection(section) {
  const el = document.createElement('section');
  el.className = 'drawer__section';
  el.dataset.section = section.titleKey;
  const title = document.createElement('h3');
  title.className = 'drawer__section-title';
  title.textContent = t(section.titleKey);
  el.appendChild(title);
  for (const row of section.rows) el.appendChild(buildRow(row));
  return el;
}

/**
 * @param {Row} row
 * @returns {HTMLElement}
 */
function buildRow(row) {
  const wrapper = document.createElement('div');
  wrapper.className = `drawer__row drawer__row--${row.type}`;

  const id = `settings-${row.key}`;
  const label = document.createElement('label');
  label.className = 'drawer__label';
  label.htmlFor = id;
  label.textContent = t(row.labelKey);

  /** @type {HTMLElement} */
  let control;
  if (row.type === 'select') {
    const select = document.createElement('select');
    select.id = id;
    select.dataset.testid = id;
    select.dataset.key = row.key;
    for (const [value, key] of row.options || []) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = t(key);
      select.appendChild(option);
    }
    // `<select>.value` is always a string; the column count is stored as a number so
    // `normalizeSettings()` clamps it as one and the CSS attribute matches exactly.
    select.addEventListener('change', () =>
      void save({ [row.key]: row.numeric ? Number(select.value) : select.value }));
    control = select;
  } else if (row.type === 'checkbox') {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.dataset.testid = id;
    input.dataset.key = row.key;
    input.addEventListener('change', () => void save({ [row.key]: input.checked }));
    control = input;
  } else if (row.type === 'widget') {
    /* A widget checkbox writes into the ordered `widgets` list rather than a key of
     * its own. Turning one on appends it, which is what makes the checkbox order in
     * the drawer the rail's order too — the list is the order, so there is no second
     * place for it to disagree. */
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.dataset.testid = id;
    input.dataset.widget = row.widgetId;
    input.addEventListener('change', () => {
      const current = (settings.widgets || []).filter((w) => w !== row.widgetId);
      const next = input.checked
        ? WIDGET_IDS.filter((w) => w === row.widgetId || current.includes(w))
        : current;
      void save({ widgets: next });
    });
    control = input;
  } else if (row.type === 'number') {
    const input = document.createElement('input');
    input.type = 'number';
    input.id = id;
    input.dataset.testid = id;
    input.dataset.key = row.key;
    input.min = String(row.min ?? 0);
    input.max = String(row.max ?? 999);
    input.step = '1';
    input.inputMode = 'numeric';
    input.addEventListener('change', () => {
      const min = row.min ?? 0;
      const max = row.max ?? 999;
      const value = Math.min(max, Math.max(min, Math.round(Number(input.value) || min)));
      input.value = String(value);
      void save({ [row.key]: value });
    });
    control = input;
  } else {
    const area = document.createElement('textarea');
    area.id = id;
    area.dataset.testid = id;
    area.dataset.key = row.key;
    area.rows = 4;
    area.spellcheck = false;
    area.autocapitalize = 'off';
    const commit = () => void save({ [row.key]: parseHosts(area.value) });
    area.addEventListener('change', () => {
      if (textTimer) {
        clearTimeout(textTimer);
        textTimer = 0;
      }
      commit();
    });
    area.addEventListener('input', () => {
      if (textTimer) clearTimeout(textTimer);
      textTimer = setTimeout(() => {
        textTimer = 0;
        commit();
      }, SETTINGS_TEXT_DEBOUNCE_MS);
    });
    control = area;
  }

  if (row.type === 'checkbox' || row.type === 'widget') {
    wrapper.append(control, label);
  } else {
    wrapper.append(label, control);
  }
  if (row.helpKey) {
    const help = document.createElement('p');
    help.className = 'drawer__help';
    help.textContent = t(row.helpKey);
    wrapper.appendChild(help);
  }
  return wrapper;
}

/**
 * @param {string} href
 * @returns {SVGElement}
 */
function glyph(href) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', href);
  svg.appendChild(use);
  return svg;
}

/* ── syncing ──────────────────────────────────────────────────────────────── */

/** Push the current settings into the controls (also after an external change). */
export function syncControls() {
  if (!drawer || !built) return;
  for (const section of SECTIONS) {
    for (const row of section.rows) {
      const el = drawer.querySelector(`#settings-${row.key}`);
      if (!el) continue;
      if (row.type === 'widget') {
        // These rows have no settings key of their own: they are membership in the
        // ordered `widgets` list.
        if (el instanceof HTMLInputElement) {
          el.checked = (settings.widgets || []).includes(row.widgetId);
        }
        continue;
      }
      const value = settings[row.key];
      if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = value === true;
      else if (el instanceof HTMLTextAreaElement) el.value = Array.isArray(value) ? value.join('\n') : '';
      else if (el instanceof HTMLSelectElement) el.value = String(value ?? '');
      else if (el instanceof HTMLInputElement) el.value = String(value ?? '');
    }
  }
}

/**
 * @param {Record<string, unknown>} patch
 */
async function save(patch) {
  settings = { ...settings, ...patch };
  try {
    const stored = await saveSettings(patch);
    if (stored) {
      settings = { ...DEFAULTS, ...stored };
      syncControls();
    }
  } catch (e) {
    log.warn('saveSettings', e);
    toast(t('operationFailed'));
  }
}

/**
 * One host per line; blank lines and stray whitespace are dropped here and
 * normalised again by `normalizeSettings()`.
 * @param {string} value
 * @returns {string[]}
 */
export function parseHosts(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** @returns {string} */
function manifestVersion() {
  try {
    return chrome.runtime.getManifest().version || '';
  } catch {
    return '';
  }
}

/* ── cache stats and clearing (spec-addendum A17) ─────────────────────────── */

/** Refresh the "$COUNT$ previews, $SIZE$ MB" line from `thumb-store.stats()`. */
export async function refreshCacheStats() {
  const el = document.getElementById('settings-cache-stats');
  if (!el) return;
  let count = 0;
  let bytes = 0;
  try {
    if (typeof thumbStore.stats === 'function') {
      const stats = await thumbStore.stats();
      if (stats) {
        count = Number(stats.count) || 0;
        bytes = Number(stats.bytes) || 0;
      }
    }
  } catch (e) {
    log.warn('thumb stats', e);
  }
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  // `chrome.i18n` has no plural support, so the singular is a separate key.
  // English takes the plural at zero ("0 previews"), so only 1 is special.
  el.textContent =
    count === 1
      ? t('settingsCacheStatsOne', [String(count), mb])
      : t('settingsCacheStats', [String(count), mb]);
}

/**
 * @param {HTMLElement} trigger the button that was clicked (focus returns there)
 */
async function onClearCache(trigger) {
  const ok = await confirmBar({
    message: t('confirmClearCache'),
    confirmLabel: t('confirmDelete'),
    danger: true,
    returnFocusTo: trigger,
  });
  if (!ok) return;
  const response = await ops.request({ type: MSG.CLEAR_THUMBS });
  if (response && response.ok) {
    toast(t('cacheCleared'));
  } else {
    toast(t('operationFailed'));
  }
  await refreshCacheStats();
}

/* ── shortcuts ────────────────────────────────────────────────────────────── */

/** Fill the shortcut rows from `commands.getAll()` (never hard-coded). */
export async function refreshShortcuts() {
  const list = document.getElementById('settings-shortcuts');
  if (!list) return;
  /** @type {chrome.commands.Command[]} */
  let commands = [];
  try {
    commands = await chrome.commands.getAll();
  } catch (e) {
    log.warn('commands.getAll', e);
  }
  const rows = [
    { name: '_execute_action', labelKey: 'shortcutToggle' },
    { name: 'search-tabs', labelKey: 'shortcutSearch' },
  ];
  list.textContent = '';
  for (const row of rows) {
    const command = commands.find((item) => item.name === row.name);
    const binding = command && command.shortcut ? command.shortcut : '';
    const dt = document.createElement('dt');
    dt.textContent = row.labelKey === 'shortcutToggle' ? t('shortcutToggle') : t('shortcutSearch');
    const dd = document.createElement('dd');
    dd.dataset.testid = `shortcut-${row.name}`;
    dd.textContent = binding !== '' ? binding : t('shortcutUnassigned');
    list.append(dt, dd);
  }
}

/* ── focus trap ───────────────────────────────────────────────────────────── */

/**
 * @returns {HTMLElement[]}
 */
function focusables() {
  if (!drawer) return [];
  return /** @type {HTMLElement[]} */ ([
    ...drawer.querySelectorAll(
      'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href]',
    ),
  ]);
}

/** @returns {HTMLElement|null} */
function firstFocusable() {
  const list = focusables();
  return list.length > 0 ? list[0] : null;
}

/**
 * @param {KeyboardEvent} event
 */
function onDrawerKeyDown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  if (event.key !== 'Tab') return;
  const list = focusables();
  if (list.length === 0) return;
  const first = list[0];
  const last = list[list.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
