import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { draftIdForArgs } from '../src/integrations/composio-bridge.ts';
import { buildDraftsRoutes } from '../src/chat/drafts.ts';
import { dispatch } from '../src/http/router.ts';
import { ChatStore, type ChatMessageRecord } from '../src/chat/chat-store.ts';
import { applyDraftResolutions } from '../src/chat/draft-resolutions.ts';
import { reviewedMessageToolSlug } from '../src/integrations/reviewed-message-policy.ts';

describe('Draft resolutions', () => {
  const draftApprovalToken = 'test-native-draft-approval';
  const draftApprovalTokenSha256 = createHash('sha256')
    .update(draftApprovalToken, 'utf8')
    .digest('hex');
  const tempDirs: string[] = [];
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
      server.close(() => resolve());
    })));
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempStore(): ChatStore {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'verso-drafts-'));
    tempDirs.push(dir);
    return new ChatStore(path.join(dir, 'chat.sqlite'));
  }

  it('persists native draft resolutions by session and draft id', () => {
    const store = tempStore();
    const session = store.createSession('Drafts');

    const first = store.recordDraftResolution(session.id, ' draft_abc ', 'sent', ' Gmail ');
    expect(first).toMatchObject({
      sessionId: session.id,
      draftId: 'draft_abc',
      status: 'sent',
      channel: 'gmail',
    });

    store.recordDraftResolution(session.id, 'draft_abc', 'discarded', 'slack');
    expect(store.listDraftResolutions(session.id)).toHaveLength(1);
    expect(store.listDraftResolutions(session.id)[0]).toMatchObject({
      sessionId: session.id,
      draftId: 'draft_abc',
      status: 'discarded',
      channel: 'slack',
    });
  });

  it('keeps discarded drafts resolved after the store is reopened', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'verso-drafts-reopen-'));
    tempDirs.push(dir);
    const databasePath = path.join(dir, 'chat.sqlite');
    const firstStore = new ChatStore(databasePath);
    const session = firstStore.createSession('Reopen draft');
    firstStore.recordDraftResolution(session.id, 'draft_restart', 'discarded', 'gmail');

    const reopenedStore = new ChatStore(databasePath);
    expect(reopenedStore.listDraftResolutions(session.id)).toEqual([
      expect.objectContaining({
        draftId: 'draft_restart',
        status: 'discarded',
        channel: 'gmail',
      }),
    ]);
  });

  it('annotates pending native draft tool steps with durable sent status', () => {
    const input = {
      channel: 'gmail',
      to: 'hugo@example.com',
      subject: 'Hello',
      body: 'Draft body',
    };
    const draftId = draftIdForArgs(input);
    const messages: ChatMessageRecord[] = [{
      id: 'm1',
      sessionId: 'session-1',
      role: 'assistant',
      content: '',
      createdAt: '2026-06-04T00:00:00.000Z',
      steps: [{
        type: 'tool',
        id: 'call-1',
        name: 'mcp_verso_propose_message_draft',
        input,
        result: JSON.stringify({ data: { status: 'pending_review', channel: 'gmail' }, error: null }),
      }],
    }];

    const annotated = applyDraftResolutions(messages, [{
      sessionId: 'session-1',
      draftId,
      status: 'sent',
      channel: 'gmail',
      updatedAt: '2026-06-04T00:00:01.000Z',
    }]);
    const step = annotated[0].steps?.[0];
    expect(step?.type).toBe('tool');
    const result = JSON.parse(step?.type === 'tool' ? step.result ?? '{}' : '{}');
    expect(result.data.status).toBe('sent');
    expect(result.data.draft_id).toBe(draftId);
    expect(result.data.resolved_by).toBe('verso_native');
  });

  it('annotates pending native draft tool steps with durable discard status', () => {
    const input = { channel: 'slack', to: '#general', body: 'Draft body' };
    const draftId = draftIdForArgs(input);
    const messages: ChatMessageRecord[] = [{
      id: 'm1',
      sessionId: 'session-1',
      role: 'assistant',
      content: '',
      createdAt: '2026-06-04T00:00:00.000Z',
      steps: [{
        type: 'tool',
        id: 'call-1',
        name: 'propose_message_draft',
        input,
        result: JSON.stringify({ data: { status: 'pending_review', channel: 'slack' }, error: null }),
      }],
    }];

    const annotated = applyDraftResolutions(messages, [{
      sessionId: 'session-1',
      draftId,
      status: 'discarded',
      channel: 'slack',
      updatedAt: '2026-06-04T00:00:01.000Z',
    }]);
    const step = annotated[0].steps?.[0];
    const result = JSON.parse(step?.type === 'tool' ? step.result ?? '{}' : '{}');
    expect(result.data.status).toBe('rejected');
    expect(result.data.reason).toBe('discarded_by_user');
  });

  it('records native sent drafts through the drafts API', async () => {
    const store = tempStore();
    const session = store.createSession('Drafts');
    const calls: Array<{ slug: string; args: Record<string, unknown> }> = [];
    const port = await startDraftServer(store, {
      sendReviewedMessage: async (channel: string, args: Record<string, unknown>) => {
        calls.push({ slug: reviewedMessageToolSlug(channel, args) ?? '', args });
        return { data: { ok: true }, error: null, logId: null };
      },
    });

    const input = { channel: 'gmail', to: 'hugo@example.com', subject: 'Hi', body: 'Hello' };
    const draftId = draftIdForArgs(input);
    const res = await fetch(`http://127.0.0.1:${port}/drafts/send`, {
      method: 'POST',
      headers: approvedDraftHeaders(),
      body: JSON.stringify({ ...input, draftId, sessionId: session.id }),
    });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].slug).toBe('GMAIL_SEND_EMAIL');
    expect(store.listDraftResolutions(session.id)[0]).toMatchObject({
      draftId,
      status: 'sent',
      channel: 'gmail',
    });

    const repeated = await fetch(`http://127.0.0.1:${port}/drafts/send`, {
      method: 'POST',
      headers: approvedDraftHeaders(),
      body: JSON.stringify({ ...input, draftId, sessionId: session.id }),
    });
    expect(repeated.status).toBe(409);
    expect(calls).toHaveLength(1);
  });

  it('rejects sends without the native draft approval capability', async () => {
    const store = tempStore();
    const session = store.createSession('Unapproved draft');
    let calls = 0;
    const port = await startDraftServer(store, {
      sendReviewedMessage: async () => {
        calls += 1;
        return { data: { ok: true }, error: null, logId: null };
      },
    });
    const input = { channel: 'gmail', to: 'hugo@example.com', subject: 'Hi', body: 'Hello' };
    const draftId = draftIdForArgs(input);

    const res = await fetch(`http://127.0.0.1:${port}/drafts/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, draftId, sessionId: session.id }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'approval_required' });
    expect(calls).toBe(0);
  });

  it('sends Slack native drafts with markdown_text', async () => {
    const store = tempStore();
    const session = store.createSession('Slack draft');
    const calls: Array<{ slug: string; args: Record<string, unknown> }> = [];
    const port = await startDraftServer(store, {
      sendReviewedMessage: async (channel: string, args: Record<string, unknown>) => {
        calls.push({ slug: reviewedMessageToolSlug(channel, args) ?? '', args });
        return { data: { ok: true }, error: null, logId: null };
      },
    });

    const input = { channel: 'slack', to: '#general', body: 'Hello **team**', threadId: '123.456' };
    const draftId = draftIdForArgs(input);
    const res = await fetch(`http://127.0.0.1:${port}/drafts/send`, {
      method: 'POST',
      headers: approvedDraftHeaders(),
      body: JSON.stringify({ ...input, draftId, sessionId: session.id }),
    });

    expect(res.status).toBe(200);
    expect(calls).toEqual([{
      slug: 'SLACK_SEND_MESSAGE',
      args: {
        channel: 'general',
        markdown_text: 'Hello **team**',
        thread_ts: '123.456',
      },
    }]);
    expect(calls[0].args).not.toHaveProperty('text');
  });

  it.each([
    [
      'self',
      { channel: 'microsoft_teams', target_kind: 'self', to: 'me', body: 'Personal note' },
      'MICROSOFT_TEAMS_SEND_MESSAGE_TO_SELF',
      { target_kind: 'self', content: 'Personal note', content_type: 'text' },
    ],
    [
      'chat',
      { channel: 'microsoft_teams', target_kind: 'chat', to: '19:chat-id', body: 'Hello chat' },
      'MICROSOFT_TEAMS_TEAMS_POST_CHAT_MESSAGE',
      { target_kind: 'chat', chat_id: '19:chat-id', content: 'Hello chat', content_type: 'text' },
    ],
    [
      'channel',
      {
        channel: 'microsoft_teams',
        target_kind: 'channel',
        team_id: 'team-1',
        to: '19:channel-id',
        body: 'Hello channel',
      },
      'MICROSOFT_TEAMS_TEAMS_POST_CHANNEL_MESSAGE',
      {
        target_kind: 'channel',
        team_id: 'team-1',
        channel_id: '19:channel-id',
        content: 'Hello channel',
        content_type: 'text',
      },
    ],
  ])('sends a reviewed Teams %s draft with its canonical target', async (_kind, input, toolSlug, expectedArgs) => {
    const store = tempStore();
    const session = store.createSession('Teams draft');
    const calls: Array<{ slug: string; args: Record<string, unknown> }> = [];
    const port = await startDraftServer(store, {
      sendReviewedMessage: async (channel: string, args: Record<string, unknown>) => {
        calls.push({ slug: reviewedMessageToolSlug(channel, args) ?? '', args });
        return { data: { ok: true }, error: null, logId: null };
      },
    });
    const draftId = draftIdForArgs(input);

    const res = await fetch(`http://127.0.0.1:${port}/drafts/send`, {
      method: 'POST',
      headers: approvedDraftHeaders(),
      body: JSON.stringify({ ...input, draftId, sessionId: session.id }),
    });

    expect(res.status).toBe(200);
    expect(calls).toEqual([{ slug: toolSlug, args: expectedArgs }]);
    expect(store.listDraftResolutions(session.id)[0]).toMatchObject({
      draftId,
      status: 'sent',
      channel: 'microsoft_teams',
    });
  });

  it('rejects a Teams channel draft without its team id', async () => {
    const store = tempStore();
    const session = store.createSession('Invalid Teams draft');
    let calls = 0;
    const port = await startDraftServer(store, {
      sendReviewedMessage: async () => {
        calls += 1;
        return { data: { ok: true }, error: null, logId: null };
      },
    });
    const input = {
      channel: 'microsoft_teams',
      target_kind: 'channel',
      to: '19:channel-id',
      body: 'Hello channel',
    };

    const res = await fetch(`http://127.0.0.1:${port}/drafts/send`, {
      method: 'POST',
      headers: approvedDraftHeaders(),
      body: JSON.stringify({ ...input, draftId: draftIdForArgs(input), sessionId: session.id }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: expect.stringContaining('team_id') });
    expect(calls).toBe(0);
  });

  it('allows only one in-flight send for a draft', async () => {
    const store = tempStore();
    const session = store.createSession('Single-use draft');
    let releaseSend!: () => void;
    let markStarted!: () => void;
    const sendReleased = new Promise<void>((resolve) => { releaseSend = resolve; });
    const sendStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    let calls = 0;
    const port = await startDraftServer(store, {
      sendReviewedMessage: async () => {
        calls += 1;
        markStarted();
        await sendReleased;
        return { data: { ok: true }, error: null, logId: null };
      },
    });
    const input = { channel: 'gmail', to: 'hugo@example.com', subject: 'Hi', body: 'Hello' };
    const draftId = draftIdForArgs(input);
    const request = () => fetch(`http://127.0.0.1:${port}/drafts/send`, {
      method: 'POST',
      headers: approvedDraftHeaders(),
      body: JSON.stringify({ ...input, draftId, sessionId: session.id }),
    });

    const first = request();
    await sendStarted;
    const competing = await request();
    expect(competing.status).toBe(409);
    expect(calls).toBe(1);

    releaseSend();
    expect((await first).status).toBe(200);
  });

  it('records native discarded drafts through the drafts API', async () => {
    const store = tempStore();
    const session = store.createSession('Drafts');
    const input = { channel: 'slack', to: '#general', body: 'Hello' };
    const draftId = draftIdForArgs(input);
    const port = await startDraftServer(store, {
      sendReviewedMessage: async () => ({ data: null, error: null, logId: null }),
    });

    const res = await fetch(`http://127.0.0.1:${port}/drafts/${encodeURIComponent(draftId)}/discard`, {
      method: 'POST',
      headers: approvedDraftHeaders(),
      body: JSON.stringify({ sessionId: session.id, channel: 'slack' }),
    });

    expect(res.status).toBe(200);
    expect(store.listDraftResolutions(session.id)[0]).toMatchObject({
      draftId,
      status: 'discarded',
      channel: 'slack',
    });

    const repeated = await fetch(`http://127.0.0.1:${port}/drafts/${encodeURIComponent(draftId)}/discard`, {
      method: 'POST',
      headers: approvedDraftHeaders(),
      body: JSON.stringify({ sessionId: session.id, channel: 'slack' }),
    });
    expect(repeated.status).toBe(200);
    expect(store.listDraftResolutions(session.id)).toHaveLength(1);

    const sendAfterDiscard = await fetch(`http://127.0.0.1:${port}/drafts/send`, {
      method: 'POST',
      headers: approvedDraftHeaders(),
      body: JSON.stringify({ ...input, draftId, sessionId: session.id }),
    });
    expect(sendAfterDiscard.status).toBe(409);
  });

  it('rejects unsupported draft channels without creating a resolution', async () => {
    const store = tempStore();
    const session = store.createSession('Notion action');
    const port = await startDraftServer(store, {
      sendReviewedMessage: async () => ({ data: null, error: null, logId: null }),
    });

    const res = await fetch(`http://127.0.0.1:${port}/drafts/draft_notion/discard`, {
      method: 'POST',
      headers: approvedDraftHeaders(),
      body: JSON.stringify({ sessionId: session.id, channel: 'notion' }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      message: 'Channel "notion" is not supported. Drafts are limited to Gmail, Slack, and Microsoft Teams.',
    });
    expect(store.listDraftResolutions(session.id)).toEqual([]);
  });

  async function startDraftServer(
    store: ChatStore,
    bridge: { sendReviewedMessage: (channel: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: string | null; logId: string | null }> },
  ): Promise<number> {
    const routes = buildDraftsRoutes(bridge as any, store, { draftApprovalTokenSha256 });
    const server = http.createServer((req, res) => {
      dispatch(routes, req, res, { allowUnauthenticated: true });
    });
    servers.push(server);

    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        resolve(addr.port);
      });
    });
  }

  function approvedDraftHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-Verso-Draft-Approval-Token': draftApprovalToken,
    };
  }
});
