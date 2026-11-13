import type {
  ActivityStep,
  ChatMessage,
  ChatSSEEvent,
  ConnectionRequestView,
} from './types';

/** Applies one Hermes SSE event to an in-progress assistant message. */
export function applyChatSSEEvent(msg: ChatMessage, event: ChatSSEEvent): ChatMessage {
  const steps = msg.steps ?? [];
  const ev = event as any;

  if (event.type === 'assistant') {
    const blocks = ev.message?.content ?? ev.content ?? [];
    let newSteps = steps;
    let newContent = msg.content;

    for (const block of blocks) {
      if (block.type === 'text' && block.text) {
        newContent = block.text;
      } else if (block.type === 'tool_use') {
        // Preserve intermediate prose before the tool in chronological order.
        const trimmed = newContent.trim();
        if (trimmed) newSteps = [...newSteps, { type: 'text', text: trimmed }];
        newContent = '';
        newSteps = [...newSteps, {
          type: 'tool',
          id: block.id,
          name: block.name ?? 'tool',
          input: block.input,
        }];
      }
    }
    return { ...msg, steps: newSteps, content: newContent };
  }

  if (event.type === 'user') {
    const blocks = ev.message?.content ?? ev.content ?? [];
    if (!Array.isArray(blocks)) return msg;
    let newSteps = steps;
    for (const block of blocks) {
      if (block.type !== 'tool_result') continue;
      const toolUseId = block.tool_use_id;
      const result = stringifyToolResult(block.content);
      newSteps = attachResult(newSteps, toolUseId, result, block.content);
    }
    return { ...msg, steps: newSteps };
  }

  if (event.type === 'content_block_delta' || event.type === 'text') {
    const delta = ev.delta?.text ?? ev.text ?? '';
    return { ...msg, content: msg.content + delta };
  }

  if (event.type === 'commentary') {
    const text = typeof event.text === 'string' ? event.text.trim() : '';
    if (!text) return msg;
    // Hermes supplies the complete visible message, which can be longer than
    // the prefix already streamed. Promote it once before the next tool or
    // final answer, using the same text steps as ordinary tool-call prose.
    const pending = msg.content.trim();
    const preceding = pending && !event.already_streamed && pending !== text
      ? [...steps, { type: 'text' as const, text: pending }]
      : steps;
    const last = preceding[preceding.length - 1];
    const nextSteps = last?.type === 'text' && last.text === text
      ? preceding
      : [...preceding, { type: 'text' as const, text }];
    return { ...msg, content: '', steps: nextSteps };
  }

  if (event.type === 'reasoning_delta') {
    const delta = typeof ev.delta === 'string' ? ev.delta : ev.delta?.text ?? ev.text ?? '';
    if (!delta) return msg;
    const reasoning = appendReasoningDelta(msg.reasoning, delta);
    return { ...msg, reasoning, steps: appendReasoningStep(steps, delta) };
  }

  if (event.type === 'reasoning') {
    const reasoning = typeof ev.reasoning === 'string' ? ev.reasoning.trim() : '';
    if (!reasoning) return msg;
    return {
      ...msg,
      reasoning: mergeFinalReasoning(msg.reasoning, reasoning),
      steps: mergeFinalReasoningStep(steps, reasoning),
    };
  }

  if (event.type === 'result') {
    const text = ev.result ?? '';
    if (text) return { ...msg, content: text };
  }

  if (event.type === 'error') {
    return { ...msg, content: msg.content + `\n\n**Error:** ${event.message ?? 'Unknown error'}` };
  }

  if (event.type === 'done') {
    return { ...msg, isStreaming: false, endedAt: Date.now() };
  }

  return msg;
}

function appendReasoningDelta(existing: string | null | undefined, delta: string): string {
  const current = typeof existing === 'string' ? existing : '';
  return current + delta;
}

function mergeFinalReasoning(existing: string | null | undefined, next: string): string {
  const current = typeof existing === 'string' ? existing.trim() : '';
  if (!current) return next;
  if (isSameReasoning(current, next)) return current;
  return `${current}\n\n${next}`;
}

function appendReasoningStep(steps: ActivityStep[], delta: string): ActivityStep[] {
  const items = [...steps];
  const last = items[items.length - 1];
  if (last?.type === 'reasoning') {
    items[items.length - 1] = { ...last, text: last.text + delta };
    return items;
  }
  return [...items, { type: 'reasoning', text: delta }];
}

function mergeFinalReasoningStep(steps: ActivityStep[], reasoning: string): ActivityStep[] {
  const current = steps
    .filter((step): step is Extract<ActivityStep, { type: 'reasoning' }> => step.type === 'reasoning')
    .map((step) => step.text)
    .join('\n\n');
  if (current && isSameReasoning(current, reasoning)) return steps;
  return [...steps, { type: 'reasoning', text: reasoning }];
}

function isSameReasoning(a: string, b: string): boolean {
  const left = normalizeReasoningForCompare(a);
  const right = normalizeReasoningForCompare(b);
  return left === right || left.includes(right) || right.includes(left);
}

function normalizeReasoningForCompare(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((entry) => (typeof entry === 'string' ? entry : entry?.text ?? JSON.stringify(entry)))
      .join('\n');
  }
  if (content == null) return '';
  try { return JSON.stringify(content); } catch { return String(content); }
}

function attachResult(
  steps: ActivityStep[],
  toolUseId: string | undefined,
  result: string,
  rawContent?: unknown,
): ActivityStep[] {
  const items = [...steps];
  const connection = parseConnectionRequest(rawContent);
  if (toolUseId) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const step = items[index];
      if (step.type === 'tool' && step.id === toolUseId && !step.result) {
        items[index] = connection ? { ...step, result, connection } : { ...step, result };
        return items;
      }
    }
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const step = items[index];
    if (step.type === 'tool' && !step.result) {
      items[index] = connection ? { ...step, result, connection } : { ...step, result };
      return items;
    }
  }
  return items;
}

function parseConnectionRequest(content: unknown): ConnectionRequestView | null {
  const target = unwrapConnectionPayload(content);
  if (!target) return null;

  const id = typeof target.id === 'string' ? target.id : '';
  const toolkitSlug = typeof target.toolkitSlug === 'string' ? target.toolkitSlug : '';
  const toolkitName = typeof target.toolkitName === 'string' ? target.toolkitName : '';
  const status = target.status;
  if (!id || !toolkitSlug || !toolkitName) return null;
  if (status !== 'pending' && status !== 'connected' && status !== 'failed' && status !== 'expired') return null;

  return {
    id,
    toolkitSlug,
    toolkitName,
    logoUrl: typeof target.logoUrl === 'string' ? target.logoUrl : null,
    status,
    redirectUrl: typeof target.redirectUrl === 'string' ? target.redirectUrl : null,
    connectedAccountId: typeof target.connectedAccountId === 'string' ? target.connectedAccountId : null,
    errorMessage: typeof target.errorMessage === 'string' ? target.errorMessage : null,
  };
}

function unwrapConnectionPayload(content: unknown): Record<string, unknown> | null {
  let current = normalizeConnectionPayload(content);
  for (let index = 0; index < 4; index += 1) {
    if (!current) return null;
    if (current.kind === 'connection_request') return asRecord(current.request) ?? current;
    if (current.structuredContent !== undefined) {
      current = normalizeConnectionPayload(current.structuredContent);
      continue;
    }
    if (current.result !== undefined) {
      current = normalizeConnectionPayload(current.result);
      continue;
    }
    return current;
  }
  return current;
}

function normalizeConnectionPayload(content: unknown): Record<string, unknown> | null {
  if (typeof content === 'string') {
    try {
      return asRecord(JSON.parse(content));
    } catch {
      return null;
    }
  }
  if (Array.isArray(content)) {
    const text = content
      .map((item) => asRecord(item))
      .map((item) => typeof item?.text === 'string' ? item.text : '')
      .filter(Boolean)
      .join('\n')
      .trim();
    return text ? normalizeConnectionPayload(text) : null;
  }
  return asRecord(content);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
