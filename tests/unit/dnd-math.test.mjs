// extension/sidepanel/dnd-math.js — pure drop-target maths
// (spec.md §9.2 as amended by spec-addendum.md A14).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { EXT } from './_load.mjs';

const file = path.join(EXT, 'sidepanel', 'dnd-math.js');
if (!fs.existsSync(file)) throw new Error('extension/sidepanel/dnd-math.js does not exist');
const mod = await import(pathToFileURL(file).href).catch(async (err) => {
  if (!/Unexpected token '?export'?|Cannot use import statement|ERR_REQUIRE_ESM/i.test(String(err && err.message))) {
    throw err;
  }
  // Mirror as .mjs when the repository root package.json is missing (see _load.mjs).
  const out = path.join(process.env.OUT_DIR || path.join(EXT, '..', 'tests', 'output'), 'esm');
  fs.mkdirSync(out, { recursive: true });
  const target = path.join(out, 'dnd-math.mjs');
  fs.writeFileSync(target, fs.readFileSync(file, 'utf8')
    .replace(/(\bfrom\s*['"])(\.\.?\/[^'"]+?)\.js(['"])/g, '$1$2.mjs$3'));
  return import(pathToFileURL(target).href);
});

const { resolveDrop, finalIndexForInsertBefore, isMultiColumn } = mod;

function rect(x, y, width, height) {
  return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height };
}

/** Vertical stack of 100 px cards, 340 px wide (a single column). */
function listItems(specs) {
  return specs.map((s, i) => ({
    tabId: s.tabId,
    pinned: !!s.pinned,
    groupId: s.groupId === undefined ? -1 : s.groupId,
    rect: rect(0, i * 100, 340, 100),
  }));
}

/** One column: the drop splits a card above/below the pointer. */
const base = { groups: [], columns: 1 };

test('finalIndexForInsertBefore compensates for removing the moving tab first', () => {
  assert.equal(finalIndexForInsertBefore(0, 3), 2);
  assert.equal(finalIndexForInsertBefore(3, 0), 0);
  assert.equal(finalIndexForInsertBefore(2, 2), 2);
  assert.equal(finalIndexForInsertBefore(5, 9), 8);
  assert.equal(finalIndexForInsertBefore(9, 5), 5);
});

test('one column: the upper half of a card inserts before it', () => {
  const items = listItems([{ tabId: 1 }, { tabId: 2 }, { tabId: 3 }]);
  const t = resolveDrop({ ...base, zone: 'list', pointerX: 100, pointerY: 120, items });
  assert.equal(t.anchorTabId, 2);
  assert.equal(t.pinned, false);
  assert.equal(t.groupId, -1);
});

test('one column: the lower half of a card inserts before the next one', () => {
  const items = listItems([{ tabId: 1 }, { tabId: 2 }, { tabId: 3 }]);
  const t = resolveDrop({ ...base, zone: 'list', pointerX: 100, pointerY: 180, items });
  assert.equal(t.anchorTabId, 3);
});

test('one column: below the last card means "append" (anchor null)', () => {
  const items = listItems([{ tabId: 1 }, { tabId: 2 }, { tabId: 3 }]);
  const below = resolveDrop({ ...base, zone: 'list', pointerX: 100, pointerY: 290, items });
  assert.equal(below.anchorTabId, null);
  assert.equal(below.pinned, false);

  const wayBelow = resolveDrop({ ...base, zone: 'list', pointerX: 100, pointerY: 900, items });
  assert.equal(wayBelow.anchorTabId, null);
});

/** Two columns of 169 px cards — the shape the panel had when `layout: 'grid'` meant 2. */
function twoColumnItems() {
  return [
    { tabId: 1, pinned: false, groupId: -1, rect: rect(0, 0, 169, 101) },
    { tabId: 2, pinned: false, groupId: -1, rect: rect(175, 0, 169, 101) },
    { tabId: 3, pinned: false, groupId: -1, rect: rect(0, 107, 169, 101) },
  ];
}

test('isMultiColumn: one column splits vertically, two or more horizontally', () => {
  assert.equal(isMultiColumn(1, undefined), false);
  assert.equal(isMultiColumn(2, undefined), true);
  assert.equal(isMultiColumn(5, undefined), true);
  // `columns` outranks the legacy alias whenever it is a usable number.
  assert.equal(isMultiColumn(1, 'grid'), false);
  assert.equal(isMultiColumn(3, 'list'), true);
  // …and the alias is the fallback when it is not.
  assert.equal(isMultiColumn(undefined, 'grid'), true);
  assert.equal(isMultiColumn(undefined, 'list'), false);
  assert.equal(isMultiColumn(0, 'grid'), true, 'a nonsense count falls back to the alias');
  assert.equal(isMultiColumn(null, 'list'), false);
});

test('several columns: the left half of a card inserts before it', () => {
  const items = twoColumnItems();
  const before = resolveDrop({ groups: [], columns: 2, zone: 'list', pointerX: 200, pointerY: 50, items });
  assert.equal(before.anchorTabId, 2);

  const after = resolveDrop({ groups: [], columns: 2, zone: 'list', pointerX: 330, pointerY: 50, items });
  assert.equal(after.anchorTabId, 3);
});

test('five columns behave the same way as two — anything above one splits on X', () => {
  const items = Array.from({ length: 5 }, (_, i) => ({
    tabId: i + 1, pinned: false, groupId: -1, rect: rect(i * 102, 0, 96, 82),
  }));
  const before = resolveDrop({ groups: [], columns: 5, zone: 'list', pointerX: 320, pointerY: 40, items });
  assert.equal(before.anchorTabId, 4, 'left half of card 4');
  const after = resolveDrop({ groups: [], columns: 5, zone: 'list', pointerX: 400, pointerY: 40, items });
  assert.equal(after.anchorTabId, 5, 'right half of card 4 → before card 5');
});

test('one column ignores X entirely: the same point means "after" on the low half', () => {
  const items = twoColumnItems();
  // Squarely in the right half of card 1 but below its middle. With several columns
  // that is "after card 1" via X; with one column the Y split has to decide instead,
  // and the two rows are what render order runs down.
  assert.equal(
    resolveDrop({ groups: [], columns: 2, zone: 'list', pointerX: 160, pointerY: 20, items }).anchorTabId, 2);
  assert.equal(
    resolveDrop({ groups: [], columns: 1, zone: 'list', pointerX: 160, pointerY: 20, items }).anchorTabId, 1,
    'upper half → before card 1');
  assert.equal(
    resolveDrop({ groups: [], columns: 1, zone: 'list', pointerX: 160, pointerY: 80, items }).anchorTabId, 2,
    'lower half → before card 2');
});

// The legacy `layout` spelling still resolves, so a caller that has not been
// updated (or a stored settings object read straight into a drop) keeps working.
test('legacy layout alias: "grid" still splits on X, "list" on Y', () => {
  const items = twoColumnItems();
  assert.equal(
    resolveDrop({ groups: [], layout: 'grid', zone: 'list', pointerX: 200, pointerY: 50, items }).anchorTabId, 2);
  assert.equal(
    resolveDrop({ groups: [], layout: 'grid', zone: 'list', pointerX: 330, pointerY: 50, items }).anchorTabId, 3);
  const listItemsRects = listItems([{ tabId: 1 }, { tabId: 2 }, { tabId: 3 }]);
  assert.equal(
    resolveDrop({ groups: [], layout: 'list', zone: 'list', pointerX: 100, pointerY: 120, items: listItemsRects })
      .anchorTabId, 2);
});

test('the pinned zone always yields a pinned, group-less target', () => {
  const tiles = [
    { tabId: 11, pinned: true, groupId: -1, rect: rect(0, 0, 34, 34) },
    { tabId: 12, pinned: true, groupId: -1, rect: rect(40, 0, 34, 34) },
    { tabId: 13, pinned: true, groupId: -1, rect: rect(80, 0, 34, 34) },
  ];
  const t = resolveDrop({ groups: [], columns: 2, zone: 'pinned', pointerX: 45, pointerY: 17, items: tiles });
  assert.equal(t.pinned, true);
  assert.equal(t.groupId, -1);
  assert.equal(t.anchorTabId, 12);

  const end = resolveDrop({ groups: [], columns: 2, zone: 'pinned', pointerX: 200, pointerY: 17, items: tiles });
  assert.equal(end.pinned, true);
  assert.equal(end.anchorTabId, null);
});

// ── addendum A14: with pinnedGrid:false pinned tabs render inline in #tablist, so
//    the pinned flag must be inferred from the drop neighbourhood, not from the zone.
test('A14 #1: dropping on the upper half of a pinned card stays pinned', () => {
  const items = listItems([
    { tabId: 1, pinned: true }, { tabId: 2, pinned: true }, { tabId: 3, pinned: false },
  ]);
  const t = resolveDrop({ ...base, zone: 'list', pointerX: 100, pointerY: 120, items });
  assert.deepEqual(
    { pinned: t.pinned, groupId: t.groupId, anchorTabId: t.anchorTabId },
    { pinned: true, groupId: -1, anchorTabId: 2 });
});

test('A14 #2: the lower half of the last pinned card resolves to the unpinned region', () => {
  const items = listItems([
    { tabId: 1, pinned: true }, { tabId: 2, pinned: true }, { tabId: 3, pinned: false },
  ]);
  const t = resolveDrop({ ...base, zone: 'list', pointerX: 100, pointerY: 180, items });
  assert.equal(t.anchorTabId, 3);
  assert.equal(t.pinned, false);
});

test('A14 #3: below every card is an unpinned append', () => {
  const items = listItems([
    { tabId: 1, pinned: true }, { tabId: 2, pinned: true }, { tabId: 3, pinned: false },
  ]);
  const t = resolveDrop({ ...base, zone: 'list', pointerX: 100, pointerY: 290, items });
  assert.equal(t.anchorTabId, null);
  assert.equal(t.pinned, false);
});

test('A14 #4: a pinned target never joins a group, even over a group body', () => {
  const items = listItems([
    { tabId: 1, pinned: true }, { tabId: 2, pinned: true, groupId: -1 }, { tabId: 3, groupId: 7 },
  ]);
  // A group body box that covers the pointer; both plausible key names are supplied
  // so the assertion does not depend on how the caller names the group id.
  const groups = [{ groupId: 7, id: 7, rect: rect(0, 0, 340, 400) }];
  const t = resolveDrop({ zone: 'list', columns: 1, pointerX: 100, pointerY: 120, items, groups });
  assert.equal(t.pinned, true);
  assert.equal(t.groupId, -1, 'a pinned tab can never have a group');
});
