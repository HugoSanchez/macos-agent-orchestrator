import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../src/http/server.ts';

describe('Chat HTTP Endpoints', () => {
  let server: http.Server | null = null;
  let port = 0;
  const envSnapshot = {
    VERSO_HERMES_MANAGED: process.env.VERSO_HERMES_MANAGED,
    VERSO_CHAT_STORE_PATH: process.env.VERSO_CHAT_STORE_PATH,
  };

  beforeAll(async () => {
    process.env.VERSO_HERMES_MANAGED = 'false';
    process.env.VERSO_CHAT_STORE_PATH = `/tmp/verso-chat-endpoint-${process.pid}.sqlite`;
    const result = await startServer({ port: 0, allowUnauthenticated: true });
    server = result.server;
    port = result.port;
  });

  afterAll(async () => {
    if (server) {
      server.close();
      server = null;
    }
    process.env.VERSO_HERMES_MANAGED = envSnapshot.VERSO_HERMES_MANAGED;
    process.env.VERSO_CHAT_STORE_PATH = envSnapshot.VERSO_CHAT_STORE_PATH;
  });

  function url(path: string): string {
    return `http://127.0.0.1:${port}${path}`;
  }

  async function fetchJson(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
    const res = await fetch(url(path), init);
    const body = await res.json();
    return { status: res.status, body };
  }

  it('reports Hermes chat status', async () => {
    const { status, body } = await fetchJson('/chat/status');
    expect(status).toBe(200);
    expect(body.status).toBe('idle');
    expect(body.provider).toBe('hermes');
    expect(body.hasActiveRequest).toBe(false);
  });

  it('rejects direct message sends before contacting the managed Composio bridge', async () => {
    const { status, body } = await fetchJson('/composio/tools/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolSlug: 'GMAIL_SEND_EMAIL', arguments: {} }),
    });
    expect(status).toBe(403);
    expect(body.error).toBe('request_failed');
    expect(body.message).toMatch(/requires review/i);
  });

  it('hides managed connection actions in local mode without a remote request', async () => {
    const { status, body } = await fetchJson('/connections/toolkits?limit=100');

    expect(status).toBe(200);
    expect(body).toMatchObject({
      available: false,
      configured: false,
      toolkits: [],
      nextCursor: null,
    });
  });

  it('creates and reads a session', async () => {
    const created = await fetchJson('/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Inflation thread' }),
    });

    expect(created.status).toBe(201);
    expect(created.body.session.title).toBe('Inflation thread');
    expect(created.body.session.archivedAt).toBeNull();
    expect(created.body.session.model).toBeNull();

    const sessionId = created.body.session.id as string;

    const fetched = await fetchJson(`/chat/sessions/${sessionId}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.session.id).toBe(sessionId);

    const messages = await fetchJson(`/chat/sessions/${sessionId}/messages`);
    expect(messages.status).toBe(200);
    expect(messages.body.messages).toEqual([]);
  });

  it('persists the selected model with the session', async () => {
    const created = await fetchJson('/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Provider-specific thread', model: 'claude-opus-4-8' }),
    });
    expect(created.status).toBe(201);
    expect(created.body.session.model).toBe('claude-opus-4-8');

    const sessionId = created.body.session.id as string;
    const changed = await fetchJson(`/chat/sessions/${sessionId}/model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.5' }),
    });
    expect(changed.status).toBe(200);
    expect(changed.body.session.model).toBe('gpt-5.5');

    const reopened = await fetchJson(`/chat/sessions/${sessionId}`);
    expect(reopened.body.session.model).toBe('gpt-5.5');

    const listed = await fetchJson('/chat/sessions');
    expect(listed.body.sessions.find((session: { id: string }) => session.id === sessionId)?.model).toBe('gpt-5.5');
  });

  it('rejects unsupported and retired session models', async () => {
    const created = await fetchJson('/chat/sessions', { method: 'POST' });
    const sessionId = created.body.session.id as string;
    const retired = await fetchJson(`/chat/sessions/${sessionId}/model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.4' }),
    });
    expect(retired.status).toBe(400);

    const unknown = await fetchJson(`/chat/sessions/${sessionId}/model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'not-a-real-model' }),
    });
    expect(unknown.status).toBe(400);
  });

  it('requires an explicit choice for a legacy session with no stored model', async () => {
    const id = `legacy-${randomUUID()}`;
    const now = new Date().toISOString();
    const db = new DatabaseSync(process.env.VERSO_CHAT_STORE_PATH!);
    db.prepare(`
      INSERT INTO chat_sessions (id, title, created_at, updated_at, hermes_session_id, model, archived_at)
      VALUES (?, 'Legacy thread', ?, ?, NULL, NULL, NULL)
    `).run(id, now, now);
    db.close();

    const result = await fetchJson(`/chat/sessions/${id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Do not guess a model' }),
    });
    expect(result.status).toBe(409);
    expect(result.body.error).toBe('model_required');
  });

  it('archives and restores a session', async () => {
    const created = await fetchJson('/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Archive me' }),
    });

    const sessionId = created.body.session.id as string;

    const archived = await fetchJson(`/chat/sessions/${sessionId}/archive`, {
      method: 'POST',
    });
    expect(archived.status).toBe(200);
    expect(archived.body.session.archivedAt).toEqual(expect.any(String));

    const restored = await fetchJson(`/chat/sessions/${sessionId}/unarchive`, {
      method: 'POST',
    });
    expect(restored.status).toBe(200);
    expect(restored.body.session.archivedAt).toBeNull();
  });

  it('renames a session', async () => {
    const created = await fetchJson('/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Draft title' }),
    });

    const sessionId = created.body.session.id as string;

    const renamed = await fetchJson(`/chat/sessions/${sessionId}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed session' }),
    });

    expect(renamed.status).toBe(200);
    expect(renamed.body.session.title).toBe('Renamed session');
  });

  it('rejects missing message content', async () => {
    const created = await fetchJson('/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const sessionId = created.body.session.id as string;

    const res = await fetchJson(`/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
  });

  it('rejects an attachment whose bytes match no supported type', async () => {
    const created = await fetchJson('/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const sessionId = created.body.session.id as string;

    // No image or document magic — rejected by the sniff before anything else.
    const res = await fetchJson(`/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'look at this',
        attachments: [{
          name: 'mystery.bin',
          mimeType: 'application/octet-stream',
          dataBase64: Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]).toString('base64'),
        }],
      }),
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
    expect(res.body.message).toMatch(/images.*documents|documents.*images/i);
  });

  it('routes a PDF to document conversion (declared MIME is advisory)', async () => {
    // Same payload the old suite rejected as a non-image: a `%PDF-` header now
    // routes to document conversion, not the image sniff. This body is garbage,
    // so conversion fails — but with a *document* error, proving the new route.
    const created = await fetchJson('/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol' }),
    });
    const sessionId = created.body.session.id as string;

    const res = await fetchJson(`/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'read this',
        attachments: [{
          name: 'not-an-image.png',
          mimeType: 'image/png',
          dataBase64: Buffer.from('%PDF-1.4 nope', 'latin1').toString('base64'),
        }],
      }),
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
    // Not the old image-only rejection copy.
    expect(res.body.message).not.toContain('PNG, JPEG, WebP, and GIF');
    expect(res.body.message).toMatch(/document/i);
  });
});
