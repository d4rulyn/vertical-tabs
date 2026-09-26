// Group-by-site tool. See widgets.js for the tool contract.

import * as i18n from '../../common/i18n.js';
import * as log from '../../common/log.js';
import * as ops from '../tab-ops.js';
import { GROUP_COLOR_IDS } from '../../common/group-colors.js';

const t = (key, subs) => i18n.t(key, subs);

/** A host has to appear at least this often to be worth a group of its own. */
const MIN_TABS_PER_GROUP = 2;

/**
 * Put the tabs of this window into one group per site, and take it back.
 *
 * Chrome has had tab groups since 2020 and has never had a way to fill them: every
 * group is made by hand, one drag at a time, which is why most people with eighty tabs
 * have none. The data needed to do it automatically — a hostname — is already on every
 * tab this panel draws.
 *
 * Two things make this safe to press. Grouping never closes, moves between windows or
 * reorders across groups: `tabs.group` only gathers tabs that are already here. And the
 * exact set it touched is remembered, so **undo** puts those tabs back out again rather
 * than ungrouping whatever happens to be grouped now.
 */
export const autoGroup = {
  id: 'autoGroup',
  titleKey: 'widgetAutoGroup',
  iconId: 'i-wand',
  mount(body, ctx) {
    const summary = document.createElement('div');
    summary.className = 'w-muted';
    summary.dataset.testid = 'widget-autogroup-summary';

    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'w-btn';
    action.dataset.testid = 'widget-autogroup-run';
    action.textContent = t('widgetAutoGroupRun');

    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'w-btn';
    undo.dataset.testid = 'widget-autogroup-undo';
    undo.textContent = t('widgetAutoGroupUndo');
    undo.hidden = true;

    body.append(summary, action, undo);

    /** @type {number[]} tabs this tool grouped, newest run only */
    let lastRun = [];

    /** Hosts with enough ungrouped tabs to be worth a group. */
    const candidates = () => {
      const model = ctx.model ? ctx.model() : null;
      const tabs = model && model.tabs ? [...model.tabs.values()] : [];
      /** @type {Map<string, number[]>} */
      const byHost = new Map();
      for (const tab of tabs) {
        // A pinned tab has no place in a group, and a tab already in one has an answer.
        if (tab.pinned) continue;
        if (typeof tab.groupId === 'number' && tab.groupId > -1) continue;
        const host = hostOf(tab.url || tab.pendingUrl || '');
        if (!host) continue;
        if (!byHost.has(host)) byHost.set(host, []);
        byHost.get(host).push(tab.id);
      }
      for (const [host, ids] of [...byHost]) {
        if (ids.length < MIN_TABS_PER_GROUP) byHost.delete(host);
      }
      return byHost;
    };

    const paint = () => {
      const found = candidates();
      const tabCount = [...found.values()].reduce((n, ids) => n + ids.length, 0);
      summary.textContent = found.size
        ? t('widgetAutoGroupFound', [String(found.size), String(tabCount)])
        : t('widgetAutoGroupNone');
      action.hidden = found.size === 0;
      undo.hidden = lastRun.length === 0;
    };

    action.addEventListener('click', async () => {
      const found = candidates();
      if (!found.size) return;
      const touched = [];
      let made = 0;
      for (const [host, tabIds] of found) {
        try {
          const groupId = await ops.group({ tabIds });
          // A group with no title is an anonymous coloured bar; the host IS the reason
          // these tabs are together, so it is the name.
          await chrome.tabGroups.update(groupId, { title: host, color: colorFor(host) });
          touched.push(...tabIds);
          made += 1;
        } catch (e) {
          log.warn('autogroup', host, e);
        }
      }
      lastRun = touched;
      if (made === 0) {
        notify(ctx, t('operationFailed'));
      } else {
        notify(ctx, t('widgetAutoGroupDone', [String(made)]));
      }
      // Grouping moves tabs so the members sit together, so every index the panel holds
      // is stale until Chrome has been asked again.
      await resync();
      paint();
    });

    undo.addEventListener('click', async () => {
      if (!lastRun.length) return;
      const ids = lastRun;
      lastRun = [];
      try {
        // Only the tabs this tool grouped, and only the ones still open.
        const alive = [];
        for (const id of ids) {
          try {
            await chrome.tabs.get(id);
            alive.push(id);
          } catch {
            /* closed since the run; nothing to put back */
          }
        }
        if (alive.length) await ops.ungroup(alive);
        notify(ctx, t('widgetAutoGroupUndone', [String(alive.length)]));
      } catch (e) {
        log.warn('autogroup undo', e);
        notify(ctx, t('operationFailed'));
      }
      await resync();
      paint();
    });

    paint();
    const off = typeof ctx.subscribe === 'function' ? ctx.subscribe('rendered', paint) : null;
    return () => { if (typeof off === 'function') off(); };
  },
};

/** @param {string} url @returns {string} '' for anything without a host */
function hostOf(url) {
  try {
    const { host, protocol } = new URL(url);
    // `chrome://`, `about:` and friends have no site to group by.
    if (protocol !== 'http:' && protocol !== 'https:') return '';
    return host;
  } catch {
    return '';
  }
}

/**
 * A stable colour per host, so the same site is the same colour every run and two
 * sites next to each other are unlikely to collide.
 * @param {string} host
 */
function colorFor(host) {
  let h = 5381;
  for (let i = 0; i < host.length; i += 1) h = (h * 33) ^ host.charCodeAt(i);
  return GROUP_COLOR_IDS[(h >>> 0) % GROUP_COLOR_IDS.length];
}

/**
 * Ask Chrome for the window again. Grouping moves tabs so that a group's members sit
 * together, so every index the panel is holding is stale the moment a group is made.
 */
async function resync() {
  try {
    await ops.resync();
  } catch (e) {
    log.warn('autogroup resync', e);
    ops.rerender();
  }
}

/** `toast` is optional in the tool contract; a missing one must not throw. */
function notify(ctx, text) {
  if (ctx && typeof ctx.toast === 'function') ctx.toast(text);
}
