import type { BridgeConnectionView } from '@verso/composio';
import type { IngestionBridge, SourceAdapter } from './ingestion-source.ts';

interface AccountCursor {
  version: 'accounts-v1';
  cursors: Record<string, string>;
  remaining: string[];
  lookbackMs: number;
  legacyAccountId?: string;
}

/** One app toggle, with independent provider cursors and document IDs per account. */
export function multiAccountSource(
  factory: (bridge: IngestionBridge) => SourceAdapter,
  bridge: IngestionBridge,
  getAccounts: () => BridgeConnectionView[],
  now: () => Date = () => new Date(),
): SourceAdapter {
  const template = factory(bridge);
  const adapters = new Map<string, SourceAdapter>();
  const defaultLookback = template.seedLookbackMs ?? 7 * 24 * 60 * 60 * 1000;
  const activeAccounts = () => getAccounts().filter((account) => account.status === 'active');

  function adapterFor(id: string): SourceAdapter {
    let adapter = adapters.get(id);
    if (!adapter) {
      adapter = factory({ executeTool: (slug, args, opts) => bridge.executeTool(slug, { ...args, connected_account_id: id }, opts) });
      adapters.set(id, adapter);
    }
    return adapter;
  }

  return {
    source: template.source,
    displayName: template.displayName,
    logoUrl: template.logoUrl,
    defaultStream: template.defaultStream,
    seedLookbackMs: template.seedLookbackMs,
    maxItemsPerBatch: template.maxItemsPerBatch,
    seedCursor: (date, lookbackMs) => JSON.stringify({
      version: 'accounts-v1', lookbackMs, remaining: [],
      cursors: Object.fromEntries(activeAccounts().map((account) => [account.connectedAccountId, template.seedCursor(date, lookbackMs)])),
    } satisfies AccountCursor),
    fetchSince: async (stream, rawCursor, opts) => {
      const accounts = activeAccounts();
      if (!accounts.length) throw new Error('No active accounts for this app.');
      const ids = new Set(accounts.map((account) => account.connectedAccountId));
      for (const id of adapters.keys()) if (!ids.has(id)) adapters.delete(id);
      let cursor: AccountCursor | undefined;
      try {
        const parsed = JSON.parse(rawCursor);
        if (parsed?.version === 'accounts-v1') cursor = parsed;
      } catch { /* Older adapters store either plain or JSON cursors. */ }
      if (!cursor) {
        // The caller orders accounts by first seen time. Preserve the existing
        // account's watermark and document IDs when migrating old app cursors.
        const legacyAccountId = accounts[0].connectedAccountId;
        cursor = { version: 'accounts-v1', cursors: { [legacyAccountId]: rawCursor }, remaining: [], lookbackMs: defaultLookback, legacyAccountId };
      }
      const newlyAdded: string[] = [];
      for (const account of accounts) {
        const id = account.connectedAccountId;
        if (!Object.hasOwn(cursor.cursors, id)) {
          cursor.cursors[id] = template.seedCursor(now(), cursor.lookbackMs);
          newlyAdded.push(id);
        }
      }
      const remaining = cursor.remaining.filter((id) => ids.has(id));
      const queue = [...new Set(remaining.length ? [...remaining, ...newlyAdded] : [...ids])];
      const id = queue.shift()!;
      const result = await adapterFor(id).fetchSince(stream, cursor.cursors[id], opts);
      cursor.cursors[id] = result.nextCursor;
      if (result.hasMore) queue.push(id);
      cursor.remaining = queue;
      const account = accounts.find((item) => item.connectedAccountId === id)!;
      const scopeRef = (ref: string) => cursor!.legacyAccountId === id ? ref : `account:${encodeURIComponent(id)}:${ref}`;
      return {
        nextCursor: JSON.stringify(cursor),
        hasMore: queue.length > 0,
        items: result.items.map((item) => ({
          ...item,
          sourceRef: scopeRef(item.sourceRef),
          ...(item.dedupRef ? { dedupRef: scopeRef(item.dedupRef) } : {}),
          content: `Account: ${account.accountLabel || id}\n${item.content}`,
        })),
      };
    },
  };
}
