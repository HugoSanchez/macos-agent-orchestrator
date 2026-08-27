import type { ServerResponse } from 'node:http';
import { json, route, type Route } from '../http/router.ts';
import {
  ChatStore,
  type ChatMessageRecord,
  type ChatSessionRecord,
  type ChatSessionSummary,
} from './chat-store.ts';
import {
  ChatRequestRegistry,
  type ActiveChatRequest,
  type ActiveChatRequestSnapshot,
} from './chat-request-registry.ts';
import { applyDraftResolutions } from './draft-resolutions.ts';
import { HermesSupervisor, type HermesGatewayConfig } from '../hermes/hermes-supervisor.ts';
import { hermesOneShotText } from '../hermes/hermes-gateway-client.ts';
import {
  HERMES_REASONING_EFFORTS,
  asRecord,
  extractFinalResponseText,
  extractReasoningDelta,
  extractResponseError,
  extractResponseId,
  isHermesGatewayAuthFailure,
  isReasoningDeltaEvent,
  parseJsonMaybe,
  shouldRetryWithoutCursor,
  streamHermesConversation,
  type HermesEventPayload,
  type HermesReasoningEffort,
} from '../hermes/hermes-response-stream.ts';
import {
  hermesHistoryHomeCandidates,
  readHermesChatMessages,
  readHermesSessionModelFromHomes,
} from './hermes-history.ts';
import { VALID_CHAT_MODELS, type ChatModel } from '../models/model-catalog.ts';
import {
  buildSkillInvocationPrompt,
  extractSlashSkillRequest,
  findSkillBySlug,
} from '../skills/skills.ts';
import { HermesCronsClient, type HermesCronJob } from '../crons/hermes-crons-client.ts';
import {
  AttachmentValidationError,
  appendAttachmentMarkers,
  parseChatAttachments,
  type ChatAttachment,
} from './attachments.ts';
import {
  buildDocumentContextBlock,
  convertDocumentToMarkdown,
} from './document-conversion.ts';
import { type MemoryExtractionScheduler } from '../memory/memory-extraction.ts';
import { ManagedBackendClient } from '../integrations/managed-backend-client.ts';

type ChatStatus = 'idle' | 'running';

export function buildChatRoutes(
  store: ChatStore,
  hermes: HermesSupervisor,
  managedBackend: ManagedBackendClient,
  requests: ChatRequestRegistry,
  memoryExtraction?: MemoryExtractionScheduler,
  defaultModelForNewSession?: () => Promise<ChatModel | null>,
): Route[] {
  return [
    route('GET', '/chat/status', async (_req, res) => {
      const gateway = await hermes.getStatus();
      const activeSessionIds = requests.sessionIds();
      json(res, 200, {
        status: requests.size > 0 ? 'running' : 'idle',
        provider: 'hermes',
        hasActiveRequest: requests.size > 0,
        activeSessionIds,
        sessionCount: store.listSessions().length,
        gateway: {
          url: gateway.baseUrl,
          reachable: gateway.reachable,
          state: gateway.state,
          source: gateway.source,
          launchConfigured: gateway.launchConfigured,
        },
      });
    }),

    route('GET', '/chat/sessions', async (_req, res) => {
      const sessions = hydrateSessionSummaries(store);
      json(res, 200, { sessions });
    }),

    route('POST', '/chat/sessions', async (_req, res, _params, body) => {
      const title = typeof (body as { title?: unknown } | null)?.title === 'string'
        ? ((body as { title?: string }).title ?? undefined)
        : undefined;
      const requestedModel = parseChatModel(body);
      if (hasModelField(body) && !requestedModel) {
        return json(res, 400, { error: 'bad_request', message: 'Invalid "model"' });
      }
      const defaultModel = requestedModel
        ? null
        : await defaultModelForNewSession?.().catch(() => null);
      const session = store.createSession(title, requestedModel ?? defaultModel ?? undefined);
      managedBackend.recordAnalyticsEvent({ eventType: 'session_created', sessionId: session.id });
      json(res, 201, { session });
    }),

    route('GET', '/chat/sessions/:id', async (_req, res, params) => {
      const record = store.getSessionRecord(params.id);
      if (!record) {
        return json(res, 404, { error: 'not_found', message: `Unknown session: ${params.id}` });
      }
      const session = hydrateSessionSummary(record, store);
      json(res, 200, { session });
    }),

    route('GET', '/chat/sessions/:id/messages', async (_req, res, params) => {
      const record = store.getSessionRecord(params.id);
      if (!record) {
        return json(res, 404, { error: 'not_found', message: `Unknown session: ${params.id}` });
      }
      const messages = hydrateSessionMessages(record, store, hermes);
      json(res, 200, { messages });
    }),

    route('POST', '/chat/sessions/:id/rename', async (_req, res, params, body) => {
      const title = typeof (body as { title?: unknown } | null)?.title === 'string'
        ? ((body as { title?: string }).title ?? '').trim()
        : '';
      if (!title) {
        return json(res, 400, { error: 'bad_request', message: 'Missing "title"' });
      }

      const record = store.renameSession(params.id, title);
      if (!record) {
        return json(res, 404, { error: 'not_found', message: `Unknown session: ${params.id}` });
      }

      const session = hydrateSessionSummary(record, store);
      json(res, 200, { session });
    }),

    route('POST', '/chat/sessions/:id/archive', async (_req, res, params) => {
      const record = store.archiveSession(params.id);
      if (!record) {
        return json(res, 404, { error: 'not_found', message: `Unknown session: ${params.id}` });
      }
      const session = hydrateSessionSummary(record, store);
      json(res, 200, { session });
    }),

    route('POST', '/chat/sessions/:id/unarchive', async (_req, res, params) => {
      const record = store.unarchiveSession(params.id);
      if (!record) {
        return json(res, 404, { error: 'not_found', message: `Unknown session: ${params.id}` });
      }
      const session = hydrateSessionSummary(record, store);
      json(res, 200, { session });
    }),

    route('POST', '/chat/sessions/:id/model', async (_req, res, params, body) => {
      const model = parseChatModel(body);
      if (!model) {
        return json(res, 400, { error: 'bad_request', message: 'Invalid "model"' });
      }
      const record = store.setSessionModel(params.id, model);
      if (!record) {
        return json(res, 404, { error: 'not_found', message: `Unknown session: ${params.id}` });
      }
      json(res, 200, { session: hydrateSessionSummary(record, store) });
    }),

    route('POST', '/chat/sessions/:id/messages', async (req, res, params, body) => {
      let record = store.getSessionRecord(params.id);
      if (!record) {
        return json(res, 404, { error: 'not_found', message: `Unknown session: ${params.id}` });
      }

      const content = typeof (body as { content?: unknown } | null)?.content === 'string'
        ? ((body as { content?: string }).content ?? '').trim()
        : '';
      let attachments: ChatAttachment[];
      try {
        attachments = parseChatAttachments(body);
      } catch (error: unknown) {
        const message = error instanceof AttachmentValidationError
          ? error.message
          : 'Invalid "attachments"';
        return json(res, 400, { error: 'bad_request', message });
      }
      if (!content && attachments.length === 0) {
        return json(res, 400, { error: 'bad_request', message: 'Missing "content"' });
      }

      const attached = parseAttached(body);
      const reasoningEffort = parseReasoningEffort(body);
      // The composer sends its selection with every message so a click and an
      // immediate send are atomic from the user's perspective. Persist it
      // before dispatching so a relaunch or reopen cannot route this session
      // through a different provider later.
      const requestedModel = parseChatModel(body);
      if (requestedModel && requestedModel !== record.model) {
        record = store.setSessionModel(params.id, requestedModel) ?? record;
      }
      // A sidecar can remain alive during an upgrade, so recover from Hermes
      // here too instead of relying solely on the startup migration.
      if (!requestedModel && !parseStoredChatModel(record.model)) {
        const hermesModel = readHermesSessionModelFromHomes({
          hermesHomes: hermesHistoryHomeCandidates(hermes.hermesHome),
          hermesSessionId: record.hermesSessionId,
        });
        const recoveredModel = parseStoredChatModel(hermesModel);
        if (recoveredModel) {
          record = store.setSessionModel(params.id, recoveredModel) ?? record;
        }
      }
      const model = requestedModel ?? parseStoredChatModel(record.model);
      if (!model) {
        return json(res, 409, {
          error: 'model_required',
          message: 'Choose a model for this legacy conversation before sending.',
        });
      }

      // Convert any document attachments to Markdown locally before we open the
      // SSE stream, so a conversion failure surfaces as a clean 400 instead of
      // a mid-stream error. Images need no conversion — they ride the wire.
      let documentContext: string;
      try {
        documentContext = await buildDocumentContext(attachments);
      } catch (error: unknown) {
        const message = error instanceof AttachmentValidationError
          ? error.message
          : 'Could not read an attached document';
        return json(res, 400, { error: 'bad_request', message });
      }

      const priorMessageCount = store.getMessages(params.id)?.length ?? 0;
      const isFirstUserMessage = priorMessageCount === 0;

      // Reserve before appending the message or starting Hermes. This closes
      // the duplicate-send race without blocking independent sessions.
      const activeRequest = requests.begin(params.id, hermes.gatewayConfig.baseUrl);
      if (!activeRequest) {
        return json(res, 409, {
          error: 'conflict',
          message: 'A chat request is already running for this session',
        });
      }

      let responseStarted = false;
      try {
        store.appendMessage(params.id, 'user', appendAttachmentMarkers(content, attachments));
        managedBackend.recordAnalyticsEvent({ eventType: 'message_sent', sessionId: params.id });
        let promptForHermes = content;
        if (attached?.kind === 'cron') {
          // Fetch the cron's current state and prepend it as a system block so
          // the agent can reason about — and edit — the job via its `cronjob`
          // tool. If the fetch fails, fall through to the raw user text.
          const cronContext = await buildCronContextPrompt(hermes, attached.id, content)
            .catch(() => null);
          if (cronContext) promptForHermes = cronContext;
        } else {
          const slashRequest = extractSlashSkillRequest(content);
          const skill = slashRequest ? findSkillBySlug(slashRequest.slug) : null;
          if (skill && slashRequest) {
            promptForHermes = buildSkillInvocationPrompt(skill, slashRequest.remainder, params.id);
          }
        }
        // Markers ride inside the prompt text (and thus Hermes' own transcript
        // and any history rebuild); the actual image bytes only travel on the
        // live request as `input_image` parts. Converted document Markdown is
        // injected here too, as a delimited block per document — never stored.
        promptForHermes = appendAttachmentMarkers(promptForHermes, attachments);
        if (documentContext) {
          promptForHermes = promptForHermes
            ? `${promptForHermes}\n\n${documentContext}`
            : documentContext;
        }

        const session = hydrateSessionSummary(record, store);

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        responseStarted = true;

        try {
          await runHermesMessage({
            session,
            sessionRecord: record,
            activeRequest,
            userPrompt: promptForHermes,
            attachments,
            isFirstUserMessage,
            reasoningEffort,
            model,
            res,
          }, store, hermes, managedBackend, memoryExtraction);
        } catch (error: unknown) {
          if (isAbortError(error)) {
            sendSSE(res, { type: 'done', reason: 'aborted', session_id: session.id });
          } else {
            const message = error instanceof Error ? error.message : String(error);
            sendSSE(res, { type: 'error', message, session_id: session.id });
          }
        }
      } finally {
        requests.finish(activeRequest);
        if (responseStarted) res.end();
      }
    }),

    route('POST', '/chat/sessions/:id/cancel', async (_req, res, params) => {
      const session = store.getSessionRecord(params.id);
      if (!session) {
        return json(res, 404, { error: 'not_found', message: `Unknown session: ${params.id}` });
      }

      if (!requests.cancel(params.id)) {
        return json(res, 200, { status: 'no_active_request' });
      }
      json(res, 200, { status: 'stopped' });
    }),
  ];
}

export function buildChatDiagnostics(
  store: ChatStore,
  requests: ChatRequestRegistry,
  memoryExtraction?: MemoryExtractionScheduler,
): {
  status: ChatStatus;
  activeRequests: ActiveChatRequestSnapshot[];
  sessionCount: number;
  storePath: string;
  memoryExtraction?: ReturnType<MemoryExtractionScheduler['diagnostics']>;
} {
  return {
    status: requests.size > 0 ? 'running' : 'idle',
    activeRequests: requests.snapshots(),
    sessionCount: store.listSessions().length,
    storePath: store.path,
    ...(memoryExtraction ? { memoryExtraction: memoryExtraction.diagnostics() } : {}),
  };
}

// Convert every document attachment to Markdown and wrap each in a delimited,
// named block. Throws AttachmentValidationError (→ 400) if any document can't
// be read. Images are skipped — they reach the model as `input_image` parts.
async function buildDocumentContext(attachments: ChatAttachment[]): Promise<string> {
  const blocks: string[] = [];
  for (const attachment of attachments) {
    if (attachment.kind !== 'document') continue;
    const markdown = await convertDocumentToMarkdown(attachment.dataBase64);
    blocks.push(buildDocumentContextBlock(attachment.name, markdown));
  }
  return blocks.join('\n\n');
}

type AttachedContext = { kind: 'cron'; id: string };

// Reasoning-effort levels Hermes accepts (see hermes_constants.VALID_REASONING_EFFORTS).
// The chat-input selector sends one of these per message; anything else falls
// back to the gateway's config.yaml default.
function parseReasoningEffort(body: unknown): HermesReasoningEffort | null {
  const raw = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).reasoningEffort
    : undefined;
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return (HERMES_REASONING_EFFORTS as readonly string[]).includes(value)
    ? (value as HermesReasoningEffort)
    : null;
}

// Models the chat-input model selector may pick (Codex + Anthropic).
// Allowlisted so a stray client value can't ask the gateway to load an
// unauthenticated model; absent values let the gateway use its config.yaml
// default. Cross-provider dispatch happens via the api_server model_routes
// the supervisor writes — the gateway re-resolves provider credentials per
// routed alias.

function parseChatModel(body: unknown): ChatModel | null {
  const raw = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).model
    : undefined;
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return parseStoredChatModel(value);
}

function hasModelField(body: unknown): boolean {
  return Boolean(body && typeof body === 'object' && !Array.isArray(body)
    && Object.hasOwn(body as Record<string, unknown>, 'model'));
}

function parseStoredChatModel(value: string | null | undefined): ChatModel | null {
  return typeof value === 'string' && (VALID_CHAT_MODELS as readonly string[]).includes(value)
    ? (value as ChatModel)
    : null;
}

function parseAttached(body: unknown): AttachedContext | null {
  if (!body || typeof body !== 'object') return null;
  const raw = (body as Record<string, unknown>).attached;
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.kind === 'cron' && typeof obj.id === 'string' && obj.id.length > 0) {
    return { kind: 'cron', id: obj.id };
  }
  return null;
}

// Mirrors the spirit of buildSkillInvocationPrompt: prepend a system block
// describing the cron's current state so Hermes' agent can reason about it
// and (via its cronjob tool) make changes the user requests in plain text.
async function buildCronContextPrompt(
  hermes: HermesSupervisor,
  cronId: string,
  userText: string,
): Promise<string | null> {
  const config = await hermes.ensureReady();
  const client = new HermesCronsClient(config.baseUrl, config.apiKey ?? undefined);
  const cron = await client.get(cronId);
  if (!cron) return null;

  const lines = formatCronContextLines(cron);
  const trimmed = userText.trim();
  const sections = [
    `[SYSTEM: The user has attached the cron job "${cron.name}" (id: ${cron.id}) for review or editing. Its current state is below — to make changes, call the \`cronjob\` tool with action="update" (or "pause"/"resume"/"remove") and job_id="${cron.id}".]`,
    '',
    ...lines,
  ];
  if (trimmed.length > 0) {
    sections.push('', `User instruction: ${trimmed}`);
  } else {
    sections.push('', 'No additional instruction was provided. Acknowledge the cron and wait for the user.');
  }
  return sections.join('\n');
}

function formatCronContextLines(cron: HermesCronJob): string[] {
  const lines: string[] = [
    `- Name: ${cron.name}`,
    `- Schedule: ${cron.schedule_display ?? JSON.stringify(cron.schedule)}`,
    `- State: ${cron.state}${cron.enabled ? '' : ' (disabled)'}`,
  ];
  if (cron.next_run_at) lines.push(`- Next run: ${cron.next_run_at}`);
  if (cron.last_run_at) {
    const status = cron.last_status ? ` (${cron.last_status})` : '';
    lines.push(`- Last run: ${cron.last_run_at}${status}`);
  }
  if (cron.last_error) lines.push(`- Last error: ${cron.last_error}`);
  if (Array.isArray(cron.skills) && cron.skills.length > 0) {
    lines.push(`- Skills loaded on each run: ${cron.skills.join(', ')}`);
  }
  if (cron.deliver) lines.push(`- Deliver: ${cron.deliver}`);
  lines.push('');
  lines.push('Prompt:');
  lines.push(cron.prompt);
  return lines;
}

function hydrateSessionSummaries(store: ChatStore): ChatSessionSummary[] {
  return store.listSessionRecords().map((record) => hydrateSessionSummary(record, store));
}

function hydrateSessionMessages(
  record: ChatSessionRecord,
  store: ChatStore,
  hermes: HermesSupervisor,
): ChatMessageRecord[] {
  const localMessages = store.getMessages(record.id) ?? [];
  const hermesMessages = readHermesChatMessages({
    hermesHome: hermes.hermesHome,
    hermesSessionId: record.hermesSessionId,
    versoSessionId: record.id,
    localMessages,
  });
  const messages = hermesMessages ?? addLocalResponseTimings(localMessages);
  return applyDraftResolutions(messages, store.listDraftResolutions(record.id));
}

function addLocalResponseTimings(messages: ChatMessageRecord[]): ChatMessageRecord[] {
  let lastUserStartedAt: number | undefined;

  return messages.map((message) => {
    if (message.role === 'user') {
      lastUserStartedAt = Date.parse(message.createdAt);
      if (!Number.isFinite(lastUserStartedAt)) {
        lastUserStartedAt = undefined;
      }
      return message;
    }

    const endedAt = Date.parse(message.createdAt);
    return {
      ...message,
      startedAt: message.startedAt ?? lastUserStartedAt,
      endedAt: message.endedAt ?? (Number.isFinite(endedAt) ? endedAt : undefined),
    };
  });
}

function hydrateSessionSummary(
  record: ChatSessionRecord,
  store: ChatStore,
): ChatSessionSummary {
  const messages = store.getMessages(record.id) ?? [];
  const lastMessage = messages[messages.length - 1];
  const updatedAt = [
    record.updatedAt,
    lastMessage?.createdAt ?? null,
  ]
    .filter(Boolean)
    .sort()
    .at(-1) ?? record.updatedAt;

  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt,
    archivedAt: record.archivedAt,
    model: parseStoredChatModel(record.model),
    messageCount: messages.length,
    lastMessagePreview: lastMessage ? preview(lastMessage.content) : null,
  };
}

async function runHermesMessage(
  opts: {
    session: ChatSessionSummary;
    sessionRecord: ChatSessionRecord;
    activeRequest: ActiveChatRequest;
    userPrompt: string;
    attachments?: ChatAttachment[];
    isFirstUserMessage: boolean;
    reasoningEffort?: HermesReasoningEffort | null;
    model?: ChatModel | null;
    res: ServerResponse;
  },
  store: ChatStore,
  hermes: HermesSupervisor,
  managedBackend: ManagedBackendClient,
  memoryExtraction?: MemoryExtractionScheduler,
): Promise<void> {
  let toolCallCount = 0;
  const runtime = await hermes.getStatus(500);

  if (runtime.state !== 'ready') {
    sendSSE(opts.res, {
      type: 'status',
      provider: 'hermes',
      session_id: opts.session.id,
      message: 'Starting Hermes',
    });
  }

  let config = await hermes.ensureReady(opts.activeRequest.signal);
  opts.activeRequest.gatewayUrl = config.baseUrl;

  let streamedText = '';
  let finalText = '';
  let linkedHermesSessionId = opts.sessionRecord.hermesSessionId;

  const handleEvent = (eventName: string, data: HermesEventPayload) => {
    if (eventName === 'response.created') {
      const responseId = extractResponseId(data);
      if (responseId) {
        opts.activeRequest.responseId = responseId;
      }
      return;
    }

    if (eventName === 'response.output_text.delta') {
      const delta = typeof data?.delta === 'string' ? data.delta : '';
      if (!delta) return;
      streamedText += delta;
      sendSSE(opts.res, {
        type: 'content_block_delta',
        session_id: opts.session.id,
        delta: { text: delta },
      });
      return;
    }

    if (eventName === 'response.output_text.done') {
      const text = typeof data?.text === 'string' ? data.text : '';
      if (text) {
        finalText = text;
      }
      return;
    }

    if (isReasoningDeltaEvent(eventName)) {
      const delta = extractReasoningDelta(data);
      if (!delta) return;
      sendSSE(opts.res, {
        type: 'reasoning_delta',
        session_id: opts.session.id,
        delta: { text: delta },
      });
      return;
    }

    if (eventName === 'response.output_item.added') {
      const item = asRecord(data?.item);
      if (!item) return;

      if (item.type === 'function_call') {
        toolCallCount += 1;
        const toolName = typeof item.name === 'string' ? item.name : 'tool';
        sendSSE(opts.res, {
          type: 'assistant',
          session_id: opts.session.id,
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: typeof item.call_id === 'string' ? item.call_id : undefined,
              name: toolName,
              input: parseJsonMaybe(item.arguments),
            }],
          },
        });
        return;
      }

      if (item.type === 'function_call_output') {
        sendSSE(opts.res, {
          type: 'user',
          session_id: opts.session.id,
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: typeof item.call_id === 'string' ? item.call_id : undefined,
              content: parseJsonMaybe(item.output),
            }],
          },
        });
      }
      return;
    }

    if (eventName === 'response.completed') {
      finalText = extractFinalResponseText(data) || finalText || streamedText;
      return;
    }

    if (eventName === 'response.failed') {
      const message = extractResponseError(data) || 'Hermes response failed';
      throw new Error(message);
    }
  };

  try {
    await streamHermesConversation(config, {
      conversation: opts.session.id,
      userPrompt: opts.userPrompt,
      attachments: opts.attachments,
      conversationHistory: null,
      reasoningEffort: opts.reasoningEffort ?? null,
      model: opts.model ?? null,
      signal: opts.activeRequest.signal,
      onSessionId: (sessionId) => {
        linkedHermesSessionId = sessionId;
      },
      onEvent: handleEvent,
    });
  } catch (error: unknown) {
    if (isHermesGatewayAuthFailure(error)) {
      sendSSE(opts.res, {
        type: 'status',
        provider: 'hermes',
        session_id: opts.session.id,
        message: 'Reconnecting to Hermes',
      });

      streamedText = '';
      finalText = '';
      config = await hermes.recoverFromAuthFailure();
      opts.activeRequest.gatewayUrl = config.baseUrl;
      await streamHermesConversation(config, {
        conversation: opts.session.id,
        userPrompt: opts.userPrompt,
        attachments: opts.attachments,
        conversationHistory: null,
        reasoningEffort: opts.reasoningEffort ?? null,
        model: opts.model ?? null,
        signal: opts.activeRequest.signal,
        onSessionId: (sessionId) => {
          linkedHermesSessionId = sessionId;
        },
        onEvent: handleEvent,
      });
    } else if (shouldRetryWithoutCursor(error) && linkedHermesSessionId) {
      sendSSE(opts.res, {
        type: 'status',
        provider: 'hermes',
        session_id: opts.session.id,
        message: 'Recovering chat context',
      });

      streamedText = '';
      finalText = '';
      // Hermes evicted the previous_response_id from its LRU. Rebuild
      // context from our durable copy in `local_messages` and retry.
      const recoveryMessages = store.getMessages(opts.session.id) ?? [];

      await streamHermesConversation(config, {
        conversation: opts.session.id,
        userPrompt: opts.userPrompt,
        attachments: opts.attachments,
        conversationHistory: recoveryMessages,
        reasoningEffort: opts.reasoningEffort ?? null,
        model: opts.model ?? null,
        signal: opts.activeRequest.signal,
        onSessionId: (sessionId) => {
          linkedHermesSessionId = sessionId;
        },
        onEvent: handleEvent,
      });
    } else {
      throw error;
    }
  }

  if (linkedHermesSessionId && linkedHermesSessionId !== opts.sessionRecord.hermesSessionId) {
    store.linkHermesSession(opts.session.id, linkedHermesSessionId);
  }

  const assistantText = finalText || streamedText;
  const assistantReasoning = linkedHermesSessionId && assistantText
    ? readLatestAssistantReasoning({
      hermes,
      hermesSessionId: linkedHermesSessionId,
      versoSessionId: opts.session.id,
      localMessages: store.getMessages(opts.session.id) ?? [],
      assistantText,
    })
    : null;
  if (assistantReasoning) {
    sendSSE(opts.res, {
      type: 'reasoning',
      session_id: opts.session.id,
      reasoning: assistantReasoning,
    });
  }

  if (assistantText) {
    store.appendMessage(opts.session.id, 'assistant', assistantText);
  }

  store.touchSession(opts.session.id);
  memoryExtraction?.markPending(opts.session.id);

  managedBackend.recordAnalyticsEvent({
    eventType: 'message_completed',
    sessionId: opts.session.id,
    toolCallCount,
  });

  // The assistant response is complete at this point. Title generation is
  // follow-up bookkeeping and can take several seconds, so do not include it
  // in the response timer shown to the user.
  sendSSE(opts.res, { type: 'done', session_id: opts.session.id });

  if (opts.isFirstUserMessage && assistantText) {
    const currentTitle = store.getSessionRecord(opts.session.id)?.title ?? '';
    if (currentTitle === DEFAULT_SESSION_TITLE) {
      const title = await generateSessionTitle(config, opts.userPrompt, assistantText)
        .catch(() => null);
      if (title) {
        store.renameSession(opts.session.id, title);
        sendSSE(opts.res, { type: 'session_title', session_id: opts.session.id, title });
      }
    }
  }
}

function readLatestAssistantReasoning(opts: {
  hermes: HermesSupervisor;
  hermesSessionId: string;
  versoSessionId: string;
  localMessages: ChatMessageRecord[];
  assistantText: string;
}): string | null {
  const messages = readHermesChatMessages({
    hermesHome: opts.hermes.hermesHome,
    hermesSessionId: opts.hermesSessionId,
    versoSessionId: opts.versoSessionId,
    localMessages: opts.localMessages,
  });
  if (!messages) return null;

  const expectedText = opts.assistantText.trim();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    if (expectedText && message.content.trim() !== expectedText) continue;
    const reasoning = message.reasoning?.trim();
    return reasoning && reasoning.length > 0 ? reasoning : null;
  }

  return null;
}

const DEFAULT_SESSION_TITLE = 'New chat';
const TITLE_GEN_TIMEOUT_MS = 8_000;
const TITLE_PROMPT_TEMPLATE = (userPrompt: string, assistantText: string) =>
  `Generate a concise title (4-8 words) summarizing this conversation. Respond with ONLY the title — no quotes, no trailing punctuation, no "Title:" prefix.\n\nUser: ${userPrompt}\nAssistant: ${assistantText}`;

async function generateSessionTitle(
  config: HermesGatewayConfig,
  userPrompt: string,
  assistantText: string,
): Promise<string | null> {
  const raw = await hermesOneShotText(config, TITLE_PROMPT_TEMPLATE(userPrompt, assistantText), TITLE_GEN_TIMEOUT_MS);
  return sanitizeGeneratedTitle(raw);
}

function sanitizeGeneratedTitle(raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  const stripped = collapsed.replace(/^["'`“”‘’\s]+|["'`“”‘’\s.!?]+$/g, '').trim();
  if (!stripped) return null;
  const words = stripped.split(' ').filter(Boolean).slice(0, 8);
  const title = words.join(' ');
  return title.length > 0 ? title.slice(0, 80) : null;
}

function sendSSE(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof Error) {
    return error.name === 'AbortError' || /abort/i.test(error.message);
  }
  return false;
}


function preview(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  if (compact.length <= 120) return compact;
  return `${compact.slice(0, 120)}...`;
}
