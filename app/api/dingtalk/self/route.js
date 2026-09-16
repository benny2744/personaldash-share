import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * GET /api/dingtalk/self
 * Identity of the DingTalk account being synced — used by the client to
 * right-align the user's own messages. Configured via env since dws has no
 * command returning the account's openDingTalkId.
 */
export async function GET() {
  return NextResponse.json(
    {
      openDingTalkId: process.env.DINGTALK_SELF_OPEN_ID || null,
      userId: process.env.DINGTALK_SELF_USER_ID || null,
      name: process.env.DINGTALK_SELF_NAME || null,
    },
    { headers: NO_STORE },
  );
}
