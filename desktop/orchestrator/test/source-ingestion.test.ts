import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IngestionStore } from '../src/memory/ingestion/ingestion-store.ts';
import { SourceIngestionScheduler, isSourceIngestionEnabled, type IngestionRunner } from '../src/memory/ingestion/source-ingestion.ts';
import type { IngestionFetchResult, IngestionItem, SourceAdapter } from '../src/memory/ingestion/ingestion-source.ts';
import type { MemoryProvider } from '../src/memory/memory-provider.ts';

const t0 = new Date('2026-06-17T10:00:00.000Z');
const MIN = 60 * 1000;
const at = (ms: number) => new Date(t0.getTime() + ms);
const item = (ref: string, ts: number): IngestionItem => ({
  sourceRef: ref,
  cursorValue: ts,
  occurredAt: new Date(ts).toISOString(),
  content: `content ${ref}`,
});

type Behavior = (cursor: string, call: number) => IngestionFetchResult;

class ScriptedAdapter implements SourceAdapter {
  readonly source = 'gmail';
  readonly displayName = 'Gmail';
  readonly defaultStream = '';
  readonly maxItemsPerBatch?: number;
  calls = 0;
  lastMaxItems = 0;
  constructor(private readonly behavior: Behavior, maxItemsPerBatch?: number) {
    this.maxItemsPerBatch = maxItemsPerBatch;
  }
  seedCursor(now: Date, lookbackMs: number): string {
    return String(now.getTime() - lookbackMs);
  }
  async fetchSince(_stream: string, cursor: string, opts: { maxItems: number }): Promise<IngestionFetchResult> {
    this.calls += 1;
    this.lastMaxItems = opts.maxItems;
    return this.behavior(cursor, this.calls);
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

describe('SourceIngestionScheduler', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup(opts: {
    behavior: Behavior;
    enabled?: () => boolean;
    extractionGate?: () => boolean;
    connectionGate?: (source: string) => boolean;
    detectThrows?: boolean;
    maxBatchAttempts?: number;
    baseBackoffMs?: number;
    adapterMaxItems?: number;
  }) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'verso-sched-'));
    tempDirs.push(dir);
    const store = new IngestionStore(path.join(dir, 'ingestion.sqlite'));
    const adapter = new ScriptedAdapter(opts.behavior, opts.adapterMaxItems);
    const runs: Array<{ source: string; stream: string; items: Array<{ sourceRef: string }> }> = [];
    const runIngestion: IngestionRunner = async (payload) => {
      runs.push(payload);
      if (opts.detectThrows) throw new Error('detect boom');
    };
    const scheduler = new SourceIngestionScheduler(store, fakeProvider, [adapter], {
      enabled: opts.enabled ?? (() => true),
      extractionGate: opts.extractionGate ?? (() => true),
      connectionGate: opts.connectionGate,
      runIngestion,
      maxBatchAttempts: opts.maxBatchAttempts ?? 5,
      baseBackoffMs: opts.baseBackoffMs ?? 1000,
    });
    return { store, adapter, runs, scheduler };
  }

  it('fetches, runs the detector with new items, and advances the cursor', async () => {
    const { store, runs, scheduler } = setup({
      behavior: () => ({ items: [item('m1', 100), item('m2', 200)], nextCursor: '200', hasMore: false }),
    });
    store.enableSource('gmail', '', { seedCursor: '0' }, t0);

    await scheduler.tick(at(MIN));

    expect(runs).toHaveLength(1);
    expect(runs[0].items.map((i) => i.sourceRef)).toEqual(['m1', 'm2']);
    const s = store.getSource('gmail', '')!;
    expect(s).toMatchObject({ status: 'idle', cursor: '200' });
    expect(s.nextDueAt).toBe(at(MIN + 120 * MIN).toISOString()); // 2h interval cadence
    expect(store.getItem('gmail', '', 'm1')?.status).toBe('processed');
  });

  it('drains immediately while a page is full (hasMore)', async () => {
    const { store, scheduler } = setup({
      behavior: () => ({ items: [item('m1', 100)], nextCursor: '100', hasMore: true }),
    });
    store.enableSource('gmail', '', { seedCursor: '0' }, t0);

    await scheduler.tick(at(MIN));
    expect(store.getSource('gmail', '')?.nextDueAt).toBe(at(MIN).toISOString()); // due now → drains next tick
  });

  it('skips already-processed items but still advances the cursor', async () => {
    const { store, runs, scheduler } = setup({
      behavior: () => ({ items: [item('m1', 100), item('m2', 200)], nextCursor: '200', hasMore: false }),
    });
    store.enableSource('gmail', '', { seedCursor: '0' }, t0);
    store.markItemsProcessed('gmail', '', ['m1'], t0); // m1 already done

    await scheduler.tick(at(MIN));
    expect(runs[0].items.map((i) => i.sourceRef)).toEqual(['m2']); // only the new one
    expect(store.getSource('gmail', '')?.cursor).toBe('200');
  });

  it('dedups on dedupRef, so an edited item re-ingests under its stable sourceRef', async () => {
    // Drive-style versioned items: sourceRef is the file id, dedupRef carries
    // the version. A new version passes dedup and reaches the provider (which
    // upserts on sourceRef); refetching the same version is skipped.
    const versioned = (ref: string, version: number, ts: number) => ({
      ...item(ref, ts),
      dedupRef: `${ref}:${version}`,
    });
    const { store, runs, scheduler } = setup({
      behavior: (_cursor, call) => call === 1
        ? { items: [versioned('doc-1', 1, 100)], nextCursor: '100', hasMore: false }
        // Second fetch: same version re-fetched (boundary overlap) plus an edit.
        : { items: [versioned('doc-1', 1, 100), versioned('doc-1', 2, 300)], nextCursor: '300', hasMore: false },
    });
    store.enableSource('gmail', '', { seedCursor: '0' }, t0);

    await scheduler.tick(at(MIN));
    await scheduler.tick(at(130 * MIN)); // past the 2h interval

    expect(runs).toHaveLength(2);
    expect(runs[0].items.map((i) => i.sourceRef)).toEqual(['doc-1']);
    expect(runs[1].items.map((i) => i.sourceRef)).toEqual(['doc-1']); // v2 only — v1 deduped
    expect(store.getItem('gmail', '', 'doc-1:1')?.status).toBe('processed');
    expect(store.getItem('gmail', '', 'doc-1:2')?.status).toBe('processed');
  });

  it('does not call the detector on an empty page', async () => {
    const { store, runs, scheduler } = setup({
      behavior: (cursor) => ({ items: [], nextCursor: cursor, hasMore: false }),
    });
    store.enableSource('gmail', '', { seedCursor: '42' }, t0);

    await scheduler.tick(at(MIN));
    expect(runs).toHaveLength(0);
    const s = store.getSource('gmail', '')!;
    expect(s).toMatchObject({ status: 'idle', cursor: '42' });
    expect(s.nextDueAt).toBe(at(MIN + 120 * MIN).toISOString());
  });

  it('defers (no failure, no fetch) when the connection is inactive', async () => {
    const { store, adapter, runs, scheduler } = setup({
      behavior: () => ({ items: [item('m1', 100)], nextCursor: '100', hasMore: false }),
      connectionGate: () => false,
    });
    store.enableSource('gmail', '', { seedCursor: '0' }, t0);

    await scheduler.tick(at(MIN));
    expect(adapter.calls).toBe(0); // never fetched
    expect(runs).toHaveLength(0);
    const s = store.getSource('gmail', '')!;
    expect(s).toMatchObject({ status: 'idle', cursor: '0', failCount: 0 });
    expect(s.nextDueAt).toBe(at(MIN + 120 * MIN).toISOString());
  });

  it('defers unknown source rows without recording a failure', async () => {
    const { store, adapter, runs, scheduler } = setup({
      behavior: () => ({ items: [item('m1', 100)], nextCursor: '100', hasMore: false }),
    });
    store.enableSource('clickup', '', { seedCursor: '0', intervalMs: 2 * 60 * 60 * 1000 }, t0);

    await scheduler.tick(at(MIN));

    expect(adapter.calls).toBe(0);
    expect(runs).toHaveLength(0);
    const s = store.getSource('clickup', '')!;
    expect(s).toMatchObject({ status: 'idle', cursor: '0', failCount: 0, lastError: null });
    expect(s.nextDueAt).toBe(at(MIN + 120 * MIN).toISOString());
  });

  it('backs off on a fetch error without advancing the cursor', async () => {
    const { store, runs, scheduler } = setup({
      behavior: () => { throw new Error('rate limited'); },
    });
    store.enableSource('gmail', '', { seedCursor: '7' }, t0);

    await scheduler.tick(at(MIN));
    expect(runs).toHaveLength(0);
    const s = store.getSource('gmail', '')!;
    expect(s).toMatchObject({ status: 'failed', cursor: '7', failCount: 1 });
    expect(s.lastError).toMatch(/rate limited/);
  });

  it('poisons a repeatedly-failing page and skips past it instead of stalling', async () => {
    const { store, scheduler } = setup({
      behavior: () => ({ items: [item('m1', 100)], nextCursor: '100', hasMore: false }),
      detectThrows: true,
      maxBatchAttempts: 2,
      baseBackoffMs: 1000,
    });
    store.enableSource('gmail', '', { seedCursor: '0' }, t0);

    // Attempt 1: under threshold → fail, cursor held.
    await scheduler.tick(at(MIN));
    expect(store.getSource('gmail', '')).toMatchObject({ status: 'failed', cursor: '0', failCount: 1 });
    expect(store.getItem('gmail', '', 'm1')?.status).toBe('pending');

    // Attempt 2 (after backoff): hits threshold → poison the page + advance cursor.
    await scheduler.tick(at(10 * MIN));
    expect(store.getItem('gmail', '', 'm1')?.status).toBe('poisoned');
    const s = store.getSource('gmail', '')!;
    expect(s).toMatchObject({ status: 'idle', cursor: '100' }); // skipped past the bad page
  });

  it('honors a per-adapter maxItemsPerBatch, else the scheduler default', async () => {
    const one = setup({ behavior: () => ({ items: [item('m1', 1)], nextCursor: '1', hasMore: false }), adapterMaxItems: 1 });
    one.store.enableSource('gmail', '', { seedCursor: '0' }, t0);
    await one.scheduler.tick(at(MIN));
    expect(one.adapter.lastMaxItems).toBe(1);

    const def = setup({ behavior: () => ({ items: [], nextCursor: '0', hasMore: false }) });
    def.store.enableSource('gmail', '', { seedCursor: '0' }, t0);
    await def.scheduler.tick(at(MIN));
    expect(def.adapter.lastMaxItems).toBe(20); // DEFAULT_MAX_ITEMS_PER_BATCH
  });

  it('source ingestion defaults on, with an explicit falsy env as kill switch', () => {
    const prev = process.env.VERSO_INGESTION_ENABLED;
    try {
      delete process.env.VERSO_INGESTION_ENABLED;
      expect(isSourceIngestionEnabled()).toBe(true); // toggle a source = enabled, no flag needed
      process.env.VERSO_INGESTION_ENABLED = '0';
      expect(isSourceIngestionEnabled()).toBe(false); // kill switch
      process.env.VERSO_INGESTION_ENABLED = 'yes';
      expect(isSourceIngestionEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.VERSO_INGESTION_ENABLED;
      else process.env.VERSO_INGESTION_ENABLED = prev;
    }
  });

  it('rebuilds the corpus when the memory store instance token changes', () => {
    const { store, scheduler } = setup({ behavior: () => ({ items: [], nextCursor: '0', hasMore: false }) });
    store.enableSource('gmail', '', { seedCursor: '0' }, t0);
    // Prior runs advanced the cursor well past history and marked items processed.
    store.completeIngestion('gmail', '', '999999', at(MIN).toISOString(), t0);
    store.markItemsProcessed('gmail', '', ['old-1', 'old-2'], t0);
    expect(store.getItem('gmail', '', 'old-1')?.status).toBe('processed');

    const now = at(60 * MIN);
    expect(scheduler.reconcileWithMemoryToken('mem-abc', now)).toBe(true);

    // Ledger wiped so nothing is skipped on re-fetch.
    expect(store.getItem('gmail', '', 'old-1')).toBeNull();
    // Cursor re-seeded to the lookback floor (7d default) and made due now.
    const s = store.getSource('gmail', '')!;
    expect(s.cursor).toBe(String(now.getTime() - 7 * 24 * 60 * 60 * 1000));
    expect(s.nextDueAt).toBe(now.toISOString());

    // Idempotent: the same token no longer rebuilds.
    expect(scheduler.reconcileWithMemoryToken('mem-abc', at(70 * MIN))).toBe(false);
  });

  it('does not rebuild on a null token, and preserves the ledger once reconciled', () => {
    const { store, scheduler } = setup({ behavior: () => ({ items: [], nextCursor: '0', hasMore: false }) });
    store.enableSource('gmail', '', { seedCursor: '0' }, t0);
    store.markItemsProcessed('gmail', '', ['keep'], t0);

    // Store not ready yet → skip without recording, so a later real token still triggers a rebuild.
    expect(scheduler.reconcileWithMemoryToken(null, at(MIN))).toBe(false);
    expect(store.getItem('gmail', '', 'keep')?.status).toBe('processed');

    expect(scheduler.reconcileWithMemoryToken('tok', at(MIN))).toBe(true);
    store.markItemsProcessed('gmail', '', ['fresh'], at(2 * MIN));
    expect(scheduler.reconcileWithMemoryToken('tok', at(3 * MIN))).toBe(false);
    expect(store.getItem('gmail', '', 'fresh')?.status).toBe('processed'); // steady-state ledger untouched
  });

  it('re-seeds only enabled sources on rebuild', () => {
    const { store, scheduler } = setup({ behavior: () => ({ items: [], nextCursor: '0', hasMore: false }) });
    store.enableSource('gmail', '', { seedCursor: '12345' }, t0);
    store.disableSource('gmail', '', t0);

    expect(scheduler.reconcileWithMemoryToken('tok', at(MIN))).toBe(true);
    // A disabled source keeps its cursor (re-enabling resumes where it left off).
    expect(store.getSource('gmail', '')?.cursor).toBe('12345');
  });

  it('does nothing when disabled or while the gate is closed', async () => {
    const disabled = setup({ behavior: () => ({ items: [item('m1', 1)], nextCursor: '1', hasMore: false }), enabled: () => false });
    disabled.store.enableSource('gmail', '', { seedCursor: '0' }, t0);
    await disabled.scheduler.tick(at(MIN));
    expect(disabled.adapter.calls).toBe(0);

    const gated = setup({ behavior: () => ({ items: [item('m1', 1)], nextCursor: '1', hasMore: false }), extractionGate: () => false });
    gated.store.enableSource('gmail', '', { seedCursor: '0' }, t0);
    await gated.scheduler.tick(at(MIN));
    expect(gated.adapter.calls).toBe(0);
  });
});
