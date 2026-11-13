// The page-side instrumentation of probes 102 (numbered 98 until round 3) and 99, and of probe 100 (Probe 16 in .agent/probe-results.md, PR #20).
// Evaluated in the PANEL page by `panel.evaluate(install)`; nothing in the extension is changed. It logs, with
// a millisecond clock and the stack that caused it: every `focus()` / `blur()` call, every DOM mutator
// (`insertBefore`, `appendChild`, `removeChild`, `remove`, ...) that moved or removed a node CARRYING focus,
// `focusin` / `focusout` / `click` / `keydown` / `keyup`, `tabs.remove` calls, `tabs.onRemoved` and
// `tabGroups.onRemoved`, one record per MutationObserver callback on `#tablist`, and a per-frame sample of
// `document.activeElement`. Results are read from `window.__fd.log`.
'use strict';

const install = () => {
  if (window.__fd) return;
  const fd = (window.__fd = { log: [], t0: performance.now(), lastActive: null });
  const now = () => Math.round((performance.now() - fd.t0) * 10) / 10;
  const desc = (el) => {
    if (!el) return null;
    if (el === document.body) return 'BODY';
    if (el === document.documentElement) return 'HTML';
    if (el.nodeType !== 1) return el.nodeName;
    const d = el.dataset || {};
    return el.tagName.toLowerCase()
      + (d.testid ? `[${d.testid}]` : '')
      + (el.classList.contains('group') ? `.group#g${d.groupId}` : '')
      + (el.classList.contains('tab-card') ? `.tab-card#t${d.tabId}` : '')
      + (el.id ? `#${el.id}` : '');
  };
  const stk = () => (new Error().stack || '').split('\n').slice(3, 9)
    .map((s) => s.trim().replace(/chrome-extension:\/\/[a-p]{32}\//, '').replace(/^at /, '')).join(' <- ');
  const L = (what, extra) => fd.log.push(Object.assign({ t: now(), what, active: desc(document.activeElement) }, extra));
  fd.L = L; fd.desc = desc;

  const origFocus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (...a) {
    const before = desc(document.activeElement);
    const r = origFocus.apply(this, a);
    L('focus()', { target: desc(this), before, stack: stk() });
    return r;
  };
  const origBlur = HTMLElement.prototype.blur;
  HTMLElement.prototype.blur = function (...a) {
    const before = desc(document.activeElement);
    const r = origBlur.apply(this, a);
    L('blur()', { target: desc(this), before, stack: stk() });
    return r;
  };

  const wrap = (proto, name, affected) => {
    const orig = proto[name];
    proto[name] = function (...args) {
      const act = document.activeElement;
      let hit = null;
      if (act && act !== document.body) {
        for (const n of affected.call(this, args)) {
          if (n && n.nodeType && typeof n.contains === 'function' && n.contains(act)) { hit = n; break; }
        }
      }
      const r = orig.apply(this, args);
      if (hit) L(`DOM ${name} carrying focus`, { node: desc(hit), on: desc(this), stack: stk() });
      return r;
    };
  };
  wrap(Node.prototype, 'insertBefore', (a) => [a[0]]);
  wrap(Node.prototype, 'appendChild', (a) => [a[0]]);
  wrap(Node.prototype, 'removeChild', (a) => [a[0]]);
  wrap(Node.prototype, 'replaceChild', (a) => [a[1]]);
  wrap(Element.prototype, 'remove', function () { return [this]; });
  wrap(Element.prototype, 'replaceWith', function () { return [this]; });
  wrap(Element.prototype, 'replaceChildren', function () { return [...this.childNodes]; });
  wrap(Element.prototype, 'append', (a) => a);
  wrap(Element.prototype, 'prepend', (a) => a);
  wrap(Element.prototype, 'before', (a) => a);
  wrap(Element.prototype, 'after', (a) => a);

  for (const type of ['focusin', 'focusout']) {
    document.addEventListener(type, (e) => {
      if (type === 'focusin') fd.lastActive = e.target;
      L(type, { target: desc(e.target), related: desc(e.relatedTarget) });
    }, true);
  }
  for (const type of ['click', 'keydown', 'keyup']) {
    document.addEventListener(type, (e) => L(type, { target: desc(e.target), detail: e.detail, key: e.key }), true);
  }
  window.addEventListener('blur', () => L('window blur'), true);
  window.addEventListener('focus', () => L('window focus'), true);
  document.addEventListener('visibilitychange', () => L('visibilitychange', { hidden: document.hidden }));

  const mo = new MutationObserver((records) => {
    let addedG = 0; let removedG = 0; let addedC = 0; let removedC = 0;
    for (const r of records) {
      for (const n of r.addedNodes) { if (n.nodeType === 1) { if (n.classList.contains('group')) addedG++; if (n.classList.contains('tab-card')) addedC++; } }
      for (const n of r.removedNodes) { if (n.nodeType === 1) { if (n.classList.contains('group')) removedG++; if (n.classList.contains('tab-card')) removedC++; } }
    }
    const holderGone = fd.lastActive && !fd.lastActive.isConnected;
    L('MO', {
      records: records.length, addedG, removedG, addedC, removedC,
      groups: [...document.querySelectorAll('#tablist .group')].map((g) => `g${g.dataset.groupId}:${g.querySelectorAll('.tab-card').length}`).join(','),
      cards: document.querySelectorAll('#tablist .tab-card').length,
      holderGone: holderGone ? desc(fd.lastActive) : false,
      hidden: document.hidden,
    });
  });
  mo.observe(document.getElementById('tablist'), { childList: true, subtree: true });

  let lastSample = null;
  const sample = () => {
    const d = desc(document.activeElement);
    if (d !== lastSample) { L('frame: activeElement changed', { from: lastSample }); lastSample = d; }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);

  const rm = chrome.tabs.remove;
  chrome.tabs.remove = function (...a) {
    L('tabs.remove called', { arg: JSON.stringify(a[0]) });
    const p = rm.apply(chrome.tabs, a);
    Promise.resolve(p).then(() => L('tabs.remove resolved'), (e) => L('tabs.remove rejected', { e: String(e) }));
    return p;
  };
  chrome.tabs.onRemoved.addListener((id) => L('tabs.onRemoved', { id }));
  if (chrome.tabGroups && chrome.tabGroups.onRemoved) chrome.tabGroups.onRemoved.addListener((g) => L('tabGroups.onRemoved', { id: g && g.id }));
  L('instrumented');
};

module.exports = { install };
