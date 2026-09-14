// Loads the extension's pure ES modules into Node's test runner.
//
// extension/**/*.js are ES modules, but Node decides that from the nearest
// package.json "type". If the repository root package.json ({"private":true,
// "type":"module"}) is present the direct import works; if it is missing Node would
// treat the files as CommonJS and throw on `export`. The mirror below keeps the unit
// tests running either way by copying extension/common/*.js to tests/output/esm/*.mjs
// with relative specifiers rewritten. Nothing is transformed beyond the extension.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');
export const EXT = process.env.EXT_DIR || path.join(REPO, 'extension');
const COMMON = path.join(EXT, 'common');
const MIRROR = path.join(process.env.OUT_DIR || path.join(REPO, 'tests', 'output'), 'esm');

const ESM_SYNTAX_ERROR = /Unexpected token '?export'?|Cannot use import statement|require\(\) of ES Module|ERR_REQUIRE_ESM/i;

let mirrored = false;

function rewriteSpecifiers(src) {
  return src
    .replace(/(\bfrom\s*['"])(\.\.?\/[^'"]+?)\.js(['"])/g, '$1$2.mjs$3')
    .replace(/(\bimport\s*\(\s*['"])(\.\.?\/[^'"]+?)\.js(['"])/g, '$1$2.mjs$3')
    .replace(/(\bexport\s+\*\s+from\s*['"])(\.\.?\/[^'"]+?)\.js(['"])/g, '$1$2.mjs$3');
}

function buildMirror() {
  if (mirrored) return;
  fs.mkdirSync(MIRROR, { recursive: true });
  for (const file of fs.readdirSync(COMMON)) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(COMMON, file), 'utf8');
    fs.writeFileSync(path.join(MIRROR, file.replace(/\.js$/, '.mjs')), rewriteSpecifiers(src));
  }
  mirrored = true;
}

/**
 * Imports extension/common/<name>.js.
 * @param {string} name file name including the .js extension
 */
export async function loadCommon(name) {
  const direct = path.join(COMMON, name);
  if (!fs.existsSync(direct)) {
    throw new Error(`extension/common/${name} does not exist — the module contract is not met`);
  }
  try {
    return await import(pathToFileURL(direct).href);
  } catch (err) {
    if (!ESM_SYNTAX_ERROR.test(String((err && err.message) || err))) throw err;
    buildMirror();
    return import(pathToFileURL(path.join(MIRROR, name.replace(/\.js$/, '.mjs'))).href);
  }
}

/** Recursively lists files under `dir` matching `filter`. */
export function walk(dir, filter = () => true, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
