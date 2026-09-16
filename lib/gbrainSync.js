/**
 * lib/gbrainSync.js — Optional fire-and-forget trigger for an external
 * vault indexer (e.g. gbrain).
 *
 * The dashboard writes vault Markdown (frontmatter write-backs, meeting
 * pipeline output, project-note edits). If you run a gbrain-style indexer
 * over the same vault, set GBRAIN_SYNC_HOOK_URL to its sync trigger
 * endpoint and every dashboard write will ask it to re-index within ~10s
 * instead of waiting for its periodic timer. The host service is expected
 * to debounce bursts into one sync run.
 *
 * When GBRAIN_SYNC_HOOK_URL is unset, this module is a safe no-op (same
 * contract as lib/push.js): callers never need to branch on configuration.
 */

const HOOK_URL = process.env.GBRAIN_SYNC_HOOK_URL || '';

let lastFiredAt = 0;
const MIN_INTERVAL_MS = 5000;

/**
 * Build a URL against the configured hook origin (the /sync HOOK_URL's
 * origin). Returns null when no hook is configured.
 * @param {string} path e.g. '/status'
 */
export function triggerGbrainSyncUrl(path = '/') {
  if (!HOOK_URL) return null;
  try {
    const url = new URL(HOOK_URL);
    return `${url.origin}${path.startsWith('/') ? path : `/${path}`}`;
  } catch {
    return HOOK_URL.replace(/\/sync\/?$/, '') + (path.startsWith('/') ? path : `/${path}`);
  }
}

/**
 * Ask the external indexer to sync the vault.
 * Never throws, never blocks the caller's request path; no-op when
 * GBRAIN_SYNC_HOOK_URL is unset.
 * @param {string} [reason]
 */
export function triggerGbrainSync(reason = 'write-back') {
  if (!HOOK_URL) return;
  const now = Date.now();
  if (now - lastFiredAt < MIN_INTERVAL_MS) return;
  lastFiredAt = now;
  fetch(HOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
    signal: AbortSignal.timeout(3000),
  }).catch((err) => {
    console.warn('[gbrain-sync] trigger failed (non-fatal):', err.message);
  });
}
