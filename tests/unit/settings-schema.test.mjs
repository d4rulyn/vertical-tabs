// extension/common/settings-schema.js — DEFAULTS, normalizeSettings, hostMatches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCommon } from './_load.mjs';

const {
  DEFAULTS, normalizeSettings, hostMatches, REFRESH_PERIODS,
  COLUMNS_MIN, COLUMNS_MAX, COLUMN_CHOICES, normalizeColumns, layoutForColumns,
  CARD_WIDTH_CHOICES, CARD_WIDTH_FILL, WIDGET_IDS, normalizeWidgets,
  PREVIEW_MOMENTS, normalizePreviewMoment,
} = await loadCommon('settings-schema.js');

// Binding default object (spec.md §10, spec-addendum.md A12; the `layout` enum from
// A11 is replaced by the `columns` integer, default ONE, on direct user instruction).
const EXPECTED_DEFAULTS = {
  version: 2,
  theme: 'system',
  columns: 1,
  cardWidth: 0,
  widgets: ['sessions', 'recent', 'windows', 'autoGroup', 'duplicates', 'staleTabs', 'scratchpad'],
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
};

test('DEFAULTS is exactly the documented object', () => {
  assert.deepEqual(Object.keys(DEFAULTS).sort(), Object.keys(EXPECTED_DEFAULTS).sort());
  for (const [key, value] of Object.entries(EXPECTED_DEFAULTS)) {
    assert.deepEqual(DEFAULTS[key], value, `DEFAULTS.${key}`);
  }
});

test('REFRESH_PERIODS maps the four settings to alarm periods', () => {
  assert.equal(REFRESH_PERIODS.off, null);
  assert.equal(REFRESH_PERIODS['30s'], 0.5);
  assert.equal(REFRESH_PERIODS['1m'], 1);
  assert.equal(REFRESH_PERIODS['5m'], 5);
});

test('normalizeSettings fills in every default', () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULTS);
  assert.deepEqual(normalizeSettings(null), DEFAULTS);
  assert.deepEqual(normalizeSettings({}), DEFAULTS);
  assert.deepEqual(normalizeSettings('nonsense'), DEFAULTS);
});

test('normalizeSettings drops unknown keys', () => {
  const out = normalizeSettings({ theme: 'dark', somethingElse: 42 });
  assert.equal(out.theme, 'dark');
  assert.equal('somethingElse' in out, false);
});

test('normalizeSettings validates enums', () => {
  assert.equal(normalizeSettings({ theme: 'purple' }).theme, DEFAULTS.theme);
  assert.equal(normalizeSettings({ theme: 'light' }).theme, 'light');
  assert.equal(normalizeSettings({ refreshInterval: '2h' }).refreshInterval, DEFAULTS.refreshInterval);
  assert.equal(normalizeSettings({ refreshInterval: 'off' }).refreshInterval, 'off');
});

test('the column count offered is exactly 1…5 and defaults to one', () => {
  assert.equal(COLUMNS_MIN, 1);
  assert.equal(COLUMNS_MAX, 5);
  assert.deepEqual([...COLUMN_CHOICES], [1, 2, 3, 4, 5]);
  assert.equal(DEFAULTS.columns, 1, 'a fresh profile shows ONE column');
});

test('normalizeSettings clamps the column count into 1…5', () => {
  for (const n of [1, 2, 3, 4, 5]) {
    assert.equal(normalizeSettings({ columns: n }).columns, n, `columns: ${n}`);
  }
  assert.equal(normalizeSettings({ columns: 0 }).columns, 1);
  assert.equal(normalizeSettings({ columns: -3 }).columns, 1);
  assert.equal(normalizeSettings({ columns: 6 }).columns, 5);
  assert.equal(normalizeSettings({ columns: 99 }).columns, 5);
  assert.equal(normalizeSettings({ columns: 3.7 }).columns, 3, 'truncated, not rounded');
  // A `<select>` hands over strings; the drawer converts, but stored data may not have.
  assert.equal(normalizeSettings({ columns: '4' }).columns, 4);
  assert.equal(normalizeSettings({ columns: 'wide' }).columns, DEFAULTS.columns);
  assert.equal(normalizeSettings({ columns: null }).columns, DEFAULTS.columns);
  assert.equal(normalizeSettings({ columns: NaN }).columns, DEFAULTS.columns);
});

test('normalizeColumns is the same clamp, exposed for the panel', () => {
  assert.equal(normalizeColumns(1), 1);
  assert.equal(normalizeColumns(5), 5);
  assert.equal(normalizeColumns(9), 5);
  assert.equal(normalizeColumns(undefined), DEFAULTS.columns);
  assert.equal(normalizeColumns('3'), 3);
});

test('layoutForColumns splits "one column" from "several"', () => {
  assert.equal(layoutForColumns(1), 'list');
  assert.equal(layoutForColumns(2), 'grid');
  assert.equal(layoutForColumns(5), 'grid');
  // Garbage falls back to the default column count, i.e. a single column.
  assert.equal(layoutForColumns(undefined), 'list');
  assert.equal(layoutForColumns('nonsense'), 'list');
});

// ── migration: settings written before `columns` existed carried a `layout` enum.
test('normalizeSettings migrates a stored layout onto a column count', () => {
  assert.equal(normalizeSettings({ layout: 'list' }).columns, 1);
  assert.equal(normalizeSettings({ layout: 'grid' }).columns, 2,
    'the old grid was two columns at the 360 px minimum panel width');
  assert.equal(normalizeSettings({ layout: 'auto' }).columns, 2,
    'auto resolved to the grid at every width the side panel can have');
  assert.equal(normalizeSettings({ layout: 'nonsense' }).columns, DEFAULTS.columns);
});

test('normalizeSettings never emits the legacy layout key', () => {
  for (const raw of [undefined, {}, { layout: 'grid' }, { layout: 'list', columns: 4 }]) {
    assert.equal('layout' in normalizeSettings(raw), false, JSON.stringify(raw));
  }
});

test('a stored column count outranks a stale layout, and migration happens once', () => {
  // `columns` is the key this version writes, so it wins whenever it is present.
  assert.equal(normalizeSettings({ layout: 'list', columns: 4 }).columns, 4);
  assert.equal(normalizeSettings({ layout: 'grid', columns: 1 }).columns, 1);
  // Re-normalising the migrated object is stable: there is no `layout` left to read.
  const once = normalizeSettings({ layout: 'grid' });
  assert.equal(once.columns, 2);
  assert.deepEqual(normalizeSettings(once), once);
});

test('the rest of an old settings object survives the migration untouched', () => {
  const legacy = {
    version: 1, theme: 'light', layout: 'auto', showThumbnails: false,
    refreshInterval: '5m', captureWhenPanelClosed: false, captureBeforeSwitch: false,
    persistThumbnails: false, excludedHosts: ['Example.com'], pinnedGrid: false,
    middleClickCloses: false, doubleClickNewTab: false, showUnreadDot: false,
    clickActiveTabSwitchesBack: true, confirmCloseThreshold: 9,
  };
  assert.deepEqual(normalizeSettings(legacy), {
    // `cardWidth` and `previewMoment` did not exist when this object was written, so
    // they take their defaults — and the preview default is the one that changes what
    // an upgraded install sees, so it is asserted here rather than assumed.
    version: 2, theme: 'light', columns: 2, cardWidth: 0,
    widgets: ['sessions', 'recent', 'windows', 'autoGroup', 'duplicates', 'staleTabs', 'scratchpad'], showThumbnails: false,
    previewMoment: 'top', refreshInterval: '5m', captureWhenPanelClosed: false, captureBeforeSwitch: false,
    persistThumbnails: false, excludedHosts: ['example.com'], pinnedGrid: false,
    middleClickCloses: false, doubleClickNewTab: false, showUnreadDot: false,
    clickActiveTabSwitchesBack: true, confirmCloseThreshold: 9,
  });
});

test('cardWidth accepts only the widths the drawer offers', () => {
  assert.equal(normalizeSettings({}).cardWidth, CARD_WIDTH_FILL, 'default is fill');
  for (const px of CARD_WIDTH_CHOICES) {
    assert.equal(normalizeSettings({ cardWidth: px }).cardWidth, px, `${px} round-trips`);
  }
  // A value between two choices could not round-trip through the select, so it falls
  // back to the default rather than being clamped onto a neighbour.
  for (const bad of [1, 150, 199, 321, 9999, -240, 'wide', null, NaN, Infinity]) {
    assert.equal(normalizeSettings({ cardWidth: bad }).cardWidth, CARD_WIDTH_FILL,
      `${String(bad)} falls back`);
  }
  // A <select> hands its value back as a string.
  assert.equal(normalizeSettings({ cardWidth: '240' }).cardWidth, 240);
});

test('widgets is an ordered list of ids this build can actually render', () => {
  // On by default: Chrome's 360 px floor leaves the space empty either way, so the
  // choice is tools or nothing rather than tools or tabs.
  assert.deepEqual(normalizeSettings({}).widgets,
    ['sessions', 'recent', 'windows', 'autoGroup', 'duplicates', 'staleTabs', 'scratchpad'], 'default');
  // Clearing it is a real choice — the column hides — not a missing value.
  assert.deepEqual(normalizeSettings({ widgets: [] }).widgets, []);
  // The list IS the order.
  assert.deepEqual(normalizeWidgets(['nowPlaying', 'sessions']), ['nowPlaying', 'sessions']);
  // Unknown ids are dropped rather than kept, so a list written by a version that had
  // more tools — the removed weather and calendar, say — degrades to what this build
  // can render instead of leaving a hole in the column.
  assert.deepEqual(normalizeWidgets(['sessions', 'weather', 'scratchpad']),
    ['sessions', 'scratchpad']);
  // Duplicates collapse; a tool cannot be mounted twice.
  assert.deepEqual(normalizeWidgets(['sessions', 'sessions']), ['sessions']);
  for (const bad of [undefined, null, 'sessions', 42, {}]) {
    assert.deepEqual(normalizeWidgets(bad),
      ['sessions', 'recent', 'windows', 'autoGroup', 'duplicates', 'staleTabs', 'scratchpad'], `${String(bad)} falls back`);
  }
  assert.deepEqual(normalizeWidgets([1, true, null]), []);
  // Everything the drawer offers must be a real id.
  for (const id of WIDGET_IDS) assert.equal(typeof id, 'string');
  assert.deepEqual(normalizeWidgets(WIDGET_IDS), [...WIDGET_IDS], 'all of them at once');
});

test('normalizeSettings coerces booleans and clamps the confirm threshold', () => {
  assert.equal(normalizeSettings({ showThumbnails: 'yes' }).showThumbnails, true);
  assert.equal(normalizeSettings({ showThumbnails: false }).showThumbnails, false);
  assert.equal(normalizeSettings({ confirmCloseThreshold: 0 }).confirmCloseThreshold, 2);
  assert.equal(normalizeSettings({ confirmCloseThreshold: 1 }).confirmCloseThreshold, 2);
  assert.equal(normalizeSettings({ confirmCloseThreshold: 999 }).confirmCloseThreshold, 50);
  assert.equal(normalizeSettings({ confirmCloseThreshold: 7 }).confirmCloseThreshold, 7);
  assert.equal(normalizeSettings({ confirmCloseThreshold: 7.6 }).confirmCloseThreshold, 7);
  assert.equal(normalizeSettings({ confirmCloseThreshold: 'x' }).confirmCloseThreshold,
    DEFAULTS.confirmCloseThreshold);
});

test('normalizeSettings normalises excludedHosts: trimmed, lower-case, unique, no blanks', () => {
  const out = normalizeSettings({ excludedHosts: ['  EXAMPLE.com ', 'example.com', '', '   ', 'A.TEST'] });
  assert.deepEqual(out.excludedHosts, ['example.com', 'a.test']);
  assert.deepEqual(normalizeSettings({ excludedHosts: 'example.com' }).excludedHosts, []);
});

test('hostMatches: exact host, wildcard subdomains, case-insensitive', () => {
  assert.equal(hostMatches('example.com', ['example.com']), true);
  assert.equal(hostMatches('EXAMPLE.com', ['example.com']), true);
  assert.equal(hostMatches('www.example.com', ['example.com']), false);
  assert.equal(hostMatches('www.example.com', ['*.example.com']), true);
  assert.equal(hostMatches('deep.www.example.com', ['*.example.com']), true);
  // The wildcard includes the apex.
  assert.equal(hostMatches('example.com', ['*.example.com']), true);
  assert.equal(hostMatches('notexample.com', ['*.example.com']), false);
  assert.equal(hostMatches('example.com', []), false);
  assert.equal(hostMatches('', ['example.com']), false);
});

// previewMoment — what a preview is a picture of. The default is binding: it is the
// whole point of the setting that an unconfigured install keeps the page header,
// because Chrome restores the scroll offset on reload and a mid-article preview
// identifies nothing.
test('previewMoment defaults to the top of the page', () => {
  assert.equal(DEFAULTS.previewMoment, 'top');
  assert.deepEqual([...PREVIEW_MOMENTS], ['top', 'reload', 'interval']);
});

test('normalizePreviewMoment accepts the three modes and nothing else', () => {
  for (const mode of PREVIEW_MOMENTS) assert.equal(normalizePreviewMoment(mode), mode);
  for (const junk of ['', 'TOP', 'header', null, undefined, 3, {}, ['top']]) {
    assert.equal(normalizePreviewMoment(junk), 'top');
  }
});

test('normalizeSettings carries previewMoment through', () => {
  assert.equal(normalizeSettings({ previewMoment: 'interval' }).previewMoment, 'interval');
  assert.equal(normalizeSettings({ previewMoment: 'reload' }).previewMoment, 'reload');
  assert.equal(normalizeSettings({ previewMoment: 'nonsense' }).previewMoment, 'top');
  assert.equal(normalizeSettings({}).previewMoment, 'top');
});
