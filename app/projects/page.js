import prisma from '@/lib/db';
import ProjectsClient from '@/components/projects/ProjectsClient';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Projects - WorkDash',
};

export default async function ProjectsPage() {
  const initialProjects = await prisma.project.findMany({
    where: { status: 'Active', note: { deletedAt: null } },
    orderBy: { updatedAt: 'desc' },
    include: { note: { select: { filepath: true } } },
  });

  const serialized = initialProjects.map((project) => ({
    ...project,
    targetDate: project.targetDate ? project.targetDate.toISOString() : null,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  }));

  return (
    <div className="flex h-[calc(100vh-var(--header-height))] flex-col gap-4 overflow-hidden sm:gap-6 md:gap-8">
      <div className="shrink-0">
        <h1 className="text-xl font-bold tracking-tight text-[var(--text-primary)] sm:text-2xl">
          Projects
        </h1>
        <p className="mt-1 text-xs text-[var(--text-secondary)] sm:text-sm">
          Active projects with inline status editing. Open a project to append ideas via chat.
        </p>
      </div>
      <div className="flex-1 overflow-hidden">
        <ProjectsClient initialProjects={serialized} />
      </div>
    </div>
  );
}
