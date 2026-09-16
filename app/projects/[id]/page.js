import { notFound } from 'next/navigation';
import prisma from '@/lib/db';
import { fileExists, readNote } from '@/lib/vault';
import ProjectDetailClient from '@/components/projects/ProjectDetailClient';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Project - PersonalDash',
};

export default async function ProjectDetailPage({ params }) {
  const { id } = await params;

  const project = await prisma.project.findFirst({
    where: { id, note: { deletedAt: null } },
    include: { note: { select: { filepath: true } } },
  });

  if (!project) {
    notFound();
  }

  let content = '';
  if (project.note?.filepath && (await fileExists(project.note.filepath))) {
    content = await readNote(project.note.filepath);
  }

  const serialized = {
    ...project,
    targetDate: project.targetDate ? project.targetDate.toISOString() : null,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };

  return <ProjectDetailClient project={serialized} initialContent={content} />;
}
