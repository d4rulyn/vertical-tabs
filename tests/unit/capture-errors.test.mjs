// extension/common/capture-errors.js — pure substring classification of the exact
// Chromium error strings (spec.md §4.2 as amended by spec-addendum.md A7a).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCommon } from './_load.mjs';

const { classifyCaptureError } = await loadCommon('capture-errors.js');

const CASES = [
  // quota — measured verbatim in the probe
  ['This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.', 'quota'],

  // readback / transient rendering failures
  ['Failed to capture tab: image readback failed', 'readback'],
  ['Failed to capture tab: view is invisible', 'readback'],
  ['Failed to capture tab: encoding failed', 'readback'],
  ['Failed to capture tab: internal error', 'readback'],

  // host access withheld — same text for a withheld host and for about:blank,
  // so capture.js refines it by URL scheme (A7b); the pure function says host-access.
  ['Cannot access contents of url "https://example.test/". Extension manifest must request permission to access this host.', 'host-access'],
  ['Cannot access contents of url "". Extension manifest must request permission to access this host.', 'host-access'],
  ['Extension manifest must request permission to access this host.', 'host-access'],

  // permanently restricted pages
  ["The 'activeTab' permission is not in effect because this extension has not been in invoked.", 'restricted'],
  ['Cannot access a chrome:// URL', 'restricted'],
  ['This page cannot be scripted due to an ExtensionsSettings policy.', 'restricted'],

  // administrator policy
  ['Taking screenshots has been disabled', 'policy'],
  ['Administrator policy prevents this action', 'policy'],

  // a native tab drag is in progress
  ['Tabs cannot be edited right now (user may be dragging a tab).', 'dragging'],

  // the tab or window disappeared
  ['No active web contents to capture', 'gone'],
  ['No window with id: 42.', 'gone'],
  ['No current window', 'gone'],
  ['No tab with id: 17.', 'gone'],

  // anything else
  ['Something entirely new happened', 'unknown'],
  ['', 'unknown'],
];

for (const [message, expected] of CASES) {
  test(`classifyCaptureError(${JSON.stringify(message.slice(0, 60))}) === ${expected}`, () => {
    assert.equal(classifyCaptureError(message), expected);
  });
}

test('classifyCaptureError never throws on non-strings', () => {
  assert.equal(classifyCaptureError(undefined), 'unknown');
  assert.equal(classifyCaptureError(null), 'unknown');
  assert.equal(classifyCaptureError(123), 'unknown');
});

test('the quota class is the only one that is safe to retry immediately', () => {
  // Guards against a future re-ordering that would swallow the quota message inside
  // the broader "Cannot access" branch.
  assert.equal(
    classifyCaptureError('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.'),
    'quota');
});
