/**
 * Pure reducer for Hermes structured chat events.
 *
 * Keeps live gateway session IDs separate from durable stored session IDs and
 * reconciles tool cards by stable tool_id.
 */

/** @typedef {'idle'|'connecting'|'open'|'closed'|'error'} ConnectionState */

/**
 * @returns {import('./chatTypes.js').ChatState}
 */
export function createInitialChatState() {
  return {
    connectionState: 'idle',
    liveSessionId: null,
    storedSessionId: null,
    title: '',
    model: '',
    running: false,
    interrupted: false,
    activeTurnId: null,
    messages: [],
    tools: [],
    activity: [],
    todos: [],
    artifacts: [],
    statusText: '',
    error: null,
    pendingPrompt: null,
    approval: null,
    clarify: null,
    sudo: null,
    secret: null,
    // Live gateway usage snapshot (session.usage ticks / message.complete).
    usage: null,
    // Live usage captured at resume; deltas above it count post-resume
    // activity on top of the cold REST row without double-counting history.
    usageBaseline: null,
    // Cold REST row (/api/sessions/:id) — fills cost/totals for resumed or
    // ended sessions where no live agent ticker exists.
    coldStats: null,
  };
}

function createTurnId() {
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function appendActivity(state, entry) {
  const next = [
    ...state.activity,
    {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      ...entry,
    },
  ];
  // Keep the dock bounded.
  return next.slice(-80);
}

function upsertTool(tools, tool) {
  const index = tools.findIndex((item) => item.tool_id === tool.tool_id);
  if (index === -1) return [...tools, tool];
  const copy = tools.slice();
  copy[index] = { ...copy[index], ...tool };
  return copy;
}

function findStreamingAssistant(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === 'assistant' && message.streaming) return i;
  }
  return -1;
}

function ensureStreamingAssistant(messages, turnId = null) {
  const index = findStreamingAssistant(messages);
  if (index !== -1) {
    if (turnId && !messages[index].turn_id) {
      const copy = messages.slice();
      copy[index] = { ...copy[index], turn_id: turnId };
      return { messages: copy, index };
    }
    return { messages, index };
  }
  const next = [
    ...messages,
    {
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      content: '',
      reasoning: '',
      streaming: true,
      interrupted: false,
      provisional: true,
      turn_id: turnId,
      timestamp: new Date().toISOString(),
    },
  ];
  return { messages: next, index: next.length - 1 };
}

function extractArtifactsFromTool(tool) {
  const artifacts = [];
  const candidates = [
    tool.result,
    tool.summary,
    tool.args_text,
    typeof tool.args === 'string' ? tool.args : JSON.stringify(tool.args || ''),
  ]
    .filter(Boolean)
    .join('\n');

  // Prefer explicit path-like references from write/edit style tools.
  const pathMatches = candidates.match(
    /(?:^|[\s"'`(=])((?:\/|[A-Za-z]:\\|\.\/)[^\s"'`)]+\.[A-Za-z0-9]{1,12})/g,
  );
  if (pathMatches) {
    for (const raw of pathMatches) {
      const path = raw.replace(/^[("'=\s]+/, '').replace(/[)"'`]+$/, '');
      if (path) {
        artifacts.push({
          path,
          tool_id: tool.tool_id,
          name: tool.name,
          at: new Date().toISOString(),
        });
      }
    }
  }

  if (
    tool.inline_diff &&
    typeof tool.inline_diff === 'object' &&
    tool.inline_diff.path
  ) {
    artifacts.push({
      path: String(tool.inline_diff.path),
      tool_id: tool.tool_id,
      name: tool.name,
      at: new Date().toISOString(),
      kind: 'diff',
    });
  }

  return artifacts;
}

function mergeArtifacts(existing, incoming) {
  const seen = new Set(existing.map((item) => item.path));
  const next = existing.slice();
  for (const item of incoming) {
    if (!item.path || seen.has(item.path)) continue;
    seen.add(item.path);
    next.push(item);
  }
  return next.slice(-50);
}

/**
 * Coerce REST (`content`) or gateway display (`text` / tool `context`) payloads.
 * @param {unknown} value
 */
function coerceHistoryText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.text) return part.text;
        if (part?.type === 'image_url') return '[image]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (value != null && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
  }
  if (value != null) return String(value);
  return '';
}

/**
 * Prefer the first non-empty reasoning variant from REST or gateway rows.
 * @param {object} message
 */
function extractHistoryReasoning(message) {
  for (const key of [
    'reasoning',
    'reasoning_content',
    'reasoning_details',
    'codex_reasoning_items',
  ]) {
    const value = message?.[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (Array.isArray(value) && value.length) {
      return value
        .map((part) => {
          if (typeof part === 'string') return part;
          if (part?.text) return part.text;
          try {
            return JSON.stringify(part);
          } catch {
            return '';
          }
        })
        .filter(Boolean)
        .join('\n');
    }
    if (value && typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch {
        // keep looking
      }
    }
  }
  return '';
}

/**
 * Normalize a single history message body/content.
 * Accepts REST `{content}` and gateway `{text}` / tool `{name,context}` shapes.
 * @param {object} message
 * @param {number} index
 */
function normalizeHistoryMessage(message, index) {
  const role = message.role || 'assistant';
  // Gateway session.resume projects display rows as `{ role, text }`.
  // REST /api/sessions/:id/messages uses `{ role, content }`.
  let content = coerceHistoryText(message.content);
  if (!content) content = coerceHistoryText(message.text);
  // Gateway tool rows expose args as `context` and often omit result text.
  if (!content && role === 'tool') {
    content = coerceHistoryText(message.context);
  }

  return {
    id: message.id || message.tool_call_id || `hist-${index}`,
    role,
    content,
    reasoning: extractHistoryReasoning(message),
    tool_name: message.tool_name || message.name,
    tool_call_id: message.tool_call_id,
    tool_calls: message.tool_calls,
    streaming: false,
    interrupted: false,
    provisional: false,
    timestamp: message.timestamp || message.created_at || null,
  };
}

/**
 * Normalize REST / RPC history messages into transcript rows with turn_ids.
 * @param {Array<object>} rawMessages
 */
export function normalizeHistoryMessages(rawMessages = []) {
  let turnId = null;
  return rawMessages.map((message, index) => {
    const normalized = normalizeHistoryMessage(message, index);
    if (normalized.role === 'user') {
      turnId = createTurnId();
    } else if (!turnId) {
      turnId = createTurnId();
    }
    return { ...normalized, turn_id: turnId };
  });
}

/**
 * Build history-derived tool cards from role:tool rows.
 * @param {Array<object>} normalizedMessages
 */
export function toolsFromNormalizedHistory(normalizedMessages = []) {
  /** @type {object[]} */
  const tools = [];
  for (const message of normalizedMessages) {
    if (message.role !== 'tool') continue;
    const toolId = message.tool_call_id || message.id;
    if (!toolId) continue;
    tools.push({
      tool_id: toolId,
      name: message.tool_name || 'tool',
      status: 'complete',
      result: message.content,
      turn_id: message.turn_id || null,
      from_history: true,
    });
  }
  return tools;
}

/**
 * Normalize a `clarify.request` payload (live event or resume replay) into UI
 * state. Single-question payloads keep the historical top-level shape;
 * batch payloads (`questions: [{qid, question, choices, multi_select}]`) get
 * a normalized `questions` array with per-question answer tracking.
 * @param {object} payload
 */
export function normalizeClarifyPrompt(payload = {}) {
  if (Array.isArray(payload.questions) && payload.questions.length > 0) {
    return {
      kind: 'clarify',
      batch: true,
      request_id: payload.request_id,
      questions: payload.questions.map((question, index) => ({
        qid: String(question?.qid ?? `q${index}`),
        question:
          typeof question?.question === 'string' ? question.question : '',
        choices: Array.isArray(question?.choices)
          ? question.choices.map((choice) => String(choice))
          : [],
        multi_select: Boolean(question?.multi_select),
        answered: false,
        answer: '',
      })),
    };
  }
  return {
    kind: 'clarify',
    batch: false,
    request_id: payload.request_id,
    question: typeof payload.question === 'string' ? payload.question : '',
    choices: Array.isArray(payload.choices)
      ? payload.choices.map((choice) => String(choice))
      : [],
    multi_select: Boolean(payload.multi_select),
  };
}

/**
 * @param {ReturnType<typeof createInitialChatState>} state
 * @param {{ type: string, payload?: any }} action
 */
export function chatReducer(state, action) {
  switch (action.type) {
    case 'connection': {
      return {
        ...state,
        connectionState: action.payload,
        error:
          action.payload === 'error'
            ? state.error || 'Connection error'
            : action.payload === 'open'
              ? null
              : state.error,
        activity:
          action.payload === 'closed' || action.payload === 'error'
            ? appendActivity(state, {
                kind: 'connection',
                text:
                  action.payload === 'error'
                    ? 'Gateway connection failed'
                    : 'Gateway disconnected — reconnecting…',
                level: action.payload === 'error' ? 'error' : 'warning',
              })
            : action.payload === 'open'
              ? appendActivity(state, {
                  kind: 'connection',
                  text: 'Gateway connected',
                  level: 'info',
                })
              : state.activity,
      };
    }

    case 'session.bound': {
      const sessionChanged =
        action.payload.liveSessionId &&
        action.payload.liveSessionId !== state.liveSessionId;
      return {
        ...state,
        liveSessionId: action.payload.liveSessionId || null,
        storedSessionId:
          action.payload.storedSessionId ||
          action.payload.liveSessionId ||
          null,
        title: action.payload.title || state.title,
        model: action.payload.model || state.model,
        interrupted: false,
        error: null,
        // Fresh live session: stale usage from the previous session is gone.
        ...(sessionChanged
          ? { usage: null, usageBaseline: null, coldStats: null }
          : {}),
      };
    }

    case 'history.loaded': {
      let messages = normalizeHistoryMessages(action.payload.messages || []);
      if (action.payload.provisional) {
        messages = messages.map((message) => ({
          ...message,
          provisional: true,
        }));
      }
      return {
        ...state,
        messages,
        tools: toolsFromNormalizedHistory(messages),
        activeTurnId: null,
        running: false,
        interrupted: false,
        pendingPrompt: null,
        approval: null,
        clarify: null,
        sudo: null,
        secret: null,
        title: action.payload.title || state.title,
        storedSessionId:
          action.payload.storedSessionId || state.storedSessionId,
      };
    }

    case 'user.message': {
      const turnId = createTurnId();
      return {
        ...state,
        running: true,
        interrupted: false,
        error: null,
        activeTurnId: turnId,
        messages: [
          ...state.messages,
          {
            id: `user-${Date.now()}`,
            role: 'user',
            content: action.payload.text,
            streaming: false,
            interrupted: false,
            provisional: true,
            turn_id: turnId,
            timestamp: new Date().toISOString(),
            attachments: action.payload.attachments || [],
          },
        ],
        activity: appendActivity(state, {
          kind: 'prompt',
          text: 'Prompt submitted',
          level: 'info',
        }),
      };
    }

    case 'event': {
      return reduceGatewayEvent(state, action.payload);
    }

    case 'mark.interrupted': {
      const messages = state.messages.map((message) =>
        message.streaming
          ? { ...message, streaming: false, interrupted: true }
          : message,
      );
      return {
        ...state,
        running: false,
        interrupted: true,
        messages,
        activity: appendActivity(state, {
          kind: 'status',
          text: 'Turn interrupted by disconnect — history rehydrated without event replay',
          level: 'warning',
        }),
      };
    }

    case 'clear.prompt': {
      return {
        ...state,
        approval: null,
        clarify: null,
        sudo: null,
        secret: null,
        pendingPrompt: null,
      };
    }

    case 'clarify.answer': {
      const questionId = String(action.payload?.questionId ?? '');
      if (!state.clarify?.batch || !questionId) return state;
      return {
        ...state,
        clarify: {
          ...state.clarify,
          questions: state.clarify.questions.map((question) =>
            question.qid === questionId
              ? {
                  ...question,
                  answered: true,
                  answer: String(action.payload?.answer ?? ''),
                }
              : question,
          ),
        },
      };
    }

    case 'prompt.pending': {
      // Rehydrate prompts a detached client missed: `session.resume` replays
      // `pending_approval` / `pending_clarify` so the agent is never left
      // parked with no visible card.
      const { approval, clarify } = action.payload || {};
      const nextApproval = approval
        ? {
            choices: ['once', 'session', 'always', 'deny'],
            ...approval,
            kind: 'approval',
          }
        : null;
      let nextClarify = null;
      if (clarify) {
        nextClarify = normalizeClarifyPrompt(clarify);
        // Batch replay includes answers locked before the disconnect.
        if (
          nextClarify.batch &&
          clarify.answers &&
          typeof clarify.answers === 'object'
        ) {
          nextClarify = {
            ...nextClarify,
            questions: nextClarify.questions.map((question) => {
              const answer = clarify.answers[question.qid];
              return answer != null
                ? { ...question, answered: true, answer: String(answer) }
                : question;
            }),
          };
        }
      }
      return {
        ...state,
        approval: nextApproval || state.approval,
        clarify: nextClarify || state.clarify,
      };
    }

    case 'usage.set': {
      return { ...state, ...foldUsage(state, action.payload || null) };
    }

    case 'usage.baseline':
      return { ...state, usageBaseline: action.payload || null };

    case 'stats.cold':
      return { ...state, coldStats: action.payload || null };

    case 'reset.session': {
      return {
        ...createInitialChatState(),
        connectionState: state.connectionState,
      };
    }

    default:
      return state;
  }
}

/**
 * Fold a new usage snapshot into state. If the snapshot's total dropped below
 * the resume baseline, the agent re-attached with fresh counters — rebase so
 * deltas count the new epoch instead of clamping to zero forever.
 */
function foldUsage(state, usage) {
  if (!usage) {
    return { usage: state.usage, usageBaseline: state.usageBaseline };
  }
  const baseline = state.usageBaseline;
  const rebased =
    baseline && (Number(usage.total) || 0) < (Number(baseline.total) || 0);
  return {
    usage,
    usageBaseline: rebased ? usage : baseline,
  };
}

function reduceGatewayEvent(state, event) {
  if (!event?.type) return state;

  // Ignore stale events from a previous live session after switch/reconnect.
  if (
    event.session_id &&
    state.liveSessionId &&
    event.session_id !== state.liveSessionId
  ) {
    return state;
  }

  const payload = event.payload || {};

  switch (event.type) {
    case 'gateway.ready':
      return state;

    case 'session.info': {
      return {
        ...state,
        title: payload.title || state.title,
        model: payload.model || state.model,
        running: Boolean(payload.running ?? state.running),
        todos: Array.isArray(payload.todos) ? payload.todos : state.todos,
        ...foldUsage(state, payload.usage || null),
      };
    }

    case 'session.usage': {
      // ~1/s live ticker while a turn runs (gateway _start_usage_ticker).
      return { ...state, ...foldUsage(state, payload.usage || null) };
    }

    case 'message.start': {
      const turnId = state.activeTurnId || createTurnId();
      const { messages } = ensureStreamingAssistant(state.messages, turnId);
      return {
        ...state,
        messages,
        activeTurnId: turnId,
        running: true,
        interrupted: false,
      };
    }

    case 'message.delta':
    case 'message.interim': {
      const turnId = state.activeTurnId || createTurnId();
      const ensured = ensureStreamingAssistant(state.messages, turnId);
      const messages = ensured.messages.slice();
      const current = messages[ensured.index];
      const nextText =
        event.type === 'message.interim' && payload.already_streamed
          ? payload.text || current.content
          : `${current.content || ''}${payload.text || ''}`;
      messages[ensured.index] = {
        ...current,
        content: nextText,
        streaming: true,
        turn_id: current.turn_id || turnId,
      };
      return {
        ...state,
        messages,
        activeTurnId: state.activeTurnId || turnId,
        running: true,
      };
    }

    case 'message.complete': {
      const turnId = state.activeTurnId || createTurnId();
      const ensured = ensureStreamingAssistant(state.messages, turnId);
      const messages = ensured.messages.slice();
      const current = messages[ensured.index];
      messages[ensured.index] = {
        ...current,
        content: payload.text ?? current.content,
        streaming: false,
        interrupted: payload.status === 'interrupted',
        turn_id: current.turn_id || turnId,
      };
      return {
        ...state,
        messages,
        running: false,
        interrupted: payload.status === 'interrupted',
        statusText: '',
        // Final per-turn authoritative snapshot (outlives the ticker).
        ...foldUsage(state, payload.usage || null),
      };
    }

    case 'thinking.delta':
    case 'reasoning.delta': {
      const turnId = state.activeTurnId || createTurnId();
      const ensured = ensureStreamingAssistant(state.messages, turnId);
      const messages = ensured.messages.slice();
      const current = messages[ensured.index];
      messages[ensured.index] = {
        ...current,
        reasoning: `${current.reasoning || ''}${payload.text || ''}`,
        streaming: true,
        turn_id: current.turn_id || turnId,
      };
      return {
        ...state,
        messages,
        activeTurnId: state.activeTurnId || turnId,
        running: true,
      };
    }

    case 'status.update': {
      const text = payload.text || payload.kind || 'Working…';
      // Keep statusText for the composer; avoid spamming the diagnostics dock.
      return {
        ...state,
        statusText: text,
      };
    }

    case 'tool.start':
    case 'tool.progress':
    case 'tool.generating':
    case 'tool.complete': {
      const toolId =
        payload.tool_id ||
        payload.toolCallId ||
        `${payload.name || 'tool'}-${Date.now()}`;
      const turnId =
        state.activeTurnId ||
        [...state.messages]
          .reverse()
          .find((message) => message.role === 'user' && message.turn_id)
          ?.turn_id ||
        createTurnId();
      const tool = {
        tool_id: toolId,
        name: payload.name || 'tool',
        status:
          event.type === 'tool.complete'
            ? payload.error
              ? 'error'
              : 'complete'
            : 'running',
        args: payload.args,
        args_text: payload.args_text || payload.context,
        result: payload.result_text || payload.result || payload.summary,
        summary: payload.summary,
        duration_s: payload.duration_s,
        error: payload.error,
        inline_diff: payload.inline_diff,
        turn_id: turnId,
      };
      const tools = upsertTool(state.tools, tool);
      const todos = Array.isArray(payload.todos) ? payload.todos : state.todos;
      const artifacts =
        event.type === 'tool.complete'
          ? mergeArtifacts(state.artifacts, extractArtifactsFromTool(tool))
          : state.artifacts;
      // Tool lifecycle belongs in the inline work trace, not the diagnostics dock.
      return {
        ...state,
        tools,
        todos,
        artifacts,
        activeTurnId: state.activeTurnId || turnId,
        running: event.type === 'tool.complete' ? state.running : true,
      };
    }

    case 'approval.request': {
      return {
        ...state,
        approval: {
          command: payload.command,
          choices: payload.choices || ['once', 'session', 'always', 'deny'],
          ...payload,
        },
        activity: appendActivity(state, {
          kind: 'approval',
          text: 'Approval required',
          level: 'warning',
        }),
      };
    }

    case 'clarify.request': {
      return {
        ...state,
        clarify: normalizeClarifyPrompt(payload),
        activity: appendActivity(state, {
          kind: 'clarify',
          text: 'Clarification requested',
          level: 'warning',
        }),
      };
    }

    case 'sudo.request': {
      return {
        ...state,
        sudo: {
          request_id: payload.request_id,
          prompt: payload.prompt || 'Password required',
          ...payload,
        },
      };
    }

    case 'secret.request': {
      return {
        ...state,
        secret: {
          request_id: payload.request_id,
          prompt: payload.prompt || 'Secret required',
          ...payload,
        },
      };
    }

    case 'clarify.expire':
    case 'approval.expire':
      return {
        ...state,
        approval: event.type.startsWith('approval') ? null : state.approval,
        clarify: event.type.startsWith('clarify') ? null : state.clarify,
      };

    case 'sudo.expire':
      return { ...state, sudo: null };

    case 'secret.expire':
      return { ...state, secret: null };

    case 'background.complete': {
      return {
        ...state,
        activity: appendActivity(state, {
          kind: 'background',
          text: payload.text || payload.summary || 'Background task complete',
          level: payload.error ? 'error' : 'info',
        }),
      };
    }

    case 'error': {
      return {
        ...state,
        running: false,
        error: payload.message || 'Hermes error',
        activity: appendActivity(state, {
          kind: 'error',
          text: payload.message || 'Hermes error',
          level: 'error',
        }),
      };
    }

    default:
      return state;
  }
}
