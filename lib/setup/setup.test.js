import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAttention, validateAttention } from './attentionSchema.js';
import { configurationRequestError } from '../settings/requestGuard.js';
import { providerRequest, sameEndpoint } from './provider.js';
import { configurationChat } from './agent.js';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import config from '../config.js';
import { readAttention, writeAttention } from './attention.js';
import { invalidateSettingsCache } from '../settings/resolve.js';

test('attention validates the pipeline schema and rejects malformed or duplicate IDs', () => {
  const clusters = { clusters: [{ id: 'team', conversationIds: ['cid-one'] }] };
  assert.equal(validateAttention('clusters', clusters), clusters);
  assert.deepEqual(
    parseAttention(
      'clusters',
      '# Config\n```json\n' + JSON.stringify(clusters) + '\n```',
    ),
    clusters,
  );
  assert.throws(() => parseAttention('watches', '# Missing fence'));
  assert.throws(() =>
    validateAttention('watches', {
      watches: [{ conversation_id: 'x', level: 'URGENT' }],
    }),
  );
  assert.throws(() =>
    validateAttention('watches', {
      watches: [
        { conversation_id: 'x', level: 'HIGH' },
        { conversation_id: 'x', level: 'NORMAL' },
      ],
    }),
  );
  assert.throws(() =>
    validateAttention('clusters', { clusters: [{ id: 'team' }] }),
  );
  assert.throws(() =>
    validateAttention('priorities', { unknown: ['ignored by reader'] }),
  );
  assert.throws(() => validateAttention('priorities', { supervisor: [42] }));
  assert.deepEqual(
    validateAttention('priorities', {
      supervisor: ['Alice'],
      priorityDepts: ['School'],
    }),
    { supervisor: ['Alice'], priorityDepts: ['School'] },
  );
});

test('configuration writes reject foreign, opaque, and cross-site origins', () => {
  const request = (headers) =>
    new Request('http://localhost:3000/api/settings/x', {
      headers: { host: 'dash.example.com', ...headers },
    });
  assert.equal(
    configurationRequestError(request({ origin: 'https://dash.example.com' })),
    null,
  );
  assert.equal(configurationRequestError(request({})), null);
  assert.ok(
    configurationRequestError(request({ origin: 'https://attacker.example' })),
  );
  assert.ok(configurationRequestError(request({ origin: 'null' })));
  assert.ok(
    configurationRequestError(request({ 'sec-fetch-site': 'cross-site' })),
  );
});

test('provider uses the bounded chat API and never exposes upstream errors', async (t) => {
  const provider = {
    baseUrl: 'https://model.example/v1/',
    model: 'test-model',
    apiKey: 'test-secret',
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://model.example/v1/chat/completions');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    assert.equal(JSON.parse(options.body).max_tokens, 3000);
    assert.ok(options.signal);
    return Response.json({
      choices: [{ message: { role: 'assistant', content: 'OK' } }],
    });
  });
  assert.equal(
    (await providerRequest(provider, [{ role: 'user', content: 'Hello' }]))
      .content,
    'OK',
  );
  globalThis.fetch.mock.mockImplementation(
    async () => new Response('test-secret upstream details', { status: 401 }),
  );
  await assert.rejects(
    providerRequest(provider, []),
    (error) => error.message === 'AI server returned HTTP 401',
  );
});

test('setup requests a provider on first run and blocks secret tool writes', async () => {
  const missing = await configurationChat([], {
    setupProvider: async () => ({}),
  });
  assert.equal(missing.needsProvider, true);
  let round = 0;
  let executed = false;
  const result = await configurationChat(
    [{ role: 'user', content: 'Configure me' }],
    {
      setupProvider: async () => ({
        baseUrl: 'https://model.example',
        model: 'model',
        apiKey: 'secret',
      }),
      describeSettings: async () => [],
      execute: async () => {
        executed = true;
      },
      providerRequest: async (_provider, messages) => {
        if (round++ === 0)
          return {
            role: 'assistant',
            tool_calls: [
              {
                id: 'one',
                function: {
                  name: 'configure',
                  arguments: JSON.stringify({
                    action: 'set',
                    key: 'llm.apiKey',
                    value: 'secret',
                  }),
                },
              },
            ],
          };
        assert.equal(
          JSON.parse(messages.at(-1).content).error.includes('Could not apply'),
          true,
        );
        return { content: 'Use the connection form.' };
      },
    },
  );
  assert.equal(executed, false);
  assert.equal(result.text, 'Use the connection form.');
});

test('endpoint matching gates stored-key reuse for the provider form', () => {
  assert.equal(
    sameEndpoint('https://litellm:4000/v1', 'https://litellm:4000/v1/'),
    true,
  );
  assert.equal(
    sameEndpoint('http://127.0.0.1:4000/v1', 'http://127.0.0.1:4000/v1'),
    true,
  );
  assert.equal(
    sameEndpoint('https://litellm:4000/v1', 'https://other-host:4000/v1'),
    false,
  );
  assert.equal(
    sameEndpoint('https://litellm:4000/v1', 'https://litellm:4000/v2'),
    false,
  );
  assert.equal(sameEndpoint('not a url', 'https://litellm:4000/v1'), false);
});

test('summary fences never shadow the configuration fence', () => {
  const config = { supervisor: ['Alice'] };
  const markdown =
    '# Attention priorities\n\n' +
    '```json\n{}\n```\n\n' +
    'A summary that itself contains a json fence\n\n' +
    '```json\n' +
    JSON.stringify(config, null, 2) +
    '\n```\n';
  assert.deepEqual(parseAttention('priorities', markdown), config);
  assert.throws(() => parseAttention('priorities', '# Only prose'));
});

test('concurrent attention writes serialize and keep distinct backups', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'workdash-attention-race-'));
  const previousPath = config.vaultPath;
  config.vaultPath = directory;
  invalidateSettingsCache();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true }));
  try {
    await Promise.all([
      writeAttention('priorities', { supervisor: ['First'] }, 'first'),
      writeAttention('priorities', { supervisor: ['Second'] }, 'second'),
    ]);
    // Serialized: the last write wins and the file is never a torn mix.
    assert.deepEqual(await readAttention('priorities'), {
      supervisor: ['Second'],
    });
    const backups = await readdir(join(directory, 'system/attention/backups'));
    assert.equal(backups.length, 2);
    const contents = await Promise.all(
      backups.map((file) =>
        readFile(join(directory, 'system/attention/backups', file), 'utf8'),
      ),
    );
    const parsed = contents.map((text) => parseAttention('priorities', text));
    assert.ok(
      parsed.some((c) => c.supervisor?.[0] === 'First'),
      'first write preserved as a backup',
    );
  } finally {
    config.vaultPath = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test('attention writes preserve original and previous configs in an isolated vault', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'workdash-attention-'));
  const previousPath = config.vaultPath;
  config.vaultPath = directory;
  invalidateSettingsCache();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true }));
  try {
    const baseline = await readAttention('priorities');
    await writeAttention(
      'priorities',
      { supervisor: ['Test Person'] },
      'Test priorities',
    );
    assert.deepEqual(await readAttention('priorities'), {
      supervisor: ['Test Person'],
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await writeAttention(
      'priorities',
      { supervisor: ['Second Person'] },
      'Updated priorities',
    );
    const backups = await readdir(join(directory, 'system/attention/backups'));
    assert.equal(backups.length, 2);
    const contents = await Promise.all(
      backups.map((file) =>
        readFile(join(directory, 'system/attention/backups', file), 'utf8'),
      ),
    );
    assert.ok(
      contents.some(
        (text) =>
          JSON.stringify(parseAttention('priorities', text)) ===
          JSON.stringify(baseline),
      ),
    );
    assert.ok(
      contents.some(
        (text) =>
          parseAttention('priorities', text).supervisor[0] === 'Test Person',
      ),
    );
  } finally {
    config.vaultPath = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
