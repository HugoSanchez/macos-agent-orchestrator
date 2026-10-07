import { createServer, request, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCP_OAUTH_REDIRECT_URI, McpOAuthCallback, type OAuthCallbackLease } from '../src/connections/mcp-oauth-callback.ts';

const leases: OAuthCallbackLease[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const lease of leases.splice(0)) lease.release();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function listen(server: Server, port = 0, host = '127.0.0.1'): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host, ipv6Only: true }, resolve);
  });
  return (server.address() as { port: number }).port;
}

async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function authorize(state: string): string {
  return `https://provider.example/authorize?${new URLSearchParams({ state, redirect_uri: MCP_OAUTH_REDIRECT_URI })}`;
}

function callback(port: number, query: string, hostname = '127.0.0.1', hostHeader = `localhost:${port}`): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path: `/oauth/callback?${query}`, headers: { Host: hostHeader } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('shared MCP OAuth callback', () => {
  it('routes concurrent providers by state on IPv4 and IPv6, rejects replay, and frees the port', async () => {
    const received: string[] = [];
    const gatewayPort = await listen(createServer((req, res) => { received.push(req.url!); res.end('ok'); }));
    const port = await freePort();
    const listener = new McpOAuthCallback(port);
    const pair = await Promise.all([listener.acquire(), listener.acquire()]);
    leases.push(...pair);
    pair[0].register(authorize('hubspot-state'), `http://127.0.0.1:${gatewayPort}/callback/hubspot`);
    pair[1].register(authorize('other-state'), `http://127.0.0.1:${gatewayPort}/callback/other`);

    expect(await callback(port, 'state=other-state&code=other-code', '::1')).toBe(200);
    expect(await callback(port, 'state=hubspot-state&code=hubspot-code')).toBe(200);
    expect(received).toEqual([
      '/callback/other?state=other-state&code=other-code',
      '/callback/hubspot?state=hubspot-state&code=hubspot-code',
    ]);
    expect(await callback(port, 'state=hubspot-state&code=hubspot-code')).toBe(400);
    pair[0].release();
    expect(await callback(port, 'state=unknown&code=x')).toBe(400);
    pair[1].release();
    expect(await listen(createServer(), port)).toBe(port);
    expect(await listen(createServer(), port, '::1')).toBe(port);
  });

  it('rejects unknown, malformed, wrong-host, and cancelled callbacks without forwarding them', async () => {
    const received: string[] = [];
    const gatewayPort = await listen(createServer((req, res) => { received.push(req.url!); res.end(); }));
    const port = await freePort();
    const listener = new McpOAuthCallback(port);
    const lease = await listener.acquire();
    const keeper = await listener.acquire();
    leases.push(lease, keeper);
    lease.register(authorize('valid'), `http://127.0.0.1:${gatewayPort}/callback`);
    for (const query of ['code=x', 'state=wrong&code=x', 'state=valid', 'state=valid&state=wrong&code=x', 'state=valid&code=x&error=denied']) {
      expect(await callback(port, query)).toBe(400);
    }
    expect(await callback(port, 'state=valid&code=x', '127.0.0.1', 'untrusted.example')).toBe(404);
    lease.release();
    expect(await callback(port, 'state=valid&code=x')).toBe(400);
    expect(received).toEqual([]);
  });

  it('forwards provider denials and respects gateway state rejection', async () => {
    const received: string[] = [];
    const gatewayPort = await listen(createServer((req, res) => {
      received.push(req.url!);
      res.writeHead(400); res.end();
    }));
    const port = await freePort();
    const listener = new McpOAuthCallback(port);
    const lease = await listener.acquire();
    leases.push(lease);
    const onFailure = vi.fn();
    lease.register(authorize('denied'), `http://127.0.0.1:${gatewayPort}/callback`, onFailure);
    expect(await callback(port, 'state=denied&error=access_denied')).toBe(400);
    expect(received).toEqual(['/callback?state=denied&error=access_denied']);
    expect(onFailure).toHaveBeenCalledWith('Authorization was declined. Start sign-in again to grant access.');
  });

  it('reports an expired gateway flow back to the connector', async () => {
    const gatewayPort = await listen(createServer((_req, res) => { res.writeHead(404); res.end(); }));
    const port = await freePort();
    const lease = await new McpOAuthCallback(port).acquire();
    leases.push(lease);
    const onFailure = vi.fn();
    lease.register(authorize('expired'), `http://127.0.0.1:${gatewayPort}/callback`, onFailure);
    expect(await callback(port, 'state=expired&code=x')).toBe(400);
    expect(onFailure).toHaveBeenCalledWith('The sign-in session expired. Return to Verso and start sign-in again.');
  });

  it('fails clearly on an occupied port and releases the other address after a partial bind', async () => {
    const port = await listen(createServer(), 0, '::1');
    const listener = new McpOAuthCallback(port);
    await expect(listener.acquire()).rejects.toThrow(`OAuth callback port ${port}`);
    expect(await listen(createServer(), port, '127.0.0.1')).toBe(port);
  });

  it('requires the registered redirect URL and a unique state before forwarding', async () => {
    const port = await freePort();
    const listener = new McpOAuthCallback(port);
    const lease = await listener.acquire();
    leases.push(lease);
    expect(() => lease.register('https://provider.example/authorize?state=x', 'http://127.0.0.1:1/callback')).toThrow(/invalid OAuth/);
    expect(() => lease.register(`https://provider.example/authorize?redirect_uri=${encodeURIComponent(MCP_OAUTH_REDIRECT_URI)}`, 'http://127.0.0.1:1/callback')).toThrow(/invalid OAuth/);
  });
});
