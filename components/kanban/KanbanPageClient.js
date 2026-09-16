'use client';

import React, { useState } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import KanbanBoard from '@/components/kanban/KanbanBoard';
import IdeaKanbanBoard from '@/components/kanban/IdeaKanbanBoard';

export default function KanbanPageClient() {
  const [activeTab, setActiveTab] = useState('tasks');

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-center justify-between">
        <Tabs>
          <TabsList>
            <TabsTrigger active={activeTab === 'tasks'} onClick={() => setActiveTab('tasks')}>Tasks</TabsTrigger>
            <TabsTrigger active={activeTab === 'ideas'} onClick={() => setActiveTab('ideas')}>Ideas</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === 'tasks' ? <KanbanBoard /> : <IdeaKanbanBoard />}
      </div>
    </div>
  );
}
