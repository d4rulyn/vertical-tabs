// Scratchpad widget. See widgets.js for the widget contract.

import * as i18n from '../../common/i18n.js';
import * as log from '../../common/log.js';
import { STORAGE_LOCAL, SETTINGS_TEXT_DEBOUNCE_MS } from '../../common/constants.js';

const t = (key, subs) => i18n.t(key, subs);

/** Enough for a paste of notes, small enough that storage.local never notices. */
const MAX_CHARS = 8000;

/**
 * A note that stays put.
 *
 * The reason a browser needs one is the same reason this extension exists: people
 * keep a tab open purely to hold three lines of text. This is that tab, without the
 * tab — and unlike a tab it survives a restart and does not compete for the strip.
 *
 * Writes are debounced with the same delay the settings drawer uses for its text
 * fields, so typing does not touch storage on every keystroke.
 */
export const scratchpad = {
  id: 'scratchpad',
  titleKey: 'widgetScratchpad',
  mount(body) {
    const area = document.createElement('textarea');
    area.className = 'w-pad';
    area.dataset.testid = 'widget-scratchpad-text';
    area.rows = 5;
    area.spellcheck = false;
    area.maxLength = MAX_CHARS;
    area.placeholder = t('widgetScratchpadPlaceholder');
    body.append(area);

    let alive = true;
    let timer = 0;

    const flush = async () => {
      timer = 0;
      try {
        await chrome.storage.local.set({ [STORAGE_LOCAL.scratchpad]: area.value });
      } catch (e) {
        log.warn('scratchpad save', e);
      }
    };

    chrome.storage.local.get(STORAGE_LOCAL.scratchpad).then((stored) => {
      // The user may have started typing while this read was in flight; their text
      // is newer than anything on disk, so it wins.
      if (!alive || area.value !== '') return;
      const text = stored && stored[STORAGE_LOCAL.scratchpad];
      if (typeof text === 'string') area.value = text;
    }).catch((e) => log.warn('scratchpad load', e));

    area.addEventListener('input', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void flush(), SETTINGS_TEXT_DEBOUNCE_MS);
    });
    // Leaving the field commits immediately: a debounce that loses the last edit
    // because the panel closed is worse than an extra write.
    area.addEventListener('blur', () => {
      if (!timer) return;
      clearTimeout(timer);
      void flush();
    });

    return () => {
      alive = false;
      if (timer) {
        clearTimeout(timer);
        void flush();
      }
    };
  },
};
