import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelOptions } from './modelOptions.js';

describe('normalizeModelOptions', () => {
  it('groups providers verbatim and flags the current (provider, id)', () => {
    const normalized = normalizeModelOptions({
      model: 'qwen3.8-flash',
      provider: 'alibaba',
      providers: [
        {
          slug: 'alibaba',
          name: 'Alibaba',
          is_current: true,
          models: ['qwen3.8-max', 'qwen3.8-flash'],
        },
        {
          slug: 'copilot',
          name: 'Copilot',
          is_current: false,
          models: ['gpt-5.2-codex'],
        },
      ],
    });
    assert.equal(normalized.currentModel, 'qwen3.8-flash');
    assert.equal(normalized.currentProvider, 'alibaba');
    assert.deepEqual(
      normalized.groups.map((g) => g.slug),
      ['alibaba', 'copilot'],
    );
    const alibaba = normalized.groups[0];
    assert.equal(alibaba.isCurrent, true);
    assert.deepEqual(
      alibaba.models.map((m) => [m.id, m.isCurrent]),
      [
        ['qwen3.8-max', false],
        ['qwen3.8-flash', true],
      ],
    );
  });

  it('disambiguates a repeated model id by provider', () => {
    const normalized = normalizeModelOptions({
      model: 'kimi-k2.5',
      provider: 'xiaomi',
      providers: [
        { slug: 'alibaba', name: 'Alibaba', models: ['kimi-k2.5'] },
        { slug: 'xiaomi', name: 'Xiaomi', is_current: true, models: ['kimi-k2.5'] },
      ],
    });
    const inAlibaba = normalized.groups[0].models[0].isCurrent;
    const inXiaomi = normalized.groups[1].models[0].isCurrent;
    assert.equal(inAlibaba, false);
    assert.equal(inXiaomi, true);
  });

  it('falls back to id-only match when no current provider is reported', () => {
    const normalized = normalizeModelOptions({
      model: 'gpt-5.2',
      providers: [{ slug: 'openai', name: 'OpenAI', models: ['gpt-5.2'] }],
    });
    assert.equal(normalized.groups[0].models[0].isCurrent, true);
  });

  it('drops providers with no models and tolerates empty payloads', () => {
    assert.deepEqual(normalizeModelOptions(undefined).groups, []);
    assert.deepEqual(normalizeModelOptions({}).groups, []);
    const normalized = normalizeModelOptions({
      providers: [
        { slug: 'empty', name: 'Empty', models: [] },
        { slug: 'ok', name: 'OK', models: ['m1'] },
      ],
    });
    assert.deepEqual(
      normalized.groups.map((g) => g.slug),
      ['ok'],
    );
  });

  it('accepts object model entries and marks unauthenticated providers', () => {
    const normalized = normalizeModelOptions({
      model: '',
      providers: [
        {
          slug: 's',
          name: 'S',
          authenticated: false,
          models: [{ id: 'x' }, { model: 'y' }],
        },
      ],
    });
    assert.equal(normalized.groups[0].authenticated, false);
    assert.deepEqual(
        normalized.groups[0].models.map((m) => m.id),
      ['x', 'y'],
    );
  });
});
