import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { HermesSupervisor } from '../src/hermes/hermes-supervisor.ts';

describe('Hermes gateway ownership probes', () => {
  const envSnapshot = {
    VERSO_HERMES_MANAGED: process.env.VERSO_HERMES_MANAGED,
  };

  afterEach(() => {
    if (envSnapshot.VERSO_HERMES_MANAGED === undefined) delete process.env.VERSO_HERMES_MANAGED;
    else process.env.VERSO_HERMES_MANAGED = envSnapshot.VERSO_HERMES_MANAGED;
  });

  it('does not treat an unauthenticated health response as an owned gateway', async () => {
    const gateway = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (req.url === '/v1/models') {
        if (req.headers.authorization !== 'Bearer expected-key') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'invalid_api_key' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [] }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    const address = gateway.address() as { port: number };
    process.env.VERSO_HERMES_MANAGED = 'false';

    try {
      const wrongKey = new HermesSupervisor({
        config: {
          baseUrl: `http://127.0.0.1:${address.port}`,
          startupTimeoutMs: 1_000,
          apiKey: 'wrong-key',
        },
        launch: { command: null, args: [], cwd: null, startupTimeoutMs: 1_000 },
      });
      await expect(wrongKey.ensureReady()).rejects.toThrow('Hermes gateway unavailable');
      expect((await wrongKey.getStatus()).reachable).toBe(false);

      const matchingKey = new HermesSupervisor({
        config: {
          baseUrl: `http://127.0.0.1:${address.port}`,
          startupTimeoutMs: 1_000,
          apiKey: 'expected-key',
        },
        launch: { command: null, args: [], cwd: null, startupTimeoutMs: 1_000 },
      });
      const ready = await matchingKey.ensureReady();
      expect(ready.baseUrl).toBe(`http://127.0.0.1:${address.port}`);
      expect((await matchingKey.getStatus()).reachable).toBe(true);
    } finally {
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    }
  });
});
