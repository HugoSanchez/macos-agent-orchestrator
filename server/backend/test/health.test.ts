import { afterEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.ts';
import { getConfig } from '../src/config.ts';

describe('GET /health', () => {
  let app: Awaited<ReturnType<typeof buildServer>> | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  test('reports ok with capability flags when no DATABASE_URL is configured', async () => {
    const config = getConfig({ NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '8788' });
    app = await buildServer({ config });

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('verso-backend');
    expect(body.capabilities).toEqual({
      databaseConfigured: false,
      workosConfigured: false,
    });
    expect(body.database.configured).toBe(false);
    expect(body.database.reachable).toBe(false);
  });

  test('flips capability flags when env vars are set', async () => {
    const config = getConfig({
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '8788',
      WORKOS_API_KEY: 'sk_test',
      WORKOS_CLIENT_ID: 'client_test',
    });
    app = await buildServer({ config });

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json().capabilities).toEqual({
      databaseConfigured: false,
      workosConfigured: true,
    });
  });
});
