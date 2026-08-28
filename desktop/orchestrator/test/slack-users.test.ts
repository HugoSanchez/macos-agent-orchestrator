import { describe, expect, it } from 'vitest';
import { ComposioSlackUserDirectory, isSlackUserId, pickDisplayName } from '../src/memory/ingestion/sources/slack-users.ts';
import type { IngestionBridge } from '../src/memory/ingestion/ingestion-source.ts';

type Handler = (slug: string, args: Record<string, unknown>) => { data: unknown; error: string | null; logId: string | null };

function mkBridge(handler: Handler) {
  const calls: Array<{ slug: string; args: Record<string, unknown> }> = [];
  const bridge: IngestionBridge = {
    async executeTool(slug, args) {
      calls.push({ slug, args });
      return handler(slug, args);
    },
  };
  return { bridge, calls };
}

const userResp = (user: Record<string, unknown>) => ({ data: { users: [user] }, error: null, logId: null });

describe('ComposioSlackUserDirectory', () => {
  it('resolves ids to display names, prefers display_name, and caches lookups', async () => {
    const { bridge, calls } = mkBridge((_slug, args) =>
      userResp({ id: args.search_query, name: 'hugo', real_name: 'Hugo Sanchez', profile: { display_name: 'Hugo' } }));
    const dir = new ComposioSlackUserDirectory(bridge);

    const first = await dir.resolve(['U1', 'unknown']);
    expect(first.get('U1')).toBe('Hugo');
    expect(first.get('unknown')).toBe('unknown'); // not a Slack id → never looked up
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ slug: 'SLACK_FIND_USERS', args: { search_query: 'U1', exact_match: true } });

    // Cached: a second resolve of the same id issues no new call.
    const second = await dir.resolve(['U1']);
    expect(second.get('U1')).toBe('Hugo');
    expect(calls).toHaveLength(1);
  });

  it('falls back to the raw id on a tool error', async () => {
    const { bridge } = mkBridge(() => ({ data: null, error: 'missing_scope: users:read', logId: null }));
    const dir = new ComposioSlackUserDirectory(bridge);
    expect((await dir.resolve(['U9'])).get('U9')).toBe('U9');
  });

  it('falls back to the raw id when the bridge throws', async () => {
    const bridge: IngestionBridge = { async executeTool() { throw new Error('network down'); } };
    const dir = new ComposioSlackUserDirectory(bridge);
    expect((await dir.resolve(['U9'])).get('U9')).toBe('U9');
  });
});

describe('pickDisplayName', () => {
  it('reads a nested users.info user and prefers display_name → real_name → name', () => {
    expect(pickDisplayName({ user: { id: 'U1', profile: { display_name: 'Hugo' } } }, 'U1')).toBe('Hugo');
    expect(pickDisplayName({ users: [{ id: 'U2', real_name: 'Bob' }] }, 'U2')).toBe('Bob');
    expect(pickDisplayName({ users: [{ id: 'U3', name: 'carol' }] }, 'U3')).toBe('carol');
  });

  it('prefers the object whose id matches, else the first plausible name', () => {
    const data = { users: [{ id: 'UX', name: 'Wrong' }, { id: 'U1', name: 'Right' }] };
    expect(pickDisplayName(data, 'U1')).toBe('Right');
    // No id match → first plausible name as a fallback.
    expect(pickDisplayName({ users: [{ id: 'UX', name: 'OnlyOne' }] }, 'U1')).toBe('OnlyOne');
  });

  it('returns null when there is no name anywhere', () => {
    expect(pickDisplayName({ ok: true, users: [] }, 'U1')).toBeNull();
    expect(pickDisplayName(null, 'U1')).toBeNull();
  });
});

describe('isSlackUserId', () => {
  it('accepts Uxxx / Wxxx ids and rejects fallbacks', () => {
    expect(isSlackUserId('U012ABCDEF')).toBe(true);
    expect(isSlackUserId('W123ABC')).toBe(true);
    expect(isSlackUserId('unknown')).toBe(false);
    expect(isSlackUserId('U')).toBe(false);
    expect(isSlackUserId('')).toBe(false);
  });
});
