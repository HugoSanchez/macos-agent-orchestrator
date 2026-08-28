import { describe, expect, it } from 'vitest';
import { GmailSource, parseGmailCursor } from '../src/memory/ingestion/sources/gmail-source.ts';
import type { IngestionBridge } from '../src/memory/ingestion/ingestion-source.ts';

interface Call {
  toolSlug: string;
  args: Record<string, unknown>;
  opts?: { recordUsage?: boolean };
}

function fakeBridge(response: { data?: unknown; error?: string | null }): { bridge: IngestionBridge; calls: Call[] } {
  const calls: Call[] = [];
  const bridge: IngestionBridge = {
    async executeTool(toolSlug, args, opts) {
      calls.push({ toolSlug, args, opts });
      return { data: response.data ?? null, error: response.error ?? null, logId: null };
    },
  };
  return { bridge, calls };
}

function gmailMessage(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    messageId: 'm_abc',
    threadId: 't_abc',
    messageTimestamp: '2026-06-17T10:00:00Z',
    subject: 'Quarterly plan',
    sender: 'alice@example.com',
    to: 'me@example.com',
    messageText: 'We decided to ship v2 in July.',
    ...over,
  };
}

describe('GmailSource', () => {
  it('seeds the cursor at now - lookback (watermark, no page token)', () => {
    const { bridge } = fakeBridge({});
    const gmail = new GmailSource(bridge);
    const now = new Date('2026-06-17T10:00:00.000Z');
    const w = now.getTime() - 7 * 24 * 60 * 60 * 1000;
    expect(parseGmailCursor(gmail.seedCursor(now, 7 * 24 * 60 * 60 * 1000))).toEqual({ w, p: null, max: w });
  });

  it('queries with after:<seconds> + inbox filter and never records tool usage', async () => {
    const { bridge, calls } = fakeBridge({ data: { messages: [gmailMessage()] } });
    const gmail = new GmailSource(bridge);
    const cursorMs = Date.parse('2026-06-10T00:00:00Z');

    await gmail.fetchSince('', String(cursorMs), { maxItems: 20 });

    expect(calls).toHaveLength(1);
    expect(calls[0].toolSlug).toBe('GMAIL_FETCH_EMAILS');
    expect(calls[0].opts).toEqual({ recordUsage: false }); // no manifest pollution
    expect(calls[0].args.query).toBe(`after:${Math.floor(cursorMs / 1000)} in:inbox -category:promotions -category:social`);
    expect(calls[0].args.max_results).toBe(20);
  });

  it('maps messageId -> sourceRef and builds detector content from the body', async () => {
    const { bridge } = fakeBridge({ data: { messages: [gmailMessage()] } });
    const gmail = new GmailSource(bridge);

    const result = await gmail.fetchSince('', '0', { maxItems: 20 });
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item.sourceRef).toBe('m_abc');
    expect(item.occurredAt).toBe('2026-06-17T10:00:00.000Z');
    expect(item.cursorValue).toBe(Date.parse('2026-06-17T10:00:00Z'));
    expect(item.content).toContain('Subject: Quarterly plan');
    expect(item.content).toContain('From: alice@example.com');
    expect(item.content).toContain('We decided to ship v2 in July.');
  });

  it('sorts ascending and does NOT advance the watermark while a page token remains', async () => {
    const messages = [
      gmailMessage({ messageId: 'm2', messageTimestamp: '2026-06-17T12:00:00Z' }),
      gmailMessage({ messageId: 'm1', messageTimestamp: '2026-06-17T09:00:00Z' }),
    ];
    const { bridge } = fakeBridge({ data: { messages, nextPageToken: 'tok' } });
    const gmail = new GmailSource(bridge);

    const result = await gmail.fetchSince('', JSON.stringify({ w: 0, p: null, max: 0 }), { maxItems: 20 });
    expect(result.items.map((i) => i.sourceRef)).toEqual(['m1', 'm2']); // ascending by timestamp
    expect(result.hasMore).toBe(true);                                   // more (older) pages remain
    const cur = parseGmailCursor(result.nextCursor);
    expect(cur.w).toBe(0);      // watermark held — older items behind the token not yet seen
    expect(cur.p).toBe('tok');  // token carried so the drain continues
  });

  it('regression: an unordered first page with a nextPageToken must not skip unseen older items', async () => {
    // Gmail paginates newest-first: page 1 carries the NEWEST message (12:00) plus a
    // token to OLDER ones. The watermark must not jump to 12:00, or the older page is lost.
    const calls: Call[] = [];
    const bridge: IngestionBridge = {
      async executeTool(toolSlug, args, opts) {
        calls.push({ toolSlug, args, opts });
        if (args.page_token === 'tok') {
          return { data: { messages: [gmailMessage({ messageId: 'old1', messageTimestamp: '2026-06-17T08:00:00Z' })] }, error: null, logId: null };
        }
        return { data: { messages: [gmailMessage({ messageId: 'new1', messageTimestamp: '2026-06-17T12:00:00Z' })], nextPageToken: 'tok' }, error: null, logId: null };
      },
    };
    const gmail = new GmailSource(bridge);

    const page1 = await gmail.fetchSince('', JSON.stringify({ w: 1000, p: null, max: 1000 }), { maxItems: 1 });
    expect(page1.hasMore).toBe(true);
    expect(parseGmailCursor(page1.nextCursor)).toMatchObject({ w: 1000, p: 'tok' }); // watermark unchanged

    const page2 = await gmail.fetchSince('', page1.nextCursor, { maxItems: 1 });
    expect(page2.items.map((i) => i.sourceRef)).toEqual(['old1']); // older message DID get fetched
    expect(page2.hasMore).toBe(false);
    const after2 = parseGmailCursor(page2.nextCursor);
    expect(after2.p).toBeNull();
    expect(after2.w).toBe(Date.parse('2026-06-17T12:00:00Z')); // watermark now the newest seen

    // Page 2 reused the SAME after:<watermark> query + token, not after:12:00.
    expect(calls[1].args.page_token).toBe('tok');
    expect(calls[1].args.query).toBe('after:1 in:inbox -category:promotions -category:social');
  });

  it('reports an empty page without rewinding the watermark', async () => {
    const { bridge } = fakeBridge({ data: { messages: [] } });
    const gmail = new GmailSource(bridge);
    const result = await gmail.fetchSince('', JSON.stringify({ w: 12345, p: null, max: 12345 }), { maxItems: 20 });
    expect(result.items).toEqual([]);
    expect(parseGmailCursor(result.nextCursor).w).toBe(12345);
    expect(result.hasMore).toBe(false);
  });

  it('skips messages without a messageId and throws on a provider error', async () => {
    const { bridge: b1 } = fakeBridge({ data: { messages: [{ subject: 'no id' }, gmailMessage()] } });
    const r1 = await new GmailSource(b1).fetchSince('', '0', { maxItems: 20 });
    expect(r1.items.map((i) => i.sourceRef)).toEqual(['m_abc']);

    const { bridge: b2 } = fakeBridge({ error: 'insufficient scope' });
    await expect(new GmailSource(b2).fetchSince('', '0', { maxItems: 20 })).rejects.toThrow(/insufficient scope/);
  });
});
