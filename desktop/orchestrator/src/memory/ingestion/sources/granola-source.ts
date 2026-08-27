import {
  asString,
  type IngestionBridge,
  type IngestionFetchResult,
  type IngestionItem,
  type SourceAdapter,
} from '../ingestion-source.ts';

const GRANOLA_LIST_MEETINGS = 'GRANOLA_MCP_LIST_MEETINGS';
const GRANOLA_GET_MEETINGS = 'GRANOLA_MCP_GET_MEETINGS';
const GRANOLA_GET_MEETING_TRANSCRIPT = 'GRANOLA_MCP_GET_MEETING_TRANSCRIPT';

const SUMMARY_CONTENT_LIMIT = 6000;
const TRANSCRIPT_CONTENT_LIMIT = 40000;

// What meeting content to feed the signal detector:
//  - 'summary'    Granola's AI summary (default — cheap, high signal, batched call)
//  - 'transcript' the full verbatim transcript only (richest, ~10x tokens; one
//                 GET_MEETING_TRANSCRIPT call per meeting since it does not batch)
//  - 'both'       summary + transcript (max recall, max cost)
// Like chat sessions, EVERY meeting is its own extraction run (maxItemsPerBatch
// = 1): one focused signal-detection pass per meeting, never a giant batch.
export type GranolaContentMode = 'summary' | 'transcript' | 'both';

export function granolaContentModeFromEnv(): GranolaContentMode {
  const raw = process.env.VERSO_GRANOLA_CONTENT?.trim().toLowerCase();
  return raw === 'transcript' || raw === 'both' ? raw : 'summary';
}

// Granola's Composio schema is malformed upstream and every response is an MCP
// text blob. LIST_MEETINGS / GET_MEETINGS return XML-ish markup; the transcript
// is JSON ({ id, title, transcript }). We parse defensively with regex/JSON and
// tolerate missing fields. Cursor is a plain epoch-ms watermark: LIST returns
// the whole recent window, we keep meetings dated after it, the store dedups by id.

export interface ListedMeeting {
  id: string;
  title: string;
  dateMs: number;
  occurredAt: string;
  participants: string;
}

export interface MeetingDetail {
  summary: string;
  participants: string;
}

export class GranolaSource implements SourceAdapter {
  readonly source = 'granola';
  readonly displayName = 'Granola';
  readonly logoUrl = 'https://logos.composio.dev/api/granola_mcp';
  readonly defaultStream = '';
  // One meeting per extraction run — meetings are coherent, self-contained
  // units (and transcripts are too big to batch).
  readonly maxItemsPerBatch = 1;

  private readonly mode: GranolaContentMode;
  private readonly contentLimit: number;

  constructor(
    private readonly bridge: IngestionBridge,
    opts: { mode?: GranolaContentMode; contentLimit?: number } = {},
  ) {
    this.mode = opts.mode ?? granolaContentModeFromEnv();
    this.contentLimit = opts.contentLimit
      ?? (this.mode === 'summary' ? SUMMARY_CONTENT_LIMIT : TRANSCRIPT_CONTENT_LIMIT);
  }

  seedCursor(now: Date, lookbackMs: number): string {
    return String(Math.max(0, now.getTime() - lookbackMs));
  }

  async fetchSince(_stream: string, cursor: string, opts: { maxItems: number }): Promise<IngestionFetchResult> {
    const parsedWatermark = Number(cursor);
    const watermark = Number.isFinite(parsedWatermark) ? parsedWatermark : 0;

    const listText = await this.callText(GRANOLA_LIST_MEETINGS, {});
    const listed = parseMeetingList(listText);

    const fresh = listed
      .filter((meeting) => meeting.dateMs > watermark)
      .sort((a, b) => a.dateMs - b.dateMs);
    const batch = fresh.slice(0, opts.maxItems);
    const hasMore = fresh.length > opts.maxItems;

    const needSummary = this.mode === 'summary' || this.mode === 'both';
    const needTranscript = this.mode === 'transcript' || this.mode === 'both';

    let details = new Map<string, MeetingDetail>();
    if (batch.length > 0 && needSummary) {
      details = parseMeetingDetails(await this.callText(GRANOLA_GET_MEETINGS, { meeting_ids: batch.map((m) => m.id) }));
    }

    const transcripts = new Map<string, string>();
    if (batch.length > 0 && needTranscript) {
      // GET_MEETING_TRANSCRIPT takes a single id — one call per meeting. Safe
      // because maxItemsPerBatch is 1, so this is at most one call per tick.
      for (const meeting of batch) {
        transcripts.set(meeting.id, parseTranscript(await this.callText(GRANOLA_GET_MEETING_TRANSCRIPT, { meeting_id: meeting.id })));
      }
    }

    const items: IngestionItem[] = batch.map((meeting) => ({
      sourceRef: meeting.id,
      cursorValue: meeting.dateMs,
      occurredAt: meeting.occurredAt,
      content: this.buildContent(meeting, details.get(meeting.id), transcripts.get(meeting.id)),
    }));

    const nextCursor = batch.length > 0 ? String(batch[batch.length - 1].dateMs) : cursor;
    return { items, nextCursor, hasMore };
  }

  private buildContent(meeting: ListedMeeting, detail: MeetingDetail | undefined, transcript: string | undefined): string {
    const participants = (detail?.participants || meeting.participants || '').trim();
    const summary = (detail?.summary || '').trim();
    const sections = [
      [
        `Meeting: ${meeting.title}`,
        meeting.occurredAt ? `Date: ${meeting.occurredAt}` : '',
        participants ? `Participants: ${participants}` : '',
      ].filter((line) => line !== '').join('\n'),
    ];
    if ((this.mode === 'summary' || this.mode === 'both') && summary) {
      sections.push(summary);
    }
    if ((this.mode === 'transcript' || this.mode === 'both') && transcript && transcript.trim()) {
      sections.push(`Transcript:\n${transcript.trim()}`);
    }
    return sections.join('\n\n').slice(0, this.contentLimit);
  }

  private async callText(slug: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.bridge.executeTool(slug, args, { recordUsage: false });
    if (res.error) {
      throw new Error(`${slug} failed: ${res.error}`);
    }
    return extractMcpText(res.data);
  }
}

/** Pull the concatenated text out of an MCP-style { data: [{ type, text }] } payload. */
export function extractMcpText(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const blocks = (data as { data?: unknown }).data;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((block) => (block && typeof block === 'object' ? asString((block as { text?: unknown }).text) : ''))
    .filter((text) => text !== '')
    .join('\n');
}

/** The transcript blob is JSON: { id, title, transcript }. Returns the transcript string, '' if absent/garbled. */
export function parseTranscript(text: string): string {
  if (!text) return '';
  try {
    const parsed = JSON.parse(text) as { transcript?: unknown };
    return typeof parsed.transcript === 'string' ? parsed.transcript : '';
  } catch {
    return '';
  }
}

export function parseMeetingList(text: string): ListedMeeting[] {
  const fallbackDate = parseDateMs(matchGroup(text, /<meetings_data\b[^>]*\bto="([^"]*)"/));

  const out: ListedMeeting[] = [];
  for (const block of meetingBlocks(text)) {
    const id = attr(block.attrs, 'id');
    if (!id) continue;

    const dateMs = parseDateMs(attr(block.attrs, 'date')) ?? fallbackDate;
    if (dateMs === null) continue;

    out.push({
      id,
      title: decodeXml(attr(block.attrs, 'title')) || '(untitled meeting)',
      dateMs,
      occurredAt: new Date(dateMs).toISOString(),
      participants: extractTag(block.inner, 'known_participants'),
    });
  }
  return out;
}

export function parseMeetingDetails(text: string): Map<string, MeetingDetail> {
  const map = new Map<string, MeetingDetail>();
  for (const block of meetingBlocks(text)) {
    const id = attr(block.attrs, 'id');
    if (!id) continue;
    map.set(id, {
      summary: extractTag(block.inner, 'summary'),
      participants: extractTag(block.inner, 'known_participants'),
    });
  }
  return map;
}

function meetingBlocks(text: string): Array<{ attrs: string; inner: string }> {
  const out: Array<{ attrs: string; inner: string }> = [];
  const re = /<meeting\b([^>]*)>([\s\S]*?)<\/meeting>/g;
  for (const m of text.matchAll(re)) {
    out.push({ attrs: m[1] ?? '', inner: m[2] ?? '' });
  }
  return out;
}

function attr(attrs: string, name: string): string {
  return matchGroup(attrs, new RegExp(`\\b${name}="([^"]*)"`));
}

function extractTag(inner: string, tag: string): string {
  return matchGroup(inner, new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)).trim();
}

function matchGroup(text: string, re: RegExp): string {
  const m = text.match(re);
  return m && typeof m[1] === 'string' ? m[1] : '';
}

function parseDateMs(value: string): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
