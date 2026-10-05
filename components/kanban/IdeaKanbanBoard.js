'use client';

import React, { useCallback, useEffect, useState } from 'react';
import useSWR from 'swr';
import { ChevronsDownUp, ChevronsUpDown, X } from 'lucide-react';
import KanbanColumn from './KanbanColumn';
import IdeaDrawer from './IdeaDrawer';
import IdeaCard from './IdeaCard';
import FilterBar from './FilterBar';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  IDEA_BOARD_STATUSES,
  IDEA_CLOSED_STATUSES,
  IDEA_FUNNEL_STATUSES,
  IDEA_STATUS_LABELS,
} from '@/lib/domain';
import { fetchJson } from '@/lib/fetcher';

// domain.js funnel/closure arrays hold canonical labels ("Captured"); the
// board keys ideasByStatus by IDEA_BOARD_STATUSES values ("captured").
const FUNNEL_VALUES = IDEA_FUNNEL_STATUSES.map((status) => status.toLowerCase());
const CLOSED_VALUES = IDEA_CLOSED_STATUSES.map((status) => status.toLowerCase());

const STATUSES = IDEA_BOARD_STATUSES.map((status) => status.value);
const STATUS_META = Object.fromEntries(
  IDEA_BOARD_STATUSES.map((status) => [status.value, status]),
);
const CLOSED_META = {
  label: 'Closed',
  color: 'var(--text-secondary)',
};
const SCORE_WEIGHT = { high: 0, medium: 1, low: 2 };
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

function normalizeStatus(value) {
  return (value || 'captured').toLowerCase().replace(/\s+/g, '');
}

function getIdeaDateTimestamp(idea) {
  const createdTs = idea.ideaCreated ? new Date(idea.ideaCreated).getTime() : NaN;
  if (Number.isFinite(createdTs)) return createdTs;
  const fallbackTs = idea.createdAt ? new Date(idea.createdAt).getTime() : NaN;
  return Number.isFinite(fallbackTs) ? fallbackTs : null;
}

function readBoardFilters() {
  if (typeof window === 'undefined') return {};
  const params = new URLSearchParams(window.location.search);
  return Object.fromEntries(
    [
      'context',
      'project',
      'domain',
      'tag',
      'impact',
      'confidence',
      'effort',
      'created',
      'sort',
      'q',
    ]
      .filter((key) => params.has(key))
      .map((key) => [key, params.get(key)]),
  );
}

export default function IdeaKanbanBoard() {
  const { data: ideas, error, mutate } = useSWR('/api/ideas', fetchJson);
  const [search, setSearch] = useState('');
  const [context, setContext] = useState('all');
  const [project, setProject] = useState('all');
  const [domain, setDomain] = useState('all');
  const [tag, setTag] = useState('all');
  const [impact, setImpact] = useState('all');
  const [confidence, setConfidence] = useState('all');
  const [effort, setEffort] = useState('all');
  const [createdFilter, setCreatedFilter] = useState('all');
  const [sortBy, setSortBy] = useState('updated');
  const [urlReady, setUrlReady] = useState(false);
  const [closedExpanded, setClosedExpanded] = useState(false);
  const [reviewPending, setReviewPending] = useState(false);
  const [drawerIdea, setDrawerIdea] = useState(null);
  const [activeMobileStatus, setActiveMobileStatus] = useState(STATUSES[0]);

  useEffect(() => {
    const params = readBoardFilters();
    setSearch(params.q || '');
    setContext(params.context || 'all');
    setProject(params.project || 'all');
    setDomain(params.domain || 'all');
    setTag(params.tag || 'all');
    setImpact(params.impact || 'all');
    setConfidence(params.confidence || 'all');
    setEffort(params.effort || 'all');
    setCreatedFilter(params.created || 'all');
    setSortBy(params.sort || 'updated');
    setUrlReady(true);
  }, []);

  useEffect(() => {
    if (!urlReady) return;
    const params = new URLSearchParams(window.location.search);
    const filters = {
      q: search.trim(),
      context,
      project,
      domain,
      tag,
      impact,
      confidence,
      effort,
      created: createdFilter,
      sort: sortBy,
    };
    for (const [key, value] of Object.entries(filters)) {
      if (!value || value === 'all' || (key === 'sort' && value === 'updated'))
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
    domain,
    tag,
    impact,
    confidence,
    effort,
    createdFilter,
    sortBy,
  ]);

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
          {Array.from({ length: 4 }).map((_, index) => (
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

  // Canonical display variant per lowercase-keyed domain: pick the most
  // frequent casing so "edtech"/"EdTech Products" dedupe into one filter.
  const domainGroups = {};
  ideas.forEach((idea) => {
    if (!idea.domain) return;
    const key = idea.domain.toLowerCase();
    domainGroups[key] = domainGroups[key] || {};
    domainGroups[key][idea.domain] = (domainGroups[key][idea.domain] || 0) + 1;
  });
  const domains = Object.values(domainGroups)
    .map((variants) =>
      Object.entries(variants).sort((a, b) => b[1] - a[1])[0][0],
    )
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const tags = [
    ...new Set(
      ideas
        .flatMap((idea) => idea.tags || [])
        .filter((item) => item !== 'type/idea'),
    ),
  ].sort();
  const projects = [
    ...new Set(ideas.map((idea) => idea.project).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  const filtered = ideas.filter((idea) => {
    const contextOk =
      context === 'all'
        ? true
        : context === 'unclassified'
          ? !idea.context
          : idea.context === context;
    const projectOk =
      project === 'all'
        ? true
        : project === 'has-project'
          ? Boolean(idea.project)
          : project === 'no-project'
            ? !idea.project
            : idea.project === project;
    const domainOk =
      domain === 'all' ||
      (idea.domain || '').toLowerCase() === domain.toLowerCase();
    const tagOk = tag === 'all' || (idea.tags || []).includes(tag);
    const impactOk =
      impact === 'all' ||
      (idea.impact || '').toLowerCase() === impact.toLowerCase();
    const confidenceOk =
      confidence === 'all' ||
      (idea.confidence || '').toLowerCase() === confidence.toLowerCase();
    const effortOk =
      effort === 'all' ||
      (idea.effort || '').toLowerCase() === effort.toLowerCase();
    const haystack = [
      idea.title || '',
      idea.domain || '',
      idea.notesSummary || '',
      ...(idea.tags || []),
    ]
      .join(' ')
      .toLowerCase();
    const searchOk = haystack.includes(search.toLowerCase());
    const dateTs = getIdeaDateTimestamp(idea);
    const createdOk =
      dateTs === null
        ? createdFilter === 'all'
        : (CREATED_FILTERS[createdFilter] || CREATED_FILTERS.all)(dateTs);
    return (
      contextOk &&
      projectOk &&
      domainOk &&
      tagOk &&
      impactOk &&
      confidenceOk &&
      effortOk &&
      searchOk &&
      createdOk
    );
  });

  const scoreOf = (idea, field) =>
    SCORE_WEIGHT[(idea[field] || '').toLowerCase()] ?? 1;
  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === 'title') {
      return (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' });
    }
    if (sortBy === 'created') {
      const aTs = getIdeaDateTimestamp(a);
      const bTs = getIdeaDateTimestamp(b);
      return (bTs ?? 0) - (aTs ?? 0);
    }
    if (sortBy === 'impact') {
      const diff = scoreOf(a, 'impact') - scoreOf(b, 'impact');
      if (diff !== 0) return diff;
      return scoreOf(a, 'confidence') - scoreOf(b, 'confidence');
    }
    if (sortBy === 'confidence') {
      return scoreOf(a, 'confidence') - scoreOf(b, 'confidence');
    }
    return (
      new Date(b.fileModifiedAt || b.updatedAt).getTime() -
      new Date(a.fileModifiedAt || a.updatedAt).getTime()
    );
  });

  const ideasByStatus = {};
  STATUSES.forEach((status) => {
    ideasByStatus[status] = [];
  });
  sorted.forEach((idea) => {
    const status = normalizeStatus(idea.status);
    if (ideasByStatus[status]) ideasByStatus[status].push(idea);
    else ideasByStatus.captured.push(idea);
  });
  const closedIdeas = CLOSED_VALUES.flatMap(
    (status) => ideasByStatus[status],
  );

  const patchStatus = async (ideaId, canonicalStatus) => {
    const previousIdeas = [...ideas];
    const ideaIndex = ideas.findIndex((item) => item.id === ideaId);
    if (ideaIndex === -1) return;
    const idea = ideas[ideaIndex];
    if (normalizeStatus(idea.status) === normalizeStatus(canonicalStatus)) return;

    const updatedIdeas = [...ideas];
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

  const handleReviewSweep = async () => {
    const incubating = ideasByStatus.incubating || [];
    if (reviewPending || incubating.length === 0) return;

    const today = new Date().toISOString().slice(0, 10);
    const targetIds = new Set(incubating.map((idea) => idea.id));
    const previousIdeas = [...ideas];
    const updatedIdeas = ideas.map((idea) =>
      targetIds.has(idea.id) ? { ...idea, reviewedAt: today } : idea,
    );

    setReviewPending(true);
    mutate(updatedIdeas, false);

    try {
      const responses = await Promise.all(
        incubating.map((idea) =>
          fetch(`/api/ideas/${idea.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reviewedAt: today }),
          }),
        ),
      );
      if (responses.some((res) => !res.ok)) throw new Error('Review sweep failed');
      mutate();
    } catch (err) {
      console.error(err);
      mutate(previousIdeas, false);
      mutate();
    } finally {
      setReviewPending(false);
    }
  };

  const handleDragStart = (e, ideaId) => {
    e.dataTransfer.setData('ideaId', ideaId);
  };

  const handleDrop = async (e, droppedStatus) => {
    e.preventDefault();
    const ideaId = e.dataTransfer.getData('ideaId');
    if (!ideaId) return;
    // Dropping onto the collapsed Closed group retires the idea by default;
    // expand the group (or use the card Move select) for the other closures.
    const canonicalStatus =
      droppedStatus === 'closed'
        ? 'Retired'
        : IDEA_STATUS_LABELS[droppedStatus] || 'Captured';
    await patchStatus(ideaId, canonicalStatus);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
  };

  const handleMoveIdea = (ideaId, droppedStatus) => {
    const canonicalStatus =
      IDEA_STATUS_LABELS[droppedStatus] || 'Captured';
    patchStatus(ideaId, canonicalStatus);
  };

  const renderReviewSweepButton = () => (
    <Button
      variant="secondary"
      size="sm"
      onClick={handleReviewSweep}
      disabled={reviewPending || (ideasByStatus.incubating || []).length === 0}
      className="shrink-0"
      title="Stamp today as Last reviewed on every visible Incubating idea"
    >
      {reviewPending ? 'Marking…' : 'Mark reviewed'}
    </Button>
  );

  const activeFilterCount = [
    search.trim().length > 0,
    context !== 'all',
    project !== 'all',
    domain !== 'all',
    tag !== 'all',
    impact !== 'all',
    confidence !== 'all',
    effort !== 'all',
    createdFilter !== 'all',
    sortBy !== 'updated',
  ].filter(Boolean).length;

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
    domain !== 'all' && ['Domain', domain, () => setDomain('all')],
    tag !== 'all' && ['Tag', tag, () => setTag('all')],
    impact !== 'all' && ['Impact', impact, () => setImpact('all')],
    confidence !== 'all' && ['Confidence', confidence, () => setConfidence('all')],
    effort !== 'all' && ['Effort', effort, () => setEffort('all')],
    createdFilter !== 'all' && [
      'Date',
      createdFilter,
      () => setCreatedFilter('all'),
    ],
  ].filter(Boolean);

  const renderColumn = (status) => {
    let headerRight = null;
    if (status === 'incubating') {
      headerRight = renderReviewSweepButton();
    } else if (CLOSED_VALUES.includes(status)) {
      headerRight = (
        <button
          type="button"
          onClick={() => setClosedExpanded(false)}
          className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-container-high)]"
          title="Collapse closed columns"
        >
          <ChevronsDownUp size={13} />
          Collapse
        </button>
      );
    }
    return (
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
        headerRight={headerRight}
        emptyMessage={
          sorted.length === 0 ? 'No ideas match these filters' : 'Drop an idea here'
        }
        cardProps={{ onMove: handleMoveIdea, statusOptions: IDEA_BOARD_STATUSES }}
      />
    );
  };

  const renderClosedColumns = () => {
    if (closedExpanded) {
      return CLOSED_VALUES.map((status) => renderColumn(status));
    }
    return (
      <KanbanColumn
        key="closed"
        status="closed"
        tasks={closedIdeas}
        statusMeta={{ closed: CLOSED_META }}
        CardComponent={({ task, ...props }) => <IdeaCard idea={task} {...props} />}
        onDragStart={handleDragStart}
        onDrop={(e) => handleDrop(e, 'closed')}
        onDragOver={handleDragOver}
        onCardOpen={handleCardOpen}
        emptyMessage={
          sorted.length === 0 ? 'No ideas match these filters' : 'Drop an idea here to retire it'
        }
        headerRight={
          <button
            type="button"
            onClick={() => setClosedExpanded(true)}
            className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-container-high)]"
            title="Expand closed columns (Graduated / Shipped / Retired / Abandoned)"
          >
            <ChevronsUpDown size={13} />
            Expand
          </button>
        }
        cardProps={{ onMove: handleMoveIdea, statusOptions: IDEA_BOARD_STATUSES }}
      />
    );
  };

  return (
    <div className="flex h-full flex-col gap-3">
      <FilterBar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search ideas..."
        activeFilterCount={activeFilterCount}
        resultCount={sorted.length}
        totalCount={ideas.length}
        onClear={() => {
          setSearch('');
          setContext('all');
          setProject('all');
          setDomain('all');
          setTag('all');
          setImpact('all');
          setConfidence('all');
          setEffort('all');
          setCreatedFilter('all');
          setSortBy('updated');
        }}
      >
        <Select value={context} onChange={(event) => setContext(event.target.value)} wrapperClassName="w-full md:w-40" className="h-8 text-xs">
          <option value="all">All contexts</option>
          <option value="Work">Work</option>
          <option value="Personal">Personal</option>
          <option value="Side Projects">Side Projects</option>
          <option value="unclassified">Unclassified</option>
        </Select>
        <Select value={project} onChange={(event) => setProject(event.target.value)} wrapperClassName="w-full md:w-44" className="h-8 text-xs">
          <option value="all">All projects</option>
          <option value="has-project">Has project</option>
          <option value="no-project">No project</option>
          {projects.map((item) => <option key={item} value={item}>{item}</option>)}
        </Select>
        <details className="w-full md:w-auto">
          <summary className="flex h-8 cursor-pointer list-none items-center justify-center rounded-lg border border-[color:color-mix(in_srgb,var(--outline)_10%,transparent)] px-3 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-container-high)]">
            More filters
          </summary>
          <div className="mt-2 flex flex-wrap gap-2 rounded-lg border border-[color:color-mix(in_srgb,var(--outline)_10%,transparent)] bg-[var(--surface-container-low)] p-2 md:absolute md:z-20 md:max-w-3xl md:shadow-lg">
            <Select value={domain} onChange={(event) => setDomain(event.target.value)} wrapperClassName="w-full md:w-40" className="h-8 text-xs">
              <option value="all">All domains</option>
              {domains.map((item) => <option key={item} value={item}>{item}</option>)}
            </Select>
            <Select value={tag} onChange={(event) => setTag(event.target.value)} wrapperClassName="w-full md:w-40" className="h-8 text-xs">
              <option value="all">All tags</option>
              {tags.map((item) => <option key={item} value={item}>{item}</option>)}
            </Select>
            <Select value={impact} onChange={(event) => setImpact(event.target.value)} wrapperClassName="w-full md:w-36" className="h-8 text-xs">
              <option value="all">All impact</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </Select>
            <Select value={confidence} onChange={(event) => setConfidence(event.target.value)} wrapperClassName="w-full md:w-40" className="h-8 text-xs">
              <option value="all">All confidence</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </Select>
            <Select value={effort} onChange={(event) => setEffort(event.target.value)} wrapperClassName="w-full md:w-36" className="h-8 text-xs">
              <option value="all">All effort</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </Select>
            <Select value={createdFilter} onChange={(event) => setCreatedFilter(event.target.value)} wrapperClassName="w-full md:w-36" className="h-8 text-xs">
              <option value="all">Created: All</option>
              <option value="last7">Created: Last 7d</option>
              <option value="last30">Created: Last 30d</option>
              <option value="last90">Created: Last 90d</option>
              <option value="thisYear">Created: This year</option>
            </Select>
          </div>
        </details>
        <Select value={sortBy} onChange={(event) => setSortBy(event.target.value)} wrapperClassName="w-full md:w-40" className="h-8 text-xs">
          <option value="updated">Sort: Updated</option>
          <option value="created">Sort: Created</option>
          <option value="impact">Sort: Impact</option>
          <option value="confidence">Sort: Confidence</option>
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

      <div data-scroll-region="kanban-statuses" className="flex shrink-0 gap-2 overflow-x-auto pb-1 md:hidden">
        {IDEA_BOARD_STATUSES.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setActiveMobileStatus(option.value)}
            className={cn(
              'shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold',
              activeMobileStatus === option.value
                ? 'bg-[var(--surface-card)] text-[var(--primary)] shadow-sm'
                : 'bg-[var(--surface-container-low)] text-[var(--text-secondary)]'
            )}
          >
            {option.label} ({ideasByStatus[option.value].length})
          </button>
        ))}
      </div>

      <div data-scroll-region="kanban-board" className="board-scroll hidden min-h-0 flex-1 gap-4 overflow-x-auto pb-4 md:flex">
        {FUNNEL_VALUES.map((status) => renderColumn(status))}
        {renderClosedColumns()}
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
          headerRight={activeMobileStatus === 'incubating' ? renderReviewSweepButton() : null}
          emptyMessage={
            sorted.length === 0 ? 'No ideas match these filters' : 'Drop an idea here'
          }
          cardProps={{ onMove: handleMoveIdea, statusOptions: IDEA_BOARD_STATUSES }}
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
