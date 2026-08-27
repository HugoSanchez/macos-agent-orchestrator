import { createHash } from 'node:crypto';
import { MAX_DOCUMENT_BYTES } from '../../../chat/attachments.ts';
import { convertDocumentToMarkdown } from '../../../chat/document-conversion.ts';
import {
  asString,
  type IngestionBridge,
  type IngestionFetchResult,
  type IngestionItem,
  type SourceAdapter,
} from '../ingestion-source.ts';

const LIST_CHANGES = 'ONE_DRIVE_LIST_ROOT_DRIVE_CHANGES';
const LIST_SHARED = 'ONE_DRIVE_LIST_ONEDRIVE_SHARED_ITEMS';
const DOWNLOAD_FILE = 'ONE_DRIVE_DOWNLOAD_FILE';

const MAX_BATCH_SIZE = 5;
const DEFAULT_CONTENT_LIMIT = 40_000;
const SEED_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CURSOR_LENGTH = 64 * 1024;
const MAX_TOKEN_LENGTH = 16 * 1024;
const MAX_SHARED_OFFSET = 10_000_000;
const MAX_PROVIDER_PAGE_ITEMS = 500;
const MAX_PAGE_ITEM_KEY_LENGTH = 512;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const DRIVE_FIELDS = [
  'id',
  'name',
  'file',
  'folder',
  'deleted',
  'lastModifiedDateTime',
  'webUrl',
  'eTag',
  'cTag',
  'parentReference',
  'size',
];
const DRIVE_SELECT = DRIVE_FIELDS.join(',');

const TEXT_MIMES = new Set(['text/plain', 'text/markdown']);
const WORD_MIMES = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown']);
const WORD_EXTENSIONS = new Set(['doc', 'docx']);

type Phase = 'primary' | 'shared';

export interface OneDriveCursorV1 {
  v: 1;
  phase: Phase;
  token: string | null;
  floor: string;
  initial: boolean;
  resync: boolean;
  sharedFrom: number;
  consumedPageIds: string[];
}

interface DriveItem {
  id: string;
  driveId: string;
  name: string;
  kind: 'text' | 'word';
  version: string;
  modifiedMs: number;
  occurredAt: string;
  webUrl: string;
}

interface ProviderPage {
  items: unknown[];
  nextLink: string | null;
  deltaLink: string | null;
}

interface DrainedPage {
  items: IngestionItem[];
  complete: boolean;
}

type OneDriveByteFetcher = (url: string) => Promise<Buffer>;
type OneDriveDocumentConverter = (bytes: Buffer) => Promise<string>;

export const fetchOneDriveBytes: OneDriveByteFetcher = async (url) => {
  assertHttpsUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`);
    assertHttpUrl(response.url || url);

    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null) {
      const bytes = Number(declaredLength);
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('download returned an invalid size');
      if (bytes > MAX_DOCUMENT_BYTES) throw new Error('download exceeds the 10 MiB limit');
    }

    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_DOCUMENT_BYTES) {
        controller.abort();
        await reader.cancel().catch(() => undefined);
        throw new Error('download exceeds the 10 MiB limit');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, length);
  } finally {
    clearTimeout(timeout);
  }
};

export class OneDriveSource implements SourceAdapter {
  readonly source = 'onedrive';
  readonly displayName = 'OneDrive';
  readonly logoUrl = 'https://logos.composio.dev/api/one_drive';
  readonly defaultStream = '';
  readonly maxItemsPerBatch = MAX_BATCH_SIZE;
  readonly seedLookbackMs = SEED_LOOKBACK_MS;

  private readonly contentLimit: number;
  private readonly fetchBytes: OneDriveByteFetcher;
  private readonly convertDocument: OneDriveDocumentConverter;

  constructor(
    private readonly bridge: IngestionBridge,
    opts: {
      contentLimit?: number;
      fetchBytes?: OneDriveByteFetcher;
      convertDocument?: OneDriveDocumentConverter;
    } = {},
  ) {
    this.contentLimit = opts.contentLimit ?? DEFAULT_CONTENT_LIMIT;
    this.fetchBytes = opts.fetchBytes ?? fetchOneDriveBytes;
    this.convertDocument = opts.convertDocument
      ?? ((bytes) => convertDocumentToMarkdown(bytes.toString('base64')));
  }

  seedCursor(now: Date, lookbackMs: number): string {
    return serializeCursor({
      v: 1,
      phase: 'primary',
      token: null,
      floor: new Date(Math.max(0, now.getTime() - lookbackMs)).toISOString(),
      initial: true,
      resync: false,
      sharedFrom: 0,
      consumedPageIds: [],
    });
  }

  async fetchSince(_stream: string, cursorString: string, opts: { maxItems: number }): Promise<IngestionFetchResult> {
    const cursor = parseCursor(cursorString);
    const requested = Math.trunc(opts.maxItems);
    if (!Number.isSafeInteger(requested) || requested < 1) throw new Error('Invalid OneDrive batch size');
    const limit = Math.min(MAX_BATCH_SIZE, requested);
    return cursor.phase === 'primary'
      ? this.fetchPrimary(cursor, limit)
      : this.fetchShared(cursor, limit);
  }

  private async fetchPrimary(cursor: OneDriveCursorV1, limit: number): Promise<IngestionFetchResult> {
    let response: Awaited<ReturnType<IngestionBridge['executeTool']>>;
    try {
      response = await this.bridge.executeTool(LIST_CHANGES, {
        top: limit,
        select: DRIVE_SELECT,
        ...(cursor.token ? { token: cursor.token } : {}),
      }, { recordUsage: false });
    } catch (error: unknown) {
      if (cursor.token && isExpiredDeltaError(error)) return resetExpiredCursor(cursor);
      throw new Error(`${LIST_CHANGES} failed: ${safeError(error)}`);
    }
    if (response.error) {
      if (cursor.token && isExpiredDeltaError(response.error)) return resetExpiredCursor(cursor);
      throw new Error(`${LIST_CHANGES} failed: ${safeError(response.error)}`);
    }

    const page = extractPrimaryPage(response.data);
    const drained = await this.drainPage(page.items, cursor, limit);
    if (!drained.complete) return result(drained.items, cursor, true);

    if (page.nextLink) {
      cursor.token = page.nextLink;
      return result(drained.items, cursor, true);
    }
    if (!page.deltaLink) throw new Error(`${LIST_CHANGES} returned no continuation or delta link`);
    cursor.token = page.deltaLink;
    cursor.phase = 'shared';
    cursor.sharedFrom = 0;
    return result(drained.items, cursor, true);
  }

  private async fetchShared(cursor: OneDriveCursorV1, limit: number): Promise<IngestionFetchResult> {
    let response: Awaited<ReturnType<IngestionBridge['executeTool']>>;
    try {
      response = await this.bridge.executeTool(LIST_SHARED, {
        from: cursor.sharedFrom,
        size: limit,
        fields: DRIVE_FIELDS,
      }, { recordUsage: false });
    } catch (error: unknown) {
      if (isUnsupportedMsaSharedSearch(error)) return completeSharedPhase(cursor, []);
      throw new Error(`${LIST_SHARED} failed: ${safeError(error)}`);
    }
    if (response.error) {
      if (isUnsupportedMsaSharedSearch(response.error)) return completeSharedPhase(cursor, []);
      throw new Error(`${LIST_SHARED} failed: ${safeError(response.error)}`);
    }

    const rawItems = extractSharedItems(response.data);
    const drained = await this.drainPage(rawItems, cursor, limit);
    if (!drained.complete) return result(drained.items, cursor, true);

    if (rawItems.length >= limit) {
      cursor.sharedFrom += rawItems.length;
      assertCursor(cursor);
      return result(drained.items, cursor, true);
    }

    return completeSharedPhase(cursor, drained.items);
  }

  private async drainPage(rawItems: unknown[], cursor: OneDriveCursorV1, limit: number): Promise<DrainedPage> {
    const pending = pendingPageItems(rawItems, cursor.consumedPageIds);
    const batch = pending.slice(0, limit);
    cursor.consumedPageIds.push(...batch.map(({ key }) => key));
    const items = await this.toIngestionItems(batch.map(({ raw }) => raw), cursor);
    const complete = pending.length === batch.length;
    if (complete) cursor.consumedPageIds = [];
    return { items, complete };
  }

  private async toIngestionItems(rawItems: unknown[], cursor: OneDriveCursorV1): Promise<IngestionItem[]> {
    const floorMs = Date.parse(cursor.floor);
    const applyFloor = cursor.initial && !cursor.resync;
    const files = rawItems
      .map(toDriveItem)
      .filter((file): file is DriveItem => file !== null && (!applyFloor || file.modifiedMs >= floorMs))
      .sort((a, b) => a.modifiedMs - b.modifiedMs || a.id.localeCompare(b.id));

    return Promise.all(files.map(async (file) => {
      const sourceRef = `${file.driveId}:${file.id}`;
      return {
        sourceRef,
        dedupRef: `${sourceRef}:${file.version}`,
        cursorValue: file.modifiedMs,
        occurredAt: file.occurredAt,
        title: file.name,
        content: await this.buildContent(file),
      };
    }));
  }

  private async buildContent(file: DriveItem): Promise<string> {
    const header = [
      `Document: ${file.name}`,
      `Modified: ${file.occurredAt}`,
      file.webUrl ? `Link: ${file.webUrl}` : '',
    ].filter(Boolean).join('\n');

    let body = '';
    try {
      const bytes = await this.download(file);
      body = file.kind === 'word'
        ? await this.convertDocument(bytes)
        : bytes.toString('utf8').replace(/^﻿/, '').trim();
    } catch (error: unknown) {
      console.warn(`[ingest] onedrive content fetch failed for ${file.driveId}:${file.id}: ${safeError(error)}`);
    }
    return (body ? `${header}\n\n${body}` : header).slice(0, this.contentLimit);
  }

  private async download(file: DriveItem): Promise<Buffer> {
    const response = await this.bridge.executeTool(DOWNLOAD_FILE, {
      item_id: file.id,
      file_name: file.name,
      user_id: 'me',
      drive_id: file.driveId,
    }, { recordUsage: false });
    if (response.error) throw new Error(`${DOWNLOAD_FILE} failed: ${safeError(response.error)}`);
    const url = extractDownloadUrl(response.data);
    if (!url) throw new Error(`${DOWNLOAD_FILE} returned no supported download URL`);
    return this.fetchBytes(url);
  }
}

function toDriveItem(raw: unknown): DriveItem | null {
  const value = unwrapDriveItem(raw);
  if (!value) return null;
  if (value.deleted || value.folder || !isRecord(value.file)) return null;

  const id = asString(value.id);
  const driveId = isRecord(value.parentReference) ? asString(value.parentReference.driveId) : '';
  const name = asString(value.name) || '(untitled)';
  const mimeType = asString(value.file.mimeType).toLowerCase();
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  const kind = WORD_MIMES.has(mimeType) || WORD_EXTENSIONS.has(extension)
    ? 'word'
    : TEXT_MIMES.has(mimeType) || TEXT_EXTENSIONS.has(extension)
      ? 'text'
      : null;
  const modifiedMs = Date.parse(asString(value.lastModifiedDateTime));
  const version = asString(value.eTag) || asString(value.cTag) || asString(value.lastModifiedDateTime);
  if (!id || !driveId || !kind || !version || !Number.isFinite(modifiedMs)) return null;

  return {
    id,
    driveId,
    name,
    kind,
    version,
    modifiedMs,
    occurredAt: new Date(modifiedMs).toISOString(),
    webUrl: asString(value.webUrl),
  };
}

function parseCursor(value: string): OneDriveCursorV1 {
  if (!value || value.length > MAX_CURSOR_LENGTH) throw new Error('Invalid OneDrive cursor');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Invalid OneDrive cursor');
  }
  if (!isRecord(parsed)) throw new Error('Invalid OneDrive cursor');
  const cursor = parsed as unknown as OneDriveCursorV1;
  assertCursor(cursor);
  return { ...cursor };
}

function serializeCursor(cursor: OneDriveCursorV1): string {
  assertCursor(cursor);
  const value = JSON.stringify(cursor);
  if (value.length > MAX_CURSOR_LENGTH) throw new Error('OneDrive cursor is too large');
  return value;
}

function assertCursor(cursor: OneDriveCursorV1): void {
  const floorMs = Date.parse(cursor.floor);
  if (
    cursor.v !== 1
    || (cursor.phase !== 'primary' && cursor.phase !== 'shared')
    || (cursor.token !== null && (
      typeof cursor.token !== 'string' || !cursor.token || cursor.token.length > MAX_TOKEN_LENGTH
    ))
    || !Number.isFinite(floorMs)
    || typeof cursor.initial !== 'boolean'
    || typeof cursor.resync !== 'boolean'
    || !Number.isSafeInteger(cursor.sharedFrom)
    || cursor.sharedFrom < 0
    || cursor.sharedFrom > MAX_SHARED_OFFSET
    || !Array.isArray(cursor.consumedPageIds)
    || cursor.consumedPageIds.length > MAX_PROVIDER_PAGE_ITEMS
    || cursor.consumedPageIds.some((id) => typeof id !== 'string' || !id || id.length > MAX_PAGE_ITEM_KEY_LENGTH)
    || new Set(cursor.consumedPageIds).size !== cursor.consumedPageIds.length
    || (cursor.phase === 'shared' && !cursor.token)
  ) {
    throw new Error('Invalid OneDrive cursor');
  }
}

function extractPrimaryPage(data: unknown): ProviderPage {
  const containers = responseContainers(data);
  const items = firstArray(containers, 'value');
  if (!items) throw new Error(`${LIST_CHANGES} returned no recognized items array`);
  return {
    items,
    nextLink: firstBoundedString(containers, '@odata.nextLink'),
    deltaLink: firstBoundedString(containers, '@odata.deltaLink'),
  };
}

function extractSharedItems(data: unknown): unknown[] {
  const containers = responseContainers(data);
  const items = firstArray(containers, 'value') ?? firstArray(containers, 'hits');
  if (!items) throw new Error(`${LIST_SHARED} returned no recognized items array`);
  return items;
}

function extractDownloadUrl(data: unknown): string {
  const root = isRecord(data) ? data : {};
  const nested = isRecord(root.data) ? root.data : {};
  const candidates = [root, nested].flatMap((container) => {
    const content = isRecord(container.content) ? container.content : {};
    const downloaded = isRecord(container.downloaded_file_content) ? container.downloaded_file_content : {};
    return [content.s3url, content.url, content.file_url, downloaded.s3url];
  });
  for (const candidate of candidates) {
    const url = asString(candidate);
    if (!url) continue;
    try {
      assertHttpsUrl(url);
      return url;
    } catch {
      continue;
    }
  }
  return '';
}

function responseContainers(data: unknown): Record<string, unknown>[] {
  if (!isRecord(data)) return [];
  return isRecord(data.data) ? [data, data.data] : [data];
}

function firstArray(containers: Record<string, unknown>[], key: string): unknown[] | null {
  for (const container of containers) {
    if (Array.isArray(container[key])) return container[key];
  }
  return null;
}

function firstBoundedString(containers: Record<string, unknown>[], key: string): string | null {
  for (const container of containers) {
    const value = asString(container[key]);
    if (!value) continue;
    if (value.length > MAX_TOKEN_LENGTH) throw new Error(`${LIST_CHANGES} returned an oversized token`);
    return value;
  }
  return null;
}

function result(items: IngestionItem[], cursor: OneDriveCursorV1, hasMore: boolean): IngestionFetchResult {
  return { items, nextCursor: serializeCursor(cursor), hasMore };
}

function resetExpiredCursor(cursor: OneDriveCursorV1): IngestionFetchResult {
  cursor.phase = 'primary';
  cursor.token = null;
  cursor.resync = true;
  cursor.sharedFrom = 0;
  cursor.consumedPageIds = [];
  return result([], cursor, true);
}

function completeSharedPhase(cursor: OneDriveCursorV1, items: IngestionItem[]): IngestionFetchResult {
  cursor.phase = 'primary';
  cursor.sharedFrom = 0;
  cursor.consumedPageIds = [];
  cursor.initial = false;
  cursor.resync = false;
  return result(items, cursor, false);
}

function isUnsupportedMsaSharedSearch(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not supported for MSA accounts/i.test(message)
    && /MicrosoftSearch|addressUrl/i.test(message);
}

function pendingPageItems(
  items: unknown[],
  consumedIds: string[],
): Array<{ raw: unknown; key: string }> {
  if (items.length > MAX_PROVIDER_PAGE_ITEMS) {
    throw new Error(`OneDrive provider page exceeds ${MAX_PROVIDER_PAGE_ITEMS} items`);
  }
  const seen = new Set(consumedIds);
  const pending: Array<{ raw: unknown; key: string }> = [];
  for (const raw of items) {
    const key = pageItemKey(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    pending.push({ raw, key });
  }
  return pending;
}

function pageItemKey(raw: unknown): string {
  const value = unwrapDriveItem(raw);
  if (value) {
    const id = asString(value.id);
    const driveId = isRecord(value.parentReference) ? asString(value.parentReference.driveId) : '';
    const identity = id && driveId ? `${driveId}:${id}` : id;
    if (identity && identity.length <= MAX_PAGE_ITEM_KEY_LENGTH - 3) return `id:${identity}`;
  }
  const serialized = JSON.stringify(raw);
  if (!serialized || serialized.length > MAX_CURSOR_LENGTH) {
    throw new Error('OneDrive provider returned an untrackable page item');
  }
  return `h:${createHash('sha256').update(serialized).digest('hex')}`;
}

function unwrapDriveItem(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  return isRecord(raw.resource) ? raw.resource : isRecord(raw.item) ? raw.item : raw;
}

function isExpiredDeltaError(error: unknown): boolean {
  const status = isRecord(error) ? Number(error.status ?? error.statusCode) : NaN;
  const message = error instanceof Error ? error.message : String(error);
  return status === 410 || /(?:\b410\b|syncStateNotFound|resyncRequired)/i.test(message);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .split(/\bThe API response is\b/i, 1)[0]
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '[request-id]')
    .trim()
    .slice(0, 300);
}

function assertHttpUrl(value: string): void {
  const protocol = new URL(value).protocol;
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error('download URL uses an unsupported protocol');
  }
}

function assertHttpsUrl(value: string): void {
  if (new URL(value).protocol !== 'https:') {
    throw new Error('download URL uses an unsupported protocol');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
