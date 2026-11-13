import { describe, expect, it, vi } from 'vitest';
import type { BridgeConnectionView } from '@verso/composio';
import { multiAccountSource } from '../src/memory/ingestion/multi-account-source.ts';
import type { IngestionBridge, SourceAdapter } from '../src/memory/ingestion/ingestion-source.ts';

const account = (id: string): BridgeConnectionView => ({ connectedAccountId: id, accountLabel: `${id}@example.com`, toolkitSlug: 'gmail', toolkitName: 'Gmail', logoUrl: null, status: 'active' });
function fixture() {
  let accounts = [account('work'), account('personal')];
  const executeTool = vi.fn(async (_slug: string, _args: Record<string, unknown>) => ({ data: {}, error: null, logId: null }));
  const factory = (bridge: IngestionBridge): SourceAdapter => ({
    source: 'gmail', displayName: 'Gmail', defaultStream: '', seedCursor: () => 'seed',
    fetchSince: async (_stream, cursor) => {
      await bridge.executeTool('GMAIL_FETCH_EMAILS', { cursor });
      return { items: [{ sourceRef: 'same-id', dedupRef: 'same-version', content: 'hello', occurredAt: '', cursorValue: 1 }], nextCursor: `${cursor}-next`, hasMore: false };
    },
  });
  return { source: multiAccountSource(factory, { executeTool }, () => accounts), executeTool, setAccounts: (next: BridgeConnectionView[]) => { accounts = next; } };
}

describe('memory with multiple accounts', () => {
  it('uses independent cursors, scopes duplicate provider IDs and records account identity', async () => {
    const { source, executeTool } = fixture();
    const first = await source.fetchSince('', source.seedCursor(new Date(), 1000), { maxItems: 20 });
    const second = await source.fetchSince('', first.nextCursor, { maxItems: 20 });
    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(false);
    expect(first.items[0].sourceRef).not.toBe(second.items[0].sourceRef);
    expect(first.items[0].dedupRef).not.toBe(second.items[0].dedupRef);
    expect(first.items[0].content).toContain('work@example.com');
    expect(second.items[0].content).toContain('personal@example.com');
    await source.fetchSince('', second.nextCursor, { maxItems: 20 });
    expect(executeTool.mock.calls.map((call) => call[1])).toEqual([
      { cursor: 'seed', connected_account_id: 'work' },
      { cursor: 'seed', connected_account_id: 'personal' },
      { cursor: 'seed-next', connected_account_id: 'work' },
    ]);
  });

  it('preserves legacy history and safely handles account additions and removals', async () => {
    const { source, executeTool, setAccounts } = fixture();
    setAccounts([account('work')]);
    const first = await source.fetchSince('', 'old-watermark', { maxItems: 20 });
    expect(first.items[0].sourceRef).toBe('same-id');
    setAccounts([account('work'), account('personal')]);
    const second = await source.fetchSince('', first.nextCursor, { maxItems: 20 });
    setAccounts([account('personal')]);
    const third = await source.fetchSince('', second.nextCursor, { maxItems: 20 });
    expect(third.items[0].sourceRef).toBe('account:personal:same-id');
    expect(executeTool.mock.calls.at(-1)?.[1]).toEqual({ cursor: 'seed', connected_account_id: 'personal' });
    expect(third.hasMore).toBe(false);
  });
});
