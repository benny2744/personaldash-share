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

/**
 * Map each model id to a Hermes provider slug, preferring the current provider
 * when a model is served by several.
 * @param {{ groups: Array<{ slug: string, isCurrent: boolean, models: Array<{ id: string }> }> }} normalized
 * @returns {Map<string,string>}
 */
export function providerByModel(normalized) {
  const map = new Map();
  const ordered = [...(normalized?.groups || [])].sort(
    (a, b) => (b.isCurrent ? 1 : 0) - (a.isCurrent ? 1 : 0),
  );
  for (const group of ordered) {
    for (const model of group.models || []) {
      if (!map.has(model.id)) map.set(model.id, group.slug);
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
      isCurrent: model === currentModel,
    });
  }

  if (rows.length === 0) return normalized;
  const covered = new Set(rows.map((row) => row.provider));
  const extraGroups = (normalized.groups || [])
    .filter(
      (group) =>
        group.authenticated &&
        EXTRA_PROVIDER_SLUGS.includes(group.slug) &&
        !covered.has(group.slug) &&
        group.models.length,
    )
    .map((group) => ({
      ...group,
      models: group.models.map((model) => ({
        id: model.id,
        label: model.id,
        sublabel: '',
        provider: group.slug,
        isCurrent: Boolean(model.isCurrent),
      })),
    }));
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
 * Reverse a canonical model id to its tier label (first matching tier), or null.
 * @param {Array<{ tier: string, model: string }>} tiers
 * @param {string} model
 */
export function tierForModel(tiers, model) {
  if (!model) return null;
  const match = (tiers || [])
    .map((t) => ({ tier: String(t.tier || '').toLowerCase(), model: t.model }))
    .find((t) => t.model === model);
  return match ? match.tier : null;
}
