import { describe, expect, it } from 'vitest';
import { ClickupSource } from '../src/memory/ingestion/sources/clickup-source.ts';
import type { IngestionBridge } from '../src/memory/ingestion/ingestion-source.ts';

interface Call {
  toolSlug: string;
  args: Record<string, unknown>;
  recordUsage: boolean | undefined;
}

function fakeBridge(responses: Record<string, unknown>): { bridge: IngestionBridge; calls: Call[] } {
  const calls: Call[] = [];
  const bridge: IngestionBridge = {
    async executeTool(toolSlug, args, opts) {
      calls.push({ toolSlug, args, recordUsage: opts?.recordUsage });
      const response = responses[toolSlug];
      if (response instanceof Error) return { data: null, error: response.message, logId: null };
      return { data: response ?? {}, error: null, logId: null };
    },
  };
  return { bridge, calls };
}

describe('ClickupSource', () => {
  it('ingests fresh task comments as per-task day buckets and advances from task updates', async () => {
    const { bridge, calls } = fakeBridge({
      CLICKUP_GET_AUTHORIZED_TEAMS_WORKSPACES: {
        teams: [{ id: '1234', name: 'Acme workspace' }],
      },
      CLICKUP_GET_FILTERED_TEAM_TASKS: {
        tasks: [{
          id: 'task-1',
          name: 'Launch checklist',
          date_updated: '1784890800000',
          status: { status: 'in progress' },
          assignees: [{ username: 'Ada' }],
          url: 'https://app.clickup.com/t/task-1',
          list: { name: 'Sprint Backlog' },
          space: { name: 'Product' },
        }],
      },
      CLICKUP_GET_TASK_COMMENTS: {
        comments: [
          { id: 'old', date: '1784880000000', comment_text: 'old enough', user: { username: 'Old' } },
          { id: 'comment-1', date: '1784890900000', comment_text: 'billing webhook retries block launch', user: { username: 'Maya' } },
        ],
      },
      CLICKUP_GET_CHAT_CHANNELS: { data: [] },
    });

    const source = new ClickupSource(bridge);
    const result = await source.fetchSince('', JSON.stringify({ w: 1784890000000 }), { maxItems: 20 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      sourceRef: 'task:task-1#comments#2026-07-24',
      dedupRef: 'task-comment:comment-1',
      title: 'ClickUp task comments: Launch checklist 2026-07-24',
      merge: true,
    });
    expect(result.items[0].content).toContain('billing webhook retries block launch');
    expect(result.items[0].content).toContain('Status: in progress');
    expect(JSON.parse(result.nextCursor)).toEqual({ w: 1784890900000 });
    expect(calls.find((call) => call.toolSlug === 'CLICKUP_GET_FILTERED_TEAM_TASKS')?.args).toMatchObject({
      team_Id: 1234,
      order_by: 'updated',
      include_closed: true,
      date_updated_gt: 1784890000000,
    });
    expect(calls.every((call) => call.recordUsage === false)).toBe(true);
  });

  it('ingests chat messages and replies into per-channel day buckets', async () => {
    const { bridge } = fakeBridge({
      CLICKUP_GET_AUTHORIZED_TEAMS_WORKSPACES: { teams: [{ id: '1234', name: 'Acme workspace' }] },
      CLICKUP_GET_FILTERED_TEAM_TASKS: { tasks: [] },
      CLICKUP_GET_CHAT_CHANNELS: { data: [{ id: 'chan-1', name: 'engineering' }] },
      CLICKUP_GET_CHAT_MESSAGES: {
        data: [{
          id: 'msg-1',
          date: 1784890800000,
          content: 'old workspace id is still hardcoded',
          user: { username: 'Nina' },
          replies_count: 1,
        }],
        next_cursor: '',
      },
      CLICKUP_GET_CHAT_MESSAGE_REPLIES: {
        data: [{
          id: 'reply-1',
          date: 1784890860000,
          content: 'yes, onboarding emails use that path too',
          user: { username: 'Omar' },
        }],
        next_cursor: '',
      },
    });

    const result = await new ClickupSource(bridge).fetchSince('', JSON.stringify({ w: 1784890000000 }), { maxItems: 20 });

    expect(result.items.map((item) => item.dedupRef)).toEqual([
      'chat-message:msg-1',
      'chat-reply:msg-1:reply-1',
    ]);
    expect(result.items[0]).toMatchObject({
      sourceRef: 'chat:chan-1#2026-07-24',
      title: 'ClickUp chat: engineering 2026-07-24',
      merge: true,
    });
    expect(result.items[1].content).toContain('Omar replied');
    expect(JSON.parse(result.nextCursor)).toEqual({ w: 1784890860000 });
  });

  it('advances past updated tasks even when they have no fresh comments', async () => {
    const { bridge } = fakeBridge({
      CLICKUP_GET_AUTHORIZED_TEAMS_WORKSPACES: { teams: [{ id: '1234', name: 'Acme workspace' }] },
      CLICKUP_GET_FILTERED_TEAM_TASKS: {
        tasks: [{ id: 'task-1', name: 'Launch checklist', date_updated: '1784890800000' }],
      },
      CLICKUP_GET_TASK_COMMENTS: {
        comments: [{ id: 'old', date: '1784880000000', comment_text: 'already seen', user: { username: 'Ada' } }],
      },
      CLICKUP_GET_CHAT_CHANNELS: { data: [] },
    });

    const result = await new ClickupSource(bridge).fetchSince('', JSON.stringify({ w: 1784890000000 }), { maxItems: 20 });

    expect(result.items).toHaveLength(0);
    expect(JSON.parse(result.nextCursor)).toEqual({ w: 1784890800000 });
  });

  it('does not advance to task date_updated when the item cap cuts through fresh comments', async () => {
    const { bridge } = fakeBridge({
      CLICKUP_GET_AUTHORIZED_TEAMS_WORKSPACES: { teams: [{ id: '1234', name: 'Acme workspace' }] },
      CLICKUP_GET_FILTERED_TEAM_TASKS: {
        tasks: [{ id: 'task-1', name: 'Launch checklist', date_updated: '1785000000000' }],
      },
      CLICKUP_GET_TASK_COMMENTS: {
        comments: [
          { id: 'comment-2', date: '1784890900000', comment_text: 'second fresh comment', user: { username: 'Maya' } },
          { id: 'comment-1', date: '1784890800000', comment_text: 'first fresh comment', user: { username: 'Maya' } },
        ],
      },
      CLICKUP_GET_CHAT_CHANNELS: { data: [] },
    });

    const result = await new ClickupSource(bridge).fetchSince('', JSON.stringify({ w: 1784890000000 }), { maxItems: 1 });

    expect(result.items.map((item) => item.dedupRef)).toEqual(['task-comment:comment-1']);
    expect(JSON.parse(result.nextCursor)).toEqual({ w: 1784890800000 });
    expect(result.hasMore).toBe(true);
  });

  it('tries common workspace argument aliases for Composio schema drift', async () => {
    const calls: Call[] = [];
    const bridge: IngestionBridge = {
      async executeTool(toolSlug, args, opts) {
        calls.push({ toolSlug, args, recordUsage: opts?.recordUsage });
        if (toolSlug === 'CLICKUP_GET_AUTHORIZED_TEAMS_WORKSPACES') {
          return { data: { teams: [{ id: '1234', name: 'Acme workspace' }] }, error: null, logId: null };
        }
        if (toolSlug === 'CLICKUP_GET_FILTERED_TEAM_TASKS' && 'team_Id' in args) {
          return { data: null, error: 'unknown field team_Id', logId: null };
        }
        if (toolSlug === 'CLICKUP_GET_FILTERED_TEAM_TASKS') {
          return { data: { tasks: [] }, error: null, logId: null };
        }
        if (toolSlug === 'CLICKUP_GET_CHAT_CHANNELS') {
          return { data: { data: [] }, error: null, logId: null };
        }
        return { data: {}, error: null, logId: null };
      },
    };

    await new ClickupSource(bridge).fetchSince('', JSON.stringify({ w: 1 }), { maxItems: 20 });

    const taskCalls = calls.filter((call) => call.toolSlug === 'CLICKUP_GET_FILTERED_TEAM_TASKS');
    expect(taskCalls).toHaveLength(2);
    expect(taskCalls[1].args).toMatchObject({ team_id: 1234 });
  });
});
