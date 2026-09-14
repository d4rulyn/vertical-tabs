// _locales parity, placeholder hygiene, and "every key the code references exists".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EXT, walk, readJson } from './_load.mjs';

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
