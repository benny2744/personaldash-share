import { NextResponse } from 'next/server';
import {
  cancelMeetingJob,
  findMeetingJob,
  requeueMeetingJob,
} from '@/lib/meetingPipeline/jobsDb';
import { enqueueMeetingJob } from '@/lib/meetingPipeline/job';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(_request, { params }) {
  const { id } = await params;
  const job = await findMeetingJob(id);
  if (!job) {
    return NextResponse.json(
      { error: 'Meeting job not found' },
      { status: 404 },
    );
  }
  return NextResponse.json(job);
}

export async function PATCH(request, { params }) {
  const { id } = await params;
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (body.status === 'cancelled') {
    const job = await cancelMeetingJob(id);
    if (!job) {
      return NextResponse.json(
        { error: 'Meeting job not found or not cancellable' },
        { status: 404 },
      );
    }
    return NextResponse.json(job);
  }

  if (body.status === 'queued') {
    const job = await requeueMeetingJob(id);
    if (!job) {
      return NextResponse.json(
        { error: 'Meeting job not found, not retryable, or has no audio' },
        { status: 404 },
      );
    }
    enqueueMeetingJob();
    return NextResponse.json(job);
  }

  return NextResponse.json(
    { error: 'Only status=cancelled or status=queued is supported' },
    { status: 400 },
  );
}
