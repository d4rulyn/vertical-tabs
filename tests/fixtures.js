// Playwright fixtures: a persistent context with the unpacked extension loaded.
//
// Extensions load ONLY through launchPersistentContext with channel:'chromium'
// (Chrome for Testing new headless). Playwright's default headless shell and
// branded Chrome both ignore --load-extension. Both flags are required because
// Playwright always adds --disable-extensions and the except-flag re-enables ours.
// captureVisibleTab is measured to work in this configuration.
'use strict';

const path = require('path');
const { test: base, chromium, expect } = require('@playwright/test');
const { startFixtureServer } = require('./helpers/fixture-server');
const { setupTwoWindows } = require('./helpers/windows');

const EXT = process.env.EXT_DIR || path.resolve(__dirname, '../extension');

// `extDir` defaults to EXT — i.e. to `process.env.EXT_DIR`, then to extension/. A spec
// passes it when it needs a DIFFERENT build in one test without changing what every
// other spec in the worker loads: `process.env.EXT_DIR` is read once, at require time,
// so a spec that reassigned it would silently relaunch its neighbours against the copy.
function launchArgs({ headed = false, extDir = EXT } = {}) {
  const args = [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
  ];
  // Chromium's own sandbox is redundant inside the container and unavailable to the
  // non-root user compose runs as; Playwright adds the same flag itself when the
  // process is root, which is how the platform probe ran. Opt out with =0.
  if (process.env.VT_CHROMIUM_NO_SANDBOX !== '0') args.push('--no-sandbox', '--disable-dev-shm-usage');
  if (headed) args.push('--disable-gpu');
  return args;
}

/**
 * Launches a fresh persistent context with the extension loaded and resolves its
 * service worker. Used by the `context` fixture and by specs that need a second
 * browser (e.g. the Japanese UI language run).
 */
async function launchExtensionContext(options = {}) {
  const {
    headed = false, env, locale = 'en-US', colorScheme = 'dark', viewport, extDir = EXT,
  } = options;
  const launchOptions = {
    channel: 'chromium',
    headless: !headed,
    colorScheme,
    viewport: viewport || { width: 1280, height: 800 },
    args: launchArgs({ headed, extDir }),
  };
  if (locale) launchOptions.locale = locale;
  if (env) launchOptions.env = env;

  const context = await chromium.launchPersistentContext('', launchOptions);
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  const extensionId = sw.url().split('/')[2];
  return { context, serviceWorker: sw, extensionId };
}

const test = base.extend({
  // Custom option, set per project in playwright.config.js.
  headed: [false, { option: true }],

  context: async ({ headed }, use) => {
    const { context } = await launchExtensionContext({ headed });
    await use(context);
    await context.close();
  },

  serviceWorker: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
    await use(sw);
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(serviceWorker.url().split('/')[2]);
  },

  // One HTTP fixture server per worker: cheap, and the URLs stay stable for a run.
  fixtures: [async ({}, use) => {
    const server = await startFixtureServer();
    await use(server);
    await server.close();
  }, { scope: 'worker' }],

  harness: async ({ context, serviceWorker, fixtures }, use) => {
    const harness = await setupTwoWindows(context, serviceWorker, fixtures);
    await use(harness);
  },
});

module.exports = { test, expect, chromium, EXT, launchExtensionContext, launchArgs };
