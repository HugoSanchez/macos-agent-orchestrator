import type { SourceAdapter } from './ingestion-source.ts';

/** Keep documents from different user-owned project credentials distinct. */
export function scopeSource(adapter: SourceAdapter, namespace: string | null): SourceAdapter {
  if (!namespace) return adapter;
  return {
    source: adapter.source,
    displayName: adapter.displayName,
    logoUrl: adapter.logoUrl,
    defaultStream: adapter.defaultStream,
    seedLookbackMs: adapter.seedLookbackMs,
    maxItemsPerBatch: adapter.maxItemsPerBatch,
    seedCursor: (now, lookback) => adapter.seedCursor(now, lookback),
    fetchSince: async (stream, cursor, opts) => {
      const result = await adapter.fetchSince(stream, cursor, opts);
      return { ...result, items: result.items.map((item) => ({
        ...item, sourceRef: `${namespace}:${item.sourceRef}`,
      })) };
    },
  };
}
