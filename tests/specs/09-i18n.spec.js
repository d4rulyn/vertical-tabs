// 09-i18n — the Japanese UI.
//
// Running Chrome "in Japanese" needs TWO independent knobs, and setting only one of
// them localises only half of the browser. Measured in mcr.microsoft.com/playwright:
// v1.62.1-noble (Chrome for Testing / Chromium 151), each config launched twice:
//
//   config                        sw.ui(early/late)  page.ui  navigator.languages  _locales
//   locale:'ja' only              en-US / ja         ja       ja                   en   <-- strings English
//   LANGUAGE=ja only              ja    / en-US      en-US    en-US                ja   <-- lang attr English
//   LC_ALL=ja_JP.UTF-8 only       ja    / en-US      en-US    en-US                ja   <-- ditto
//   LANGUAGE=ja + locale:'ja'     ja    / ja         ja       ja                   ja   <-- everything ja
//   (nothing)                     en-US / en-US      en-US    en-US                en
//
// The "LANGUAGE=ja only" row looks like it contradicts .agent/probe-results.md, which
// measured `getUILanguage() === 'ja'` in extension pages under that variable alone. It
// does not: that probe launched Chromium directly, whereas @playwright/test injects a
// default `locale: 'en-US'` into every context created through its instrumented
// `chromium` object, and that override outranks the process environment in renderers.
// Passing `locale: null` does not remove the default, so knob (b) must be set to 'ja'
// explicitly. probe-results.md stays correct for a bare launch; this table describes
// the same browser underneath @playwright/test.
//
//   (a) the browser process's environment (LANGUAGE / LC_ALL) picks the *application*
//       locale, i.e. what `_locales/<x>/messages.json` and the `__MSG_*` fields of the
//       manifest resolve against — chrome.i18n.getMessage();
//   (b) Playwright's `locale` option (an Emulation.setLocaleOverride on every attached
//       target) picks what renderers report as chrome.i18n.getUILanguage() and
//       navigator.languages — and `<html lang>` is stamped from getUILanguage()
//       (spec.md §4.6 / line 235), so it follows (b), not (a).
//
// `--lang=ja` on the command line moves knob (a) only — measured: with `--lang=ja`
// and no env override, getMessage('extName') is Japanese while renderers still report
// getUILanguage() === 'en-US'. It therefore cannot satisfy the `<html lang>` assertion
// on its own, and adding it to (a)+(b) changes nothing, so it is not used here.
//
// One measured trap worth naming: the *service worker*'s getUILanguage() answers with
// the application locale (a) while no extension page exists yet, and switches to the
// renderer locale (b) once one does. So an early swEval() reading `ja` proves nothing
// about the panel — the previous version of this test passed that check under
// LANGUAGE=ja alone and then found `<html lang="en-US">`. Everything below is asserted
// from the panel document itself; the manifest name is used for knob (a) because the
// extension's own l10n is not timing-dependent.
//
// en/ja key parity, placeholder parity and "every referenced key exists" are asserted
// by tests/unit/i18n-parity.test.mjs (`npm run unit`).
'use strict';

const { test, expect, launchExtensionContext } = require('../fixtures');
const { swEval } = require('../helpers/chrome');
const { openPanelPage, settleWelcomeTab } = require('../helpers/windows');

test('the panel is rendered in Japanese when Chrome runs in Japanese', async () => {
  test.setTimeout(120_000);

  const { context, serviceWorker } = await launchExtensionContext({
    // (a) application locale -> _locales/ja for getMessage() and the manifest.
    env: { ...process.env, LANGUAGE: 'ja', LC_ALL: 'ja_JP.UTF-8' },
    // (b) renderer UI language -> chrome.i18n.getUILanguage() and navigator.languages.
    locale: 'ja',
  });

  try {
    // spec-addendum.md A25 makes this a hard assertion, not a skip. It is stable
    // under this configuration: with both knobs set the service worker reports `ja`
    // early and late alike, so an early read is no longer the trap it was under
    // `LANGUAGE=ja` alone.
    const uiLang = await swEval(serviceWorker, () => chrome.i18n.getUILanguage());
    expect(uiLang).toMatch(/^ja/);

    // Knob (a): the manifest's __MSG_extName__ came from _locales/ja.
    const manifest = await swEval(serviceWorker, () => chrome.runtime.getManifest());
    expect(manifest.name).toBe('縦型タブ');

    await settleWelcomeTab(context, serviceWorker);
    const windowId = await swEval(serviceWorker, async () =>
      (await chrome.windows.getAll({ windowTypes: ['normal'] }))[0].id);

    const panel = await openPanelPage(context, serviceWorker, {
      hostWindowId: windowId, scopedWindowId: windowId,
    });

    // Knob (b): the panel's own renderer reports Japanese, which is what the
    // extension stamps onto <html lang>.
    const panelUiLang = await panel.evaluate(() => chrome.i18n.getUILanguage());
    expect(panelUiLang).toMatch(/^ja/);

    await expect(panel.locator('html')).toHaveAttribute('lang', /^ja/);
    await expect(panel.locator('#btn-new-tab')).toHaveAttribute('aria-label', '新しいタブ');
    await expect(panel.locator('#search-input')).toHaveAttribute('placeholder', 'タブを検索');
    await expect(panel.locator('#btn-trash')).toHaveAttribute('aria-label', '閉じたタブ');

    await panel.locator('[data-testid="settings-button"]').click();
    const drawer = panel.locator('[data-testid="settings-view"]');
    await expect(drawer).toBeVisible({ timeout: 10_000 });
    await expect(drawer).toContainText('プレビューのキャッシュを削除');
    await expect(drawer).toContainText('テーマ');

    // No unresolved i18n placeholders anywhere in the document.
    const body = await panel.evaluate(() => document.body.innerText);
    expect(body).not.toContain('__MSG_');
    expect(body).not.toContain('$COUNT$');
  } finally {
    await context.close();
  }
});
