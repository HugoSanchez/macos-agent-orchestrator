import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsStore, type ConnectionRecord } from '../src/http/connections-store.ts';
import { ManagedBackendClient } from '../src/integrations/managed-backend-client.ts';
import { ConnectionsService } from '../src/integrations/composio.ts';

function fixtureConnection(overrides: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    connectedAccountId: 'ca_123',
    toolkitSlug: 'slack',
    toolkitName: 'Slack',
    logoUrl: 'https://example.com/slack.png',
    status: 'active',
    createdAt: '2026-05-12T10:00:00.000Z',
    updatedAt: '2026-05-12T10:00:00.000Z',
    ...overrides,
  };
}

function setupService(): { service: ConnectionsService; store: ConnectionsStore } {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'verso-connections-service-'));
  const store = new ConnectionsStore(
    path.join(tempDir, 'connections.json'),
    path.join(tempDir, 'composio-tools-refresh.marker'),
  );
  const managedBackend = new ManagedBackendClient('https://backend.example.test');
  managedBackend.setSession({
    token: 'token-test',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    userId: 'usr_test',
    email: null,
    displayName: null,
    receivedAt: new Date().toISOString(),
  });
  return { service: new ConnectionsService(managedBackend, store), store };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ConnectionsService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('removes stale local connections after a successful empty remote list', async () => {
    const { service, store } = setupService();
    store.upsertConnection(fixtureConnection());
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ connections: [] }));

    await expect(service.listConnections()).resolves.toEqual([]);

    expect(store.listConnections()).toEqual([]);
  });

  it('treats backend 404 on delete as already disconnected locally', async () => {
    const { service, store } = setupService();
    store.upsertConnection(fixtureConnection());
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ message: 'not found' }, 404));

    await expect(service.deleteConnection('ca_123')).resolves.toEqual({
      connectedAccountId: 'ca_123',
      composioAccountDeleted: true,
      providerRevocation: 'already_absent',
    });

    expect(store.listConnections()).toEqual([]);
  });

  it.each(['revoked', 'already_absent', 'manual_action_required'] as const)(
    'propagates the backend disconnect result "%s" and removes the local row',
    async (providerRevocation) => {
      const { service, store } = setupService();
      store.upsertConnection(fixtureConnection());
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
        disconnect: {
          connectedAccountId: 'ca_123',
          composioAccountDeleted: true,
          providerRevocation,
        },
      }));

      await expect(service.deleteConnection('ca_123')).resolves.toEqual({
        connectedAccountId: 'ca_123',
        composioAccountDeleted: true,
        providerRevocation,
      });

      expect(store.listConnections()).toEqual([]);
    },
  );

  it.each([
    ['missing disconnect result', undefined],
    ['missing composioAccountDeleted', { connectedAccountId: 'ca_123', providerRevocation: 'revoked' }],
    ['false composioAccountDeleted', { connectedAccountId: 'ca_123', composioAccountDeleted: false, providerRevocation: 'revoked' }],
    ['mismatched connectedAccountId', { connectedAccountId: 'ca_other', composioAccountDeleted: true, providerRevocation: 'revoked' }],
    ['missing providerRevocation', { connectedAccountId: 'ca_123', composioAccountDeleted: true }],
  ] as const)(
    'rejects an unconfirmed 200 disconnect body (%s) sanitized and keeps the local row',
    async (_label, disconnect) => {
      const { service, store } = setupService();
      store.upsertConnection(fixtureConnection());
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ disconnect }));

      await expect(service.deleteConnection('ca_123')).rejects.toMatchObject({
        status: 502,
        message: 'Managed backend returned an invalid disconnect result.',
      });

      expect(store.listConnections()).toHaveLength(1);
    },
  );

  it('keeps the local row when the backend reports a retryable revoke failure', async () => {
    const { service, store } = setupService();
    store.upsertConnection(fixtureConnection());
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ message: 'Could not revoke the provider connection. Try again.' }, 502),
    );

    await expect(service.deleteConnection('ca_123')).rejects.toMatchObject({ status: 502 });

    expect(store.listConnections()).toHaveLength(1);
  });

  it('never reports an unconfirmed revocation as revoked', async () => {
    // A legacy 204 body and an unrecognized status both mean the backend did
    // not confirm provider revocation; both degrade to manual action.
    const { service, store } = setupService();
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({
        disconnect: {
          connectedAccountId: 'ca_123',
          composioAccountDeleted: true,
          providerRevocation: 'weird_future_status',
        },
      }));

    store.upsertConnection(fixtureConnection());
    await expect(service.deleteConnection('ca_123')).resolves.toMatchObject({
      providerRevocation: 'manual_action_required',
    });

    store.upsertConnection(fixtureConnection());
    await expect(service.deleteConnection('ca_123')).resolves.toMatchObject({
      providerRevocation: 'manual_action_required',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.listConnections()).toEqual([]);
  });

  it('lets the catalog reconnect a toolkit when the remote connected flag is stale after delete', async () => {
    const { service, store } = setupService();
    store.upsertConnection(fixtureConnection());
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/v1/composio/toolkits?query=slack')) {
        return jsonResponse({
          toolkits: [
            {
              slug: 'slack',
              name: 'Slack',
              description: null,
              logoUrl: null,
              categories: [],
              authSchemes: [],
              composioManagedAuthSchemes: [],
              connected: true,
              connectedAccountId: 'ca_123',
              noAuth: false,
            },
          ],
        });
      }
      return jsonResponse({ connections: [] });
    });

    await service.deleteConnection('ca_123');
    const result = await service.listToolkits({ query: 'slack' });

    expect(result.toolkits).toHaveLength(1);
    expect(result.toolkits[0]).toMatchObject({
      slug: 'slack',
      connected: false,
      connectedAccountId: null,
    });
  });
});
