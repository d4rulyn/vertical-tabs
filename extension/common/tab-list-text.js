/**
 * Tabs as text, and text as a list of links.
 *
 * A window's worth of tabs is research, and research has to leave the browser
 * eventually — into a note, an issue, a message to someone — and come back the same
 * way. Both directions are pure string work, which is why they live here rather than
 * in the tool that offers the buttons: they are the part worth testing exactly.
 */

import { BULK_OPEN_MAX } from './constants.js';

/**
 * `- [title](url)` per tab, in the order the panel shows them.
 *
 * Markdown because it pastes usefully into almost everything and degrades to readable
 * plain text where it does not. Pinned tabs are included — they are part of what is
 * open, and a list that silently omits things is worse than no list. Brackets in a
 * title are escaped so a title containing one cannot break the link that follows it.
 *
 * Tabs without an `http(s)` URL are skipped: a `chrome://` page is not a link anyone
 * can follow from a note.
 *
 * @param {Array<{index?: number, title?: string, url?: string, pendingUrl?: string}>} tabs
 * @returns {string}
 */
export function asMarkdown(tabs) {
  if (!Array.isArray(tabs)) return '';
  const lines = [];
  for (const tab of [...tabs].sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0))) {
    if (!tab) continue;
    const url = tab.url || tab.pendingUrl || '';
    if (!/^https?:\/\//i.test(url)) continue;
    const title = String(tab.title || url).replace(/[[\]]/g, '\\$&');
    lines.push(`- [${title}](${url})`);
  }
  return lines.join('\n');
}

/**
 * Every `http(s)` URL in a blob of text, in order, without duplicates.
 *
 * Deliberately forgiving about what it is given: a Markdown list, a column pasted from
 * a spreadsheet, a chat message with prose around the links. Anything that is not a URL
 * is ignored rather than being an error for the reader to correct.
 *
 * Capped at `BULK_OPEN_MAX` because opening a list is one click with no undo and every
 * entry is a page load.
 *
 * @param {string} text
 * @param {number} [max]
 * @returns {string[]}
 */
export function urlsIn(text, max = BULK_OPEN_MAX) {
  if (typeof text !== 'string' || text === '') return [];
  const out = [];
  const seen = new Set();
  // Stops at whitespace, at quotes, and at the closing bracket of a Markdown link.
  const re = /https?:\/\/[^\s<>"'`)\]]+/gi;
  for (const match of text.matchAll(re)) {
    // A URL at the end of a sentence picks up its punctuation; a real path almost never
    // ends in one.
    const url = match[0].replace(/[.,;:!?]+$/, '');
    if (url.length <= 'https://'.length) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= max) break;
  }
  return out;
}
