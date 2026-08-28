import { describe, expect, it } from 'vitest';
import { GdriveSource } from '../src/memory/ingestion/sources/gdrive-source.ts';
import type { IngestionBridge } from '../src/memory/ingestion/ingestion-source.ts';

interface Call {
  toolSlug: string;
  args: Record<string, unknown>;
}

const DOC_MIME = 'application/vnd.google-apps.document';

function driveFile(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'file-1',
    name: 'Project Atlas notes',
    mimeType: DOC_MIME,
    modifiedTime: '2026-06-17T10:00:00.211Z',
    trashed: false,
    webViewLink: 'https://docs.google.com/document/d/file-1/edit',
    ...overrides,
  };
}

/**
 * Fake bridge with per-slug responses: FIND_FILE serves the file listing,
 * DOWNLOAD_FILE serves a presigned-URL envelope per fileId. Content behind
 * the URLs comes from the injected fetchText fake.
 */
function fakeBridge(opts: {
  files?: unknown[];
  nextPageToken?: string;
  findError?: string;
  downloadError?: string;
  urls?: Record<string, string>;
}): { bridge: IngestionBridge; calls: Call[] } {
  const calls: Call[] = [];
  const bridge: IngestionBridge = {
    async executeTool(toolSlug, args) {
      calls.push({ toolSlug, args });
      if (toolSlug === 'GOOGLEDRIVE_FIND_FILE') {
        if (opts.findError) return { data: null, error: opts.findError, logId: null };
        return {
          data: {
            files: opts.files ?? [],
            ...(opts.nextPageToken ? { nextPageToken: opts.nextPageToken } : {}),
          },
          error: null,
          logId: null,
        };
      }
      if (toolSlug === 'GOOGLEDRIVE_DOWNLOAD_FILE') {
        if (opts.downloadError) return { data: null, error: opts.downloadError, logId: null };
        const url = (opts.urls ?? {})[String(args.fileId)] ?? `s3://content/${String(args.fileId)}`;
        return { data: { downloaded_file_content: { s3url: url } }, error: null, logId: null };
      }
      throw new Error(`unexpected tool ${toolSlug}`);
    },
  };
  return { bridge, calls };
}

function source(bridge: IngestionBridge, opts: {
  contentLimit?: number;
  texts?: Record<string, string>;
  fetchThrows?: boolean;
} = {}): GdriveSource {
  return new GdriveSource(bridge, {
    contentLimit: opts.contentLimit,
    fetchText: async (url) => {
      if (opts.fetchThrows) throw new Error('presigned URL expired');
      return (opts.texts ?? {})[url] ?? 'Body text from Drive.';
    },
  });
}

describe('GdriveSource', () => {
  it('lists files ascending, builds items, and advances the cursor to the newest modifiedTime', async () => {
    const { bridge, calls } = fakeBridge({
      files: [
        driveFile({ id: 'newer', modifiedTime: '2026-06-17T11:00:00.000Z', name: 'Newer doc' }),
        driveFile({ id: 'older', modifiedTime: '2026-06-17T09:00:00.000Z', name: 'Older doc' }),
      ],
    });
    const result = await source(bridge).fetchSince('', '0', { maxItems: 5 });

    expect(result.items.map((i) => i.sourceRef)).toEqual(['older', 'newer']); // ascending
    expect(result.items[0].title).toBe('Older doc');
    expect(result.items[0].occurredAt).toBe('2026-06-17T09:00:00.000Z');
    expect(result.items[0].content).toContain('Document: Older doc');
    expect(result.items[0].content).toContain('Body text from Drive.');
    expect(result.nextCursor).toBe(String(Date.parse('2026-06-17T11:00:00.000Z')));
    expect(result.hasMore).toBe(false);

    const find = calls.find((c) => c.toolSlug === 'GOOGLEDRIVE_FIND_FILE')!;
    expect(find.args.orderBy).toBe('modifiedTime');
    expect(find.args.pageSize).toBe(5);
    expect(String(find.args.q)).toContain('trashed = false');
  });

  it('queries the watermark boundary with >= truncated to whole seconds', async () => {
    const { bridge, calls } = fakeBridge({ files: [] });
    const watermark = Date.parse('2026-06-17T10:00:00.211Z');

    const result = await source(bridge).fetchSince('', String(watermark), { maxItems: 5 });

    const q = String(calls[0].args.q);
    expect(q).toContain("modifiedTime >= '2026-06-17T10:00:00.000Z'");
    // Empty page: cursor stays put, no drain loop.
    expect(result.nextCursor).toBe(String(watermark));
    expect(result.hasMore).toBe(false);
  });

  it('re-includes an edited file: same sourceRef, new dedupRef', async () => {
    const v1 = driveFile({ modifiedTime: '2026-06-17T10:00:00.000Z' });
    const { bridge: b1 } = fakeBridge({ files: [v1] });
    const first = (await source(b1).fetchSince('', '0', { maxItems: 5 })).items[0];

    const v2 = driveFile({ modifiedTime: '2026-06-18T12:00:00.000Z' });
    const { bridge: b2 } = fakeBridge({ files: [v2] });
    const second = (await source(b2).fetchSince('', first.cursorValue.toString(), { maxItems: 5 })).items[0];

    expect(second.sourceRef).toBe(first.sourceRef); // upserts over the same memory row
    expect(second.dedupRef).not.toBe(first.dedupRef); // passes scheduler dedup
    expect(first.dedupRef).toBe(`file-1:${Date.parse('2026-06-17T10:00:00.000Z')}`);
  });

  it('filters trashed files and non-whitelisted MIME types defensively', async () => {
    const { bridge } = fakeBridge({
      files: [
        driveFile({ id: 'doc', mimeType: DOC_MIME }),
        driveFile({ id: 'md', mimeType: 'text/markdown' }),
        driveFile({ id: 'sheet', mimeType: 'application/vnd.google-apps.spreadsheet' }),
        driveFile({ id: 'pdf', mimeType: 'application/pdf' }),
        driveFile({ id: 'gone', trashed: true }),
        { name: 'no id at all' },
      ],
    });
    const result = await source(bridge).fetchSince('', '0', { maxItems: 10 });

    expect(result.items.map((i) => i.sourceRef).sort()).toEqual(['doc', 'md']);
  });

  it('reports hasMore from nextPageToken', async () => {
    const { bridge } = fakeBridge({ files: [driveFile()], nextPageToken: 'tok-next' });
    const result = await source(bridge).fetchSince('', '0', { maxItems: 1 });
    expect(result.hasMore).toBe(true);
  });

  it('exports Google Docs as text/plain but downloads text files as-is', async () => {
    const { bridge, calls } = fakeBridge({
      files: [
        driveFile({ id: 'doc', mimeType: DOC_MIME }),
        driveFile({ id: 'md', mimeType: 'text/markdown' }),
      ],
    });
    await source(bridge).fetchSince('', '0', { maxItems: 5 });

    const downloads = calls.filter((c) => c.toolSlug === 'GOOGLEDRIVE_DOWNLOAD_FILE');
    const byId = Object.fromEntries(downloads.map((c) => [String(c.args.fileId), c.args]));
    expect(byId.doc.mime_type).toBe('text/plain');
    expect(byId.md.mime_type).toBeUndefined();
  });

  it('caps content at the configured limit and strips the export BOM', async () => {
    const { bridge } = fakeBridge({ files: [driveFile({ id: 'big' })] });
    const [item] = (await source(bridge, {
      contentLimit: 120,
      texts: { 's3://content/big': `﻿${'x'.repeat(500)}` },
    }).fetchSince('', '0', { maxItems: 5 })).items;

    expect(item.content).toHaveLength(120);
    expect(item.content).not.toContain('﻿');
  });

  it('falls back to a header-only item when the content fetch fails', async () => {
    const { bridge } = fakeBridge({ files: [driveFile()] });
    const [item] = (await source(bridge, { fetchThrows: true }).fetchSince('', '0', { maxItems: 5 })).items;

    expect(item.sourceRef).toBe('file-1');
    expect(item.content).toContain('Document: Project Atlas notes');
    expect(item.content).not.toContain('Body text');
  });

  it('falls back to a header-only item when the download tool errors', async () => {
    const { bridge } = fakeBridge({ files: [driveFile()], downloadError: 'file not accessible' });
    const [item] = (await source(bridge).fetchSince('', '0', { maxItems: 5 })).items;

    expect(item.content).toContain('Document: Project Atlas notes');
  });

  it('throws on a listing provider error', async () => {
    const { bridge } = fakeBridge({ findError: 'insufficient scope' });
    await expect(source(bridge).fetchSince('', '0', { maxItems: 5 })).rejects.toThrow(/insufficient scope/);
  });

  it('seeds the cursor at now minus the lookback', () => {
    const now = new Date('2026-06-17T10:00:00.000Z');
    const adapter = new GdriveSource(fakeBridge({}).bridge);
    expect(adapter.seedCursor(now, 1000)).toBe(String(now.getTime() - 1000));
    expect(adapter.seedLookbackMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect(adapter.maxItemsPerBatch).toBe(5);
  });
});
