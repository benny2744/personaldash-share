import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import matter from 'gray-matter';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://stub';
process.env.VAULT_PATH = process.env.VAULT_PATH || '/tmp/vault';
process.env.MEETING_S3_ENDPOINT =
  process.env.MEETING_S3_ENDPOINT || 'http://localhost:9000';
process.env.MEETING_S3_PUBLIC_BASE =
  process.env.MEETING_S3_PUBLIC_BASE || 'http://localhost:9000';
process.env.QWEN_FILETRANS_BASE_URL =
  process.env.QWEN_FILETRANS_BASE_URL || 'http://localhost';

const { buildTaskMarkdown, applyMeetingTypeFloor } = await import(
  './tasks.js'
);

describe('buildTaskMarkdown', () => {
  const baseTask = {
    title: 'Share the primer deck',
    actionItem: 'Share the primer deck with parents',
    people: ['李雪'],
    when: '2026-10-05',
  };

  it('writes the classified context and inherited area into frontmatter', () => {
    const { data } = matter(
      buildTaskMarkdown({
        task: baseTask,
        meetingBasename: '2026-10-01 - Curriculum - Primers',
        project: 'AI Class',
        area: 'Classroom Practice',
        context: 'Work',
      }),
    );
    assert.equal(data.Context, 'Work');
    assert.equal(data.Area, '[[Classroom Practice]]');
    assert.equal(data.Project, '[[AI Class]]');
    assert.equal(data.When, '2026-10-05');
  });

  it('leaves context null when unclassified and area null without inheritance', () => {
    const { data } = matter(
      buildTaskMarkdown({
        task: baseTask,
        meetingBasename: '2026-10-01 - Curriculum - Primers',
        project: null,
        area: null,
        context: null,
      }),
    );
    assert.equal(data.Context, null);
    assert.equal(data.Area, null);
    assert.equal(data.Project, '');
  });
});

describe('applyMeetingTypeFloor', () => {
  it('defaults unclassified tasks to Work for known meeting types', () => {
    assert.deepEqual(applyMeetingTypeFloor([null, 'Personal'], 'Team'), [
      'Work',
      'Personal',
    ]);
    assert.deepEqual(applyMeetingTypeFloor([null], 'Client'), ['Work']);
  });

  it('leaves contexts untouched for unknown or missing meeting types', () => {
    assert.deepEqual(applyMeetingTypeFloor([null], 'Birthday Party'), [null]);
    assert.deepEqual(applyMeetingTypeFloor([null, 'Work'], undefined), [
      null,
      'Work',
    ]);
  });
});
