import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IngestionStore } from '../src/memory/ingestion/ingestion-store.ts';
import { SourceIngestionScheduler } from '../src/memory/ingestion/source-ingestion.ts';
import type { IngestionFetchResult, SourceAdapter } from '../src/memory/ingestion/ingestion-source.ts';
import type { MemoryProvider } from '../src/memory/memory-provider.ts';

class EmptyAdapter implements SourceAdapter {
  readonly source = 'clickup';
  readonly displayName = 'ClickUp';
  readonly defaultStream = '';
  seedCursor(now: Date, lookbackMs: number): string {
    return String(now.getTime() - lookbackMs);
  }
  async fetchSince(): Promise<IngestionFetchResult> {
    return { items: [], nextCursor: '0', hasMore: false };
  }
}

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

describe('SourceIngestionScheduler resetSourceData', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('disables the source, clears cursor/fail state, and wipes its item ledger', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'verso-ingest-reset-'));
    tempDirs.push(dir);
    const store = new IngestionStore(path.join(dir, 'ingestion.sqlite'));
    const scheduler = new SourceIngestionScheduler(store, fakeProvider, [new EmptyAdapter()], { enabled: () => true });
    store.enableSource('clickup', '', { seedCursor: '123' });
    store.markItemsProcessed('clickup', '', ['comment-1', 'comment-2']);
    store.failIngestion('clickup', '', 'boom', new Date().toISOString());

    const result = scheduler.resetSourceData('clickup');

    expect(result?.itemRowsDeleted).toBe(2);
    expect(result?.sourceView).toMatchObject({
      source: 'clickup',
      enabled: false,
      status: 'idle',
      itemCount: 0,
    });
    const state = store.getSource('clickup', '')!;
    expect(state.cursor).toBeNull();
    expect(state.lastError).toBeNull();
    expect(state.failCount).toBe(0);
  });
});
