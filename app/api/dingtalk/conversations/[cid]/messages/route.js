import { NextResponse } from 'next/server';
import { query } from '@/lib/dingtalk/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * GET /api/dingtalk/conversations/[cid]/messages?before=&limit=&after=
 * Messages for a conversation (cid = openConversationId), oldest→newest.
 * `before`/`after` accept ISO timestamps for cursor pagination / polling.
 */
export async function GET(request, context) {
  try {
    const { cid } = await context.params;
    const openConversationId = decodeURIComponent(cid);
    const { searchParams } = new URL(request.url);
    const before = searchParams.get('before');
    const after = searchParams.get('after');
    const latest = searchParams.get('latest') === '1';
    const limit = Math.min(Number(searchParams.get('limit')) || 100, 500);

    const queryParams = [openConversationId];
    let cursor = '';
    if (before) {
      queryParams.push(before);
      cursor += ` AND m.created_at < $${queryParams.length}`;
    }
    if (after) {
      queryParams.push(after);
      cursor += ` AND m.created_at > $${queryParams.length}`;
    }
    queryParams.push(limit);

    const result = latest
      ? await query(
          `SELECT * FROM (
             SELECT m.open_message_id AS "openMessageId",
                    m.sender_id AS "senderId",
                    m.sender_name AS "senderName",
                    m.sender_open_dingtalk_id AS "senderOpenDingTalkId",
                    m.content,
                    m.message_type AS "messageType",
                    m.created_at AS "createdAt",
                    m.recalled
             FROM dingtalk_messages m
             JOIN dingtalk_conversations c ON c.id = m.conversation_id
             WHERE c.open_conversation_id = $1
             ORDER BY m.created_at DESC
             LIMIT $${queryParams.length}
           ) sub
           ORDER BY sub."createdAt" ASC`,
          queryParams,
        )
      : await query(
          `SELECT m.open_message_id AS "openMessageId",
                  m.sender_id AS "senderId",
                  m.sender_name AS "senderName",
                  m.sender_open_dingtalk_id AS "senderOpenDingTalkId",
                  m.content,
                  m.message_type AS "messageType",
                  m.created_at AS "createdAt",
                  m.recalled
           FROM dingtalk_messages m
           JOIN dingtalk_conversations c ON c.id = m.conversation_id
           WHERE c.open_conversation_id = $1
           ${cursor}
           ORDER BY m.created_at ASC
           LIMIT $${queryParams.length}`,
          queryParams,
        );

    return NextResponse.json({ messages: result.rows }, { headers: NO_STORE });
  } catch (error) {
    console.error('[dingtalk/messages]', error);
    return NextResponse.json(
      { error: 'Failed to load messages' },
      { status: 500, headers: NO_STORE },
    );
  }
}
