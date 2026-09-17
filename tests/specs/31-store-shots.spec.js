// 31-store-shots — the 1280x800 screenshots the Chrome Web Store listing needs.
//
// The store shows these at a fixed size and rejects anything else, so a panel screenshot
// (380 px wide) cannot be used directly. Each shot composes a real panel capture into a
// mock browser window at exactly 1280x800, with one line of copy saying what the reader
// is looking at — which is what the store's own guidance asks for.
//
// The panel in these images is the real thing, driven through the real extension. Nothing
// is drawn by hand except the window chrome around it.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('../fixtures');
const { swEval, createTab, keyOf, waitForThumb, setSettings } = require('../helpers/chrome');

const OUT = '/work/docs/store/screenshots';

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
// The panel is captured at exactly the height the mock window gives it. Capturing
// taller and letting the composition crop is how the first attempt cut the
// cross-window results — the one thing that screenshot existed to show — off the bottom.
const WINDOW = Object.freeze({ width: 1180, height: 648, bar: 34, pad: 6 });
const PANEL = Object.freeze({ width: 400, height: WINDOW.height - WINDOW.bar - WINDOW.pad });

/**
 * Composes a panel capture into a 1280x800 browser mock.
 *
 * @param {import('@playwright/test').BrowserContext} context
 * @param {{png: Buffer, page: Buffer|null, title: string, caption: string,
 *           dark: boolean, file: string}} a
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
  fs.mkdirSync(path.dirname(path.join(OUT, file)), { recursive: true });
  await sheet.screenshot({ path: path.join(OUT, file) });
  await sheet.close();
}

/** The same frame, once per language, so each listing gets words its readers can read. */
async function composeAll(context, { png, page, key, dark, file }) {
  for (const lang of LANGS) {
    const [title, caption] = COPY[lang][key];
    await compose(context, { png, page, title, caption, dark, file: `${lang}/${file}` });
  }
}

test('produces the 1280x800 store screenshots', async ({ harness, serviceWorker, fixtures, context }) => {
  test.setTimeout(300_000);
  const { panel, w2, tabIds, urls } = harness;

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
    { id: tabIds.alpha, url: fixtures.mock('article', 'Forty tabs', '7c3aed') },
    { id: tabIds.beta, url: fixtures.mock('docs', 'Release notes', '0369a1') },
    { id: tabIds.gamma, url: fixtures.mock('dashboard', 'Status', 'b45309') },
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
  const stage = await context.newPage();
  await stage.setViewportSize({ width: WINDOW.width - PANEL.width, height: PANEL.height });
  await stage.goto(restyled[0].url);
  await stage.waitForLoadState('networkidle');
  const pageShot = await stage.screenshot();
  await stage.close();

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
      await expect(panel.locator(id), `${id} must not be in a listing image`).toBeHidden();
    }
  };

  await clearBanners();

  // 1 — the product, dark.
  await composeAll(context, {
    page: pageShot,
    png: await panel.screenshot(),
    key: 'list', dark: true, file: '01-list-dark.png',
  });

  // 2 — the tools column, which is what fills Chrome's 360 px floor.
  await setSettings(serviceWorker, {
    widgets: ['recent', 'windows', 'duplicates', 'staleTabs', 'scratchpad'],
  });
  await expect.poll(
    async () => panel.evaluate(() => document.querySelectorAll('[data-widget]').length),
    { timeout: 15_000 },
  ).toBeGreaterThan(3);
  await clearBanners();
  await composeAll(context, {
    page: pageShot,
    png: await panel.screenshot(),
    key: 'tools', dark: true, file: '02-tools-dark.png',
  });

  // 3 — light theme, two columns: the same panel, configured differently.
  await setSettings(serviceWorker, { theme: 'light', columns: 2, cardWidth: 160, widgets: [] });
  await expect.poll(
    async () => panel.evaluate(() => document.documentElement.dataset.columns),
    { timeout: 15_000 },
  ).toBe('2');
  await clearBanners();
  await composeAll(context, {
    page: pageShot,
    png: await panel.screenshot(),
    key: 'columns', dark: false, file: '03-columns-light.png',
  });

  // 4 — search reaching into another window, the thing a tab list normally cannot do.
  await setSettings(serviceWorker, { theme: 'dark', columns: 1, widgets: [] });
  const third = await swEval(serviceWorker, async (url) => {
    const w = await chrome.windows.create({ url, focused: false, width: 900, height: 700 });
    return { windowId: w.id, tabId: (w.tabs || [])[0].id };
  }, fixtures.mock('article', 'Release notes', 'be123c'));
  await swEval(serviceWorker, async (id) => {
    for (let i = 0; i < 40 && !(await chrome.tabs.get(id)).title; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }, third.tabId);
  await panel.locator('#search-input').fill('release');
  await expect(panel.locator('#other-windows')).toBeVisible({ timeout: 15_000 });
  await clearBanners();
  await composeAll(context, {
    page: pageShot,
    png: await panel.screenshot(),
    key: 'search', dark: true, file: '04-search.png',
  });

  for (const lang of LANGS) {
    const made = fs.readdirSync(path.join(OUT, lang)).filter((f) => f.endsWith('.png')).sort();
    console.log(`[store] ${lang}: ${made.join(', ')}`);
    expect(made.length, `${lang} is missing a screenshot`).toBe(4);
  }
});
