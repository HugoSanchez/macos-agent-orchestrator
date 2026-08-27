import {
  asString,
  type IngestionBridge,
  type IngestionFetchResult,
  type IngestionItem,
  type SourceAdapter,
} from '../ingestion-source.ts';

const CLICKUP_GET_AUTHORIZED_TEAMS_WORKSPACES = 'CLICKUP_GET_AUTHORIZED_TEAMS_WORKSPACES';
const CLICKUP_GET_FILTERED_TEAM_TASKS = 'CLICKUP_GET_FILTERED_TEAM_TASKS';
const CLICKUP_GET_TASK_COMMENTS = 'CLICKUP_GET_TASK_COMMENTS';
const CLICKUP_GET_CHAT_CHANNELS = 'CLICKUP_GET_CHAT_CHANNELS';
const CLICKUP_GET_CHAT_MESSAGES = 'CLICKUP_GET_CHAT_MESSAGES';
const CLICKUP_GET_CHAT_MESSAGE_REPLIES = 'CLICKUP_GET_CHAT_MESSAGE_REPLIES';

const DEFAULT_CONTENT_LIMIT = 4000;
const TASK_PAGE_SIZE = 100;
const CHAT_PAGE_SIZE = 50;
const MAX_TASKS_PER_FETCH = 30;
const MAX_CHANNELS_PER_WORKSPACE = 100;
const MAX_REPLIES_PER_MESSAGE = 20;
const SEED_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

interface ClickupCursor {
  w: number;
}

interface Workspace {
  id: string;
  name: string;
}

interface TaskSummary {
  id: string;
  name: string;
  updatedMs: number;
  status: string;
  url: string;
  list: string;
  space: string;
  assignees: string[];
}

interface ClickupComment {
  id: string;
  dateMs: number;
  occurredAt: string;
  author: string;
  text: string;
}

interface ChatChannel {
  id: string;
  name: string;
}

interface ChatMessage {
  id: string;
  dateMs: number;
  occurredAt: string;
  author: string;
  text: string;
  repliesCount: number;
}

export class ClickupSource implements SourceAdapter {
  readonly source = 'clickup';
  readonly displayName = 'ClickUp';
  readonly logoUrl = 'https://logos.composio.dev/api/clickup';
  readonly defaultStream = '';
  readonly maxItemsPerBatch = 20;
  readonly seedLookbackMs = SEED_LOOKBACK_MS;

  private readonly contentLimit: number;

  constructor(
    private readonly bridge: IngestionBridge,
    opts: { contentLimit?: number } = {},
  ) {
    this.contentLimit = opts.contentLimit ?? DEFAULT_CONTENT_LIMIT;
  }

  seedCursor(now: Date, lookbackMs: number): string {
    return JSON.stringify({ w: Math.max(0, now.getTime() - lookbackMs) } satisfies ClickupCursor);
  }

  async fetchSince(_stream: string, cursorStr: string, opts: { maxItems: number }): Promise<IngestionFetchResult> {
    const cursor = parseCursor(cursorStr);
    const workspaces = await this.listWorkspaces();
    const items: IngestionItem[] = [];
    let maxSeen = cursor.w;
    let sawMore = false;

    for (const workspace of workspaces) {
      if (items.length >= opts.maxItems) {
        sawMore = true;
        break;
      }

      const tasks = await this.listUpdatedTasks(workspace, cursor.w);
      if (tasks.length >= MAX_TASKS_PER_FETCH) sawMore = true;
      for (const task of tasks) {
        if (items.length >= opts.maxItems) {
          sawMore = true;
          break;
        }
        const comments = await this.listFreshTaskComments(task, cursor.w);
        let emittedAllCommentsForTask = true;
        for (const comment of comments) {
          if (items.length >= opts.maxItems) {
            sawMore = true;
            emittedAllCommentsForTask = false;
            break;
          }
          maxSeen = Math.max(maxSeen, comment.dateMs);
          items.push(this.taskCommentItem(workspace, task, comment));
        }
        if (emittedAllCommentsForTask) {
          maxSeen = Math.max(maxSeen, task.updatedMs);
        } else {
          break;
        }
      }

      if (items.length >= opts.maxItems) continue;
      const channels = await this.listChatChannels(workspace, cursor.w);
      if (channels.length >= MAX_CHANNELS_PER_WORKSPACE) sawMore = true;
      for (const channel of channels) {
        if (items.length >= opts.maxItems) {
          sawMore = true;
          break;
        }
        const messages = await this.listFreshChatMessages(workspace, channel, cursor.w);
        for (const message of messages) {
          if (items.length >= opts.maxItems) {
            sawMore = true;
            break;
          }
          maxSeen = Math.max(maxSeen, message.dateMs);
          items.push(this.chatMessageItem(workspace, channel, message));

          if (items.length >= opts.maxItems) {
            if (message.repliesCount > 0) sawMore = true;
            continue;
          }
          if (message.repliesCount <= 0) continue;
          for (const reply of await this.listFreshChatReplies(workspace, message, cursor.w)) {
            if (items.length >= opts.maxItems) {
              sawMore = true;
              break;
            }
            maxSeen = Math.max(maxSeen, reply.dateMs);
            items.push(this.chatReplyItem(workspace, channel, message, reply));
          }
        }
      }
    }

    items.sort((a, b) => a.cursorValue - b.cursorValue);
    const nextCursor = JSON.stringify({ w: maxSeen } satisfies ClickupCursor);
    return { items, nextCursor, hasMore: sawMore };
  }

  private async listWorkspaces(): Promise<Workspace[]> {
    const data = await this.call(CLICKUP_GET_AUTHORIZED_TEAMS_WORKSPACES, [{}]);
    return arrayAt(data, ['teams', 'workspaces', 'data'])
      .map(toWorkspace)
      .filter((workspace): workspace is Workspace => workspace !== null);
  }

  private async listUpdatedTasks(workspace: Workspace, watermark: number): Promise<TaskSummary[]> {
    const workspaceId = numericIfPossible(workspace.id);
    const data = await this.call(CLICKUP_GET_FILTERED_TEAM_TASKS, [
      {
        team_Id: workspaceId,
        page: 0,
        order_by: 'updated',
        reverse: false,
        subtasks: true,
        include_closed: true,
        include_markdown_description: true,
        date_updated_gt: watermark,
      },
      {
        team_id: workspaceId,
        page: 0,
        order_by: 'updated',
        reverse: false,
        subtasks: true,
        include_closed: true,
        include_markdown_description: true,
        date_updated_gt: watermark,
      },
      {
        workspace_id: workspaceId,
        page: 0,
        order_by: 'updated',
        reverse: false,
        subtasks: true,
        include_closed: true,
        include_markdown_description: true,
        date_updated_gt: watermark,
      },
    ]);
    return arrayAt(data, ['tasks', 'data'])
      .map(toTaskSummary)
      .filter((task): task is TaskSummary => task !== null)
      .filter((task) => task.updatedMs > watermark)
      .sort((a, b) => a.updatedMs - b.updatedMs)
      .slice(0, MAX_TASKS_PER_FETCH);
  }

  private async listFreshTaskComments(task: TaskSummary, watermark: number): Promise<ClickupComment[]> {
    const data = await this.call(CLICKUP_GET_TASK_COMMENTS, [{ task_id: task.id }]);
    return arrayAt(data, ['comments', 'data'])
      .map(toComment)
      .filter((comment): comment is ClickupComment => comment !== null)
      .filter((comment) => comment.dateMs > watermark)
      .sort((a, b) => a.dateMs - b.dateMs);
  }

  private async listChatChannels(workspace: Workspace, watermark: number): Promise<ChatChannel[]> {
    const workspaceId = numericIfPossible(workspace.id);
    const data = await this.call(CLICKUP_GET_CHAT_CHANNELS, [
      {
        workspace_id: workspaceId,
        limit: MAX_CHANNELS_PER_WORKSPACE,
        with_message_since: watermark,
        include_closed: false,
        description_format: 'text/plain',
      },
      {
        team_id: workspaceId,
        limit: MAX_CHANNELS_PER_WORKSPACE,
        with_message_since: watermark,
        include_closed: false,
        description_format: 'text/plain',
      },
    ]);
    return arrayAt(data, ['data', 'channels'])
      .map(toChatChannel)
      .filter((channel): channel is ChatChannel => channel !== null)
      .slice(0, MAX_CHANNELS_PER_WORKSPACE);
  }

  private async listFreshChatMessages(workspace: Workspace, channel: ChatChannel, watermark: number): Promise<ChatMessage[]> {
    const workspaceId = numericIfPossible(workspace.id);
    const data = await this.call(CLICKUP_GET_CHAT_MESSAGES, [
      {
        workspace_id: workspaceId,
        channel_id: channel.id,
        limit: CHAT_PAGE_SIZE,
        content_format: 'text/md',
      },
      {
        team_id: workspaceId,
        channel_id: channel.id,
        limit: CHAT_PAGE_SIZE,
        content_format: 'text/md',
      },
    ]);
    return arrayAt(data, ['data', 'messages'])
      .map(toChatMessage)
      .filter((message): message is ChatMessage => message !== null)
      .filter((message) => message.dateMs > watermark)
      .sort((a, b) => a.dateMs - b.dateMs);
  }

  private async listFreshChatReplies(workspace: Workspace, message: ChatMessage, watermark: number): Promise<ChatMessage[]> {
    const workspaceId = numericIfPossible(workspace.id);
    const data = await this.call(CLICKUP_GET_CHAT_MESSAGE_REPLIES, [
      {
        workspace_id: workspaceId,
        message_id: message.id,
        limit: MAX_REPLIES_PER_MESSAGE,
        content_format: 'text/md',
      },
      {
        team_id: workspaceId,
        message_id: message.id,
        limit: MAX_REPLIES_PER_MESSAGE,
        content_format: 'text/md',
      },
    ]);
    return arrayAt(data, ['data', 'replies'])
      .map(toChatMessage)
      .filter((reply): reply is ChatMessage => reply !== null)
      .filter((reply) => reply.dateMs > watermark)
      .sort((a, b) => a.dateMs - b.dateMs);
  }

  private taskCommentItem(workspace: Workspace, task: TaskSummary, comment: ClickupComment): IngestionItem {
    const day = comment.occurredAt.slice(0, 10) || 'undated';
    const time = comment.occurredAt.slice(11, 16) || '??:??';
    const context = [
      `Workspace: ${workspace.name}`,
      `Task: ${task.name}`,
      task.status ? `Status: ${task.status}` : '',
      task.list ? `List: ${task.list}` : '',
      task.space ? `Space: ${task.space}` : '',
      task.assignees.length > 0 ? `Assignees: ${task.assignees.join(', ')}` : '',
      task.url ? `Link: ${task.url}` : '',
    ].filter((line) => line !== '').join('\n');
    return {
      sourceRef: `task:${task.id}#comments#${day}`,
      dedupRef: `task-comment:${comment.id}`,
      cursorValue: comment.dateMs,
      occurredAt: comment.occurredAt,
      title: `ClickUp task comments: ${task.name} ${day}`,
      content: `${context}\n[${time}] ${comment.author}: ${comment.text}`.slice(0, this.contentLimit),
      merge: true,
    };
  }

  private chatMessageItem(workspace: Workspace, channel: ChatChannel, message: ChatMessage): IngestionItem {
    const day = message.occurredAt.slice(0, 10) || 'undated';
    const time = message.occurredAt.slice(11, 16) || '??:??';
    return {
      sourceRef: `chat:${channel.id}#${day}`,
      dedupRef: `chat-message:${message.id}`,
      cursorValue: message.dateMs,
      occurredAt: message.occurredAt,
      title: `ClickUp chat: ${channel.name} ${day}`,
      content: `Workspace: ${workspace.name}\nChannel: ${channel.name}\n[${time}] ${message.author}: ${message.text}`.slice(0, this.contentLimit),
      merge: true,
    };
  }

  private chatReplyItem(workspace: Workspace, channel: ChatChannel, parent: ChatMessage, reply: ChatMessage): IngestionItem {
    const day = reply.occurredAt.slice(0, 10) || 'undated';
    const time = reply.occurredAt.slice(11, 16) || '??:??';
    return {
      sourceRef: `chat:${channel.id}#${day}`,
      dedupRef: `chat-reply:${parent.id}:${reply.id}`,
      cursorValue: reply.dateMs,
      occurredAt: reply.occurredAt,
      title: `ClickUp chat: ${channel.name} ${day}`,
      content: `Workspace: ${workspace.name}\nChannel: ${channel.name}\n[${time}] ${reply.author} replied: ${reply.text}`.slice(0, this.contentLimit),
      merge: true,
    };
  }

  private async call(slug: string, argVariants: Record<string, unknown>[]): Promise<unknown> {
    let lastError: string | null = null;
    for (const args of argVariants) {
      const res = await this.bridge.executeTool(slug, args, { recordUsage: false });
      if (!res.error) return unwrapComposioData(res.data);
      lastError = res.error;
    }
    throw new Error(`${slug} failed: ${lastError ?? 'unknown error'}`);
  }
}

function parseCursor(cursor: string): ClickupCursor {
  try {
    const parsed = JSON.parse(cursor) as Partial<ClickupCursor>;
    if (parsed && typeof parsed.w === 'number' && Number.isFinite(parsed.w)) {
      return { w: Math.max(0, parsed.w) };
    }
  } catch {
    // Fall through for a bare numeric cursor.
  }
  const n = Number(cursor);
  return { w: Number.isFinite(n) ? Math.max(0, n) : 0 };
}

function unwrapComposioData(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data;
  const record = data as Record<string, unknown>;
  if (Array.isArray(record.data)) return data;
  if (record.data && typeof record.data === 'object') return record.data;
  return data;
}

function arrayAt(data: unknown, keys: string[]): unknown[] {
  const candidates: unknown[] = [data];
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    for (const key of keys) candidates.push(record[key]);
  }
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function toWorkspace(raw: unknown): Workspace | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = asString(r.id) || stringFromNumber(r.id);
  if (!id) return null;
  return { id, name: asString(r.name) || `Workspace ${id}` };
}

function toTaskSummary(raw: unknown): TaskSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = asString(r.id);
  const updatedMs = parseMs(r.date_updated ?? r.updated_at ?? r.updatedAt);
  if (!id || updatedMs === null) return null;
  return {
    id,
    name: asString(r.name) || `(task ${id})`,
    updatedMs,
    status: objectString(r.status, 'status') || asString(r.status),
    url: asString(r.url),
    list: objectString(r.list, 'name'),
    space: objectString(r.space, 'name') || objectString(r.space, 'id'),
    assignees: arrayAt(r, ['assignees']).map(userName).filter((name) => name !== ''),
  };
}

function toComment(raw: unknown): ClickupComment | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = asString(r.id);
  const dateMs = parseMs(r.date ?? r.created_at ?? r.createdAt);
  const text = commentText(r);
  if (!id || dateMs === null || !text) return null;
  return {
    id,
    dateMs,
    occurredAt: new Date(dateMs).toISOString(),
    author: userName(r.user) || 'unknown',
    text,
  };
}

function toChatChannel(raw: unknown): ChatChannel | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = asString(r.id);
  if (!id) return null;
  return { id, name: asString(r.name) || asString(r.topic) || `Channel ${id}` };
}

function toChatMessage(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = asString(r.id);
  const dateMs = parseMs(r.date ?? r.created_at ?? r.createdAt);
  const text = asString(r.content) || objectString(r.content, 'text') || asString(r.text) || asString(r.message);
  if (!id || dateMs === null || !text) return null;
  return {
    id,
    dateMs,
    occurredAt: new Date(dateMs).toISOString(),
    author: userName(r.user ?? r.sender ?? r.author ?? r.created_by) || 'unknown',
    text,
    repliesCount: parseCount(r.replies_count ?? r.repliesCount),
  };
}

function commentText(record: Record<string, unknown>): string {
  const direct = asString(record.comment_text) || asString(record.text) || asString(record.content);
  if (direct) return direct;
  const rich = record.comment;
  if (Array.isArray(rich)) {
    return rich
      .map((part) => part && typeof part === 'object' ? asString((part as Record<string, unknown>).text) : '')
      .filter((part) => part !== '')
      .join('');
  }
  return objectString(record.comment, 'text');
}

function userName(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const r = value as Record<string, unknown>;
  return asString(r.username)
    || asString(r.name)
    || asString(r.email)
    || asString(r.initials)
    || asString(r.id)
    || stringFromNumber(r.id);
}

function objectString(value: unknown, key: string): string {
  return value && typeof value === 'object' ? asString((value as Record<string, unknown>)[key]) : '';
}

function parseMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseCount(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function stringFromNumber(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function numericIfPossible(value: string): string | number {
  const n = Number(value);
  return Number.isFinite(n) && String(Math.floor(n)) === value ? n : value;
}
