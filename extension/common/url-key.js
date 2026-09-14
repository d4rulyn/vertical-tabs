/**
 * URL keying and capture eligibility (spec.md §4.1, spec-addendum A8).
 *
 * PURE: `urlKey()` and `classifyUrl()` touch nothing outside their arguments,
 * so `tests/unit/url-key.test.mjs` can import this module under `node --test`.
 * `isOwnPanelUrl()` reads `chrome.runtime` lazily and accepts an explicit base
 * URL so it, too, is testable outside the extension.
 */

import { URL_KEY_MAX_LENGTH, PANEL_PATH } from './constants.js';
import { hostMatches } from './settings-schema.js';

/** Ports that are implied by their scheme and therefore dropped from the key. */
const DEFAULT_PORTS = {
  'http:': '80',
  'https:': '443',
  'ws:': '80',
  'wss:': '443',
  'ftp:': '21',
};

/**
 * Parse a URL, returning `null` instead of throwing.
 * @param {unknown} url
 * @returns {URL|null}
 */
function parse(url) {
  if (typeof url !== 'string' || url === '') return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * `scheme://host[:port]` of a parsed URL, or '' when the URL has no authority
 * (`about:blank`, `data:…`, `javascript:…`).
 *
 * Deliberately not `URL#origin`: for non-special schemes that property is the
 * string `"null"` in Node — which would make every opaque URL compare equal to
 * a `chrome-extension://…` own-origin in the unit tests — while Chrome returns
 * a real origin for `chrome-extension:`. Computing the authority ourselves
 * behaves identically in both environments.
 *
 * @param {URL} u
 * @returns {string}
 */
function authorityOf(u) {
  if (!u.href.slice(u.protocol.length).startsWith('//')) return '';
  const host = u.hostname.toLowerCase();
  if (!host) return '';
  const port = u.port ? `:${u.port}` : '';
  return `${u.protocol.toLowerCase()}//${host}${port}`;
}

/**
 * Stable identity of a page, used as the IndexedDB primary key so a preview
 * survives tab-id churn (restart, trash restore, duplicate tabs).
 *
 * Scheme and host are lower-cased (the WHATWG parser already does this), a
 * default port is dropped, and path + query + **fragment** are kept on purpose
 * so hash-routed SPAs get one preview per route. The result is truncated to
 * `URL_KEY_MAX_LENGTH` characters.
 *
 * @param {unknown} url
 * @returns {string|null} `null` for '' and for anything the URL parser rejects
 */
export function urlKey(url) {
  const u = parse(url);
  if (!u) return null;

  const scheme = u.protocol.toLowerCase();
  // Distinguish hierarchical URLs ("scheme://host/path") from opaque ones
  // ("about:blank", "data:text/html,x"): only the former carry an authority.
  const hasAuthority = u.href.slice(u.protocol.length).startsWith('//');

  let key;
  if (hasAuthority) {
    const host = u.hostname.toLowerCase();
    const port = u.port && u.port !== DEFAULT_PORTS[scheme] ? `:${u.port}` : '';
    key = `${scheme}//${host}${port}${u.pathname}${u.search}${u.hash}`;
  } else {
    key = `${scheme}${u.pathname}${u.search}${u.hash}`;
  }

  return key.length > URL_KEY_MAX_LENGTH ? key.slice(0, URL_KEY_MAX_LENGTH) : key;
}

/**
 * Chromium refuses to screenshot the Chrome Web Store without `activeTab`, and
 * `IsWebstoreOrigin()` covers the legacy origin as well (spec-addendum A8.5).
 * @param {string} host lower-cased hostname
 * @param {string} pathname
 * @returns {boolean}
 */
function isWebStore(host, pathname) {
  return (
    host === 'chromewebstore.google.com' ||
    (host === 'chrome.google.com' && pathname.startsWith('/webstore'))
  );
}

/**
 * Normalise an "own origin" argument. Callers pass either
 * `chrome.runtime.getURL('')` (`chrome-extension://<id>/`) or `location.origin`
 * (`chrome-extension://<id>`); both reduce to the same authority.
 * @param {unknown} ownOrigin
 * @returns {string} '' when unusable
 */
function normalizeOrigin(ownOrigin) {
  if (typeof ownOrigin !== 'string' || ownOrigin === '') return '';
  const trimmed = ownOrigin.replace(/\/+$/, '');
  const u = parse(trimmed);
  return u ? authorityOf(u) : trimmed.toLowerCase();
}

/**
 * Decide whether a URL may be captured at all — evaluated *before* any
 * `captureVisibleTab` call so a restricted page never spends a quota token
 * (spec.md §4.1, §7.4 step 3h).
 *
 * The same function runs in the panel so cards reach a terminal state without a
 * round trip to the service worker (spec-addendum A10); pass the same inputs.
 *
 * @param {unknown} url
 * @param {object} [options]
 * @param {string[]} [options.excludedHosts] user patterns, `settings.excludedHosts`
 * @param {boolean} [options.fileAccess] `chrome.extension.isAllowedFileSchemeAccess()`
 * @param {string} [options.ownOrigin] this extension's origin
 * @returns {'ok'|'restricted'|'excluded'}
 */
export function classifyUrl(url, options = {}) {
  const { excludedHosts = [], fileAccess = false, ownOrigin = '' } = options || {};

  const u = parse(url);
  // '' / unparsable / about: — nothing to screenshot, and `about:blank` is
  // rejected by Chromium before any visibility check (measured).
  if (!u) return 'restricted';

  const own = normalizeOrigin(ownOrigin);
  if (own && authorityOf(u) === own) return 'excluded'; // our own pages: capturable, but useless

  const scheme = u.protocol.toLowerCase();

  if (scheme === 'http:' || scheme === 'https:') {
    const host = u.hostname.toLowerCase();
    if (hostMatches(host, excludedHosts)) return 'excluded';
    if (isWebStore(host, u.pathname)) return 'restricted';
    return 'ok';
  }

  if (scheme === 'file:') return fileAccess ? 'ok' : 'restricted';

  // chrome:, chrome-untrusted:, chrome-extension: (other extensions), devtools:,
  // data:, blob:, javascript:, view-source:, about:, edge:, … — only `activeTab`
  // can capture these, and this extension deliberately does not request it.
  return 'restricted';
}

/**
 * The panel's own document URL, used to keep the panel from listing itself when
 * it is opened as a normal tab (tests, debugging) — spec.md §4.1, §8.2.
 * @returns {string} '' outside an extension context
 */
export function panelUrlBase() {
  try {
    return chrome.runtime.getURL(PANEL_PATH);
  } catch {
    return '';
  }
}

/**
 * @param {unknown} url
 * @param {string} [base] injectable for unit tests; defaults to `panelUrlBase()`
 * @returns {boolean}
 */
export function isOwnPanelUrl(url, base = panelUrlBase()) {
  if (typeof url !== 'string' || url === '' || !base) return false;
  return url.startsWith(base);
}

/**
 * This extension's origin without a trailing slash, ready to be passed as
 * `classifyUrl(url, { ownOrigin })`.
 * @returns {string} '' outside an extension context
 */
export function getOwnOrigin() {
  try {
    return chrome.runtime.getURL('').replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/**
 * Origin (`scheme://host[:port]`) of a URL, or '' when it has none. Keys the
 * withheld-site-access bookkeeping `noHostAccessOrigins` (spec-addendum A7c);
 * for http(s) URLs the result is identical to `new URL(url).origin`.
 * @param {unknown} url
 * @returns {string}
 */
export function originOf(url) {
  const u = parse(url);
  return u ? authorityOf(u) : '';
}

/**
 * Lower-cased scheme of a URL, including the colon (`'https:'`), or '' when it
 * cannot be parsed. Used by the `host-access` refinement in `capture.js`, which
 * maps the class to `no-host-access` only for http/https/file (spec-addendum A7b).
 * @param {unknown} url
 * @returns {string}
 */
export function schemeOf(url) {
  const u = parse(url);
  return u ? u.protocol.toLowerCase() : '';
}
