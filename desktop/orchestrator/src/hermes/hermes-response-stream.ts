import type { ChatAttachment } from '../chat/attachments.ts';
import type { ChatMessageRecord } from '../chat/chat-store.ts';
import { extractAssistantText, hermesGatewayAuthHeaders } from './hermes-gateway-client.ts';
import type { HermesGatewayConfig } from './hermes-runtime-config.ts';
import type { ChatModel } from '../models/model-catalog.ts';

export const HERMES_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type HermesReasoningEffort = (typeof HERMES_REASONING_EFFORTS)[number];
export type HermesEventPayload = Record<string, unknown> | null;

export class HermesHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, message: string) {
    super(message);
    this.name = 'HermesHttpError';
    this.status = status;
    this.body = body;
  }
}

export interface HermesConversationStreamOptions {
  conversation: string;
  userPrompt: string;
  attachments?: ChatAttachment[];
  conversationHistory: ChatMessageRecord[] | null;
  reasoningEffort?: HermesReasoningEffort | null;
  model?: ChatModel | null;
  signal: AbortSignal;
  onSessionId: (sessionId: string) => void;
  onEvent: (eventName: string, data: HermesEventPayload) => void;
}

export async function streamHermesConversation(
  config: HermesGatewayConfig,
  opts: HermesConversationStreamOptions,
): Promise<void> {
  const payload = buildHermesRequestBody({
    conversation: opts.conversation,
    userPrompt: opts.userPrompt,
    conversationHistory: opts.conversationHistory,
    reasoningEffort: opts.reasoningEffort,
    model: opts.model,
    attachments: opts.attachments,
  });
  await streamHermesResponse(config, payload, opts);
}

export function buildHermesRequestBody(opts: {
  conversation: string;
  userPrompt: string;
  conversationHistory: ChatMessageRecord[] | null;
  reasoningEffort?: HermesReasoningEffort | null;
  model?: ChatModel | null;
  attachments?: ChatAttachment[];
}): Record<string, unknown> {
  // Documents are converted to Markdown before this boundary. Only images
  // become multimodal parts in the live Responses request.
  const imageAttachments = (opts.attachments ?? [])
    .filter((attachment) => attachment.kind === 'image');
  const input = imageAttachments.length > 0
    ? [{
        role: 'user',
        content: [
          ...(opts.userPrompt ? [{ type: 'input_text', text: opts.userPrompt }] : []),
          ...imageAttachments.map((attachment) => ({
            type: 'input_image',
            image_url: `data:${attachment.mimeType};base64,${attachment.dataBase64}`,
          })),
        ],
      }]
    : opts.userPrompt;

  const body: Record<string, unknown> = {
    input,
    conversation: opts.conversation,
    truncation: 'auto',
    stream: true,
    store: true,
  };

  if (opts.reasoningEffort) {
    body.reasoning = { effort: opts.reasoningEffort };
  }
  if (opts.model) {
    body.model = opts.model;
  }
  if (opts.conversationHistory && opts.conversationHistory.length > 0) {
    body.conversation_history = opts.conversationHistory.map((message) => ({
      role: message.role,
      content: message.content,
    }));
  }

  return body;
}

async function streamHermesResponse(
  config: HermesGatewayConfig,
  body: Record<string, unknown>,
  opts: Pick<HermesConversationStreamOptions, 'signal' | 'onSessionId' | 'onEvent'>,
): Promise<void> {
  const res = await fetch(`${config.baseUrl}/v1/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...hermesGatewayAuthHeaders(config),
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    const responseBody = await safeReadBody(res);
    throw new HermesHttpError(
      res.status,
      responseBody,
      `Hermes response stream failed (HTTP ${res.status})${responseBody ? `: ${responseBody}` : ''}`,
    );
  }

  const hermesSessionId = res.headers.get('x-hermes-session-id');
  if (hermesSessionId) opts.onSessionId(hermesSessionId);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r\n\r\n|\n\n|\r\r/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) emitSseFrame(frame, opts.onEvent);
    }

    buffer += decoder.decode();
    if (buffer.trim().length > 0) emitSseFrame(buffer, opts.onEvent);
  } catch (error: unknown) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function emitSseFrame(
  frame: string,
  onEvent: HermesConversationStreamOptions['onEvent'],
): void {
  const parsed = parseSseFrame(frame);
  if (parsed) onEvent(parsed.event, parsed.data);
}

export function parseSseFrame(
  frame: string,
): { event: string; data: HermesEventPayload } | null {
  const lines = frame
    .split(/\r?\n|\r/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  if (lines.length === 0 || lines.every((line) => line.startsWith(':'))) return null;

  let eventName = 'message';
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim() || eventName;
      continue;
    }
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }

  if (dataLines.length === 0) return { event: eventName, data: null };

  try {
    const parsed = JSON.parse(dataLines.join('\n'));
    return parsed && typeof parsed === 'object'
      ? { event: eventName, data: parsed as Record<string, unknown> }
      : { event: eventName, data: null };
  } catch {
    return { event: eventName, data: null };
  }
}

export function extractResponseId(data: HermesEventPayload): string | null {
  const responseId = asRecord(data?.response)?.id;
  return typeof responseId === 'string' && responseId.length > 0 ? responseId : null;
}

export function extractFinalResponseText(data: HermesEventPayload): string {
  return extractAssistantText(asRecord(data?.response));
}

export function extractResponseError(data: HermesEventPayload): string {
  const message = asRecord(asRecord(data?.response)?.error)?.message;
  return typeof message === 'string' ? message : '';
}

export function isReasoningDeltaEvent(eventName: string): boolean {
  return eventName === 'hermes.reasoning.delta'
    || eventName === 'response.reasoning_text.delta'
    || eventName === 'response.reasoning_summary_text.delta';
}

export function extractReasoningDelta(data: HermesEventPayload): string {
  const delta = data?.delta;
  if (typeof delta === 'string') return delta;
  if (typeof data?.text === 'string') return data.text;
  const nestedText = asRecord(delta)?.text;
  return typeof nestedText === 'string' ? nestedText : '';
}

export function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== 'string' || !value.trim()) return value;
  try {
    return JSON.parse(value.trim());
  } catch {
    return value;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function shouldRetryWithoutCursor(error: unknown): boolean {
  return error instanceof HermesHttpError
    && error.status === 404
    && /previous response not found/i.test(error.body);
}

export function isHermesGatewayAuthFailure(error: unknown): boolean {
  return error instanceof HermesHttpError
    && error.status === 401
    && /invalid[_ ]api[_ ]key|unauthorized/i.test(error.body);
}

async function safeReadBody(res: Response): Promise<string> {
  try {
    return (await res.text()).trim();
  } catch {
    return '';
  }
}
