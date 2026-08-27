import { describe, expect, it } from 'vitest';
import { SlackSource, parseSlackCursor, extractMatches, extractNextCursor } from '../src/memory/ingestion/sources/slack-source.ts';
import type { IngestionBridge } from '../src/memory/ingestion/ingestion-source.ts';
import type { SlackUserDirectory } from '../src/memory/ingestion/sources/slack-users.ts';
import type { SlackConversationDirectory } from '../src/memory/ingestion/sources/slack-conversations.ts';

interface Call { slug: string; args: Record<string, unknown>; opts?: { recordUsage?: boolean }; }

const searchResp = (matches: unknown[], nextCursor: string | null) =>
  ({ data: { messages: { matches, paging: nextCursor ? { next_cursor: nextCursor } : {} }, ok: true }, error: null as string | null, logId: null });
const errResp = (message: string) => ({ data: null, error: message, logId: null });
const match = (
  channelId: string,
  ts: string,
  text: string,
  over: Record<string, unknown> = {},
  channel: Record<string, unknown> = {},
) => ({ type: 'message', ts, user: 'U1', text, channel: { id: channelId, name: 'general', ...channel }, ...over });

// A directory that maps ids from a fixed table, falling back to the id itself.
const directory = (table: Record<string, string> = {}): SlackUserDirectory => ({
  async resolve(userIds) {
    const out = new Map<string, string>();
    for (const id of userIds) out.set(id, table[id] ?? id);
    return out;
  },
});

// Maps DM channel ids to a peer user id from a fixed table.
const conversations = (table: Record<string, string> = {}): SlackConversationDirectory => ({
  async peerIds(channelIds) {
    const out = new Map<string, string>();
    for (const id of channelIds) if (table[id]) out.set(id, table[id]);
    return out;
  },
});

// `pages` is one array of matches per page; the mock simulates cursor-mark
// pagination — page 0 is fetched with cursor '*', page i with cursor `cur<i>`,
// and each page advertises the next page's cursor (null on the last page).
const cursorFor = (i: number) => (i === 0 ? '*' : `cur${i}`);
function bridgeWith(pages: unknown[][] | ((args: Record<string, unknown>) => ReturnType<typeof searchResp> | ReturnType<typeof errResp>)) {
  const calls: Call[] = [];
  const bridge: IngestionBridge = {
    async executeTool(slug, args, opts) {
      calls.push({ slug, args, opts });
      if (slug !== 'SLACK_SEARCH_MESSAGES') return errResp('unknown');
      if (typeof pages === 'function') return pages(args);
      const cur = String(args.cursor ?? '*');
      const idx = pages.findIndex((_, i) => cursorFor(i) === cur);
      if (idx < 0) return searchResp([], null);
      const next = idx + 1 < pages.length ? cursorFor(idx + 1) : null;
      return searchResp(pages[idx], next);
    },
  };
  return { bridge, calls };
}

describe('SlackSource.fetchSince', () => {
  it('groups messages into per-(channel, day) documents with time-stamped lines', async () => {
    const { bridge, calls } = bridgeWith([[
      match('C1', '100.000100', 'hi'),
      match('C9', '200.000100', 'hello'),
    ]]);
    const result = await new SlackSource(bridge).fetchSince('', '50.0', { maxItems: 50 });

    // sourceRef is the day bucket; dedupRef is the unique per-message key.
    expect(result.items.map((i) => i.sourceRef)).toEqual(['C1#1970-01-01', 'C9#1970-01-01']);
    expect(result.items.map((i) => i.dedupRef)).toEqual(['C1.100.000100', 'C9.200.000100']);
    expect(result.items.every((i) => i.merge === true)).toBe(true);
    expect(result.items[0]).toMatchObject({ title: '#general 1970-01-01', content: '[00:01] U1: hi' });

    expect(calls[0].args).toMatchObject({ sort: 'timestamp', sort_dir: 'asc', count: 100, cursor: '*' });
    expect(String(calls[0].args.query)).toMatch(/^after:\d{4}-\d{2}-\d{2}$/);
    expect(calls[0].opts).toEqual({ recordUsage: false });
    expect(JSON.parse(result.nextCursor)).toEqual({ w: '200.000100', a: null, c: null }); // caught up
    expect(result.hasMore).toBe(false);
  });

  it('shares one sourceRef across a channel-day so messages merge into it', async () => {
    const { bridge } = bridgeWith([[
      match('C1', '100.0', 'first'),
      match('C1', '200.0', 'second'),
    ]]);
    const result = await new SlackSource(bridge).fetchSince('', '0', { maxItems: 50 });
    expect(result.items.map((i) => i.sourceRef)).toEqual(['C1#1970-01-01', 'C1#1970-01-01']);
    expect(result.items.map((i) => i.dedupRef)).toEqual(['C1.100.0', 'C1.200.0']);
    expect(result.items.map((i) => i.content)).toEqual(['[00:01] U1: first', '[00:03] U1: second']);
  });

  it('resolves author ids and <@mention> ids to display names', async () => {
    const { bridge } = bridgeWith([[
      match('C1', '100.0', 'hey <@U2> and <@U3|ignored-handle>', { user: 'U1' }),
    ]]);
    const src = new SlackSource(bridge, { userDirectory: directory({ U1: 'Alice', U2: 'Bob' }) });
    const result = await src.fetchSince('', '0', { maxItems: 50 });
    // U1 → Alice (author), U2 → Bob (mention), U3 → unresolved falls back to the id.
    expect(result.items[0].content).toBe('[00:01] Alice: hey @Bob and @U3');
  });

  it('drops messages below the watermark and keeps the exact ts cursor precise', async () => {
    const { bridge } = bridgeWith([[
      match('C1', '90.0', 'old, before watermark'),
      match('C1', '100.000000', 'right at watermark'),
      match('C1', '100.000123', 'just after'),
    ]]);
    const result = await new SlackSource(bridge).fetchSince('', '100.000000', { maxItems: 50 });
    expect(result.items.map((i) => i.dedupRef)).toEqual(['C1.100.000000', 'C1.100.000123']);
    expect(JSON.parse(result.nextCursor).w).toBe('100.000123');
  });

  it('carries the cursor past a page-cap prefix and resumes to the new message (no stall)', async () => {
    // 20 full pages of already-processed messages (< watermark), then a new one
    // on page 21. The page cap stops run 1 deep in the prefix — it must carry
    // the cursor so a later tick resumes there instead of re-scanning and never
    // reaching the new message.
    const prefix = Array.from({ length: 20 }, () => Array.from({ length: 100 }, () => match('C1', '1000.0', 'old')));
    const pages = [...prefix, [match('C1', '6000.0', 'fresh')]];
    const { bridge, calls } = bridgeWith(pages);
    const src = new SlackSource(bridge);

    const run1 = await src.fetchSince('', '5000.0', { maxItems: 50 });
    expect(run1.items).toEqual([]); // still deep in the prefix
    expect(run1.hasMore).toBe(true); // not caught up
    expect(JSON.parse(run1.nextCursor).c).toBe('cur20'); // cursor carried to the 21st page
    expect(calls).toHaveLength(20); // capped at MAX_PAGES this tick

    const run2 = await src.fetchSince('', run1.nextCursor, { maxItems: 50 });
    expect(run2.items.map((i) => i.content)).toEqual(['[01:40] U1: fresh']);
    expect(run2.hasMore).toBe(false);
    expect(calls[20].args.cursor).toBe('cur20'); // resumed from the carried cursor — no re-scan
  });

  it('advances the cursor past a window of only skipped messages (no loop)', async () => {
    const { bridge } = bridgeWith([[
      match('C1', '500.0', 'joined', { subtype: 'channel_join' }),
      match('C1', '600.0', 'beep', { subtype: 'bot_message' }),
      { type: 'message', ts: '700.0', text: 'x', user: 'U9' }, // no channel → skipped
    ]]);
    const result = await new SlackSource(bridge).fetchSince('', '100.0', { maxItems: 50 });
    expect(result.items).toEqual([]);
    expect(JSON.parse(result.nextCursor).w).toBe('700.0'); // moved past every ts seen
    expect(result.hasMore).toBe(false);
  });

  it('bounds the batch by maxItems and carries the cursor to re-read the rest', async () => {
    const { bridge } = bridgeWith([[
      match('C1', '10.0', 'a'),
      match('C1', '20.0', 'b'),
      match('C1', '30.0', 'c'),
    ]]);
    const result = await new SlackSource(bridge).fetchSince('', '0', { maxItems: 2 });
    expect(result.items.map((i) => i.content)).toEqual(['[00:00] U1: a', '[00:00] U1: b']);
    expect(result.hasMore).toBe(true);
    const cur = JSON.parse(result.nextCursor);
    expect(cur.w).toBe('20.0'); // advanced only to the last item taken — c isn't skipped
    expect(cur.c).toBe('*'); // re-read this page next run (taken items fall below the watermark)
  });

  it('labels DMs and group DMs distinctly from channels in the title', async () => {
    const { bridge } = bridgeWith([[
      match('D1', '10.0', 'direct', {}, { is_im: true, name: '' }),
      match('G1', '20.0', 'huddle', {}, { is_mpim: true, name: 'mpdm-a--b' }),
      match('C1', '30.0', 'public'),
    ]]);
    const result = await new SlackSource(bridge).fetchSince('', '0', { maxItems: 50 });
    expect(result.items.map((i) => i.title)).toEqual([
      'DM 1970-01-01',
      'Group DM 1970-01-01',
      '#general 1970-01-01',
    ]);
    expect(result.items.map((i) => i.sourceRef)).toEqual(['D1#1970-01-01', 'G1#1970-01-01', 'C1#1970-01-01']);
    expect(result.items.map((i) => i.content)).toEqual([
      '[00:00] U1: direct',
      '[00:00] U1: huddle',
      '[00:00] U1: public',
    ]);
  });

  it('titles a DM document with the resolved peer name', async () => {
    const { bridge } = bridgeWith([[match('D1', '10.0', 'hey', { user: 'U1' }, { is_im: true, name: '' })]]);
    const src = new SlackSource(bridge, {
      userDirectory: directory({ U1: 'Alice', U2: 'Bob' }), // U1 sent it, U2 is the DM peer
      conversationDirectory: conversations({ D1: 'U2' }),
    });
    const result = await src.fetchSince('', '0', { maxItems: 50 });
    expect(result.items[0].title).toBe('DM with Bob 1970-01-01');
    expect(result.items[0].content).toBe('[00:00] Alice: hey');
  });

  it('falls back to a bare DM title when the peer name is unavailable', async () => {
    const { bridge } = bridgeWith([[match('D1', '10.0', 'hey', {}, { is_im: true, name: '' })]]);
    // Peer id resolves but the (identity) user directory cannot name it → "DM".
    const src = new SlackSource(bridge, { conversationDirectory: conversations({ D1: 'U2' }) });
    const result = await src.fetchSince('', '0', { maxItems: 50 });
    expect(result.items[0].title).toBe('DM 1970-01-01');
  });

  it('skips system messages (subtype), empty text, missing ts, and missing channel id', async () => {
    const { bridge } = bridgeWith([[
      match('C1', '1.1', 'real'),
      match('C1', '2.1', 'joined', { subtype: 'channel_join' }),
      match('C1', '3.1', ''),
      { type: 'message', text: 'no ts', user: 'U9', channel: { id: 'C1' } },
      { type: 'message', ts: '5.1', text: 'no channel', user: 'U9' },
    ]]);
    const result = await new SlackSource(bridge).fetchSince('', '0', { maxItems: 50 });
    expect(result.items.map((i) => i.dedupRef)).toEqual(['C1.1.1']);
  });

  it('returns the watermark unchanged when nothing new matches', async () => {
    const { bridge } = bridgeWith([[]]);
    const result = await new SlackSource(bridge).fetchSince('', '123.456', { maxItems: 50 });
    expect(result.items).toEqual([]);
    expect(JSON.parse(result.nextCursor).w).toBe('123.456');
    expect(result.hasMore).toBe(false);
  });

  it('throws on a provider error', async () => {
    const { bridge } = bridgeWith(() => errResp('missing_scope: search:read'));
    await expect(new SlackSource(bridge).fetchSince('', '0', { maxItems: 50 })).rejects.toThrow(/missing_scope/);
  });

  it('seeds at now − 24h and exposes a 24h backfill window', () => {
    const src = new SlackSource(bridgeWith([]).bridge);
    expect(src.seedLookbackMs).toBe(24 * 60 * 60 * 1000);
    const now = new Date('2026-06-17T10:00:00.000Z');
    expect(src.seedCursor(now, src.seedLookbackMs)).toBe(`${Math.floor((now.getTime() - 24 * 60 * 60 * 1000) / 1000)}.000000`);
  });
});

describe('parseSlackCursor', () => {
  it('parses the JSON form and tolerates a bare ts / empty', () => {
    expect(parseSlackCursor(JSON.stringify({ w: '9.0', a: '2026-06-20', c: 'CUR' }))).toEqual({ w: '9.0', a: '2026-06-20', c: 'CUR' });
    expect(parseSlackCursor('1781999275.000000')).toEqual({ w: '1781999275.000000', a: null, c: null });
    expect(parseSlackCursor('')).toEqual({ w: '0', a: null, c: null });
  });
});

describe('extractMatches', () => {
  it('reads matches from data.messages.matches and tolerates a flattened shape', () => {
    expect(extractMatches({ messages: { matches: [{ ts: '1.0' }] } })).toHaveLength(1);
    expect(extractMatches({ matches: [{ ts: '1.0' }, { ts: '2.0' }] })).toHaveLength(2);
    expect(extractMatches({})).toEqual([]);
    expect(extractMatches(null)).toEqual([]);
    expect(extractMatches({ messages: { matches: 'nope' } })).toEqual([]);
  });
});

describe('extractNextCursor', () => {
  it('reads data.messages.paging.next_cursor and treats empty/missing as null', () => {
    expect(extractNextCursor({ messages: { paging: { next_cursor: 'abc' } } })).toBe('abc');
    expect(extractNextCursor({ messages: { paging: { next_cursor: '' } } })).toBeNull();
    expect(extractNextCursor({ messages: { paging: {} } })).toBeNull();
    expect(extractNextCursor({ messages: {} })).toBeNull();
    expect(extractNextCursor(null)).toBeNull();
  });
});
