/**
 * Pure presentation helpers for compact Hermes work traces.
 *
 * Groups messages + tools into transcript rows without mutating chat state.
 */

/**
 * @param {string | null | undefined} name
 */
export function humanizeToolName(name) {
  const raw = String(name || 'tool').trim();
  if (!raw) return 'Tool';
  const spaced = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_./-]+/g, ' ')
    .trim();
  return spaced.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/**
 * Extract a short primary argument for a tool step summary.
 * @param {object} tool
 */
export function primaryToolTarget(tool) {
  if (!tool) return '';
  const args =
    tool.args && typeof tool.args === 'object'
      ? tool.args
      : (() => {
          try {
            return tool.args_text ? JSON.parse(tool.args_text) : null;
          } catch {
            return null;
          }
        })();

  if (args && typeof args === 'object') {
    for (const key of [
      'path',
      'file',
      'filename',
      'query',
      'url',
      'command',
      'cmd',
      'pattern',
      'target',
      'name',
    ]) {
      if (args[key] != null && String(args[key]).trim()) {
        return String(args[key]).trim();
      }
    }
  }

  const text = String(tool.args_text || '').trim();
  if (!text) return '';
  const firstLine = text.split('\n')[0].trim();
  if (firstLine.length <= 80) return firstLine;
  return `${firstLine.slice(0, 77)}…`;
}

/**
 * @param {object} tool
 */
export function formatToolStepLabel(tool) {
  const name = humanizeToolName(tool?.name);
  const target = primaryToolTarget(tool);
  if (!target) return name;
  const short =
    target.length > 48 ? `${target.slice(0, 45)}…` : target;
  return `${name} · ${short}`;
}

/**
 * Prefer a meaningful one-line result over raw JSON.
 * @param {object} tool
 * @param {{ maxLen?: number }} [options]
 */
export function summarizeToolResult(tool, options = {}) {
  const maxLen = options.maxLen ?? 180;
  if (!tool) return '';
  if (tool.error) {
    return truncateOneLine(String(tool.error), maxLen);
  }
  const raw = String(tool.summary || tool.result || '').trim();
  if (!raw) return '';

  const routine = isRoutineTool(tool.name);
  if (routine && tool.status !== 'error') {
    // Suppress noisy read/search dumps in collapsed/one-line previews.
    const first = firstMeaningfulLine(raw);
    if (!first || looksLikeRawJson(first) || first.length > maxLen) {
      return '';
    }
    return truncateOneLine(first, maxLen);
  }

  if (looksLikeRawJson(raw)) {
    const first = firstMeaningfulLine(raw);
    return first ? truncateOneLine(first, maxLen) : '';
  }
  return truncateOneLine(firstMeaningfulLine(raw) || raw, maxLen);
}

function isRoutineTool(name) {
  const n = String(name || '').toLowerCase();
  return /^(read|read_file|cat|search|grep|find|list|ls|glob|web_search|web_fetch|browse)/.test(
    n,
  );
}

function looksLikeRawJson(text) {
  const t = String(text || '').trim();
  return (
    (t.startsWith('{') && t.endsWith('}')) ||
    (t.startsWith('[') && t.endsWith(']'))
  );
}

function firstMeaningfulLine(text) {
  return (
    String(text || '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !/^[{}[\],]$/.test(line)) || ''
  );
}

function truncateOneLine(text, maxLen) {
  const one = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (one.length <= maxLen) return one;
  return `${one.slice(0, Math.max(0, maxLen - 1))}…`;
}

/**
 * Build a semantic aggregate label for a work burst.
 * @param {{
 *   tools?: object[],
 *   reasoning?: string,
 *   running?: boolean,
 *   interrupted?: boolean,
 *   durationSec?: number | null,
 * }} burst
 */
export function formatWorkSummary(burst) {
  const tools = Array.isArray(burst.tools) ? burst.tools : [];
  const failed = tools.filter((tool) => tool.status === 'error').length;
  const running = Boolean(
    burst.running || tools.some((tool) => tool.status === 'running'),
  );
  const stepCount =
    tools.length + (burst.reasoning && String(burst.reasoning).trim() ? 1 : 0);

  if (burst.interrupted) {
    return stepCount
      ? `Interrupted · ${stepCount} step${stepCount === 1 ? '' : 's'}`
      : 'Interrupted';
  }

  if (running) {
    const current =
      [...tools].reverse().find((tool) => tool.status === 'running') ||
      tools[tools.length - 1];
    const currentLabel = current
      ? formatToolStepLabel(current)
      : burst.reasoning
        ? 'Thinking'
        : 'Working';
    const countLabel =
      stepCount > 1 ? ` · ${stepCount} steps` : '';
    return `${currentLabel}${countLabel}`;
  }

  if (failed > 0) {
    const base =
      stepCount > 0
        ? `Ran ${stepCount} step${stepCount === 1 ? '' : 's'} · ${failed} failed`
        : `${failed} failed`;
    return withDuration(base, burst.durationSec);
  }

  if (!stepCount) return '';

  const family = classifyToolFamily(tools);
  let base = '';
  if (family === 'read') {
    base = `Read ${tools.length} file${tools.length === 1 ? '' : 's'}`;
  } else if (family === 'search') {
    base = `Searched ${tools.length} time${tools.length === 1 ? '' : 's'}`;
  } else if (family === 'web') {
    base = `Explored ${tools.length} source${tools.length === 1 ? '' : 's'}`;
  } else if (family === 'write') {
    base = `Updated ${tools.length} file${tools.length === 1 ? '' : 's'}`;
  } else if (tools.length && !burst.reasoning) {
    base = `Ran ${tools.length} step${tools.length === 1 ? '' : 's'}`;
  } else if (!tools.length && burst.reasoning) {
    base = 'Thought';
  } else {
    base = `Worked · ${stepCount} step${stepCount === 1 ? '' : 's'}`;
  }
  return withDuration(base, burst.durationSec);
}

function withDuration(label, durationSec) {
  if (durationSec == null || !Number.isFinite(durationSec) || durationSec < 1) {
    return label;
  }
  return `${label} · ${Math.round(durationSec)}s`;
}

function classifyToolFamily(tools) {
  if (!tools.length) return 'other';
  const names = tools.map((tool) => String(tool.name || '').toLowerCase());
  const all = (re) => names.every((name) => re.test(name));
  if (all(/^(read|read_file|cat)/)) return 'read';
  if (all(/^(search|grep|find|glob|list|ls)/)) return 'search';
  if (all(/^(web_|browse|fetch)/)) return 'web';
  if (all(/^(write|edit|patch|create|update|delete|rm)/)) return 'write';
  return 'other';
}

/**
 * Estimate burst duration from tool durations when available.
 * @param {object[]} tools
 */
export function estimateBurstDurationSec(tools = []) {
  let total = 0;
  let any = false;
  for (const tool of tools) {
    if (tool?.duration_s != null && Number.isFinite(Number(tool.duration_s))) {
      total += Number(tool.duration_s);
      any = true;
    }
  }
  return any ? total : null;
}

/**
 * Build ordered transcript rows for rendering.
 *
 * Row types:
 * - { type: 'user', message }
 * - { type: 'work', turnId, reasoning, tools, running, interrupted, durationSec, summary }
 * - { type: 'assistant', message }
 * - { type: 'other', message }
 *
 * @param {object[]} messages
 * @param {object[]} tools
 */
export function groupTranscriptRows(messages = [], tools = []) {
  const visibleMessages = messages.filter((message) => message?.role !== 'tool');
  const historyTools = toolsFromHistoryMessages(messages);
  const mergedTools = mergeTools(historyTools, tools);

  /** @type {Map<string, object[]>} */
  const toolsByTurn = new Map();
  for (const tool of mergedTools) {
    const key = tool.turn_id || '__orphan__';
    if (!toolsByTurn.has(key)) toolsByTurn.set(key, []);
    toolsByTurn.get(key).push(tool);
  }

  const turnIds = [];
  const seenTurns = new Set();
  for (const message of visibleMessages) {
    const turnId = message.turn_id || `msg:${message.id}`;
    if (!seenTurns.has(turnId)) {
      seenTurns.add(turnId);
      turnIds.push(turnId);
    }
  }
  for (const key of toolsByTurn.keys()) {
    if (key !== '__orphan__' && !seenTurns.has(key)) {
      seenTurns.add(key);
      turnIds.push(key);
    }
  }
  if (toolsByTurn.has('__orphan__')) {
    turnIds.push('__orphan__');
  }

  /** @type {object[]} */
  const rows = [];

  for (const turnId of turnIds) {
    const turnMessages = visibleMessages.filter(
      (message) => (message.turn_id || `msg:${message.id}`) === turnId,
    );
    const turnTools = toolsByTurn.get(turnId) || [];

    for (const message of turnMessages) {
      if (message.role === 'user') {
        rows.push({ type: 'user', id: `user-${message.id}`, message });
      }
    }

    const assistantMessages = turnMessages.filter(
      (message) => message.role === 'assistant',
    );
    const reasoning = assistantMessages
      .map((message) => message.reasoning || '')
      .filter(Boolean)
      .join('\n\n');
    const running = assistantMessages.some((message) => message.streaming);
    const interrupted = assistantMessages.some((message) => message.interrupted);
    const hasWork =
      Boolean(String(reasoning).trim()) ||
      turnTools.length > 0 ||
      (running && assistantMessages.length > 0);

    if (hasWork) {
      const durationSec = estimateBurstDurationSec(turnTools);
      const burst = {
        type: 'work',
        id: `work-${turnId}`,
        turnId,
        reasoning,
        tools: turnTools,
        running:
          running || turnTools.some((tool) => tool.status === 'running'),
        interrupted,
        durationSec,
      };
      rows.push({
        ...burst,
        summary: formatWorkSummary(burst),
      });
    }

    for (const message of assistantMessages) {
      const content = String(message.content || '').trim();
      if (!content && !message.streaming) continue;
      // Skip empty streaming shell if work row already represents activity.
      if (!content && message.streaming && hasWork) continue;
      rows.push({
        type: 'assistant',
        id: `assistant-${message.id}`,
        message,
      });
    }

    for (const message of turnMessages) {
      if (
        message.role !== 'user' &&
        message.role !== 'assistant' &&
        message.role !== 'tool'
      ) {
        rows.push({ type: 'other', id: `other-${message.id}`, message });
      }
    }
  }

  return rows;
}

/**
 * @param {object[]} messages
 */
function toolsFromHistoryMessages(messages = []) {
  /** @type {object[]} */
  const tools = [];
  for (const message of messages) {
    if (message?.role !== 'tool') continue;
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
 * Prefer live gateway tools over history-derived duplicates.
 * @param {object[]} historyTools
 * @param {object[]} liveTools
 */
function mergeTools(historyTools = [], liveTools = []) {
  /** @type {Map<string, object>} */
  const byId = new Map();
  for (const tool of historyTools) {
    if (!tool?.tool_id) continue;
    byId.set(tool.tool_id, tool);
  }
  for (const tool of liveTools) {
    if (!tool?.tool_id) continue;
    const existing = byId.get(tool.tool_id);
    byId.set(tool.tool_id, existing ? { ...existing, ...tool } : tool);
  }
  return [...byId.values()];
}
