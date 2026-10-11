'use client';

import React, { useState } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import KanbanBoard from '@/components/kanban/KanbanBoard';
import IdeaKanbanBoard from '@/components/kanban/IdeaKanbanBoard';

export default function KanbanPageClient() {
  const [activeTab, setActiveTab] = useState('tasks');

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-[var(--text-primary)] sm:text-2xl">Kanban Boards</h1>
          <p className="mt-1 text-xs text-[var(--text-secondary)] sm:text-sm">Manage tasks and ideas with drag-and-drop workflows</p>
        </div>
        <Tabs>
          <TabsList>
            <TabsTrigger active={activeTab === 'tasks'} onClick={() => setActiveTab('tasks')}>Tasks</TabsTrigger>
            <TabsTrigger active={activeTab === 'ideas'} onClick={() => setActiveTab('ideas')}>Ideas</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="min-h-0 flex-1 md:overflow-hidden">
        {activeTab === 'tasks' ? <KanbanBoard /> : <IdeaKanbanBoard />}
      </div>
    </div>
  );
}
