// Sound widget — see widgets.js for the widget contract.

import * as i18n from '../../common/i18n.js';
import * as log from '../../common/log.js';

const t = (key, subs) => i18n.t(key, subs);

/**
 * Whatever is making sound, and the controls for it.
 *
 * Chrome tells an extension which tabs are audible and lets it mute them, so this
 * needs no content script and no host permission beyond what previews already use.
 * It cannot pause a player — no extension API exposes that — so it offers the two
 * things it genuinely can do: jump to the tab, and mute it.
 */
export const nowPlaying = {
  id: 'nowPlaying',
  titleKey: 'widgetNowPlaying',
  mount(body, ctx) {
    const empty = document.createElement('div');
    empty.className = 'w-np__empty';
    empty.dataset.testid = 'widget-now-playing-empty';
    empty.textContent = t('widgetNowPlayingEmpty');
    const list = document.createElement('div');
    list.className = 'w-np__list';
    list.dataset.testid = 'widget-now-playing-list';
    body.append(empty, list);

    const paint = () => {
      const model = ctx.model ? ctx.model() : null;
      const tabs = model && model.tabs ? [...model.tabs.values()] : [];
      // Audible OR muted. A muted tab is not making sound, but it is a tab whose
      // sound the user took away and may want back, and it is the one case where
      // the tab strip's own speaker icon is easy to lose track of.
      const sounding = tabs.filter((tab) => tab.audible
        || Boolean(tab.mutedInfo && tab.mutedInfo.muted));
      empty.hidden = sounding.length > 0;
      list.textContent = '';
      for (const tab of sounding) {
        list.append(row(tab, ctx));
      }
    };

    paint();
    // `rendered` fires after the tab list has been repainted, which is exactly when
    // audible state may have changed. This redraws only the rail's own list, never
    // the tab list, so riding that event costs a handful of nodes.
    const off = typeof ctx.subscribe === 'function' ? ctx.subscribe('rendered', paint) : null;
    return () => { if (typeof off === 'function') off(); };
  },
};

/** One audible tab: title, jump, mute. @param {any} tab @param {any} ctx */
function row(tab, ctx) {
  const el = document.createElement('div');
  el.className = 'w-np__row';
  // Not `data-tab-id` — that attribute marks the CARD for a tab, and a second element
  // carrying it makes every `[data-tab-id="…"]` lookup ambiguous.
  el.dataset.soundTab = String(tab.id);

  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'w-np__title';
  title.textContent = tab.title || '';
  title.title = tab.title || '';
  title.dataset.testid = 'widget-now-playing-jump';
  title.addEventListener('click', () => {
    try {
      ctx.activate(tab.id);
    } catch (e) {
      log.warn('nowPlaying activate', e);
    }
  });

  const muted = Boolean(tab.mutedInfo && tab.mutedInfo.muted);
  const mute = document.createElement('button');
  mute.type = 'button';
  mute.className = 'w-np__mute iconbtn';
  mute.dataset.testid = 'widget-now-playing-mute';
  mute.setAttribute('aria-label', t(muted ? 'unmuteTab' : 'muteTab'));
  mute.title = mute.getAttribute('aria-label');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', muted ? '#i-muted' : '#i-audio');
  svg.append(use);
  mute.append(svg);
  mute.addEventListener('click', () => {
    try {
      ctx.setMuted(tab.id, !muted);
    } catch (e) {
      log.warn('nowPlaying mute', e);
    }
  });

  el.append(title, mute);
  return el;
}

