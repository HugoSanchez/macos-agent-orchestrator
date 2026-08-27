import { describe, expect, it } from 'vitest';
import { applyMemorySoulSection } from '../src/memory/memory-soul.ts';
import { ManagedBackendClient } from '../src/integrations/managed-backend-client.ts';
import {
  ComposioBridgeHttpError,
  ComposioBridgeService,
} from '../src/integrations/composio-bridge.ts';

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

  it('teaches existing managed profiles that drafts are not generic approvals', () => {
    const soul = applyMemorySoulSection('# Existing profile\n', true);

    expect(soul).toContain('Use propose_message_draft only to compose outbound Gmail email or Slack messages.');
    expect(soul).toContain('Never use it as a generic approval widget for Notion');
    expect(soul).not.toContain('Before using any custom connector tool');
  });
});
