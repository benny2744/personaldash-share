'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ChevronRight,
  Download,
  Eye,
  FileText,
  Folder,
  Inbox,
  FolderOutput,
  Loader2,
  RefreshCw,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { isMarkdownPath } from '@/lib/hermes/filePreview';
import FilePreviewDrawer from '@/components/files/FilePreviewDrawer';

const QUICK_LINKS = [
  { path: 'inbox', label: 'Inbox', icon: Inbox },
  { path: 'outputs', label: 'Outputs', icon: FolderOutput },
];

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function formatWhen(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

const PREVIEWABLE_EXTENSIONS = [
  '.md',
  '.markdown',
  '.txt',
  '.csv',
  '.json',
  '.html',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
];

function isPreviewable(name) {
  const lower = name.toLowerCase();
  return PREVIEWABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export default function ExchangeBrowser() {
  const [cwd, setCwd] = useState('inbox');
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploads, setUploads] = useState([]);
  const [previewFile, setPreviewFile] = useState(null);
  const fileInputRef = useRef(null);
  const dragDepthRef = useRef(0);

  const fetchDirectory = useCallback(async (dirPath) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/exchange/list?path=${encodeURIComponent(dirPath)}`,
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load directory');
      setEntries(data.entries || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDirectory(cwd);
  }, [cwd, fetchDirectory]);

  const uploadFiles = useCallback(
    async (fileList) => {
      const files = Array.from(fileList || []);
      if (!files.length) return;
      const uploadId = Date.now();
      const tracked = files.map((file, index) => ({
        id: `${uploadId}-${index}`,
        name: file.name,
        size: file.size,
        status: 'uploading',
      }));
      setUploads((prev) => [...prev, ...tracked]);

      await Promise.all(
        files.map(async (file, index) => {
          const entryId = tracked[index].id;
          try {
            const form = new FormData();
            form.append('file', file);
            const res = await fetch(
              `/api/exchange/upload?path=${encodeURIComponent(cwd)}`,
              { method: 'POST', body: form },
            );
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Upload failed');
            setUploads((prev) =>
              prev.map((item) =>
                item.id === entryId ? { ...item, status: 'done' } : item,
              ),
            );
          } catch (err) {
            setUploads((prev) =>
              prev.map((item) =>
                item.id === entryId
                  ? { ...item, status: 'error', error: err.message }
                  : item,
              ),
            );
          }
        }),
      );

      // Refresh listing; drop finished entries after a beat.
      await fetchDirectory(cwd);
      setTimeout(() => {
        setUploads((prev) =>
          prev.filter((item) => item.id.startsWith(String(uploadId)) === false),
        );
      }, 6000);
    },
    [cwd, fetchDirectory],
  );

  const breadcrumbs = useMemo(() => cwd.split('/').filter(Boolean), [cwd]);

  const onDrop = (event) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragOver(false);
    uploadFiles(event.dataTransfer?.files);
  };

  return (
    <div
      className="flex flex-col gap-3"
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepthRef.current += 1;
        if (event.dataTransfer?.types?.includes('Files')) setDragOver(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault();
        dragDepthRef.current -= 1;
        if (dragDepthRef.current <= 0) {
          dragDepthRef.current = 0;
          setDragOver(false);
        }
      }}
      onDrop={onDrop}
    >
      <div className="flex flex-wrap items-center gap-2">
        {QUICK_LINKS.map((link) => (
          <Button
            key={link.path}
            variant={cwd === link.path ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setCwd(link.path)}
          >
            <link.icon size={14} className="mr-1.5" />
            {link.label}
          </Button>
        ))}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          onClick={() => fetchDirectory(cwd)}
          aria-label="Refresh"
          title="Refresh"
          className="h-8 w-8"
        >
          <RefreshCw size={14} />
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            uploadFiles(event.target.files);
            event.target.value = '';
          }}
        />
        <Button size="sm" onClick={() => fileInputRef.current?.click()}>
          <Upload size={14} className="mr-1.5" />
          Upload here
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-1 text-xs">
        <Button
          variant="ghost"
          className={cn(
            'h-7 px-2 text-xs',
            cwd === '' && 'bg-[var(--bg-hover)]',
          )}
          onClick={() => setCwd('')}
        >
          exchange
        </Button>
        {breadcrumbs.map((part, index) => {
          const pathValue = breadcrumbs.slice(0, index + 1).join('/');
          return (
            <React.Fragment key={pathValue}>
              <ChevronRight size={12} className="text-[var(--text-tertiary)]" />
              <Button
                variant="ghost"
                className={cn(
                  'h-7 px-2 text-xs',
                  pathValue === cwd && 'bg-[var(--bg-hover)]',
                )}
                onClick={() => setCwd(pathValue)}
              >
                {part}
              </Button>
            </React.Fragment>
          );
        })}
      </div>

      {uploads.length > 0 && (
        <div className="space-y-1 rounded-lg bg-[var(--surface-container-low)] p-2">
          {uploads.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-2 text-xs text-[var(--text-secondary)]"
            >
              {item.status === 'uploading' ? (
                <Loader2 size={12} className="animate-spin" />
              ) : item.status === 'done' ? (
                <Badge variant="secondary" className="text-[10px]">
                  done
                </Badge>
              ) : (
                <Badge variant="destructive" className="text-[10px]">
                  failed
                </Badge>
              )}
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              <span className="shrink-0">{formatBytes(item.size)}</span>
              {item.status === 'error' && (
                <span className="shrink-0 text-[var(--on-error-container)]">
                  {item.error}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      <Card
        className={cn(
          'flex h-[62vh] flex-col transition',
          dragOver && 'ring-2 ring-[var(--accent)]',
        )}
      >
        <CardContent className="flex min-h-0 flex-1 flex-col p-2">
          {dragOver ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 border-2 border-dashed border-[var(--accent)]/40 text-sm text-[var(--text-secondary)]">
              <Upload size={22} />
              Drop files to upload to <span className="font-mono">/{cwd}</span>
            </div>
          ) : loading && entries.length === 0 ? (
            <div className="space-y-2 p-1">
              {Array.from({ length: 5 }).map((_, index) => (
                <Skeleton key={index} className="h-9 w-full" />
              ))}
            </div>
          ) : error ? (
            <p className="rounded-lg bg-[var(--error-container)]/20 p-4 text-sm text-[var(--on-error-container)]">
              {error}
            </p>
          ) : entries.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-[var(--text-secondary)]">
              <Upload size={20} className="text-[var(--text-tertiary)]" />
              <p>
                Empty. Drop files here or click <em>Upload here</em> — materials
                land on the server for AI/processes to pick up.
              </p>
            </div>
          ) : (
            <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto">
              {entries.map((entry) => (
                <li key={entry.path}>
                  {entry.type === 'directory' ? (
                    <button
                      type="button"
                      onClick={() => setCwd(entry.path)}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--bg-hover)]"
                    >
                      <Folder
                        size={15}
                        className="shrink-0 text-[var(--text-secondary)]"
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {entry.name}
                      </span>
                    </button>
                  ) : (
                    <div className="group flex w-full items-center rounded-lg text-sm hover:bg-[var(--bg-hover)]">
                      <div className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2">
                        {isMarkdownPath(entry.name) ? (
                          <FileText
                            size={15}
                            className="shrink-0 text-[var(--text-secondary)]"
                          />
                        ) : (
                          <FileText
                            size={15}
                            className="shrink-0 text-[var(--text-tertiary)]"
                          />
                        )}
                        <span className="min-w-0 flex-1 truncate">
                          {entry.name}
                        </span>
                        <span className="hidden shrink-0 text-[11px] text-[var(--text-tertiary)] sm:block">
                          {formatWhen(entry.modifiedAt)}
                        </span>
                        <span className="w-16 shrink-0 text-right text-[11px] text-[var(--text-tertiary)]">
                          {formatBytes(entry.size)}
                        </span>
                      </div>
                      <div className="mr-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                        {isPreviewable(entry.name) && (
                          <button
                            type="button"
                            onClick={() => setPreviewFile(entry)}
                            aria-label={`Preview ${entry.name}`}
                            title={`Preview ${entry.name}`}
                            className="rounded p-1.5 text-[var(--text-secondary)] hover:bg-[var(--surface-container-low)] hover:text-[var(--text-primary)]"
                          >
                            <Eye size={14} />
                          </button>
                        )}
                        <a
                          href={`/api/exchange/download?path=${encodeURIComponent(entry.path)}`}
                          download={entry.name}
                          aria-label={`Download ${entry.name}`}
                          title={`Download ${entry.name}`}
                          className="rounded p-1.5 text-[var(--text-secondary)] hover:bg-[var(--surface-container-low)] hover:text-[var(--text-primary)]"
                        >
                          <Download size={14} />
                        </a>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {previewFile && (
        <FilePreviewDrawer
          file={previewFile}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </div>
  );
}
