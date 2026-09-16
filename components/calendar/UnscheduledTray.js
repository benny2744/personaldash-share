'use client';

import React, { useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import FilterBar from '@/components/kanban/FilterBar';
import { TASK_PRIORITIES } from '@/lib/domain';
import { cn } from '@/lib/utils';

const PRIORITY_WEIGHT = { high: 0, medium: 1, low: 2 };

const PRIORITY_PILL = {
  high: 'border-[color:color-mix(in_srgb,var(--error-container)_45%,transparent)] bg-[color:color-mix(in_srgb,var(--error-container)_20%,transparent)] text-[var(--on-error-container)]',
  medium:
    'border-[color:color-mix(in_srgb,#fde68a_60%,transparent)] bg-[color:color-mix(in_srgb,#fde68a_40%,transparent)] text-[color:#92400e]',
  low: 'border-[color:color-mix(in_srgb,var(--outline)_15%,transparent)] bg-[var(--surface-container-high)] text-[var(--text-secondary)]',
};

export default function UnscheduledTray({
  tasks,
  search,
  setSearch,
  priorityFilter,
  setPriorityFilter,
  projectFilter,
  setProjectFilter,
  sortBy,
  setSortBy,
  showCompleted,
  setShowCompleted,
  clearFilters,
  onDragStart,
  onOpenTask,
}) {
  const unscheduledRaw = tasks.filter((task) => !task.whenDate);
  const projects = useMemo(
    () =>
      [
        'all',
        ...new Set(unscheduledRaw.map((task) => task.project).filter(Boolean)),
      ].sort(),
    [unscheduledRaw],
  );

  const filteredUnscheduled = useMemo(() => {
    let result = unscheduledRaw;

    if (!showCompleted) {
      result = result.filter((task) => {
        const status = (task.status || '').toLowerCase();
        return status !== 'done' && status !== 'archived';
      });
    }

    if (search) {
      const lower = search.toLowerCase();
      result = result.filter((task) =>
        (task.title || '').toLowerCase().includes(lower),
      );
    }

    if (priorityFilter !== 'all') {
      result = result.filter(
        (task) => (task.priority || '').toLowerCase() === priorityFilter,
      );
    }

    if (projectFilter !== 'all') {
      result = result.filter((task) => task.project === projectFilter);
    }

    return [...result].sort((a, b) => {
      if (sortBy === 'title') {
        return (a.title || '').localeCompare(b.title || '', undefined, {
          sensitivity: 'base',
        });
      }
      const aW = PRIORITY_WEIGHT[(a.priority || 'medium').toLowerCase()] ?? 1;
      const bW = PRIORITY_WEIGHT[(b.priority || 'medium').toLowerCase()] ?? 1;
      if (aW !== bW) return aW - bW;
      return (a.title || '').localeCompare(b.title || '', undefined, {
        sensitivity: 'base',
      });
    });
  }, [
    unscheduledRaw,
    search,
    priorityFilter,
    projectFilter,
    sortBy,
    showCompleted,
  ]);

  const activeFilterCount =
    (priorityFilter !== 'all' ? 1 : 0) +
    (projectFilter !== 'all' ? 1 : 0) +
    (search ? 1 : 0);

  const priorityPill = (priority) =>
    PRIORITY_PILL[(priority || 'medium').toLowerCase()] || PRIORITY_PILL.medium;

  return (
    <Card data-interactive="true">
      <CardContent className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-semibold">Unscheduled</div>
          <button
            type="button"
            className="text-xs text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
            onClick={() => setShowCompleted((prev) => !prev)}
          >
            {showCompleted ? 'Hide completed' : 'Show completed'}
          </button>
        </div>
        <div className="mb-3">
          <FilterBar
            searchValue={search}
            onSearchChange={setSearch}
            searchPlaceholder="Search unscheduled tasks..."
            onClear={clearFilters}
            activeFilterCount={activeFilterCount}
            resultCount={filteredUnscheduled.length}
            totalCount={unscheduledRaw.length}
          >
            <Select
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value)}
              wrapperClassName="w-28 shrink-0"
              className="h-8 text-xs"
            >
              <option value="all">All priority</option>
              {TASK_PRIORITIES.map((p) => (
                <option key={p} value={p.toLowerCase()}>
                  {p}
                </option>
              ))}
            </Select>
            <Select
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              wrapperClassName="w-36 shrink-0"
              className="h-8 text-xs"
            >
              <option value="all">All projects</option>
              {projects
                .filter((p) => p !== 'all')
                .map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
            </Select>
            <Select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              wrapperClassName="w-28 shrink-0"
              className="h-8 text-xs"
            >
              <option value="priority">Sort: Priority</option>
              <option value="title">Sort: Title</option>
            </Select>
          </FilterBar>
        </div>
        {filteredUnscheduled.length === 0 ? (
          <p className="text-sm text-[var(--text-secondary)]">
            {unscheduledRaw.length === 0
              ? 'All tasks are scheduled.'
              : 'No tasks match your filters.'}
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {filteredUnscheduled.map((task) => (
              <div
                key={task.id}
                draggable
                onDragStart={(event) => onDragStart(event, task.id)}
                className="min-w-0"
              >
                <button
                  type="button"
                  title={task.title}
                  onClick={(event) => onOpenTask(event, task)}
                  className={cn(
                    'w-full min-w-0 cursor-grab rounded-lg border px-3 py-2 text-left text-sm font-medium transition hover:-translate-y-0.5 hover:shadow-sm active:cursor-grabbing',
                    priorityPill(task.priority),
                  )}
                >
                  <span className="block truncate">{task.title}</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
