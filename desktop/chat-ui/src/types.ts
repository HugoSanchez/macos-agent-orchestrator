export interface ChatMessage {
  id: string;
  sessionId?: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string | null;
  steps?: ActivityStep[];
  isStreaming?: boolean;
  startedAt?: number;
  endedAt?: number;
  // Client-only marker. When set, the renderer swaps the normal message body
  // for a special widget (e.g. an inline Codex connect flow). Synthetic
  // messages with `kind` are never persisted to the orchestrator.
  kind?: 'codex_connect_required';
  // For `codex_connect_required` widgets: the message the user was trying to
  // send when we intercepted them. Once they finish connecting, we replay
  // this send in place of the widget so the chat continues seamlessly.
  pendingText?: string;
  pendingAttached?: AttachedContext | null;
  pendingAttachments?: OutgoingAttachment[];
}

// A file the user attached in the composer, ready to POST. `dataBase64` is the
// raw base64 payload (no data-URL prefix); the orchestrator re-validates by
// magic bytes. Images ride the live request to the model; documents are
// converted to Markdown server-side. `kind` is a client-side hint for the chip
// UI only — the server re-derives it from the bytes and ignores this field.
export interface OutgoingAttachment {
  name: string;
  mimeType: string;
  dataBase64: string;
  kind: 'image' | 'document';
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  // `null` denotes a legacy session created before model choice was stored.
  model: ChatModel | null;
  messageCount: number;
  lastMessagePreview: string | null;
}

export interface StoredChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  reasoning?: string | null;
  steps?: ActivityStep[];
  startedAt?: number;
  endedAt?: number;
}

export interface ConnectionRequestView {
  id: string;
  toolkitSlug: string;
  toolkitName: string;
  logoUrl: string | null;
  status: 'pending' | 'connected' | 'failed' | 'expired';
  redirectUrl: string | null;
  connectedAccountId: string | null;
  errorMessage: string | null;
}

export interface ConnectionView {
  connectedAccountId: string;
  toolkitSlug: string;
  toolkitName: string;
  logoUrl: string | null;
  status: 'active' | 'inactive';
}

export interface CustomConnectorView {
  id: string;
  name: string;
  slug: string;
  url: string;
  transport: 'http' | 'sse';
  auth: 'none' | 'bearer' | 'oauth';
  logoUrl: string | null;
  lastKnownToolCount?: number;
  createdAt: string;
  updatedAt: string;
  status:
    | { state: 'connected'; toolCount: number; cached?: true }
    | { state: 'pending_auth'; toolCount: 0 }
    | { state: 'failed'; toolCount: 0; reason: string };
}

export interface ToolkitView {
  slug: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  connected: boolean;
  connectedAccountId: string | null;
  noAuth: boolean;
}

export interface SkillSummaryView {
  slug: string;
  name: string;
  description: string;
  category: string | null;
  tags: string[];
  prerequisites: string[];
  platforms: string[];
  enabled: boolean;
  pinned: boolean;
}

export interface HubSkillSummaryView {
  identifier: string;
  name: string;
  slug: string;
  description: string;
  source: string;
  trustLevel: string;
  repo: string | null;
  path: string | null;
  tags: string[];
  installed: boolean;
}

export interface HubSkillDetailView extends HubSkillSummaryView {
  content: string;
  rawContent: string;
  files: string[];
}

export interface HubSkillInstallView {
  installed: boolean;
  changed: boolean;
  skill: {
    name: string;
    source: string;
    identifier: string;
    trustLevel: string;
    scanVerdict: string;
    contentHash: string;
    installPath: string;
    files: string[];
    installedAt: string | null;
    updatedAt: string | null;
  } | null;
  message: string;
  output: string;
}

export interface SkillDetailView extends SkillSummaryView {
  content: string;
}

export interface CronJobView {
  id: string;
  name: string;
  prompt: string;
  skills: string[];
  schedule: { kind?: string; display?: string; expr?: string; minutes?: number; run_at?: string } | null;
  schedule_display: string | null;
  enabled: boolean;
  state: string;
  paused_at: string | null;
  paused_reason: string | null;
  created_at: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  deliver: string | null;
  origin: Record<string, unknown> | null;
}

export interface CronRunSummaryView {
  filename: string;
  ts: string;
  size: number;
  modified: string;
}

export interface CronDescriptionView {
  text: string;
  source: 'auto' | 'user';
  generatedAt: number;
}

export interface CronDetailView {
  cron: CronJobView;
  runs: CronRunSummaryView[];
  description: CronDescriptionView | null;
}

export interface CronRunTranscriptMessage {
  role: string;
  content: unknown;
  reasoning?: string | null;
  tool_calls?: Array<{
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
  tool_call_id?: string;
  timestamp?: number | string | null;
}

export interface CronRunTranscriptView {
  sessionId: string;
  messages: CronRunTranscriptMessage[];
}

// Generalized "context attachment" for the chat input. Today the input bar
// supports two flavours: a skill (auto-promoted from `/skill-name` text) and
// a cron job (attached via the "Edit in chat" button on its detail page).
export type AttachedContext =
  | { kind: 'skill'; slug: string }
  | { kind: 'cron'; id: string; name: string };

// Reasoning-effort levels offered in the chat-input selector. A subset of the
// levels Hermes accepts (it also supports "minimal"/"xhigh"); these are the
// ones we surface to non-technical users. Sent per message as
// `reasoningEffort` and applied by the gateway over its config.yaml default.
export const REASONING_EFFORTS = ['low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

// Models offered in the chat-input model selector, grouped by the provider
// that serves them (Codex OAuth vs Anthropic API key). Order defines the
// click-to-cycle sequence. Sent per message as `model` and applied by the
// gateway over its config.yaml default (validated server-side too; the
// orchestrator mirror lives in src/models/model-catalog.ts). The selector
// only cycles models whose provider is connected.
export const CODEX_CHAT_MODELS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'] as const;
export const ANTHROPIC_CHAT_MODELS = ['claude-opus-4-8', 'claude-fable-5', 'claude-sonnet-5', 'claude-haiku-4-5'] as const;
export const CHAT_MODELS = [...CODEX_CHAT_MODELS, ...ANTHROPIC_CHAT_MODELS] as const;
export type ChatModel = (typeof CHAT_MODELS)[number];

export const CHAT_MODEL_LABELS: Record<ChatModel, string> = {
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 mini',
  'claude-opus-4-8': 'Claude Opus 4.8',
  'claude-fable-5': 'Claude Fable 5',
  'claude-sonnet-5': 'Claude Sonnet 5',
  'claude-haiku-4-5': 'Claude Haiku 4.5',
};

export const DEFAULT_ANTHROPIC_CHAT_MODEL: ChatModel = ANTHROPIC_CHAT_MODELS[0];

export type ActivityStep =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool';
      id?: string;
      name: string;
      input?: unknown;
      result?: string;
      connection?: ConnectionRequestView;
    };

export interface ChatSSEEvent {
  type: string;
  message?: string | {
    role?: string;
    content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  };
  delta?: { text?: string } | string;
  reasoning?: string | null;
  reason?: string;
  provider?: string;
  session_id?: string;
  role?: string;
  content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  stop_reason?: string;
}
