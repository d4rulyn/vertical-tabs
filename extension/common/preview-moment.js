/**
 * What a preview is allowed to show — the decision, with no Chrome in it.
 *
 * `captureVisibleTab` photographs the viewport, so a preview is only ever a picture of
 * wherever the reader happened to be. This module answers one question: given the mode
 * the user chose, what is already stored, and where the reader is, may this capture
 * happen and what should the resulting record claim about itself?
 *
 * It lives in `common/` and takes plain data because the policy is the part worth
 * testing exactly — every combination of mode, stored record and answer, including the
 * answers that never arrive.
 */

/** `atTop` when the answer is wanted but must not be waited for yet. */
export const AT_TOP_PENDING = 'pending';

/**
 * @typedef {{known: boolean, atTop: boolean}} Position
 *   Where the reader is. `known: false` means the page could not be asked — a PDF
 *   viewer, a withheld origin, an answer that did not arrive in time.
 *
 * @typedef {{ok: boolean, why?: string, atTop?: boolean|'pending'}} Verdict
 */

/**
 * @param {object} a
 * @param {string} a.moment          'top' | 'reload' | 'interval'
 * @param {string} a.reason          why this capture was scheduled
 * @param {boolean} a.manual         the user asked for it in so many words
 * @param {object|null} a.held       the record already stored for this url key
 * @param {Position|null} a.position where the reader is, or null if not asked
 * @returns {Verdict}
 */
export function decidePreview({ moment, reason, manual, held, position }) {
  // Every capture replaces the preview: what the panel did before the setting existed.
  if (moment === 'interval') return { ok: true };

  if (moment === 'reload') {
    // `complete` is Chrome saying the page finished loading, which is exactly the moment
    // this mode wants; a manual refresh is the user asking outright.
    const replaces = reason === 'complete' || manual;
    if (!replaces && held) return { ok: false, why: 'not-a-reload' };
    return { ok: true };
  }

  // 'top' — the default.
  //
  // Nothing here may block the FIRST preview of a page: a card that stays blank until
  // someone scrolls up is worse than a preview of the wrong part of the page.
  if (!held || held.atTop !== true) return { ok: true, atTop: AT_TOP_PENDING };

  // A picture of the header exists and is worth protecting, so the answer decides
  // whether to spend a capture at all.
  if (!position) return { ok: true, atTop: AT_TOP_PENDING };

  // The page answered, and the reader has scrolled away: keep the header. This is the
  // case the setting exists for — F5 half way down an article restores that offset, so
  // the capture at `complete` would replace a usable header with a band of body text.
  if (position.known && !position.atTop) return { ok: false, why: 'not-at-top' };

  if (position.known) return { ok: true, atTop: true };

  // The page could not be asked. A preview must never freeze: if "keep what we have"
  // were the answer here, a page that can never answer — because `scripting` is not
  // granted, because it is a PDF viewer, because injection is refused — would hold its
  // first preview forever and quietly stop updating. So the capture goes ahead and the
  // record stops claiming to be a protected picture of the top, which also lets the page
  // heal: the next capture asks again, and a successful answer restores the claim.
  return { ok: true, atTop: false, why: 'position-unknown' };
}
