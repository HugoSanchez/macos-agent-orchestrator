import { IngestionStore, type IngestionSourceState } from './ingestion-store.ts';
import type { IngestionDocument, SourceAdapter } from './ingestion-source.ts';
import type { MemoryProvider } from '../memory-provider.ts';

const DEFAULT_POLL_INTERVAL_MS = 30 * 1000;
const DEFAULT_STALE_RUNNING_MS = 10 * 60 * 1000;
// How often a source is re-checked once it's caught up. Ingestion is not
// time-sensitive — a couple of hours of latency is fine — and a long interval
// keeps Composio fetch volume low. (A backlog still drains promptly: hasMore
// sets next_due_at = now so the scheduler keeps going until caught up.)
const DEFAULT_SOURCE_INTERVAL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_ITEMS_PER_BATCH = 20;
const DEFAULT_MAX_BATCH_ATTEMPTS = 5;
const DEFAULT_BASE_BACKOFF_MS = 30 * 1000;
const DEFAULT_MAX_BACKOFF_MS = 30 * 60 * 1000;
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

// ingestion_config key holding the memory-store instance token we last rebuilt
// the corpus for. A mismatch on startup means memory was reset → rebuild.
const MEMORY_INSTANCE_CONFIG_KEY = 'memory_instance_id';

/** UI-facing view of a source: store state enriched with adapter + connection info. */
export interface IngestionSourceView {
  source: string;
  displayName: string;
  logoUrl: string | null;
  stream: string;
  connected: boolean;
  enabled: boolean;
  status: IngestionSourceState['status'];
  lastCompletedAt: string | null;
  lastError: string | null;
  nextDueAt: string | null;
  /** Processed items ingested so far for this source. */
  itemCount: number;
}

/** Pulled out so the scheduler is testable without the real network detector. */
export type IngestionRunner = (
  payload: {
    source: string;
    stream: string;
    items: Array<IngestionDocument & { occurredAt: string }>;
  },
) => Promise<void>;

export function isSourceIngestionEnabled(): boolean {
  // Default ON: enabling a source in Settings is all it takes. The per-source
  // toggles control what actually gets ingested; an explicit falsy
  // VERSO_INGESTION_ENABLED still works as a kill switch.
  const raw = process.env.VERSO_INGESTION_ENABLED?.trim().toLowerCase();
  if (!raw) return true;
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off');
}

/**
 * Time-driven sibling of MemoryExtractionScheduler for external sources. Each
 * tick claims one due (source, stream), fetches the next page after its cursor,
 * dedups, runs the pages-only detector through the shared write gate at 'source'
 * priority, then advances the cursor. A full page reschedules immediately
 * (bounded drain); a short page waits a full interval. Cursors are durable, so
 * downtime backfills on the next launch.
 */
export class SourceIngestionScheduler {
  private readonly store: IngestionStore;
  private readonly provider: MemoryProvider;
  private readonly adapters: Map<string, SourceAdapter>;
  private readonly pollIntervalMs: number;
  private readonly staleRunningMs: number;
  private readonly maxItemsPerBatch: number;
  private readonly maxBatchAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly extractionGate: () => boolean;
  private readonly connectionGate: (source: string) => boolean;
  private readonly runIngestion: IngestionRunner;
  private readonly enabledFn: () => boolean;
  private readonly lookbackMs: number;
  private interval: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    store: IngestionStore,
    provider: MemoryProvider,
    adapters: SourceAdapter[],
    opts: {
      pollIntervalMs?: number;
      staleRunningMs?: number;
      maxItemsPerBatch?: number;
      maxBatchAttempts?: number;
      baseBackoffMs?: number;
      maxBackoffMs?: number;
      extractionGate?: () => boolean;
      connectionGate?: (source: string) => boolean;
      runIngestion?: IngestionRunner;
      enabled?: () => boolean;
      lookbackMs?: number;
    } = {},
  ) {
    this.store = store;
    this.provider = provider;
    this.adapters = new Map(adapters.map((adapter) => [adapter.source, adapter]));
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.staleRunningMs = opts.staleRunningMs ?? DEFAULT_STALE_RUNNING_MS;
    this.maxItemsPerBatch = opts.maxItemsPerBatch ?? DEFAULT_MAX_ITEMS_PER_BATCH;
    this.maxBatchAttempts = opts.maxBatchAttempts ?? DEFAULT_MAX_BATCH_ATTEMPTS;
    this.baseBackoffMs = opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.extractionGate = opts.extractionGate ?? (() => true);
    this.connectionGate = opts.connectionGate ?? (() => true);
    this.runIngestion = opts.runIngestion ?? ((payload) => this.provider.ingestSourceBatch(payload));
    this.enabledFn = opts.enabled ?? (() => this.provider.diagnostics().enabled && isSourceIngestionEnabled());
    this.lookbackMs = opts.lookbackMs ?? DEFAULT_LOOKBACK_MS;

    // Register a disabled row per source so the UI can list it before it's ever
    // enabled. Every source is single-stream (one watermark per source). Also
    // reconcile the interval so rows created by an earlier build adopt the
    // current cadence (ensureIngestionSource won't overwrite an existing row).
    for (const adapter of adapters) {
      this.store.ensureIngestionSource(adapter.source, adapter.defaultStream, DEFAULT_SOURCE_INTERVAL_MS);
      this.store.setSourceInterval(adapter.source, adapter.defaultStream, DEFAULT_SOURCE_INTERVAL_MS);
    }
  }

  get enabled(): boolean {
    return this.enabledFn();
  }

  /** Toggle a source on/off. Enabling seeds the cursor at now − the adapter's lookback. */
  setSourceEnabled(source: string, enabled: boolean, now = new Date()): IngestionSourceState | null {
    const adapter = this.adapters.get(source);
    if (!adapter) return null;
    if (enabled) {
      const lookbackMs = adapter.seedLookbackMs ?? this.lookbackMs;
      return this.store.enableSource(source, adapter.defaultStream, { seedCursor: adapter.seedCursor(now, lookbackMs) }, now);
    }
    return this.store.disableSource(source, adapter.defaultStream, now);
  }

  /**
   * Reconcile the ingestion ledger with the memory store's identity. The memory
   * store and this ledger have independent lifecycles: if the store is recreated
   * (fresh build, path change, manual wipe) its instance token changes, but the
   * ledger still marks every past item 'processed' and the cursors sit past
   * them — so nothing is ever re-fetched and the new store stays empty except
   * for whatever high-churn source happens to produce new items. Detect that
   * mismatch and rebuild: clear the ledger and re-seed every enabled source's
   * cursor to its lookback floor, so the corpus re-fetches into the new store.
   *
   * A null token (store not ready / memory disabled) is a no-op — we retry on
   * the next launch rather than clobbering the recorded token. Returns true when
   * a rebuild ran.
   */
  reconcileWithMemoryToken(memoryToken: string | null, now = new Date()): boolean {
    if (!memoryToken) return false;
    const recorded = this.store.getConfig(MEMORY_INSTANCE_CONFIG_KEY);
    if (recorded === memoryToken) return false;

    const cleared = this.store.clearProcessedLedger();
    const reseeded: string[] = [];
    for (const adapter of this.adapters.values()) {
      const state = this.store.getSource(adapter.source, adapter.defaultStream);
      if (!state?.enabled) continue;
      const lookbackMs = adapter.seedLookbackMs ?? this.lookbackMs;
      this.store.reseedCursor(adapter.source, adapter.defaultStream, adapter.seedCursor(now, lookbackMs), now);
      reseeded.push(adapter.source);
    }
    this.store.setConfig(MEMORY_INSTANCE_CONFIG_KEY, memoryToken);
    console.log(
      `[ingest] memory store reset detected (${recorded ?? 'none'} → ${memoryToken}); `
      + `rebuilding corpus: cleared ${cleared} ledger row(s), re-seeded [${reseeded.join(', ') || 'none'}]`,
    );
    return true;
  }

  /** UI-facing list: one row per source. */
  listSources(): IngestionSourceView[] {
    return [...this.adapters.values()].map((adapter) => this.viewForAdapter(adapter));
  }

  getSourceView(source: string): IngestionSourceView | null {
    const adapter = this.adapters.get(source);
    return adapter ? this.viewForAdapter(adapter) : null;
  }

  resetSourceData(source: string, now = new Date()): {
    source: string;
    itemRowsDeleted: number;
    stateRowsReset: number;
    sourceView: IngestionSourceView | null;
  } | null {
    const adapter = this.adapters.get(source);
    if (!adapter) return null;
    const result = this.store.resetSourceData(source, now);
    this.store.ensureIngestionSource(adapter.source, adapter.defaultStream, DEFAULT_SOURCE_INTERVAL_MS, now);
    this.store.setSourceInterval(adapter.source, adapter.defaultStream, DEFAULT_SOURCE_INTERVAL_MS, now);
    return { ...result, sourceView: this.getSourceView(source) };
  }

  private viewForAdapter(adapter: SourceAdapter): IngestionSourceView {
    const state = this.store.getSource(adapter.source, adapter.defaultStream)
      ?? this.store.ensureIngestionSource(adapter.source, adapter.defaultStream);
    return this.toView(state);
  }

  private toView(state: IngestionSourceState): IngestionSourceView {
    const adapter = this.adapters.get(state.source);
    return {
      source: state.source,
      displayName: adapter?.displayName ?? state.source,
      logoUrl: adapter?.logoUrl ?? null,
      stream: state.stream,
      connected: this.connectionGate(state.source),
      enabled: state.enabled,
      status: state.status,
      lastCompletedAt: state.lastCompletedAt,
      lastError: state.lastError,
      nextDueAt: state.nextDueAt,
      itemCount: this.store.countProcessedItems(state.source),
    };
  }

  start(): void {
    if (!this.enabled || this.interval) return;
    this.store.resetStaleRunningIngestion(this.staleRunningMs);
    this.interval = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        console.warn(`[ingest] source ingestion scheduler failed: ${formatError(error)}`);
      });
    }, this.pollIntervalMs);
    this.interval.unref();
  }

  stop(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }

  async tick(now = new Date()): Promise<void> {
    if (!this.enabled || this.running) return;
    if (!this.extractionGate()) return;
    this.running = true;
    try {
      const claim = this.store.claimDueIngestionSource(now);
      if (!claim) return;

      const adapter = this.adapters.get(claim.source);
      if (!adapter) {
        // Older sidecars can share the same ingestion DB with a newer build
        // that registered additional sources. Treat those rows like inactive
        // connections: leave their cursor intact and try again later instead
        // of poisoning the source with a failure the newer build then shows.
        this.store.deferIngestion(claim.source, claim.stream, this.intervalAt(now, claim.intervalMs), now);
        return;
      }

      // Cheap, local connection check. If the source isn't connected right now,
      // defer (don't burn a failure) and try again next interval.
      if (!this.connectionGate(claim.source)) {
        this.store.deferIngestion(claim.source, claim.stream, this.intervalAt(now, claim.intervalMs), now);
        return;
      }

      const maxItems = adapter.maxItemsPerBatch ?? this.maxItemsPerBatch;
      let result;
      try {
        result = await adapter.fetchSince(claim.stream, claim.cursor ?? '', { maxItems });
      } catch (error: unknown) {
        this.store.failIngestion(claim.source, claim.stream, formatError(error), this.backoffAt(now, claim.failCount), now);
        console.warn(`[ingest] fetch failed for ${claim.source}/${claim.stream || '(default)'}: ${formatError(error)}`);
        return;
      }

      // Dedup key: dedupRef when the adapter versions its items (edited Drive
      // docs re-enter with a new version), else the stable sourceRef.
      const refOf = (item: { sourceRef: string; dedupRef?: string }) => item.dedupRef ?? item.sourceRef;
      const fetchedRefs = result.items.map(refOf);
      const newRefs = this.store.filterNewRefs(claim.source, claim.stream, fetchedRefs);
      const nextDue = result.hasMore ? now.toISOString() : this.intervalAt(now, claim.intervalMs);

      // Nothing new on this page (empty or fully deduped): still advance the
      // cursor so we don't refetch it forever, then reschedule.
      if (newRefs.length === 0) {
        this.store.completeIngestion(claim.source, claim.stream, result.nextCursor, nextDue, now);
        return;
      }

      const newSet = new Set(newRefs);
      const newItems = result.items.filter((item) => newSet.has(refOf(item)));
      this.store.recordPendingItems(claim.source, claim.stream, newRefs, now);

      try {
        await this.runIngestion({
          source: claim.source,
          stream: claim.stream,
          items: newItems.map((item) => ({
            sourceRef: item.sourceRef,
            occurredAt: item.occurredAt,
            ...(item.title ? { title: item.title } : {}),
            content: item.content,
            ...(item.merge ? { merge: true } : {}),
            ...(item.mergeOrder ? { mergeOrder: item.mergeOrder } : {}),
          })),
        });
        this.store.markItemsProcessed(claim.source, claim.stream, newRefs, now);
        this.store.completeIngestion(claim.source, claim.stream, result.nextCursor, nextDue, now);
      } catch (error: unknown) {
        const message = formatError(error);
        if (claim.failCount + 1 >= this.maxBatchAttempts) {
          // This page has failed repeatedly. Poison its items and skip past it
          // so one bad batch can't stall the stream forever.
          for (const ref of newRefs) this.store.markItemPoisoned(claim.source, claim.stream, ref, message, now);
          this.store.completeIngestion(claim.source, claim.stream, result.nextCursor, this.intervalAt(now, claim.intervalMs), now);
          console.warn(`[ingest] poisoned ${newRefs.length} item(s) for ${claim.source}/${claim.stream || '(default)'} after ${claim.failCount + 1} attempts; skipping page`);
        } else {
          this.store.failIngestion(claim.source, claim.stream, message, this.backoffAt(now, claim.failCount), now);
          console.warn(`[ingest] ingestion failed for ${claim.source}/${claim.stream || '(default)'}: ${message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private intervalAt(now: Date, intervalMs: number): string {
    return new Date(now.getTime() + intervalMs).toISOString();
  }

  private backoffAt(now: Date, failCount: number): string {
    const backoff = Math.min(this.baseBackoffMs * 2 ** failCount, this.maxBackoffMs);
    return new Date(now.getTime() + backoff).toISOString();
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
