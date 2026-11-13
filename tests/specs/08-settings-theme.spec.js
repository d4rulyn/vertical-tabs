// 08-settings-theme — settings live in chrome.storage.local and reach the panel
// through storage.onChanged, without a reload. Also the two states a preview box can be
// in when it holds no screenshot, which must not look alike in either theme.
'use strict';

const { test, expect } = require('../fixtures');
const {
  swEval, setSettings, keyOf, waitForThumb, getThumb, thumbStats, shot,
} = require('../helpers/chrome');

async function gridTrackCount(panel) {
  return panel.evaluate(() => {
    const list = document.getElementById('tablist');
    const cs = getComputedStyle(list);
    if (cs.display !== 'grid') return 0;
    return cs.gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length;
  });
}

/* ── contrast, measured rather than reasoned about ─────────────────────────────
   WCAG 2.x relative luminance and contrast ratio, on the colours the browser
   actually computed. Thresholds: 4.5:1 for the small text label (1.4.3) and 3:1
   for the lock glyph, which is a non-text graphic (1.4.11). */

/** `rgb(r, g, b)` / `rgba(...)` → `[r, g, b]`. */
function parseRgb(value) {
  const m = String(value).match(/-?[\d.]+/g);
  if (!m || m.length < 3) throw new Error(`cannot parse colour: ${value}`);
  return m.slice(0, 3).map(Number);
}

function relativeLuminance([r, g, b]) {
  const lin = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrastRatio(fg, bg) {
  const a = relativeLuminance(parseRgb(fg));
  const b = relativeLuminance(parseRgb(bg));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/** Everything the "no preview is possible" placeholder renders, as the browser sees it. */
async function readBlockedThumb(panel, tabId) {
  return panel.evaluate((id) => {
    const card = document.querySelector(`.tab-card[data-tab-id="${id}"]`);
    if (!card) return null;
    const thumb = card.querySelector('.thumb');
    const label = card.querySelector('.thumb__label');
    const glyph = card.querySelector('.thumb__glyph');
    if (!thumb) return null;
    const ts = getComputedStyle(thumb);
    const box = thumb.getBoundingClientRect();
    const labelBox = label ? label.getBoundingClientRect() : null;
    return {
      classes: [...thumb.classList],
      title: thumb.getAttribute('title') || '',
      background: ts.backgroundColor,
      backgroundImage: ts.backgroundImage,
      thumbW: Math.round(box.width),
      thumbH: Math.round(box.height),
      label: {
        text: label ? label.textContent : null,
        color: label ? getComputedStyle(label).color : null,
        display: label ? getComputedStyle(label).display : null,
        opacity: label ? Number(getComputedStyle(label).opacity) : null,
        width: labelBox ? Math.round(labelBox.width) : 0,
        // Nothing may clip the label away.
        clipped: labelBox ? labelBox.width + 0.5 < label.scrollWidth : false,
      },
      glyph: {
        // `.hidden` is an HTMLElement property and the glyph is an inline <svg>, so the
        // ATTRIBUTE is the only truthful answer here — assigning the property to an SVG
        // element leaves `[hidden] { display: none !important }` in force.
        hidden: glyph ? glyph.hasAttribute('hidden') : null,
        display: glyph ? getComputedStyle(glyph).display : null,
        color: glyph ? getComputedStyle(glyph).color : null,
        opacity: glyph ? Number(getComputedStyle(glyph).opacity) : null,
        size: glyph ? Math.round(glyph.getBoundingClientRect().width) : 0,
      },
      placeholderOpacity: Number(getComputedStyle(card.querySelector('.thumb__placeholder')).opacity),
    };
  }, tabId);
}

test('theme, column count and thumbnail settings apply live', async ({ harness, serviceWorker }) => {
  test.setTimeout(150_000);
  const { panel } = harness;

  // The panel is designed for Chrome's 360 px minimum side-panel width.
  await panel.setViewportSize({ width: 360, height: 900 });

  // ── the default on a fresh profile is ONE column (direct user instruction; this
  //    overrides spec-addendum A11, which had defaulted to the two-per-row grid).
  await expect(panel.locator('html')).toHaveAttribute('data-columns', '1');
  await expect(panel.locator('html')).toHaveAttribute('data-layout', 'list');
  await expect.poll(() => gridTrackCount(panel), { timeout: 10_000 }).toBe(1);
  await shot(panel, '08-one-column-dark.png');

  // ── theme flips without a reload (proves cross-context storage.onChanged), and so
  //    does the column count.
  await setSettings(serviceWorker, { widgets: [], theme: 'light', columns: 2 });
  await expect(panel.locator('html')).toHaveAttribute('data-theme', 'light', { timeout: 10_000 });
  await expect(panel.locator('html')).toHaveAttribute('data-columns', '2', { timeout: 10_000 });
  await expect(panel.locator('html')).toHaveAttribute('data-layout', 'grid', { timeout: 10_000 });
  await expect.poll(() => gridTrackCount(panel), { timeout: 10_000 }).toBe(2);
  await shot(panel, '08-two-columns-light.png');

  // ── previews can be switched off entirely
  await setSettings(serviceWorker, { theme: 'dark', showThumbnails: false });
  await expect(panel.locator('html')).toHaveAttribute('data-thumbs', 'off', { timeout: 10_000 });
  await expect(panel.locator('[data-testid="tab-card"]').first().locator('.thumb')).toBeHidden();
  await shot(panel, '08-nothumbs.png');

  await setSettings(serviceWorker, { showThumbnails: true, columns: 1 });
  await expect(panel.locator('html')).toHaveAttribute('data-thumbs', 'on', { timeout: 10_000 });
});

// The user's first real-Chrome session had a window of chrome:// tabs and reported the
// previews as "まっくろ" — pitch black. Chrome will never let an extension screenshot such
// a page, so the card can only ever show a placeholder; the placeholder was a lock glyph at
// 18 % white multiplied by `opacity: .40`, about 7 % effective alpha on #1f1f1f, i.e.
// invisible. A card that can never have a preview has to say so, in both themes, without
// waiting for a tooltip — and must not be mistakable for one that is merely still loading.
test('a page that can never be previewed says so, legibly, in both themes',
  async ({ harness, serviceWorker }) => {
    test.setTimeout(180_000);
    const { panel, w2 } = harness;
    await setSettings(serviceWorker, { refreshInterval: 'off', columns: 1 });
    await panel.setViewportSize({ width: 380, height: 900 });

    // chrome:// is the exact case the user hit: classifyUrl() calls it 'restricted'
    // before a capture is ever attempted, so no quota token is spent either.
    const restrictedId = await swEval(serviceWorker, async (wid) => {
      const t = await chrome.tabs.create({ windowId: wid, url: 'chrome://version', active: false });
      return t.id;
    }, w2);
    const card = panel.locator(`.tab-card[data-tab-id="${restrictedId}"]`);
    await expect(card).toHaveCount(1, { timeout: 15_000 });
    await expect(card.locator('.thumb')).toHaveClass(/thumb--restricted/, { timeout: 20_000 });

    for (const theme of ['dark', 'light']) {
      await setSettings(serviceWorker, { theme });
      await expect(panel.locator('html')).toHaveAttribute('data-theme', theme, { timeout: 10_000 });
      await panel.evaluate(() => new Promise((r) => {
        requestAnimationFrame(() => requestAnimationFrame(() => r()));
      }));

      const m = await readBlockedThumb(panel, restrictedId);
      expect(m, 'the restricted card must be on screen').not.toBeNull();
      const where = `theme=${theme} bg=${m.background} label="${m.label.text}" `
        + `labelColor=${m.label.color} glyphColor=${m.glyph.color}`;

      // (1) It reads as a reason, not as a failed screenshot: a real, non-empty label.
      expect(m.label.text, `the placeholder must name the reason — ${where}`).toBeTruthy();
      expect(m.label.display, `the label must be rendered — ${where}`).not.toBe('none');
      expect(m.label.clipped, `the label must not be clipped — ${where}`).toBe(false);
      expect(m.label.width, `the label must occupy real space — ${where}`).toBeGreaterThan(20);

      // (2) The lock is actually drawn — not `hidden` still on the attribute, and not a
      //     7 %-alpha ghost.
      expect(m.glyph.hidden, `the lock glyph must not carry [hidden] — ${where}`).toBe(false);
      expect(m.glyph.display, `the lock glyph must be laid out — ${where}`).not.toBe('none');
      expect(m.glyph.size, `the lock glyph must have a size — ${where}`).toBeGreaterThanOrEqual(12);

      // (3) Nothing multiplies the placeholder back into invisibility.
      expect(m.placeholderOpacity, `placeholder opacity — ${where}`).toBe(1);
      expect(m.label.opacity, `label opacity — ${where}`).toBe(1);
      expect(m.glyph.opacity, `glyph opacity — ${where}`).toBe(1);

      // (4) Measured contrast, not eyeballed CSS.
      const labelRatio = contrastRatio(m.label.color, m.background);
      const glyphRatio = contrastRatio(m.glyph.color, m.background);
      expect(labelRatio,
        `label contrast is ${labelRatio}:1, WCAG AA needs 4.5:1 for text — ${where}`)
        .toBeGreaterThanOrEqual(4.5);
      expect(glyphRatio,
        `glyph contrast is ${glyphRatio}:1, WCAG needs 3:1 for a non-text graphic — ${where}`)
        .toBeGreaterThanOrEqual(3);

      // (5) It must not be confusable with "the preview has not arrived yet", which keeps
      //     the ordinary near-black/near-grey preview surface. Different background, and
      //     a hatch the pending state does not have.
      const pending = await panel.evaluate(() => {
        const el = document.createElement('div');
        el.className = 'thumb thumb--empty';
        document.body.appendChild(el);
        const cs = getComputedStyle(el);
        const out = { background: cs.backgroundColor, backgroundImage: cs.backgroundImage };
        el.remove();
        return out;
      });
      expect(m.background,
        `a blocked preview must not use the ordinary preview surface — ${where}`)
        .not.toBe(pending.background);
      expect(m.backgroundImage,
        `a blocked preview carries a hatch the pending state does not — ${where}`)
        .not.toBe(pending.backgroundImage);

      // (6) The full sentence stays available on hover.
      expect(m.title.length, `the tooltip must still explain in full — ${where}`).toBeGreaterThan(10);

      // (7) The one blocked reason that is coloured — "Chrome is withholding site access",
      //     which 13-host-access drives — uses a separate token so it clears 3:1 too.
      //     Measured from the palette, because that state cannot be provoked from here.
      const alert = await panel.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--vt-thumb-blocked-alert)';
        document.body.appendChild(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      const alertRatio = contrastRatio(alert, m.background);
      expect(alertRatio,
        `--vt-thumb-blocked-alert is ${alertRatio}:1 on ${m.background}, needs 3:1 — theme=${theme}`)
        .toBeGreaterThanOrEqual(3);

      await shot(panel, `08-restricted-${theme}.png`);
      await shot(card, `08-restricted-card-${theme}.png`);
    }

    // Narrow cards keep the signal: at five columns in a 380 px panel the box is tiny,
    // and it still must not fall back to a black rectangle.
    await setSettings(serviceWorker, { theme: 'dark', columns: 5 });
    await expect(panel.locator('html')).toHaveAttribute('data-columns', '5', { timeout: 10_000 });
    await panel.evaluate(() => new Promise((r) => {
      requestAnimationFrame(() => requestAnimationFrame(() => r()));
    }));
    const tiny = await readBlockedThumb(panel, restrictedId);
    expect(tiny.glyph.hidden, 'the lock must survive a narrow card').toBe(false);
    expect(tiny.glyph.display, 'the lock must still be laid out on a narrow card').not.toBe('none');
    expect(contrastRatio(tiny.glyph.color, tiny.background),
      'the lock must stay legible on a narrow card').toBeGreaterThanOrEqual(3);
    expect(tiny.label.clipped,
      `the label must not be clipped at ${tiny.thumbW}x${tiny.thumbH}`).toBe(false);
    await shot(panel, '08-restricted-narrow.png');
  });

test('the settings drawer opens and the preview cache can be cleared',
  async ({ harness, serviceWorker }) => {
    test.setTimeout(150_000);
    const { panel, tabIds, urls } = harness;
    // `columns` is named explicitly: the setSettings helper still merges over a
    // hard-coded DEFAULTS that carries the legacy `layout: 'grid'`, which would
    // otherwise migrate this profile to two columns before the drawer is read.
    await setSettings(serviceWorker, { refreshInterval: 'off', columns: 1 });

    // Something must be in the cache before clearing it means anything.
    const alphaKey = await keyOf(panel, urls.alpha);
    await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), tabIds.alpha);
    await waitForThumb(panel, alphaKey, { timeout: 40_000 });
    expect((await thumbStats(panel)).count).toBeGreaterThanOrEqual(1);

    await panel.locator('[data-testid="settings-button"]').click();
    await expect(panel.locator('[data-testid="settings-view"]')).toBeVisible({ timeout: 10_000 });

    // The column control is the replacement for the old three-way layout select: five
    // localised choices, and picking one writes a number the panel applies at once.
    const columnsSelect = panel.locator('[data-testid="settings-columns"]');
    await expect(columnsSelect).toBeVisible();
    await expect(columnsSelect.locator('option')).toHaveCount(5);
    const optionText = await columnsSelect.locator('option').allTextContents();
    for (const [i, text] of optionText.entries()) {
      expect(text.trim(), `option ${i} must be a localised label, not a raw i18n key`)
        .not.toMatch(/^columns\d$/);
      expect(text.trim()).toContain(String(i + 1));
    }
    await expect(columnsSelect).toHaveValue('1');
    await columnsSelect.selectOption('3');
    await expect(panel.locator('html')).toHaveAttribute('data-columns', '3', { timeout: 10_000 });
    expect(await swEval(serviceWorker,
      async () => (await chrome.storage.local.get('settings')).settings.columns)).toBe(3);
    await shot(panel, '08-settings-columns.png');

    await panel.keyboard.press('Escape');
    await expect(panel.locator('[data-testid="settings-view"]')).toBeHidden({ timeout: 10_000 });

    // The message contract behind the "Clear preview cache" button.
    const res = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'vt/clear-thumbs' }));
    expect(res && res.ok).toBe(true);

    await expect.poll(async () => (await thumbStats(panel)).count, { timeout: 15_000 }).toBe(0);
    await expect(panel.locator(`[data-tab-id="${tabIds.alpha}"] .thumb`))
      .not.toHaveClass(/thumb--loaded/, { timeout: 15_000 });
  });

/* S15 (spec-addendum A39, "Known, not changed", item 9). The button above sends the message itself; this is the
 * button. "Clear preview cache" asks "Delete all saved previews?" in #confirm-bar, and the settings drawer is a layer
 * over the whole panel (`position: fixed; inset: 0`), so the bar is an answer only if it is stacked ABOVE the drawer. It
 * was not (bar 65, drawer 70): the question was drawn under the drawer and a click at Cancel or OK landed on the drawer.
 * Only the keyboard could answer it (spec 42, section 16, does).
 *
 * The clicks are real pointer events at the buttons' own coordinates and never `force`d, so Playwright's hit test
 * fails them when something else is on top. Before them, `elementFromPoint` names what IS on top, so a regression
 * fails by assertion, quickly and with the culprit named, instead of by a click retried until the test times out. */
test('the clear-cache question in the settings drawer can be answered with the mouse: Cancel keeps the previews, Delete deletes them',
  async ({ harness, serviceWorker }) => {
    test.setTimeout(150_000);
    const { panel, tabIds, urls } = harness;
    await setSettings(serviceWorker, { refreshInterval: 'off', columns: 1 });
    await panel.setViewportSize({ width: 360, height: 900 });

    // "Kept" and "deleted" can only be told apart if something is in the cache.
    const alphaKey = await keyOf(panel, urls.alpha);
    await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), tabIds.alpha);
    await waitForThumb(panel, alphaKey, { timeout: 40_000 });
    expect((await thumbStats(panel)).count).toBeGreaterThanOrEqual(1);

    // Counts the requests that delete the previews. A Cancel that answered "yes" sends one in the same task as the
    // click (the continuation of `await confirmBar` is a microtask), before the store empties, so this is read
    // without waiting and the stored record is read next to it.
    await panel.evaluate(() => {
      const real = chrome.runtime.sendMessage.bind(chrome.runtime);
      window.__clearRequests = 0;
      chrome.runtime.sendMessage = (message, ...rest) => {
        if (message && message.type === 'vt/clear-thumbs') window.__clearRequests += 1;
        return real(message, ...rest);
      };
    });
    const clearRequests = () => panel.evaluate(() => window.__clearRequests);

    await panel.locator('[data-testid="settings-button"]').click();
    const view = panel.locator('[data-testid="settings-view"]');
    await expect(view).toBeVisible({ timeout: 10_000 });
    const bar = panel.locator('[data-testid="confirm-bar"]');
    const cancel = bar.locator('[data-testid="confirm-cancel"]');
    const ok = bar.locator('[data-testid="confirm-ok"]');

    const ask = async () => {
      await view.locator('[data-testid="settings-clear-cache"]').click();
      await expect(bar, 'the clear-cache button must ask its question in the confirm bar').toBeVisible();
    };
    // What the browser puts on top at the centre of each button, and whether that is the button (or inside it).
    const hitTest = () => panel.evaluate(() => {
      const describe = (el) => (el
        ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.classList.length ? `.${[...el.classList].join('.')}` : ''}`
        : 'nothing');
      const at = (testid) => {
        const button = document.querySelector(`#confirm-bar [data-testid="${testid}"]`);
        const box = button.getBoundingClientRect();
        const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return { isButton: Boolean(top && button.contains(top)), top: describe(top) };
      };
      return { cancel: at('confirm-cancel'), ok: at('confirm-ok') };
    });
    const expectBarOnTop = async () => {
      const hit = await hitTest();
      expect(hit.cancel.isButton,
        `the bar's Cancel button is covered: what is on top at its centre is ${hit.cancel.top}`).toBe(true);
      expect(hit.ok.isButton,
        `the bar's Delete button is covered: what is on top at its centre is ${hit.ok.top}`).toBe(true);
    };

    // Cancel, with Playwright's own actionability checks (visible, stable, and the click must reach the button).
    await ask();
    await expectBarOnTop();
    await shot(panel, '08-clear-cache-question-over-drawer.png');
    await cancel.click();
    await expect(bar, 'a click on Cancel did not close the bar').toBeHidden();
    expect(await clearRequests(), 'Cancel sent the request that deletes the previews').toBe(0);
    expect(await getThumb(panel, alphaKey), 'Cancel deleted the saved preview').not.toBeNull();
    await expect(view, 'answering the question must not close the drawer').toBeVisible();

    // Delete, as a bare click at the button's coordinates: no hit test of Playwright's in between.
    await ask();
    await expectBarOnTop();
    const box = await ok.boundingBox();
    await panel.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(bar, 'a click on Delete did not close the bar').toBeHidden();
    await expect.poll(clearRequests, { message: 'Delete did not send the request that deletes the previews' }).toBe(1);
    await expect.poll(async () => (await thumbStats(panel)).count, {
      message: 'the previews are still in the cache after Delete', timeout: 15_000,
    }).toBe(0);
    expect(await getThumb(panel, alphaKey), 'Delete left the saved preview').toBeNull();
    await expect(view, 'answering the question must not close the drawer').toBeVisible();
  });

/* Every label in the drawer comes from `t(key)`, and `t()` returns the bare key when the
 * locale does not define it (common/i18n.js). Two of the drawer's keys are not written out
 * but derived from data — the column choices and the card widths — and a template literal is
 * invisible to both static scans. The widget ticks were a third, which is how
 * `widgetStaleTabs` shipped undefined and its checkbox read "widgetStaleTabs" in the released
 * extension; those rows now carry the tool's own titleKey instead. The unit tests check the
 * derived keys against _locales; this is the same claim checked where it matters, on the
 * drawer Chromium actually rendered. */
test('no control in the settings drawer is labelled with a raw i18n key', async ({ harness }) => {
  const { panel } = harness;

  await panel.locator('[data-testid="settings-button"]').click();
  await expect(panel.locator('[data-testid="settings-view"]')).toBeVisible({ timeout: 10_000 });

  const view = panel.locator('[data-testid="settings-view"]');
  await expect(view.locator('.drawer__row--widget')).toHaveCount(9);

  const texts = await view
    .locator('.drawer__section-title, .drawer__label, .drawer__help, option')
    .evaluateAll((els) => els.map((el) => ({
      text: (el.textContent || '').trim(),
      where: el.className || el.tagName.toLowerCase(),
    })));
  expect(texts.length).toBeGreaterThan(30);

  // A rendered label always has a space, a capital, a digit or a non-ASCII character in it.
  // A leaked key never does: every key in _locales is lowerCamelCase and unbroken.
  for (const { text, where } of texts) {
    expect(text, `"${text}" (${where}) is a raw i18n key, not a localised label`)
      .not.toMatch(/^[a-z][A-Za-z0-9]{2,}$/);
    expect(text.length, `an empty label in ${where}`).toBeGreaterThan(0);
  }
});

/* A section may carry a `helpKey` of its own, describing the group rather than one control.
 * `buildSection()` did not render it: the side-column section had named one since the rail
 * was built and it had never once appeared on screen. The distinction this asserts is where
 * the paragraph sits — a row's help is inside `.drawer__row`, a section's is a direct child
 * of the section — because rendering it in the wrong place is the way to pass by accident. */
test("the side column's section help is on screen, not just in the table", async ({ harness }) => {
  const { panel } = harness;

  await panel.locator('[data-testid="settings-button"]').click();
  await expect(panel.locator('[data-testid="settings-view"]')).toBeVisible({ timeout: 10_000 });

  const section = panel.locator('[data-testid="settings-view"] [data-section="settingsSideColumn"]');
  await expect(section).toHaveCount(1);

  const sectionHelp = section.locator(':scope > .drawer__help');
  await expect(sectionHelp).toHaveCount(1);
  // "360 px" is the one figure both locales state, so this pins the text without pinning
  // a language: it is settingsSideColumnHelp that rendered, not some other paragraph.
  // 360 is in both locales, so this does not depend on which one rendered. It is NOT
  // unique to this string — settingsCardWidthHelp says 360 px too — so the `:scope >`
  // above is what actually pins WHICH help this is; this only pins that it is the right
  // text rather than an empty paragraph.
  await expect(sectionHelp).toHaveText(/360/);
  await expect(sectionHelp).toBeVisible();
});
