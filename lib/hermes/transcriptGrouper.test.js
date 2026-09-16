import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatToolStepLabel,
  formatWorkSummary,
  groupTranscriptRows,
  humanizeToolName,
  summarizeToolResult,
} from './transcriptGrouper.js';

describe('humanizeToolName', () => {
  it('formats snake and camel names', () => {
    assert.equal(humanizeToolName('read_file'), 'Read File');
    assert.equal(humanizeToolName('webSearch'), 'Web Search');
  });
});

describe('formatToolStepLabel', () => {
  it('includes a primary target argument', () => {
    assert.equal(
      formatToolStepLabel({
        name: 'read_file',
        args: { path: 'config.yaml' },
      }),
      'Read File · config.yaml',
    );
  });
});

describe('summarizeToolResult', () => {
  it('suppresses routine raw json dumps', () => {
    assert.equal(
      summarizeToolResult({
        name: 'read_file',
        status: 'complete',
        result: '{"ok":true,"data":[1,2,3]}',
      }),
      '',
    );
  });

  it('keeps a meaningful one-line result', () => {
    assert.equal(
      summarizeToolResult({
        name: 'write_file',
        status: 'complete',
        result: 'Wrote ./notes/demo.md successfully\nextra',
      }),
      'Wrote ./notes/demo.md successfully',
    );
  });
});

describe('formatWorkSummary', () => {
  it('describes running and completed bursts', () => {
    assert.match(
      formatWorkSummary({
        running: true,
        tools: [
          {
            name: 'read_file',
            status: 'running',
            args: { path: 'a.md' },
          },
        ],
      }),
      /Read File · a\.md/,
    );
    assert.equal(
      formatWorkSummary({
        tools: [
          { name: 'read_file', status: 'complete', duration_s: 1.2 },
          { name: 'read_file', status: 'complete', duration_s: 0.8 },
        ],
        durationSec: 2,
      }),
      'Read 2 files · 2s',
    );
    assert.match(
      formatWorkSummary({
        tools: [
          { name: 'write_file', status: 'complete' },
          { name: 'write_file', status: 'error' },
        ],
      }),
      /1 failed/,
    );
  });
});

describe('groupTranscriptRows', () => {
  it('folds history tool rows into a work burst and keeps the answer', () => {
    const rows = groupTranscriptRows(
      [
        {
          id: 'u1',
          role: 'user',
          content: 'save note',
          turn_id: 't1',
        },
        {
          id: 'a1',
          role: 'assistant',
          content: '',
          reasoning: 'I should write a note',
          turn_id: 't1',
          tool_calls: [{ id: 'c1' }],
        },
        {
          id: 'tool1',
          role: 'tool',
          tool_call_id: 'c1',
          tool_name: 'write_file',
          content: 'Wrote note.md',
          turn_id: 't1',
        },
        {
          id: 'a2',
          role: 'assistant',
          content: 'Saved your note.',
          turn_id: 't1',
        },
      ],
      [],
    );

    assert.equal(rows[0].type, 'user');
    assert.equal(rows[1].type, 'work');
    assert.equal(rows[1].tools.length, 1);
    assert.equal(rows[1].tools[0].tool_id, 'c1');
    assert.match(rows[1].reasoning, /write a note/);
    assert.equal(rows[2].type, 'assistant');
    assert.equal(rows[2].message.content, 'Saved your note.');
  });

  it('deduplicates live tools against history tool rows', () => {
    const rows = groupTranscriptRows(
      [
        { id: 'u1', role: 'user', content: 'hi', turn_id: 't1' },
        {
          id: 'a1',
          role: 'assistant',
          content: 'done',
          turn_id: 't1',
        },
        {
          id: 'tool1',
          role: 'tool',
          tool_call_id: 'c1',
          tool_name: 'read_file',
          content: 'old',
          turn_id: 't1',
        },
      ],
      [
        {
          tool_id: 'c1',
          name: 'read_file',
          status: 'complete',
          result: 'new',
          turn_id: 't1',
          args: { path: 'x.md' },
        },
      ],
    );
    const work = rows.find((row) => row.type === 'work');
    assert.equal(work.tools.length, 1);
    assert.equal(work.tools[0].result, 'new');
  });

  it('shows a live work row while streaming with tools', () => {
    const rows = groupTranscriptRows(
      [
        { id: 'u1', role: 'user', content: 'go', turn_id: 't1' },
        {
          id: 'a1',
          role: 'assistant',
          content: '',
          reasoning: 'planning',
          streaming: true,
          turn_id: 't1',
        },
      ],
      [
        {
          tool_id: 'c1',
          name: 'search',
          status: 'running',
          turn_id: 't1',
          args: { query: 'visa' },
        },
      ],
    );
    assert.equal(rows.some((row) => row.type === 'work' && row.running), true);
    assert.equal(rows.some((row) => row.type === 'assistant'), false);
  });
});
