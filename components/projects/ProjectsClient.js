'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSWRConfig } from 'swr';
import {
  SortableTableHead,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchJson } from '@/lib/fetcher';
import { PROJECT_STATUSES } from '@/lib/domain';
import { cn } from '@/lib/utils';

const STATUS_TABS = [
  { value: 'Active', label: 'Active' },
  { value: 'Idea', label: 'Ideas' },
  { value: 'Done', label: 'Done' },
  { value: 'All', label: 'All' },
];

const STATUS_VARIANT = {
  Active: 'status-active',
  Idea: 'status-backburner',
  Done: 'status-done',
};

const DEFAULT_SORT = { key: 'updatedAt', dir: 'desc' };

function sortValue(project, key) {
  switch (key) {
    case 'title':
      return (project.title || '').toLowerCase();
    case 'targetDate': {
      if (!project.targetDate) return null;
      const time = new Date(project.targetDate).getTime();
      return Number.isNaN(time) ? null : time;
    }
    case 'area':
      return project.area ? project.area.toLowerCase() : null;
    case 'tasks':
      return (project.linkedTasks || []).length;
    case 'updatedAt': {
      const time = new Date(project.updatedAt).getTime();
      return Number.isNaN(time) ? null : time;
    }
    default:
      return null;
  }
}

function compareWithDirection(a, b, key, dir) {
  const av = sortValue(a, key);
  const bv = sortValue(b, key);
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  const cmp = av < bv ? -1 : av > bv ? 1 : 0;
  return dir === 'asc' ? cmp : -cmp;
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default function ProjectsClient({ initialProjects = [] }) {
  const [statusFilter, setStatusFilter] = useState('Active');
  const [projects, setProjects] = useState(initialProjects);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState(DEFAULT_SORT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [optimisticStatus, setOptimisticStatus] = useState({});
  const [savingId, setSavingId] = useState(null);
  const { mutate: globalMutate } = useSWRConfig();

  const handleSort = useCallback((column) => {
    setSort((prev) => {
      if (prev.key !== column) return { key: column, dir: 'asc' };
      if (prev.dir === 'asc') return { key: column, dir: 'desc' };
      return DEFAULT_SORT;
    });
  }, []);

  const visibleProjects = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = needle
      ? projects.filter((project) =>
          [project.title, project.area, project.notesSummary].some((value) =>
            (value || '').toLowerCase().includes(needle),
          ),
        )
      : projects;
    return [...filtered].sort((a, b) =>
      compareWithDirection(a, b, sort.key, sort.dir),
    );
  }, [projects, search, sort]);

  const refetch = useCallback(async (status) => {
    setLoading(true);
    setError(null);
    try {
      const query =
        status === 'All' ? '' : `?status=${encodeURIComponent(status)}`;
      const data = await fetchJson(`/api/projects${query}`);
      setProjects(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.message || 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleTabChange = useCallback(
    (status) => {
      setStatusFilter(status);
      refetch(status);
    },
    [refetch],
  );

  const handleStatusChange = useCallback(
    async (projectId, newStatus) => {
      const current = projects.find((p) => p.id === projectId);
      if (!current || current.status === newStatus) return;

      setOptimisticStatus((prev) => ({ ...prev, [projectId]: newStatus }));
      setSavingId(projectId);
      try {
        const updated = await fetchJson(`/api/projects/${projectId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: newStatus }),
        });
        setProjects((prev) =>
          prev
            .map((p) => (p.id === projectId ? { ...p, ...updated } : p))
            .filter((p) => statusFilter === 'All' || p.status === statusFilter),
        );
        globalMutate('/api/projects');
      } catch (err) {
        setError(err.message || 'Failed to update status');
        setOptimisticStatus((prev) => {
          const next = { ...prev };
          delete next[projectId];
          return next;
        });
      } finally {
        setSavingId(null);
      }
    },
    [projects, statusFilter, globalMutate],
  );

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => handleTabChange(tab.value)}
            className={cn(
              'rounded-full px-4 py-1.5 text-sm font-semibold transition-colors',
              statusFilter === tab.value
                ? 'bg-[var(--primary)] text-white'
                : 'bg-[var(--surface-container-low)] text-[var(--text-secondary)] hover:bg-[var(--surface-container-high)]',
            )}
          >
            {tab.label}
          </button>
        ))}
        {loading && (
          <span className="text-xs text-[var(--text-muted)]">Loading…</span>
        )}
        {error && <span className="text-xs text-[var(--error)]">{error}</span>}
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search title, area, or notes..."
          className="ml-auto h-8 w-full text-xs sm:w-60"
          aria-label="Search projects"
        />
      </div>

      <div
        className="flex-1 overflow-auto rounded-xl border border-[color:color-mix(in_srgb,var(--outline)_10%,transparent)] bg-[var(--surface-container-lowest)]"
        data-scroll-region
      >
        <Table data-layout-allow-overflow>
          <TableHeader>
            <TableRow>
              <SortableTableHead
                direction={sort.key === 'title' ? sort.dir : null}
                onClick={() => handleSort('title')}
              >
                Project
              </SortableTableHead>
              <TableHead className="w-[150px]">Status</TableHead>
              <SortableTableHead
                className="w-[140px]"
                direction={sort.key === 'targetDate' ? sort.dir : null}
                onClick={() => handleSort('targetDate')}
              >
                Target
              </SortableTableHead>
              <SortableTableHead
                className="w-[160px]"
                direction={sort.key === 'area' ? sort.dir : null}
                onClick={() => handleSort('area')}
              >
                Area
              </SortableTableHead>
              <SortableTableHead
                className="w-[90px] text-center [&>button]:mx-auto"
                direction={sort.key === 'tasks' ? sort.dir : null}
                onClick={() => handleSort('tasks')}
              >
                Tasks
              </SortableTableHead>
              <TableHead>Notes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && projects.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6}>
                  <Skeleton className="h-8 w-full" />
                </TableCell>
              </TableRow>
            ) : visibleProjects.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="py-12 text-center text-sm text-[var(--text-muted)]"
                >
                  {search.trim()
                    ? 'No projects match your search.'
                    : 'No projects found.'}
                </TableCell>
              </TableRow>
            ) : (
              visibleProjects.map((project) => {
                const effectiveStatus =
                  optimisticStatus[project.id] ?? project.status;
                return (
                  <TableRow key={project.id}>
                    <TableCell>
                      <Link
                        href={`/projects/${project.id}`}
                        className="font-semibold text-[var(--text-primary)] hover:text-[var(--primary)]"
                      >
                        {project.title}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Select
                          value={effectiveStatus}
                          onChange={(e) =>
                            handleStatusChange(project.id, e.target.value)
                          }
                          disabled={savingId === project.id}
                          wrapperClassName="w-[130px]"
                          className="h-8 py-1 text-xs"
                          aria-label={`Status for ${project.title}`}
                        >
                          {PROJECT_STATUSES.map((status) => (
                            <option key={status} value={status}>
                              {status}
                            </option>
                          ))}
                        </Select>
                        <Badge
                          variant={
                            STATUS_VARIANT[effectiveStatus] || 'secondary'
                          }
                          pill
                        >
                          {effectiveStatus}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-[var(--text-secondary)]">
                      {formatDate(project.targetDate)}
                    </TableCell>
                    <TableCell className="text-sm text-[var(--text-secondary)]">
                      {project.area || '—'}
                    </TableCell>
                    <TableCell className="text-center text-sm text-[var(--text-secondary)]">
                      {(project.linkedTasks || []).length}
                    </TableCell>
                    <TableCell className="max-w-[280px] truncate text-sm text-[var(--text-secondary)]">
                      {project.notesSummary || '—'}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
