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
 *     iconId,             // OPTIONAL sprite symbol id for the tool strip, e.g.
 *                         // 'i-clock'; a widget that omits it gets a generic glyph
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

/**
 * Widgets mounted somewhere OTHER than the rail — today the tool strip's sheet.
 *
 * Deliberately a second map, not `state.mounted`. `apply()` treats `state.mounted` as
 * "what is in the rail": a sheet-mounted widget listed there would be torn down by the
 * next diff pass, whose `rail.querySelector('[data-widget="…"]')` then finds nothing to
 * remove, because the element is in the sheet. The result is a live node with a dead
 * teardown — a scratchpad that no longer saves — which no test would notice.
 *
 * @type {Map<string, { el: Element|null, teardown: Function|null }>}
 */
const detached = new Map();

/* ── Registry ────────────────────────────────────────────────────────────── */

/** Every widget the rail knows how to build, by id. */
const REGISTRY = new Map(
  [sessions, recentTabs, windowList, autoGroup, duplicates, staleTabs, listIO, nowPlaying, scratchpad]
    .map((w) => [w.id, w]),
);

/**
 * The widget object behind an id, or `null`.
 *
 * Exported so the tool strip can read each tool's own `titleKey` and `iconId` instead
 * of keeping a table of its own. The nine ids already appear in `WIDGET_IDS`, in the
 * registry above and in `22-widgets.spec.js`; a fourth list is exactly how the strings
 * and the widgets drifted apart once already.
 *
 * @param {string} id
 * @returns {any|null}
 */
export function getWidget(id) {
  return REGISTRY.get(id) || null;
}

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
    // The same widget must never run in two places. Switching the side column back to
    // the tools while one of them is open in the strip's sheet mounts the rail's copy
    // in this very loop, so the sheet's copy is torn down FIRST: the scratchpad commits
    // its last edit from that teardown, and issuing that write before the new copy's
    // read is the only ordering this file can offer it.
    unmountOne(id);
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

/* ── One widget, somewhere else ──────────────────────────────────────────── */

/**
 * Build one widget into `host`, outside the rail. Used by the tool strip, which shows
 * a single tool at a time in a sheet; `host` is that sheet.
 *
 * Mounting the same id twice is a no-op'd remount: the previous copy is torn down
 * first, so a widget is never running in two places.
 *
 * @param {string} id
 * @param {HTMLElement} host
 * @returns {boolean} whether a widget was built
 */
export function mountOne(id, host) {
  const widget = REGISTRY.get(id);
  if (!widget || !(host instanceof HTMLElement)) return false;
  unmountOne(id);
  /** @type {Function|null} */
  let teardown = null;
  try {
    teardown = build(widget, host);
  } catch (e) {
    log.warn('widget mount', id, e);
  }
  // Read back rather than trusting `build()`'s append: whatever ended up in the host
  // is what has to come out again, even if `mount()` threw half way through.
  detached.set(id, { el: host.querySelector(`[data-widget="${id}"]`), teardown });
  return true;
}

/**
 * Tear down and remove a widget mounted by `mountOne()`. Safe to call for an id that
 * is not mounted, and it never touches the rail's own copy of that widget.
 *
 * @param {string} id
 */
export function unmountOne(id) {
  const entry = detached.get(id);
  if (!entry) return;
  detached.delete(id);
  try {
    if (typeof entry.teardown === 'function') entry.teardown();
  } catch (e) {
    log.warn('widget teardown', id, e);
  }
  if (entry.el) entry.el.remove();
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
  // Sheet-mounted widgets own timers and pending writes too: the scratchpad commits
  // its last edit from its teardown, so skipping them here would lose it.
  for (const id of [...detached.keys()]) unmountOne(id);
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
