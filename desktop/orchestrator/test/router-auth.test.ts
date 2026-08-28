import { describe, expect, it } from 'vitest';
import { buildConnectionsRoutes, renderCallbackPage } from '../src/connections/connections.ts';
import { dispatch, json, route, type Route } from '../src/http/router.ts';
import { HttpError, type ConnectionsService } from '../src/integrations/composio.ts';

const SECRET = 'test-sidecar-secret';

describe('sidecar router auth boundary', () => {
  it('rejects missing and wrong tokens on protected routes', async () => {
    expect((await request('/diagnostics')).status).toBe(401);
    expect((await request('/diagnostics', { headers: { 'x-verso-sidecar-token': 'wrong' } })).status).toBe(401);
  });

  it('accepts the correct token on protected routes', async () => {
    const res = await request('/diagnostics', { headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });

  it('does not grant CORS to hostile origins', async () => {
    const res = await request('/diagnostics', {
      headers: { ...authHeaders(), origin: 'https://evil.example' },
    });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  // WKWebView serializes the chat page's origin as "file://" because the
  // shell enables allowFileAccessFromFileURLs (see ChatWebView.swift).
  it('allows WKWebView file-origin preflight with required headers', async () => {
    const res = await request('/chat/sessions', {
      method: 'OPTIONS',
      headers: {
        origin: 'file://',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, x-verso-sidecar-token',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('file://');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain('x-verso-sidecar-token');
  });

  it('does not grant CORS to the null origin (forgeable via sandboxed iframes)', async () => {
    const res = await request('/chat/sessions', {
      method: 'OPTIONS',
      headers: {
        origin: 'null',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, x-verso-sidecar-token',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not grant CORS to hostile preflights', async () => {
    const res = await request('/chat/sessions', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, x-verso-sidecar-token',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('still requires the token on protected requests after preflight', async () => {
    await request('/chat/sessions', {
      method: 'OPTIONS',
      headers: {
        origin: 'null',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, x-verso-sidecar-token',
      },
    });
    const res = await request('/chat/sessions', {
      method: 'POST',
      headers: { origin: 'null', 'content-type': 'application/json' },
    });
    expect(res.status).toBe(401);
  });

  it('keeps public exemptions narrow', async () => {
    expect((await request('/health')).status).toBe(200);
    expect((await request('/connections/requests/abc/open')).status).toBe(302);
    expect((await request('/connections/callback?status=success')).status).toBe(200);
    expect((await request('/connections/callback/font')).status).toBe(200);
    expect((await request('/connections/requests/abc')).status).toBe(401);
  });

  it('renders branded callback pages and serves the bundled font', async () => {
    const html = renderCallbackPage('<Complete>', 'Return to verso & continue.');
    expect(html).toContain('font-family: "IBM Plex Sans"');
    expect(html).toContain('background: #F5F2EA');
    expect(html).toContain('text-align: center');
    expect(html).toContain('&lt;Complete&gt;');
    expect(html).toContain('verso &amp; continue');

    const routes = buildConnectionsRoutes({} as ConnectionsService);
    const callback = await request('/connections/callback?status=success', { routes });
    expect(callback.status).toBe(200);
    expect(callback.headers['content-type']).toBe('text/html; charset=utf-8');

    const font = await request('/connections/callback/font', { routes });
    expect(font.status).toBe(200);
    expect(font.headers['content-type']).toBe('font/ttf');
    expect(font.headers['access-control-allow-origin']).toBe('*');
    expect(Number(font.headers['content-length'])).toBeGreaterThan(100_000);
  });

  it('reconciles a failed callback with the exact active connected account', async () => {
    const connections = {
      listConnections: async () => [{
        connectedAccountId: 'ca_active',
        toolkitSlug: 'one_drive',
        toolkitName: 'OneDrive',
        logoUrl: null,
        status: 'active',
      }],
    } as unknown as ConnectionsService;

    const callback = await request(
      '/connections/callback?status=failed&connected_account_id=ca_active',
      { routes: buildConnectionsRoutes(connections) },
    );

    expect(callback.body).toContain('Connection complete');
    expect(callback.body).not.toContain('Connection failed');
  });

  it('keeps a failed callback failed when its account is not active', async () => {
    const connections = {
      listConnections: async () => [],
    } as unknown as ConnectionsService;

    const callback = await request(
      '/connections/callback?status=failed&connected_account_id=ca_failed',
      { routes: buildConnectionsRoutes(connections) },
    );

    expect(callback.body).toContain('Connection failed');
  });

  it('rejects malformed, foreign, and DNS-rebinding Host headers before public routes', async () => {
    for (const host of [
      'evil.example:4123',
      '127.0.0.1.evil.example:4123',
      'localtest.me:4123',
      '2130706433:4123',
      '127.1:4123',
      'http://127.0.0.1:4123',
      '127.0.0.1',
      '127.0.0.1:9999',
      '127.0.0.1:70000',
      '127.0.0.1:4123#frag',
      'user@127.0.0.1:4123',
    ]) {
      const res = await request('/connections/callback', { headers: { host }, localPort: 4123 });
      expect(res.status, host).toBe(400);
    }
  });

  it('accepts only the local loopback Host forms the sidecar serves', async () => {
    expect((await request('/health', { headers: { host: '127.0.0.1:4123' }, localPort: 4123 })).status).toBe(200);
    expect((await request('/health', { headers: { host: 'localhost:4123' }, localPort: 4123 })).status).toBe(200);
  });

  it('does not reflect an attacker Host into the Composio callback payload', async () => {
    let capturedBaseUrl: string | null = null;
    const connections = {
      requestConnection: async (_toolkit: string, baseUrl: string) => {
        capturedBaseUrl = baseUrl;
        return { id: 'req_1', redirectUrl: 'https://composio.example/auth' };
      },
    } as unknown as ConnectionsService;

    const res = await request('/connections/request', {
      method: 'POST',
      headers: {
        ...authHeaders(),
        host: 'evil.example:4123',
        'content-type': 'application/json',
      },
      routes: buildConnectionsRoutes(connections),
      body: { toolkit: 'gmail' },
      localPort: 4123,
    });
    expect(res.status).toBe(400);
    expect(capturedBaseUrl).toBeNull();

    const valid = await request('/connections/request', {
      method: 'POST',
      headers: {
        ...authHeaders(),
        host: '127.0.0.1:4123',
        'content-type': 'application/json',
      },
      routes: buildConnectionsRoutes(connections),
      body: { toolkit: 'gmail' },
      localPort: 4123,
    });
    expect(valid.status).toBe(201);
    expect(capturedBaseUrl).toBe('http://127.0.0.1:4123');
  });

  it('returns the disconnect result from DELETE /connections/:id', async () => {
    const connections = {
      deleteConnection: async (id: string) => ({
        connectedAccountId: id,
        composioAccountDeleted: true,
        providerRevocation: 'manual_action_required',
      }),
    } as unknown as ConnectionsService;

    const res = await request('/connections/ca_1', {
      method: 'DELETE',
      headers: authHeaders(),
      routes: buildConnectionsRoutes(connections),
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      disconnect: {
        connectedAccountId: 'ca_1',
        composioAccountDeleted: true,
        providerRevocation: 'manual_action_required',
      },
    });
  });

  it('maps a retryable disconnect failure from DELETE /connections/:id without leaking internals', async () => {
    const connections = {
      deleteConnection: async () => {
        throw new HttpError(502, 'Could not revoke the provider connection. Try again.');
      },
    } as unknown as ConnectionsService;

    const res = await request('/connections/ca_1', {
      method: 'DELETE',
      headers: authHeaders(),
      routes: buildConnectionsRoutes(connections),
    });

    expect(res.status).toBe(502);
    expect(JSON.parse(res.body)).toEqual({
      error: 'request_failed',
      message: 'Could not revoke the provider connection. Try again.',
    });
  });

  it('does not expose the secret in diagnostics', async () => {
    const res = await request('/diagnostics', {
      headers: authHeaders(),
      routes: [
        route('GET', '/diagnostics', async (_req, res) => {
          json(res, 200, { status: 'ok', auth: 'configured' });
        }),
      ],
    });
    expect(res.body).not.toContain(SECRET);
  });
});

async function request(pathname: string, opts: {
  method?: string;
  headers?: Record<string, string>;
  routes?: Route[];
  localPort?: number;
  body?: unknown;
} = {}): Promise<{ status: number; headers: Record<string, string | number | string[]>; body: string }> {
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const req = {
    method: opts.method ?? 'GET',
    url: pathname,
    headers: { host: '127.0.0.1:4123', ...(opts.headers ?? {}) },
    socket: { localPort: opts.localPort ?? 4123 },
    on(event: string, listener: (...args: unknown[]) => void) {
      if (event === 'data' && body !== undefined) listener(Buffer.from(body));
      if (event === 'end') listener();
      return this;
    },
  };
  const res = makeResponse();
  await dispatch(opts.routes ?? testRoutes(), req as never, res as never, { authSecret: SECRET });
  return res.result();
}

function makeResponse() {
  let status = 200;
  let body = '';
  const headers: Record<string, string | number | string[]> = {};
  return {
    setHeader(name: string, value: string | number | string[]) {
      headers[name.toLowerCase()] = value;
    },
    writeHead(nextStatus: number, nextHeaders?: Record<string, string | number | string[]>) {
      status = nextStatus;
      for (const [name, value] of Object.entries(nextHeaders ?? {})) headers[name.toLowerCase()] = value;
    },
    write(chunk: string | Buffer) {
      body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    },
    end(chunk?: string | Buffer) {
      if (chunk) body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    },
    result: () => ({ status, headers, body }),
  };
}

function testRoutes(): Route[] {
  return [
    route('GET', '/health', async (_req, res) => {
      json(res, 200, { status: 'ok' });
    }),
    route('GET', '/diagnostics', async (_req, res) => {
      json(res, 200, { status: 'ok' });
    }),
    route('POST', '/chat/sessions', async (_req, res) => {
      json(res, 201, { session: { id: 'chat_1' } });
    }),
    route('GET', '/connections/requests/:id', async (_req, res) => {
      json(res, 200, { request: { id: 'abc' } });
    }),
    route('GET', '/connections/requests/:id/open', async (_req, res) => {
      res.writeHead(302, { Location: 'https://example.com/oauth' });
      res.end();
    }),
    route('GET', '/connections/callback', async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>OK</title>');
    }),
    route('GET', '/connections/callback/font', async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'font/ttf' });
      res.end('font');
    }),
  ];
}

function authHeaders(): Record<string, string> {
  return { 'x-verso-sidecar-token': SECRET };
}
