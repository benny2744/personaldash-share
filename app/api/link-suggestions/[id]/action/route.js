import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import {
  createEntityStub,
  linkEntityToMeeting,
  addAliasToNote,
  entityFilepathFor,
} from '@/lib/meetingPipeline/linker';
import { appendMeetingLogBullet } from '@/lib/meetingPipeline/entityUpdates';
import { readNote, writeNote } from '@/lib/vault';
import { triggerGbrainSync } from '@/lib/gbrainSync';
import { errorResponse, parseJsonBody } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ENTITY_TYPES = ['person', 'project', 'area'];

/**
 * Resolve the canonical entity type for a suggestion. 'fuzzy' suggestions carry
 * a near-match; their type comes from the request body (defaulting to person).
 */
function resolveType(suggestion, body) {
  if (ENTITY_TYPES.includes(suggestion.suggestedType))
    return suggestion.suggestedType;
  if (body.type && ENTITY_TYPES.includes(body.type)) return body.type;
  return 'person';
}

const PROFILE_UPDATE_PREFIX = 'profile_update:';

function isProfileUpdate(suggestion) {
  return String(suggestion.suggestedType || '').startsWith(
    PROFILE_UPDATE_PREFIX,
  );
}

/**
 * POST /api/link-suggestions/[id]/action
 * Body: { action: 'create'|'map'|'dismiss'|'apply', targetNote?, type? }
 *  - create: stub a new entity note, link it into the meeting, resolve.
 *  - map:    link an existing note into the meeting + record the raw mention as
 *            an alias on the target note (compounding auto-resolve).
 *  - dismiss: mark resolved without changes.
 *  - apply:  (profile_update suggestions only) append the reviewed fact bullet
 *            to the target entity note's Meeting Log.
 */
export async function POST(request, { params }) {
  const { id } = await params;
  const { body, response } = await parseJsonBody(request);
  if (response) return response;

  const { action, targetNote, type: bodyType } = body || {};
  if (!['create', 'map', 'dismiss', 'apply'].includes(action)) {
    return errorResponse('action must be create, map, dismiss, or apply', 400);
  }

  const suggestion = await prisma.entitySuggestion.findUnique({
    where: { id },
  });
  if (!suggestion) return errorResponse('Suggestion not found', 404);
  if (suggestion.status !== 'pending') {
    return errorResponse('Suggestion already resolved', 409);
  }
  if (
    !suggestion.noteId &&
    !isProfileUpdate(suggestion) &&
    action !== 'dismiss'
  ) {
    return errorResponse('Backing meeting note is missing; cannot apply', 410);
  }

  const type = resolveType(suggestion, { type: bodyType });

  try {
    if (action === 'dismiss') {
      const updated = await prisma.entitySuggestion.update({
        where: { id },
        data: { status: 'dismissed', resolvedAt: new Date() },
      });
      return NextResponse.json({ suggestion: updated });
    }

    if (action === 'apply') {
      if (!isProfileUpdate(suggestion)) {
        return errorResponse(
          'apply is only valid for profile_update suggestions',
          400,
        );
      }
      const kind = suggestion.suggestedType.slice(PROFILE_UPDATE_PREFIX.length);
      const target = String(
        targetNote || suggestion.suggestedExistingNote || '',
      ).trim();
      const targetPath = entityFilepathFor({ name: target, type: kind });
      if (!target || !targetPath) {
        return errorResponse('Cannot resolve target entity note', 400);
      }
      const bullet = `- ${suggestion.evidence}`;
      const current = await readNote(targetPath);
      const { markdown, added } = appendMeetingLogBullet(current, bullet);
      if (added) {
        await writeNote(targetPath, markdown);
        triggerGbrainSync('entity-update');
      }
      const updated = await prisma.entitySuggestion.update({
        where: { id },
        data: { status: 'accepted', resolvedAt: new Date() },
      });
      return NextResponse.json({
        suggestion: updated,
        appliedTo: targetPath,
        added,
      });
    }

    if (action === 'create') {
      const { filepath, name } = await createEntityStub({
        name: suggestion.mention,
        type,
      });
      const linkResult = await linkEntityToMeeting({
        meetingNoteId: suggestion.noteId,
        name,
        type,
      });
      if (linkResult?.success === false) {
        return NextResponse.json(
          {
            error: linkResult?.error || 'Write-back failed',
            conflict: Boolean(linkResult?.conflict),
          },
          { status: linkResult?.conflict ? 409 : 500 },
        );
      }
      const updated = await prisma.entitySuggestion.update({
        where: { id },
        data: { status: 'accepted', resolvedAt: new Date() },
      });
      return NextResponse.json({ suggestion: updated, createdNote: filepath });
    }

    // action === 'map'
    const target = String(
      targetNote || suggestion.suggestedExistingNote || '',
    ).trim();
    if (!target) return errorResponse('targetNote is required for map', 400);

    const targetPath = entityFilepathFor({ name: target, type });
    if (!targetPath) return errorResponse('Invalid entity type for map', 400);

    const linkResult = await linkEntityToMeeting({
      meetingNoteId: suggestion.noteId,
      name: target,
      type,
    });
    if (linkResult?.success === false) {
      return NextResponse.json(
        {
          error: linkResult?.error || 'Write-back failed',
          conflict: Boolean(linkResult?.conflict),
        },
        { status: linkResult?.conflict ? 409 : 500 },
      );
    }

    // Record the raw mention as an alias on the target note so future runs
    // auto-resolve this variant (best-effort; the note file must exist).
    let aliasAdded = false;
    try {
      const result = await addAliasToNote({
        filepath: targetPath,
        alias: suggestion.mention,
      });
      aliasAdded = Boolean(result.added);
    } catch (err) {
      console.warn(
        `[link-suggestions] alias write failed for ${targetPath}:`,
        err.message,
      );
    }

    const updated = await prisma.entitySuggestion.update({
      where: { id },
      data: { status: 'accepted', resolvedAt: new Date() },
    });
    return NextResponse.json({
      suggestion: updated,
      mappedTo: target,
      aliasAdded,
    });
  } catch (error) {
    console.error(`Error applying link-suggestion ${id}:`, error);
    return NextResponse.json(
      { error: 'Failed to apply action' },
      { status: 500 },
    );
  }
}
