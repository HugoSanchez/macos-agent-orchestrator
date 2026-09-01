import { describe, expect, it, vi } from 'vitest';
import { applyMemorySoulSection } from '../src/memory/memory-soul.ts';
import { ManagedBackendClient } from '../src/integrations/managed-backend-client.ts';
import {
  ComposioBridgeHttpError,
  ComposioBridgeService,
} from '../src/integrations/composio-bridge.ts';
import {
  PROTECTED_MESSAGE_SEND_TOOL_SLUGS,
  REVIEWED_MESSAGE_TOOL_BY_CHANNEL,
} from '../src/integrations/reviewed-message-policy.ts';

describe('message draft eligibility', () => {
  it.each(['gmail', 'slack'])('accepts supported communication channel %s', async (channel) => {
    const bridge = new ComposioBridgeService(new ManagedBackendClient(''));

    const result = await bridge.executeTool('PROPOSE_MESSAGE_DRAFT', {
      channel,
      to: 'recipient',
      body: 'Hello',
    });

    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({ status: 'pending_review', channel });
  });

  it.each(['notion', 'airtable', 'google_docs', ''])('rejects non-message channel %s', async (channel) => {
    const bridge = new ComposioBridgeService(new ManagedBackendClient(''));

    try {
      await bridge.executeTool('PROPOSE_MESSAGE_DRAFT', { channel, body: 'Not a message' });
      throw new Error('Expected unsupported channel to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(ComposioBridgeHttpError);
      expect(error).toMatchObject({ status: 400 });
      expect((error as Error).message).toContain('only Gmail email and Slack messages');
    }
  });

  it.each(PROTECTED_MESSAGE_SEND_TOOL_SLUGS)(
    'rejects direct agent execution of protected send tool %s',
    async (toolSlug) => {
      const bridge = new ComposioBridgeService(new ManagedBackendClient(''));

      await expect(bridge.executeTool(toolSlug, { body: 'bypass review' }))
        .rejects.toMatchObject({ status: 403 });
    },
  );

  it('keeps every reviewed dispatch tool inside the protected policy', () => {
    expect(PROTECTED_MESSAGE_SEND_TOOL_SLUGS).toEqual(expect.arrayContaining(
      Object.values(REVIEWED_MESSAGE_TOOL_BY_CHANNEL),
    ));
  });

  it.each([
    ['gmail', 'GMAIL_SEND_EMAIL'],
    ['slack', 'SLACK_SEND_MESSAGE'],
  ])('maps reviewed %s sends to the fixed provider tool', async (channel, toolSlug) => {
    const bridge = new ComposioBridgeService(new ManagedBackendClient('https://backend.example'));
    const remote = (bridge as unknown as {
      bridgeClient: { executeTool: (slug: string, args: Record<string, unknown>) => Promise<unknown> };
    }).bridgeClient;
    const execute = vi.spyOn(remote, 'executeTool').mockResolvedValue({
      data: { ok: true },
      error: null,
      logId: null,
    });
    const args = { body: 'reviewed content' };

    await bridge.sendReviewedMessage(channel, args);

    expect(execute).toHaveBeenCalledWith(toolSlug, args);
  });

  it.each(['me', 'self', 'myself', 'yourself'])(
    'resolves Slack self alias %s to a DM before the reviewed send',
    async (selfAlias) => {
      const bridge = new ComposioBridgeService(new ManagedBackendClient('https://backend.example'));
      const remote = (bridge as unknown as {
        bridgeClient: { executeTool: (slug: string, args: Record<string, unknown>) => Promise<unknown> };
      }).bridgeClient;
      const execute = vi.spyOn(remote, 'executeTool')
        .mockResolvedValueOnce({
          data: { ok: true, user_id: 'U012AUTHED' },
          error: null,
          logId: null,
        })
        .mockResolvedValueOnce({
          data: { ok: true, channel: { id: 'D012SELFDM' } },
          error: null,
          logId: null,
        })
        .mockResolvedValueOnce({
          data: { ok: true },
          error: null,
          logId: null,
        });

      const result = await bridge.sendReviewedMessage('slack', {
        channel: selfAlias,
        markdown_text: 'Hello from Hermes',
      });

      expect(result.error).toBeNull();
      expect(execute.mock.calls).toEqual([
        ['SLACK_TEST_AUTH', {}],
        ['SLACK_OPEN_DM', { users: 'U012AUTHED', return_im: true }],
        ['SLACK_SEND_MESSAGE', {
          channel: 'D012SELFDM',
          markdown_text: 'Hello from Hermes',
        }],
      ]);
    },
  );

  it('passes an existing Slack DM conversation id straight through', async () => {
    const bridge = new ComposioBridgeService(new ManagedBackendClient('https://backend.example'));
    const remote = (bridge as unknown as {
      bridgeClient: { executeTool: (slug: string, args: Record<string, unknown>) => Promise<unknown> };
    }).bridgeClient;
    const execute = vi.spyOn(remote, 'executeTool').mockResolvedValue({
      data: { ok: true },
      error: null,
      logId: null,
    });
    const args = { channel: 'D012EXISTING', markdown_text: 'Hello' };

    await bridge.sendReviewedMessage('slack', args);

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith('SLACK_SEND_MESSAGE', args);
  });

  it('leaves unrelated connected-app tools on the generic execution path', async () => {
    const bridge = new ComposioBridgeService(new ManagedBackendClient(''));

    await expect(bridge.executeTool('GMAIL_FETCH_EMAILS', {}))
      .rejects.toMatchObject({ status: 503 });
  });

  it('teaches existing managed profiles that drafts are not generic approvals', () => {
    const soul = applyMemorySoulSection('# Existing profile\n', true);

    expect(soul).toContain('Use propose_message_draft only to compose outbound Gmail email or Slack messages.');
    expect(soul).toContain('Never use it as a generic approval widget for Notion');
    expect(soul).not.toContain('Before using any custom connector tool');
  });
});
