'use client';

/**
 * components/settings/TerminalHostsCard.js — admin management of the web
 * terminal host registry: add/edit/disable hosts, assign user identities,
 * and enroll host-key fingerprints (explicit two-step; never auto-trusted).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Fingerprint, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

const EMPTY_FORM = {
  slug: '',
  displayName: '',
  sshHost: '',
  sshPort: '22',
  sshUser: '',
  credentialRef: 'default',
  allowedIdentities: '',
  hostKeySha256: '',
  enabled: true,
};

function toForm(host) {
  return {
    slug: host.slug,
    displayName: host.displayName,
    sshHost: host.sshHost,
    sshPort: String(host.sshPort),
    sshUser: host.sshUser,
    credentialRef: host.credentialRef,
    allowedIdentities: (host.allowedIdentities || []).join(', '),
    hostKeySha256: host.hostKeySha256 || '',
    enabled: host.enabled,
  };
}

export default function TerminalHostsCard() {
  const [hosts, setHosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [learningId, setLearningId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/terminal/hosts');
      const payload = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(payload.error || 'Failed to load hosts');
      setHosts(payload.hosts || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const startEdit = (host) => {
    setEditingId(host.id);
    setForm(toForm(host));
    setNotice(null);
    setError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
  };

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const body = {
        slug: form.slug,
        displayName: form.displayName,
        sshHost: form.sshHost,
        sshPort: Number(form.sshPort) || 22,
        sshUser: form.sshUser,
        credentialRef: form.credentialRef || 'default',
        allowedIdentities: form.allowedIdentities,
        hostKeySha256: form.hostKeySha256 || null,
        enabled: form.enabled,
      };
      const response = await fetch(
        editingId ? `/api/terminal/hosts/${editingId}` : '/api/terminal/hosts',
        {
          method: editingId ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Save failed');
      setNotice(editingId ? 'Host updated' : 'Host created');
      cancelEdit();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (host) => {
    if (!window.confirm(`Delete host '${host.slug}'? This cannot be undone.`))
      return;
    try {
      const response = await fetch(`/api/terminal/hosts/${host.id}`, {
        method: 'DELETE',
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Delete failed');
      if (editingId === host.id) cancelEdit();
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  /** Two-step enrollment: probe the fingerprint, show it, admin pins it. */
  const learnFingerprint = async (host) => {
    setLearningId(host.id);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/terminal/hosts/${host.id}/fingerprint`,
        { method: 'POST' },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Probe failed');
      setNotice(
        `Reported fingerprint for ${host.sshHost}: ${payload.fingerprint} — verify out-of-band, then paste it below and save.`,
      );
      setEditingId(host.id);
      setForm((current) =>
        current.slug === host.slug
          ? { ...current, hostKeySha256: payload.fingerprint }
          : current,
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setLearningId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            Terminal hosts
            <Badge variant="outline">{hosts.length}</Badge>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={load}
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </Button>
        </CardTitle>
        <CardDescription>
          SSH targets for the web terminal. Identities not in a host&apos;s
          allow-list are admins-only. Host-key fingerprints must be pinned
          before anyone can connect.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <p className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        {notice && (
          <p className="rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400 break-all">
            {notice}
          </p>
        )}

        <div className="space-y-2">
          {loading ? (
            <p className="text-xs text-[var(--text-secondary)]">Loading…</p>
          ) : hosts.length === 0 ? (
            <p className="text-xs text-[var(--text-secondary)]">
              No hosts registered yet — add the first one below.
            </p>
          ) : (
            hosts.map((host) => (
              <div
                key={host.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-[var(--text-primary)]">
                      {host.displayName}
                    </span>
                    {!host.enabled && (
                      <Badge variant="destructive">disabled</Badge>
                    )}
                    {!host.hostKeySha256 && (
                      <Badge variant="outline">unpinned</Badge>
                    )}
                    {editingId === host.id && (
                      <Badge variant="outline">editing</Badge>
                    )}
                  </div>
                  <p className="truncate text-xs text-[var(--text-secondary)]">
                    {host.sshUser}@{host.sshHost}:{host.sshPort} · key{' '}
                    {host.credentialRef} ·{' '}
                    {host.allowedIdentities?.length
                      ? host.allowedIdentities.join(', ')
                      : 'admins only'}
                  </p>
                  {host.hostKeySha256 && (
                    <p className="truncate font-mono text-[0.65rem] text-[var(--text-muted)]">
                      {host.hostKeySha256}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => learnFingerprint(host)}
                    disabled={learningId === host.id}
                    title="Probe the host's key fingerprint"
                  >
                    <Fingerprint size={14} />
                    {learningId === host.id ? 'Probing…' : 'Learn key'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => startEdit(host)}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => remove(host)}
                    className="text-red-600 dark:text-red-400"
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>

        <form
          onSubmit={save}
          className="space-y-3 rounded-lg border border-[var(--border)] p-3"
        >
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            {editingId ? 'Edit host' : 'Add host'}
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs">
              <span className="font-semibold text-[var(--text-secondary)]">
                Slug
              </span>
              <Input
                value={form.slug}
                onChange={(event) =>
                  setForm({ ...form, slug: event.target.value })
                }
                placeholder="student-vm-01"
                required
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="font-semibold text-[var(--text-secondary)]">
                Display name
              </span>
              <Input
                value={form.displayName}
                onChange={(event) =>
                  setForm({ ...form, displayName: event.target.value })
                }
                placeholder="Student VM 1"
                required
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="font-semibold text-[var(--text-secondary)]">
                SSH host
              </span>
              <Input
                value={form.sshHost}
                onChange={(event) =>
                  setForm({ ...form, sshHost: event.target.value })
                }
                placeholder="vm.example.com"
                required
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1 text-xs">
                <span className="font-semibold text-[var(--text-secondary)]">
                  Port
                </span>
                <Input
                  type="number"
                  min="1"
                  max="65535"
                  value={form.sshPort}
                  onChange={(event) =>
                    setForm({ ...form, sshPort: event.target.value })
                  }
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="font-semibold text-[var(--text-secondary)]">
                  SSH user
                </span>
                <Input
                  value={form.sshUser}
                  onChange={(event) =>
                    setForm({ ...form, sshUser: event.target.value })
                  }
                  placeholder="deploy"
                  required
                />
              </label>
            </div>
            <label className="space-y-1 text-xs">
              <span className="font-semibold text-[var(--text-secondary)]">
                Credential alias
              </span>
              <Select
                value={form.credentialRef}
                onChange={(event) =>
                  setForm({ ...form, credentialRef: event.target.value })
                }
                className="h-9 text-xs"
              >
                <option value="default">default</option>
              </Select>
            </label>
            <label className="space-y-1 text-xs">
              <span className="font-semibold text-[var(--text-secondary)]">
                Allowed identities
              </span>
              <Input
                value={form.allowedIdentities}
                onChange={(event) =>
                  setForm({ ...form, allowedIdentities: event.target.value })
                }
                placeholder="alice@example.com, bob@example.com (empty = admins only)"
              />
            </label>
            <label className="space-y-1 text-xs sm:col-span-2">
              <span className="font-semibold text-[var(--text-secondary)]">
                Host key fingerprint (SHA256:…)
              </span>
              <Input
                value={form.hostKeySha256}
                onChange={(event) =>
                  setForm({ ...form, hostKeySha256: event.target.value })
                }
                placeholder="SHA256:… — use “Learn key”, then verify out-of-band"
                className="font-mono text-xs"
              />
            </label>
          </div>
          <div className="flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) =>
                  setForm({ ...form, enabled: event.target.checked })
                }
              />
              Enabled
            </label>
            <div className="flex gap-2">
              {editingId && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={cancelEdit}
                >
                  Cancel
                </Button>
              )}
              <Button type="submit" size="sm" disabled={saving}>
                {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add host'}
                {!editingId && <Plus size={14} />}
              </Button>
            </div>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
