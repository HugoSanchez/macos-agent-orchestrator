import { describe, expect, test } from 'vitest';
import { getConfig } from '../src/config.ts';

describe('getConfig', () => {
  test('derives capability flags from env vars', () => {
    const config = getConfig({
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '9000',
      DATABASE_URL: 'postgres://example',
      WORKOS_API_KEY: 'sk_test',
      WORKOS_CLIENT_ID: 'client_test',
      WEB_BASE_URL: 'https://example.com',
    });

    expect(config.databaseConfigured).toBe(true);
    expect(config.workosConfigured).toBe(true);
    expect(config.workosIssuer).toBe('https://api.workos.com/user_management/client_test');
    expect(config.PORT).toBe(9000);
  });

  test('treats blank optional env vars as unset', () => {
    const config = getConfig({
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '9000',
      DATABASE_URL: '',
      WORKOS_API_KEY: '',
      WORKOS_CLIENT_ID: '',
      WEB_BASE_URL: '',
    });

    expect(config.databaseConfigured).toBe(false);
    expect(config.workosConfigured).toBe(false);
    expect(config.DATABASE_URL).toBeUndefined();
    expect(config.WEB_BASE_URL).toBeUndefined();
  });

  test('configures public WorkOS authentication with only provider credentials', () => {
    const config = getConfig({
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '9000',
      WORKOS_API_KEY: 'sk_live',
      WORKOS_CLIENT_ID: 'client_live',
    });

    expect(config.workosConfigured).toBe(true);
  });
});
