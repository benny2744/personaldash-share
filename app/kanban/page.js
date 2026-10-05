import KanbanPageClient from '@/components/kanban/KanbanPageClient';

export const metadata = {
  title: 'Kanban - WorkDash',
};

export default function KanbanPage() {
  return (
    <div className="kanban-page flex flex-col">
      <div className="min-h-0 flex-1 md:overflow-hidden">
        <KanbanPageClient />
      </div>
    </div>
  );
}
