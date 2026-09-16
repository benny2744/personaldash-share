import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Pure-helper tests for lib/meetingPipeline/recover.js (session-based salvage
// of interrupted format jobs). Nothing here touches S3, prisma, opencode, or
// the LLM provider; env vars are stubbed so module load doesn't throw.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://stub';
process.env.VAULT_PATH = process.env.VAULT_PATH || '/tmp/vault';
process.env.MEETING_S3_ENDPOINT =
  process.env.MEETING_S3_ENDPOINT || 'http://localhost:9000';
process.env.MEETING_S3_PUBLIC_BASE =
  process.env.MEETING_S3_PUBLIC_BASE || 'http://localhost:9000';
process.env.QWEN_FILETRANS_BASE_URL =
  process.env.QWEN_FILETRANS_BASE_URL || 'http://localhost';

const {
  messageText,
  lastUserPromptOf,
  lastAssistantTextOf,
  parsePromptHeaders,
  extractCleanedTranscript,
  parsePersistedPass1,
  replayPostFormat,
} = await import('./recover.js');

function message(role, text, agent = '') {
  return {
    info: { role, agent },
    parts: [{ type: 'text', text }],
  };
}

describe('messageText / lastUserPromptOf / lastAssistantTextOf', () => {
  it('joins text parts of a message', () => {
    const msg = {
      info: { role: 'assistant' },
      parts: [
        { type: 'step-start' },
        { type: 'text', text: 'hello ' },
        { type: 'text', text: 'world' },
      ],
    };
    assert.equal(messageText(msg), 'hello \nworld');
  });

  it('returns empty string for messages without text parts', () => {
    assert.equal(messageText({ info: { role: 'user' }, parts: [] }), '');
  });

  it('finds the last user prompt and last assistant text', () => {
    const messages = [
      message('user', 'first prompt', 'meeting-program-ops'),
      message('assistant', 'intermediate reasoning'),
      message('user', 'second prompt'),
      message('assistant', '```json\n{"summary_en":"x"}\n```'),
    ];
    const prompt = lastUserPromptOf(messages);
    assert.equal(prompt.text, 'second prompt');
    assert.equal(prompt.agent, '');

    assert.equal(
      lastAssistantTextOf(messages),
      '```json\n{"summary_en":"x"}\n```',
    );
  });

  it('returns null / empty when no matching messages exist', () => {
    const messages = [message('assistant', 'only assistant')];
    assert.equal(lastUserPromptOf(messages), null);
    assert.equal(lastAssistantTextOf([message('user', 'only user')]), '');
  });
});

describe('parsePromptHeaders', () => {
  it('extracts date, type, and topic from a format prompt', () => {
    const prompt = [
      'Meeting date: 2026-08-17',
      'Meeting type: Program Ops',
      'Topic: Classroom Proxy Internet Control Setup',
      '',
      'Existing People notes (use exact names when linking):',
      'Alex, Claire',
    ].join('\n');
    assert.deepEqual(parsePromptHeaders(prompt), {
      date: '2026-08-17',
      type: 'Program Ops',
      topic: 'Classroom Proxy Internet Control Setup',
    });
  });

  it('returns empty strings when headers are missing', () => {
    assert.deepEqual(parsePromptHeaders('unrelated text'), {
      date: '',
      type: '',
      topic: '',
    });
  });
});

describe('extractCleanedTranscript', () => {
  it('slices everything after the transcript marker', () => {
    const prompt =
      'Meeting date: 2026-08-17\n\nCleaned transcript:\n\nHello everyone.\n\nSecond paragraph.';
    assert.equal(
      extractCleanedTranscript(prompt),
      'Hello everyone.\n\nSecond paragraph.',
    );
  });

  it('returns empty string when the marker is absent', () => {
    assert.equal(extractCleanedTranscript('no marker here'), '');
  });
});

describe('parsePersistedPass1', () => {
  it('parses a persisted pass1 payload', () => {
    const pass1 = {
      metadata: { date: '2026-08-17' },
      cleanedTranscript: 'the transcript',
      sourceName: 'a.mp3',
    };
    assert.deepEqual(parsePersistedPass1(JSON.stringify(pass1)), pass1);
  });

  it('returns null for absent, malformed, or incomplete payloads', () => {
    assert.equal(parsePersistedPass1(null), null);
    assert.equal(parsePersistedPass1(''), null);
    assert.equal(parsePersistedPass1('{not json'), null);
    assert.equal(parsePersistedPass1('{"metadata":{}}'), null);
  });
});

describe('replayPostFormat (dry run)', () => {
  beforeEach(async () => {
    await fs.mkdir('/tmp/vault/meetings', { recursive: true });
  });

  it('assembles the note without touching the vault and reports paths', async () => {
    const previewDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'recover-test-'),
    );
    const contract = {
      summary_en: '## Context\nThe meeting happened.',
      summary_zh: '',
      action_items: [{ title: 'Do the thing', owner: 'Alex', due: null }],
      decisions: ['Decide the decision'],
      frontmatter_extra: {},
    };
    const pass1 = {
      metadata: {
        date: '2026-08-17',
        type: 'Program Ops',
        topic: 'Dry Run Topic',
        attendees: [],
        project: '',
        area: '',
        tags: [],
        filename: '2026-08-17 - Program Ops - Dry Run Topic.md',
      },
      cleanedTranscript: 'word-for-word transcript body',
    };
    const vaultContext = {
      people: [],
      projects: [],
      areas: [],
      peopleAliases: {},
      projectsAliases: {},
      areasAliases: {},
    };

    const result = await replayPostFormat({
      jobId: 'testjob',
      contract,
      pass1,
      vaultContext,
      sessionID: null,
      dryRun: true,
      previewDir,
    });

    assert.equal(
      result.outputPath,
      'meetings/2026-08-17 - Program Ops - Dry Run Topic.md',
    );
    assert.deepEqual(result.taskTitles, ['Do the thing']);

    const markdown = await fs.readFile(result.previewPath, 'utf8');
    assert.match(markdown, /# 2026-08-17 - Program Ops - Dry Run Topic/);
    assert.match(markdown, /## Context/);
    assert.match(markdown, /## Transcript/);
    assert.match(markdown, /word-for-word transcript body/);

    // Dry run must not write the note into the vault.
    await assert.rejects(
      fs.readFile(path.join('/tmp/vault', result.outputPath), 'utf8'),
    );
  });
});
