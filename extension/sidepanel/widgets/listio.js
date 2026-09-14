// Copy the list out, and bring a list of links back in. See widgets.js for the contract.

import * as i18n from '../../common/i18n.js';
import * as log from '../../common/log.js';
import * as ops from '../tab-ops.js';
import { asMarkdown, urlsIn } from '../../common/tab-list-text.js';

const t = (key, subs) => i18n.t(key, subs);

/**
 * Get a window's worth of tabs out as text, and a list of links in as tabs.
 *
 * The two halves of the same problem. A set of open tabs is research, and research has
 * to leave the browser eventually — into a note, an issue, a message to someone. The
 * only way out today is copying URLs one at a time. And the way back in, from a list
 * someone sends you, is opening them one at a time.
 *
 * Markdown because it pastes usefully into almost everything and degrades to readable
 * plain text where it does not.
 */
export const listIO = {
  id: 'listIO',
  titleKey: 'widgetListIO',
  mount(body, ctx) {
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'w-btn';
    copy.dataset.testid = 'widget-listio-copy';
    copy.textContent = t('widgetListIOCopy');

    const paste = document.createElement('textarea');
    paste.className = 'w-pad';
    paste.dataset.testid = 'widget-listio-input';
    paste.rows = 3;
    paste.spellcheck = false;
    paste.placeholder = t('widgetListIOPlaceholder');

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'w-btn';
    open.dataset.testid = 'widget-listio-open';
    open.textContent = t('widgetListIOOpen');
    open.disabled = true;

    body.append(copy, paste, open);

    copy.addEventListener('click', async () => {
      const model = ctx.model ? ctx.model() : null;
      const tabs = model && model.tabs ? [...model.tabs.values()] : [];
      const text = asMarkdown(tabs);
      if (!text) {
        notify(ctx, t('widgetListIONothing'));
        return;
      }
      const ok = await ops.copyText(text);
      notify(ctx, ok ? t('widgetListIOCopied', [String(tabs.length)]) : t('copyFailed'));
    });

    const refreshOpenButton = () => {
      open.disabled = urlsIn(paste.value).length === 0;
    };
    paste.addEventListener('input', refreshOpenButton);

    open.addEventListener('click', async () => {
      const urls = urlsIn(paste.value);
      if (!urls.length) return;
      try {
        // A window of their own: opening thirty links into the window someone is
        // working in is not a favour, and a new window can be closed in one gesture.
        await chrome.windows.create({ url: urls });
        notify(ctx, t('widgetListIOOpened', [String(urls.length)]));
        paste.value = '';
        refreshOpenButton();
      } catch (e) {
        log.warn('listIO open', e);
        notify(ctx, t('operationFailed'));
      }
    });

    return () => { /* nothing to tear down */ };
  },
};

/** `toast` is optional in the tool contract; a missing one must not throw. */
function notify(ctx, text) {
  if (ctx && typeof ctx.toast === 'function') ctx.toast(text);
}
