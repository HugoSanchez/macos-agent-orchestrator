import { afterEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.ts';
import { getConfig } from '../src/config.ts';
import { AuthService } from '../src/auth/service.ts';
import { MemoryAuthStore } from '../src/auth/memory-store.ts';
import {
  ComposioService,
  ComposioServiceError,
  type BridgeSearchToolResult,
  type BridgeToolExecutionView,
  type BridgeToolSchemaView,
  type DisconnectConnectionResult,
  type ProviderRevocationStatus,
} from '../src/composio/service.ts';
import type { PrivyAuthVerifier, VerifiedPrivyAuthToken } from '../src/auth/types.ts';

class StubVerifier implements PrivyAuthVerifier {
  async verifyAuthToken(_t: string): Promise<VerifiedPrivyAuthToken> {
    return {
      userId: 'did:privy:composio-test',
      sessionId: 'p-s',
      appId: 'p-a',
      issuer: 'privy.io',
      issuedAt: 1_700_000_000,
      expiration: 1_700_003_600,
    };
  }
}

/**
 * Test double for ComposioService. Captures the userId each method receives so
 * we can assert routes pass the *authenticated* user's id, not whatever the
 * client sent in the body.
 */
class StubComposioService extends ComposioService {
  capturedUserId: string | null = null;
  capturedDeletedConnectionId: string | null = null;
  capturedRequestId: string | null = null;
  capturedCallbackUrl: string | null = null;
  requestOwnerUserId = 'did:privy:composio-test';
  disconnectRevocation: ProviderRevocationStatus = 'revoked';
  constructor() { super('test-key'); }

  override get configured(): boolean { return true; }

  override async listConnections(userId: string) {
    this.capturedUserId = userId;
    return [
      {
        connectedAccountId: 'ca_1',
        toolkitSlug: 'gmail',
        toolkitName: 'Gmail',
        logoUrl: null,
        status: 'active' as const,
      },
    ];
  }

  override async listToolkits(userId: string, _opts?: { query?: string; limit?: number }) {
    this.capturedUserId = userId;
    return [
      {
        slug: 'gmail',
        name: 'Gmail',
        description: null,
        logoUrl: null,
        categories: [],
        authSchemes: [],
        composioManagedAuthSchemes: [],
        connected: false,
        connectedAccountId: null,
        noAuth: false,
      },
    ];
  }

  override async deleteConnection(userId: string, connectedAccountId: string): Promise<DisconnectConnectionResult> {
    this.capturedUserId = userId;
    this.capturedDeletedConnectionId = connectedAccountId;
    return {
      connectedAccountId,
      composioAccountDeleted: true,
      providerRevocation: this.disconnectRevocation,
    };
  }

  override async getRequest(userId: string, requestId: string) {
    this.capturedUserId = userId;
    this.capturedRequestId = requestId;
    if (userId !== this.requestOwnerUserId) {
      throw new ComposioServiceError(404, `Connection request "${requestId}" not found.`);
    }
    return {
      id: requestId,
      toolkitSlug: 'gmail',
      toolkitName: 'Gmail',
      logoUrl: null,
      status: 'pending' as const,
      redirectUrl: null,
      connectedAccountId: null,
      errorMessage: null,
    };
  }

  override async searchTools(userId: string, query: string, _toolkits?: string[]): Promise<BridgeSearchToolResult[]> {
    this.capturedUserId = userId;
    return [
      {
        slug: query || 'SLACK_SEARCH_MESSAGES',
        name: 'Search messages',
        description: null,
        toolkitSlug: 'slack',
        toolkitName: 'Slack',
      },
    ];
  }

  override async listTools(userId: string, toolkits: string[]): Promise<BridgeSearchToolResult[]> {
    this.capturedUserId = userId;
    return toolkits.map((toolkit) => ({
      slug: `${toolkit.toUpperCase()}_SEARCH`,
      name: `${toolkit} search`,
      description: null,
      toolkitSlug: toolkit,
      toolkitName: toolkit,
    }));
  }

  override async getToolSchemas(userId: string, toolSlugs: string[]): Promise<BridgeToolSchemaView[]> {
    this.capturedUserId = userId;
    return toolSlugs.map((slug) => ({
      slug,
      name: 'Search messages',
      description: null,
      toolkitSlug: 'slack',
      toolkitName: 'Slack',
      inputParameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
    }));
  }

  override async executeTool(
    userId: string,
    toolSlug: string,
    arguments_: Record<string, unknown> | undefined,
  ): Promise<BridgeToolExecutionView> {
    this.capturedUserId = userId;
    return {
      data: { toolSlug, arguments: arguments_ ?? {} },
      error: null,
      logId: 'log_1',
    };
  }
}

const baseEnv: Record<string, string> = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '8788',
  PRIVY_APP_ID: 'app',
  PRIVY_APP_SECRET: 'secret',
  COMPOSIO_API_KEY: 'composio',
};

interface Setup {
  app: Awaited<ReturnType<typeof buildServer>>;
  sessionToken: string;
  userId: string;
  composio: StubComposioService;
}

async function setup(): Promise<Setup> {
  const config = getConfig(baseEnv);
  const authStore = new MemoryAuthStore();
  const authService = new AuthService(config, authStore, new StubVerifier());
  const composio = new StubComposioService();
  const app = await buildServer({ config, authService, authStore, composioService: composio });
  const exchange = await authService.exchangePrivyAuth({
    privyAccessToken: 'privy',
    deviceLabel: 'Hugo',
    platform: 'macos',
  });
  return { app, sessionToken: exchange.sessionToken, userId: exchange.user.id, composio };
}

describe('Composio routes', () => {
  let s: Setup | null = null;
  afterEach(async () => { if (s) { await s.app.close(); s = null; } });

  test('rejects unauthenticated requests with 401', async () => {
    s = await setup();
    const res = await s.app.inject({ method: 'GET', url: '/v1/composio/connections' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('missing_session');
  });

  test('GET /v1/composio/connections returns the live list', async () => {
    s = await setup();
    const res = await s.app.inject({
      method: 'GET',
      url: '/v1/composio/connections',
      headers: { authorization: `Bearer ${s.sessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0].toolkitSlug).toBe('gmail');
    expect(s.composio.capturedUserId).toBe(s.userId);
  });

  test('DELETE /v1/composio/connections/:id uses authenticated user and returns the disconnect result', async () => {
    s = await setup();
    const res = await s.app.inject({
      method: 'DELETE',
      url: '/v1/composio/connections/ca_1',
      headers: { authorization: `Bearer ${s.sessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      disconnect: {
        connectedAccountId: 'ca_1',
        composioAccountDeleted: true,
        providerRevocation: 'revoked',
      },
    });
    expect(s.composio.capturedUserId).toBe(s.userId);
    expect(s.composio.capturedDeletedConnectionId).toBe('ca_1');
  });

  test('DELETE /v1/composio/connections/:id surfaces the manual-action result unchanged', async () => {
    s = await setup();
    s.composio.disconnectRevocation = 'manual_action_required';
    const res = await s.app.inject({
      method: 'DELETE',
      url: '/v1/composio/connections/ca_1',
      headers: { authorization: `Bearer ${s.sessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().disconnect.providerRevocation).toBe('manual_action_required');
    expect(res.json().disconnect.composioAccountDeleted).toBe(true);
  });

  test('DELETE /v1/composio/connections/:id maps a retryable revoke failure without upstream details', async () => {
    s = await setup();
    s.composio.deleteConnection = async () => {
      throw new ComposioServiceError(502, 'Could not revoke the provider connection. Try again.');
    };
    const res = await s.app.inject({
      method: 'DELETE',
      url: '/v1/composio/connections/ca_1',
      headers: { authorization: `Bearer ${s.sessionToken}` },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: 'composio_error',
      message: 'Could not revoke the provider connection. Try again.',
    });
  });

  test('GET /v1/composio/toolkits passes query+limit params through', async () => {
    s = await setup();
    const composio = s.composio;
    let receivedOpts: { query?: string; limit?: number } | undefined;
    composio.listToolkits = async (userId, opts) => {
      receivedOpts = opts;
      composio.capturedUserId = userId;
      return [];
    };
    const res = await s.app.inject({
      method: 'GET',
      url: '/v1/composio/toolkits?query=gmail&limit=12',
      headers: { authorization: `Bearer ${s.sessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(receivedOpts?.query).toBe('gmail');
    expect(receivedOpts?.limit).toBe(12);
  });

  test('POST /v1/composio/connections/request ignores caller-supplied userId and uses authenticated user', async () => {
    s = await setup();
    const composio = s.composio;
    let capturedToolkit: string | null = null;
    composio.requestConnection = async (userId, toolkit, _callbackUrl) => {
      composio.capturedUserId = userId;
      capturedToolkit = toolkit;
      return {
        id: 'req_x',
        toolkitSlug: toolkit,
        toolkitName: 'Gmail',
        logoUrl: null,
        status: 'pending' as const,
        redirectUrl: 'https://composio.example/auth',
        connectedAccountId: null,
        errorMessage: null,
      };
    };
    const res = await s.app.inject({
      method: 'POST',
      url: '/v1/composio/connections/request',
      headers: { authorization: `Bearer ${s.sessionToken}` },
      payload: {
        userId: 'usr_attacker_attempting_to_act_as_someone_else',
        toolkit: 'gmail',
        callbackUrl: 'http://127.0.0.1:4123/connections/callback',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(capturedToolkit).toBe('gmail');
    expect(composio.capturedUserId).toBe(s.userId);
  });

  test('GET connection request passes the authenticated user and returns their request', async () => {
    s = await setup();
    s.composio.requestOwnerUserId = s.userId;
    const res = await s.app.inject({
      method: 'GET',
      url: '/v1/composio/connections/requests/req_owned',
      headers: { authorization: `Bearer ${s.sessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().request.id).toBe('req_owned');
    expect(s.composio.capturedUserId).toBe(s.userId);
    expect(s.composio.capturedRequestId).toBe('req_owned');
  });

  test('GET connection request returns non-enumerating 404 for another user request', async () => {
    s = await setup();
    s.composio.requestOwnerUserId = 'did:privy:another-user';
    const res = await s.app.inject({
      method: 'GET',
      url: '/v1/composio/connections/requests/req_foreign',
      headers: { authorization: `Bearer ${s.sessionToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: 'composio_error',
      message: 'Connection request "req_foreign" not found.',
    });
    expect(s.composio.capturedUserId).toBe(s.userId);
  });

  test('POST /v1/composio/connections/request validates callbackUrl at the backend boundary', async () => {
    s = await setup();
    const invalidUrls = [
      'https://127.0.0.1:4123/connections/callback',
      'http://localhost:4123/connections/callback',
      'http://localtest.me:4123/connections/callback',
      'http://127.0.0.1.evil.example:4123/connections/callback',
      'http://2130706433:4123/connections/callback',
      'http://127.0.0.1/connections/callback',
      'http://127.0.0.1:0/connections/callback',
      'http://127.0.0.1:70000/connections/callback',
      'http://127.0.0.1:4123/connections/callback/extra',
      'http://127.0.0.1:4123/other',
      'http://127.0.0.1:4123/connections/callback?next=https://evil.example',
      'http://127.0.0.1:4123/connections/callback#token',
      'http://user:pass@127.0.0.1:4123/connections/callback',
    ];

    for (const callbackUrl of invalidUrls) {
      const res = await s.app.inject({
        method: 'POST',
        url: '/v1/composio/connections/request',
        headers: { authorization: `Bearer ${s.sessionToken}` },
        payload: { toolkit: 'gmail', callbackUrl },
      });
      expect(res.statusCode, callbackUrl).toBe(400);
      expect(res.json().message).toBe('Invalid callbackUrl.');
    }
  });

  test('POST /v1/composio/connections/request accepts the exact loopback callback URL', async () => {
    s = await setup();
    const composio = s.composio;
    composio.requestConnection = async (userId, toolkit, callbackUrl) => {
      composio.capturedUserId = userId;
      composio.capturedCallbackUrl = callbackUrl;
      return {
        id: 'req_x',
        toolkitSlug: toolkit,
        toolkitName: 'Gmail',
        logoUrl: null,
        status: 'pending' as const,
        redirectUrl: 'https://composio.example/auth',
        connectedAccountId: null,
        errorMessage: null,
      };
    };

    const res = await s.app.inject({
      method: 'POST',
      url: '/v1/composio/connections/request',
      headers: { authorization: `Bearer ${s.sessionToken}` },
      payload: { toolkit: 'gmail', callbackUrl: 'http://127.0.0.1:4123/connections/callback' },
    });

    expect(res.statusCode).toBe(201);
    expect(composio.capturedCallbackUrl).toBe('http://127.0.0.1:4123/connections/callback');
  });

  test('POST /v1/composio/connections/request rejects missing toolkit as 400', async () => {
    s = await setup();
    const res = await s.app.inject({
      method: 'POST',
      url: '/v1/composio/connections/request',
      headers: { authorization: `Bearer ${s.sessionToken}` },
      payload: { callbackUrl: 'http://127.0.0.1:4123/connections/callback' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('composio_error');
  });

  test('POST /v1/composio/tools/search uses authenticated user', async () => {
    s = await setup();
    const composio = s.composio;
    let receivedQuery: string | undefined;
    let receivedToolkits: string[] | undefined;
    composio.searchTools = async (userId, query, toolkits) => {
      composio.capturedUserId = userId;
      receivedQuery = query;
      receivedToolkits = toolkits;
      return [
        {
          slug: 'SLACK_SEARCH_MESSAGES',
          name: 'Search messages',
          description: null,
          toolkitSlug: 'slack',
          toolkitName: 'Slack',
        },
      ];
    };
    const res = await s.app.inject({
      method: 'POST',
      url: '/v1/composio/tools/search',
      headers: { authorization: `Bearer ${s.sessionToken}` },
      payload: {
        userId: 'usr_attacker_attempting_to_act_as_someone_else',
        query: 'search Slack',
        toolkits: ['slack'],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(receivedQuery).toBe('search Slack');
    expect(receivedToolkits).toEqual(['slack']);
    expect(s.composio.capturedUserId).toBe(s.userId);
    expect(res.json().results[0].slug).toBe('SLACK_SEARCH_MESSAGES');
  });

  test('POST /v1/composio/tools/list uses authenticated user and forwards toolkits', async () => {
    s = await setup();
    const composio = s.composio;
    let receivedToolkits: string[] | undefined;
    composio.listTools = async (userId, toolkits) => {
      composio.capturedUserId = userId;
      receivedToolkits = toolkits;
      return [
        {
          slug: 'GMAIL_SEND_EMAIL',
          name: 'Send email',
          description: null,
          toolkitSlug: 'gmail',
          toolkitName: 'Gmail',
        },
      ];
    };
    const res = await s.app.inject({
      method: 'POST',
      url: '/v1/composio/tools/list',
      headers: { authorization: `Bearer ${s.sessionToken}` },
      payload: {
        userId: 'usr_attacker_attempting_to_act_as_someone_else',
        toolkits: ['gmail'],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(receivedToolkits).toEqual(['gmail']);
    expect(s.composio.capturedUserId).toBe(s.userId);
    expect(res.json().tools[0].slug).toBe('GMAIL_SEND_EMAIL');
  });

  test('POST /v1/composio/tools/schemas forwards tool slugs', async () => {
    s = await setup();
    const composio = s.composio;
    let receivedToolSlugs: string[] | undefined;
    composio.getToolSchemas = async (userId, toolSlugs) => {
      composio.capturedUserId = userId;
      receivedToolSlugs = toolSlugs;
      return [
        {
          slug: toolSlugs[0],
          name: 'Search messages',
          description: null,
          toolkitSlug: 'slack',
          toolkitName: 'Slack',
          inputParameters: { type: 'object' },
        },
      ];
    };
    const res = await s.app.inject({
      method: 'POST',
      url: '/v1/composio/tools/schemas',
      headers: { authorization: `Bearer ${s.sessionToken}` },
      payload: {
        toolSlugs: ['SLACK_SEARCH_MESSAGES'],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(s.composio.capturedUserId).toBe(s.userId);
    expect(receivedToolSlugs).toEqual(['SLACK_SEARCH_MESSAGES']);
    expect(res.json().tools[0].slug).toBe('SLACK_SEARCH_MESSAGES');
  });

  test('POST /v1/composio/tools/execute forwards tool slug and arguments', async () => {
    s = await setup();
    const composio = s.composio;
    let receivedToolSlug: string | undefined;
    let receivedArguments: Record<string, unknown> | undefined;
    composio.executeTool = async (userId, toolSlug, arguments_) => {
      composio.capturedUserId = userId;
      receivedToolSlug = toolSlug;
      receivedArguments = arguments_;
      return {
        data: { ok: true },
        error: null,
        logId: 'log_1',
      };
    };
    const res = await s.app.inject({
      method: 'POST',
      url: '/v1/composio/tools/execute',
      headers: { authorization: `Bearer ${s.sessionToken}` },
      payload: {
        toolSlug: 'SLACK_SEARCH_MESSAGES',
        arguments: { query: 'katana' },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(s.composio.capturedUserId).toBe(s.userId);
    expect(receivedToolSlug).toBe('SLACK_SEARCH_MESSAGES');
    expect(receivedArguments).toEqual({ query: 'katana' });
  });

  test('POST /v1/composio/tools/execute rejects missing or null arguments before service execution', async () => {
    s = await setup();
    s.composio.executeTool = async () => {
      throw new Error('executeTool should not be called');
    };

    const missing = await s.app.inject({
      method: 'POST',
      url: '/v1/composio/tools/execute',
      headers: { authorization: `Bearer ${s.sessionToken}` },
      payload: { toolSlug: 'SLACK_SEARCH_MESSAGES' },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe('composio_error');

    const nullArgs = await s.app.inject({
      method: 'POST',
      url: '/v1/composio/tools/execute',
      headers: { authorization: `Bearer ${s.sessionToken}` },
      payload: {
        toolSlug: 'SLACK_SEARCH_MESSAGES',
        arguments: null,
      },
    });
    expect(nullArgs.statusCode).toBe(400);
    expect(nullArgs.json().error).toBe('composio_error');
  });

  test('surfaces ComposioServiceError status when the service throws', async () => {
    s = await setup();
    s.composio.listConnections = async () => {
      throw new ComposioServiceError(503, 'Composio backend is unavailable.');
    };
    const res = await s.app.inject({
      method: 'GET',
      url: '/v1/composio/connections',
      headers: { authorization: `Bearer ${s.sessionToken}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('composio_error');
  });
});
