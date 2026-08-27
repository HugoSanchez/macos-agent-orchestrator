import { existsSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ChatActivityStep,
  ChatMessageRecord,
} from './chat-store.ts';

interface HermesMessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string | null;
  tool_call_id: string | null;
  tool_calls: string | null;
  tool_name: string | null;
  timestamp: number;
  reasoning?: string | null;
  reasoning_content?: string | null;
}

interface ReadHermesMessagesOptions {
  hermesHome: string | null;
  hermesSessionId: string | null;
  versoSessionId: string;
  localMessages: ChatMessageRecord[];
}

interface ReadHermesSessionModelOptions {
  hermesHome: string | null;
  hermesSessionId: string | null;
}

interface ReadHermesSessionModelFromHomesOptions {
  hermesHomes: readonly string[];
  hermesSessionId: string | null;
}

interface MapHermesRowsOptions {
  hermesSessionId: string;
  versoSessionId: string;
  localMessages?: ChatMessageRecord[];
}

interface MutableChatMessageRecord extends ChatMessageRecord {
  steps?: ChatActivityStep[];
}

export function readHermesChatMessages(
  options: ReadHermesMessagesOptions,
): ChatMessageRecord[] | null {
  if (!options.hermesHome || !options.hermesSessionId) return null;

  const dbPath = join(options.hermesHome, 'state.db');
  if (!existsSync(dbPath)) return null;

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const columns = tableColumns(db, 'messages');
    const reasoningColumn = columns.has('reasoning') ? 'reasoning' : 'NULL AS reasoning';
    const reasoningContentColumn = columns.has('reasoning_content')
      ? 'reasoning_content'
      : 'NULL AS reasoning_content';
    const rows = db.prepare(`
      SELECT id, session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp,
             ${reasoningColumn}, ${reasoningContentColumn}
      FROM messages
      WHERE session_id = ?
      ORDER BY timestamp ASC, id ASC
    `).all(options.hermesSessionId) as unknown as HermesMessageRow[];

    if (rows.length === 0) return null;

    const messages = mapHermesRowsToChatMessages(rows, {
      hermesSessionId: options.hermesSessionId,
      versoSessionId: options.versoSessionId,
      localMessages: options.localMessages,
    });
    return messages.length > 0 ? messages : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

// Hermes is the authoritative execution record for an already-run turn. Use
// its persisted model when migrating Verso sessions created before the model
// field existed, rather than guessing from today's global gateway default.
export function readHermesSessionModel(
  options: ReadHermesSessionModelOptions,
): string | null {
  if (!options.hermesHome || !options.hermesSessionId) return null;

  const dbPath = join(options.hermesHome, 'state.db');
  if (!existsSync(dbPath)) return null;

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    if (!tableColumns(db, 'sessions').has('model')) return null;
    const row = db.prepare('SELECT model FROM sessions WHERE id = ?')
      .get(options.hermesSessionId) as { model?: unknown } | undefined;
    return normalizedText(typeof row?.model === 'string' ? row.model : null);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

// Verso originally wrote Hermes state into this app-support home. Keep it as
// a read-only migration source after moving to a profile-specific Hermes home;
// otherwise a profile migration would make historical model selection appear
// unknowable even though Hermes retained the execution record.
export function hermesHistoryHomeCandidates(activeHermesHome: string | null): string[] {
  const legacyHermesHome = join(
    os.homedir(),
    'Library',
    'Application Support',
    'Verso',
    'hermes-home',
  );
  return Array.from(new Set([activeHermesHome, legacyHermesHome].filter(
    (home): home is string => Boolean(home?.trim()),
  )));
}

export function readHermesSessionModelFromHomes(
  options: ReadHermesSessionModelFromHomesOptions,
): string | null {
  for (const hermesHome of options.hermesHomes) {
    const model = readHermesSessionModel({ hermesHome, hermesSessionId: options.hermesSessionId });
    if (model) return model;
  }
  return null;
}

export function mapHermesRowsToChatMessages(
  rows: HermesMessageRow[],
  options: MapHermesRowsOptions,
): ChatMessageRecord[] {
  const hermesMessages = buildHermesTranscript(rows, options)
    .filter((message) => (
      message.content.trim().length > 0
      || (message.steps?.length ?? 0) > 0
      || (message.reasoning?.trim().length ?? 0) > 0
    ))
    .map((message) => ({
      ...message,
      steps: message.steps && message.steps.length > 0 ? message.steps : undefined,
      reasoning: normalizedText(message.reasoning) ?? undefined,
    }));

  if (options.localMessages && options.localMessages.length > 0) {
    return mergeWithLocalMessageSkeleton(hermesMessages, options.localMessages);
  }

  return hermesMessages;
}

function buildHermesTranscript(
  rows: HermesMessageRow[],
  options: MapHermesRowsOptions,
): MutableChatMessageRecord[] {
  const messages: MutableChatMessageRecord[] = [];
  let currentAssistant: MutableChatMessageRecord | null = null;
  let currentTurnStartedAt: number | undefined;

  const ensureAssistant = (row: HermesMessageRow, forceNew = false): MutableChatMessageRecord => {
    if (currentAssistant && !forceNew) return currentAssistant;

    const timestamp = timestampToMs(row.timestamp);
    currentAssistant = {
      id: `hermes-${options.hermesSessionId}-assistant-${row.id}`,
      sessionId: options.versoSessionId,
      role: 'assistant',
      content: '',
      createdAt: timestampToIso(row.timestamp),
      startedAt: forceNew ? timestamp : (currentTurnStartedAt ?? timestamp),
      endedAt: timestamp,
      steps: [],
    };
    messages.push(currentAssistant);
    return currentAssistant;
  };

  for (const row of rows) {
    const timestamp = timestampToMs(row.timestamp);

    if (row.role === 'user') {
      currentAssistant = null;
      currentTurnStartedAt = timestamp;

      const content = row.content ?? '';
      if (content.trim().length === 0) continue;
      messages.push({
        id: `hermes-${options.hermesSessionId}-${row.id}`,
        sessionId: options.versoSessionId,
        role: 'user',
        content,
        createdAt: timestampToIso(row.timestamp),
      });
      continue;
    }

    if (row.role === 'assistant') {
      const toolCalls = parseToolCalls(row.tool_calls);
      const content = row.content ?? '';
      const reasoning = readableReasoning(row);

      if (toolCalls.length === 0 && content.trim().length === 0 && !reasoning) continue;

      const startsNewImplicitTurn = toolCalls.length > 0
        && hasAssistantContent(currentAssistant);
      const assistant = ensureAssistant(row, startsNewImplicitTurn);
      assistant.endedAt = timestamp;
      assistant.createdAt = timestampToIso(row.timestamp);
      assistant.reasoning = appendReasoning(assistant.reasoning, reasoning);
      if (reasoning) {
        assistant.steps = appendReasoningStep(assistant.steps ?? [], reasoning);
      }

      if (toolCalls.length === 0 && content.trim().length === 0) continue;

      if (toolCalls.length > 0) {
        if (content.trim().length > 0) {
          assistant.steps = [...(assistant.steps ?? []), { type: 'text', text: content }];
        }
        assistant.steps = [
          ...(assistant.steps ?? []),
          ...toolCalls.map(toolCallToStep),
        ];
      } else if (assistant.content.trim().length > 0) {
        assistant.content = `${assistant.content}\n\n${content}`;
      } else {
        assistant.content = content;
      }
      continue;
    }

    if (row.role === 'tool') {
      const assistant = ensureAssistant(row);
      assistant.endedAt = timestamp;
      assistant.createdAt = timestampToIso(row.timestamp);
      attachToolResult(
        assistant,
        row.tool_call_id ?? undefined,
        row.content ?? '',
        row.tool_name ?? undefined,
      );
    }
  }

  return messages;
}

function hasAssistantContent(message: MutableChatMessageRecord | null): boolean {
  return (message?.content.trim().length ?? 0) > 0;
}

function parseToolCalls(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function toolCallToStep(toolCall: unknown): ChatActivityStep {
  const record = asRecord(toolCall) ?? {};
  const fn = asRecord(record.function) ?? {};
  const id = stringValue(record.call_id) ?? stringValue(record.id);
  const name = stringValue(fn.name) ?? stringValue(record.name) ?? 'tool';
  const input = parseJsonMaybe(fn.arguments ?? record.arguments ?? record.input);

  return {
    type: 'tool',
    ...(id ? { id } : {}),
    name,
    ...(input === undefined ? {} : { input }),
  };
}

function appendReasoningStep(steps: ChatActivityStep[], reasoning: string): ChatActivityStep[] {
  const last = steps.at(-1);
  if (last?.type === 'reasoning') {
    return [
      ...steps.slice(0, -1),
      { ...last, text: `${last.text}\n\n${reasoning}` },
    ];
  }
  return [...steps, { type: 'reasoning', text: reasoning }];
}

function attachToolResult(
  assistant: MutableChatMessageRecord,
  toolUseId: string | undefined,
  result: string,
  fallbackName: string | undefined,
): void {
  const steps = [...(assistant.steps ?? [])];

  if (toolUseId) {
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const step = steps[index];
      if (step.type === 'tool' && step.id === toolUseId && !step.result) {
        steps[index] = { ...step, result };
        assistant.steps = steps;
        return;
      }
    }
  }

  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step.type === 'tool' && !step.result) {
      steps[index] = { ...step, result };
      assistant.steps = steps;
      return;
    }
  }

  steps.push({
    type: 'tool',
    ...(toolUseId ? { id: toolUseId } : {}),
    name: fallbackName || 'tool',
    result,
  });
  assistant.steps = steps;
}

function mergeWithLocalMessageSkeleton(
  hermesMessages: ChatMessageRecord[],
  localMessages: ChatMessageRecord[],
): ChatMessageRecord[] {
  const hermesAssistantMessages = hermesMessages.filter((message) => message.role === 'assistant');
  const merged: ChatMessageRecord[] = [];
  let assistantCursor = 0;
  let lastUserStartedAt: number | undefined;

  for (const localMessage of localMessages) {
    if (localMessage.role === 'user') {
      // If Hermes completed a response that Verso did not persist (for
      // example, the app exited between the gateway finishing and the local
      // write), restore it before the next user turn instead of moving it to
      // the end of the transcript.
      const userStartedAt = isoToMs(localMessage.createdAt);
      const recovered = takeAssistantFragmentsThrough(
        hermesAssistantMessages,
        assistantCursor,
        userStartedAt,
        false,
      );
      if (recovered.fragments.length > 0) {
        merged.push(coalesceAssistantFragments(recovered.fragments));
        assistantCursor = recovered.nextCursor;
      }

      lastUserStartedAt = isoToMs(localMessage.createdAt);
      merged.push(localMessage);
      continue;
    }

    const localEndedAt = isoToMs(localMessage.createdAt);
    let matched = takeAssistantFragmentsThrough(
      hermesAssistantMessages,
      assistantCursor,
      localEndedAt,
    );

    // Invalid legacy timestamps cannot be compared safely. Preserve the old
    // sequential fallback for those records, but only consume one fragment.
    if (matched.fragments.length === 0 && localEndedAt === undefined) {
      const fallback = hermesAssistantMessages[assistantCursor];
      if (fallback) {
        matched = { fragments: [fallback], nextCursor: assistantCursor + 1 };
      }
    }
    assistantCursor = matched.nextCursor;
    const hermesTurn = matched.fragments.length > 0
      ? coalesceAssistantFragments(matched.fragments)
      : null;

    const endedAt = localEndedAt ?? hermesTurn?.endedAt;
    const startedAt = lastUserStartedAt ?? hermesTurn?.startedAt;
    merged.push({
      ...localMessage,
      content: localMessage.content || hermesTurn?.content || '',
      reasoning: hermesTurn?.reasoning ?? localMessage.reasoning,
      steps: hermesTurn?.steps ?? localMessage.steps,
      startedAt,
      endedAt,
    });
  }

  const remaining = hermesAssistantMessages.slice(assistantCursor);
  if (remaining.length > 0) {
    // A single Verso turn can contain many Hermes assistant rows (interim
    // text, tool calls, tool results, final text). Keep them one visible turn
    // even when recovering a response with no local assistant skeleton.
    merged.push(coalesceAssistantFragments(remaining));
  }

  return merged;
}

function takeAssistantFragmentsThrough(
  messages: ChatMessageRecord[],
  cursor: number,
  deadline: number | undefined,
  inclusive = true,
): { fragments: ChatMessageRecord[]; nextCursor: number } {
  if (deadline === undefined) return { fragments: [], nextCursor: cursor };

  const fragments: ChatMessageRecord[] = [];
  let nextCursor = cursor;
  while (nextCursor < messages.length) {
    const message = messages[nextCursor];
    const timestamp = message.endedAt ?? isoToMs(message.createdAt);
    if (timestamp === undefined || (inclusive ? timestamp > deadline : timestamp >= deadline)) break;
    fragments.push(message);
    nextCursor += 1;
  }
  return { fragments, nextCursor };
}

function coalesceAssistantFragments(fragments: ChatMessageRecord[]): ChatMessageRecord {
  const first = fragments[0];
  const last = fragments.at(-1) ?? first;
  const content = fragments
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join('\n\n');
  const reasoning = fragments.reduce<string | undefined>(
    (current, message) => appendReasoning(current, normalizedText(message.reasoning)),
    undefined,
  );
  const steps = fragments.flatMap((message) => message.steps ?? []);
  const startedAt = fragments
    .map((message) => message.startedAt)
    .find((value): value is number => value !== undefined);
  const endedAt = [...fragments]
    .reverse()
    .map((message) => message.endedAt)
    .find((value): value is number => value !== undefined);

  return {
    ...first,
    content,
    createdAt: last.createdAt,
    reasoning,
    steps: steps.length > 0 ? steps : undefined,
    startedAt,
    endedAt,
  };
}

function tableColumns(db: DatabaseSync, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: unknown }>;
  return new Set(rows.map((row) => typeof row.name === 'string' ? row.name : '').filter(Boolean));
}

function readableReasoning(row: HermesMessageRow): string | null {
  return normalizedText(row.reasoning) ?? normalizedText(row.reasoning_content);
}

function normalizedText(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
}

function appendReasoning(existing: string | null | undefined, next: string | null): string | undefined {
  const current = normalizedText(existing);
  if (!next) return current ?? undefined;
  if (!current) return next;
  if (current === next || current.includes(next)) return current;
  return `${current}\n\n${next}`;
}

function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function timestampToMs(timestamp: number): number {
  return timestamp * 1000;
}

function timestampToIso(timestamp: number): string {
  return new Date(timestampToMs(timestamp)).toISOString();
}

function isoToMs(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
