// extension/sidepanel/bookmark-write.js — the write half of editing the bookmark column (PR2, unit U3).
// Criteria B2 U-d (the module against a fake `bm`) and U-e (the module is pure, calls only the five methods,
// and every call names its method as a literal).
//
// The fake `bm` below knows NOTHING about Chrome's `index` rule. It records the arguments of every call and
// answers READS from a tiny in-memory tree; what a WRITE does to that tree is whatever the test says, as the
// literal order from the probe tables (`answers`), so no expectation in this file is computed by a model of
// Chrome. What the tests assert is the ARGUMENTS the module hands to `bm`, the ORDER of the calls and how MANY
// there are, against the literal numbers of Probe 13 P1/P2 and Probe 17 PA (the same tables that
// tests/unit/bookmark-math.test.mjs carries). What Chrome then does with those arguments is asserted by the
// end-to-end specs of U5/U6, which run against a real Chrome.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EXT, loadSidepanel } from './_load.mjs';

const write = await loadSidepanel('bookmark-write.js');
const { createFolder, renameNode, moveToPosition, moveRelative, normaliseTitle, queue } = write;

/** What the panel may ask `chrome.bookmarks` (docs/store/permissions.md; tests/unit/bookmark-claims.test.mjs). */
const ALLOWED = ['getChildren', 'get', 'create', 'update', 'move'];
const WRITES = new Set(['create', 'update', 'move']);

const refused = (reason) => ({ ok: false, landed: null, reason });
const landedAt = (id, parentId, index) => ({ ok: true, landed: { id, parentId, index }, reason: null });
const settle = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
/**
 * Every wait on a queued task goes through this. The module has ONE queue, so a task that never finishes would hold
 * back every test after it, and a test that waits for it would hang instead of failing. Late is a failed assertion.
 */
function finishes(promise, ms = 3000) {
  let timer;
  const late = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new assert.AssertionError({ message: `did not finish within ${ms} ms: a queued task is stuck` })), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/* ── The fake ─────────────────────────────────────────────────────────────── */

/** Every fake made by the running test, so `afterEach` can look at every call it saw. */
const live = [];
const usedMethods = new Set();

/**
 * @param {Record<string, string | string[]>} layout folder id -> its children, in order (one letter per link; an id
 *   that is a key of `layout` is a folder)
 * @param {Array<null | { orders?: Record<string, string | string[]>, node?: object }>} [answers] one per WRITE, in
 *   order: `null` = the call is rejected (`bm` answers null); `orders` = the literal order each listed folder has
 *   AFTER the call (a probe-table cell); `node` = fields to overwrite on the node the call resolves with. A write
 *   with no answer left changes nothing and resolves with the node as it is.
 * @param {{ permanent?: string[] }} [options] ids that are permanent folders (they carry `folderType`, like '1')
 */
function fakeBookmarks(layout, answers = [], { permanent = [] } = {}) {
  const kids = new Map();
  const parentOf = new Map();
  const folders = new Set(Object.keys(layout));
  const flags = new Map();
  const titles = new Map();
  const calls = [];
  const logs = [];
  const rejects = new Set();
  const script = [...answers];

  const place = (folder, ids) => {
    kids.set(folder, [...ids]);
    for (const id of ids) parentOf.set(id, folder);
  };
  for (const [folder, ids] of Object.entries(layout)) place(folder, ids);
  for (const id of permanent) flags.set(id, { folderType: id === '1' ? 'bookmarks-bar' : 'other' });

  const exists = (id) => folders.has(id) || parentOf.has(id);
  const nodeOf = (id) => {
    const node = { id, title: titles.get(id) ?? id, dateAdded: 1 };
    if (parentOf.has(id)) {
      node.parentId = parentOf.get(id);
      node.index = kids.get(node.parentId).indexOf(id);
    }
    if (!folders.has(id)) node.url = `https://example.test/${id}`;
    return Object.assign(node, flags.get(id));
  };
  const detach = (id) => {
    const parent = parentOf.get(id);
    if (parent !== undefined) kids.set(parent, kids.get(parent).filter((other) => other !== id));
    parentOf.delete(id);
  };

  function writeCall(method, args) {
    const answer = script.shift();
    if (answer === null) return null;
    let id = args[0];
    if (method === 'create') {
      id = 'N';
      folders.add(id);
      kids.set(id, []);
      titles.set(id, args[0].title);
    }
    if (method === 'update') titles.set(id, args[1].title);
    for (const [folder, order] of Object.entries((answer && answer.orders) || {})) place(folder, order);
    return { ...nodeOf(id), ...((answer && answer.node) || {}) };
  }

  async function bm(method, ...args) {
    calls.push([method, ...structuredClone(args)]);
    usedMethods.add(method);
    if (fake.hold) await fake.hold(method, args);
    const key = typeof args[0] === 'string' ? `${method}:${args[0]}` : method;
    if (rejects.has(method) || rejects.has(key)) return null;
    switch (method) {
      case 'get': return exists(args[0]) ? [nodeOf(args[0])] : null;
      case 'getChildren': return kids.has(args[0]) ? kids.get(args[0]).map(nodeOf) : null;
      case 'create': case 'update': case 'move': return writeCall(method, args);
      default: return null; // anything else is not a method of this panel; the afterEach hook reports it
    }
  }

  const fake = {
    calls,
    logs,
    /** 'move' or 'get:B' or 'getChildren:F': the call answers null, as `bm` does for a rejected call. */
    rejects,
    /** async (method, args) => void: stops a call in the air until the test lets it go. */
    hold: null,
    bm,
    host: { bm, log: (line) => logs.push(line) },
    /** Somebody else deleted `id` (and with it what is under it). */
    vanish(id) { detach(id); folders.delete(id); kids.delete(id); },
    /** Somebody else moved `id` to the end of `folder`. */
    relocate(id, folder) { detach(id); kids.get(folder).push(id); parentOf.set(id, folder); },
    flag(id, extra) { flags.set(id, { ...flags.get(id), ...extra }); },
    reads: () => calls.filter(([method]) => !WRITES.has(method)),
    writes: () => calls.filter(([method]) => WRITES.has(method)),
    names: () => calls.map(([method]) => method),
  };
  live.push(fake);
  return fake;
}

const onlyKeys = (object, keys) => object !== null && typeof object === 'object' && Object.keys(object).every((key) => keys.includes(key));
const isIndex = (n) => Number.isInteger(n) && n >= 0;
/** What an argument list has to look like, for each method. A write that carries anything else is a bug. */
const SHAPE = {
  get: (a) => a.length === 1 && typeof a[0] === 'string',
  getChildren: (a) => a.length === 1 && typeof a[0] === 'string',
  create: (a) => a.length === 1 && onlyKeys(a[0], ['parentId', 'title', 'index']) && typeof a[0].parentId === 'string'
    && typeof a[0].title === 'string' && (!('index' in a[0]) || isIndex(a[0].index)),
  update: (a) => a.length === 2 && typeof a[0] === 'string' && onlyKeys(a[1], ['title']) && typeof a[1].title === 'string',
  move: (a) => a.length === 2 && typeof a[0] === 'string' && onlyKeys(a[1], ['parentId', 'index'])
    && typeof a[1].parentId === 'string' && (!('index' in a[1]) || isIndex(a[1].index)),
};

// The catch-all of criteria B2 U-d: whatever a test did, every method the fake saw is one of the five, each call is
// shaped as that method's arguments are (no `url` on a new folder, no stray key, an `index` that is a whole number
// from 0 up, never `undefined`), and nothing deletes, searches or reads the whole tree.
afterEach(() => {
  const bad = [];
  for (const fake of live.splice(0)) {
    for (const call of fake.calls) {
      const [method, ...args] = call;
      if (!ALLOWED.includes(method)) bad.push(`${method}: not one of ${ALLOWED.join(', ')}`);
      else if (!SHAPE[method](args)) bad.push(`${JSON.stringify(call)} is not shaped like a ${method} call`);
    }
  }
  assert.deepEqual(bad, [], 'the module asked bookmarks for something it must never ask');
});

/* ── U-e: the module is pure ──────────────────────────────────────────────── */

const SOURCE = path.join(EXT, 'sidepanel', 'bookmark-write.js');
const code = () => fs.readFileSync(SOURCE, 'utf8')
  // Comments are allowed to mention anything; code is not.
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('U-e purity: bookmark-write.js imports only bookmark-math.js and touches no document, window or chrome', () => {
  const src = code();
  const imports = src.match(/^\s*import\b[^;]*;/gm) || [];
  assert.equal(imports.length, 1, `exactly one import, found: ${imports.join(' | ')}`);
  assert.match(imports[0], /^\s*import\s*\{\s*bookmarkMoveArg\s*\}\s*from\s*'\.\/bookmark-math\.js'\s*;$/);
  assert.ok(!/\bimport\s*\(/.test(src), 'bookmark-write.js must not import() anything');
  assert.ok(!/\brequire\s*\(/.test(src), 'bookmark-write.js must not require() anything');
  for (const global of ['document', 'window', 'chrome', 'navigator', 'localStorage', 'sessionStorage', 'globalThis', 'self', 'fetch', 'XMLHttpRequest']) {
    assert.ok(!new RegExp(`\\b${global}\\b`).test(src), `bookmark-write.js must not touch ${global}`);
  }
});

test('U-e: every host.bm call names its method as a string literal, from the five allowed, and each of the five is used', () => {
  const src = code();
  const all = src.match(/\bbm\s*\(/g) || [];
  const literal = [...src.matchAll(/\bhost\.bm\(\s*'([A-Za-z]+)'\s*[,)]/g)].map((m) => m[1]);
  assert.equal(literal.length, all.length, `${all.length} calls of bm(, ${literal.length} of them \`host.bm('<name>', ...)\``);
  // And `bm` is not reached in any other way (host['bm'](...), an alias): every mention of the word is one of those calls.
  assert.equal((src.match(/\bbm\b/g) || []).length, literal.length, 'every mention of bm is a host.bm(\'<literal>\', ...) call');
  assert.deepEqual([...new Set(literal)].sort(), [...ALLOWED].sort(), 'the set of method names the module calls');
  assert.ok(!/\bremove(Tree)?\b|\bsearch\b|\bgetTree\b|\bgetSubTree\b|\bgetRecent\b/.test(src.replace(/`[^`]*`/g, '')), 'no delete, search or whole-tree read');
});

test('U-e: the module exports exactly the API the host relies on', () => {
  assert.deepEqual(Object.keys(write).sort(), ['createFolder', 'moveRelative', 'moveToPosition', 'normaliseTitle', 'queue', 'renameNode']);
  for (const name of Object.keys(write)) assert.equal(typeof write[name], 'function', name);
});

/* ── normaliseTitle ───────────────────────────────────────────────────────── */

test('U-d normaliseTitle: each CR, LF and tab becomes one space, the ends are trimmed, nothing else changes', () => {
  const rows = [
    ['Projects', 'Projects'],
    ['  Projects  ', 'Projects'],
    ['\tProjects\n', 'Projects'],
    ['a\nb', 'a b'],
    ['a\rb', 'a b'],
    ['a\tb', 'a b'],
    ['a\r\nb', 'a  b'], // one space each, as Chrome stores it (Probe 13 P9); runs are not collapsed
    ['a  b', 'a  b'],
    ['\n\nPlans\n\n', 'Plans'],
    ['a\n  b', 'a   b'],
    ['　予定　', '予定'], // a full-width space at the ends goes too
    ['x'.repeat(5000), 'x'.repeat(5000)], // nothing is truncated here (the input's maxlength is the UI's)
    ['', ''],
    ['   ', ''],
    ['\n\t\r', ''],
    [undefined, ''],
    [null, ''],
  ];
  for (const [raw, want] of rows) assert.equal(normaliseTitle(raw), want, JSON.stringify(raw));
  assert.equal(normaliseTitle(12), '12');
});

/* ── queue ────────────────────────────────────────────────────────────────── */

test('U-d queue: tasks run one at a time, in the order they were queued, whatever each one waits for', async () => {
  const log = [];
  const gate = deferred();
  const a = queue(async () => { log.push('a:start'); await gate.promise; log.push('a:end'); return 'A'; });
  const b = queue(async () => { log.push('b:start'); log.push('b:end'); return 'B'; });
  const c = queue(() => { log.push('c'); return 'C'; });
  try {
    await settle();
    assert.deepEqual(log, ['a:start'], 'b and c wait while a is still running');
  } finally {
    gate.resolve(); // whatever happened above, the one queue must not be left holding a task nobody will release
  }
  assert.deepEqual(await finishes(Promise.all([a, b, c])), ['A', 'B', 'C'], 'every caller gets its own task\'s result');
  assert.deepEqual(log, ['a:start', 'a:end', 'b:start', 'b:end', 'c']);
});

test('U-d queue: a task that throws or rejects does not stop the ones behind it, and its caller still hears about it', async () => {
  const bad = queue(() => { throw new Error('boom'); });
  const worse = queue(async () => { throw new Error('async boom'); });
  const fine = queue(() => 'still runs');
  const [first, second, third] = await finishes(Promise.allSettled([bad, worse, fine]));
  assert.equal(first.status, 'rejected');
  assert.match(first.reason.message, /^boom$/);
  assert.equal(second.status, 'rejected');
  assert.match(second.reason.message, /^async boom$/);
  assert.deepEqual(third, { status: 'fulfilled', value: 'still runs' });
  assert.equal(await finishes(queue(() => 'and the queue is still usable')), 'and the queue is still usable');
});

test('U-d queue: a rejection nobody waits for is not an unhandled rejection that takes the panel down', async () => {
  const seen = [];
  const onUnhandled = (reason) => seen.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    queue(() => { throw new Error('nobody is listening'); });
    await finishes(queue(() => 'next'));
    await settle();
    await settle();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(seen, []);
});

/* ── createFolder ─────────────────────────────────────────────────────────── */

// Probe 17 PA, `create` of a folder N in a folder holding m links: the order after, for each `index` k = 0 .. m + 1
// and for an omitted index. 'rejects' = Index out of bounds. Copied from tests/unit/bookmark-math.test.mjs.
const PA_CREATE = [
  { m: 0, list: '', ks: [0, 1, 'omitted'], after: ['N', 'rejects', 'N'] },
  { m: 1, list: 'A', ks: [0, 1, 2, 'omitted'], after: ['NA', 'AN', 'rejects', 'AN'] },
  { m: 2, list: 'AB', ks: [0, 1, 2, 3, 'omitted'], after: ['NAB', 'ANB', 'ABN', 'rejects', 'ABN'] },
  { m: 5, list: 'ABCDE', ks: [0, 1, 2, 3, 4, 5, 6, 'omitted'], after: ['NABCDE', 'ANBCDE', 'ABNCDE', 'ABCNDE', 'ABCDNE', 'ABCDEN', 'rejects', 'ABCDEN'] },
];

for (const t of PA_CREATE) {
  test(`U-d createFolder, Probe 17 PA, folder of ${t.m} children${t.m === 0 ? ' (EMPTY)' : ''}: "at the end" omits the index, "after row r" asks for r.index + 1`, async () => {
    // At the end of the folder: one call, no read, no index key (the 'omitted' column).
    const end = fakeBookmarks({ F: t.list }, [{ orders: { F: t.after[t.ks.indexOf('omitted')] } }]);
    const made = await createFolder(end.host, { parentId: 'F', title: 'Projects' });
    assert.deepEqual(end.calls, [['create', { parentId: 'F', title: 'Projects' }]], 'at the end');
    assert.deepEqual(made, landedAt('N', 'F', t.m), 'at the end');

    // After each row a: the column k = a + 1, and the table's order shows the new folder right behind that row.
    for (let a = 0; a < t.m; a += 1) {
      const k = a + 1;
      const cell = t.after[t.ks.indexOf(k)];
      assert.ok(cell.includes(`${t.list[a]}N`), `the table says N follows ${t.list[a]} in ${cell}`);
      const fake = fakeBookmarks({ F: t.list }, [{ orders: { F: cell } }]);
      const r = await createFolder(fake.host, { parentId: 'F', title: 'Projects', anchorId: t.list[a] });
      assert.deepEqual(fake.calls, [['get', t.list[a]], ['create', { parentId: 'F', title: 'Projects', index: k }]], `after ${t.list[a]}`);
      assert.deepEqual(r, landedAt('N', 'F', k), `after ${t.list[a]}`);
    }
  });
}

test('U-d createFolder: the name is normalised before it is written, and the new folder carries no url', async () => {
  const fake = fakeBookmarks({ F: 'AB' }, [{ orders: { F: 'ABN' } }]);
  const r = await createFolder(fake.host, { parentId: 'F', title: '  My\tprojects\n ' });
  assert.deepEqual(fake.calls, [['create', { parentId: 'F', title: 'My projects' }]]);
  assert.equal(r.ok, true);
});

test('U-d createFolder: an empty name writes nothing and reads nothing, with or without an anchor', async () => {
  for (const title of ['', '   ', '\n', '\t \r\n', undefined]) {
    for (const anchorId of [null, undefined, 'A']) {
      const fake = fakeBookmarks({ F: 'AB' });
      const r = await createFolder(fake.host, { parentId: 'F', title, anchorId });
      assert.deepEqual(r, refused('noop'), `${JSON.stringify(title)} anchored at ${anchorId}`);
      assert.deepEqual(fake.calls, [], `${JSON.stringify(title)} anchored at ${anchorId}`);
    }
  }
});

test('U-d createFolder: an anchor that is gone, or is in another folder now, is stale and nothing is created', async () => {
  const gone = fakeBookmarks({ F: 'ABC' });
  gone.vanish('B');
  assert.deepEqual(await createFolder(gone.host, { parentId: 'F', title: 'P', anchorId: 'B' }), refused('stale'));
  assert.deepEqual(gone.calls, [['get', 'B']]);

  const moved = fakeBookmarks({ F: 'ABC', G: 'XY' });
  moved.relocate('B', 'G');
  assert.deepEqual(await createFolder(moved.host, { parentId: 'F', title: 'P', anchorId: 'B' }), refused('stale'));
  assert.deepEqual(moved.calls, [['get', 'B']], 'the parent changed: one read, no write');

  const unreadable = fakeBookmarks({ F: 'ABC' });
  unreadable.rejects.add('get');
  assert.deepEqual(await createFolder(unreadable.host, { parentId: 'F', title: 'P', anchorId: 'B' }), refused('stale'));
  assert.deepEqual(unreadable.calls, [['get', 'B']]);
});

test('U-d createFolder: a rejected create is a failure, anchored or not', async () => {
  const plain = fakeBookmarks({ F: 'AB' }, [null]);
  assert.deepEqual(await createFolder(plain.host, { parentId: 'F', title: 'P' }), refused('failed'));
  assert.deepEqual(plain.calls, [['create', { parentId: 'F', title: 'P' }]]);

  const anchored = fakeBookmarks({ F: 'AB' }, [null]);
  assert.deepEqual(await createFolder(anchored.host, { parentId: 'F', title: 'P', anchorId: 'A' }), refused('failed'));
  assert.deepEqual(anchored.calls, [['get', 'A'], ['create', { parentId: 'F', title: 'P', index: 1 }]]);
});

test('U-d createFolder: a row that carries `unmodifiable` is read-only: failed, and nothing is created', async () => {
  const fake = fakeBookmarks({ F: 'AB' });
  fake.flag('A', { unmodifiable: 'managed' });
  assert.deepEqual(await createFolder(fake.host, { parentId: 'F', title: 'P', anchorId: 'A' }), refused('failed'));
  assert.deepEqual(fake.calls, [['get', 'A']]);
});

test('U-d createFolder: a permanent folder is a parent like any other (Probe 17 PB); the module does not special-case it', async () => {
  const fake = fakeBookmarks({ 1: 'AB' }, [{ orders: { 1: 'ABN' } }], { permanent: ['1'] });
  const r = await createFolder(fake.host, { parentId: '1', title: 'Reading list' });
  assert.deepEqual(fake.calls, [['create', { parentId: '1', title: 'Reading list' }]]);
  assert.deepEqual(r, landedAt('N', '1', 2));
});

/* ── renameNode ───────────────────────────────────────────────────────────── */

test('U-d renameNode: one update with the normalised title, and the answer is what Chrome resolved with', async () => {
  const fake = fakeBookmarks({ F: 'ABC' });
  const r = await renameNode(fake.host, { id: 'B', title: '  Be\tta\n', original: 'B' });
  assert.deepEqual(fake.calls, [['update', 'B', { title: 'Be ta' }]]);
  assert.deepEqual(r, landedAt('B', 'F', 1));
  assert.equal(fake.logs.length, 0, 'a success says nothing');
});

test('U-d renameNode: an empty or unchanged name writes nothing and reads nothing (criteria B4.6)', async () => {
  const rows = [
    ['', 'B'], ['   ', 'B'], ['\n', 'B'], ['\t\r\n ', 'B'],   // empty after normalising
    ['B', 'B'], [' B ', 'B'], ['B\n', 'B'], ['\tB', 'B'],     // the original once normalised
    [' B ', ' B '], ['B ', 'B '],                              // the raw text is the original: an untouched edit is not trimmed behind the user's back
  ];
  for (const [title, original] of rows) {
    const fake = fakeBookmarks({ F: 'ABC' });
    assert.deepEqual(await renameNode(fake.host, { id: 'B', title, original }), refused('noop'), JSON.stringify([title, original]));
    assert.deepEqual(fake.calls, [], JSON.stringify([title, original]));
  }
});

test('U-d renameNode: a changed name is written, even when it only differs by what was trimmed from the original', async () => {
  const fake = fakeBookmarks({ F: 'ABC' });
  const r = await renameNode(fake.host, { id: 'B', title: 'B', original: ' B ' });
  assert.deepEqual(fake.calls, [['update', 'B', { title: 'B' }]]);
  assert.equal(r.ok, true);
  const again = fakeBookmarks({ F: 'ABC' });
  await renameNode(again.host, { id: 'B', title: 'Beta', original: 'B' });
  assert.deepEqual(again.calls, [['update', 'B', { title: 'Beta' }]]);
  const without = fakeBookmarks({ F: 'ABC' });
  await renameNode(without.host, { id: 'B', title: 'Beta' });
  assert.deepEqual(without.calls, [['update', 'B', { title: 'Beta' }]], 'no original: nothing to compare with');
});

test('U-d renameNode: a node that is gone (update rejected) is a failure', async () => {
  const fake = fakeBookmarks({ F: 'ABC' }, [null]);
  assert.deepEqual(await renameNode(fake.host, { id: 'B', title: 'Beta', original: 'B' }), refused('failed'));
  assert.deepEqual(fake.calls, [['update', 'B', { title: 'Beta' }]]);
});

/* ── moveToPosition: the same parent, Probe 13 P1 ─────────────────────────── */

// Probe 13 P1 (n = 4, `ABCD`): the order AFTER the call, for the columns that resolve: k = 0 1 2 3 4 and omitted.
// Row s = the child that is moved. Copied from tests/unit/bookmark-math.test.mjs (P1 rows, minus the rejecting k = 9).
const P1_KS = [0, 1, 2, 3, 4, 'omitted'];
const P1_ORDERS = [
  ['ABCD', 'ABCD', 'BACD', 'BCAD', 'BCDA', 'BCDA'], // s = 0 (A)
  ['BACD', 'ABCD', 'ABCD', 'ACBD', 'ACDB', 'ACDB'], // s = 1 (B)
  ['CABD', 'ACBD', 'ABCD', 'ABCD', 'ABDC', 'ABDC'], // s = 2 (C)
  ['DABC', 'ADBC', 'ABDC', 'ABCD', 'ABCD', 'ABCD'], // s = 3 (D)
];
// The same cells as the CALL the UI has to make ('skip' = no call, else the `index` argument), written by reading the
// table above: an order that does not change is a skip, otherwise the index is the k that was passed and an omitted
// index is the end, 4 (copied from tests/unit/bookmark-math.test.mjs P1_CALLS).
const P1_CALLS = [
  ['skip', 'skip', 2, 3, 4, 4], // s = 0
  [0, 'skip', 'skip', 3, 4, 4], // s = 1
  [0, 1, 'skip', 'skip', 4, 4], // s = 2
  [0, 1, 2, 'skip', 'skip', 'skip'], // s = 3
];

/** Every way the UI can say the position the probes called `k`, for a destination with `count` children. */
function spellings(k, count) {
  if (k === 'omitted') return [{ place: 'end' }];
  const out = [];
  if (k < count) out.push({ place: 'before', at: k });
  if (k >= 1) out.push({ place: 'after', at: k - 1 });
  if (k === 0) out.push({ place: 'start' });
  if (k === count) out.push({ place: 'end' });
  return out;
}

test('the P1 call table agrees with the P1 order table: a call is skipped exactly where the order does not change', () => {
  P1_CALLS.forEach((row, s) => row.forEach((want, col) => {
    assert.equal(want === 'skip', P1_ORDERS[s][col] === 'ABCD', `s=${s} k=${P1_KS[col]}`);
    if (want !== 'skip') assert.equal(want, P1_KS[col] === 'omitted' ? 4 : P1_KS[col], `s=${s} k=${P1_KS[col]}`);
  }));
});

test('U-d moveToPosition, same parent, Probe 13 P1: every cell, every spelling: the move call, or no call at all', async () => {
  let spelled = 0;
  for (let s = 0; s < 4; s += 1) {
    for (let col = 0; col < P1_KS.length; col += 1) {
      for (const sp of spellings(P1_KS[col], 4)) {
        spelled += 1;
        const id = 'ABCD'[s];
        const fake = fakeBookmarks({ F: 'ABCD' });
        const r = await moveToPosition(fake.host, { id, parentId: 'F', place: sp.place, anchorId: sp.at === undefined ? null : 'ABCD'[sp.at] });
        const tag = `s=${s} k=${P1_KS[col]} ${JSON.stringify(sp)}`;
        const want = P1_CALLS[s][col];
        // 'start' needs no count, so it reads the item only; the others read the item and then the folder.
        assert.deepEqual(fake.reads(), sp.place === 'start' ? [['get', id]] : [['get', id], ['getChildren', 'F']], `${tag}: reads`);
        if (want === 'skip') {
          assert.deepEqual(r, refused('noop'), tag);
          assert.deepEqual(fake.writes(), [], `${tag}: a no-op writes nothing`);
        } else {
          assert.equal(r.ok, true, tag);
          assert.deepEqual(fake.writes(), [['move', id, { parentId: 'F', index: want }]], tag);
          assert.equal(fake.calls[fake.calls.length - 1][0], 'move', `${tag}: the move comes after the reads`);
        }
      }
    }
  }
  assert.ok(spelled >= 24, `all 24 resolved cells are spelled (${spelled} spellings)`);
});

test('U-d moveToPosition: "A after C" in ABCD asks for index 3 (BCAD), "A before C" for index 2 (BACD), and the answer is Chrome\'s', async () => {
  const after = fakeBookmarks({ F: 'ABCD' }, [{ orders: { F: 'BCAD' } }]); // Probe 13 P1, s = 0, k = 3
  const r = await moveToPosition(after.host, { id: 'A', place: 'after', anchorId: 'C', parentId: 'F' });
  assert.deepEqual(after.calls, [['get', 'A'], ['getChildren', 'F'], ['move', 'A', { parentId: 'F', index: 3 }]]);
  assert.deepEqual(r, landedAt('A', 'F', 2), 'the node Chrome resolved with: A now sits at index 2 of BCAD');

  const before = fakeBookmarks({ F: 'ABCD' }, [{ orders: { F: 'BACD' } }]); // s = 0, k = 2
  const b = await moveToPosition(before.host, { id: 'A', place: 'before', anchorId: 'C', parentId: 'F' });
  assert.deepEqual(before.calls, [['get', 'A'], ['getChildren', 'F'], ['move', 'A', { parentId: 'F', index: 2 }]]);
  assert.deepEqual(b, landedAt('A', 'F', 1));

  const last = fakeBookmarks({ F: 'ABCD' }, [{ orders: { F: 'BCDA' } }]); // s = 0, k = 4: after the last row
  assert.equal((await moveToPosition(last.host, { id: 'A', place: 'after', anchorId: 'D', parentId: 'F' })).ok, true);
  assert.deepEqual(last.writes(), [['move', 'A', { parentId: 'F', index: 4 }]]);

  const front = fakeBookmarks({ F: 'ABCD' }, [{ orders: { F: 'DABC' } }]); // s = 3, k = 0
  assert.equal((await moveToPosition(front.host, { id: 'D', place: 'before', anchorId: 'A', parentId: 'F' })).ok, true);
  assert.deepEqual(front.writes(), [['move', 'D', { parentId: 'F', index: 0 }]]);
});

test('U-d moveToPosition: `landed` is what the resolved node says, not what the maths expected', async () => {
  // The maths says A lands at 2; the node Chrome answers with says 7 (something else happened meanwhile). The host paints and focuses by it.
  const fake = fakeBookmarks({ F: 'ABCD' }, [{ orders: { F: 'BCAD' }, node: { index: 7 } }]);
  const r = await moveToPosition(fake.host, { id: 'A', place: 'after', anchorId: 'C', parentId: 'F' });
  assert.deepEqual(r, landedAt('A', 'F', 7));
});

test('U-d moveToPosition: the two no-op positions make no move call, are noop and say nothing to the user, their neighbours move', async () => {
  // ABCD, B (s = 1): before B, before C, after A, after B all leave the order alone (Probe 13 P1: s = 1, k = 1 and k = 2 are ABCD).
  for (const [place, anchorId] of [['before', 'B'], ['before', 'C'], ['after', 'A'], ['after', 'B']]) {
    const fake = fakeBookmarks({ F: 'ABCD' });
    assert.deepEqual(await moveToPosition(fake.host, { id: 'B', place, anchorId, parentId: 'F' }), refused('noop'), `${place} ${anchorId}`);
    assert.deepEqual(fake.calls, [['get', 'B'], ['getChildren', 'F']], `${place} ${anchorId}: reads only`);
  }
  for (const [place, anchorId, index] of [['before', 'A', 0], ['before', 'D', 3], ['after', 'C', 3], ['after', 'D', 4]]) {
    const fake = fakeBookmarks({ F: 'ABCD' });
    assert.equal((await moveToPosition(fake.host, { id: 'B', place, anchorId, parentId: 'F' })).ok, true, `${place} ${anchorId}`);
    assert.deepEqual(fake.writes(), [['move', 'B', { parentId: 'F', index }]], `${place} ${anchorId}`);
  }
});

test('U-d moveToPosition: "first child" and "last child" of the item\'s own folder: where the item already is, nothing is called', async () => {
  const first = fakeBookmarks({ F: 'ABCD' });
  assert.deepEqual(await moveToPosition(first.host, { id: 'A', place: 'start', parentId: 'F' }), refused('noop'));
  assert.deepEqual(first.calls, [['get', 'A']], 'the first child needs no count');
  const last = fakeBookmarks({ F: 'ABCD' });
  assert.deepEqual(await moveToPosition(last.host, { id: 'D', place: 'end', parentId: 'F' }), refused('noop'));
  assert.deepEqual(last.calls, [['get', 'D'], ['getChildren', 'F']], 'it has to read the folder to know D is the last');

  const toFront = fakeBookmarks({ F: 'ABCD' }, [{ orders: { F: 'CABD' } }]); // Probe 13 P1, s = 2, k = 0
  assert.equal((await moveToPosition(toFront.host, { id: 'C', place: 'start', parentId: 'F' })).ok, true);
  assert.deepEqual(toFront.calls, [['get', 'C'], ['move', 'C', { parentId: 'F', index: 0 }]]);
  const toBack = fakeBookmarks({ F: 'ABCD' }, [{ orders: { F: 'ACDB' } }]); // s = 1, k = 4
  assert.equal((await moveToPosition(toBack.host, { id: 'B', place: 'end', parentId: 'F' })).ok, true);
  assert.deepEqual(toBack.calls, [['get', 'B'], ['getChildren', 'F'], ['move', 'B', { parentId: 'F', index: 4 }]]);
});

/* ── moveToPosition: another parent, Probe 13 P2 and Probe 17 PA ──────────── */

// Probe 13 P2 and Probe 17 PA, other parent: M (a link, or a folder holding three links) moved out of F = `pMq` into G
// holding m links. The order of G after the call, for the `index` k and for an omitted one. Copied from the math tests.
const CROSS = [
  { label: 'Probe 13 P2, 3 children', g: 'XYZ', ks: [0, 1, 2, 3, 4, 9, 'omitted'], leaf: ['MXYZ', 'XMYZ', 'XYMZ', 'XYZM', 'rejects', 'rejects', 'XYZM'] },
  { label: 'Probe 17 PA, EMPTY destination', g: '', ks: [0, 1, 'omitted'], leaf: ['M', 'rejects', 'M'] },
  { label: 'Probe 17 PA, 1 child', g: 'X', ks: [0, 1, 2, 'omitted'], leaf: ['MX', 'XM', 'rejects', 'XM'] },
  { label: 'Probe 17 PA, 2 children', g: 'XY', ks: [0, 1, 2, 3, 'omitted'], leaf: ['MXY', 'XMY', 'XYM', 'rejects', 'XYM'] },
  { label: 'Probe 17 PA, 5 children', g: 'XYZUV', ks: [0, 1, 2, 3, 4, 5, 6, 'omitted'], leaf: ['MXYZUV', 'XMYZUV', 'XYMZUV', 'XYZMUV', 'XYZUMV', 'XYZUVM', 'rejects', 'XYZUVM'] },
];

for (const t of CROSS) {
  test(`U-d moveToPosition, other parent, ${t.label}: link and folder, every cell, every spelling`, async () => {
    let spelled = 0;
    for (const kind of ['link', 'folder']) {
      for (let col = 0; col < t.ks.length; col += 1) {
        const k = t.ks[col];
        if (t.leaf[col] === 'rejects') continue; // Chrome would reject it; no anchor can ask for it (a missing anchor is stale)
        for (const sp of spellings(k, t.g.length)) {
          spelled += 1;
          // M is moved out of F = `pMq` into G; a folder M holds three links `abc`. Both F and G sit in the bar '1'.
          const layout = { 1: 'FG', F: 'pMq', G: t.g, ...(kind === 'folder' ? { M: 'abc' } : {}) };
          const fake = fakeBookmarks(layout, [{ orders: { F: 'pq', G: t.leaf[col] } }], { permanent: ['1'] });
          const r = await moveToPosition(fake.host, { id: 'M', parentId: 'G', place: sp.place, anchorId: sp.at === undefined ? null : t.g[sp.at] });
          const tag = `${kind} k=${k} ${JSON.stringify(sp)}`;
          assert.deepEqual(fake.writes(), [['move', 'M', sp.place === 'end' ? { parentId: 'G' } : { parentId: 'G', index: k }]], tag);
          assert.deepEqual(r, landedAt('M', 'G', t.leaf[col].indexOf('M')), `${tag}: lands where the table's order has M`);
          // A link: the item, then the folder when there is an anchor. A folder: the item, the climb (G, then the bar), then the folder.
          const wantReads = [
            ...(kind === 'folder' ? ['get', 'get', 'get'] : ['get']),
            ...(sp.place === 'before' || sp.place === 'after' ? ['getChildren'] : []),
          ];
          assert.deepEqual(fake.reads().map(([method]) => method), wantReads, `${tag}: reads`);
        }
      }
    }
    assert.ok(spelled >= 2 * (t.ks.length - 1), 'every resolving cell is spelled at least once');
  });
}

test('U-d moveToPosition: "inside another folder, at the end" has no index key and no folder read, even into an EMPTY folder (criteria B6.1)', async () => {
  const full = fakeBookmarks({ F: 'pMq', G: 'XYZ' }, [{ orders: { F: 'pq', G: 'XYZM' } }]);
  const r = await moveToPosition(full.host, { id: 'M', place: 'end', parentId: 'G' });
  assert.deepEqual(full.calls, [['get', 'M'], ['move', 'M', { parentId: 'G' }]]);
  assert.ok(!('index' in full.calls[1][2]), 'omitted, so a child added meanwhile cannot make it stale');
  assert.deepEqual(r, landedAt('M', 'G', 3));

  const empty = fakeBookmarks({ F: 'pMq', E: '' }, [{ orders: { F: 'pq', E: 'M' } }]);
  assert.equal((await moveToPosition(empty.host, { id: 'M', place: 'end', parentId: 'E' })).ok, true);
  assert.deepEqual(empty.calls, [['get', 'M'], ['move', 'M', { parentId: 'E' }]]);

  const first = fakeBookmarks({ F: 'pMq', E: '' }, [{ orders: { F: 'pq', E: 'M' } }]);
  assert.equal((await moveToPosition(first.host, { id: 'M', place: 'start', parentId: 'E' })).ok, true);
  assert.deepEqual(first.calls, [['get', 'M'], ['move', 'M', { parentId: 'E', index: 0 }]], 'an empty folder takes index 0 (Probe 17 PA)');
});

test('U-d moveToPosition: a link needs two reads at most; a folder moved inside a sibling needs two; into a deeper one, one more per level', async () => {
  const link = fakeBookmarks({ 1: 'FG', F: 'pMq', G: 'XYZ' }, [], { permanent: ['1'] });
  await moveToPosition(link.host, { id: 'M', place: 'before', anchorId: 'Y', parentId: 'G' });
  assert.deepEqual(link.reads(), [['get', 'M'], ['getChildren', 'G']]);

  // M is a folder now. Its parent F and G are both under the bar '1'. The climb from G stops at the bar (a permanent folder).
  const sibling = fakeBookmarks({ 1: 'FG', F: 'pMq', G: 'XYZ', M: 'abc' }, [{ orders: { F: 'pq', G: 'XYZM' } }], { permanent: ['1'] });
  await moveToPosition(sibling.host, { id: 'M', place: 'end', parentId: 'G' });
  assert.deepEqual(sibling.calls, [['get', 'M'], ['get', 'G'], ['get', '1'], ['move', 'M', { parentId: 'G' }]]);

  // M sits directly in the bar, G is a sibling folder: the climb meets M's own parent after one step.
  const directly = fakeBookmarks({ 1: 'MG', G: 'XYZ', M: 'abc' }, [{ orders: { 1: 'G', G: 'XYZM' } }], { permanent: ['1'] });
  await moveToPosition(directly.host, { id: 'M', place: 'end', parentId: 'G' });
  assert.deepEqual(directly.calls, [['get', 'M'], ['get', 'G'], ['move', 'M', { parentId: 'G' }]], 'two reads, as for a link');

  const deeper = fakeBookmarks({ 1: 'MG', G: 'H', H: 'XY', M: 'abc' }, [{ orders: { 1: 'G', H: 'XYM' } }], { permanent: ['1'] });
  await moveToPosition(deeper.host, { id: 'M', place: 'end', parentId: 'H' });
  assert.deepEqual(deeper.calls, [['get', 'M'], ['get', 'H'], ['get', 'G'], ['move', 'M', { parentId: 'H' }]], 'one more per level between the destination and M\'s parent');

  const sameFolder = fakeBookmarks({ 1: 'FG', F: 'pMq', G: 'XYZ', M: 'abc' }, [{ orders: { F: 'pqM' } }], { permanent: ['1'] });
  await moveToPosition(sameFolder.host, { id: 'M', place: 'end', parentId: 'F' });
  assert.deepEqual(sameFolder.calls, [['get', 'M'], ['getChildren', 'F'], ['move', 'M', { parentId: 'F', index: 3 }]], 'inside one folder there is no climb');
});

test('U-d moveToPosition: across the two permanent folders a folder needs one read per level up to the permanent folder, and none for the root above it (criteria B6.5)', async () => {
  // '0' is the root, '1' the bar, '2' "Other bookmarks". M (a folder) sits in F under the bar.
  const layout = { 0: '12', 1: 'F', 2: 'G', F: 'M', G: '', M: 'ab' };
  const into = fakeBookmarks(layout, [{ orders: { F: '', G: 'M' } }], { permanent: ['1', '2'] });
  assert.equal((await moveToPosition(into.host, { id: 'M', place: 'end', parentId: 'G' })).ok, true);
  assert.deepEqual(into.calls, [['get', 'M'], ['get', 'G'], ['get', '2'], ['move', 'M', { parentId: 'G' }]], 'G, then "Other bookmarks", which says what it is: the climb stops there');

  const row = fakeBookmarks(layout, [{ orders: { F: '', 2: 'GM' } }], { permanent: ['1', '2'] });
  assert.equal((await moveToPosition(row.host, { id: 'M', place: 'end', parentId: '2' })).ok, true);
  assert.deepEqual(row.calls, [['get', 'M'], ['get', '2'], ['move', 'M', { parentId: '2' }]], 'dropped on the permanent folder itself');
});

test('U-d moveToPosition: an answer that is not what Chrome answers with is read as a failure, never as a node or an exception', async () => {
  const node = { id: 'A', parentId: 'F', index: 0, title: 'A', url: 'https://example.test/A' };
  // An exception would be a different failure from a wrong answer: show it as the answer, so the assertion says what happened.
  const outcome = (promise) => promise.catch((err) => ({ threw: String(err && err.message) }));
  // `get` resolves with an ARRAY of nodes; a bare node, an empty array or a hole in it is not an item that can be moved.
  for (const answer of [node, [], [undefined], [null], 'A', 0, true]) {
    const calls = [];
    const host = { bm: async (method, ...args) => { calls.push([method, ...args]); return method === 'get' ? answer : null; } };
    assert.deepEqual(await outcome(moveToPosition(host, { id: 'A', place: 'end', parentId: 'G' })), refused('failed'), JSON.stringify(answer));
    assert.deepEqual(calls, [['get', 'A']], JSON.stringify(answer));
  }
  // `undefined` is not an answer either: a write (or a read of the children) that resolves with nothing has failed.
  const hollow = { bm: async (method) => (method === 'get' ? [node] : undefined) };
  assert.deepEqual(await outcome(renameNode(hollow, { id: 'A', title: 'Beta', original: 'A' })), refused('failed'));
  assert.deepEqual(await outcome(createFolder(hollow, { parentId: 'F', title: 'P' })), refused('failed'));
  assert.deepEqual(await outcome(moveToPosition(hollow, { id: 'A', place: 'end', parentId: 'G' })), refused('failed'));
  assert.deepEqual(await outcome(moveToPosition(hollow, { id: 'A', place: 'after', anchorId: 'B', parentId: 'F' })), refused('failed'));
  assert.deepEqual(await outcome(moveRelative(hollow, { id: 'A', direction: 'down' })), refused('failed'));
});

/* ── moveToPosition: cycles, stale, failure, read-only ────────────────────── */

// F holds C holds H holds the link L; S is a sibling of F and holds T; all under the bar '1'.
const NEST = { 1: 'FS', F: 'C', C: 'H', H: 'L', S: 'T', T: '' };

test('U-d moveToPosition: a folder into itself or anywhere under itself never reaches move (checked again from fresh reads)', async () => {
  const cases = [
    ['into itself', { id: 'F', place: 'end', parentId: 'F' }, [['get', 'F']]],
    ['into its child', { id: 'F', place: 'end', parentId: 'C' }, [['get', 'F'], ['get', 'C']]],
    ['into its grandchild', { id: 'F', place: 'end', parentId: 'H' }, [['get', 'F'], ['get', 'H'], ['get', 'C']]],
    ['before a row of its grandchild', { id: 'F', place: 'before', anchorId: 'L', parentId: 'H' }, [['get', 'F'], ['get', 'H'], ['get', 'C']]],
    ['as the first child of its grandchild', { id: 'F', place: 'start', parentId: 'H' }, [['get', 'F'], ['get', 'H'], ['get', 'C']]],
    ['a child into its own child', { id: 'C', place: 'end', parentId: 'H' }, [['get', 'C'], ['get', 'H']]],
  ];
  for (const [label, spec, calls] of cases) {
    const fake = fakeBookmarks(NEST, [], { permanent: ['1'] });
    assert.deepEqual(await moveToPosition(fake.host, spec), refused('stale'), label);
    assert.deepEqual(fake.calls, calls, `${label}: reads only, and no write`);
  }
});

test('U-d moveToPosition: the cycle check follows the tree as it is NOW, not as the drag began (a destination that moved under the item)', async () => {
  // At dragstart S was beside F. Now somebody has put S inside F's child C. Dropping F into S is a cycle that no earlier read knew of.
  const fake = fakeBookmarks(NEST, [], { permanent: ['1'] });
  fake.relocate('S', 'C');
  assert.deepEqual(await moveToPosition(fake.host, { id: 'F', place: 'end', parentId: 'S' }), refused('stale'));
  assert.deepEqual(fake.writes(), []);
  // And the other way round: a destination that was moved OUT of the item's subtree is fine, although the drag began with it inside.
  const left = fakeBookmarks({ ...NEST, C: 'HT', T: '', S: '' }, [{ orders: { 1: 'S', T: 'F' } }], { permanent: ['1'] });
  left.relocate('T', '1');
  assert.equal((await moveToPosition(left.host, { id: 'F', place: 'end', parentId: 'T' })).ok, true);
  assert.deepEqual(left.writes(), [['move', 'F', { parentId: 'T' }]]);
});

test('U-d moveToPosition: a folder into a folder that is NOT under it is moved; reads: the item, then one per level up to its own parent', async () => {
  const fake = fakeBookmarks(NEST, [{ orders: { 1: 'S', S: 'T', T: 'F' } }], { permanent: ['1'] });
  const r = await moveToPosition(fake.host, { id: 'F', place: 'end', parentId: 'T' });
  assert.deepEqual(fake.calls, [['get', 'F'], ['get', 'T'], ['get', 'S'], ['move', 'F', { parentId: 'T' }]]);
  assert.equal(r.ok, true);
});

test('U-d moveToPosition: a link needs no cycle check, and a folder reordered inside its own folder neither', async () => {
  const link = fakeBookmarks(NEST, [{ orders: { H: '', S: 'TL' } }], { permanent: ['1'] });
  await moveToPosition(link.host, { id: 'L', place: 'end', parentId: 'S' });
  assert.deepEqual(link.calls, [['get', 'L'], ['move', 'L', { parentId: 'S' }]]);
  const inside = fakeBookmarks({ 1: 'FS', F: 'AB', S: '' }, [{ orders: { 1: 'SF' } }], { permanent: ['1'] });
  await moveToPosition(inside.host, { id: 'F', place: 'after', anchorId: 'S', parentId: '1' });
  assert.deepEqual(inside.calls, [['get', 'F'], ['getChildren', '1'], ['move', 'F', { parentId: '1', index: 2 }]]);
});

test('U-d moveToPosition: a climb that cannot be read, or never ends, writes nothing and is a failure', async () => {
  const broken = fakeBookmarks(NEST, [], { permanent: ['1'] });
  broken.rejects.add('get:C');
  assert.deepEqual(await moveToPosition(broken.host, { id: 'F', place: 'end', parentId: 'H' }), refused('failed'));
  assert.deepEqual(broken.writes(), []);

  // A fake tree with a loop that does not contain F: the climb gives up instead of spinning.
  const loop = fakeBookmarks({ X: 'Y', Y: 'X', F: '' });
  const result = await moveToPosition(loop.host, { id: 'F', place: 'end', parentId: 'X' });
  assert.deepEqual(result, refused('failed'));
  assert.deepEqual(loop.writes(), []);
});

test('U-d moveToPosition: an anchor that is not among the destination\'s children now is stale; nothing is moved', async () => {
  // Removed during the drag.
  const gone = fakeBookmarks({ F: 'ABCD' });
  gone.vanish('C');
  assert.deepEqual(await moveToPosition(gone.host, { id: 'A', place: 'after', anchorId: 'C', parentId: 'F' }), refused('stale'));
  assert.deepEqual(gone.calls, [['get', 'A'], ['getChildren', 'F']]);
  // Moved to another folder during the drag.
  const away = fakeBookmarks({ F: 'ABCD', G: 'XY' });
  away.relocate('C', 'G');
  assert.deepEqual(await moveToPosition(away.host, { id: 'A', place: 'before', anchorId: 'C', parentId: 'F' }), refused('stale'));
  assert.deepEqual(away.writes(), []);
  // Across folders too.
  const cross = fakeBookmarks({ F: 'pMq', G: 'XYZ' });
  cross.vanish('Y');
  assert.deepEqual(await moveToPosition(cross.host, { id: 'M', place: 'before', anchorId: 'Y', parentId: 'G' }), refused('stale'));
  assert.deepEqual(cross.calls, [['get', 'M'], ['getChildren', 'G']]);
  // No anchor given for a place that needs one.
  const none = fakeBookmarks({ F: 'ABCD' });
  assert.deepEqual(await moveToPosition(none.host, { id: 'A', place: 'before', parentId: 'F' }), refused('stale'));
  assert.deepEqual(none.writes(), []);
});

test('U-d moveToPosition: failures: the item gone, the destination unreadable, a rejected move: nothing more is called and it is "failed"', async () => {
  const noItem = fakeBookmarks({ F: 'ABCD' });
  noItem.vanish('A');
  assert.deepEqual(await moveToPosition(noItem.host, { id: 'A', place: 'after', anchorId: 'C', parentId: 'F' }), refused('failed'));
  assert.deepEqual(noItem.calls, [['get', 'A']]);

  const noFolder = fakeBookmarks({ F: 'ABCD', G: 'XY' });
  noFolder.vanish('G');
  assert.deepEqual(await moveToPosition(noFolder.host, { id: 'A', place: 'before', anchorId: 'X', parentId: 'G' }), refused('failed'));
  assert.deepEqual(noFolder.calls, [['get', 'A'], ['getChildren', 'G']]);

  const rejected = fakeBookmarks({ F: 'ABCD' }, [null]);
  assert.deepEqual(await moveToPosition(rejected.host, { id: 'A', place: 'after', anchorId: 'C', parentId: 'F' }), refused('failed'));
  assert.deepEqual(rejected.calls, [['get', 'A'], ['getChildren', 'F'], ['move', 'A', { parentId: 'F', index: 3 }]]);

  // "Inside" a folder that was deleted: there is no read of it, the move itself is what Chrome rejects (Probe 13 P3).
  const inside = fakeBookmarks({ F: 'pMq', G: 'XYZ' }, [null]);
  inside.vanish('G');
  assert.deepEqual(await moveToPosition(inside.host, { id: 'M', place: 'end', parentId: 'G' }), refused('failed'));
  assert.deepEqual(inside.calls, [['get', 'M'], ['move', 'M', { parentId: 'G' }]]);
});

test('U-d moveToPosition: a read-only item, or an anchor row of a read-only folder, is never written', async () => {
  const item = fakeBookmarks({ F: 'ABCD' });
  item.flag('A', { unmodifiable: 'managed' });
  assert.deepEqual(await moveToPosition(item.host, { id: 'A', place: 'after', anchorId: 'C', parentId: 'F' }), refused('failed'));
  assert.deepEqual(item.calls, [['get', 'A']]);

  // G is a managed folder: its rows carry the flag. Dropping before one of them would write into it.
  const managed = fakeBookmarks({ F: 'pMq', G: 'XYZ' });
  managed.flag('Y', { unmodifiable: 'managed' });
  assert.deepEqual(await moveToPosition(managed.host, { id: 'M', place: 'before', anchorId: 'Y', parentId: 'G' }), refused('failed'));
  assert.deepEqual(managed.calls, [['get', 'M'], ['getChildren', 'G']]);

  // An unflagged anchor next to a flagged sibling is fine.
  const fine = fakeBookmarks({ F: 'pMq', G: 'XYZ' });
  fine.flag('Z', { unmodifiable: 'managed' });
  assert.equal((await moveToPosition(fine.host, { id: 'M', place: 'before', anchorId: 'X', parentId: 'G' })).ok, true);
});

test('U-d moveToPosition: an unknown place throws before any write (a typo must not become "append")', async () => {
  for (const place of ['inside', 'append', '', undefined, null]) {
    const fake = fakeBookmarks({ F: 'ABCD', G: 'XY' });
    await assert.rejects(moveToPosition(fake.host, { id: 'A', place, anchorId: 'B', parentId: 'G' }), RangeError, String(place));
    assert.deepEqual(fake.writes(), [], String(place));
    const same = fakeBookmarks({ F: 'ABCD' });
    await assert.rejects(moveToPosition(same.host, { id: 'A', place, anchorId: 'B', parentId: 'F' }), RangeError, String(place));
    assert.deepEqual(same.writes(), [], String(place));
  }
});

test('U-d moveToPosition: it takes what resolveBookmarkDrop returns, extra keys and all', async () => {
  const fake = fakeBookmarks({ F: 'ABCD' }, [{ orders: { F: 'BCAD' } }]);
  const target = { place: 'after', anchorId: 'C', parentId: 'F', valid: true, noop: false, reason: 'ok' };
  assert.equal((await moveToPosition(fake.host, { id: 'A', ...target })).ok, true);
  assert.deepEqual(fake.writes(), [['move', 'A', { parentId: 'F', index: 3 }]]);
});

/* ── moveRelative: Alt+Arrow, Move up, Move down ──────────────────────────── */

// Probe 17 PA, n = 5 (`ABCDE`): the order after, for k = 0 .. 5 and omitted (k = 6 rejects). Row s = the child that is moved.
const PA5 = [
  ['ABCDE', 'ABCDE', 'BACDE', 'BCADE', 'BCDAE', 'BCDEA', 'BCDEA'], // s = 0 (A)
  ['BACDE', 'ABCDE', 'ABCDE', 'ACBDE', 'ACDBE', 'ACDEB', 'ACDEB'], // s = 1 (B)
  ['CABDE', 'ACBDE', 'ABCDE', 'ABCDE', 'ABDCE', 'ABDEC', 'ABDEC'], // s = 2 (C)
  ['DABCE', 'ADBCE', 'ABDCE', 'ABCDE', 'ABCDE', 'ABCED', 'ABCED'], // s = 3 (D)
  ['EABCD', 'AEBCD', 'ABECD', 'ABCED', 'ABCDE', 'ABCDE', 'ABCDE'], // s = 4 (E)
];
// One step, written as the swap it is and the `index` the table says produces it: up from s is the column s - 1, down is s + 2.
const STEPS = [
  { id: 'A', dir: 'up', want: null },
  { id: 'B', dir: 'up', want: { index: 0, after: 'BACDE' } },
  { id: 'C', dir: 'up', want: { index: 1, after: 'ACBDE' } },
  { id: 'D', dir: 'up', want: { index: 2, after: 'ABDCE' } },
  { id: 'E', dir: 'up', want: { index: 3, after: 'ABCED' } },
  { id: 'A', dir: 'down', want: { index: 2, after: 'BACDE' } },
  { id: 'B', dir: 'down', want: { index: 3, after: 'ACBDE' } },
  { id: 'C', dir: 'down', want: { index: 4, after: 'ABDCE' } },
  { id: 'D', dir: 'down', want: { index: 5, after: 'ABCED' } }, // t = 5 = the child count: an append
  { id: 'E', dir: 'down', want: null },
];

test('U-d moveRelative, Probe 17 PA n = 5: one step up and down from every position; the two ends are no-ops (criteria B9.1, M14)', async () => {
  const failures = [];
  for (const { id, dir, want } of STEPS) {
    const s = 'ABCDE'.indexOf(id);
    const fake = fakeBookmarks({ F: 'ABCDE' }, want ? [{ orders: { F: want.after } }] : []);
    const r = await moveRelative(fake.host, { id, direction: dir });
    const tag = `${id} ${dir}`;
    if (JSON.stringify(fake.reads()) !== JSON.stringify([['get', id], ['getChildren', 'F']])) failures.push(`${tag}: reads ${JSON.stringify(fake.reads())}`);
    if (want === null) {
      if (JSON.stringify(r) !== JSON.stringify(refused('noop'))) failures.push(`${tag}: ${JSON.stringify(r)}`);
      if (fake.writes().length !== 0) failures.push(`${tag}: wrote at the end of the list`);
    } else {
      assert.equal(PA5[s][want.index], want.after, `the table says index ${want.index} turns ABCDE into ${want.after} for ${id}`);
      if (JSON.stringify(fake.writes()) !== JSON.stringify([['move', id, { parentId: 'F', index: want.index }]])) failures.push(`${tag}: ${JSON.stringify(fake.writes())}`);
      if (JSON.stringify(r) !== JSON.stringify(landedAt(id, 'F', want.after.indexOf(id)))) failures.push(`${tag}: ${JSON.stringify(r)}`);
    }
  }
  assert.deepEqual(failures.slice(0, 5), [], `${failures.length} of ${STEPS.length} steps disagree`);
});

test('U-d moveRelative: down is index s + 2, never s + 1 (which Chrome treats as "no move"), and up is s - 1', async () => {
  const down = fakeBookmarks({ F: 'ABCD' }, [{ orders: { F: 'BACD' } }]);
  await moveRelative(down.host, { id: 'A', direction: 'down' });
  assert.deepEqual(down.writes(), [['move', 'A', { parentId: 'F', index: 2 }]]);
  const up = fakeBookmarks({ F: 'ABCD' }, [{ orders: { F: 'ABDC' } }]);
  await moveRelative(up.host, { id: 'D', direction: 'up' });
  assert.deepEqual(up.writes(), [['move', 'D', { parentId: 'F', index: 2 }]]);
  const alone = fakeBookmarks({ F: 'A' });
  assert.deepEqual(await moveRelative(alone.host, { id: 'A', direction: 'up' }), refused('noop'));
  assert.deepEqual(await moveRelative(alone.host, { id: 'A', direction: 'down' }), refused('noop'));
  assert.deepEqual(alone.writes(), []);
});

test('U-d moveRelative: it stays inside its folder: the first child cannot go up into the folder above, the last cannot go down into the next', async () => {
  const layout = { 1: 'SFT', S: 'ab', F: 'ABC', T: 'yz' };
  const first = fakeBookmarks(layout, [], { permanent: ['1'] });
  assert.deepEqual(await moveRelative(first.host, { id: 'A', direction: 'up' }), refused('noop'));
  assert.deepEqual(first.calls, [['get', 'A'], ['getChildren', 'F']], 'it never looks at S, and never leaves F');
  const last = fakeBookmarks(layout, [], { permanent: ['1'] });
  assert.deepEqual(await moveRelative(last.host, { id: 'C', direction: 'down' }), refused('noop'));
  assert.deepEqual(last.calls, [['get', 'C'], ['getChildren', 'F']]);
  // A folder is reordered among its siblings like a link, with no cycle check.
  const folder = fakeBookmarks(layout, [{ orders: { 1: 'FST' } }], { permanent: ['1'] });
  assert.equal((await moveRelative(folder.host, { id: 'F', direction: 'up' })).ok, true);
  assert.deepEqual(folder.calls, [['get', 'F'], ['getChildren', '1'], ['move', 'F', { parentId: '1', index: 0 }]]);
});

test('U-d moveRelative: failures: the item gone, its folder unreadable, a rejected move, a read-only item', async () => {
  const gone = fakeBookmarks({ F: 'ABC' });
  gone.vanish('B');
  assert.deepEqual(await moveRelative(gone.host, { id: 'B', direction: 'up' }), refused('failed'));
  assert.deepEqual(gone.calls, [['get', 'B']]);

  const unreadable = fakeBookmarks({ F: 'ABC' });
  unreadable.rejects.add('getChildren');
  assert.deepEqual(await moveRelative(unreadable.host, { id: 'B', direction: 'up' }), refused('failed'));
  assert.deepEqual(unreadable.writes(), []);

  const rejected = fakeBookmarks({ F: 'ABC' }, [null]);
  assert.deepEqual(await moveRelative(rejected.host, { id: 'C', direction: 'up' }), refused('failed'));
  assert.deepEqual(rejected.calls, [['get', 'C'], ['getChildren', 'F'], ['move', 'C', { parentId: 'F', index: 1 }]]);

  const managed = fakeBookmarks({ F: 'ABC' });
  managed.flag('B', { unmodifiable: 'managed' });
  assert.deepEqual(await moveRelative(managed.host, { id: 'B', direction: 'down' }), refused('failed'));
  assert.deepEqual(managed.calls, [['get', 'B']]);
});

test('U-d moveRelative: an unknown direction throws before any call', async () => {
  for (const direction of ['left', 'next', '', undefined, null]) {
    const fake = fakeBookmarks({ F: 'ABC' });
    await assert.rejects(moveRelative(fake.host, { id: 'B', direction }), RangeError, String(direction));
    assert.deepEqual(fake.calls, [], String(direction));
  }
});

/* ── queued operations ────────────────────────────────────────────────────── */

test('U-d two queued operations: the second does not make a call until the first is done, and then reads the tree as the first left it', async () => {
  // Probe 13 P1: ABCD, A after C is index 3 and leaves BCAD. Then D before B: B is at index 0 NOW (it was at 1), so the index is 0, not 1.
  const fake = fakeBookmarks({ F: 'ABCD' }, [{ orders: { F: 'BCAD' } }, { orders: { F: 'DBCA' } }]);
  const gate = deferred();
  let held = false;
  fake.hold = async () => { if (!held) { held = true; await gate.promise; } };
  const one = queue(() => moveToPosition(fake.host, { id: 'A', place: 'after', anchorId: 'C', parentId: 'F' }));
  const two = queue(() => moveToPosition(fake.host, { id: 'D', place: 'before', anchorId: 'B', parentId: 'F' }));
  try {
    await settle();
    assert.deepEqual(fake.calls, [['get', 'A']], 'the first is inside its first read; the second has not started');
  } finally {
    gate.resolve(); // the one queue must not be left holding a task nobody will release
  }
  const [r1, r2] = await finishes(Promise.all([one, two]));
  assert.deepEqual(fake.calls, [
    ['get', 'A'], ['getChildren', 'F'], ['move', 'A', { parentId: 'F', index: 3 }],
    ['get', 'D'], ['getChildren', 'F'], ['move', 'D', { parentId: 'F', index: 0 }],
  ]);
  assert.deepEqual(r1, landedAt('A', 'F', 2));
  assert.deepEqual(r2, landedAt('D', 'F', 0));
});

test('U-d two queued operations: the item\'s own index is read again too (A goes last, then A goes before B: s is 3 now, not 0)', async () => {
  // Probe 13 P1: s = 0, k = 4 leaves BCDA. Then A before B: with the old s = 0 that would be "t = 0 = s": a no-op, and it is not.
  const fake = fakeBookmarks({ F: 'ABCD' }, [{ orders: { F: 'BCDA' } }, { orders: { F: 'ABCD' } }]);
  const one = queue(() => moveToPosition(fake.host, { id: 'A', place: 'end', parentId: 'F' }));
  const two = queue(() => moveToPosition(fake.host, { id: 'A', place: 'before', anchorId: 'B', parentId: 'F' }));
  const [r1, r2] = await finishes(Promise.all([one, two]));
  assert.deepEqual(fake.writes(), [['move', 'A', { parentId: 'F', index: 4 }], ['move', 'A', { parentId: 'F', index: 0 }]]);
  assert.equal(r1.ok && r2.ok, true);
});

test('U-d two queued operations: a failure in the first does not stop the second, which reads the unchanged tree', async () => {
  const fake = fakeBookmarks({ F: 'ABCD' }, [null, { orders: { F: 'BACD' } }]);
  const one = queue(() => moveToPosition(fake.host, { id: 'A', place: 'after', anchorId: 'C', parentId: 'F' }));
  const two = queue(() => moveToPosition(fake.host, { id: 'A', place: 'before', anchorId: 'C', parentId: 'F' }));
  const [r1, r2] = await finishes(Promise.all([one, two]));
  assert.deepEqual(r1, refused('failed'));
  assert.deepEqual(r2, landedAt('A', 'F', 1));
  assert.deepEqual(fake.calls, [
    ['get', 'A'], ['getChildren', 'F'], ['move', 'A', { parentId: 'F', index: 3 }],
    ['get', 'A'], ['getChildren', 'F'], ['move', 'A', { parentId: 'F', index: 2 }],
  ]);
});

test('U-d two queued operations: an anchor the first operation moved away is stale for the second (nothing is written for it)', async () => {
  const fake = fakeBookmarks({ F: 'ABCD', G: 'XYZ' }, [{ orders: { F: 'ABD', G: 'XYZC' } }]);
  const one = queue(() => moveToPosition(fake.host, { id: 'C', place: 'end', parentId: 'G' }));
  const two = queue(() => moveToPosition(fake.host, { id: 'A', place: 'after', anchorId: 'C', parentId: 'F' }));
  const [r1, r2] = await finishes(Promise.all([one, two]));
  assert.deepEqual(r1, landedAt('C', 'G', 3));
  assert.deepEqual(r2, refused('stale'));
  assert.deepEqual(fake.calls, [
    ['get', 'C'], ['move', 'C', { parentId: 'G' }],
    ['get', 'A'], ['getChildren', 'F'],
  ]);
});

test('U-d queued operations of every kind run in the order they were queued', async () => {
  const fake = fakeBookmarks({ F: 'ABC' }, [{ orders: { F: 'ABCN' } }, undefined, { orders: { F: 'BACN' } }]);
  const gate = deferred();
  let held = false;
  fake.hold = async () => { if (!held) { held = true; await gate.promise; } };
  const results = [
    queue(() => createFolder(fake.host, { parentId: 'F', title: 'N' })),
    queue(() => renameNode(fake.host, { id: 'B', title: 'Beta', original: 'B' })),
    queue(() => moveRelative(fake.host, { id: 'A', direction: 'down' })),
  ];
  try {
    await settle();
    assert.deepEqual(fake.calls, [['create', { parentId: 'F', title: 'N' }]]);
  } finally {
    gate.resolve(); // the one queue must not be left holding a task nobody will release
  }
  const [made, renamed, moved] = await finishes(Promise.all(results));
  assert.deepEqual(fake.calls, [
    ['create', { parentId: 'F', title: 'N' }],
    ['update', 'B', { title: 'Beta' }],
    ['get', 'A'], ['getChildren', 'F'], ['move', 'A', { parentId: 'F', index: 2 }],
  ]);
  assert.deepEqual([made.ok, renamed.ok, moved.ok], [true, true, true]);
});

/* ── what the module says when it refuses ─────────────────────────────────── */

test('U-d every refusal is logged once, with its reason and the ids it was decided on; a success logs nothing', async () => {
  const rows = [];
  const run = async (label, fake, call, reason, mentions) => {
    const r = await call(fake.host);
    assert.equal(r.reason, reason, label);
    assert.equal(fake.logs.length, 1, `${label}: ${JSON.stringify(fake.logs)}`);
    assert.ok(fake.logs[0].includes(reason), `${label}: ${fake.logs[0]}`);
    for (const word of mentions) assert.ok(fake.logs[0].includes(word), `${label}: "${fake.logs[0]}" names ${word}`);
    rows.push(fake.logs[0]);
  };
  await run('create, empty', fakeBookmarks({ F: 'AB' }), (h) => createFolder(h, { parentId: 'F', title: ' ' }), 'noop', ['createFolder', 'F']);
  const gone = fakeBookmarks({ F: 'AB' });
  gone.vanish('B');
  await run('create, stale', gone, (h) => createFolder(h, { parentId: 'F', title: 'P', anchorId: 'B' }), 'stale', ['createFolder', 'B']);
  await run('create, rejected', fakeBookmarks({ F: 'AB' }, [null]), (h) => createFolder(h, { parentId: 'F', title: 'P' }), 'failed', ['createFolder', 'F']);
  await run('rename, unchanged', fakeBookmarks({ F: 'AB' }), (h) => renameNode(h, { id: 'B', title: 'B', original: 'B' }), 'noop', ['renameNode', 'B']);
  await run('rename, rejected', fakeBookmarks({ F: 'AB' }, [null]), (h) => renameNode(h, { id: 'B', title: 'Beta', original: 'B' }), 'failed', ['renameNode', 'B']);
  await run('move, no-op', fakeBookmarks({ F: 'ABCD' }), (h) => moveToPosition(h, { id: 'B', place: 'before', anchorId: 'C', parentId: 'F' }), 'noop', ['moveToPosition', 'B', 'C', 'F']);
  const away = fakeBookmarks({ F: 'ABCD' });
  away.vanish('C');
  await run('move, stale', away, (h) => moveToPosition(h, { id: 'A', place: 'after', anchorId: 'C', parentId: 'F' }), 'stale', ['moveToPosition', 'C', 'F']);
  await run('move, cycle', fakeBookmarks(NEST, [], { permanent: ['1'] }), (h) => moveToPosition(h, { id: 'F', place: 'end', parentId: 'H' }), 'stale', ['moveToPosition', 'F', 'H']);
  await run('move, rejected', fakeBookmarks({ F: 'ABCD' }, [null]), (h) => moveToPosition(h, { id: 'A', place: 'end', parentId: 'F' }), 'failed', ['moveToPosition', 'A', 'F']);
  await run('relative, end', fakeBookmarks({ F: 'AB' }), (h) => moveRelative(h, { id: 'A', direction: 'up' }), 'noop', ['moveRelative', 'A', 'F']);
  assert.equal(new Set(rows).size, rows.length, 'every line says something different');

  const fine = fakeBookmarks({ F: 'ABCD' }, [{ orders: { F: 'BACD' } }]);
  await moveToPosition(fine.host, { id: 'A', place: 'before', anchorId: 'C', parentId: 'F' });
  assert.deepEqual(fine.logs, []);
  // No `log` on the host is fine too.
  const quiet = fakeBookmarks({ F: 'AB' });
  assert.deepEqual(await renameNode({ bm: quiet.bm }, { id: 'B', title: '', original: 'B' }), refused('noop'));
});

test('U-d the log lines carry ids and counts, never a title or an address', async () => {
  const fake = fakeBookmarks({ F: 'ABCD' }, [null, null]);
  fake.vanish('C');
  await moveToPosition(fake.host, { id: 'A', place: 'after', anchorId: 'C', parentId: 'F' });
  await renameNode(fake.host, { id: 'B', title: 'SECRET TITLE\n', original: 'SECRET TITLE' }); // unchanged
  await renameNode(fake.host, { id: 'B', title: 'SECRET TITLE', original: 'x' }); // rejected
  await createFolder(fake.host, { parentId: 'F', title: 'SECRET TITLE' }); // rejected
  await createFolder(fake.host, { parentId: 'F', title: 'SECRET TITLE', anchorId: 'C' }); // anchor gone
  assert.equal(fake.logs.length, 5);
  for (const line of fake.logs) {
    assert.ok(!/SECRET|https?:|example\.test/i.test(line), line);
  }
});

/* ── the whole file ───────────────────────────────────────────────────────── */

test('U-d catch-all: across every test above the module called get, getChildren, create, update and move, and nothing else', () => {
  assert.deepEqual([...usedMethods].sort(), [...ALLOWED].sort());
});
