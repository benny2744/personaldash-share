import { NextResponse } from 'next/server';
import { readNote, writeNote, fileExists, hashContent } from '@/lib/vault';
import { triggerGbrainSync } from '@/lib/gbrainSync';
import prisma from '@/lib/db';

export const dynamic = 'force-dynamic';

function normalizeVaultPath(value) {
  if (!value) return '';
  return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

function isSecretPath(path) {
  return path === 'Secrets' || path.startsWith('Secrets/');
}

function isProtectedWritePath(path) {
  return (
    isSecretPath(path) ||
    path.startsWith('sources/') ||
    path.startsWith('concepts/')
  );
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const path = normalizeVaultPath(searchParams.get('path'));

  if (!path) {
    return NextResponse.json({ error: 'Missing path parameter' }, { status: 400 });
  }

  if (isSecretPath(path)) {
    return NextResponse.json({ error: 'Forbidden path' }, { status: 403 });
  }

  try {
    const exists = await fileExists(path);
    if (!exists) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    const content = await readNote(path);

    // Attempt to enrich with database sync state if applicable
    let syncState = null;
    try {
      const noteRecord = await prisma.note.findUnique({
        where: { filepath: path },
        include: { syncState: true }
      });
      if (noteRecord && noteRecord.syncState) {
        syncState = noteRecord.syncState;
      }
    } catch {
      // Just ignore db errors for simple note reading
    }

    // Content hash of the returned body — metadata changes never alter it, so
    // clients can revalidate cheaply without re-downloading unchanged files.
    return NextResponse.json({ content, syncState, contentHash: hashContent(content) });
  } catch (error) {
    console.error(`Error reading vault note ${path}:`, error);
    return NextResponse.json({ error: 'Failed to read note' }, { status: 500 });
  }
}

export async function PUT(request) {
  const { searchParams } = new URL(request.url);
  const path = normalizeVaultPath(searchParams.get('path'));

  if (!path) {
    return NextResponse.json({ error: 'Missing path parameter' }, { status: 400 });
  }

  if (isProtectedWritePath(path)) {
    return NextResponse.json({ error: 'This vault path is protected from web UI writes' }, { status: 403 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { content } = body;
  if (typeof content !== 'string') {
    return NextResponse.json({ error: 'Missing string content field' }, { status: 400 });
  }

  try {
    // 1. Write file to disk
    await writeNote(path, content);
    triggerGbrainSync('vault-note-save');
    
    // 2. Update DB sync state to prevent indexer loop
    try {
      const newHash = hashContent(content);
      const noteRecord = await prisma.note.findUnique({ where: { filepath: path } });
      
      if (noteRecord) {
         await prisma.syncState.upsert({
           where: { noteId: noteRecord.id },
           create: {
             noteId: noteRecord.id,
             lastSeenHash: newHash,
             lastWrittenHash: newHash,
             syncStatus: 'clean',
           },
           update: {
             lastSeenHash: newHash,
             lastWrittenHash: newHash,
             syncStatus: 'clean',
             lastError: null,
           }
         });
         
         await prisma.note.update({
           where: { id: noteRecord.id },
           data: { fileHash: newHash },
         });
      }
    } catch (dbErr) {
       console.warn('Could not update DB after note write:', dbErr);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error(`Error writing vault note ${path}:`, error);
    return NextResponse.json({ error: 'Failed to write note' }, { status: 500 });
  }
}
