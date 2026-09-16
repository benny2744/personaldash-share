'use client';

import React, { useCallback, useState } from 'react';
import useSWR from 'swr';
import KanbanColumn from './KanbanColumn';
import IdeaCard from './IdeaCard';
import IdeaDrawer from './IdeaDrawer';
import FilterBar from './FilterBar';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { IDEA_BOARD_STATUSES, IDEA_STATUS_LABELS } from '@/lib/domain';
import { fetchJson } from '@/lib/fetcher';

const STATUSES = IDEA_BOARD_STATUSES.map((status) => status.value);
const STATUS_META = Object.fromEntries(IDEA_BOARD_STATUSES.map((status) => [status.value, status]));
const SORTERS = {
  updated: (a, b) =>
    new Date(b.fileModifiedAt || b.updatedAt).getTime() -
    new Date(a.fileModifiedAt || a.updatedAt).getTime(),
  title: (a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' }),
};

function normalizeStatus(value) {
  return (value || 'backburner').toLowerCase().replace(/\s+/g, '');
}

export default function IdeaKanbanBoard() {
  const { data: ideas, error, mutate } = useSWR('/api/ideas', fetchJson);
  const [search, setSearch] = useState('');
  const [domain, setDomain] = useState('all');
  const [sortBy, setSortBy] = useState('updated');
  const [drawerIdea, setDrawerIdea] = useState(null);
  const [activeMobileStatus, setActiveMobileStatus] = useState(STATUSES[0]);

  const handleCardOpen = useCallback((idea) => setDrawerIdea(idea), []);
  const handleDrawerClose = useCallback(() => setDrawerIdea(null), []);
  const handleIdeaUpdate = useCallback((updatedIdea) => {
    if (!updatedIdea?.id) return;
    mutate((currentIdeas) => {
      if (!Array.isArray(currentIdeas)) return currentIdeas;
      return currentIdeas.map((idea) => (idea.id === updatedIdea.id ? { ...idea, ...updatedIdea } : idea));
    }, false);
    setDrawerIdea((currentIdea) => (
      currentIdea?.id === updatedIdea.id ? { ...currentIdea, ...updatedIdea } : currentIdea
    ));
  }, [mutate]);

  if (error) return <div className="kanban-error">Failed to load ideas.</div>;
  if (!ideas) {
    return (
      <>
        {/* Desktop skeleton */}
        <div className="board-scroll hidden gap-6 overflow-x-auto pb-4 md:flex">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="w-80 flex-none space-y-3 rounded-xl bg-[var(--surface-container-low)] p-4">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ))}
        </div>
        {/* Mobile skeleton */}
        <div className="md:hidden space-y-3">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      </>
    );
  }

  const domains = ['all', ...new Set(ideas.map((idea) => idea.domain).filter(Boolean))];
  const filtered = ideas.filter((idea) => {
    const domainOk = domain === 'all' || idea.domain === domain;
    const titleOk = (idea.title || '').toLowerCase().includes(search.toLowerCase());
    return domainOk && titleOk;
  });

  const sorted = [...filtered].sort(SORTERS[sortBy] || SORTERS.updated);

  const ideasByStatus = {};
  STATUSES.forEach((status) => {
    ideasByStatus[status] = [];
  });
  sorted.forEach((idea) => {
    const status = normalizeStatus(idea.status);
    if (ideasByStatus[status]) ideasByStatus[status].push(idea);
    else ideasByStatus.backburner.push(idea);
  });

  const handleDragStart = (e, ideaId) => {
    e.dataTransfer.setData('ideaId', ideaId);
  };

  const handleDrop = async (e, droppedStatus) => {
    e.preventDefault();
    const ideaId = e.dataTransfer.getData('ideaId');
    if (!ideaId) return;

    const previousIdeas = [...ideas];
    const ideaIndex = ideas.findIndex((item) => item.id === ideaId);
    if (ideaIndex === -1) return;

    const idea = ideas[ideaIndex];
    if (normalizeStatus(idea.status) === droppedStatus) return;

    const updatedIdeas = [...ideas];
    const canonicalStatus = IDEA_STATUS_LABELS[droppedStatus] || 'Backburner';
    updatedIdeas[ideaIndex] = { ...idea, status: canonicalStatus };
    mutate(updatedIdeas, false);

    try {
      const res = await fetch(`/api/ideas/${ideaId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: canonicalStatus }),
      });
      if (!res.ok) throw new Error('Update failed');
      mutate();
    } catch (err) {
      console.error(err);
      mutate(previousIdeas, false);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
  };

  const activeFilterCount = [
    search.trim().length > 0,
    domain !== 'all',
    sortBy !== 'updated',
  ].filter(Boolean).length;

  return (
    <div className="flex h-full flex-col gap-6">
      <FilterBar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search ideas..."
        activeFilterCount={activeFilterCount}
        resultCount={sorted.length}
        totalCount={ideas.length}
        onClear={() => {
          setSearch('');
          setDomain('all');
          setSortBy('updated');
        }}
      >
        <Select value={domain} onChange={(event) => setDomain(event.target.value)} wrapperClassName="w-full md:w-40" className="h-8 text-xs">
          {domains.map((item) => <option key={item} value={item}>{item === 'all' ? 'All domains' : item}</option>)}
        </Select>
        <Select value={sortBy} onChange={(event) => setSortBy(event.target.value)} wrapperClassName="w-full md:w-36" className="h-8 text-xs">
          <option value="updated">Sort: Updated</option>
          <option value="title">Sort: Title</option>
        </Select>
      </FilterBar>

      <div className="flex gap-2 overflow-x-auto pb-1 md:hidden">
        {STATUSES.map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => setActiveMobileStatus(status)}
            className={cn(
              'shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold',
              activeMobileStatus === status
                ? 'bg-[var(--surface-card)] text-[var(--primary)] shadow-sm'
                : 'bg-[var(--surface-container-low)] text-[var(--text-secondary)]'
            )}
          >
            {(STATUS_META[status]?.label || status)} ({ideasByStatus[status].length})
          </button>
        ))}
      </div>

      <div className="board-scroll hidden flex-1 gap-6 overflow-x-auto pb-4 md:flex">
        {STATUSES.map((status) => (
          <KanbanColumn
            key={status}
            status={status}
            tasks={ideasByStatus[status]}
            statusMeta={STATUS_META}
            CardComponent={({ task, ...props }) => <IdeaCard idea={task} {...props} />}
            onDragStart={handleDragStart}
            onDrop={(e) => handleDrop(e, status)}
            onDragOver={handleDragOver}
            onCardOpen={handleCardOpen}
          />
        ))}
      </div>

      <div className="flex min-h-0 flex-1 md:hidden">
        <KanbanColumn
          status={activeMobileStatus}
          tasks={ideasByStatus[activeMobileStatus]}
          statusMeta={STATUS_META}
          CardComponent={({ task, ...props }) => <IdeaCard idea={task} {...props} />}
          onDragStart={handleDragStart}
          onDrop={(e) => handleDrop(e, activeMobileStatus)}
          onDragOver={handleDragOver}
          onCardOpen={handleCardOpen}
          singleColumn
        />
      </div>

      {drawerIdea && (
        <IdeaDrawer
          idea={drawerIdea}
          onClose={handleDrawerClose}
          onIdeaUpdate={handleIdeaUpdate}
        />
      )}
    </div>
  );
}
