// Test infrastructure for the bookmark EDITING specs: create a folder, rename, reorder,
// move (37-bookmark-folders, 38-bookmark-reorder-move, 41-bookmark-menu-keys, and the
// guards added to 40-bookmark-guards).
//
// Nothing in here is a test. Part of what it addresses is built by the units that come after
// it: the drop feedback arrives with the drag and drop unit, so `dragRow` with `valid: true`
// waits for something that does not exist yet and cannot pass until then. Each function says
// what it needs.
//
// What the product has to provide (the whole product contract of this file):
//   [data-testid="bookmark-row"], .w-row__main      the rows (exist today, bookmarks.js)
//   #bookmark-rail, [data-testid="bookmark-list"]   the column (exist today); installRepaintSpy needs both
//   [data-testid="bookmark-drop-indicator"]         the before/after line (plan.md section 3.1)
//   .is-bmk-drop-into                               the "inside" outline on a folder row (plan.md section 3.1)
//
// Not shared with `installMonitor` in bookmark-preview.js: that one records only the NAMES
// of the five write methods. "Exactly one create, with these arguments and no index key"
// needs the arguments and the outcome, and "reads per drop" needs the reads as well.
//
// Page-side state lives on `window.__bm*` (the existing monitor uses `window.__peekMon`).
// What this file writes into the product's DOM: the attribute `data-bm-mark` (markNode), and,
// for the length of one synchronous task inside installRepaintSpy's canary, one hidden node.
'use strict';

const { expect } = require('../fixtures');
const { swEval } = require('./chrome');

/* ── What the specs address ───────────────────────────────────────────────── */

/** A row of the column: a link or a folder. The edit row is NOT one (`bookmark-edit-row`). */
const ROW = '[data-testid="bookmark-row"]';
/** The line drawn where a before/after drop would land (plan.md section 3.1). */
const DROP_INDICATOR = '[data-testid="bookmark-drop-indicator"]';
/**
 * "Inside a folder" is an outline on the folder row with its own class name (plan.md section
 * 3.1), never `is-dragging`, which `dnd.js` strips from every element on any dragend.
 */
const DROP_INTO = '.is-bmk-drop-into';

/** The calls that change the tree. */
const WRITE_METHODS = ['create', 'update', 'move', 'remove', 'removeTree'];
/** The two reads the feature makes: `get` for the current parent and index, and `getChildren`. */
const READ_METHODS = ['get', 'getChildren'];
/**
 * Never called by the panel. Wrapped all the same, so that "the panel never searches and never
 * reads the whole tree" can be asserted at run time as well as by the static test in
 * tests/unit/bookmark-claims.test.mjs.
 */
const NEVER_CALLED = ['search', 'getTree', 'getRecent', 'getSubTree'];

/* ── What the panel asked chrome.bookmarks ────────────────────────────────── */

/**
 * Record, in the panel, every call to `chrome.bookmarks`:
 * `{ n, method, args, keys, status, result?, error?, sync?, t, tEnd? }`.
 *
 *   n        1, 2, 3... in the order the calls were made (a timestamp can tie; a counter cannot)
 *   args     a structured copy taken at call time
 *   keys     per argument: its own enumerable keys, or null when it is not an object. This is
 *            what says "no `index` key" (`!keys[0].includes('index')`) without depending on how
 *            a key whose value is `undefined` crosses back into the test
 *   status   'pending' | 'resolved' | 'rejected'
 *   result   resolved: `{ count }` for a list, `{ id, parentId, index, title, hasUrl }` for a node
 *   error    rejected: the message. `sync: true` when the call THREW instead of rejecting, which
 *            is what a revoked namespace does (probe-results.md, Probe 7)
 *   t, tEnd  `performance.now()` at the call and when it settled
 *
 * Idempotent per page. The page's own `chrome.bookmarks.<method>` properties are replaced, so a
 * test that replaces one afterwards (the revoke staging in 32-bookmarks-rail does) also replaces
 * its wrapper, and calls made after that are not recorded.
 *
 * "Nothing was recorded" only means something if a call WOULD have been, so before returning
 * every wrapped method is exercised once through the property, the way the product calls it,
 * with forwarding switched off (nothing reaches Chrome), and so are a rejection and a
 * synchronous throw. The records are checked, then cleared. A page where the assignment did
 * not take fails here, in every spec that uses the spy.
 * @param {import('@playwright/test').Page} panel
 */
async function installWriteSpy(panel) {
  const canary = await panel.evaluate(async (names) => {
    if (window.__bmSpy) return null;
    const spy = { calls: [], seq: 0 };
    window.__bmSpy = spy;
    const now = () => performance.now();
    const message = (e) => String(e && e.message ? e.message : e);
    const snap = (args) => args.map((a) => {
      if (typeof a === 'function') return '[function]';
      try { return structuredClone(a); } catch { return String(a); }
    });
    const keysOf = (args) => args.map((a) => (a && typeof a === 'object' ? Object.keys(a) : null));
    const summary = (v) => {
      if (Array.isArray(v)) return { count: v.length };
      if (v && typeof v === 'object') {
        return { id: v.id, parentId: v.parentId, index: v.index, title: v.title, hasUrl: 'url' in v };
      }
      return v;
    };

    // `forward` is off only while the canary below runs. What a call does then is fixed by its
    // first argument, so one wrapper can be shown to record a resolve, a reject and a throw.
    let forward = true;
    const fake = (args) => {
      if (args[0] === '__throw__') throw new Error('__canary__');
      if (args[0] === '__reject__') return Promise.reject(new Error('__canary__'));
      return Promise.resolve(undefined);
    };

    const wrapped = [];
    if (chrome.bookmarks) {
      for (const name of names) {
        if (typeof chrome.bookmarks[name] !== 'function') continue;
        const real = chrome.bookmarks[name].bind(chrome.bookmarks);
        chrome.bookmarks[name] = (...args) => {
          const call = {
            n: (spy.seq += 1), method: name, args: snap(args), keys: keysOf(args), status: 'pending', t: now(),
          };
          spy.calls.push(call);
          const settle = (status, extra) => Object.assign(call, { status, tEnd: now() }, extra);
          let out;
          try {
            out = forward ? real(...args) : fake(args);
          } catch (e) {
            settle('rejected', { error: message(e), sync: true });
            throw e;
          }
          // The callback form returns nothing: hand that back untouched.
          if (!out || typeof out.then !== 'function') {
            settle('resolved', { result: summary(out) });
            return out;
          }
          return out.then(
            (v) => { settle('resolved', { result: summary(v) }); return v; },
            (e) => { settle('rejected', { error: message(e), sync: false }); throw e; },
          );
        };
        wrapped.push(name);
      }
    }

    forward = false;
    try {
      for (const name of wrapped) await chrome.bookmarks[name]('__canary__');
      const resolved = spy.calls.map((c) => ({ method: c.method, status: c.status, args: c.args }));
      let rejection = null;
      let thrown = null;
      if (wrapped.length) {
        try { await chrome.bookmarks[wrapped[0]]('__reject__'); } catch (e) { rejection = message(e); }
        try { chrome.bookmarks[wrapped[0]]('__throw__'); } catch (e) { thrown = message(e); }
      }
      return {
        wrapped,
        resolved,
        rejection,
        thrown,
        tail: spy.calls.slice(resolved.length).map((c) => ({
          method: c.method, status: c.status, error: c.error, sync: c.sync,
        })),
      };
    } finally {
      forward = true;
      spy.calls.length = 0;
      spy.seq = 0;
    }
  }, [...WRITE_METHODS, ...READ_METHODS, ...NEVER_CALLED]);

  if (!canary) return;
  expect(canary.wrapped.length, 'there are bookmark methods to watch').toBeGreaterThan(0);
  expect(canary.resolved.map((c) => [c.method, c.status]),
    'the spy records a call to every method it wraps, and that it resolved')
    .toEqual(canary.wrapped.map((name) => [name, 'resolved']));
  expect(canary.resolved.map((c) => c.args), 'together with the arguments it was called with')
    .toEqual(canary.wrapped.map(() => ['__canary__']));
  expect(canary.rejection, 'a rejection reaches the caller').toBe('__canary__');
  expect(canary.thrown, 'and so does a synchronous throw').toBe('__canary__');
  expect(canary.tail, 'both are recorded as rejected, the throw as a synchronous one').toEqual([
    { method: canary.wrapped[0], status: 'rejected', error: '__canary__', sync: false },
    { method: canary.wrapped[0], status: 'rejected', error: '__canary__', sync: true },
  ]);
}

/**
 * The calls {@link installWriteSpy} has recorded, oldest first. `since` is a sequence number:
 * only calls made after it are returned, so "what did this one drop do" is
 *   const before = (await readWriteSpy(panel)).at(-1)?.n ?? 0;
 *   ...the drop...
 *   const during = await readWriteSpy(panel, before);
 * @param {import('@playwright/test').Page} panel
 * @param {number} [since]
 */
function readWriteSpy(panel, since = 0) {
  return panel.evaluate((after) => {
    if (!window.__bmSpy) throw new Error('readWriteSpy: installWriteSpy was not called on this page');
    return window.__bmSpy.calls.filter((c) => c.n > after).map((c) => ({ ...c }));
  }, since);
}

/* ── Trees ────────────────────────────────────────────────────────────────── */

/**
 * Build a tree of any depth under `parentId`, from the service worker, and return the id of
 * every node by title. `seedBookmarks` builds one level of folders under the bar; the move
 * specs need a 4-deep tree, an empty folder, a folder of 400.
 *
 * An item with a `url` is a link; one without is a folder, and its `children` go inside it.
 * Created depth-first, one call at a time, so the order is the order written. A title used
 * twice is an error: the ids are keyed by title and a second one would silently replace the
 * first.
 *
 * @param {import('@playwright/test').Worker} sw
 * @param {string} parentId an existing folder, e.g. `seeded.barId` from seedBookmarks
 * @param {Array<{ title: string, url?: string, children?: Array<object> }>} spec
 * @returns {Promise<{ ids: Record<string, string> }>}
 */
function seedTree(sw, parentId, spec) {
  return swEval(sw, async (a) => {
    const ids = {};
    const build = async (parent, items) => {
      for (const item of items) {
        if (Object.hasOwn(ids, item.title)) {
          throw new Error(`seedTree: the title "${item.title}" is used twice; ids are keyed by title`);
        }
        if (item.url && item.children) throw new Error(`seedTree: "${item.title}" has a url and children`);
        const made = await chrome.bookmarks.create(item.url
          ? { parentId: parent, title: item.title, url: item.url }
          : { parentId: parent, title: item.title });
        ids[item.title] = made.id;
        if (item.children) await build(made.id, item.children);
      }
    };
    await build(a.parentId, a.spec);
    return { ids };
  }, { parentId, spec });
}

/**
 * What Chrome says is in a folder, in order. A link has a `url`; a folder has NO `url` key at
 * all (measured, Probe 7), so `'url' in node` is the test.
 * @param {import('@playwright/test').Worker} sw
 * @param {string} id
 * @returns {Promise<Array<{ id: string, parentId: string, index: number, title: string, url?: string }>>}
 */
function childrenOf(sw, id) {
  return swEval(sw, async (folderId) => {
    const kids = await chrome.bookmarks.getChildren(folderId);
    return kids.map((n) => {
      const node = { id: n.id, parentId: n.parentId, index: n.index, title: n.title };
      if ('url' in n) node.url = n.url;
      return node;
    });
  }, id);
}

/**
 * A node and everything under it, nested: `{ id, parentId, index, title, url? | children }`.
 * A folder always has `children` (empty for an empty folder), a link never does. Dates are
 * left out on purpose, so "the same before and after" can be a plain deep equal.
 * @param {import('@playwright/test').Worker} sw
 * @param {string} id
 */
function subtreeOf(sw, id) {
  return swEval(sw, async (rootId) => {
    const [root] = await chrome.bookmarks.getSubTree(rootId);
    const plain = (n) => {
      const node = { id: n.id, parentId: n.parentId, index: n.index, title: n.title };
      if ('url' in n) node.url = n.url;
      else node.children = (n.children || []).map(plain);
      return node;
    };
    return plain(root);
  }, id);
}

/**
 * The order a folder should be in after `source` is dropped at `gap`: immediately before the
 * child that is at `gap` in the ORIGINAL order, or last when `gap` is the number of titles.
 * Written from names. It does not contain the `t > s ? t - 1 : t` arithmetic of the index rule
 * it is there to check, so a product that gets that rule wrong cannot also get the oracle wrong.
 *
 *   gap j = "before child j" (so j = n is "after the last"); dropping the item before itself or
 *   before its next neighbour leaves the order as it was, which falls out of the definition.
 *
 * `source` may be absent from `titles` (a move into another folder: `titles` is the destination
 * and `gap` a position in it). Titles must be unique.
 *
 * @param {string[]} titles the folder's order before the drop
 * @param {string} source title of the item that moves
 * @param {number} gap 0..titles.length
 * @returns {string[]}
 */
function orderOracle(titles, source, gap) {
  if (new Set(titles).size !== titles.length) {
    throw new Error(`orderOracle works by names, so titles must be unique: ${JSON.stringify(titles)}`);
  }
  if (!Number.isInteger(gap) || gap < 0 || gap > titles.length) {
    throw new RangeError(`orderOracle: gap ${gap} is outside 0..${titles.length}`);
  }
  const anchor = gap < titles.length ? titles[gap] : null;
  if (anchor === source) return [...titles];
  const rest = titles.filter((title) => title !== source);
  if (anchor === null) return [...rest, source];
  return rest.flatMap((title) => (title === anchor ? [source, title] : [title]));
}

/* ── Rows by title ────────────────────────────────────────────────────────── */

const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The row whose title is exactly `title`. `clickRow` in bookmarks.js matches a substring,
 * case-insensitively, which for a folder of [A..F] matches every row with an "a" in it.
 * Resolves to more than one row only if two share a title, and Playwright's strictness then
 * says so instead of acting on the first.
 * @param {import('@playwright/test').Page} panel
 * @param {string} title
 */
function rowTitled(panel, title) {
  return panel.locator(ROW)
    .filter({ has: panel.locator('.w-row__main', { hasText: new RegExp(`^${escapeRegExp(title)}$`) }) });
}

/* ── Dragging ─────────────────────────────────────────────────────────────── */

/**
 * Where in a row's box the pointer goes for each zone, as a fraction of its height. Chosen to
 * sit inside BOTH rules of plan.md D4 at once: a link row has halves (top = before, bottom =
 * after), a folder row has 25 / 50 / 25 (top = before, middle = inside, bottom = after). 12 %
 * is in the top 25 % and in the top half; 88 % in the bottom 25 % and in the bottom half; and
 * 50 % is 25 % clear of both edges of a folder's middle band. A link row has no middle.
 */
const ZONE_Y = Object.freeze({ top: 0.12, middle: 0.5, bottom: 0.88 });
/** How far sideways the last approach comes from, in px (see `dragRow`). */
const SWAY_PX = 24;
/** How long to wait for what the drag should have caused, before saying it did not. */
const FEEDBACK_MS = 10_000;
const ARRIVE_MS = 5_000;
const START_MS = 1_500;
const END_MS = 5_000;

/**
 * The point of `box` that means `zone`.
 * @param {{ x: number, y: number, width: number, height: number }} box
 * @param {'top'|'middle'|'bottom'} zone
 */
function dropPoint(box, zone) {
  if (!Object.hasOwn(ZONE_Y, zone)) {
    throw new Error(`zone must be 'top', 'middle' or 'bottom', not ${JSON.stringify(zone)}`);
  }
  return { x: box.x + box.width / 2, y: box.y + box.height * ZONE_Y[zone] };
}

/** A title means the row with that title; a Locator means itself. */
function locate(panel, what) {
  return typeof what === 'string' ? rowTitled(panel, what) : what;
}

const label = (what) => (typeof what === 'string' ? JSON.stringify(what) : String(what));

/** Two animation frames: whatever the product was going to draw after the last event is drawn. */
function frames(panel) {
  return panel.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
  }));
}

/**
 * Count the drag events from `window` in the capture phase, so an event is seen whatever the
 * product does with it, and reset the counts. Whether a `dragover` was accepted
 * (`defaultPrevented`) is read in a task of its own, after the dispatch, so that a handler
 * anywhere on the path has had its say, including one that stops the event.
 */
function recordDrag(panel) {
  return panel.evaluate(() => {
    let rec = window.__bmDrag;
    if (!rec) {
      rec = { start: 0, over: 0, last: null, drop: 0, end: 0 };
      window.__bmDrag = rec;
      window.addEventListener('dragstart', () => { rec.start += 1; }, true);
      window.addEventListener('dragover', (e) => {
        rec.over += 1;
        const mine = { n: rec.over, x: e.clientX, y: e.clientY, settled: false, prevented: null };
        rec.last = mine;
        setTimeout(() => { mine.settled = true; mine.prevented = e.defaultPrevented; }, 0);
      }, true);
      window.addEventListener('drop', () => { rec.drop += 1; }, true);
      window.addEventListener('dragend', () => { rec.end += 1; }, true);
    }
    Object.assign(rec, { start: 0, over: 0, last: null, drop: 0, end: 0 });
  });
}

/** True once `ok` holds in the page; false after `timeout`. Never throws on the timeout. */
function pageHolds(panel, ok, arg, timeout) {
  return panel.waitForFunction(ok, arg, { timeout, polling: 50 }).then(() => true, () => false);
}

/**
 * What the page saw, for the message of a drag that did not do what the test said it would.
 * The judgement and the numbers it rests on go into the same line.
 */
async function dragFacts(panel) {
  const facts = await panel.evaluate((sel) => ({
    events: window.__bmDrag || null,
    indicators: document.querySelectorAll(sel.line).length,
    outlined: document.querySelectorAll(sel.into).length,
  }), { line: DROP_INDICATOR, into: DROP_INTO });
  return JSON.stringify(facts);
}

/**
 * A slow, multi-step HTML5 drag with the real mouse: `dragTo` in 06-dnd.spec.js (copied, not
 * imported: that one lives in a spec), minus every fixed pause. Instead of sleeping so that the
 * product's throttled `dragover` has caught up, it waits for the evidence.
 *
 * `src` and `dst` are the exact title of a bookmark row, or a Locator for anything else (a
 * favicon, the "Empty" marker, `#tablist`, a tab card, the bare rail). `zone` is where in the
 * destination's box the pointer goes: 'top' | 'middle' | 'bottom' (see {@link dropPoint}).
 *
 *   valid: true (default)   the test says this target is a valid one. Before the button is
 *                           released the product's drop feedback must be on screen: the line
 *                           `bookmark-drop-indicator` (before / after) or the outline
 *                           `.is-bmk-drop-into` (inside; plan.md section 3.1). Which of the two a
 *                           zone gets is the product's decision (the bottom of an EXPANDED folder
 *                           means inside, plan.md D4), so either will do here; what the drop did
 *                           is asserted by the test. If neither appears this throws, with what
 *                           the page saw.
 *   valid: false            no feedback is expected. The wait is for the product to have handled
 *                           the final `dragover` and drawn two frames, so that the test's own
 *                           "no indicator" is read after the product had its chance.
 *   drop: true (default)    release the button and wait until the drag has ended (`dragend`).
 *   drop: false             stop with the button down and the pointer on the target, for a test
 *                           that changes something mid-drag. Finish with {@link releaseDrag}.
 *
 * The last approach is a sideways move of SWAY_PX at the target's height. The product throttles
 * `dragover` (a pointer that moved less than 4 px within 40 ms is not re-resolved, as in
 * `dnd.js`); a final event that lands within that window of the one before is skipped, and
 * what the product last resolved would be a neighbouring row. A move of far more than 4 px
 * cannot be skipped, so the last event the product resolves is at the target's height, in the
 * target's zone.
 *
 * Both ends have to be on screen together: the pointer is driven in viewport coordinates. When
 * they are not, this throws instead of aiming at a point outside the viewport.
 *
 * Needs: the drag and drop unit, for any `valid: true` drag. With `valid: false` it runs
 * against any page that has drag events.
 *
 * @param {import('@playwright/test').Page} panel
 * @param {string|import('@playwright/test').Locator} src
 * @param {string|import('@playwright/test').Locator} dst
 * @param {'top'|'middle'|'bottom'} zone
 * @param {{ drop?: boolean, valid?: boolean }} [options]
 * @returns {Promise<{ started: boolean, reached: boolean, accepted: boolean|null, x: number, y: number,
 *   dropped?: boolean, ended?: boolean }>} `started`: a dragstart was seen. `reached`: the product
 *   handled a dragover at the target. `accepted`: whether a handler called preventDefault on it
 *   (null when there was none). `dropped` / `ended`: a `drop` / a `dragend` was seen after the
 *   release.
 */
async function dragRow(panel, src, dst, zone, { drop = true, valid = true } = {}) {
  const from = locate(panel, src);
  const to = locate(panel, dst);
  // Without these a row that is not there is waited for until the whole test times out.
  await expect(from, `the drag source ${label(src)} is on the page`).toBeVisible();
  await expect(to, `the drag target ${label(dst)} is on the page`).toBeVisible();
  // Feedback left over from before would satisfy the wait below without the product having
  // answered this drag.
  await expect(panel.locator(DROP_INDICATOR), 'no drop line is showing before the drag starts').toBeHidden();
  await expect(panel.locator(DROP_INTO), 'no folder is outlined before the drag starts').toHaveCount(0);
  await recordDrag(panel);
  // The destination first, then the source: both ends have to be on screen before either box
  // is measured, and the pointer is driven in viewport coordinates (06-dnd.spec.js).
  await to.scrollIntoViewIfNeeded();
  await from.scrollIntoViewIfNeeded();
  const sb = await from.boundingBox();
  const db = await to.boundingBox();
  if (!sb || !db) throw new Error(`a drag needs two visible elements: ${label(src)} -> ${label(dst)}`);

  const sx = sb.x + sb.width / 2;
  const sy = sb.y + sb.height / 2;
  const { x: tx, y: ty } = dropPoint(db, zone);
  const viewport = panel.viewportSize();
  if (viewport && [sy, ty].some((y) => y < 0 || y >= viewport.height)) {
    throw new Error(`dragRow ${label(src)} -> ${label(dst)}: the two ends do not fit in the `
      + `${viewport.width}x${viewport.height} viewport together (source y=${Math.round(sy)}, target y=${Math.round(ty)})`);
  }
  const sway = Math.min(SWAY_PX, db.width / 3);

  await panel.mouse.move(sx, sy);
  await panel.mouse.down();
  await panel.mouse.move(sx + 6, sy + 6, { steps: 4 });
  // A source that is not draggable never gets here; for one that is, `dragstart` is already in.
  const started = await pageHolds(panel, () => window.__bmDrag.start > 0, null, START_MS);
  await panel.mouse.move(tx - sway, ty, { steps: 16 });
  await panel.mouse.move(tx, ty, { steps: 2 });
  const reached = started && await pageHolds(panel, ({ x, y }) => {
    const last = window.__bmDrag.last;
    return Boolean(last && last.settled && Math.abs(last.x - x) <= 1.5 && Math.abs(last.y - y) <= 1.5);
  }, { x: tx, y: ty }, ARRIVE_MS);

  if (valid) {
    try {
      await expect(panel.locator(DROP_INDICATOR).or(panel.locator(DROP_INTO)).first())
        .toBeVisible({ timeout: FEEDBACK_MS });
    } catch (err) {
      throw new Error(`dragRow ${label(src)} -> ${label(dst)} (${zone}): no drop feedback `
        + `(${DROP_INDICATOR} or ${DROP_INTO}) with the button still down. `
        + `started=${started} reached=${reached} facts=${await dragFacts(panel)}\n${err.message}`);
    }
  } else if (reached) {
    await frames(panel);
  }

  const last = await panel.evaluate(() => window.__bmDrag.last);
  const result = { started, reached, accepted: last ? last.prevented : null, x: tx, y: ty };
  if (!drop) return result;
  return { ...result, ...(await releaseDrag(panel)) };
}

/**
 * Release the button and wait until the page has seen the drag end (`dragend`). Does not throw
 * when it never arrives: a drag whose source row was rebuilt mid-drag loses its `dragend`
 * (Probe 13 P8), and that must show up as a failed assertion in the test, not as an error in
 * here. Returns at once when no drag had started.
 * @param {import('@playwright/test').Page} panel
 * @returns {Promise<{ dropped: boolean, ended: boolean }>}
 */
async function releaseDrag(panel) {
  await panel.mouse.up();
  await pageHolds(panel, () => {
    const d = window.__bmDrag;
    return !d || d.start === 0 || d.end > 0;
  }, null, END_MS);
  return panel.evaluate(() => {
    const d = window.__bmDrag;
    return { dropped: Boolean(d && d.drop > 0), ended: Boolean(d && d.end > 0) };
  });
}

/* ── Changes the panel did not make, and proof that it did not rebuild ────── */

/**
 * Run `fn(arg)` in the service worker: a write the panel did not make, which reaches the panel
 * as a `chrome.bookmarks.on*` event, the way a change in Chrome's own bookmark manager does.
 *   await externalWrite(sw, (a) => chrome.bookmarks.create(a), { parentId, title: 'X' });
 * `fn` runs in the worker, so it cannot see this file's variables; pass them in `arg`.
 * @param {import('@playwright/test').Worker} sw
 * @param {Function} fn
 * @param {any} [arg]
 */
function externalWrite(sw, fn, arg) {
  if (typeof fn !== 'function') throw new TypeError('externalWrite: fn must be a function');
  return swEval(sw, fn, arg);
}

/**
 * Put a marker on the one element that matches `selector`, and remember the element itself.
 * @param {import('@playwright/test').Page} panel
 * @param {string} selector must match exactly one element now
 * @returns {Promise<string>} the marker, written to `data-bm-mark`
 */
function markNode(panel, selector) {
  return panel.evaluate((sel) => {
    const found = document.querySelectorAll(sel);
    if (found.length !== 1) throw new Error(`markNode: ${found.length} elements match ${sel}, expected exactly 1`);
    const marks = (window.__bmMarks ||= new Map());
    const token = `m${marks.size + 1}-${Math.random().toString(36).slice(2, 8)}`;
    found[0].setAttribute('data-bm-mark', token);
    marks.set(sel, { el: found[0], token });
    return token;
  }, selector);
}

/**
 * Is what `selector` matches now the very node {@link markNode} marked: one match, the same
 * node (not a clone that copied the attribute), the marker still on it. False after the panel
 * rebuilt it.
 * @param {import('@playwright/test').Page} panel
 * @param {string} selector the same selector that was marked
 * @returns {Promise<boolean>}
 */
function sameNode(panel, selector) {
  return panel.evaluate((sel) => {
    const mark = window.__bmMarks && window.__bmMarks.get(sel);
    if (!mark) throw new Error(`sameNode: ${sel} was never marked`);
    const now = document.querySelectorAll(sel);
    return now.length === 1 && now[0] === mark.el && mark.el.getAttribute('data-bm-mark') === mark.token;
  }, selector);
}

/**
 * Count what happens to the children of the list: `{ n, t, where, added, removed }` per change,
 * `where` = 'list' (a row came or went) or 'rail' (the column was rebuilt), `added` and
 * `removed` = how many ELEMENTS. A repaint empties the list in one assignment and appends the
 * rows again, so it is one record that removed rows followed by records that added them.
 *
 * Watches `#bookmark-rail` rather than the list: `start()` builds a new list, and an observer
 * on the old one would go quiet without saying so. Needs the column to be showing a list.
 *
 * "Nothing was rebuilt" only means something if a rebuild WOULD have been counted, so before
 * returning one hidden node is inserted into the list and into the rail and taken out again,
 * in the same task (no frame can show it), and the four records that makes are checked, then
 * cleared. That proves the observer is attached to the live list and rail and that both ways
 * of classifying a change work.
 * @param {import('@playwright/test').Page} panel
 */
async function installRepaintSpy(panel) {
  const canary = await panel.evaluate(() => {
    if (window.__bmRepaint) return null;
    const rail = document.getElementById('bookmark-rail');
    const list = document.querySelector('[data-testid="bookmark-list"]');
    if (!rail || !list) {
      throw new Error('installRepaintSpy: the column shows no list (no #bookmark-rail / bookmark-list); '
        + 'install it after showBookmarks()');
    }
    const spy = { records: [], seq: 0 };
    const elements = (nodes) => [...nodes].filter((n) => n.nodeType === 1).length;
    const take = (records) => {
      for (const r of records) {
        if (r.type !== 'childList') continue;
        let where = null;
        if (r.target === rail) where = 'rail';
        else if (r.target.matches && r.target.matches('[data-testid="bookmark-list"]')) where = 'list';
        if (!where) continue;
        spy.records.push({
          n: (spy.seq += 1), t: performance.now(), where,
          added: elements(r.addedNodes), removed: elements(r.removedNodes),
        });
      }
    };
    const observer = new MutationObserver(take);
    observer.observe(rail, { childList: true, subtree: true });
    spy.flush = () => take(observer.takeRecords());
    window.__bmRepaint = spy;

    const dummy = document.createElement('i');
    dummy.hidden = true;
    list.append(dummy);
    dummy.remove();
    rail.append(dummy);
    dummy.remove();
    spy.flush();
    const seen = spy.records.map((r) => ({ where: r.where, added: r.added, removed: r.removed }));
    spy.records.length = 0;
    spy.seq = 0;
    return seen;
  });
  if (canary) {
    expect(canary, 'the repaint spy counts a node added to and removed from the live list and rail').toEqual([
      { where: 'list', added: 1, removed: 0 },
      { where: 'list', added: 0, removed: 1 },
      { where: 'rail', added: 1, removed: 0 },
      { where: 'rail', added: 0, removed: 1 },
    ]);
  }
}

/**
 * What {@link installRepaintSpy} has counted: `records`, the totals `added` and `removed`
 * (elements), and `removals` = how many records removed at least one element. Compare two
 * reads for a window ("nothing rebuilt for 1 s" is `removed` unchanged). An edit row leaving
 * the list is a removal too, so a test that cares about repaints says so by size.
 * @param {import('@playwright/test').Page} panel
 */
function readRepaintSpy(panel) {
  return panel.evaluate(() => {
    const spy = window.__bmRepaint;
    if (!spy) throw new Error('readRepaintSpy: installRepaintSpy was not called on this page');
    spy.flush();
    const records = spy.records.map((r) => ({ ...r }));
    const sum = (key) => records.reduce((total, r) => total + r[key], 0);
    return {
      records,
      added: sum('added'),
      removed: sum('removed'),
      removals: records.filter((r) => r.removed > 0).length,
    };
  });
}

module.exports = {
  ROW, DROP_INDICATOR, DROP_INTO, WRITE_METHODS, READ_METHODS, NEVER_CALLED,
  installWriteSpy, readWriteSpy,
  seedTree, childrenOf, subtreeOf, orderOracle,
  rowTitled, dropPoint, dragRow, releaseDrag,
  externalWrite, markNode, sameNode, installRepaintSpy, readRepaintSpy,
};

/* ══ Added with the drag and drop unit (38-bookmark-reorder-move) ══════════════════════════════
   Appended; nothing above this line is changed. `dragRow` drives a drag between two named rows. What
   follows is for the cases that need more: a pause with the button down, a point that is no row (the
   1 px between two rows, the bottom of the column), a change made with the button down, and a record
   of what the page saw and what one `dragover` cost. The drop feedback exists now, so `dragRow` with
   `valid: true` can pass. */

/**
 * The titles of the DIRECT children of the folder `folderId`, in the order the column draws them, or
 * null when that folder's row is not on screen. (The rows are one flat list; the folder's children
 * are the rows after it that are exactly one level deeper, up to the next row that is not deeper.)
 * @param {import('@playwright/test').Page} panel
 * @param {string} folderId
 * @returns {Promise<string[]|null>}
 */
function domChildren(panel, folderId) {
  return panel.evaluate((id) => {
    const folder = document.querySelector(`[data-testid="bookmark-row"][data-bookmark-id="${CSS.escape(id)}"]`);
    if (!folder) return null;
    const depth = Number(folder.dataset.depth);
    const out = [];
    for (let el = folder.nextElementSibling; el; el = el.nextElementSibling) {
      if (el.dataset.testid !== 'bookmark-row') continue;
      const d = Number(el.dataset.depth);
      if (d <= depth) break;
      if (d === depth + 1) out.push((el.querySelector('.w-row__main') || el).textContent);
    }
    return out;
  }, folderId);
}

/**
 * What the column shows of a drag right now: the line (its box, or null when it is not showing), the
 * titles of the rows that carry the "inside" outline, and how many rows are dimmed as being carried.
 * @param {import('@playwright/test').Page} panel
 * @returns {Promise<{ line: { top: number, left: number, width: number, height: number }|null, into: string[], dragging: number }>}
 */
function railFeedback(panel) {
  return panel.evaluate((sel) => {
    const line = document.querySelector(sel.line);
    const box = line && !line.hidden ? line.getBoundingClientRect() : null;
    return {
      line: box && box.height > 0 ? { top: box.top, left: box.left, width: box.width, height: box.height } : null,
      into: [...document.querySelectorAll(sel.into)]
        .map((el) => (el.querySelector('.w-row__main') || el).textContent),
      dragging: document.querySelectorAll('.is-bmk-dragging').length,
    };
  }, { line: DROP_INDICATOR, into: DROP_INTO });
}

/**
 * Put the children of `parentId` back in the order `ids`, from the service worker (a write the panel
 * did not make). Ascending, so that each one is moved to an index that is at or before where it is.
 * @param {import('@playwright/test').Worker} sw
 * @param {string} parentId
 * @param {string[]} ids
 */
function restoreOrder(sw, parentId, ids) {
  return swEval(sw, async (a) => {
    for (let i = 0; i < a.ids.length; i += 1) {
      await chrome.bookmarks.move(a.ids[i], { parentId: a.parentId, index: i });
    }
  }, { parentId, ids });
}

/**
 * Record every drag event the page gets, in the order it gets them: `{ k, t, x, y, target, types,
 * settled, prevented }` with `target` = `{ tag, cls, testid, row, isList, isRail }` (`row` = the id of
 * the row the target is in or is, else null) and `prevented` = whether the event had been cancelled by
 * the time its dispatch was over (read in a task of its own, so a handler anywhere on the path has had
 * its say). `dragstart` is stamped in the bubble phase, so its `types` are what the page's handler left
 * in the data store; a `drop` also carries `rowRect`, the box of its target's row at that moment.
 * Idempotent per page; each call empties the record.
 * @param {import('@playwright/test').Page} panel
 */
async function installDragLog(panel) {
  await panel.evaluate(() => {
    let log = window.__bmLog;
    if (!log) {
      log = { events: [] };
      window.__bmLog = log;
      const describe = (el) => {
        if (!(el instanceof Element)) return { tag: String(el && el.nodeName), cls: '', testid: '', row: null, isList: false, isRail: false };
        const row = el.closest('[data-bookmark-id]');
        return {
          tag: el.tagName,
          cls: String(el.getAttribute('class') || ''),
          testid: el.dataset ? el.dataset.testid || '' : '',
          row: row ? row.dataset.bookmarkId : null,
          isList: el.matches('[data-testid="bookmark-list"]'),
          isRail: el.id === 'bookmark-rail',
        };
      };
      const typesOf = (e) => {
        try { return Array.from(e.dataTransfer ? e.dataTransfer.types : []); } catch { return null; }
      };
      const note = (e, extra) => {
        const rec = {
          k: e.type, t: performance.now(), x: e.clientX, y: e.clientY, target: describe(e.target),
          types: typesOf(e), settled: false, prevented: null, ...extra,
        };
        log.events.push(rec);
        return rec;
      };
      for (const kind of ['dragenter', 'dragover', 'dragleave', 'drop', 'dragend']) {
        window.addEventListener(kind, (e) => {
          const extra = {};
          if (kind === 'drop' && e.target instanceof Element) {
            const row = e.target.closest('[data-bookmark-id]');
            if (row) {
              const r = row.getBoundingClientRect();
              extra.rowRect = { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
            }
          }
          const rec = note(e, extra);
          setTimeout(() => { rec.settled = true; rec.prevented = e.defaultPrevented; }, 0);
        }, true);
      }
      window.addEventListener('dragstart', (e) => { note(e, { settled: true, hasData: Boolean(e.dataTransfer) }); }, false);
    }
    log.events.length = 0;
  });
}

/** A copy of what {@link installDragLog} has recorded since it was last called. */
function readDragLog(panel) {
  return panel.evaluate(() => {
    if (!window.__bmLog) throw new Error('readDragLog: installDragLog was not called on this page');
    return JSON.parse(JSON.stringify(window.__bmLog.events));
  });
}

/**
 * Press on `src` (a title, or a Locator) and move far enough for the browser to start the drag, then
 * stop with the button down. {@link steerTo} moves on from there; {@link releaseDrag} lets go.
 * Waits for the evidence (`dragstart`), not for a time; `started` is false when the browser never
 * started one, which is the answer for a row that cannot be dragged.
 * @param {import('@playwright/test').Page} panel
 * @param {string|import('@playwright/test').Locator} src
 * @returns {Promise<{ started: boolean, x: number, y: number }>} where the pointer is now
 */
async function beginDrag(panel, src) {
  const from = locate(panel, src);
  await expect(from, `the drag source ${label(src)} is on the page`).toBeVisible();
  await expect(panel.locator(DROP_INDICATOR), 'no drop line is showing before the drag starts').toBeHidden();
  await expect(panel.locator(DROP_INTO), 'no folder is outlined before the drag starts').toHaveCount(0);
  await recordDrag(panel);
  await installDragLog(panel);
  await from.scrollIntoViewIfNeeded();
  const box = await from.boundingBox();
  if (!box) throw new Error(`beginDrag: ${label(src)} has no box`);
  const sx = box.x + box.width / 2;
  const sy = box.y + box.height / 2;
  await panel.mouse.move(sx, sy);
  await panel.mouse.down();
  await panel.mouse.move(sx + 6, sy + 6, { steps: 4 });
  const started = await pageHolds(panel, () => window.__bmDrag.start > 0, null, START_MS);
  return { started, x: sx + 6, y: sy + 6 };
}

/**
 * Move the pointer, button down, to (x, y) by the same last approach `dragRow` makes (a sideways move
 * of `sway` px at the target's height, then two steps), and wait until the page has handled the last
 * `dragenter` or `dragover` there. Returns whether it did.
 * @param {import('@playwright/test').Page} panel
 * @param {number} x
 * @param {number} y
 * @param {{ sway?: number }} [options]
 * @returns {Promise<boolean>}
 */
async function steerTo(panel, x, y, { sway = SWAY_PX } = {}) {
  await panel.mouse.move(x - sway, y, { steps: 16 });
  await panel.mouse.move(x, y, { steps: 2 });
  return pageHolds(panel, ({ x: wantX, y: wantY }) => {
    const events = window.__bmLog.events.filter((e) => e.k === 'dragenter' || e.k === 'dragover');
    const last = events[events.length - 1];
    return Boolean(last && last.settled && Math.abs(last.x - wantX) <= 1.5 && Math.abs(last.y - wantY) <= 1.5);
  }, { x, y }, ARRIVE_MS);
}

/** Wait for the line or the outline to be on screen; throws, with what the page saw, if neither comes. */
async function expectFeedback(panel, what) {
  try {
    await expect(panel.locator(DROP_INDICATOR).or(panel.locator(DROP_INTO)).first())
      .toBeVisible({ timeout: FEEDBACK_MS });
  } catch (err) {
    throw new Error(`${what}: no drop feedback (${DROP_INDICATOR} or ${DROP_INTO}) with the button still down. `
      + `facts=${await dragFacts(panel)}\n${err.message}`);
  }
}

/**
 * Count what ONE `dragenter` / `dragover` costs the page: the calls to `getBoundingClientRect`,
 * `getClientRects`, `elementFromPoint` and `elementsFromPoint` made while the event is being
 * dispatched. A capture listener on `window` takes the count as the dispatch begins and a bubble
 * listener on `window` as it ends, so what is counted is the handlers' work and nothing between events.
 * A sample with `missing: true` is an event whose dispatch did not reach `window` again (somebody
 * stopped it).
 *
 * "Nothing was counted" only means something if a call WOULD have been, so before returning a
 * synthetic `dragover` is dispatched on <body> with a listener that makes one call of two of the
 * four, and the sample that makes is checked, then cleared.
 * @param {import('@playwright/test').Page} panel
 */
async function installDragCostSpy(panel) {
  const canary = await panel.evaluate(() => {
    if (window.__bmCost) return null;
    const cost = { counts: { rect: 0, rects: 0, point: 0, points: 0 }, samples: [], open: null };
    window.__bmCost = cost;
    const wrap = (proto, name, key) => {
      const real = proto[name];
      proto[name] = function counted(...args) { cost.counts[key] += 1; return real.apply(this, args); };
    };
    wrap(Element.prototype, 'getBoundingClientRect', 'rect');
    wrap(Element.prototype, 'getClientRects', 'rects');
    wrap(Document.prototype, 'elementFromPoint', 'point');
    wrap(Document.prototype, 'elementsFromPoint', 'points');
    for (const kind of ['dragenter', 'dragover']) {
      window.addEventListener(kind, () => { cost.open = { ...cost.counts }; }, true);
      window.addEventListener(kind, (e) => {
        if (!cost.open) {
          cost.samples.push({ k: e.type, missing: true });
          return;
        }
        const d = {};
        for (const key of Object.keys(cost.counts)) d[key] = cost.counts[key] - cost.open[key];
        cost.samples.push({ k: e.type, ...d });
        cost.open = null;
      }, false);
    }
    const probe = () => {
      document.body.getBoundingClientRect();
      document.elementFromPoint(1, 1);
    };
    document.body.addEventListener('dragover', probe);
    document.body.dispatchEvent(new Event('dragover', { bubbles: true }));
    document.body.removeEventListener('dragover', probe);
    const sample = cost.samples[0] || null;
    cost.samples.length = 0;
    cost.open = null;
    return sample;
  });
  if (canary) {
    expect(canary, 'the cost spy counts the calls made while one dragover is dispatched')
      .toEqual({ k: 'dragover', rect: 1, rects: 0, point: 1, points: 0 });
  }
}

/** The samples {@link installDragCostSpy} has taken, one per `dragenter` / `dragover`, oldest first. */
function readDragCostSpy(panel) {
  return panel.evaluate(() => {
    if (!window.__bmCost) throw new Error('readDragCostSpy: installDragCostSpy was not called on this page');
    return JSON.parse(JSON.stringify(window.__bmCost.samples));
  });
}

/** Empty the record of {@link installDragCostSpy}. */
function resetDragCostSpy(panel) {
  return panel.evaluate(() => { window.__bmCost.samples.length = 0; window.__bmCost.open = null; });
}

/**
 * A gate on the panel's own reads of a folder (`chrome.bookmarks.getChildren`): while it is armed
 * a call is held, and answered when the gate is opened. That makes "a repaint that is already in
 * flight when the drag starts" something a test can stage exactly, with no timer to race.
 * {@link armReadGate} starts holding, {@link readGate} says how many calls are held, and
 * {@link openReadGate} stops holding and lets the held ones through (it returns how many).
 * @param {import('@playwright/test').Page} panel
 */
function installReadGate(panel) {
  return panel.evaluate(() => {
    if (window.__bmGate) return;
    const gate = { armed: false, held: 0, waiting: [] };
    window.__bmGate = gate;
    const real = chrome.bookmarks.getChildren.bind(chrome.bookmarks);
    chrome.bookmarks.getChildren = (...args) => {
      if (!gate.armed) return real(...args);
      gate.held += 1;
      return new Promise((resolve, reject) => {
        gate.waiting.push(() => real(...args).then(resolve, reject));
      });
    };
  });
}

function armReadGate(panel) {
  return panel.evaluate(() => {
    if (!window.__bmGate) throw new Error('armReadGate: installReadGate was not called on this page');
    window.__bmGate.armed = true;
    window.__bmGate.held = 0;
  });
}

function readGate(panel) {
  return panel.evaluate(() => ({ armed: window.__bmGate.armed, held: window.__bmGate.held, waiting: window.__bmGate.waiting.length }));
}

function openReadGate(panel) {
  return panel.evaluate(() => {
    const gate = window.__bmGate;
    gate.armed = false;
    const waiting = gate.waiting.splice(0);
    for (const answer of waiting) answer();
    return waiting.length;
  });
}

/**
 * Stage the loss of the permission as 32-bookmarks-rail and 37-bookmark-folders do: `contains()`
 * says no, and the calls the next move makes (`get`, `move`) fail with the message of a revoked
 * namespace. The reads of the column are left alone, so that what the column does about it is its own.
 * @param {import('@playwright/test').Page} panel
 */
function staleGrant(panel) {
  return panel.evaluate(() => {
    chrome.permissions.contains = () => Promise.resolve(false);
    const gone = (name) => () => Promise.reject(new Error(`'bookmarks.${name}' is not available in this context.`));
    chrome.bookmarks.get = gone('get');
    chrome.bookmarks.move = gone('move');
  });
}

Object.assign(module.exports, {
  domChildren, railFeedback, restoreOrder,
  installDragLog, readDragLog, beginDrag, steerTo, expectFeedback,
  installDragCostSpy, readDragCostSpy, resetDragCostSpy,
  installReadGate, armReadGate, readGate, openReadGate, staleGrant,
});

/* ── U6: the row menu and the keys that move a row (41-bookmark-menu-keys) ─────
   The menu is the panel's one `#context-menu` (context-menu.js), filled by bookmark-menu.js; the
   items are `[data-testid="menu-item-<id>"]` with the ids below. */

/** The panel's one context menu, and the submenu it grows for "Move to…". */
const MENU = '[data-testid="context-menu"]';
const SUBMENU = '[data-testid="context-submenu"]';
/** The ids of the items of a row's menu, in the order they are offered. */
const MENU_ITEMS = Object.freeze({
  newFolder: 'bm-new-folder', rename: 'bm-rename', up: 'bm-up', down: 'bm-down', moveTo: 'bm-move-to',
});

/** The menu item `id` (an id from {@link MENU_ITEMS}, or `bm-moveto-<folderId>` in the submenu). */
function menuItem(panel, id) {
  return panel.locator(`[data-testid="menu-item-${id}"]`);
}

/**
 * What the menu shows right now, read in one go: whether it is open, its items in order (`id`, the
 * label's text, `disabled` as the property, `ariaDisabled` as the attribute, `parent` = it opens a
 * submenu), the submenu's items if one is open (else null), the box of the menu, and how many
 * `role="menu"` elements are on screen (the menu itself, plus the submenu while one is open).
 * @param {import('@playwright/test').Page} panel
 */
function readMenu(panel) {
  return panel.evaluate(() => {
    const menu = document.getElementById('context-menu');
    if (!menu || menu.hidden) return { open: false, items: [], submenu: null, box: null, menus: 0 };
    const read = (el) => {
      const label = el.querySelector('.menu__label');
      return {
        id: el.dataset.id || null,
        label: label ? label.textContent : el.textContent,
        disabled: el.disabled === true,
        ariaDisabled: el.getAttribute('aria-disabled'),
        parent: el.classList.contains('menu__item--parent'),
      };
    };
    const sub = menu.querySelector('[data-testid="context-submenu"]');
    const box = menu.getBoundingClientRect();
    return {
      open: true,
      items: [...menu.querySelectorAll(':scope > .menu__item')].map(read),
      submenu: sub ? [...sub.querySelectorAll(':scope > .menu__item')].map(read) : null,
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      menus: document.querySelectorAll('[role="menu"]:not([hidden])').length,
    };
  });
}

/**
 * Record every `contextmenu` event from now on: whether it had been cancelled when it reached
 * `document` (this listener is on `document`, in the bubble phase, so every handler between the target
 * and the document has had its say), and the id of the row it was aimed at (else the tag of its target).
 * Each call empties the record.
 * @param {import('@playwright/test').Page} panel
 */
function watchContextMenuEvents(panel) {
  return panel.evaluate(() => {
    if (window.__u6Cm) { window.__u6Cm.length = 0; return; }
    window.__u6Cm = [];
    document.addEventListener('contextmenu', (event) => {
      const el = event.target instanceof Element ? event.target : null;
      const row = el ? el.closest('[data-bookmark-id]') : null;
      window.__u6Cm.push({ prevented: event.defaultPrevented, on: row ? row.dataset.bookmarkId : (el ? el.tagName : null) });
    });
  });
}

/** What {@link watchContextMenuEvents} has recorded, oldest first. */
function readContextMenuEvents(panel) {
  return panel.evaluate(() => {
    if (!window.__u6Cm) throw new Error('readContextMenuEvents: watchContextMenuEvents was not called on this page');
    return window.__u6Cm.map((e) => ({ ...e }));
  });
}

/**
 * Record every text the toast shows from now on (the single #toast takes the newest and hides it
 * after 2.5 s, so a test that polls it can be too late to see a message that WAS shown). Each call
 * starts a fresh record.
 * @param {import('@playwright/test').Page} panel
 */
function recordToastTexts(panel) {
  return panel.evaluate(() => {
    const el = document.getElementById('toast');
    if (!window.__u6ToastWatch) {
      window.__u6Toasts = [];
      window.__u6ToastWatch = new MutationObserver(() => { if (!el.hidden && el.textContent) window.__u6Toasts.push(el.textContent); });
      window.__u6ToastWatch.observe(el, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    }
    window.__u6Toasts.length = 0;
  });
}

/** The texts {@link recordToastTexts} saw, oldest first, without the repeats that a hide and a show make. */
function readToastTexts(panel) {
  return panel.evaluate(() => {
    if (!window.__u6ToastWatch) throw new Error('readToastTexts: recordToastTexts was not called on this page');
    return window.__u6Toasts.filter((text, i, all) => text !== all[i - 1]);
  });
}

/** The bookmark id of the element that has focus, or null when it is not a row. */
function activeRowId(panel) {
  return panel.evaluate(() => {
    const el = document.activeElement;
    return el && el.dataset && el.dataset.bookmarkId ? el.dataset.bookmarkId : null;
  });
}

Object.assign(module.exports, {
  MENU, SUBMENU, MENU_ITEMS, menuItem, readMenu,
  watchContextMenuEvents, readContextMenuEvents, recordToastTexts, readToastTexts, activeRowId,
});

/* ── The robustness specs (44-bookmark-robustness) ────────────────────────────────────────────────────
   Appended; nothing above is changed. What follows counts how often the column rebuilds its rows, and
   stages the ORDER of a late tree event against a repaint that is already reading, with no clock to race:
   the answer of one read is held (`installAnswerGate`) and the 400 ms timer of the repaint is held in the
   test's hand (`installTimerHold`). Needs `installRepaintSpy` for everything that counts. */

/** `performance.now()` of the page: the clock the repaint spy stamps its records with. */
function pageNow(panel) {
  return panel.evaluate(() => performance.now());
}

/** Resolves once the page's clock has passed `until` (a value of {@link pageNow}). */
function waitPageClock(panel, until) {
  return panel.waitForFunction((t) => performance.now() >= t, until, { timeout: 30_000, polling: 50 });
}

/**
 * Wait until the column has not rebuilt or added a row for `ms` (a quiet start: nothing from the set-up is
 * still on its way). Needs installRepaintSpy.
 * @param {import('@playwright/test').Page} panel
 * @param {number} [ms]
 */
function columnRests(panel, ms = 900) {
  return panel.waitForFunction((wait) => {
    const spy = window.__bmRepaint;
    if (!spy) throw new Error('columnRests: installRepaintSpy was not called on this page');
    spy.flush();
    const last = spy.records.length ? spy.records[spy.records.length - 1].t : 0;
    return performance.now() - last >= wait;
  }, ms, { timeout: 30_000, polling: 100 });
}

/**
 * How many times the column rebuilt ALL its rows at or after `since` (a value of {@link pageNow}), and when:
 * `at` is each rebuild's time in ms after `since`. A rebuild is one record of the repaint spy in which the list
 * lost at least `minRows` elements at once (a paint empties the list in one assignment); the name field leaving
 * the list is one element and is not counted.
 * @param {import('@playwright/test').Page} panel
 * @param {number} since
 * @param {number} [minRows]
 * @returns {Promise<{ n: number, at: number[] }>}
 */
function rebuildsSince(panel, since, minRows = 3) {
  return panel.evaluate((a) => {
    const spy = window.__bmRepaint;
    if (!spy) throw new Error('rebuildsSince: installRepaintSpy was not called on this page');
    spy.flush();
    const at = spy.records
      .filter((r) => r.where === 'list' && r.removed >= a.minRows && r.t >= a.since)
      .map((r) => Math.round(r.t - a.since));
    return { n: at.length, at };
  }, { since, minRows });
}

/**
 * Hold the ANSWER of one folder's `getChildren`: while it is armed, a read of that folder is made at once (so
 * it sees the tree as it is NOW) and its answer is handed back only when the gate is opened. A repaint that is
 * waiting on it has therefore read the tree before whatever the test changes next, and finishes after.
 * Unlike {@link installReadGate}, which makes the read itself late. Every other read is untouched.
 * @param {import('@playwright/test').Page} panel
 */
function installAnswerGate(panel) {
  return panel.evaluate(() => {
    if (window.__bmAnswers) return;
    const gate = { folder: null, held: 0, waiting: [] };
    window.__bmAnswers = gate;
    const real = chrome.bookmarks.getChildren.bind(chrome.bookmarks);
    chrome.bookmarks.getChildren = (...args) => {
      const answer = real(...args);
      if (gate.folder === null || String(args[0]) !== gate.folder) return answer;
      gate.held += 1;
      return new Promise((resolve, reject) => {
        gate.waiting.push(() => answer.then(resolve, reject));
      });
    };
  });
}

/** Start holding the answer of `folderId`'s children (and count the held ones from zero). */
function armAnswerGate(panel, folderId) {
  return panel.evaluate((id) => {
    if (!window.__bmAnswers) throw new Error('armAnswerGate: installAnswerGate was not called on this page');
    window.__bmAnswers.folder = String(id);
    window.__bmAnswers.held = 0;
  }, folderId);
}

/** How many answers {@link armAnswerGate} is holding. */
function answersHeld(panel) {
  return panel.evaluate(() => window.__bmAnswers.held);
}

/** Stop holding, and give the held answers back. Resolves to how many there were. */
function openAnswerGate(panel) {
  return panel.evaluate(() => {
    const gate = window.__bmAnswers;
    gate.folder = null;
    const waiting = gate.waiting.splice(0);
    for (const give of waiting) give();
    return waiting.length;
  });
}

/**
 * Take the 400 ms timers of the page (the column's repaint debounce is one) into the test's hand: while
 * {@link holdTimers} is on, a `setTimeout` of exactly 400 ms is not started but kept, and runs when
 * {@link fireTimers} says so (`clearTimeout` of a kept one drops it). Everything else keeps its real timer.
 * This is what makes "the event arrived while the repaint was reading" a fact of the test and not of a race.
 * @param {import('@playwright/test').Page} panel
 */
function installTimerHold(panel) {
  return panel.evaluate(() => {
    if (window.__bmTimers) return;
    const realSet = window.setTimeout.bind(window);
    const realClear = window.clearTimeout.bind(window);
    const hold = { on: false, pending: new Map(), seq: 0, made: 0 };
    window.__bmTimers = hold;
    window.setTimeout = (fn, ms, ...rest) => {
      if (!hold.on || ms !== 400 || typeof fn !== 'function') return realSet(fn, ms, ...rest);
      hold.made += 1;
      hold.seq += 1;
      const id = 900_000_000 + hold.seq;
      hold.pending.set(id, () => fn(...rest));
      return id;
    };
    window.clearTimeout = (id) => {
      if (hold.pending.delete(id)) return;
      realClear(id);
    };
  });
}

/** Switch the holding of 400 ms timers on or off. Turning it off does not fire what is kept. */
function holdTimers(panel, on) {
  return panel.evaluate((flag) => {
    if (!window.__bmTimers) throw new Error('holdTimers: installTimerHold was not called on this page');
    window.__bmTimers.on = flag;
  }, on);
}

/** How many held 400 ms timers are waiting. */
function heldTimers(panel) {
  return panel.evaluate(() => window.__bmTimers.pending.size);
}

/** Run every held timer, oldest first, and forget them. Resolves to how many ran. */
function fireTimers(panel) {
  return panel.evaluate(() => {
    const hold = window.__bmTimers;
    const run = [...hold.pending.values()];
    hold.pending.clear();
    for (const fn of run) fn();
    return run.length;
  });
}

Object.assign(module.exports, {
  pageNow, waitPageClock, columnRests, rebuildsSince,
  installAnswerGate, armAnswerGate, answersHeld, openAnswerGate,
  installTimerHold, holdTimers, heldTimers, fireTimers,
});

/* ── A window that loses focus (45-bookmark-window-blur) ──────────────────────────────────────────────────
   Appended; nothing above is changed.

   Why it is done this way (probe 105, measured in the e2e image; tests/probes/105-window-blur-probe.spec.js).
   Playwright switches focus emulation on for every page it opens, so a page believes it has focus for ever, and
   nothing done to ANOTHER WINDOW changes that: `Page.bringToFront` of a page of the second window, and
   `chrome.windows.update(id, { focused: true })`, give the panel page no event and `document.hasFocus()` stays
   true, with emulation on or off. A sibling tab of the panel's own window brought to front changes nothing either,
   as long as the emulation is on. What works is both: a SECOND CDP session of the panel page says
   `Emulation.setFocusEmulationEnabled({ enabled: false })`, and then another tab of the panel's own window is
   brought to front. The field gets a real `blur` that sees `document.hasFocus() === false`, the window gets
   `blur`, `document.visibilityState` stays 'visible' and `document.hidden` false, and `document.activeElement` is
   still the field. Bringing the panel back gives `focus` on the window and on the field, `hasFocus()` true.
   Three runs of the probe gave the same lines each time.

   What it is NOT: an operating-system window losing focus (no window manager is involved; it is a tab switch in
   headless Chromium that gives the page the events of one), and the panel is a tab here, not the side panel. */

/**
 * Record, in the panel page, every `blur` and `focus` it gets, whatever they are aimed at: a capture listener on
 * `window` sees an event aimed at an element as well as one aimed at the window itself.
 * `{ n, k: 'blur'|'focus', on, hasFocus, vis, hidden }`. `on` is 'window', 'document', or for an element its
 * `data-testid`, else `#id`, else its tag. `hasFocus` / `vis` / `hidden` are `document.hasFocus()` /
 * `document.visibilityState` / `document.hidden` at the moment of the dispatch, which is what a handler of that
 * event sees. The listener on `window` runs before the field's own, so `hasFocus` is what the field's handler saw.
 * Idempotent per page; each call empties the record (numbering goes on, so `since` stays meaningful).
 * @param {import('@playwright/test').Page} panel
 */
function watchFocus(panel) {
  return panel.evaluate(() => {
    if (!window.__wfLog) {
      const log = { events: [], seq: 0 };
      window.__wfLog = log;
      const nameOf = (target) => {
        if (target === window) return 'window';
        if (target === document) return 'document';
        if (!(target instanceof Element)) return String(target && target.nodeName);
        return target.dataset.testid || (target.id ? `#${target.id}` : target.tagName);
      };
      for (const kind of ['blur', 'focus']) {
        window.addEventListener(kind, (event) => {
          log.events.push({
            n: (log.seq += 1), k: kind, on: nameOf(event.target),
            hasFocus: document.hasFocus(), vis: document.visibilityState, hidden: document.hidden,
          });
        }, true);
      }
    }
    window.__wfLog.events.length = 0;
  });
}

/**
 * What {@link watchFocus} has recorded, oldest first; only the events after number `since`.
 * @param {import('@playwright/test').Page} panel
 * @param {number} [since]
 * @returns {Promise<Array<{ n: number, k: 'blur'|'focus', on: string, hasFocus: boolean, vis: string, hidden: boolean }>>}
 */
function readFocusLog(panel, since = 0) {
  return panel.evaluate((after) => {
    if (!window.__wfLog) throw new Error('readFocusLog: watchFocus was not called on this page');
    return window.__wfLog.events.filter((e) => e.n > after).map((e) => ({ ...e }));
  }, since);
}

/**
 * Make the panel page lose and regain focus, the way a window does.
 *   const focus = await windowFocus({ context, panel, serviceWorker, windowId: harness.w1 });
 *   await focus.prepare();            // optional: the page's focus state is the real one from here on
 *   const lost = await focus.lose();  // the events the page got: a `blur` of the focused element that saw
 *                                     // hasFocus() false, and the window's `blur`; the element stays activeElement
 *   const back = await focus.regain();// the window's `focus`, and the element's
 * `prepare` switches focus emulation off and checks that the page, in the front tab of its window, has focus
 * (it is called by the first `lose` if the test did not). A test that never calls either is untouched. Both
 * `lose` and `regain` wait for the page's own word that it happened and say so in their message if it does not
 * come; they do not look at what the product did about it.
 * @param {{ context: import('@playwright/test').BrowserContext, panel: import('@playwright/test').Page,
 *   serviceWorker: import('@playwright/test').Worker, windowId: number }} args `windowId` is the window the
 *   panel PAGE is a tab of (`harness.w1`), not the window it is scoped to.
 */
async function windowFocus({ context, panel, serviceWorker, windowId }) {
  let cdp = null;
  let sibling = null;
  const lastSeq = async () => (await readFocusLog(panel)).at(-1)?.n ?? 0;

  async function prepare() {
    if (cdp) return;
    await panel.bringToFront();
    await watchFocus(panel);
    cdp = await context.newCDPSession(panel);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await expect.poll(() => panel.evaluate(() => document.hasFocus()), {
      timeout: 10_000,
      message: 'focus emulation is off, and the panel, in the front tab of its window, has focus',
    }).toBe(true);
  }

  async function lose() {
    await prepare();
    const since = await lastSeq();
    sibling = await swEval(serviceWorker, async (id) => {
      const tab = await chrome.tabs.create({ windowId: id, url: 'about:blank', active: true });
      return tab.id;
    }, windowId);
    const lost = await pageHolds(panel, (after) => window.__wfLog.events.some(
      (e) => e.n > after && e.k === 'blur' && e.on === 'window',
    ), since, 10_000);
    expect(lost, 'another tab of the panel\'s window came to front and the panel page lost focus (its window got a `blur`)')
      .toBe(true);
    return readFocusLog(panel, since);
  }

  async function regain() {
    const since = await lastSeq();
    if (sibling !== null) {
      await swEval(serviceWorker, (id) => chrome.tabs.remove(id), sibling);
      sibling = null;
    }
    await panel.bringToFront();
    const back = await pageHolds(panel, (after) => document.hasFocus() && window.__wfLog.events.some(
      (e) => e.n > after && e.k === 'focus' && e.on === 'window',
    ), since, 10_000);
    expect(back, 'the panel came back to front and its page has focus again (its window got a `focus`, hasFocus() is true)')
      .toBe(true);
    return readFocusLog(panel, since);
  }

  return { prepare, lose, regain };
}

Object.assign(module.exports, { watchFocus, readFocusLog, windowFocus });

/* ── Focus that the PRODUCT moves while the window has none (unit A3, 45-bookmark-window-blur) ───────────────
   Appended; nothing above is changed. */

/**
 * Hand the panel the "focus the search box" intent the way the `search-tabs` command's handler does
 * (service-worker.js writes `storage.session.pendingFocusSearch = { windowId, at }`; search.js reads it on
 * `storage.onChanged` and calls `focusSearch()`, which is `input.focus()`), and wait until the search box is the
 * page's active element. So the focus move is made by the PANEL'S OWN code, fed by the key the shortcut writes.
 * NOT exercised: the command itself (`chrome.commands`), `sidePanel.open()` and the key press. Run it while the
 * panel page has lost focus (see {@link windowFocus}) and it is what an Alt+Shift+S does to a panel that has no
 * system focus: the active element changes, and the browser sends nothing to the element that lost it (probe 105).
 * @param {import('@playwright/test').Page} panel
 * @param {import('@playwright/test').Worker} serviceWorker
 * @param {number} windowId the window the panel is SCOPED to (`harness.w2`), which the hand-off must name
 */
async function focusSearchLikeTheShortcut(panel, serviceWorker, windowId) {
  await swEval(serviceWorker, (id) => chrome.storage.session.set({
    pendingFocusSearch: { windowId: id, at: Date.now() },
  }), windowId);
  await expect.poll(() => panel.evaluate(() => document.activeElement && document.activeElement.id), {
    timeout: 10_000,
    message: 'the panel\'s own focusSearch() ran and the search box is the active element',
  }).toBe('search-input');
}

/**
 * Count the `focus` listeners that code in the page puts on `window` from now on (not the capturing ones: the log
 * of {@link watchFocus} captures, and is not counted). `addEventListener` / `removeEventListener` of `window` are
 * wrapped, the way {@link installWriteSpy} wraps `chrome.bookmarks`; a listener is "live" from its add to its remove
 * (the same function twice is one listener, as in the browser). A listener added with `{ once: true }` or removed by
 * an AbortSignal is not tracked: the product's is neither.
 *
 * "Nothing is left" only means something if a listener WOULD have been counted, so before returning one is added and
 * removed again, and the two counts are checked. Idempotent per page.
 * @param {import('@playwright/test').Page} panel
 */
async function watchWindowFocusListeners(panel) {
  const canary = await panel.evaluate(() => {
    if (window.__wfListeners) return null;
    const live = new Set();
    window.__wfListeners = live;
    const capturing = (options) => (typeof options === 'boolean' ? options : Boolean(options && options.capture));
    const realAdd = window.addEventListener;
    const realRemove = window.removeEventListener;
    window.addEventListener = function addEventListener(type, listener, options) {
      if (type === 'focus' && listener && !capturing(options)) live.add(listener);
      return realAdd.call(this, type, listener, options);
    };
    window.removeEventListener = function removeEventListener(type, listener, options) {
      if (type === 'focus' && listener && !capturing(options)) live.delete(listener);
      return realRemove.call(this, type, listener, options);
    };
    const probe = () => {};
    window.addEventListener('focus', probe);
    const added = live.size;
    window.removeEventListener('focus', probe);
    return { added, removed: live.size };
  });
  if (canary) {
    expect(canary, 'the listener counter counts a `focus` listener added to window, and its removal').toEqual({ added: 1, removed: 0 });
  }
}

/** How many `focus` listeners {@link watchWindowFocusListeners} sees live on `window` now. */
function countWindowFocusListeners(panel) {
  return panel.evaluate(() => {
    if (!window.__wfListeners) throw new Error('countWindowFocusListeners: watchWindowFocusListeners was not called on this page');
    return window.__wfListeners.size;
  });
}

Object.assign(module.exports, { focusSearchLikeTheShortcut, watchWindowFocusListeners, countWindowFocusListeners });
