import { describe, expect, it } from 'vitest';
import {
  GranolaSource,
  extractMcpText,
  parseMeetingList,
  parseMeetingDetails,
  parseTranscript,
} from '../src/memory/ingestion/sources/granola-source.ts';
import type { IngestionBridge } from '../src/memory/ingestion/ingestion-source.ts';

interface Call { slug: string; args: Record<string, unknown>; opts?: { recordUsage?: boolean }; }

const mcp = (text: string) => ({ data: { data: [{ type: 'text', text }] }, error: null as string | null, logId: null });
const mcpError = (message: string) => ({ data: null, error: message, logId: null });

function listText(
  meetings: Array<{ id?: string; title?: string; date?: string; participants?: string }>,
  opts: { to?: string } = {},
): string {
  const blocks = meetings.map((m) => {
    const attrs = [
      m.id !== undefined ? ` id="${m.id}"` : '',
      m.title !== undefined ? ` title="${m.title}"` : '',
      m.date !== undefined ? ` date="${m.date}"` : '',
    ].join('');
    return `<meeting${attrs}>\n  <known_participants>${m.participants ?? ''}</known_participants>\n</meeting>`;
  }).join('\n');
  return `<meetings_data from="May 18, 2026"${opts.to ? ` to="${opts.to}"` : ''} count="${meetings.length}">\n${blocks}\n</meetings_data>`;
}

function detailText(meetings: Array<{ id: string; summary?: string; participants?: string }>): string {
  const blocks = meetings.map((m) =>
    `<meeting id="${m.id}">\n  <known_participants>${m.participants ?? ''}</known_participants>\n  <summary>${m.summary ?? ''}</summary>\n</meeting>`,
  ).join('\n');
  return `<meetings_data>\n${blocks}\n</meetings_data>`;
}

function fakeBridge(handlers: {
  list?: () => ReturnType<typeof mcp>;
  get?: (ids: string[]) => ReturnType<typeof mcp>;
  transcript?: (id: string) => ReturnType<typeof mcp>;
}) {
  const calls: Call[] = [];
  const bridge: IngestionBridge = {
    async executeTool(slug, args, opts) {
      calls.push({ slug, args, opts });
      if (slug === 'GRANOLA_MCP_LIST_MEETINGS') return handlers.list ? handlers.list() : mcp(listText([]));
      if (slug === 'GRANOLA_MCP_GET_MEETINGS') return handlers.get ? handlers.get((args.meeting_ids as string[]) ?? []) : mcp(detailText([]));
      if (slug === 'GRANOLA_MCP_GET_MEETING_TRANSCRIPT') return handlers.transcript ? handlers.transcript(String(args.meeting_id)) : mcp(JSON.stringify({ transcript: '' }));
      return mcpError('unknown tool');
    },
  };
  return { bridge, calls };
}

const TO = 'Jun 17, 2026';

describe('GranolaSource.fetchSince', () => {
  it('lists, hydrates, sorts ascending, and builds meeting content', async () => {
    const { bridge, calls } = fakeBridge({
      list: () => mcp(listText([
        { id: 'm2', title: 'Planning', date: '2026-06-17T12:00:00Z', participants: 'Alice' },
        { id: 'm1', title: 'Standup', date: '2026-06-17T09:00:00Z', participants: 'Bob' },
      ], { to: TO })),
      get: (ids) => mcp(detailText(ids.map((id) => ({ id, summary: `summary ${id}` })))),
    });

    const result = await new GranolaSource(bridge).fetchSince('', '0', { maxItems: 20 });

    expect(result.items.map((i) => i.sourceRef)).toEqual(['m1', 'm2']); // ascending by date
    expect(result.items[0].content).toContain('Meeting: Standup');
    expect(result.items[0].content).toContain('Participants: Bob');
    expect(result.items[0].content).toContain('summary m1');
    expect(result.items[0].occurredAt).toBe('2026-06-17T09:00:00.000Z');
    expect(result.nextCursor).toBe(String(Date.parse('2026-06-17T12:00:00Z')));
    expect(result.hasMore).toBe(false);

    expect(calls.map((c) => c.slug)).toEqual(['GRANOLA_MCP_LIST_MEETINGS', 'GRANOLA_MCP_GET_MEETINGS']);
    expect(calls.every((c) => c.opts?.recordUsage === false)).toBe(true); // no manifest pollution
    expect((calls[1].args.meeting_ids as string[]).slice().sort()).toEqual(['m1', 'm2']);
  });

  it('throws when LIST fails (scheduler backs off)', async () => {
    const { bridge } = fakeBridge({ list: () => mcpError('granola unavailable') });
    await expect(new GranolaSource(bridge).fetchSince('', '0', { maxItems: 20 })).rejects.toThrow(/granola unavailable/);
  });

  it('throws when GET fails (transient flakiness → retry via backoff, not silent loss)', async () => {
    const { bridge } = fakeBridge({
      list: () => mcp(listText([{ id: 'm1', title: 'T', date: '2026-06-17T09:00:00Z' }], { to: TO })),
      get: () => mcpError('granola get timeout'),
    });
    await expect(new GranolaSource(bridge).fetchSince('', '0', { maxItems: 20 })).rejects.toThrow(/granola get timeout/);
  });

  it('returns nothing (and does not call GET) for an empty window', async () => {
    const { bridge, calls } = fakeBridge({ list: () => mcp(listText([], { to: TO })) });
    const result = await new GranolaSource(bridge).fetchSince('', '5', { maxItems: 20 });
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBe('5'); // unchanged
    expect(result.hasMore).toBe(false);
    expect(calls.map((c) => c.slug)).toEqual(['GRANOLA_MCP_LIST_MEETINGS']); // GET skipped
  });

  it('skips meetings with no id', async () => {
    const { bridge } = fakeBridge({
      list: () => mcp(listText([
        { title: 'no id', date: '2026-06-17T09:00:00Z' },
        { id: 'm1', title: 'has id', date: '2026-06-17T10:00:00Z' },
      ], { to: TO })),
      get: (ids) => mcp(detailText(ids.map((id) => ({ id, summary: 's' })))),
    });
    const result = await new GranolaSource(bridge).fetchSince('', '0', { maxItems: 20 });
    expect(result.items.map((i) => i.sourceRef)).toEqual(['m1']);
  });

  it('falls back to the window end date when a meeting date is garbled', async () => {
    const { bridge } = fakeBridge({
      list: () => mcp(listText([{ id: 'm1', title: 'T', date: 'not-a-date' }], { to: TO })),
      get: (ids) => mcp(detailText(ids.map((id) => ({ id, summary: 's' })))),
    });
    const result = await new GranolaSource(bridge).fetchSince('', '0', { maxItems: 20 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].occurredAt).toBe(new Date(Date.parse(TO)).toISOString());
  });

  it('skips a meeting with no usable date at all (garbled date, no window bound)', async () => {
    const { bridge } = fakeBridge({
      list: () => mcp(listText([{ id: 'm1', title: 'T', date: 'garbage' }])), // no `to`
    });
    const result = await new GranolaSource(bridge).fetchSince('', '0', { maxItems: 20 });
    expect(result.items).toEqual([]);
  });

  it('degrades per-item when GET returns detail for only some ids', async () => {
    const { bridge } = fakeBridge({
      list: () => mcp(listText([
        { id: 'm1', title: 'One', date: '2026-06-17T09:00:00Z', participants: 'Bob' },
        { id: 'm2', title: 'Two', date: '2026-06-17T10:00:00Z', participants: 'Carol' },
      ], { to: TO })),
      get: () => mcp(detailText([{ id: 'm1', summary: 'only m1 summary' }])), // m2 missing
    });
    const result = await new GranolaSource(bridge).fetchSince('', '0', { maxItems: 20 });
    expect(result.items[0].content).toContain('only m1 summary');
    expect(result.items[1].content).toContain('Meeting: Two');
    expect(result.items[1].content).toContain('Participants: Carol'); // from list
    expect(result.items[1].content).not.toContain('summary');
  });

  it('bounds the batch and advances nextCursor to the batch max (not the window max)', async () => {
    const { bridge, calls } = fakeBridge({
      list: () => mcp(listText([
        { id: 'm1', title: 'A', date: '2026-06-17T08:00:00Z' },
        { id: 'm2', title: 'B', date: '2026-06-17T09:00:00Z' },
        { id: 'm3', title: 'C', date: '2026-06-17T10:00:00Z' },
      ], { to: TO })),
      get: (ids) => mcp(detailText(ids.map((id) => ({ id, summary: 's' })))),
    });
    const result = await new GranolaSource(bridge).fetchSince('', '0', { maxItems: 2 });
    expect(result.items.map((i) => i.sourceRef)).toEqual(['m1', 'm2']); // oldest two
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe(String(Date.parse('2026-06-17T09:00:00Z'))); // batch max, not m3
    expect((calls[1].args.meeting_ids as string[]).slice().sort()).toEqual(['m1', 'm2']);
  });

  it('only includes meetings dated after the cursor', async () => {
    const cursor = String(Date.parse('2026-06-17T10:00:00Z'));
    const { bridge } = fakeBridge({
      list: () => mcp(listText([
        { id: 'old', title: 'Old', date: '2026-06-17T09:00:00Z' },
        { id: 'new', title: 'New', date: '2026-06-17T12:00:00Z' },
      ], { to: TO })),
      get: (ids) => mcp(detailText(ids.map((id) => ({ id, summary: 's' })))),
    });
    const result = await new GranolaSource(bridge).fetchSince('', cursor, { maxItems: 20 });
    expect(result.items.map((i) => i.sourceRef)).toEqual(['new']);
  });

  it('truncates content to the configured limit', async () => {
    const { bridge } = fakeBridge({
      list: () => mcp(listText([{ id: 'm1', title: 'T', date: '2026-06-17T09:00:00Z' }], { to: TO })),
      get: (ids) => mcp(detailText(ids.map((id) => ({ id, summary: 'x'.repeat(9999) })))),
    });
    const result = await new GranolaSource(bridge, { contentLimit: 80 }).fetchSince('', '0', { maxItems: 20 });
    expect(result.items[0].content.length).toBe(80);
  });

  it('seeds the cursor at now - lookback', () => {
    const now = new Date('2026-06-17T10:00:00.000Z');
    const gmail = new GranolaSource(fakeBridge({}).bridge);
    expect(gmail.seedCursor(now, 7 * 24 * 60 * 60 * 1000)).toBe(String(now.getTime() - 7 * 24 * 60 * 60 * 1000));
  });
});

describe('Granola defensive parsing', () => {
  it('extractMcpText joins text blocks and tolerates junk', () => {
    expect(extractMcpText({ data: [{ text: 'a' }, { text: 'b' }] })).toBe('a\nb');
    expect(extractMcpText({ data: [{ text: 'a' }, { notText: 'x' }] })).toBe('a');
    expect(extractMcpText(null)).toBe('');
    expect(extractMcpText({})).toBe('');
    expect(extractMcpText({ data: 'nope' })).toBe('');
  });

  it('parseMeetingList decodes entities and extracts participants; ignores unterminated blocks', () => {
    const text = [
      '<meetings_data to="Jun 17, 2026">',
      '<meeting id="m1" title="Succinct &amp; Co" date="2026-06-17T09:00:00Z">',
      '  <known_participants>Bob, Carol</known_participants>',
      '</meeting>',
      '<meeting id="m2" title="Truncated" date="2026-06-17T10:00:00Z">', // never closed
    ].join('\n');
    const meetings = parseMeetingList(text);
    expect(meetings.map((m) => m.id)).toEqual(['m1']); // m2's block is not closed → skipped
    expect(meetings[0].title).toBe('Succinct & Co'); // entity decoded
    expect(meetings[0].participants).toBe('Bob, Carol');
  });

  it('parseMeetingDetails maps id → summary', () => {
    const text = '<meeting id="m1"><summary>Decided to ship</summary></meeting>';
    expect(parseMeetingDetails(text).get('m1')?.summary).toBe('Decided to ship');
  });

  it('parseTranscript extracts the transcript field defensively', () => {
    expect(parseTranscript(JSON.stringify({ id: 'm1', title: 'T', transcript: 'verbatim talk' }))).toBe('verbatim talk');
    expect(parseTranscript('not json')).toBe('');
    expect(parseTranscript(JSON.stringify({ no: 'transcript' }))).toBe('');
    expect(parseTranscript('')).toBe('');
  });
});

describe('GranolaSource transcript modes', () => {
  const meetings = [{ id: 'm1', title: 'Sync', date: '2026-06-17T09:00:00Z', participants: 'Bob' }];
  const transcriptBlob = (id: string) => mcp(JSON.stringify({ id, title: 'Sync', transcript: `verbatim ${id} talk` }));

  it('processes one meeting per run (maxItemsPerBatch = 1)', () => {
    expect(new GranolaSource(fakeBridge({}).bridge).maxItemsPerBatch).toBe(1);
  });

  it("transcript mode: fetches the transcript, skips the summary call", async () => {
    const { bridge, calls } = fakeBridge({
      list: () => mcp(listText(meetings, { to: TO })),
      transcript: (id) => transcriptBlob(id),
    });
    const result = await new GranolaSource(bridge, { mode: 'transcript' }).fetchSince('', '0', { maxItems: 1 });
    expect(result.items[0].content).toContain('Transcript:');
    expect(result.items[0].content).toContain('verbatim m1 talk');
    const slugs = calls.map((c) => c.slug);
    expect(slugs).toContain('GRANOLA_MCP_GET_MEETING_TRANSCRIPT');
    expect(slugs).not.toContain('GRANOLA_MCP_GET_MEETINGS'); // summary call skipped
    expect(calls.every((c) => c.opts?.recordUsage === false)).toBe(true);
  });

  it('both mode: includes summary AND transcript', async () => {
    const { bridge, calls } = fakeBridge({
      list: () => mcp(listText(meetings, { to: TO })),
      get: (ids) => mcp(detailText(ids.map((id) => ({ id, summary: `summary ${id}` })))),
      transcript: (id) => transcriptBlob(id),
    });
    const result = await new GranolaSource(bridge, { mode: 'both' }).fetchSince('', '0', { maxItems: 1 });
    expect(result.items[0].content).toContain('summary m1');
    expect(result.items[0].content).toContain('verbatim m1 talk');
    const slugs = calls.map((c) => c.slug);
    expect(slugs).toContain('GRANOLA_MCP_GET_MEETINGS');
    expect(slugs).toContain('GRANOLA_MCP_GET_MEETING_TRANSCRIPT');
  });

  it('summary mode (default) never calls the transcript action', async () => {
    const { bridge, calls } = fakeBridge({
      list: () => mcp(listText(meetings, { to: TO })),
      get: (ids) => mcp(detailText(ids.map((id) => ({ id, summary: 's' })))),
    });
    await new GranolaSource(bridge).fetchSince('', '0', { maxItems: 1 });
    expect(calls.map((c) => c.slug)).not.toContain('GRANOLA_MCP_GET_MEETING_TRANSCRIPT');
  });

  it('throws when the transcript call fails (so the scheduler backs off)', async () => {
    const { bridge } = fakeBridge({
      list: () => mcp(listText(meetings, { to: TO })),
      transcript: () => mcpError('transcript timeout'),
    });
    await expect(new GranolaSource(bridge, { mode: 'transcript' }).fetchSince('', '0', { maxItems: 1 })).rejects.toThrow(/transcript timeout/);
  });
});
