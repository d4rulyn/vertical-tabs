// @ts-check
const path = require('path');
const { defineConfig } = require('@playwright/test');

const OUT = process.env.OUT_DIR || path.resolve(__dirname, 'output');

module.exports = defineConfig({
  testDir: './specs',
  // One extension instance owns the captureVisibleTab quota (~1 call/second for the
  // whole extension), so parallel workers would fight over it.
  workers: 1,
  fullyParallel: false,
  retries: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: path.join(OUT, 'artifacts'),
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(OUT, 'report'), open: 'never' }],
  ],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'headless-chromium',
      use: { headed: false },
      grepInvert: /@headed/,
    },
    {
      // Only meaningful under xvfb-run (`npm run test:headed`); the @headed tests
      // skip themselves when DISPLAY is unset, so a plain `playwright test` is safe.
      name: 'headed',
      use: { headed: true },
      grep: /@headed/,
    },
  ],
});
