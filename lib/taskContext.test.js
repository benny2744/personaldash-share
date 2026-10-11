import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://stub';
process.env.VAULT_PATH = process.env.VAULT_PATH || '/tmp/vault';
process.env.MEETING_S3_ENDPOINT =
  process.env.MEETING_S3_ENDPOINT || 'http://localhost:9000';
process.env.MEETING_S3_PUBLIC_BASE =
  process.env.MEETING_S3_PUBLIC_BASE || 'http://localhost:9000';
process.env.QWEN_FILETRANS_BASE_URL =
  process.env.QWEN_FILETRANS_BASE_URL || 'http://localhost';

const { classifyTaskContexts, mapClassifiedContexts, inheritAreaFromProject } =
  await import('@/lib/taskContext.js');

describe('mapClassifiedContexts', () => {
  it('normalizes allowed values and rejects junk', () => {
    const contexts = mapClassifiedContexts(
      JSON.stringify(['work', 'PERSONAL', 'side projects', 'family', 42]),
      5,
    );
    assert.deepEqual(contexts, [
      'Work',
      'Personal',
      'Side Projects',
      null,
      null,
    ]);
  });

  it('strips a code fence before parsing', () => {
    const contexts = mapClassifiedContexts(
      '```json\n["Work", null]\n```',
      2,
    );
    assert.deepEqual(contexts, ['Work', null]);
  });

  it('accepts a {contexts:[...]} wrapper', () => {
    const contexts = mapClassifiedContexts(
      JSON.stringify({ contexts: ['Personal'] }),
      2,
    );
    assert.deepEqual(contexts, ['Personal', null]);
  });

  it('fills null for missing or malformed responses', () => {
    assert.deepEqual(mapClassifiedContexts(JSON.stringify([]), 2), [
      null,
      null,
    ]);
    assert.deepEqual(mapClassifiedContexts('not json at all', 2), [
      null,
      null,
    ]);
  });
});

describe('classifyTaskContexts', () => {
  it('maps the LLM response onto the task order', async () => {
    const seen = [];
    const contexts = await classifyTaskContexts(
      [
        { title: 'Prep parent updates', actionItem: 'send weekly notes' },
        { title: 'Fix the leaky kitchen tap' },
      ],
      { meetingType: 'Parent Comms' },
      async (args) => {
        seen.push(args);
        return '["Work", "Personal"]';
      },
    );
    assert.deepEqual(contexts, ['Work', 'Personal']);
    assert.equal(seen.length, 1);
    assert.match(seen[0].user, /Prep parent updates/);
    assert.match(seen[0].user, /Meeting type: Parent Comms/);
  });

  it('returns all null without calling the LLM for an empty batch', async () => {
    let calls = 0;
    const contexts = await classifyTaskContexts(
      [],
      {},
      async () => {
        calls += 1;
        return '[]';
      },
    );
    assert.deepEqual(contexts, []);
    assert.equal(calls, 0);
  });

  it('falls back to all null when the LLM call fails', async () => {
    const contexts = await classifyTaskContexts(
      [{ title: 'Anything' }],
      {},
      async () => {
        throw new Error('gateway down');
      },
    );
    assert.deepEqual(contexts, [null]);
  });
});

describe('inheritAreaFromProject', () => {
  let tmpDir;
  let originalVaultPath;

  beforeEach(async () => {
    const cfg = (await import('@/lib/config.js')).default;
    originalVaultPath = cfg.vaultPath;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-context-test-'));
    cfg.vaultPath = tmpDir;
    await fs.mkdir(path.join(tmpDir, 'projects'), { recursive: true });
  });

  afterEach(async () => {
    const cfg = (await import('@/lib/config.js')).default;
    cfg.vaultPath = originalVaultPath;
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reads the linked area from the project note', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'projects', 'AI Demo Class.md'),
      '---\nArea: "[[Classroom Practice]]"\n---\n# AI Demo Class\n',
    );
    assert.equal(await inheritAreaFromProject('AI Demo Class'), 'Classroom Practice');
    assert.equal(await inheritAreaFromProject('[[AI Demo Class]]'), 'Classroom Practice');
  });

  it('returns null when the project note is missing or has no area', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'projects', 'Bare Project.md'),
      '---\nArea: null\n---\n# Bare Project\n',
    );
    assert.equal(await inheritAreaFromProject('Missing Project'), null);
    assert.equal(await inheritAreaFromProject('Bare Project'), null);
    assert.equal(await inheritAreaFromProject(''), null);
  });
});
