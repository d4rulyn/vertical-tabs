// What `thumb-store.touch()` asks of IndexedDB, counted rather than timed. Shared by probe 98b and spec 43.
//
// The counter is the transaction recorder in helpers/bookmark-preview.js (`installStoreRecorder`), which wraps
// `IDBDatabase.transaction`, `IDBObjectStore.get` and `.put` in the panel, so it sees what `thumb-store.js`
// really asks of the database whichever module asked.
'use strict';

const { expect } = require('../fixtures');
const {
  setSettings, keyOf, waitForThumb, activateTab,
} = require('./chrome');

/**
 * Let the panel finish its own store traffic before anything is counted or timed. The transaction recorder checks
 * itself against the real store with an exact list of four transactions, so a read the panel makes meanwhile (the
 * refresh after the service worker's first capture of the active tab) would fail that check for a reason that has
 * nothing to do with `touch()`; and a probe that times the store wants nothing else writing to it. Periodic
 * re-captures are turned off for the same reason. Needs the two-window harness.
 * @param {{panel: import('@playwright/test').Page, tabIds: {alpha: number}, urls: {alpha: string}}} harness
 * @param {import('@playwright/test').Worker} serviceWorker
 */
async function settled(harness, serviceWorker) {
  const { panel, tabIds, urls } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off' });
  const alphaKey = await keyOf(panel, urls.alpha);
  await activateTab(serviceWorker, tabIds.alpha);
  await waitForThumb(panel, alphaKey, { timeout: 40_000 });
  await expect(panel.locator(`[data-testid="tab-card"][data-tab-id="${tabIds.alpha}"] .thumb`))
    .toHaveClass(/thumb--loaded/, { timeout: 15_000 });
}

/**
 * Import `common/thumb-store.main.js` into the panel as `window.__mainStore`.
 *
 * That file is NOT in the repository. Probe 98b's launcher copies origin/main's `thumb-store.js` next to the real
 * one, byte for byte, so that one page can run the unchanged `touch()` and the tree's `touch()` side by side
 * against the same database. Both files' SHA-256 are read back through `fetch`, i.e. what the browser really
 * loaded, so a caller can check the copy against the file it claims to be.
 * @param {import('@playwright/test').Page} panel
 * @returns {Promise<{mainSha: string, ownSha: string}>}
 */
function loadMainStore(panel) {
  return panel.evaluate(async () => {
    const hex = async (url) => {
      const bytes = await (await fetch(url)).arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    };
    const mainUrl = chrome.runtime.getURL('common/thumb-store.main.js');
    const ownUrl = chrome.runtime.getURL('common/thumb-store.js');
    window.__mainStore = await import(mainUrl);
    return { mainSha: await hex(mainUrl), ownSha: await hex(ownUrl) };
  });
}

/**
 * Call `touch(keys, now)` of one of the two stores and report the read-write transactions that call opened on
 * its keys: how many `get`s and `put`s each carried and the `lastUsedAt` of every record put. The recorder must
 * already be installed. A transaction counts as the call's own only when every key it read is one of `keys`, so
 * the panel's own `touchDisplayed()` and reads cannot be mistaken for it.
 * @param {import('@playwright/test').Page} panel
 * @param {'fix'|'main'} arm 'fix' = the tree's own module, 'main' = `window.__mainStore` (see `loadMainStore`)
 * @param {string[]} keys
 * @param {number} now
 * @returns {Promise<{ret: string, txs: Array<{gets: number, puts: number, stamps: number[]}>}>}
 */
function countedTouch(panel, arm, keys, now) {
  return panel.evaluate(async (a) => {
    const rec = window.__idb;
    if (!rec) throw new Error('install the store recorder before counting');
    const touch = a.arm === 'main' ? window.__mainStore.touch : window.__vt.thumbStore.touch;
    const before = rec.seq;
    const ret = await touch(a.keys, a.now);
    const want = new Set(a.keys);
    const mine = rec.tx.filter((t) => t.n > before && t.mode === 'readwrite' && t.keys.length > 0
      && t.keys.every((k) => want.has(k)));
    return {
      ret: ret === undefined ? 'undefined' : String(ret),
      txs: mine.map((t) => ({ gets: t.gets, puts: t.puts, stamps: t.stamps })),
    };
  }, { arm, keys, now });
}

/**
 * Fisher's exact test, one-sided: given `a` of `nA` cycles stalled in arm A and `b` of `nB` in arm B, the chance
 * of a split at least as lopsided towards A when the stalls fall on the cycles at random.
 * P(X >= a), X hypergeometric (population nA + nB, `a + b` successes, nA draws).
 * @returns {number}
 */
function fisherOneSided(a, nA, b, nB) {
  const logFact = (n) => {
    let s = 0;
    for (let i = 2; i <= n; i += 1) s += Math.log(i);
    return s;
  };
  const logC = (n, k) => logFact(n) - logFact(k) - logFact(n - k);
  const total = nA + nB;
  const successes = a + b;
  let p = 0;
  for (let x = a; x <= Math.min(nA, successes); x += 1) {
    if (nA - x > total - successes) continue;
    p += Math.exp(logC(successes, x) + logC(total - successes, nA - x) - logC(total, nA));
  }
  return Math.min(1, p);
}

module.exports = { settled, loadMainStore, countedTouch, fisherOneSided };
