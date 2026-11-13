// extension/sidepanel/bookmark-math.js — pure geometry of the bookmark column.
// Today that is `placePreview`, the hover preview's placement; the bookmark editing work
// adds its drop-zone maths to the same file and its tests to this one.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { EXT } from './_load.mjs';

const file = path.join(EXT, 'sidepanel', 'bookmark-math.js');
if (!fs.existsSync(file)) throw new Error('extension/sidepanel/bookmark-math.js does not exist');
const mod = await import(pathToFileURL(file).href).catch(async (err) => {
  if (!/Unexpected token '?export'?|Cannot use import statement|ERR_REQUIRE_ESM/i.test(String(err && err.message))) {
    throw err;
  }
  // Mirror as .mjs when the repository root package.json is missing (see _load.mjs).
  const out = path.join(process.env.OUT_DIR || path.join(EXT, '..', 'tests', 'output'), 'esm');
  fs.mkdirSync(out, { recursive: true });
  const target = path.join(out, 'bookmark-math.mjs');
  fs.writeFileSync(target, fs.readFileSync(file, 'utf8')
    .replace(/(\bfrom\s*['"])(\.\.?\/[^'"]+?)\.js(['"])/g, '$1$2.mjs$3'));
  return import(pathToFileURL(target).href);
});

const { placePreview } = mod;

/** The aspect the thumbnails are stored at (constants.js THUMB_ASPECT). */
const ASPECT = 8 / 3;

const row = (top, bottom) => ({ top, bottom });

test('the module is pure: no imports, no DOM, no chrome', () => {
  const src = fs.readFileSync(file, 'utf8')
    // Comments are allowed to mention anything; code is not.
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert.ok(!/^\s*import\b/m.test(src), 'bookmark-math.js must not import anything');
  assert.ok(!/\bimport\s*\(/.test(src), 'bookmark-math.js must not import() anything');
  for (const global of ['document', 'window', 'chrome', 'navigator', 'localStorage']) {
    assert.ok(!new RegExp(`\\b${global}\\b`).test(src), `bookmark-math.js must not touch ${global}`);
  }
});

test('placePreview: at the 360 px minimum the card is 300 x 112, under the row, flush right', () => {
  const p = placePreview({ rowRect: row(100, 126), viewport: { w: 360, h: 900 }, aspect: ASPECT });
  assert.deepEqual(p, { left: 52, top: 130, width: 300, height: 112, flipped: false });
});

test('placePreview: a wide panel does not widen the card past 300', () => {
  const p = placePreview({ rowRect: row(100, 126), viewport: { w: 800, h: 900 }, aspect: ASPECT });
  assert.equal(p.width, 300);
  assert.equal(p.height, 112);
  assert.equal(p.left, 800 - 300 - 8, 'still flush with the right edge, one margin in');
});

test('placePreview: a panel narrower than 316 shrinks the card to keep a margin each side', () => {
  const p = placePreview({ rowRect: row(10, 36), viewport: { w: 300, h: 600 }, aspect: ASPECT });
  assert.equal(p.width, 284);
  assert.equal(p.height, Math.floor(284 / ASPECT));
  assert.equal(p.left, 8, 'both margins are 8, so the card starts at the left one');
  const tiny = placePreview({ rowRect: row(10, 36), viewport: { w: 100, h: 600 }, aspect: ASPECT });
  assert.equal(tiny.width, 84);
  assert.equal(tiny.left, 8);
});

test('placePreview: the height follows the aspect it is given', () => {
  const square = placePreview({ rowRect: row(0, 20), viewport: { w: 360, h: 900 }, aspect: 1 });
  assert.equal(square.height, square.width);
  const wide = placePreview({ rowRect: row(0, 20), viewport: { w: 360, h: 900 }, aspect: 4 });
  assert.equal(wide.height, 75);
});

test('placePreview: flips above the row when the card would run off the bottom', () => {
  const p = placePreview({ rowRect: row(360, 386), viewport: { w: 360, h: 400 }, aspect: ASPECT });
  assert.equal(p.flipped, true);
  assert.equal(p.top, 360 - 4 - 112);
  assert.ok(p.top + p.height <= 360, 'it ends above the row it describes');
});

test('placePreview: the row at the very bottom still gets a card, above it', () => {
  const p = placePreview({ rowRect: row(874, 900), viewport: { w: 460, h: 900 }, aspect: ASPECT });
  assert.equal(p.flipped, true);
  assert.equal(p.top + p.height + 4, 874);
});

test('placePreview: the caption counts when deciding whether it fits', () => {
  // 112 high fits under this row (130 + 112 = 242 <= 250 - 8); with a 40 px caption it does not.
  const args = { rowRect: row(100, 126), viewport: { w: 360, h: 250 }, aspect: ASPECT };
  assert.equal(placePreview(args).flipped, false);
  const withCaption = placePreview({ ...args, extraHeight: 40 });
  assert.equal(withCaption.flipped, false, 'above has no room either (100 - 4 - 152 < 8) and below has more');
  const roomy = placePreview({
    rowRect: row(300, 326), viewport: { w: 360, h: 460 }, aspect: ASPECT, extraHeight: 40,
  });
  assert.equal(roomy.flipped, true, '330 + 152 > 452, so it goes above');
  assert.equal(roomy.top, 300 - 4 - 152);
  assert.equal(roomy.height, 112, 'extraHeight is not part of the picture');
});

test('placePreview: when neither side holds it, it stays inside the panel and takes the roomier side', () => {
  const p = placePreview({ rowRect: row(60, 86), viewport: { w: 360, h: 150 }, aspect: ASPECT });
  assert.ok(p.top >= 8, `top ${p.top} is inside the panel`);
  assert.ok(p.top + p.height <= 150 - 8, `bottom ${p.top + p.height} is inside the panel`);
  assert.equal(p.flipped, false, 'there is more room below this row than above it');
});

test('placePreview: a card taller than the panel starts at the top margin', () => {
  const p = placePreview({ rowRect: row(10, 36), viewport: { w: 360, h: 100 }, aspect: ASPECT });
  assert.equal(p.top, 8);
});

test('placePreview: inside the panel, and off the row whenever there is a way to be, over a sweep', () => {
  const failures = [];
  for (const w of [360, 400, 460, 700]) {
    for (const h of [180, 240, 400, 600, 900]) {
      for (let top = 0; top + 26 <= h; top += 7) {
        for (const extra of [0, 44]) {
          const rowRect = row(top, top + 26);
          const p = placePreview({ rowRect, viewport: { w, h }, aspect: ASPECT, extraHeight: extra });
          const total = p.height + extra;
          const tag = `w=${w} h=${h} row=${top} extra=${extra} -> ${JSON.stringify(p)}`;
          if (p.width > 300 || p.width < 0) failures.push(`width out of range: ${tag}`);
          if (p.height !== Math.floor(p.width / ASPECT)) failures.push(`height is not the aspect's: ${tag}`);
          if (p.left < 8 || p.left + p.width > w - 8) failures.push(`outside horizontally: ${tag}`);
          for (const n of [p.left, p.top, p.width, p.height]) {
            if (!Number.isInteger(n)) failures.push(`not whole pixels: ${tag}`);
          }
          const fits = total <= h - 16;
          if (fits && (p.top < 8 || p.top + total > h - 8)) failures.push(`outside vertically: ${tag}`);
          // A way to avoid the row exists when a whole card fits above or below it.
          const roomBelow = h - 8 - (rowRect.bottom + 4);
          const roomAbove = rowRect.top - 4 - 8;
          if (fits && (roomBelow >= total || roomAbove >= total)) {
            const clear = p.top >= rowRect.bottom || p.top + total <= rowRect.top;
            if (!clear) failures.push(`covers its own row although it did not have to: ${tag}`);
          }
        }
      }
    }
  }
  assert.deepEqual(failures.slice(0, 5), [], `${failures.length} placements broke an invariant`);
});

// =====================================================================================================
// U1 of the bookmark folders work (PR2): bookmarkMoveArg, resolveBookmarkDrop, descendantIds.
// Criteria B2 U-a, U-b, U-c and the math half of U-e. Everything above this line is the hover preview's
// and is unchanged.
// =====================================================================================================
const {
  bookmarkMoveArg, resolveBookmarkDrop, descendantIds,
  DROP_LINK_BEFORE, DROP_FOLDER_BEFORE, DROP_FOLDER_AFTER,
} = mod;

// ----------------------------------------------------------------------------------------------------
// THE MEASURED TABLES, as literal order strings. Nothing in this block is computed by the code under test.
//
// Sources: Probe 13 P1 and P2 (the tables typed in `.agent/probe-results.md`) and Probe 17 PA (the 259 cells
// of run 1, commit `643a47d`). The block was produced ONCE by a throwaway script (not in the repository) that
// read the run's JSON and that file, cross-checked them against each other before writing anything, and
// refused to write on any difference:
//   - the PA JSON against the PA tables of the markdown: all 23 same-parent rows (188 cells), the 40
//     other-parent cells and the 31 create cells are equal;
//   - PA n = 4 against Probe 13 P1: the 24 cells they share are equal (P1 also has k = 9, PA has k = 5);
//   - every one of the 134 PB cells (a permanent folder as parent, Probe 17) is the same SHAPE as a cell of
//     these tables once the letters are renamed, and `create` is the other-parent rule at m = 0, 1, 2 and 5,
//     so PB adds no row of its own and none is copied.
//
// Layout. `list` is the order before the call, one letter per child, in order. `ks` names the columns: the
// `index` passed to `bookmarks.move` / `bookmarks.create`, or 'omitted' when it is left out. A row holds the
// order AFTER the call for each column; 'rejects' means the call rejected ("Index out of bounds.") and
// changed nothing. Same parent: row s is the child that is moved. Other parent and create: the moved or
// created node is M / N, and the destination's own children are the letters of `g` / `list`.
// ----------------------------------------------------------------------------------------------------

/** Probe 13 P1: n = 4, `ABCD`; columns k = 0 1 2 3 4 9 omitted (28 cells; 24 resolve, 4 reject at k = 9). */
const P1 = {
  list: 'ABCD',
  ks: [0, 1, 2, 3, 4, 9, 'omitted'],
  rows: [
    ['ABCD', 'ABCD', 'BACD', 'BCAD', 'BCDA', 'rejects', 'BCDA'],  // s = 0 (A)
    ['BACD', 'ABCD', 'ABCD', 'ACBD', 'ACDB', 'rejects', 'ACDB'],  // s = 1 (B)
    ['CABD', 'ACBD', 'ABCD', 'ABCD', 'ABDC', 'rejects', 'ABDC'],  // s = 2 (C)
    ['DABC', 'ADBC', 'ABDC', 'ABCD', 'ABCD', 'rejects', 'ABCD'],  // s = 3 (D)
  ],
};

/** Probe 13 P2: M (a link, or a folder holding three links) moved into G = `XYZ` (14 cells; 4 reject: k = 4 and k = 9). */
const P2 = {
  m: 3,
  g: 'XYZ',
  ks: [0, 1, 2, 3, 4, 9, 'omitted'],
  leaf: ['MXYZ', 'XMYZ', 'XYMZ', 'XYZM', 'rejects', 'rejects', 'XYZM'],
  folder3: ['MXYZ', 'XMYZ', 'XYMZ', 'XYZM', 'rejects', 'rejects', 'XYZM'],
};

/** Probe 17 PA, same parent: n = 1, 2, 3, 4, 5, 8 (188 cells). Columns k = 0 .. n + 1, then omitted. */
const PA_SAME = [
  {
    n: 1,
    list: 'A',
    ks: [0, 1, 2, 'omitted'],
    rows: [
      ['A', 'A', 'rejects', 'A'],  // s = 0 (A)
    ],
  },
  {
    n: 2,
    list: 'AB',
    ks: [0, 1, 2, 3, 'omitted'],
    rows: [
      ['AB', 'AB', 'BA', 'rejects', 'BA'],  // s = 0 (A)
      ['BA', 'AB', 'AB', 'rejects', 'AB'],  // s = 1 (B)
    ],
  },
  {
    n: 3,
    list: 'ABC',
    ks: [0, 1, 2, 3, 4, 'omitted'],
    rows: [
      ['ABC', 'ABC', 'BAC', 'BCA', 'rejects', 'BCA'],  // s = 0 (A)
      ['BAC', 'ABC', 'ABC', 'ACB', 'rejects', 'ACB'],  // s = 1 (B)
      ['CAB', 'ACB', 'ABC', 'ABC', 'rejects', 'ABC'],  // s = 2 (C)
    ],
  },
  {
    n: 4,
    list: 'ABCD',
    ks: [0, 1, 2, 3, 4, 5, 'omitted'],
    rows: [
      ['ABCD', 'ABCD', 'BACD', 'BCAD', 'BCDA', 'rejects', 'BCDA'],  // s = 0 (A)
      ['BACD', 'ABCD', 'ABCD', 'ACBD', 'ACDB', 'rejects', 'ACDB'],  // s = 1 (B)
      ['CABD', 'ACBD', 'ABCD', 'ABCD', 'ABDC', 'rejects', 'ABDC'],  // s = 2 (C)
      ['DABC', 'ADBC', 'ABDC', 'ABCD', 'ABCD', 'rejects', 'ABCD'],  // s = 3 (D)
    ],
  },
  {
    n: 5,
    list: 'ABCDE',
    ks: [0, 1, 2, 3, 4, 5, 6, 'omitted'],
    rows: [
      ['ABCDE', 'ABCDE', 'BACDE', 'BCADE', 'BCDAE', 'BCDEA', 'rejects', 'BCDEA'],  // s = 0 (A)
      ['BACDE', 'ABCDE', 'ABCDE', 'ACBDE', 'ACDBE', 'ACDEB', 'rejects', 'ACDEB'],  // s = 1 (B)
      ['CABDE', 'ACBDE', 'ABCDE', 'ABCDE', 'ABDCE', 'ABDEC', 'rejects', 'ABDEC'],  // s = 2 (C)
      ['DABCE', 'ADBCE', 'ABDCE', 'ABCDE', 'ABCDE', 'ABCED', 'rejects', 'ABCED'],  // s = 3 (D)
      ['EABCD', 'AEBCD', 'ABECD', 'ABCED', 'ABCDE', 'ABCDE', 'rejects', 'ABCDE'],  // s = 4 (E)
    ],
  },
  {
    n: 8,
    list: 'ABCDEFGH',
    ks: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 'omitted'],
    rows: [
      ['ABCDEFGH', 'ABCDEFGH', 'BACDEFGH', 'BCADEFGH', 'BCDAEFGH', 'BCDEAFGH', 'BCDEFAGH', 'BCDEFGAH', 'BCDEFGHA', 'rejects', 'BCDEFGHA'],  // s = 0 (A)
      ['BACDEFGH', 'ABCDEFGH', 'ABCDEFGH', 'ACBDEFGH', 'ACDBEFGH', 'ACDEBFGH', 'ACDEFBGH', 'ACDEFGBH', 'ACDEFGHB', 'rejects', 'ACDEFGHB'],  // s = 1 (B)
      ['CABDEFGH', 'ACBDEFGH', 'ABCDEFGH', 'ABCDEFGH', 'ABDCEFGH', 'ABDECFGH', 'ABDEFCGH', 'ABDEFGCH', 'ABDEFGHC', 'rejects', 'ABDEFGHC'],  // s = 2 (C)
      ['DABCEFGH', 'ADBCEFGH', 'ABDCEFGH', 'ABCDEFGH', 'ABCDEFGH', 'ABCEDFGH', 'ABCEFDGH', 'ABCEFGDH', 'ABCEFGHD', 'rejects', 'ABCEFGHD'],  // s = 3 (D)
      ['EABCDFGH', 'AEBCDFGH', 'ABECDFGH', 'ABCEDFGH', 'ABCDEFGH', 'ABCDEFGH', 'ABCDFEGH', 'ABCDFGEH', 'ABCDFGHE', 'rejects', 'ABCDFGHE'],  // s = 4 (E)
      ['FABCDEGH', 'AFBCDEGH', 'ABFCDEGH', 'ABCFDEGH', 'ABCDFEGH', 'ABCDEFGH', 'ABCDEFGH', 'ABCDEGFH', 'ABCDEGHF', 'rejects', 'ABCDEGHF'],  // s = 5 (F)
      ['GABCDEFH', 'AGBCDEFH', 'ABGCDEFH', 'ABCGDEFH', 'ABCDGEFH', 'ABCDEGFH', 'ABCDEFGH', 'ABCDEFGH', 'ABCDEFHG', 'rejects', 'ABCDEFHG'],  // s = 6 (G)
      ['HABCDEFG', 'AHBCDEFG', 'ABHCDEFG', 'ABCHDEFG', 'ABCDHEFG', 'ABCDEHFG', 'ABCDEFHG', 'ABCDEFGH', 'ABCDEFGH', 'rejects', 'ABCDEFGH'],  // s = 7 (H)
    ],
  },
];

/** Probe 17 PA, other parent: M (leaf, or a folder holding three links) moved out of F = `pMq` into G holding m links (40 cells).
 *  Columns k = 0 .. m + 1, then omitted. After a call that resolves F is `pq`; after one that rejects it is still `pMq`. */
const PA_CROSS = [
  {
    m: 0, g: '',
    ks: [0, 1, 'omitted'],
    leaf: ['M', 'rejects', 'M'],
    folder3: ['M', 'rejects', 'M'],
  },
  {
    m: 1, g: 'X',
    ks: [0, 1, 2, 'omitted'],
    leaf: ['MX', 'XM', 'rejects', 'XM'],
    folder3: ['MX', 'XM', 'rejects', 'XM'],
  },
  {
    m: 2, g: 'XY',
    ks: [0, 1, 2, 3, 'omitted'],
    leaf: ['MXY', 'XMY', 'XYM', 'rejects', 'XYM'],
    folder3: ['MXY', 'XMY', 'XYM', 'rejects', 'XYM'],
  },
  {
    m: 5, g: 'XYZUV',
    ks: [0, 1, 2, 3, 4, 5, 6, 'omitted'],
    leaf: ['MXYZUV', 'XMYZUV', 'XYMZUV', 'XYZMUV', 'XYZUMV', 'XYZUVM', 'rejects', 'XYZUVM'],
    folder3: ['MXYZUV', 'XMYZUV', 'XYMZUV', 'XYZMUV', 'XYZUMV', 'XYZUVM', 'rejects', 'XYZUVM'],
  },
];

/** Probe 17 PA, `create` of a folder N in a folder holding m links (31 cells). Columns k = 0 .. m + 1, then omitted. */
const PA_CREATE = [
  {
    m: 0, list: '',
    ks: [0, 1, 'omitted'],
    after: ['N', 'rejects', 'N'],
  },
  {
    m: 1, list: 'A',
    ks: [0, 1, 2, 'omitted'],
    after: ['NA', 'AN', 'rejects', 'AN'],
  },
  {
    m: 2, list: 'AB',
    ks: [0, 1, 2, 3, 'omitted'],
    after: ['NAB', 'ANB', 'ABN', 'rejects', 'ABN'],
  },
  {
    m: 5, list: 'ABCDE',
    ks: [0, 1, 2, 3, 4, 5, 6, 'omitted'],
    after: ['NABCDE', 'ANBCDE', 'ABNCDE', 'ABCNDE', 'ABCDNE', 'ABCDEN', 'rejects', 'ABCDEN'],
  },
  {
    m: 8, list: 'ABCDEFGH',
    ks: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 'omitted'],
    after: ['NABCDEFGH', 'ANBCDEFGH', 'ABNCDEFGH', 'ABCNDEFGH', 'ABCDNEFGH', 'ABCDENFGH', 'ABCDEFNGH', 'ABCDEFGNH', 'ABCDEFGHN', 'rejects', 'ABCDEFGHN'],
  },
];

// ---- an independent model of Chrome's `bookmarks.move` / `create` ---------------------------------------
// Written from the probes' wording, NOT from the helper. `index` is read against the children as they are
// BEFORE the moved one is taken out (same parent); it is the final position (another parent, or a node that
// is new); omitted appends; above the child count the call rejects. The model is itself checked against
// EVERY literal cell below, so it cannot drift from the probes without a test going red.

function chromeMoveWithin(order, s, index) {
  const kids = [...order];
  const k = index === undefined ? kids.length : index;
  if (!Number.isInteger(k) || k < 0) throw new RangeError('Value must be at least 0.');
  if (k > kids.length) throw new RangeError('Index out of bounds.');
  const [moved] = kids.splice(s, 1);
  kids.splice(k > s ? k - 1 : k, 0, moved);
  return kids.join('');
}

function chromeInsert(order, letter, index) {
  const kids = [...order];
  const k = index === undefined ? kids.length : index;
  if (!Number.isInteger(k) || k < 0) throw new RangeError('Value must be at least 0.');
  if (k > kids.length) throw new RangeError('Index out of bounds.');
  kids.splice(k, 0, letter);
  return kids.join('');
}

/** What the model says, in the tables' words: the order after, or 'rejects'. Anything else it throws is shown. */
function modelOutcome(run) {
  try {
    return run();
  } catch (err) {
    return /Index out of bounds/.test(err.message) ? 'rejects' : `threw: ${err.message}`;
  }
}

/**
 * The expected order of a drag, written from NAMES only: the moved item ends up immediately before the
 * ORIGINAL child at `gap` ("gap j" = before child j), or last when `gap` is the list length. No index
 * arithmetic, so it is a second opinion on the arithmetic (criteria B5.1).
 */
function oracleOrder(list, s, gap) {
  const moved = list[s];
  const rest = [...list].filter((name) => name !== moved);
  if (gap === list.length) return rest.join('') + moved;
  const successor = list[gap];
  if (successor === moved) return list; // "before itself" leaves it where it is
  rest.splice(rest.indexOf(successor), 0, moved);
  return rest.join('');
}

/** The same for a node that comes from another folder: it goes immediately before the original child `gap`. */
const oracleInsert = (list, gap) => list.slice(0, gap) + 'M' + list.slice(gap);

const kArg = (k) => (k === 'omitted' ? undefined : k);

/** Every way the UI can say the position the probes called `k`, for a destination with `count` children. */
function spellings(k, count) {
  if (k === 'omitted') return [{ place: 'end' }];
  if (k > count) {
    // Chrome rejects this index. A stale anchor can still ask for it, and the helper has to clamp it.
    return [{ place: 'before', anchorIndex: k }, { place: 'after', anchorIndex: k - 1 }];
  }
  const out = [];
  if (k < count) out.push({ place: 'before', anchorIndex: k });
  if (k >= 1) out.push({ place: 'after', anchorIndex: k - 1 });
  if (k === 0) out.push({ place: 'start' });
  if (k === count) out.push({ place: 'end' });
  return out;
}

test('the literal tables are complete: every cell of P1, P2 and Probe 17 PA is present and well-formed', () => {
  const cells = (table) => table.rows.length * table.ks.length;
  assert.deepEqual(PA_SAME.map((t) => t.n), [1, 2, 3, 4, 5, 8]);
  assert.deepEqual(PA_SAME.map(cells), [4, 10, 18, 28, 40, 88]);
  assert.equal(PA_SAME.reduce((sum, t) => sum + cells(t), 0), 188, 'PA same parent');
  assert.equal(cells(P1), 28, 'Probe 13 P1');
  assert.deepEqual(PA_CROSS.map((t) => t.m), [0, 1, 2, 5]);
  assert.equal(PA_CROSS.reduce((sum, t) => sum + 2 * t.ks.length, 0), 40, 'PA other parent');
  assert.equal(2 * P2.ks.length, 14, 'Probe 13 P2');
  assert.deepEqual(PA_CREATE.map((t) => t.m), [0, 1, 2, 5, 8]);
  assert.equal(PA_CREATE.reduce((sum, t) => sum + t.ks.length, 0), 31, 'PA create');

  const rows = [];
  for (const t of [P1, ...PA_SAME]) t.rows.forEach((row, s) => rows.push({ list: t.list, ks: t.ks, row, label: `${t.list} s=${s}`, extra: '' }));
  for (const t of PA_CROSS) {
    for (const kind of ['leaf', 'folder3']) rows.push({ list: t.g, ks: t.ks, row: t[kind], label: `m=${t.m} ${kind}`, extra: 'M' });
  }
  for (const kind of ['leaf', 'folder3']) rows.push({ list: P2.g, ks: P2.ks, row: P2[kind], label: `P2 ${kind}`, extra: 'M' });
  for (const t of PA_CREATE) rows.push({ list: t.list, ks: t.ks, row: t.after, label: `create m=${t.m}`, extra: 'N' });
  const problems = [];
  for (const { list, ks, row, label, extra } of rows) {
    const n = list.length;
    if (row.length !== ks.length) problems.push(`${label}: ${row.length} cells for ${ks.length} columns`);
    if (ks[ks.length - 1] !== 'omitted') problems.push(`${label}: the last column is not 'omitted'`);
    ks.forEach((k, col) => {
      const above = k !== 'omitted' && k > n;
      if ((row[col] === 'rejects') !== above) problems.push(`${label} k=${k}: it must reject exactly above ${n}`);
      if (!above) {
        const want = [...(list + extra)].sort().join('');
        if ([...row[col]].sort().join('') !== want) problems.push(`${label} k=${k}: ${row[col]} is not a rearrangement of ${list + extra}`);
      }
    });
  }
  assert.deepEqual(problems.slice(0, 5), [], `${problems.length} malformed rows`);
});

test('the order model and the by-name oracle reproduce every literal cell (so they can judge the helper)', () => {
  const failures = [];
  let checked = 0;
  const same = (table) => {
    table.rows.forEach((row, s) => table.ks.forEach((k, col) => {
      checked += 1;
      const got = modelOutcome(() => chromeMoveWithin(table.list, s, kArg(k)));
      if (got !== row[col]) failures.push(`model, ${table.list} s=${s} k=${k}: ${got} != ${row[col]}`);
      if (k === 'omitted' || k <= table.list.length) {
        const gap = k === 'omitted' ? table.list.length : k;
        if (oracleOrder(table.list, s, gap) !== row[col]) failures.push(`oracle, ${table.list} s=${s} k=${k}: ${oracleOrder(table.list, s, gap)} != ${row[col]}`);
      }
    }));
  };
  [P1, ...PA_SAME].forEach(same);
  const insert = (list, letter, ks, row, label) => ks.forEach((k, col) => {
    checked += 1;
    const got = modelOutcome(() => chromeInsert(list, letter, kArg(k)));
    if (got !== row[col]) failures.push(`model, ${label} k=${k}: ${got} != ${row[col]}`);
    if (letter === 'M' && (k === 'omitted' || k <= list.length)) {
      const want = oracleInsert(list, k === 'omitted' ? list.length : k);
      if (want !== row[col]) failures.push(`oracle, ${label} k=${k}: ${want} != ${row[col]}`);
    }
  });
  for (const t of PA_CROSS) for (const kind of ['leaf', 'folder3']) insert(t.g, 'M', t.ks, t[kind], `m=${t.m} ${kind}`);
  for (const kind of ['leaf', 'folder3']) insert(P2.g, 'M', P2.ks, P2[kind], `P2 ${kind}`);
  for (const t of PA_CREATE) insert(t.list, 'N', t.ks, t.after, `create m=${t.m}`);
  assert.equal(checked, 188 + 28 + 40 + 14 + 31);
  assert.deepEqual(failures.slice(0, 5), [], `${failures.length} cells disagree with the model`);
});

/** One same-parent table, every column spelled every way the UI can say it (see spellings). */
function checkSameParent(table) {
  const n = table.list.length;
  const failures = [];
  let spelled = 0;
  table.rows.forEach((row, s) => {
    const letter = table.list[s];
    table.ks.forEach((k, col) => {
      // A k above the child count is rejected by Chrome. The helper clamps such an anchor to the end, so
      // what it has to produce for that column is what the row says for k = n.
      const want = row[col] === 'rejects' ? row[table.ks.indexOf(n)] : row[col];
      for (const sp of spellings(k, n)) {
        spelled += 1;
        const r = bookmarkMoveArg({ sameParent: true, s, count: n, ...sp });
        const tag = `s=${s} k=${k} ${JSON.stringify(sp)} -> ${JSON.stringify(r)}`;
        let got;
        if (r.skip) {
          if ('index' in r) failures.push(`a skipped move still carries an index: ${tag}`);
          got = table.list;
        } else {
          if (!Number.isInteger(r.index) || r.index < 0 || r.index > n) failures.push(`index outside 0..${n}: ${tag}`);
          got = modelOutcome(() => chromeMoveWithin(table.list, s, r.index));
        }
        if (got !== want) failures.push(`the order becomes ${got}, the table says ${want}: ${tag}`);
        if (r.skip !== (want === table.list)) failures.push(`skip should be ${want === table.list}: ${tag}`);
        if (r.final !== want.indexOf(letter)) failures.push(`final should be ${want.indexOf(letter)}: ${tag}`);
      }
    });
  });
  return { failures, spelled };
}

/** One other-parent (or create) row: M or N goes into a destination of `list.length` children. */
function checkInsertRow({ list, ks, row, letter }) {
  const m = list.length;
  const failures = [];
  let spelled = 0;
  ks.forEach((k, col) => {
    const want = row[col] === 'rejects' ? row[ks.indexOf(m)] : row[col];
    for (const sp of spellings(k, m)) {
      for (const s of [1, 0, 99]) { // where the item sat in the folder it comes from must not matter
        spelled += 1;
        const r = bookmarkMoveArg({ sameParent: false, s, count: m, ...sp });
        const tag = `k=${k} s=${s} ${JSON.stringify(sp)} -> ${JSON.stringify(r)}`;
        if (r.skip !== false) failures.push(`another parent never skips: ${tag}`);
        if (sp.place === 'end') {
          if ('index' in r) failures.push(`an append leaves the index out: ${tag}`);
          if (r.final !== m) failures.push(`an append lands at ${m}: ${tag}`);
        } else if (!Number.isInteger(r.index) || r.index < 0 || r.index > m) {
          failures.push(`index outside 0..${m}: ${tag}`);
        }
        const got = modelOutcome(() => chromeInsert(list, letter, 'index' in r ? r.index : undefined));
        if (got !== want) failures.push(`the order becomes ${got}, the table says ${want}: ${tag}`);
        if (r.final !== want.indexOf(letter)) failures.push(`final should be ${want.indexOf(letter)}: ${tag}`);
      }
    }
  });
  return { failures, spelled };
}

for (const table of [P1, ...PA_SAME]) {
  const label = table === P1 ? 'Probe 13 P1 (n = 4, k up to 9)' : `Probe 17 PA, n = ${table.list.length}`;
  test(`U-a bookmarkMoveArg, same parent, ${label}: every cell, every spelling, against the literal orders`, () => {
    const { failures, spelled } = checkSameParent(table);
    assert.ok(spelled >= table.rows.length * table.ks.length, 'every cell is spelled at least once');
    assert.deepEqual(failures.slice(0, 5), [], `${failures.length} of ${spelled} spellings disagree with the table`);
  });
}

for (const t of PA_CROSS) {
  test(`U-b bookmarkMoveArg, other parent, Probe 17 PA, destination of ${t.m} children${t.m === 0 ? ' (EMPTY)' : ''}: link and folder, every cell`, () => {
    for (const kind of ['leaf', 'folder3']) {
      const { failures, spelled } = checkInsertRow({ list: t.g, ks: t.ks, row: t[kind], letter: 'M' });
      assert.ok(spelled >= t.ks.length, 'every cell is spelled at least once');
      assert.deepEqual(failures.slice(0, 5), [], `${kind}: ${failures.length} of ${spelled} spellings disagree`);
    }
  });
}

test('U-b bookmarkMoveArg, other parent, Probe 13 P2 (a 3-child target, k up to 9): link and folder, every cell', () => {
  for (const kind of ['leaf', 'folder3']) {
    const { failures, spelled } = checkInsertRow({ list: P2.g, ks: P2.ks, row: P2[kind], letter: 'M' });
    assert.ok(spelled >= P2.ks.length);
    assert.deepEqual(failures.slice(0, 5), [], `${kind}: ${failures.length} of ${spelled} spellings disagree`);
  }
});

// A new folder is not in the list it is created in, so `create` takes the same `index` as a move from another
// parent: the PA create table and the PA other-parent table have the same shape at m = 0, 1, 2 and 5 (checked
// by the script that wrote the literals), and the helper is what turns "after this row" into `anchor.index + 1`.
for (const t of PA_CREATE) {
  test(`U-b bookmarkMoveArg for create, Probe 17 PA, folder of ${t.m} children${t.m === 0 ? ' (EMPTY)' : ''}: every cell`, () => {
    const { failures, spelled } = checkInsertRow({ list: t.list, ks: t.ks, row: t.after, letter: 'N' });
    assert.ok(spelled >= t.ks.length);
    assert.deepEqual(failures.slice(0, 5), [], `${failures.length} of ${spelled} spellings disagree`);
  });
}

// The same Probe 13 rows as the CALL the UI has to make, one step less derived than the order tables above.
// [s][k] for k = 0 1 2 3 4 omitted of P1, the 24 rows that resolve: 'skip' = no call at all, a number = the `index`
// argument. Written by reading the probe's table (an order that does not change is a skip; otherwise the index is
// the k that was passed, and an omitted index is the end, 4), not by running the helper.
const P1_CALL_KS = [0, 1, 2, 3, 4, 'omitted'];
const P1_CALLS = [
  ['skip', 'skip', 2, 3, 4, 4], // s = 0
  [0, 'skip', 'skip', 3, 4, 4], // s = 1
  [0, 1, 'skip', 'skip', 4, 4], // s = 2
  [0, 1, 2, 'skip', 'skip', 'skip'], // s = 3
];

test('U-a bookmarkMoveArg, same parent, Probe 13 P1: the 24 rows that resolve, as literal calls (no call, or this index)', () => {
  const failures = [];
  let checked = 0;
  P1_CALLS.forEach((row, s) => P1_CALL_KS.forEach((k, col) => {
    for (const sp of spellings(k, 4)) {
      checked += 1;
      const r = bookmarkMoveArg({ sameParent: true, s, count: 4, ...sp });
      const tag = `s=${s} k=${k} ${JSON.stringify(sp)} -> ${JSON.stringify(r)}`;
      if (row[col] === 'skip') {
        if (r.skip !== true || 'index' in r) failures.push(`expected no call: ${tag}`);
      } else if (r.skip !== false || r.index !== row[col]) {
        failures.push(`expected index ${row[col]}: ${tag}`);
      }
    }
  }));
  assert.ok(checked >= 24, 'all 24 rows are spelled');
  assert.deepEqual(failures.slice(0, 5), [], `${failures.length} of ${checked} spellings differ from the table`);
});

test('U-b bookmarkMoveArg, other parent, Probe 13 P2: the final index IS the index argument for 0..3 on a 3-child target, omitted appends', () => {
  for (const k of [0, 1, 2, 3]) {
    for (const sp of spellings(k, 3)) {
      assert.deepEqual(
        bookmarkMoveArg({ sameParent: false, s: 1, count: 3, ...sp }),
        sp.place === 'end' ? { skip: false, final: 3 } : { skip: false, index: k, final: k },
        `k=${k} ${JSON.stringify(sp)}`,
      );
    }
  }
  assert.deepEqual(bookmarkMoveArg({ sameParent: false, s: 1, count: 3, place: 'end' }), { skip: false, final: 3 });
  // Chrome rejects 4 and 9 for this target; a stale anchor that asks for them is clamped to the end, never passed on.
  for (const anchorIndex of [4, 9]) {
    assert.deepEqual(
      bookmarkMoveArg({ sameParent: false, s: 1, count: 3, place: 'before', anchorIndex }),
      { skip: false, index: 3, final: 3 },
    );
  }
});

test('U-a bookmarkMoveArg: "move B below C" in ABCD asks for index 3, not 2 (Chrome reads the index before the removal)', () => {
  // s = 1, the row after C (anchor 2). Taking `index` for the FINAL position would send 2, which Chrome treats
  // as "no move" (Probe 13 P1, s = 1, k = 2).
  assert.deepEqual(
    bookmarkMoveArg({ sameParent: true, s: 1, anchorIndex: 2, place: 'after', count: 4 }),
    { skip: false, index: 3, final: 2 },
  );
  assert.deepEqual(
    bookmarkMoveArg({ sameParent: true, s: 0, anchorIndex: 2, place: 'before', count: 4 }),
    { skip: false, index: 2, final: 1 },
  );
  // From another folder the same anchor is the final position, so the same call says something else.
  assert.deepEqual(
    bookmarkMoveArg({ sameParent: false, s: 1, anchorIndex: 2, place: 'after', count: 4 }),
    { skip: false, index: 3, final: 3 },
  );
  assert.deepEqual(
    bookmarkMoveArg({ sameParent: false, s: 1, anchorIndex: 1, place: 'before', count: 3 }),
    { skip: false, index: 1, final: 1 },
    'an anchor at the item\'s old index is NOT a no-op when the item comes from another folder',
  );
});

test('U-a bookmarkMoveArg: the two no-op positions skip the call and carry no index; their neighbours are real moves', () => {
  // ABCDEF, C (s = 2). Gap j means "before child j": j = 2 and j = 3 leave C where it is.
  const call = (place, anchorIndex) => bookmarkMoveArg({ sameParent: true, s: 2, anchorIndex, place, count: 6 });
  for (const r of [call('before', 2), call('before', 3), call('after', 1), call('after', 2)]) {
    assert.deepEqual(r, { skip: true, final: 2 });
  }
  assert.deepEqual(call('before', 1), { skip: false, index: 1, final: 1 });
  assert.deepEqual(call('before', 4), { skip: false, index: 4, final: 3 });
  assert.deepEqual(call('after', 0), { skip: false, index: 1, final: 1 });
  assert.deepEqual(call('after', 3), { skip: false, index: 4, final: 3 });
  // Last child to the end, first child to the start.
  assert.deepEqual(bookmarkMoveArg({ sameParent: true, s: 5, place: 'end', count: 6 }), { skip: true, final: 5 });
  assert.deepEqual(bookmarkMoveArg({ sameParent: true, s: 4, place: 'end', count: 6 }), { skip: false, index: 6, final: 5 });
  assert.deepEqual(bookmarkMoveArg({ sameParent: true, s: 0, place: 'start', count: 6 }), { skip: true, final: 0 });
  assert.deepEqual(bookmarkMoveArg({ sameParent: true, s: 1, place: 'start', count: 6 }), { skip: false, index: 0, final: 0 });
});

test('U-a bookmarkMoveArg: the position is clamped to 0..count, so a stale anchor never yields a negative index or one Chrome rejects', () => {
  for (const sameParent of [true, false]) {
    for (const place of ['before', 'after']) {
      for (const anchorIndex of [-1000, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 1000]) {
        const r = bookmarkMoveArg({ sameParent, s: 2, anchorIndex, place, count: 4 });
        if (r.skip) {
          assert.ok(!('index' in r));
        } else {
          assert.ok(Number.isInteger(r.index) && r.index >= 0 && r.index <= 4, `${sameParent} ${place} ${anchorIndex} -> ${JSON.stringify(r)}`);
        }
      }
    }
  }
  const away = (anchorIndex, place, sameParent = false) => bookmarkMoveArg({ sameParent, s: 1, anchorIndex, place, count: 4 });
  assert.deepEqual(away(-3, 'before'), { skip: false, index: 0, final: 0 });
  assert.deepEqual(away(-1, 'after'), { skip: false, index: 0, final: 0 });
  assert.deepEqual(away(9, 'before'), { skip: false, index: 4, final: 4 });
  assert.deepEqual(away(3, 'after'), { skip: false, index: 4, final: 4 });
  assert.deepEqual(bookmarkMoveArg({ sameParent: true, s: 2, anchorIndex: 9, place: 'before', count: 4 }), { skip: false, index: 4, final: 3 });
  assert.deepEqual(bookmarkMoveArg({ sameParent: true, s: 2, anchorIndex: -5, place: 'before', count: 4 }), { skip: false, index: 0, final: 0 });
});

test('U-b bookmarkMoveArg: "as the first child" needs no count, an append leaves the index out, an unknown place throws', () => {
  assert.deepEqual(bookmarkMoveArg({ sameParent: false, place: 'start' }), { skip: false, index: 0, final: 0 });
  for (const count of [0, 1, 5]) {
    assert.deepEqual(bookmarkMoveArg({ sameParent: false, s: 1, place: 'end', count }), { skip: false, final: count });
  }
  assert.throws(() => bookmarkMoveArg({ sameParent: true, s: 0, anchorIndex: 0, place: 'inside', count: 3 }), RangeError);
  assert.throws(() => bookmarkMoveArg({ sameParent: false, s: 0, anchorIndex: 0, count: 3 }), RangeError);
});

// =====================================================================================================
// resolveBookmarkDrop
// =====================================================================================================

/** A link row at depth 1, 24 px high (what the rail draws), index 3 of folder F. */
const rowModel = (over = {}) => ({
  id: 'R', parentId: 'F', index: 3, depth: 1, isFolder: false, expanded: false, hasChildren: false,
  modifiable: true, empty: false, rect: { top: 100, bottom: 124 }, ...over,
});
const folderModel = (over = {}) => rowModel({ id: 'D', isFolder: true, hasChildren: true, ...over });
/** A drag that comes from somewhere else entirely, so only the zone rules decide. */
const faraway = () => ({ id: 'X', parentId: 'ELSEWHERE', index: 0, isFolder: false, descendants: new Set() });
const drop = (hovered, pointerY, dragged = faraway(), extra = {}) => resolveBookmarkDrop({ hovered, pointerY, dragged, ...extra });
const target = (place, anchorId, parentId, extra = {}) => ({ place, anchorId, parentId, valid: true, noop: false, reason: 'ok', ...extra });
const noopTarget = (place, anchorId, parentId) => target(place, anchorId, parentId, { noop: true, reason: 'noop' });
const refused = (reason) => ({ place: null, anchorId: null, parentId: null, valid: false, noop: false, reason });

test('U-c the zone constants: a link is split 50/50, a folder 25/50/25', () => {
  assert.equal(DROP_LINK_BEFORE, 0.5);
  assert.equal(DROP_FOLDER_BEFORE, 0.25);
  assert.equal(DROP_FOLDER_AFTER, 0.25);
  assert.equal(1 - DROP_FOLDER_BEFORE - DROP_FOLDER_AFTER, 0.5, 'the middle of a folder is half of it');
});

test('U-c resolveBookmarkDrop returns exactly {place, anchorId, parentId, valid, noop, reason}', () => {
  const results = [drop(rowModel(), 101), drop(rowModel(), 101, { ...faraway(), parentId: 'F', index: 2 }), drop(null, 101), drop(rowModel({ modifiable: false }), 101)];
  for (const r of results) assert.deepEqual(Object.keys(r).sort(), ['anchorId', 'noop', 'parentId', 'place', 'reason', 'valid']);
});

test('U-c resolveBookmarkDrop: a link row is split in two, the upper half is "before" and the lower half "after"', () => {
  const link = rowModel({ id: 'L', parentId: 'F', index: 3, rect: { top: 100, bottom: 124 } });
  const before = target('before', 'L', 'F');
  const after = target('after', 'L', 'F');
  assert.deepEqual(drop(link, 100), before, 'the top edge');
  assert.deepEqual(drop(link, 111), before);
  assert.deepEqual(drop(link, 111.5), before);
  assert.deepEqual(drop(link, 112), after, 'exactly on the boundary belongs to the lower half');
  assert.deepEqual(drop(link, 123), after);
  assert.deepEqual(drop(link, 124), after, 'the bottom edge');
  assert.deepEqual(drop(link, 99), before, 'a pointer above the rect counts as its top edge');
  assert.deepEqual(drop(link, 130), after, 'a pointer below the rect counts as its bottom edge');
  // Counting whole pixels: a 24 px row gives 12 to each half, a 40 px row 20 to each.
  for (const [top, height] of [[100, 24], [0, 40], [-60, 26]]) {
    const rect = { top, bottom: top + height };
    let upper = 0;
    for (let y = top; y < top + height; y += 1) if (drop(rowModel({ rect }), y).place === 'before') upper += 1;
    assert.equal(upper, height / 2, `${height} px: ${upper} px are "before"`);
  }
});

test('U-c resolveBookmarkDrop: a folder row is split 25 / 50 / 25; every boundary belongs to the zone below it', () => {
  const folder = folderModel({ id: 'D', parentId: 'F', index: 3, rect: { top: 100, bottom: 124 }, expanded: false });
  const before = target('before', 'D', 'F');
  const inside = target('end', null, 'D');
  const after = target('after', 'D', 'F');
  assert.deepEqual(drop(folder, 100), before, 'the top edge');
  assert.deepEqual(drop(folder, 105), before);
  assert.deepEqual(drop(folder, 105.99), before);
  assert.deepEqual(drop(folder, 106), inside, 'exactly 25 % down is inside');
  assert.deepEqual(drop(folder, 112), inside);
  assert.deepEqual(drop(folder, 117.99), inside);
  assert.deepEqual(drop(folder, 118), after, 'exactly 75 % down is after');
  assert.deepEqual(drop(folder, 123), after);
  assert.deepEqual(drop(folder, 124), after, 'the bottom edge');
  assert.deepEqual(drop(folder, 90), before);
  assert.deepEqual(drop(folder, 400), after);
  // A taller row, a row with a fractional rect, and a row that is off-screen above: the same shares.
  const tall = folderModel({ rect: { top: 0, bottom: 40 } });
  assert.deepEqual([9.99, 10, 29.99, 30].map((y) => drop(tall, y).place), ['before', 'end', 'end', 'after']);
  const fractional = folderModel({ rect: { top: 10.5, bottom: 36.5 } });
  assert.deepEqual([16.9, 17, 29.9, 30].map((y) => drop(fractional, y).place), ['before', 'end', 'end', 'after'],
    '26 px: 6.5 and 19.5 px down');
  const above = folderModel({ rect: { top: -80, bottom: -56 } });
  assert.deepEqual([-80, -74.01, -74, -62.01, -62, -56].map((y) => drop(above, y).place), ['before', 'before', 'end', 'end', 'after', 'after']);
  // Counting whole pixels: a 24 px row is 6 / 12 / 6, a 40 px row 10 / 20 / 10.
  for (const [top, height, counts] of [[100, 24, [6, 12, 6]], [0, 40, [10, 20, 10]], [-60, 28, [7, 14, 7]]]) {
    const seen = { before: 0, end: 0, after: 0 };
    for (let y = top; y < top + height; y += 1) seen[drop(folderModel({ rect: { top, bottom: top + height } }), y).place] += 1;
    assert.deepEqual([seen.before, seen.end, seen.after], counts, `${height} px`);
  }
});

test('U-c resolveBookmarkDrop: depth changes nothing, except that depth 0 is a permanent folder', () => {
  const reference = [101, 112, 123].map((y) => drop(folderModel({ depth: 1 }), y));
  for (const depth of [2, 3, 7, 50]) {
    assert.deepEqual([101, 112, 123].map((y) => drop(folderModel({ depth }), y)), reference, `depth ${depth}`);
  }
  assert.deepEqual([101, 112, 123].map((y) => drop(rowModel({ depth: 9 }), y).place), ['before', 'after', 'after'], 'a link at depth 9');
});

test('U-c resolveBookmarkDrop: below a COLLAPSED folder is the sibling after it; below an EXPANDED one is inside it, first', () => {
  const collapsed = folderModel({ id: 'D', parentId: 'F', index: 3, expanded: false });
  assert.deepEqual(drop(collapsed, 123), target('after', 'D', 'F'));
  const open = folderModel({ id: 'D', parentId: 'F', index: 3, expanded: true });
  assert.deepEqual(drop(open, 123), target('start', null, 'D'), 'the first child is the row right under this one');
  // The top of an open folder is still "before it", its middle still "inside, last".
  assert.deepEqual(drop(open, 101), target('before', 'D', 'F'));
  assert.deepEqual(drop(open, 112), target('end', null, 'D'));
  // An expanded folder with nothing in it is the same: its bottom edge is inside.
  const openEmpty = folderModel({ id: 'D', parentId: 'F', index: 3, expanded: true, hasChildren: false });
  assert.deepEqual(drop(openEmpty, 123), target('start', null, 'D'));
  // A link never expands: `expanded` on a link row means nothing.
  assert.deepEqual(drop(rowModel({ id: 'L', expanded: true }), 123), target('after', 'L', 'F'));
});

test('U-c resolveBookmarkDrop: the "Empty" marker row is inside its folder wherever the pointer is on it', () => {
  const marker = folderModel({ id: 'D', parentId: 'F', index: 3, depth: 2, expanded: true, hasChildren: false, empty: true });
  for (const y of [90, 100, 101, 112, 123, 124, 130]) assert.deepEqual(drop(marker, y), target('end', null, 'D'), `y = ${y}`);
  assert.deepEqual(drop({ ...marker, rect: undefined }, NaN), target('end', null, 'D'), 'it needs no geometry');
  // The marker of an open empty permanent folder is inside it too (the root's own row refuses its edges, the marker has none).
  const rootMarker = folderModel({ id: '2', parentId: '0', index: 1, depth: 1, expanded: true, hasChildren: false, empty: true });
  assert.deepEqual(drop(rootMarker, 101), target('end', null, '2'));
  // Not modifiable: refused like any row.
  assert.deepEqual(drop({ ...marker, modifiable: false }, 112), refused('read-only'));
});

test('U-c resolveBookmarkDrop: a permanent folder row takes drops inside only, from its middle; its edges refuse', () => {
  const root = folderModel({ id: '1', parentId: '0', index: 0, depth: 0, expanded: false });
  assert.deepEqual(drop(root, 112), target('end', null, '1'));
  assert.deepEqual(drop(root, 106), target('end', null, '1'));
  assert.deepEqual(drop(root, 105.9), refused('root-edge'));
  assert.deepEqual(drop(root, 101), refused('root-edge'));
  assert.deepEqual(drop(root, 118), refused('root-edge'));
  assert.deepEqual(drop(root, 123), refused('root-edge'));
  // Open, its bottom edge is NOT "first child" as it is for other folders: nothing is written there (B7.2).
  assert.deepEqual(drop({ ...root, expanded: true }, 123), refused('root-edge'));
  assert.deepEqual(drop({ ...root, expanded: true }, 112), target('end', null, '1'));
  // The refusal is about depth 0, not about the id: the same row one level down is an ordinary folder.
  assert.deepEqual(drop({ ...root, depth: 1 }, 101), target('before', '1', '0'));
});

test('U-c resolveBookmarkDrop: a read-only row is no destination, in any zone, as a marker, or below the list; a missing flag fails closed', () => {
  const cases = [
    ['link', rowModel({ modifiable: false }), [101, 123]],
    ['folder', folderModel({ modifiable: false }), [101, 112, 123]],
    ['open folder', folderModel({ modifiable: false, expanded: true }), [101, 112, 123]],
    ['marker', folderModel({ modifiable: false, empty: true, expanded: true, hasChildren: false }), [101, 112]],
    ['permanent folder', folderModel({ modifiable: false, depth: 0, parentId: '0' }), [112]],
  ];
  for (const [what, hovered, ys] of cases) {
    for (const y of ys) assert.deepEqual(drop(hovered, y), refused('read-only'), `${what} at ${y}`);
    assert.deepEqual(drop(hovered, 5000, faraway(), { pastLast: true, allRendered: true }), refused('read-only'), `${what} below the list`);
  }
  assert.deepEqual(drop(rowModel({ modifiable: undefined }), 101), refused('read-only'), 'a row that does not say it is writable is not written to');
  // ... and the same rows are targets when the flag is true, so the refusal is about the flag.
  assert.equal(drop(rowModel(), 101).valid, true);
});

test('U-c resolveBookmarkDrop: a folder is never dropped into itself or anything under it (reason "cycle"); its own place is a no-op', () => {
  const dragged = () => ({ id: 'D', parentId: 'P', index: 2, isFolder: true, descendants: new Set(['d1', 'd2', 'd21']), siblings: 5 });
  const at = (over) => rowModel({ rect: { top: 100, bottom: 124 }, ...over });
  // On itself: before and after are where it already is; inside is a cycle.
  const self = at({ id: 'D', parentId: 'P', index: 2, isFolder: true, hasChildren: true });
  assert.deepEqual(drop(self, 101, dragged()), noopTarget('before', 'D', 'P'));
  assert.deepEqual(drop(self, 123, dragged()), noopTarget('after', 'D', 'P'));
  assert.deepEqual(drop(self, 112, dragged()), refused('cycle'));
  assert.deepEqual(drop({ ...self, expanded: true }, 123, dragged()), refused('cycle'), 'the first child of itself');
  // A direct child (a link), before and after.
  const child = at({ id: 'd1', parentId: 'D', index: 0 });
  assert.deepEqual(drop(child, 101, dragged()), refused('cycle'));
  assert.deepEqual(drop(child, 123, dragged()), refused('cycle'));
  // A direct child that is a folder: before, inside and after.
  const childFolder = at({ id: 'd2', parentId: 'D', index: 1, isFolder: true, hasChildren: true });
  for (const y of [101, 112, 123]) assert.deepEqual(drop(childFolder, y, dragged()), refused('cycle'), `d2 at ${y}`);
  // A grandchild, and its own folder's marker row.
  assert.deepEqual(drop(at({ id: 'd21', parentId: 'd2', index: 0 }), 101, dragged()), refused('cycle'));
  assert.deepEqual(drop(at({ id: 'd21', parentId: 'd2', index: 0 }), 123, dragged()), refused('cycle'));
  const ownMarker = at({ id: 'D', parentId: 'P', index: 2, isFolder: true, expanded: true, empty: true, depth: 2 });
  assert.deepEqual(drop(ownMarker, 112, dragged()), refused('cycle'));
  const innerMarker = at({ id: 'd2', parentId: 'D', index: 1, isFolder: true, expanded: true, empty: true, depth: 3 });
  assert.deepEqual(drop(innerMarker, 112, dragged()), refused('cycle'));
  // Everything else is fine: its next sibling, a folder beside it, its parent's row.
  const sibling = at({ id: 'E', parentId: 'P', index: 4, isFolder: true, hasChildren: true });
  assert.deepEqual(drop(sibling, 101, dragged()), target('before', 'E', 'P'));
  assert.deepEqual(drop(sibling, 112, dragged()), target('end', null, 'E'));
  assert.deepEqual(drop(sibling, 123, dragged()), target('after', 'E', 'P'));
  const parent = at({ id: 'P', parentId: 'G', index: 0, isFolder: true, expanded: true, hasChildren: true });
  assert.deepEqual(drop(parent, 112, dragged()), target('end', null, 'P'), 'to the end of its own folder');
  assert.deepEqual(drop(parent, 101, dragged()), target('before', 'P', 'G'), 'one level up');
  // A link can be dropped anywhere that exists: it has no descendants, and an absent set is no set.
  const link = { id: 'L9', parentId: 'P', index: 0, isFolder: false, descendants: new Set() };
  assert.deepEqual(drop(childFolder, 112, link), target('end', null, 'd2'));
  assert.deepEqual(drop(child, 101, { ...dragged(), descendants: undefined }), refused('cycle'), 'a child of the folder, found by its parent being the folder');
});

/** The B5.1 matrix at the level of the maths: 6 children, every source, every row, top and bottom half. */
function dragMatrix(kinds) {
  const names = 'ABCDEF';
  const failures = [];
  let cases = 0;
  let noops = 0;
  for (let s = 0; s < 6; s += 1) {
    const dragged = { id: names[s], parentId: 'P', index: s, isFolder: kinds[s] === 'folder', descendants: new Set(), siblings: 6 };
    for (let j = 0; j < 6; j += 1) {
      for (const half of ['top', 'bottom']) {
        const hovered = rowModel({ id: names[j], parentId: 'P', index: j, isFolder: kinds[j] === 'folder', hasChildren: kinds[j] === 'folder' });
        const gap = half === 'top' ? j : j + 1;
        const want = oracleOrder(names, s, gap);
        const r = resolveBookmarkDrop({ hovered, pointerY: half === 'top' ? 101 : 123, dragged });
        cases += 1;
        const tag = `s=${s} row ${j} ${half} (gap ${gap}) -> ${JSON.stringify(r)}`;
        if (!r.valid || r.parentId !== 'P' || r.anchorId !== names[j] || r.place !== (half === 'top' ? 'before' : 'after')) {
          failures.push(`wrong target: ${tag}`);
          continue;
        }
        if (r.noop !== (want === names)) failures.push(`noop should be ${want === names}: ${tag}`);
        if (r.noop) {
          noops += 1;
          continue;
        }
        const arg = bookmarkMoveArg({ sameParent: true, s, anchorIndex: j, place: r.place, count: 6 });
        const got = arg.skip ? names : modelOutcome(() => chromeMoveWithin(names, s, arg.index));
        if (got !== want) failures.push(`the order becomes ${got}, the oracle says ${want}: ${tag}`);
      }
    }
  }
  return { failures, cases, noops };
}

test('U-c resolveBookmarkDrop + bookmarkMoveArg: 6 sources x 12 spellings in a folder of links = the oracle, 22 no-op spellings', () => {
  const { failures, cases, noops } = dragMatrix(['link', 'link', 'link', 'link', 'link', 'link']);
  assert.equal(cases, 72);
  assert.equal(noops, 22, '12 no-op gaps of 42, spelled 22 ways: 3 + 4 + 4 + 4 + 4 + 3');
  assert.deepEqual(failures.slice(0, 5), [], `${failures.length} of ${cases} drags disagree with the oracle`);
});

test('U-c resolveBookmarkDrop + bookmarkMoveArg: the same matrix in a mixed folder (3 collapsed folders, 3 links)', () => {
  const { failures, cases, noops } = dragMatrix(['folder', 'folder', 'folder', 'link', 'link', 'link']);
  assert.equal(cases, 72);
  assert.equal(noops, 22);
  assert.deepEqual(failures.slice(0, 5), [], `${failures.length} of ${cases} drags disagree with the oracle`);
});

test('U-c resolveBookmarkDrop + bookmarkMoveArg: before / after a row at depth 1, 2 and 3 lands in THAT row\'s folder, per the oracle', () => {
  const names = 'ABCDE';
  const failures = [];
  let cases = 0;
  for (const depth of [1, 2, 3]) {
    const folderId = `F${depth}`;
    const dragged = { id: 'M', parentId: 'ELSEWHERE', index: 1, isFolder: false, descendants: new Set() };
    for (let j = 0; j < 5; j += 1) {
      for (const half of ['top', 'bottom']) {
        const hovered = rowModel({ id: `${folderId}${names[j]}`, parentId: folderId, index: j, depth });
        const gap = half === 'top' ? j : j + 1;
        const r = resolveBookmarkDrop({ hovered, pointerY: half === 'top' ? 101 : 123, dragged });
        cases += 1;
        const tag = `depth ${depth} row ${j} ${half} -> ${JSON.stringify(r)}`;
        if (!r.valid || r.noop || r.parentId !== folderId || r.anchorId !== hovered.id) {
          failures.push(`wrong target: ${tag}`);
          continue;
        }
        const arg = bookmarkMoveArg({ sameParent: false, s: dragged.index, anchorIndex: j, place: r.place, count: 5 });
        const got = modelOutcome(() => chromeInsert(names, 'M', arg.index));
        if (got !== oracleInsert(names, gap)) failures.push(`the order becomes ${got}, the oracle says ${oracleInsert(names, gap)}: ${tag}`);
      }
    }
  }
  assert.equal(cases, 30);
  assert.deepEqual(failures.slice(0, 5), [], `${failures.length} of ${cases} drags disagree`);
  // Inside a folder is an append: the move leaves the index out.
  const inside = resolveBookmarkDrop({ hovered: folderModel({ id: 'G', parentId: 'F1' }), pointerY: 112, dragged: { id: 'M', parentId: 'ELSEWHERE', index: 1, isFolder: false, descendants: new Set() } });
  assert.deepEqual(inside, target('end', null, 'G'));
  assert.ok(!('index' in bookmarkMoveArg({ sameParent: false, s: 1, place: inside.place, count: 3 })));
});

test('U-c resolveBookmarkDrop: dropping an item on its own folder is an append (a no-op when it is already last) or, below an open one, the start', () => {
  const parent = folderModel({ id: 'P', parentId: 'G', index: 4, expanded: true });
  const child = (index, over = {}) => ({ id: `c${index}`, parentId: 'P', index, isFolder: false, descendants: new Set(), siblings: 4, ...over });
  const eachChild = (y, extra) => [0, 1, 2, 3].map((i) => drop(parent, y, child(i, extra)));
  // Middle: "inside" = to the end of P. Only the last of the 4 children stays where it is.
  assert.deepEqual(eachChild(112), [
    target('end', null, 'P'), target('end', null, 'P'), target('end', null, 'P'), noopTarget('end', null, 'P'),
  ]);
  // Below an OPEN folder: "inside, first". Only the first child stays.
  assert.deepEqual(eachChild(123), [
    noopTarget('start', null, 'P'), target('start', null, 'P'), target('start', null, 'P'), target('start', null, 'P'),
  ]);
  // Without `siblings` the "already last" case cannot be seen here, and is NOT flagged (the write skips it).
  assert.deepEqual(eachChild(112, { siblings: undefined }), [0, 1, 2, 3].map(() => target('end', null, 'P')));
  // A different folder is never the same parent.
  assert.deepEqual(drop(parent, 112, child(3, { parentId: 'Q' })), target('end', null, 'P'));
});

test('U-c resolveBookmarkDrop: below the last row it appends after that row, but only when every row is rendered', () => {
  const below = (last, extra) => drop(last, 5000, faraway(), { pastLast: true, ...extra });
  const link = rowModel({ id: 'Z', parentId: 'F', index: 9 });
  assert.deepEqual(below(link, { allRendered: true }), target('after', 'Z', 'F'));
  assert.deepEqual(below(link, { allRendered: false }), refused('unrendered'));
  assert.deepEqual(below(link, {}), refused('unrendered'), 'allRendered defaults to false: no target');
  // The pointer's height is not read, only the fact that it is past the end.
  assert.deepEqual(drop(link, -10, faraway(), { pastLast: true, allRendered: true }), target('after', 'Z', 'F'));
  // A folder row last: collapsed -> after it; (a tree cut at the row limit) open -> its start.
  const folder = folderModel({ id: 'Y', parentId: 'F', index: 9 });
  assert.deepEqual(below(folder, { allRendered: true }), target('after', 'Y', 'F'));
  assert.deepEqual(below({ ...folder, expanded: true }, { allRendered: true }), target('start', null, 'Y'));
  // The "Empty" marker last: inside that folder, and only when everything is rendered (not merely "on" the marker).
  const marker = folderModel({ id: 'W', parentId: 'F', index: 9, expanded: true, hasChildren: false, empty: true, depth: 2 });
  assert.deepEqual(below(marker, { allRendered: true }), target('end', null, 'W'));
  assert.deepEqual(below(marker, { allRendered: false }), refused('unrendered'));
  assert.deepEqual(drop(marker, 112), target('end', null, 'W'), 'while ON the marker row it is inside either way');
  // A permanent folder last: nothing can go beside it.
  const root = folderModel({ id: '2', parentId: '0', index: 1, depth: 0 });
  assert.deepEqual(below(root, { allRendered: true }), refused('root-edge'));
  // The dragged row itself last: appending after it is its own place; a descendant last is a cycle.
  const lastDragged = { id: 'Z', parentId: 'F', index: 9, isFolder: false, descendants: new Set() };
  assert.deepEqual(drop(link, 5000, lastDragged, { pastLast: true, allRendered: true }), noopTarget('after', 'Z', 'F'));
  const folderDrag = { id: 'D', parentId: 'F', index: 2, isFolder: true, descendants: new Set(['Z']) };
  assert.deepEqual(drop(rowModel({ id: 'Z', parentId: 'D', index: 9 }), 5000, folderDrag, { pastLast: true, allRendered: true }), refused('cycle'));
});

test('U-c resolveBookmarkDrop: no row, no drag, or no usable geometry gives no target instead of a guess', () => {
  assert.deepEqual(drop(null, 101), refused('no-row'));
  assert.deepEqual(drop(undefined, 101), refused('no-row'));
  assert.deepEqual(resolveBookmarkDrop({ hovered: rowModel(), pointerY: 101, dragged: null }), refused('no-drag'));
  assert.deepEqual(resolveBookmarkDrop({ hovered: rowModel(), pointerY: 101 }), refused('no-drag'));
  for (const rect of [{ top: 100, bottom: 100 }, { top: 124, bottom: 100 }, undefined, null]) {
    assert.deepEqual(drop(rowModel({ rect }), 101), refused('no-geometry'), JSON.stringify(rect));
    assert.deepEqual(drop(folderModel({ rect }), 112), refused('no-geometry'), `folder ${JSON.stringify(rect)}`);
  }
  for (const y of [NaN, undefined, Infinity, '112']) assert.deepEqual(drop(rowModel(), y), refused('no-geometry'), String(y));
  assert.equal(drop(rowModel({ rect: { top: 100, bottom: 100.5 } }), 100.4).valid, true, 'a half-pixel row still has zones');
});

test('U-c resolveBookmarkDrop is O(1): it takes ONE hovered row and only ever asks the descendants set "has"', () => {
  class Watched extends Set {
    constructor(items) {
      super(items);
      this.calls = { has: 0, walk: 0 };
    }
    has(value) { this.calls.has += 1; return super.has(value); }
    [Symbol.iterator]() { this.calls.walk += 1; return super[Symbol.iterator](); }
    values() { this.calls.walk += 1; return super.values(); }
    keys() { this.calls.walk += 1; return super.keys(); }
    entries() { this.calls.walk += 1; return super.entries(); }
    forEach(...args) { this.calls.walk += 1; return super.forEach(...args); }
  }
  const ids = Array.from({ length: 5000 }, (_, i) => `r${i}`);
  const big = new Watched(ids);
  const dragged = { id: 'D', parentId: 'P', index: 2, isFolder: true, descendants: big, siblings: 5 };
  const small = { ...dragged, descendants: new Set(['r4999', 'r0']) };
  let touched = 0;
  const rows = new Proxy(ids.map((id) => ({ id, depth: 2 })), {
    get(t, p, r) { touched += 1; return Reflect.get(t, p, r); },
    has(t, p) { touched += 1; return Reflect.has(t, p); },
    ownKeys(t) { touched += 1; return Reflect.ownKeys(t); },
  });
  let calls = 0;
  for (const id of ['r0', 'r2500', 'r4999', 'elsewhere']) {
    for (const y of [101, 112, 123]) {
      const hovered = rowModel({ id, parentId: id === 'elsewhere' ? 'Q' : 'D', index: 1, isFolder: y === 112 });
      const a = resolveBookmarkDrop({ hovered, pointerY: y, dragged, rows });
      const b = resolveBookmarkDrop({ hovered, pointerY: y, dragged: small });
      calls += 1;
      if (id === 'r0' || id === 'r4999' || id === 'elsewhere') assert.deepEqual(a, b, `${id} at ${y}`);
    }
  }
  assert.equal(big.calls.walk, 0, 'the descendants set is never walked');
  assert.ok(big.calls.has <= calls * 2, `${big.calls.has} lookups for ${calls} calls`);
  assert.ok(big.calls.has > 0, 'it did use the set');
  assert.equal(touched, 0, 'a list of rows handed in is never read');
});

test('U-c resolveBookmarkDrop does not modify what it is given and answers the same twice', () => {
  const hovered = folderModel({ id: 'E', parentId: 'P', index: 4, expanded: true });
  const dragged = { id: 'D', parentId: 'P', index: 2, isFolder: true, descendants: new Set(['d1']), siblings: 5 };
  const snapshot = () => JSON.stringify([hovered, dragged, [...dragged.descendants]]);
  const before = snapshot();
  const first = drop(hovered, 123, dragged);
  assert.equal(snapshot(), before);
  assert.deepEqual(drop(hovered, 123, dragged), first);
});

// =====================================================================================================
// descendantIds
// =====================================================================================================

test('U-c descendantIds: the rows after the row that are deeper than it, up to the first that is not', () => {
  // A (0) > [B (1) > [C (2), D (2) > [E (3)]], F (1)] ; G (0) > [H (1)] ; I (0)
  const shape = [['A', 0], ['B', 1], ['C', 2], ['D', 2], ['E', 3], ['F', 1], ['G', 0], ['H', 1], ['I', 0]];
  const flat = shape.map(([id, depth]) => ({ id, depth }));
  const entries = shape.map(([id, depth]) => ({ node: { id }, depth, bar: 0 })); // what flatten() builds
  for (const rows of [flat, entries]) {
    assert.deepEqual([...descendantIds(rows, 0)], ['B', 'C', 'D', 'E', 'F']);
    assert.deepEqual([...descendantIds(rows, 1)], ['C', 'D', 'E']);
    assert.deepEqual([...descendantIds(rows, 3)], ['E']);
    assert.deepEqual([...descendantIds(rows, 6)], ['H']);
    for (const leaf of [2, 4, 5, 7, 8]) assert.equal(descendantIds(rows, leaf).size, 0, `row ${leaf} is a leaf`);
  }
  assert.ok(descendantIds(flat, 0) instanceof Set);
  for (const idx of [-1, 9, 100, undefined, NaN]) assert.equal(descendantIds(flat, idx).size, 0, `idx ${idx}`);
  assert.equal(descendantIds([], 0).size, 0);
  assert.equal(descendantIds(undefined, 0).size, 0);
});

test('U-c descendantIds: an "Empty" marker entry is not a descendant (it carries its folder\'s own node)', () => {
  // D (0) open and empty: [marker for D (1)]; E (0) > [F (1) open and empty > [marker for F (2)]]
  const rows = [
    { node: { id: 'D' }, depth: 0 }, { node: { id: 'D' }, depth: 1, empty: true },
    { node: { id: 'E' }, depth: 0 }, { node: { id: 'F' }, depth: 1 }, { node: { id: 'F' }, depth: 2, empty: true },
  ];
  assert.equal(descendantIds(rows, 0).size, 0, 'D has nothing under it, and is not its own descendant');
  assert.deepEqual([...descendantIds(rows, 2)], ['F']);
  assert.deepEqual([...descendantIds(rows, 3)], []);
  // So hovering the dragged folder's own row is its own place, not a cycle.
  const dragged = { id: 'D', parentId: 'P', index: 0, isFolder: true, descendants: descendantIds(rows, 0) };
  assert.equal(drop(rowModel({ id: 'D', parentId: 'P', index: 0, isFolder: true }), 101, dragged).reason, 'noop');
});

test('U-c descendantIds reads only the subtree, never the rest of the list', () => {
  // 5 000 rows at depth 1, except r11..r13 which are one level down: r10 has a subtree of 3 rows.
  const rows = Array.from({ length: 5000 }, (_, i) => ({ id: `r${i}`, depth: i >= 11 && i <= 13 ? 2 : 1 }));
  let reads = 0;
  const watched = new Proxy(rows, {
    get(t, p, r) {
      if (typeof p === 'string' && /^\d+$/.test(p)) reads += 1;
      return Reflect.get(t, p, r);
    },
  });
  assert.deepEqual([...descendantIds(watched, 10)], ['r11', 'r12', 'r13']);
  assert.ok(reads <= 3 + 3, `${reads} rows read for a subtree of 3`);
  reads = 0;
  assert.equal(descendantIds(watched, 4999).size, 0);
  assert.ok(reads <= 2, `${reads} rows read for the last row`);
});

// =====================================================================================================
// U-e, math half
// =====================================================================================================

test('U-e (math half): bookmark-math.js exports only pure functions and plain constants, and keeps no state', () => {
  for (const [name, value] of Object.entries(mod)) {
    assert.ok(typeof value === 'function' || (typeof value === 'number' && Number.isFinite(value)), `${name} is a ${typeof value}`);
  }
  for (const name of ['bookmarkMoveArg', 'resolveBookmarkDrop', 'descendantIds', 'placePreview']) assert.equal(typeof mod[name], 'function', name);
  const src = fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert.ok(!/^\s*export\s+(let|var|default|class|async)\b/m.test(src), 'no mutable or default export');
  assert.ok(!/^(let|var)\s/m.test(src), 'no module-level mutable binding');
  for (const hazard of ['fetch', 'XMLHttpRequest', 'setTimeout', 'setInterval', 'Date.now', 'Math.random', 'performance']) {
    assert.ok(!new RegExp(`\\b${hazard.replace('.', '\\.')}\\b`).test(src), `bookmark-math.js must not use ${hazard}`);
  }
});
