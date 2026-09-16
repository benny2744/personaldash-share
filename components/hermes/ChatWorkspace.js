'use client';

import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DEFAULT_PANEL_STATE,
  loadPanelState,
  savePanelState,
} from '@/lib/hermes/panelState';
import { cn } from '@/lib/utils';
import DingTalkClient from '@/components/dingtalk/DingTalkClient';
import ActivityDock from './ActivityDock';
import Composer from './Composer';
import PromptDialogs from './PromptDialogs';
import SessionSidebar from './SessionSidebar';
import Transcript from './Transcript';
import WorkspacePanel from './WorkspacePanel';

function useMediaQuery(query) {
  const [matches, setMatches] = useState(false);
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export default function ChatWorkspace({ chat, isOnline }) {
  const searchParams = useSearchParams();
  const initialChatMode = searchParams.get('chatMode');
  const initialDingTalkConversationId = searchParams.get('c');

  const [panels, setPanels] = useState(DEFAULT_PANEL_STATE);
  const [hydrated, setHydrated] = useState(false);
  const [mobileSessionsOpen, setMobileSessionsOpen] = useState(false);
  const [mobileWorkspaceOpen, setMobileWorkspaceOpen] = useState(false);
  const isTablet = useMediaQuery('(max-width: 900px)');
  const isMobile = useMediaQuery('(max-width: 640px)');

  useEffect(() => {
    const loaded = loadPanelState();
    if (initialChatMode === 'dingtalk' || initialChatMode === 'hermes') {
      loaded.chatMode = initialChatMode;
    }
    setPanels(loaded);
    setHydrated(true);
  }, [initialChatMode]);

  useEffect(() => {
    if (hydrated) savePanelState(panels);
  }, [panels, hydrated]);

  const showSessions = useMemo(() => {
    if (!hydrated || isMobile || isTablet) return false;
    return panels.sessionsOpen;
  }, [hydrated, isMobile, isTablet, panels.sessionsOpen]);

  const showWorkspace = useMemo(() => {
    if (!hydrated || isMobile || isTablet) return false;
    return panels.workspaceOpen;
  }, [hydrated, isMobile, isTablet, panels.workspaceOpen]);

  const centerMinWidth = 420;
  const chatMode = panels.chatMode || 'hermes';
  const setChatMode = (chatMode) =>
    setPanels((current) => ({ ...current, chatMode }));

  if (hydrated && chatMode === 'dingtalk') {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--background)]">
        <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-container-low)]/80 px-3 py-2 backdrop-blur-xl">
          <TabsList>
            <TabsTrigger onClick={() => setChatMode('hermes')}>
              Hermes
            </TabsTrigger>
            <TabsTrigger active onClick={() => setChatMode('dingtalk')}>
              DingTalk
            </TabsTrigger>
          </TabsList>
          <div className="ml-auto text-xs text-[var(--text-muted)]">
            {isOnline ? 'Online' : 'Offline'}
          </div>
        </div>
        <DingTalkClient sidebarWidth={panels.sessionsWidth} initialActiveId={initialDingTalkConversationId} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--background)]">
      <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-container-low)]/80 px-3 py-2 backdrop-blur-xl">
        <TabsList>
          <TabsTrigger active onClick={() => setChatMode('hermes')}>
            Hermes
          </TabsTrigger>
          <TabsTrigger onClick={() => setChatMode('dingtalk')}>
            DingTalk
          </TabsTrigger>
        </TabsList>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (isMobile || isTablet) {
              setMobileSessionsOpen(true);
            } else {
              setPanels((current) => ({
                ...current,
                sessionsOpen: !current.sessionsOpen,
              }));
            }
          }}
        >
          {showSessions ? (
            <PanelLeftClose size={16} />
          ) : (
            <PanelLeftOpen size={16} />
          )}
          Sessions
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (isMobile || isTablet) {
              setMobileWorkspaceOpen(true);
            } else {
              setPanels((current) => ({
                ...current,
                workspaceOpen: !current.workspaceOpen,
              }));
            }
          }}
        >
          {showWorkspace ? (
            <PanelRightClose size={16} />
          ) : (
            <PanelRightOpen size={16} />
          )}
          Workspace
        </Button>
        <div className="ml-auto text-xs text-[var(--text-muted)]">
          {isOnline ? 'Online' : 'Offline'}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {showSessions ? (
          <>
            <SessionSidebar
              className="shrink-0"
              style={{ width: panels.sessionsWidth }}
              sessions={chat.sessions}
              loading={chat.sessionsLoading}
              error={chat.sessionsError}
              activeId={chat.state.storedSessionId || chat.state.liveSessionId}
              query={chat.query}
              onQueryChange={chat.setQuery}
              onSearch={() => chat.refreshSessions(chat.query)}
              onNew={() => chat.createSession()}
              onSelect={(id) => chat.resumeSession(id)}
              onRename={chat.renameSession}
              onDelete={chat.removeSession}
              pinnedIds={chat.pinnedIds}
              onTogglePin={chat.togglePin}
              searching={chat.searching}
              profiles={chat.profiles}
              activeProfile={chat.profile}
              onSelectProfile={chat.selectProfile}
            />
            <div
              className="hidden w-1 cursor-col-resize bg-transparent hover:bg-[var(--accent-muted)] md:block"
              onMouseDown={(event) => {
                event.preventDefault();
                const startX = event.clientX;
                const startWidth = panels.sessionsWidth;
                function onMove(moveEvent) {
                  const next = startWidth + (moveEvent.clientX - startX);
                  setPanels((current) => ({
                    ...current,
                    sessionsWidth: Math.min(420, Math.max(200, next)),
                  }));
                }
                function onUp() {
                  window.removeEventListener('mousemove', onMove);
                  window.removeEventListener('mouseup', onUp);
                }
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
              }}
            />
          </>
        ) : null}

        <div
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          style={{
            minWidth:
              hydrated && !isMobile && !isTablet ? centerMinWidth : undefined,
          }}
        >
          {chat.bootstrapError ? (
            <div className="border-b border-[var(--error)]/30 bg-[color:color-mix(in_srgb,var(--error-container)_18%,transparent)] px-4 py-3 text-sm text-[var(--on-error-container)]">
              {chat.bootstrapError}
            </div>
          ) : null}
          <Transcript
            messages={chat.state.messages}
            tools={chat.state.tools}
            title={chat.state.title}
            model={chat.state.model}
            connectionState={chat.state.connectionState}
            error={chat.state.error}
            sessionKey={
              chat.state.liveSessionId || chat.state.storedSessionId || ''
            }
          />
          <PromptDialogs
            approval={chat.state.approval}
            clarify={chat.state.clarify}
            sudo={chat.state.sudo}
            secret={chat.state.secret}
            onApproval={chat.respondApproval}
            onClarify={chat.respondClarify}
            onSecret={chat.respondSecret}
          />
          <Composer
            value={chat.draft}
            onChange={chat.updateDraft}
            onSend={chat.sendMessage}
            onStop={chat.stop}
            running={chat.state.running}
            disabled={Boolean(chat.bootstrapError)}
            offline={!isOnline}
            statusText={chat.state.statusText}
            models={chat.models}
            currentModel={chat.currentModel}
            currentTier={chat.currentTier}
            pendingModel={chat.pendingModel}
            modelsLoading={chat.modelsLoading}
            modelSwitching={chat.modelSwitching}
            onSwitchModel={chat.switchModel}
          />
        </div>

        {showWorkspace ? (
          <>
            <div
              className="hidden w-1 cursor-col-resize bg-transparent hover:bg-[var(--accent-muted)] md:block"
              onMouseDown={(event) => {
                event.preventDefault();
                const startX = event.clientX;
                const startWidth = panels.workspaceWidth;
                function onMove(moveEvent) {
                  const next = startWidth - (moveEvent.clientX - startX);
                  setPanels((current) => ({
                    ...current,
                    workspaceWidth: Math.min(520, Math.max(220, next)),
                  }));
                }
                function onUp() {
                  window.removeEventListener('mousemove', onMove);
                  window.removeEventListener('mouseup', onUp);
                }
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
              }}
            />
            <WorkspacePanel
              className="shrink-0"
              style={{ width: panels.workspaceWidth }}
              tab={panels.workspaceTab}
              onTabChange={(workspaceTab) =>
                setPanels((current) => ({ ...current, workspaceTab }))
              }
              artifacts={chat.state.artifacts}
              todos={chat.state.todos}
              runtime={chat.runtime}
            />
          </>
        ) : null}
      </div>

      <ActivityDock
        open={panels.activityOpen}
        height={panels.activityHeight}
        onToggle={() =>
          setPanels((current) => ({
            ...current,
            activityOpen: !current.activityOpen,
          }))
        }
        activity={chat.state.activity}
        statusText={chat.state.statusText}
      />

      {mobileSessionsOpen ? (
        <div className="fixed inset-0 z-[60]">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="Close sessions"
            onClick={() => setMobileSessionsOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 w-[min(320px,90vw)] bg-[var(--surface-card)] shadow-xl">
            <SessionSidebar
              className="h-full"
              sessions={chat.sessions}
              loading={chat.sessionsLoading}
              error={chat.sessionsError}
              activeId={chat.state.storedSessionId || chat.state.liveSessionId}
              query={chat.query}
              onQueryChange={chat.setQuery}
              onSearch={() => chat.refreshSessions(chat.query)}
              onNew={async () => {
                await chat.createSession();
                setMobileSessionsOpen(false);
              }}
              onSelect={async (id) => {
                await chat.resumeSession(id);
                setMobileSessionsOpen(false);
              }}
              onRename={chat.renameSession}
              onDelete={chat.removeSession}
              pinnedIds={chat.pinnedIds}
              onTogglePin={chat.togglePin}
              searching={chat.searching}
              profiles={chat.profiles}
              activeProfile={chat.profile}
              onSelectProfile={chat.selectProfile}
            />
          </div>
        </div>
      ) : null}

      {mobileWorkspaceOpen ? (
        <div className="fixed inset-0 z-[60]">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="Close workspace"
            onClick={() => setMobileWorkspaceOpen(false)}
          />
          <div className="absolute inset-y-0 right-0 w-[min(360px,92vw)] bg-[var(--surface-card)] shadow-xl">
            <WorkspacePanel
              className="h-full"
              tab={panels.workspaceTab}
              onTabChange={(workspaceTab) =>
                setPanels((current) => ({ ...current, workspaceTab }))
              }
              artifacts={chat.state.artifacts}
              todos={chat.state.todos}
              runtime={chat.runtime}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
