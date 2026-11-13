import { describe, expect, it, vi } from 'vitest';
import { ComposioBridgeService } from '../src/integrations/composio-bridge.ts';
import { ManagedBackendClient } from '../src/integrations/managed-backend-client.ts';
import type { ConnectedAppsProvider } from '../src/integrations/connected-apps-provider.ts';

function fixture() {
  const executeTool = vi.fn(async () => ({ data: {}, error: null, logId: null }));
  const provider = { configured: true, executeTool, getToolSchemas: async () => [{
    slug: 'GMAIL_FETCH_EMAILS', inputParameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  }] } as unknown as ConnectedAppsProvider;
  return { executeTool, bridge: new ComposioBridgeService(new ManagedBackendClient(''), null, provider) };
}

describe('multi-account bridge', () => {
  it('exposes selection in native schemas and keeps it out of provider arguments', async () => {
    const { bridge, executeTool } = fixture();
    expect((await bridge.getToolSchemas(['GMAIL_FETCH_EMAILS']))[0].inputParameters).toMatchObject({
      properties: { connected_account_id: { type: 'string' }, query: { type: 'string' } }, required: ['query'],
    });
    await bridge.executeTool('GMAIL_FETCH_EMAILS', { connected_account_id: 'personal', query: 'hello' });
    expect(executeTool).toHaveBeenCalledWith('GMAIL_FETCH_EMAILS', { query: 'hello' }, 'personal');
  });

  it('preserves the selected sender for reviewed sends without enabling direct sends', async () => {
    const { bridge, executeTool } = fixture();
    const args = { connected_account_id: 'work', recipient_email: 'recipient@example.com', body: 'Hello' };
    await expect(bridge.executeTool('GMAIL_SEND_EMAIL', args)).rejects.toMatchObject({ status: 403 });
    await bridge.sendReviewedMessage('gmail', args);
    expect(executeTool).toHaveBeenCalledWith('GMAIL_SEND_EMAIL', { recipient_email: 'recipient@example.com', body: 'Hello' }, 'work');
  });

  it('rejects an invalid selector instead of falling back to another account', async () => {
    const { bridge, executeTool } = fixture();
    await expect(bridge.executeTool('GMAIL_FETCH_EMAILS', { connected_account_id: 123 })).rejects.toMatchObject({ status: 400 });
    expect(executeTool).not.toHaveBeenCalled();
  });
});
