'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Unzip, UnzipInflate } from 'fflate';
import {
  AlertTriangle,
  ChevronRight,
  Download,
  Eye,
  FileText,
  Folder,
  FolderPlus,
  Inbox,
  FolderOutput,
  Loader2,
  RefreshCw,
  Upload,
} from 'lucide-react';
import PQueue from 'p-queue';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { isMarkdownPath } from '@/lib/hermes/filePreview';
import FilePreviewDrawer from '@/components/files/FilePreviewDrawer';
import {
  sanitizeRelativeUploadPath,
  uploadPathSegments,
  zipRootDirName,
} from '@/lib/files/uploadPaths';
import { isPreviewableName } from '@/lib/files/previewTypes';

const QUICK_LINKS = [
  { path: 'inbox', label: 'Inbox', icon: Inbox },
  { path: 'outputs', label: 'Outputs', icon: FolderOutput },
];

const UPLOAD_CONCURRENCY = 4;

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(2)} GB`;
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

/** Upload target dir for a picked file, preserving its relative folder. */
function targetDirFor(cwd, relativePath) {
  const base = cwd || 'inbox';
  if (!relativePath) return base;
  const segments = uploadPathSegments(relativePath);
  if (!segments) return null;
  const dirSegments = segments.slice(0, -1);
  return dirSegments.length ? [base, ...dirSegments].join('/') : base;
}

/**
 * Collect dropped items, descending into folders via the FileSystem entries
 * API so a dropped directory uploads with its structure. Falls back to the
 * plain File list when entries are unavailable.
 * @returns {Promise<Array<{file: File, relativePath?: string}>>}
 */
async function collectDataTransferFiles(dataTransfer) {
  const fallback = () =>
    Array.from(dataTransfer?.files || []).map((file) => ({ file }));
  const items = Array.from(dataTransfer?.items || []);
  const roots = [];
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) roots.push(entry);
  }
  if (!roots.length) return fallback();

  const collected = [];
  await Promise.all(
    roots.map((entry) => walkFileSystemEntry(entry, '', collected)),
  );
  return collected.length ? collected : fallback();
}

function walkFileSystemEntry(entry, prefix, out) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file(
        (file) => {
          out.push({ file, relativePath: `${prefix}${file.name}` });
          resolve();
        },
        () => resolve(),
      );
    } else if (entry.isDirectory) {
      // readEntries returns results in batches — keep calling until empty.
      const reader = entry.createReader();
      const dirPrefix = `${prefix}${entry.name}/`;
      const readBatch = () => {
        reader.readEntries(
          async (batch) => {
            if (!batch.length) {
              resolve();
              return;
            }
            await Promise.all(
              batch.map((child) => walkFileSystemEntry(child, dirPrefix, out)),
            );
            readBatch();
          },
          () => resolve(),
        );
      };
      readBatch();
    } else {
      resolve();
    }
  });
}

/**
 * Parse a zip File in the browser (fflate streaming Unzip) and hand each
 * entry to `onEntry(name, Blob)` as its data completes — entries are never
 * held in memory all at once beyond their own blob.
 * @returns {Promise<number>} number of file entries dispatched
 */
function extractZipEntries(file, onEntry) {
  return new Promise((resolve, reject) => {
    const unzip = new Unzip();
    unzip.register(UnzipInflate);
    let dispatched = 0;
    unzip.onfile = (entry) => {
      if (entry.name.endsWith('/')) return; // directory entry
      dispatched += 1;
      const chunks = [];
      entry.ondata = (err, data, final) => {
        if (err) return; // partial entry — uploaded nothing for it
        chunks.push(data);
        if (final) {
          const blob = new Blob(chunks);
          chunks.length = 0;
          Promise.resolve(onEntry(entry.name, blob)).catch(() => {});
        }
      };
      entry.start();
    };
    const reader = file.stream().getReader();
    const pump = async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            unzip.push(new Uint8Array(0), true);
            break;
          }
          unzip.push(value, false);
        }
        resolve(dispatched);
      } catch (err) {
        reject(err);
      }
    };
    pump();
  });
}

async function uploadOne(body, filename, dir, createDirs) {
  const form = new FormData();
  form.append('file', body, filename);
  const params = new URLSearchParams({ path: dir });
  if (createDirs) params.set('createDirs', '1');
  const res = await fetch(`/api/exchange/upload?${params}`, {
    method: 'POST',
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
}

export default function ExchangeBrowser() {
  const [cwd, setCwd] = useState('inbox');
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploads, setUploads] = useState([]);
  const [previewFile, setPreviewFile] = useState(null);
  const [zipPrompt, setZipPrompt] = useState(null);
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
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

  // webkitdirectory is non-standard — set it imperatively.
  useEffect(() => {
    const input = folderInputRef.current;
    if (!input) return undefined;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
    return undefined;
  }, []);

  /** Plain multi-file upload: one progress row per file (legacy UI). */
  const uploadPlainFiles = useCallback(
    async (files) => {
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
            await uploadOne(file, file.name, cwd || 'inbox', false);
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

  /** Folder/zip-aware batch upload: one aggregated progress row. */
  const startBatchUpload = useCallback(
    async (decisions) => {
      if (!decisions.length) return;
      const batchId = `batch-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const queue = new PQueue({ concurrency: UPLOAD_CONCURRENCY });
      const fileJobs = [];
      const extractJobs = [];
      let folderName = null;

      for (const decision of decisions) {
        if (decision.extract) {
          extractJobs.push(decision);
          continue;
        }
        const dir = targetDirFor(cwd, decision.relativePath);
        if (!dir) {
          fileJobs.push({ invalid: true, name: decision.file.name });
          continue;
        }
        if (decision.relativePath && !folderName) {
          [folderName] = decision.relativePath.split('/');
        }
        fileJobs.push({ file: decision.file, dir });
      }

      const label =
        extractJobs.length && !fileJobs.length
          ? `${extractJobs.length} zip${extractJobs.length > 1 ? 's' : ''} → extract`
          : folderName ||
            `${fileJobs.length} file${fileJobs.length === 1 ? '' : 's'}`;
      setUploads((prev) => [
        ...prev,
        {
          id: batchId,
          kind: 'batch',
          name: label,
          total: fileJobs.length,
          done: 0,
          failed: 0,
          errors: [],
          status: 'uploading',
        },
      ]);

      const bump = (field, delta = 1, errorEntry = null) =>
        setUploads((prev) =>
          prev.map((item) => {
            if (item.id !== batchId) return item;
            const next = { ...item, [field]: item[field] + delta };
            if (errorEntry) {
              next.errors = [...item.errors, errorEntry].slice(-10);
            }
            return next;
          }),
        );

      const runFileJob = async (job) => {
        if (job.invalid) {
          bump('failed', 1, `${job.name}: unsafe path`);
          return;
        }
        try {
          await queue.add(() =>
            uploadOne(job.file, job.file.name, job.dir, true),
          );
          bump('done');
        } catch (err) {
          bump('failed', 1, `${job.file.name}: ${err.message}`);
        }
      };

      const runExtractJob = async (job) => {
        const rootDir = zipRootDirName(job.file.name);
        try {
          const dispatched = await extractZipEntries(
            job.file,
            async (entryName, blob) => {
              // Zip-slip guard: skip entries the path sanitizer rejects.
              const safe = sanitizeRelativeUploadPath(entryName);
              if (!safe) {
                bump('failed', 1, `${entryName}: unsafe path, skipped`);
                return;
              }
              const segments = safe.split('/');
              const filename = segments.pop();
              const dir = [cwd || 'inbox', rootDir, ...segments]
                .filter(Boolean)
                .join('/');
              try {
                await queue.add(() => uploadOne(blob, filename, dir, true));
                bump('done');
              } catch (err) {
                bump('failed', 1, `${entryName}: ${err.message}`);
              }
            },
          );
          // Zip totals are only known after parsing — fold them in now.
          bump('total', dispatched);
        } catch (err) {
          bump(
            'failed',
            1,
            `${job.file.name}: extraction failed (${err.message})`,
          );
        }
      };

      await Promise.all([
        ...fileJobs.map((job) => runFileJob(job)),
        ...extractJobs.map((job) => runExtractJob(job)),
      ]);

      setUploads((prev) =>
        prev.map((item) =>
          item.id === batchId
            ? { ...item, status: item.failed ? 'error' : 'done' }
            : item,
        ),
      );

      await fetchDirectory(cwd);
      setTimeout(() => {
        setUploads((prev) => prev.filter((item) => item.id !== batchId));
      }, 6000);
    },
    [cwd, fetchDirectory],
  );

  /** Send decided items to the plain or batch flow. */
  const routeUploads = useCallback(
    (decisions) => {
      if (!decisions.length) return;
      const structured = decisions.some(
        (decision) => decision.relativePath || decision.extract,
      );
      if (structured) {
        startBatchUpload(decisions);
      } else {
        uploadPlainFiles(decisions.map((decision) => decision.file));
      }
    },
    [startBatchUpload, uploadPlainFiles],
  );

  /** Show the store/extract prompt when zips are present, else upload. */
  const handleIncoming = useCallback(
    (items) => {
      const usable = (items || []).filter((item) => item?.file);
      if (!usable.length) return;
      const zips = [];
      const rest = [];
      for (const item of usable) {
        if (String(item.file.name).toLowerCase().endsWith('.zip')) {
          zips.push({ ...item, extract: false });
        } else {
          rest.push(item);
        }
      }
      if (!zips.length) {
        routeUploads(usable.map((item) => ({ ...item, extract: false })));
        return;
      }
      setZipPrompt({ zips, rest });
    },
    [routeUploads],
  );

  const confirmZipPrompt = useCallback(() => {
    if (!zipPrompt) return;
    const decisions = [...zipPrompt.rest, ...zipPrompt.zips];
    setZipPrompt(null);
    routeUploads(decisions);
  }, [zipPrompt, routeUploads]);

  const toggleZipExtract = (index, extract) => {
    setZipPrompt((prev) => {
      if (!prev) return prev;
      const zips = prev.zips.map((zip, i) =>
        i === index ? { ...zip, extract } : zip,
      );
      return { ...prev, zips };
    });
  };

  const onDrop = (event) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragOver(false);
    collectDataTransferFiles(event.dataTransfer).then(handleIncoming);
  };

  const breadcrumbs = useMemo(() => cwd.split('/').filter(Boolean), [cwd]);

  const zipTotal = zipPrompt
    ? zipPrompt.zips.length + zipPrompt.rest.length
    : 0;

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
            handleIncoming(
              Array.from(event.target.files || []).map((file) => ({ file })),
            );
            event.target.value = '';
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            handleIncoming(
              Array.from(event.target.files || []).map((file) => ({
                file,
                relativePath: file.webkitRelativePath || undefined,
              })),
            );
            event.target.value = '';
          }}
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={() => folderInputRef.current?.click()}
        >
          <FolderPlus size={14} className="mr-1.5" />
          Upload folder
        </Button>
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
          {uploads.map((item) =>
            item.kind === 'batch' ? (
              <div
                key={item.id}
                className="flex items-center gap-2 text-xs text-[var(--text-secondary)]"
              >
                {item.status === 'uploading' ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : item.status === 'error' ? (
                  <Badge variant="destructive" className="text-[10px]">
                    failed
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="text-[10px]">
                    done
                  </Badge>
                )}
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                {item.errors.length > 0 && (
                  <span
                    title={item.errors.join('\n')}
                    aria-label={`${item.errors.length} errors`}
                    className="flex shrink-0 items-center gap-1 text-[var(--on-error-container)]"
                  >
                    <AlertTriangle size={12} />
                    {item.errors.length}
                  </span>
                )}
                <span className="shrink-0">
                  {item.done}/{item.total}
                  {item.failed ? ` · ${item.failed} failed` : ''}
                </span>
              </div>
            ) : (
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
            ),
          )}
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
              Drop files or folders to upload to{' '}
              <span className="font-mono">/{cwd}</span>
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
                Empty. Drop files or folders here, or use <em>Upload here</em> /{' '}
                <em>Upload folder</em> — materials land on the server for
                AI/processes to pick up.
              </p>
            </div>
          ) : (
            <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto">
              {entries.map((entry) => (
                <li key={entry.path}>
                  {entry.type === 'directory' ? (
                    <div className="group flex w-full items-center rounded-lg text-sm hover:bg-[var(--bg-hover)]">
                      <button
                        type="button"
                        onClick={() => setCwd(entry.path)}
                        className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left"
                      >
                        <Folder
                          size={15}
                          className="shrink-0 text-[var(--text-secondary)]"
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {entry.name}
                        </span>
                        <span className="hidden shrink-0 text-[11px] text-[var(--text-tertiary)] sm:block">
                          {formatWhen(entry.modifiedAt)}
                        </span>
                      </button>
                      <div className="mr-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                        <a
                          href={`/api/exchange/download?path=${encodeURIComponent(entry.path)}`}
                          download={`${entry.name}.zip`}
                          aria-label={`Download ${entry.name} as zip`}
                          title={`Download ${entry.name} as zip`}
                          className="rounded p-1.5 text-[var(--text-secondary)] hover:bg-[var(--surface-container-low)] hover:text-[var(--text-primary)]"
                        >
                          <Download size={14} />
                        </a>
                      </div>
                    </div>
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
                        {isPreviewableName(entry.name) ? (
                          <button
                            type="button"
                            onClick={() => setPreviewFile(entry)}
                            title={`Preview ${entry.name}`}
                            className="min-w-0 flex-1 truncate text-left hover:text-[var(--primary)]"
                          >
                            {entry.name}
                          </button>
                        ) : (
                          <span className="min-w-0 flex-1 truncate">
                            {entry.name}
                          </span>
                        )}
                        <span className="hidden shrink-0 text-[11px] text-[var(--text-tertiary)] sm:block">
                          {formatWhen(entry.modifiedAt)}
                        </span>
                        <span className="w-16 shrink-0 text-right text-[11px] text-[var(--text-tertiary)]">
                          {formatBytes(entry.size)}
                        </span>
                      </div>
                      <div className="mr-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                        {isPreviewableName(entry.name) && (
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

      {zipPrompt && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/30 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Zip upload options"
        >
          <div className="w-full max-w-md rounded-xl bg-[var(--surface-card)] p-4 shadow-2xl">
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">
              Zip upload
            </h2>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">
              Keep each archive as a file, or extract it into its own folder
              under <span className="font-mono">/{cwd || 'inbox'}</span>.
            </p>
            <ul className="mt-3 max-h-64 space-y-2 overflow-y-auto">
              {zipPrompt.zips.map((zip, index) => (
                <li
                  key={`${zip.file.name}-${index}`}
                  className="rounded-lg bg-[var(--surface-container-low)] p-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--text-primary)]">
                      {zip.file.name}
                    </span>
                    <span className="shrink-0 text-[11px] text-[var(--text-tertiary)]">
                      {formatBytes(zip.file.size)}
                    </span>
                  </div>
                  <div className="mt-1.5 flex gap-1">
                    <Button
                      size="sm"
                      variant={zip.extract ? 'ghost' : 'secondary'}
                      onClick={() => toggleZipExtract(index, false)}
                    >
                      Store as zip
                    </Button>
                    <Button
                      size="sm"
                      variant={zip.extract ? 'secondary' : 'ghost'}
                      onClick={() => toggleZipExtract(index, true)}
                    >
                      Extract to folder
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setZipPrompt(null)}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={confirmZipPrompt}>
                Upload {zipTotal} item{zipTotal === 1 ? '' : 's'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {previewFile && (
        <FilePreviewDrawer
          file={previewFile}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </div>
  );
}
