'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export default function SetupAssistant() {
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content:
        'Let’s set up your dashboard together. Tell me your name, what matters to you, or which feature you want to configure. If you need an AI connection, open the secure connection form below.',
    },
  ]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState(false);
  const [provider, setProvider] = useState({
    baseUrl: '',
    model: '',
    apiKey: '',
  });
  const [error, setError] = useState('');

  async function send(event) {
    event.preventDefault();
    if (!draft.trim() || busy) return;
    const next = [...messages, { role: 'user', content: draft.trim() }];
    setMessages(next);
    setDraft('');
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/setup/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next.slice(-30) }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error);
      setMessages([...next, { role: 'assistant', content: result.text }]);
      if (result.needsProvider) setConnection(true);
      window.dispatchEvent(new Event('settings-updated'));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function connect(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/setup/provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(provider),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error);
      setProvider({ ...provider, apiKey: '' });
      setConnection(false);
      setMessages([
        ...messages,
        {
          role: 'assistant',
          content:
            'Your AI connection is working and saved. What name should I use for you, and what timezone are you in?',
        },
      ]);
      window.dispatchEvent(new Event('settings-updated'));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Configure with AI</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-[var(--text-muted)]">
          This conversation stays in this page’s memory. Put API keys in the
          secure connection form, never in chat.
        </p>
        <div className="max-h-96 space-y-3 overflow-auto" aria-live="polite">
          {messages.map((m, i) => (
            <div
              key={i}
              className={`rounded-lg p-3 text-sm whitespace-pre-wrap ${m.role === 'user' ? 'bg-[var(--surface-container-high)]' : 'bg-[var(--surface-container-low)]'}`}
            >
              <strong>{m.role === 'user' ? 'You' : 'Setup assistant'}</strong>
              <p>{m.content}</p>
            </div>
          ))}
        </div>
        <form onSubmit={send} className="flex gap-2">
          <Input
            aria-label="Configuration message"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Use my name Alex; I care about…"
            disabled={busy}
          />
          <Button type="submit" disabled={busy || !draft.trim()}>
            {busy ? 'Working…' : 'Send'}
          </Button>
        </form>
        <Button variant="secondary" onClick={() => setConnection(!connection)}>
          AI connection
        </Button>
        {connection && (
          <form onSubmit={connect} className="space-y-2">
            <Input
              aria-label="AI server URL"
              placeholder="https://api.openai.com/v1"
              value={provider.baseUrl}
              onChange={(e) =>
                setProvider({ ...provider, baseUrl: e.target.value })
              }
            />
            <Input
              aria-label="AI model"
              placeholder="Model name"
              value={provider.model}
              onChange={(e) =>
                setProvider({ ...provider, model: e.target.value })
              }
            />
            <Input
              aria-label="AI API key"
              type="password"
              autoComplete="off"
              placeholder="API key (never added to chat)"
              value={provider.apiKey}
              onChange={(e) =>
                setProvider({ ...provider, apiKey: e.target.value })
              }
            />
            <Button type="submit" disabled={busy}>
              Test and save connection
            </Button>
          </form>
        )}
        {error && (
          <p role="alert" className="text-sm text-[var(--error)]">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
