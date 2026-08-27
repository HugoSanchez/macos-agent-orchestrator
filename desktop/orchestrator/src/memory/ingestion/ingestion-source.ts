// Source-agnostic adapter seam for automated ingestion. The scheduler talks
// only to this interface, so new sources (and a future v2 of agent-assisted
// "source recipes") drop in without touching the scheduler, the store, or the
// detector. An adapter owns two source-specific concerns: cursor semantics and
// turning provider payloads into detector-ready items.

/** The narrow slice of ComposioBridgeService an adapter needs. Keeps adapters testable with a fake. */
export interface IngestionBridge {
  executeTool(
    toolSlug: string,
    arguments_: Record<string, unknown>,
    opts?: { recordUsage?: boolean },
  ): Promise<{ data: unknown; error: string | null; logId: string | null }>;
}

export interface IngestionDocument {
  /** Stable target id in the memory store (e.g. Gmail messageId). */
  sourceRef: string;
  /** ISO timestamp of the item, for citations. */
  occurredAt?: string;
  /** Optional display title, stored (and FTS-indexed) alongside the content. */
  title?: string;
  /** Detector-ready text for this item. */
  content: string;
  /** Append to the target row instead of replacing it. */
  merge?: boolean;
  /** Keep one-line bucket entries ordered by their leading timestamp. */
  mergeOrder?: 'chronological';
}

export interface IngestionItem extends IngestionDocument {
  /** ISO timestamp of the item, for citations. Empty string if unknown. */
  occurredAt: string;
  /**
   * Versioned dedup key for sources whose items legitimately re-enter after
   * edits (e.g. Drive `<fileId>:<modifiedTime>`). The scheduler tracks
   * processed items by this key, so a new version passes dedup and is
   * re-ingested — while `sourceRef` stays stable so the memory store upserts
   * over the same row instead of duplicating it. Omit for immutable items.
   */
  dedupRef?: string;
  /** Monotonic position used to advance the cursor and to sort a page (e.g. epoch ms). */
  cursorValue: number;
}

export interface IngestionFetchResult {
  items: IngestionItem[];
  /** Cursor to commit after this batch. Advances past the whole fetched page, even items deduped away. */
  nextCursor: string;
  /** True when more items remain past this page → the scheduler should drain again immediately. */
  hasMore: boolean;
}

export interface SourceAdapter {
  readonly source: string;
  /** Human-readable name for the UI (e.g. "Gmail"). */
  readonly displayName: string;
  /** App logo for the UI. */
  readonly logoUrl?: string;
  /** Single watermark stream per source; '' for all current sources. */
  readonly defaultStream: string;
  /** Backfill window applied when this source is first enabled. Omit to use the scheduler default. */
  readonly seedLookbackMs?: number;
  /**
   * Items fetched (and fed to one detector run) per tick. Omit to use the
   * scheduler default. Sources with large, self-contained items (e.g. Granola
   * meeting transcripts) set this to 1 so each item gets its own focused
   * extraction pass instead of being batched.
   */
  readonly maxItemsPerBatch?: number;
  /** Initial cursor for the disabled→enabled transition (the lookback floor). */
  seedCursor(now: Date, lookbackMs: number): string;
  /** Fetch up to `maxItems` items strictly after `cursor`. Throws on a provider error. */
  fetchSince(stream: string, cursor: string, opts: { maxItems: number }): Promise<IngestionFetchResult>;
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
