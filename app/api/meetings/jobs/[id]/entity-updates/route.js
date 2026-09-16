/**
 * POST /api/meetings/jobs/[id]/entity-updates — manually apply (or dry-run)
 * the persisted meeting_analysis_v1 entity_updates of one job.
 *
 * Body: { mode?: 'dry_run' | 'apply' } — defaults to the global
 * MEETING_ENTITY_UPDATES_MODE. 'apply' via this endpoint always applies,
 * regardless of the global mode (explicit operator action); anything less
 * explicit honors the global gate.
 */
import { NextResponse } from 'next/server';
import { findMeetingJob } from '@/lib/meetingPipeline/jobsDb';
import { processJobEntityUpdates } from '@/lib/meetingPipeline/entityUpdates';
import { errorResponse, parseJsonBody } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request, { params }) {
  const { id } = await params;
  const { body, response } = await parseJsonBody(request);
  if (response) return response;

  const job = await findMeetingJob(id);
  if (!job) return errorResponse('Meeting job not found', 404);
  if (!job.analysisJson) {
    return errorResponse(
      'Job has no persisted analysis (pre-v1 pipeline)',
      400,
    );
  }

  const mode = body?.mode === 'apply' ? 'apply' : 'dry_run';
  const result = await processJobEntityUpdates(job, { mode });
  return NextResponse.json({
    jobId: id,
    mode: result.mode,
    processed: result.processed,
    error: result.error || null,
  });
}
