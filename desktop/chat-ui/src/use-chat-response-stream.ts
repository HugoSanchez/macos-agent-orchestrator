import { useCallback } from 'react';
import { streamChatMessage } from './chat';
import { applyChatSSEEvent } from './chat-event-reducer';
import { postShellAction } from './shell-bridge';
import type {
  AttachedContext,
  ChatMessage,
  ChatModel,
  ChatSSEEvent,
  OutgoingAttachment,
  ReasoningEffort,
} from './types';

export interface UseChatResponseStreamOptions {
  defaultModel: ChatModel | null;
  ensureSession: () => Promise<string>;
  finishSessionStream: (sessionId: string) => void;
  getCurrentSessionKey: () => string;
  isNativeShell: boolean;
  model: ChatModel | null;
  onCodexAuthRequired: () => void;
  reasoningEffort: ReasoningEffort;
  startSessionStream: (sessionId: string, abort: () => void) => void;
  updateSessionMessages: (
    sessionKey: string,
    updater: (messages: ChatMessage[]) => ChatMessage[],
  ) => void;
}

export function useChatResponseStream(options: UseChatResponseStreamOptions) {
  const {
    defaultModel,
    ensureSession,
    finishSessionStream,
    getCurrentSessionKey,
    isNativeShell,
    model,
    onCodexAuthRequired,
    reasoningEffort,
    startSessionStream,
    updateSessionMessages,
  } = options;

  const streamInto = useCallback((
    assistantId: string,
    text: string,
    attached: AttachedContext | null,
    attachments: OutgoingAttachment[] = [],
  ) => {
    // Start in the pending/current bucket, then switch to the resolved session
    // so even a synchronous transport failure updates the migrated placeholder.
    let targetSessionKey = getCurrentSessionKey();

    void (async () => {
      try {
        const sessionId = await ensureSession();
        targetSessionKey = sessionId;
        updateSessionMessages(sessionId, (messages) => messages.map((message) => (
          message.id === assistantId ? { ...message, sessionId } : message
        )));

        let pendingEvents: ChatSSEEvent[] = [];
        let flushScheduled = false;
        const flushEvents = () => {
          flushScheduled = false;
          if (pendingEvents.length === 0) return;
          const events = pendingEvents;
          pendingEvents = [];
          updateSessionMessages(sessionId, (messages) => messages.map((message) => {
            if (message.id !== assistantId) return message;
            return events.reduce((next, event) => applyChatSSEEvent(next, event), message);
          }));
        };
        const scheduleFlush = () => {
          if (flushScheduled) return;
          flushScheduled = true;
          window.requestAnimationFrame(flushEvents);
        };

        const showCodexConnectWidget = () => {
          updateSessionMessages(sessionId, (messages) => messages.map((message) => (
            message.id === assistantId
              ? asCodexConnectWidget(message, text, attached, attachments)
              : message
          )));
          onCodexAuthRequired();
        };

        const abort = streamChatMessage(
          sessionId,
          text,
          (event: ChatSSEEvent) => {
            if (event.type === 'error'
              && typeof event.message === 'string'
              && isCodexAuthError(event.message)) {
              flushEvents();
              showCodexConnectWidget();
              return;
            }
            pendingEvents.push(event);
            scheduleFlush();
          },
          () => {
            flushEvents();
            updateSessionMessages(sessionId, (messages) => messages.map((message) => (
              message.id === assistantId && message.isStreaming
                ? { ...message, isStreaming: false, endedAt: Date.now() }
                : message
            )));
            finishSessionStream(sessionId);
            postShellAction({ kind: 'session-mutated', id: sessionId });
            notifyNativeResponseReady(isNativeShell);
          },
          (error: string) => {
            if (isCodexAuthError(error)) {
              showCodexConnectWidget();
            } else {
              updateSessionMessages(sessionId, (messages) => messages.map((message) => (
                message.id === assistantId
                  ? {
                      ...message,
                      content: `${message.content}\n\n**Error:** ${error}`,
                      isStreaming: false,
                      endedAt: Date.now(),
                    }
                  : message
              )));
            }
            finishSessionStream(sessionId);
            postShellAction({ kind: 'session-mutated', id: sessionId });
            notifyNativeResponseReady(isNativeShell);
          },
          { attached, attachments, reasoningEffort, model: model ?? defaultModel },
        );

        startSessionStream(sessionId, abort);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (isCodexAuthError(message)) {
          updateSessionMessages(targetSessionKey, (messages) => messages.map((entry) => (
            entry.id === assistantId
              ? asCodexConnectWidget(entry, text, attached, attachments)
              : entry
          )));
          onCodexAuthRequired();
        } else {
          updateSessionMessages(targetSessionKey, (messages) => messages.map((entry) => (
            entry.id === assistantId
              ? {
                  ...entry,
                  content: `**Error:** ${message}`,
                  isStreaming: false,
                  endedAt: Date.now(),
                }
              : entry
          )));
        }
      }
    })();
  }, [
    defaultModel,
    ensureSession,
    finishSessionStream,
    getCurrentSessionKey,
    isNativeShell,
    model,
    onCodexAuthRequired,
    reasoningEffort,
    startSessionStream,
    updateSessionMessages,
  ]);

  return { streamInto };
}

export function isCodexAuthError(error: string): boolean {
  return /no\s+codex\s+credentials|hermes\s+auth|hermes\s+model/i.test(error);
}

function asCodexConnectWidget(
  message: ChatMessage,
  pendingText: string,
  pendingAttached: AttachedContext | null,
  pendingAttachments: OutgoingAttachment[],
): ChatMessage {
  return {
    ...message,
    kind: 'codex_connect_required',
    pendingText,
    pendingAttached,
    pendingAttachments,
    content: '',
    steps: [],
    isStreaming: false,
    endedAt: Date.now(),
  };
}

function notifyNativeResponseReady(isNativeShell: boolean): void {
  if (!isNativeShell) return;
  window.webkit?.messageHandlers?.chatBridge?.postMessage({ type: 'notifyResponseReady' });
}
