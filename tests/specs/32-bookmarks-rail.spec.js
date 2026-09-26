// 32-bookmarks-rail — the bookmark rail, and the promise that turning it on is the
// only thing that turns it on.
//
// The extension is already published, so an update reaches profiles that never asked
// for bookmarks. `bookmarks` is therefore an OPTIONAL permission, the new
// `settings.railMode` defaults to `tools`, and nothing in the panel changes until the
// user chooses otherwise. The first test in this file is the proof of exactly that,
// and it stays first: every later test here adds a way to turn the feature ON, and
// this one is the one that says the OFF state is still the shipped one.
//
// HALF THIS FILE RUNS AGAINST A MODIFIED COPY OF THE EXTENSION. Everything declared with
// `granted(...)` rather than `test(...)` loads a copy of `extension/` whose manifest asks
// for `bookmarks` in the required `permissions` array, because Playwright cannot answer
// Chrome's own permission bubble. The act of granting is therefore NOT tested here and
// cannot be; the full reasoning, and the manual release gate that covers it, are in the
// banner above `buildGrantedExtension()`.
'use strict';

const fs = require('fs');
const path = require('path');
const { test, expect, launchExtensionContext } = require('../fixtures');
const { setSettings, sleep, swEval } = require('../helpers/chrome');

// `DEFAULTS.widgets` from extension/common/settings-schema.js, in order. Written out
// rather than imported because the specs are CommonJS and the schema is an ES module
// the browser loads; the order is the assertion, so it is spelled out on purpose.
const DEFAULT_TOOLS = Object.freeze([
  'sessions', 'recent', 'windows', 'autoGroup', 'duplicates', 'staleTabs', 'scratchpad',
]);

test('an update changes nothing on a profile that never asked for bookmarks', async ({
  harness,
}) => {
  test.setTimeout(180_000);
  const { panel } = harness;

  /* Ported from 22-widgets ("every tool mounts, and none of them touches the
   * network"): only real egress counts, so the panel's own document, its `blob:`
   * previews and its `chrome-extension://…/_favicon/` icons are not requests that
   * leave the machine. The bookmark work must not change this, and the favicon route
   * it will use is the same in-process one the cards already use. */
  const requests = [];
  const onRequest = (req) => {
    const url = req.url();
    if (/^https?:/i.test(url)) requests.push(url);
  };
  panel.on('request', onRequest);

  // Nothing new on screen. The bookmark rail is a SEPARATE sibling of `#widget-rail`
  // inside `#main-row`, and on a profile still in `tools` mode it is hidden, empty and
  // costs nothing: the column is the tool rail's, to the pixel.
  //
  // This read `toHaveCount(0)` while the markup did not exist yet. The element is part
  // of `sidepanel.html` from the geometry stage on, so "absent" stopped being a thing
  // the OFF state could promise; what it does promise — that a profile which never
  // asked for bookmarks sees exactly what it saw before — is measured instead, and a
  // rail that was shown, filled or merely given width would now fail three ways.
  expect(
    await panel.evaluate(() => {
      const rail = document.getElementById('bookmark-rail');
      return {
        present: Boolean(rail),
        hidden: rail ? rail.hidden : null,
        children: rail ? rail.childElementCount : null,
        width: rail ? Math.round(rail.getBoundingClientRect().width) : null,
      };
    }),
    'the bookmark rail exists in the markup and does nothing at all',
  ).toEqual({ present: true, hidden: true, children: 0, width: 0 });

  // The tool rail is untouched: the seven default tools, in DEFAULTS.widgets order.
  await expect
    .poll(
      () => panel.evaluate(() => {
        const rail = document.getElementById('widget-rail');
        return [...rail.querySelectorAll('[data-widget]')].map((w) => w.dataset.widget);
      }),
      { timeout: 15_000 },
    )
    .toEqual([...DEFAULT_TOOLS]);

  // The new setting exists and is off. A default of 'bookmarks' would hide every tool
  // above on a profile that never asked for one.
  expect(await panel.evaluate(() => window.__vt.settings.railMode)).toBe('tools');

  // `bookmarks` is optional and ungranted: measured (probe-results.md Probe 7) to leave
  // `chrome.bookmarks` undefined in both the panel and the service worker.
  expect(
    await panel.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] })),
    'a fresh profile has not granted the optional bookmarks permission',
  ).toBe(false);

  await sleep(2000);
  panel.off('request', onRequest);
  expect(requests, `the panel must not fetch: ${requests.join(', ')}`).toEqual([]);
});

/* Everything below turns the feature ON. Each test starts from the same fresh profile
 * the one above describes and writes `railMode` itself, so the OFF state stays the
 * default the first test measures. */

/** What the panel is showing, read in one round trip. */
function columnState(panel) {
  return panel.evaluate(() => {
    const widgetRail = document.getElementById('widget-rail');
    const bookmarkRail = document.getElementById('bookmark-rail');
    const strip = document.getElementById('tool-strip');
    return {
      widgetRailHidden: widgetRail.hidden,
      widgets: [...widgetRail.querySelectorAll('[data-widget]')].map((w) => w.dataset.widget),
      widgetRailWidth: Math.round(widgetRail.getBoundingClientRect().width),
      bookmarkRailHidden: bookmarkRail.hidden,
      bookmarkRailWidth: Math.round(bookmarkRail.getBoundingClientRect().width),
      bookmarkRailChildren: bookmarkRail.childElementCount,
      stripHidden: strip.hidden,
      tools: [...strip.querySelectorAll('[data-tool]')].map((b) => b.dataset.tool),
      settingsWidgets: [...window.__vt.settings.widgets],
      railMode: window.__vt.settings.railMode,
      overflows: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
}

test('bookmarks mode gives the column to the bookmarks and the tools to the strip', async ({
  harness, serviceWorker,
}) => {
  test.setTimeout(180_000);
  const { panel } = harness;
  await panel.setViewportSize({ width: 360, height: 720 });
  await setSettings(serviceWorker, { refreshInterval: 'off', railMode: 'bookmarks' });

  await expect.poll(async () => (await columnState(panel)).railMode, { timeout: 10_000 })
    .toBe('bookmarks');
  await expect.poll(async () => (await columnState(panel)).stripHidden, { timeout: 10_000 })
    .toBe(false);
  const shown = await columnState(panel);

  // The column is the bookmark rail now — on screen, and the same width the tool rail
  // had. It holds exactly one thing, the permission card: on a profile that has not
  // granted `bookmarks` there is nothing else it could honestly show, and it must not
  // show an empty column either (the state this used to assert, back when the rail was
  // a container with no code behind it).
  expect(shown.bookmarkRailHidden).toBe(false);
  expect(shown.bookmarkRailChildren, 'the rail holds the grant card and nothing else').toBe(1);
  expect(shown.bookmarkRailWidth, 'and it takes the column').toBeGreaterThan(120);
  await expect(panel.locator('[data-testid="bookmark-grant"]')).toBeVisible();
  await expect(panel.locator('[data-testid="bookmark-list"]')).toHaveCount(0);

  // The tool rail is gone the way an empty widget list has always made it go.
  expect(shown.widgetRailHidden).toBe(true);
  expect(shown.widgets).toEqual([]);
  expect(shown.widgetRailWidth, 'a hidden rail takes no width').toBe(0);

  // Only one column: two rails' worth of 184 px would push the tab list out.
  expect(shown.overflows, 'the panel never scrolls sideways').toBe(false);

  // The tools moved, they were not turned off. The strip's order IS settings.widgets.
  expect(shown.tools).toEqual([...DEFAULT_TOOLS]);
  expect(shown.settingsWidgets, 'the ticked tools are untouched').toEqual([...DEFAULT_TOOLS]);

  // Each button is named after its tool rather than after its position.
  const scratchpad = panel.locator('[data-testid="tool-scratchpad"]');
  await expect(scratchpad).toHaveAttribute('aria-label', 'Notes');
  await expect(scratchpad).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(scratchpad).toHaveAttribute('aria-expanded', 'false');
});

test('a tool opens in the sheet, Escape closes it and focus comes back', async ({
  harness, serviceWorker,
}) => {
  test.setTimeout(180_000);
  const { panel } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });
  await setSettings(serviceWorker, { refreshInterval: 'off', railMode: 'bookmarks' });

  const button = panel.locator('[data-testid="tool-scratchpad"]');
  await expect(button).toBeVisible({ timeout: 15_000 });
  const sheet = panel.locator('[data-testid="tool-sheet"]');
  await expect(sheet).toBeHidden();

  await button.click();
  await expect(sheet).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  // The widget really mounted, into the sheet and not into the rail.
  await expect(sheet.locator('[data-testid="widget-scratchpad-text"]')).toBeVisible();
  expect(await panel.evaluate(() => ({
    inRail: document.querySelectorAll('#widget-rail [data-widget="scratchpad"]').length,
    inSheet: document.querySelectorAll('#tool-sheet [data-widget="scratchpad"]').length,
  }))).toEqual({ inRail: 0, inSheet: 1 });

  await panel.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  expect(
    await panel.evaluate(() => document.activeElement && document.activeElement.dataset.testid),
    'focus goes back to the button that opened the sheet (spec-addendum A15.5)',
  ).toBe('tool-scratchpad');
  // Nothing is left running: the widget came out with the sheet, and it was never in
  // the rail to begin with. (Scoped to the two hosts: the settings drawer puts
  // `data-widget` on its checkboxes too, once it has been opened.)
  expect(await panel.evaluate(() => document.querySelectorAll(
    '#tool-sheet [data-widget], #widget-rail [data-widget]').length)).toBe(0);
});

test('closing the sheet keeps the last thing typed in the scratchpad', async ({
  harness, serviceWorker,
}) => {
  test.setTimeout(180_000);
  const { panel } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });
  await setSettings(serviceWorker, { refreshInterval: 'off', railMode: 'bookmarks' });

  const button = panel.locator('[data-testid="tool-scratchpad"]');
  await expect(button).toBeVisible({ timeout: 15_000 });
  await button.click();

  const text = panel.locator('[data-testid="widget-scratchpad-text"]');
  await expect(text).toBeVisible();
  // Typed and closed inside the widget's 400 ms save debounce: the commit has to come
  // from the teardown, which is the thing that would be skipped if the sheet mount
  // shared `widgets.js`'s rail map and got torn down by the wrong code path.
  const note = 'sheet round trip';
  await text.fill(note);
  await panel.keyboard.press('Escape');
  await expect(panel.locator('[data-testid="tool-sheet"]')).toBeHidden();

  // The edit reached storage. Polled rather than slept on: the assertion IS that the
  // write happens, so waiting for the write is waiting for the thing under test.
  await expect.poll(
    () => panel.evaluate(() => chrome.storage.local.get('scratchpad').then((s) => s.scratchpad)),
    { timeout: 10_000 },
  ).toBe(note);

  // And it comes back the next time the sheet is opened.
  await button.click();
  await expect(panel.locator('[data-testid="widget-scratchpad-text"]')).toHaveValue(note);
});

test('the mode switch flips the column both ways and the tools come back', async ({
  harness, serviceWorker,
}) => {
  test.setTimeout(180_000);
  const { panel } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });
  // A set that is NOT the default, and not in WIDGET_IDS order either: what has to
  // survive the round trip is the user's own list, order included.
  const mine = ['scratchpad', 'sessions', 'nowPlaying'];
  await setSettings(serviceWorker, {
    refreshInterval: 'off', railMode: 'bookmarks', widgets: mine,
  });

  await expect.poll(async () => (await columnState(panel)).tools, { timeout: 15_000 })
    .toEqual(mine);

  // Back to the tools, from the strip rather than from four clicks into the drawer.
  await panel.locator('[data-testid="rail-mode-toggle"]').click();
  await expect.poll(async () => (await columnState(panel)).railMode, { timeout: 10_000 })
    .toBe('tools');
  const back = await columnState(panel);
  expect(back.widgets, 'the tools are back in the column, in the order the user chose').toEqual(mine);
  expect(back.widgetRailHidden).toBe(false);
  expect(back.stripHidden, 'and the strip costs nothing again').toBe(true);
  expect(back.bookmarkRailHidden).toBe(true);
  expect(back.settingsWidgets).toEqual(mine);

  // And out again through the drawer, which is the way in.
  await panel.locator('[data-testid="settings-button"]').click();
  await expect(panel.locator('[data-testid="settings-view"]')).toBeVisible({ timeout: 10_000 });
  await panel.locator('[data-testid="settings-railMode"]').selectOption('bookmarks');
  await panel.locator('[data-testid="settings-close"]').click();

  await expect.poll(async () => (await columnState(panel)).stripHidden, { timeout: 10_000 })
    .toBe(false);
  const again = await columnState(panel);
  expect(again.tools).toEqual(mine);
  expect(again.widgets).toEqual([]);
  expect(again.bookmarkRailHidden).toBe(false);
  expect(again.settingsWidgets, 'nothing rewrote the ticked tools').toEqual(mine);
});

test('with every tool unticked the strip is still the way back out of bookmarks', async ({
  harness, serviceWorker,
}) => {
  test.setTimeout(180_000);
  const { panel } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });
  // The README advertises unticking them all as the way to hide the column, and the
  // settings help text says so too. Doing that and then choosing bookmarks must not also
  // remove the only in-panel way back: the strip carries no tools here, but it still has
  // to carry the switch.
  await setSettings(serviceWorker, {
    refreshInterval: 'off', railMode: 'bookmarks', widgets: [],
  });

  const toggle = panel.locator('[data-testid="rail-mode-toggle"]');
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  const shown = await columnState(panel);
  expect(shown.stripHidden, 'the strip is on screen for the switch alone').toBe(false);
  expect(shown.tools, 'and it carries no tools, because none are ticked').toEqual([]);
  expect(shown.bookmarkRailHidden).toBe(false);

  await toggle.click();
  await expect.poll(async () => (await columnState(panel)).railMode, { timeout: 10_000 })
    .toBe('tools');
  const back = await columnState(panel);
  expect(back.stripHidden, 'and in tools mode the strip costs nothing again').toBe(true);
  expect(back.widgetRailHidden, 'no tool is ticked, so the column goes entirely').toBe(true);
  expect(back.bookmarkRailHidden).toBe(true);
  expect(back.overflows, 'the panel never scrolls sideways').toBe(false);
});

test('Escape closes the sheet even when the tool inside it has nothing to focus', async ({
  harness, serviceWorker,
}) => {
  test.setTimeout(180_000);
  const { panel } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });
  // `nowPlaying` with nothing audible mounts two plain `<div>`s and no control at all, so
  // focus stays on the strip button that opened the sheet — which is OUTSIDE
  // `#tool-sheet`, where the sheet's own keydown handler never sees the key.
  await setSettings(serviceWorker, {
    refreshInterval: 'off', railMode: 'bookmarks', widgets: ['nowPlaying'],
  });

  const button = panel.locator('[data-testid="tool-nowPlaying"]');
  await expect(button).toBeVisible({ timeout: 15_000 });
  await button.click();
  const sheet = panel.locator('[data-testid="tool-sheet"]');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-testid="widget-now-playing-empty"]')).toBeVisible();

  expect(
    await panel.evaluate(() => document.querySelectorAll(
      '#tool-sheet button, #tool-sheet input, #tool-sheet select, #tool-sheet textarea,'
      + ' #tool-sheet [href], #tool-sheet [tabindex]:not([tabindex="-1"])').length),
    'the premise of this test: the open tool really does offer nothing to focus',
  ).toBe(0);
  expect(
    await panel.evaluate(() => document.activeElement && document.activeElement.dataset.testid),
    'so focus is still on the strip button, outside the sheet',
  ).toBe('tool-nowPlaying');

  await panel.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
});

test('flipping back to tools while a tool is open moves it and keeps the last edit', async ({
  harness, serviceWorker,
}) => {
  test.setTimeout(180_000);
  const { panel } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });
  await setSettings(serviceWorker, {
    refreshInterval: 'off', railMode: 'bookmarks', widgets: ['scratchpad'],
  });

  const button = panel.locator('[data-testid="tool-scratchpad"]');
  await expect(button).toBeVisible({ timeout: 15_000 });
  await button.click();
  const text = panel.locator('#tool-sheet [data-testid="widget-scratchpad-text"]');
  await expect(text).toBeVisible();

  // The flip comes from a SETTINGS WRITE, not from a pointer: clicking into the drawer
  // would close the sheet on the way through `onDocumentPointerDown`, and this is the
  // path that does not. `widgets.apply()`'s mount loop is then the only thing standing
  // between "the sheet's copy is torn down" and "two copies of the same widget are live
  // with two debounces writing over each other" (widgets.js, the `unmountOne(id)` before
  // `build()`). Written from the panel so the whole thing lands inside the scratchpad's
  // 400 ms save debounce — the commit under test is the teardown's, not the timer's.
  const note = 'flipped mid-edit';
  await text.fill(note);
  await panel.evaluate(async () => {
    const stored = (await chrome.storage.local.get('settings')).settings || {};
    await chrome.storage.local.set({ settings: { ...stored, railMode: 'tools' } });
  });

  await expect.poll(
    () => panel.evaluate(() => ({
      inRail: document.querySelectorAll('#widget-rail [data-widget="scratchpad"]').length,
      inSheet: document.querySelectorAll('#tool-sheet [data-widget]').length,
    })),
    { timeout: 10_000 },
  ).toEqual({ inRail: 1, inSheet: 0 });

  // The edit reached storage from the teardown, and — because that teardown ran BEFORE
  // the rail's copy was built — the rail's copy read it back rather than the stale value.
  // Both halves are what the ordering in `widgets.js` buys; the second is the one that
  // silently stops being true if the sheet's copy is torn down afterwards instead.
  await expect.poll(
    () => panel.evaluate(() => chrome.storage.local.get('scratchpad').then((s) => s.scratchpad)),
    { timeout: 10_000 },
  ).toBe(note);
  await expect(panel.locator('#widget-rail [data-testid="widget-scratchpad-text"]'))
    .toHaveValue(note, { timeout: 10_000 });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The column itself.
 *
 * Two halves, and the line between them matters. The test directly below runs on the
 * SHIPPED extension, where `bookmarks` is optional and ungranted — the state every
 * install starts in. Everything after it runs against a SYNTHESISED GRANT: a copy of
 * extension/ in tests/output/ whose manifest.json asks for `bookmarks` in the required
 * `permissions` array, so Chrome hands it over at load time.
 *
 * That copy exists because Playwright cannot answer Chrome's own permission bubble.
 * Measured (.agent/probe-results.md Probe 7): a `permissions.request()` fired from a
 * real trusted click in this harness stays pending for the full 30-second budget,
 * headless and under a real X server alike, while the identical call for a permission
 * with no warning (`alarms`) resolves in 6 ms. The prompt is simply never answered.
 *
 * So: the act of granting is NOT tested here and cannot be. What is tested is the
 * ungranted UI, and the behaviour of the column once the permission exists. Saying so
 * in the file is the difference between a test and a lie — and it is why
 * `.agent/resume.md` carries a manual check on real Chrome as a release gate.
 * ──────────────────────────────────────────────────────────────────────────── */

test('ungranted, the column asks for the permission and reads nothing', async ({
  harness, serviceWorker,
}) => {
  test.setTimeout(180_000);
  const { panel } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });

  // Installed BEFORE the feature is switched on, so it is watching from the moment the
  // module is imported. A getter rather than a spy: ungranted, `chrome.bookmarks` is
  // measured to be `undefined`, so there is no object to wrap — but reading the
  // property at all is exactly what the code must not do, and a getter sees that.
  const watching = await panel.evaluate(() => {
    window.__bookmarkTouches = 0;
    try {
      Object.defineProperty(chrome, 'bookmarks', {
        configurable: true,
        enumerable: true,
        get() {
          window.__bookmarkTouches += 1;
          return undefined;
        },
      });
    } catch {
      return false;
    }
    const d = Object.getOwnPropertyDescriptor(chrome, 'bookmarks');
    return Boolean(d && typeof d.get === 'function');
  });
  expect(watching, 'the probe must be able to watch chrome.bookmarks, or it proves nothing')
    .toBe(true);

  await setSettings(serviceWorker, { refreshInterval: 'off', railMode: 'bookmarks' });

  const card = panel.locator('[data-testid="bookmark-grant"]');
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText('Bookmarks need your permission first');
  const button = panel.locator('[data-testid="bookmark-grant-button"]');
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  await expect(button).toHaveText('Allow bookmarks');

  // The escape hatch is a second thought, not the first thing offered: it appears only
  // after the in-panel prompt has gone unanswered.
  await expect(panel.locator('[data-testid="bookmark-grant-pending"]')).toBeHidden();

  // No listing was built, and no folder was read to decide that.
  await expect(panel.locator('[data-testid="bookmark-list"]')).toHaveCount(0);
  await expect(panel.locator('[data-testid="bookmark-row"]')).toHaveCount(0);

  expect(
    await panel.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] })),
    'the permission really is absent — otherwise the count below proves nothing',
  ).toBe(false);

  await sleep(1500);
  expect(
    await panel.evaluate(() => window.__bookmarkTouches),
    'the ungranted column must not so much as look at chrome.bookmarks',
  ).toBe(0);
});

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
    })));
}

/** The header: the folder's own name, and the whole path behind it. */
function header(panel) {
  return panel.evaluate(() => {
    const title = document.querySelector('[data-testid="bookmark-title"]');
    const back = document.querySelector('[data-testid="bookmark-back"]');
    const list = document.querySelector('[data-testid="bookmark-list"]');
    return {
      name: title ? title.textContent : null,
      path: title ? title.getAttribute('title') : null,
      backHidden: back ? back.hidden : null,
      listRole: list ? list.getAttribute('role') : null,
    };
  });
}

/** Switch the column on and wait for the first folder to arrive. */
async function showBookmarks(panel, serviceWorker) {
  await setSettings(serviceWorker, { refreshInterval: 'off', railMode: 'bookmarks' });
  // The header, not the list: an empty folder's list box has no height, and "visible"
  // would then mean "has bookmarks in it" rather than "the column is up".
  await expect(panel.locator('[data-testid="bookmark-head"]')).toBeVisible({ timeout: 20_000 });
  await expect(panel.locator('[data-testid="bookmark-grant"]')).toHaveCount(0);
}

granted('a folder opens, and every way back comes home again', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(180_000);
  const { panel } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });

  /* The same watcher the first test in this file runs, but with the OTHER half of the
   * single purpose on screen. `22-widgets.spec.js` makes the "no network requests at all"
   * promise for the tools; it runs in the default `tools` layout and never reaches this
   * column, so a bookmark row's favicon was covered by nothing. Rows draw their icons from
   * `chrome-extension://<id>/_favicon/`, which Chrome answers in-process, so the only
   * thing this can catch is a fetch that should never have been written. */
  const requests = [];
  const onRequest = (req) => {
    const url = req.url();
    if (/^https?:/i.test(url)) requests.push(url);
  };
  panel.on('request', onRequest);

  await seedBookmarks(serviceWorker, [
    { title: 'Reading', children: [
      { title: 'One', url: 'https://one.example.com/a' },
      { title: 'Two', url: 'https://two.example.com/b' },
    ] },
    { title: 'Loose', url: 'https://loose.example.com/c' },
  ]);
  await showBookmarks(panel, serviceWorker);

  // The bar, one level deep. A folder first, then a link — creation order, as Chrome
  // returned it, not an order this file invented.
  await expect.poll(() => rows(panel), { timeout: 15_000 })
    .toMatchObject([{ kind: 'folder', text: 'Reading' }, { kind: 'link', text: 'Loose' }]);

  const bar = await header(panel);
  expect(bar.name).toBe('Bookmarks bar');
  expect(bar.listRole, 'a flat list per level is a listbox, not a tree').toBe('listbox');
  expect(bar.backHidden, 'the roots are one level above the bar, so back is live').toBe(false);
  expect(
    await panel.evaluate(() => [...document.querySelectorAll('[data-testid="bookmark-row"]')]
      .every((el) => el.getAttribute('role') === 'option')),
  ).toBe(true);

  // In with the mouse.
  await panel.locator('[data-testid="bookmark-row"]').first().click();
  await expect.poll(() => rows(panel), { timeout: 10_000 })
    .toMatchObject([{ kind: 'link', text: 'One' }, { kind: 'link', text: 'Two' }]);
  const inside = await header(panel);
  expect(inside.name).toBe('Reading');
  expect(inside.path, 'the breadcrumb is walked up with get(parentId), not read off a tree')
    .toBe('Bookmarks bar / Reading');

  // Out with the Left arrow.
  await panel.keyboard.press('ArrowLeft');
  await expect.poll(() => rows(panel), { timeout: 10_000 })
    .toMatchObject([{ kind: 'folder', text: 'Reading' }, { kind: 'link', text: 'Loose' }]);
  expect((await header(panel)).name).toBe('Bookmarks bar');

  // In with the keyboard: focus is on the first row after coming back.
  await panel.keyboard.press('ArrowRight');
  await expect.poll(() => rows(panel), { timeout: 10_000 })
    .toMatchObject([{ kind: 'link', text: 'One' }, { kind: 'link', text: 'Two' }]);

  // Out with the button.
  await panel.locator('[data-testid="bookmark-back"]').click();
  await expect.poll(() => rows(panel), { timeout: 10_000 })
    .toMatchObject([{ kind: 'folder', text: 'Reading' }, { kind: 'link', text: 'Loose' }]);

  // And up again to the roots, where "Other bookmarks" lives and nothing can be written.
  await panel.locator('[data-testid="bookmark-back"]').click();
  await expect.poll(async () => (await header(panel)).backHidden, { timeout: 10_000 }).toBe(true);
  expect(await panel.locator('[data-testid="bookmark-add"]').isDisabled()).toBe(true);
  expect(
    (await rows(panel)).every((row) => row.kind === 'folder'),
    'the bookmark roots are all folders',
  ).toBe(true);

  // And at Chrome's own minimum panel width, with the column full. The tab list is the
  // thing the panel exists for; a side column that pushes it off the edge, or makes the
  // whole panel scroll sideways, has broken the feature it sits next to.
  await panel.setViewportSize({ width: 360, height: 720 });
  await panel.locator('[data-testid="bookmark-row"]').first().click();
  await expect.poll(async () => (await rows(panel)).length, { timeout: 10_000 })
    .toBeGreaterThan(0);
  const narrow = await panel.evaluate(() => ({
    overflows: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    listWidth: Math.round(document.getElementById('tablist').getBoundingClientRect().width),
    railWidth: Math.round(document.getElementById('bookmark-rail').getBoundingClientRect().width),
    cards: document.querySelectorAll('#tablist .tab-card').length,
  }));
  expect(narrow.overflows, 'the panel never scrolls sideways').toBe(false);
  expect(narrow.railWidth, 'the column keeps its width').toBeGreaterThan(120);
  expect(narrow.listWidth, 'and the tab list keeps the rest').toBeGreaterThan(120);
  expect(narrow.cards, 'the tabs are still listed beside it').toBeGreaterThan(0);

  panel.off('request', onRequest);
  expect(
    requests,
    `the bookmark column must not fetch: ${requests.join(', ')}`,
  ).toEqual([]);
});

granted('a bookmark already open activates that tab instead of opening a second copy', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(180_000);
  const { panel, w2, tabIds, urls } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });

  // Gamma is the active tab in W2 (it was created last); alpha is open and not active.
  await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), tabIds.gamma);

  await seedBookmarks(serviceWorker, [
    { title: 'Alpha, already open', url: urls.alpha },
    { title: 'Never opened', url: 'https://nowhere.example.com/x' },
  ]);
  await showBookmarks(panel, serviceWorker);

  await expect.poll(() => rows(panel), { timeout: 15_000 }).toMatchObject([
    { kind: 'link', text: 'Alpha, already open', open: tabIds.alpha },
    { kind: 'link', text: 'Never opened', open: null },
  ]);

  // The dot is drawn for the one that is open and only for that one. One Map lookup per
  // row against the panel's own model: no permission, no request, no I/O.
  await expect(panel.locator('[data-testid="bookmark-open-dot"]')).toHaveCount(1);

  const before = await swEval(serviceWorker, (id) => chrome.tabs.query({ windowId: id })
    .then((ts) => ts.length), w2);

  await panel.locator('[data-testid="bookmark-row"]').first().click();

  await expect.poll(
    () => swEval(serviceWorker, (id) => chrome.tabs.query({ active: true, windowId: id })
      .then((ts) => (ts[0] ? ts[0].url : '')), w2),
    { timeout: 10_000 },
  ).toBe(urls.alpha);

  const after = await swEval(serviceWorker, (id) => chrome.tabs.query({ windowId: id })
    .then((ts) => ts.length), w2);
  expect(after, 'the page was already open, so no second copy of it was made').toBe(before);
});

granted('the one write puts the active tab in the folder on screen', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(180_000);
  const { panel, tabIds } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });

  const seeded = await seedBookmarks(serviceWorker, [
    { title: 'Keep', children: [] },
  ]);
  await showBookmarks(panel, serviceWorker);
  await expect.poll(() => rows(panel), { timeout: 15_000 })
    .toMatchObject([{ kind: 'folder', text: 'Keep' }]);

  await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), tabIds.beta);

  // Into the folder that is on screen — not the bar, not "Other bookmarks".
  await panel.locator('[data-testid="bookmark-row"]').first().click();
  await expect(panel.locator('[data-testid="bookmark-empty"]')).toBeVisible({ timeout: 10_000 });

  await panel.locator('[data-testid="bookmark-add"]').click();

  // The row arrives through `onCreated`, which is the same path an edit made in Chrome's
  // own bookmark manager takes — the write does not paint itself.
  await expect.poll(() => rows(panel), { timeout: 10_000 }).toHaveLength(1);
  await expect(panel.locator('[data-testid="bookmark-empty"]')).toBeHidden();

  const stored = await swEval(serviceWorker, (folderId) => chrome.bookmarks.getChildren(folderId)
    .then((kids) => kids.map((k) => ({ title: k.title, url: k.url }))), seeded.ids.Keep);
  expect(stored).toHaveLength(1);
  expect(stored[0].url, 'the active tab of the window this panel drives').toContain('title=Beta');
});

granted('a long folder arrives in chunks and grows as it is scrolled', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(240_000);
  const { panel } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });

  // 170 > the 150-row chunk. Measured: one folder can hold 5 000 children at 100 ms and
  // 995 KB, and rendering that in one pass is the hole this closes.
  const total = 170;
  const big = await swEval(serviceWorker, async (n) => {
    const roots = await chrome.bookmarks.getChildren('0');
    const bar = roots.find((r) => !('url' in r));
    const folder = await chrome.bookmarks.create({ parentId: bar.id, title: 'Big' });
    for (let i = 0; i < n; i += 1) {
      await chrome.bookmarks.create({
        parentId: folder.id,
        title: `Item ${String(i).padStart(3, '0')}`,
        url: `https://bulk.example.com/${i}`,
      });
    }
    return folder.id;
  }, total);
  expect(big).toBeTruthy();

  await showBookmarks(panel, serviceWorker);
  await panel.locator('[data-testid="bookmark-row"]').first().click();

  // Exactly one chunk, and the count of what is still to come.
  await expect(panel.locator('[data-testid="bookmark-row"]')).toHaveCount(150, { timeout: 20_000 });
  const more = panel.locator('[data-testid="bookmark-more"]');
  await expect(more).toBeVisible();
  await expect(more).toHaveText(`${total - 150} more`);

  await panel.evaluate(() => {
    const rail = document.getElementById('bookmark-rail');
    rail.scrollTop = rail.scrollHeight;
  });

  await expect(panel.locator('[data-testid="bookmark-row"]')).toHaveCount(total, { timeout: 20_000 });
  await expect(more).toBeHidden();
});

granted('a bookmark deleted anywhere else leaves the column', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(180_000);
  const { panel } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });

  const seeded = await seedBookmarks(serviceWorker, [
    { title: 'Stays', url: 'https://stays.example.com/1' },
    { title: 'Goes', url: 'https://goes.example.com/2' },
  ]);
  await showBookmarks(panel, serviceWorker);
  await expect.poll(() => rows(panel), { timeout: 15_000 })
    .toMatchObject([{ text: 'Stays' }, { text: 'Goes' }]);

  // Deleted from outside the panel entirely — this is what Chrome's bookmark manager,
  // a sync, or another window looks like from in here. The listener lives in the PANEL
  // (the service worker cannot register `bookmarks.on*` while the permission is
  // optional and ungranted), and a burst of them is one repaint.
  await swEval(serviceWorker, (id) => chrome.bookmarks.remove(id), seeded.ids.Goes);

  await expect.poll(() => rows(panel), { timeout: 10_000 }).toMatchObject([{ text: 'Stays' }]);
});

granted('the bookmark column does not impersonate a tab card', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(180_000);
  const { panel, urls } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });

  // Including a row that IS keyed to an open tab: that is the row most likely to have
  // been given `data-tab-id` by someone reaching for the obvious attribute.
  await seedBookmarks(serviceWorker, [
    { title: 'Alpha, already open', url: urls.alpha },
    { title: 'A folder', children: [{ title: 'Inside', url: 'https://inside.example.com/' }] },
  ]);
  await showBookmarks(panel, serviceWorker);
  await expect(panel.locator('[data-testid="bookmark-open-dot"]')).toHaveCount(1, { timeout: 15_000 });

  // Ported verbatim from 22-widgets.spec.js:103-118, which says the same thing about the
  // tools column. `data-tab-id` means "this element IS the card for that tab"; a second
  // owner makes every `[data-tab-id="…"]` lookup in the panel match two nodes and breaks
  // rendering, events and drag-and-drop at once.
  const counts = await panel.evaluate(() => ({
    withAttribute: document.querySelectorAll('[data-tab-id]').length,
    cardsAndTiles: document.querySelectorAll('.tab-card, .pinned-tile').length,
    offenders: [...document.querySelectorAll('[data-tab-id]')]
      .filter((el) => !el.matches('.tab-card, .pinned-tile'))
      .map((el) => el.className || el.tagName),
  }));
  expect(counts.offenders, 'only cards and pinned tiles carry data-tab-id').toEqual([]);
  expect(counts.withAttribute).toBe(counts.cardsAndTiles);

  // What the rows carry instead.
  expect(await panel.evaluate(() => document.querySelectorAll('[data-bookmark-id]').length))
    .toBeGreaterThan(0);
});

granted('losing the permission returns the card and leaves the layout alone', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(180_000);
  const { panel } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });

  const seeded = await seedBookmarks(serviceWorker, [
    { title: 'Before', url: 'https://before.example.com/1' },
  ]);
  await showBookmarks(panel, serviceWorker);
  await expect.poll(() => rows(panel), { timeout: 15_000 }).toMatchObject([{ text: 'Before' }]);

  // A real revoke cannot be staged: this fixture makes `bookmarks` a REQUIRED permission
  // so that Chrome grants it at load, and `permissions.remove()` refuses a required one.
  // What is staged instead is precisely the state a revoke leaves behind, and it is the
  // single most surprising thing the probe found (.agent/probe-results.md, Probe 7):
  // `chrome.bookmarks` STAYS a live object whose every call throws, while
  // `permissions.contains()` has already turned false. Gating on `if (chrome.bookmarks)`
  // would sail straight past this; gating on `contains()` is what catches it.
  await panel.evaluate(() => {
    chrome.permissions.contains = () => Promise.resolve(false);
    const gone = (name) => () => Promise.reject(
      new Error(`'bookmarks.${name}' is not available in this context.`));
    chrome.bookmarks.getChildren = gone('getChildren');
    chrome.bookmarks.get = gone('get');
  });

  // How a panel that has just lost the permission finds out: something changes in the
  // tree, the repaint calls through, and the call throws.
  await swEval(serviceWorker, (id) => chrome.bookmarks.create({
    parentId: id, title: 'After', url: 'https://after.example.com/2',
  }), seeded.barId);

  await expect(panel.locator('[data-testid="bookmark-grant"]')).toBeVisible({ timeout: 15_000 });
  await expect(panel.locator('[data-testid="bookmark-grant-button"]')).toBeEnabled();
  await expect(panel.locator('[data-testid="bookmark-list"]')).toHaveCount(0);
  await expect(panel.locator('[data-testid="bookmark-row"]')).toHaveCount(0);

  // The invariant the whole design rests on. Taking the permission away must not also
  // take away the layout the user chose: rewriting `railMode` here would be the extension
  // quietly undoing something they did, and the way back would be a trip into the drawer
  // rather than the button that is now on screen.
  expect(await panel.evaluate(() => window.__vt.settings.railMode)).toBe('bookmarks');
  expect(
    await panel.evaluate(() => chrome.storage.local.get('settings').then((s) => s.settings.railMode)),
    'and nothing wrote it back to disk either',
  ).toBe('bookmarks');
  expect(
    await panel.evaluate(() => document.getElementById('bookmark-rail').hidden),
    'the column is still the bookmarks column; it just has nothing to show yet',
  ).toBe(false);
});
