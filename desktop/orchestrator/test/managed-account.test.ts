import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/http/server.ts';

let currentPort = 0;

describe('Managed account routes', () => {
  let server: http.Server | null = null;
  let backendServer: http.Server | null = null;
  let port = 0;
  let backendPort = 0;
  let tempDir = '';
  let envSnapshot: Record<string, string | undefined> = {};

  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'verso-managed-account-'));
    envSnapshot = {
      VERSO_RUNTIME_MODE: process.env.VERSO_RUNTIME_MODE,
      VERSO_BACKEND_URL: process.env.VERSO_BACKEND_URL,
      VERSO_CHAT_STORE_PATH: process.env.VERSO_CHAT_STORE_PATH,
      VERSO_MANAGED_SESSION_TOKEN: process.env.VERSO_MANAGED_SESSION_TOKEN,
      VERSO_MANAGED_SESSION_EXPIRES_AT: process.env.VERSO_MANAGED_SESSION_EXPIRES_AT,
      VERSO_MANAGED_USER_ID: process.env.VERSO_MANAGED_USER_ID,
    };

    backendPort = await allocatePort();
    process.env.VERSO_RUNTIME_MODE = 'managed';
    process.env.VERSO_BACKEND_URL = `http://127.0.0.1:${backendPort}`;
    process.env.VERSO_CHAT_STORE_PATH = path.join(tempDir, 'chat.sqlite');
    delete process.env.VERSO_MANAGED_SESSION_TOKEN;
    delete process.env.VERSO_MANAGED_SESSION_EXPIRES_AT;
    delete process.env.VERSO_MANAGED_USER_ID;

    backendServer = await startFakeBackend(backendPort);
    const result = await startServer({ port: 0, allowUnauthenticated: true });
    server = result.server;
    port = result.port;
    currentPort = port;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }

    if (backendServer) {
      await new Promise<void>((resolve) => backendServer!.close(() => resolve()));
      backendServer = null;
    }

    restoreEnv('VERSO_RUNTIME_MODE', envSnapshot.VERSO_RUNTIME_MODE);
    restoreEnv('VERSO_BACKEND_URL', envSnapshot.VERSO_BACKEND_URL);
    restoreEnv('VERSO_CHAT_STORE_PATH', envSnapshot.VERSO_CHAT_STORE_PATH);
    restoreEnv('VERSO_MANAGED_SESSION_TOKEN', envSnapshot.VERSO_MANAGED_SESSION_TOKEN);
    restoreEnv('VERSO_MANAGED_SESSION_EXPIRES_AT', envSnapshot.VERSO_MANAGED_SESSION_EXPIRES_AT);
    restoreEnv('VERSO_MANAGED_USER_ID', envSnapshot.VERSO_MANAGED_USER_ID);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports signed out when no managed session has been pushed', async () => {
    await fetch(url('/managed/session'), { method: 'DELETE' });

    const res = await fetch(url('/managed/account'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.session.present).toBe(false);
    expect(body.account.state).toBe('signed_out');
    expect(body.account.user).toBeNull();
  });

  it('hydrates authenticated account data from the backend after a session push', async () => {
    const pushRes = await fetch(url('/managed/session'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: 'token_test_123',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        userId: 'usr_test_123',
        email: 'hugo@example.com',
        displayName: null,
        receivedAt: new Date().toISOString(),
      }),
    });
    expect(pushRes.status).toBe(200);

    const res = await fetch(url('/managed/account'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.session.present).toBe(true);
    expect(body.account.state).toBe('authenticated');
    expect(body.account.user.email).toBe('hugo@example.com');
    expect(body.account.device.platform).toBe('macos');
    expect(body.account.entitlements).toEqual([
      expect.objectContaining({
        mode: 'managed',
        status: 'active',
      }),
    ]);
  });

  it('rejects malformed session pushes', async () => {
    const res = await fetch(url('/managed/session'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'only_token' }),
    });
    expect(res.status).toBe(400);
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function url(pathname: string): string {
  return `http://127.0.0.1:${currentPort}${pathname}`;
}

async function startFakeBackend(port: number): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/v1/me') {
      if (req.headers.authorization !== 'Bearer token_test_123') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_session', message: 'Invalid token.' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        user: {
          id: 'usr_test_123',
          privyUserId: 'did:privy:test-user',
          email: 'hugo@example.com',
          displayName: null,
        },
        device: {
          id: 'dev_test_123',
          label: 'verso for macOS',
          platform: 'macos',
          lastSeenAt: new Date().toISOString(),
        },
        session: {
          id: 'ses_test_123',
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
        entitlements: [
          {
            id: 'ent_test_123',
            mode: 'managed',
            status: 'active',
            allowedModels: ['openai/gpt-5.4'],
            monthlyUsdLimit: null,
            dailyUsdLimit: null,
          },
        ],
      }));
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
