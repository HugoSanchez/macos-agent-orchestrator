import {
  asString,
  type IngestionBridge,
  type IngestionFetchResult,
  type IngestionItem,
  type SourceAdapter,
} from '../ingestion-source.ts';
import { identityUserDirectory, type SlackUserDirectory } from './slack-users.ts';
import { emptyConversationDirectory, type SlackConversationDirectory } from './slack-conversations.ts';

const SLACK_SEARCH_MESSAGES = 'SLACK_SEARCH_MESSAGES';
const DEFAULT_CONTENT_LIMIT = 4000;
const PAGE_SIZE = 100; // Slack search max per page
// Pages walked in a single fetch. A larger backlog isn't dropped — we carry
// Slack's cursor-mark forward (see SlackCursor.c) so the next tick resumes
// exactly where this one stopped, draining across ticks without re-scanning.
const MAX_PAGES = 20;
// Slack ingests "what's new", not history — one day of backfill on first enable.
const SEED_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Slack ingestion is search-based and single-stream: `search.messages
 * after:<date>` returns recent activity across ALL the user's channels and DMs
 * at once — far cheaper than polling each conversation.
 *
 * `after:` is date-granular and results come back oldest-first, so a busy day
 * can have thousands of already-processed messages before the first new one.
 * Rather than re-scan that prefix from the start every run (which a page cap
 * would strand us in), we paginate with Slack's cursor-mark and CARRY THE
 * CURSOR across runs: when a fetch stops mid-prefix at the page cap it reports
 * hasMore and stores the cursor, and the next tick resumes from there. The
 * watermark (w) only advances over messages we actually ingest, so it never
 * moves backward past unprocessed history. Once we reach the end of results we
 * drop the cursor and re-anchor the query at the watermark's day, keeping the
 * steady-state scan small.
 */
interface SlackCursor {
  /** Watermark: ts of the newest ingested message (dedup floor + fresh-start anchor). */
  w: string;
  /** after:<date> the in-flight pagination belongs to; held fixed while resuming. */
  a: string | null;
  /** Slack cursor-mark to resume an in-progress drain, or null when caught up. */
  c: string | null;
}

/** A single accepted Slack message, parsed but not yet name-resolved or grouped. */
interface ParsedSlackMessage {
  channelId: string;
  label: string;
  isIm: boolean;
  ts: string;
  tsNum: number;
  userId: string;
  text: string;
  occurredAt: string;
}

export class SlackSource implements SourceAdapter {
  readonly source = 'slack';
  readonly displayName = 'Slack';
  readonly logoUrl = 'https://logos.composio.dev/api/slack';
  readonly defaultStream = '';
  readonly seedLookbackMs = SEED_LOOKBACK_MS;

  private readonly contentLimit: number;
  private readonly userDirectory: SlackUserDirectory;
  private readonly conversationDirectory: SlackConversationDirectory;

  constructor(
    private readonly bridge: IngestionBridge,
    opts: {
      contentLimit?: number;
      userDirectory?: SlackUserDirectory;
      conversationDirectory?: SlackConversationDirectory;
    } = {},
  ) {
    this.contentLimit = opts.contentLimit ?? DEFAULT_CONTENT_LIMIT;
    // Default to identity/empty (raw ids, bare "DM") so the adapter works
    // standalone; the server wires Composio-backed directories that resolve ids
    // to display names and DMs to their peer.
    this.userDirectory = opts.userDirectory ?? identityUserDirectory;
    this.conversationDirectory = opts.conversationDirectory ?? emptyConversationDirectory;
  }

  seedCursor(now: Date, lookbackMs: number): string {
    const seconds = Math.max(0, Math.floor((now.getTime() - lookbackMs) / 1000));
    return `${seconds}.000000`;
  }

  async fetchSince(_stream: string, cursorStr: string, opts: { maxItems: number }): Promise<IngestionFetchResult> {
    const { w, a, c } = parseSlackCursor(cursorStr);
    const parsed = Number(w);
    const watermark = Number.isFinite(parsed) ? parsed : 0;
    // One day back so the date-granular filter never drops boundary messages;
    // held fixed (stored in `a`) while resuming a drain so the cursor stays valid.
    const afterDate = c ? (a ?? ymd((watermark - 86_400) * 1000)) : ymd((watermark - 86_400) * 1000);

    const collected: ParsedSlackMessage[] = [];
    // Newest ts examined at/above the watermark — including skipped messages — so
    // a window of only skipped messages still moves the cursor forward. Never
    // advanced for below-watermark messages (that would move the cursor back).
    let lastSeenTs = w;
    let lastSeenNum = watermark;
    let slackCursor = c || '*';
    let resumeCursor = slackCursor; // cursor to carry if we stop before the end
    let truncated = false; // hit maxItems (more accepted messages remain)
    let exhausted = false; // reached the last page of results

    for (let page = 0; page < MAX_PAGES; page++) {
      const usedCursor = slackCursor;
      const res = await this.bridge.executeTool(
        SLACK_SEARCH_MESSAGES,
        { query: `after:${afterDate}`, sort: 'timestamp', sort_dir: 'asc', count: PAGE_SIZE, cursor: usedCursor },
        { recordUsage: false },
      );
      if (res.error) {
        throw new Error(`SLACK_SEARCH_MESSAGES failed: ${res.error}`);
      }

      const matches = extractMatches(res.data);
      const nextCur = extractNextCursor(res.data);
      for (const raw of matches) {
        const msg = parseMessage(raw);
        if (!msg) {
          const ts = asString((raw as { ts?: unknown })?.ts);
          const n = Number(ts);
          if (ts && Number.isFinite(n) && n > lastSeenNum) {
            lastSeenNum = n;
            lastSeenTs = ts;
          }
          continue;
        }
        if (msg.tsNum < watermark) continue; // already processed
        if (collected.length >= opts.maxItems) {
          truncated = true;
          break;
        }
        collected.push(msg);
        if (msg.tsNum > lastSeenNum) {
          lastSeenNum = msg.tsNum;
          lastSeenTs = msg.ts;
        }
      }

      if (truncated) {
        resumeCursor = usedCursor; // re-fetch this page next run; the taken items fall below the watermark
        break;
      }
      if (matches.length < PAGE_SIZE || !nextCur) {
        exhausted = true;
        break;
      }
      slackCursor = nextCur;
      resumeCursor = nextCur; // if we stop at the page cap, resume from the next page
    }

    const items = await this.buildItems(collected);
    const hasMore = !exhausted;
    const nextCursor = exhausted
      ? serializeSlackCursor({ w: lastSeenTs, a: null, c: null }) // caught up: re-anchor next run
      : serializeSlackCursor({ w: lastSeenTs, a: afterDate, c: resumeCursor }); // resume the drain

    return { items, nextCursor, hasMore };
  }

  /**
   * Turn accepted messages into ingestion items. Each message becomes one line
   * in a per-(channel, day) document (`merge: true`): search gives us no
   * thread_ts to group true threads, so a channel's day is the coherent unit
   * the store accumulates as replies arrive. `dedupRef` is the globally-unique
   * channel+ts so every message re-enters exactly once and appends; `sourceRef`
   * is the day bucket so they all land in — and upsert-merge into — one row.
   * User ids are resolved to display names here (best-effort; falls back to ids).
   */
  private async buildItems(messages: ParsedSlackMessage[]): Promise<IngestionItem[]> {
    if (messages.length === 0) return [];

    // Map each DM channel to its peer so the title reads "DM with Alice".
    const imChannels = new Set<string>();
    for (const m of messages) {
      if (m.isIm) imChannels.add(m.channelId);
    }
    const peers = await this.conversationDirectory.peerIds(imChannels);

    // Resolve author ids, mention ids, and DM peer ids in one pass.
    const ids = new Set<string>();
    for (const m of messages) {
      ids.add(m.userId);
      for (const id of mentionIds(m.text)) ids.add(id);
    }
    for (const peer of peers.values()) ids.add(peer);
    const names = await this.userDirectory.resolve(ids);

    return messages.map((m) => {
      const author = names.get(m.userId) ?? m.userId;
      const text = replaceMentions(m.text, names);
      const day = m.occurredAt.slice(0, 10) || 'undated';
      const time = m.occurredAt.slice(11, 16) || '??:??';
      return {
        sourceRef: `${m.channelId}#${day}`,
        dedupRef: `${m.channelId}.${m.ts}`,
        cursorValue: m.tsNum,
        occurredAt: m.occurredAt,
        title: `${labelFor(m, peers, names)} ${day}`.trim(),
        content: `[${time}] ${author}: ${text}`.slice(0, this.contentLimit),
        merge: true,
      };
    });
  }
}

function parseMessage(raw: unknown): ParsedSlackMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.subtype) return null; // skip join/leave/bot/system messages

  const ts = asString(m.ts);
  const text = asString(m.text);
  if (!ts || !text) return null;

  const channel = (m.channel && typeof m.channel === 'object' ? m.channel : {}) as Record<string, unknown>;
  const channelId = asString(channel.id);
  if (!channelId) return null;

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return null;
  const occurredAt = new Date(tsNum * 1000).toISOString();
  const isIm = channel.is_im === true;
  const label = isIm
    ? 'DM'
    : channel.is_mpim
      ? 'Group DM'
      : `#${asString(channel.name) || channelId}`;
  const userId = asString(m.user) || asString(m.username) || 'unknown';

  return { channelId, label, isIm, ts, tsNum, userId, text, occurredAt };
}

/** DM title becomes "DM with <peer>" when the peer resolves to a real name; otherwise the base label. */
function labelFor(
  m: ParsedSlackMessage,
  peers: Map<string, string>,
  names: Map<string, string>,
): string {
  if (!m.isIm) return m.label;
  const peerId = peers.get(m.channelId);
  const peerName = peerId ? names.get(peerId) : undefined;
  return peerName && peerName !== peerId ? `DM with ${peerName}` : m.label;
}

// Slack wraps user mentions as <@U0A4NP3GTHU> or <@U0A4NP3GTHU|handle>.
const MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

function mentionIds(text: string): string[] {
  return [...text.matchAll(MENTION_RE)].map((match) => match[1]);
}

function replaceMentions(text: string, names: Map<string, string>): string {
  return text.replace(MENTION_RE, (_full, id: string) => `@${names.get(id) ?? id}`);
}

/** Tolerates the JSON cursor and a bare ts (seedCursor output / legacy rows). */
export function parseSlackCursor(str: string): SlackCursor {
  if (!str) return { w: '0', a: null, c: null };
  try {
    const o = JSON.parse(str) as unknown;
    if (o && typeof o === 'object' && typeof (o as SlackCursor).w === 'string') {
      const cur = o as Record<string, unknown>;
      return {
        w: cur.w as string,
        a: typeof cur.a === 'string' ? cur.a : null,
        c: typeof cur.c === 'string' ? cur.c : null,
      };
    }
  } catch {
    // not JSON — fall through to the bare-ts form
  }
  return { w: str, a: null, c: null };
}

function serializeSlackCursor(cursor: SlackCursor): string {
  return JSON.stringify(cursor);
}

/** Slack search nests matches under data.messages.matches; tolerate flattened shapes too. */
export function extractMatches(data: unknown): unknown[] {
  if (!data || typeof data !== 'object') return [];
  const d = data as { messages?: unknown; matches?: unknown };
  const messages = d.messages && typeof d.messages === 'object' ? (d.messages as { matches?: unknown }) : null;
  const matches = messages?.matches ?? d.matches;
  return Array.isArray(matches) ? matches : [];
}

/** Slack returns the cursor-mark for the next page at data.messages.paging.next_cursor. */
export function extractNextCursor(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const messages = (data as { messages?: unknown }).messages;
  const paging = messages && typeof messages === 'object' ? (messages as { paging?: unknown }).paging : null;
  const next = paging && typeof paging === 'object' ? (paging as { next_cursor?: unknown }).next_cursor : null;
  return typeof next === 'string' && next.length > 0 ? next : null;
}

function ymd(ms: number): string {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : '1970-01-01';
}
