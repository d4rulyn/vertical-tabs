// What the extension says it does to the user's bookmarks, as tests.
//
// docs/store/permissions.md tells the Web Store reviewer to run `grep -n "bm('" ...` and read the
// method names, and the README says the column never deletes. plan.md D13 makes that a property
// of the code: `chrome.bookmarks` is called from ONE place, the `bm()` wrapper, with LITERAL method
// names, and the names are {getChildren, get, create, update, move}. These tests read every source
// file under extension/ and fail when that stops being true, so "it never deletes" is checked on
// every run instead of being a sentence somebody has to remember to re-verify.
//
// It reads the source; it does not run it. What that cannot see: a call made through another
// name for `bm`, or a `chrome.bookmarks` reached by a route this scan does not model. The write
// spy in tests/helpers/bookmark-edit.js wraps every method at run time and covers the end-to-end
// flows; this file is the tripwire that costs nothing to run. Widening ALLOWED is a decision for
// the owner of the store text, not a way to make a red test green.
//
// Comments are removed before anything is matched, because a comment may say anything
// (`bm('removeTree')` appears in prose all over this repository) and code may not. Removing them
// with two regular expressions, as bookmark-math.test.mjs does for its purity test, is not safe
// here: a `//` or a `/*` inside a string literal would swallow the rest of the line or the next
// block of code, and what it swallows is exactly what this file exists to see. `mask()` below
// reads the source the way the language does (strings, template literals, regular expressions)
// and has its own tests further down.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EXT, walk } from './_load.mjs';

/** What the panel may ask `chrome.bookmarks`. The store text and the docs name exactly this set. */
const ALLOWED = ['getChildren', 'get', 'create', 'update', 'move'];
/** What it must never call: delete, search, and every read of the whole tree. */
const FORBIDDEN = ['remove', 'removeTree', 'search', 'getTree', 'getRecent', 'getSubTree'];

/* ── Reading source the way the language does ─────────────────────────────── */

/** Stands in for the contents of a string, a template literal's text, or a regular expression. */
const FILL = '_';
const WORD = /[\w$\u0080-\uffff]/;
const BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else',
  'yield', 'await',
]);

function lineOf(source, offset) {
  let line = 1;
  for (let k = 0; k < offset; k += 1) if (source.charCodeAt(k) === 10) line += 1;
  return line;
}

/** After this token, is a `/` the start of a regular expression (true) or a division (false)? */
function regexAllowed(prev) {
  if (prev === '') return true;
  if (prev === '++' || prev === '--') return false;
  if (prev === ')' || prev === ']' || prev === '"' || prev === '`') return false;
  if (WORD.test(prev[0])) return BEFORE_REGEX.has(prev);
  return true;
}

/**
 * The source with the same length and the same line breaks, in which every comment is blank and
 * the inside of every string, template literal and regular expression is `FILL`. Quotes, `${`, `}`
 * and the code inside a `${ }` are kept, so what is left is the code and only the code.
 *
 * Throws when it cannot read the source (an unterminated string, comment, template or regular
 * expression): reading it wrongly would hide code, so it says so instead of guessing.
 * @param {string} source
 * @returns {string}
 */
function mask(source) {
  const n = source.length;
  const out = new Array(n);
  const open = []; // one brace counter per `${` that is still open
  let mode = 'code';
  let prev = '';
  let i = 0;

  const fail = (what, at) => { throw new SyntaxError(`${what} (line ${lineOf(source, at)})`); };
  const blank = (from, to) => { for (let k = from; k < to; k += 1) out[k] = source[k] === '\n' ? '\n' : ' '; };
  const fill = (k) => { out[k] = source[k] === '\n' ? '\n' : FILL; };

  const readRegex = (from) => {
    out[from] = '/';
    let j = from + 1;
    let inClass = false;
    for (;;) {
      if (j >= n || source[j] === '\n') fail('unterminated regular expression', from);
      const ch = source[j];
      if (ch === '\\') {
        if (source[j + 1] === undefined || source[j + 1] === '\n') fail('unterminated regular expression', from);
        fill(j);
        fill(j + 1);
        j += 2;
      } else if (inClass) {
        if (ch === ']') inClass = false;
        fill(j);
        j += 1;
      } else if (ch === '[') {
        inClass = true;
        fill(j);
        j += 1;
      } else if (ch === '/') {
        out[j] = '/';
        j += 1;
        break;
      } else {
        fill(j);
        j += 1;
      }
    }
    while (j < n && /[A-Za-z]/.test(source[j])) { out[j] = source[j]; j += 1; }
    return j;
  };

  while (i < n) {
    const c = source[i];
    const d = source[i + 1];

    if (mode === 'template') {
      if (c === '\\') {
        fill(i);
        if (i + 1 < n) fill(i + 1);
        i += 2;
      } else if (c === '`') {
        out[i] = c;
        i += 1;
        mode = 'code';
        prev = '`';
      } else if (c === '$' && d === '{') {
        out[i] = '$';
        out[i + 1] = '{';
        i += 2;
        open.push(0);
        mode = 'code';
        prev = '{';
      } else {
        fill(i);
        i += 1;
      }
      continue;
    }

    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && source[j] !== '\n') j += 1;
      blank(i, j);
      i = j;
    } else if (c === '/' && d === '*') {
      const j = source.indexOf('*/', i + 2);
      if (j < 0) fail('unterminated comment', i);
      blank(i, j + 2);
      i = j + 2;
    } else if (c === '"' || c === "'") {
      out[i] = c;
      let j = i + 1;
      for (;;) {
        if (j >= n || source[j] === '\n') fail('unterminated string', i);
        const ch = source[j];
        if (ch === '\\') {
          fill(j);
          if (j + 1 < n) fill(j + 1);
          j += 2;
        } else if (ch === c) {
          out[j] = c;
          j += 1;
          break;
        } else {
          fill(j);
          j += 1;
        }
      }
      i = j;
      prev = '"';
    } else if (c === '`') {
      out[i] = c;
      i += 1;
      mode = 'template';
    } else if (c === '{') {
      if (open.length) open[open.length - 1] += 1;
      out[i] = c;
      i += 1;
      prev = '{';
    } else if (c === '}') {
      out[i] = c;
      i += 1;
      prev = '}';
      if (open.length) {
        if (open[open.length - 1] === 0) {
          open.pop();
          mode = 'template';
        } else {
          open[open.length - 1] -= 1;
        }
      }
    } else if (c === '/') {
      if (regexAllowed(prev)) {
        i = readRegex(i);
        prev = ')';
      } else {
        out[i] = c;
        i += 1;
        prev = '/';
      }
    } else if (WORD.test(c)) {
      let j = i;
      while (j < n && WORD.test(source[j])) { out[j] = source[j]; j += 1; }
      prev = source.slice(i, j);
      i = j;
    } else if (/\s/.test(c)) {
      out[i] = c;
      i += 1;
    } else if ((c === '+' || c === '-') && d === c) {
      out[i] = c;
      out[i + 1] = c;
      i += 2;
      prev = c + c;
    } else {
      out[i] = c;
      i += 1;
      prev = c;
    }
  }
  if (mode !== 'code' || open.length) fail('end of file inside a template literal', n);
  return out.join('');
}

/**
 * The string literal that opens at `p` in the masked code: its text (from the original source,
 * because the masked one has none), where it ends, and whether it is a template with `${ }` in it.
 * Null when what is at `p` is not a quote.
 */
function literalAt(code, source, p) {
  const quote = code[p];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  const close = code.indexOf(quote, p + 1);
  if (close < 0) return null;
  if (quote === '`') {
    const substitution = code.indexOf('${', p + 1);
    if (substitution >= 0 && substitution < close) return { value: null, end: close + 1, templated: true };
  }
  return { value: source.slice(p + 1, close), end: close + 1, templated: false };
}

/**
 * Every place in `source` that matters to the claims, comments and the inside of strings aside:
 *   brackets  `chrome.bookmarks[...]`        { line, literal, key }  (key: the text of a literal key)
 *   members   `chrome.bookmarks.<name>`      { line, name }          (also `?.` and a line break before the dot)
 *   bare      `chrome.bookmarks` with no `[` or `.` after it (an alias, a presence test)   { line }
 *   calls     `bm('<name>', ...)`            { line, name }          (also `host.bm(...)`)
 *   dynamic   a `bm(` call whose first argument is not a plain string literal, `bm.call` and its kin
 * The definition `function bm(` is not a call.
 * @param {string} source
 */
function scan(source) {
  const code = mask(source);
  const found = { brackets: [], members: [], bare: [], calls: [], dynamic: [] };
  const line = (offset) => lineOf(source, offset);

  // Every way of naming the namespace: `chrome.bookmarks`, `chrome?.bookmarks`, `chrome['bookmarks']`;
  // `from` is the offset just after it.
  const uses = [];
  for (const m of code.matchAll(/(?<![\w$])chrome\s*(?:\?\.|\.)\s*bookmarks(?![\w$])/g)) {
    uses.push({ at: m.index, from: m.index + m[0].length });
  }
  for (const m of code.matchAll(/(?<![\w$])chrome\s*(?:\?\.)?\s*\[\s*(?=['"`])/g)) {
    const lit = literalAt(code, source, m.index + m[0].length);
    const close = lit && !lit.templated ? /^\s*\]/.exec(code.slice(lit.end)) : null;
    if (close && lit.value === 'bookmarks') uses.push({ at: m.index, from: lit.end + close[0].length });
  }
  // `const { bookmarks } = chrome` is an alias made in one step.
  for (const m of code.matchAll(/\{[^{}]*(?<![\w$])bookmarks(?![\w$])[^{}]*\}\s*=\s*(?:(?:globalThis|window|self)\s*\.\s*)?chrome(?![\w$])/g)) {
    found.bare.push({ line: line(m.index) });
  }

  for (const use of uses) {
    const access = /^\s*(\?\.|\.|\[)\s*/.exec(code.slice(use.from));
    if (!access) {
      found.bare.push({ line: line(use.at) });
    } else if (access[1] === '[') {
      const lit = literalAt(code, source, use.from + access[0].length);
      found.brackets.push({ line: line(use.at), literal: Boolean(lit), key: lit ? lit.value : null });
    } else {
      const name = /^[A-Za-z_$][\w$]*/.exec(code.slice(use.from + access[0].length));
      found.members.push({ line: line(use.at), name: name ? name[0] : null });
    }
  }

  for (const m of code.matchAll(/(?<![\w$])bm\s*(?:\?\.)?\s*\(/g)) {
    if (/\bfunction\s*\*?\s*$/.test(code.slice(Math.max(0, m.index - 40), m.index))) continue;
    const from = m.index + m[0].length;
    const lit = literalAt(code, source, from + /^\s*/.exec(code.slice(from))[0].length);
    const plain = lit && !lit.templated && /^\s*[,)]/.test(code.slice(lit.end));
    if (plain) found.calls.push({ line: line(m.index), name: lit.value });
    else found.dynamic.push({ line: line(m.index), text: source.slice(m.index, m.index + 60).split('\n')[0] });
  }
  for (const m of code.matchAll(/(?<![\w$])bm\s*\.\s*(?:call|apply|bind)(?![\w$])/g)) {
    found.dynamic.push({ line: line(m.index), text: source.slice(m.index, m.index + 60).split('\n')[0] });
  }
  return found;
}

/* ── The reader reads correctly (each of these has to be able to fail) ────── */

/** The method names of the `bm('<name>')` calls found in a snippet. */
const names = (source) => scan(source).calls.map((c) => c.name);

test('reading source: a comment says what it likes, a call does not', () => {
  assert.deepEqual(names("// bm('removeTree', '1')\nbm('get', '1');"), ['get'], 'a line comment');
  assert.deepEqual(names("/* bm('removeTree', '1') */ bm('get', '1');"), ['get'], 'a block comment');
  assert.deepEqual(names("/**\n * `bm('removeTree')` is never called\n * and it's \"quoted\" here\n */\nbm('get', 1);"),
    ['get'], 'a doc comment with quotes and an apostrophe in it');
  assert.deepEqual(names("// it's the user's\nbm('get', 1); // don't\n"), ['get'], 'apostrophes in comments open no string');
  assert.deepEqual(names("bm('create', {}); // bm('removeTree')\n"), ['create'], 'a comment after code on the same line');
  const withComments = scan("// chrome.bookmarks['removeTree']\n/* chrome.bookmarks.remove(1) */ const x = 1;");
  assert.deepEqual([withComments.brackets, withComments.members, withComments.bare], [[], [], []],
    'chrome.bookmarks in a comment is not a use of it');
});

test('reading source: what looks like a comment inside a string or a regular expression is not one', () => {
  assert.deepEqual(names("const u = 'https://example.com//x'; bm('removeTree', '1');"), ['removeTree'],
    '// inside a string does not hide the rest of the line');
  assert.deepEqual(names("const g = '**/*.js'; bm('removeTree', '1');"), ['removeTree'],
    '/* inside a string does not swallow the code after it');
  assert.deepEqual(names('const g = "a//b"; const h = `c//d`; bm(\'removeTree\', 1);'), ['removeTree'],
    'in double quotes and in a template');
  assert.deepEqual(names("const r = /\\/\\//g; bm('removeTree', 1);"), ['removeTree'], 'a regular expression of two slashes');
  assert.deepEqual(names("const r = /['\"`]/; bm('removeTree', 1);"), ['removeTree'], 'quotes inside a regular expression open no string');
  assert.deepEqual(names("if (/[/]bm\\('x'\\)/.test(s)) bm('get', 1);"), ['get'], 'a slash inside a character class, a call written inside a regular expression');
});

test('reading source: a call written inside a string is not a call, and one inside ${ } is', () => {
  assert.deepEqual(names("const s = \"bm('removeTree', '1')\"; const t = 'bm(\\'removeTree\\')';"), [], 'in strings');
  assert.deepEqual(names("const a = `bm('removeTree')`; const b = `x ${bm('move', '1')} y`;"), ['move'],
    'the text of a template is not code, what is inside ${ } is');
  assert.deepEqual(names("`a ${ `b ${ bm('update', '1') }` } c`"), ['update'], 'nested templates');
  assert.deepEqual(names("`${ items.map((x) => { return bm('get', x); }).join('') }`"), ['get'], 'braces inside ${ }');
});

test('reading source: a division is not the start of a regular expression', () => {
  assert.deepEqual(names("const half = total / 2; const q = (a + b) / 2 / 3; bm('removeTree', 1);"), ['removeTree']);
  assert.deepEqual(names("i++ / 2; j-- / 3; bm('removeTree', 1);"), ['removeTree'], 'after ++ and --');
  assert.deepEqual(names("const x = a[0] / b[1]; bm('removeTree', 1);"), ['removeTree'], 'after ]');
  assert.deepEqual(names("const f = () => /'/.test(s); bm('get', 1);"), ['get'], 'a regular expression after =>');
  assert.deepEqual(names("const g = (s) => { return /\"/.test(s); }; bm('get', 1);"), ['get'], 'and after return');
});

test('reading source: what it cannot read is an error, not a pass', () => {
  assert.throws(() => mask("const s = 'abc\nbm('removeTree');"), /unterminated string \(line 1\)/);
  assert.throws(() => mask('/* never closed\nbm(\'get\')'), /unterminated comment \(line 1\)/);
  assert.throws(() => mask('const t = `never closed\nbm(\'get\')'), /template literal/);
  assert.throws(() => mask('const r = /never closed\nbm(\'get\')'), /unterminated regular expression \(line 1\)/);
  assert.throws(() => mask('const t = `${ bm(\'get\') '), /template literal/);
});

test('reading source: the mask keeps every offset and every line break', () => {
  const source = "a /* x\ny */ b; const s = 'q\\'r'; const t = `u ${ v } w`; // z\nconst r = /[/]\\//g;\n";
  const code = mask(source);
  assert.equal(code.length, source.length);
  assert.deepEqual([...code].flatMap((ch, k) => (ch === '\n' ? [k] : [])),
    [...source].flatMap((ch, k) => (ch === '\n' ? [k] : [])));
});

test('scanning: the shapes chrome.bookmarks and bm() can take', () => {
  const s = (source) => scan(source);
  assert.deepEqual(s('return await chrome.bookmarks[method](...args);').brackets,
    [{ line: 1, literal: false, key: null }], 'the wrapper');
  assert.deepEqual(s("chrome.bookmarks['removeTree']('1');").brackets,
    [{ line: 1, literal: true, key: 'removeTree' }], 'a literal key');
  assert.deepEqual(s('chrome.bookmarks.remove(id);').members, [{ line: 1, name: 'remove' }]);
  assert.deepEqual(s('chrome.bookmarks?.removeTree(id);').members, [{ line: 1, name: 'removeTree' }], 'optional chaining');
  assert.deepEqual(s('chrome.bookmarks\n  .remove(id);').members, [{ line: 1, name: 'remove' }], 'a line break before the dot');
  assert.deepEqual(s('globalThis.chrome.bookmarks.remove(id);').members, [{ line: 1, name: 'remove' }], 'behind another object');
  assert.deepEqual(s('chrome?.bookmarks.remove(id);').members, [{ line: 1, name: 'remove' }], 'chrome?.bookmarks');
  assert.deepEqual(s("chrome['bookmarks'].remove(id);").members, [{ line: 1, name: 'remove' }], "chrome['bookmarks']");
  assert.deepEqual(s('chrome["bookmarks"]\n  .removeTree(id);').members, [{ line: 1, name: 'removeTree' }], 'in double quotes, line break');
  assert.equal(s('const { bookmarks } = chrome;').bare.length, 1, 'destructured out of chrome');
  assert.equal(s('const { alarms, bookmarks: b } = globalThis.chrome;').bare.length, 1, 'destructured out of globalThis.chrome');
  const unrelated = s("chrome.bookmarksFoo(); chrome.bookmark(); chrome['alarms'].get(); const { alarms } = chrome; xchrome.bookmarks.remove(1);");
  assert.deepEqual([unrelated.brackets, unrelated.members, unrelated.bare], [[], [], []], 'other names are not it');
  assert.deepEqual(s('[chrome.bookmarks.onCreated, () => {}]').members, [{ line: 1, name: 'onCreated' }], 'an event');
  assert.equal(s('const b = chrome.bookmarks;').bare.length, 1, 'an alias');
  assert.equal(s('if (chrome.bookmarks) go();').bare.length, 1, 'a presence test');
  assert.deepEqual(s("host.bm('get', id);").calls, [{ line: 1, name: 'get' }], 'through a host object');
  assert.deepEqual(s("bm(\n  'get',\n  id);").calls, [{ line: 1, name: 'get' }], 'the name on the next line');
  assert.deepEqual(s('bm(`get`, id);').calls, [{ line: 1, name: 'get' }], 'a template without ${ }');
  assert.deepEqual(s("bm?.('get', id);").calls, [{ line: 1, name: 'get' }], 'an optional call');
  for (const dynamic of ['bm(name, id);', 'bm(`${name}`, id);', "bm('a' + b, id);", 'bm(...args);', "bm.call(null, 'removeTree');",
    "bm.apply(null, ['removeTree']);", 'const f = bm.bind(null);']) {
    assert.equal(s(dynamic).dynamic.length, 1, `${dynamic} cannot be checked, so it is refused`);
    assert.deepEqual(s(dynamic).calls, [], `${dynamic} is not read as a literal call`);
  }
  assert.deepEqual(s('async function bm(method, ...args) { return null; }').dynamic, [], 'the definition is not a call');
  assert.deepEqual(s("rebm('x'); $bm('x'); xbm.bm_('x');").calls, [], 'other names that end in bm');
});

/* ── The claims, on the extension as it is ────────────────────────────────── */

const FILES = walk(EXT, (file) => /\.[cm]?js$/.test(file)).sort();
const rel = (file) => path.relative(path.dirname(EXT), file).split(path.sep).join('/');
const SCANNED = FILES.map((file) => {
  try {
    return { file: rel(file), ...scan(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    return { file: rel(file), error: err.message };
  }
});

/** Every source file, scanned. A file that cannot be read is a failure here too, never a skip. */
function scanned() {
  assert.deepEqual(SCANNED.filter((r) => r.error).map((r) => `${r.file}: ${r.error}`), [],
    'every file under extension/ must be readable by the scan, or the claims below say nothing about it');
  return SCANNED;
}

test('claims: every extension source is read to the end', () => {
  assert.ok(scanned().length > 0, `no .js under ${EXT}: the claims below would hold of nothing`);
  for (const file of FILES) {
    const source = fs.readFileSync(file, 'utf8');
    assert.equal(mask(source).length, source.length, `${rel(file)}: the mask lost its place`);
  }
});

test('claims: chrome.bookmarks has exactly one computed-key call site, the bm() wrapper', () => {
  const sites = scanned().flatMap((r) => r.brackets.map((b) => ({ at: `${r.file}:${b.line}`, ...b })));
  assert.equal(sites.length, 1,
    `expected exactly one \`chrome.bookmarks[\`, found ${sites.length}: ${sites.map((s) => s.at).join(', ') || 'none'}`);
  assert.equal(sites[0].literal, false, `${sites[0].at}: the method must come from a variable, not a string literal`);
});

test('claims: chrome.bookmarks is used only through that wrapper, its events and its constants', () => {
  const bad = [];
  for (const r of scanned()) {
    for (const m of r.members) {
      if (!/^(?:on[A-Z]\w*|[A-Z][A-Z0-9_]+)$/.test(m.name || '')) bad.push(`${r.file}:${m.line} chrome.bookmarks.${m.name}`);
    }
    for (const b of r.bare) bad.push(`${r.file}:${b.line} chrome.bookmarks as a bare value (an alias bypasses the wrapper)`);
  }
  assert.deepEqual(bad, [], `calls go through bm(); found:\n${bad.join('\n')}`);
});

test(`claims: every bm('<name>') names one of ${ALLOWED.join(', ')}, as a string literal`, () => {
  const bad = [];
  for (const r of scanned()) {
    for (const c of r.calls) if (!ALLOWED.includes(c.name)) bad.push(`${r.file}:${c.line} bm('${c.name}')`);
    for (const d of r.dynamic) bad.push(`${r.file}:${d.line} ${d.text}  (the method name must be a string literal)`);
  }
  assert.deepEqual(bad, [], `the method names are the store's promise (${ALLOWED.join(', ')}); found:\n${bad.join('\n')}`);
});

test(`claims: nothing calls ${FORBIDDEN.join(', ')}`, () => {
  const bad = [];
  for (const r of scanned()) {
    for (const c of r.calls) if (FORBIDDEN.includes(c.name)) bad.push(`${r.file}:${c.line} bm('${c.name}')`);
    for (const m of r.members) if (FORBIDDEN.includes(m.name)) bad.push(`${r.file}:${m.line} chrome.bookmarks.${m.name}`);
    for (const b of r.brackets) if (FORBIDDEN.includes(b.key)) bad.push(`${r.file}:${b.line} chrome.bookmarks['${b.key}']`);
  }
  assert.deepEqual(bad, [], `the extension never deletes, searches or reads the whole tree; found:\n${bad.join('\n')}`);
});

test('claims: the scan finds the calls that are there (a scan that finds nothing proves nothing)', () => {
  const used = new Set(scanned().flatMap((r) => r.calls.map((c) => c.name)));
  assert.ok(used.has('getChildren'), `the column reads folders with bm('getChildren'); the scan found: ${[...used].join(', ') || 'nothing'}`);
});
