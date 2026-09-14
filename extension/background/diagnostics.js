/**
 * background/diagnostics.js — capture counters mirrored into chrome.storage.session.
 *
 * Spec: §5.3 (`diagnostics` key), §6.1 (`vt/get-diagnostics`), §7.5, addendum A2
 * ("diagnostics.captures gains quotaRejections and byReason gains …").
 *
 * The counters live in memory (always fresh for the running worker) and are mirrored
 * to chrome.storage.session so they survive a service-worker restart but never a
 * browser restart — nothing in here can go stale across sessions.
 *
 * Every reason key is pre-seeded with 0 so tests may assert `byReason.quota === 0`
 * for a run in which the pipeline never hit the quota (an absent key would be
 * `undefined`, not `0`).
 */

const SESSION_KEY = 'diagnostics';
const WRITE_DEBOUNCE_MS = 250;

/** Every reason the pipeline can report. Keep in sync with §6.2 + addendum A2/A4/A7. */
export const REASONS = [
  // broadcast failure reasons (§6.2 + A7)
  'restricted',
  'policy',
  'no-host-access',
  'excluded',
  'quota',
  'readback',
  'timeout',
  'unknown',
  'dragging',
  'gone',
  'not-active',
  'minimized',
  'discarded',
  // silent-skip reasons (A2 / A4)
  'window-type',
  'panel-closed',
  'backoff',
  'bad-window',
  'restricted-cached',
  'per-tab-interval',
  'same-url',
  'never-committed',
  'thumbnails-off',
  'postcheck',
  'disabled',
  'busy',
];

function emptyState() {
  const byReason = {};
  for (const reason of REASONS) byReason[reason] = 0;
  return {
    captures: { ok: 0, failed: 0, skipped: 0, rechecks: 0, quotaRejections: 0, byReason },
    lastError: null,
  };
}

let state = emptyState();
let hydratePromise = null;
let writeTimer = null;

function toInt(value) {
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

/** Reads the mirrored counters back after a service-worker restart. Memoised. */
export function hydrate() {
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    let saved = null;
    try {
      const got = await chrome.storage.session.get(SESSION_KEY);
      saved = got?.[SESSION_KEY] ?? null;
    } catch {
      saved = null;
    }
    if (!saved || typeof saved !== 'object' || !saved.captures) return;
    // Merge by addition so counters incremented before hydrate() resolved are kept.
    const c = saved.captures;
    state.captures.ok += toInt(c.ok);
    state.captures.failed += toInt(c.failed);
    state.captures.skipped += toInt(c.skipped);
    state.captures.rechecks += toInt(c.rechecks);
    state.captures.quotaRejections += toInt(c.quotaRejections);
    if (c.byReason && typeof c.byReason === 'object') {
      for (const [key, value] of Object.entries(c.byReason)) {
        state.captures.byReason[key] = (state.captures.byReason[key] ?? 0) + toInt(value);
      }
    }
    if (state.lastError == null && typeof saved.lastError === 'string') state.lastError = saved.lastError;
  })().catch(() => {});
  return hydratePromise;
}

function persistSoon() {
  if (writeTimer != null) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void flush();
  }, WRITE_DEBOUNCE_MS);
}

/** Writes the counters to storage.session immediately. Never throws. */
export async function flush() {
  if (writeTimer != null) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  try {
    await chrome.storage.session.set({ [SESSION_KEY]: snapshot() });
  } catch {
    /* storage.session unavailable (never on Chrome ≥ 102) — counters stay in memory */
  }
}

function bumpReason(reason) {
  if (!reason) return;
  state.captures.byReason[reason] = (state.captures.byReason[reason] ?? 0) + 1;
}

/** A capture completed and the thumbnail was stored. */
export function ok() {
  state.captures.ok += 1;
  persistSoon();
}

/** A capture failed for `reason` (a reason that reaches the user as `vt/thumb-failed`). */
export function failed(reason) {
  state.captures.failed += 1;
  bumpReason(reason);
  persistSoon();
}

/** A job was dropped before spending a quota token. */
export function skipped(reason) {
  state.captures.skipped += 1;
  bumpReason(reason);
  persistSoon();
}

/** A uniform-looking capture scheduled its one extra re-check (§7.4 step 9). */
export function recheck() {
  state.captures.rechecks += 1;
  persistSoon();
}

/** captureVisibleTab rejected with the per-second quota error (A1/A2). */
export function quotaRejection() {
  state.captures.quotaRejections += 1;
  persistSoon();
}

/** Records the last error string (diagnostics only, never shown to users). */
export function setLastError(message) {
  state.lastError = message == null ? null : String(message).slice(0, 500);
  persistSoon();
}

/** Deep copy of the counters, for `vt/get-diagnostics`. */
export function snapshot() {
  return {
    captures: {
      ok: state.captures.ok,
      failed: state.captures.failed,
      skipped: state.captures.skipped,
      rechecks: state.captures.rechecks,
      quotaRejections: state.captures.quotaRejections,
      byReason: { ...state.captures.byReason },
    },
    lastError: state.lastError,
  };
}

/** Test/maintenance helper: zeroes every counter and mirrors the reset. */
export function reset() {
  state = emptyState();
  persistSoon();
}
