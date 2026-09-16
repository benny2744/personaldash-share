import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { readNote, writeNote, fileExists, hashContent } from '@/lib/vault';
import { triggerGbrainSync } from '@/lib/gbrainSync';
import { complete } from '@/lib/meetingPipeline/llm';
import matter from 'gray-matter';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const SYSTEM_PROMPT = `You are an assistant that updates an Obsidian project note.

You will receive the COMPLETE current markdown of a project note (including YAML frontmatter delimited by ---) followed by a user message describing an idea, todo, or status change.

Your job: return the COMPLETE updated markdown with the user's input thoughtfully integrated.
- Append new ideas as bullet points under a "## Ideas" section (create it if missing).
- Append new todos as "- [ ]" checkboxes under a "## Tasks" or "## Todos" section if the message reads like an action item.
- Append general notes as bullets under "## Notes".
- Update frontmatter fields (e.g. Status, Target) ONLY if the message explicitly requests a status or date change.
- Preserve ALL existing content and structure. Never delete or rewrite existing bullets unless the message clearly asks you to.
- Keep frontmatter keys exactly as written (Status, Target, Area, Tasks, People, Notes, Domain, tags).
- Output ONLY the raw markdown of the full updated note. No code fences, no commentary.`;

function stripCodeFences(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
  return match ? match[1] : trimmed;
}

export async function POST(request, { params }) {
  const { id } = await params;

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!message) {
    return NextResponse.json({ error: 'Message is required' }, { status: 400 });
  }

  try {
    const project = await prisma.project.findFirst({
      where: { id, note: { deletedAt: null } },
      include: { note: { select: { filepath: true, id: true } } },
    });

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    if (!project.note?.filepath || !(await fileExists(project.note.filepath))) {
      return NextResponse.json({ error: 'Backing note file is missing' }, { status: 410 });
    }

    const filepath = project.note.filepath;
    const raw = await readNote(filepath);

    let updated;
    try {
      updated = await complete({
        system: SYSTEM_PROMPT,
        user: `<current_note>\n${raw}\n</current_note>\n\n<user_message>\n${message}\n</user_message>`,
        maxTokens: 8000,
        temperature: 0.2,
      });
    } catch (llmError) {
      console.error(`LLM call failed for project ${id}:`, llmError);
      return NextResponse.json(
        { error: 'LLM call failed', detail: llmError.message },
        { status: 502 },
      );
    }

    let nextContent = stripCodeFences(updated);

    // Validate the result still parses as frontmatter markdown and preserve
    // the original frontmatter if the model dropped or corrupted it.
    let parsed;
    try {
      parsed = matter(nextContent);
    } catch {
      return NextResponse.json(
        { error: 'LLM returned invalid markdown' },
        { status: 502 },
      );
    }

    const original = matter(raw);
    const fmKeys = Object.keys(original.data);
    const missingKeys = fmKeys.filter((key) => !(key in parsed.data));
    if (missingKeys.length > 0) {
      const merged = { ...original.data, ...parsed.data };
      nextContent = matter.stringify(parsed.content, merged);
    }

    if (!nextContent.trim()) {
      return NextResponse.json({ error: 'LLM returned empty content' }, { status: 502 });
    }

    // Conflict detection: bail if the file changed under us since we read it.
    const currentHash = hashContent(raw);
    const latestRaw = await readNote(filepath);
    if (hashContent(latestRaw) !== currentHash) {
      return NextResponse.json(
        { error: 'Note was modified externally; retry', conflict: true },
        { status: 409 },
      );
    }

    await writeNote(filepath, nextContent);
    triggerGbrainSync('project-chat-edit');
    const newHash = hashContent(nextContent);

    await prisma.$transaction([
      prisma.syncState.upsert({
        where: { noteId: project.note.id },
        create: {
          noteId: project.note.id,
          lastSeenHash: newHash,
          lastWrittenHash: newHash,
          syncStatus: 'clean',
        },
        update: {
          lastSeenHash: newHash,
          lastWrittenHash: newHash,
          syncStatus: 'clean',
          lastError: null,
        },
      }),
      prisma.note.update({
        where: { id: project.note.id },
        data: { fileHash: newHash },
      }),
    ]);

    return NextResponse.json({
      content: nextContent,
      reply: `Updated "${project.title}" note.`,
    });
  } catch (error) {
    console.error(`Error in project chat ${id}:`, error);
    return NextResponse.json({ error: 'Failed to update note' }, { status: 500 });
  }
}
