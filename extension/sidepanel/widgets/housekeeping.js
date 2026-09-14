// Duplicate-tab and stale-tab widgets. See widgets.js for the widget contract.

import * as i18n from '../../common/i18n.js';
import * as log from '../../common/log.js';
import { urlKey } from '../../common/url-key.js';
import * as ops from '../tab-ops.js';

const t = (key, subs) => i18n.t(key, subs);

/** A tab untouched for this long is a candidate for hibernating. */
const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Tabs open more than once, and a button to close the extras.
 *
 * Duplicates are keyed with the same `urlKey()` the previews are keyed with, so
 * "the same page" means exactly what it means everywhere else in this extension —
 * including that a fragment counts, because a hash-routed app really is showing
 * something different.
 *
 * The tab kept is the OLDEST of each set: it is the one whose history and scroll
 * position the user has actually built up.
 */
export const duplicates = {
  id: 'duplicates',
  titleKey: 'widgetDuplicates',
  mount(body, ctx) {
    const summary = document.createElement('div');
    summary.className = 'w-muted';
    summary.dataset.testid = 'widget-duplicates-summary';

    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'w-btn';
    action.dataset.testid = 'widget-duplicates-close';
    action.textContent = t('widgetDuplicatesClose');

    body.append(summary, action);

    const extras = () => {
      const model = ctx.model ? ctx.model() : null;
      const tabs = model && model.tabs ? [...model.tabs.values()] : [];
      /** @type {Map<string, any[]>} */
      const groups = new Map();
      for (const tab of tabs) {
        if (tab.pinned) continue; // a pinned duplicate is deliberate
        const key = urlKey(tab.url || '');
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(tab);
      }
      const doomed = [];
      for (const set of groups.values()) {
        if (set.length < 2) continue;
        // Oldest first, so everything after the first is an extra. `id` ascends with
        // creation order, and is present where `lastAccessed` may not be.
        const ordered = [...set].sort((a, b) => a.id - b.id);
        doomed.push(...ordered.slice(1));
      }
      return doomed;
    };

    const paint = () => {
      const doomed = extras();
      summary.textContent = doomed.length
        ? t('widgetDuplicatesFound', [String(doomed.length)])
        : t('widgetDuplicatesNone');
      action.hidden = doomed.length === 0;
    };

    action.addEventListener('click', async () => {
      const doomed = extras();
      if (!doomed.length) return;
      try {
        // Through the panel's one close path, so a locked duplicate is kept.
        await ops.remove(doomed.map((tab) => tab.id));
        notify(ctx, t('widgetDuplicatesClosed', [String(doomed.length)]));
      } catch (e) {
        log.warn('duplicates close', e);
        notify(ctx, t('operationFailed'));
      }
      paint();
    });

    paint();
    const off = typeof ctx.subscribe === 'function' ? ctx.subscribe('rendered', paint) : null;
    return () => { if (typeof off === 'function') off(); };
  },
};

/**
 * Tabs nobody has looked at in days, and a button to hibernate them.
 *
 * Hibernating rather than closing is the point: `tabs.discard` frees the tab's memory
 * while leaving it in the strip, so nothing is lost and the row still says what it
 * was. Chrome does this on its own under memory pressure; this makes it a choice.
 *
 * `lastAccessed` is Chrome 121+. Where it is missing the widget says so rather than
 * guessing an age from the tab id.
 */
export const staleTabs = {
  id: 'staleTabs',
  titleKey: 'widgetStale',
  mount(body, ctx) {
    const summary = document.createElement('div');
    summary.className = 'w-muted';
    summary.dataset.testid = 'widget-stale-summary';

    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'w-btn';
    action.dataset.testid = 'widget-stale-discard';
    action.textContent = t('widgetStaleDiscard');

    body.append(summary, action);

    const candidates = () => {
      const model = ctx.model ? ctx.model() : null;
      const tabs = model && model.tabs ? [...model.tabs.values()] : [];
      const now = Date.now();
      return tabs.filter((tab) => typeof tab.lastAccessed === 'number'
        && !tab.active
        && !tab.pinned
        && !tab.discarded
        && tab.autoDiscardable !== false
        && now - tab.lastAccessed > STALE_AFTER_MS);
    };

    const supported = () => {
      const model = ctx.model ? ctx.model() : null;
      const tabs = model && model.tabs ? [...model.tabs.values()] : [];
      return tabs.some((tab) => typeof tab.lastAccessed === 'number');
    };

    const paint = () => {
      if (!supported()) {
        summary.textContent = t('widgetStaleUnsupported');
        action.hidden = true;
        return;
      }
      const idle = candidates();
      summary.textContent = idle.length
        ? t('widgetStaleFound', [String(idle.length)])
        : t('widgetStaleNone');
      action.hidden = idle.length === 0;
    };

    action.addEventListener('click', async () => {
      const idle = candidates();
      if (!idle.length) return;
      let done = 0;
      for (const tab of idle) {
        try {
          await chrome.tabs.discard(tab.id);
          done += 1;
        } catch (e) {
          // A tab Chrome refuses to discard is not an error worth a toast; it is
          // usually one that is playing audio or holding a beforeunload handler.
          log.warn('stale discard', tab.id, e);
        }
      }
      notify(ctx, t('widgetStaleDiscarded', [String(done)]));
      paint();
    });

    paint();
    const off = typeof ctx.subscribe === 'function' ? ctx.subscribe('rendered', paint) : null;
    return () => { if (typeof off === 'function') off(); };
  },
};

/** `toast` is optional in the widget contract; a missing one must not throw. */
function notify(ctx, text) {
  if (ctx && typeof ctx.toast === 'function') ctx.toast(text);
}
