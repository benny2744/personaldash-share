import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelOptions } from './modelOptions.js';
import {
  buildTierCatalog,
  providerByModel,
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
});

describe('tierForModel', () => {
  it('maps a model id back to its tier', () => {
    assert.equal(tierForModel(tiers, 'k3'), 'advanced');
  });
  it('returns null for an unknown model or empty input', () => {
    assert.equal(tierForModel(tiers, 'nope'), null);
    assert.equal(tierForModel(tiers, ''), null);
  });
});
