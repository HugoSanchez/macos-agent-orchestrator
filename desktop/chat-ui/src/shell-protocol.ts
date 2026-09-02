// Wire format between the Swift shell and the chat-ui WebView.
//
// All product-level shell IPC uses three channels:
//
//   • Swift → JS: `verso:shell-state` carrying a full `ShellState` snapshot.
//   • Swift → JS: `verso:shell-command` for transient commands.
//   • JS → Swift: `chatBridge.postMessage({type: 'action', action})` with a
//     single discriminated `ShellAction` payload.
//
// `desktop/macos/ChatWebView.swift` contains the matching Swift definitions.

import type { ChatSessionSummary } from './types';

/// Snapshot of everything the chat-ui's UI derives from. Pushed from Swift
/// after every mutation that affects what the chat-ui should render.
/// Last write wins.
export interface ShellState {
  sessions: ChatSessionSummary[];
  selectedSessionId: string | null;
}

/// Transient command pushed from Swift to JS. Not snapshot-able (overlay
/// open/close state lives in the chat-ui).
export type ShellCommand =
  | { kind: 'open-catalog' }
  | { kind: 'close-catalog' }
  | { kind: 'open-skills-catalog' }
  | { kind: 'close-skills-catalog' }
  | { kind: 'open-cron'; id: string }
  | { kind: 'open-settings' }
  | { kind: 'focus-chat' };

/// Action sent from JS → Swift via the chatBridge.
export type ShellAction =
  | { kind: 'select-session'; id: string | null }
  | { kind: 'create-session' }
  | { kind: 'archive-session'; id: string }
  | { kind: 'unarchive-session'; id: string }
  | { kind: 'rename-session'; id: string; title: string }
  // "I just streamed a message into session X; please refresh." Used so
  // Swift's leftbar picks up the AI-generated title that lands after the
  // first response.
  | { kind: 'session-mutated'; id: string }
  // Streaming state changed for a session. Swift's leftbar uses this to
  // show a "working" indicator on rows whose agent is currently generating,
  // so the user can tell which conversations are alive when they're not
  // looking at the chat surface.
  | { kind: 'session-streaming'; id: string; streaming: boolean }
  // Unread response for a session — set when a stream finishes while the
  // user wasn't looking at that chat surface (different session selected,
  // or an overlay covered chat). Cleared when the chat-ui sees the session
  // become actively-viewed again. Chat-ui owns the rule because only it
  // knows full overlay state.
  | { kind: 'session-unread'; id: string; unread: boolean }
  | { kind: 'crons-changed' }
  | { kind: 'connections-changed' }
  | { kind: 'skills-changed' }
  | { kind: 'open-external-url'; url: string }
  | { kind: 'sign-out' }
  // User dismissed the catalog via the chat-ui's close button (rather
  // than via a Swift-side leftbar toggle).
  | { kind: 'catalog-closed' }
  | { kind: 'skills-catalog-closed' }
  // Settings page visibility. The native shell hides the sessions sidebar
  // while settings is open so the settings rail is the window's only left
  // column; the chat-ui owns navigation state, so it reports transitions.
  | { kind: 'settings-visibility'; open: boolean };
