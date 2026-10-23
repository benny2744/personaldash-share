/**
 * Tier → model adapter for the Hermes chat model picker.
 *
 * The picker is driven by the LLM tier registry (cheap / fast / balanced / …),
 * not the raw provider catalog. Each tier resolves to the model the registry
 * points at; that model must also be switchable via Hermes (`model.options`), so
 * we attribute a Hermes provider slug to it and drop tiers whose model Hermes
 * cannot switch to (e.g. asr/tts). Switching stays `/model <id> --provider <slug>`.
 *
 * Authenticated providers that no tier references (e.g. an OAuth provider like
 * openai-codex used purely through Hermes) can be appended as their own groups
 * below Tiers, so their models stay reachable without touching the registry.
 * The catalog exposes many credential pools, so only slugs in
 * EXTRA_PROVIDER_SLUGS are surfaced — keeping the picker compact.
 */

// Authenticated Hermes providers (not referenced by any tier) to show as their
// own picker group. Keep this short — each entry adds its full model catalog.
export const EXTRA_PROVIDER_SLUGS = ['openai-codex'];

// Chat tiers in picker order; anything not listed falls after, alphabetical.
const CHAT_TIER_ORDER = [
  'fast',
  'cheap',
  'balanced',
  'deep',
  'advanced',
  'multi',
  'translation',
];

function tierRank(tier) {
  const index = CHAT_TIER_ORDER.indexOf(tier);
  return index === -1 ? CHAT_TIER_ORDER.length : index;
}

// Providers preferred for attribution when a model is served by several
// credential pools. The profile's own provider (the `alibaba` slot — really
// the local LiteLLM gateway) lists every model its gateway routes, so an
// isCurrent-first attribution flip-flops with group order and steers OpenAI
// models to the gateway path. Estate policy: the OpenAI family is served by
// the authenticated OpenAI path — openai-codex wins over isCurrent.
const PREFERRED_PROVIDER_ORDER = ['openai-codex'];

function providerRank(group) {
  const index = PREFERRED_PROVIDER_ORDER.indexOf(group.slug);
  return index === -1 ? PREFERRED_PROVIDER_ORDER.length : index;
}

function groupsByPreference(normalized) {
  return [...(normalized?.groups || [])].sort(
    (a, b) =>
      providerRank(a) - providerRank(b) ||
      (b.isCurrent ? 1 : 0) - (a.isCurrent ? 1 : 0),
  );
}

/**
 * Map each model id to a Hermes provider slug, preferring the estate's
 * serving path (PREFERRED_PROVIDER_ORDER) over the merely-current provider.
 * @param {{ groups: Array<{ slug: string, isCurrent: boolean, models: Array<{ id: string }> }> }} normalized
 * @returns {Map<string,string>}
 */
export function providerByModel(normalized) {
  const map = new Map();
  for (const group of groupsByPreference(normalized)) {
    for (const model of group.models || []) {
      if (!map.has(model.id)) map.set(model.id, group.slug);
    }
  }
  return map;
}

/**
 * Every Hermes provider slug serving each model id, most-preferred first
 * (same ordering as providerByModel). Consumed by the create-time override
 * fallback: the create path validates model×provider against curated
 * per-provider catalogs, so a rejected attributed pair needs the model's
 * other serving providers in preference order.
 * @param {{ groups: Array<{ slug: string, isCurrent: boolean, models: Array<{ id: string }> }> }} normalized
 * @returns {Map<string, string[]>}
 */
export function providersForModel(normalized) {
  const map = new Map();
  for (const group of groupsByPreference(normalized)) {
    for (const model of group.models || []) {
      const list = map.get(model.id) || [];
      if (!list.includes(group.slug)) list.push(group.slug);
      map.set(model.id, list);
    }
  }
  return map;
}

/**
 * Build a picker catalog (same shape as normalizeModelOptions) from the tier
 * registry. Falls back to the raw catalog when no tier resolves, so the picker
 * never blanks out. Authenticated provider groups whose slug no tier row
 * references are appended after the Tiers group.
 *
 * @param {Array<{ tier: string, model: string }>} tiers
 * @param {import('./modelOptions.js').NormalizedModels} normalized
 */
export function buildTierCatalog(tiers, normalized) {
  const provider = providerByModel(normalized);
  const allProviders = providersForModel(normalized);
  const currentModel = normalized.currentModel || '';

  const rows = [];
  const seen = new Set();
  const sorted = [...(tiers || [])]
    .map((t) => ({ tier: String(t.tier || '').toLowerCase(), model: t.model }))
    .filter((t) => t.tier && t.model)
    .sort(
      (a, b) =>
        tierRank(a.tier) - tierRank(b.tier) || a.tier.localeCompare(b.tier),
    );

  for (const { tier, model } of sorted) {
    if (seen.has(tier)) continue;
    const slug = provider.get(model);
    if (!slug) continue; // not switchable via Hermes (asr/tts or unknown)
    seen.add(tier);
    rows.push({
      id: model,
      label: tier,
      sublabel: model,
      tier,
      provider: slug,
      // Ordered fallback for create-time override: the attributed provider's
      // curated create catalog may reject the pair, the next one may not.
      providers: allProviders.get(model) || [slug],
      isCurrent: model === currentModel,
    });
  }

  if (rows.length === 0) return normalized;
  // Per-MODEL coverage: a tier row only makes its own model reachable, so an
  // extra provider group stays listed (filtered to the models tier rows don't
  // already include) even when a tier row attributes to that provider.
  // Provider-level coverage here wiped the whole Codex catalog from the
  // picker the moment the fast tier (gpt-6-luna) attributed to
  // openai-codex (2026-10-22 regression).
  const coveredModels = new Set(rows.map((row) => row.id));
  const extraGroups = (normalized.groups || [])
    .filter(
      (group) =>
        group.authenticated &&
        EXTRA_PROVIDER_SLUGS.includes(group.slug) &&
        group.models.length,
    )
    .map((group) => ({
      ...group,
      models: group.models
        .filter((model) => !coveredModels.has(model.id))
        .map((model) => ({
          id: model.id,
          label: model.id,
          sublabel: '',
          provider: group.slug,
          providers: [group.slug],
          isCurrent: Boolean(model.isCurrent),
        })),
    }))
    .filter((group) => group.models.length > 0);
  return {
    groups: [
      {
        slug: 'tier',
        name: 'Tiers',
        isCurrent: false,
        authenticated: true,
        models: rows,
      },
      ...extraGroups,
    ],
    currentModel,
    currentProvider: normalized.currentProvider,
  };
}

/**
 * Reverse a canonical model id to its tier label, or null. A model may map to
 * several tiers (e.g. qwen3.8-flash as both `multi` and `translation`); the
 * match follows CHAT_TIER_ORDER (fast first) so the label is deterministic
 * instead of input-order dependent.
 * @param {Array<{ tier: string, model: string }>} tiers
 * @param {string} model
 */
export function tierForModel(tiers, model) {
  if (!model) return null;
  const matches = (tiers || [])
    .map((t) => ({ tier: String(t.tier || '').toLowerCase(), model: t.model }))
    .filter((t) => t.model === model);
  if (matches.length === 0) return null;
  const best = matches.reduce((a, b) =>
    tierRank(b.tier) < tierRank(a.tier) ? b : a,
  );
  return best.tier;
}
