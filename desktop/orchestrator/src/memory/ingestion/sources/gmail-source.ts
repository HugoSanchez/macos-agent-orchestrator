import {
  asString,
  type IngestionBridge,
  type IngestionFetchResult,
  type IngestionItem,
  type SourceAdapter,
} from '../ingestion-source.ts';

const GMAIL_FETCH_EMAILS = 'GMAIL_FETCH_EMAILS';

// v1 hardcoded filter: the inbox minus the obvious noise buckets. A
// user-configurable filter (preset checkboxes) is a later phase.
const V1_QUERY_FILTER = 'in:inbox -category:promotions -category:social';

const DEFAULT_CONTENT_LIMIT = 6000;

/**
 * Gmail cursor. Gmail's messages.list paginates NEWEST-first, so a single
 * `after:<watermark>` query returns the newest matches first and `nextPageToken`
 * points at OLDER matches. Advancing the watermark to a page's max timestamp
 * would skip everything still behind the token, so the cursor is two-part:
 *   - `w`   committed watermark (epoch ms): everything at/below here is synced.
 *   - `p`   page token for an in-progress drain of `after:w` (null = not mid-drain).
 *   - `max` newest timestamp seen so far in the in-progress drain.
 * The watermark only advances once a drain exhausts its page tokens — so no
 * older message is ever skipped.
 */
export interface GmailCursor {
  w: number;
  p: string | null;
  max: number;
}

export function parseGmailCursor(cursor: string): GmailCursor {
  try {
    const parsed = JSON.parse(cursor) as Partial<GmailCursor>;
    if (parsed && typeof parsed === 'object' && typeof parsed.w === 'number') {
      return {
        w: parsed.w,
        p: typeof parsed.p === 'string' && parsed.p ? parsed.p : null,
        max: typeof parsed.max === 'number' ? parsed.max : parsed.w,
      };
    }
  } catch {
    // Fall through: a bare numeric string is treated as a watermark.
  }
  const n = Number(cursor);
  const w = Number.isFinite(n) ? n : 0;
  return { w, p: null, max: w };
}

export class GmailSource implements SourceAdapter {
  readonly source = 'gmail';
  readonly displayName = 'Gmail';
  readonly logoUrl = 'https://logos.composio.dev/api/gmail';
  readonly defaultStream = '';

  constructor(
    private readonly bridge: IngestionBridge,
    private readonly contentLimit = DEFAULT_CONTENT_LIMIT,
  ) {}

  seedCursor(now: Date, lookbackMs: number): string {
    const w = Math.max(0, now.getTime() - lookbackMs);
    return JSON.stringify({ w, p: null, max: w } satisfies GmailCursor);
  }

  async fetchSince(_stream: string, cursor: string, opts: { maxItems: number }): Promise<IngestionFetchResult> {
    const cur = parseGmailCursor(cursor);
    const afterSeconds = Math.floor(cur.w / 1000);
    const query = `after:${afterSeconds} ${V1_QUERY_FILTER}`;

    const res = await this.bridge.executeTool(
      GMAIL_FETCH_EMAILS,
      {
        query,
        max_results: opts.maxItems,
        include_payload: false,
        // verbose:true = detailed fetch that returns the message body
        // (messageText). verbose:false is faster but metadata-only, which
        // leaves the body empty — useless for extraction.
        verbose: true,
        ...(cur.p ? { page_token: cur.p } : {}),
      },
      { recordUsage: false },
    );
    if (res.error) {
      throw new Error(`GMAIL_FETCH_EMAILS failed: ${res.error}`);
    }

    const data = (res.data ?? {}) as { messages?: unknown; nextPageToken?: unknown };
    const rawMessages = Array.isArray(data.messages) ? data.messages : [];

    const items: IngestionItem[] = [];
    for (const raw of rawMessages) {
      const item = this.toItem(raw);
      if (item) items.push(item);
    }
    // Response array is not recency-sorted; sort ascending for stable processing.
    items.sort((a, b) => a.cursorValue - b.cursorValue);

    const pageMax = items.reduce((acc, item) => Math.max(acc, item.cursorValue), cur.max);
    const nextPageToken = typeof data.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : null;

    let nextCursor: GmailCursor;
    let hasMore: boolean;
    if (nextPageToken) {
      // More (older) pages of the same query remain — keep the watermark put,
      // carry the token. Advancing `w` here would skip the unseen older items.
      nextCursor = { w: cur.w, p: nextPageToken, max: pageMax };
      hasMore = true;
    } else {
      // Drain complete: every message after `w` has been seen. Now it is safe
      // to advance the watermark to the newest message in the whole drain.
      const newW = Math.max(pageMax, cur.w);
      nextCursor = { w: newW, p: null, max: newW };
      hasMore = false;
    }

    return { items, nextCursor: JSON.stringify(nextCursor), hasMore };
  }

  private toItem(raw: unknown): IngestionItem | null {
    if (!raw || typeof raw !== 'object') return null;
    const m = raw as Record<string, unknown>;

    const sourceRef = asString(m.messageId);
    if (!sourceRef) return null; // tool docs: messageId may be absent — null-check.

    const parsed = Date.parse(asString(m.messageTimestamp));
    const cursorValue = Number.isFinite(parsed) ? parsed : 0;
    const occurredAt = Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';

    const preview = (m.preview && typeof m.preview === 'object' ? m.preview : {}) as Record<string, unknown>;
    const subject = asString(m.subject) || asString(preview.subject) || '(no subject)';
    const from = asString(m.sender);
    const to = asString(m.to);
    const body = (asString(m.messageText) || asString(preview.body)).slice(0, this.contentLimit);

    const header = [
      `Subject: ${subject}`,
      from ? `From: ${from}` : '',
      to ? `To: ${to}` : '',
      occurredAt ? `Date: ${occurredAt}` : '',
    ].filter((line) => line !== '').join('\n');
    const content = body ? `${header}\n\n${body}` : header;

    return { sourceRef, cursorValue, occurredAt, content };
  }
}
