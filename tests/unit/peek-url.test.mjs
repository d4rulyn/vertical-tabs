// extension/sidepanel/thumbs.js — `peekUrl()` and `keysToKeep()`, the privacy gates of the
// bookmark column.
//
// The claim under test is the one the code makes in writing: a stored preview of the normal
// profile, or of a site on the exclusion list, is never READ into a private window's document,
// and when the panel cannot tell what kind of window it is in, nothing is read either. "Read"
// is counted for real: `indexedDB.open` is replaced by a counter, and `thumb-store.js` calls it
// for every read that is attempted, so "0 opens" means the store was never asked.
//
// What this file cannot show: that a record that EXISTS comes back as `loaded` (there is no
// IndexedDB in Node). That, and `chrome.windows.getCurrent()` in a real extension page, are in
// 39-bookmark-preview.spec.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSidepanel } from './_load.mjs';

const OWN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

/** `indexedDB.open` calls: every attempt to read a stored preview ends up here. */
let opens = 0;
/** What `chrome.windows.getCurrent()` does next. */
let windowAnswer = async () => ({ id: 1, incognito: false });
let getCurrentCalls = 0;
/** Warnings the module logged, to check the decision and its reason are on the record. */
const warns = [];

globalThis.chrome = {
  runtime: { getURL: (p = '') => `${OWN}/${p}` },
  windows: {
    getCurrent: () => {
      getCurrentCalls += 1;
      return windowAnswer();
    },
  },
  i18n: { getMessage: () => '' },
};
globalThis.indexedDB = {
  open() {
    opens += 1;
    const request = {};
    // `thumb-store.js` assigns `onerror` after this returns; fail on the next microtask so the
    // module forgets its cached connection and the NEXT read calls `open` again.
    queueMicrotask(() => request.onerror && request.onerror());
    return request;
  },
};
console.warn = (...args) => { warns.push(args.map(String).join(' ')); };

const thumbs = await loadSidepanel('thumbs.js');

/**
 * A panel in the given state. `init()` itself asks the (fail-open) shared probe once, so the
 * counters are zeroed after it: what is counted from here on is the bookmark side.
 */
function panel({ window = async () => ({ id: 1, incognito: false }), excluded = [], seam } = {}) {
  windowAnswer = window;
  thumbs.init({
    getSettings: () => ({ excludedHosts: excluded }),
    getFileAccess: () => false,
    getHostAccess: () => true,
    isPolicyActive: () => false,
    ownOrigin: OWN,
    isIncognitoWindow: seam,
  });
  opens = 0;
  getCurrentCalls = 0;
  warns.length = 0;
}

const URL_A = 'https://example.com/a';

test('a private window: the verdict is incognito and the store is never opened', async () => {
  panel({ window: async () => ({ id: 1, incognito: true }) });
  const info = await thumbs.peekUrl(URL_A);
  assert.equal(info.state, 'incognito');
  assert.equal(info.blob, null);
  assert.equal(info.key, URL_A);
  assert.equal(opens, 0, 'no read was attempted');
});

test('the test seam says the same, through the same gate', async () => {
  panel({ seam: () => true });
  assert.equal((await thumbs.peekUrl(URL_A)).state, 'incognito');
  assert.equal(opens, 0);
  panel({ seam: () => false });
  assert.equal((await thumbs.peekUrl(URL_A)).state, 'none');
  assert.equal(opens, 1, 'and in a normal window the store is read');
});

test('a window that cannot be identified is treated as private: none, and nothing is read', async () => {
  const unanswerable = [
    ['getCurrent rejects', async () => { throw new Error('boom'); }],
    ['getCurrent answers with no `incognito`', async () => ({ id: 1 })],
    ['getCurrent answers with nothing', async () => undefined],
    ['`incognito` is not a boolean', async () => ({ id: 1, incognito: 'no' })],
  ];
  for (const [what, answer] of unanswerable) {
    panel({ window: answer });
    const info = await thumbs.peekUrl(URL_A);
    assert.equal(info.state, 'none', what);
    assert.equal(info.blob, null, what);
    assert.equal(info.key, URL_A, `${what}: still says which key it did not read`);
    assert.equal(opens, 0, `${what}: no read was attempted`);
    assert.ok(
      warns.some((w) => /cannot tell whether this is a private window/.test(w)),
      `${what}: the decision and its reason are logged (got ${JSON.stringify(warns)})`,
    );
  }
});

test('a failed answer is not remembered; a real one is, until init() asks again', async () => {
  let failing = true;
  panel({ window: async () => { if (failing) throw new Error('the window cannot be read'); return { incognito: false }; } });
  assert.equal((await thumbs.peekUrl(URL_A)).state, 'none', 'first: could not tell');
  assert.equal(opens, 0);
  failing = false;
  assert.equal((await thumbs.peekUrl(URL_A)).state, 'none', 'second: asked again, normal window, no record');
  assert.equal(opens, 1, 'and this time the store was read');
  const asked = getCurrentCalls;
  await thumbs.peekUrl(URL_A);
  await thumbs.keysToKeep([URL_A]);
  assert.equal(getCurrentCalls, asked, 'a real answer is remembered: no third call');

  // init() makes a new ctx, which forgets it.
  panel({ window: async () => ({ incognito: true }) });
  assert.equal((await thumbs.peekUrl(URL_A)).state, 'incognito', 'a new init() asks again');
});

test('an excluded host, and this extension\'s own panel, are refused before any read', async () => {
  panel({ excluded: ['secret.example.org', '*.wild.example.net'] });
  for (const url of ['https://secret.example.org/p', 'https://a.wild.example.net/p', 'https://wild.example.net/']) {
    const info = await thumbs.peekUrl(url);
    assert.equal(info.state, 'excluded', url);
    assert.equal(info.blob, null, url);
  }
  const own = await thumbs.peekUrl(`${OWN}/sidepanel/sidepanel.html`);
  assert.equal(own.state, 'restricted', 'the panel itself is not "turned off for this site"');
  assert.equal(opens, 0, 'none of them was read');

  assert.equal((await thumbs.peekUrl('https://notsecret.example.org/p')).state, 'none',
    'a host that merely resembles an excluded one is not excluded');
  assert.equal(opens, 1);
});

test('in a normal window the verdict order is the tab card\'s: record, restricted, policy, no access, none', async () => {
  panel();
  // A record would win over everything below; there is none here, so each of these is read once.
  for (const url of ['chrome://settings/', 'javascript:alert(1)', 'data:text/html,x', 'file:///tmp/x.html']) {
    assert.equal((await thumbs.peekUrl(url)).state, 'restricted', url);
  }
  assert.equal(opens, 4, 'each one asked the store first');
  assert.equal((await thumbs.peekUrl(URL_A)).state, 'none');

  // policy and withheld site access only speak for a page that could have been captured
  thumbs.init({ isPolicyActive: () => true });
  assert.equal((await thumbs.peekUrl(URL_A)).state, 'policy');
  assert.equal((await thumbs.peekUrl('chrome://settings/')).state, 'restricted', 'restricted outranks policy');
  thumbs.init({ isPolicyActive: () => false, getHostAccess: () => false });
  assert.equal((await thumbs.peekUrl(URL_A)).state, 'no-access');
  assert.equal((await thumbs.peekUrl('file:///tmp/x.html')).state, 'restricted',
    'restricted outranks no-access, and withheld host access is about http(s) anyway');
});

test('keysToKeep: nothing in a private window, nothing when it cannot be told, nothing for an excluded host', async () => {
  panel({ window: async () => ({ incognito: true }), excluded: ['secret.example.org'] });
  assert.deepEqual(await thumbs.keysToKeep([URL_A, 'https://other.example.com/']), [], 'private window');

  panel({ window: async () => { throw new Error('boom'); }, excluded: ['secret.example.org'] });
  assert.deepEqual(await thumbs.keysToKeep([URL_A]), [], 'cannot be told');
  assert.ok(warns.some((w) => /cannot tell whether this is a private window/.test(w)));

  panel({ excluded: ['secret.example.org'] });
  const keys = await thumbs.keysToKeep([
    URL_A,
    'https://secret.example.org/p',
    'https://other.example.com/#frag',
    'HTTPS://EXAMPLE.COM:443/a', // the same key as URL_A
    'https://user:pw@keys.example.com/x', // userinfo is not part of the key
    'not a url at all', // no key at all
    '',
  ]);
  assert.deepEqual(keys, [
    URL_A,
    'https://other.example.com/#frag',
    'https://keys.example.com/x',
  ]);
  assert.equal(opens, 0, 'deciding which to keep reads nothing');
  assert.deepEqual(await thumbs.keysToKeep([]), []);
  assert.deepEqual(await thumbs.keysToKeep(undefined), []);
});

test('keysToKeep keeps exactly the URLs peekUrl is willing to read', async () => {
  panel({ excluded: ['secret.example.org', '*.wild.example.net'] });
  const urls = [
    URL_A, 'https://secret.example.org/p', 'https://a.wild.example.net/', 'https://wild.example.net/',
    'https://notwild.example.net/', `${OWN}/sidepanel/sidepanel.html`, 'chrome://settings/',
    'javascript:alert(1)', 'not a url at all',
  ];
  const kept = new Set(await thumbs.keysToKeep(urls));
  for (const url of urls) {
    const before = opens;
    const info = await thumbs.peekUrl(url);
    const read = opens > before;
    assert.equal(kept.has(info.key), read,
      `${url}: peekUrl says ${info.state} and ${read ? 'read' : 'did not read'} the store, `
      + `keysToKeep ${kept.has(info.key) ? 'keeps' : 'drops'} it`);
  }
  assert.ok(kept.has('https://notwild.example.net/'), 'the control: something was kept');
  assert.ok(!kept.has('https://secret.example.org/p'), 'and something was not');
});
