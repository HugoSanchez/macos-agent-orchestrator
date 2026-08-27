import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IngestionStore } from '../src/memory/ingestion/ingestion-store.ts';
import { SourceIngestionScheduler } from '../src/memory/ingestion/source-ingestion.ts';
import { buildIngestionRoutes } from '../src/memory/ingestion/ingestion.ts';
import { dispatch } from '../src/http/router.ts';
import type { IngestionFetchResult, SourceAdapter } from '../src/memory/ingestion/ingestion-source.ts';
import type { MemoryProvider } from '../src/memory/memory-provider.ts';

const fakeProvider: MemoryProvider = {
  backend: 'lexical',
  capabilities: { search: true, getPage: true, bridgeWrites: true },
  start: async () => undefined,
  stop: async () => undefined,
  isReady: () => true,
  getState: () => 'ready',
  diagnostics: () => ({ enabled: true, state: 'ready', backend: 'lexical' }),
  search: async () => [],
  getPage: async () => null,
  ingestChatSegment: async () => undefined,
  ingestSourceBatch: async () => undefined,
};

class FakeAdapter implements SourceAdapter {
  readonly source = 'gmail';
  readonly displayName = 'Gmail';
  readonly defaultStream = '';
  seedCursor(now: Date, lookbackMs: number): string {
    return String(now.getTime() - lookbackMs);
  }
  async fetchSince(): Promise<IngestionFetchResult> {
    return { items: [], nextCursor: '0', hasMore: false };
  }
}

describe('Ingestion routes', () => {
  const tempDirs: string[] = [];
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeScheduler(connected = true): SourceIngestionScheduler {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'verso-ingroutes-'));
    tempDirs.push(dir);
    const store = new IngestionStore(path.join(dir, 'ingestion.sqlite'));
    return new SourceIngestionScheduler(store, fakeProvider, [new FakeAdapter()], {
      enabled: () => true,
      connectionGate: () => connected,
      runIngestion: async () => {},
    });
  }

  async function serve(scheduler: SourceIngestionScheduler): Promise<number> {
    const routes = buildIngestionRoutes(scheduler);
    const server = http.createServer((req, res) => dispatch(routes, req, res, { allowUnauthenticated: true }));
    servers.push(server);
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
    });
  }

  it('lists known sources with connection + enabled state', async () => {
    const port = await serve(makeScheduler(true));
    const res = await fetch(`http://127.0.0.1:${port}/ingestion/sources`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0]).toMatchObject({ source: 'gmail', displayName: 'Gmail', connected: true, enabled: false, status: 'idle' });
  });

  it('enables a source (and seeds its cursor) via toggle', async () => {
    const scheduler = makeScheduler(true);
    const port = await serve(scheduler);
    const res = await fetch(`http://127.0.0.1:${port}/ingestion/sources/gmail/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toMatchObject({ source: 'gmail', enabled: true });
    // Enabling seeded a cursor, so it's now claimable.
    expect(scheduler.getSourceView('gmail')?.enabled).toBe(true);
  });

  it('refuses to enable a source whose connection is inactive', async () => {
    const port = await serve(makeScheduler(false));
    const res = await fetch(`http://127.0.0.1:${port}/ingestion/sources/gmail/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('not_connected');
  });

  it('allows disabling regardless of connection, and round-trips', async () => {
    const scheduler = makeScheduler(true);
    const port = await serve(scheduler);
    await fetch(`http://127.0.0.1:${port}/ingestion/sources/gmail/toggle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
    });
    const res = await fetch(`http://127.0.0.1:${port}/ingestion/sources/gmail/toggle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).source.enabled).toBe(false);
  });

  it('404s an unknown source', async () => {
    const port = await serve(makeScheduler(true));
    const res = await fetch(`http://127.0.0.1:${port}/ingestion/sources/notion/toggle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(404);
  });
});
