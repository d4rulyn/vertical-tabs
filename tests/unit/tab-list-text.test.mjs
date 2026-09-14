// extension/common/tab-list-text.js — tabs out as Markdown, links back in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCommon } from './_load.mjs';

const { asMarkdown, urlsIn } = await loadCommon('tab-list-text.js');
const { BULK_OPEN_MAX } = await loadCommon('constants.js');

test('asMarkdown writes one link per tab, in panel order', () => {
  const tabs = [
    { index: 2, title: 'Gamma', url: 'https://example.com/g' },
    { index: 0, title: 'Alpha', url: 'https://example.com/a' },
    { index: 1, title: 'Beta', url: 'http://example.com/b' },
  ];
  assert.equal(asMarkdown(tabs), [
    '- [Alpha](https://example.com/a)',
    '- [Beta](http://example.com/b)',
    '- [Gamma](https://example.com/g)',
  ].join('\n'));
});

test('asMarkdown skips pages that are not links anyone can follow', () => {
  const tabs = [
    { index: 0, title: 'Settings', url: 'chrome://settings' },
    { index: 1, title: 'Blank', url: 'about:blank' },
    { index: 2, title: 'Local', url: 'file:///tmp/x.html' },
    { index: 3, title: 'Real', url: 'https://example.com/' },
  ];
  assert.equal(asMarkdown(tabs), '- [Real](https://example.com/)');
});

test('asMarkdown escapes brackets so a title cannot break the link after it', () => {
  const out = asMarkdown([{ index: 0, title: 'Bug [#12] fixed', url: 'https://example.com/x' }]);
  assert.equal(out, '- [Bug \\[#12\\] fixed](https://example.com/x)');
});

test('asMarkdown falls back to the URL when a tab has no title, and survives junk', () => {
  assert.equal(asMarkdown([{ index: 0, url: 'https://example.com/x' }]),
    '- [https://example.com/x](https://example.com/x)');
  // A navigating tab carries its destination in pendingUrl.
  assert.equal(asMarkdown([{ index: 0, title: 'Loading', pendingUrl: 'https://example.com/p' }]),
    '- [Loading](https://example.com/p)');
  for (const bad of [undefined, null, 'nope', 42, {}]) assert.equal(asMarkdown(bad), '');
  assert.equal(asMarkdown([null, undefined]), '');
});

test('urlsIn finds links in whatever shape they arrive', () => {
  const markdown = '- [One](https://a.example/1)\n- [Two](https://b.example/2)';
  assert.deepEqual(urlsIn(markdown), ['https://a.example/1', 'https://b.example/2']);

  const prose = 'see https://a.example/1, and also http://b.example/2. Thanks!';
  assert.deepEqual(urlsIn(prose), ['https://a.example/1', 'http://b.example/2'],
    'trailing sentence punctuation is not part of the URL');

  const column = 'https://a.example/1\nhttps://b.example/2\n';
  assert.deepEqual(urlsIn(column), ['https://a.example/1', 'https://b.example/2']);
});

test('urlsIn keeps the first of each duplicate and ignores everything else', () => {
  assert.deepEqual(urlsIn('https://a.example/1 https://a.example/1 https://b.example/2'),
    ['https://a.example/1', 'https://b.example/2']);
  assert.deepEqual(urlsIn('no links here at all'), []);
  assert.deepEqual(urlsIn('chrome://settings file:///tmp/x ftp://h/x'), []);
  for (const bad of [undefined, null, 42, {}, []]) assert.deepEqual(urlsIn(bad), []);
});

test('urlsIn refuses to open more than the cap in one go', () => {
  const many = Array.from({ length: BULK_OPEN_MAX + 25 }, (_, i) => `https://example.com/${i}`).join('\n');
  const found = urlsIn(many);
  assert.equal(found.length, BULK_OPEN_MAX);
  assert.equal(found[0], 'https://example.com/0', 'the cap takes the first, not a sample');
  assert.equal(urlsIn(many, 3).length, 3, 'and the cap is a parameter, not a constant to work around');
});
