/**
 * Pure merge of Hermes session usage sources for the chat Session stats panel.
 *
 * Three sources, different lifetimes:
 *  - `usage`    — live gateway snapshots (`session.usage` ticks,
 *                 `message.complete`); agent counters are runtime-only and
 *                 start at 0 when an agent (re)attaches, so they never include
 *                 pre-attach history.
 *  - `cold`     — REST `GET /api/sessions/:id` row from state.db; lifetime
 *                 token/cost/count columns flushed per turn.
 *  - `baseline` — live snapshot captured at resume; the delta above it counts
 *                 post-resume activity without double-counting history.
 *
 * Displayed accumulative fields are `cold + max(0, live - baseline)`. The
 * clamp handles re-attach: when counters restart below the baseline the
 * reducer rebases, but a transient regression must never undercount history.
 */

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function obj(value) {
  return value && typeof value === 'object' ? value : null;
}

/**
 * @param {object|null} usage live gateway usage snapshot
 * @param {object|null} cold REST session row (state.db columns, snake_case)
 * @param {object|null} baseline live usage snapshot captured at resume
 */
export function buildSessionStats(usage, cold, baseline) {
  const u = obj(usage);
  const c = obj(cold);
  const b = obj(baseline) || {};

  const delta = (live, base) => Math.max(0, num(live) - num(base));

  const input = num(c?.input_tokens) + delta(u?.input, b.input);
  const output = num(c?.output_tokens) + delta(u?.output, b.output);
  const reasoning = num(c?.reasoning_tokens) + delta(u?.reasoning, b.reasoning);
  // state.db has no total column; input+output+reasoning matches the
  // gateway's session_total_tokens composition.
  const total = input + output + reasoning;
  const calls = num(c?.api_call_count) + delta(u?.calls, b.calls);

  const cacheRead = num(c?.cache_read_tokens);
  const cacheWrite = num(c?.cache_write_tokens);
  // Cache-hit %: prefer the cold row (covers full history, same formula the
  // gateway uses: cache_read / (input + cache_read + cache_write)); fall back
  // to the live ratio only when no cold cache data exists.
  let cacheHitPct = null;
  const coldPrompt = num(c?.input_tokens) + cacheRead + cacheWrite;
  if (cacheRead > 0 && coldPrompt > 0) {
    cacheHitPct = Math.max(0, Math.min(100, Math.round((cacheRead / coldPrompt) * 100)));
  } else if (u && Number.isFinite(Number(u.cache_hit_pct))) {
    cacheHitPct = Number(u.cache_hit_pct);
  }

  return {
    model: u?.model || c?.model || '',
    contextUsed: num(u?.context_used),
    contextMax: num(u?.context_max),
    contextPercent: num(u?.context_percent),
    contextEstimated: Boolean(u?.context_estimated),
    input,
    output,
    reasoning,
    total,
    cacheRead,
    cacheWrite,
    cacheHitPct,
    calls,
    avgLatencyS: num(u?.avg_latency_s) || null,
    avgTps: num(u?.avg_tps) || null,
    activeSubagents: num(u?.active_subagents),
    compressions: num(u?.compressions),
    estimatedCost: num(c?.estimated_cost_usd) || null,
    actualCost: num(c?.actual_cost_usd) || null,
    messageCount: num(c?.message_count) || null,
    toolCallCount: num(c?.tool_call_count) || null,
  };
}
