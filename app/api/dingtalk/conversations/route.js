import { NextResponse } from 'next/server';
import { query } from '@/lib/dingtalk/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * GET /api/dingtalk/conversations?q=&limit=
 * Lists DingTalk conversations ordered by most recent message.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const q = (searchParams.get('q') || '').trim();
    const limit = Math.min(Number(searchParams.get('limit')) || 50, 200);

    const params = [];
    let where = '';
    if (q) {
      params.push(`%${q}%`);
      where = `
        WHERE c.title ILIKE $1
           OR EXISTS (
             SELECT 1 FROM dingtalk_messages m
             WHERE m.conversation_id = c.id
               AND (m.content ILIKE $1 OR m.sender_name ILIKE $1)
           )`;
    }
    params.push(limit);

    const result = await query(
      `SELECT c.open_conversation_id AS "openConversationId",
              c.title,
              c.type,
              c.member_count AS "memberCount",
              c.last_message_at AS "lastMessageAt",
              (
                SELECT m.content FROM dingtalk_messages m
                WHERE m.conversation_id = c.id
                ORDER BY m.created_at DESC LIMIT 1
              ) AS "lastMessagePreview",
              (
                SELECT m.sender_name FROM dingtalk_messages m
                WHERE m.conversation_id = c.id
                ORDER BY m.created_at DESC LIMIT 1
              ) AS "lastMessageSender"
       FROM dingtalk_conversations c
       ${where}
       ORDER BY c.last_message_at DESC NULLS LAST
       LIMIT $${params.length}`,
      params,
    );

    return NextResponse.json(
      { conversations: result.rows },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.error('[dingtalk/conversations]', error);
    return NextResponse.json(
      { error: 'Failed to load conversations' },
      { status: 500, headers: NO_STORE },
    );
  }
}
