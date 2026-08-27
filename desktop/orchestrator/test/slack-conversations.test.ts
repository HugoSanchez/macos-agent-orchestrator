import { describe, expect, it } from 'vitest';
import { ComposioSlackConversationDirectory, collectImPeers } from '../src/memory/ingestion/sources/slack-conversations.ts';
import type { IngestionBridge } from '../src/memory/ingestion/ingestion-source.ts';

function mkBridge(handler: (slug: string, args: Record<string, unknown>) => { data: unknown; error: string | null; logId: string | null }) {
  const calls: Array<{ slug: string; args: Record<string, unknown> }> = [];
  const bridge: IngestionBridge = {
    async executeTool(slug, args) {
      calls.push({ slug, args });
      return handler(slug, args);
    },
  };
  return { bridge, calls };
}

const imResp = (channels: unknown[]) => ({ data: { channels }, error: null, logId: null });

describe('ComposioSlackConversationDirectory', () => {
  it('resolves DM channels to peer ids and lists conversations only once', async () => {
    const { bridge, calls } = mkBridge(() => imResp([
      { id: 'D1', is_im: true, user: 'U1' },
      { id: 'D2', is_im: true, user: 'U2' },
      { id: 'C9', is_im: false, name: 'general' }, // non-IM ignored
    ]));
    const dir = new ComposioSlackConversationDirectory(bridge);

    const first = await dir.peerIds(['D1', 'D2', 'Cunknown']);
    expect(first.get('D1')).toBe('U1');
    expect(first.get('D2')).toBe('U2');
    expect(first.has('Cunknown')).toBe(false);
    expect(calls).toMatchObject([{ slug: 'SLACK_LIST_CONVERSATIONS', args: { types: 'im' } }]);

    // Cached: a second call issues no new listing.
    await dir.peerIds(['D1']);
    expect(calls).toHaveLength(1);
  });

  it('returns an empty map (never throws) on error or when nothing is asked', async () => {
    const { bridge } = mkBridge(() => ({ data: null, error: 'missing_scope: im:read', logId: null }));
    const dir = new ComposioSlackConversationDirectory(bridge);
    expect((await dir.peerIds(['D1'])).size).toBe(0);

    const thrower: IngestionBridge = { async executeTool() { throw new Error('down'); } };
    expect((await new ComposioSlackConversationDirectory(thrower).peerIds(['D1'])).size).toBe(0);

    const { bridge: ok, calls } = mkBridge(() => imResp([{ id: 'D1', is_im: true, user: 'U1' }]));
    expect((await new ComposioSlackConversationDirectory(ok).peerIds([])).size).toBe(0);
    expect(calls).toHaveLength(0); // nothing requested → no listing
  });
});

describe('collectImPeers', () => {
  it('records only IM entries with an id and user, tolerating nested shapes', () => {
    const map = collectImPeers({ ok: true, data: { channels: [
      { id: 'D1', is_im: true, user: 'U1' },
      { id: 'D2', is_im: true },        // no user → skipped
      { id: 'C1', is_im: false, user: 'U9' }, // not an IM → skipped
    ] } }, new Map());
    expect([...map]).toEqual([['D1', 'U1']]);
  });

  it('is empty for junk input', () => {
    expect(collectImPeers(null, new Map()).size).toBe(0);
    expect(collectImPeers({ channels: 'nope' }, new Map()).size).toBe(0);
  });
});
