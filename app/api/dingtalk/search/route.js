import { NextResponse } from 'next/server';
import { query } from '@/lib/dingtalk/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * GET /api/dingtalk/search?q=
 * Global search across DingTalk message content and senders.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const q = (searchParams.get('q') || '').trim();
    if (!q) {
      return NextResponse.json(
        { error: 'Missing required query param `q`' },
        { status: 400, headers: NO_STORE },
      );
    }

    const result = await query(
      `SELECT m.open_message_id AS "openMessageId",
              c.open_conversation_id AS "openConversationId",
              c.title AS "conversationTitle",
              c.type AS "conversationType",
              m.sender_name AS "senderName",
              m.content,
              m.created_at AS "createdAt"
       FROM dingtalk_messages m
       JOIN dingtalk_conversations c ON c.id = m.conversation_id
       WHERE m.content ILIKE $1 OR m.sender_name ILIKE $1
       ORDER BY m.created_at DESC
       LIMIT 100`,
      [`%${q}%`],
    );

    return NextResponse.json(
      { results: result.rows },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.error('[dingtalk/search]', error);
    return NextResponse.json(
      { error: 'Failed to search messages' },
      { status: 500, headers: NO_STORE },
    );
  }
}
