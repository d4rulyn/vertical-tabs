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

test('the topbar button switches the column both ways, from either side', async ({
  harness, serviceWorker,
}) => {
  test.setTimeout(180_000);
  const { panel } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });
  /* The drawer's select is the complete way to set this, and it is two levels down a
   * panel of settings. The first person to use the feature could not find it, so the
   * switch also lives in the topbar where it is always one press — and, unlike the
   * strip's own toggle, it is there in TOOLS mode too, which is the direction that had
   * no in-panel way in at all. */
  await setSettings(serviceWorker, { refreshInterval: 'off' });

  const button = panel.locator('[data-testid="rail-mode-button"]');
  await expect(button).toBeVisible({ timeout: 20_000 });
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  expect(
    await button.getAttribute('title'),
    'the label says what pressing it does, not which half it is on',
  ).toBe('Show bookmarks instead');

  await button.click();
  await expect.poll(async () => (await columnState(panel)).railMode, { timeout: 10_000 })
    .toBe('bookmarks');
  const shown = await columnState(panel);
  expect(shown.bookmarkRailHidden).toBe(false);
  expect(shown.stripHidden, 'and the tools moved to the strip').toBe(false);
  expect(shown.widgetRailHidden).toBe(true);
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  expect(await button.getAttribute('title')).toBe('Show tools instead');

  // Back again, and the tools are exactly the ones that were ticked before.
  await button.click();
  await expect.poll(async () => (await columnState(panel)).railMode, { timeout: 10_000 })
    .toBe('tools');
  const back = await columnState(panel);
  expect(back.widgetRailHidden).toBe(false);
  expect(back.bookmarkRailHidden).toBe(true);
  expect(back.stripHidden).toBe(true);
  expect(back.widgets).toEqual(shown.settingsWidgets);
  await expect(button).toHaveAttribute('aria-pressed', 'false');

  // The drawer and the button are the same setting. Asserted while the setting is
  // BOOKMARKS: `tools` is the default, so reading it there would pass even if the
  // drawer never saw the button at all.
  await button.click();
  await expect.poll(async () => (await columnState(panel)).railMode, { timeout: 10_000 })
    .toBe('bookmarks');
  await panel.locator('[data-testid="settings-button"]').click();
  await expect(panel.locator('[data-testid="settings-view"]')).toBeVisible({ timeout: 10_000 });
  await expect(panel.locator('[data-testid="settings-railMode"]')).toHaveValue('bookmarks');
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

/** The header: the column's name, and whether anything is open below it. */
function header(panel) {
  return panel.evaluate(() => {
    const title = document.querySelector('[data-testid="bookmark-title"]');
    const collapse = document.querySelector('[data-testid="bookmark-collapse"]');
    const list = document.querySelector('[data-testid="bookmark-list"]');
    return {
      name: title ? title.textContent : null,
      collapseHidden: collapse ? collapse.hidden : null,
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

granted('a folder opens in place, and closing it puts the column back', async ({
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

  // Everything shut. The roots are what a reader sees first — the bars themselves —
  // and each is a folder. This is the shape the drill-down did NOT have: it opened
  // inside the bar, so the other roots were off screen from the first frame.
  await expect.poll(async () => (await rows(panel)).length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  const shut = await rows(panel);
  expect(shut.every((row) => row.kind === 'folder'), 'the roots are all folders').toBe(true);
  expect(shut.every((row) => row.depth === 0), 'and nothing is nested yet').toBe(true);
  expect(shut.every((row) => row.expanded === 'false'), 'and nothing is open').toBe(true);
  expect(
    new Set(shut.map((row) => row.bar)).size,
    'each root gets its own stripe colour, which is what tells two "Bookmarks bar" apart',
  ).toBe(shut.length);

  const top = await header(panel);
  expect(top.name).toBe('Bookmarks');
  expect(top.listRole, 'nesting drawn in one flat DOM is still a tree to a reader').toBe('tree');
  expect(top.collapseHidden, 'nothing is open, so there is nothing to close').toBe(true);
  expect(
    await panel.evaluate(() => [...document.querySelectorAll('[data-testid="bookmark-row"]')]
      .every((el) => el.getAttribute('role') === 'treeitem' && el.getAttribute('aria-level') === '1')),
  ).toBe(true);
  expect(
    await panel.locator('[data-testid="bookmark-add"]').isDisabled(),
    'no folder is open, so there is nowhere for the tab to go',
  ).toBe(true);

  // Open the bar. Its children appear UNDER it, indented — the other roots stay put.
  await clickRow(panel, 'Bookmarks bar');
  // The bar's own children, directly beneath it and one level in. How many roots this
  // profile has is Chrome's business — what matters is that the rest of them are still
  // on screen, still shut, which is exactly what the drill-down took away.
  await expect.poll(async () => (await rows(panel)).slice(0, 3), { timeout: 10_000 })
    .toMatchObject([
      { kind: 'folder', text: 'Bookmarks bar', depth: 0, expanded: 'true' },
      { kind: 'folder', text: 'Reading', depth: 1, expanded: 'false' },
      { kind: 'link', text: 'Loose', depth: 1 },
    ]);
  const siblings = (await rows(panel)).slice(3);
  expect(siblings.length, 'the other roots did not go anywhere').toBe(shut.length - 1);
  expect(siblings.every((row) => row.depth === 0 && row.expanded === 'false')).toBe(true);
  expect((await header(panel)).collapseHidden, 'something is open now').toBe(false);

  // Open a folder inside it. Same again, one level further in, and `Loose` — which
  // comes after `Reading` in the bar — is still on screen below the expansion.
  await clickRow(panel, 'Reading');
  await expect.poll(async () => (await rows(panel)).slice(0, 5), { timeout: 10_000 })
    .toMatchObject([
      { kind: 'folder', text: 'Bookmarks bar', depth: 0 },
      { kind: 'folder', text: 'Reading', depth: 1, expanded: 'true' },
      { kind: 'link', text: 'One', depth: 2 },
      { kind: 'link', text: 'Two', depth: 2 },
      { kind: 'link', text: 'Loose', depth: 1 },
    ]);
  expect(
    (await rows(panel)).every((row) => row.bar === 0 || row.depth === 0),
    'everything nested under the first bar carries that bar\'s stripe',
  ).toBe(true);

  // Left on a child steps out to the folder holding it; Left again closes that folder.
  await panel.locator('[data-testid="bookmark-row"]', { hasText: 'One' }).first().focus();
  await panel.keyboard.press('ArrowLeft');
  await expect.poll(
    () => panel.evaluate(() => {
      const el = document.activeElement;
      const main = el && el.querySelector ? el.querySelector('.w-row__main') : null;
      return main ? main.textContent : null;
    }),
    { timeout: 10_000 },
  ).toBe('Reading');

  await panel.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await rows(panel)).slice(0, 3), { timeout: 10_000 })
    .toMatchObject([
      { kind: 'folder', text: 'Bookmarks bar', depth: 0 },
      { kind: 'folder', text: 'Reading', depth: 1, expanded: 'false' },
      { kind: 'link', text: 'Loose', depth: 1 },
    ]);
  expect((await rows(panel)).some((row) => row.text === 'One'),
    'the folder is shut, so its contents are not rendered at all').toBe(false);

  // Right opens it again, without the mouse.
  await panel.keyboard.press('ArrowRight');
  await expect.poll(async () => (await rows(panel)).some((row) => row.text === 'One'),
    { timeout: 10_000 }).toBe(true);

  // And the header button shuts the lot in one press, which is the way out of a tree
  // that has been opened several levels deep.
  await panel.locator('[data-testid="bookmark-collapse"]').click();
  await expect.poll(async () => (await rows(panel)).every((row) => row.depth === 0),
    { timeout: 10_000 }).toBe(true);
  await expect.poll(async () => (await header(panel)).collapseHidden, { timeout: 10_000 })
    .toBe(true);
  // The button hides itself on that repaint, with focus on it. Handing focus back into
  // the list is what keeps the arrow keys working; without it focus falls to <body> and
  // the column is keyboard-dead until a row is clicked.
  expect(
    await panel.evaluate(() => {
      const el = document.activeElement;
      const list = document.querySelector('[data-testid="bookmark-list"]');
      return !!(el && list && list.contains(el) && el.dataset && el.dataset.bookmarkId);
    }),
    'focus came back to a row rather than falling out of the column',
  ).toBe(true);

  // And at Chrome's own minimum panel width, with the column full. The tab list is the
  // thing the panel exists for; a side column that pushes it off the edge, or makes the
  // whole panel scroll sideways, has broken the feature it sits next to.
  await panel.setViewportSize({ width: 360, height: 720 });
  await clickRow(panel, 'Bookmarks bar');
  await expect.poll(async () => (await rows(panel)).some((row) => row.depth > 0),
    { timeout: 10_000 }).toBe(true);
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

granted('an empty folder says so, and closing one gives up the write target', async ({
  harness, serviceWorker,
}) => {
  granted.setTimeout(180_000);
  const { panel } = harness;
  await panel.setViewportSize({ width: 460, height: 900 });

  await seedBookmarks(serviceWorker, [{ title: 'Nothing here', children: [] }]);
  await showBookmarks(panel, serviceWorker);
  await clickRow(panel, 'Bookmarks bar');

  // Opening an empty folder has to look different from opening one whose read failed.
  // Rendering nothing makes the two identical, and the drill-down this replaced did say
  // "Empty" — so the line is a guarantee carried over, not a new flourish.
  await clickRow(panel, 'Nothing here');
  const marker = panel.locator('[data-testid="bookmark-folder-empty"]');
  await expect(marker).toHaveCount(1, { timeout: 10_000 });
  await expect(marker).toBeVisible();
  expect(
    await marker.getAttribute('data-bar'),
    'the marker belongs to the same bar as the folder above it',
  ).toBe('0');
  expect(
    (await rows(panel)).some((row) => row.text === ''),
    'and it is not a row: nothing to focus, open or count',
  ).toBe(false);

  // Opening the folder is what offers it as the place a bookmark would go...
  await expect.poll(
    async () => panel.locator('[data-testid="bookmark-add"]').getAttribute('title'),
    { timeout: 10_000 },
  ).toBe('Add this tab to \u201cNothing here\u201d');

  // ...and closing it withdraws the offer. The row is still on screen and still a
  // folder, so nothing but the open state can tell; leaving the target set put the one
  // write this column makes into a folder the reader had just shut.
  await clickRow(panel, 'Nothing here');
  await expect(marker).toHaveCount(0, { timeout: 10_000 });
  await expect(panel.locator('[data-testid="bookmark-add"]')).toBeDisabled({ timeout: 10_000 });
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

  // The bar holds them, so open it: the tree starts shut.
  await clickRow(panel, 'Bookmarks bar');
  await expect.poll(
    async () => (await rows(panel)).filter((row) => row.kind === 'link'),
    { timeout: 15_000 },
  ).toMatchObject([
    { kind: 'link', text: 'Alpha, already open', open: tabIds.alpha, depth: 1 },
    { kind: 'link', text: 'Never opened', open: null, depth: 1 },
  ]);

  // The dot is drawn for the one that is open and only for that one. One Map lookup per
  // row against the panel's own model: no permission, no request, no I/O.
  await expect(panel.locator('[data-testid="bookmark-open-dot"]')).toHaveCount(1);

  const before = await swEval(serviceWorker, (id) => chrome.tabs.query({ windowId: id })
    .then((ts) => ts.length), w2);

  await clickRow(panel, 'Alpha, already open');

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
  await clickRow(panel, 'Bookmarks bar');
  await expect.poll(async () => (await rows(panel)).some((row) => row.text === 'Keep'),
    { timeout: 15_000 }).toBe(true);

  await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), tabIds.beta);

  // Opening a folder is also how you say where the tab should go. Nothing is written
  // into the bar or into "Other bookmarks" just because they happen to be on screen.
  await clickRow(panel, 'Keep');
  await expect.poll(
    async () => panel.locator('[data-testid="bookmark-add"]').getAttribute('title'),
    { timeout: 10_000 },
  ).toBe('Add this tab to \u201cKeep\u201d');

  await panel.locator('[data-testid="bookmark-add"]').click();

  // The row arrives through `onCreated`, which is the same path an edit made in Chrome's
  // own bookmark manager takes — the write does not paint itself. It lands INSIDE Keep,
  // one level below it, not beside it.
  await expect.poll(
    async () => (await rows(panel)).filter((row) => row.kind === 'link' && row.depth === 2).length,
    { timeout: 10_000 },
  ).toBe(1);

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
  await clickRow(panel, 'Bookmarks bar');
  await clickRow(panel, 'Big');

  // One chunk of the WHOLE open tree, not of one folder: the rows are flattened before
  // they are cut, so the roots and the bar's other children count against the 150 too.
  await expect(panel.locator('[data-testid="bookmark-row"]')).toHaveCount(150, { timeout: 20_000 });
  const more = panel.locator('[data-testid="bookmark-more"]');
  await expect(more).toBeVisible();
  const remaining = Number(((await more.textContent()) || '').replace(/\D+/g, ''));
  expect(remaining, 'the button says how many rows are still to come').toBeGreaterThan(0);

  // Not one of the 170 is missing from the model — they are just not built yet.
  expect(
    (await rows(panel)).filter((row) => row.text.startsWith('Item ')).length,
    'the first chunk is items, not a placeholder',
  ).toBeGreaterThan(0);

  await panel.evaluate(() => {
    const rail = document.getElementById('bookmark-rail');
    rail.scrollTop = rail.scrollHeight;
  });

  await expect(panel.locator('[data-testid="bookmark-row"]'))
    .toHaveCount(150 + remaining, { timeout: 20_000 });
  await expect(more).toBeHidden();
  expect(
    (await rows(panel)).filter((row) => row.text.startsWith('Item ')).length,
    'and every item is there once the list has grown',
  ).toBe(total);
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
  await clickRow(panel, 'Bookmarks bar');
  await expect.poll(async () => (await rows(panel)).filter((row) => row.kind === 'link'),
    { timeout: 15_000 }).toMatchObject([{ text: 'Stays' }, { text: 'Goes' }]);

  // Deleted from outside the panel entirely — this is what Chrome's bookmark manager,
  // a sync, or another window looks like from in here. The listener lives in the PANEL
  // (the service worker cannot register `bookmarks.on*` while the permission is
  // optional and ungranted), and a burst of them is one repaint.
  await swEval(serviceWorker, (id) => chrome.bookmarks.remove(id), seeded.ids.Goes);

  await expect.poll(async () => (await rows(panel)).filter((row) => row.kind === 'link'),
    { timeout: 10_000 }).toMatchObject([{ text: 'Stays' }]);
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
  await clickRow(panel, 'Bookmarks bar');
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
  await clickRow(panel, 'Bookmarks bar');
  await expect.poll(async () => (await rows(panel)).filter((row) => row.kind === 'link'),
    { timeout: 15_000 }).toMatchObject([{ text: 'Before' }]);

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
