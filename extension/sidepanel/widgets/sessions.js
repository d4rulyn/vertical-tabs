// Saved sessions widget. See widgets.js for the widget contract.

import * as i18n from '../../common/i18n.js';
import * as log from '../../common/log.js';
import { STORAGE_LOCAL } from '../../common/constants.js';

const t = (key, subs) => i18n.t(key, subs);

/** Keep the store bounded: a session is a URL list, but a hoarder is a hoarder. */
const MAX_SESSIONS = 40;
const MAX_TABS_PER_SESSION = 500;

/**
 * Save this window's tabs under a name, and reopen the set later.
 *
 * Chrome's own "recently closed" only reaches backwards, and only for a while. This
 * keeps a set of tabs on purpose and indefinitely, which is the thing people keep
 * dozens of tabs open FOR — the fear that closing them loses the trail.
 *
 * A session stores URLs and titles, nothing else: no cookies, no scroll position, no
 * form state. Restoring opens a new window rather than replacing the current one, so
 * it can never take tabs away.
 */
export const sessions = {
  id: 'sessions',
  titleKey: 'widgetSessions',
  iconId: 'i-layers',
  mount(body, ctx) {
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'w-btn';
    save.dataset.testid = 'widget-sessions-save';
    save.textContent = t('widgetSessionsSave');

    const list = document.createElement('div');
    list.className = 'w-sess__list';
    list.dataset.testid = 'widget-sessions-list';

    const empty = document.createElement('div');
    empty.className = 'w-muted';
    empty.dataset.testid = 'widget-sessions-empty';
    empty.textContent = t('widgetSessionsEmpty');

    body.append(save, empty, list);

    let alive = true;

    const paint = async () => {
      const saved = await read();
      if (!alive) return;
      empty.hidden = saved.length > 0;
      list.textContent = '';
      for (const session of saved) list.append(row(session, paint, ctx));
    };

    save.addEventListener('click', () => void saveCurrent(ctx).then(paint));
    void paint();

    return () => { alive = false; };
  },
};

/**
 * @typedef {{ id: string, name: string, at: number, tabs: {url: string, title: string}[] }} Session
 */

/** @returns {Promise<Session[]>} newest first; never rejects */
async function read() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_LOCAL.sessions);
    const list = stored && stored[STORAGE_LOCAL.sessions];
    if (!Array.isArray(list)) return [];
    return list.filter((s) => s && typeof s.id === 'string' && Array.isArray(s.tabs));
  } catch (e) {
    log.warn('sessions read', e);
    return [];
  }
}

/** @param {Session[]} list */
async function write(list) {
  try {
    await chrome.storage.local.set({ [STORAGE_LOCAL.sessions]: list.slice(0, MAX_SESSIONS) });
  } catch (e) {
    log.warn('sessions write', e);
  }
}

/** Snapshot the window this panel is scoped to. @param {any} ctx */
async function saveCurrent(ctx) {
  try {
    const model = ctx.model ? ctx.model() : null;
    const tabs = model && model.tabs ? [...model.tabs.values()] : [];
    const captured = tabs
      .filter((tab) => typeof tab.url === 'string' && /^https?:/.test(tab.url))
      .slice(0, MAX_TABS_PER_SESSION)
      .map((tab) => ({ url: tab.url, title: tab.title || tab.url }));
    if (captured.length === 0) {
      notify(ctx, t('widgetSessionsNothing'));
      return;
    }
    const now = new Date();
    const session = {
      // `Date.now()` alone collides when two saves land in the same millisecond.
      id: `${now.getTime()}-${captured.length}`,
      name: now.toLocaleString(i18n.getUILanguage(), {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      }),
      at: now.getTime(),
      tabs: captured,
    };
    await write([session, ...(await read())]);
    notify(ctx, t('widgetSessionsSaved', [String(captured.length)]));
  } catch (e) {
    log.warn('sessions save', e);
    notify(ctx, t('operationFailed'));
  }
}

/** @param {Session} session @param {Function} repaint @param {any} ctx */
function row(session, repaint, ctx) {
  const el = document.createElement('div');
  el.className = 'w-sess__row';
  el.dataset.sessionId = session.id;

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'w-sess__open';
  open.dataset.testid = 'widget-sessions-restore';
  open.textContent = `${session.name} · ${session.tabs.length}`;
  open.title = session.tabs.map((tab) => tab.title).join('\n');
  open.addEventListener('click', async () => {
    try {
      // A new window, never this one: restoring must not be able to take tabs away.
      await chrome.windows.create({ url: session.tabs.map((tab) => tab.url) });
    } catch (e) {
      log.warn('sessions restore', e);
      notify(ctx, t('operationFailed'));
    }
  });

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'w-sess__delete iconbtn';
  remove.dataset.testid = 'widget-sessions-delete';
  remove.setAttribute('aria-label', t('widgetSessionsDelete'));
  remove.title = t('widgetSessionsDelete');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-close');
  svg.append(use);
  remove.append(svg);
  remove.addEventListener('click', async () => {
    await write((await read()).filter((s) => s.id !== session.id));
    void repaint();
  });

  el.append(open, remove);
  return el;
}

/** `toast` is optional in the widget contract; a missing one must not throw. */
function notify(ctx, text) {
  if (ctx && typeof ctx.toast === 'function') ctx.toast(text);
}
