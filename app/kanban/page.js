import KanbanPageClient from '@/components/kanban/KanbanPageClient';

export const metadata = {
  title: 'Kanban - PersonalDash',
};

export default function KanbanPage() {
  return (
    <div className="flex h-[calc(100vh-var(--header-height))] flex-col gap-4 overflow-hidden sm:gap-6 md:gap-8">
      <div className="shrink-0">
        <h1 className="text-xl font-bold tracking-tight text-[var(--text-primary)] sm:text-2xl">Kanban Boards</h1>
        <p className="mt-1 text-xs text-[var(--text-secondary)] sm:text-sm">Manage tasks and ideas with drag-and-drop workflows</p>
      </div>
      <div className="flex-1 overflow-hidden">
        <KanbanPageClient />
      </div>
    </div>
  );
}
