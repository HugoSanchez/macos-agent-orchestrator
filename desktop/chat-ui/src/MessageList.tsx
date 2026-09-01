import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, ActivityStep, ConnectionRequestView, ConnectionView, ToolkitView } from './types';
import {
  discardDraft,
  draftIdForArgs,
  resolveSidecarUrl,
  sendDraft,
} from './chat';
import { AssistantActivity, AssistantMessageActions } from './AssistantActivity';
import { MarkdownContent } from './MarkdownContent';
import { displayToolkitName } from './display-names';
import { CodexMark, CodexConnectFlow, useCodexConnect } from './CodexConnect';
import { type ToolkitInfo } from './message-activity-model';
import { isSupportedMessageDraftStep } from './message-draft-model';

interface DraftOverlayItem {
  step: Extract<ActivityStep, { type: 'tool' }>;
  sessionId?: string;
}

interface Props {
  messages: ChatMessage[];
  onConnect: (request: ConnectionRequestView) => void;
  connections: ConnectionView[];
  toolkitCatalog: ToolkitView[];
  onCodexConnected: (widgetMessageId: string) => void;
}

// Build a slug → {name, logoUrl} map from the full toolkit catalog first
// (covers every toolkit regardless of connection state), then overlay
// connection entries so user-customized names and any connection-specific
// logo URLs win when present.
function buildToolkitMap(
  connections: ConnectionView[],
  catalog: ToolkitView[],
): Map<string, ToolkitInfo> {
  const map = new Map<string, ToolkitInfo>();
  for (const tk of catalog) {
    const slug = tk.slug?.toLowerCase();
    if (!slug) continue;
    map.set(slug, { name: displayToolkitName(tk.name), logoUrl: tk.logoUrl, connected: tk.connected });
  }
  for (const conn of connections) {
    const slug = conn.toolkitSlug?.toLowerCase();
    if (!slug) continue;
    const existing = map.get(slug);
    map.set(slug, {
      name: conn.toolkitName ? displayToolkitName(conn.toolkitName) : existing?.name || slug,
      logoUrl: conn.logoUrl ?? existing?.logoUrl ?? null,
      connected: conn.status === 'active' || existing?.connected === true,
    });
  }
  return map;
}

// Pixel slack for "user is at the bottom" — any scroll position within this
// many pixels of the end keeps auto-scroll engaged. Larger than 0 so that the
// browser's natural smooth-scroll deceleration still counts as pinned.
const STICK_TO_BOTTOM_THRESHOLD_PX = 32;

export function MessageList({ messages, onConnect, connections, toolkitCatalog, onCodexConnected }: Props) {
  const toolkits = buildToolkitMap(connections, toolkitCatalog);
  const containerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const hasStreamingAssistant = messages.some((message) => message.role === 'assistant' && message.isStreaming);
  // Tracks whether the user is currently pinned to the bottom. Streaming
  // tokens only auto-scroll while this is true; the moment the user scrolls
  // up it flips to false and stays false until they scroll back down.
  const stickToBottomRef = useRef(true);
  const previousLengthRef = useRef(0);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance < STICK_TO_BOTTOM_THRESHOLD_PX;
  };

  useEffect(() => {
    const justLoaded = previousLengthRef.current === 0 && messages.length > 0;
    if (justLoaded) {
      // Fresh session hydrate — jump instantly to the latest message, no
      // smooth-scroll animation since there's no continuity to preserve.
      stickToBottomRef.current = true;
      endRef.current?.scrollIntoView({ behavior: 'auto' });
    } else if (messages.length === 0) {
      // Session cleared — reset pinning so the next load starts at bottom.
      stickToBottomRef.current = true;
    } else if (stickToBottomRef.current) {
      endRef.current?.scrollIntoView({ behavior: hasStreamingAssistant ? 'auto' : 'smooth' });
    }
    previousLengthRef.current = messages.length;
  }, [hasStreamingAssistant, messages]);

  if (messages.length === 0) {
    return (
      <div className="message-empty-state">
        Start a new session or resume one from the sidebar
      </div>
    );
  }

  // Collect supported Gmail/Slack draft steps across the session so the
  // floating overlay can stack them in one place. Historical misuse of the
  // tool for another app remains ordinary activity instead of a stale widget.
  const draftSteps: DraftOverlayItem[] = [];
  for (const msg of messages) {
    for (const step of msg.steps ?? []) {
      if (step.type === 'tool'
        && isSupportedMessageDraftStep(step)
        && !isDraftFinalized(step)) {
        draftSteps.push({ step, sessionId: msg.sessionId });
      }
    }
  }

  return (
    <>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="chat-scroll"
      >
        {messages.map(msg => (
          <MessageBubble
            key={msg.id}
            message={msg}
            onConnect={onConnect}
            toolkits={toolkits}
            onCodexConnected={onCodexConnected}
          />
        ))}
        <div ref={endRef} />
      </div>
      {draftSteps.length > 0 && (
        <DraftOverlay drafts={draftSteps} toolkits={toolkits} />
      )}
    </>
  );
}

function MessageBubble({
  message,
  onConnect,
  toolkits,
  onCodexConnected,
}: {
  message: ChatMessage;
  onConnect: (request: ConnectionRequestView) => void;
  toolkits: Map<string, ToolkitInfo>;
  onCodexConnected: (widgetMessageId: string) => void;
}) {
  const isUser = message.role === 'user';

  if (message.kind === 'codex_connect_required') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: '12px' }}>
        <CodexConnectRequiredCard onConnected={() => onCodexConnected(message.id)} />
      </div>
    );
  }

  // Connection cards render alongside the message body; active draft cards live
  // in a floating overlay. Finalized draft tools stay in the history activity
  // stream so old messages do not lose their tool-call context.
  const allSteps = message.steps ?? [];
  const connectionRequests: ConnectionRequestView[] = [];
  const stepsForActivity: ActivityStep[] = [];
  for (const step of allSteps) {
    if (step.type === 'tool' && step.connection) {
      connectionRequests.push(step.connection);
      continue;
    }
    if (step.type === 'tool'
      && isSupportedMessageDraftStep(step)
      && !isDraftFinalized(step)) {
      continue;
    }
    stepsForActivity.push(step);
  }

  const assistantMessage = !isUser ? { ...message, steps: stepsForActivity } : message;

  return (
    <div style={{
      display: 'flex',
      justifyContent: isUser ? 'flex-end' : 'flex-start',
      marginBottom: isUser ? '28px' : '12px',
      marginTop: isUser ? '28px' : '0',
    }}>
      <div
        className={isUser ? 'user-message-bubble' : 'assistant-message-bubble'}
      >
        {!isUser && (
          <AssistantActivity
            message={assistantMessage}
            toolkits={toolkits}
          />
        )}

        <div className={`message-content ${isUser ? 'user-message-content' : 'assistant-message-content'}`}>
          {isUser ? (
            <UserMessageBody content={message.content} />
          ) : message.content ? (
            <MarkdownContent content={message.content} />
          ) : null}
        </div>

        {!isUser && <AssistantMessageActions message={assistantMessage} />}

        {!isUser && connectionRequests.length > 0 && (
          <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {connectionRequests.map((request, idx) => (
              <ConnectionCard
                key={request.id || `${idx}-${request.toolkitSlug}`}
                request={request}
                onConnect={onConnect}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DraftOverlay({
  drafts,
  toolkits,
}: {
  drafts: DraftOverlayItem[];
  toolkits: Map<string, ToolkitInfo>;
}) {
  return (
    <div className="message-draft-overlay" role="region" aria-label="Pending message drafts">
      {drafts.map(({ step, sessionId }, idx) => (
        <MessageDraftCard
          key={step.id ?? `draft-${idx}`}
          step={step}
          sessionId={sessionId}
          toolkits={toolkits}
        />
      ))}
    </div>
  );
}

function CodexConnectRequiredCard({ onConnected }: { onConnected: () => void }) {
  const { phase, start, cancel, reset } = useCodexConnect({ onConnected });

  return (
    <div className="codex-connect-card">
      {phase.kind === 'idle' ? (
        <>
          <p className="codex-connect-card-text">
            Connect your Codex account to start chatting. We&rsquo;ll open the OpenAI sign-in
            page in your browser and you can come back here once you&rsquo;re done.
          </p>
          <button
            type="button"
            className="settings-button settings-button-primary"
            onClick={start}
          >
            <CodexMark />
            <span>Connect Codex</span>
          </button>
        </>
      ) : null}

      <CodexConnectFlow phase={phase} onRetry={start} onCancel={phase.kind === 'error' ? reset : cancel} />
    </div>
  );
}

interface DraftFields {
  // The widget is intentionally limited to the communication channels
  // that Verso can dispatch and durably resolve itself.
  channel: string;
  targetKind: string;
  teamId: string;
  channelLabel: string;
  channelLogoUrl: string;
  // `to` is what gets sent (possibly an opaque id like a Slack DM channel id
  // `D0..`). `toLabel` is what we show the user. They stay in sync once the
  // user edits, so manual changes always win over the agent's hint.
  to: string;
  toLabel: string;
  toAvatarUrl: string;
  cc: string;
  subject: string;
  body: string;
  threadId: string;
}

type DraftStatus = 'draft' | 'sending' | 'sent' | 'error';

function parseDraftInput(input: unknown): DraftFields {
  const obj = (input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {}) ;
  const channel = typeof obj.channel === 'string' ? obj.channel.trim().toLowerCase() : '';
  const to = firstStringField(obj, [
    'to',
    'recipient',
    'recipient_id',
    'user',
    'user_id',
    'channel_id',
    'channel_name',
    'conversation_id',
  ]);
  const toDisplay = firstStringField(obj, [
    'to_display',
    'to_label',
    'recipient_display',
    'recipient_label',
    'recipient_name',
    'user_name',
    'channel_display',
    'channel_label',
  ]);
  const body = firstStringField(obj, ['body', 'message', 'markdown_text', 'fallback_text', 'text']);
  return {
    channel,
    targetKind: firstStringField(obj, ['targetKind', 'target_kind']).toLowerCase(),
    teamId: firstStringField(obj, ['teamId', 'team_id']),
    channelLabel: typeof obj.channel_label === 'string' ? obj.channel_label.trim() : '',
    channelLogoUrl: typeof obj.channel_logo_url === 'string' ? obj.channel_logo_url.trim() : '',
    to,
    toLabel: toDisplay.length > 0 ? toDisplay : to,
    toAvatarUrl: firstStringField(obj, ['to_avatar_url', 'recipient_avatar_url', 'user_avatar_url']),
    cc: typeof obj.cc === 'string' ? obj.cc : '',
    subject: typeof obj.subject === 'string' ? obj.subject : '',
    body,
    threadId: firstStringField(obj, ['threadId', 'thread_id', 'thread_ts']),
  };
}

function firstStringField(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return '';
}

// Pending review is interactive; every durable send/discard resolution is
// final and should never reconstruct a widget after session hydration.
function isDraftFinalized(step: Extract<ActivityStep, { type: 'tool' }>): boolean {
  if (typeof step.result !== 'string' || step.result.length === 0) return false;
  try {
    const parsed = JSON.parse(step.result) as { data?: { status?: unknown } } | null;
    const status = parsed?.data?.status;
    return typeof status === 'string' && status !== 'pending_review';
  } catch {
    return false;
  }
}

function prettyChannelLabel(channel: string): string {
  if (!channel) return 'message';
  if (channel === 'gmail') return 'Gmail';
  if (channel === 'slack') return 'Slack';
  if (channel === 'microsoft_teams') return 'Microsoft Teams';
  return channel.charAt(0).toUpperCase() + channel.slice(1);
}

function MessageDraftCard({
  step,
  sessionId,
  toolkits,
}: {
  step: Extract<ActivityStep, { type: 'tool' }>;
  sessionId?: string;
  toolkits: Map<string, ToolkitInfo>;
}) {
  const initial = parseDraftInput(step.input);
  const [fields, setFields] = useState<DraftFields>(initial);
  const [status, setStatus] = useState<DraftStatus>('draft');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isDiscarded, setIsDiscarded] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isHidden, setIsHidden] = useState(false);
  const [showCc, setShowCc] = useState(initial.cc.trim().length > 0);

  const finalized = isDraftFinalized(step);

  // A resolution can arrive from session rehydration or another view. Hide
  // the editor as soon as that durable result reaches the step.
  useEffect(() => {
    if (finalized && status === 'draft') setIsHidden(true);
  }, [finalized, status]);

  useEffect(() => {
    if (status !== 'sent') return;
    const id = setTimeout(() => setIsHidden(true), 1800);
    return () => clearTimeout(id);
  }, [status]);

  // Deterministic draft id derived from the agent's args. The orchestrator
  // uses the same value to persist the send/discard resolution by session.
  const draftId = draftIdForArgs(step.input);

  // Prefer explicit display hints, then the connected toolkit catalog.
  const toolkitInfo = fields.channel ? toolkits.get(fields.channel) : undefined;
  const channelLogoUrl = fields.channelLogoUrl || toolkitInfo?.logoUrl || null;
  const channelLabel = fields.channelLabel
    || toolkitInfo?.name
    || prettyChannelLabel(fields.channel);

  const sendDisabled = status === 'sending' || status === 'sent'
    || fields.to.trim().length === 0
    || fields.body.trim().length === 0;

  const update = <K extends keyof DraftFields>(key: K, value: DraftFields[K]) => {
    setFields((prev) => ({ ...prev, [key]: value }));
    if (status === 'error') setStatus('draft');
  };

  const handleSend = async () => {
    if (sendDisabled) return;
    setStatus('sending');
    setErrorMessage(null);
    const payload = {
      channel: fields.channel,
      targetKind: fields.targetKind || undefined,
      teamId: fields.teamId || undefined,
      to: fields.to.trim(),
      cc: fields.cc.trim() || undefined,
      subject: fields.subject.trim() || undefined,
      body: fields.body,
      threadId: fields.threadId.trim() || undefined,
    };
    try {
      if (!sessionId) throw new Error('Cannot send draft before the session is ready.');
      await sendDraft(draftId, sessionId, payload);
      setStatus('sent');
    } catch (error: unknown) {
      setStatus('error');
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleDiscard = async () => {
    if (status === 'sending') return;
    setErrorMessage(null);
    if (!sessionId) {
      setStatus('error');
      setErrorMessage('Cannot discard draft before the session is ready.');
      return;
    }
    setStatus('sending');
    try {
      await discardDraft(draftId, sessionId, fields.channel);
      setIsDiscarded(true);
      setStatus('sent');
    } catch (error: unknown) {
      setStatus('error');
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  if (isHidden) return null;

  // Friendly recipient for any header/summary surface. Falls back to the raw
  // `to` (likely an opaque id) only when no display label is set.
  const toFriendly = fields.toLabel.trim() || fields.to.trim();

  const supportsEmailFields = fields.channel === 'gmail';

  const toPlaceholder = fields.channel === 'gmail'
    ? 'name@example.com'
    : fields.channel === 'microsoft_teams'
      ? 'Chat or channel'
      : '#channel or @user';
  const sizeClass = draftSizeClass(fields.body);
  const bodyRows = draftBodyRows(fields.body);

  if (status === 'sent') {
    return (
      <div className="message-draft-card is-terminal">
        <ToolkitLogo name={channelLabel} logoUrl={channelLogoUrl} />
        <div className="message-draft-card-meta">
          <div className="message-draft-card-title">
            {isDiscarded ? 'Draft discarded' : `Sent via ${channelLabel}`}
          </div>
          {!isDiscarded && toFriendly && (
            <div className="message-draft-card-subtitle">{truncate(toFriendly, 36)}</div>
          )}
        </div>
      </div>
    );
  }

  if (isMinimized) {
    const summary = toFriendly || `New ${channelLabel.toLowerCase()} message`;
    return (
      <button
        type="button"
        className="message-draft-card-minimized"
        onClick={() => setIsMinimized(false)}
        title="Expand draft"
      >
        <ToolkitLogo name={channelLabel} logoUrl={channelLogoUrl} />
        <span className="message-draft-card-minimized-text">
          {channelLabel} draft · {truncate(summary, 28)}
        </span>
        <ExpandIcon />
      </button>
    );
  }

  return (
    <div className={`message-draft-card ${sizeClass}`}>
      <div className="message-draft-card-head">
        <ToolkitLogo name={channelLabel} logoUrl={channelLogoUrl} />
        <div className="message-draft-card-meta">
          <div className="message-draft-card-title">Review & send via {channelLabel}</div>
          <div className="message-draft-card-subtitle">Edit anything before sending.</div>
        </div>
        <button
          type="button"
          className="message-draft-card-icon-button"
          onClick={() => setIsMinimized(true)}
          aria-label="Minimize draft"
          title="Minimize"
        >
          <MinimizeIcon />
        </button>
      </div>

      <div className="message-draft-card-fields">
        <DraftRow label="To">
          {fields.toAvatarUrl && (
            <img
              src={fields.toAvatarUrl}
              alt=""
              aria-hidden="true"
              className="message-draft-card-avatar"
            />
          )}
          <input
            type="text"
            className="message-draft-card-input"
            placeholder={toPlaceholder}
            value={fields.toLabel}
            onChange={(e) => {
              const value = e.target.value;
              // Once the user edits the field they take over both surfaces —
              // we send whatever they typed, not the agent's original id.
              setFields((prev) => ({ ...prev, to: value, toLabel: value }));
              if (status === 'error') setStatus('draft');
            }}
            disabled={status === 'sending'}
          />
          {supportsEmailFields && !showCc && (
            <button
              type="button"
              className="message-draft-card-row-toggle"
              onClick={() => setShowCc(true)}
              disabled={status === 'sending'}
            >
              Cc
            </button>
          )}
        </DraftRow>

        {supportsEmailFields && showCc && (
          <DraftRow label="Cc">
            <input
              type="text"
              className="message-draft-card-input"
              placeholder="name@example.com"
              value={fields.cc}
              onChange={(e) => update('cc', e.target.value)}
              disabled={status === 'sending'}
              autoFocus
            />
          </DraftRow>
        )}

        {supportsEmailFields && (
          <DraftRow label="Subject">
            <input
              type="text"
              className="message-draft-card-input"
              value={fields.subject}
              onChange={(e) => update('subject', e.target.value)}
              disabled={status === 'sending'}
            />
          </DraftRow>
        )}

        <textarea
          className="message-draft-card-body"
          value={fields.body}
          onChange={(e) => update('body', e.target.value)}
          rows={bodyRows}
          disabled={status === 'sending'}
        />
      </div>

      {errorMessage && status === 'error' && (
        <div className="message-draft-card-error">{errorMessage}</div>
      )}

      <div className="message-draft-card-actions">
        <button
          type="button"
          className="message-draft-card-button is-secondary"
          onClick={handleDiscard}
          disabled={status === 'sending'}
        >
          Discard
        </button>
        <button
          type="button"
          className="message-draft-card-button is-primary"
          onClick={handleSend}
          disabled={sendDisabled}
        >
          {status === 'sending' ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

function draftSizeClass(body: string): 'is-compact' | 'is-medium' | 'is-large' {
  const metrics = draftBodyMetrics(body);
  if (metrics.characters > 720 || metrics.visualLines > 12) return 'is-large';
  if (metrics.characters > 180 || metrics.visualLines > 4) return 'is-medium';
  return 'is-compact';
}

function draftBodyRows(body: string): number {
  const metrics = draftBodyMetrics(body);
  if (metrics.characters > 720 || metrics.visualLines > 12) {
    return Math.max(9, Math.min(18, metrics.visualLines + 1));
  }
  if (metrics.characters > 180 || metrics.visualLines > 4) {
    return Math.max(6, Math.min(12, metrics.visualLines + 1));
  }
  return Math.max(4, Math.min(6, metrics.visualLines + 1));
}

function draftBodyMetrics(body: string): { characters: number; visualLines: number } {
  const lines = body.split('\n');
  const visualLines = lines.reduce((total, line) => (
    total + Math.max(1, Math.ceil(line.length / 72))
  ), 0);
  return { characters: body.trim().length, visualLines };
}

function MinimizeIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <line x1="2" y1="5" x2="8" y2="5" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="2.5,7 5,4 7.5,7" />
    </svg>
  );
}

function DraftRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="message-draft-card-row">
      <span className="message-draft-card-label">{label}</span>
      {children}
    </label>
  );
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function ConnectionCard({
  request,
  onConnect,
}: {
  request: ConnectionRequestView;
  onConnect: (request: ConnectionRequestView) => void;
}) {
  const status = request.status;
  const displayName = displayToolkitName(request.toolkitName);
  const canConnect = status === 'pending' || status === 'failed' || status === 'expired';
  const label = status === 'connected'
    ? 'Connected'
    : status === 'failed' || status === 'expired'
      ? 'Retry'
      : 'Connect';

  return (
    <div className="connection-card">
      <div className="connection-card-head">
        <div className="connection-card-meta">
          <ToolkitLogo name={displayName} logoUrl={request.logoUrl} />
          <div>
            <div className="connection-card-title">{displayName}</div>
            <div className="connection-card-subtitle">This tool needs access to continue.</div>
          </div>
        </div>
        <button
          type="button"
          className={`connection-pill is-${status}`}
          disabled={!canConnect}
          onClick={() => canConnect && onConnect(request)}
        >
          {label}
        </button>
      </div>
      {request.errorMessage && (
        <div className="connection-card-error">{request.errorMessage}</div>
      )}
    </div>
  );
}

function ToolkitLogo({ logoUrl, name }: { logoUrl: string | null; name: string }) {
  if (logoUrl) {
    return <img className="connection-card-logo" src={resolveSidecarUrl(logoUrl) ?? logoUrl} alt="" aria-hidden="true" />;
  }

  const initial = name.trim().charAt(0).toUpperCase() || '?';
  return <div className="connection-card-logo-fallback" aria-hidden="true">{initial}</div>;
}

const SLASH_SKILL_MATCH = /^\/([a-z0-9][a-z0-9_-]*)\b\s*/i;

// Attachment marker lines the orchestrator stores in message content (see
// attachments.ts `attachmentMarker`). The blobs themselves are never
// persisted; these lines are the durable record that a message carried
// attachments, and we render them as chips instead of raw text.
const ATTACHMENT_MARKER = /^\[attached (image|document): (.+)\]$/;

interface AttachmentChipInfo {
  kind: 'image' | 'document';
  name: string;
}

function splitAttachmentMarkers(content: string): { text: string; attachments: AttachmentChipInfo[] } {
  if (!content.includes('[attached image:') && !content.includes('[attached document:')) {
    return { text: content, attachments: [] };
  }
  const attachments: AttachmentChipInfo[] = [];
  const kept: string[] = [];
  for (const line of content.split('\n')) {
    const match = line.match(ATTACHMENT_MARKER);
    if (match) attachments.push({ kind: match[1] as 'image' | 'document', name: match[2] });
    else kept.push(line);
  }
  return { text: kept.join('\n').trim(), attachments };
}

function AttachmentChipIcon({ kind }: { kind: 'image' | 'document' }) {
  if (kind === 'document') {
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M2.5 1 H6 L7.5 2.5 V9 H2.5 Z" />
        <path d="M6 1 V2.5 H7.5" />
        <line x1="3.7" y1="5" x2="6.3" y2="5" />
        <line x1="3.7" y1="6.8" x2="6.3" y2="6.8" />
      </svg>
    );
  }
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1" y="1" width="8" height="8" rx="1.5" />
      <circle cx="3.6" cy="3.6" r="0.9" fill="currentColor" stroke="none" />
      <path d="M1.5 7.5 L4 5 L6 7 L7.4 5.6 L9 7.2" />
    </svg>
  );
}

function UserMessageBody({ content }: { content: string }) {
  const { text, attachments } = splitAttachmentMarkers(content);
  const attachmentChips = attachments.length > 0 && (
    <span className="message-attachments-row">
      {attachments.map((attachment, index) => (
        <span key={`${attachment.name}-${index}`} className="attachment-chip">
          <AttachmentChipIcon kind={attachment.kind} />
          <span className="attachment-chip-name">{attachment.name}</span>
        </span>
      ))}
    </span>
  );

  const match = text.match(SLASH_SKILL_MATCH);
  if (!match) {
    return (
      <span style={{ whiteSpace: 'pre-wrap' }}>
        {text}
        {attachmentChips}
      </span>
    );
  }
  const slug = match[1].toLowerCase();
  const remainder = text.slice(match[0].length);
  return (
    <span style={{ whiteSpace: 'pre-wrap' }}>
      <span className="skill-chip">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M5 1 L6 4 L9 5 L6 6 L5 9 L4 6 L1 5 L4 4 Z" fill="currentColor" />
        </svg>
        <span className="skill-chip-slug">/{slug}</span>
      </span>
      {remainder.length > 0 && <span> {remainder}</span>}
      {attachmentChips}
    </span>
  );
}
