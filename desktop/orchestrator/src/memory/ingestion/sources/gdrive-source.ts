import {
  asString,
  type IngestionBridge,
  type IngestionFetchResult,
  type IngestionItem,
  type SourceAdapter,
} from '../ingestion-source.ts';

// Verified against the live Composio schemas (2026-07-06):
//  - GOOGLEDRIVE_FIND_FILE: full Drive `q` syntax, `orderBy: 'modifiedTime'`
//    (ascending), pageSize/pageToken; files come back with id, name, mimeType,
//    modifiedTime (ISO ms), trashed, webViewLink.
//  - GOOGLEDRIVE_DOWNLOAD_FILE: returns `downloaded_file_content.s3url` — a
//    short-lived presigned URL, NOT inline text. With `mime_type: 'text/plain'`
//    it exports Google Docs server-side (`export_applied: true`), so a plain
//    GET on the URL yields the document text. This keeps content fetching
//    inside the googledrive toolkit — no googledocs connection required.
const GDRIVE_FIND_FILE = 'GOOGLEDRIVE_FIND_FILE';
const GDRIVE_DOWNLOAD_FILE = 'GOOGLEDRIVE_DOWNLOAD_FILE';

const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
// v1 whitelist: Google Docs plus plain-text/markdown files. No Sheets/Slides/
// PDF/images — their exports are noisy or need format-specific handling.
const TEXT_MIMES = ['text/plain', 'text/markdown'];

const DEFAULT_CONTENT_LIMIT = 40_000; // Granola transcript precedent
const DOWNLOAD_TIMEOUT_MS = 30_000;
const SEED_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

export function gdriveContentLimitFromEnv(): number {
  const raw = process.env.VERSO_GDRIVE_CONTENT_LIMIT?.trim();
  if (!raw) return DEFAULT_CONTENT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONTENT_LIMIT;
}

/** Fetches a presigned download URL and returns its text. Injectable for tests. */
export type UrlTextFetcher = (url: string) => Promise<string>;

const defaultFetchText: UrlTextFetcher = async (url) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`download fetch failed: HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
};

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedMs: number;
  occurredAt: string;
  webViewLink: string;
}

/**
 * Google Drive adapter. Cursor is a plain epoch-ms watermark over
 * `modifiedTime`: Drive lists ascending, so each page advances the watermark
 * to its newest file and the next tick re-queries from there — no page-token
 * state to persist or expire. An edit bumps `modifiedTime`, re-enters the
 * query window, and (via `dedupRef = id:modifiedTime`) passes scheduler dedup
 * while upserting over the same memory row — the index always holds the
 * latest fetched version, stale by at most one polling interval.
 *
 * The watermark boundary is queried with `>=` truncated to whole seconds
 * (Drive query timestamps are second-granular), so files sharing the
 * boundary second are re-fetched and rely on dedup — nothing can slip
 * through the gap.
 *
 * Known v1 limitations (accepted): deletions/trash don't propagate (the last
 * indexed version stays, same as Gmail); metadata-only renames may not bump
 * modifiedTime, so titles can lag until the next content edit.
 */
export class GdriveSource implements SourceAdapter {
  readonly source = 'gdrive';
  readonly displayName = 'Google Drive';
  readonly logoUrl = 'https://logos.composio.dev/api/googledrive';
  readonly defaultStream = '';
  readonly maxItemsPerBatch = 5;
  readonly seedLookbackMs = SEED_LOOKBACK_MS;

  private readonly contentLimit: number;
  private readonly fetchText: UrlTextFetcher;

  constructor(
    private readonly bridge: IngestionBridge,
    opts: { contentLimit?: number; fetchText?: UrlTextFetcher } = {},
  ) {
    this.contentLimit = opts.contentLimit ?? gdriveContentLimitFromEnv();
    this.fetchText = opts.fetchText ?? defaultFetchText;
  }

  seedCursor(now: Date, lookbackMs: number): string {
    return String(Math.max(0, now.getTime() - lookbackMs));
  }

  async fetchSince(_stream: string, cursor: string, opts: { maxItems: number }): Promise<IngestionFetchResult> {
    const parsed = Number(cursor);
    const watermark = Number.isFinite(parsed) ? parsed : 0;
    // Second-truncated `>=` boundary: truncation loses ≤999ms, so any file
    // newer than the watermark still matches; re-fetched boundary files are
    // absorbed by dedup.
    const boundaryIso = new Date(Math.floor(watermark / 1000) * 1000).toISOString();
    const mimeClause = [GOOGLE_DOC_MIME, ...TEXT_MIMES]
      .map((mime) => `mimeType = '${mime}'`)
      .join(' or ');

    const res = await this.bridge.executeTool(
      GDRIVE_FIND_FILE,
      {
        q: `(${mimeClause}) and trashed = false and modifiedTime >= '${boundaryIso}'`,
        orderBy: 'modifiedTime',
        pageSize: opts.maxItems,
      },
      { recordUsage: false },
    );
    if (res.error) {
      throw new Error(`${GDRIVE_FIND_FILE} failed: ${res.error}`);
    }

    const data = (res.data ?? {}) as { files?: unknown; nextPageToken?: unknown };
    const files = (Array.isArray(data.files) ? data.files : [])
      .map((raw) => toDriveFile(raw))
      .filter((file): file is DriveFile => file !== null)
      .sort((a, b) => a.modifiedMs - b.modifiedMs);

    const items: IngestionItem[] = [];
    for (const file of files) {
      items.push({
        sourceRef: file.id,
        dedupRef: `${file.id}:${file.modifiedMs}`,
        cursorValue: file.modifiedMs,
        occurredAt: file.occurredAt,
        title: file.name,
        content: await this.buildContent(file),
      });
    }

    const nextCursor = files.length > 0 ? String(files[files.length - 1].modifiedMs) : cursor;
    const hasMore = typeof data.nextPageToken === 'string' && data.nextPageToken !== '';
    return { items, nextCursor, hasMore };
  }

  private async buildContent(file: DriveFile): Promise<string> {
    const header = [
      `Document: ${file.name}`,
      `Modified: ${file.occurredAt}`,
      file.webViewLink ? `Link: ${file.webViewLink}` : '',
    ].filter((line) => line !== '').join('\n');

    // A single unreadable file (permissions, export failure, expired URL)
    // must not fail — and eventually poison — the whole batch: fall back to
    // indexing the header alone.
    let body = '';
    try {
      body = await this.downloadText(file);
    } catch (error: unknown) {
      console.warn(`[ingest] gdrive content fetch failed for ${file.id} (${file.name}): ${error instanceof Error ? error.message : String(error)}`);
    }
    const content = body ? `${header}\n\n${body}` : header;
    return content.slice(0, this.contentLimit);
  }

  private async downloadText(file: DriveFile): Promise<string> {
    const res = await this.bridge.executeTool(
      GDRIVE_DOWNLOAD_FILE,
      {
        fileId: file.id,
        // Export only applies to Google Workspace docs; regular text files
        // download as-is and the param is ignored upstream.
        ...(file.mimeType === GOOGLE_DOC_MIME ? { mime_type: 'text/plain' } : {}),
      },
      { recordUsage: false },
    );
    if (res.error) {
      throw new Error(`${GDRIVE_DOWNLOAD_FILE} failed: ${res.error}`);
    }
    const payload = (res.data ?? {}) as { downloaded_file_content?: { s3url?: unknown } };
    const url = asString(payload.downloaded_file_content?.s3url);
    if (!url) {
      throw new Error(`${GDRIVE_DOWNLOAD_FILE} returned no download URL`);
    }
    // Exported text arrives with a UTF-8 BOM; strip it.
    return (await this.fetchText(url)).replace(/^﻿/, '').trim();
  }
}

function toDriveFile(raw: unknown): DriveFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;

  const id = asString(f.id);
  const mimeType = asString(f.mimeType);
  if (!id || f.trashed === true) return null;
  // Defensive re-filter in case the query returns more than the whitelist.
  if (mimeType !== GOOGLE_DOC_MIME && !TEXT_MIMES.includes(mimeType)) return null;

  const modifiedMs = Date.parse(asString(f.modifiedTime));
  if (!Number.isFinite(modifiedMs)) return null;

  return {
    id,
    name: asString(f.name) || '(untitled)',
    mimeType,
    modifiedMs,
    occurredAt: new Date(modifiedMs).toISOString(),
    webViewLink: asString(f.webViewLink),
  };
}
