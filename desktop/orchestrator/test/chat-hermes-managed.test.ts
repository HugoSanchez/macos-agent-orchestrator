import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import { startServer } from '../src/http/server.ts';

describe('Managed Hermes Startup', () => {
  let server: http.Server | null = null;
  let port = 0;
  let gatewayPort = 0;
  let envSnapshot: {
    API_SERVER_KEY?: string;
    VERSO_HERMES_API_SERVER_KEY?: string;
    VERSO_HERMES_GATEWAY_URL?: string;
    VERSO_CHAT_STORE_PATH?: string;
    VERSO_HERMES_COMMAND?: string;
    VERSO_HERMES_ARGS?: string;
    VERSO_HERMES_CWD?: string;
    VERSO_HERMES_MANAGED?: string;
  } = {};

  beforeAll(async () => {
    envSnapshot = {
      API_SERVER_KEY: process.env.API_SERVER_KEY,
      VERSO_HERMES_API_SERVER_KEY: process.env.VERSO_HERMES_API_SERVER_KEY,
      VERSO_HERMES_GATEWAY_URL: process.env.VERSO_HERMES_GATEWAY_URL,
      VERSO_CHAT_STORE_PATH: process.env.VERSO_CHAT_STORE_PATH,
      VERSO_HERMES_COMMAND: process.env.VERSO_HERMES_COMMAND,
      VERSO_HERMES_ARGS: process.env.VERSO_HERMES_ARGS,
      VERSO_HERMES_CWD: process.env.VERSO_HERMES_CWD,
      VERSO_HERMES_MANAGED: process.env.VERSO_HERMES_MANAGED,
    };

    gatewayPort = await allocatePort();
    delete process.env.API_SERVER_KEY;
    delete process.env.VERSO_HERMES_API_SERVER_KEY;
    process.env.VERSO_HERMES_GATEWAY_URL = `http://127.0.0.1:${gatewayPort}`;
    process.env.VERSO_CHAT_STORE_PATH = `/tmp/verso-chat-managed-${process.pid}.sqlite`;
    process.env.VERSO_HERMES_COMMAND = process.execPath;
    process.env.VERSO_HERMES_ARGS = JSON.stringify([
      path.resolve(process.cwd(), 'test/fixtures/fake-hermes-gateway.mjs'),
    ]);
    process.env.VERSO_HERMES_CWD = process.cwd();
    process.env.VERSO_HERMES_MANAGED = 'true';

    const result = await startServer({ port: 0, allowUnauthenticated: true });
    server = result.server;
    port = result.port;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
      });
      server = null;
    }

    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function url(pathname: string): string {
    return `http://127.0.0.1:${port}${pathname}`;
  }

  async function fetchJson(pathname: string, init?: RequestInit): Promise<{ status: number; body: any }> {
    const res = await fetch(url(pathname), init);
    const body = await res.json();
    return { status: res.status, body };
  }

  it('streams a response through managed Hermes', async () => {
    const created = await fetchJson('/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Managed', model: 'gpt-5.6-sol' }),
    });
    const sessionId = created.body.session.id as string;

    const res = await fetch(url(`/chat/sessions/${sessionId}/messages`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Say hello from managed Hermes' }),
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Managed Hermes: Say hello from managed Hermes');
    expect(body).toContain('content_block_delta');

    const status = await fetchJson('/chat/status');
    expect(status.status).toBe(200);
    expect(status.body.gateway.reachable).toBe(true);
    expect(status.body.gateway.source).toBe('managed');
  });
});

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
