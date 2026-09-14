// 16-excluded-purge — "Never capture previews on these sites" has to remove what was
// ALREADY captured for that host, not merely stop capturing from now on.
//
// README.md ("Privacy") promises the setting keeps a site "out of the cache entirely",
// and a user typically adds their bank AFTER visiting it, so the screenshot that matters
// is the one already on disk. Excluding a host therefore deletes its stored previews and
// tells open panels to release the object URLs they are holding.
//
// The fixture server binds to 127.0.0.1 only, so the "other host" that must SURVIVE the
// purge is seeded straight into the store rather than served — the purge reads its hosts
// off the stored keys, so a seeded record exercises exactly the same path.
'use strict';

const { test, expect } = require('../fixtures');
const {
  swEval, createTab, keyOf, waitForThumb, setSettings,
} = require('../helpers/chrome');

/** A record for a host the fixture server does not serve, written like the SW writes. */
const OTHER_KEY = 'https//keep.example/page';

/** Every stored preview key, read straight out of the extension's IndexedDB. */
function storedKeys(sw) {
  return swEval(sw, () => new Promise((resolve) => {
    const open = indexedDB.open('vertical-tabs');
    open.onerror = () => resolve([]);
    open.onsuccess = () => {
      const req = open.result.transaction('thumbs').objectStore('thumbs').getAllKeys();
      req.onsuccess = () => resolve(req.result.map(String));
      req.onerror = () => resolve([]);
    };
  }));
}

function seedThumb(sw, urlKey) {
  return swEval(sw, (key) => new Promise((resolve) => {
    const open = indexedDB.open('vertical-tabs');
    open.onerror = () => resolve(false);
    open.onsuccess = () => {
      const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' });
      const now = Date.now();
      const tx = open.result.transaction('thumbs', 'readwrite');
      tx.objectStore('thumbs').put({
        urlKey: key, blob, bytes: blob.size, capturedAt: now, lastUsedAt: now,
        width: 640, height: 240,
      });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    };
  }), urlKey);
}

test('excluding a host deletes the previews already captured for it', async ({
  harness, serviceWorker, fixtures,
}) => {
  test.setTimeout(150_000);
  const { panel, w2 } = harness;
  await setSettings(serviceWorker, { refreshInterval: 'off', excludedHosts: [] });

  const secretUrl = fixtures.page('884400', 'Secret');
  const secretKey = await keyOf(panel, secretUrl);
  const secretTab = await createTab(serviceWorker, w2, secretUrl, { active: true });
  await waitForThumb(panel, secretKey, { timeout: 40_000 });
  expect(await seedThumb(serviceWorker, OTHER_KEY)).toBe(true);

  const before = await storedKeys(serviceWorker);
  expect(before).toContain(secretKey);
  expect(before).toContain(OTHER_KEY);

  // The open panel is showing the very image we are about to revoke.
  const secretThumb = panel.locator(`[data-tab-id="${secretTab}"] .thumb`);
  await expect(secretThumb).toHaveClass(/thumb--loaded/, { timeout: 15_000 });

  // ── exclude only the served host
  await setSettings(serviceWorker, { excludedHosts: ['127.0.0.1'] });

  await expect
    .poll(async () => (await storedKeys(serviceWorker)).includes(secretKey),
      { timeout: 20_000 })
    .toBe(false);

  // A purge, not a cache wipe: the unrelated host keeps its preview.
  expect(await storedKeys(serviceWorker)).toContain(OTHER_KEY);

  // The panel released the blob rather than holding a URL to deleted data.
  await expect(secretThumb).not.toHaveClass(/thumb--loaded/, { timeout: 15_000 });
});
