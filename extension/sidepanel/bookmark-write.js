/**
 * Writing to the bookmark tree: create a folder, rename a node, move a node (PR2, unit U3).
 *
 * No DOM and no `chrome`, and the only import is the pure maths (`bookmark-math.js`). The host
 * (`bookmarks.js`, through the seam of U4) hands in an object whose `bm` is the panel's one
 * `chrome.bookmarks` wrapper; every call here goes through `host.bm('<method>', ...)` with a LITERAL
 * method name, so the reviewer's grep and `tests/unit/bookmark-claims.test.mjs` see all of them. The
 * methods used are `get`, `getChildren`, `create`, `update` and `move`, and nothing else.
 *
 * `bm` answers `null` when a call failed (a rejection, or the namespace being gone after a revoke):
 * that is its only failure signal, and every answer is checked for it. `get` and `getChildren` resolve
 * with ARRAYS of nodes (Chrome's shape, even for one id); `create`, `update` and `move` with the node.
 *
 * ── How the host uses it ────────────────────────────────────────────────────
 *   const r = await queue(() => moveToPosition(host, { id, ...target }));
 *   // r = { ok, landed, reason }
 *   //   ok      a write resolved; `landed` is the node Chrome answered with, as { id, parentId, index }
 *   //           (read from Chrome's node, never from the maths: after a call the answer is the truth)
 *   //   reason  null when `ok`, else 'stale' | 'failed' | 'noop' (landed is then null):
 *   //     'stale'   a FRESH read says the place the user pointed at is gone, so nothing was written:
 *   //               toast `bookmarksStale`, repaint
 *   //     'failed'  something else could not be done, nothing (more) was written: toast `operationFailed`,
 *   //               repaint (`bm` has already shown the grant card if the permission went)
 *   //     'noop'    nothing to do (the drop changes nothing, an empty or unchanged name): no call
 *   //               was made and nothing is shown, not even a repaint
 *   // `host.log(line)` is optional: it is called once for every refusal, with the reason and the evidence
 *   // (ids and counts, never titles or urls).
 *
 * Every operation is a plain async function: it does NOT queue itself. The host puts each call through
 * `queue()`, which keeps them strictly one after the other (a burst of writes is unmeasured), and every
 * operation reads what it needs when it RUNS, never when it was queued: it takes ids, never indexes.
 *
 * Calls made, in order (`get` and `getChildren` read, the others write, at most one write per operation):
 *   createFolder     [get anchor]  create
 *   renameNode       update
 *   moveToPosition   get item  [climb: get ...]  [getChildren destination]  move
 *   moveRelative     get item  getChildren parent  move
 *
 * ── Readings where the plan and the criteria were silent or disagreed (each is tested) ───────────
 *  1. 'stale' vs 'failed' is decided by WHICH call came back null. 'stale' is only "a successful fresh read
 *     shows the anchor is gone" (moves: absent from `getChildren(parent)`; create: `get(anchor)` fails or
 *     the anchor sits in another folder now, plan O1) and "a folder into itself or under itself". Every
 *     other null is 'failed': the item to move cannot be read (criteria B8.4: operationFailed), the
 *     destination cannot be read (B8.4: a removed destination is operationFailed, not bookmarksStale), a
 *     write was rejected. So a new folder in a parent that was deleted meanwhile (no anchor, hence no read)
 *     is 'failed' too: Chrome's rejection of the `create` is the only thing that says so.
 *  2. 'noop' is not ok. `ok` means "a write resolved", so `landed` is set exactly when `ok` is. Reads were
 *     needed to decide a no-op; the promise is "no WRITE call".
 *  3. A name is normalised by the plan's rule: each `\r`, `\n`, `\t` becomes ONE space (what Chrome does
 *     anyway, Probe 13 P9) and the ends are trimmed (all Unicode white space, a full-width space too). Runs
 *     of spaces are NOT collapsed and nothing is truncated (`maxlength` belongs to the input). An empty
 *     name writes nothing, for a new folder as well (plan D1): it is never replaced by a default name. "Blur
 *     with the untouched default" is the UI's rule, because only the UI knows the default and the trigger.
 *  4. "Unchanged" (rename) is judged against the `original` title the UI passes, because plan O2 lists
 *     `update` as the only call, not against a read. The raw text counts as unchanged too, so an untouched
 *     edit of a title that has stray spaces is not silently trimmed.
 *  5. A folder moved to ANOTHER parent is checked for a cycle again at write time, from fresh reads: climb
 *     from the destination with `get` until the folder itself (-> 'stale'), the folder's own parent (stop:
 *     the folder cannot be above it) or the top (a node with no `parentId`, or a permanent folder). This
 *     costs extra reads for those drops only. Criteria B6.7 says "<= 2 reads per drop": that holds for a
 *     link, for any move inside one folder, and for a folder dropped INSIDE a sibling or a permanent folder
 *     (the item, then the one destination node). A folder dropped before/after a row of another folder is
 *     get + getChildren + the climb, and one more read per level when the destination is deeper. Chrome
 *     rejects a cycle itself and leaves the tree alone (Probe 13 P6), so this buys "the call is never made",
 *     not safety.
 *  6. `unmodifiable` (never observed, Probe 13 P5/P12) is honoured on the nodes already in hand: the item,
 *     the anchor row (a managed folder's rows carry it) and the create anchor. A read-only node is
 *     'failed' without a write. The destination folder is NOT read just to look for the flag: for an
 *     "inside" drop or a create with no anchor, Chrome's rejection is the backstop and comes back 'failed'.
 *  7. "Move to the end of the item's own folder" reads the children (it has to know whether the item is
 *     already last, which is a no-op); "to another folder, at the end" reads nothing but the item and
 *     omits `index`; "as the first child" needs no count either.
 *  8. `moveRelative` stays inside the parent (plan D7): up on the first child and down on the last are
 *     'noop' (the maths clamps them to the item's own place); it never crosses into a neighbouring folder.
 *  9. `queue` is one chain for the whole module. A task that throws or rejects does not stop the next
 *     one, and its own caller still receives the rejection.
 * 10. An unknown `place` or `direction` THROWS before any write (a write cannot be undone, so a typo must
 *     not become "append"); everything that can happen to the TREE is a result, never an exception.
 */

import { bookmarkMoveArg } from './bookmark-math.js';

/** The climb of the cycle check gives up after this many folders (a real tree is nowhere near this deep). */
const MAX_CLIMB = 256;

/**
 * @typedef {object} Host
 * @property {(method: string, ...args: any[]) => Promise<any>} bm the panel's one `chrome.bookmarks` call;
 *   resolves `null` when the call failed
 * @property {(line: string) => void} [log] optional, one line per refusal
 */

/**
 * @typedef {object} Result
 * @property {boolean} ok a write resolved
 * @property {{ id: string, parentId: string | undefined, index: number | undefined } | null} landed
 *   the node Chrome answered with; null unless `ok`
 * @property {'stale' | 'failed' | 'noop' | null} reason null when `ok`
 */

/**
 * A title as it is written: each CR, LF and tab becomes one space (Chrome does the same to a title it is
 * given, Probe 13 P9) and the ends are trimmed. An empty result means "write nothing".
 * @param {unknown} raw
 * @returns {string}
 */
export function normaliseTitle(raw) {
  return String(raw ?? '').replace(/[\r\n\t]/g, ' ').trim();
}

let tail = Promise.resolve();

/**
 * Run `task` after every task queued before it has settled, and never beside one. A task that throws or
 * rejects does not stop the ones behind it; its caller still gets the rejection.
 * @template T
 * @param {() => T | Promise<T>} task
 * @returns {Promise<T>}
 */
export function queue(task) {
  const run = tail.then(() => task());
  tail = run.then(() => undefined, () => undefined);
  return run;
}

/** Said once per refusal, with what it was decided on: ids and counts only. */
function refuse(host, op, reason, because) {
  if (typeof host.log === 'function') host.log(`${op} ${reason}: ${because}`);
  return { ok: false, landed: null, reason };
}

/** Where Chrome says the node it resolved with is now. */
function wrote(node) {
  return { ok: true, landed: { id: node.id, parentId: node.parentId, index: node.index }, reason: null };
}

/** `bm` answers `null` for a failed call; `undefined` is not an answer either. */
const isNull = (answer) => answer === null || answer === undefined;

/** A folder has no `url` key at all (measured, as in bookmarks.js `isFolder`). */
const isFolder = (node) => !('url' in node);

/**
 * `get` of one id: the node, or null when the call failed or answered with nothing.
 * @param {Host} host
 * @param {string} id
 */
async function readNode(host, id) {
  const got = await host.bm('get', id);
  return (Array.isArray(got) && got[0]) || null;
}

/**
 * Does climbing from the folder `fromId` run into the folder `id`? One fresh `get` per level.
 * `stopId` is the parent `id` lives in now: if the climb gets there first, `id` is not above `fromId`.
 * @returns {Promise<'clear' | 'inside' | 'unreadable'>}
 */
async function climb(host, id, fromId, stopId) {
  let current = fromId;
  for (let step = 0; step < MAX_CLIMB; step += 1) {
    if (current === id) return 'inside';
    if (current === stopId) return 'clear';
    const node = await readNode(host, current);
    if (!node) return 'unreadable';
    // The top: the root has no parent, and a permanent folder's parent is the root, which is nobody's item.
    if (node.parentId === undefined || node.folderType) return 'clear';
    current = node.parentId;
  }
  return 'unreadable';
}

/**
 * Make a folder named `title` in `parentId`: at the end, or right after `anchorId` (a row of that folder).
 * The host calls this when the edit row COMMITS and not before (plan D1), so nothing is written for an
 * Escape. Calls: `create`, or `get` of the anchor then `create` with `index: anchor.index + 1`.
 *
 * @param {Host} host
 * @param {{ parentId: string, title: string, anchorId?: string | null }} spec
 * @returns {Promise<Result>}
 */
export async function createFolder(host, { parentId, title, anchorId = null }) {
  const no = (reason, because) => refuse(host, 'createFolder', reason, because);
  const name = normaliseTitle(title);
  if (name === '') return no('noop', `the name is empty (in ${parentId})`);
  const args = { parentId, title: name };
  if (anchorId) {
    const anchor = await readNode(host, anchorId);
    if (!anchor) return no('stale', `anchor ${anchorId} cannot be read`);
    if (anchor.parentId !== parentId) {
      return no('stale', `anchor ${anchorId} is in ${anchor.parentId} now, not in ${parentId}`);
    }
    if (anchor.unmodifiable) {
      return no('failed', `${parentId} is read-only (anchor ${anchorId} is ${anchor.unmodifiable})`);
    }
    // A new folder is not in the list yet, so it takes the index of a move from another parent. The anchor
    // exists, so its parent has at least `anchor.index + 1` children: a count for which the clamp changes nothing.
    args.index = bookmarkMoveArg({
      sameParent: false, anchorIndex: anchor.index, place: 'after', count: anchor.index + 1,
    }).index;
  }
  const made = await host.bm('create', args);
  if (isNull(made)) return no('failed', `create in ${parentId} was rejected`);
  return wrote(made);
}

/**
 * Rename `id` to `title`. Calls: `update` only. Nothing is written for an empty name, or for one that is
 * `original` (the title the edit started from) once normalised.
 *
 * @param {Host} host
 * @param {{ id: string, title: string, original?: string }} spec
 * @returns {Promise<Result>}
 */
export async function renameNode(host, { id, title, original }) {
  const no = (reason, because) => refuse(host, 'renameNode', reason, because);
  const name = normaliseTitle(title);
  if (name === '') return no('noop', `the name is empty (${id})`);
  if (title === original || name === original) return no('noop', `the name of ${id} is unchanged`);
  const node = await host.bm('update', id, { title: name });
  if (isNull(node)) return no('failed', `update of ${id} was rejected`);
  return wrote(node);
}

/**
 * Put `id` where a drop or a menu choice says. `place`, `anchorId` and `parentId` are what
 * `resolveBookmarkDrop` returns (extra keys such as `valid` are ignored):
 *   'before' / 'after'  next to the row `anchorId` of `parentId`
 *   'start'             the first child of `parentId`
 *   'end'               the last child of `parentId` (also what "Move to..." means)
 * The item's parent, its index and the destination's children are all read when this runs, never taken from
 * the rendered rows. Calls: `get` item, [`get` ... a climb, for a folder going to another parent],
 * [`getChildren` destination: before / after, and 'end' inside the item's own folder], then `move` unless
 * `bookmarkMoveArg` says the drop changes nothing.
 *
 * @param {Host} host
 * @param {{ id: string, place: 'before' | 'after' | 'start' | 'end', anchorId?: string | null, parentId: string }} spec
 * @returns {Promise<Result>}
 */
export async function moveToPosition(host, { id, place, anchorId = null, parentId }) {
  const no = (reason, because) => refuse(host, 'moveToPosition', reason, because);
  const item = await readNode(host, id);
  if (!item) return no('failed', `${id} cannot be read`);
  if (item.unmodifiable) return no('failed', `${id} is read-only (${item.unmodifiable})`);
  const sameParent = item.parentId === parentId;

  if (!sameParent && isFolder(item)) {
    const where = await climb(host, id, parentId, item.parentId);
    if (where === 'inside') return no('stale', `${parentId} is ${id} or lies under it`);
    if (where !== 'clear') return no('failed', `the way up from ${parentId} cannot be read`);
  }

  let count;
  let anchorIndex;
  if (place === 'before' || place === 'after' || (place === 'end' && sameParent)) {
    const kids = await host.bm('getChildren', parentId);
    if (isNull(kids)) return no('failed', `the children of ${parentId} cannot be read`);
    count = kids.length;
    if (place !== 'end') {
      anchorIndex = kids.findIndex((kid) => kid.id === anchorId);
      if (anchorIndex < 0) {
        return no('stale', `anchor ${anchorId} is not among the ${count} children of ${parentId}`);
      }
      if (kids[anchorIndex].unmodifiable) {
        return no('failed', `${parentId} is read-only (anchor ${anchorId} is ${kids[anchorIndex].unmodifiable})`);
      }
    }
  }

  const arg = bookmarkMoveArg({ sameParent, s: item.index, anchorIndex, place, count });
  if (arg.skip) {
    return no('noop', `${place} of ${anchorId || parentId} leaves ${id} at ${item.index} in ${parentId}`);
  }
  const destination = { parentId };
  if ('index' in arg) destination.index = arg.index;
  const moved = await host.bm('move', id, destination);
  if (isNull(moved)) return no('failed', `move of ${id} to ${parentId} was rejected`);
  return wrote(moved);
}

/**
 * Move `id` one place up or down inside its own folder (Alt+Arrow, the menu's Move up / Move down). The
 * ends are 'noop' and it never leaves the folder. Calls: `get` item, `getChildren` of its folder, `move`.
 * The neighbour is asked for as a position ("before the one above", "after the one below") and the maths
 * decides: that is `index: s - 1` going up and `index: s + 2` going down, because Chrome reads the index
 * before the item is taken out (Probe 13 P1).
 *
 * @param {Host} host
 * @param {{ id: string, direction: 'up' | 'down' }} spec
 * @returns {Promise<Result>}
 */
export async function moveRelative(host, { id, direction }) {
  if (direction !== 'up' && direction !== 'down') {
    throw new RangeError(`moveRelative: unknown direction ${String(direction)}`);
  }
  const no = (reason, because) => refuse(host, 'moveRelative', reason, because);
  const item = await readNode(host, id);
  if (!item) return no('failed', `${id} cannot be read`);
  if (item.unmodifiable) return no('failed', `${id} is read-only (${item.unmodifiable})`);
  const kids = await host.bm('getChildren', item.parentId);
  if (isNull(kids)) return no('failed', `the children of ${item.parentId} cannot be read`);
  const arg = bookmarkMoveArg({
    sameParent: true,
    s: item.index,
    anchorIndex: direction === 'up' ? item.index - 1 : item.index + 1,
    place: direction === 'up' ? 'before' : 'after',
    count: kids.length,
  });
  if (arg.skip) {
    return no('noop', `${id} is already ${direction === 'up' ? 'first' : 'last'} of the ${kids.length} in ${item.parentId}`);
  }
  const moved = await host.bm('move', id, { parentId: item.parentId, index: arg.index });
  if (isNull(moved)) return no('failed', `move of ${id} ${direction} in ${item.parentId} was rejected`);
  return wrote(moved);
}
