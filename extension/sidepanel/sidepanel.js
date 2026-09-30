/**
 * Side-panel bootstrap and pointer wiring (spec.md §8.1, §9.1; spec-addendum
 * A7 site-access banner, A12 capture-before-switch, A15 focus rules, A17).
 *
 * Boot order is the one the spec fixes: i18n → settings attributes → window id
 * → model → first render → thumbnails → `vt/panel-ready` → Chrome events → UI →
 * hints. Feature modules that another file group owns (`search`, `keyboard`,
 * `dnd`, `context-menu`, `trash`, `settings-view`, `tab-ops`, `toast`) are
 * imported dynamically and initialised with the shared context object below, so
 * a module that is missing or throws degrades that one feature instead of
 * blanking the panel.
 */

import * as state from './state.js';
import * as render from './render.js';
import * as thumbs from './thumbs.js';
import * as widgets from './widgets.js';
import * as locks from './locks.js';

import * as i18n from '../common/i18n.js';
import * as messagesMod from '../common/messages.js';
import * as settingsMod from '../common/settings.js';
import * as urlKeyMod from '../common/url-key.js';
import * as thumbStore from '../common/thumb-store.js';
import * as log from '../common/log.js';
import {
  STORAGE_SESSION,
  STORAGE_LOCAL,
  HINTS_DEFAULTS,
  PENDING_FOCUS_SEARCH_TTL_MS,
  TOAST_MS,
  CHROME_APPEARANCE_URL,
  extensionDetailsUrl,
  POPOUT_WIDTH,
} from '../common/constants.js';

const MSG = state.MSG;

/* ── Interop shims ───────────────────────────────────────────────────────── */

const t =
  typeof i18n.t === 'function'
    ? i18n.t
    : (key, subs) => {
        try {
          return chrome.i18n.getMessage(key, subs) || key;
        } catch {
          return key;
        }
      };

const applyI18n = typeof i18n.applyI18n === 'function' ? i18n.applyI18n : applyI18nFallback;

const broadcast =
  typeof messagesMod.broadcast === 'function'
    ? messagesMod.broadcast
    : (msg) => Promise.resolve(chrome.runtime.sendMessage(msg)).catch(() => {});

const request =
  typeof messagesMod.request === 'function'
    ? messagesMod.request
    : (msg) => chrome.runtime.sendMessage(msg);

const loadSettings =
  typeof settingsMod.loadSettings === 'function'
    ? settingsMod.loadSettings
    : async () => state.state.settings;

const saveSettings =
  typeof settingsMod.saveSettings === 'function'
    ? settingsMod.saveSettings
    : async () => {};

const loadHints =
  typeof settingsMod.loadHints === 'function'
    ? settingsMod.loadHints
    : async () => {
        try {
          const stored = await chrome.storage.local.get(STORAGE_LOCAL.hints);
          return { ...HINTS_DEFAULTS, ...(stored ? stored[STORAGE_LOCAL.hints] : null) };
        } catch {
          return { ...HINTS_DEFAULTS };
        }
      };

const saveHints =
  typeof settingsMod.saveHints === 'function'
    ? settingsMod.saveHints
    : async (patch) => {
        const current = await loadHints();
        const merged = { ...current, ...patch };
        try {
          await chrome.storage.local.set({ [STORAGE_LOCAL.hints]: merged });
        } catch (e) {
          log.warn('saveHints', e);
        }
        return merged;
      };

const urlKey = typeof urlKeyMod.urlKey === 'function' ? urlKeyMod.urlKey : () => null;
const classifyUrl =
  typeof urlKeyMod.classifyUrl === 'function' ? urlKeyMod.classifyUrl : () => 'ok';
const getOwnOrigin =
  typeof urlKeyMod.getOwnOrigin === 'function'
    ? urlKeyMod.getOwnOrigin
    : () => {
        try {
          return chrome.runtime.getURL('').replace(/\/+$/, '');
        } catch {
          return '';
        }
      };

/* ── DOM references ──────────────────────────────────────────────────────── */

const el = {
  /** @type {HTMLElement|null} */ tablist: null,
  /** @type {HTMLElement|null} */ pinned: null,
  /** @type {HTMLInputElement|null} */ searchInput: null,
  /** @type {HTMLElement|null} */ searchClear: null,
  /** @type {HTMLElement|null} */ searchCount: null,
  /** @type {HTMLElement|null} */ searchEmpty: null,
  /** @type {HTMLElement|null} */ btnSettings: null,
  /** @type {HTMLElement|null} */ btnNewTab: null,
  /** @type {HTMLElement|null} */ btnTrash: null,
  /** @type {HTMLElement|null} */ trashBadge: null,
  /** @type {HTMLElement|null} */ hintBanner: null,
  /** @type {HTMLElement|null} */ hintOpenSettings: null,
  /** @type {HTMLElement|null} */ hintDismiss: null,
  /** @type {HTMLElement|null} */ policyBanner: null,
  /** @type {HTMLElement|null} */ hostBanner: null,
  /** @type {HTMLElement|null} */ hostOpen: null,
  /** @type {HTMLElement|null} */ hostDismiss: null,
  /** @type {HTMLElement|null} */ dropIndicator: null,
  /** @type {HTMLElement|null} */ contextMenu: null,
  /** @type {HTMLElement|null} */ trashPopover: null,
  /** @type {HTMLElement|null} */ settingsView: null,
  /** @type {HTMLElement|null} */ confirmBar: null,
  /** @type {HTMLElement|null} */ toast: null,
};

function collectRefs() {
  el.tablist = document.getElementById('tablist');
  el.pinned = document.getElementById('pinned');
  el.searchInput = document.getElementById('search-input');
  el.searchClear = document.getElementById('search-clear');
  el.searchCount = document.getElementById('search-count');
  el.searchEmpty = document.getElementById('search-empty');
  el.btnSettings = document.getElementById('btn-settings');
  el.btnRailMode = document.getElementById('btn-rail-mode');
  el.btnNewTab = document.getElementById('btn-new-tab');
  el.btnTrash = document.getElementById('btn-trash');
  el.btnPopout = document.getElementById('btn-popout');
  el.widgetRail = document.getElementById('widget-rail');
  el.trashBadge = document.getElementById('trash-badge');
  el.hintBanner = document.getElementById('hint-banner');
  el.hintOpenSettings = document.getElementById('hint-open-settings');
  el.hintDismiss = document.getElementById('hint-dismiss');
  el.policyBanner = document.getElementById('policy-banner');
  el.hostBanner = document.getElementById('host-access-banner');
  el.hostOpen = document.getElementById('host-access-open');
  el.hostDismiss = document.getElementById('host-access-dismiss');
  el.dropIndicator = document.getElementById('drop-indicator');
  el.contextMenu = document.getElementById('context-menu');
  el.trashPopover = document.getElementById('trash-popover');
  el.settingsView = document.getElementById('settings-view');
  el.confirmBar = document.getElementById('confirm-bar');
  el.toast = document.getElementById('toast');
}

/* ── Tab operations (spec §9.1: everything goes through tab-ops.js) ──────── */

const fallbackOps = {
  update: (tabId, props) => chrome.tabs.update(tabId, props),
  remove: (tabIds) => chrome.tabs.remove(tabIds),
  create: (props) => chrome.tabs.create(props),
  move: (tabIds, props) => chrome.tabs.move(tabIds, props),
  highlight: (info) => chrome.tabs.highlight(info),
  group: (options) => chrome.tabs.group(options),
  ungroup: (tabIds) => chrome.tabs.ungroup(tabIds),
  discard: (tabId) => chrome.tabs.discard(tabId),
  reload: (tabId) => chrome.tabs.reload(tabId),
  duplicate: (tabId) => chrome.tabs.duplicate(tabId),
};

/** Replaced by `tab-ops.js` (retry + toast + resync) when that module loads. */
let ops = { ...fallbackOps };

/** @type {Record<string, any>} feature modules owned by other file groups */
export const modules = Object.create(null);

/* ── Panel identity ──────────────────────────────────────────────────────── */

let windowId = -1;
/** True in the detached copy, which hides the button that would detach it again. */
let poppedOut = false;
let testMode = false;
/** @type {typeof HINTS_DEFAULTS} */
let hints = { ...HINTS_DEFAULTS };
/** @type {object|null} the `vt/panel-ready` response */
let panelReadyResponse = null;
let policyTimer = null;
let toastTimer = null;

/* ── Boot ────────────────────────────────────────────────────────────────── */

async function boot() {
  collectRefs();
  render.init();

  // 1 — language and strings (templates hold their own DocumentFragment, which
  //     `document.querySelectorAll` does not reach into).
  try {
    applyI18n(document);
  } catch (e) {
    log.warn('applyI18n', e);
    applyI18nFallback(document);
  }
  for (const tpl of document.querySelectorAll('template')) {
    try {
      applyI18n(tpl.content);
    } catch (e) {
      log.warn('applyI18n template', e);
    }
  }

  // 2 / 3 — settings, the hosting window and the locked-tab set, together.
  //
  // None of the three depends on the other two, and each is a round trip out of the
  // document: asking for them one after another put three of them in front of the first
  // paint for no reason. The tab list is what the reader opened the panel for, so
  // everything in front of it is measured (tests/specs/29-open-latency.spec.js).
  const qs = new URLSearchParams(location.search);
  testMode = qs.has('windowId');
  const [settings, hostWindowId] = await Promise.all([
    loadSettings(),
    testMode
      ? Promise.resolve(Number(qs.get('windowId')))
      : chrome.windows.getCurrent().then((w) => w.id),
    // Resolved before the first paint so a locked card is drawn locked rather than
    // flickering its close button for a frame — but concurrently, not in front.
    locks.load(),
  ]);
  windowId = hostWindowId;
  render.applySettingsAttrs(settings);
  applyRailModeButton(settings);
  watchSystemTheme();
  state.state.testMode = testMode;
  // The detached copy lives in its own popup window but keeps listing the window it
  // was opened FOR, which is what `?windowId=` already carries.
  poppedOut = qs.get('popout') === '1';
  document.documentElement.dataset.popout = poppedOut ? '1' : '0';

  // 4 — model + first paint
  widgets.init({
    rail: el.widgetRail,
    model: () => state.state,
    subscribe: state.subscribe,
    activate: (tabId) => void activate(tabId),
    setMuted: (tabId, muted) => void ops.update(tabId, { muted }),
    toast: (text) => showToast(text),
  });
  widgets.apply(railWidgets(settings));
  thumbs.init(thumbsContext());
  state.setRenderer(render.render);
  await state.init(windowId, settings);
  render.render();

  // 5 — stored previews for everything on screen
  await thumbs.loadFor(state.allUrlKeys());
  render.render();
  thumbs.touchDisplayed();

  // 6 — announce ourselves; the SW answers with the flags the panel needs
  const ready = await panelReady();
  panelReadyResponse = ready;
  state.applyReady(ready);

  // 7 — Chrome events and user interface
  state.registerChromeEvents();
  registerUi();
  registerStateSubscriptions();

  // 8 — banner bookkeeping (the banners themselves are wired in
  //     `adoptModuleOwnership()`, by `hints.js` when it is present)
  hints = await loadHints();

  // 9 — a clean good-bye; the `search-tabs` hand-off is consumed by whichever
  //     module owns the search box
  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void state.resync();
  });

  // The panel is usable from here on; publish the hooks before the optional
  // modules so a module that never resolves cannot block `__vt.ready`.
  publishTestHooks();

  await loadFeatureModules();
  await ensureBookmarks(state.state.settings);
  render.render();
  if (window.__vt) window.__vt.modulesReady = true;
}

/**
 * `vt/panel-ready` → `{ ok, version, policyDisabledUntil, fileAccess, hostAccess }`.
 * The service worker may still be starting, so one retry is allowed.
 * @returns {Promise<object|null>}
 */
async function panelReady() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await request({ type: MSG.PANEL_READY, windowId });
      if (response) return response;
    } catch (e) {
      if (attempt === 1) log.warn('panel-ready', e);
    }
    if (attempt === 0) await sleep(300); // the service worker may still be starting
  }
  return null;
}

/**
 * The tools the rail should be showing — none of them while the side column belongs
 * to the bookmarks.
 *
 * A DERIVED list, computed at the two call sites and nowhere stored: `settings.widgets`
 * stays exactly as the user ticked it, so switching back to `tools` brings their own
 * set back rather than an empty column. Handing `apply([])` is also the path ten spec
 * files already exercise, so hiding the rail this way is the behaviour that is already
 * under test.
 *
 * @param {any} settings
 * @returns {string[]}
 */
function railWidgets(settings) {
  if (!settings) return [];
  return settings.railMode === 'bookmarks' ? [] : (settings.widgets || []);
}

/** The bookmark column's module, imported at most once. @type {Promise<any>|null} */
let bookmarksImport = null;
/** Set before `init()` is awaited, so two settings changes cannot start it twice. */
let bookmarksStarted = false;
/** `pagehide` has run. Nothing may be started on the document after that. */
let panelClosing = false;

/**
 * Load the bookmark column — and only for a profile that has actually asked for it.
 *
 * Deliberately NOT in `loadFeatureModules()`'s fixed list. Everything in that list is
 * imported during boot on every install, and `tests/specs/29-open-latency.spec.js`
 * measures what boot costs; a file nobody in `tools` mode will ever see has no business
 * in that budget. The cost of the feature for someone who never turns it on is the
 * `railMode` comparison below.
 *
 * `bookmarks.js` subscribes to `settings` itself for its own build and teardown, so it
 * is started once and then left alone.
 *
 * @param {any} settings
 * @returns {Promise<void>}
 */
async function ensureBookmarks(settings) {
  if (!settings || settings.railMode !== 'bookmarks' || panelClosing) return;
  if (!bookmarksImport) {
    bookmarksImport = import('./bookmarks.js').catch((e) => {
      log.warn('optional module ./bookmarks.js not loaded', e);
      return null;
    });
  }
  const mod = await bookmarksImport;
  // `pagehide` can land inside that import. `onPageHide()` would have found
  // `modules.bookmarks` still undefined and called no `destroy()` at all, so starting the
  // column now would register five Chrome listeners on a document that has already
  // broadcast `PANEL_CLOSING`.
  if (!mod || bookmarksStarted || panelClosing) return;
  bookmarksStarted = true;
  modules.bookmarks = mod;
  try {
    if (typeof mod.init === 'function') await mod.init(panelContext());
  } catch (e) {
    log.error('init ./bookmarks.js', e);
  }
}

/** Context handed to `thumbs.js` (spec-addendum A9). */
function thumbsContext() {
  return {
    getSettings: () => state.state.settings,
    getHostAccess: () => state.state.hostAccess,
    isPolicyActive: () => state.isPolicyActive(),
    getFileAccess: () => state.state.fileAccess,
    ownOrigin: getOwnOrigin(),
    requestCapture: (payload) => {
      void Promise.resolve(
        request({ type: MSG.CAPTURE_REQUEST, windowId, ...payload }),
      ).catch(() => {});
    },
    rerenderTab: (tabId) => render.rerenderTab(tabId),
    getTab: (tabId) => state.getTab(tabId),
  };
}

/* ── Feature modules owned by other file groups ──────────────────────────── */

/**
 * Each module may export `init(ctx)`; `tab-ops.js` may additionally export the
 * `chrome.tabs` wrappers used by `ops`, and `toast.js` a `showToast()`.
 * A module that fails to load is logged once and skipped.
 */
async function loadFeatureModules() {
  const wanted = [
    ['toast', './toast.js'],
    ['tabOps', './tab-ops.js'],
    ['hints', './hints.js'],
    ['search', './search.js'],
    ['keyboard', './keyboard.js'],
    ['contextMenu', './context-menu.js'],
    ['dnd', './dnd.js'],
    ['trash', './trash.js'],
    ['settingsView', './settings-view.js'],
    ['palette', './palette.js'],
    ['toolStrip', './tool-strip.js'],
  ];
  const ctx = panelContext();
  for (const [name, path] of wanted) {
    let mod = null;
    try {
      mod = await import(path);
    } catch (e) {
      log.warn(`optional module ${path} not loaded`, e);
      continue;
    }
    modules[name] = mod;
    if (name === 'tabOps') adoptOps(mod);
    try {
      if (typeof mod.init === 'function') await mod.init(ctx);
    } catch (e) {
      log.error(`init ${path}`, e);
    }
  }
  adoptModuleOwnership();
}

/**
 * Hand the jobs that a feature module owns over to it, so nothing is wired
 * twice: `search.js` owns the query and `.is-hidden`, `keyboard.js` owns the
 * roving `tabindex` and post-close focus, `hints.js` owns the three banners.
 */
function adoptModuleOwnership() {
  if (modules.search && typeof modules.search.getFilter === 'function') {
    render.setFilterSource(() => modules.search.getFilter() || state.state.filter);
    // Deterministic re-paint after each render pass (search.js also watches the
    // DOM, but an explicit call removes the one-frame lag of the observer).
    state.subscribe('rendered', () => {
      if (typeof modules.search.applyFilter === 'function') modules.search.applyFilter();
    });
  }
  if (modules.keyboard && typeof modules.keyboard.sync === 'function') render.setRovingOwner(true);

  if (modules.hints) {
    if (typeof modules.hints.applyPanelReady === 'function') modules.hints.applyPanelReady(panelReadyResponse);
    if (typeof modules.hints.checkSidePosition === 'function') {
      void Promise.resolve(modules.hints.checkSidePosition())
        .then((side) => {
          if (side) state.state.side = side;
        })
        .catch((e) => log.warn('checkSidePosition', e));
    }
  } else {
    // No hints module: this file owns the banners.
    void checkSidePosition();
    applyPolicy(state.state.policyDisabledUntil);
    updateHostAccessBanner();
  }

  if (!modules.search) void consumePendingFocusSearch();
}

/** @param {Record<string, any>} mod */
function adoptOps(mod) {
  const next = { ...fallbackOps };
  const source = mod && typeof mod.ops === 'object' && mod.ops ? mod.ops : mod;
  for (const name of Object.keys(fallbackOps)) {
    if (source && typeof source[name] === 'function') next[name] = source[name].bind(source);
  }
  ops = next;
}

/** The shared context object every feature module receives. */
function panelContext() {
  return {
    state,
    thumbs,
    el,
    modules,
    MSG,
    get windowId() {
      return windowId;
    },
    get settings() {
      return state.state.settings;
    },
    get ops() {
      return ops;
    },
    getSettings: () => state.state.settings,
    // The live tab model, under the name `widgets.js` already hands its tools. The
    // bookmark column keys its rows against it to find the pages you already have open.
    model: () => state.state,
    render: () => render.render(),
    renderModule: render,
    rerenderTab: (tabId) => render.rerenderTab(tabId),
    ownOrigin: getOwnOrigin(),
    get testMode() {
      return testMode;
    },
    get fileAccess() {
      return state.state.fileAccess;
    },
    get hostAccess() {
      return state.state.hostAccess;
    },
    get policyDisabledUntil() {
      return state.state.policyDisabledUntil;
    },
    t,
    request,
    broadcast,
    activate,
    closeTab,
    closeTabs,
    newTab,
    showToast,
    focusSearch,
    popOut,
    scheduleRender: state.scheduleRender,
    resync: state.resync,
    subscribe: state.subscribe,
  };
}

/* ── Pointer wiring (spec §9.1) ──────────────────────────────────────────── */

function registerUi() {
  if (el.tablist) {
    el.tablist.addEventListener('click', onListClick);
    el.tablist.addEventListener('auxclick', onAuxClick);
    el.tablist.addEventListener('mousedown', onMouseDown);
    el.tablist.addEventListener('dblclick', onListDoubleClick);
    el.tablist.addEventListener('pointerenter', () => {
      state.state.pointerInList = true;
    });
    el.tablist.addEventListener('pointerleave', () => {
      state.state.pointerInList = false;
    });
    el.tablist.addEventListener('scroll', () => thumbs.touchDisplayed(), { passive: true });
  }

  if (el.pinned) {
    el.pinned.addEventListener('click', onListClick);
    el.pinned.addEventListener('auxclick', onAuxClick);
    el.pinned.addEventListener('mousedown', onMouseDown);
  }

  if (el.btnPopout) {
    el.btnPopout.hidden = poppedOut;
    el.btnPopout.addEventListener('click', () => void popOut());
  }

  if (el.btnNewTab) {
    el.btnNewTab.addEventListener('click', () => void newTab(true));
    el.btnNewTab.addEventListener('auxclick', (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      void newTab(false);
    });
  }

  // `trash.js`, `settings-view.js` and `hints.js` bind these buttons in their
  // own `init()`. The handlers below are fallbacks that stand down as soon as
  // the owning module is loaded, so nothing is ever handled twice.
  if (el.btnTrash) {
    el.btnTrash.addEventListener('click', () => {
      if (modules.trash) return;
      log.warn('trash module unavailable');
    });
  }

  if (el.btnRailMode) {
    el.btnRailMode.addEventListener('click', () => {
      // Written to storage rather than to a local copy, the way the strip's own toggle
      // does it: `storage.onChanged` is what tells the rail, the strip and the drawer
      // at once, in every panel that is open.
      const next = state.state.settings.railMode === 'bookmarks' ? 'tools' : 'bookmarks';
      void saveSettings({ railMode: next }).catch((e) => log.warn('railMode', e));
    });
  }

  if (el.btnSettings) {
    el.btnSettings.addEventListener('click', () => {
      if (modules.settingsView) return;
      log.warn('settings module unavailable');
    });
  }

  if (el.hintOpenSettings) {
    el.hintOpenSettings.addEventListener('click', () => {
      if (modules.hints) return;
      void openUrl(CHROME_APPEARANCE_URL);
    });
  }
  if (el.hintDismiss) {
    el.hintDismiss.addEventListener('click', () => {
      if (modules.hints) return;
      void dismissSideHint();
    });
  }
  if (el.hostOpen) {
    el.hostOpen.addEventListener('click', () => {
      if (modules.hints) return;
      void openUrl(extensionDetailsUrl(chrome.runtime.id));
    });
  }
  if (el.hostDismiss) {
    el.hostDismiss.addEventListener('click', () => {
      if (modules.hints) return;
      void dismissHostBanner();
    });
  }

  // A drag must not fight the "scroll the active card into view" rule.
  document.addEventListener('dragstart', () => {
    state.state.dragging = true;
  });
  document.addEventListener('dragend', () => {
    state.state.dragging = false;
  });
  document.addEventListener('drop', () => {
    state.state.dragging = false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[STORAGE_SESSION.pendingFocusSearch]) {
      if (modules.search) return; // search.js consumes the hand-off itself
      void consumePendingFocusSearch();
    }
  });
}

/**
 * Three jobs, three attributes. The accessible NAME is fixed and names the control
 * ("Bookmarks in the side column"); `aria-pressed` carries the STATE; the tooltip
 * carries the ACTION. Putting the action in the name as well produced the reading
 * "Show tools instead, toggle button, pressed" while the column showed bookmarks,
 * which says the state twice and contradicts itself once.
 *
 * @param {import('../common/settings-schema.js').Settings} settings
 */
function applyRailModeButton(settings) {
  const button = el.btnRailMode;
  if (!button) return;
  const bookmarks = settings.railMode === 'bookmarks';
  button.setAttribute('aria-pressed', bookmarks ? 'true' : 'false');
  button.setAttribute('aria-label', t('railModeButton'));
  button.title = bookmarks ? t('railSwitchToTools') : t('railSwitchToBookmarks');
}

function registerStateSubscriptions() {
  state.subscribe('settings', (settings) => {
    render.applySettingsAttrs(settings);
    applyRailModeButton(settings);
    widgets.apply(railWidgets(settings));
    // First time into `bookmarks` mode this is where the column is imported; every time
    // after, it is a comparison and a resolved promise nobody waits on.
    void ensureBookmarks(settings);
  });
  state.subscribe('policy', (until) => {
    if (modules.hints) return; // hints.js listens for vt/policy-changed itself
    applyPolicy(until);
  });
  state.subscribe('host-access', (info) => {
    if (modules.hints) return;
    void onHostAccessChanged(info);
  });
}

/** @param {MouseEvent} event */
function onListClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const closeBtn = target.closest('.close');
  if (closeBtn) {
    event.preventDefault();
    event.stopPropagation();
    const card = closeBtn.closest('.tab-card, .pinned-tile');
    if (card) void closeTab(Number(card.dataset.tabId), { fromCloseButton: true });
    return;
  }

  const audioBtn = target.closest('.audio');
  if (audioBtn) {
    event.preventDefault();
    event.stopPropagation();
    const card = audioBtn.closest('.tab-card, .pinned-tile');
    if (card) void toggleMute(Number(card.dataset.tabId));
    return;
  }

  const header = target.closest('.group-header');
  if (header) {
    // `context-menu.js` owns the header (collapse toggle + colour swatch); this
    // is the fallback for a build without that module.
    if (modules.contextMenu) return;
    if (target.closest('.group-swatch') || target.closest('.group-rename')) return;
    event.preventDefault();
    void toggleGroupCollapsed(Number(header.dataset.groupId));
    return;
  }

  const item = target.closest('.tab-card, .pinned-tile');
  if (!item) return;
  const tabId = Number(item.dataset.tabId);
  if (!Number.isFinite(tabId)) return;
  render.setRoving(tabId);

  if (event.ctrlKey || event.metaKey) {
    void toggleHighlight(tabId);
    return;
  }
  if (event.shiftKey) {
    void highlightRange(tabId);
    return;
  }
  void onActivateClick(tabId);
}

/** @param {MouseEvent} event */
function onAuxClick(event) {
  if (event.button !== 1) return;
  const target = event.target instanceof Element ? event.target : null;
  const item = target ? target.closest('.tab-card, .pinned-tile') : null;
  if (!item) return;
  event.preventDefault();
  if (state.state.settings.middleClickCloses === false) return;
  void closeTab(Number(item.dataset.tabId), { fromCloseButton: false });
}

/** Suppress the autoscroll/paste that a middle press would otherwise start. */
function onMouseDown(event) {
  if (event.button !== 1) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target && target.closest('.tab-card, .pinned-tile')) event.preventDefault();
}

/** @param {MouseEvent} event */
function onListDoubleClick(event) {
  if (state.state.settings.doubleClickNewTab === false) return;
  const target = event.target instanceof Element ? event.target : null;
  if (!target || target.closest('.tab-card, .pinned-tile, .group-header')) return;
  event.preventDefault();
  void newTab(true);
}

/**
 * Open this tab list in a window of its own.
 *
 * Chrome fixes the side panel's minimum inner width at 360 px and gives extensions no
 * way to change it, so a detached window is the only way to get a genuinely narrow
 * strip: this one is ours, and `windows.create` takes whatever width we ask for.
 *
 * The copy is scoped to the window it was opened for, not to the popup it lives in —
 * `?windowId=` already carries that — so it keeps listing the tabs the user was
 * looking at. It is a `popup` window, which has no address bar or tab strip of its
 * own, and it is parked against the working area's right edge at the panel's own
 * minimum-ish width.
 *
 * @returns {Promise<void>}
 */
async function popOut() {
  const key = `${STORAGE_SESSION.popoutWindow}:${windowId}`;

  // Already open? Focus it rather than piling up copies. The id is remembered in
  // `storage.session`, which is cleared on restart, so a stale id can only ever
  // survive within a session and `windows.update` rejects it harmlessly.
  try {
    const stored = await chrome.storage.session.get(key);
    const existing = stored && stored[key];
    if (Number.isInteger(existing)) {
      await chrome.windows.update(existing, { focused: true });
      return;
    }
  } catch {
    /* not open any more — fall through and create one */
  }

  const url = chrome.runtime.getURL(`sidepanel/sidepanel.html?windowId=${windowId}&popout=1`);
  const size = { width: POPOUT_WIDTH, height: Math.max(400, Number(screen.availHeight) || 800) };

  /* Park it against the right edge of the working area, which is where a docked strip
   * belongs. Chrome validates the bounds and rejects anything it considers off screen
   * with "Bounds must be at least 50% within visible screen space" — and it reports no
   * usable screen geometry at all in some environments, where EVERY explicit position
   * is refused (measured: headless Chromium 151 rejects left/top outright, including a
   * placement well inside a 1280x800 screen it reports itself). So the position is an
   * attempt, not a requirement: if Chrome will not take it, the window still opens and
   * Chrome places it.
   */
  const availLeft = Number.isFinite(screen.availLeft) ? screen.availLeft : 0;
  const availTop = Number.isFinite(screen.availTop) ? screen.availTop : 0;
  const availWidth = Number(screen.availWidth) || 0;
  const placements = [];
  if (availWidth >= POPOUT_WIDTH * 2) {
    placements.push({ ...size, left: availLeft + availWidth - POPOUT_WIDTH, top: availTop });
  }
  placements.push(size);

  for (const bounds of placements) {
    try {
      const created = await chrome.windows.create({ url, type: 'popup', focused: true, ...bounds });
      if (created && Number.isInteger(created.id)) {
        await chrome.storage.session.set({ [key]: created.id });
      }
      return;
    } catch (e) {
      log.warn('popOut', e);
    }
  }
  showToast(t('operationFailed'));
}

/* ── Tab actions ─────────────────────────────────────────────────────────── */

/**
 * Activate a tab, asking for a refreshed preview of the outgoing tab on the way
 * out (spec-addendum A12) without ever delaying the switch on it.
 * @param {number} tabId
 * @returns {Promise<void>}
 */
export async function activate(tabId) {
  if (modules.tabOps && typeof modules.tabOps.activate === 'function') {
    try {
      await modules.tabOps.activate(tabId); // identical A12 flow, with retries
      return;
    } catch (e) {
      log.warn('activate', e);
      return;
    }
  }
  const previous = state.state.activeTabId;
  if (state.state.settings.captureBeforeSwitch !== false && previous != null && previous !== tabId) {
    /* Fire and forget — deliberately NOT awaited.
     *
     * Blocking the switch on this capture is what made a card click feel slow:
     * measured click-to-switch p50 218 ms with the wait against 122 ms without it,
     * with a tail to 576 ms, and that was a warm worker in a container. Switching
     * tabs is the panel's primary job, so it does not queue behind a screenshot.
     *
     * Correctness does not depend on winning the race. `capture.js` step 3a drops a
     * job whose tab is no longer active, so a capture that arrives after the switch
     * is discarded rather than filed against the wrong tab; the outgoing card simply
     * keeps the preview it already had. When the worker is warm it usually still
     * wins, which is the freshness A12 was after.
     */
    Promise.resolve(
      request({
        type: MSG.CAPTURE_REQUEST,
        windowId,
        tabId: previous,
        reason: 'before-switch',
      }),
    ).catch(() => null);
  }
  try {
    await ops.update(tabId, { active: true });
  } catch (e) {
    log.warn('activate', e);
    showToast(t('operationFailed'));
    void state.resync();
  }
}

/**
 * Click on a card: activate it, or — when it is already active and the user
 * asked for it — switch back to the most recently used other tab (spec §9.1).
 * @param {number} tabId
 */
async function onActivateClick(tabId) {
  if (tabId !== state.state.activeTabId || state.state.settings.clickActiveTabSwitchesBack !== true) {
    await activate(tabId);
    return;
  }
  const candidates = state
    .orderedTabs()
    .filter((tab) => tab.id !== tabId && typeof tab.lastAccessed === 'number');
  if (!candidates.length) return; // Chrome < 121: `lastAccessed` is undefined
  const previous = candidates.reduce((best, tab) => (tab.lastAccessed > best.lastAccessed ? tab : best));
  await activate(previous.id);
}

/**
 * Close one tab and keep the keyboard focus usable (spec-addendum A15.4).
 * @param {number} tabId
 * @param {{fromCloseButton?: boolean}} [options]
 */
export async function closeTab(tabId, options = {}) {
  const cards = render.visibleCards();
  const index = cards.findIndex((card) => Number(card.dataset.tabId) === tabId);
  const successor = index >= 0 ? cards[index + 1] || cards[index - 1] || null : null;
  const successorId = successor ? Number(successor.dataset.tabId) : null;
  const hadFocus = index >= 0 && cards[index].contains(document.activeElement);

  try {
    await ops.remove(tabId);
  } catch (e) {
    log.warn('closeTab', e);
    showToast(t('operationFailed'));
    void state.resync();
    return;
  }
  // keyboard.js records the successor on click-capture and restores focus in
  // its own render sync; only take over when that module is absent.
  if (hadFocus && !modules.keyboard) focusAfterRender(successorId, Boolean(options.fromCloseButton));
}

/**
 * @param {number[]} tabIds
 * @returns {Promise<void>}
 */
export async function closeTabs(tabIds) {
  if (!tabIds || !tabIds.length) return;
  try {
    await ops.remove(tabIds);
  } catch (e) {
    log.warn('closeTabs', e);
    showToast(t('operationFailed'));
    void state.resync();
  }
}

/**
 * @param {boolean} active foreground or background tab
 * @returns {Promise<void>}
 */
export async function newTab(active = true) {
  try {
    await ops.create({ windowId, active });
  } catch (e) {
    log.warn('newTab', e);
    showToast(t('operationFailed'));
  }
}

/** @param {number} tabId */
async function toggleMute(tabId) {
  const tab = state.getTab(tabId);
  if (!tab) return;
  const muted = Boolean(tab.mutedInfo && tab.mutedInfo.muted);
  try {
    await ops.update(tabId, { muted: !muted });
  } catch (e) {
    log.warn('toggleMute', e);
    showToast(t('operationFailed'));
  }
}

/** Ctrl/Cmd + click — never un-highlights the active tab (spec §9.1). */
async function toggleHighlight(tabId) {
  const tab = state.getTab(tabId);
  if (!tab) return;
  if (tab.active && tab.highlighted) return;
  try {
    await ops.update(tabId, { highlighted: !tab.highlighted });
  } catch (e) {
    log.warn('toggleHighlight', e);
    showToast(t('operationFailed'));
  }
}

/** Shift + click — `tabs.highlight` takes indices, active first (verified). */
async function highlightRange(tabId) {
  const target = state.getTab(tabId);
  const active = state.state.activeTabId != null ? state.getTab(state.state.activeTabId) : null;
  if (!target) return;
  if (!active) {
    await activate(tabId);
    return;
  }
  const from = Math.min(active.index, target.index);
  const to = Math.max(active.index, target.index);
  const indices = state
    .orderedTabs()
    .filter((tab) => tab.index >= from && tab.index <= to)
    .map((tab) => tab.index)
    .filter((index) => index !== active.index);
  try {
    await ops.highlight({ windowId, tabs: [active.index, ...indices] });
  } catch (e) {
    log.warn('highlightRange', e);
    showToast(t('operationFailed'));
  }
}

/** @param {number} groupId */
async function toggleGroupCollapsed(groupId) {
  const group = state.state.groups.get(groupId);
  if (!group || !chrome.tabGroups) return;
  try {
    await chrome.tabGroups.update(groupId, { collapsed: !group.collapsed });
  } catch (e) {
    log.warn('toggleGroupCollapsed', e);
    showToast(t('operationFailed'));
    void state.resync();
  }
}

/**
 * Move focus once the removal has been rendered.
 * @param {number|null} tabId
 * @param {boolean} preferCloseButton
 */
function focusAfterRender(tabId, preferCloseButton) {
  const unsubscribe = state.subscribe('rendered', () => {
    unsubscribe();
    if (tabId == null) {
      if (el.btnNewTab) el.btnNewTab.focus();
      return;
    }
    const card = render.elementFor(tabId);
    if (!card) {
      if (el.btnNewTab) el.btnNewTab.focus();
      return;
    }
    render.setRoving(tabId);
    const closeBtn = preferCloseButton ? card.querySelector('.close') : null;
    if (closeBtn) closeBtn.focus();
    else card.focus();
  });
  state.scheduleRender();
}

/* ── Hints and banners (spec §9.7, spec-addendum A7e) ────────────────────── */

/**
 * `chrome.sidePanel.getLayout()` (Chrome 140+, **no arguments** — measured)
 * reports which side Chrome docked the panel on.
 */
async function checkSidePosition() {
  const sidePanel = chrome.sidePanel;
  if (!sidePanel || typeof sidePanel.getLayout !== 'function') return;
  let layout = null;
  try {
    layout = await sidePanel.getLayout();
  } catch (e) {
    log.warn('sidePanel.getLayout', e);
    return;
  }
  const side = layout && (layout.side === 'left' || layout.side === 'right') ? layout.side : 'unknown';
  state.state.side = side;
  document.documentElement.dataset.side = side;
  if (side !== 'left') return;
  if (hints.sidePositionHintDismissed) return;
  if (el.hintBanner) el.hintBanner.hidden = false;
}

async function dismissSideHint() {
  if (el.hintBanner) el.hintBanner.hidden = true;
  hints = await saveHints({ sidePositionHintDismissed: true });
}

/**
 * @param {number} until ms timestamp
 */
function applyPolicy(until) {
  state.state.policyDisabledUntil = Number(until) || 0;
  const active = state.isPolicyActive();
  if (el.policyBanner) el.policyBanner.hidden = !active;
  if (policyTimer !== null) {
    clearTimeout(policyTimer);
    policyTimer = null;
  }
  if (!active) return;
  // Capped so a bogus far-future value cannot overflow the setTimeout limit.
  const delay = Math.min(Math.max(500, state.state.policyDisabledUntil - Date.now() + 250), 10 * 60000);
  policyTimer = setTimeout(() => applyPolicy(state.state.policyDisabledUntil), delay);
  state.scheduleRender();
}

/**
 * @param {{hostAccess: boolean, changed?: boolean, seenFailure?: boolean}} info
 */
async function onHostAccessChanged(info) {
  // A change in the grant clears an earlier dismissal, so a later withdrawal
  // shows the banner again (spec-addendum A7e).
  if (info && info.changed) hints = await saveHints({ siteAccessBannerDismissedAt: 0 });
  updateHostAccessBanner();
}

function updateHostAccessBanner() {
  if (!el.hostBanner) return;
  const needed = state.state.hostAccess === false || state.state.sawNoHostAccess === true;
  const dismissed = Number(hints.siteAccessBannerDismissedAt || 0) > 0;
  el.hostBanner.hidden = !(needed && !dismissed);
}

async function dismissHostBanner() {
  if (el.hostBanner) el.hostBanner.hidden = true;
  hints = await saveHints({ siteAccessBannerDismissedAt: Date.now() });
}

/**
 * @param {string} url
 */
async function openUrl(url) {
  try {
    await chrome.tabs.create({ url });
  } catch (e) {
    log.warn('openUrl', e);
    showToast(t('openUrlManually', [url]));
  }
}

/* ── Focus hand-off from the `search-tabs` command ───────────────────────── */

async function consumePendingFocusSearch() {
  let entry = null;
  try {
    const stored = await chrome.storage.session.get(STORAGE_SESSION.pendingFocusSearch);
    entry = stored ? stored[STORAGE_SESSION.pendingFocusSearch] : null;
    if (!entry) return;
    await chrome.storage.session.remove(STORAGE_SESSION.pendingFocusSearch);
  } catch (e) {
    log.warn('consumePendingFocusSearch', e);
    return;
  }
  if (Date.now() - (Number(entry.at) || 0) >= PENDING_FOCUS_SEARCH_TTL_MS) return;
  if (entry.windowId != null && entry.windowId !== windowId) return;
  focusSearch();
}

/** Focus (and select) the search box. */
export function focusSearch() {
  const fn = pickFn(modules.search, ['focusSearch', 'focus']);
  if (fn) {
    try {
      fn();
      return;
    } catch (e) {
      log.warn('search.focusSearch', e);
    }
  }
  if (!el.searchInput) return;
  el.searchInput.focus();
  el.searchInput.select();
}

/* ── Toast (owned by toast.js; this is the fallback) ─────────────────────── */

/**
 * @param {string} message already localised
 */
export function showToast(message) {
  const mod = modules.toast;
  const fn = pickFn(mod, ['showToast', 'toast', 'show']);
  if (fn) {
    try {
      fn(message);
      return;
    } catch (e) {
      log.warn('toast module', e);
    }
  }
  if (!el.toast) return;
  el.toast.textContent = message;
  el.toast.hidden = false;
  el.toast.classList.add('is-visible');
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.classList.remove('is-visible');
    el.toast.hidden = true;
    toastTimer = null;
  }, TOAST_MS);
}

/* ── Misc helpers ────────────────────────────────────────────────────────── */

/**
 * First function a module exports under one of `names`.
 * @param {Record<string, any>|undefined|null} mod
 * @param {string[]} names
 * @returns {Function|null}
 */
function pickFn(mod, names) {
  if (!mod) return null;
  for (const name of names) if (typeof mod[name] === 'function') return mod[name];
  return null;
}

/** Re-resolve `theme: 'system'` when the OS flips (spec §8.1). */
function watchSystemTheme() {
  let media = null;
  try {
    media = window.matchMedia('(prefers-color-scheme: dark)');
  } catch {
    return;
  }
  const onChange = () => {
    if ((state.state.settings.theme || 'system') === 'system') {
      render.applySettingsAttrs(state.state.settings);
    }
  };
  if (typeof media.addEventListener === 'function') media.addEventListener('change', onChange);
  else if (typeof media.addListener === 'function') media.addListener(onChange);
}

function onPageHide() {
  panelClosing = true;
  widgets.destroy();
  // The bookmark column owns Chrome listeners and two timers of its own; a `pagehide`
  // that left them registered would leave them pointing at a dead document.
  if (modules.bookmarks && typeof modules.bookmarks.destroy === 'function') {
    try {
      modules.bookmarks.destroy();
    } catch (e) {
      log.warn('bookmarks destroy', e);
    }
  }
  void broadcast({ type: MSG.PANEL_CLOSING, windowId });
  thumbs.dispose();
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {Element|DocumentFragment} root */
function applyI18nFallback(root) {
  const scope = root || document;
  for (const node of scope.querySelectorAll('[data-i18n]')) {
    const value = t(node.dataset.i18n);
    if (value) node.textContent = value;
  }
  for (const node of scope.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of String(node.dataset.i18nAttr).split(';')) {
      const [attr, key] = pair.split(':').map((part) => (part || '').trim());
      if (!attr || !key) continue;
      const value = t(key);
      if (value) node.setAttribute(attr, value);
    }
  }
  if (scope === document) {
    try {
      document.documentElement.lang = chrome.i18n.getUILanguage();
    } catch {
      /* not an extension context */
    }
  }
}

/**
 * Test hooks (spec §8.1 / Appendix A.1). Published unconditionally: spec 14(a)
 * exercises the production window-resolution path — i.e. without `?windowId=` —
 * and still reads `state.windowId`. The panel is an extension-origin document
 * with a strict CSP, so nothing outside the extension can reach this object.
 */
function publishTestHooks() {
  window.__vt = {
    ready: true,
    state: state.state,
    stateModule: state,
    render,
    thumbs,
    thumbStore,
    modules,
    ctx: panelContext(),
    activate,
    closeTab,
    newTab,
    urlKey,
    classifyUrl,
    debugState: () => thumbs.debugState(),
    get settings() {
      return state.state.settings;
    },
    get windowId() {
      return windowId;
    },
    get testMode() {
      return testMode;
    },
  };
}

boot().catch((e) => {
  log.error('panel bootstrap failed', e);
  try {
    window.__vt = { ready: false, error: String(e) };
  } catch {
    /* nothing else to do */
  }
});
