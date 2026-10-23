/**
 * Model-switch decision helpers for the Hermes chat model picker.
 *
 * Three gateway paths can apply a mid-session /model pick, and each has a
 * narrow reliability window (live-verified 2026-10-21 against the gateway's
 * own handlers):
 *
 * - `session.create` model+provider override: instant, but the create path
 *   validates the pair against the gateway's CURATED per-provider catalogs,
 *   which are NOT the same as the `model.options` credential-pool groups the
 *   picker attributes from — a valid-looking pair can be rejected with
 *   "Model `X` is not served by provider `Y`" (-32602).
 * - `config.set model` (~200ms): reliable only once the session's agent has
 *   been built AND survived a completed turn, or while a turn is running
 *   (the gateway defers the pick to the next turn start). Right after a
 *   create/resume — before the first turn — it resolves successfully but is
 *   silently ignored (the later agent build clobbers it).
 * - `slash.exec /model` (the mirror path): reliable whenever the session is
 *   idle, but the FIRST use per session forks a slash worker (~8s), and when
 *   a turn is running the live-agent mirror refuses with a `warning` while
 *   the output still says "✓ Model switched" — the pick is NOT applied.
 */

/**
 * The value both `slash.exec /model <value>` and `config.set model=<value>`
 * accept: an optional `--provider` disambiguates model ids that several
 * credential pools serve.
 * @param {string} modelId
 * @param {string=} provider
 */
export function modelSwitchValue(modelId, provider) {
  const id = String(modelId || '').trim();
  if (!id) return '';
  const slug = String(provider || '').trim();
  return slug ? `${id} --provider ${slug}` : id;
}

/**
 * Ordered model+provider pairs to try for a create-time override, most
 * preferred first. `pick.providers` is the model's serving providers in
 * preference order (tierModels.providersForModel — openai-codex ahead of the
 * profile's own LiteLLM slot), with the attributed `pick.provider` appended
 * when missing. The create path validates each pair against its curated
 * per-provider catalog and answers -32602 for a rejected one BEFORE creating
 * anything, so the caller tries candidates until one is accepted and only
 * then falls back to a plain create (profile default) plus a post-bind
 * switch.
 * @param {{ id: string, provider?: string, providers?: string[] } | null} pick
 * @returns {Array<{ id: string, provider: string }>}
 */
export function createOverrideCandidates(pick) {
  const id = String(pick?.id || '').trim();
  if (!id) return [];
  const ordered = [];
  const seen = new Set();
  for (const provider of [
    ...(Array.isArray(pick.providers) ? pick.providers : []),
    pick.provider,
  ]) {
    const slug = String(provider || '').trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    ordered.push(slug);
  }
  return ordered.map((provider) => ({ id, provider }));
}

/**
 * Did `session.create` reject the model+provider override? The create path's
 * catalog validation answers -32602 "Model `X` is not served by provider `Y`
 * (...)" BEFORE creating anything, so the caller can retry as a plain create
 * plus a post-bind switch.
 * @param {unknown} error
 */
export function isCreateOverrideRejection(error) {
  return /not served by provider/i.test(
    String((error && error.message) || error || ''),
  );
}

/**
 * A non-empty `warning` on a slash /model result means the live-agent mirror
 * did NOT apply the switch ("session busy — …" while a turn runs, or
 * "live session sync failed: …"). The `output` still prints "✓ Model
 * switched" (that is the slash worker's own view), so the warning is the
 * only honest signal.
 * @param {string=} warning
 */
export function mirrorRefusedSwitch(warning) {
  return Boolean(String(warning || '').trim());
}

/**
 * Pick the mid-session switch transport. `config.set` when the gateway can
 * apply it reliably (a turn is running → it defers; a turn already completed
 * since this session was bound → fast immediate path), `slash.exec` for the
 * not-yet-turned window where `config.set` would be silently dropped.
 * @param {{ sessionRunning?: boolean, turnRanSinceBind?: boolean }} state
 */
export function shouldFastSwitch({ sessionRunning, turnRanSinceBind }) {
  return Boolean(sessionRunning || turnRanSinceBind);
}
