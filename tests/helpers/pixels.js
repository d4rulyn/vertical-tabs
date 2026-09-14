// Pixel statistics for thumbnail assertions (spec-addendum.md A23).
//
// PIXEL_RULE is data, not a magic number buried in a spec:
//   a pixel counts as "red" when r >= 200 && g <= 80 && b <= 80 (blue/green analogous).
//   The thresholds absorb the channel shift of JPEG q0.72 on a flat fill; the measured
//   shares with the fixtures' 48 px header band were 0.90 red / 0.885 blue.
//   uniformSpanMin is the "this is a real screenshot, not a flat placeholder" check:
//   the dark header band guarantees a per-channel spread of >= 24.
'use strict';

const PIXEL_RULE = { dominantMin: 200, othersMax: 80, uniformSpanMin: 24, sample: [32, 12] };

// Must be fully self-contained: Playwright serializes it into the page, and MV3's
// CSP forbids eval, so it cannot reference anything from this module's scope.
const STATS_IN_PAGE = async ({ mode, key, tabId, rule }) => {
  let bmp = null;
  if (mode === 'blob') {
    const rec = await window.__vt.thumbStore.getThumb(key);
    if (!rec || !rec.blob) return { error: 'no-record' };
    bmp = await createImageBitmap(rec.blob);
  } else {
    const img = document.querySelector(`[data-tab-id="${tabId}"] .thumb__img`);
    if (!img) return { error: 'no-img-element' };
    if (!img.getAttribute('src')) return { error: 'no-src' };
    if (!img.complete || !img.naturalWidth) {
      try { await img.decode(); } catch { /* fall through to the check below */ }
    }
    if (!img.naturalWidth) return { error: 'not-decoded' };
    bmp = await createImageBitmap(img);
  }

  const sw = rule.sample[0];
  const sh = rule.sample[1];
  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, sw, sh);
  const natural = { width: bmp.width, height: bmp.height };
  bmp.close();

  let data;
  try {
    data = ctx.getImageData(0, 0, sw, sh).data;
  } catch (e) {
    return { error: 'tainted-canvas: ' + String(e) };
  }

  const n = sw * sh;
  const min = [255, 255, 255];
  const max = [0, 0, 0];
  const sum = [0, 0, 0];
  let red = 0, green = 0, blue = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r < min[0]) min[0] = r; if (r > max[0]) max[0] = r; sum[0] += r;
    if (g < min[1]) min[1] = g; if (g > max[1]) max[1] = g; sum[1] += g;
    if (b < min[2]) min[2] = b; if (b > max[2]) max[2] = b; sum[2] += b;
    if (r >= rule.dominantMin && g <= rule.othersMax && b <= rule.othersMax) red++;
    if (g >= rule.dominantMin && r <= rule.othersMax && b <= rule.othersMax) green++;
    if (b >= rule.dominantMin && r <= rule.othersMax && g <= rule.othersMax) blue++;
  }

  const share = { red: red / n, green: green / n, blue: blue / n };
  let dominant = 'none';
  let best = 0;
  for (const k of ['red', 'green', 'blue']) {
    if (share[k] > best) { best = share[k]; dominant = k; }
  }
  return {
    error: null,
    natural,
    share,
    dominant,
    span: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    mean: [Math.round(sum[0] / n), Math.round(sum[1] / n), Math.round(sum[2] / n)],
  };
};

function assertNoError(stats, what) {
  if (stats && stats.error) throw new Error(`pixel stats failed for ${what}: ${stats.error}`);
  return stats;
}

/** Decodes the thumbnail Blob stored in IndexedDB. */
async function statsOfBlob(panel, urlKey) {
  const s = await panel.evaluate(STATS_IN_PAGE, { mode: 'blob', key: urlKey, tabId: null, rule: PIXEL_RULE });
  return assertNoError(s, `stored blob ${urlKey}`);
}

/** Decodes the image the user actually sees inside that card. */
async function statsOfRenderedImg(panel, tabId) {
  const s = await panel.evaluate(STATS_IN_PAGE, { mode: 'img', key: null, tabId, rule: PIXEL_RULE });
  return assertNoError(s, `rendered <img> of tab ${tabId}`);
}

/** Same as statsOfRenderedImg but returns { error } instead of throwing. */
async function tryStatsOfRenderedImg(panel, tabId) {
  return panel.evaluate(STATS_IN_PAGE, { mode: 'img', key: null, tabId, rule: PIXEL_RULE });
}

module.exports = { PIXEL_RULE, statsOfBlob, statsOfRenderedImg, tryStatsOfRenderedImg };
