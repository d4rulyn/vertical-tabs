// Recently-used tabs tool. See widgets.js for the tool contract.

import * as i18n from '../../common/i18n.js';
import * as log from '../../common/log.js';
import * as ops from '../tab-ops.js';

const t = (key, subs) => i18n.t(key, subs);

/** Long enough to cover "the thing I was just on", short enough to stay a glance. */
const MAX_ROWS = 8;

/**
 * The tabs you were just on, most recent first.
 *
 * A vertical list is in the order tabs were OPENED, which stops being useful somewhere
 * around thirty tabs: the one you want is the one you were reading a minute ago, and
 * that is nowhere in particular. Chrome records `lastAccessed` on every tab, and nothing
 * in the browser's own UI shows it.
 *
 * The active tab is left out — it is the one you are looking at — and so are tabs that
 * have never been visited, which have no access time to sort by.
 *
 * `lastAccessed` is Chrome 121+; where it is missing the tool says so rather than
 * inventing an order from tab ids, which would just be "oldest first" wearing a
 * different hat.
 */
export const recentTabs = {
  id: 'recent',
  titleKey: 'widgetRecent',
  mount(body, ctx) {
    const list = document.createElement('div');
    list.className = 'w-rows';
    list.dataset.testid = 'widget-recent-list';

    const note = document.createElement('div');
    note.className = 'w-muted';
    note.dataset.testid = 'widget-recent-note';
    note.hidden = true;

    body.append(note, list);

    let alive = true;

    const paint = async () => {
      // Not the panel's model: its tab objects are the snapshot `tabs.query` returned,
      // and `lastAccessed` moves every time the reader looks at a tab without any event
      // the panel subscribes to. Reading it here was measured returning the order tabs
      // were LAST QUERIED in, which is not the order anyone visited them.
      let tabs = [];
      try {
        tabs = await chrome.tabs.query({ windowId: ops.windowId() });
      } catch (e) {
        log.warn('recent query', e);
        return;
      }
      if (!alive) return;

      if (!tabs.some((tab) => typeof tab.lastAccessed === 'number')) {
        note.textContent = t('widgetRecentUnsupported');
        note.hidden = false;
        list.textContent = '';
        return;
      }

      const ordered = tabs
        .filter((tab) => !tab.active && typeof tab.lastAccessed === 'number')
        .sort((a, b) => b.lastAccessed - a.lastAccessed)
        .slice(0, MAX_ROWS);

      note.hidden = ordered.length > 0;
      if (!ordered.length) note.textContent = t('widgetRecentNone');

      list.textContent = '';
      for (const tab of ordered) list.append(row(tab, ctx));
    };

    void paint();
    const repaint = () => void paint();
    // `onActivated` is the event that moves `lastAccessed`, and it is the whole point of
    // this list; a render covers tabs opening, closing and being renamed.
    if (chrome.tabs.onActivated && typeof chrome.tabs.onActivated.addListener === 'function') {
      chrome.tabs.onActivated.addListener(repaint);
    }
    const off = typeof ctx.subscribe === 'function' ? ctx.subscribe('rendered', repaint) : null;
    return () => {
      alive = false;
      try {
        if (chrome.tabs.onActivated) chrome.tabs.onActivated.removeListener(repaint);
      } catch (e) {
        log.warn('recent listener', e);
      }
      if (typeof off === 'function') off();
    };
  },
};

/** @param {any} tab @param {any} ctx */
function row(tab, ctx) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'w-row';
  el.dataset.testid = 'widget-recent-row';
  // NOT `data-tab-id`: that attribute means "this element IS the card for that tab",
  // and everything from the renderer to the drag layer to the specs addresses cards by
  // it. A second element carrying it made `[data-tab-id="…"]` match two nodes.
  el.dataset.recentTab = String(tab.id);

  const name = document.createElement('span');
  name.className = 'w-row__main';
  name.textContent = tab.title || tab.url || '';

  const when = document.createElement('span');
  when.className = 'w-row__aside';
  when.textContent = ago(tab.lastAccessed);

  el.append(name, when);
  el.title = `${tab.title || ''}\n${tab.url || ''}`.trim();
  el.addEventListener('click', () => {
    if (typeof ctx.activate === 'function') ctx.activate(tab.id);
  });
  return el;
}

/**
 * "2m", "3h", "4d" — a column of times has to stay narrow, and the exact second of a
 * tab you last touched yesterday is not information anyone wants.
 * @param {number} at
 */
function ago(at) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return t('agoNow');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('agoMinutes', [String(minutes)]);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('agoHours', [String(hours)]);
  return t('agoDays', [String(Math.round(hours / 24))]);
}
