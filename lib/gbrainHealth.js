/**
 * lib/gbrainHealth.js — Pure composite that turns the raw gbrain /status
 * payload (host trigger service :9103 + app indexer/sync queue) into the
 * Settings health fields. Makes the canonical-authority invariant visible:
 * gbrain is retrieval-only; canonical writes belong to Personal Dash/Hermes.
 */

const SAFE_DREAM_PHASES = [
  'sync', 'extract', 'embed', 'backlinks', 'orphans', 'consolidate',
  'propose_takes', 'grade_takes', 'resolve_symbol_edges',
  'recompute_emotional_weight', 'purge',
];

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {object} status full /api/gbrain/status payload
 *   { host, indexer, syncQueue, retrievalOnly }
 * @returns {object} health fields for the Settings card
 */
export function computeGbrainHealth(status = {}) {
  const host = status.host || {};
  const invariant = host.invariant || {};
  const profile = host.dream_profile || {};
  const jobs = host.jobs || {};
  const stats = host.stats || {};
  const writeThrough = host.write_through?.['sync.write_through'];

  // --- canonical integrity composite ---
  const reasons = [];
  if (invariant.missing) reasons.push('invariant probe has never run');
  else if (invariant.error) reasons.push(`invariant probe error: ${invariant.error}`);
  else {
    if (invariant.ok === false) reasons.push('canonical mutation during read-only probe');
    if (num(invariant.mutations_during_probe) > 0) {
      reasons.push(`${invariant.mutations_during_probe} unexpected vault write(s)`);
    }
    if (invariant.stale) reasons.push(`invariant check stale (${invariant.age_hours}h old)`);
  }
  if (writeThrough !== 'false') reasons.push(`sync.write_through=${writeThrough ?? 'unknown'}`);
  if (host.include_working_tree !== 'true') {
    reasons.push(`sync.include_working_tree=${host.include_working_tree ?? 'unknown'}`);
  }
  if (profile.profile !== 'safe') {
    reasons.push(`dream profile ${profile.profile || 'unknown'}`);
  }
  if (profile.timer_enabled === false) reasons.push('dream timer disabled');

  const canonicalIntegrity =
    reasons.length === 0 ? 'clean' : reasons.some((r) => !r.includes('stale')) ? 'fail' : 'warn';

  // --- overall status ---
  const syncFailures = num(host.sync_failures) ?? 0;
  const jobsFailed = num(jobs.failed) ?? 0;
  let overall = 'healthy';
  if (host.ok !== true) overall = 'unreachable';
  else if (canonicalIntegrity === 'fail' || jobsFailed > 0 || syncFailures > 0) overall = 'unhealthy';
  else if (canonicalIntegrity === 'warn') overall = 'degraded';

  // --- embeddings coverage ---
  const embedded = num(stats.embedded);
  const chunks = num(stats.chunks);
  let embeddings = 'unknown';
  if (embedded !== null && chunks !== null) {
    embeddings = embedded >= chunks ? 'current' : `${chunks - embedded} pending`;
  }

  // --- dream ---
  const dream = host.dream || {};
  const durationS = num(dream.duration_s);
  const lastDream = dream.last_run
    ? `${dream.last_run.replace('T', ' ')} (+08:00)`
    : 'never';

  // --- propose_takes watch metrics ---
  const pt = host.propose_takes || {};
  const llm = Array.isArray(pt.llm) ? pt.llm : [];
  const proposals = pt.proposals || {};

  return {
    status: overall,
    canonicalAuthority: 'Personal Dash / Hermes',
    canonicalIntegrity,
    integrityReasons: reasons,
    writeThrough: writeThrough ?? 'unknown',
    workingTreeSync: host.include_working_tree ?? 'unknown',
    safeDreamPhases: SAFE_DREAM_PHASES,
    dream: {
      profile: profile.profile || 'unknown',
      phases: profile.phases || [],
      timerEnabled: profile.timer_enabled === true,
      lastRun: lastDream,
      durationS,
      slowPhases: dream.slow_phases || {},
    },
    jobs: {
      pending: num(jobs.pending) ?? 0,
      running: num(jobs.running) ?? 0,
      failed: jobsFailed,
    },
    embeddings,
    unexpectedVaultWrites: num(invariant.mutations_during_probe) ?? null,
    invariant: {
      lastCheck: invariant.checked_at || null,
      stale: invariant.stale === true,
      missing: invariant.missing === true,
      fileCount: num(invariant.file_count),
    },
    syncFailures,
    syncQueue: status.syncQueue || null,
    indexer: status.indexer || null,
    proposeTakes: {
      durationS: num(pt.duration_s),
      windowStart: pt.window_start || null,
      windowEnd: pt.window_end || null,
      llm,
      proposalsPending: num(proposals.pending) ?? 0,
      proposalsRejected: num(proposals.rejected) ?? 0,
    },
    retrievalOnly: status.retrievalOnly === true,
  };
}
