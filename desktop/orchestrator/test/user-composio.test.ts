import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComposioService } from '@verso/composio';
import { ComposioProject, buildComposioProjectRoutes } from '../src/connections/composio-project.ts';
import { UserComposioProvider } from '../src/integrations/user-composio-provider.ts';
import { ConnectionsService } from '../src/integrations/composio.ts';
import { ConnectionsStore } from '../src/connections/connections-store.ts';
import { ManagedBackendClient } from '../src/integrations/managed-backend-client.ts';
import { ComposioBridgeService } from '../src/integrations/composio-bridge.ts';
import { GmailSource } from '../src/memory/ingestion/sources/gmail-source.ts';
import { scopeSource } from '../src/memory/ingestion/scoped-source.ts';
import { SourceIngestionScheduler } from '../src/memory/ingestion/source-ingestion.ts';
import { IngestionStore } from '../src/memory/ingestion/ingestion-store.ts';
import { LexicalMemoryProvider } from '../src/memory/lexical-provider.ts';
import { dispatch } from '../src/http/router.ts';

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'verso-composio-project-'));
  const secrets = new Map<string, string>();
  const keychain = {
    getSecret: vi.fn(async (id: string) => secrets.get(id) ?? null),
    setSecret: vi.fn(async (id: string, value: string) => { secrets.set(id, value); }),
    deleteSecret: vi.fn(async (id: string) => { secrets.delete(id); }),
  };
  const connection = { connectedAccountId: 'ca_gmail', toolkitSlug: 'gmail', toolkitName: 'Gmail', logoUrl: null, status: 'active' };
  const service = {
    listConnections: vi.fn(async () => [connection]),
    listToolkits: vi.fn(async () => []),
    requestConnection: vi.fn(async () => ({ id: 'req_1', toolkitSlug: 'gmail', toolkitName: 'Gmail', logoUrl: null,
      status: 'connected', connectedAccountId: 'ca_gmail', redirectUrl: null, errorMessage: null })),
    getRequest: vi.fn(async () => ({ id: 'req_1', toolkitSlug: 'gmail', toolkitName: 'Gmail', logoUrl: null,
      status: 'connected', connectedAccountId: 'ca_gmail', redirectUrl: null, errorMessage: null })),
    deleteConnection: vi.fn(async () => ({ connectedAccountId: 'ca_gmail', composioAccountDeleted: true, providerRevocation: 'revoked' })),
    listTools: vi.fn(async () => []),
    getToolSchemas: vi.fn(async () => []),
    executeTool: vi.fn(async () => ({ data: { messages: [{ messageId: 'm_1', threadId: 't_1',
      messageTimestamp: '2026-09-08T10:00:00Z', subject: 'Migration plan', sender: 'alice@example.test',
      messageText: 'The albatross project ships tomorrow.' }] }, error: null, logId: null })),
  };
  const createService = vi.fn((_key: string) => service as unknown as ComposioService);
  const filePath = path.join(dir, 'composio-project.json');
  const createProject = (mode: 'local' | 'byo' | 'managed' = 'local') => new ComposioProject(filePath, mode, { keychain, createService });
  return { dir, secrets, keychain, service, createService, filePath, createProject };
}

afterEach(() => vi.restoreAllMocks());

describe('User-owned Composio project', () => {
  it('stores only a credential reference on disk and activates on the next launch', async () => {
    const f = fixture();
    const project = f.createProject();
    await project.initialize();
    expect(f.keychain.getSecret).not.toHaveBeenCalled();
    const status = await project.save('personal-project-key');
    expect(status).toMatchObject({ saved: true, active: false, restartRequired: true });
    expect(JSON.stringify(status)).not.toContain('personal-project-key');
    expect(readFileSync(f.filePath, 'utf8')).not.toContain('personal-project-key');
    expect([...f.secrets.values()]).toEqual(['personal-project-key']);

    const restarted = f.createProject('byo');
    await restarted.initialize();
    expect(restarted.status()).toMatchObject({ saved: true, active: true, restartRequired: false, userId: status.userId });
    await restarted.connectedApps.listConnections();
    expect(f.service.listConnections).toHaveBeenLastCalledWith(status.userId);
  });

  it('rejects invalid credentials without replacing the saved project or exposing SDK errors', async () => {
    const f = fixture();
    const project = f.createProject();
    await project.save('working-key');
    const previous = readFileSync(f.filePath, 'utf8');
    f.service.listConnections.mockRejectedValueOnce(new Error('headers x-api-key: rejected-secret'));
    await expect(project.save('rejected-secret')).rejects.toThrow('Composio request failed');
    expect(readFileSync(f.filePath, 'utf8')).toBe(previous);
    expect([...f.secrets.values()]).toEqual(['working-key']);
  });

  it('isolates project changes and disables old tools until restart', async () => {
    const f = fixture();
    await f.createProject().save('first-key');
    const first = f.createProject();
    await first.initialize();
    const firstNamespace = first.namespace;
    await first.save('second-key');
    expect(first.connectedApps.configured).toBe(false);
    await expect(first.connectedApps.executeTool('GMAIL_FETCH_EMAILS', {})).rejects.toMatchObject({ status: 503 });
    const second = f.createProject();
    await second.initialize();
    expect(second.namespace).not.toBe(firstNamespace);
    expect(second.status().userId).toBe(first.status().userId);
  });

  it('removing a key stops access immediately, including in-flight responses', async () => {
    const f = fixture();
    await f.createProject().save('personal-key');
    const project = f.createProject();
    await project.initialize();
    let resolve!: (value: []) => void;
    f.service.listConnections.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const running = project.connectedApps.listConnections();
    const rejection = expect(running).rejects.toThrow();
    await project.remove();
    resolve([]);
    await rejection;
    expect(f.secrets.size).toBe(0);
    const restarted = f.createProject();
    await restarted.initialize();
    expect(restarted.status()).toMatchObject({ saved: false, active: false, restartRequired: false });
  });

  it('fails closed if Keychain is missing or no longer matches the stored reference', async () => {
    const f = fixture();
    await f.createProject().save('personal-key');
    for (const id of f.secrets.keys()) f.secrets.set(id, 'different-project');
    const project = f.createProject();
    await project.initialize();
    expect(project.connectedApps.configured).toBe(false);
  });

  it('does not load local project credentials in managed mode', async () => {
    const f = fixture();
    await f.createProject().save('personal-key');
    f.keychain.getSecret.mockClear();
    const project = f.createProject('managed');
    await project.initialize();
    expect(f.keychain.getSecret).not.toHaveBeenCalled();
    await expect(project.save('other-key')).rejects.toMatchObject({ status: 403 });
    expect(project.status()).toMatchObject({ provider: 'managed', editable: false, userId: null });
  });

  it('requires authenticated loopback access for settings, without echoing the key', async () => {
    const f = fixture();
    const routes = buildComposioProjectRoutes(f.createProject(), () => undefined);
    const server = http.createServer((req, res) => dispatch(routes, req, res, { authSecret: 'local-token' }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/settings/composio`;
    try {
      expect((await fetch(url)).status).toBe(401);
      const saved = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Verso-Sidecar-Token': 'local-token' }, body: JSON.stringify({ apiKey: 'secret-project-key' }) });
      expect(saved.status).toBe(200);
      expect(await saved.text()).not.toContain('secret-project-key');
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});

describe('Connected-app provider integration', () => {
  it('connects, polls, ingests searchable Gmail data, and revokes without a managed session', async () => {
    const f = fixture();
    const externalFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No Verso network calls allowed'));
    const provider = new UserComposioProvider(f.service as unknown as ComposioService, 'local-user');
    const managed = new ManagedBackendClient({ runtimeMode: 'local', baseUrl: 'https://verso.example.test' });
    const connections = new ConnectionsService(managed, new ConnectionsStore(path.join(f.dir, 'connections.json'), path.join(f.dir, 'marker')), null, provider);
    await connections.requestConnection('gmail', 'http://127.0.0.1:8888');
    await connections.getRequest('req_1');
    expect(await connections.listConnections()).toHaveLength(1);
    const bridge = new ComposioBridgeService(managed, null, provider);
    const source = scopeSource(new GmailSource(bridge), 'project-one');
    const memory = new LexicalMemoryProvider({ enabled: true, dbPath: path.join(f.dir, 'memory.sqlite') });
    await memory.start();
    try {
      const scheduler = new SourceIngestionScheduler(new IngestionStore(path.join(f.dir, 'ingestion.sqlite')), memory, [source], { connectionGate: () => provider.configured });
      const now = new Date('2026-09-08T11:00:00Z');
      scheduler.setSourceEnabled('gmail', true, now);
      await scheduler.tick(now);
      expect(await memory.search('albatross', 5)).toHaveLength(1);
      expect(f.service.executeTool).toHaveBeenCalledWith('local-user', 'GMAIL_FETCH_EMAILS', expect.objectContaining({ verbose: true }));
      expect(await connections.deleteConnection('ca_gmail')).toMatchObject({ providerRevocation: 'revoked' });
      expect(f.service.deleteConnection).toHaveBeenCalledWith('local-user', 'ca_gmail');
      expect(externalFetch).not.toHaveBeenCalled();
    } finally { await memory.stop(); }
  });

  it('retains reviewed-send protections for the direct provider', async () => {
    const f = fixture();
    const provider = new UserComposioProvider(f.service as unknown as ComposioService, 'local-user');
    const bridge = new ComposioBridgeService(new ManagedBackendClient({ runtimeMode: 'local' }), null, provider);
    await expect(bridge.executeTool('GMAIL_SEND_EMAIL', { recipient_email: 'person@example.test' })).rejects.toMatchObject({ status: 403 });
    expect(f.service.executeTool).not.toHaveBeenCalled();
    await expect(provider.requestConnection('gmail', 'https://foreign.example/callback')).rejects.toMatchObject({ status: 400 });
  });

  it('namespaces identical source IDs from different projects', async () => {
    const f = fixture();
    const bridge = new UserComposioProvider(f.service as unknown as ComposioService, 'user');
    const source = new GmailSource(bridge);
    const first = await scopeSource(source, 'first-project').fetchSince('', '0', { maxItems: 20 });
    const second = await scopeSource(source, 'second-project').fetchSince('', '0', { maxItems: 20 });
    expect(first.items[0].sourceRef).not.toBe(second.items[0].sourceRef);
    expect(first.nextCursor).toBe(second.nextCursor);
  });
});
