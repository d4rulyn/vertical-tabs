// 31-store-shots — the 1280x800 screenshots the Chrome Web Store listing needs.
//
// The store shows these at a fixed size and rejects anything else, so a panel screenshot
// (380 px wide) cannot be used directly. Each shot composes a real panel capture into a
// mock browser window at exactly 1280x800, with one line of copy saying what the reader
// is looking at — which is what the store's own guidance asks for.
//
// The panel in these images is the real thing, driven through the real extension. Nothing
// is drawn by hand except the window chrome around it.
//
// THE WHOLE SCENE IS BUILT ONCE PER LANGUAGE, IN ITS OWN BROWSER. An earlier version
// captured the panel once and wrote those same pixels into both `en/` and `ja/`, swapping
// only the marketing copy, so every `ja/*.png` showed a Japanese caption over an ENGLISH
// panel — `03-columns-light.png` promised「日本語と英語に対応しています」directly above
// untranslated buttons. A screenshot carries its own words, so that is the same mistake
// as shipping an untranslated UI, and it was the one the listing was advertising against.
// The panel's language is fixed when its browser launches (the measured truth table at the
// top of 09-i18n.spec.js: it takes BOTH the process environment and Playwright's
// `locale`), so one capture cannot be re-rendered in another language. There have to be
// two browsers.
//
// WHAT AN ASSERTION HERE IS ALLOWED TO CLAIM. The first fix for that bug was itself green
// while writing the wrong file. Every check sat upstream of the one line that binds a
// language to a filename, so composing both listings from the English captures passed:
// the two sets then differed only inside the caption band (y 41-92, measured) and were
// identical pixel for pixel below it. Reading the live DOM before a shutter proves what
// the PANEL was doing; it proves nothing about which bytes reached which path. So the
// checks at the bottom of this file read the composed images back off disk, compare the
// panel region of the artefact rather than the buffers upstream of it, and diff the
// in-frame text of the two scenes so an English string surviving in the Japanese panel is
// named instead of merely photographed.
//
// The previews are pixels too. `.thumb--loaded` says only that a record exists for the URL, and
// a card in that state can still be painted, in whole or in part, as its page's flat average
// colour. So every shot goes through `photograph()`, which measures each preview in the capture
// itself (see PREVIEW); check (8) ties the bytes that were measured to the bytes composed, and
// check (9) measures the same boxes again in the finished sheet read back from disk.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { test, expect, launchExtensionContext } = require('../fixtures');
const { setupTwoWindows } = require('../helpers/windows');
const { swEval, createTab, keyOf, waitForThumb, setSettings } = require('../helpers/chrome');

// WHERE THE IMAGES GO. Composing straight into `docs/store/screenshots/` meant every run
// of the suite rewrote eight tracked PNGs, and a run that failed half way left whatever it
// had drawn behind as the listing's artwork. The test writes into the gitignored output
// directory and asserts there. Copying into `docs/` happens only under
// STORE_SHOTS_PUBLISH=1 and only after every assertion that comes before the copy loop has
// passed, because replacing published artwork is a decision, not a side effect of running the
// tests. The loop itself asserts per file and checks for stray images after each language's four
// copies, so a failure there can leave a language partly replaced: read `git status` before
// committing a publish run that ended red.
const STAGE = path.join(process.env.OUT_DIR || '/work/tests/output', 'store-shots');
const PUBLISH = '/work/docs/store/screenshots';
const PUBLISHING = process.env.STORE_SHOTS_PUBLISH === '1';

// The store shows one listing per language, and a screenshot carries its own words, so
// a Japanese caption on the English listing is the same mistake as an untranslated
// button. Each shot is rendered once per language.
const COPY = {
  en: {
    list:    ['Your tabs, vertical, each showing the page itself',
              'Recognisable by the page rather than by a favicon you have seen forty times. Groups and pinned tabs are drawn as they are.'],
    tools:   ['The width Chrome insists on, spent on tidying tabs',
              'Recently used, your other windows, duplicates, idle tabs, notes. Pick the ones you want; unpick them all and the column goes away.'],
    columns: ['One to five columns, any card size, either theme',
              'Light and dark, English and Japanese, and a card size that packs the row instead of leaving a gutter.'],
    search:  ['Search reaches into your other windows',
              'Every window, not just this one. Choosing a result brings that window forward and opens the tab.'],
  },
  ja: {
    list:    ['タブを縦に並べて、それぞれにページの見た目を添える',
              'ファビコンではなくページそのもので見分けられます。グループとピン留めタブもそのまま表示されます。'],
    tools:   ['余った幅は、タブの片づけに使う',
              '最近使ったタブ、開いているウィンドウ、重複の検出、放置タブの休止、メモ。必要なものだけ選べます。'],
    columns: ['列数もカードの大きさも、テーマも選べる',
              '1 列から 5 列まで。ライトとダーク、日本語と英語に対応しています。'],
    search:  ['他のウィンドウにあるタブも探せる',
              '検索は開いているすべてのウィンドウに届きます。選べばそのウィンドウを前に出して開きます。'],
  },
};
const LANGS = Object.keys(COPY);

// What the panel must be saying at the moment it is photographed. These are read off the
// live document, not off the image, so they establish that the panel WAS running in this
// language when the shutter fired. That is all they establish: they say nothing about
// which file the resulting bytes end up in, which is what the checks at the end are for.
const SPEAKS = {
  en: {
    lang: /^en/, placeholder: 'Search tabs', recent: 'Recently used',
    windows: 'Your windows', otherWindows: 'In other windows',
    duplicates: 'Duplicates', staleTabs: 'Idle tabs', scratchpad: 'Notes',
  },
  ja: {
    lang: /^ja/, placeholder: 'タブを検索', recent: '最近使ったタブ',
    windows: '開いているウィンドウ', otherWindows: '他のウィンドウ',
    duplicates: '重複', staleTabs: '放置中のタブ', scratchpad: 'メモ',
  },
};

// Strings that are legitimately identical in both listings, so the English-leak diff does
// not flag them: content this test typed itself, and text that carries no language at all.
/** Pixel dimensions from a PNG's IHDR, which is always its first chunk. */
function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const digest = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const SHARED_BY_DESIGN = [
  /^Work$/,                                                      // the tab group's title, set below
  /^(Forty tabs|Release notes|Handbook|Inbox|Metrics|Status)$/,  // fixture page titles
  /^127\.0\.0\.1(:\d+)?$/,                                       // the fixture server's origin
  /^[^\p{L}]*$/u,                                               // digits and punctuation: no language to get wrong
];

// The panel is captured at exactly the height the mock window gives it. Capturing
// taller and letting the composition crop is how the first attempt cut the
// cross-window results — the one thing that screenshot existed to show — off the bottom.
const WINDOW = Object.freeze({ width: 1180, height: 648, bar: 34, pad: 6 });
const PANEL = Object.freeze({ width: 400, height: WINDOW.height - WINDOW.bar - WINDOW.pad });

// `dark` paints the mock window's chrome; `columns` is what the caption claims. Both are
// asserted against the live panel at the shutter (`expectPanelLooks`), so a dark capture
// cannot end up framed in a light window, and 03 cannot quietly ship one column.
// `previews` is how many page previews can be measured in the frame, a card the footer cuts off
// included: 3, 4, 5 and 1 in every run measured, in both languages. A shot in which the
// measuring finds nothing therefore cannot pass, and a preview that is in the frame but cannot
// be measured does not count towards it: it fails the shot.
const SHOTS = [
  { key: 'list',    file: '01-list-dark.png',     dark: true,  columns: '1', previews: 3 },
  { key: 'tools',   file: '02-tools-dark.png',    dark: true,  columns: '1', previews: 4 },
  { key: 'columns', file: '03-columns-light.png', dark: false, columns: '2', previews: 5 },
  { key: 'search',  file: '04-search.png',        dark: true,  columns: '1', previews: 1 },
];
const SHOT = Object.fromEntries(SHOTS.map((s) => [s.key, s]));

/**
 * Composes a panel capture into a 1280x800 browser mock and writes it to the staging dir.
 *
 * @param {import('@playwright/test').BrowserContext} context
 * @param {{png: Buffer, page: Buffer|null, title: string, caption: string,
 *           dark: boolean, file: string}} a
 * @returns {Promise<{sheet: Buffer, panel: Buffer, panelAt: {x: number, y: number}}>} the bytes
 *   written, the panel region of them with the caption band excluded, and where that region
 *   starts in the sheet
 */
async function compose(context, { png, page: pagePng, title, caption, dark, file }) {
  const data = `data:image/png;base64,${png.toString('base64')}`;
  const pageData = pagePng ? `data:image/png;base64,${pagePng.toString('base64')}` : null;
  const ink = dark ? '#e9edf4' : '#1b1f27';
  const ground = dark ? '#11141a' : '#eef1f6';
  const chrome_ = dark ? '#1c2029' : '#dfe4ec';
  const page = dark ? '#171b23' : '#ffffff';
  const muted = dark ? '#7d8697' : '#6d7789';

  const html = `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;width:1280px;height:800px;overflow:hidden}
  body{background:${ground};color:${ink};
       font-family:"Hiragino Sans","Noto Sans JP",system-ui,sans-serif;
       display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px}
  .cap{font-size:21px;font-weight:700;letter-spacing:.01em;text-align:center;max-width:1100px}
  .sub{font-size:14px;color:${muted};margin-top:-10px;text-align:center;max-width:900px;line-height:1.6}
  .win{width:${WINDOW.width}px;height:${WINDOW.height}px;border-radius:10px;overflow:hidden;
       box-shadow:0 18px 50px -20px rgba(0,0,0,.55);display:flex;flex-direction:column;background:${chrome_}}
  .bar{height:${WINDOW.bar}px;display:flex;align-items:center;gap:7px;padding:0 12px;flex:none}
  .dot{width:10px;height:10px;border-radius:50%;background:${muted};opacity:.5}
  .omni{flex:1;height:20px;margin-left:10px;border-radius:10px;background:${page};opacity:.6}
  .body{flex:1;display:flex;gap:0;padding:0 ${WINDOW.pad}px ${WINDOW.pad}px}
  .content{flex:1;background:${page};border-radius:6px 0 0 6px;overflow:hidden}
  .content img{display:block;width:100%;height:100%;object-fit:cover;object-position:top left}
  .panel{width:${PANEL.width}px;flex:none;background:${page};border-radius:0 6px 6px 0;overflow:hidden}
  .panel img{display:block;width:${PANEL.width}px;height:100%;object-fit:cover;object-position:top}
</style>
<div class="cap">${title}</div>
<div class="sub">${caption}</div>
<div class="win">
  <div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="omni"></span></div>
  <div class="body">
    <div class="content">${pageData ? `<img src="${pageData}">` : ''}</div>
    <div class="panel"><img src="${data}"></div>
  </div>
</div>`;

  const sheet = await context.newPage();
  await sheet.setViewportSize({ width: 1280, height: 800 });
  await sheet.setContent(html);
  const target = path.join(STAGE, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const sheetPng = await sheet.screenshot({ path: target });
  // The panel region of the finished artefact, with the caption band left out. The caption
  // is the one part swapped per language without re-rendering anything, so a comparison
  // that includes it cannot tell a translated listing from a translated caption pasted
  // over an English panel — which is precisely the bug this file exists for.
  const panelPng = await sheet.locator('.panel').screenshot();
  const panelBox = await sheet.locator('.panel').boundingBox();
  await sheet.close();
  // What this sheet was actually built from. `png`, `title`, `caption` and `file` reach
  // this function as four independent values, so nothing in the composition step stops
  // one listing being drawn from the other one's panel. The caller ties them back to the
  // language and the shot — see check (6).
  return {
    sheet: sheetPng,
    panel: panelPng,
    source: digest(png),
    copy: [title, caption],
    dark: Boolean(dark),
    hadPage: Boolean(pagePng),
    panelAt: { x: Math.round(panelBox.x), y: Math.round(panelBox.y) },
  };
}

/**
 * Fails unless the panel about to be photographed is really running in `lang`.
 *
 * `<html lang>` follows the renderer's UI language and the placeholder comes from
 * `_locales/<lang>/messages.json`, so the pair covers both of the knobs that have to be
 * set (09-i18n.spec.js). Read from the live document immediately before the shutter.
 *
 * @param {import('@playwright/test').Page} panel
 * @param {'en'|'ja'} lang
 * @param {string} where which shot, so a failure says which image would have been wrong
 */
async function expectPanelSpeaks(panel, lang, where) {
  const want = SPEAKS[lang];
  await expect(panel.locator('html'), `${where}: the ${lang} listing would get a panel in another language`)
    .toHaveAttribute('lang', want.lang);
  await expect(panel.locator('#search-input'), `${where}: ${lang} panel strings did not come from _locales/${lang}`)
    .toHaveAttribute('placeholder', want.placeholder);
}

/**
 * Fails unless the panel is wearing the theme and column count the composition assumes.
 *
 * `compose()` paints the mock window's chrome from `SHOTS[].dark` and the captions name
 * the column count. Nothing tied either to the panel until now, so a light capture could
 * have been framed in a dark window and the image would merely have looked odd.
 *
 * @param {import('@playwright/test').Page} panel
 * @param {string} key which entry of SHOTS
 */
async function expectPanelLooks(panel, key) {
  const want = SHOT[key];
  const root = panel.locator('html');
  await expect(root, `${want.file}: the mock window around it is painted ${want.dark ? 'dark' : 'light'}`)
    .toHaveAttribute('data-theme', want.dark ? 'dark' : 'light');
  await expect(root, `${want.file}: the caption is written for ${want.columns} column(s)`)
    .toHaveAttribute('data-columns', want.columns);
}

/**
 * The strings actually inside the photograph.
 *
 * Text nodes whose box intersects the captured viewport and whose ink is not hidden, which
 * is what a reader sees in the PNG rather than what the DOM happens to hold off-screen.
 * Diffing these between the two scenes is how an untranslated string is named: replacing
 * the VALUES of seven `_locales/ja` keys with English leaves the key sets equal, so the
 * unit parity test stays green and only the picture is wrong.
 *
 * @param {import('@playwright/test').Page} panel
 * @returns {Promise<string[]>}
 */
async function inFrameText(panel) {
  return panel.evaluate(() => {
    const seen = new Set();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || ['SCRIPT', 'STYLE', 'TEMPLATE'].includes(el.tagName)) continue;
      // A search match is wrapped in `<mark>` (render.js:589), which breaks the title
      // into several text nodes: under the query "release" the row "Release notes"
      // reaches this walker as "Release" and "notes". Read a highlighted title from the
      // element that owns the whole string, so this reports the words the photograph
      // shows rather than fragments that no list of real titles could ever name.
      const host = el.tagName === 'MARK' && el.parentElement ? el.parentElement : el;
      // Only when the mark is a DIRECT child. `querySelector` searches all descendants,
      // so any container above a highlighted row matched as well and this returned that
      // container's entire textContent — every string in the panel as one blob, hidden
      // banners included, since textContent ignores styling. The cross-language diff
      // could not see it, because the two blobs were in different languages. Rule (5a)
      // printed it on the first run.
      const split = host !== el
        || [...host.children].some((child) => child.tagName === 'MARK');
      const text = String((split ? host.textContent : node.nodeValue) || '')
        .replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const style = getComputedStyle(host);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      if (Number(style.opacity) === 0) continue;
      let r;
      if (split) {
        r = host.getBoundingClientRect();
      } else {
        const range = document.createRange();
        range.selectNodeContents(node);
        r = range.getBoundingClientRect();
      }
      if (r.width === 0 || r.height === 0) continue;
      if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
      seen.add(text);
    }
    // Painted text that is not a text node. A placeholder shows only while its field is
    // empty, and `scratchpad.js:33` sets one from `_locales` — so the Notes box can print
    // an English sentence into the Japanese listing that a text-node walk never sees.
    for (const el of document.querySelectorAll('[placeholder]')) {
      if (el.value) continue;
      const ph = String(el.placeholder || '').replace(/\s+/g, ' ').trim();
      if (!ph) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      if (Number(style.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
      seen.add(ph);
    }
    return [...seen];
  });
}

// WHAT "THE PREVIEW IS REAL" MEANS IN PIXELS. `.thumb--loaded` says only that a record exists for
// the URL; a card in that state whose <img> has no src, has not decoded yet, or is only partly
// showing is painted, where the image is not, as the flat average colour of its page: a lavender
// block where "Forty tabs" should be, in a listing whose first caption says "each showing the page
// itself". Two statistics are taken from the PNG over the preview box (the visible part of the
// thumb, inset to stay clear of its rounded corners), and a preview must pass both.
//
// own: the share of the box within `tolerance` of the page's OWN accent colour. Every fixture page
// is built around an accent (`fixtures.mock(kind, title, accent)`) that fills its top bar, so a
// capture of that page carries it and nothing else does: not the flat average of a mostly white
// page, not a placeholder, not another page's capture. Measured over 16 unmutated runs x en/ja x 4
// shots: real previews 0.057 .. 0.488 (405), a loaded card painted as a flat block 0.000 (11), the
// empty and the restricted placeholder 0.000 (32 each). `ownMin` is half the smallest real share,
// so a real preview clears it twice over. `tolerance` 8 is the smallest of {8, 12, 16, 24, 32, 48}
// at which every real preview holds 0.04, and the two closest accents (Inbox c2410c, Status b45309,
// 18 apart) cannot both fall inside it.
//
// avg: the share of the box within `avgTolerance` of the card's own average colour, which is what
// the product paints behind an <img> that is not showing. A preview whose lower part is hidden
// still carries its accent bar and passes `own`; the hidden part shows this colour. At
// `avgTolerance` 4 the share was at most 0.0003 for 208 real previews, 0.0021 for the worst shot of
// the 96 of an earlier build, and 0.0065 for the stored thumbnails of 24 other mock pages (4 kinds
// x 6 accents). With the lower 60% of every preview hidden it was 0.587 or more, with the lower 20%
// hidden 0.153, with a band at 30-60% hidden 0.305, with no image 0.976 .. 0.995, with the image
// transparent 1.000; the empty and restricted placeholders give 0.937 and 0.846. `avgMax` is the
// geometric mean of the largest real value (0.0065) and the 60% one (0.587), 0.062, rounded down:
// 9x the first, 1/9.8 of the second. Roughly, it flags a preview whose lower 6% or more is blank.
// Limit: a REAL preview of a page that is itself one flat colour would fail it, so the scene
// uses pages that look like pages.
//
// What neither statistic measures is how flat the box is, or whether the picture is the right way
// up or the right shape. Each of these passes both: every preview stretched to a flat block of its
// own accent (own 1.0000, avg 0.0000), the lower 60% covered by a dark block (own 0.057 .. 0.084,
// avg 0.0000), previews upside down (own as low as 0.0317), a gradient in place of one card's
// preview, previews squashed into 15 to 31 px strips (own 0.27 .. 0.41). Those numbers come from an
// independent review of this spec, not from a run kept in the repository. The earlier version of
// this comment said that flatness "is NOT used"; that sentence was dropped when the gate was
// tightened and the blind spot went with it. The checks that would close it need a reference: the
// product's own stored thumbnail for the same card, compared with the box (a probe measured 0.45 ..
// 8.8 mean absolute difference per card for real previews and 27 .. 150 for the four mutants above).
// That is a follow-up, not done here.
//
// Every preview with any part in the frame is measured as long as its top is, because that is
// where the accent bar is. 01's third card is a third in the frame, under the footer; it was a
// blank block in the ja/01-list-dark.png first committed. One that is cut off at the top, or is
// under `minSide` px after the inset, cannot be measured and fails the shot instead of being
// skipped in silence. `attempts` is how many times a shot may be taken. Each take first waits for
// what can be waited for (every <img> with a src decodes, favicons included, and the opacity
// transition runs to its end), so a second take is for something that was neither of those. In 12
// clean runs with a cap of 6 (96 shots) none needed a second take; the cap is 2 so a blank that
// returns turns the run red.
const PREVIEW = Object.freeze({
  inset: 2, minSide: 8, tolerance: 8, ownMin: 0.028, avgTolerance: 4, avgMax: 0.06, attempts: 2,
});

/**
 * Every preview box that has any part inside the frame, with the DOM's account of it.
 *
 * Inside the frame means inside the viewport AND inside every ancestor that clips: the list
 * ends above the footer, so a card the footer covers is on screen only as far as the list lets it.
 *
 * @param {import('@playwright/test').Page} panel
 * @returns {Promise<Array<{tabId: number, title: string, cutTop: boolean, avg: number[]|null,
 *   box: {left: number, top: number, right: number, bottom: number}, dom: string}>>}
 */
async function previewBoxes(panel) {
  return panel.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const boxes = [];
    for (const card of document.querySelectorAll('.tab-card')) {
      const thumb = card.querySelector('.thumb');
      if (!thumb) continue;
      const r = thumb.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const clip = { left: 0, top: 0, right: vw, bottom: vh };
      for (let a = thumb.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const ar = a.getBoundingClientRect();
        clip.left = Math.max(clip.left, ar.left);
        clip.top = Math.max(clip.top, ar.top);
        clip.right = Math.min(clip.right, ar.right);
        clip.bottom = Math.min(clip.bottom, ar.bottom);
      }
      const box = {
        left: Math.max(r.left, clip.left),
        top: Math.max(r.top, clip.top),
        right: Math.min(r.right, clip.right),
        bottom: Math.min(r.bottom, clip.bottom),
      };
      if (box.right - box.left <= 0 || box.bottom - box.top <= 0) continue;
      const img = thumb.querySelector('.thumb__img');
      const state = [...thumb.classList].filter((c) => c.startsWith('thumb--')).join(' ');
      const shows = !img || !img.getAttribute('src')
        ? '<img> has no src'
        : `<img> src set, ${img.naturalWidth}x${img.naturalHeight} decoded${img.hidden ? ', hidden' : ''}`;
      // The colour the product paints behind the <img>: `applyTo` sets it from the capture's average.
      const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(thumb).backgroundColor);
      boxes.push({
        tabId: Number(card.dataset.tabId),
        title: String((card.querySelector('.title') || {}).textContent || ''),
        cutTop: r.top < clip.top - 0.5,
        avg: rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null,
        box,
        dom: `${state}; ${shows}`,
      });
    }
    return boxes;
  });
}

/**
 * For each rectangle of a PNG: the share of it within `tolerance` of its page's accent and within
 * `avgTolerance` of its card's average colour, and the one colour that fills most of it. Decoded in
 * the page, because Node has no canvas.
 *
 * @param {import('@playwright/test').Page} panel any page: it only decodes and counts
 * @param {Buffer} png
 * @param {Array<{x: number, y: number, w: number, h: number, accent: string, avg: number[]|null}>} rects
 * @returns {Promise<Array<{own: number, avg: number, dominant: {rgb: number[], share: number}}>>}
 */
async function paintedShares(panel, png, rects) {
  return panel.evaluate(async ({ b64, rs, tol, avgTol }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    return rs.map((rect) => {
      const { data } = ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
      const want = [0, 2, 4].map((i) => parseInt(rect.accent.slice(i, i + 2), 16));
      const avg = rect.avg || [-999, -999, -999];
      const counts = new Map();
      let own = 0;
      let nearAvg = 0;
      for (let i = 0; i < data.length; i += 4) {
        const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        counts.set(key, (counts.get(key) || 0) + 1);
        if (Math.abs(data[i] - want[0]) <= tol
          && Math.abs(data[i + 1] - want[1]) <= tol
          && Math.abs(data[i + 2] - want[2]) <= tol) own += 1;
        if (Math.abs(data[i] - avg[0]) <= avgTol
          && Math.abs(data[i + 1] - avg[1]) <= avgTol
          && Math.abs(data[i + 2] - avg[2]) <= avgTol) nearAvg += 1;
      }
      let top = 0;
      let topCount = 0;
      for (const [key, count] of counts) if (count > topCount) { top = key; topCount = count; }
      const n = rect.w * rect.h;
      return {
        own: own / n,
        avg: nearAvg / n,
        dominant: { rgb: [(top >> 16) & 255, (top >> 8) & 255, top & 255], share: topCount / n },
      };
    });
  }, { b64: png.toString('base64'), rs: rects, tol: PREVIEW.tolerance, avgTol: PREVIEW.avgTolerance });
}

/**
 * What is wrong with the previews of one picture, as a list of sentences (empty when nothing is).
 *
 * @param {{where: string, atLeast: number, cards: Array<object>, shares: Array<object>,
 *   skipped: string[], pages: Record<number, {accent: string}>}} a
 * @returns {string[]}
 */
function previewProblems({ where, atLeast, cards, shares, skipped, pages }) {
  const pct = (share) => `${(share * 100).toFixed(1)}%`;
  const problems = [...skipped];
  if (cards.length < atLeast) {
    problems.push(`only ${cards.length} preview(s) could be measured, and ${where} is meant to show at least ${atLeast}`);
  }
  cards.forEach((p, i) => {
    const page = pages[p.tabId];
    const s = shares[i];
    if (!page) {
      problems.push(`"${p.title}" (tab ${p.tabId}) is not a page this scene built, so there is no colour to look for`);
      return;
    }
    const why = [];
    if (s.own < PREVIEW.ownMin) {
      why.push(`${pct(s.own)} of it is the page's own colour #${page.accent}, needs ${pct(PREVIEW.ownMin)}`);
    }
    if (!p.avg) {
      why.push('its card has no average colour to compare with');
    } else if (s.avg > PREVIEW.avgMax) {
      why.push(`${pct(s.avg)} of it is the card's own average colour rgb(${p.avg.join(',')}), what shows `
        + `where the image does not, limit ${pct(PREVIEW.avgMax)}`);
    }
    if (why.length) {
      problems.push(`"${p.title}" (tab ${p.tabId}): ${why.join('; ')}; the commonest colour fills `
        + `${pct(s.dominant.share)} of it, rgb(${s.dominant.rgb.join(',')}); DOM at the shutter: ${p.dom}`);
    }
  });
  return problems;
}

/**
 * Photographs the panel and returns the PNG once every preview in it is its page's real pixels,
 * with that PNG's digest and where the previews are in it.
 *
 * The measuring is done on the capture itself, the buffer `compose()` later draws and checks (6),
 * (8) and (9) tie to the finished sheet, not on the DOM: a CSS rule that hides a decoded image
 * leaves every DOM fact intact and the picture blank. Before each take it waits for what can be
 * waited for, with no sleep: every <img> that has a src decodes, favicons included, and
 * `animations: 'disabled'` runs the opacity transition to its end. A shot may then be taken
 * `PREVIEW.attempts` times; what is left over after that fails with what was measured in the
 * last take. A preview that is in the picture but cannot be measured fails it too.
 *
 * @param {import('@playwright/test').Page} panel
 * @param {'en'|'ja'} lang
 * @param {string} key which entry of SHOTS
 * @param {Record<number, {accent: string}>} pages what each tab id was built from
 * @returns {Promise<{png: Buffer, digest: string, measured: number, rects: object[], cards: object[]}>}
 */
async function photograph(panel, lang, key, pages) {
  const { file, previews: atLeast } = SHOT[key];
  let png = null;
  let rects = [];
  let cards = [];
  let skipped = [];
  let problems = [];
  let firstSight = [];
  let shares = [];
  let attempts = 0;
  while (attempts < PREVIEW.attempts) {
    attempts += 1;
    await panel.evaluate(() => Promise.all(
      [...document.images]
        .filter((img) => img.getAttribute('src'))
        .map((img) => img.decode().catch(() => null)),
    ));
    png = await panel.screenshot({ animations: 'disabled' });
    rects = [];
    cards = [];
    skipped = [];
    for (const p of await previewBoxes(panel)) {
      const x = Math.ceil(p.box.left + PREVIEW.inset);
      const y = Math.ceil(p.box.top + PREVIEW.inset);
      const w = Math.floor(p.box.right - PREVIEW.inset) - x;
      const h = Math.floor(p.box.bottom - PREVIEW.inset) - y;
      if (p.cutTop || w < PREVIEW.minSide || h < PREVIEW.minSide) {
        skipped.push(`"${p.title}" (tab ${p.tabId}) is in the picture but cannot be measured: `
          + `${p.cutTop ? 'its top is cut off' : `its box is ${Math.max(0, w)}x${Math.max(0, h)}px after the inset`}`);
        continue;
      }
      cards.push(p);
      rects.push({ x, y, w, h, accent: (pages[p.tabId] || {}).accent || '000000', avg: p.avg });
    }
    shares = rects.length ? await paintedShares(panel, png, rects) : [];
    problems = previewProblems({ where: file, atLeast, cards, shares, skipped, pages });
    if (attempts === 1) firstSight = problems;
    if (!problems.length) break;
  }
  expect(
    problems,
    `${lang}/${file}: a preview in the picture is not its page's real pixels `
    + `(take ${attempts} of ${PREVIEW.attempts}; own within ${PREVIEW.tolerance}/255 of the accent, `
    + `avg within ${PREVIEW.avgTolerance}/255 of the card's average colour)`,
  ).toEqual([]);
  // The numbers behind the verdict go in the line, so every run adds to the population the limits came from.
  const account = `${lang}/${file}: ${cards.length} previews measured, ${skipped.length} skipped, ${attempts} take(s); `
    + `own min ${Math.min(...shares.map((s) => s.own)).toFixed(4)} (needs ${PREVIEW.ownMin}), `
    + `avg max ${Math.max(...shares.map((s) => s.avg)).toFixed(4)} (limit ${PREVIEW.avgMax})`;
  console.log(`[store] ${account}${attempts > 1 ? `; take 1 saw ${JSON.stringify(firstSight)}` : ''}`);
  test.info().annotations.push({ type: 'previews', description: account });
  return { png, digest: digest(png), measured: cards.length, rects, cards };
}

/**
 * Builds the scene and takes all four panel captures in ONE browser, i.e. in one language.
 *
 * Everything the listing shows — the tabs, their previews, the group, the pinned tile, the
 * tools column, the cross-window search — is built here rather than shared, because the
 * language is a property of the browser and none of it can be re-rendered afterwards.
 *
 * @returns {Promise<{page: Buffer, shots: Record<string, Buffer>,
 *                    texts: Record<string, string[]>, measured: Record<string, number>,
 *                    measuredDigest: Record<string, string>, looks: Record<string, object>,
 *                    pages: Record<number, {accent: string}>}>}
 */
async function shoot(lang, { context, serviceWorker, fixtures, harness }) {
  const { panel, w2, tabIds } = harness;
  const shots = {};
  const texts = {};
  const measured = {};
  const measuredDigest = {};
  const looks = {};

  await setSettings(serviceWorker, {
    refreshInterval: 'off', theme: 'dark', columns: 1, widgets: [],
  });
  await panel.setViewportSize(PANEL);

  // Pages that look like pages: a preview of a flat red rectangle demonstrates nothing.
  const extra = [
    { url: fixtures.mock('docs', 'Handbook', '3b5bdb'), id: null },
    { url: fixtures.mock('mail', 'Inbox', 'c2410c'), id: null },
    { url: fixtures.mock('dashboard', 'Metrics', '0f766e'), id: null },
  ];
  for (const item of extra) item.id = await createTab(serviceWorker, w2, item.url, { active: false });

  const restyled = [
    { id: tabIds.alpha, title: 'Forty tabs', url: fixtures.mock('article', 'Forty tabs', '7c3aed') },
    { id: tabIds.beta, title: 'Release notes', url: fixtures.mock('docs', 'Release notes', '0369a1') },
    { id: tabIds.gamma, title: 'Status', url: fixtures.mock('dashboard', 'Status', 'b45309') },
  ];
  for (const item of restyled) {
    await swEval(serviceWorker, (a) => chrome.tabs.update(a.id, { url: a.url }), item);
  }
  await swEval(serviceWorker, async (ids) => {
    for (const id of ids) {
      for (let i = 0; i < 60; i += 1) {
        const t = await chrome.tabs.get(id);
        if (t.status === 'complete') break;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }, restyled.map((r) => r.id));

  const groupId = await swEval(serviceWorker, async (a) => {
    const gid = await chrome.tabs.group({ tabIds: [a.a, a.b], createProperties: { windowId: a.wid } });
    await chrome.tabGroups.update(gid, { title: 'Work', color: 'blue' });
    return gid;
  }, { a: extra[0].id, b: extra[1].id, wid: w2 });
  expect(groupId).toBeGreaterThan(-1);
  await swEval(serviceWorker, (id) => chrome.tabs.update(id, { pinned: true }), extra[2].id);

  // 01's caption promises groups and pinned tabs "drawn as they are", so both have to be
  // inside the 400x608 frame. Grouped last, the group landed at the bottom of six
  // single-column cards with its header around y 640 — below a list clipped at 568, i.e.
  // the sentence was advertising something the image did not contain. Index 1 is the first
  // slot after the pinned tab.
  await swEval(serviceWorker, (id) => chrome.tabGroups.move(id, { index: 1 }), groupId);

  // A real preview for every tab; the limiter allows roughly one a second.
  const plan = [
    { id: extra[2].id, url: extra[2].url },
    { id: extra[0].id, url: extra[0].url },
    { id: extra[1].id, url: extra[1].url },
    { id: restyled[2].id, url: restyled[2].url },
    { id: restyled[1].id, url: restyled[1].url },
    { id: restyled[0].id, url: restyled[0].url },
  ];
  for (const step of plan) {
    const key = await keyOf(panel, step.url);
    await swEval(serviceWorker, (id) => chrome.tabs.update(id, { active: true }), step.id);
    await waitForThumb(panel, key, { timeout: 60_000 });
  }
  await expect(panel.locator('.thumb--loaded')).toHaveCount(5, { timeout: 25_000 });

  // The page behind the panel, so the window is not an empty black box.
  //
  // While it is open the panel lists it as a sixth card: it is a tab of the panel's own window.
  // On the SAME url as the Forty tabs card it shares that card's thumbnail entry, and closing it
  // releases the entry once too often, so the next refresh of that URL leaves Forty tabs with no
  // <img> src: a flat lavender block. Reproduced in isolation with two tabs on one url (close one,
  // refresh the url, the other loses its src); a product bug that this spec does not fix, only
  // stops depending on. Five unmutated runs wrote the block into 13 of 40 images. A distinct
  // query string gives the stage its own entry, and the mock page ignores the parameter.
  const stage = await context.newPage();
  await stage.setViewportSize({ width: WINDOW.width - PANEL.width, height: PANEL.height });
  await stage.goto(`${restyled[0].url}&stage=1`);
  await stage.waitForLoadState('networkidle');
  // The window behind the panel has to hold the page the active card claims. `goto`
  // throws on a network error and on nothing else, so a 404 body or a blank document is
  // photographed without complaint and becomes the content half of all eight images.
  await expect(stage, 'the page behind the panel is not the one the active card shows')
    .toHaveTitle(restyled[0].title);
  const pageShot = await stage.screenshot();
  // The stage is a tab of this window, and its viewport resized the WINDOW: 1280x800 before it
  // opened, 780x608 once it had set that viewport, and nothing resizes it back (sampled with
  // `windows.get`). Closing it makes Forty tabs the active tab again and the product photographs it
  // again, at the new size: the stored record goes from 11,278 to 7,018 bytes, a narrower and more
  // zoomed view of the same page, 0.5-2 s after the close. Left alone that is a race with the
  // shots, and the card showed one look or the other in 02 and 03 from run to run. So wait for it,
  // on the record and then on the card, and every shot shows the same one.
  const activeKey = await keyOf(panel, restyled[0].url);
  const activeImg = panel.locator(`[data-tab-id="${restyled[0].id}"] .thumb__img`);
  await expect(activeImg, 'the active card shows no preview before the stage closes').toHaveAttribute('src', /^blob:/);
  const srcBefore = await activeImg.getAttribute('src');
  const recordBefore = await waitForThumb(panel, activeKey, { timeout: 10_000 });
  await stage.close();
  await waitForThumb(panel, activeKey, { timeout: 30_000, newerThan: recordBefore.capturedAt });
  await expect(activeImg, 'the active card did not take up the capture made after the stage closed')
    .not.toHaveAttribute('src', srcBefore);

  /**
   * Clears the transient banners before a capture.
   *
   * The host-access banner appears when Chrome has momentarily withheld site access,
   * which happens in a fresh test profile as windows are created. It says "previews are
   * unavailable" — true of that instant, and a lie about the product, so a listing image
   * must never contain it.
   */
  const clearBanners = async () => {
    for (const id of ['#host-access-dismiss', '#hint-dismiss']) {
      const button = panel.locator(id);
      if (await button.isVisible().catch(() => false)) await button.click();
    }
    for (const id of ['#host-access-banner', '#policy-banner', '#hint-banner']) {
      // `toBeHidden()` is also true of an element that is not there, so a mistyped id would pass
      // for ever. These three are static markup: present, and hidden.
      await expect(panel.locator(id), `${id} is not in the panel's markup`).toHaveCount(1);
      await expect(panel.locator(id), `${id} must not be in a listing image`).toBeHidden();
    }
  };

  // What each card's page was built from: `photograph()` looks for that page's own accent in the
  // card's preview. Read back from the URLs the tabs were given, so there is one source of truth.
  const pages = {};
  for (const item of [...extra, ...restyled]) {
    pages[item.id] = { accent: new URL(item.url).searchParams.get('accent') };
  }
  const snap = async (key) => {
    const taken = await photograph(panel, lang, key, pages);
    shots[key] = taken.png;
    measured[key] = taken.measured;
    measuredDigest[key] = taken.digest;
    looks[key] = { rects: taken.rects, cards: taken.cards };
  };

  // 1 — the product, dark.
  await clearBanners();
  await expectPanelSpeaks(panel, lang, '01-list-dark');
  await expectPanelLooks(panel, 'list');
  // The list is a scroller, and on first render the panel scrolls the active card into
  // view (`maybeScrollActiveIntoView`, render.js:786). In a 608 px frame that had put the
  // group 316 px above the top edge: the diagnostic showed the group correctly placed at
  // tab index 1 and `#tablist` sitting at `scrollTop: 407`, so `tabGroups.move` above was
  // doing its job and the scroller was undoing it. The group is `#tablist`'s first child,
  // so scrolling the list home frames it. This cannot race with the panel: that function
  // returns early unless `activeTabId` changed, and nothing activates a tab from here on.
  await panel.evaluate(() => {
    const list = document.getElementById('tablist');
    if (list) list.scrollTop = 0;
  });

  await expect(panel.locator('.pinned-tile').first(), '01-list-dark: the pinned tab the caption promises')
    .toBeInViewport({ ratio: 1 });
  await expect(panel.locator('.group-header').first(), '01-list-dark: the group the caption promises')
    .toBeInViewport({ ratio: 1 });
  texts.list = await inFrameText(panel);
  await snap('list');

  // 2 — the tools column, which is what fills Chrome's 360 px floor.
  await setSettings(serviceWorker, {
    widgets: ['recent', 'windows', 'duplicates', 'staleTabs', 'scratchpad'],
  });
  await expect.poll(
    async () => panel.evaluate(() => document.querySelectorAll('[data-widget]').length),
    { timeout: 15_000 },
  ).toBeGreaterThan(3);
  await clearBanners();
  await expectPanelSpeaks(panel, lang, '02-tools-dark');
  await expectPanelLooks(panel, 'tools');
  // The tool headings are this image's subject, so assert them by name rather than
  // trusting that `<html lang>` reached every section — and assert they are inside the
  // frame, because a heading scrolled past the fold is translated and invisible. All five
  // the caption names: it says "recently used, your other windows, duplicates, idle tabs, notes".
  for (const id of ['recent', 'windows', 'duplicates', 'staleTabs', 'scratchpad']) {
    await expect(panel.locator(`[data-widget="${id}"] .widget__title`), `02-tools-dark: ${lang} ${id} heading`)
      .toContainText(SPEAKS[lang][id]);
    await expect(panel.locator(`[data-widget="${id}"] .widget__title`), `02-tools-dark: ${id} heading is below the fold`)
      .toBeInViewport({ ratio: 1 });
  }
  texts.tools = await inFrameText(panel);
  await snap('tools');

  // 3 — light theme, two columns: the same panel, configured differently.
  await setSettings(serviceWorker, { theme: 'light', columns: 2, cardWidth: 160, widgets: [] });
  await expect.poll(
    async () => panel.evaluate(() => document.documentElement.dataset.columns),
    { timeout: 15_000 },
  ).toBe('2');
  await clearBanners();
  await expectPanelSpeaks(panel, lang, '03-columns-light');
  await expectPanelLooks(panel, 'columns');
  texts.columns = await inFrameText(panel);
  await snap('columns');

  // 4 — search reaching into another window, the thing a tab list normally cannot do.
  // `cardWidth: 0` is the schema default and has to be named: shot 3 set 160 px, and
  // that survives a `columns: 1` change because the width is a separate setting. 04 was
  // shipping with its result card in a 160 px track inside a 400 px panel.
  await setSettings(serviceWorker, { theme: 'dark', columns: 1, cardWidth: 0, widgets: [] });
  const third = await swEval(serviceWorker, async (url) => {
    const w = await chrome.windows.create({ url, focused: false, width: 900, height: 700 });
    return { windowId: w.id, tabId: (w.tabs || [])[0].id };
  }, fixtures.mock('article', 'Release notes', 'be123c'));
  // The row's icon comes from Chrome's favicon store (search.js, `faviconUrl`). Asked as soon as the
  // title was there, the row came out with no icon in 4 of 24 scenes and with the default globe in
  // 1. The tab's own `favIconUrl` is set once the browser has the page's icon, so wait for that as
  // well as for the title (all 24 scenes after the wait showed the fixture's icon), and say so if it
  // never comes instead of photographing an unfinished row.
  const ready = await swEval(serviceWorker, async (id) => {
    let t = await chrome.tabs.get(id);
    for (let i = 0; i < 40 && !(t.title && t.favIconUrl); i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      t = await chrome.tabs.get(id);
    }
    return { title: Boolean(t.title), icon: Boolean(t.favIconUrl) };
  }, third.tabId);
  expect(ready, '04: the other window\'s tab has no title or no icon yet, so its search row would be photographed unfinished')
    .toEqual({ title: true, icon: true });
  await panel.locator('#search-input').fill('release');
  await expect(panel.locator('#other-windows')).toBeVisible({ timeout: 15_000 });
  await clearBanners();
  await expectPanelSpeaks(panel, lang, '04-search');
  await expectPanelLooks(panel, 'search');
  // The placeholder expectPanelSpeaks reads is NOT rendered in this one — the field holds
  // the query, so the attribute is true of the document and absent from the photograph.
  // Two translated strings ARE rendered here: the cross-window heading, which is what the
  // shot exists to demonstrate, and the match counter under the field. Assert both by
  // sight, since neither is covered by an attribute.
  await expect(panel.locator('#other-windows'), `04-search: ${lang} cross-window heading`)
    .toContainText(SPEAKS[lang].otherWindows);
  await expect(panel.locator('[data-testid="other-window-result"]').first(), '04-search: the result row is below the fold')
    .toBeInViewport({ ratio: 1 });
  await expect(panel.locator('#search-count'), '04-search: the match counter is below the fold')
    .toBeInViewport({ ratio: 1 });
  texts.search = await inFrameText(panel);
  await snap('search');

  return { page: pageShot, shots, texts, measured, measuredDigest, looks, pages };
}

test('produces the 1280x800 store screenshots, each listing in its own language', async ({
  harness, serviceWorker, fixtures, context,
}) => {
  // Two full scenes, each with six real captures at the limiter's ~1 s spacing. Measured
  // at 60-90 s in this container; the budget is the headroom a loaded machine needs.
  test.setTimeout(300_000);

  // Never let an image an earlier run staged stand in for one this run failed to write.
  for (const lang of LANGS) {
    for (const { file } of SHOTS) fs.rmSync(path.join(STAGE, lang, file), { force: true });
  }

  const taken = {};
  taken.en = await shoot('en', { context, serviceWorker, fixtures, harness });

  // A second browser, launched in Japanese. Both knobs are required and neither is
  // sufficient alone — the environment picks which `_locales/<x>` the strings come from,
  // Playwright's `locale` picks what the renderer reports and therefore `<html lang>`,
  // and `locale: null` does not clear the default Playwright injects. The measurements
  // are the table at the top of 09-i18n.spec.js. `setupTwoWindows` then gives this
  // browser the same two-window harness the fixture builds for the default one.
  let ja = null;
  try {
    ja = await launchExtensionContext({
      env: { ...process.env, LANGUAGE: 'ja', LC_ALL: 'ja_JP.UTF-8' },
      locale: 'ja',
    });
    const jaHarness = await setupTwoWindows(ja.context, ja.serviceWorker, fixtures);
    taken.ja = await shoot('ja', {
      context: ja.context, serviceWorker: ja.serviceWorker, fixtures, harness: jaHarness,
    });
  } finally {
    // A failure to close must not become the failure the report shows: if the scene above
    // threw, that is the error worth reading.
    if (ja) await ja.context.close().catch(() => {});
  }

  // Composition happens in the default context. The sheet's own locale changes nothing,
  // but not for the reason this comment used to give: the font stack it names is not the
  // reason — the image contains neither Hiragino Sans nor Noto Sans JP, because the
  // container has neither and fc-match resolves the whole stack to WenQuanYi Zen Hei. It
  // changes nothing because every word on the sheet comes from COPY, which is indexed by
  // `lang` rather than read from the browser.
  const composed = {};
  for (const lang of LANGS) {
    composed[lang] = {};
    for (const { key, file, dark } of SHOTS) {
      const [title, caption] = COPY[lang][key];
      composed[lang][key] = await compose(context, {
        png: taken[lang].shots[key], page: taken[lang].page, title, caption, dark,
        file: `${lang}/${file}`,
      });
    }
  }

  // (1) Every image was composed IN THIS RUN. Counting directory entries could not tell a
  // fresh image from one git had already put there, so skipping a whole language passed.
  for (const lang of LANGS) {
    for (const { key, file } of SHOTS) {
      expect(
        composed[lang] && composed[lang][key] ? composed[lang][key].sheet.length : 0,
        `${lang}/${file} was not composed in this run`,
      ).toBeGreaterThan(0);
    }
  }

  // (2) The two listings are not holding the same photograph — asserted on the PANEL
  // REGION OF THE COMPOSED IMAGE, not on the captures upstream of it. Comparing
  // `taken.ja` with `taken.en` is true of those buffers whatever is done with them
  // afterwards: composing both listings from the English capture left them untouched and
  // passed, while writing an English panel under a Japanese caption. Byte inequality
  // still does not by itself prove either image is Japanese — two runs of the same
  // language would differ too. What proves the language is `expectPanelSpeaks` at the
  // shutter, and check (5) below.
  for (const { key, file } of SHOTS) {
    expect(
      composed.ja[key].panel.equals(composed.en[key].panel),
      `ja/${file} and en/${file} show the same panel under different captions — the `
      + 'Japanese listing is advertising an English UI',
    ).toBe(false);
  }

  // (3) The bytes on disk are the bytes this run composed for that language — the write
  // landed, at that path, intact. Swapping the two output directories satisfied every
  // other assertion. It does NOT prove the content belongs to that language: the buffer
  // it compares against is the one `screenshot({ path })` wrote in the same call. What
  // the sheet was built from is check (6); what it measures is check (7).
  for (const lang of LANGS) {
    for (const { key, file } of SHOTS) {
      const target = path.join(STAGE, lang, file);
      expect(fs.existsSync(target), `${lang}/${file} was never written`).toBe(true);
      expect(
        fs.readFileSync(target).equals(composed[lang][key].sheet),
        `${lang}/${file} does not hold the image composed for ${lang}`,
      ).toBe(true);
    }
  }

  // (4) Exactly the listing's images, by name. A count is satisfied by any four files.
  for (const lang of LANGS) {
    const made = fs.readdirSync(path.join(STAGE, lang)).filter((f) => f.endsWith('.png')).sort();
    expect(made, `${lang} does not hold exactly the listing's images`)
      .toEqual(SHOTS.map((s) => s.file).sort());
  }

  // (5) Neither frame speaks the other listing's language. Two rules, because the
  // cross-frame diff alone is blind in a different way in each direction.
  //
  // (5a) is absolute and needs no second scene: the Japanese frame may hold no run of
  // three or more ASCII letters, and the English frame no CJK, unless SHARED_BY_DESIGN
  // names it. This catches a "translation" that is the English string with a full stop
  // added, which the diff below cannot see because the two are no longer equal. It also
  // catches Japanese surviving in the ENGLISH listing — the mirror of the original bug,
  // which the old allowlist waved through by exempting anything without ASCII letters.
  //
  // (5b) is the cross-frame identity diff, with digit runs normalised: the two scenes are
  // timed separately, so one untranslated counter can read "1 of 6 tabs" here and
  // "1 of 7 tabs" there and escape an equality test.
  const allowed = (str) => SHARED_BY_DESIGN.some((re) => re.test(str));
  // Latin words that legitimately sit INSIDE Japanese text: the fixture pages' titles,
  // which the panel prints as tab titles within its own sentences. Tested word by word,
  // because an anchored whole-string allowlist cannot exempt a proper noun embedded in a
  // Japanese string, and a rule that gave up on such strings would exempt the sentence.
  const LATIN_BY_DESIGN = new Set(
    ['Work', 'Forty tabs', 'Release notes', 'Handbook', 'Inbox', 'Metrics', 'Status']
      .flatMap((name) => name.split(' ')),
  );
  const strayLatin = (str) => [...new Set(
    (str.match(/[A-Za-z]+/g) || []).filter((w) => w.length >= 3 && !LATIN_BY_DESIGN.has(w)),
  )];
  const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
  const sameShape = (str) => str.replace(/\d+/g, '#');

  for (const { key, file } of SHOTS) {
    const strayEn = [...new Set(
      taken.ja.texts[key].filter((t) => !allowed(t)).flatMap(strayLatin),
    )];
    expect(strayEn, `ja/${file} shows English: ${JSON.stringify(strayEn)}`).toEqual([]);
    const strayJa = taken.en.texts[key].filter((t) => !allowed(t) && CJK.test(t));
    expect(strayJa, `en/${file} shows Japanese: ${JSON.stringify(strayJa)}`).toEqual([]);

    const jaByShape = new Map();
    for (const t of taken.ja.texts[key]) if (!allowed(t)) jaByShape.set(sameShape(t), t);
    const shared = [];
    for (const t of taken.en.texts[key]) {
      if (allowed(t)) continue;
      const twin = jaByShape.get(sameShape(t));
      if (twin !== undefined) shared.push(twin === t ? t : `${t} ~ ${twin}`);
    }
    expect(shared, `ja/${file} and en/${file} show the same untranslated text: ${JSON.stringify(shared)}`)
      .toEqual([]);
  }

  // (6) Each sheet was composed from the capture and the words belonging to ITS language
  // and ITS shot. Checks (1)-(3) are all satisfied by swapping the two languages' panels
  // at the `compose` call: the files still exist, still differ from each other, and still
  // match what was written. That swap IS the original bug — a Japanese caption over an
  // English panel — and it is one line away, so it gets its own check.
  for (const lang of LANGS) {
    for (const { key, file } of SHOTS) {
      expect(
        composed[lang][key].source,
        `${lang}/${file} was composed from another scene's capture`,
      ).toBe(digest(taken[lang].shots[key]));
      expect(
        composed[lang][key].copy,
        `${lang}/${file} carries another listing's words`,
      ).toEqual(COPY[lang][key]);
      // The frame is drawn light or dark from this same argument. `expectPanelLooks`
      // reads `data-theme` off the live panel, which says nothing about the sheet around
      // it, so a dark panel in a light mock passes everything else.
      expect(
        composed[lang][key].dark,
        `${lang}/${file} was framed in the other theme`,
      ).toBe(Boolean(SHOT[key].dark));
      // The browser mock is a window with a page in it. With no page the content area is
      // a flat rectangle, which is a worse advertisement and a silent one.
      expect(
        composed[lang][key].hadPage,
        `${lang}/${file} has an empty browser window behind the panel`,
      ).toBe(true);
    }
  }

  // (7) The artefact is the size the store requires, and the capture is the size the
  // sheet crops to. Both numbers live in this file only as inputs — a viewport and a
  // stylesheet — and nothing read either back off an image. A panel viewport 140 px
  // taller than `PANEL` satisfies every in-viewport assertion and is then cropped away
  // by `object-fit: cover`, which is the failure the header comment describes.
  for (const lang of LANGS) {
    for (const { key, file } of SHOTS) {
      expect(
        pngSize(fs.readFileSync(path.join(STAGE, lang, file))),
        `${lang}/${file} is not the 1280x800 the Chrome Web Store accepts`,
      ).toEqual({ width: 1280, height: 800 });
      expect(
        pngSize(taken[lang].shots[key]),
        `${lang}/${file}: the capture is not panel-sized, so the sheet cropped part of it away`,
      ).toEqual({ width: PANEL.width, height: PANEL.height });
    }
  }

  // (8) Every shot went through `photograph()`, the frame held enough previews, and the PNG that
  // was measured is the PNG that was composed. The measuring happens there, at the shutter; this
  // is the receipt. Taking the call out of `shoot()` leaves no count, and photographing again
  // after it (a later capture with the previews hidden, say) leaves a digest that is not the one
  // that was measured. Check (6) ties `composed.source` to `taken[lang].shots[key]`, so this
  // chains the measurement to the sheet that was drawn from it.
  for (const lang of LANGS) {
    for (const { key, file, previews } of SHOTS) {
      expect(
        taken[lang].measured[key] ?? 0,
        `${lang}/${file}: its previews were never measured, or fewer than the ${previews} it is meant to show`,
      ).toBeGreaterThanOrEqual(previews);
      expect(
        digest(taken[lang].shots[key]),
        `${lang}/${file}: the capture that was composed is not the one whose previews were measured`,
      ).toBe(taken[lang].measuredDigest[key]);
    }
  }

  // (9) The previews are in the finished image. (8) says which capture the sheet was drawn from,
  // not that `compose()` drew it faithfully, and everything above compares something upstream of
  // the pixels on disk. This reads each sheet back off disk and measures the same boxes where the
  // panel sits in it, with the same limits, so a composition that hides the panel, or moves it far
  // enough that its previews leave their boxes, fails here. A sideways shift does not (the accent
  // bars span the whole box width: 32 px was measured to pass) and a vertical shift of a few tens
  // of pixels is expected to pass by arithmetic, which was not run.
  for (const lang of LANGS) {
    for (const { key, file, previews } of SHOTS) {
      const { rects, cards } = taken[lang].looks[key];
      const at = composed[lang][key].panelAt;
      const shares = await paintedShares(
        harness.panel,
        fs.readFileSync(path.join(STAGE, lang, file)),
        rects.map((r) => ({ ...r, x: r.x + at.x, y: r.y + at.y })),
      );
      expect(
        previewProblems({ where: `${lang}/${file}`, atLeast: previews, cards, shares, skipped: [], pages: taken[lang].pages }),
        `${lang}/${file}: the finished sheet, read back from disk, does not show its page previews`,
      ).toEqual([]);
    }
  }

  if (!PUBLISHING) {
    console.log(`[store] staged in ${STAGE}. Re-run with STORE_SHOTS_PUBLISH=1 to replace ${PUBLISH}.`);
    return;
  }
  for (const lang of LANGS) {
    const dir = path.join(PUBLISH, lang);
    fs.mkdirSync(dir, { recursive: true });
    for (const { key, file } of SHOTS) {
      const to = path.join(dir, file);
      fs.copyFileSync(path.join(STAGE, lang, file), to);
      // Read the promoted file back. `copyFileSync` reports its own throw and nothing
      // else, and a half-written listing image is what staging exists to prevent.
      expect(
        fs.readFileSync(to).equals(composed[lang][key].sheet),
        `${lang}/${file} was not promoted intact`,
      ).toBe(true);
    }
    // A renamed shot would otherwise leave its predecessor in the listing directory,
    // where `docs/store/listing.md` says there are four images per language. Named, not
    // deleted: removing published artwork is a person's decision.
    const strays = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.png') && !SHOTS.some((shot) => shot.file === f));
    expect(strays, `${lang} holds images the listing does not use: ${JSON.stringify(strays)}`)
      .toEqual([]);
  }
  console.log(`[store] published ${LANGS.length * SHOTS.length} images into ${PUBLISH}`);
});
