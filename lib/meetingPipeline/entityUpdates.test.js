import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Pure-helper tests for lib/meetingPipeline/entityUpdates.js (bullet building
// + Meeting Log append). DB-touching paths are not exercised here.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://stub';
process.env.VAULT_PATH = process.env.VAULT_PATH || '/tmp/vault';
process.env.MEETING_S3_ENDPOINT =
  process.env.MEETING_S3_ENDPOINT || 'http://localhost:9000';
process.env.MEETING_S3_PUBLIC_BASE =
  process.env.MEETING_S3_PUBLIC_BASE || 'http://localhost:9000';
process.env.QWEN_FILETRANS_BASE_URL =
  process.env.QWEN_FILETRANS_BASE_URL || 'http://localhost';

const { buildLogBullet, appendMeetingLogBullet } =
  await import('./entityUpdates.js');

const analysis = { meeting: { date: '2026-08-21' } };
const update = { fact: 'Launch moved to October' };

describe('buildLogBullet', () => {
  it('builds a dated, meeting-linked bullet', () => {
    assert.equal(
      buildLogBullet(analysis, update, '2026-08-21 - Leadership - X'),
      '- 2026-08-21: Launch moved to October ([[2026-08-21 - Leadership - X]])',
    );
  });
});

describe('appendMeetingLogBullet', () => {
  const bullet = '- 2026-08-21: Launch moved to October ([[M]])';

  it('creates the heading when absent', () => {
    const { markdown, added } = appendMeetingLogBullet(
      '# Note\n\nBody.\n',
      bullet,
    );
    assert.equal(added, true);
    assert.ok(markdown.includes('## Meeting Log\n- 2026-08-21: Launch moved'));
  });

  it('appends at the end of an existing section, before the next heading', () => {
    const input =
      '# Note\n\n## Meeting Log\n- 2026-08-20: Earlier fact ([[A]])\n\n## Other\nStuff\n';
    const { markdown, added } = appendMeetingLogBullet(input, bullet);
    assert.equal(added, true);
    const logSection = markdown.split('## Meeting Log')[1].split('## Other')[0];
    assert.ok(logSection.includes('- 2026-08-20: Earlier fact'));
    assert.ok(logSection.includes('- 2026-08-21: Launch moved'));
    assert.ok(
      logSection.indexOf('Earlier fact') < logSection.indexOf('Launch moved'),
    );
    assert.ok(markdown.includes('## Other\nStuff'));
  });

  it('is a no-op when the identical bullet already exists', () => {
    const input = `## Meeting Log\n${bullet}\n`;
    const { markdown, added } = appendMeetingLogBullet(input, bullet);
    assert.equal(added, false);
    assert.equal(markdown, input);
  });
});
