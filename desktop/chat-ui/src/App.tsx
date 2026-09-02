import { useState, useRef, useCallback, useEffect, useMemo, useReducer } from 'react';
import { MessageList } from './MessageList';
import { InputBar } from './InputBar';
import { CatalogOverlay } from './CatalogOverlay';
import { SkillsCatalogOverlay } from './SkillsCatalogOverlay';
import { SkillDetailPage } from './SkillDetailPage';
import { HubSkillDetailPage } from './HubSkillDetailPage';
import { CronDetailPage } from './CronDetailPage';
import { SettingsPage, type SettingsPanelId } from './SettingsPage';
import {
  cancelChatRequest,
  createChatSession,
  updateChatSessionModel,
  openConnectionRequest,
} from './chat';
import type {
  AttachedContext,
  ChatMessage,
  ActivityStep,
  ChatModel,
  OutgoingAttachment,
  ConnectionRequestView,
  ReasoningEffort,
} from './types';
import { ANTHROPIC_CHAT_MODELS, chatModelLabel, CODEX_CHAT_MODELS } from './types';
import type { ShellCommand, ShellState } from './shell-protocol';
import { useBrowserShellHost } from './browser-shell-host';
import { hasNativeShell, postShellAction } from './shell-bridge';
import {
  chatNavigationTitle,
  createChatNavigationState,
  isChatSurfaceActive,
  reduceChatNavigation,
  resolveShellSessionSelection,
} from './chat-navigation-model';
import { sessionMessageKey } from './session-message-model';
import { useSessionMessages } from './use-session-messages';
import { useSessionStreamRegistry } from './use-session-stream-registry';
import { useChatResponseStream } from './use-chat-response-stream';
import { useSidecarResources } from './use-sidecar-resources';
import { useChatInputDrafts } from './use-chat-input-drafts';
import { BrowserSidebar } from './BrowserSidebar';
import { formatSessionSummary } from './session-format';

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        chatBridge?: { postMessage: (msg: unknown) => void };
      };
    };
    setSidecarPort?: (port: number) => void;
    __versoSidecarPort?: number;
    __versoSidecarToken?: string;
    __versoDraftApprovalToken?: string;
    __versoShellMode?: 'native' | 'browser';
    __versoPendingCatalogOpen?: boolean;
    __versoPendingSkillsCatalogOpen?: boolean;
    __versoPendingShellState?: ShellState | null;
    __versoPendingShellCommands?: ShellCommand[];
    __versoShellCommandReady?: boolean;
  }
}

export function App() {
  const isNativeShell = hasNativeShell();
  // The shell host is the only owner of sessions and selection. Swift drives
  // this snapshot in native mode; BrowserShellHost provides the same contract
  // during browser development.
  const [shellState, setShellState] = useState<ShellState | null>(
    () => (typeof window !== 'undefined' ? window.__versoPendingShellState ?? null : null),
  );
  const sessions = shellState?.sessions ?? [];
  const selectedSessionId = shellState?.selectedSessionId ?? null;
  const [navigation, dispatchNavigation] = useReducer(
    reduceChatNavigation,
    createChatNavigationState(
      Boolean(typeof window !== 'undefined' && window.__versoPendingCatalogOpen),
      Boolean(typeof window !== 'undefined' && window.__versoPendingSkillsCatalogOpen),
    ),
  );
  const isCatalogOpen = navigation.catalog === 'connections';
  const isSkillsCatalogOpen = navigation.catalog === 'skills';
  const selectedSkillSlug = navigation.page.kind === 'skill' ? navigation.page.slug : null;
  const selectedHubSkillIdentifier = navigation.page.kind === 'hub-skill'
    ? navigation.page.identifier
    : null;
  const selectedCronId = navigation.page.kind === 'cron' ? navigation.page.id : null;
  const isSettingsOpen = navigation.page.kind === 'settings';

  // The shell collapses the sessions sidebar while settings is open (the
  // settings rail replaces it). Posted on every transition — including the
  // initial mount, which lets a reloaded WebView reset stale shell state.
  useEffect(() => {
    postShellAction({ kind: 'settings-visibility', open: isSettingsOpen });
  }, [isSettingsOpen]);

  // Which panel settings should open on. Deep-links (the provider nudge) set
  // this before opening; it reverts to the default once settings closes so a
  // later gear-open lands on Account again.
  const [settingsInitialPanel, setSettingsInitialPanel] = useState<SettingsPanelId>('account');
  useEffect(() => {
    if (!isSettingsOpen) setSettingsInitialPanel('account');
  }, [isSettingsOpen]);

  const handleOpenProviderSettings = useCallback(() => {
    setSettingsInitialPanel('models');
    dispatchNavigation({ type: 'shell-command', command: { kind: 'open-settings' } });
  }, []);
  const activelyViewedSessionId = selectedSessionId && isChatSurfaceActive(navigation)
    ? selectedSessionId
    : null;
  const {
    currentDraft,
    setText: handleDraftTextChange,
    setAttached: handleDraftAttachedChange,
  } = useChatInputDrafts(selectedSessionId);
  // Reasoning effort for the next message. Sticky across sessions (matches the
  // global model/effort footer in Cursor/Claude). 'medium' mirrors the gateway
  // config default so the visible selection and actual behaviour line up.
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('medium');
  // Mirrors the active session's persisted model. A choice made before a
  // session exists is carried into that session when it is created.
  const [model, setModel] = useState<ChatModel | null>(null);
  const idCounter = useRef(0);
  const {
    streamingSessionIds: streamingSessions,
    startSessionStream: markSessionStreaming,
    finishSessionStream: markSessionNotStreaming,
    abortSessionStream,
    isSessionStreaming,
  } = useSessionStreamRegistry(activelyViewedSessionId);
  const {
    messagesBySession,
    isHydratingSession,
    sessionError,
    setSessionError,
    getCurrentSessionId,
    getCurrentSessionKey,
    updateSessionMessages,
    hydrateSession,
    adoptSession,
    resetPendingSession,
  } = useSessionMessages({
    isSessionStreaming,
    onSessionModelSelected: setModel,
  });
  const handleResourceError = useCallback((message: string) => setSessionError(message), [setSessionError]);
  const {
    connected,
    codexConnected,
    anthropicConnected,
    customModelStatus,
    connections,
    customConnectors,
    toolkitCatalog,
    catalogRefreshToken,
    connectingToolkitSlugs,
    setCodexConnected,
    refreshConnections,
    refreshModelStatus: refreshCodexStatus,
    bumpCatalogRefresh,
    pollConnectionRequest,
    connectToolkit: handleConnectToolkit,
    retryConnector,
    disconnectConnector,
  } = useSidecarResources({ onError: handleResourceError });
  const isLoadingSessions = connected && shellState === null;
  const availableModels = useMemo<readonly ChatModel[]>(() => {
    const models: ChatModel[] = [];
    if (customModelStatus?.connected && customModelStatus.model) models.push(customModelStatus.model);
    if (codexConnected === true) models.push(...CODEX_CHAT_MODELS);
    if (anthropicConnected === true) models.push(...ANTHROPIC_CHAT_MODELS);
    return models;
  }, [anthropicConnected, codexConnected, customModelStatus]);
  const defaultModel = useMemo<ChatModel | null>(() => {
    if (customModelStatus?.connected && customModelStatus.model) return customModelStatus.model;
    if (codexConnected === true) return CODEX_CHAT_MODELS[0];
    if (anthropicConnected === true) return ANTHROPIC_CHAT_MODELS[0];
    return null;
  }, [anthropicConnected, codexConnected, customModelStatus]);

  // First-run nudge pointing at Settings → Model providers. Only once every
  // provider status has resolved — an async-loading gap must not flash the
  // nudge at connected users on launch.
  const showProviderNudge = connected
    && codexConnected !== null
    && anthropicConnected !== null
    && customModelStatus !== null
    && availableModels.length === 0;

  // In browser mode this hook plays Swift's role: owns the sessions list,
  // dispatches `verso:shell-state` snapshots, and handles `verso:shell-action`
  // posts from `postShellAction`. No-op in native (Swift is the host).
  useBrowserShellHost({ isNativeShell, sidecarReady: connected });

  const handleCloseCatalog = useCallback(() => {
    dispatchNavigation({ type: 'close-connections-catalog' });
    postShellAction({ kind: 'catalog-closed' });
  }, []);

  const handleCloseSkillsCatalog = useCallback(() => {
    dispatchNavigation({ type: 'close-skills-catalog' });
    postShellAction({ kind: 'skills-catalog-closed' });
  }, []);

  const handleCloseCatalogs = useCallback(() => {
    dispatchNavigation({ type: 'close-catalogs' });
    postShellAction({ kind: 'catalog-closed' });
    postShellAction({ kind: 'skills-catalog-closed' });
  }, []);

  useEffect(() => {
    if (selectedSessionId !== null || !defaultModel) return;
    setModel((current) => {
      return current && availableModels.includes(current) ? current : defaultModel;
    });
  }, [availableModels, defaultModel, selectedSessionId]);

  // Intra-app `verso:select-session` event (currently fired by
  // `CronDetailPage`'s "Edit in Chat" after creating a fresh session). In
  // native mode we forward to Swift so its leftbar selection follows; in
  // browser mode we hydrate directly. Distinct from the now-removed
  // Swift-driven `verso:select-session` channel, which is replaced by
  // `verso:shell-state`.
  useEffect(() => {
    const onSelectSession = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: unknown }>).detail;
      const sessionId = typeof detail?.sessionId === 'string' && detail.sessionId.length > 0
        ? detail.sessionId
        : null;
      // postShellAction routes to Swift in native and to BrowserShellHost
      // in browser; both end up dispatching a fresh shellState snapshot.
      postShellAction({ kind: 'select-session', id: sessionId });
    };
    window.addEventListener('verso:select-session', onSelectSession as EventListener);
    return () => {
      window.removeEventListener('verso:select-session', onSelectSession as EventListener);
    };
  }, []);

  // Subscribe to the shell host's full state snapshot. Swift owns this in
  // native mode; `BrowserShellHost` (the hook above) owns it in browser
  // mode. Both push fresh state on every change.
  useEffect(() => {
    const onShellState = (event: Event) => {
      const detail = (event as CustomEvent<ShellState | null>).detail;
      setShellState(detail ?? null);
    };
    window.addEventListener('verso:shell-state', onShellState as EventListener);
    return () => {
      window.removeEventListener('verso:shell-state', onShellState as EventListener);
    };
  }, []);

  useEffect(() => {
    if (!shellState) return;
    const selection = resolveShellSessionSelection(shellState, getCurrentSessionId());
    // Model synchronization is independent from message hydration. On app
    // launch the message cache can already point at the selected session while
    // the model picker still contains the default from a different chat.
    if (selection.persistedModel !== undefined) setModel(selection.persistedModel);
    if (!selection.shouldHydrate) return;
    // Leaving overlays open while switching sessions is jarring — every
    // session click from the leftbar should land you in the chat surface.
    if (selection.id) {
      dispatchNavigation({ type: 'show-chat' });
      handleCloseCatalogs();
    }
    void hydrateSession(selection.id);
  }, [shellState, getCurrentSessionId, hydrateSession, handleCloseCatalogs]);

  useEffect(() => {
    const handleShellCommand = (event: Event) => {
      const command = (event as CustomEvent<ShellCommand>).detail;
      if (!command) return;
      dispatchNavigation({ type: 'shell-command', command });
    };
    window.addEventListener('verso:shell-command', handleShellCommand as EventListener);
    window.__versoShellCommandReady = true;
    const pending = window.__versoPendingShellCommands ?? [];
    window.__versoPendingShellCommands = [];
    for (const command of pending) {
      handleShellCommand(new CustomEvent<ShellCommand>('verso:shell-command', { detail: command }));
    }
    return () => {
      window.__versoShellCommandReady = false;
      window.removeEventListener('verso:shell-command', handleShellCommand as EventListener);
    };
  }, []);

  const handleSelectSkill = useCallback((slug: string) => {
    dispatchNavigation({ type: 'show-skill', slug });
    handleCloseSkillsCatalog();
  }, [handleCloseSkillsCatalog]);

  const handleSelectHubSkill = useCallback((identifier: string) => {
    dispatchNavigation({ type: 'show-hub-skill', identifier });
    handleCloseSkillsCatalog();
  }, [handleCloseSkillsCatalog]);

  const nextId = () => String(++idCounter.current);

  const ensureSession = useCallback(async () => {
    const currentSessionId = getCurrentSessionId();
    if (currentSessionId) return currentSessionId;
    // Create the session with the default title ('New chat'). Passing the
    // user's first message as a seed title would suppress the orchestrator's
    // AI-title generation, which only fires when the title is still the
    // default — that's the whole "name this chat after the first response"
    // feature. The leftbar will briefly show 'New chat' during streaming and
    // then refresh to the AI-generated title once the stream completes.
    const session = await createChatSession(undefined, model ?? defaultModel ?? undefined);
    return adoptSession(session, true);
  }, [adoptSession, defaultModel, getCurrentSessionId, model]);

  const handleNewChat = useCallback(() => {
    // Per-session streams: a new chat creates a fresh session, so it can't
    // conflict with anything that's already streaming. Only block on the
    // sidecar connection and on the in-flight hydrate (which would mid-air
    // the bucket migration in adoptSession).
    if (!connected || isHydratingSession) return;

    void (async () => {
      try {
        // A new chat does not inherit the active chat's model. In particular,
        // an old session may display a provider that is no longer connected.
        const session = await createChatSession(undefined, defaultModel ?? undefined);
        adoptSession(session, false);
      } catch (error: unknown) {
        setSessionError(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [adoptSession, connected, defaultModel, isHydratingSession]);

  const handleModelChange = useCallback((nextModel: ChatModel) => {
    setModel(nextModel);
    const sessionId = getCurrentSessionId();
    if (!sessionId) return;

    // Save on selection, rather than on the next send. This makes the choice
    // durable for empty sessions and prevents a reopen from switching a
    // conversation to a different provider.
    void updateChatSessionModel(sessionId, nextModel)
      .then(() => {
        postShellAction({ kind: 'session-mutated', id: sessionId });
      })
      .catch((error: unknown) => {
        setSessionError(error instanceof Error ? error.message : String(error));
      });
  }, [getCurrentSessionId]);

  const handleSelectSession = useCallback((sessionId: string) => {
    // Switching sessions while another is streaming is now first-class
    // behavior — the stream keeps running, the new session loads alongside.
    if (isHydratingSession || sessionId === selectedSessionId) return;
    // Route through the shell host so its sessions/selection state stays
    // authoritative — `BrowserShellHost` in browser, Swift in native. The
    // host dispatches a fresh shellState that the state subscriber picks up;
    // overlay clears happen there too.
    postShellAction({ kind: 'select-session', id: sessionId });
  }, [isHydratingSession, selectedSessionId]);

  const handleArchiveToggle = useCallback(() => {
    if (!selectedSessionId || isHydratingSession) return;
    // Archiving a session that's actively streaming would orphan the stream.
    // Block only when *this* session is the one streaming.
    if (streamingSessions.has(selectedSessionId)) return;

    const session = sessions.find((candidate) => candidate.id === selectedSessionId);
    if (!session) return;

    postShellAction({
      kind: session.archivedAt ? 'unarchive-session' : 'archive-session',
      id: selectedSessionId,
    });
  }, [isHydratingSession, selectedSessionId, sessions, streamingSessions]);

  const handleCodexAuthRequired = useCallback(() => setCodexConnected(false), []);
  const { streamInto } = useChatResponseStream({
    defaultModel,
    ensureSession,
    finishSessionStream: markSessionNotStreaming,
    getCurrentSessionKey,
    isNativeShell,
    model,
    onCodexAuthRequired: handleCodexAuthRequired,
    reasoningEffort,
    startSessionStream: markSessionStreaming,
    updateSessionMessages,
  });

  const handleSend = useCallback((text: string, attached: AttachedContext | null = null, attachments: OutgoingAttachment[] = []) => {
    const hasContent = text.trim().length > 0 || attached?.kind === 'cron' || attachments.length > 0;
    if (!hasContent || !connected) return;
    const selectedModel = model ?? defaultModel;
    if (!selectedModel) {
      setSessionError('Choose a model for this conversation before sending.');
      return;
    }
    if (!model) {
      setModel(selectedModel);
    }
    const providerUnavailable = selectedModel === customModelStatus?.model
      ? customModelStatus.connected === false
      : selectedModel.startsWith('claude-')
        ? anthropicConnected === false
        : codexConnected === false;
    if (providerUnavailable) {
      setSessionError(`${chatModelLabel(selectedModel)} is not currently connected. Choose an available model before sending.`);
      return;
    }

    const sessionKey = getCurrentSessionKey();
    // Per-session: block only if *this* session is already streaming. Other
    // sessions stream independently. Pending sessions (no id yet) are
    // pre-stream; let them through so the optimistic placeholder lands.
    const currentSessionId = getCurrentSessionId();
    if (currentSessionId && streamingSessions.has(currentSessionId)) return;

    let displayText = attached?.kind === 'cron' && text.trim().length === 0
      ? `[Reviewing routine: ${attached.name}]`
      : text;
    // Mirror the orchestrator's stored form (`appendAttachmentMarkers`) so the
    // optimistic message matches what a reload hydrates from the store.
    if (attachments.length > 0) {
      const markers = attachments
        .map((a) => (a.kind === 'document' ? `[attached document: ${a.name}]` : `[attached image: ${a.name}]`))
        .join('\n');
      displayText = displayText ? `${displayText}\n\n${markers}` : markers;
    }

    // If we know the user hasn't connected any provider yet, don't bother
    // hitting Hermes — it'll just error with a CLI-flavoured "no
    // credentials" message that doesn't help our users. Stash the user's
    // message on the synthetic widget so we can replay the send once they
    // finish auth. An Anthropic API key counts as connected: Claude models
    // route to it, and it may even be the default provider.
    if (codexConnected === false && anthropicConnected !== true && customModelStatus?.connected !== true) {
      const userMsg: ChatMessage = { id: nextId(), role: 'user', content: displayText };
      const widgetMsg: ChatMessage = {
        id: nextId(),
        role: 'assistant',
        content: '',
        kind: 'codex_connect_required',
        pendingText: text,
        pendingAttached: attached,
        pendingAttachments: attachments,
      };
      updateSessionMessages(sessionKey, (prev) => [...prev, userMsg, widgetMsg]);
      return;
    }

    const userMsg: ChatMessage = { id: nextId(), role: 'user', content: displayText };
    const assistantMsg: ChatMessage = {
      id: nextId(),
      role: 'assistant',
      content: '',
      steps: [],
      isStreaming: true,
      startedAt: Date.now(),
    };

    updateSessionMessages(sessionKey, (prev) => [...prev, userMsg, assistantMsg]);
    streamInto(assistantMsg.id, text, attached, attachments);
  }, [anthropicConnected, codexConnected, connected, customModelStatus, defaultModel, getCurrentSessionId, getCurrentSessionKey, model, streamInto, streamingSessions, updateSessionMessages]);

  const handleCodexConnected = useCallback((widgetId: string) => {
    setCodexConnected(true);
    const sessionKey = getCurrentSessionKey();
    const currentMessages = messagesBySession[sessionKey] ?? [];
    const widget = currentMessages.find((m) => m.id === widgetId && m.kind === 'codex_connect_required');
    const pendingText = widget?.pendingText ?? '';
    const pendingAttached = widget?.pendingAttached ?? null;
    const pendingAttachments = widget?.pendingAttachments ?? [];

    if (!pendingText && pendingAttachments.length === 0) {
      // Nothing to replay (shouldn't happen — handleSend always stashes text
      // before showing the widget). Just remove the widget.
      updateSessionMessages(sessionKey, (prev) => prev.filter((m) => m.id !== widgetId));
      return;
    }

    // Swap the widget for a fresh assistant placeholder and start streaming.
    // The user's original message stays in place above it, so the result
    // looks identical to a normal send.
    const assistantMsg: ChatMessage = {
      id: nextId(),
      role: 'assistant',
      content: '',
      steps: [],
      isStreaming: true,
      startedAt: Date.now(),
    };
    updateSessionMessages(sessionKey, (prev) => prev.map((m) => m.id === widgetId ? assistantMsg : m));
    streamInto(assistantMsg.id, pendingText, pendingAttached, pendingAttachments);
  }, [getCurrentSessionKey, messagesBySession, streamInto, updateSessionMessages]);

  const handleOpenSkillInNewSession = useCallback((slug: string) => {
    // Per-session streams: opens a brand new session, no conflict with
    // anything already streaming.
    if (!connected || isHydratingSession) return;

    resetPendingSession();
    postShellAction({ kind: 'select-session', id: null });
    dispatchNavigation({ type: 'show-chat' });
    handleCloseSkillsCatalog();
    const selectedAvailableModel = model && availableModels.includes(model) ? model : defaultModel;
    void (async () => {
      try {
        const session = await createChatSession(
          slug.replace(/-/g, ' '),
          selectedAvailableModel ?? undefined,
        );
        adoptSession(session, false);
        if (selectedAvailableModel) {
          handleSend(`/${slug}`);
        } else {
          setSessionError('Choose an available model before starting this skill conversation.');
        }
      } catch (error: unknown) {
        setSessionError(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [adoptSession, availableModels, connected, defaultModel, handleCloseSkillsCatalog, handleSend, isHydratingSession, model, resetPendingSession]);

  const handleStop = useCallback(() => {
    // Per-session streams: the Stop button is in the InputBar of the
    // currently-viewed session, so it stops *that* session's stream. Other
    // sessions' streams keep running.
    if (!selectedSessionId) return;
    if (!abortSessionStream(selectedSessionId)) return;
    void cancelChatRequest(selectedSessionId).catch(() => {});
    updateSessionMessages(selectedSessionId, (prev) => prev.map((message) =>
      message.isStreaming ? { ...message, isStreaming: false, endedAt: Date.now() } : message,
    ));
    markSessionNotStreaming(selectedSessionId);
  }, [abortSessionStream, markSessionNotStreaming, selectedSessionId, updateSessionMessages]);

  const handleConnect = useCallback((request: ConnectionRequestView) => {
    openConnectionRequest(request.id);
    // The connection step lives in the assistant message of whichever session
    // the user clicked from. Capture that bucket now so a later session switch
    // doesn't redirect the status update.
    const sessionKey = getCurrentSessionKey();
    pollConnectionRequest(request.id, (next) => {
      updateSessionMessages(sessionKey, (prev) => prev.map((message) => ({
        ...message,
        steps: updateConnectionSteps(message.steps, next),
      })));
    });
  }, [getCurrentSessionKey, pollConnectionRequest, updateSessionMessages]);

  const handleShowChat = useCallback(() => {
    dispatchNavigation({ type: 'show-chat' });
  }, []);

  const handleCloseSettings = useCallback(() => {
    handleShowChat();
    void refreshCodexStatus();
  }, [handleShowChat, refreshCodexStatus]);

  const handleSkillTitleResolved = useCallback((name: string | null) => {
    dispatchNavigation({ type: 'resolve-skill-name', name });
  }, []);

  const handleCronTitleResolved = useCallback((name: string | null) => {
    dispatchNavigation({ type: 'resolve-cron-name', name });
  }, []);

  const activeSessions = sessions.filter((session) => !session.archivedAt);
  const archivedSessions = sessions.filter((session) => !!session.archivedAt);
  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;
  // Render the bucket for the currently-selected session. Pre-creation drafts
  // live under the pending key; adoptSession migrates them on first send.
  const messages = messagesBySession[sessionMessageKey(selectedSessionId)] ?? [];

  // Header title is computed from the active view; the detail pages report
  // their resolved name via `onTitleResolved` so we don't double-fetch.
  // Reset the cached name when the active id clears so a stale name doesn't
  // flash on the next navigation.
  const headerTitle = chatNavigationTitle(navigation, selectedSession?.title ?? 'New chat');
  const headerSubtitle = !connected
    ? 'Connecting'
    : selectedSession?.archivedAt
      ? 'Archived. Restore this session to continue chatting.'
      : isHydratingSession
        ? 'Loading messages'
        : selectedSession
          ? formatSessionSummary(selectedSession)
          : isNativeShell
            ? 'Create a new chat in the sidebar or start typing.'
            : 'Start a new chat or resume an existing session';

  const mainPanel = (
    <main className="chat-panel">
      {isNativeShell && <ChatHeaderScaffold title={headerTitle} />}
      {!isNativeShell && !selectedSkillSlug && !selectedHubSkillIdentifier && !selectedCronId && !isSettingsOpen && (
        <div className="chat-toolbar">
          <div>
            <div className="chat-toolbar-title">{selectedSession?.title ?? 'New Chat'}</div>
            <div className="chat-toolbar-subtitle">{headerSubtitle}</div>
          </div>
          {selectedSession && (
            <button
              className="chat-toolbar-button"
              type="button"
              onClick={handleArchiveToggle}
              disabled={isHydratingSession || (selectedSessionId !== null && streamingSessions.has(selectedSessionId))}
            >
              {selectedSession.archivedAt ? 'Restore' : 'Archive'}
            </button>
          )}
        </div>
      )}

      {isSettingsOpen ? (
        <SettingsPage onBack={handleCloseSettings} initialPanel={settingsInitialPanel} />
      ) : selectedCronId ? (
        <CronDetailPage
          id={selectedCronId}
          onBack={handleShowChat}
          onTitleResolved={handleCronTitleResolved}
        />
      ) : selectedSkillSlug ? (
        <SkillDetailPage
          slug={selectedSkillSlug}
          onOpenInNewSession={handleOpenSkillInNewSession}
          onTitleResolved={handleSkillTitleResolved}
        />
      ) : selectedHubSkillIdentifier ? (
        <HubSkillDetailPage
          identifier={selectedHubSkillIdentifier}
          onTitleResolved={handleSkillTitleResolved}
        />
      ) : (
        <>
          <div className="chat-thread">
            <MessageList
              messages={messages}
              onConnect={handleConnect}
              connections={connections}
              onCodexConnected={handleCodexConnected}
              toolkitCatalog={toolkitCatalog}
            />
          </div>

          {showProviderNudge ? (
            <div className="provider-nudge">
              <div className="provider-nudge-card">
                <div className="provider-nudge-text">
                  <span className="provider-nudge-label">Connect a model provider</span>
                  <span className="provider-nudge-detail">
                    Chat needs a provider — Codex, Anthropic, or a custom endpoint.
                  </span>
                </div>
                <button
                  type="button"
                  className="settings-button settings-button-primary"
                  onClick={handleOpenProviderSettings}
                >
                  Open settings
                </button>
              </div>
            </div>
          ) : null}

          <InputBar
            text={currentDraft.text}
            attached={currentDraft.attached}
            onTextChange={handleDraftTextChange}
            onAttachedChange={handleDraftAttachedChange}
            onSend={handleSend}
            onStop={handleStop}
            reasoningEffort={reasoningEffort}
            onReasoningEffortChange={setReasoningEffort}
            model={model}
            onModelChange={handleModelChange}
            availableModels={availableModels}
            onModelMenuOpen={refreshCodexStatus}
            isStreaming={selectedSessionId !== null && streamingSessions.has(selectedSessionId)}
            disabled={!connected || isHydratingSession || !!selectedSession?.archivedAt}
            focusRecoveryEnabled={!isCatalogOpen && !isSkillsCatalogOpen}
          />
        </>
      )}
    </main>
  );

  const catalog = (
    <CatalogOverlay
      isOpen={isCatalogOpen}
      refreshToken={catalogRefreshToken}
      connectingToolkitSlugs={connectingToolkitSlugs}
      onClose={handleCloseCatalog}
      onConnect={handleConnectToolkit}
      onCustomConnectorAdded={() => {
        void refreshConnections();
        bumpCatalogRefresh();
      }}
    />
  );

  const skillsCatalog = (
    <SkillsCatalogOverlay
      isOpen={isSkillsCatalogOpen}
      onClose={handleCloseSkillsCatalog}
      onSelectSkill={handleSelectSkill}
      onSelectHubSkill={handleSelectHubSkill}
    />
  );

  if (isNativeShell) {
    return (
      <div className="chat-shell-native">
        {mainPanel}
        {catalog}
        {skillsCatalog}
      </div>
    );
  }

  return (
    <div className="app-shell">
      <BrowserSidebar
        activeSessions={activeSessions}
        archivedSessions={archivedSessions}
        connected={connected}
        customConnectors={customConnectors}
        isHydratingSession={isHydratingSession}
        isLoadingSessions={isLoadingSessions}
        onDisconnectConnector={disconnectConnector}
        onNewChat={handleNewChat}
        onRetryConnector={retryConnector}
        onSelectSession={handleSelectSession}
        selectedSessionId={selectedSessionId}
        sessionError={sessionError}
      />

      {mainPanel}
      {catalog}
      {skillsCatalog}
    </div>
  );
}

function ChatHeaderScaffold({ title }: { title?: string }) {
  return (
    <div className="chat-header-scaffold">
      <div className="chat-header-band-top" data-window-drag>
        {title && <span className="chat-header-title">{title}</span>}
      </div>
      {/* Second band (tabs) is hidden for launch — bring back when tabs ship.
      <div className="chat-header-band-tabs">
        <div className="chat-header-active-line" />
      </div>
      */}
    </div>
  );
}

function updateConnectionSteps(
  steps: ActivityStep[] | undefined,
  request: ConnectionRequestView,
): ActivityStep[] | undefined {
  if (!steps) return steps;
  return steps.map((step) => {
    if (step.type !== 'tool' || !step.connection) return step;
    if (step.connection.id !== request.id) return step;
    return {
      ...step,
      connection: request,
    };
  });
}
