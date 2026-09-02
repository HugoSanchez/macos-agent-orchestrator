import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/http/server.ts';

describe('Managed Hermes authentication recovery', () => {
  let baseUrl = '';
  let closeServer: (() => Promise<void>) | null = null;
  let tempHome = '';
  let envSnapshot: Record<string, string | undefined> = {};

  beforeAll(async () => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), 'verso-auth-recovery-'));
    envSnapshot = {
      API_SERVER_KEY: process.env.API_SERVER_KEY,
      FAKE_HERMES_REJECT_FIRST_RESPONSE_AUTH_ONCE: process.env.FAKE_HERMES_REJECT_FIRST_RESPONSE_AUTH_ONCE,
      VERSO_CHAT_STORE_PATH: process.env.VERSO_CHAT_STORE_PATH,
      VERSO_HERMES_API_SERVER_KEY: process.env.VERSO_HERMES_API_SERVER_KEY,
      VERSO_HERMES_ARGS: process.env.VERSO_HERMES_ARGS,
      VERSO_HERMES_COMMAND: process.env.VERSO_HERMES_COMMAND,
      VERSO_HERMES_CWD: process.env.VERSO_HERMES_CWD,
      VERSO_HERMES_GATEWAY_URL: process.env.VERSO_HERMES_GATEWAY_URL,
      VERSO_HERMES_HOME: process.env.VERSO_HERMES_HOME,
      VERSO_HERMES_MANAGED: process.env.VERSO_HERMES_MANAGED,
      VERSO_MEMORY_ENABLED: process.env.VERSO_MEMORY_ENABLED,
    };
    delete process.env.API_SERVER_KEY;
    delete process.env.VERSO_HERMES_API_SERVER_KEY;
    delete process.env.VERSO_HERMES_GATEWAY_URL;
    process.env.FAKE_HERMES_REJECT_FIRST_RESPONSE_AUTH_ONCE = '1';
    process.env.VERSO_CHAT_STORE_PATH = path.join(tempHome, 'chat.sqlite');
    process.env.VERSO_HERMES_ARGS = JSON.stringify([
      path.resolve(process.cwd(), 'test/fixtures/fake-hermes-gateway.mjs'),
    ]);
    process.env.VERSO_HERMES_COMMAND = process.execPath;
    process.env.VERSO_HERMES_CWD = process.cwd();
    process.env.VERSO_HERMES_HOME = tempHome;
    process.env.VERSO_HERMES_MANAGED = 'true';
    process.env.VERSO_MEMORY_ENABLED = '0';

    const started = await startServer({ port: 0, allowUnauthenticated: true });
    baseUrl = `http://127.0.0.1:${started.port}`;
    closeServer = started.close;
  });

  afterAll(async () => {
    await closeServer?.();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('rotates endpoint and key once, then safely retries the rejected prompt', async () => {
    const created = await fetch(`${baseUrl}/chat/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Recovery', model: 'gpt-5.6-sol' }),
    });
    const sessionId = (await created.json() as { session: { id: string } }).session.id;

    const response = await fetch(`${baseUrl}/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Recover this request' }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('Reconnecting to Hermes');
    expect(body).toContain('Managed Hermes: Recover this request');
    expect(existsSync(path.join(tempHome, '.fake-hermes-rejected-response-auth'))).toBe(true);
  }, 20_000);
});
