// Open-windows tool. See widgets.js for the tool contract.

import * as i18n from '../../common/i18n.js';
import * as log from '../../common/log.js';
import * as ops from '../tab-ops.js';

const t = (key, subs) => i18n.t(key, subs);

/** Windows are few; a cap only exists so a scripted hundred cannot flood the column. */
const MAX_WINDOWS = 20;

/** `tabs.onUpdated` fires several times per page load; one repaint covers them all. */
const REPAINT_DEBOUNCE_MS = 400;

/**
 * Every window you have open, and a way back to it.
 *
 * The panel lists ONE window by construction, and Chrome gives no picture of the others
 * at all — the taskbar shows a title, `Alt+Tab` shows a thumbnail of whatever was last
 * on screen, and neither says how many tabs are in there or what they are. Someone with
 * four windows open is navigating between them blind.
 *
 * Each row names the window by its active tab, which is what a person recognises it by,
 * and says how many tabs it holds. The window this panel is driving is marked rather
 * than hidden, so the list reads as "where am I among these".
 */
export const windowList = {
  id: 'windows',
  titleKey: 'widgetWindows',
  mount(body, ctx) {
    const list = document.createElement('div');
    list.className = 'w-rows';
    list.dataset.testid = 'widget-windows-list';

    const alone = document.createElement('div');
    alone.className = 'w-muted';
    alone.dataset.testid = 'widget-windows-alone';
    alone.textContent = t('widgetWindowsAlone');
    alone.hidden = true;

    body.append(alone, list);

    let alive = true;

    const paint = async () => {
      let windows = [];
      try {
        windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
      } catch (e) {
        log.warn('windows list', e);
        return;
      }
      if (!alive) return;

      const here = ops.windowId();
      list.textContent = '';
      const shown = windows.slice(0, MAX_WINDOWS);
      for (const win of shown) list.append(row(win, here));
      alone.hidden = shown.length > 1;
    };

    void paint();

    // A render of the tab list is NOT enough: opening a window somewhere else changes
    // nothing about this one, so the list would sit there stale until something local
    // happened. Chrome says so directly instead.
    //
    // `tabs.onUpdated` is in the set because a window is named after its active tab, and
    // at `windows.onCreated` that tab has no title yet — the row would read "untitled"
    // until something else happened to it. It also fires often, which is why every
    // listener goes through one coalescing timer rather than straight to `paint`.
    let timer = 0;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = 0;
        void paint();
      }, REPAINT_DEBOUNCE_MS);
    };

    const events = [
      chrome.windows.onCreated, chrome.windows.onRemoved, chrome.windows.onFocusChanged,
      chrome.tabs.onUpdated, chrome.tabs.onActivated, chrome.tabs.onRemoved,
    ];
    const listeners = [];
    for (const event of events) {
      if (!event || typeof event.addListener !== 'function') continue;
      event.addListener(schedule);
      listeners.push(event);
    }
    const off = typeof ctx.subscribe === 'function' ? ctx.subscribe('rendered', schedule) : null;

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      for (const event of listeners) {
        try {
          event.removeListener(schedule);
        } catch (e) {
          log.warn('windows listener', e);
        }
      }
      if (typeof off === 'function') off();
    };
  },
};

/**
 * @param {chrome.windows.Window} win
 * @param {number} here the window this panel is driving
 */
function row(win, here) {
  const tabs = win.tabs || [];
  const active = tabs.find((tab) => tab.active) || tabs[0] || null;
  const isHere = win.id === here;

  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'w-row';
  el.dataset.testid = 'widget-windows-row';
  el.dataset.windowId = String(win.id);
  if (isHere) el.dataset.current = '1';
  el.disabled = isHere;

  const name = document.createElement('span');
  name.className = 'w-row__main';
  // A window has no name of its own; people know it by what is on top of it.
  name.textContent = active ? (active.title || active.url || t('widgetWindowsUntitled'))
    : t('widgetWindowsUntitled');

  const count = document.createElement('span');
  count.className = 'w-row__aside';
  count.textContent = isHere ? t('widgetWindowsHere', [String(tabs.length)]) : String(tabs.length);

  el.append(name, count);
  el.title = tabs.slice(0, 12).map((tab) => tab.title || tab.url || '').join('\n');
  el.addEventListener('click', async () => {
    try {
      await chrome.windows.update(win.id, { focused: true });
    } catch (e) {
      log.warn('windows focus', e);
    }
  });
  return el;
}
