import type {
  ChatModel,
  ChatSessionSummary,
  ChatSSEEvent,
  ConnectionRequestView,
  ConnectionView,
  CustomConnectorView,
  HubSkillDetailView,
  HubSkillInstallView,
  HubSkillSummaryView,
  SkillDetailView,
  SkillSummaryView,
  StoredChatMessage,
  ToolkitView,
} from './types';
import { postShellAction } from './shell-bridge';

let sidecarPort: number | null = null;
let sidecarToken: string | null = null;
let draftApprovalToken: string | null = null;

// Tell the native host that a piece of sidebar state changed. The Swift shell
// listens via WKScriptMessageHandler('chatBridge') and refetches the
// corresponding endpoint. Using this on every mutating helper means the
// sidebar stays in sync without a polling timer.
//
// Session mutations no longer use this — they post `ShellAction.sessionMutated`
// via `postShellAction` instead, which Swift's `handleShellAction` routes
// through the consolidated channel. Cron/skill mutations still use the
// lightweight refresh bridge because Swift owns those sidebar collections.
function notifyHost(kind: 'crons-changed' | 'skills-changed'): void {
  postShellAction({ kind });
}

function notifyConnectionsChanged(): void {
  postShellAction({ kind: 'connections-changed' });
}

export function setSidecarPort(port: number) {
  sidecarPort = port;
}

export function setSidecarAuthToken(token: string | null | undefined) {
  sidecarToken = token || null;
}

export function setDraftApprovalToken(token: string | null | undefined) {
  draftApprovalToken = token || null;
}

export function getSidecarPort(): number | null {
  return sidecarPort;
}

export function baseURL(): string {
  if (!sidecarPort) throw new Error('Sidecar port not set');
  return `http://127.0.0.1:${sidecarPort}`;
}

export function resolveSidecarUrl(value: string | null): string | null {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/')) return `${baseURL()}${value}`;
  return value;
}

export function sidecarFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (sidecarToken) headers.set('X-Verso-Sidecar-Token', sidecarToken);
  return fetch(input, { ...init, headers });
}

// Shared wrapper for the non-streaming endpoints: hit the sidecar, convert a
// non-OK response into an Error carrying the server's message (falling back
// to `errorMsg`), then parse the JSON body. 204/no-content responses resolve
// to `undefined` so body-less endpoints can share it.
async function requestJson<T>(path: string, errorMsg: string, init?: RequestInit): Promise<T> {
  const res = await sidecarFetch(`${baseURL()}${path}`, init);
  if (!res.ok) {
    throw new Error(await readError(res, errorMsg));
  }
  if (res.status === 204) return undefined as T;
  return await res.json() as T;
}

function jsonInit(method: string, payload: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

export async function createChatSession(title?: string, model?: ChatModel): Promise<ChatSessionSummary> {
  const body = await requestJson<{ session: ChatSessionSummary }>(
    '/chat/sessions',
    'Failed to create chat session',
    jsonInit('POST', { ...(title ? { title } : {}), ...(model ? { model } : {}) }),
  );
  return body.session;
}

export async function updateChatSessionModel(sessionId: string, model: ChatModel): Promise<ChatSessionSummary> {
  const body = await requestJson<{ session: ChatSessionSummary }>(
    `/chat/sessions/${encodeURIComponent(sessionId)}/model`,
    'Failed to save chat model',
    jsonInit('POST', { model }),
  );
  return body.session;
}

export async function getChatSessions(): Promise<ChatSessionSummary[]> {
  const body = await requestJson<{ sessions: ChatSessionSummary[] }>('/chat/sessions', 'Failed to load chat sessions');
  return Array.isArray(body.sessions) ? body.sessions : [];
}

export async function archiveChatSession(sessionId: string): Promise<ChatSessionSummary> {
  const body = await requestJson<{ session: ChatSessionSummary }>(
    `/chat/sessions/${encodeURIComponent(sessionId)}/archive`,
    'Failed to archive chat session',
    { method: 'POST' },
  );
  return body.session;
}

export async function unarchiveChatSession(sessionId: string): Promise<ChatSessionSummary> {
  const body = await requestJson<{ session: ChatSessionSummary }>(
    `/chat/sessions/${encodeURIComponent(sessionId)}/unarchive`,
    'Failed to restore chat session',
    { method: 'POST' },
  );
  return body.session;
}

export async function getChatMessages(sessionId: string): Promise<StoredChatMessage[]> {
  const body = await requestJson<{ messages: StoredChatMessage[] }>(
    `/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
    'Failed to load chat messages',
  );
  return body.messages;
}

export function streamChatMessage(
  sessionId: string,
  content: string,
  onEvent: (event: ChatSSEEvent) => void,
  onDone: () => void,
  onError: (err: string) => void,
  options: {
    attached?: import('./types').AttachedContext | null;
    attachments?: import('./types').OutgoingAttachment[];
    reasoningEffort?: string | null;
    model?: string | null;
  } = {},
): () => void {
  const controller = new AbortController();

  // Skills travel via the slash text (`/skill body`), so we only forward the
  // structured `attached` field for cron context — the orchestrator does the
  // Hermes round-trip to inject the cron's current state.
  const attached = options.attached?.kind === 'cron'
    ? { kind: 'cron' as const, id: options.attached.id }
    : undefined;

  const requestBody: Record<string, unknown> = { content };
  if (attached) requestBody.attached = attached;
  if (options.attachments && options.attachments.length > 0) {
    requestBody.attachments = options.attachments.map(({ name, mimeType, dataBase64 }) => ({
      name,
      mimeType,
      dataBase64,
    }));
  }
  if (options.reasoningEffort) requestBody.reasoningEffort = options.reasoningEffort;
  if (options.model) requestBody.model = options.model;

  (async () => {
    try {
      const res = await sidecarFetch(`${baseURL()}/chat/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        onError(await readError(res, `HTTP ${res.status}`));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n');
        buffer = frames.pop() ?? '';

        for (const line of frames) {
          if (!line.startsWith('data: ')) continue;
          try {
            const parsed = JSON.parse(line.slice(6)) as ChatSSEEvent;
            onEvent(parsed);
          } catch {
            // Skip malformed lines.
          }
        }
      }

      onDone();
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') return;
      onError(error instanceof Error ? error.message : String(error));
    }
  })();

  return () => controller.abort();
}

export async function cancelChatRequest(sessionId: string): Promise<void> {
  await sidecarFetch(`${baseURL()}/chat/sessions/${encodeURIComponent(sessionId)}/cancel`, {
    method: 'POST',
  });
}

export async function getConnections(opts: { fast?: boolean } = {}): Promise<{
  available: boolean;
  configured: boolean;
  connections: ConnectionView[];
}> {
  // fast: bound the sidecar's remote sync so boot paints from the local
  // cache when Composio is slow; callers follow up with a full fetch.
  const path = opts.fast ? '/connections?wait=1200' : '/connections';
  return requestJson(path, 'Failed to load connections');
}

export async function getCustomConnectors(): Promise<CustomConnectorView[]> {
  const body = await requestJson<{ connectors?: CustomConnectorView[] }>(
    '/connectors/custom',
    'Failed to load custom connectors',
  );
  return Array.isArray(body.connectors) ? body.connectors : [];
}

export async function addCustomConnector(input: { name: string; url: string; token?: string }): Promise<CustomConnectorView> {
  const body = await requestJson<{ connector: CustomConnectorView }>(
    '/connectors/custom',
    'Failed to add custom connector',
    jsonInit('POST', input),
  );
  notifyConnectionsChanged();
  return body.connector;
}

export async function disconnectCustomConnector(id: string): Promise<void> {
  await requestJson<void>(
    `/connectors/custom/${encodeURIComponent(id)}`,
    'Failed to disconnect custom connector',
    { method: 'DELETE' },
  );
  notifyConnectionsChanged();
}

export async function retryCustomConnector(id: string): Promise<CustomConnectorView> {
  const body = await requestJson<{ connector: CustomConnectorView }>(
    `/connectors/custom/${encodeURIComponent(id)}/retry`,
    'Failed to retry custom connector',
    { method: 'POST' },
  );
  notifyConnectionsChanged();
  return body.connector;
}

export async function getToolkits(opts: {
  query?: string;
  cursor?: string;
  limit?: number;
} = {}): Promise<{
  toolkits: ToolkitView[];
  nextCursor: string | null;
}> {
  const params = new URLSearchParams();
  if (opts.query) params.set('query', opts.query);
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (typeof opts.limit === 'number') params.set('limit', String(opts.limit));
  const suffix = params.toString().length > 0 ? `?${params.toString()}` : '';
  const body = await requestJson<{ toolkits: ToolkitView[]; nextCursor?: string | null }>(
    `/connections/toolkits${suffix}`,
    'Failed to load toolkits',
  );
  return {
    toolkits: body.toolkits ?? [],
    nextCursor: body.nextCursor ?? null,
  };
}

export async function getSkills(): Promise<SkillSummaryView[]> {
  const body = await requestJson<{ skills: SkillSummaryView[] }>('/skills', 'Failed to load skills');
  return Array.isArray(body.skills) ? body.skills : [];
}

export async function getSkill(slug: string): Promise<SkillDetailView> {
  const body = await requestJson<{ skill: SkillDetailView }>(
    `/skills/${encodeURIComponent(slug)}`,
    'Failed to load skill',
  );
  return body.skill;
}

export async function getHubSkills(opts: {
  query?: string;
  source?: string;
  limit?: number;
} = {}): Promise<{
  skills: HubSkillSummaryView[];
  sourceCounts: Record<string, number>;
  timedOutSources: string[];
}> {
  const params = new URLSearchParams();
  if (opts.query) params.set('query', opts.query);
  if (opts.source) params.set('source', opts.source);
  if (typeof opts.limit === 'number') params.set('limit', String(opts.limit));
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const body = await requestJson<{
    skills?: HubSkillSummaryView[];
    sourceCounts?: Record<string, number>;
    timedOutSources?: string[];
  }>(`/skills/hub${suffix}`, 'Failed to load Skills Hub');
  return {
    skills: Array.isArray(body.skills) ? body.skills : [],
    sourceCounts: body.sourceCounts ?? {},
    timedOutSources: Array.isArray(body.timedOutSources) ? body.timedOutSources : [],
  };
}

export async function getHubSkill(identifier: string): Promise<HubSkillDetailView> {
  const body = await requestJson<{ skill: HubSkillDetailView }>(
    `/skills/hub/${encodeURIComponent(identifier)}`,
    'Failed to load hub skill',
  );
  return body.skill;
}

export async function installHubSkill(identifier: string): Promise<HubSkillInstallView> {
  const body = await requestJson<HubSkillInstallView>(
    `/skills/hub/${encodeURIComponent(identifier)}/install`,
    'Failed to install hub skill',
    { method: 'POST' },
  );
  notifyHost('skills-changed');
  return body;
}

export async function toggleSkill(slug: string, enabled: boolean): Promise<SkillSummaryView> {
  const body = await requestJson<{ skill: SkillSummaryView }>(
    `/skills/${encodeURIComponent(slug)}/toggle`,
    'Failed to toggle skill',
    jsonInit('POST', { enabled }),
  );
  notifyHost('skills-changed');
  return body.skill;
}

export interface IngestionSourceView {
  source: string;
  displayName: string;
  logoUrl: string | null;
  stream: string;
  connected: boolean;
  enabled: boolean;
  status: 'idle' | 'running' | 'failed';
  lastCompletedAt: string | null;
  lastError: string | null;
  nextDueAt: string | null;
  itemCount: number;
}

export async function getIngestionSources(): Promise<IngestionSourceView[]> {
  const body = await requestJson<{ sources: IngestionSourceView[] }>(
    '/ingestion/sources',
    'Failed to load ingestion sources',
  );
  return body.sources;
}

export async function toggleIngestionSource(slug: string, enabled: boolean): Promise<IngestionSourceView> {
  const body = await requestJson<{ source: IngestionSourceView }>(
    `/ingestion/sources/${encodeURIComponent(slug)}/toggle`,
    'Failed to toggle ingestion source',
    jsonInit('POST', { enabled }),
  );
  return body.source;
}

export async function getCronDetail(id: string): Promise<import('./types').CronDetailView> {
  return requestJson(`/crons/${encodeURIComponent(id)}`, 'Failed to load cron job');
}

export async function getCronRunOutput(id: string, filename: string): Promise<string> {
  const body = await requestJson<{ content: string }>(
    `/crons/${encodeURIComponent(id)}/runs/${encodeURIComponent(filename)}`,
    'Failed to load run output',
  );
  return body.content;
}

export async function generateCronDescription(id: string, force = false): Promise<import('./types').CronDescriptionView | null> {
  const body = await requestJson<{ description: import('./types').CronDescriptionView | null }>(
    `/crons/${encodeURIComponent(id)}/description/generate`,
    'Failed to generate description',
    jsonInit('POST', { force }),
  );
  return body.description;
}

export async function patchCronDescription(id: string, description: string): Promise<import('./types').CronDescriptionView | null> {
  const body = await requestJson<{ description: import('./types').CronDescriptionView | null }>(
    `/crons/${encodeURIComponent(id)}/description`,
    'Failed to update description',
    jsonInit('PATCH', { description }),
  );
  return body.description;
}

export async function getCronRunTranscript(id: string, filename: string): Promise<import('./types').CronRunTranscriptView | null> {
  const res = await sidecarFetch(`${baseURL()}/crons/${encodeURIComponent(id)}/runs/${encodeURIComponent(filename)}/transcript`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to load run transcript'));
  }
  return res.json() as Promise<import('./types').CronRunTranscriptView>;
}

export async function patchCron(id: string, payload: Partial<{
  name: string;
  schedule: string;
  prompt: string;
  deliver: string;
  skills: string[];
}>): Promise<import('./types').CronJobView> {
  const body = await requestJson<{ cron: import('./types').CronJobView }>(
    `/crons/${encodeURIComponent(id)}`,
    'Failed to update cron job',
    jsonInit('PATCH', payload),
  );
  notifyHost('crons-changed');
  return body.cron;
}

export async function deleteCron(id: string): Promise<void> {
  await requestJson<void>(`/crons/${encodeURIComponent(id)}`, 'Failed to delete cron job', { method: 'DELETE' });
  notifyHost('crons-changed');
}

export async function cronAction(id: string, op: 'pause' | 'resume' | 'run'): Promise<import('./types').CronJobView> {
  const body = await requestJson<{ cron: import('./types').CronJobView }>(
    `/crons/${encodeURIComponent(id)}/${op}`,
    `Failed to ${op} cron job`,
    { method: 'POST' },
  );
  notifyHost('crons-changed');
  return body.cron;
}

export async function pinSkill(slug: string, pinned: boolean): Promise<SkillSummaryView> {
  const body = await requestJson<{ skill: SkillSummaryView }>(
    `/skills/${encodeURIComponent(slug)}/pin`,
    'Failed to pin skill',
    jsonInit('POST', { pinned }),
  );
  notifyHost('skills-changed');
  return body.skill;
}

export async function getConnectionRequest(requestId: string): Promise<ConnectionRequestView> {
  const body = await requestJson<{ request: ConnectionRequestView }>(
    `/connections/requests/${encodeURIComponent(requestId)}`,
    'Failed to load connection request',
  );
  return body.request;
}

export async function createConnectionRequest(toolkit: string): Promise<ConnectionRequestView> {
  const body = await requestJson<{ request: ConnectionRequestView }>(
    '/connections/request',
    'Failed to create connection request',
    jsonInit('POST', { toolkit }),
  );
  return body.request;
}

export function openConnectionRequest(requestId: string): void {
  openExternalUrl(`${baseURL()}/connections/requests/${encodeURIComponent(requestId)}/open`);
}

export function openCustomConnectorAuth(connectorId: string): void {
  openExternalUrl(`${baseURL()}/connectors/custom/${encodeURIComponent(connectorId)}/open`);
}

export function openExternalUrl(url: string): void {
  if (window.webkit?.messageHandlers?.chatBridge) {
    postShellAction({ kind: 'open-external-url', url });
    return;
  }

  window.open(url, '_blank', 'noopener,noreferrer');
}

export interface AgentBrowserStatus {
  supported: boolean;
  enabled: boolean;
  running: boolean;
  settings: { allowPrivateUrls: boolean };
}

export async function getAgentBrowserStatus(): Promise<AgentBrowserStatus> {
  return requestJson('/browser/status', 'Failed to load agent browser status');
}

export async function openAgentBrowser(): Promise<AgentBrowserStatus> {
  return requestJson('/browser/open', 'Failed to open the agent browser', { method: 'POST' });
}

export async function resetAgentBrowser(): Promise<AgentBrowserStatus> {
  return requestJson('/browser/reset', 'Failed to clear agent browser data', { method: 'POST' });
}

export async function setAgentBrowserPrivateUrls(allow: boolean): Promise<{ allowPrivateUrls: boolean }> {
  const body = await requestJson<{ settings: { allowPrivateUrls: boolean } }>(
    '/browser/settings',
    'Failed to update agent browser settings',
    jsonInit('POST', { allowPrivateUrls: allow }),
  );
  return body.settings;
}

export interface CodexStatus {
  connected: boolean;
  count: number;
}

export async function getCodexStatus(): Promise<CodexStatus> {
  return requestJson('/model-auth/codex/status', 'Failed to load Codex status');
}

export async function disconnectCodex(): Promise<{ removed: number }> {
  return requestJson('/model-auth/codex/disconnect', 'Failed to disconnect Codex', { method: 'POST' });
}

export function codexConnectUrl(): string {
  return `${baseURL()}/model-auth/codex/start`;
}

export interface AnthropicStatus {
  connected: boolean;
}

export async function getAnthropicStatus(): Promise<AnthropicStatus> {
  return requestJson('/model-auth/anthropic/status', 'Failed to load Anthropic status');
}

// Validates the key against the Anthropic API before storing, so this can
// take a few seconds; a rejected key surfaces as a thrown error with the
// orchestrator's message ("Anthropic rejected this API key…").
export async function connectAnthropic(apiKey: string): Promise<void> {
  await requestJson<void>('/model-auth/anthropic/connect', 'Failed to connect Anthropic', jsonInit('POST', { apiKey }));
}

export async function disconnectAnthropic(): Promise<void> {
  await requestJson<void>('/model-auth/anthropic/disconnect', 'Failed to disconnect Anthropic', { method: 'POST' });
}

export interface DraftSendInput {
  channel: string;
  to: string;
  cc?: string;
  subject?: string;
  body: string;
  threadId?: string;
}

// The draft endpoints stay on raw `sidecarFetch`: their fallback error
// message embeds the live HTTP status, which `requestJson`'s static message
// can't express.

// The model ends its turn after proposing, so sending is a direct
// UI → orchestrator action.
export async function sendDraft(
  draftId: string,
  sessionId: string,
  payload: DraftSendInput,
): Promise<void> {
  const res = await sidecarFetch(`${baseURL()}/drafts/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(draftApprovalToken ? { 'X-Verso-Draft-Approval-Token': draftApprovalToken } : {}),
    },
    body: JSON.stringify({ ...payload, draftId, sessionId }),
  });
  if (!res.ok) {
    throw new Error(await readError(res, `Failed to send draft (HTTP ${res.status})`));
  }
}

export async function discardDraft(
  draftId: string,
  sessionId: string,
  channel: string,
): Promise<void> {
  const res = await sidecarFetch(`${baseURL()}/drafts/${encodeURIComponent(draftId)}/discard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, channel }),
  });
  if (!res.ok) {
    throw new Error(await readError(res, `Failed to discard draft (HTTP ${res.status})`));
  }
}

/**
 * Deterministic draft id derived from the agent's tool args. Must match the
 * orchestrator's `draftIdForArgs` in composio-bridge.ts byte-for-byte.
 */
export function draftIdForArgs(args: unknown): string {
  return `draft_${fnv1a32(stableStringify(args))}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.text();
    if (!body) return fallback;
    try {
      const parsed = JSON.parse(body) as { message?: unknown; output?: unknown };
      if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message;
      if (typeof parsed.output === 'string' && parsed.output.trim()) return parsed.output;
    } catch {
      // fall through to raw body
    }
    return body;
  } catch {
    return fallback;
  }
}
