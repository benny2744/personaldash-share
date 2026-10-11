import { NextResponse } from 'next/server';
import { getSettings } from '@/lib/settings/resolve';

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
  const settings = await getSettings([
    'identity.openId',
    'identity.userId',
    'identity.name',
  ]);
  return NextResponse.json(
    {
      openDingTalkId: settings['identity.openId'] || null,
      userId: settings['identity.userId'] || null,
      name: settings['identity.name'] || null,
    },
    { headers: NO_STORE },
  );
}
