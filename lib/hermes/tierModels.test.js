import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelOptions } from './modelOptions.js';
import {
  buildTierCatalog,
  providerByModel,
  providersForModel,
  tierForModel,
} from './tierModels.js';

const catalog = normalizeModelOptions({
  model: 'qwen3.8-flash',
  provider: 'alibaba',
  providers: [
    { slug: 'alibaba', name: 'Alibaba', is_current: true, models: ['qwen3.8-flash', 'qwen3.7-flash'] },
    { slug: 'deepseek', name: 'DeepSeek', models: ['k3', 'deepseek-v4-pro'] },
    { slug: 'copilot', name: 'Copilot', models: ['gpt-5.6-sol'] },
    { slug: 'xiaomi', name: 'Xiaomi', models: ['musespark-1.3'] },
  ],
});

const tiers = [
  { tier: 'fast', model: 'qwen3.8-flash' },
  { tier: 'cheap', model: 'qwen3.7-flash' },
  { tier: 'advanced', model: 'k3' },
  { tier: 'deep', model: 'gpt-5.6-sol' },
  { tier: 'balanced', model: 'musespark-1.3' },
  { tier: 'asr', model: 'qwen3-asr-flash-filetrans' }, // not switchable
];

describe('providerByModel', () => {
  it('attributes a model to its provider, preferring the current one', () => {
    const map = providerByModel(catalog);
    assert.equal(map.get('qwen3.8-flash'), 'alibaba');
    assert.equal(map.get('k3'), 'deepseek');
  });

  it('prefers the estate serving path over the merely-current provider', () => {
    // A model listed by both the profile's own provider (current) and the
    // preferred OpenAI path must attribute to the preferred one — the
    // create-time override validates against curated per-provider catalogs
    // and rejects the LiteLLM-slot pair for OpenAI models.
    const multi = normalizeModelOptions({
      model: 'qwen3.8-flash',
      provider: 'alibaba',
      providers: [
        { slug: 'alibaba', name: 'Alibaba', is_current: true, models: ['gpt-6-luna'] },
        { slug: 'zai', name: 'Zai', models: ['gpt-6-luna'] },
        { slug: 'openai-codex', name: 'Codex', models: ['gpt-6-luna'] },
      ],
    });
    const map = providerByModel(multi);
    assert.equal(map.get('gpt-6-luna'), 'openai-codex');
  });
});

describe('providersForModel', () => {
  it('lists every serving provider, preferred first, then catalog order', () => {
    const multi = normalizeModelOptions({
      model: 'qwen3.8-flash',
      provider: 'alibaba',
      providers: [
        { slug: 'alibaba', name: 'Alibaba', is_current: true, models: ['gpt-6-luna'] },
        { slug: 'deepseek', name: 'DeepSeek', models: ['gpt-6-luna', 'k3'] },
        { slug: 'openai-codex', name: 'Codex', models: ['gpt-6-luna'] },
      ],
    });
    assert.deepEqual(
      [...providersForModel(multi).entries()],
      [
        ['gpt-6-luna', ['openai-codex', 'alibaba', 'deepseek']],
        ['k3', ['deepseek']],
      ],
    );
  });
});

describe('buildTierCatalog', () => {
  it('emits one flat Tiers group with switchable tiers in chat order', () => {
    const out = buildTierCatalog(tiers, catalog);
    assert.equal(out.groups.length, 1);
    assert.equal(out.groups[0].slug, 'tier');
    assert.deepEqual(
      out.groups[0].models.map((m) => m.label),
      ['fast', 'cheap', 'balanced', 'deep', 'advanced'],
    );
  });

  it('attaches the resolved provider and the underlying model as sublabel', () => {
    const out = buildTierCatalog(tiers, catalog);
    const fast = out.groups[0].models.find((m) => m.label === 'fast');
    assert.equal(fast.id, 'qwen3.8-flash');
    assert.equal(fast.provider, 'alibaba');
    assert.equal(fast.sublabel, 'qwen3.8-flash');
  });

  it('attaches the ordered provider fallback list to tier rows', () => {
    const out = buildTierCatalog(tiers, catalog);
    const fast = out.groups[0].models.find((m) => m.label === 'fast');
    assert.deepEqual(fast.providers, ['alibaba']);
  });

  it('flags the tier backing the current model', () => {
    const out = buildTierCatalog(tiers, catalog);
    const fast = out.groups[0].models.find((m) => m.label === 'fast');
    assert.equal(fast.isCurrent, true);
    const cheap = out.groups[0].models.find((m) => m.label === 'cheap');
    assert.equal(cheap.isCurrent, false);
  });

  it('drops tiers whose model is not switchable via Hermes', () => {
    const out = buildTierCatalog(tiers, catalog);
    const labels = out.groups[0].models.map((m) => m.label);
    assert.ok(!labels.includes('asr'));
  });

  it('falls back to the raw catalog when no tier resolves', () => {
    const out = buildTierCatalog(
      [{ tier: 'weird', model: 'unknown-model' }],
      catalog,
    );
    assert.equal(out, catalog);
  });

  it('appends authenticated providers no tier references as their own group', () => {
    const withCodex = normalizeModelOptions({
      model: 'qwen3.8-flash',
      provider: 'alibaba',
      providers: [
        catalog.groups[0] ?? { slug: 'alibaba', models: [] },
        { slug: 'openai-codex', name: 'OpenAI Codex', models: ['gpt-6-astra', 'gpt-5.6-sol'] },
      ],
    });
    const nonCodexTiers = tiers.filter((t) => t.model !== 'gpt-5.6-sol');
    const out = buildTierCatalog(nonCodexTiers, withCodex);
    assert.equal(out.groups.length, 2);
    const codex = out.groups[1];
    assert.equal(codex.slug, 'openai-codex');
    assert.equal(codex.name, 'OpenAI Codex');
    assert.deepEqual(
      codex.models.map((m) => m.id),
      ['gpt-6-astra', 'gpt-5.6-sol'],
    );
    const astra = codex.models[0];
    assert.equal(astra.provider, 'openai-codex');
    assert.equal(astra.label, 'gpt-6-astra');
    assert.equal(astra.isCurrent, false);
  });

  it('does not duplicate providers already covered by tier rows', () => {
    const out = buildTierCatalog(tiers, catalog);
    const slugs = out.groups.map((g) => g.slug);
    assert.ok(!slugs.includes('alibaba'));
    assert.ok(!slugs.includes('copilot'));
  });

  it('keeps an extra provider group when a tier row attributes to it, minus covered models', () => {
    // Regression 2026-10-22: provider-level `covered` dropped the whole Codex
    // group from the picker the moment the fast tier (gpt-6-luna) attributed
    // to openai-codex — coverage must be per model.
    const withCodex = normalizeModelOptions({
      model: 'gpt-6-luna',
      provider: 'openai-codex',
      providers: [
        { slug: 'alibaba', name: 'Alibaba', is_current: true, models: ['gpt-6-luna'] },
        { slug: 'openai-codex', name: 'OpenAI Codex', authenticated: true, models: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'] },
      ],
    });
    const out = buildTierCatalog([{ tier: 'fast', model: 'gpt-6-luna' }], withCodex);
    assert.deepEqual(out.groups.map((g) => g.slug), ['tier', 'openai-codex']);
    const codex = out.groups[1];
    // luna is already the fast tier row — not duplicated under Codex.
    assert.deepEqual(
      codex.models.map((m) => m.id),
      ['gpt-6.1-sol', 'gpt-6-astra'],
    );
  });

  it('drops an extra provider group when every model is covered by tier rows', () => {
    const withCodex = normalizeModelOptions({
      model: 'gpt-6-luna',
      provider: 'openai-codex',
      providers: [
        { slug: 'openai-codex', name: 'OpenAI Codex', authenticated: true, models: ['gpt-6-luna'] },
      ],
    });
    const out = buildTierCatalog([{ tier: 'fast', model: 'gpt-6-luna' }], withCodex);
    assert.deepEqual(out.groups.map((g) => g.slug), ['tier']);
  });

  it('excludes unauthenticated extra providers', () => {
    const withUnauth = normalizeModelOptions({
      model: 'qwen3.8-flash',
      provider: 'alibaba',
      providers: [
        catalog.groups[0] ?? { slug: 'alibaba', models: [] },
        { slug: 'openai-codex', name: 'OpenAI Codex', authenticated: false, models: ['gpt-6-astra'] },
      ],
    });
    const out = buildTierCatalog(tiers, withUnauth);
    const slugs = out.groups.map((g) => g.slug);
    assert.ok(!slugs.includes('openai-codex'));
  });

  it('excludes authenticated providers not in EXTRA_PROVIDER_SLUGS', () => {
    const withZai = normalizeModelOptions({
      model: 'qwen3.8-flash',
      provider: 'alibaba',
      providers: [
        catalog.groups[0] ?? { slug: 'alibaba', models: [] },
        { slug: 'zai', name: 'Z.AI', models: ['glm-5'] },
      ],
    });
    const nonCodexTiers = tiers.filter((t) => t.model !== 'gpt-5.6-sol');
    const out = buildTierCatalog(nonCodexTiers, withZai);
    assert.deepEqual(out.groups.map((g) => g.slug), ['tier']);
  });
});

describe('tierForModel', () => {
  it('maps a model id back to its tier', () => {
    assert.equal(tierForModel(tiers, 'k3'), 'advanced');
  });
  it('returns null for an unknown model or empty input', () => {
    assert.equal(tierForModel(tiers, 'nope'), null);
    assert.equal(tierForModel(tiers, ''), null);
  });
  it('prefers the higher-ranked tier when a model maps to several', () => {
    // qwen3.8-flash is both `multi` and `translation`; input order must not
    // decide the label — CHAT_TIER_ORDER does (fast < … < multi < translation).
    const ambiguous = [
      { tier: 'translation', model: 'qwen3.8-flash' },
      { tier: 'multi', model: 'qwen3.8-flash' },
      { tier: 'fast', model: 'qwen3.8-flash' },
    ];
    assert.equal(tierForModel(ambiguous, 'qwen3.8-flash'), 'fast');
    const two = [
      { tier: 'translation', model: 'qwen3.8-flash' },
      { tier: 'multi', model: 'qwen3.8-flash' },
    ];
    assert.equal(tierForModel(two, 'qwen3.8-flash'), 'multi');
  });
});
