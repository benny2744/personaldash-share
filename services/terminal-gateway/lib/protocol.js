/**
 * services/terminal-gateway/lib/protocol.js — WS frame validation.
 * JSON text frames; `data` payloads are base64 (binary-safe).
 */

export const MAX_FRAME_BYTES = 96 * 1024;
export const MAX_INPUT_BYTES = 64 * 1024;
export const RESIZE_MIN = 2;
export const RESIZE_MAX = 500;

/**
 * Validate + normalize one client frame.
 * @returns {{ ok: true, frame: {type:string, data?:Buffer, cols?:number, rows?:number} }
 *           | { ok: false, reason: string, fatal: boolean }}
 */
export function parseClientFrame(raw, limits = {}) {
  const maxFrame = limits.maxFrameBytes || MAX_FRAME_BYTES;
  const maxInput = limits.maxInputBytes || MAX_INPUT_BYTES;
  if (typeof raw !== 'string' || raw.length > maxFrame) {
    return { ok: false, reason: 'frame too large or not text', fatal: true };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'frame is not JSON', fatal: true };
  }
  const type = parsed?.type;
  if (type === 'input') {
    if (typeof parsed.data !== 'string') {
      return { ok: false, reason: 'input.data must be base64 text', fatal: false };
    }
    let data;
    try {
      data = Buffer.from(parsed.data, 'base64');
    } catch {
      return { ok: false, reason: 'input.data is not valid base64', fatal: false };
    }
    if (data.length === 0) {
      return { ok: false, reason: 'input.data is empty', fatal: false };
    }
    if (data.length > maxInput) {
      return { ok: false, reason: 'input.data exceeds cap', fatal: true };
    }
    return { ok: true, frame: { type: 'input', data } };
  }
  if (type === 'resize') {
    const cols = Number(parsed.cols);
    const rows = Number(parsed.rows);
    if (
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < RESIZE_MIN ||
      cols > RESIZE_MAX ||
      rows < RESIZE_MIN ||
      rows > RESIZE_MAX
    ) {
      return { ok: false, reason: 'resize out of bounds', fatal: false };
    }
    return { ok: true, frame: { type: 'resize', cols, rows } };
  }
  if (type === 'ping') {
    return { ok: true, frame: { type: 'ping' } };
  }
  // Unknown types are ignored (non-fatal) so the client can evolve first.
  return { ok: false, reason: `ignored frame type ${String(type)}`, fatal: false };
}

/** Encode a server frame as JSON text. */
export function encodeServerFrame(frame) {
  if (frame.type === 'output') {
    return JSON.stringify({
      type: 'output',
      data: Buffer.from(frame.data).toString('base64'),
    });
  }
  return JSON.stringify(frame);
}
