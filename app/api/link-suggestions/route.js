import { NextResponse } from 'next/server';
import prisma from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/link-suggestions?status=pending
 * Returns pending/fuzzy entity suggestions for the Link Review inbox.
 */
export async function GET(request) {
  const status = request.nextUrl.searchParams.get('status') || 'pending';
  const allowed = ['pending', 'accepted', 'dismissed'];
  const where = allowed.includes(status) ? { status } : { status: 'pending' };

  const suggestions = await prisma.entitySuggestion.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }],
    include: {
      note: { select: { filepath: true } },
    },
    take: 500,
  });

  // Join meeting titles (the note may be soft-deleted; keep filepath fallback).
  const filepaths = [...new Set(suggestions.map((s) => s.filepath))];
  const meetings = await prisma.meeting.findMany({
    where: { note: { filepath: { in: filepaths } } },
    select: { title: true, meetingDate: true, meetingType: true, note: { select: { filepath: true } } },
  });
  const meetingByPath = new Map(meetings.map((m) => [m.note.filepath, m]));

  const rows = suggestions.map((suggestion) => {
    const meeting = meetingByPath.get(suggestion.filepath);
    return {
      id: suggestion.id,
      mention: suggestion.mention,
      suggestedType: suggestion.suggestedType,
      evidence: suggestion.evidence,
      suggestedExistingNote: suggestion.suggestedExistingNote,
      status: suggestion.status,
      filepath: suggestion.filepath,
      meetingTitle: meeting?.title || suggestion.filepath.split('/').pop(),
      meetingDate: meeting?.meetingDate || null,
      meetingType: meeting?.meetingType || null,
      createdAt: suggestion.createdAt,
    };
  });

  return NextResponse.json({ suggestions: rows });
}
