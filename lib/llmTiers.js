// LLM tier registry access — reads LLM_TIER_* env (injected from the vps-infra
// registry via scripts/llm-tiers passthrough) merged with DB overrides
// (LlmTier table, edited on the settings page). DB wins; env is fallback.
// Host-side llm-tiers-sync pushes overrides back to the global registry.

// Lazy prisma import keeps this module importable in tests without DATABASE_URL.
async function db() {
  const { default: prisma } = await import('@/lib/db');
  return prisma;
}

const TIER_RE = /^LLM_TIER_([A-Z]+)_MODEL$/;

function envTiers() {
  const tiers = {};
  for (const [key, value] of Object.entries(process.env)) {
    const m = TIER_RE.exec(key);
    if (m && value) {
      const tier = m[1].toLowerCase();
      tiers[tier] = tiers[tier] || { tier, model: value, baseUrl: null, source: 'registry' };
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    const m = /^LLM_TIER_([A-Z]+)_BASE_URL$/.exec(key);
    if (m && value && tiers[m[1].toLowerCase()]) {
      tiers[m[1].toLowerCase()].baseUrl = value;
    }
  }
  return tiers;
}

/**
 * Effective tier list: env registry defaults merged with LlmTier overrides.
 * Each entry: { tier, model, baseUrl, source: 'override'|'registry' }.
 */
export async function listTiers() {
  const tiers = envTiers();
  let overrides = [];
  try {
    overrides = await (await db()).llmTier.findMany();
  } catch {
    // table missing pre-migration — registry values only
  }
  for (const row of overrides) {
    const tier = row.tier.toLowerCase();
    if (tiers[tier]) {
      tiers[tier] = {
        ...tiers[tier],
        model: row.model,
        baseUrl: row.baseUrl,
        source: 'override',
      };
    } else {
      tiers[tier] = { tier, model: row.model, baseUrl: row.baseUrl, source: 'override' };
    }
  }
  return Object.values(tiers).sort((a, b) => a.tier.localeCompare(b.tier));
}

/**
 * DB override for one tier, or null (no env fallback). Use in pipeline call
 * paths: null => keep existing env-driven behavior; override => use it now.
 */
export async function getTierOverride(tier) {
  const key = String(tier || '').trim().toLowerCase();
  if (!key) return null;
  try {
    const row = await (await db()).llmTier.findUnique({ where: { tier: key } });
    return row ? { model: row.model, baseUrl: row.baseUrl } : null;
  } catch {
    return null;
  }
}

/**
 * Resolve one tier to { model, baseUrl } at call time.
 * Order: DB override -> env registry -> null. Throws when unresolvable.
 */
export async function resolveTier(tier) {
  const key = String(tier || '').toLowerCase();
  if (!key) throw new Error('resolveTier: tier required');
  try {
    const row = await (await db()).llmTier.findUnique({ where: { tier: key } });
    if (row) return { model: row.model, baseUrl: row.baseUrl };
  } catch {
    // fall through to env
  }
  const model = process.env[`LLM_TIER_${key.toUpperCase()}_MODEL`];
  const baseUrl = process.env[`LLM_TIER_${key.toUpperCase()}_BASE_URL`];
  if (!model || !baseUrl) {
    throw new Error(`resolveTier: unknown tier '${tier}' (no override, no LLM_TIER_* env)`);
  }
  return { model, baseUrl };
}

export async function upsertTier(tier, model, baseUrl) {
  const key = String(tier || '').trim().toLowerCase();
  if (!key || !model || !baseUrl) {
    throw new Error('tier, model and baseUrl are required');
  }
  await (await db()).llmTier.upsert({
    where: { tier: key },
    update: { model, baseUrl },
    create: { tier: key, model, baseUrl },
  });
  return { tier: key, model, baseUrl, source: 'override' };
}

export async function deleteTier(tier) {
  const key = String(tier || '').trim().toLowerCase();
  await (await db()).llmTier.deleteMany({ where: { tier: key } });
}

export const TIERS_LIST = [
  'cheap',
  'fast',
  'balanced',
  'deep',
  'advanced',
  'multi',
  'translation',
  'asr',
  'tts',
];
