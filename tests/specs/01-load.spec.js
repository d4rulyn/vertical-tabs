// 01-load — the extension loads unpacked in new headless, exposes the documented
// manifest surface, and the side panel really opens/closes (addendum A22).
'use strict';

const { test, expect } = require('../fixtures');
const { swEval, diagnostics, shot } = require('../helpers/chrome');

// Pinned so a permission cannot creep in unnoticed. `scripting` was added deliberately
// for `previewMoment: 'top'` (spec-addendum A30): reading `window.scrollY` is the only
// way to know whether a preview would be of the page header or of its middle. Adding to
// this list is a decision, not a formality — both READMEs carry it in the permissions
// table, where they previously listed `scripting` among the permissions NOT requested.
const EXPECTED_PERMISSIONS = [
  'sidePanel', 'tabs', 'tabGroups', 'sessions', 'storage', 'unlimitedStorage', 'favicon',
  'alarms', 'scripting',
];

test('manifest, panel behaviour and alarms are as specified', async ({ serviceWorker, extensionId }) => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);

  const manifest = await swEval(serviceWorker, () => chrome.runtime.getManifest());

  // __MSG_…__ placeholders must have been resolved by chrome.i18n.
  expect(manifest.name).not.toMatch(/__MSG_/);
  expect(manifest.description).not.toMatch(/__MSG_/);
  expect(manifest.name.length).toBeGreaterThan(0);

  expect(manifest.manifest_version).toBe(3);
  expect(manifest.minimum_chrome_version).toBe('120');
  expect([...manifest.permissions].sort()).toEqual([...EXPECTED_PERMISSIONS].sort());
  expect(manifest.host_permissions).toEqual(['<all_urls>']);
  expect(manifest.side_panel.default_path).toBe('sidepanel/sidepanel.html');
  expect(manifest.background.service_worker).toBe('background/service-worker.js');
  expect(manifest.background.type).toBe('module');
  expect(manifest.options_ui.page).toBe('welcome/welcome.html');
  expect(Object.keys(manifest.commands).sort()).toEqual(['_execute_action', 'search-tabs']);
  // `description` on _execute_action is ignored by Chrome and must not be present.
  expect(manifest.commands._execute_action.description).toBeUndefined();

  const behavior = await swEval(serviceWorker, () => chrome.sidePanel.getPanelBehavior());
  expect(behavior.openPanelOnActionClick).toBe(true);

  const options = await swEval(serviceWorker, () => chrome.sidePanel.getOptions({}));
  expect(options.enabled).toBe(true);
  expect(options.path.endsWith('sidepanel/sidepanel.html')).toBe(true);

  const commands = await swEval(serviceWorker, () => chrome.commands.getAll());
  const names = commands.map((c) => c.name).sort();
  expect(names).toEqual(['_execute_action', 'search-tabs']);

  // The action tooltip carries the CURRENT binding, never a hard-coded one (A16).
  const execShortcut = (commands.find((c) => c.name === '_execute_action') || {}).shortcut || '';
  await expect.poll(async () => {
    const t = await swEval(serviceWorker, () => chrome.action.getTitle({}));
    return typeof t === 'string' && t.length > 0 && !t.includes('__MSG_')
      && (!execShortcut || t.includes(execShortcut));
  }, {
    timeout: 15_000,
    message: 'chrome.action.setTitle({ title }) must run at every service worker start and carry the current binding',
  }).toBe(true);

  // Both alarms are created during service-worker start, and `vt-refresh` needs the
  // settings read first, so it lands strictly later than `vt-maintenance`. Reading
  // `getAll()` once raced that: measured 2026-09-30, one read failed in 3 of 6 runs on
  // BOTH main and the branch under test. Polling is not a relaxation — both names are
  // still required, and the timeout still fails a worker that never registers them —
  // it removes the assumption that the read and the registration are ordered.
  await expect.poll(async () => swEval(serviceWorker, async () =>
    (await chrome.alarms.getAll()).map((a) => a.name).sort()), {
    timeout: 15_000,
    message: 'the service worker registers both alarms at start; the default refreshInterval is 1m',
  }).toEqual(['vt-maintenance', 'vt-refresh']);

  const alarms = await swEval(serviceWorker, async () =>
    (await chrome.alarms.getAll()).map((a) => ({ name: a.name, periodInMinutes: a.periodInMinutes })));
  expect(alarms.find((a) => a.name === 'vt-refresh').periodInMinutes,
    'the default refreshInterval is 1m').toBe(1);
});

test('sidePanel.getLayout() reports which side Chrome docks the panel on', async ({ serviceWorker }) => {
  const layout = await swEval(serviceWorker, async () => {
    if (typeof chrome.sidePanel.getLayout !== 'function') return null;
    return chrome.sidePanel.getLayout(); // takes NO arguments (measured)
  });
  test.skip(layout === null, 'chrome.sidePanel.getLayout() is Chrome 140+');
  expect(['left', 'right']).toContain(layout.side);
});

test('sidePanel.open() resolves and open/close is tracked', async ({ harness, serviceWorker }) => {
  // W1 is used on purpose: the harness panel PAGE already registered W2 in
  // openPanels through vt/panel-ready, so only W1 can prove sidePanel.onOpened.
  const openResult = await harness.panel.evaluate(
    (w) => chrome.sidePanel.open({ windowId: w }).then(() => 'resolved', (e) => 'rejected: ' + String(e)),
    harness.w1);
  expect(openResult).toBe('resolved');

  await expect.poll(
    async () => (await diagnostics(harness.panel)).openPanels.includes(harness.w1),
    { timeout: 20_000, message: 'sidePanel.onOpened should add the window to openPanels' },
  ).toBe(true);

  const hasClose = await swEval(serviceWorker, () => typeof chrome.sidePanel.close === 'function');
  test.skip(!hasClose, 'chrome.sidePanel.close() is not available in this build');

  await harness.panel.evaluate((w) => chrome.sidePanel.close({ windowId: w }), harness.w1);
  await expect.poll(
    async () => (await diagnostics(harness.panel)).openPanels.includes(harness.w1),
    { timeout: 20_000, message: 'sidePanel.onClosed should remove the window from openPanels' },
  ).toBe(false);
});

test.describe('headed smoke', () => {
  test.skip(!process.env.DISPLAY, 'headed runs need an X display (npm run test:headed)');

  test('@headed the extension loads and the panel renders under Xvfb', async ({ harness }) => {
    await expect(harness.panel.locator('[data-testid="tab-card"]')).toHaveCount(3);
    await shot(harness.panel, '01-headed-smoke.png');
  });
});
