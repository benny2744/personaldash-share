import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chatReducer,
  createInitialChatState,
  normalizeHistoryMessages,
  toolsFromNormalizedHistory,
} from './chatReducer.js';
import { normalizePanelState } from './panelState.js';

describe('normalizeHistoryMessages', () => {
  it('marks REST/history rows as canonical (not provisional)', () => {
    const messages = normalizeHistoryMessages([
      { role: 'user', content: 'hi', id: 1 },
      { role: 'assistant', content: 'hello', id: 2 },
      { role: 'user', content: 'again' },
    ]);
    assert.equal(messages[0].provisional, false);
    assert.equal(messages[1].provisional, false);
    assert.equal(messages[2].provisional, false);
  });

  it('marks live user messages and streaming assistant rows as provisional', () => {
    let state = createInitialChatState();
    state = chatReducer(state, {
      type: 'session.bound',
      payload: { liveSessionId: 'live-s1', storedSessionId: 'stored-s1' },
    });
    state = chatReducer(state, {
      type: 'user.message',
      payload: { text: 'go' },
    });
    assert.equal(state.messages[0].provisional, true);

    state = chatReducer(state, {
      type: 'event',
      payload: {
        type: 'message.delta',
        session_id: 'live-s1',
        payload: { text: 'Hi' },
      },
    });
    assert.equal(state.messages[1].provisional, true);

    state = chatReducer(state, {
      type: 'event',
      payload: {
        type: 'message.complete',
        session_id: 'live-s1',
        payload: { text: 'Hi there' },
      },
    });
    assert.equal(state.messages[1].provisional, true);
  });

  it('marks fallback history as provisional when requested', () => {
    let state = createInitialChatState();
    state = chatReducer(state, {
      type: 'history.loaded',
      payload: {
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'yo' },
        ],
        provisional: true,
      },
    });
    assert.equal(state.messages[0].provisional, true);
    assert.equal(state.messages[1].provisional, true);
  });

  it('keeps roles, flattens array content, and assigns turn ids', () => {
    const messages = normalizeHistoryMessages([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: ' world' },
        ],
      },
      { role: 'user', content: 'again' },
      { role: 'assistant', content: 'ok' },
    ]);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[1].content, 'hello\n world');
    assert.equal(messages[1].streaming, false);
    assert.ok(messages[0].turn_id);
    assert.equal(messages[0].turn_id, messages[1].turn_id);
    assert.notEqual(messages[0].turn_id, messages[2].turn_id);
    assert.equal(messages[2].turn_id, messages[3].turn_id);
  });

  it('folds tool history rows into tool cards with the same turn id', () => {
    const messages = normalizeHistoryMessages([
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', function: { name: 'write_file' } }],
      },
      {
        role: 'tool',
        tool_call_id: 'c1',
        tool_name: 'write_file',
        content: 'Wrote demo.md',
      },
      { role: 'assistant', content: 'Done' },
    ]);
    const tools = toolsFromNormalizedHistory(messages);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].tool_id, 'c1');
    assert.equal(tools[0].turn_id, messages[0].turn_id);
  });

  it('accepts gateway session.resume {text} rows and tool name/context', () => {
    // Matches Hermes tui_gateway _history_to_messages / session.resume display shape.
    const messages = normalizeHistoryMessages([
      { role: 'user', text: 'hello' },
      {
        role: 'assistant',
        text: 'yo',
        reasoning: 'thoughts',
      },
      { role: 'tool', name: 'search', context: 'query=visa' },
      { role: 'assistant', text: 'Saved your note.' },
    ]);
    assert.equal(messages[0].content, 'hello');
    assert.equal(messages[1].content, 'yo');
    assert.equal(messages[1].reasoning, 'thoughts');
    assert.equal(messages[2].role, 'tool');
    assert.equal(messages[2].tool_name, 'search');
    assert.equal(messages[2].content, 'query=visa');
    assert.equal(messages[3].content, 'Saved your note.');
    assert.equal(messages[0].turn_id, messages[1].turn_id);
    assert.equal(messages[0].turn_id, messages[2].turn_id);
    assert.equal(messages[0].turn_id, messages[3].turn_id);

    const tools = toolsFromNormalizedHistory(messages);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'search');
    assert.equal(tools[0].result, 'query=visa');
    assert.equal(tools[0].turn_id, messages[0].turn_id);
  });
});

describe('chatReducer', () => {
  it('binds live and stored session ids separately', () => {
    let state = createInitialChatState();
    state = chatReducer(state, {
      type: 'session.bound',
      payload: {
        liveSessionId: 'live1234',
        storedSessionId: 'stored-abc',
        title: 'Demo',
      },
    });
    assert.equal(state.liveSessionId, 'live1234');
    assert.equal(state.storedSessionId, 'stored-abc');
    assert.equal(state.title, 'Demo');
  });

  it('streams deltas and completes assistant messages', () => {
    let state = createInitialChatState();
    state = chatReducer(state, {
      type: 'session.bound',
      payload: { liveSessionId: 's1', storedSessionId: 's1' },
    });
    state = chatReducer(state, {
      type: 'event',
      payload: {
        type: 'message.delta',
        session_id: 's1',
        payload: { text: 'Hel' },
      },
    });
    state = chatReducer(state, {
      type: 'event',
      payload: {
        type: 'message.delta',
        session_id: 's1',
        payload: { text: 'lo' },
      },
    });
    state = chatReducer(state, {
      type: 'event',
      payload: {
        type: 'message.complete',
        session_id: 's1',
        payload: { text: 'Hello' },
      },
    });
    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0].content, 'Hello');
    assert.equal(state.messages[0].streaming, false);
    assert.equal(state.running, false);
  });

  it('reconciles tools by tool_id, attaches turn ids, and collects artifacts', () => {
    let state = createInitialChatState();
    state = chatReducer(state, {
      type: 'session.bound',
      payload: { liveSessionId: 's1', storedSessionId: 's1' },
    });
    state = chatReducer(state, {
      type: 'user.message',
      payload: { text: 'write a note' },
    });
    const turnId = state.activeTurnId;
    assert.ok(turnId);
    state = chatReducer(state, {
      type: 'event',
      payload: {
        type: 'tool.start',
        session_id: 's1',
        payload: { tool_id: 't1', name: 'write_file' },
      },
    });
    state = chatReducer(state, {
      type: 'event',
      payload: {
        type: 'tool.complete',
        session_id: 's1',
        payload: {
          tool_id: 't1',
          name: 'write_file',
          result_text: 'Wrote ./notes/demo.md successfully',
          todos: [{ id: '1', content: 'Ship chat', status: 'pending' }],
        },
      },
    });
    assert.equal(state.tools.length, 1);
    assert.equal(state.tools[0].status, 'complete');
    assert.equal(state.tools[0].turn_id, turnId);
    assert.equal(state.todos[0].content, 'Ship chat');
    assert.ok(state.artifacts.some((item) => item.path.includes('demo.md')));
    // Tool events should not spam the diagnostics activity feed.
    assert.equal(
      state.activity.filter((item) => item.kind === 'tool').length,
      0,
    );
  });

  it('loads history tools instead of wiping them', () => {
    let state = createInitialChatState();
    state = chatReducer(state, {
      type: 'history.loaded',
      payload: {
        storedSessionId: 'hist-1',
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'tool',
            tool_call_id: 'c9',
            tool_name: 'read_file',
            content: 'hello',
          },
          { role: 'assistant', content: 'done' },
        ],
      },
    });
    assert.equal(state.tools.length, 1);
    assert.equal(state.tools[0].tool_id, 'c9');
    assert.equal(state.tools[0].turn_id, state.messages[0].turn_id);
  });

  it('ignores stale events from other live sessions', () => {
    let state = createInitialChatState();
    state = chatReducer(state, {
      type: 'session.bound',
      payload: { liveSessionId: 'current', storedSessionId: 'current' },
    });
    state = chatReducer(state, {
      type: 'event',
      payload: {
        type: 'message.delta',
        session_id: 'old',
        payload: { text: 'stale' },
      },
    });
    assert.equal(state.messages.length, 0);
  });

  it('updates the canonical model from a session.info event', () => {
    let state = createInitialChatState();
    state = chatReducer(state, {
      type: 'session.bound',
      payload: {
        liveSessionId: 'live-s1',
        storedSessionId: 's1',
        model: 'qwen3.8-flash',
      },
    });
    assert.equal(state.model, 'qwen3.8-flash');
    // A /model switch (via slash.exec) re-emits session.info with the new model.
    state = chatReducer(state, {
      type: 'event',
      payload: {
        type: 'session.info',
        session_id: 'live-s1',
        payload: { model: 'qwen3.7-plus' },
      },
    });
    assert.equal(state.model, 'qwen3.7-plus');
  });

  it('ignores a session.info model update from a stale session id', () => {
    let state = createInitialChatState();
    state = chatReducer(state, {
      type: 'session.bound',
      payload: {
        liveSessionId: 'live-current',
        storedSessionId: 'cur',
        model: 'qwen3.8-flash',
      },
    });
    state = chatReducer(state, {
      type: 'event',
      payload: {
        type: 'session.info',
        session_id: 'live-old',
        payload: { model: 'gpt-5.2' },
      },
    });
    assert.equal(state.model, 'qwen3.8-flash');
  });

  it('marks interrupted turns after disconnect', () => {
    let state = createInitialChatState();
    state = chatReducer(state, {
      type: 'session.bound',
      payload: { liveSessionId: 's1', storedSessionId: 's1' },
    });
    state = chatReducer(state, {
      type: 'event',
      payload: {
        type: 'message.delta',
        session_id: 's1',
        payload: { text: 'partial' },
      },
    });
    state = chatReducer(state, { type: 'mark.interrupted' });
    assert.equal(state.interrupted, true);
    assert.equal(state.messages[0].interrupted, true);
    assert.equal(state.running, false);
  });

  it('tracks connection recovery activity', () => {
    let state = createInitialChatState();
    state = chatReducer(state, { type: 'connection', payload: 'closed' });
    state = chatReducer(state, { type: 'connection', payload: 'open' });
    assert.ok(state.activity.some((item) => /disconnected/i.test(item.text)));
    assert.ok(state.activity.some((item) => /connected/i.test(item.text)));
  });
});

describe('clarify prompts', () => {
  it('normalizes single-question clarify requests (live shape)', () => {
    let state = createInitialChatState();
    state = chatReducer(state, {
      type: 'event',
      payload: {
        type: 'clarify.request',
        session_id: 's1',
        payload: {
          request_id: 'r1',
          question: 'Which format?',
          choices: ['md', 'pdf (Recommended)'],
        },
      },
    });
    assert.equal(state.clarify.batch, false);
    assert.equal(state.clarify.request_id, 'r1');
    assert.equal(state.clarify.question, 'Which format?');
    assert.deepEqual(state.clarify.choices, ['md', 'pdf (Recommended)']);
  });

  it('normalizes batch clarify requests with per-question state', () => {
    let state = createInitialChatState();
    state = chatReducer(state, {
      type: 'event',
      payload: {
        type: 'clarify.request',
        session_id: 's1',
        payload: {
          request_id: 'rb',
          questions: [
            { qid: 'q0', question: 'Title?', choices: ['A', 'B'] },
            {
              qid: 'q1',
              question: 'Tags?',
              choices: ['x', 'y'],
              multi_select: true,
            },
          ],
        },
      },
    });
    assert.equal(state.clarify.batch, true);
    assert.equal(state.clarify.request_id, 'rb');
    assert.equal(state.clarify.questions.length, 2);
    assert.equal(state.clarify.questions[0].qid, 'q0');
    assert.deepEqual(state.clarify.questions[0].choices, ['A', 'B']);
    assert.equal(state.clarify.questions[1].multi_select, true);
    assert.equal(state.clarify.questions[0].answered, false);
  });

  it('marks batch questions answered via clarify.answer', () => {
    let state = createInitialChatState();
    state = chatReducer(state, {
      type: 'event',
      payload: {
        type: 'clarify.request',
        session_id: 's1',
        payload: {
          request_id: 'rb',
          questions: [
            { qid: 'q0', question: 'Title?', choices: ['A'] },
            { qid: 'q1', question: 'Tags?', choices: ['x'] },
          ],
        },
      },
    });
    state = chatReducer(state, {
      type: 'clarify.answer',
      payload: { questionId: 'q0', answer: 'A' },
    });
    assert.equal(state.clarify.questions[0].answered, true);
    assert.equal(state.clarify.questions[0].answer, 'A');
    assert.equal(state.clarify.questions[1].answered, false);
  });

  it('rehydrates pending approval + clarify after resume (prompt.pending)', () => {
    let state = createInitialChatState();
    // history.loaded clears prompts — pending rehydration must survive it.
    state = chatReducer(state, {
      type: 'history.loaded',
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    state = chatReducer(state, {
      type: 'prompt.pending',
      payload: {
        approval: { request_id: 'a1', command: 'rm -rf /tmp/x' },
        clarify: {
          request_id: 'rb',
          questions: [
            { qid: 'q0', question: 'Title?', choices: ['A', 'B'] },
            { qid: 'q1', question: 'Tags?', choices: ['x', 'y'] },
          ],
          answers: { q0: 'A' },
        },
      },
    });
    assert.equal(state.approval.request_id, 'a1');
    assert.equal(state.approval.command, 'rm -rf /tmp/x');
    assert.deepEqual(state.approval.choices, [
      'once',
      'session',
      'always',
      'deny',
    ]);
    assert.equal(state.clarify.batch, true);
    assert.equal(state.clarify.questions[0].answered, true);
    assert.equal(state.clarify.questions[0].answer, 'A');
    assert.equal(state.clarify.questions[1].answered, false);
  });

  it('rehydrates a single-question pending clarify', () => {
    let state = createInitialChatState();
    state = chatReducer(state, {
      type: 'prompt.pending',
      payload: {
        clarify: { request_id: 'r1', question: 'Proceed?', choices: ['yes'] },
      },
    });
    assert.equal(state.clarify.batch, false);
    assert.equal(state.clarify.question, 'Proceed?');
    assert.equal(state.approval, null);
  });

  it('clear.prompt clears rehydrated prompts', () => {
    let state = createInitialChatState();
    state = chatReducer(state, {
      type: 'prompt.pending',
      payload: { approval: { request_id: 'a1', command: 'ls' } },
    });
    state = chatReducer(state, { type: 'clear.prompt' });
    assert.equal(state.approval, null);
    assert.equal(state.clarify, null);
  });
});

describe('normalizePanelState', () => {
  it('clamps widths and validates tabs', () => {
    const state = normalizePanelState({
      sessionsWidth: 10,
      workspaceWidth: 9999,
      workspaceTab: 'nope',
      activityHeight: 12,
    });
    assert.equal(state.sessionsWidth, 200);
    assert.equal(state.workspaceWidth, 520);
    assert.equal(state.workspaceTab, 'files');
    assert.equal(state.activityHeight, 96);
  });

  it('defaults activity dock closed for new users', () => {
    const state = normalizePanelState({});
    assert.equal(state.activityOpen, false);
  });
});
