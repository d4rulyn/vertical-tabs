// Shared fixture for every spec that needs `chrome.bookmarks`.
//
// Moved verbatim out of 32-bookmarks-rail.spec.js so the hover-preview specs (and the
// bookmark editing specs after them) load the SAME synthesised-grant copy of the
// extension instead of growing a second one. See the long note above the ungranted test
// in that file for why the grant has to be synthesised and what is therefore NOT tested.
'use strict';

const fs = require('fs');
const path = require('path');
const { test, expect, launchExtensionContext } = require('../fixtures');
const { setSettings, swEval } = require('./chrome');

/* ── The synthesised grant ─────────────────────────────────────────────────── */

const OUT = process.env.OUT_DIR || path.resolve(__dirname, '../output');
const SHIPPED_EXT = path.resolve(__dirname, '../../extension');

/**
 * A byte-for-byte copy of extension/ with ONE edit: `bookmarks` moves out of
 * `optional_permissions` and into `permissions`. Nothing else is touched, so the code
 * under test is the code that ships; only the answer `permissions.contains()` gives is
 * different, which is precisely the state a real user reaches by pressing Allow.
 *
 * @param {string} dir
 * @returns {string} dir
 */
function buildGrantedExtension(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(SHIPPED_EXT, dir, { recursive: true });
  const file = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!(manifest.optional_permissions || []).includes('bookmarks')) {
    throw new Error('extension/manifest.json no longer lists bookmarks as optional; '
      + 'this fixture exists to flip exactly that and has nothing to flip');
  }
  manifest.permissions = [...manifest.permissions, 'bookmarks'];
  manifest.optional_permissions = manifest.optional_permissions.filter((p) => p !== 'bookmarks');
  if (manifest.optional_permissions.length === 0) delete manifest.optional_permissions;
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

// Overriding `context` is enough: `serviceWorker`, `extensionId` and `harness` are all
// derived from it, so the whole two-window harness comes along unchanged.
const granted = test.extend({
  grantedExt: [async ({}, use, workerInfo) => {
    await use(buildGrantedExtension(path.join(OUT, `ext-bookmarks-granted-${workerInfo.workerIndex}`)));
  }, { scope: 'worker' }],

  context: async ({ headed, grantedExt }, use) => {
    const { context } = await launchExtensionContext({ headed, extDir: grantedExt });
    await use(context);
    await context.close();
  },
});

/**
 * Build a bookmark tree under the Bookmarks bar, from the service worker.
 *
 * `getChildren('0')[0]` is the bar — the same way the panel finds it, and for the same
 * reason: `folderType` and `ROOT_NODE_ID` are newer than `minimum_chrome_version: 120`.
 *
 * @param {import('@playwright/test').Worker} sw
 * @param {Array<{ title: string, url?: string, children?: Array<{title:string,url:string}> }>} spec
 */
function seedBookmarks(sw, spec) {
  return swEval(sw, async (items) => {
    const roots = await chrome.bookmarks.getChildren('0');
    const bar = roots.find((n) => !('url' in n));
    const made = {};
    for (const item of items) {
      if (item.url) {
        const node = await chrome.bookmarks.create({ parentId: bar.id, title: item.title, url: item.url });
        made[item.title] = node.id;
        continue;
      }
      const folder = await chrome.bookmarks.create({ parentId: bar.id, title: item.title });
      made[item.title] = folder.id;
      for (const child of item.children || []) {
        const node = await chrome.bookmarks.create({
          parentId: folder.id, title: child.title, url: child.url,
        });
        made[child.title] = node.id;
      }
    }
    return { barId: bar.id, ids: made };
  }, spec);
}

/** The rows on screen, in order, with what each one is. */
function rows(panel) {
  return panel.evaluate(() => [...document.querySelectorAll('[data-testid="bookmark-row"]')]
    .map((el) => ({
      id: el.dataset.bookmarkId,
      kind: el.dataset.kind,
      text: (el.querySelector('.w-row__main') || {}).textContent || '',
      open: el.dataset.openTab ? Number(el.dataset.openTab) : null,
      depth: Number(el.dataset.depth),
      bar: Number(el.dataset.bar),
      expanded: el.getAttribute('aria-expanded'),
    })));
}

/**
 * Click the first row whose main text contains `text`, case-insensitively — `hasText` is
 * a substring match, not an exact one. The click waits for the row to be actionable, NOT
 * for the repaint it starts, so every caller polls for what it expects afterwards.
 */
async function clickRow(panel, text) {
  const row = panel.locator('[data-testid="bookmark-row"]', { hasText: text })
    .filter({ has: panel.locator('.w-row__main', { hasText: text }) })
    .first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  return row;
}

/** Switch the column on and wait for the first folder to arrive. */
async function showBookmarks(panel, serviceWorker) {
  await setSettings(serviceWorker, { refreshInterval: 'off', railMode: 'bookmarks' });
  // The header, not the list: an empty folder's list box has no height, and "visible"
  // would then mean "has bookmarks in it" rather than "the column is up".
  await expect(panel.locator('[data-testid="bookmark-head"]')).toBeVisible({ timeout: 20_000 });
  await expect(panel.locator('[data-testid="bookmark-grant"]')).toHaveCount(0);
}

module.exports = {
  granted, buildGrantedExtension, seedBookmarks, rows, clickRow, showBookmarks,
};
