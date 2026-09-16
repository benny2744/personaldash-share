'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { ArrowLeft, Send, Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { fetchJson } from '@/lib/fetcher';
import { cn } from '@/lib/utils';

const STATUS_VARIANT = {
  Active: 'status-active',
  Idea: 'status-backburner',
  Done: 'status-done',
};

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function ProjectDetailClient({ project, initialContent }) {
  const [content, setContent] = useState(initialContent || '');
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const scrollRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, sending]);

  const handleSend = async () => {
    const message = draft.trim();
    if (!message || sending) return;

    const userMsg = { role: 'user', text: message };
    setMessages((prev) => [...prev, userMsg]);
    setDraft('');
    setSending(true);
    setError(null);

    try {
      const result = await fetchJson(`/api/projects/${project.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      if (result.content) setContent(result.content);
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', text: result.reply || 'Note updated.' },
      ]);
    } catch (err) {
      setError(err.message || 'Failed to update note');
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', text: `Error: ${err.message || 'Failed to update note'}`, error: true },
      ]);
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex h-[calc(100vh-var(--header-height))] flex-col gap-4 overflow-hidden sm:gap-6">
      <div className="shrink-0">
        <Link
          href="/projects"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--primary)]"
        >
          <ArrowLeft size={16} />
          Back to Projects
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-bold tracking-tight text-[var(--text-primary)] sm:text-2xl">
            {project.title}
          </h1>
          <Badge variant={STATUS_VARIANT[project.status] || 'secondary'} pill>
            {project.status}
          </Badge>
          {project.area && (
            <span className="text-sm text-[var(--text-secondary)]">{project.area}</span>
          )}
          <span className="text-sm text-[var(--text-muted)]">
            Target: {formatDate(project.targetDate)}
          </span>
        </div>
      </div>

      <div className="flex flex-col overflow-hidden rounded-xl border border-[color:color-mix(in_srgb,var(--outline)_10%,transparent)] bg-[var(--surface-container-lowest)]">
        {(messages.length > 0 || sending) && (
          <div
            ref={scrollRef}
            className="max-h-32 space-y-2 overflow-auto border-b border-[color:color-mix(in_srgb,var(--outline)_10%,transparent)] px-4 py-3"
          >
            {messages.map((msg, idx) => (
              <div
                key={idx}
                className={cn(
                  'max-w-[85%] rounded-2xl px-3.5 py-2 text-sm',
                  msg.role === 'user'
                    ? 'ml-auto bg-[var(--primary)] text-white'
                    : msg.error
                      ? 'bg-[color:color-mix(in_srgb,var(--error-container)_30%,transparent)] text-[var(--on-error-container)]'
                      : 'bg-[var(--surface-container-high)] text-[var(--text-primary)]',
                )}
              >
                {msg.text}
              </div>
            ))}
            {sending && (
              <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                <Loader2 size={14} className="animate-spin" />
                Updating note…
              </div>
            )}
          </div>
        )}

        <div className="flex items-end gap-3 px-4 py-3">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Add an idea or todo… (Cmd/Ctrl+Enter to send)"
            rows={2}
            className="flex-1 resize-none rounded-lg border border-[color:color-mix(in_srgb,var(--outline)_10%,transparent)] bg-[var(--surface-container-low)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-b-2 focus:border-b-[var(--primary)] focus:ring-0"
          />
          <Button
            type="button"
            size="sm"
            onClick={handleSend}
            disabled={!draft.trim() || sending}
          >
            <Send size={14} />
            Send
          </Button>
        </div>
        {error && (
          <p className="-mt-1 px-4 pb-2 text-xs text-[var(--error)]">{error}</p>
        )}
      </div>

      <div className="flex-1 overflow-auto rounded-xl border border-[color:color-mix(in_srgb,var(--outline)_10%,transparent)] bg-[var(--surface-container-lowest)] p-5">
        <div className="markdown-prose">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
