'use client';

import React, { useCallback, useEffect, useState } from 'react';
import useSWR from 'swr';
import { X } from 'lucide-react';
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

function readBoardFilters() {
  if (typeof window === 'undefined') return {};
  const params = new URLSearchParams(window.location.search);
  return Object.fromEntries(
    [
      'context',
      'project',
      'priority',
      'domain',
      'area',
      'tag',
      'person',
      'course',
      'created',
      'sort',
      'q',
    ]
      .filter((key) => params.has(key))
      .map((key) => [key, params.get(key)]),
  );
}

export default function KanbanBoard() {
  const { data: tasks, error, mutate } = useSWR('/api/tasks', fetchJson);
  const [search, setSearch] = useState('');
  const [context, setContext] = useState('all');
  const [project, setProject] = useState('all');
  const [priority, setPriority] = useState('all');
  const [domain, setDomain] = useState('all');
  const [area, setArea] = useState('all');
  const [tag, setTag] = useState('all');
  const [person, setPerson] = useState('all');
  const [course, setCourse] = useState('all');
  const [createdFilter, setCreatedFilter] = useState('all');
  const [sortBy, setSortBy] = useState('priority');
  const [urlReady, setUrlReady] = useState(false);
  const [drawerTask, setDrawerTask] = useState(null);
  const [activeMobileStatus, setActiveMobileStatus] = useState('proposed');
  const [archivePending, setArchivePending] = useState(false);

  useEffect(() => {
    const params = readBoardFilters();
    setSearch(params.q || '');
    setContext(params.context || 'all');
    setProject(params.project || 'all');
    setPriority(params.priority || 'all');
    setDomain(params.domain || 'all');
    setArea(params.area || 'all');
    setTag(params.tag || 'all');
    setPerson(params.person || 'all');
    setCourse(params.course || 'all');
    setCreatedFilter(params.created || 'all');
    setSortBy(params.sort || 'priority');
    setUrlReady(true);
  }, []);

  useEffect(() => {
    if (!urlReady) return;
    const params = new URLSearchParams(window.location.search);
    const filters = {
      q: search.trim(),
      context,
      project,
      priority,
      domain,
      area,
      tag,
      person,
      course,
      created: createdFilter,
      sort: sortBy,
    };
    for (const [key, value] of Object.entries(filters)) {
      if (!value || value === 'all' || (key === 'sort' && value === 'priority'))
        params.delete(key);
      else params.set(key, value);
    }
    const query = params.toString();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`,
    );
  }, [
    urlReady,
    search,
    context,
    project,
    priority,
    domain,
    area,
    tag,
    person,
    course,
    createdFilter,
    sortBy,
  ]);

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
  const uniqueValues = (key) =>
    [...new Set(tasks.map((task) => task[key]).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' }),
    );
  const projects = uniqueValues('project');
  const domains = uniqueValues('domain');
  const areas = uniqueValues('area');
  const tags = [
    ...new Set(
      tasks
        .flatMap((task) => task.tags || [])
        .filter((tag) => tag !== 'type/task'),
    ),
  ].sort();
  const people = [
    ...new Set(tasks.flatMap((task) => task.people || [])),
  ].sort();
  const courses = [
    ...new Set(tasks.flatMap((task) => task.courses || [])),
  ].sort();

  const filtered = tasks.filter((task) => {
    const status = normalizeStatus(task.status);
    const statusOk = STATUSES.includes(status);
    const contextOk =
      context === 'all'
        ? true
        : context === 'unclassified'
          ? !task.context
          : task.context === context;
    const projectOk =
      project === 'all'
        ? true
        : project === 'has-project'
          ? Boolean(task.project)
          : project === 'no-project'
            ? !task.project
            : task.project === project;
    const priorityOk =
      priority === 'all' || (task.priority || '').toLowerCase() === priority;
    const domainOk = domain === 'all' || task.domain === domain;
    const areaOk = area === 'all' || task.area === area;
    const tagOk = tag === 'all' || (task.tags || []).includes(tag);
    const personOk = person === 'all' || (task.people || []).includes(person);
    const courseOk = course === 'all' || (task.courses || []).includes(course);
    const titleOk = (task.title || '')
      .toLowerCase()
      .includes(search.toLowerCase());
    const dateTs = getTaskDateTimestamp(task);
    const createdOk =
      dateTs === null
        ? createdFilter === 'all'
        : (CREATED_FILTERS[createdFilter] || CREATED_FILTERS.all)(dateTs);
    return (
      statusOk &&
      contextOk &&
      projectOk &&
      priorityOk &&
      domainOk &&
      areaOk &&
      tagOk &&
      personOk &&
      courseOk &&
      titleOk &&
      createdOk
    );
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
    context !== 'all',
    project !== 'all',
    priority !== 'all',
    domain !== 'all',
    area !== 'all',
    tag !== 'all',
    person !== 'all',
    course !== 'all',
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

  const activeChips = [
    search.trim() && ['Search', search, () => setSearch('')],
    context !== 'all' && [
      'Context',
      context === 'unclassified' ? 'Unclassified' : context,
      () => setContext('all'),
    ],
    project !== 'all' && [
      'Project',
      project === 'has-project'
        ? 'Has project'
        : project === 'no-project'
          ? 'No project'
          : project,
      () => setProject('all'),
    ],
    priority !== 'all' && ['Priority', priority, () => setPriority('all')],
    domain !== 'all' && ['Domain', domain, () => setDomain('all')],
    area !== 'all' && ['Area', area, () => setArea('all')],
    tag !== 'all' && ['Tag', tag, () => setTag('all')],
    person !== 'all' && ['Person', person, () => setPerson('all')],
    course !== 'all' && ['Course', course, () => setCourse('all')],
    createdFilter !== 'all' && [
      'Date',
      createdFilter,
      () => setCreatedFilter('all'),
    ],
  ].filter(Boolean);

  return (
    <div className="flex h-full flex-col gap-3">
      <FilterBar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search tasks..."
        activeFilterCount={activeFilterCount}
        resultCount={sorted.length}
        totalCount={tasks.length}
        onClear={() => {
          setSearch('');
          setContext('all');
          setProject('all');
          setPriority('all');
          setDomain('all');
          setArea('all');
          setTag('all');
          setPerson('all');
          setCourse('all');
          setCreatedFilter('all');
          setSortBy('priority');
        }}
      >
        <Select
          value={context}
          onChange={(event) => setContext(event.target.value)}
          wrapperClassName="w-full md:w-40"
          className="h-8 text-xs"
        >
          <option value="all">All contexts</option>
          <option value="Work">Work</option>
          <option value="Personal">Personal</option>
          <option value="Side Projects">Side Projects</option>
          <option value="unclassified">Unclassified</option>
        </Select>
        <Select
          value={project}
          onChange={(event) => setProject(event.target.value)}
          wrapperClassName="w-full md:w-44"
          className="h-8 text-xs"
        >
          <option value="all">All projects</option>
          <option value="has-project">Has project</option>
          <option value="no-project">No project</option>
          {projects.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </Select>
        <details className="w-full md:w-auto">
          <summary className="flex h-8 cursor-pointer list-none items-center justify-center rounded-lg border border-[color:color-mix(in_srgb,var(--outline)_10%,transparent)] px-3 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-container-high)]">
            More filters
          </summary>
          <div className="mt-2 flex flex-wrap gap-2 rounded-lg border border-[color:color-mix(in_srgb,var(--outline)_10%,transparent)] bg-[var(--surface-container-low)] p-2 md:absolute md:z-20 md:max-w-3xl md:shadow-lg">
            <Select
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              wrapperClassName="w-full md:w-40"
              className="h-8 text-xs"
            >
              <option value="all">All domains</option>
              {domains.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </Select>
            <Select
              value={area}
              onChange={(event) => setArea(event.target.value)}
              wrapperClassName="w-full md:w-40"
              className="h-8 text-xs"
            >
              <option value="all">All areas</option>
              {areas.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </Select>
            <Select
              value={tag}
              onChange={(event) => setTag(event.target.value)}
              wrapperClassName="w-full md:w-40"
              className="h-8 text-xs"
            >
              <option value="all">All tags</option>
              {tags.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </Select>
            <Select
              value={person}
              onChange={(event) => setPerson(event.target.value)}
              wrapperClassName="w-full md:w-40"
              className="h-8 text-xs"
            >
              <option value="all">All people</option>
              {people.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </Select>
            <Select
              value={course}
              onChange={(event) => setCourse(event.target.value)}
              wrapperClassName="w-full md:w-40"
              className="h-8 text-xs"
            >
              <option value="all">All courses</option>
              {courses.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </Select>
          </div>
        </details>
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

      {activeChips.length > 0 && (
        <div
          className="flex shrink-0 flex-wrap items-center gap-1.5"
          aria-label="Active filters"
        >
          {activeChips.map(([label, value, clear]) => (
            <button
              key={label}
              type="button"
              onClick={clear}
              className="inline-flex h-7 items-center gap-1 rounded-full border border-[color:color-mix(in_srgb,var(--outline)_12%,transparent)] bg-[var(--surface-container-low)] px-2.5 text-[0.7rem] text-[var(--text-secondary)] hover:bg-[var(--surface-container-high)]"
              aria-label={`Clear ${label} filter: ${value}`}
            >
              <span className="font-semibold">{label}:</span> {value}
              <X size={12} />
            </button>
          ))}
        </div>
      )}

      <div
        data-scroll-region="kanban-statuses"
        className="flex shrink-0 gap-2 overflow-x-auto pb-1 md:hidden"
      >
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

      <div
        data-scroll-region="kanban-board"
        className="board-scroll hidden min-h-0 flex-1 gap-4 overflow-x-auto pb-4 md:flex"
      >
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
            emptyMessage={
              sorted.length === 0
                ? 'No tasks match these filters'
                : 'Drop a task here'
            }
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
          emptyMessage={
            sorted.length === 0
              ? 'No tasks match these filters'
              : 'Drop a task here'
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
