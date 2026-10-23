'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronRight,
  Download,
  Eye,
  FilePenLine,
  FileText,
  Folder,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  SortableTableHead,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { sortVaultEntries } from '@/lib/files/vaultSort';
import { isPreviewableName } from '@/lib/files/previewTypes';
import NotePreviewDrawer from '@/components/files/NotePreviewDrawer';
import FilePreviewDrawer from '@/components/files/FilePreviewDrawer';

function isMarkdownName(name) {
  return /\.(md|markdown)$/i.test(name);
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function formatWhen(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Vault explorer for the /files page: breadcrumb navigation over the vault
 * with a sortable table (Name / Modified / Size; directories pinned first).
 * Clicking a file opens the preview drawer — .md via NotePreviewDrawer,
 * other text/images via FilePreviewDrawer against /api/vault/download.
 */
export default function VaultBrowser() {
  const [cwd, setCwd] = useState('');
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  const [notePath, setNotePath] = useState(null);
  const [filePath, setFilePath] = useState(null);

  const fetchDirectory = useCallback(async (dirPath) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/vault/files?path=${encodeURIComponent(dirPath)}`,
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load directory');
      setEntries(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDirectory(cwd);
  }, [cwd, fetchDirectory]);

  const sorted = useMemo(
    () => sortVaultEntries(entries, sort),
    [entries, sort],
  );

  const toggleSort = (key) => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'modified' ? 'desc' : 'asc' },
    );
  };

  const openFile = (entry) => {
    if (isMarkdownName(entry.name)) setNotePath(entry.path);
    else if (isPreviewableName(entry.name)) setFilePath(entry);
    // Non-previewable binaries: use the download link instead.
  };

  const breadcrumbs = cwd ? cwd.split('/').filter(Boolean) : [];
  // Modified/Size columns collapse below the sm breakpoint (mobile keeps Name + actions).
  const hideOnMobile = (key) =>
    key === 'modified' || key === 'size' ? 'hidden sm:table-cell' : '';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <Button
            variant="ghost"
            className={cn(
              'h-7 px-2 text-xs',
              !cwd && 'bg-[var(--bg-hover)] text-[var(--text-primary)]',
            )}
            onClick={() => setCwd('')}
          >
            vault
          </Button>
          {breadcrumbs.map((part, index) => {
            const pathValue = breadcrumbs.slice(0, index + 1).join('/');
            return (
              <React.Fragment key={pathValue}>
                <ChevronRight
                  size={12}
                  className="text-[var(--text-tertiary)]"
                />
                <Button
                  variant="ghost"
                  className={cn(
                    'h-7 px-2 text-xs',
                    pathValue === cwd &&
                      'bg-[var(--bg-hover)] text-[var(--text-primary)]',
                  )}
                  onClick={() => setCwd(pathValue)}
                >
                  {part}
                </Button>
              </React.Fragment>
            );
          })}
        </div>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          onClick={() => fetchDirectory(cwd)}
          aria-label="Refresh"
          title="Refresh"
          className="h-8 w-8"
        >
          {loading ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <RefreshCw size={14} />
          )}
        </Button>
      </div>

      <Card className="flex h-[62vh] flex-col">
        <CardContent className="flex min-h-0 flex-1 flex-col p-2">
          {loading && entries.length === 0 ? (
            <div className="space-y-2 p-1">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} className="h-9 w-full" />
              ))}
            </div>
          ) : error ? (
            <p className="rounded-lg bg-[var(--error-container)]/20 p-4 text-sm text-[var(--on-error-container)]">
              {error}
            </p>
          ) : sorted.length === 0 ? (
            <p className="p-6 text-center text-sm text-[var(--text-secondary)]">
              Empty directory.
            </p>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10">
                  <TableRow className="hover:bg-transparent">
                    <SortableTableHead
                      direction={sort.key === 'name' ? sort.dir : null}
                      onClick={() => toggleSort('name')}
                    >
                      Name
                    </SortableTableHead>
                    <SortableTableHead
                      className={cn('w-28', hideOnMobile('modified'))}
                      direction={sort.key === 'modified' ? sort.dir : null}
                      onClick={() => toggleSort('modified')}
                    >
                      Modified
                    </SortableTableHead>
                    <SortableTableHead
                      className={cn('w-24 text-right', hideOnMobile('size'))}
                      direction={sort.key === 'size' ? sort.dir : null}
                      onClick={() => toggleSort('size')}
                    >
                      Size
                    </SortableTableHead>
                    <TableHead className="w-20 text-right">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((entry) => (
                    <TableRow key={entry.path}>
                      <TableCell>
                        {entry.type === 'directory' ? (
                          <button
                            type="button"
                            onClick={() => setCwd(entry.path)}
                            className="flex w-full items-center gap-2 text-left text-sm hover:text-[var(--primary)]"
                          >
                            <Folder
                              size={15}
                              className="shrink-0 text-[var(--text-secondary)]"
                            />
                            <span className="truncate font-medium">
                              {entry.name}
                            </span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => openFile(entry)}
                            className={cn(
                              'flex w-full items-center gap-2 text-left text-sm',
                              isPreviewableName(entry.name)
                                ? 'hover:text-[var(--primary)]'
                                : 'cursor-default text-[var(--text-secondary)]',
                            )}
                            title={
                              isPreviewableName(entry.name)
                                ? `Preview ${entry.name}`
                                : `${entry.name} — use download`
                            }
                          >
                            {isMarkdownName(entry.name) ? (
                              <FilePenLine
                                size={15}
                                className="shrink-0 text-[var(--text-secondary)]"
                              />
                            ) : (
                              <FileText
                                size={15}
                                className="shrink-0 text-[var(--text-tertiary)]"
                              />
                            )}
                            <span className="truncate">{entry.name}</span>
                          </button>
                        )}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-xs text-[var(--text-secondary)]',
                          hideOnMobile('modified'),
                        )}
                      >
                        {formatWhen(entry.modifiedAt)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right text-xs text-[var(--text-secondary)]',
                          hideOnMobile('size'),
                        )}
                      >
                        {entry.type === 'directory' ? (
                          <Badge variant="outline" className="text-[10px]">
                            dir
                          </Badge>
                        ) : (
                          formatBytes(entry.size)
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-0.5">
                          {entry.type === 'directory' ? (
                            <a
                              href={`/api/vault/download?path=${encodeURIComponent(entry.path)}`}
                              download={`${entry.name}.zip`}
                              onClick={(event) => event.stopPropagation()}
                              aria-label={`Download ${entry.name} as zip`}
                              title={`Download ${entry.name} as zip`}
                              className="rounded p-1.5 text-[var(--text-secondary)] hover:bg-[var(--surface-container-low)] hover:text-[var(--text-primary)]"
                            >
                              <Download size={14} />
                            </a>
                          ) : (
                            <>
                              {isPreviewableName(entry.name) && (
                                <button
                                  type="button"
                                  onClick={() => openFile(entry)}
                                  aria-label={`Preview ${entry.name}`}
                                  title={`Preview ${entry.name}`}
                                  className="rounded p-1.5 text-[var(--text-secondary)] hover:bg-[var(--surface-container-low)] hover:text-[var(--text-primary)]"
                                >
                                  <Eye size={14} />
                                </button>
                              )}
                              <a
                                href={`/api/vault/download?path=${encodeURIComponent(entry.path)}`}
                                download={entry.name}
                                onClick={(event) => event.stopPropagation()}
                                aria-label={`Download ${entry.name}`}
                                title={`Download ${entry.name}`}
                                className="rounded p-1.5 text-[var(--text-secondary)] hover:bg-[var(--surface-container-low)] hover:text-[var(--text-primary)]"
                              >
                                <Download size={14} />
                              </a>
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {notePath && (
        <NotePreviewDrawer
          filepath={notePath}
          onClose={() => setNotePath(null)}
        />
      )}
      {filePath && (
        <FilePreviewDrawer
          file={filePath}
          downloadBase="/api/vault/download"
          subtitlePrefix="vault/"
          onClose={() => setFilePath(null)}
        />
      )}
    </div>
  );
}
