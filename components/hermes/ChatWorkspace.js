'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import DingTalkClient from '@/components/dingtalk/DingTalkClient';
import ActivityDock from './ActivityDock';
import Composer from './Composer';
import PromptDialogs from './PromptDialogs';
import SessionSidebar from './SessionSidebar';
import Transcript from './Transcript';
import WorkspacePanel from './WorkspacePanel';

export default function ChatWorkspace({ chat, isOnline }) {
  const searchParams = useSearchParams();
  const initialChatMode = searchParams.get('chatMode');
  const initialDingTalkConversationId = searchParams.get('c');

  const [panels, setPanels] = useState(DEFAULT_PANEL_STATE);
  const [hydrated, setHydrated] = useState(false);
  const [mobileSessionsOpen, setMobileSessionsOpen] = useState(false);
  const [mobileWorkspaceOpen, setMobileWorkspaceOpen] = useState(false);
  const frameRef = useRef(null);
  const [frameWidth, setFrameWidth] = useState(0);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(([entry]) =>
      setFrameWidth(entry.contentRect.width),
    );
    observer.observe(frame);
    return () => observer.disconnect();
  }, [panels.chatMode, hydrated]);

  useEffect(() => {
    const loaded = loadPanelState();
    if (
      initialChatMode === 'dingtalk' ||
      initialChatMode === 'hermes'
    ) {
      loaded.chatMode = initialChatMode;
    }
    setPanels(loaded);
    setHydrated(true);
  }, [initialChatMode]);

  useEffect(() => {
    if (hydrated) savePanelState(panels);
  }, [panels, hydrated]);

  const centerMinWidth = 420;
  const dividerWidth = 4;
  const canDockSessions =
    hydrated &&
    frameWidth >= centerMinWidth + panels.sessionsWidth + dividerWidth;
  const showSessions = canDockSessions && panels.sessionsOpen;
  const canDockWorkspace =
    hydrated &&
    frameWidth >=
      centerMinWidth +
        panels.workspaceWidth +
        dividerWidth +
        (showSessions ? panels.sessionsWidth + dividerWidth : 0);
  const showWorkspace = canDockWorkspace && panels.workspaceOpen;
  const chatMode = panels.chatMode || 'hermes';

  const setChatMode = (chatMode) =>
    setPanels((current) => ({ ...current, chatMode }));

  if (hydrated && chatMode === 'dingtalk') {
    return (
      <div
        ref={frameRef}
        data-layout="chat-frame"
        className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--background)]"
      >
        <div
          data-layout="chat-toolbar"
          className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--border)] bg-[var(--surface-container-low)]/80 px-3 py-2 backdrop-blur-xl"
        >
          <TabsList>
            <TabsTrigger onClick={() => setChatMode('hermes')}>
              Hermes
            </TabsTrigger>
            <TabsTrigger active onClick={() => setChatMode('dingtalk')}>
              DingTalk
            </TabsTrigger>
          </TabsList>
          <div className="ml-auto shrink-0 text-xs text-[var(--text-muted)]">
            {isOnline ? 'Online' : 'Offline'}
          </div>
        </div>
        <DingTalkClient
          sidebarWidth={panels.sessionsWidth}
          initialActiveId={initialDingTalkConversationId}
        />
      </div>
    );
  }

  return (
    <div
      ref={frameRef}
      data-layout="chat-frame"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--background)]"
    >
      <div
        data-layout="chat-toolbar"
        className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--border)] bg-[var(--surface-container-low)]/80 px-3 py-2 backdrop-blur-xl"
      >
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
          className="shrink-0 px-2 sm:px-3"
          aria-label="Sessions"
          title="Sessions"
          onClick={() => {
            if (!canDockSessions) {
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
          <span className="hidden sm:inline">Sessions</span>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0 px-2 sm:px-3"
          aria-label="Workspace"
          title="Workspace"
          onClick={() => {
            if (!canDockWorkspace) {
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
          <span className="hidden sm:inline">Workspace</span>
        </Button>
        <div className="ml-auto shrink-0 text-xs text-[var(--text-muted)]">
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
              className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-[var(--accent-muted)]"
              onMouseDown={(event) => {
                event.preventDefault();
                const startX = event.clientX;
                const startWidth = panels.sessionsWidth;
                function onMove(moveEvent) {
                  const next = startWidth + (moveEvent.clientX - startX);
                  setPanels((current) => ({
                    ...current,
                    sessionsWidth: Math.min(
                      420,
                      frameWidth -
                        centerMinWidth -
                        dividerWidth -
                        (showWorkspace
                          ? panels.workspaceWidth + dividerWidth
                          : 0),
                      Math.max(200, next),
                    ),
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
              showSessions || showWorkspace ? centerMinWidth : undefined,
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
              className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-[var(--accent-muted)]"
              onMouseDown={(event) => {
                event.preventDefault();
                const startX = event.clientX;
                const startWidth = panels.workspaceWidth;
                function onMove(moveEvent) {
                  const next = startWidth - (moveEvent.clientX - startX);
                  setPanels((current) => ({
                    ...current,
                    workspaceWidth: Math.min(
                      520,
                      frameWidth -
                        centerMinWidth -
                        dividerWidth -
                        (showSessions
                          ? panels.sessionsWidth + dividerWidth
                          : 0),
                      Math.max(220, next),
                    ),
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
              usage={chat.state.usage}
              usageBaseline={chat.state.usageBaseline}
              coldStats={chat.state.coldStats}
              running={chat.state.running}
              statsOpen={panels.statsOpen}
              onStatsToggle={() =>
                setPanels((current) => ({
                  ...current,
                  statsOpen: !current.statsOpen,
                }))
              }
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
              usage={chat.state.usage}
              usageBaseline={chat.state.usageBaseline}
              coldStats={chat.state.coldStats}
              running={chat.state.running}
              statsOpen={panels.statsOpen}
              onStatsToggle={() =>
                setPanels((current) => ({
                  ...current,
                  statsOpen: !current.statsOpen,
                }))
              }
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
