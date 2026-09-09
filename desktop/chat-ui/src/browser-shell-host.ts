// Browser-mode equivalent of the Swift shell. When `npm run dev` runs the
// chat-ui outside Verso.app, this hook plays Swift's role: owns the sessions
// list + current selection, dispatches `verso:shell-state` snapshots, and
// handles `verso:shell-action` posts from `postShellAction`. After this is
// installed, the chat-ui's shellState pipeline drives both native and
// browser modes identically.
//
// No-op in native — `isNativeShell` short-circuits everything so Swift
// remains the sole driver there.

import { useEffect, useRef } from 'react';
import type { ChatSessionSummary } from './types';
import type { ShellAction, ShellState } from './shell-protocol';
import {
  archiveChatSession,
  createChatSession,
  getChatSessions,
  unarchiveChatSession,
} from './chat';

const BROWSER_SELECTED_SESSION_KEY = 'verso.chat.sessionId';

export interface UseBrowserShellHostOptions {
  isNativeShell: boolean;
  sidecarReady: boolean;
}

export function useBrowserShellHost(opts: UseBrowserShellHostOptions): void {
  const sessionsRef = useRef<ChatSessionSummary[]>([]);
  const selectedRef = useRef<string | null>(null);
  // Whether we've fired the initial snapshot. Sidecar can come up before the
  // hook mounts (Vite HMR), so we both fetch on mount and react to changes.
  const initializedRef = useRef(false);

  const dispatchShellState = () => {
    const detail: ShellState = {
      accountId: null,
      sessions: sessionsRef.current,
      selectedSessionId: selectedRef.current,
    };
    window.__versoPendingShellState = detail;
    window.dispatchEvent(new CustomEvent<ShellState>('verso:shell-state', { detail }));
  };

  const refreshSessions = async (): Promise<ChatSessionSummary[]> => {
    try {
      const next = sortSessions(await getChatSessions());
      sessionsRef.current = next;
      // If our remembered selection no longer exists, fall back to the
      // most-recent active session (same heuristic Swift uses).
      if (selectedRef.current && !next.some((s) => s.id === selectedRef.current)) {
        selectedRef.current = next.find((s) => !s.archivedAt)?.id ?? next[0]?.id ?? null;
        writePersistedSelection(selectedRef.current);
      }
      dispatchShellState();
      return next;
    } catch {
      return sessionsRef.current;
    }
  };

  // Initial fetch as soon as the sidecar is reachable.
  useEffect(() => {
    if (opts.isNativeShell) return;
    if (!opts.sidecarReady) return;
    if (initializedRef.current) return;
    initializedRef.current = true;
    selectedRef.current = readPersistedSelection();
    // Eager-dispatch the persisted selection so the chat-ui can immediately
    // render the right header while the fetch is in flight.
    dispatchShellState();
    void (async () => {
      const next = await refreshSessions();
      // After we have the list, if there's still no selection, pick the first
      // active session — mirrors Swift's `hasCompletedInitialSelection` path.
      if (!selectedRef.current) {
        selectedRef.current = next.find((s) => !s.archivedAt)?.id ?? next[0]?.id ?? null;
        writePersistedSelection(selectedRef.current);
        dispatchShellState();
      }
    })();
  }, [opts.isNativeShell, opts.sidecarReady]);

  // Handle JS→host actions in browser mode. `postShellAction` dispatches a
  // `verso:shell-action` CustomEvent when there's no native chatBridge, and
  // we route each kind to the orchestrator the way Swift would.
  useEffect(() => {
    if (opts.isNativeShell) return;
    const handle = async (event: Event) => {
      const action = (event as CustomEvent<ShellAction>).detail;
      if (!action) return;
      await handleAction(action);
    };
    const handleAction = async (action: ShellAction): Promise<void> => {
      switch (action.kind) {
        case 'select-session': {
          if (selectedRef.current === action.id) return;
          selectedRef.current = action.id;
          writePersistedSelection(action.id);
          // If we don't know this session yet (e.g., JS just created it via
          // `createChatSession` and `adoptSession` posted us a select before
          // we'd refreshed), pull a fresh list so the snapshot includes the
          // new row. `refreshSessions` dispatches.
          if (action.id && !sessionsRef.current.some((s) => s.id === action.id)) {
            await refreshSessions();
          } else {
            dispatchShellState();
          }
          return;
        }
        case 'create-session': {
          try {
            const session = await createChatSession();
            sessionsRef.current = sortSessions(replaceSession(sessionsRef.current, session));
            selectedRef.current = session.id;
            writePersistedSelection(session.id);
            dispatchShellState();
          } catch {
            // Swallow — App's catch path on its own createChatSession call
            // would surface the user-visible error.
          }
          return;
        }
        case 'archive-session': {
          try {
            const session = await archiveChatSession(action.id);
            sessionsRef.current = sortSessions(replaceSession(sessionsRef.current, session));
            if (selectedRef.current === action.id) {
              selectedRef.current = null;
              writePersistedSelection(null);
            }
            dispatchShellState();
          } catch {
            // ignore
          }
          return;
        }
        case 'unarchive-session': {
          try {
            const session = await unarchiveChatSession(action.id);
            sessionsRef.current = sortSessions(replaceSession(sessionsRef.current, session));
            selectedRef.current = session.id;
            writePersistedSelection(session.id);
            dispatchShellState();
          } catch {
            // ignore
          }
          return;
        }
        case 'rename-session': {
          // Renames are driven from Swift's leftbar today; chat-ui doesn't
          // expose UI for it. Refresh on receipt so any out-of-band change
          // still surfaces.
          await refreshSessions();
          return;
        }
        case 'session-mutated': {
          await refreshSessions();
          return;
        }
        case 'open-external-url': {
          window.open(action.url, '_blank', 'noopener,noreferrer');
          return;
        }
        case 'sign-out':
        case 'catalog-closed':
        case 'skills-catalog-closed':
        case 'settings-visibility':
          // No browser-mode equivalent; the chat-ui handles overlay close
          // state itself and there's no managed session to sign out of.
          return;
        case 'session-streaming':
        case 'session-unread':
        case 'crons-changed':
        case 'connections-changed':
        case 'skills-changed':
          // Native-shell bookkeeping/refresh signals. Browser mode already
          // owns these surfaces locally, so there is no host work to do.
          return;
        default: {
          const unhandled: never = action;
          void unhandled;
          return;
        }
      }
    };

    window.addEventListener('verso:shell-action', handle as EventListener);
    return () => {
      window.removeEventListener('verso:shell-action', handle as EventListener);
    };
  }, [opts.isNativeShell]);
}

function readPersistedSelection(): string | null {
  try {
    return window.localStorage.getItem(BROWSER_SELECTED_SESSION_KEY) || null;
  } catch {
    return null;
  }
}

function writePersistedSelection(sessionId: string | null): void {
  try {
    if (sessionId) {
      window.localStorage.setItem(BROWSER_SELECTED_SESSION_KEY, sessionId);
    } else {
      window.localStorage.removeItem(BROWSER_SELECTED_SESSION_KEY);
    }
  } catch {
    // localStorage may be unavailable (private mode); the session list still
    // works, the selection just doesn't persist across reloads.
  }
}

function sortSessions(sessions: ChatSessionSummary[]): ChatSessionSummary[] {
  return [...sessions].sort((left, right) => {
    const leftArchived = !!left.archivedAt;
    const rightArchived = !!right.archivedAt;
    if (leftArchived !== rightArchived) return leftArchived ? 1 : -1;
    const leftSortKey = left.archivedAt ?? left.createdAt;
    const rightSortKey = right.archivedAt ?? right.createdAt;
    const byDate = rightSortKey.localeCompare(leftSortKey);
    return byDate !== 0 ? byDate : right.id.localeCompare(left.id);
  });
}

function replaceSession(sessions: ChatSessionSummary[], next: ChatSessionSummary): ChatSessionSummary[] {
  const filtered = sessions.filter((session) => session.id !== next.id);
  return [next, ...filtered];
}
