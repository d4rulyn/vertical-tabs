// Numeric constants read straight out of the extension's own constants module.
//
// The e2e specs are CommonJS running in Node, while `extension/common/constants.js` is
// an ES module the browser loads, so the values are parsed from source instead of
// imported. A missing or non-numeric constant throws rather than yielding `undefined`:
// an assertion that silently compared against `undefined` would pass for the wrong
// reason, which is exactly the failure mode these helpers exist to avoid.
'use strict';

const fs = require('fs');
const path = require('path');

// Same resolution as tests/fixtures.js (EXT_DIR is set by tests/docker-compose.yml);
// requiring fixtures.js from here would close a require cycle through helpers/windows.js.
const EXT = process.env.EXT_DIR || path.resolve(__dirname, '../../extension');
const CONSTANTS_FILE = path.join(EXT, 'common', 'constants.js');

let cachedSource = null;

function constantsSource() {
  if (cachedSource == null) cachedSource = fs.readFileSync(CONSTANTS_FILE, 'utf8');
  return cachedSource;
}

/**
 * Reads `export const <name> = <number>;` from extension/common/constants.js.
 * @param {string} name
 * @returns {number}
 */
function extConstant(name) {
  const re = new RegExp(`^export const ${name}\\s*=\\s*([-+0-9._eE]+)\\s*;`, 'm');
  const m = re.exec(constantsSource());
  if (!m) throw new Error(`${CONSTANTS_FILE} does not export a numeric ${name}`);
  const value = Number(m[1].replace(/_/g, ''));
  if (!Number.isFinite(value)) {
    throw new Error(`${name} in ${CONSTANTS_FILE} is not a finite number: ${m[1]}`);
  }
  return value;
}

module.exports = { extConstant, CONSTANTS_FILE, EXT_DIR: EXT };
