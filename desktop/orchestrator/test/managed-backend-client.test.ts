import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import {
  ManagedBackendClient,
  ManagedBackendError,
  resolveManagedBackendUrl,
} from '../src/integrations/managed-backend-client.ts';

let backendServer: http.Server | null = null;
let backendPort = 0;
let nextAccountStatus = 200;
let nextRevokeStatus = 204;
let revokeCallCount = 0;
let revokeAuthHeader: string | null = null;
let accountDeviceHeader: string | null = null;

beforeAll(async () => {
  backendPort = await allocatePort();
  backendServer = await startFakeBackend(backendPort);
});

afterAll(async () => {
  if (backendServer) {
    await new Promise<void>((resolve) => backendServer!.close(() => resolve()));
    backendServer = null;
  }
});

function freshClient(opts: { withSession?: boolean } = {}): ManagedBackendClient {
  const client = new ManagedBackendClient(`http://127.0.0.1:${backendPort}`);
  if (opts.withSession !== false) {
    client.setSession({
      token: 'token-test',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      userId: 'usr_test',
      deviceId: 'dev_test',
      email: null,
      displayName: null,
      receivedAt: new Date().toISOString(),
    });
  }
  return client;
}

describe('ManagedBackendClient.getAccount', () => {
  it('stays disabled in local mode even with a stale backend URL and session', async () => {
    const client = new ManagedBackendClient({
      runtimeMode: 'local',
      baseUrl: 'https://managed.example',
    });
    client.setSession({
      token: 'stale-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      userId: 'stale-user',
      deviceId: 'stale-device',
      email: null,
      displayName: null,
      receivedAt: new Date().toISOString(),
    });

    const account = await client.getAccount();

    expect(client.configured).toBe(false);
    expect(client.getStoredSession()).toBeNull();
    expect(account.runtimeMode).toBe('local');
    expect(account.capabilities).toEqual({ managedAccount: false, remoteConnections: false });
  });

  it('has no implicit managed backend default', () => {
    expect(resolveManagedBackendUrl('managed', {})).toBe('');
    expect(resolveManagedBackendUrl('local', {
      VERSO_BACKEND_URL: 'https://managed.example',
    })).toBe('');
  });

  it('reports signed out when no session is loaded', async () => {
    const client = freshClient({ withSession: false });

    const account = await client.getAccount();

    expect(account.session.present).toBe(false);
    expect(account.account.state).toBe('signed_out');
  });

  it('hydrates account data from /v1/me', async () => {
    nextAccountStatus = 200;
    const client = freshClient();

    const account = await client.getAccount();

    expect(account.account.state).toBe('authenticated');
    expect(accountDeviceHeader).toBe('dev_test');
    expect(account.account.user?.email).toBe('hugo@example.com');
    expect(account.account.entitlements[0]?.mode).toBe('managed');
  });

  it('maps backend auth failures to invalid_session', async () => {
    nextAccountStatus = 401;
    const client = freshClient();

    const account = await client.getAccount();

    expect(account.account.state).toBe('invalid_session');
    expect(account.account.error).toBe('Invalid token.');
  });
});

describe('ManagedBackendClient.revokeSession', () => {
  it('POSTs /v1/auth/revoke with the in-memory bearer and treats 204 as success', async () => {
    nextRevokeStatus = 204;
    revokeCallCount = 0;
    revokeAuthHeader = null;

    const client = freshClient();
    await expect(client.revokeSession()).resolves.toBeUndefined();
    expect(revokeCallCount).toBe(1);
    expect(revokeAuthHeader).toBe('Bearer token-test');
  });

  it('is a no-op when no session is loaded', async () => {
    revokeCallCount = 0;
    const client = freshClient({ withSession: false });
    await expect(client.revokeSession()).resolves.toBeUndefined();
    expect(revokeCallCount).toBe(0);
  });

  it('treats 401 as success because the session is already invalid', async () => {
    nextRevokeStatus = 401;
    revokeCallCount = 0;
    const client = freshClient();
    await expect(client.revokeSession()).resolves.toBeUndefined();
    expect(revokeCallCount).toBe(1);
  });

  it('surfaces non-auth revoke failures', async () => {
    nextRevokeStatus = 503;
    const client = freshClient();

    const error = await client.revokeSession().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ManagedBackendError);
    expect((error as ManagedBackendError).status).toBe(503);
  });
});

async function startFakeBackend(port: number): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/v1/me') {
      accountDeviceHeader = (req.headers['x-verso-device-id'] as string | undefined) ?? null;
      if (nextAccountStatus !== 200) {
        res.writeHead(nextAccountStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_session', message: 'Invalid token.' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        user: {
          id: 'usr_test',
          workosUserId: 'user_workos_test',
          email: 'hugo@example.com',
          displayName: null,
        },
        device: {
          id: 'dev_test',
          label: 'verso for macOS',
          platform: 'macos',
          lastSeenAt: new Date().toISOString(),
        },
        session: {
          id: 'ses_test',
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        entitlements: [
          {
            id: 'ent_test',
            mode: 'managed',
            status: 'active',
            allowedModels: null,
            monthlyUsdLimit: null,
            dailyUsdLimit: null,
          },
        ],
      }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/revoke') {
      revokeCallCount += 1;
      revokeAuthHeader = (req.headers.authorization as string | undefined) ?? null;
      res.writeHead(nextRevokeStatus, { 'Content-Type': 'application/json' });
      res.end(nextRevokeStatus === 204 ? '' : JSON.stringify({ error: 'invalid_session', message: 'gone' }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return server;
}

async function allocatePort(): Promise<number> {
  const server = http.createServer();
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to allocate port'));
        return;
      }
      const { port } = addr;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}
