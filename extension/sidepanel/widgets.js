/**
 * The tools column — the panel beside the tab list.
 *
 * Chrome pins the side panel's minimum inner width at 360 px and gives extensions no
 * way to lower it, so a single column of tabs leaves most of that width doing nothing.
 * This column spends it on the things a tab list cannot say in a row: which pages are
 * open twice, which have not been touched in days, a set of tabs kept on purpose, what
 * is making noise, and somewhere to write.
 *
 * Deliberately NOT a dashboard. A clock, a calendar and the weather were built here and
 * then removed: they filled the space without earning it, and the two that fetched cost
 * the extension its "makes no network requests at all" promise for a temperature
 * reading. Everything here is about the tabs in front of you, and needs no permission
 * the previews did not already require.
 *
 * A widget is a plain object:
 *
 *   {
 *     id,                 // stable key, stored in settings
 *     titleKey,           // i18n key for the heading, '' for no heading
 *     mount(body, ctx),   // fill `body`; may return a teardown function
 *   }
 *
 * `mount` is called once when the widget appears and its teardown when it goes away,
 * so a widget that ticks owns its own timer and is responsible for clearing it. The
 * rail is rebuilt only when the chosen set changes, never on a tab render, so a
 * widget is never torn down just because a tab moved.
 *
 * Nothing here reaches the network, and nothing new should. The README promises the
 * extension makes no network requests at all, and a tool that phoned out would make
 * that text false — `tests/specs/22-widgets.spec.js` asserts it with every tool
 * mounted, so the promise fails a test rather than quietly rotting.
 */

import * as i18n from '../common/i18n.js';
import * as log from '../common/log.js';
import { WIDGET_IDS } from '../common/settings-schema.js';
import { sessions } from './widgets/sessions.js';
import { duplicates, staleTabs } from './widgets/housekeeping.js';
import { autoGroup } from './widgets/autogroup.js';
import { nowPlaying } from './widgets/sound.js';
import { scratchpad } from './widgets/scratchpad.js';
import { listIO } from './widgets/listio.js';
import { windowList } from './widgets/windows.js';
import { recentTabs } from './widgets/recent.js';

const t = (key, subs) => i18n.t(key, subs);

/** @type {{ rail: HTMLElement|null, ctx: any, mounted: Map<string, Function|null>, order: string[] }} */
const state = { rail: null, ctx: null, mounted: new Map(), order: [] };

/* ── Registry ────────────────────────────────────────────────────────────── */

/** Every widget the rail knows how to build, by id. */
const REGISTRY = new Map(
  [sessions, recentTabs, windowList, autoGroup, duplicates, staleTabs, listIO, nowPlaying, scratchpad]
    .map((w) => [w.id, w]),
);

/* ── Rail ────────────────────────────────────────────────────────────────── */

/**
 * @param {{ rail: HTMLElement, model: Function, subscribe: Function,
 *          activate: Function, setMuted: Function }} ctx
 */
export function init(ctx) {
  state.ctx = ctx;
  state.rail = ctx.rail || null;
}

/**
 * Show exactly `ids`, in that order. Widgets already on screen keep running: only
 * what actually changed is torn down or built, so the clock does not restart every
 * time an unrelated setting is saved.
 *
 * @param {string[]} ids
 */
export function apply(ids) {
  const rail = state.rail;
  if (!rail) return;
  const wanted = (Array.isArray(ids) ? ids : []).filter((id) => REGISTRY.has(id));
  if (sameOrder(wanted, state.order)) return;

  for (const [id, teardown] of state.mounted) {
    if (wanted.includes(id)) continue;
    try {
      if (typeof teardown === 'function') teardown();
    } catch (e) {
      log.warn('widget teardown', id, e);
    }
    state.mounted.delete(id);
    rail.querySelector(`[data-widget="${id}"]`)?.remove();
  }

  for (const id of wanted) {
    if (state.mounted.has(id)) continue;
    try {
      state.mounted.set(id, build(REGISTRY.get(id), rail));
    } catch (e) {
      log.warn('widget mount', id, e);
      state.mounted.set(id, null);
    }
  }

  // Re-order in place; every wanted widget exists by now.
  for (const id of wanted) {
    const el = rail.querySelector(`[data-widget="${id}"]`);
    if (el) rail.append(el);
  }

  state.order = wanted;
  rail.hidden = wanted.length === 0;
}

/** @param {any} widget @param {HTMLElement} rail @returns {Function|null} teardown */
function build(widget, rail) {
  const section = document.createElement('section');
  section.className = `widget widget--${widget.id}`;
  section.dataset.widget = widget.id;
  section.dataset.testid = `widget-${widget.id}`;
  if (widget.titleKey) {
    const h = document.createElement('h2');
    h.className = 'widget__title';
    h.textContent = t(widget.titleKey);
    section.append(h);
  }
  const body = document.createElement('div');
  body.className = 'widget__body';
  section.append(body);
  rail.append(section);
  const teardown = widget.mount(body, state.ctx);
  return typeof teardown === 'function' ? teardown : null;
}

/** @param {string[]} a @param {string[]} b */
function sameOrder(a, b) {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** Tear everything down — `pagehide`, so timers do not outlive the document. */
export function destroy() {
  for (const [id, teardown] of state.mounted) {
    try {
      if (typeof teardown === 'function') teardown();
    } catch (e) {
      log.warn('widget teardown', id, e);
    }
  }
  state.mounted.clear();
  state.order = [];
  if (state.rail) {
    state.rail.textContent = '';
    state.rail.hidden = true;
  }
}

/** The ids the rail can build, in the order the settings drawer lists them. */
export const AVAILABLE = Object.freeze(WIDGET_IDS.filter((id) => REGISTRY.has(id)));
