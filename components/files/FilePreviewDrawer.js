'use client';

import React, { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Download, Loader2 } from 'lucide-react';
import {
  isImageMime,
  isMarkdownPath,
  isTextPath,
} from '@/lib/hermes/filePreview';
import { isAudioPath, isPdfPath, isVideoPath } from '@/lib/files/previewTypes';
import PreviewDrawerShell from '@/components/files/PreviewDrawerShell';

const MARKDOWN_PROSE_CLASSES =
  'prose prose-sm max-w-none break-words prose-p:my-2 prose-pre:bg-[var(--surface-container-low)] prose-pre:text-[var(--text-primary)]';

const MilkdownEditor = dynamic(
  () => import('@/components/vault/MilkdownEditor'),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-64 items-center justify-center text-[var(--text-secondary)]">
        <Loader2 size={20} className="mr-2 animate-spin" />
        Loading preview...
      </div>
    ),
  },
);

/**
 * Read-only preview drawer for non-note files (text/markdown render via
 * Milkdown, other text via <pre>, images via object URL). `downloadBase`
 * picks the serving route: '/api/exchange/download' (default) or
 * '/api/vault/download'.
 */
export default function FilePreviewDrawer({
  file,
  onClose,
  downloadBase = '/api/exchange/download',
  subtitlePrefix = 'exchange/',
}) {
  const [state, setState] = useState({
    loading: true,
    error: null,
    text: '',
    objectUrl: null,
    mime: '',
  });
  const objectUrlRef = useRef(null);

  useEffect(() => {
    if (!file?.path) return undefined;
    const controller = new AbortController();
    setState({
      loading: true,
      error: null,
      text: '',
      objectUrl: null,
      mime: '',
    });

    // PDF/audio/video render straight from the download URL — the exchange
    // and vault download routes support HTTP Range, so players can stream
    // and seek without the drawer pulling the whole file as a blob.
    if (
      isPdfPath(file.name) ||
      isAudioPath(file.name) ||
      isVideoPath(file.name)
    ) {
      setState({
        loading: false,
        error: null,
        text: '',
        objectUrl: null,
        mime: '',
      });
      return undefined;
    }

    (async () => {
      try {
        const res = await fetch(
          `${downloadBase}?path=${encodeURIComponent(file.path)}`,
          { signal: controller.signal },
        );
        if (!res.ok) throw new Error('Unable to load file');
        const mime = res.headers.get('content-type') || '';
        if (isImageMime(mime)) {
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          if (controller.signal.aborted) {
            URL.revokeObjectURL(url);
            return;
          }
          objectUrlRef.current = url;
          setState({
            loading: false,
            error: null,
            text: '',
            objectUrl: url,
            mime,
          });
        } else {
          const text = await res.text();
          if (controller.signal.aborted) return;
          setState({
            loading: false,
            error: null,
            text,
            objectUrl: null,
            mime,
          });
        }
      } catch (err) {
        if (err.name === 'AbortError') return;
        setState((prev) => ({ ...prev, loading: false, error: err.message }));
      }
    })();

    return () => {
      controller.abort();
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [file?.path, file.name, downloadBase]);

  if (!file?.path) return null;

  const markdown = isMarkdownPath(file.name) || state.mime === 'text/markdown';
  const directUrl = `${downloadBase}?path=${encodeURIComponent(file.path)}`;
  const isPdf = isPdfPath(file.name);
  const isAudio = isAudioPath(file.name);
  const isVideo = isVideoPath(file.name);

  let mediaContent = null;
  if (!state.loading && !state.error) {
    if (isPdf) {
      mediaContent = (
        <iframe
          src={directUrl}
          title={file.name}
          className="h-[68vh] min-h-[20rem] w-full rounded-lg border border-[color:color-mix(in_srgb,var(--outline)_30%,transparent)] bg-white"
        />
      );
    } else if (isVideo) {
      mediaContent = (
        <video
          controls
          src={directUrl}
          className="mx-auto max-h-[68vh] w-full rounded-lg"
        />
      );
    } else if (isAudio) {
      mediaContent = (
        <div className="flex h-40 items-center justify-center">
          <audio controls src={directUrl} className="w-full max-w-md" />
        </div>
      );
    }
  }

  return (
    <PreviewDrawerShell
      title={file.name}
      subtitle={`${subtitlePrefix}${file.path}`}
      onClose={onClose}
      actions={
        <a
          href={directUrl}
          download={file.name}
          aria-label="Download file"
          title={`Download ${file.name}`}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-secondary)] transition-all hover:bg-[var(--surface-container-high)] hover:text-[var(--text-primary)]"
        >
          <Download size={18} />
        </a>
      }
      content={
        state.loading ? (
          <div className="flex h-64 items-center justify-center text-[var(--text-secondary)]">
            <Loader2 size={20} className="mr-2 animate-spin" />
            Loading file...
          </div>
        ) : state.error ? (
          <p className="rounded-lg bg-[var(--error-container)]/20 p-4 text-sm text-[var(--on-error-container)]">
            {state.error}
          </p>
        ) : mediaContent ? (
          mediaContent
        ) : state.objectUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={state.objectUrl}
            alt={file.name}
            className="mx-auto max-w-full rounded-lg object-contain"
          />
        ) : markdown ? (
          <MilkdownEditor content={state.text} readOnly compact />
        ) : isTextPath(file.name) || state.mime.startsWith('text/') ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px]">
            {state.text}
          </pre>
        ) : (
          <div className={MARKDOWN_PROSE_CLASSES}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {state.text}
            </ReactMarkdown>
          </div>
        )
      }
    />
  );
}
