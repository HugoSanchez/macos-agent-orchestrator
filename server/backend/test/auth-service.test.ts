import { describe, expect, test } from 'vitest';
import { AuthService } from '../src/auth/service.ts';
import { MemoryAuthStore } from '../src/auth/memory-store.ts';
import { getConfig } from '../src/config.ts';
import { FakeWorkOSProvider } from './fake-workos.ts';

const config = getConfig({
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '8788',
  WORKOS_API_KEY: 'sk_test',
  WORKOS_CLIENT_ID: 'client_test',
});

function setup() {
  const provider = new FakeWorkOSProvider();
  const store = new MemoryAuthStore();
  const service = new AuthService(config, store, provider);
  return { provider, store, service };
}

describe('AuthService WorkOS magic auth', () => {
  test('sends a code for any valid email address', async () => {
    const { provider, service } = setup();

    await service.sendMagicCode(' Owner@Example.com ');
    await service.sendMagicCode('unknown@example.com');

    expect(provider.sentCodes).toEqual(['owner@example.com', 'unknown@example.com']);
  });

  test('uses only the verified WorkOS identity and creates a bound device', async () => {
    const { service } = setup();
    const result = await service.verifyMagicCode({
      email: 'owner@example.com',
      code: '123456',
      deviceLabel: 'Hugo MacBook',
      platform: 'macos',
    });

    expect(result.user).toMatchObject({
      workosUserId: 'user_workos_123',
      email: 'owner@example.com',
      displayName: 'Owner',
    });
    expect(result.device).toMatchObject({ deviceLabel: 'Hugo MacBook', platform: 'macos' });
    expect(result.accessToken).toBe('access-1');
    expect(result.entitlements).toHaveLength(1);
  });

  test('preserves an existing user id by matching the newly verified email', async () => {
    const { service, store } = setup();
    await store.insertUser({
      id: 'usr_existing',
      workosUserId: 'did:privy:legacy-user',
      email: 'OWNER@example.com',
      displayName: 'Legacy name',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const result = await service.verifyMagicCode({
      email: 'owner@example.com',
      code: '123456',
      deviceLabel: 'Hugo MacBook',
      platform: 'macos',
    });

    expect(result.user.id).toBe('usr_existing');
    expect(result.user.workosUserId).toBe('user_workos_123');
    expect(await store.getUserByWorkOSUserId('user_workos_123')).toMatchObject({ id: 'usr_existing' });
  });

  test('rejects a provider identity whose email was not verified', async () => {
    const { provider, service } = setup();
    provider.user.emailVerified = false;

    await expect(service.verifyMagicCode({
      email: 'owner@example.com',
      code: '123456',
      deviceLabel: 'Hugo MacBook',
      platform: 'macos',
    })).rejects.toMatchObject({ status: 401, code: 'unverified_email' });
  });

  test('rejects a provider identity that does not match the verified request email', async () => {
    const { provider, service } = setup();
    provider.user.email = 'partner@example.com';

    await expect(service.verifyMagicCode({
      email: 'owner@example.com',
      code: '123456',
      deviceLabel: 'Hugo MacBook',
      platform: 'macos',
    })).rejects.toMatchObject({ status: 502, code: 'invalid_provider_response' });
  });

  test('validates the WorkOS bearer and local device together', async () => {
    const { service } = setup();
    const login = await service.verifyMagicCode({
      email: 'owner@example.com',
      code: '123456',
      deviceLabel: 'Hugo MacBook',
      platform: 'macos',
    });

    const auth = await service.authenticateAccessToken(login.accessToken, login.device.id);
    expect(auth.user.id).toBe(login.user.id);
    expect(auth.session.id).toBe('session-workos-1');

    await expect(service.authenticateAccessToken(login.accessToken, 'dev_attacker'))
      .rejects.toMatchObject({ status: 401, code: 'invalid_device' });
    await expect(service.authenticateAccessToken('stolen-or-invalid', login.device.id))
      .rejects.toMatchObject({ status: 401, code: 'invalid_session' });
  });

  test('rotates WorkOS tokens while retaining the same local device', async () => {
    const { provider, service } = setup();
    const login = await service.verifyMagicCode({
      email: 'owner@example.com',
      code: '123456',
      deviceLabel: 'Hugo MacBook',
      platform: 'macos',
    });
    provider.validRefreshToken = login.refreshToken;
    provider.nextAccessToken = 'access-2';
    provider.nextRefreshToken = 'refresh-2';

    const refreshed = await service.refreshSession({
      refreshToken: login.refreshToken,
      deviceId: login.device.id,
    });

    expect(refreshed.accessToken).toBe('access-2');
    expect(refreshed.refreshToken).toBe('refresh-2');
    expect(refreshed.device.id).toBe(login.device.id);
  });

  test('revokes the WorkOS session identified by the signed access token', async () => {
    const { provider, service } = setup();
    await service.revokeSession('access-1');
    expect(provider.revokedSessionIds).toEqual(['session-workos-1']);
  });
});
