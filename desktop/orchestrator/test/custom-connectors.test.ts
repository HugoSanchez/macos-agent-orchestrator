import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { CustomConnectorsStore, sanitizeCustomConnectorSlug } from '../src/connections/custom-connectors-store.ts';
import { CustomConnectorKeychain, type KeychainExec } from '../src/connections/keychain.ts';
import { probeMcpServer } from '../src/connections/mcp-probe.ts';
import { HermesSupervisor } from '../src/hermes/hermes-supervisor.ts';
import { countCustomConnectorTools } from '../src/hermes/hermes-gateway-client.ts';
import {
  CustomConnectorService,
  customConnectorErrorMessage,
  removeHermesOAuthFiles,
  waitForCustomConnectorTools,
} from '../src/connections/custom-connectors.ts';

describe('custom MCP connectors', () => {
  let tempRoot = '';
  let envSnapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'verso-custom-connectors-'));
    envSnapshot = {
      HERMES_HOME: process.env.HERMES_HOME,
      VERSO_HERMES_COMMAND: process.env.VERSO_HERMES_COMMAND,
    };
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.unstubAllGlobals();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('sanitizes slugs and rejects duplicates/reserved names', () => {
    expect(sanitizeCustomConnectorSlug('Linear MCP!')).toBe('linear_mcp');
    const store = new CustomConnectorsStore(path.join(tempRoot, 'custom-connectors.json'));
    store.create({
      name: 'Linear',
      slug: 'linear',
      url: 'https://mcp.linear.app/mcp',
      transport: 'http',
      auth: 'oauth',
      logoUrl: null,
    });
    expect(() => store.create({
      name: 'Linear 2',
      slug: 'linear',
      url: 'https://example.com/mcp',
      transport: 'http',
      auth: 'none',
      logoUrl: null,
    })).toThrow(/already exists/);
    expect(() => store.create({
      name: 'Verso',
      slug: 'verso',
      url: 'https://example.com/mcp',
      transport: 'http',
      auth: 'none',
      logoUrl: null,
    })).toThrow(/reserved/);
  });

  it('keeps connector diagnostics out of user-facing errors', () => {
    expect(customConnectorErrorMessage(new Error(
      'Hermes gateway stopped unexpectedly (process exit code 0). Recent logs: Port 50104 already in use',
    ))).toBe('Verso couldn’t start the connection service. Please try again.');
    expect(customConnectorErrorMessage(new Error('The server rejected the API token.')))
      .toBe('The server rejected the API token.');
  });

  it('uses the security CLI wrapper without exposing secret values in errors', async () => {
    const calls: string[][] = [];
    const exec: KeychainExec = (_file, args, callback) => {
      calls.push(args);
      if (args[0] === 'find-generic-password') callback(null, 'secret-token\n', '');
      else callback(null, '', '');
    };
    const keychain = new CustomConnectorKeychain(exec);
    await keychain.setSecret('id1', 'secret-token');
    await expect(keychain.getSecret('id1')).resolves.toBe('secret-token');
    await keychain.deleteSecret('id1');
    expect(calls[0]).toContain('add-generic-password');
    expect(calls[0]).toContain('-U');
    expect(calls.flat()).toContain('com.verso.custom-connectors');
  });

  it('probes JSON, oauth, Streamable HTTP event-stream, legacy SSE, and junk responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/favicon.ico')) return new Response('', { status: 404 });
      if (url.endsWith('/oauth')) return new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="mcp"' } });
      if (url.endsWith('/streamable')) {
        return new Response('data: {"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"SSE"}}}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      if (url.endsWith('/legacy-sse') && init?.method === 'POST') return new Response('', { status: 405 });
      if (url.endsWith('/legacy-sse') && init?.method === 'GET') {
        return new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (url.endsWith('/junk')) return new Response('nope', { status: 200, headers: { 'Content-Type': 'text/plain' } });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'Fixture' } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    await expect(probeMcpServer('https://example.com/ok', { iconDir: tempRoot })).resolves.toMatchObject({ auth: 'none', transport: 'http', serverName: 'Fixture' });
    await expect(probeMcpServer('https://example.com/oauth', { iconDir: tempRoot })).resolves.toMatchObject({ auth: 'oauth' });
    await expect(probeMcpServer('https://example.com/streamable', { iconDir: tempRoot })).resolves.toMatchObject({ transport: 'http', serverName: 'SSE' });
    await expect(probeMcpServer('https://example.com/legacy-sse', { iconDir: tempRoot })).resolves.toMatchObject({ transport: 'sse' });
    await expect(probeMcpServer('https://example.com/junk', { iconDir: tempRoot })).rejects.toThrow(/valid MCP/);
  });

  it('sends bearer tokens during probe and reports missing auth clearly', async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      const url = String(input);
      if (url.endsWith('/favicon.ico')) return new Response('', { status: 404 });
      if (url.endsWith('/protected')) {
        if ((init?.headers as Record<string, string> | undefined)?.Authorization === 'Bearer valid-token') {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'Protected' } } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('', { status: 401 });
      }
      return new Response('', { status: 404 });
    }));

    await expect(probeMcpServer('https://example.com/protected', { token: 'valid-token', iconDir: tempRoot })).resolves.toMatchObject({ auth: 'bearer' });
    expect(calls[0].headers).toMatchObject({ Authorization: 'Bearer valid-token' });
    await expect(probeMcpServer('https://example.com/protected', { iconDir: tempRoot })).rejects.toThrow(/requires authentication/);
    await expect(probeMcpServer('https://example.com/protected', { token: 'wrong-token', iconDir: tempRoot })).rejects.toThrow(/rejected the API token/);
  });

  it('falls back to HTML-declared icons on parent domains', async () => {
    const fetched: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      fetched.push(url);
      if (url === 'https://mcp.example.com/mcp' && init?.method === 'POST') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'Fixture' } } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === 'https://example.com/') {
        return new Response('<html><head><link rel="apple-touch-icon" sizes="180x180" href="/brand.png"></head></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      if (url === 'https://example.com/brand.png') {
        return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      return new Response('', { status: 404 });
    }));

    const result = await probeMcpServer('https://mcp.example.com/mcp', { iconDir: tempRoot });
    expect(result.iconPath).toMatch(/\.png$/);
    expect(result.iconContentType).toBe('image/png');
    expect(fetched).toContain('https://example.com/brand.png');
  });

  it('never sends the bearer token to cross-origin icon hosts', async () => {
    const iconRequests: Array<{ url: string; auth: string | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/mcp')) {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { serverInfo: { name: 'Fixture', icons: [{ src: 'https://cdn.example.net/logo.png', sizes: '64x64' }] } },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      iconRequests.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
      return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'Content-Type': 'image/png' } });
    }));

    await probeMcpServer('https://example.com/mcp', { token: 'secret-token', iconDir: tempRoot });
    expect(iconRequests.length).toBeGreaterThan(0);
    for (const request of iconRequests) {
      expect(request.auth).toBeUndefined();
    }
  });

  it('polls custom connector tools until registration appears', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['mcp__custom_linear__create_issue']);
    const delays: number[] = [];
    await expect(waitForCustomConnectorTools(
      { slug: 'linear', auth: 'bearer' },
      fetcher,
      { attempts: 3, delayMs: 7, delayFn: async (ms) => { delays.push(ms); } },
    )).resolves.toEqual(['mcp__custom_linear__create_issue']);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([7]);
  });

  it('writes custom MCP config entries and reconciles stale custom keys', () => {
    const templateHome = tempRoot;
    const managedHome = path.join(tempRoot, 'profiles', 'verso');
    seedHermesTemplate(templateHome);
    mkdirSync(managedHome, { recursive: true });
    writeFileSync(path.join(managedHome, 'config.yaml'), [
      'mcp_servers:',
      '  custom_old:',
      '    url: https://old.example/mcp',
      '  other:',
      '    url: https://user.example/mcp',
    ].join('\n'), 'utf8');
    const store = new CustomConnectorsStore(path.join(tempRoot, 'store.json'));
    const connector = store.create({
      name: 'Example',
      slug: 'example',
      url: 'https://example.com/mcp',
      transport: 'sse',
      auth: 'bearer',
      logoUrl: null,
    });
    const supervisor = new HermesSupervisor({
      runtimeMode: 'managed',
      customConnectorsStore: store,
      launch: { command: '/bin/true', args: [], cwd: null, startupTimeoutMs: 1 },
    });
    (supervisor as unknown as { ensureManagedHermesHome: () => void }).ensureManagedHermesHome();

    const parsed = YAML.parse(readFileSync(path.join(managedHome, 'config.yaml'), 'utf8')) as { mcp_servers?: Record<string, any> };
    expect(parsed.mcp_servers?.custom_old).toBeUndefined();
    expect(parsed.mcp_servers?.other).toEqual({ url: 'https://user.example/mcp' });
    expect(parsed.mcp_servers?.custom_example).toEqual({
      url: 'https://example.com/mcp',
      transport: 'sse',
      headers: { Authorization: `Bearer \${VERSO_CC_${connector.id}_TOKEN}` },
      timeout: 120,
      connect_timeout: 30,
    });
  });

  it('counts both custom tool name prefixes and removes Hermes OAuth residue', () => {
    expect(countCustomConnectorTools([
      'mcp__custom_linear__create_issue',
      'mcp_custom_linear_search',
      'mcp__custom_other__x',
    ], 'linear')).toBe(2);

    const tokenDir = path.join(tempRoot, 'mcp-tokens');
    mkdirSync(tokenDir, { recursive: true });
    for (const suffix of ['.json', '.client.json', '.meta.json']) {
      writeFileSync(path.join(tokenDir, `custom_linear${suffix}`), '{}', 'utf8');
    }
    removeHermesOAuthFiles(tempRoot, 'custom_linear');
    expect(existsSync(path.join(tokenDir, 'custom_linear.json'))).toBe(false);
    expect(existsSync(path.join(tokenDir, 'custom_linear.client.json'))).toBe(false);
    expect(existsSync(path.join(tokenDir, 'custom_linear.meta.json'))).toBe(false);
  });

  it('openAuth starts a gateway OAuth flow and redirects to its authorization URL', async () => {
    const store = new CustomConnectorsStore(path.join(tempRoot, 'store.json'));
    const keychain = fakeKeychain();
    const hermes = fakeHermes(tempRoot);
    const connector = store.create({
      name: 'Holded',
      slug: 'holded',
      url: 'https://mcp.holded.com/mcp',
      transport: 'http',
      auth: 'oauth',
      logoUrl: null,
    });
    const authUrl = 'https://app.holded.com/oauth/authorize?response_type=code&state=abc';
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/mcp/servers/custom_holded/auth') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          flow_id: 'flow-1',
          server_name: 'custom_holded',
          status: 'authorization_required',
          authorization_url: authUrl,
          error: null,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/api/mcp/oauth/flows/flow-1')) {
        return new Response(JSON.stringify({ status: 'approved', error: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/api/mcp/tools')) return toolsetsResponse(['mcp__custom_holded__list_invoices']);
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new CustomConnectorService(store, keychain.instance, hermes, {
      registrationAttempts: 1, registrationDelayMs: 0, authPollDelayMs: 0, authPollAttempts: 3,
    });
    const res = fakeResponse();

    await service.openAuth(connector.id, res as any);

    expect(res.status).toBe(302);
    expect(res.headers.Location).toBe(authUrl);
    const startCall = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/auth') && (init as RequestInit)?.method === 'POST');
    expect(startCall).toBeDefined();
  });

  it('openAuth surfaces gateway flow errors as a failed connector status', async () => {
    const store = new CustomConnectorsStore(path.join(tempRoot, 'store.json'));
    const keychain = fakeKeychain();
    const hermes = fakeHermes(tempRoot);
    const connector = store.create({
      name: 'Holded',
      slug: 'holded',
      url: 'https://mcp.holded.com/mcp',
      transport: 'http',
      auth: 'oauth',
      logoUrl: null,
    });
    let flowPolls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/mcp/servers/custom_holded/auth') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          flow_id: 'flow-2',
          status: 'authorization_required',
          authorization_url: 'https://app.holded.com/oauth/authorize?state=xyz',
          error: null,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/api/mcp/oauth/flows/flow-2')) {
        flowPolls += 1;
        return new Response(JSON.stringify({
          status: 'error',
          error: "'custom_holded' only allows pre-approved OAuth clients",
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/api/mcp/tools')) return toolsetsResponse([]);
      return new Response('', { status: 404 });
    }));
    const service = new CustomConnectorService(store, keychain.instance, hermes, {
      registrationAttempts: 1, registrationDelayMs: 0, authPollDelayMs: 0, authPollAttempts: 3,
    });
    const res = fakeResponse();

    await service.openAuth(connector.id, res as any);
    await vi.waitFor(() => expect(flowPolls).toBeGreaterThan(0));

    const [view] = await service.list();
    expect(view.id).toBe(connector.id);
    expect(view.status).toEqual({
      state: 'failed',
      toolCount: 0,
      reason: "'custom_holded' only allows pre-approved OAuth clients",
    });
    expect(hermes.restart).not.toHaveBeenCalled();
  });

  it('marks an expired gateway OAuth flow as failed instead of leaving it pending forever', async () => {
    const store = new CustomConnectorsStore(path.join(tempRoot, 'store.json'));
    const keychain = fakeKeychain();
    const hermes = fakeHermes(tempRoot);
    const connector = store.create({
      name: 'Holded',
      slug: 'holded',
      url: 'https://mcp.holded.com/mcp',
      transport: 'http',
      auth: 'oauth',
      logoUrl: null,
    });
    let flowPolls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/mcp/servers/custom_holded/auth') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          flow_id: 'expired-flow',
          status: 'authorization_required',
          authorization_url: 'https://app.holded.com/oauth/authorize?state=expired',
          error: null,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/api/mcp/oauth/flows/expired-flow')) {
        flowPolls += 1;
        return new Response('', { status: 404 });
      }
      if (url.endsWith('/api/mcp/tools')) return toolsetsResponse([]);
      return new Response('', { status: 404 });
    }));
    const service = new CustomConnectorService(store, keychain.instance, hermes, {
      authPollDelayMs: 0,
      authPollAttempts: 1,
    });

    await service.openAuth(connector.id, fakeResponse() as any);
    await vi.waitFor(() => expect(flowPolls).toBe(1));

    const [view] = await service.list();
    expect(view.status).toEqual({
      state: 'failed',
      toolCount: 0,
      reason: 'The sign-in session expired. Start the sign-in again.',
    });
  });

  it('marks an approved OAuth flow as failed when Hermes still registers no tools', async () => {
    const store = new CustomConnectorsStore(path.join(tempRoot, 'store.json'));
    const keychain = fakeKeychain();
    const hermes = fakeHermes(tempRoot);
    const connector = store.create({
      name: 'Holded',
      slug: 'holded',
      url: 'https://mcp.holded.com/mcp',
      transport: 'http',
      auth: 'oauth',
      logoUrl: null,
    });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/mcp/servers/custom_holded/auth') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          flow_id: 'approved-without-tools',
          status: 'authorization_required',
          authorization_url: 'https://app.holded.com/oauth/authorize?state=approved',
          error: null,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/api/mcp/oauth/flows/approved-without-tools')) {
        return new Response(JSON.stringify({ status: 'approved', error: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/api/mcp/tools')) return toolsetsResponse([]);
      return new Response('', { status: 404 });
    }));
    const service = new CustomConnectorService(store, keychain.instance, hermes, {
      registrationAttempts: 1,
      registrationDelayMs: 0,
      authPollDelayMs: 0,
      authPollAttempts: 1,
    });

    await service.openAuth(connector.id, fakeResponse() as any);
    await vi.waitFor(() => expect(hermes.restart).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => {
      const [view] = await service.list();
      expect(view.status).toEqual({
        state: 'failed',
        toolCount: 0,
        reason: 'Sign-in completed, but the connector could not be activated: The connector signed in, but Hermes registered no tools for it.',
      });
    });
  });

  it('hydrates an existing OAuth connection from persisted credentials while tools warm up', async () => {
    const store = new CustomConnectorsStore(path.join(tempRoot, 'store.json'));
    const keychain = fakeKeychain();
    const hermes = fakeHermes(tempRoot);
    const connector = store.create({
      name: 'Holded',
      slug: 'holded',
      url: 'https://mcp.holded.com/mcp',
      transport: 'http',
      auth: 'oauth',
      logoUrl: null,
      lastKnownToolCount: 47,
    });
    mkdirSync(path.join(tempRoot, 'mcp-tokens'), { recursive: true });
    writeFileSync(path.join(tempRoot, 'mcp-tokens', 'custom_holded.json'), '{"access_token":"cached"}', 'utf8');
    vi.stubGlobal('fetch', vi.fn(async () => toolsetsResponse([])));
    const service = new CustomConnectorService(store, keychain.instance, hermes);

    const [view] = await service.list();

    expect(view.id).toBe(connector.id);
    expect(view.status).toEqual({ state: 'connected', toolCount: 47, cached: true });

    writeFileSync(path.join(tempRoot, 'mcp-tokens', 'custom_holded.json'), JSON.stringify({
      access_token: 'expired',
      expires_at: 1,
    }), 'utf8');
    const [expiredView] = await service.list();
    expect(expiredView.status).toEqual({ state: 'pending_auth', toolCount: 0 });
  });

  it('persists the last verified tool count for immediate status on the next launch', async () => {
    const storePath = path.join(tempRoot, 'store.json');
    const store = new CustomConnectorsStore(storePath);
    const keychain = fakeKeychain();
    const hermes = fakeHermes(tempRoot);
    const connector = store.create({
      name: 'Holded',
      slug: 'holded',
      url: 'https://mcp.holded.com/mcp',
      transport: 'http',
      auth: 'oauth',
      logoUrl: null,
    });
    const tools = Array.from({ length: 47 }, (_, index) => `mcp__custom_holded__tool_${index}`);
    vi.stubGlobal('fetch', vi.fn(async () => toolsetsResponse(tools)));
    const service = new CustomConnectorService(store, keychain.instance, hermes);

    const [view] = await service.list();
    const persisted = new CustomConnectorsStore(storePath).get(connector.id);

    expect(view.status).toEqual({ state: 'connected', toolCount: 47 });
    expect(persisted?.lastKnownToolCount).toBe(47);
  });

  it('retry on an oauth connector skips the gateway restart and reports pending sign-in', async () => {
    const store = new CustomConnectorsStore(path.join(tempRoot, 'store.json'));
    const keychain = fakeKeychain();
    const hermes = fakeHermes(tempRoot);
    const connector = store.create({
      name: 'Holded',
      slug: 'holded',
      url: 'https://mcp.holded.com/mcp',
      transport: 'http',
      auth: 'oauth',
      logoUrl: null,
    });
    mkdirSync(path.join(tempRoot, 'mcp-tokens'), { recursive: true });
    writeFileSync(path.join(tempRoot, 'mcp-tokens', 'custom_holded.json'), '{"access_token":"cached"}', 'utf8');
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/favicon.ico')) return new Response('', { status: 404 });
      if (url.endsWith('/api/mcp/tools')) return toolsetsResponse([]);
      return new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="mcp"' } });
    }));
    const service = new CustomConnectorService(store, keychain.instance, hermes, { registrationAttempts: 1, registrationDelayMs: 0 });

    const view = await service.retry(connector.id);

    expect(view.status).toEqual({ state: 'pending_auth', toolCount: 0 });
    expect(hermes.restart).not.toHaveBeenCalled();
  });

  it('retry failures surface as the connector row reason', async () => {
    const store = new CustomConnectorsStore(path.join(tempRoot, 'store.json'));
    const keychain = fakeKeychain();
    const hermes = fakeHermes(tempRoot);
    const connector = store.create({
      name: 'Holded',
      slug: 'holded',
      url: 'https://mcp.holded.com/mcp',
      transport: 'http',
      auth: 'oauth',
      logoUrl: null,
    });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/api/mcp/tools')) return toolsetsResponse([]);
      throw new Error('network down');
    }));
    const service = new CustomConnectorService(store, keychain.instance, hermes, { registrationAttempts: 1, registrationDelayMs: 0 });

    await expect(service.retry(connector.id)).rejects.toThrow();
    const [view] = await service.list();
    expect(view.status.state).toBe('failed');
    expect((view.status as { reason?: string }).reason).toBeTruthy();
  });

  it('service add stores bearer secrets and returns the registered tool count', async () => {
    const store = new CustomConnectorsStore(path.join(tempRoot, 'store.json'));
    const keychain = fakeKeychain();
    const hermes = fakeHermes(tempRoot);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/favicon.ico') || url === 'https://linear.example/') {
        return new Response('', { status: 404 });
      }
      if (url.endsWith('/api/mcp/tools')) {
        return toolsetsResponse(['mcp__custom_linear__search']);
      }
      return initializeResponse('Linear');
    }));
    const service = new CustomConnectorService(store, keychain.instance, hermes, {
      registrationAttempts: 1,
      registrationDelayMs: 0,
    });

    const view = await service.add({
      name: 'Linear',
      url: 'https://linear.example/mcp',
      token: 'secret-token',
    });

    expect(keychain.setSecret).toHaveBeenCalledWith(view.id, 'secret-token');
    expect(hermes.restart).toHaveBeenCalledTimes(1);
    expect(view.status).toEqual({ state: 'connected', toolCount: 1 });
    expect(readFileSync(store.path, 'utf8')).not.toContain('secret-token');
  });

  it('service add keeps a new OAuth connector pending until browser sign-in', async () => {
    const store = new CustomConnectorsStore(path.join(tempRoot, 'store.json'));
    const keychain = fakeKeychain();
    const hermes = fakeHermes(tempRoot);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/favicon.ico') || url === 'https://holded.example/') {
        return new Response('', { status: 404 });
      }
      if (url.endsWith('/api/mcp/tools')) return toolsetsResponse([]);
      return new Response('', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer realm="mcp"' },
      });
    }));
    const service = new CustomConnectorService(store, keychain.instance, hermes, {
      registrationAttempts: 1,
      registrationDelayMs: 0,
    });

    const view = await service.add({ name: 'Holded', url: 'https://holded.example/mcp' });

    expect(view.status).toEqual({ state: 'pending_auth', toolCount: 0 });
    expect(keychain.setSecret).not.toHaveBeenCalled();
    expect(hermes.restart).toHaveBeenCalledTimes(1);
  });

  it('service add rolls back store and keychain when restart fails', async () => {
    const store = new CustomConnectorsStore(path.join(tempRoot, 'store.json'));
    const keychain = fakeKeychain();
    const hermes = fakeHermes(tempRoot);
    hermes.restart.mockRejectedValueOnce(new Error('restart failed'));
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => String(input).endsWith('/favicon.ico')
      ? new Response('', { status: 404 })
      : initializeResponse('Broken')));
    const service = new CustomConnectorService(store, keychain.instance, hermes, { registrationAttempts: 1, registrationDelayMs: 0 });

    await expect(service.add({ name: 'Broken', url: 'https://broken.example/mcp', token: 'secret-token' })).rejects.toThrow(/restart failed/);
    expect(store.list()).toEqual([]);
    expect(keychain.deleteSecret).toHaveBeenCalledTimes(1);
  });

  it('service remove deletes keychain secret, oauth residue, and skips unknown restarts', async () => {
    const store = new CustomConnectorsStore(path.join(tempRoot, 'store.json'));
    const keychain = fakeKeychain();
    const hermes = fakeHermes(tempRoot);
    const connector = store.create({
      name: 'Linear',
      slug: 'linear',
      url: 'https://linear.example/mcp',
      transport: 'http',
      auth: 'oauth',
      logoUrl: null,
    });
    mkdirSync(path.join(tempRoot, 'mcp-tokens'), { recursive: true });
    writeFileSync(path.join(tempRoot, 'mcp-tokens', 'custom_linear.json'), '{}', 'utf8');
    const service = new CustomConnectorService(store, keychain.instance, hermes, { registrationAttempts: 1, registrationDelayMs: 0 });

    await service.remove(connector.id);
    await service.remove('missing');

    expect(keychain.deleteSecret).toHaveBeenCalledWith(connector.id);
    expect(existsSync(path.join(tempRoot, 'mcp-tokens', 'custom_linear.json'))).toBe(false);
    expect(hermes.restart).toHaveBeenCalledTimes(1);
  });
});

function initializeResponse(name: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name } } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function toolsetsResponse(tools: string[]): Response {
  return new Response(JSON.stringify({ servers: { custom_holded: tools } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fakeKeychain() {
  const setSecret = vi.fn(async () => {});
  const getSecret = vi.fn(async () => 'secret-token');
  const deleteSecret = vi.fn(async () => {});
  return {
    setSecret,
    getSecret,
    deleteSecret,
    instance: { setSecret, getSecret, deleteSecret } as unknown as CustomConnectorKeychain,
  };
}

function fakeHermes(hermesHome: string) {
  return {
    hermesHome,
    gatewayConfig: { baseUrl: 'http://127.0.0.1:65535', apiKey: null },
    launchCwd: null,
    invoke: vi.fn(() => null),
    restart: vi.fn(async () => {}),
  } as unknown as HermesSupervisor & { restart: ReturnType<typeof vi.fn> };
}

function fakeResponse() {
  return {
    status: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(status: number, headers: Record<string, string> = {}) {
      this.status = status;
      this.headers = headers;
      return this;
    },
    end(chunk?: string) {
      if (chunk) this.body += chunk;
    },
  };
}

function seedHermesTemplate(home: string): void {
  writeFileSync(path.join(home, 'config.yaml'), 'model:\n  provider: openai-codex\n', 'utf8');
  writeFileSync(path.join(home, '.env'), '', 'utf8');
  writeFileSync(path.join(home, 'auth.json'), '{}', 'utf8');
  writeFileSync(path.join(home, 'SOUL.md'), '', 'utf8');
  mkdirSync(path.join(home, 'memories'), { recursive: true });
  writeFileSync(path.join(home, 'memories', 'MEMORY.md'), '', 'utf8');
  writeFileSync(path.join(home, 'memories', 'USER.md'), '', 'utf8');
  process.env.HERMES_HOME = home;
  process.env.VERSO_HERMES_COMMAND = '/bin/true';
}
