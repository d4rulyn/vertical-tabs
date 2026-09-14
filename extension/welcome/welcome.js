// First-run page (also the options page). It may open the side panel itself: a click
// on an extension page is a valid user gesture and chrome.sidePanel.open({windowId})
// resolves from an extension page (measured), so the window id is resolved at load
// time and the click handler contains no await before open() — any await would let
// the gesture expire.
import { t, applyI18n } from '../common/i18n.js';

const APPEARANCE_URL = 'chrome://settings/appearance';

applyI18n(document);

const openLine = document.getElementById('open-line');
const openNowButton = document.getElementById('open-now');
const appearanceButton = document.getElementById('open-appearance');
const manualUrl = document.getElementById('manual-url');
const versionLine = document.getElementById('version');

/** Resolved long before any click so the gesture is never spent on an await. */
let hostWindowId = null;
chrome.windows.getCurrent()
  .then((w) => { hostWindowId = w.id; })
  .catch(() => { hostWindowId = null; });

/** Shows the address the user has to open by hand when Chrome refuses tabs.create. */
function showManualUrl(url) {
  if (!manualUrl) return;
  manualUrl.textContent = t('openUrlManually', [url]);
  manualUrl.hidden = false;
}

/** Falls back to "press the shortcut" when the panel cannot be opened from here. */
function showShortcutHint() {
  if (!openLine) return;
  openLine.classList.add('is-highlighted');
  openLine.scrollIntoView({ block: 'nearest' });
}

function renderOpenLine(shortcut) {
  if (!openLine) return;
  openLine.textContent = t('welcomeOpen', [shortcut || t('shortcutUnassigned')]);
}

// The real, current binding — never a hard-coded "Ctrl+Shift+E", which would be
// wrong on macOS and after the user rebinds the command.
chrome.commands.getAll()
  .then((commands) => {
    const entry = commands.find((c) => c.name === '_execute_action');
    renderOpenLine((entry && entry.shortcut) || '');
  })
  .catch(() => renderOpenLine(''));

if (openNowButton) {
  openNowButton.addEventListener('click', () => {
    if (hostWindowId == null) { showShortcutHint(); return; }
    chrome.sidePanel.open({ windowId: hostWindowId }).catch(() => showShortcutHint());
  });
}

if (appearanceButton) {
  appearanceButton.addEventListener('click', () => {
    chrome.tabs.create({ url: APPEARANCE_URL }).catch(() => showManualUrl(APPEARANCE_URL));
  });
}

if (versionLine) {
  versionLine.textContent = t('version', [chrome.runtime.getManifest().version]);
}
