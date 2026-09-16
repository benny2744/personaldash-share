'use client';

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, Download, FolderOpen, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { getLocalStore } from '@/lib/cache/localStore';
import {
  readFileListing,
  readFilePreview,
  writeFileListing,
  writeFilePreview,
} from '@/lib/cache/hermesCache';
import {
  dataUrlToText,
  isImageMime,
  isMarkdownPath,
  isTextMime,
  isTextPath,
} from '@/lib/hermes/filePreview';
import { cn } from '@/lib/utils';

function stripHtml(str) {
  if (!str) return str;
  return str
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function friendlyError(err) {
  const message = stripHtml(err.message || String(err));
  if (message.includes('404') || message.includes('Not Found')) {
    return 'Workspace files are not available right now.';
  }
  return message || 'Something went wrong.';
}

function previewText(preview) {
  const dataUrl = preview.data_url;
  if (typeof dataUrl === 'string' && dataUrl && dataUrl.includes(',')) {
    return dataUrlToText(dataUrl);
  }
  return dataUrl || '';
}

const MARKDOWN_PROSE_CLASSES =
  'prose prose-sm max-w-none break-words prose-p:my-2 prose-pre:bg-[var(--surface-container-low)] prose-pre:text-[var(--text-primary)]';

/**
 * Full-height file viewer for the workspace sidecar. Takes over the panel
 * below the tab bar; internal scrolling is clamped with min-h-0/overflow-auto
 * so long documents never expand the page.
 */
function FileViewer({ preview, onBack, onDownload }) {
  const markdown =
    isMarkdownPath(preview.path || preview.name) ||
    preview.mime_type === 'text/markdown';
  const image = isImageMime(preview.mime_type);
  const asText =
    !image &&
    (markdown ||
      isTextMime(preview.mime_type) ||
      isTextPath(preview.path || preview.name));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-[var(--border)] px-3 py-2">
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 shrink-0"
          onClick={onBack}
          aria-label="Back to list"
        >
          <ArrowLeft size={14} />
        </Button>
        <div className="min-w-0 flex-1 truncate text-xs font-semibold">
          {preview.name || preview.path}
        </div>
        {markdown ? <Badge variant="secondary">md</Badge> : null}
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 shrink-0"
          onClick={onDownload}
          aria-label="Download file"
        >
          <Download size={14} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={preview.data_url}
            alt={preview.name || preview.path}
            className="max-w-full rounded-lg object-contain"
          />
        ) : markdown && asText ? (
          <div className={MARKDOWN_PROSE_CLASSES}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {previewText(preview)}
            </ReactMarkdown>
          </div>
        ) : asText ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px]">
            {previewText(preview)}
          </pre>
        ) : (
          <p className="text-xs text-[var(--text-muted)]">
            No preview available for this file type.
          </p>
        )}
      </div>
    </div>
  );
}

export default function WorkspacePanel({
  tab,
  onTabChange,
  artifacts,
  todos,
  runtime,
  className,
  style,
}) {
  const [path, setPath] = useState('');
  const [listing, setListing] = useState(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function loadFiles(nextPath = path) {
    const store = getLocalStore();
    const cached = await readFileListing(store, nextPath);
    if (cached) {
      setListing(cached);
      setPath(cached.path || nextPath || '');
    }
    setLoading(true);
    setError(null);
    try {
      const data = await runtime.files.list(nextPath || undefined);
      setListing(data);
      setPath(data.path || nextPath || '');
      setPreview(null);
      await writeFileListing(store, nextPath, data);
    } catch (err) {
      if (!cached) setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setPreview(null);
    if (tab === 'files') {
      loadFiles('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function openEntry(entry) {
    if (entry.is_directory) {
      await loadFiles(entry.path);
      return;
    }
    await openPath(entry.path);
  }

  async function openPath(targetPath) {
    const store = getLocalStore();
    const cached = await readFilePreview(store, targetPath);
    if (cached) setPreview(cached);
    setLoading(true);
    setError(null);
    try {
      const data = await runtime.files.read(targetPath);
      setPreview(data);
      await writeFilePreview(store, targetPath, data);
    } catch (err) {
      if (!cached) {
        setError(err.message || String(err));
        setPreview(null);
      }
    } finally {
      setLoading(false);
    }
  }

  function handleTabChange(nextTab) {
    setPreview(null);
    onTabChange?.(nextTab);
  }

  async function downloadPreview() {
    if (!preview) return;
    const url = await runtime.files.downloadUrl(preview.path);
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  const viewerVisible = Boolean(preview) && tab !== 'todos';

  return (
    <aside
      style={style}
      className={cn(
        'flex h-full min-w-0 flex-col border-l border-[var(--border)] bg-[var(--surface-container-low)]',
        className,
      )}
    >
      <div className="border-b border-[var(--border)] p-3">
        <Tabs>
          <TabsList className="w-full justify-between">
            {[
              ['files', 'Files'],
              ['artifacts', 'Artifacts'],
              ['todos', 'Todos'],
            ].map(([id, label]) => (
              <TabsTrigger
                key={id}
                active={tab === id}
                className="flex-1"
                onClick={() => handleTabChange(id)}
              >
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {viewerVisible ? (
        <FileViewer
          preview={preview}
          onBack={() => setPreview(null)}
          onDownload={downloadPreview}
        />
      ) : (
        <ScrollArea className="min-h-0 flex-1 p-3">
          {tab === 'files' ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => loadFiles(listing?.parent || '')}
                  disabled={!listing?.parent}
                >
                  Up
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => loadFiles(path)}
                >
                  <RefreshCw size={14} />
                </Button>
                <span className="truncate font-mono text-[11px] text-[var(--text-muted)]">
                  {path || '/'}
                </span>
              </div>
              {loading ? (
                <p className="text-xs text-[var(--text-muted)]">Loading…</p>
              ) : null}
              {error ? (
                <div className="rounded-lg bg-[color:color-mix(in_srgb,var(--error)_8%,transparent)] p-2 text-xs text-[var(--on-error-container)]">
                  <p>{friendlyError(error)}</p>
                  <button
                    type="button"
                    onClick={() => loadFiles(path)}
                    className="mt-1 font-semibold text-[var(--accent)] hover:underline"
                  >
                    Retry
                  </button>
                </div>
              ) : null}
              <ul className="space-y-1">
                {(listing?.entries || []).map((entry) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-[var(--surface-container-high)]"
                      onClick={() => openEntry(entry)}
                    >
                      <FolderOpen
                        size={14}
                        className={
                          entry.is_directory
                            ? 'text-[var(--primary)]'
                            : 'text-[var(--text-muted)]'
                        }
                      />
                      <span className="truncate">{entry.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {tab === 'artifacts' ? (
            <ul className="space-y-2">
              {artifacts.length === 0 ? (
                <li className="text-xs text-[var(--text-muted)]">
                  File-producing tools will appear here.
                </li>
              ) : (
                artifacts.map((item) => (
                  <li key={`${item.path}-${item.tool_id}`}>
                    <button
                      type="button"
                      className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-card)] px-3 py-2 text-left transition-colors hover:bg-[var(--surface-container-high)]"
                      onClick={() => openPath(item.path)}
                      title={`Preview ${item.path}`}
                    >
                      <div className="truncate font-mono text-xs">
                        {item.path}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
                        <span>{item.name}</span>
                        {item.kind ? (
                          <Badge variant="secondary">{item.kind}</Badge>
                        ) : null}
                      </div>
                    </button>
                  </li>
                ))
              )}
            </ul>
          ) : null}

          {tab === 'todos' ? (
            <ul className="space-y-2">
              {todos.length === 0 ? (
                <li className="text-xs text-[var(--text-muted)]">
                  No todos for this session.
                </li>
              ) : (
                todos.map((todo, index) => (
                  <li
                    key={todo.id || index}
                    className="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] px-3 py-2 text-sm"
                  >
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={
                          todo.status === 'completed' || todo.status === 'done'
                            ? 'status-done'
                            : 'status-todo'
                        }
                      >
                        {todo.status || 'pending'}
                      </Badge>
                      <span>{todo.content || todo.text || todo.title}</span>
                    </div>
                  </li>
                ))
              )}
            </ul>
          ) : null}
        </ScrollArea>
      )}
    </aside>
  );
}
