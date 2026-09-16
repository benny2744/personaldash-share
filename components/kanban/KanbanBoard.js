'use client';

import React, { useCallback, useState } from 'react';
import useSWR from 'swr';
import KanbanColumn from './KanbanColumn';
import TaskDrawer from './TaskDrawer';
import FilterBar from './FilterBar';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { TASK_BOARD_STATUSES } from '@/lib/domain';
import { normalizeStatus } from '@/lib/taskStats';
import { fetchJson } from '@/lib/fetcher';

const PRIORITY_WEIGHT = { high: 0, medium: 1, low: 2 };
const CREATED_FILTERS = {
  all: () => true,
  last7: (timestamp) => timestamp >= Date.now() - 7 * 24 * 60 * 60 * 1000,
  last30: (timestamp) => timestamp >= Date.now() - 30 * 24 * 60 * 60 * 1000,
  last90: (timestamp) => timestamp >= Date.now() - 90 * 24 * 60 * 60 * 1000,
  thisYear: (timestamp) => {
    const created = new Date(timestamp);
    return created.getFullYear() === new Date().getFullYear();
  },
};

function getTaskDateTimestamp(task) {
  // Prefer frontmatter "When" because DB createdAt reflects index/import time for many legacy tasks.
  const whenTs = task.whenDate ? new Date(task.whenDate).getTime() : NaN;
  if (Number.isFinite(whenTs)) return whenTs;

  const createdTs = task.createdAt ? new Date(task.createdAt).getTime() : NaN;
  return Number.isFinite(createdTs) ? createdTs : null;
}

export default function KanbanBoard() {
  const { data: tasks, error, mutate } = useSWR('/api/tasks', fetchJson);
  const [search, setSearch] = useState('');
  const [project, setProject] = useState('all');
  const [priority, setPriority] = useState('all');
  const [createdFilter, setCreatedFilter] = useState('all');
  const [sortBy, setSortBy] = useState('priority');
  const [drawerTask, setDrawerTask] = useState(null);
  const [activeMobileStatus, setActiveMobileStatus] = useState('proposed');
  const [archivePending, setArchivePending] = useState(false);

  const handleCardOpen = useCallback((task) => setDrawerTask(task), []);
  const handleDrawerClose = useCallback(() => setDrawerTask(null), []);
  const handleTaskUpdate = useCallback(
    (updatedTask) => {
      if (!updatedTask?.id) return;
      mutate((currentTasks) => {
        if (!Array.isArray(currentTasks)) return currentTasks;
        return currentTasks.map((task) =>
          task.id === updatedTask.id ? { ...task, ...updatedTask } : task,
        );
      }, false);
      setDrawerTask((currentTask) =>
        currentTask?.id === updatedTask.id
          ? { ...currentTask, ...updatedTask }
          : currentTask,
      );
    },
    [mutate],
  );

  if (error) return <div className="kanban-error">Failed to load tasks.</div>;
  if (!tasks) {
    return (
      <>
        {/* Desktop skeleton */}
        <div className="board-scroll hidden gap-6 overflow-x-auto pb-4 md:flex">
          {Array.from({ length: 4 }).map((_, index) => (
            <div
              key={index}
              className="w-80 flex-none space-y-3 rounded-xl bg-[var(--surface-container-low)] p-4"
            >
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

  const STATUS_OPTIONS = TASK_BOARD_STATUSES;
  const STATUSES = STATUS_OPTIONS.map((status) => status.value);
  const projects = [
    'all',
    ...new Set(tasks.map((task) => task.project).filter(Boolean)),
  ];

  const filtered = tasks.filter((task) => {
    const status = normalizeStatus(task.status);
    const statusOk = STATUSES.includes(status);
    const projectOk = project === 'all' || task.project === project;
    const priorityOk =
      priority === 'all' || (task.priority || '').toLowerCase() === priority;
    const titleOk = (task.title || '')
      .toLowerCase()
      .includes(search.toLowerCase());
    const dateTs = getTaskDateTimestamp(task);
    const createdOk =
      dateTs === null
        ? createdFilter === 'all'
        : (CREATED_FILTERS[createdFilter] || CREATED_FILTERS.all)(dateTs);
    return statusOk && projectOk && priorityOk && titleOk && createdOk;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === 'title') {
      return (a.title || '').localeCompare(b.title || '', undefined, {
        sensitivity: 'base',
      });
    }
    if (sortBy === 'date') {
      if (!a.whenDate && !b.whenDate) return 0;
      if (!a.whenDate) return 1;
      if (!b.whenDate) return -1;
      return new Date(a.whenDate).getTime() - new Date(b.whenDate).getTime();
    }
    if (sortBy === 'updated') {
      return (
        new Date(b.fileModifiedAt || b.updatedAt).getTime() -
        new Date(a.fileModifiedAt || a.updatedAt).getTime()
      );
    }

    const aPriority =
      PRIORITY_WEIGHT[(a.priority || 'medium').toLowerCase()] ?? 1;
    const bPriority =
      PRIORITY_WEIGHT[(b.priority || 'medium').toLowerCase()] ?? 1;
    if (aPriority !== bPriority) return aPriority - bPriority;

    if (!a.whenDate && !b.whenDate) return 0;
    if (!a.whenDate) return 1;
    if (!b.whenDate) return -1;
    return new Date(a.whenDate).getTime() - new Date(b.whenDate).getTime();
  });

  const tasksByStatus = {};
  STATUSES.forEach((status) => {
    tasksByStatus[status] = [];
  });

  sorted.forEach((task) => {
    const status = normalizeStatus(task.status);
    if (tasksByStatus[status]) tasksByStatus[status].push(task);
  });

  const handleDragStart = (e, taskId) => {
    e.dataTransfer.setData('taskId', taskId);
  };

  const handleDrop = async (e, droppedStatus) => {
    e.preventDefault();
    const taskId = e.dataTransfer.getData('taskId');

    // Optimistic UI update
    const previousTasks = [...tasks];
    const taskIndex = tasks.findIndex((t) => t.id === taskId);
    if (taskIndex === -1) return;

    const task = tasks[taskIndex];
    if ((task.status || '').toLowerCase() === droppedStatus) return; // No change

    const updatedTasks = [...tasks];
    const canonicalStatus =
      droppedStatus.charAt(0).toUpperCase() + droppedStatus.slice(1);
    updatedTasks[taskIndex] = { ...task, status: canonicalStatus };

    mutate(updatedTasks, false);

    // API Call
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: canonicalStatus }),
      });

      if (!res.ok) throw new Error('Update failed');
      mutate(); // Revalidate
    } catch (err) {
      console.error(err);
      mutate(previousTasks); // Rollback
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
  };

  const handleMoveTask = async (taskId, droppedStatus) => {
    const previousTasks = [...tasks];
    const taskIndex = tasks.findIndex((task) => task.id === taskId);
    if (taskIndex === -1) return;

    const task = tasks[taskIndex];
    if ((task.status || '').toLowerCase() === droppedStatus) return;

    const updatedTasks = [...tasks];
    const canonicalStatus =
      droppedStatus.charAt(0).toUpperCase() + droppedStatus.slice(1);
    updatedTasks[taskIndex] = { ...task, status: canonicalStatus };
    mutate(updatedTasks, false);

    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: canonicalStatus }),
      });
      if (!res.ok) throw new Error('Update failed');
      mutate();
    } catch (err) {
      console.error(err);
      mutate(previousTasks, false);
    }
  };

  const handleArchiveVisibleDone = async () => {
    const doneTasks = tasksByStatus.done || [];
    if (archivePending || doneTasks.length === 0) return;

    const doneTaskIds = new Set(doneTasks.map((task) => task.id));
    const previousTasks = [...tasks];
    const updatedTasks = tasks.map((task) =>
      doneTaskIds.has(task.id) ? { ...task, status: 'Archived' } : task,
    );

    setArchivePending(true);
    mutate(updatedTasks, false);

    try {
      const responses = await Promise.all(
        [...doneTaskIds].map((taskId) =>
          fetch(`/api/tasks/${taskId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'Archived' }),
          }),
        ),
      );
      if (responses.some((res) => !res.ok)) throw new Error('Archive failed');
      mutate();
    } catch (err) {
      console.error(err);
      mutate(previousTasks, false);
      mutate();
    } finally {
      setArchivePending(false);
    }
  };

  const activeFilterCount = [
    search.trim().length > 0,
    project !== 'all',
    priority !== 'all',
    createdFilter !== 'all',
    sortBy !== 'priority',
  ].filter(Boolean).length;

  const renderArchiveDoneButton = () => (
    <Button
      variant="secondary"
      size="sm"
      onClick={handleArchiveVisibleDone}
      disabled={archivePending || tasksByStatus.done.length === 0}
      className="shrink-0"
    >
      {archivePending ? 'Archiving...' : 'Archive All'}
    </Button>
  );

  return (
    <div className="flex h-full flex-col gap-6">
      <FilterBar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search tasks..."
        activeFilterCount={activeFilterCount}
        resultCount={sorted.length}
        totalCount={tasks.length}
        onClear={() => {
          setSearch('');
          setProject('all');
          setPriority('all');
          setCreatedFilter('all');
          setSortBy('priority');
        }}
      >
        <Select
          value={project}
          onChange={(event) => setProject(event.target.value)}
          wrapperClassName="w-full md:w-40"
          className="h-8 text-xs"
        >
          {projects.map((item) => (
            <option key={item} value={item}>
              {item === 'all' ? 'All projects' : item}
            </option>
          ))}
        </Select>
        <Select
          value={priority}
          onChange={(event) => setPriority(event.target.value)}
          wrapperClassName="w-full md:w-36"
          className="h-8 text-xs"
        >
          <option value="all">All priorities</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </Select>
        <Select
          value={createdFilter}
          onChange={(event) => setCreatedFilter(event.target.value)}
          wrapperClassName="w-full md:w-36"
          className="h-8 text-xs"
        >
          <option value="all">Date: All (default)</option>
          <option value="last7">Date: Last 7d</option>
          <option value="last30">Date: Last 30d</option>
          <option value="last90">Date: Last 90d</option>
          <option value="thisYear">Date: This year</option>
        </Select>
        <Select
          value={sortBy}
          onChange={(event) => setSortBy(event.target.value)}
          wrapperClassName="w-full md:w-36"
          className="h-8 text-xs"
        >
          <option value="priority">Sort: Priority</option>
          <option value="updated">Sort: Updated</option>
          <option value="date">Sort: Date</option>
          <option value="title">Sort: Title</option>
        </Select>
      </FilterBar>

      <div className="flex gap-2 overflow-x-auto pb-1 md:hidden">
        {STATUS_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setActiveMobileStatus(option.value)}
            className={cn(
              'shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold',
              activeMobileStatus === option.value
                ? 'bg-[var(--surface-card)] text-[var(--primary)] shadow-sm'
                : 'bg-[var(--surface-container-low)] text-[var(--text-secondary)]',
            )}
          >
            {option.label} ({tasksByStatus[option.value].length})
          </button>
        ))}
      </div>

      <div className="board-scroll hidden flex-1 gap-6 overflow-x-auto pb-4 md:flex">
        {STATUSES.map((status) => (
          <KanbanColumn
            key={status}
            status={status}
            tasks={tasksByStatus[status]}
            onDragStart={handleDragStart}
            onDrop={(e) => handleDrop(e, status)}
            onDragOver={handleDragOver}
            onCardOpen={handleCardOpen}
            headerRight={status === 'done' ? renderArchiveDoneButton() : null}
            cardProps={{
              onMove: handleMoveTask,
              statusOptions: STATUS_OPTIONS,
            }}
          />
        ))}
      </div>

      <div className="flex min-h-0 flex-1 md:hidden">
        <KanbanColumn
          status={activeMobileStatus}
          tasks={tasksByStatus[activeMobileStatus]}
          onDragStart={handleDragStart}
          onDrop={(e) => handleDrop(e, activeMobileStatus)}
          onDragOver={handleDragOver}
          onCardOpen={handleCardOpen}
          singleColumn
          headerRight={
            activeMobileStatus === 'done' ? renderArchiveDoneButton() : null
          }
          cardProps={{ onMove: handleMoveTask, statusOptions: STATUS_OPTIONS }}
        />
      </div>

      {drawerTask && (
        <TaskDrawer
          task={drawerTask}
          onClose={handleDrawerClose}
          onTaskUpdate={handleTaskUpdate}
        />
      )}
    </div>
  );
}
