// extension/common/preview-moment.js — which moment of a page a preview may show.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCommon } from './_load.mjs';

const { decidePreview, AT_TOP_PENDING } = await loadCommon('preview-moment.js');

const TOP = { atTop: true };        // a stored record that IS a picture of the header
const MIDDLE = { atTop: false };    // a stored record that is not
const OLD = {};                     // written before the setting existed
const AT_TOP = { known: true, atTop: true };
const SCROLLED = { known: true, atTop: false };
const UNKNOWN = { known: false, atTop: false };

const call = (over) => decidePreview({
  moment: 'top', reason: 'complete', manual: false, held: null, position: null, ...over,
});

test('interval mode never refuses: every capture replaces the preview', () => {
  for (const held of [null, TOP, MIDDLE, OLD]) {
    for (const position of [null, AT_TOP, SCROLLED, UNKNOWN]) {
      const v = call({ moment: 'interval', held, position });
      assert.equal(v.ok, true);
      assert.equal(v.atTop, undefined, 'and it makes no claim about what it shows');
    }
  }
});

test('reload mode replaces on a load or a manual refresh, and at no other time', () => {
  assert.equal(call({ moment: 'reload', held: TOP, reason: 'complete' }).ok, true);
  assert.equal(call({ moment: 'reload', held: TOP, reason: 'activated', manual: true }).ok, true);

  const refused = call({ moment: 'reload', held: TOP, reason: 'activated' });
  assert.equal(refused.ok, false);
  assert.equal(refused.why, 'not-a-reload');

  for (const reason of ['activated', 'before-switch', 'refresh', 'panel-opened']) {
    assert.equal(call({ moment: 'reload', held: MIDDLE, reason }).ok, false, reason);
    // Nothing stored yet: the first preview of a page is never blocked.
    assert.equal(call({ moment: 'reload', held: null, reason }).ok, true, `${reason}, nothing held`);
  }
});

test('top mode never blocks the first preview of a page', () => {
  for (const position of [null, AT_TOP, SCROLLED, UNKNOWN]) {
    const v = call({ held: null, position });
    assert.equal(v.ok, true, 'a card is never left blank waiting for someone to scroll up');
    assert.equal(v.atTop, AT_TOP_PENDING, 'and the answer is resolved alongside the capture');
  }
});

test('top mode does not protect a record that is not a picture of the top', () => {
  for (const held of [MIDDLE, OLD]) {
    for (const position of [null, AT_TOP, SCROLLED, UNKNOWN]) {
      const v = call({ held, position });
      assert.equal(v.ok, true);
      assert.equal(v.atTop, AT_TOP_PENDING);
    }
  }
});

test('top mode keeps the header when the reader has scrolled away', () => {
  const v = call({ held: TOP, position: SCROLLED });
  assert.equal(v.ok, false);
  assert.equal(v.why, 'not-at-top');
});

test('top mode takes a fresh picture when the reader is back at the top', () => {
  const v = call({ held: TOP, position: AT_TOP });
  assert.equal(v.ok, true);
  assert.equal(v.atTop, true);
});

// The regression this module was extracted for. A page that can never answer — no
// `scripting` permission, a PDF viewer, injection refused — used to keep its first
// preview forever and silently stop updating.
test('a page that cannot be asked never freezes its preview', () => {
  const v = call({ held: TOP, position: UNKNOWN });
  assert.equal(v.ok, true, 'the capture goes ahead rather than the preview freezing');
  assert.equal(v.atTop, false, 'and the record stops claiming to be a protected top shot');
  assert.equal(v.why, 'position-unknown');

  // Which also means it heals: the record is no longer protected, so the next capture
  // asks again, and a successful answer restores the claim.
  const next = call({ held: MIDDLE, position: null });
  assert.equal(next.atTop, AT_TOP_PENDING);
  assert.equal(call({ held: TOP, position: AT_TOP }).atTop, true);
});

test('an unasked protected record is captured rather than refused on no evidence', () => {
  // `position: null` means the caller has not asked yet. Refusing here would mean
  // refusing on no evidence at all.
  const v = call({ held: TOP, position: null });
  assert.equal(v.ok, true);
  assert.equal(v.atTop, AT_TOP_PENDING);
});
