import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatAttachment } from '../src/chat/attachments.ts';
import {
  HermesHttpError,
  buildHermesRequestBody,
  isHermesGatewayAuthFailure,
  parseSseFrame,
  shouldRetryWithoutCursor,
  streamHermesConversation,
} from '../src/hermes/hermes-response-stream.ts';
import type { HermesGatewayConfig } from '../src/hermes/hermes-supervisor.ts';

const config: HermesGatewayConfig = {
  baseUrl: 'http://hermes.test',
  startupTimeoutMs: 1_000,
  apiKey: 'gateway-key',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Hermes response stream', () => {
  it('builds one request body for text, image, model, reasoning, and recovery history', () => {
    const attachments: ChatAttachment[] = [
      { name: 'photo.png', mimeType: 'image/png', dataBase64: 'aW1hZ2U=', kind: 'image' },
      { name: 'notes.pdf', mimeType: 'application/pdf', dataBase64: 'ZG9jdW1lbnQ=', kind: 'document' },
    ];

    expect(buildHermesRequestBody({
      conversation: 'session-1',
      userPrompt: 'What is shown?',
      conversationHistory: [
        {
          id: 'message-1',
          sessionId: 'session-1',
          role: 'user',
          content: 'Earlier question',
          createdAt: '2026-08-18T00:00:00.000Z',
        },
      ],
      reasoningEffort: 'high',
      model: 'gpt-5.2',
      attachments,
    })).toEqual({
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: 'What is shown?' },
          { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' },
        ],
      }],
      conversation: 'session-1',
      truncation: 'auto',
      stream: true,
      store: true,
      reasoning: { effort: 'high' },
      model: 'gpt-5.2',
      conversation_history: [{ role: 'user', content: 'Earlier question' }],
    });
  });

  it('decodes CRLF frames split across arbitrary network chunks', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> | null }> = [];
    const sessionIds: string[] = [];
    const chunks = [
      ': keep-alive\r\n\r\nevent: response.created\r\ndata: {"response":{"id":"resp_1"}}\r\n\r\nevent: response.output_text.delta\r\ndata: {"delta":"Hel',
      'lo"}\r\n\r\nevent: response.completed\r\ndata: {"response":{"status":"completed"}}',
    ];
    const fetchMock = vi.fn(async () => chunkedEventStream(chunks, {
      'x-hermes-session-id': 'hermes-session-1',
    }));
    vi.stubGlobal('fetch', fetchMock);

    await streamHermesConversation(config, {
      conversation: 'session-1',
      userPrompt: 'Hello',
      conversationHistory: null,
      signal: new AbortController().signal,
      onSessionId: (sessionId) => sessionIds.push(sessionId),
      onEvent: (event, data) => events.push({ event, data }),
    });

    expect(sessionIds).toEqual(['hermes-session-1']);
    expect(events).toEqual([
      { event: 'response.created', data: { response: { id: 'resp_1' } } },
      { event: 'response.output_text.delta', data: { delta: 'Hello' } },
      { event: 'response.completed', data: { response: { status: 'completed' } } },
    ]);
    expect(fetchMock).toHaveBeenCalledWith('http://hermes.test/v1/responses', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer gateway-key' }),
    }));
  });

  it('parses comments, default event names, and malformed payloads safely', () => {
    expect(parseSseFrame(': heartbeat')).toBeNull();
    expect(parseSseFrame('data: {"ok":true}')).toEqual({ event: 'message', data: { ok: true } });
    expect(parseSseFrame('event: response.failed\ndata: not-json')).toEqual({
      event: 'response.failed',
      data: null,
    });
  });

  it('preserves HTTP status and body for retry classification', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'invalid_api_key' } }),
      { status: 401 },
    )));

    let caught: unknown;
    try {
      await streamHermesConversation(config, {
        conversation: 'session-1',
        userPrompt: 'Hello',
        conversationHistory: null,
        signal: new AbortController().signal,
        onSessionId: () => undefined,
        onEvent: () => undefined,
      });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HermesHttpError);
    expect(caught).toMatchObject({ status: 401 });
    expect(isHermesGatewayAuthFailure(caught)).toBe(true);
    expect(shouldRetryWithoutCursor(caught)).toBe(false);

    const missingCursor = new HermesHttpError(404, 'Previous response not found', 'missing');
    expect(shouldRetryWithoutCursor(missingCursor)).toBe(true);
    expect(isHermesGatewayAuthFailure(missingCursor)).toBe(false);
  });
});

function chunkedEventStream(chunks: string[], headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers });
}
