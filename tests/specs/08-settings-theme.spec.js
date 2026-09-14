// 08-settings-theme — settings live in chrome.storage.local and reach the panel
// through storage.onChanged, without a reload. Also the two states a preview box can be
// in when it holds no screenshot, which must not look alike in either theme.
'use strict';

const { test, expect } = require('../fixtures');
const {
  swEval, setSettings, keyOf, waitForThumb, thumbStats, shot,
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
