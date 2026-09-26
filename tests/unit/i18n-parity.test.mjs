// _locales parity, placeholder hygiene, and "every key the code references exists".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EXT, walk, readJson, loadCommon } from './_load.mjs';

const EN_FILE = path.join(EXT, '_locales', 'en', 'messages.json');
const JA_FILE = path.join(EXT, '_locales', 'ja', 'messages.json');

assert.ok(fs.existsSync(EN_FILE), 'extension/_locales/en/messages.json is missing');
assert.ok(fs.existsSync(JA_FILE), 'extension/_locales/ja/messages.json is missing');

const en = readJson(EN_FILE);
const ja = readJson(JA_FILE);

// Keys the specification names explicitly (spec.md §11 plus spec-addendum.md A16).
const REQUIRED_KEYS = [
  'extName', 'extDescription', 'actionTitle', 'actionTitleWithShortcut', 'cmdSearchTabs',
  'tabs', 'pinnedTabs', 'searchPlaceholder', 'clearSearch', 'searchNoResults', 'searchCount',
  'newTab', 'newTabTooltip', 'closeTab', 'closeNTabs', 'closeOtherTabs', 'closeTabsBelow', 'closeGroup',
  'reload', 'duplicate', 'pinTab', 'unpinTab', 'muteTab', 'unmuteTab', 'hibernateTab', 'hibernated',
  'addToNewGroup', 'addToGroup', 'removeFromGroup', 'moveToNewWindow', 'copyUrl', 'copied', 'copyFailed',
  'refreshPreview', 'reopenClosedTab', 'restoreTab', 'closedTabs', 'closedTabsEmpty', 'closedWindow',
  'restoreFailed', 'operationFailed', 'groupMoveInvalid', 'groupUntitled', 'groupRename', 'groupColor',
  'groupCollapse', 'groupExpand', 'groupUngroup', 'groupNewTab', 'groupTabCount',
  'colorGrey', 'colorBlue', 'colorRed', 'colorYellow', 'colorGreen', 'colorPink', 'colorPurple',
  'colorCyan', 'colorOrange',
  'audioPlaying', 'audioMuted', 'loading', 'unreadTab',
  'previewPending', 'previewCapturing', 'previewUnavailable', 'previewDisabledByPolicy', 'previewStale',
  'previewExcluded', 'previewNoSiteAccess',
  'bannerScreenshotsDisabled', 'bannerSiteAccess', 'bannerSiteAccessOpen',
  'confirmCloseMany', 'confirmClose', 'confirmClearCache', 'confirmDelete', 'cacheCleared',
  'cancel', 'dismiss',
  'settings', 'settingsAppearance', 'settingsBehavior', 'settingsPreviews', 'settingsTheme',
  'themeSystem', 'themeDark', 'themeLight',
  'settingsShowThumbnails', 'settingsPinnedGrid', 'settingsMiddleClick', 'settingsDoubleClickNewTab',
  'settingsUnreadDot', 'settingsClickActiveSwitchesBack', 'settingsConfirmThreshold',
  'settingsRefresh', 'refreshOff', 'refresh30s', 'refresh1m', 'refresh5m',
  'settingsCaptureWhenClosed', 'settingsCaptureBeforeSwitch', 'settingsPersistThumbs',
  'settingsExcludedHosts', 'settingsExcludedHostsHelp', 'settingsCacheStats', 'settingsClearCache',
  'settingsShortcuts', 'shortcutToggle', 'shortcutSearch', 'shortcutUnassigned', 'shortcutsOpenSettings',
  'settingsAbout', 'settingsReadme', 'version',
  'sidePositionHint', 'sidePositionOpenSettings', 'openUrlManually',
  'timeJustNow', 'timeMinutesAgo', 'timeHoursAgo', 'timeDaysAgo',
  'welcomeTitle', 'welcomeOpen', 'welcomeOpenNow', 'welcomePin', 'welcomeSide',
  'welcomeChromeVerticalTabs', 'welcomePermissions', 'welcomeSettings',
];

// Strings the end-to-end specs assert verbatim.
const EXACT_EN = {
  previewNoSiteAccess: 'Chrome is not letting this extension read this site, so no preview can be made',
  previewExcluded: 'Previews are turned off for this site',
  newTab: 'New tab',
  searchPlaceholder: 'Search tabs',
  closedTabs: 'Closed tabs',
  searchCount: '$N$ of $M$ tabs',
  // 32-bookmarks-rail asserts these four verbatim. Pinned here so that renaming one
  // fails in seconds against the string table instead of six minutes later as an opaque
  // Playwright text mismatch.
  widgetScratchpad: 'Notes',
  bookmarksGrantTitle: 'Bookmarks need your permission first',
  bookmarksGrantButton: 'Allow bookmarks',
  bookmarksMore: '$COUNT$ more',
};
const EXACT_JA = {
  extName: '縦型タブ',
  newTab: '新しいタブ',
  searchPlaceholder: 'タブを検索',
  closedTabs: '閉じたタブ',
  settingsClearCache: 'プレビューのキャッシュを削除',
  settingsTheme: 'テーマ',
};

function placeholderNames(entry) {
  return Object.keys(entry.placeholders || {}).map((k) => k.toLowerCase()).sort();
}

function messagePlaceholders(message) {
  const out = new Set();
  // $$ is the literal-dollar escape and must not be read as a placeholder.
  const stripped = String(message).replace(/\$\$/g, '');
  for (const m of stripped.matchAll(/\$([A-Za-z0-9_]+)\$/g)) out.add(m[1].toLowerCase());
  return [...out].sort();
}

test('en and ja declare exactly the same keys', () => {
  const enKeys = Object.keys(en).sort();
  const jaKeys = Object.keys(ja).sort();
  const missingInJa = enKeys.filter((k) => !jaKeys.includes(k));
  const missingInEn = jaKeys.filter((k) => !enKeys.includes(k));
  assert.deepEqual(missingInJa, [], 'keys missing from _locales/ja');
  assert.deepEqual(missingInEn, [], 'keys missing from _locales/en');
});

test('every documented key exists in both locales', () => {
  const missing = REQUIRED_KEYS.filter((k) => !(k in en) || !(k in ja));
  assert.deepEqual(missing, [], 'documented i18n keys that are not defined');
});

test('no message is empty', () => {
  for (const [locale, table] of [['en', en], ['ja', ja]]) {
    for (const [key, entry] of Object.entries(table)) {
      assert.equal(typeof entry.message, 'string', `${locale}.${key}.message must be a string`);
      assert.ok(entry.message.trim().length > 0, `${locale}.${key}.message is empty`);
    }
  }
});

test('placeholder declarations match between locales and cover every $TOKEN$', () => {
  for (const key of Object.keys(en)) {
    assert.deepEqual(placeholderNames(en[key]), placeholderNames(ja[key]),
      `placeholder names differ between locales for "${key}"`);
  }
  for (const [locale, table] of [['en', en], ['ja', ja]]) {
    for (const [key, entry] of Object.entries(table)) {
      const used = messagePlaceholders(entry.message);
      const declared = placeholderNames(entry);
      for (const name of used) {
        assert.ok(declared.includes(name),
          `${locale}.${key} uses $${name.toUpperCase()}$ but declares no "placeholders" entry for it`);
      }
      for (const [pname, pdef] of Object.entries(entry.placeholders || {})) {
        assert.ok(typeof pdef.content === 'string' && pdef.content.length > 0,
          `${locale}.${key}.placeholders.${pname}.content is required`);
      }
    }
  }
});

test('the action title never hard-codes a keyboard shortcut', () => {
  for (const [locale, table] of [['en', en], ['ja', ja]]) {
    const msg = table.actionTitle.message;
    for (const needle of ['Ctrl', 'Cmd', 'Command', 'Alt', '⌘']) {
      assert.ok(!msg.includes(needle),
        `${locale}.actionTitle must not contain "${needle}" — bindings are read from commands.getAll()`);
    }
  }
  assert.ok(en.actionTitleWithShortcut.message.includes('$SHORTCUT$'));
  assert.ok(ja.actionTitleWithShortcut.message.includes('$SHORTCUT$'));
});

test('strings the end-to-end specs assert verbatim are stable', () => {
  for (const [key, value] of Object.entries(EXACT_EN)) {
    assert.equal(en[key].message, value, `en.${key}`);
  }
  for (const [key, value] of Object.entries(EXACT_JA)) {
    assert.equal(ja[key].message, value, `ja.${key}`);
  }
});

test('every i18n key referenced from extension/** is defined', () => {
  const files = walk(EXT, (f) => /\.(js|html|json)$/.test(f) && !f.includes(`${path.sep}_locales${path.sep}`));
  assert.ok(files.length > 0, 'no extension source files were found');

  const referenced = new Map(); // key -> first file that used it
  const note = (key, file) => { if (key && !referenced.has(key)) referenced.set(key, file); };

  // Comments hold illustrative snippets (e.g. the `data-i18n-attr="attr:key"` JSDoc
  // in common/i18n.js). Stripping them keeps documentation from registering as a
  // real key reference; string literals never legitimately contain `/* */` or `//`
  // sequences that matter to the patterns below.
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    const src = file.endsWith('.js') ? stripComments(raw) : raw;
    const rel = path.relative(EXT, file);

    for (const m of src.matchAll(/data-i18n\s*=\s*"([^"]+)"/g)) note(m[1].trim(), rel);
    for (const m of src.matchAll(/data-i18n-attr\s*=\s*"([^"]+)"/g)) {
      for (const pair of m[1].split(';')) {
        const key = pair.split(':')[1];
        if (key) note(key.trim(), rel);
      }
    }
    for (const m of src.matchAll(/\bt\(\s*['"]([A-Za-z0-9_]+)['"]/g)) note(m[1], rel);
    for (const m of src.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) note(m[1], rel);
  }

  const undefinedKeys = [...referenced.entries()]
    .filter(([key]) => !(key in en))
    .map(([key, file]) => `${key} (referenced in ${file})`);
  assert.deepEqual(undefinedKeys, [], 'i18n keys referenced by the extension but missing from _locales/en');
});

// settings-view.js does not spell three of its i18n keys out. It derives them from data:
//
//   options: COLUMN_CHOICES.map((n) => [String(n), `columns${n}`])
//   px === CARD_WIDTH_FILL ? 'cardWidthFill' : `cardWidth${px}`
//   labelKey: `widget${id.charAt(0).toUpperCase()}${id.slice(1)}`
//
// A template literal is invisible to the reference scan above and to MSG_RE in
// tools/check_integration.py, so adding a choice can ship a row labelled with its own key.
// widgetStaleTabs shipped exactly that way: the staleTabs widget is titled widgetStale, so
// the key the drawer derived was defined nowhere and the checkbox read "widgetStaleTabs".
// t() does console.warn on a miss (common/i18n.js), but no test asserts on the console and
// the __MSG_ guards in 01-load, 09-i18n and 14-coverage cannot fire — t() returns the bare
// key, not __MSG_key__ — so nothing failed. These three tests are the check the derivations
// do not otherwise get.
test('every option the settings drawer derives has a message in both locales', async () => {
  const { WIDGET_IDS, COLUMN_CHOICES, CARD_WIDTH_CHOICES, CARD_WIDTH_FILL } =
    await loadCommon('settings-schema.js');

  const derived = [
    ...WIDGET_IDS.map((id) => [`widget${id.charAt(0).toUpperCase()}${id.slice(1)}`, `widget id "${id}"`]),
    ...COLUMN_CHOICES.map((n) => [`columns${n}`, `column choice ${n}`]),
    ...CARD_WIDTH_CHOICES.map((px) => [
      px === CARD_WIDTH_FILL ? 'cardWidthFill' : `cardWidth${px}`,
      `card width choice ${px}`,
    ]),
  ];

  const missing = [];
  for (const [key, origin] of derived) {
    if (!(key in en)) missing.push(`${key} (en, derived from ${origin})`);
    if (!(key in ja)) missing.push(`${key} (ja, derived from ${origin})`);
  }
  assert.deepEqual(missing, [], 'settings-view.js derives these keys but _locales does not define them');
});

// The test above re-types the three expressions rather than calling them, so it cannot see a
// change to the derivation itself. This pins them: change one and this fails, naming the file
// to edit. Delete an entry here when its key stops being derived.
test('the settings drawer still builds its keys the way the test above assumes', () => {
  const src = fs.readFileSync(path.join(EXT, 'sidepanel', 'settings-view.js'), 'utf8');
  const expressions = [
    '`columns${n}`',
    "px === CARD_WIDTH_FILL ? 'cardWidthFill' : `cardWidth${px}`",
    '`widget${id.charAt(0).toUpperCase()}${id.slice(1)}`',
  ];
  const gone = expressions.filter((expr) => !src.includes(expr));
  assert.deepEqual(gone, [],
    'settings-view.js changed how it builds a label key — the test above copies these expressions verbatim and has to change with it');
});

test('every widget declares a heading both locales define, and its drawer row agrees', async () => {
  const { WIDGET_IDS } = await loadCommon('settings-schema.js');

  // Pair `id` with `titleKey` inside each widget module. Scanning for the two tokens and
  // pairing them by proximity tolerates either declaration order, either quote style, and
  // comments in between; an empty titleKey is legal (widgets.js: "'' for no heading").
  // Unquoted ids are skipped on purpose: sessions.js has one in a @typedef and one built
  // from a template literal, and neither is a widget declaration.
  const tokens = [];
  for (const file of walk(path.join(EXT, 'sidepanel', 'widgets'), (f) => f.endsWith('.js'))) {
    const rel = path.relative(EXT, file);
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, n) => {
      const id = line.match(/\bid:\s*['"]([A-Za-z][A-Za-z0-9]*)['"]/);
      if (id) tokens.push({ kind: 'id', value: id[1], file: rel, line: n });
      const title = line.match(/\btitleKey:\s*['"]([A-Za-z0-9]*)['"]/);
      if (title) tokens.push({ kind: 'titleKey', value: title[1], file: rel, line: n });
    });
  }

  const used = new Set();
  const declared = new Map();
  for (const tok of tokens) {
    if (tok.kind !== 'id') continue;
    const mate = tokens.find((t) => t.kind === 'titleKey' && t.file === tok.file
      && !used.has(t) && Math.abs(t.line - tok.line) <= 6);
    if (!mate) continue;
    used.add(mate);
    declared.set(tok.value, { titleKey: mate.value, file: tok.file, line: tok.line + 1 });
  }

  // Anchoring on the id set, not on a count, is what makes a widget the scan missed loud.
  assert.deepEqual([...declared.keys()].sort(), [...WIDGET_IDS].sort(),
    'every id in WIDGET_IDS must come from a widget module declaring `id` and `titleKey` within six lines of each other');

  const problems = [];
  for (const [id, { titleKey, file, line }] of declared) {
    if (!titleKey) continue; // a widget may render no heading at all
    const derived = `widget${id.charAt(0).toUpperCase()}${id.slice(1)}`;
    for (const [name, table] of [['en', en], ['ja', ja]]) {
      const heading = table[titleKey]?.message;
      if (heading === undefined) {
        problems.push(`${name}: ${file}:${line} is titled ${titleKey}, which no locale defines`);
        continue;
      }
      const label = table[derived]?.message;
      if (label !== heading) {
        problems.push(`${name}: the drawer row says "${label}" (${derived}) but ${file}:${line} says "${heading}" (${titleKey})`);
      }
    }
  }
  assert.deepEqual(problems, [],
    'the drawer checkbox and the widget heading name the same tool and must read identically');
});
