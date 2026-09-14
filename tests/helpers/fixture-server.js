// Static fixture server used by every capture spec.
//
// The container has no internet access, so every page the browser visits is served
// from here on 127.0.0.1. Pages are deliberately shaped for the thumbnail
// assertions (see .agent/spec.md §13.2 and .agent/spec-addendum.md A23):
//
//   /page?color=ff0000&title=Alpha  full-viewport flat colour + a 48 px #202020
//                                   header band → NON-uniform, dominant colour ≈ 90 %
//   /solid?color=112233             truly uniform → exercises the uniform-recheck path
//   /slow?ms=3000                   response withheld for ms → tab stays status:'loading'
//   /favicon.png                    16×16 PNG so favIconUrl is non-empty
//
// about:blank / data: / setContent are never used: Chrome refuses to capture them.
'use strict';

const http = require('http');
const zlib = require('zlib');

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** Builds a size×size solid RGBA PNG without any native dependency. */
function makePng(size, r, g, b) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  const raw = Buffer.alloc(size * (1 + size * 4));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const FAVICON = makePng(16, 0x4f, 0x7c, 0xff);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function normColor(raw, fallback) {
  const v = String(raw || '').replace(/^#/, '').toLowerCase();
  return /^[0-9a-f]{6}$/.test(v) ? v : fallback;
}

function bandedPage(color, title) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<link rel="icon" type="image/png" href="/favicon.png">
<style>
  html, body { margin:0; padding:0; width:100%; height:100%; background:#${color}; }
  .band { height:48px; background:#202020; color:#f5f5f5;
          font:600 18px/48px system-ui, sans-serif; padding:0 12px; letter-spacing:.04em; }
  .band b { color:#ffffff; }
</style>
</head><body>
<div class="band"><b>${esc(title)}</b> &middot; #${esc(color)}</div>
</body></html>`;
}

function solidPage(color, title) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<link rel="icon" type="image/png" href="/favicon.png">
<style>html, body { margin:0; padding:0; width:100%; height:100%; background:#${color}; }</style>
</head><body></body></html>`;
}

/**
 * Pages that look like pages.
 *
 * The flat-colour fixtures are perfect for asserting on pixels and useless for showing
 * anyone what the extension does: a preview of a solid red rectangle demonstrates
 * nothing. These render a plausible article, dashboard, mail list or document, with
 * invented content and no real names, so a preview of one looks like a preview.
 */
function mockPage(kind, title, accent) {
  const shell = (inner, bg = '#ffffff') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<link rel="icon" type="image/png" href="/favicon.png">
<style>
  *{box-sizing:border-box}
  body{margin:0;background:${bg};color:#1c2128;
       font:15px/1.65 "Hiragino Sans","Noto Sans JP",system-ui,-apple-system,sans-serif}
  .top{height:52px;background:#${accent};display:flex;align-items:center;gap:14px;padding:0 22px;color:#fff}
  .brand{font-weight:700;font-size:16px;letter-spacing:.02em}
  .nav{display:flex;gap:16px;font-size:13px;opacity:.85;margin-left:18px}
  .wrap{max-width:1000px;margin:0 auto;padding:30px 26px}
  h1{font-size:31px;line-height:1.3;margin:0 0 10px}
  .meta{color:#6b7480;font-size:13px;margin-bottom:22px}
  p{margin:0 0 14px;color:#3b444f}
  .lede{font-size:17px;color:#242b34}
  .hero{height:190px;border-radius:8px;margin:0 0 22px;
        background:linear-gradient(120deg,#${accent} 0%,#${accent}bb 55%,#e8ecf2 100%)}
  .cols{display:grid;grid-template-columns:1fr 250px;gap:30px}
  .card{border:1px solid #e3e7ee;border-radius:8px;padding:14px 16px;margin-bottom:12px}
  .k{font-size:11px;letter-spacing:.12em;color:#8b94a1;text-transform:uppercase}
  .v{font-size:27px;font-weight:700;margin-top:2px}
  .grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:22px}
  .bars{display:flex;align-items:flex-end;gap:9px;height:130px;padding:14px;border:1px solid #e3e7ee;border-radius:8px}
  .bars i{flex:1;background:#${accent};border-radius:3px 3px 0 0;display:block}
  .row{display:flex;gap:12px;padding:11px 4px;border-bottom:1px solid #edf0f5;align-items:center}
  .av{width:30px;height:30px;border-radius:50%;background:#${accent};flex:none;opacity:.85}
  .row b{font-size:14px}
  .row span{color:#6b7480;font-size:13px}
  .side{font-size:13px;color:#6b7480}
  .side div{padding:7px 0;border-bottom:1px solid #edf0f5}
</style></head><body>${inner}</body></html>`;

  const top = `<div class="top"><span class="brand">${esc(title)}</span>
    <span class="nav"><span>Overview</span><span>Library</span><span>Settings</span></span></div>`;

  if (kind === 'dashboard') {
    return shell(`${top}<div class="wrap">
      <h1>This week</h1>
      <div class="meta">Updated a few minutes ago</div>
      <div class="grid3">
        <div class="card"><div class="k">Open</div><div class="v">128</div></div>
        <div class="card"><div class="k">Closed</div><div class="v">94</div></div>
        <div class="card"><div class="k">Waiting</div><div class="v">17</div></div>
      </div>
      <div class="bars"><i style="height:44%"></i><i style="height:71%"></i><i style="height:39%"></i>
        <i style="height:88%"></i><i style="height:57%"></i><i style="height:96%"></i><i style="height:63%"></i></div>
    </div>`, '#f7f9fc');
  }

  if (kind === 'mail') {
    const rows = [
      ['Deployment finished', 'The nightly build is on staging and the checks are green.'],
      ['Re: schedule for Thursday', 'Moving it an hour later works for everyone except the design review.'],
      ['Weekly summary', 'Seventeen items closed, four carried over, nothing blocked.'],
      ['Invoice 2291', 'Attached, due at the end of the month.'],
      ['Re: the migration plan', 'The second phase can start once the index finishes rebuilding.'],
      ['Notes from the workshop', 'Everything we agreed, plus the two questions left open.'],
    ].map(([a, b]) => `<div class="row"><span class="av"></span><div><b>${a}</b><br><span>${b}</span></div></div>`).join('');
    return shell(`${top}<div class="wrap"><h1>Inbox</h1><div class="meta">6 unread</div>${rows}</div>`);
  }

  if (kind === 'docs') {
    return shell(`${top}<div class="wrap"><div class="cols"><div>
      <h1>Getting started</h1>
      <div class="meta">Last edited yesterday</div>
      <p class="lede">This page walks through the shortest path from an empty project to something running, and points at the longer explanations where they matter.</p>
      <p>Begin with the defaults. They are chosen so that the common case needs no configuration at all, and every one of them can be changed later without starting over.</p>
      <p>The three sections below cover installation, the first run, and what to do when the first run does not go the way it should.</p>
      <p>Where a step has a cost that is not obvious, it is called out rather than buried, so you can decide whether to pay it.</p>
      </div><div class="side">
      <div>Installation</div><div>First run</div><div>Configuration</div><div>Troubleshooting</div><div>Reference</div>
      </div></div></div>`);
  }

  return shell(`${top}<div class="wrap">
    <h1>${esc(title)}</h1>
    <div class="meta">Eight minute read · Updated today</div>
    <div class="hero"></div>
    <p class="lede">A browser window with forty tabs in it is not a list any more; it is a row of identical squares, and finding the one you want means clicking through them.</p>
    <p>The horizontal strip was designed for a handful of tabs. Past that, titles vanish first, then the favicons start repeating, and what is left is a guess.</p>
    <p>Vertical space is the resource nobody is short of on a wide screen, which is why a vertical list holds its shape long after the strip has given up.</p>
    <p>What the list still cannot tell you is what is actually on a page, and that is the part a picture answers better than any amount of text.</p>
  </div>`);
}

/**
 * A page taller than the viewport whose top and body are different flat colours.
 *
 * `previewMoment` is about WHICH PART of a page a preview shows, so testing it needs a
 * page where the top and the middle look different. The header block is two viewports
 * tall so that a capture taken at the top is entirely header, and the body is six more
 * so that a reader scrolled into it sees no header at all.
 */
function tallPage(head, body, title) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<link rel="icon" type="image/png" href="/favicon.png">
<style>
  html, body { margin:0; padding:0; }
  .head { height:200vh; background:#${head}; }
  .body { height:600vh; background:#${body}; }
</style>
</head><body><div class="head"></div><div class="body"></div></body></html>`;
}

/**
 * Starts the fixture server on 127.0.0.1 with an ephemeral port.
 * @returns {Promise<{origin:string, port:number, close:()=>Promise<void>,
 *   page:(color:string,title:string,extra?:object)=>string,
 *   solid:(color:string,title?:string)=>string, slow:(ms:number)=>string,
 *   tall:(head?:string,body?:string,title?:string)=>string,
 *   mock:(kind:string,title:string,accent?:string)=>string,
 *   alpha:string, beta:string, gamma:string, delta:string, hits:()=>number}>}
 */
async function startFixtureServer() {
  let hits = 0;
  const pending = new Set();

  const server = http.createServer((req, res) => {
    hits += 1;
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    const q = url.searchParams;
    const noCache = {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
    };

    if (url.pathname === '/favicon.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': FAVICON.length, ...noCache });
      res.end(FAVICON);
      return;
    }

    if (url.pathname === '/page') {
      const body = bandedPage(normColor(q.get('color'), 'ff0000'), q.get('title') || 'Fixture');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...noCache });
      res.end(body);
      return;
    }

    if (url.pathname === '/mock') {
      const body = mockPage(q.get('kind') || 'article', q.get('title') || 'Article',
        normColor(q.get('accent'), '3b5bdb'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...noCache });
      res.end(body);
      return;
    }

    if (url.pathname === '/tall') {
      const body = tallPage(
        normColor(q.get('head'), 'ff0000'),
        normColor(q.get('body'), '0000ff'),
        q.get('title') || 'Tall',
      );
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...noCache });
      res.end(body);
      return;
    }

    if (url.pathname === '/solid') {
      const body = solidPage(normColor(q.get('color'), '123456'), q.get('title') || 'Solid');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...noCache });
      res.end(body);
      return;
    }

    if (url.pathname === '/slow') {
      const ms = Math.min(Math.max(Number(q.get('ms')) || 3000, 0), 30000);
      const body = bandedPage(normColor(q.get('color'), '888800'), q.get('title') || 'Slow');
      const timer = setTimeout(() => {
        pending.delete(timer);
        if (res.writableEnded) return;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...noCache });
        res.end(body);
      }, ms);
      pending.add(timer);
      res.on('close', () => { clearTimeout(timer); pending.delete(timer); });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...noCache });
    res.end('not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();

  const { port } = /** @type {import('net').AddressInfo} */ (server.address());
  const origin = `http://127.0.0.1:${port}`;

  const page = (color, title, extra = {}) => {
    const u = new URL('/page', origin);
    u.searchParams.set('color', color);
    u.searchParams.set('title', title);
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, String(v));
    return u.href;
  };

  return {
    origin,
    port,
    page,
    solid: (color, title = 'Solid') => {
      const u = new URL('/solid', origin);
      u.searchParams.set('color', color);
      u.searchParams.set('title', title);
      return u.href;
    },
    mock: (kind, title, accent = '3b5bdb') => {
      const u = new URL('/mock', origin);
      u.searchParams.set('kind', kind);
      u.searchParams.set('title', title);
      u.searchParams.set('accent', accent);
      return u.href;
    },
    tall: (head = 'ff0000', body = '0000ff', title = 'Tall') => {
      const u = new URL('/tall', origin);
      u.searchParams.set('head', head);
      u.searchParams.set('body', body);
      u.searchParams.set('title', title);
      return u.href;
    },
    slow: (ms = 3000, title = 'Slow') => {
      const u = new URL('/slow', origin);
      u.searchParams.set('ms', String(ms));
      u.searchParams.set('title', title);
      return u.href;
    },
    alpha: page('ff0000', 'Alpha'),
    beta: page('0000ff', 'Beta'),
    gamma: page('00ff00', 'Gamma'),
    delta: page('ff00ff', 'Delta'),
    hits: () => hits,
    close: async () => {
      for (const t of pending) clearTimeout(t);
      pending.clear();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

module.exports = { startFixtureServer, makePng };
