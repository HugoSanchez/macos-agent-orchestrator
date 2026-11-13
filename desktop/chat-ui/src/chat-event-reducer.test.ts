import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyChatSSEEvent } from './chat-event-reducer';
import type { ChatMessage, ChatSSEEvent } from './types';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    isStreaming: true,
    ...overrides,
  };
}

function event(value: { type: string } & Record<string, unknown>): ChatSSEEvent {
  return value as unknown as ChatSSEEvent;
}

describe('applyChatSSEEvent', () => {
  afterEach(() => vi.useRealTimers());

  it('appends both content-block and plain text deltas', () => {
    const afterBlock = applyChatSSEEvent(
      message({ content: 'Hello' }),
      event({ type: 'content_block_delta', delta: { text: ', ' } }),
    );
    const afterText = applyChatSSEEvent(afterBlock, event({ type: 'text', text: 'world' }));

    expect(afterText.content).toBe('Hello, world');
  });

  it('uses an assistant text block as the authoritative current content', () => {
    const result = applyChatSSEEvent(
      message({ content: 'partial' }),
      event({ type: 'assistant', message: { content: [{ type: 'text', text: 'complete' }] } }),
    );

    expect(result.content).toBe('complete');
    expect(result.steps).toEqual([]);
  });

  it('promotes prose before a tool and keeps following prose as current content', () => {
    const result = applyChatSSEEvent(
      message({ content: '  First I will look.  ' }),
      event({
        type: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'search', input: { query: 'Verso' } },
          { type: 'text', text: 'Here is what I found.' },
        ],
      }),
    );

    expect(result.content).toBe('Here is what I found.');
    expect(result.steps).toEqual([
      { type: 'text', text: 'First I will look.' },
      { type: 'tool', id: 'tool-1', name: 'search', input: { query: 'Verso' } },
    ]);
  });

  it('attaches a string tool result to the matching unresolved tool', () => {
    const result = applyChatSSEEvent(
      message({
        steps: [
          { type: 'tool', id: 'tool-1', name: 'first' },
          { type: 'tool', id: 'tool-2', name: 'second' },
        ],
      }),
      event({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'found it' }] },
      }),
    );

    expect(result.steps).toEqual([
      { type: 'tool', id: 'tool-1', name: 'first', result: 'found it' },
      { type: 'tool', id: 'tool-2', name: 'second' },
    ]);
  });

  it.each([false, true])('keeps commentary before tools and the final answer separate (streamed=%s)', (streamed) => {
    let current = message({ content: streamed ? 'I will check' : '' });
    current = applyChatSSEEvent(current, event({
      type: 'commentary', text: 'I will check your calendar.', already_streamed: streamed,
    }));
    current = applyChatSSEEvent(current, event({
      type: 'assistant', content: [{ type: 'tool_use', id: 'calendar-1', name: 'calendar' }],
    }));
    current = applyChatSSEEvent(current, event({
      type: 'commentary', text: 'I found two conflicts.', already_streamed: false,
    }));
    current = applyChatSSEEvent(current, event({ type: 'text', text: 'Tuesday is available.' }));
    current = applyChatSSEEvent(current, event({ type: 'done' }));

    expect(current.content).toBe('Tuesday is available.');
    expect(current.steps).toEqual([
      { type: 'text', text: 'I will check your calendar.' },
      { type: 'tool', id: 'calendar-1', name: 'calendar', input: undefined },
      { type: 'text', text: 'I found two conflicts.' },
    ]);
    expect(current.reasoning).toBeUndefined();
    expect(current.isStreaming).toBe(false);
  });

  it('ignores empty commentary and does not duplicate a repeated boundary', () => {
    const original = message({ content: 'I will check your calendar.' });
    expect(applyChatSSEEvent(original, event({ type: 'commentary', text: '  ' }))).toBe(original);
    const update = event({ type: 'commentary', text: original.content, already_streamed: true });
    const result = applyChatSSEEvent(applyChatSSEEvent(original, update), update);
    expect(result.content).toBe('');
    expect(result.steps).toEqual([{ type: 'text', text: original.content }]);
  });

  it('falls back to the latest unresolved tool and stringifies multipart results', () => {
    const result = applyChatSSEEvent(
      message({
        steps: [
          { type: 'tool', id: 'tool-1', name: 'first', result: 'done' },
          { type: 'tool', id: 'tool-2', name: 'second' },
        ],
      }),
      event({
        type: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'missing',
          content: ['line one', { type: 'text', text: 'line two' }, { value: 3 }],
        }],
      }),
    );

    expect(result.steps?.[1]).toEqual({
      type: 'tool',
      id: 'tool-2',
      name: 'second',
      result: 'line one\nline two\n{"value":3}',
    });
  });

  it('turns a nested connection-request tool result into connection UI state', () => {
    const request = {
      id: 'request-1',
      toolkitSlug: 'google_drive',
      toolkitName: 'Google Drive',
      logoUrl: 'https://example.test/drive.png',
      status: 'pending',
      redirectUrl: 'https://example.test/connect',
      connectedAccountId: null,
      errorMessage: null,
    };
    const rawContent = [{
      type: 'text',
      text: JSON.stringify({ structuredContent: { kind: 'connection_request', request } }),
    }];

    const result = applyChatSSEEvent(
      message({ steps: [{ type: 'tool', id: 'connect-1', name: 'connect_toolkit' }] }),
      event({
        type: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'connect-1', content: rawContent }],
      }),
    );

    expect(result.steps?.[0]).toMatchObject({
      type: 'tool',
      id: 'connect-1',
      connection: request,
    });
  });

  it('does not create connection state for an invalid connection payload', () => {
    const rawContent = {
      kind: 'connection_request',
      request: { id: 'request-1', toolkitSlug: 'drive', status: 'unexpected' },
    };
    const result = applyChatSSEEvent(
      message({ steps: [{ type: 'tool', id: 'connect-1', name: 'connect_toolkit' }] }),
      event({
        type: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'connect-1', content: rawContent }],
      }),
    );

    expect(result.steps?.[0]).toEqual({
      type: 'tool',
      id: 'connect-1',
      name: 'connect_toolkit',
      result: JSON.stringify(rawContent),
    });
  });

  it('accumulates reasoning deltas in the message and the latest reasoning step', () => {
    const first = applyChatSSEEvent(
      message({ steps: [{ type: 'text', text: 'Earlier' }] }),
      event({ type: 'reasoning_delta', delta: 'Check ' }),
    );
    const second = applyChatSSEEvent(first, event({ type: 'reasoning_delta', delta: { text: 'facts' } }));

    expect(second.reasoning).toBe('Check facts');
    expect(second.steps).toEqual([
      { type: 'text', text: 'Earlier' },
      { type: 'reasoning', text: 'Check facts' },
    ]);
  });

  it('deduplicates a final reasoning summary already represented by deltas', () => {
    const original = message({
      reasoning: 'Check   the facts',
      steps: [{ type: 'reasoning', text: 'Check the facts' }],
    });
    const result = applyChatSSEEvent(
      original,
      event({ type: 'reasoning', reasoning: ' Check the facts ' }),
    );

    expect(result.reasoning).toBe('Check   the facts');
    expect(result.steps).toBe(original.steps);
  });

  it('keeps distinct final reasoning after streamed reasoning', () => {
    const result = applyChatSSEEvent(
      message({ reasoning: 'Initial thought', steps: [{ type: 'reasoning', text: 'Initial thought' }] }),
      event({ type: 'reasoning', reasoning: 'Final independent summary' }),
    );

    expect(result.reasoning).toBe('Initial thought\n\nFinal independent summary');
    expect(result.steps).toEqual([
      { type: 'reasoning', text: 'Initial thought' },
      { type: 'reasoning', text: 'Final independent summary' },
    ]);
  });

  it('uses a result event as authoritative final text', () => {
    const result = applyChatSSEEvent(
      message({ content: 'streamed partial' }),
      event({ type: 'result', result: 'authoritative result' }),
    );

    expect(result.content).toBe('authoritative result');
  });

  it('appends explicit and default error messages', () => {
    const explicit = applyChatSSEEvent(
      message({ content: 'Before' }),
      event({ type: 'error', message: 'Gateway unavailable' }),
    );
    const unknown = applyChatSSEEvent(message(), event({ type: 'error' }));

    expect(explicit.content).toBe('Before\n\n**Error:** Gateway unavailable');
    expect(unknown.content).toBe('\n\n**Error:** Unknown error');
  });

  it('marks the message done with a stable completion timestamp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T12:00:00.000Z'));

    const result = applyChatSSEEvent(message(), event({ type: 'done' }));

    expect(result.isStreaming).toBe(false);
    expect(result.endedAt).toBe(Date.parse('2026-08-18T12:00:00.000Z'));
  });

  it('returns the same object for unknown and empty reasoning events', () => {
    const original = message();

    expect(applyChatSSEEvent(original, event({ type: 'status', message: 'working' }))).toBe(original);
    expect(applyChatSSEEvent(original, event({ type: 'reasoning', reasoning: '  ' }))).toBe(original);
    expect(applyChatSSEEvent(original, event({ type: 'reasoning_delta', delta: '' }))).toBe(original);
  });
});
