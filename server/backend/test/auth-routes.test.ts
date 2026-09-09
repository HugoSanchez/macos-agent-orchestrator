import { afterEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.ts';
import { getConfig } from '../src/config.ts';
import { AuthService } from '../src/auth/service.ts';
import { MemoryAuthStore } from '../src/auth/memory-store.ts';
import { FakeWorkOSProvider } from './fake-workos.ts';

const config = getConfig({
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '8788',
  WORKOS_API_KEY: 'sk_test',
  WORKOS_CLIENT_ID: 'client_test',
});

describe('auth routes', () => {
  let app: Awaited<ReturnType<typeof buildServer>> | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  async function setup() {
    const provider = new FakeWorkOSProvider();
    const authService = new AuthService(config, new MemoryAuthStore(), provider);
    app = await buildServer({ config, authService });
    return provider;
  }

  async function signIn() {
    await setup();
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/auth/magic/verify',
      payload: {
        email: 'owner@example.com',
        code: '123456',
        deviceLabel: 'Hugo MacBook',
        platform: 'macos',
      },
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  test('requests a WorkOS magic code for any valid email address', async () => {
    const provider = await setup();
    const allowed = await app!.inject({
      method: 'POST',
      url: '/v1/auth/magic/start',
      payload: { email: 'owner@example.com' },
    });
    const denied = await app!.inject({
      method: 'POST',
      url: '/v1/auth/magic/start',
      payload: { email: 'unknown@example.com' },
    });

    expect(allowed.statusCode).toBe(204);
    expect(denied.statusCode).toBe(204);
    expect(provider.sentCodes).toEqual(['owner@example.com', 'unknown@example.com']);
  });

  test('verifies the code and uses the WorkOS access token for /v1/me', async () => {
    const body = await signIn();
    expect(body.session).toMatchObject({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      id: 'session-workos-1',
    });
    expect(body.user.workosUserId).toBe('user_workos_123');

    const me = await app!.inject({
      method: 'GET',
      url: '/v1/me',
      headers: {
        authorization: `Bearer ${body.session.accessToken}`,
        'x-verso-device-id': body.device.id,
      },
    });

    expect(me.statusCode).toBe(200);
    expect(me.json().device.label).toBe('Hugo MacBook');
    expect(me.json().session.id).toBe('session-workos-1');
  });

  test('rejects a wrong magic code without leaking provider details', async () => {
    await setup();
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/auth/magic/verify',
      payload: {
        email: 'owner@example.com',
        code: '000000',
        deviceLabel: 'verso',
        platform: 'macos',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'invalid_code' });
  });

  test('refreshes and rotates a WorkOS session', async () => {
    const provider = await setup();
    const login = await app!.inject({
      method: 'POST',
      url: '/v1/auth/magic/verify',
      payload: {
        email: 'owner@example.com',
        code: '123456',
        deviceLabel: 'verso',
        platform: 'macos',
      },
    });
    const first = login.json();
    provider.nextAccessToken = 'access-2';
    provider.nextRefreshToken = 'refresh-2';

    const refreshed = await app!.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: {
        refreshToken: first.session.refreshToken,
        deviceId: first.device.id,
      },
    });

    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().session).toMatchObject({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
    });
  });

  test('requires the local device binding on protected routes', async () => {
    const body = await signIn();
    const response = await app!.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${body.session.accessToken}` },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('missing_device');
  });

  test('revokes the WorkOS session and no legacy Privy endpoint remains', async () => {
    const provider = await setup();
    const revoke = await app!.inject({
      method: 'POST',
      url: '/v1/auth/revoke',
      headers: { authorization: 'Bearer access-1' },
    });
    const legacy = await app!.inject({
      method: 'POST',
      url: '/v1/auth/privy/exchange',
      payload: {},
    });

    expect(revoke.statusCode).toBe(204);
    expect(provider.revokedSessionIds).toEqual(['session-workos-1']);
    expect(legacy.statusCode).toBe(404);
  });

  test('returns 503 when WorkOS is not configured', async () => {
    const unconfigured = getConfig({ NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '8788' });
    app = await buildServer({
      config: unconfigured,
      authService: new AuthService(unconfigured, new MemoryAuthStore(), null),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/magic/start',
      payload: { email: 'owner@example.com' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('workos_unconfigured');
  });
});
