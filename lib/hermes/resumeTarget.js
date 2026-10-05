/**
 * Resolve the session id a dashboard resume should target.
 *
 * Compression continuations branch the session id, so a stale sidebar id must
 * be followed to its newest descendant. But the REST latest-descendant endpoint
 * walks to the newest child WITHOUT excluding internal child sessions, while
 * the gateway's own resume resolver (`resolve_resume_session_id`) skips
 * children marked `_delegate_from` / `_branched_from` / `_reset_from`. Those
 * children are delegate sub-agents, /model branches and reset contexts — not
 * user-visible continuations: resuming one renders the delegate's internal
 * transcript instead of the real chat, and the aliased transcript-cache write
 * then poisons the parent entry.
 *
 * This mirrors the gateway's filtering client-side: follow the descendant tip
 * only when it carries no branch marker. Staying on the original id is always
 * safe because WS `session.resume` re-resolves compression tips server-side
 * (`_resume_follow_tip`).
 */

const BRANCH_MARKERS = ['_delegate_from', '_branched_from', '_reset_from'];

/**
 * @param {string|object|null|undefined} modelConfig Raw `model_config` (JSON
 *   string or already-parsed object) from a session detail row.
 * @returns {string|null} the first branch marker present, if any.
 */
export function findBranchMarker(modelConfig) {
  if (!modelConfig) return null;
  let config = modelConfig;
  if (typeof config === 'string') {
    try {
      config = JSON.parse(config);
    } catch {
      return null;
    }
  }
  if (typeof config !== 'object') return null;
  return BRANCH_MARKERS.find((key) => config[key] != null) || null;
}

/**
 * @param {string} sessionId Sidebar/requested session id.
 * @param {{
 *   getLatestDescendant: (id: string) => Promise<{session_id?: string}|null>,
 *   getSession: (id: string) => Promise<{model_config?: unknown}|null>,
 * }} io Hermes REST accessors.
 * @returns {Promise<string>} the id to resume: the descendant tip when it is a
 *   user-visible continuation, otherwise the original id.
 */
export async function resolveResumeTarget(sessionId, { getLatestDescendant, getSession }) {
  if (!sessionId) return sessionId;
  let latest;
  try {
    latest = await getLatestDescendant(sessionId);
  } catch {
    return sessionId;
  }
  const tipId = latest?.session_id;
  if (!tipId || tipId === sessionId) return sessionId;

  // A tip we cannot verify must never hijack the target: the gateway resolves
  // compression continuations from the original id itself, so keeping it
  // preserves both correctness and the parent's cached transcript.
  try {
    const detail = await getSession(tipId);
    if (findBranchMarker(detail?.model_config)) return sessionId;
  } catch {
    return sessionId;
  }
  return tipId;
}
