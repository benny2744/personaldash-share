'use client';

import React, { useEffect, useState } from 'react';
import { FolderOpen, FolderTree, Search } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import ExchangeBrowser from '@/components/files/ExchangeBrowser';
import VaultBrowser from '@/components/files/VaultBrowser';
import VaultSearchBrowser from '@/components/files/VaultSearchBrowser';
import NotePreviewDrawer from '@/components/files/NotePreviewDrawer';

const TAB_VALUES = new Set(['exchange', 'browse', 'search']);
// 'vault' is the legacy ?tab= value, which pointed at search.
const TAB_ALIASES = { vault: 'search' };

/**
 * Unified file surface: exchange dir (upload/download materials + Hermes
 * outputs), the vault explorer table, and semantic vault search with note
 * previews. `?preview=<vault path>` deep-links straight into a note preview
 * drawer (chat messages link here from lib/hermes/markdownLinks.js).
 */
export default function FilesClient() {
  const [tab, setTab] = useState('exchange');
  const [previewPath, setPreviewPath] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = TAB_ALIASES[params.get('tab')] || params.get('tab');
    if (TAB_VALUES.has(requested)) setTab(requested);
    const preview = params.get('preview');
    if (preview) {
      setPreviewPath(preview);
      if (!TAB_VALUES.has(requested)) setTab('browse');
    }
  }, []);

  const closePreview = () => {
    setPreviewPath(null);
    // Drop ?preview from the URL so refresh doesn't reopen the drawer.
    const url = new URL(window.location.href);
    url.searchParams.delete('preview');
    window.history.replaceState(null, '', url);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="page-header">
        <h1>Files</h1>
        <p className="subtitle">
          Upload materials for AI workflows, browse the vault, and search it by
          meaning
        </p>
      </div>

      <Tabs className="flex flex-col">
        <TabsList className="shrink-0 self-start">
          <TabsTrigger
            active={tab === 'exchange'}
            onClick={() => setTab('exchange')}
          >
            <span className="flex items-center gap-1.5">
              <FolderOpen size={13} />
              Exchange
            </span>
          </TabsTrigger>
          <TabsTrigger
            active={tab === 'browse'}
            onClick={() => setTab('browse')}
          >
            <span className="flex items-center gap-1.5">
              <FolderTree size={13} />
              Vault Browse
            </span>
          </TabsTrigger>
          <TabsTrigger
            active={tab === 'search'}
            onClick={() => setTab('search')}
          >
            <span className="flex items-center gap-1.5">
              <Search size={13} />
              Vault Search
            </span>
          </TabsTrigger>
        </TabsList>
        <div className="flex min-h-0 flex-col pt-4">
          {tab === 'exchange' && <ExchangeBrowser />}
          {tab === 'browse' && <VaultBrowser />}
          {tab === 'search' && <VaultSearchBrowser />}
        </div>
      </Tabs>

      {previewPath && (
        <NotePreviewDrawer filepath={previewPath} onClose={closePreview} />
      )}
    </div>
  );
}
