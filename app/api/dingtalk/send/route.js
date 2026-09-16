import { execFile } from 'node:child_process';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };
// Path to the dws CLI (https://github.com/DingTalk-Real-AI/dingtalk-workspace-tool).
// Required — no default, so a missing install fails fast with a clear error.
const DWS_PATH = process.env.DWS_PATH || 'dws';
const MAX_TEXT_LENGTH = 4000;

function dwsSend(args) {
  return new Promise((resolve, reject) => {
    execFile(
      DWS_PATH,
      args,
      { timeout: 30000, env: { ...process.env, HOME: process.env.HOME || '/root' } },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

/**
 * POST /api/dingtalk/send
 * Body: { openConversationId, text } — sends as the authenticated user via dws.
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const openConversationId = String(body?.openConversationId || '').trim();
    const text = String(body?.text || '').trim();

    if (!openConversationId || !text) {
      return NextResponse.json(
        { error: 'openConversationId and text are required' },
        { status: 400, headers: NO_STORE },
      );
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return NextResponse.json(
        { error: `Message too long (max ${MAX_TEXT_LENGTH} chars)` },
        { status: 400, headers: NO_STORE },
      );
    }

    const stdout = await dwsSend([
      'chat',
      'message',
      'send',
      '--conversation-id',
      openConversationId,
      '--content',
      text,
      '--yes',
    ]);

    let parsed = null;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = { raw: stdout };
    }

    return NextResponse.json(
      { ok: true, result: parsed },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.error('[dingtalk/send]', error);
    return NextResponse.json(
      { error: error.message || 'Failed to send message' },
      { status: 500, headers: NO_STORE },
    );
  }
}
