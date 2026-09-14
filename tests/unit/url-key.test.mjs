// extension/common/url-key.js — pure URL keying and classification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCommon } from './_load.mjs';

const { urlKey, classifyUrl } = await loadCommon('url-key.js');

test('urlKey returns null for anything that is not a usable URL', () => {
  assert.equal(urlKey(''), null);
  assert.equal(urlKey(null), null);
  assert.equal(urlKey(undefined), null);
  assert.equal(urlKey('not a url'), null);
  assert.equal(urlKey('   '), null);
});

test('urlKey lower-cases the scheme and host but keeps the path case', () => {
  const key = urlKey('HTTP://Example.COM/AbC');
  assert.ok(key.includes('example.com'), key);
  assert.ok(!/Example\.COM/.test(key), key);
  assert.ok(key.includes('AbC'), key);
  assert.notEqual(urlKey('https://a.test/AbC'), urlKey('https://a.test/abc'));
});

test('urlKey drops the default port but keeps a custom one', () => {
  assert.equal(urlKey('http://a.test:80/x'), urlKey('http://a.test/x'));
  assert.equal(urlKey('https://a.test:443/x'), urlKey('https://a.test/x'));
  assert.notEqual(urlKey('http://a.test:8080/x'), urlKey('http://a.test/x'));
});

test('urlKey keeps the query and the fragment (hash-routed SPAs are different pages)', () => {
  assert.notEqual(urlKey('https://a.test/p?q=1'), urlKey('https://a.test/p?q=2'));
  assert.notEqual(urlKey('https://a.test/#/one'), urlKey('https://a.test/#/two'));
  assert.ok(urlKey('https://a.test/#/one').includes('#/one'));
});

test('urlKey is capped at 2048 characters', () => {
  const key = urlKey('https://a.test/' + 'x'.repeat(6000));
  assert.ok(key.length <= 2048, `length ${key.length}`);
});

test('classifyUrl: ordinary web pages are capturable', () => {
  assert.equal(classifyUrl('https://a.test/'), 'ok');
  assert.equal(classifyUrl('http://127.0.0.1:8080/page'), 'ok');
});

test('classifyUrl: empty, about: and browser-internal URLs are restricted', () => {
  for (const url of [
    '', '   ', 'about:blank', 'about:newtab', 'chrome://version', 'chrome://newtab/',
    'chrome-untrusted://x', 'devtools://devtools/bundled/x.html', 'data:text/html,<p>hi',
    'blob:https://a.test/1234', 'javascript:void(0)', 'view-source:https://a.test/',
    'edge://settings', 'not a url',
  ]) {
    assert.equal(classifyUrl(url), 'restricted', `expected 'restricted' for ${JSON.stringify(url)}`);
  }
});

test('classifyUrl: the Chrome Web Store needs activeTab, on both origins', () => {
  assert.equal(classifyUrl('https://chromewebstore.google.com/'), 'restricted');
  assert.equal(classifyUrl('https://chromewebstore.google.com/detail/abc'), 'restricted');
  assert.equal(classifyUrl('https://chrome.google.com/webstore/detail/abc'), 'restricted');
  assert.equal(classifyUrl('https://chrome.google.com/other'), 'ok');
});

test('classifyUrl: file: depends on the "allow access to file URLs" toggle', () => {
  assert.equal(classifyUrl('file:///tmp/x.html', { fileAccess: false }), 'restricted');
  assert.equal(classifyUrl('file:///tmp/x.html', { fileAccess: true }), 'ok');
  assert.equal(classifyUrl('file:///tmp/x.html'), 'restricted');
});

test('classifyUrl: our own pages are excluded, other extensions are restricted', () => {
  const ownOrigin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/';
  assert.equal(
    classifyUrl('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/sidepanel/sidepanel.html', { ownOrigin }),
    'excluded');
  assert.equal(
    classifyUrl('chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/page.html', { ownOrigin }),
    'restricted');
  assert.equal(classifyUrl('chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/page.html'), 'restricted');
});

test('classifyUrl: excluded hosts win over "ok", exactly and with wildcards', () => {
  assert.equal(classifyUrl('https://bank.example/', { excludedHosts: ['bank.example'] }), 'excluded');
  assert.equal(classifyUrl('https://www.bank.example/', { excludedHosts: ['bank.example'] }), 'ok');
  assert.equal(classifyUrl('https://www.bank.example/', { excludedHosts: ['*.bank.example'] }), 'excluded');
  assert.equal(classifyUrl('https://bank.example/', { excludedHosts: ['*.bank.example'] }), 'excluded');
  assert.equal(classifyUrl('https://BANK.example/', { excludedHosts: ['bank.example'] }), 'excluded');
  assert.equal(classifyUrl('https://other.test/', { excludedHosts: ['bank.example'] }), 'ok');
  // An excluded host never turns a restricted URL into 'excluded' by accident.
  assert.equal(classifyUrl('chrome://version', { excludedHosts: ['version'] }), 'restricted');
});
