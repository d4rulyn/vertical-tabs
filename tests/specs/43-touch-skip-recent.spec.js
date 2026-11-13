// 43-touch-skip-recent — `thumb-store.touch()` leaves a record whose stamp is a number within X of now alone, and writes
// every other record, without touching the picture or any other field. X is `TOUCH_FRESH_MS` in constants.js.
//
// Why it exists. The callers (the tab cards' `touchDisplayed()` and the bookmark column's row touch) touch the rows
// they draw on events, at most once per 30 s each. `touch()` used to put every record back, blob and all, and with a
// thousand bookmark rows that is a thousand blob rewrites per call, which probe 98a and 98b (Probe 18 in
// .agent/probe-results.md) tied to stalls of the store of seconds to minutes. `prune()` only looks at stamps that are
// days old, so a stamp of the last X is as good as one of this second.
//
// What is counted, and how. The panel's `IDBDatabase.transaction`, `IDBObjectStore.get` and `.put` are wrapped
// (`installStoreRecorder`), so "no write" is "no `put` was issued", read off what thumb-store.js really asked of
// IndexedDB. A count of puts ISSUED says nothing about what was COMMITTED (a handler that throws rolls the whole batch
// back and `touch()` still resolves), so the tests that matter for correctness read the store back. Time is explicit:
// `touch(keys, now)` takes `now`, so the tests that need hours to pass pass `now` instead of waiting for it. The one
// wait is the 30 s throttle of `touchDisplayed()`, which is polled, not slept.
//
// What is pinned. X is read from constants.js, the one place it is written, and must be at least half an hour (or
// nothing is saved) and at most a day (the 14-day prune horizon would lose over 7 %). The labels P1, P2(a)-(f), clock,
// recorder and callers are only names for the groups of tests below:
//   P1       1000 rows stamped 30 s ago: 1 transaction, 1000 reads, 0 writes; rows older than X: 1 write each
//   P2(a)    a row shown every 30 s for two X is rewritten once per X (not more, not less), and the edge is exact
//   P2(b)    prune keeps and drops what it kept and dropped; a touched record survives, an untouched old one does not
//   P2(c)    a key with no record costs nothing and creates nothing, and the rows around it are COMMITTED (read back)
//   P2(d)    touch() returns undefined and never rejects, for any input
//   P2(e)    a stamp that is not a number within X of now (missing, null, a string, a BigInt, a Date, NaN, an infinity
//            ...) is replaced by `now`, never subtracted from, and the picture stays
//   P2(f)    after a stale touch the stored picture is the same bytes and every other field is as it was
//   clock    a stamp a little in the future is left alone, one more than X in the future (the clock went back) and
//            a record with no stamp at all are written, as before
//   recorder the recorder's self-check ignores store traffic that is not its own
//   callers  the bookmark column's own row touch and the tab cards' own `touchDisplayed()` write only the stale rows
//
// Not covered: how long the store takes (that is probe 98b), and the effective prune horizon of 14 days minus X
// (and minus one 30 s cadence), which follows from P2(a) + P2(b) and is stated next to the constant in constants.js.
'use strict';

const { test, expect } = require('../fixtures');
const { granted } = require('../helpers/bookmarks');
const P = require('../helpers/bookmark-preview');
const { settled, countedTouch } = require('../helpers/touch-count');
const { createTab, queryTabs } = require('../helpers/chrome');

const DAY = 86_400_000;
const ONE_MIN = 60_000; // "just past X" is X + ONE_MIN; no test writes a duration of its own for X
const CADENCE = 30_000; // how often both callers touch (TOUCH_DISPLAYED_INTERVAL_MS)
const urlsOf = (ns, n) => Array.from({ length: n }, (_, i) => `https://${ns}.example.com/page/${i}`);
const keysOf = (panel, urls) => panel.evaluate((list) => list.map((u) => window.__vt.urlKey(u)), urls);

/**
 * `TOUCH_FRESH_MS` as constants.js defines it, the one place the number is written. A tree whose constants.js has
 * none fails here, loudly, instead of the tests quietly using a number of their own.
 */
async function freshMs(panel) {
  const value = await panel.evaluate(async () => (await import(chrome.runtime.getURL('common/constants.js'))).TOUCH_FRESH_MS);
  if (typeof value !== 'number') throw new Error('extension/common/constants.js does not export a numeric TOUCH_FRESH_MS');
  return value;
}

/** The `lastUsedAt` of each key's stored record, null where there is none. */
function stampsOf(panel, keys) {
  return panel.evaluate(async (list) => Promise.all(list.map(async (key) => {
    const record = await window.__vt.thumbStore.getThumb(key);
    return record ? record.lastUsedAt : null;
  })), keys);
}

test('P1: rows stamped within X of now cost no write; every older row costs exactly one', async ({ harness, serviceWorker }) => {
  test.setTimeout(420_000);
  const { panel } = harness;
  await settled(harness, serviceWorker);
  await P.installStoreRecorder(panel);

  // Soft, so that a tree whose thumb-store does not re-export the constant still goes on to fail on the writes below.
  const X = await freshMs(panel);
  const exported = await panel.evaluate(() => window.__vt.thumbStore.TOUCH_FRESH_MS);
  expect.soft(exported, 'thumb-store re-exports TOUCH_FRESH_MS, the same number constants.js has').toBe(X);
  expect.soft(X, 'at least half an hour, or nothing is saved').toBeGreaterThanOrEqual(30 * 60_000);
  expect.soft(X, 'at most a day, or the 14-day prune horizon loses over 7 %').toBeLessThanOrEqual(DAY);

  // S1, the case of the report: 1000 drawn bookmark rows, every one stamped half a minute ago.
  const drawn = urlsOf('p1-drawn', 1000);
  await P.putFakeThumbs(panel, drawn, { lastUsedAt: Date.now() - 30_000 });
  const s1 = await countedTouch(panel, 'fix', await keysOf(panel, drawn), Date.now());
  expect(s1.txs.length, 'one read-write transaction for the whole batch').toBe(1);
  expect(s1.txs[0].gets, 'every row is read').toBe(1000);
  expect(s1.txs[0].puts, 'S1: 1000 rows stamped 30 s ago, none is written back').toBe(0);

  // S3: half of them stale. The stale ones are written, with `now`; the fresh ones keep the stamp they had.
  const freshUrls = urlsOf('p1-mixed-fresh', 100);
  const staleUrls = urlsOf('p1-mixed-stale', 100);
  const freshStamp = Date.now() - 30_000;
  await P.putFakeThumbs(panel, freshUrls, { lastUsedAt: freshStamp });
  await P.putFakeThumbs(panel, staleUrls, { lastUsedAt: Date.now() - X - 60_000 });
  const freshKeys = await keysOf(panel, freshUrls);
  const staleKeys = await keysOf(panel, staleUrls);
  const now = Date.now();
  const s3 = await countedTouch(panel, 'fix', [...freshKeys, ...staleKeys], now);
  expect(s3.txs.length).toBe(1);
  expect(s3.txs[0].gets).toBe(200);
  expect(s3.txs[0].puts, 'S3: one write per stale row, none for the fresh ones').toBe(100);
  expect(s3.txs[0].stamps.every((s) => s === now), 'what is written is `now`').toBe(true);
  expect((await stampsOf(panel, freshKeys)).every((s) => s === freshStamp), 'a fresh row keeps its stamp').toBe(true);
  expect((await stampsOf(panel, staleKeys)).every((s) => s === now), 'a stale row has `now`').toBe(true);

  // S2: all stale, so a row that was last shown more than X ago is written, however many there are.
  const allStale = urlsOf('p1-stale', 200);
  await P.putFakeThumbs(panel, allStale, { lastUsedAt: Date.now() - X - 60_000 });
  const s2 = await countedTouch(panel, 'fix', await keysOf(panel, allStale), Date.now());
  expect(s2.txs[0].puts, 'S2: 200 rows older than X, 200 writes').toBe(200);
});

test('P2(a): a row shown every 30 s is rewritten once per X, and the edge is exact', async ({ harness, serviceWorker }) => {
  test.setTimeout(300_000);
  const { panel } = harness;
  await settled(harness, serviceWorker);
  const X = await freshMs(panel);
  const T0 = 1_700_000_000_000;
  const key = await P.putFakeThumb(panel, 'https://p2a.example.com/shown-all-day', { lastUsedAt: T0 });
  await P.installStoreRecorder(panel);

  const steps = Math.ceil((2 * X) / CADENCE) + 2;
  const walk = await panel.evaluate(async (a) => {
    const rec = window.__idb;
    const { thumbStore } = window.__vt;
    const out = [];
    for (let i = 1; i <= a.steps; i += 1) {
      const now = a.t0 + i * a.cadence;
      const before = rec.seq;
      await thumbStore.touch([a.key], now);
      const puts = rec.tx.filter((t) => t.n > before && t.mode === 'readwrite' && t.keys.includes(a.key))
        .reduce((s, t) => s + t.puts, 0);
      out.push({ now, puts, stamp: (await thumbStore.getThumb(a.key)).lastUsedAt });
    }
    return out;
  }, { key, t0: T0, cadence: CADENCE, steps });

  const refreshes = walk.filter((s) => s.puts > 0);
  expect(refreshes.every((s) => s.puts === 1), 'one write per refresh').toBe(true);
  expect(refreshes.length, 'two X of display refresh the row at least twice').toBeGreaterThanOrEqual(2);
  const stamps = [T0, ...refreshes.map((s) => s.now)];
  const gaps = stamps.slice(1).map((s, i) => s - stamps[i]);
  expect(gaps.every((g) => g >= X), `no refresh sooner than X (${X} ms): gaps ${gaps}`).toBe(true);
  expect(gaps.every((g) => g <= X + CADENCE),
    `a refresh at most one touch after X, so the stamp is never older than X + 30 s: gaps ${gaps}`).toBe(true);
  expect(walk[walk.length - 1].stamp, 'the stored stamp is the last refresh').toBe(refreshes[refreshes.length - 1].now);
  const unchangedOnSkip = walk.every((s, i) => s.puts > 0 || s.stamp === (i === 0 ? T0 : walk[i - 1].stamp));
  expect(unchangedOnSkip, 'a touch that writes nothing leaves the stamp as it was').toBe(true);

  // The edge: a stamp X old is stale, one millisecond younger is not.
  const edgeKey = await P.putFakeThumb(panel, 'https://p2a.example.com/edge', { lastUsedAt: T0 });
  const justFresh = await countedTouch(panel, 'fix', [edgeKey], T0 + X - 1);
  expect(justFresh.txs[0].puts, 'a stamp X - 1 ms old is left alone').toBe(0);
  const exactlyX = await countedTouch(panel, 'fix', [edgeKey], T0 + X);
  expect(exactlyX.txs[0].puts, 'a stamp exactly X old is rewritten').toBe(1);
  expect(await P.lastUsedAt(panel, edgeKey)).toBe(T0 + X);
});

test('P2(b): prune keeps and drops what it did; a touched record survives and an untouched old one does not', async ({ harness }) => {
  test.setTimeout(300_000);
  const { panel } = harness;
  const maxAge = await panel.evaluate(async () => (await import(chrome.runtime.getURL('common/constants.js'))).PRUNE.maxAgeMs);
  expect(maxAge, 'the horizon this test is written for').toBe(14 * DAY);

  const NOW = Date.now();
  const url = (name) => `https://p2b.example.com/${name}`;
  const seeded = {
    untouchedOld: await P.putFakeThumb(panel, url('untouched-old'), { lastUsedAt: NOW - maxAge - 60_000 }),
    touchedOld: await P.putFakeThumb(panel, url('touched-old'), { lastUsedAt: NOW - maxAge - 60_000 }),
    justInside: await P.putFakeThumb(panel, url('just-inside'), { lastUsedAt: NOW - maxAge + 60_000 }),
    shownWithinHorizon: await P.putFakeThumb(panel, url('shown-13-days'), { lastUsedAt: NOW - 13 * DAY }),
    shownRecently: await P.putFakeThumb(panel, url('shown-10-minutes'), { lastUsedAt: NOW - 10 * 60_000 }),
  };
  await panel.evaluate(async (a) => {
    await window.__vt.thumbStore.touch([a.touchedOld, a.shownWithinHorizon, a.shownRecently], a.now);
  }, { touchedOld: seeded.touchedOld, shownWithinHorizon: seeded.shownWithinHorizon, shownRecently: seeded.shownRecently, now: NOW });

  const result = await panel.evaluate((now) => window.__vt.thumbStore.prune({ now }), NOW);
  const alive = await panel.evaluate(async (keys) => {
    const out = {};
    for (const [name, key] of Object.entries(keys)) out[name] = (await window.__vt.thumbStore.getThumb(key)) !== null;
    return out;
  }, seeded);

  expect(alive, `prune at the 14-day horizon (it deleted ${result.deleted})`).toEqual({
    untouchedOld: false, // 14 days + 1 min old, nobody showed it: gone, exactly as before
    touchedOld: true, // the same age, but shown just now: the touch rewrote it, so it stays
    justInside: true, // 14 days - 1 min old: inside the horizon, nobody touched it
    shownWithinHorizon: true, // 13 days old and shown: refreshed (older than X), so it stays
    shownRecently: true,
  });
});

test('P2(c): a key with no record costs nothing and creates nothing, and the rows around it are committed', async ({ harness, serviceWorker }) => {
  test.setTimeout(300_000);
  const { panel } = harness;
  await settled(harness, serviceWorker);
  const X = await freshMs(panel);
  await P.installStoreRecorder(panel);

  const present = urlsOf('p2c-present', 10);
  const staleOnes = urlsOf('p2c-stale', 5);
  const absent = urlsOf('p2c-absent', 40);
  const freshStamp = Date.now() - 30_000;
  const seedStale = () => P.putFakeThumbs(panel, staleOnes, { lastUsedAt: Date.now() - X - ONE_MIN });
  await P.putFakeThumbs(panel, present, { lastUsedAt: freshStamp });
  await seedStale();
  const presentKeys = await keysOf(panel, present);
  const staleKeys = await keysOf(panel, staleOnes);
  const absentKeys = await keysOf(panel, absent);
  const count = () => panel.evaluate(async () => (await window.__vt.thumbStore.stats()).count);
  const before = await count();

  const onlyAbsent = await countedTouch(panel, 'fix', absentKeys, Date.now());
  expect(onlyAbsent.txs.reduce((s, t) => s + t.puts, 0), 'keys with no record: no write').toBe(0);
  expect(await count(), 'and no record is created for them').toBe(before);

  // The recorder counts puts that were ISSUED. A handler that throws on the first absent key rolls the whole batch
  // back and `touch()` still resolves, so what shows the call did its work is what the store holds afterwards, read
  // back. Twice: the absent keys after the rows they must not harm (the puts of the stale rows are issued before the
  // throw, so the counts alone look right), and the absent keys in front of, between and behind them.
  const orders = {
    'absent keys last': [...presentKeys, ...staleKeys, ...absentKeys],
    'absent keys first, between and last': [
      ...absentKeys.slice(0, 10), ...presentKeys.slice(0, 5), ...absentKeys.slice(10, 20), ...staleKeys,
      ...absentKeys.slice(20, 30), ...presentKeys.slice(5), ...absentKeys.slice(30),
    ],
  };
  for (const [name, keys] of Object.entries(orders)) {
    await seedStale();
    const now = Date.now();
    const mixed = await countedTouch(panel, 'fix', keys, now);
    expect(mixed.ret, `${name}: the call resolved`).toBe('undefined');
    expect(mixed.txs[0].gets, `${name}: every key asked for is looked up`).toBe(55);
    expect(await stampsOf(panel, staleKeys), `${name}: the stale rows are committed with now`).toEqual(staleKeys.map(() => now));
    expect(await stampsOf(panel, presentKeys), `${name}: the fresh rows keep their stamp`).toEqual(presentKeys.map(() => freshStamp));
    expect(await stampsOf(panel, absentKeys), `${name}: no absent key has a record`).toEqual(absentKeys.map(() => null));
    expect(await count(), `${name}: the store has the same records afterwards`).toBe(before);
    expect(mixed.txs[0].puts, `${name}: only the stale rows with a record are written`).toBe(5);
  }
});

test('P2(d): touch() returns undefined and never rejects, whatever it is given', async ({ harness }) => {
  test.setTimeout(300_000);
  const { panel } = harness;
  const X = await freshMs(panel);
  const fresh = await P.putFakeThumb(panel, 'https://p2d.example.com/fresh', { lastUsedAt: Date.now() - 30_000 });
  const stale = await P.putFakeThumb(panel, 'https://p2d.example.com/stale', { lastUsedAt: Date.now() - X - ONE_MIN });
  const staleDefault = await P.putFakeThumb(panel, 'https://p2d.example.com/stale-default-now', { lastUsedAt: Date.now() - X - ONE_MIN });

  const out = await panel.evaluate(async (a) => {
    const { touch } = window.__vt.thumbStore;
    const results = {};
    const settle = async (name, call) => {
      try {
        const value = await call();
        results[name] = value === undefined ? 'undefined' : `RETURNED ${JSON.stringify(value)}`;
      } catch (e) {
        results[name] = `REJECTED ${e}`;
      }
    };
    await settle('no arguments', () => touch());
    await settle('empty list', () => touch([]));
    await settle('null', () => touch(null));
    await settle('not an array', () => touch('x'));
    await settle('junk entries', () => touch(['', null, 5, {}, undefined]));
    await settle('fresh row', () => touch([a.fresh], Date.now()));
    await settle('stale row', () => touch([a.stale], Date.now()));
    await settle('absent key', () => touch(['https://p2d.example.com/absent'], Date.now()));
    await settle('default now', () => touch([a.staleDefault]));
    return results;
  }, { fresh, stale, staleDefault });

  expect(Object.values(out).every((v) => v === 'undefined'), JSON.stringify(out)).toBe(true);
  expect(await P.lastUsedAt(panel, staleDefault), 'without `now` it stamps with the current time')
    .toBeGreaterThan(Date.now() - 120_000);
});

test('clock: a stamp a little in the future is left alone; one far in the future and a missing one are written', async ({ harness, serviceWorker }) => {
  test.setTimeout(300_000);
  const { panel } = harness;
  await settled(harness, serviceWorker);
  const X = await freshMs(panel);
  await P.installStoreRecorder(panel);
  const now = Date.now();
  const soon = await P.putFakeThumb(panel, 'https://clock.example.com/soon', { lastUsedAt: now + 10 * 60_000 });
  const far = await P.putFakeThumb(panel, 'https://clock.example.com/far', { lastUsedAt: now + X + ONE_MIN });
  const missing = await panel.evaluate(async () => {
    const url = 'https://clock.example.com/no-stamp';
    const key = window.__vt.urlKey(url);
    await window.__vt.thumbStore.putThumb({
      urlKey: key, url, title: 'no stamp', capturedAt: Date.now(), bytes: 0, width: 640, height: 240,
    });
    return key;
  });

  const a = await countedTouch(panel, 'fix', [soon], now);
  expect(a.txs[0].puts, 'a stamp 10 minutes ahead (another caller stamped it with a later `now`): left alone').toBe(0);
  const b = await countedTouch(panel, 'fix', [far], now);
  expect(b.txs[0].puts, 'a stamp more than X ahead (the clock went back) is corrected, as before').toBe(1);
  expect(await P.lastUsedAt(panel, far)).toBe(now);
  const c = await countedTouch(panel, 'fix', [missing], now);
  expect(c.txs[0].puts, 'a record with no stamp at all is stamped, as before').toBe(1);
  expect(await P.lastUsedAt(panel, missing)).toBe(now);
});

test('P2(e): a stored stamp that is not a number within X of now is replaced, whatever it is, and the picture stays', async ({ harness }) => {
  // A touch that does arithmetic on whatever it finds would skip a numeric string or a Date that coerces to a number
  // within X of now, and would throw on a BigInt, which rolls the whole batch back. Each kind gets its own record and
  // its own touch, and is read back: the stamp has to be the number `now`, and the picture the same bytes.
  test.setTimeout(300_000);
  const { panel } = harness;
  const now = Date.now();
  const rows = await panel.evaluate(async (a) => {
    const store = window.__vt.thumbStore;
    const hex = async (blob) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    const canvas = new OffscreenCanvas(160, 60);
    const g = canvas.getContext('2d');
    g.fillStyle = '#2a5db0';
    g.fillRect(0, 0, 160, 60);
    g.fillStyle = '#c0392b';
    g.fillRect(20, 15, 70, 30);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
    const sha = await hex(blob);
    const OMIT = Symbol('omit');
    const kinds = [
      ['no stamp field at all', () => OMIT],
      ['undefined', () => undefined],
      ['null', () => null],
      ['empty string', () => ''],
      ['numeric string equal to now', (n) => String(n)],
      ['numeric string far from now', () => '12345'],
      ['BigInt equal to now', (n) => BigInt(n)],
      ['Date equal to now', (n) => new Date(n)],
      ['plain object', () => ({})],
      ['empty array', () => []],
      ['true', () => true],
      ['NaN', () => NaN],
      ['Infinity', () => Infinity],
      ['-Infinity', () => -Infinity],
    ];
    const out = [];
    for (const [i, [label, make]] of kinds.entries()) {
      const url = `https://p2e.example.com/odd/${i}`;
      const urlKey = window.__vt.urlKey(url);
      const record = {
        urlKey, url, title: label, capturedAt: 1_700_000_000_000, width: 160, height: 60, bytes: blob.size, blob,
        avgColor: [1, 2, 3], uniform: false, tabId: null, windowId: null, atTop: true,
      };
      const value = make(a.now);
      if (value !== OMIT) record.lastUsedAt = value;
      await store.putThumb(record);
      await store.touch([urlKey], a.now);
      const after = await store.getThumb(urlKey);
      out.push({
        label,
        stampType: typeof after.lastUsedAt,
        stampIsNow: after.lastUsedAt === a.now,
        pictureSame: Boolean(after.blob) && after.blob.size === blob.size && after.blob.type === blob.type
          && (await hex(after.blob)) === sha,
      });
    }
    return out;
  }, { now });
  const wrong = rows.filter((r) => !(r.stampType === 'number' && r.stampIsNow && r.pictureSame));
  expect(rows.length, 'every kind was tried').toBe(14);
  expect(wrong, `kinds whose stamp was not replaced by now, or whose picture changed: ${JSON.stringify(wrong)}`).toEqual([]);
});

test('P2(f): a stale touch leaves the stored picture byte for byte and every other field as it was', async ({ harness }) => {
  // `touch()` reads a whole record and puts it back; nothing in a count of puts says what it put. Three stale records
  // with three different pictures and a field the code does not know about, touched in ONE call, read back from the store.
  test.setTimeout(300_000);
  const { panel } = harness;
  const X = await freshMs(panel);
  const now = Date.now();
  const rows = await panel.evaluate(async (a) => {
    const store = window.__vt.thumbStore;
    const hex = async (blob) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    const jpeg = async (color, w, h) => {
      const canvas = new OffscreenCanvas(w, h);
      const g = canvas.getContext('2d');
      g.fillStyle = color;
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#f4f4f4';
      g.fillRect(0, 0, w, Math.round(h / 4));
      g.fillStyle = '#c0392b';
      g.fillRect(Math.round(w / 8), Math.round(h / 2), Math.round(w / 3), Math.round(h / 4));
      return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
    };
    const specs = [
      { name: 'stale just past X', stamp: a.now - a.x - a.minute, color: '#2a5db0', w: 320, h: 120 },
      { name: 'stale by a day more', stamp: a.now - a.x - 86_400_000, color: '#27ae60', w: 300, h: 130 },
      { name: 'stale by 20 days', stamp: a.now - 20 * 86_400_000, color: '#8e44ad', w: 310, h: 90 },
    ];
    const canon = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
    const kept = [];
    for (const [i, s] of specs.entries()) {
      const url = `https://p2f.example.com/picture/${i}`;
      const urlKey = window.__vt.urlKey(url);
      const blob = await jpeg(s.color, s.w, s.h);
      const record = {
        urlKey, url, title: `title of ${s.name}`, capturedAt: 1_700_000_000_000 + i, lastUsedAt: s.stamp, width: s.w, height: s.h,
        bytes: blob.size, blob, avgColor: [10 + i, 20 + i, 30 + i], uniform: false, tabId: 100 + i, windowId: 7, atTop: i % 2 === 0,
        futureField: { nested: [i, 'two', null], flag: true },
      };
      await store.putThumb(record);
      const { blob: _blob, lastUsedAt: _stamp, ...others } = record;
      kept.push({ s, urlKey, meta: { size: blob.size, type: blob.type, sha: await hex(blob) }, others: canon(others) });
    }
    const distinct = new Set(kept.map((k) => k.meta.sha)).size;
    await store.touch(kept.map((k) => k.urlKey), a.now);
    const out = [];
    for (const k of kept) {
      const after = await store.getThumb(k.urlKey);
      const { blob: afterBlob, lastUsedAt: afterStamp, ...afterOthers } = after;
      out.push({
        name: k.s.name,
        stampIsNow: afterStamp === a.now,
        pictureSame: Boolean(afterBlob) && afterBlob.size === k.meta.size && afterBlob.type === k.meta.type
          && (await hex(afterBlob)) === k.meta.sha,
        othersSame: canon(afterOthers) === k.others,
      });
    }
    return { distinct, out };
  }, { now, x: X, minute: ONE_MIN });
  expect(rows.distinct, 'premise: the three stored pictures are three different pictures').toBe(3);
  const wrong = rows.out.filter((r) => !(r.stampIsNow && r.pictureSame && r.othersSame));
  expect(wrong, `records whose stamp is not now, whose picture changed, or whose other fields changed: ${JSON.stringify(wrong)}`)
    .toEqual([]);
});

test('recorder: its canary is not disturbed by the panel\'s own traffic that lands in its window', async ({ harness }) => {
  // This spec's own counts depend on the recorder, and the recorder checks itself against the real store before it is
  // used. A late refresh of a card (the second capture of the active tab) made a transaction that was not the canary's
  // fail that check once in an otherwise green run. Here the traffic is made on purpose, without pause, from before the
  // recorder goes in until it is in: the check has to pass, and it has to have seen transactions that are not its own.
  test.setTimeout(120_000);
  const { panel } = harness;
  await panel.evaluate(() => {
    window.__stray = { stop: false };
    (async () => {
      while (!window.__stray.stop) {
        await window.__vt.thumbStore.getThumb('https://stray.example.com/never-stored');
      }
    })();
  });
  await P.installStoreRecorder(panel);
  const ignored = await panel.evaluate(() => {
    window.__stray.stop = true;
    return window.__idb.ignoredDuringCanary;
  });
  expect(ignored, 'premise: transactions that were not the canary\'s were recorded while it ran').toBeGreaterThan(0);
});

granted('caller: the bookmark column writes back only the rows whose stamp is old', async ({ harness, serviceWorker }) => {
  granted.setTimeout(300_000);
  const { panel } = harness;
  await settled(harness, serviceWorker);
  const X = await freshMs(panel);
  const links = [
    { title: 'Fresh one', url: 'https://touch-rows.example.com/fresh-1' },
    { title: 'Stale one', url: 'https://touch-rows.example.com/stale-1' },
    { title: 'Fresh two', url: 'https://touch-rows.example.com/fresh-2' },
    { title: 'Stale two', url: 'https://touch-rows.example.com/stale-2' },
  ];
  await P.openColumn(harness, serviceWorker, links);
  await P.installStoreRecorder(panel);

  const freshStamp = Date.now() - 30_000;
  const staleStamp = Date.now() - X - ONE_MIN;
  const keys = [
    await P.putFakeThumb(panel, links[0].url, { lastUsedAt: freshStamp }),
    await P.putFakeThumb(panel, links[1].url, { lastUsedAt: staleStamp }),
    await P.putFakeThumb(panel, links[2].url, { lastUsedAt: freshStamp }),
    await P.putFakeThumb(panel, links[3].url, { lastUsedAt: staleStamp }),
  ];
  // A NEW preview, whose row touch runs at once (see recycleColumn).
  await P.recycleColumn(panel, serviceWorker, links[0].title);

  const carrying = (rec) => rec.tx.filter((t) => t.mode === 'readwrite' && keys.every((k) => t.keys.includes(k)));
  await expect.poll(async () => carrying(await P.readStoreRecorder(panel)).length, {
    timeout: 30_000, message: 'the rebuilt column touched the four rows it draws',
  }).toBeGreaterThan(0);
  const txs = carrying(await P.readStoreRecorder(panel));
  expect(txs.reduce((s, t) => s + t.puts, 0), 'the two stale rows are written, the two fresh ones are not').toBe(2);
  const after = await stampsOf(panel, keys);
  expect([after[0], after[2]], 'a fresh row keeps its stamp').toEqual([freshStamp, freshStamp]);
  expect(after[1], 'a stale row has been stamped now').toBeGreaterThan(Date.now() - 120_000);
  expect(after[3]).toBeGreaterThan(Date.now() - 120_000);
});

test('caller: the tab cards\' touchDisplayed() writes back only the cards whose stamp is old', async ({ harness, serviceWorker, fixtures }) => {
  test.setTimeout(420_000);
  const { panel, w2 } = harness;
  await settled(harness, serviceWorker);
  const X = await freshMs(panel);
  const extra = 9;
  for (let i = 0; i < extra; i += 1) {
    await createTab(serviceWorker, w2, fixtures.page('aa4400', `Card${i}`, { n: i }));
  }
  const tabs = await queryTabs(serviceWorker, w2);
  expect(tabs.length, 'the scoped window has the three fixture tabs and nine more').toBe(3 + extra);
  await expect.poll(() => panel.locator('[data-testid="tab-card"]').count(), { timeout: 30_000 }).toBe(tabs.length);

  // Every card gets a record, half stamped 30 s ago and half more than X ago. A capture the service worker
  // makes meanwhile can only replace the first card's record (the one active tab), and that is a fresh one.
  const freshStamp = Date.now() - 30_000;
  const staleStamp = Date.now() - X - ONE_MIN;
  const keys = [];
  const stale = [];
  for (let i = 0; i < tabs.length; i += 1) {
    const isStale = i % 2 === 1;
    const key = await P.putFakeThumb(panel, tabs[i].url, { lastUsedAt: isStale ? staleStamp : freshStamp });
    keys.push(key);
    if (isStale) stale.push(key);
  }
  await P.installStoreRecorder(panel);

  const keySet = new Set(keys);
  const ours = (rec) => rec.tx.find((t) => t.mode === 'readwrite' && t.keys.length >= keys.length
    && t.keys.every((k) => keySet.has(k)));
  let seen = null;
  await expect.poll(async () => {
    await panel.evaluate(() => window.__vt.thumbs.touchDisplayed());
    seen = ours(await P.readStoreRecorder(panel));
    return Boolean(seen);
  }, {
    timeout: 60_000, intervals: [1000], message: 'touchDisplayed() ran for every card once its 30 s throttle opened',
  }).toBe(true);

  expect(seen.gets, 'it read every card').toBe(keys.length);
  expect(seen.puts, 'it wrote back only the stale half').toBe(stale.length);
  const after = await stampsOf(panel, keys);
  keys.forEach((key, i) => {
    if (stale.includes(key)) expect(after[i], `card ${i} was stale and is stamped now`).toBeGreaterThan(Date.now() - 300_000);
    else expect(after[i], `card ${i} was fresh and keeps its stamp`).toBe(freshStamp);
  });
});
