import { NextResponse } from 'next/server';
import path from 'path';
import config from '@/lib/config';
import { putObject } from '@/lib/meetingPipeline/storage';
import { enqueueMeetingJob } from '@/lib/meetingPipeline/job';
import {
  createMeetingJob,
  listMeetingJobs,
  updateMeetingJob,
} from '@/lib/meetingPipeline/jobsDb';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function errorResponse(message, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function fileExt(file) {
  const fromName = path.extname(file.name || '').replace(/^\./, '');
  if (fromName) return fromName;
  const subtype = (file.type || '').split('/')[1] || 'bin';
  return subtype.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
}

function isAudioFile(file) {
  if (!file.type) return true; // Trust extension fallback.
  return (
    file.type.startsWith('audio/') || file.type === 'application/octet-stream'
  );
}

function serializeJob(job) {
  return {
    id: job.id,
    audioName: job.audioName,
    audioSize: job.audioSize,
    audioFiles: job.audioFiles ?? null,
    supplementaryFiles: job.supplementaryFiles ?? null,
    status: job.status,
    step: job.step,
    asrTaskId: job.asrTaskId,
    asrTaskIds: job.asrTaskIds ?? null,
    asrChars: job.asrChars,
    outputPath: job.outputPath,
    error: job.error,
    opencodeSessionId: job.opencodeSessionId ?? null,
    opencodeShareUrl: job.opencodeShareUrl ?? null,
    participantsText: job.participantsText ?? null,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function audioKeyForJob(jobId, index, ext) {
  return `${jobId}/audio-${index}.${fileExt({ name: `audio.${ext}`, type: `audio/${ext}` })}`;
}

function supplementaryKeyForJob(jobId, index, ext) {
  return `${jobId}/supp-${index}.${fileExt({ name: `supp.${ext}`, type: '' })}`;
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const activeOnly = searchParams.get('active') === '1';
    const recentCutoff = new Date(Date.now() - 30 * 60 * 1000);

    const jobs = await listMeetingJobs({
      activeOnly,
      recentCutoff,
      limit: activeOnly ? 20 : 100,
    });

    return NextResponse.json(jobs.map(serializeJob));
  } catch (error) {
    console.error('Error fetching meeting jobs:', error);
    return errorResponse('Failed to fetch meeting jobs', 500);
  }
}

async function uploadFile(jobId, file, key) {
  return putObject({
    key,
    stream: file.stream(),
    contentType: file.type || 'application/octet-stream',
    contentLength: file.size,
  });
}

export async function POST(request) {
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse('Invalid multipart form data');
  }

  const audioEntries = [];
  let audioIndex = 0;
  while (true) {
    const field = formData.get(
      audioIndex === 0 ? 'audio' : `audio-${audioIndex}`,
    );
    if (
      !field ||
      typeof field !== 'object' ||
      typeof field.stream !== 'function'
    )
      break;
    audioEntries.push(field);
    audioIndex += 1;
  }

  if (!audioEntries.length) {
    return errorResponse('Missing audio file field named "audio"');
  }

  for (const file of audioEntries) {
    if (file.size > config.meetingAudioMaxBytes) {
      return errorResponse(
        `Audio file exceeds ${config.meetingAudioMaxBytes} byte limit`,
        413,
      );
    }
    if (!isAudioFile(file)) {
      return errorResponse(`Unsupported audio content type: ${file.type}`);
    }
  }

  const supplementaryEntries = [];
  let suppIndex = 0;
  while (true) {
    const field = formData.get(
      `supplementary${suppIndex === 0 ? '' : `-${suppIndex}`}`,
    );
    if (
      !field ||
      typeof field !== 'object' ||
      typeof field.stream !== 'function'
    )
      break;
    if (field.size > config.meetingAudioMaxBytes) {
      return errorResponse(
        `Supplementary file exceeds ${config.meetingAudioMaxBytes} byte limit`,
        413,
      );
    }
    supplementaryEntries.push(field);
    suppIndex += 1;
  }

  const firstAudio = audioEntries[0];
  const totalAudioSize = audioEntries.reduce(
    (sum, file) => sum + (file.size || 0),
    0,
  );

  const participantsText = formData.get('participants');

  const job = await createMeetingJob({
    audioName: firstAudio.name || 'meeting-audio',
    audioSize: totalAudioSize,
    status: 'queued',
    step: 'upload',
    participantsText:
      typeof participantsText === 'string' ? participantsText : null,
  });

  try {
    const audioFiles = [];
    for (let index = 0; index < audioEntries.length; index += 1) {
      const file = audioEntries[index];
      const ext = fileExt(file);
      const key = audioKeyForJob(job.id, index, ext);
      await uploadFile(job.id, file, key);
      audioFiles.push({
        key,
        name: file.name || `audio-${index}`,
        size: file.size || 0,
        type: file.type || 'application/octet-stream',
        index,
      });
    }

    const supplementaryFiles = [];
    for (let index = 0; index < supplementaryEntries.length; index += 1) {
      const file = supplementaryEntries[index];
      const ext = fileExt(file);
      const key = supplementaryKeyForJob(job.id, index, ext);
      await uploadFile(job.id, file, key);
      supplementaryFiles.push({
        key,
        name: file.name || `supplementary-${index}`,
        size: file.size || 0,
        type: file.type || 'application/octet-stream',
        index,
      });
    }

    const updated = await updateMeetingJob(job.id, {
      audioFiles,
      supplementaryFiles,
      status: 'queued',
      step: 'queued',
    });

    enqueueMeetingJob(job.id);
    return NextResponse.json(serializeJob(updated), { status: 202 });
  } catch (error) {
    const failed = await updateMeetingJob(job.id, {
      status: 'failed',
      step: 'failed',
      error: error instanceof Error ? error.message : String(error),
      finishedAt: new Date(),
    });
    return NextResponse.json(serializeJob(failed), { status: 500 });
  }
}
