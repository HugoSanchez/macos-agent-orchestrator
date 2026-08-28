import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IngestionBridge } from '../src/memory/ingestion/ingestion-source.ts';
import {
  fetchOneDriveBytes,
  OneDriveSource,
  type OneDriveCursorV1,
} from '../src/memory/ingestion/sources/onedrive-source.ts';

interface Call {
  toolSlug: string;
  args: Record<string, unknown>;
  opts?: { recordUsage?: boolean };
}

const NOW = new Date('2026-08-27T12:00:00.000Z');
const RECENT = '2026-08-20T12:00:00.000Z';
const OLD = '2026-06-01T12:00:00.000Z';

function driveItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'file-1',
    name: 'Launch notes.docx',
    file: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    lastModifiedDateTime: RECENT,
    eTag: 'etag-1',
    webUrl: 'https://onedrive.live.com/file-1',
    parentReference: { driveId: 'drive-1' },
    ...overrides,
  };
}

function cursor(overrides: Partial<OneDriveCursorV1> = {}): string {
  return JSON.stringify({
    v: 1,
    phase: 'primary',
    token: 'https://graph.microsoft.com/delta-token',
    floor: '2026-07-28T12:00:00.000Z',
    initial: false,
    resync: false,
    sharedFrom: 0,
    consumedPageIds: [],
    ...overrides,
  });
}

function fakeBridge(responses: Partial<Record<string, Array<unknown | Error>>> = {}): {
  bridge: IngestionBridge;
  calls: Call[];
} {
  const calls: Call[] = [];
  const bridge: IngestionBridge = {
    async executeTool(toolSlug, args, opts) {
      calls.push({ toolSlug, args, opts });
      const next = responses[toolSlug]?.shift();
      if (next instanceof Error) throw next;
      if (typeof next === 'string') return { data: null, error: next, logId: null };
      if (next !== undefined) return { data: next, error: null, logId: null };
      if (toolSlug === 'ONE_DRIVE_DOWNLOAD_FILE') {
        return {
          data: { content: { s3url: `https://files.example/${String(args.item_id)}` } },
          error: null,
          logId: null,
        };
      }
      throw new Error(`unexpected tool ${toolSlug}`);
    },
  };
  return { bridge, calls };
}

function source(bridge: IngestionBridge, opts: {
  bytes?: Buffer;
  fetchError?: Error;
  converted?: string;
} = {}): OneDriveSource {
  return new OneDriveSource(bridge, {
    fetchBytes: async () => {
      if (opts.fetchError) throw opts.fetchError;
      return opts.bytes ?? Buffer.from('plain body');
    },
    convertDocument: async () => opts.converted ?? 'converted Word body',
  });
}

function parsed(resultCursor: string): OneDriveCursorV1 {
  return JSON.parse(resultCursor) as OneDriveCursorV1;
}

describe('OneDriveSource', () => {
  it('seeds a bounded 30-day cursor', () => {
    const adapter = source(fakeBridge().bridge);
    const seeded = parsed(adapter.seedCursor(NOW, adapter.seedLookbackMs!));

    expect(seeded).toEqual({
      v: 1,
      phase: 'primary',
      token: null,
      floor: '2026-07-28T12:00:00.000Z',
      initial: true,
      resync: false,
      sharedFrom: 0,
      consumedPageIds: [],
    });
    expect(adapter.maxItemsPerBatch).toBe(5);
  });

  it('rejects malformed, oversized, and inconsistent cursors', async () => {
    const adapter = source(fakeBridge().bridge);
    await expect(adapter.fetchSince('', '{}', { maxItems: 5 })).rejects.toThrow('Invalid OneDrive cursor');
    await expect(adapter.fetchSince('', 'x'.repeat(65 * 1024), { maxItems: 5 }))
      .rejects.toThrow('Invalid OneDrive cursor');
    await expect(adapter.fetchSince('', cursor({ phase: 'shared', token: null }), { maxItems: 5 }))
      .rejects.toThrow('Invalid OneDrive cursor');
  });

  it('drains initial primary pages, applies the floor, and preserves complete continuation URLs', async () => {
    const { bridge, calls } = fakeBridge({
      ONE_DRIVE_LIST_ROOT_DRIVE_CHANGES: [{
        value: [driveItem(), driveItem({ id: 'old', lastModifiedDateTime: OLD })],
        '@odata.nextLink': 'https://graph.microsoft.com/next?page=2',
      }],
    });
    const seeded = source(bridge).seedCursor(NOW, 30 * 24 * 60 * 60 * 1000);
    const result = await source(bridge).fetchSince('', seeded, { maxItems: 5 });

    expect(result.items.map((item) => item.sourceRef)).toEqual(['drive-1:file-1']);
    expect(parsed(result.nextCursor)).toMatchObject({
      phase: 'primary',
      token: 'https://graph.microsoft.com/next?page=2',
      initial: true,
    });
    expect(result.hasMore).toBe(true);
    expect(calls[0].args).toMatchObject({ top: 5 });
    expect(calls[0].args.token).toBeUndefined();
    expect(String(calls[0].args.select)).toContain('parentReference');
    expect(calls.every((call) => call.opts?.recordUsage === false)).toBe(true);
  });

  it('keeps initial mode through shared files, filters old shares, then completes the cycle', async () => {
    const { bridge, calls } = fakeBridge({
      ONE_DRIVE_LIST_ROOT_DRIVE_CHANGES: [{
        value: [],
        '@odata.deltaLink': 'https://graph.microsoft.com/delta=new',
      }],
      ONE_DRIVE_LIST_ONEDRIVE_SHARED_ITEMS: [{
        value: [driveItem({ id: 'old-shared', lastModifiedDateTime: OLD })],
      }],
    });
    const adapter = source(bridge);
    const primary = await adapter.fetchSince('', adapter.seedCursor(NOW, 30 * 24 * 60 * 60 * 1000), { maxItems: 5 });
    expect(parsed(primary.nextCursor)).toMatchObject({ phase: 'shared', initial: true });

    const shared = await adapter.fetchSince('', primary.nextCursor, { maxItems: 5 });
    expect(shared.items).toEqual([]);
    expect(shared.hasMore).toBe(false);
    expect(parsed(shared.nextCursor)).toMatchObject({
      phase: 'primary',
      token: 'https://graph.microsoft.com/delta=new',
      initial: false,
      resync: false,
      sharedFrom: 0,
    });
    expect(calls.find((call) => call.toolSlug.includes('SHARED'))?.args).toMatchObject({ from: 0, size: 5 });
  });

  it('resumes shared snapshots by offset and keeps drive-qualified identities', async () => {
    const sharedItems = Array.from({ length: 5 }, (_, index) => driveItem({
      id: `shared-${index}`,
      parentReference: { driveId: `remote-${index}` },
    }));
    const { bridge } = fakeBridge({ ONE_DRIVE_LIST_ONEDRIVE_SHARED_ITEMS: [{ hits: sharedItems }] });
    const result = await source(bridge).fetchSince('', cursor({ phase: 'shared', sharedFrom: 10 }), { maxItems: 5 });

    expect(result.items).toHaveLength(5);
    expect(result.items[0].sourceRef).toBe('remote-0:shared-0');
    expect(result.items[0].dedupRef).toBe('remote-0:shared-0:etag-1');
    expect(parsed(result.nextCursor)).toMatchObject({ phase: 'shared', sharedFrom: 15 });
    expect(result.hasMore).toBe(true);
  });

  it('completes without shared files when Microsoft Search rejects a personal account', async () => {
    const { bridge } = fakeBridge({
      ONE_DRIVE_LIST_ONEDRIVE_SHARED_ITEMS: [
        'Failed to search drive items. Status: 400. The API response is: '
          + '{"error":{"message":"This API is not supported for MSA accounts '
          + '(no addressUrl for Microsoft.MicrosoftSearch,False)."}}',
      ],
    });
    const result = await source(bridge).fetchSince('', cursor({
      phase: 'shared',
      initial: true,
    }), { maxItems: 5 });

    expect(result.items).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(parsed(result.nextCursor)).toMatchObject({
      phase: 'primary', initial: false, resync: false, sharedFrom: 0,
    });
  });

  it('resets only explicit expired delta errors and recovery bypasses the old floor', async () => {
    const expired = fakeBridge({ ONE_DRIVE_LIST_ROOT_DRIVE_CHANGES: ['HTTP 410 syncStateNotFound'] });
    const reset = await source(expired.bridge).fetchSince('', cursor({ initial: true }), { maxItems: 5 });
    expect(reset.items).toEqual([]);
    expect(parsed(reset.nextCursor)).toMatchObject({
      phase: 'primary', token: null, initial: true, resync: true,
    });

    const recovery = fakeBridge({
      ONE_DRIVE_LIST_ROOT_DRIVE_CHANGES: [{ value: [], '@odata.deltaLink': 'delta-recovered' }],
      ONE_DRIVE_LIST_ONEDRIVE_SHARED_ITEMS: [{ value: [driveItem({ id: 'old-shared', lastModifiedDateTime: OLD })] }],
    });
    const adapter = source(recovery.bridge);
    const primary = await adapter.fetchSince('', reset.nextCursor, { maxItems: 5 });
    const shared = await adapter.fetchSince('', primary.nextCursor, { maxItems: 5 });
    expect(shared.items.map((item) => item.sourceRef)).toEqual(['drive-1:old-shared']);
    expect(parsed(shared.nextCursor)).toMatchObject({ initial: false, resync: false });

    const unrelated = fakeBridge({ ONE_DRIVE_LIST_ROOT_DRIVE_CHANGES: ['permission denied'] });
    await expect(source(unrelated.bridge).fetchSince('', cursor(), { maxItems: 5 }))
      .rejects.toThrow(/permission denied/);
  });

  it('ingests incremental changes regardless of the first-sync floor', async () => {
    const { bridge, calls } = fakeBridge({
      ONE_DRIVE_LIST_ROOT_DRIVE_CHANGES: [{
        data: {
          value: [driveItem({ lastModifiedDateTime: OLD, name: 'archive.txt', file: { mimeType: 'text/plain' } })],
          '@odata.deltaLink': 'delta-next',
        },
      }],
    });
    const result = await source(bridge, { bytes: Buffer.from('﻿archive text') })
      .fetchSince('', cursor(), { maxItems: 5 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].content).toContain('archive text');
    expect(calls[0].args.token).toBe('https://graph.microsoft.com/delta-token');
    expect(parsed(result.nextCursor)).toMatchObject({ phase: 'shared', token: 'delta-next' });
  });

  it('converts Word bytes, passes the drive id, and caps assembled content', async () => {
    const { bridge, calls } = fakeBridge({
      ONE_DRIVE_LIST_ROOT_DRIVE_CHANGES: [{ value: [driveItem()], '@odata.deltaLink': 'delta-next' }],
    });
    const adapter = new OneDriveSource(bridge, {
      contentLimit: 100,
      fetchBytes: async () => Buffer.from('word bytes'),
      convertDocument: async () => 'x'.repeat(500),
    });
    const [item] = (await adapter.fetchSince('', cursor(), { maxItems: 5 })).items;

    expect(item.content).toHaveLength(100);
    expect(item.title).toBe('Launch notes.docx');
    expect(calls.find((call) => call.toolSlug === 'ONE_DRIVE_DOWNLOAD_FILE')?.args).toEqual({
      item_id: 'file-1', file_name: 'Launch notes.docx', user_id: 'me', drive_id: 'drive-1',
    });
  });

  it('falls back to metadata and rejects arbitrary nested download URLs', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const nested = fakeBridge({
      ONE_DRIVE_LIST_ROOT_DRIVE_CHANGES: [{ value: [driveItem()], '@odata.deltaLink': 'delta-next' }],
      ONE_DRIVE_DOWNLOAD_FILE: [{ arbitrary: { url: 'https://files.example/secret' } }],
    });
    const [item] = (await source(nested.bridge).fetchSince('', cursor(), { maxItems: 5 })).items;

    expect(item.content).toContain('Document: Launch notes.docx');
    expect(item.content).not.toContain('converted Word body');
    expect(warning).toHaveBeenCalledOnce();
  });

  it('skips folders, deleted files, unsupported types, and malformed identities', async () => {
    const { bridge } = fakeBridge({
      ONE_DRIVE_LIST_ROOT_DRIVE_CHANGES: [{
        value: [
          driveItem({ id: 'folder', file: undefined, folder: {} }),
          driveItem({ id: 'deleted', deleted: {} }),
          driveItem({ id: 'pdf', name: 'file.pdf', file: { mimeType: 'application/pdf' } }),
          driveItem({ id: 'no-drive', parentReference: {} }),
          driveItem({ id: 'bad-date', lastModifiedDateTime: 'today' }),
        ],
        '@odata.deltaLink': 'delta-next',
      }],
    });
    expect((await source(bridge).fetchSince('', cursor(), { maxItems: 5 })).items).toEqual([]);
  });

  it('drains oversized provider pages across bounded batches without advancing early', async () => {
    const six = Array.from({ length: 6 }, (_, index) => driveItem({ id: `file-${index}` }));
    const primary = fakeBridge({
      ONE_DRIVE_LIST_ROOT_DRIVE_CHANGES: [
        { value: six, '@odata.deltaLink': 'delta-next' },
        { value: six, '@odata.deltaLink': 'delta-next' },
      ],
    });
    const adapter = source(primary.bridge);
    const first = await adapter.fetchSince('', cursor(), { maxItems: 5 });
    expect(first.items).toHaveLength(5);
    expect(parsed(first.nextCursor)).toMatchObject({
      phase: 'primary',
      token: 'https://graph.microsoft.com/delta-token',
      consumedPageIds: expect.arrayContaining(['id:drive-1:file-0', 'id:drive-1:file-4']),
    });
    const second = await adapter.fetchSince('', first.nextCursor, { maxItems: 5 });
    expect(second.items).toHaveLength(1);
    expect(parsed(second.nextCursor)).toMatchObject({
      phase: 'shared', token: 'delta-next', consumedPageIds: [],
    });

    const shared = fakeBridge({
      ONE_DRIVE_LIST_ONEDRIVE_SHARED_ITEMS: [{ value: six }, { value: six }],
    });
    const sharedAdapter = source(shared.bridge);
    const sharedFirst = await sharedAdapter.fetchSince('', cursor({ phase: 'shared' }), { maxItems: 5 });
    expect(sharedFirst.items).toHaveLength(5);
    expect(parsed(sharedFirst.nextCursor)).toMatchObject({ phase: 'shared', sharedFrom: 0 });
    const sharedSecond = await sharedAdapter.fetchSince('', sharedFirst.nextCursor, { maxItems: 5 });
    expect(sharedSecond.items).toHaveLength(1);
    expect(parsed(sharedSecond.nextCursor)).toMatchObject({
      phase: 'shared', sharedFrom: 6, consumedPageIds: [],
    });
  });

  it('fails closed on unbounded provider pages', async () => {
    const tooMany = Array.from({ length: 501 }, (_, index) => driveItem({ id: `file-${index}` }));
    const { bridge } = fakeBridge({
      ONE_DRIVE_LIST_ROOT_DRIVE_CHANGES: [{ value: tooMany, '@odata.deltaLink': 'delta-next' }],
    });
    await expect(source(bridge).fetchSince('', cursor(), { maxItems: 5 }))
      .rejects.toThrow('provider page exceeds 500 items');
  });

  it('rejects missing primary envelopes and terminal cursor links', async () => {
    const missingItems = fakeBridge({ ONE_DRIVE_LIST_ROOT_DRIVE_CHANGES: [{ nope: [] }] });
    await expect(source(missingItems.bridge).fetchSince('', cursor(), { maxItems: 5 }))
      .rejects.toThrow('no recognized items array');

    const missingLink = fakeBridge({ ONE_DRIVE_LIST_ROOT_DRIVE_CHANGES: [{ value: [] }] });
    await expect(source(missingLink.bridge).fetchSince('', cursor(), { maxItems: 5 }))
      .rejects.toThrow('no continuation or delta link');
  });
});

describe('fetchOneDriveBytes', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('requires HTTPS input and a successful HTTP response', async () => {
    await expect(fetchOneDriveBytes('file:///tmp/document')).rejects.toThrow('unsupported protocol');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })));
    await expect(fetchOneDriveBytes('https://files.example/document')).rejects.toThrow('HTTP 403');
  });

  it('rejects an oversized Content-Length before reading the body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('small', {
      headers: { 'content-length': String(10 * 1024 * 1024 + 1) },
    })));
    await expect(fetchOneDriveBytes('https://files.example/document')).rejects.toThrow('10 MiB');
  });

  it('aborts downloads after 30 seconds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })
    )));

    const download = fetchOneDriveBytes('https://files.example/document');
    const rejected = expect(download).rejects.toThrow(/aborted/i);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
  });

  it('enforces the streaming limit when Content-Length is absent', async () => {
    const chunk = new Uint8Array(6 * 1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    await expect(fetchOneDriveBytes('https://files.example/document')).rejects.toThrow('10 MiB');
  });

  it('returns bounded response bytes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('hello')));
    await expect(fetchOneDriveBytes('https://files.example/document')).resolves.toEqual(Buffer.from('hello'));
  });
});
