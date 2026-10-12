/**
 * lib/terminal/audit.js — structured audit logging for the web terminal.
 * Metadata only (never keystrokes or output content); one JSON line per event.
 */

function emit(level, event, fields = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    component: 'terminal',
    ...fields,
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const terminalAudit = {
  info: (event, fields) => emit('info', event, fields),
  warn: (event, fields) => emit('warn', event, fields),
  error: (event, fields) => emit('error', event, fields),
};
