import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DOCUMENT_MARKDOWN_CACHE_VERSION } from '../src/chat/document-conversion.ts';
import { dispatch } from '../src/http/router.ts';
import { LexicalMemoryProvider } from '../src/memory/lexical-provider.ts';
import { WorkspaceIndexer } from '../src/workspaces/workspace-indexer.ts';
import { WORKSPACE_INDEX_STATE_FILENAME } from '../src/workspaces/workspace-index-state.ts';
import { buildWorkspaceRoutes } from '../src/workspaces/workspace-routes.ts';
import { WorkspaceError, WorkspaceStore } from '../src/workspaces/workspace-store.ts';
import { makeMinimalPdf } from './fixtures/documents.ts';

describe('workspaces', () => {
  const tempDirs: string[] = [];
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeRoot(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), 'verso-workspaces-'));
    tempDirs.push(root);
    return root;
  }

  it('stores workspace content as ordinary files and persists only metadata beside them', () => {
    const root = makeRoot();
    const store = new WorkspaceStore(root);
    const workspace = store.create('Fundraising');

    store.createFolder(workspace.id, 'Notes');
    store.createText(workspace.id, 'Notes/brief.md', '# Investor brief');
    expect(() => store.createText(workspace.id, 'Notes/brief.md', 'erased'))
      .toThrow(/already exists/i);

    expect(readFileSync(path.join(root, workspace.id, 'Notes', 'brief.md'), 'utf8'))
      .toBe('# Investor brief');
    expect(JSON.parse(readFileSync(path.join(root, 'workspaces.json'), 'utf8')).workspaces[0])
      .toMatchObject({ id: workspace.id, name: 'Fundraising' });
    expect(store.listEntries(workspace.id)).toEqual([
      { path: 'Notes', name: 'Notes', kind: 'folder', editable: false },
      {
        path: 'Notes/brief.md',
        name: 'brief.md',
        kind: 'file',
        size: 16,
        mimeType: 'text/markdown',
        editable: true,
      },
    ]);
  });

  it('rejects duplicate names, path traversal, and symlink escapes', () => {
    const root = makeRoot();
    const outside = makeRoot();
    const store = new WorkspaceStore(root);
    const workspace = store.create('Research');

    expect(() => store.create(' research ')).toThrow(/already exists/i);
    expect(() => store.writeText(workspace.id, '../outside.md', 'nope')).toThrow(WorkspaceError);
    symlinkSync(outside, path.join(root, workspace.id, 'linked'));
    expect(() => store.writeText(workspace.id, 'linked/outside.md', 'nope')).toThrow(/symbolic links/i);
    expect(existsSync(path.join(outside, 'outside.md'))).toBe(false);
  });

  it('imports without overwriting, and safely moves and deletes entries', () => {
    const root = makeRoot();
    const sourceRoot = makeRoot();
    const source = path.join(sourceRoot, 'notes.txt');
    writeFileSync(source, 'source material', 'utf8');
    const store = new WorkspaceStore(root);
    const workspace = store.create('Writing');

    expect(() => store.importFiles(workspace.id, [source, path.join(sourceRoot, 'missing.txt')]))
      .toThrow(/does not exist/i);
    expect(store.listEntries(workspace.id)).toEqual([]);
    expect(store.get(workspace.id)?.revision).toBe(1);

    store.importFiles(workspace.id, [source, source]);
    expect(store.listEntries(workspace.id).map((entry) => entry.path)).toEqual(['notes 2.txt', 'notes.txt']);

    store.moveEntry(workspace.id, 'notes.txt', 'Archive/notes.txt');
    expect(store.readText(workspace.id, 'Archive/notes.txt').content).toBe('source material');
    store.deleteEntry(workspace.id, 'Archive');
    expect(store.listEntries(workspace.id).map((entry) => entry.path)).toEqual(['notes 2.txt']);
  });

  it('indexes changed files globally and removes deleted files from retrieval', async () => {
    const root = makeRoot();
    const store = new WorkspaceStore(path.join(root, 'workspaces'));
    const first = store.create('Fundraising');
    const second = store.create('Hiring');
    store.writeText(first.id, 'assumptions.md', 'Our revenue assumption is twelve million euros.');
    store.writeText(second.id, 'scorecard.md', 'The engineering scorecard values systems thinking.');

    const memory = new LexicalMemoryProvider({ enabled: true, dbPath: path.join(root, 'memory.sqlite') });
    await memory.start();
    const indexer = new WorkspaceIndexer(store, memory);
    try {
      await indexer.syncWorkspace(first.id);
      await indexer.syncWorkspace(second.id);

      expect(await indexer.search('revenue assumption', 5)).toHaveLength(1);
      expect(await indexer.search('systems thinking', 5, first.id)).toEqual([]);
      expect(indexer.status(first.id, 'assumptions.md')).toBe('ready');

      store.deleteEntry(first.id, 'assumptions.md');
      await indexer.syncWorkspace(first.id);
      expect(await indexer.search('revenue assumption', 5)).toEqual([]);
    } finally {
      await memory.stop();
    }
  });

  it('indexes PDF text through the isolated document worker', async () => {
    const root = makeRoot();
    const workspaceRoot = path.join(root, 'workspaces');
    const store = new WorkspaceStore(workspaceRoot);
    const workspace = store.create('Research');
    writeFileSync(
      path.join(workspaceRoot, workspace.id, 'report.pdf'),
      makeMinimalPdf('Workspace PDF isolation test'),
    );

    const memory = new LexicalMemoryProvider({ enabled: true, dbPath: path.join(root, 'memory.sqlite') });
    await memory.start();
    const indexer = new WorkspaceIndexer(store, memory);
    try {
      await indexer.syncWorkspace(workspace.id);

      expect(indexer.status(workspace.id, 'report.pdf')).toBe('ready');
      expect(await indexer.search('PDF isolation', 5, workspace.id)).toHaveLength(1);
    } finally {
      await memory.stop();
    }
  });

  it('reuses persisted PDF results after restart and reconverts only after content changes', async () => {
    const root = makeRoot();
    const workspaceRoot = path.join(root, 'workspaces');
    const memoryPath = path.join(root, 'memory.sqlite');
    const store = new WorkspaceStore(workspaceRoot);
    const workspace = store.create('Research');
    const pdfPath = path.join(workspaceRoot, workspace.id, 'report.pdf');
    writeFileSync(pdfPath, 'first PDF bytes');

    let conversions = 0;
    const convertDocument = async () => {
      conversions += 1;
      return conversions === 1 ? 'OriginalAlpha research' : 'UpdatedBeta research';
    };

    const firstMemory = new LexicalMemoryProvider({ enabled: true, dbPath: memoryPath });
    await firstMemory.start();
    await new WorkspaceIndexer(store, firstMemory, { convertDocument }).syncWorkspace(workspace.id);
    expect(conversions).toBe(1);
    expect(await firstMemory.search('OriginalAlpha', 5, { source: 'workspace' })).toHaveLength(1);
    await firstMemory.stop();

    const secondMemory = new LexicalMemoryProvider({ enabled: true, dbPath: memoryPath });
    await secondMemory.start();
    const restarted = new WorkspaceIndexer(store, secondMemory, { convertDocument });
    await restarted.syncWorkspace(workspace.id);
    expect(conversions).toBe(1);
    expect(restarted.status(workspace.id, 'report.pdf')).toBe('ready');

    const touchedAt = new Date(Date.now() + 1_000);
    utimesSync(pdfPath, touchedAt, touchedAt);
    await restarted.syncWorkspace(workspace.id);
    expect(conversions).toBe(1);

    writeFileSync(pdfPath, 'second PDF bytes');
    await restarted.syncWorkspace(workspace.id);
    expect(conversions).toBe(2);
    expect(await secondMemory.search('OriginalAlpha', 5, { source: 'workspace' })).toEqual([]);
    expect(await secondMemory.search('UpdatedBeta', 5, { source: 'workspace' })).toHaveLength(1);

    const persisted = JSON.parse(readFileSync(
      path.join(workspaceRoot, WORKSPACE_INDEX_STATE_FILENAME),
      'utf8',
    )) as { memoryInstanceToken: string; entries: Array<Record<string, unknown>> };
    expect(persisted.memoryInstanceToken).toBe(secondMemory.instanceToken());
    expect(persisted.entries).toEqual([
      expect.objectContaining({
        workspaceId: workspace.id,
        path: 'report.pdf',
        parserVersion: DOCUMENT_MARKDOWN_CACHE_VERSION,
        status: 'ready',
      }),
    ]);
    await secondMemory.stop();
  });

  it('removes deleted files from persisted state and retrieval after restart', async () => {
    const root = makeRoot();
    const workspaceRoot = path.join(root, 'workspaces');
    const store = new WorkspaceStore(workspaceRoot);
    const workspace = store.create('Research');
    writeFileSync(path.join(workspaceRoot, workspace.id, 'report.pdf'), 'PDF bytes');

    const memory = new LexicalMemoryProvider({ enabled: true, dbPath: path.join(root, 'memory.sqlite') });
    await memory.start();
    const convertDocument = async () => 'Research scheduled for deletion';
    await new WorkspaceIndexer(store, memory, { convertDocument }).syncWorkspace(workspace.id);
    store.deleteEntry(workspace.id, 'report.pdf');

    const restarted = new WorkspaceIndexer(store, memory, { convertDocument });
    await restarted.syncWorkspace(workspace.id);
    expect(await restarted.search('scheduled deletion', 5, workspace.id)).toEqual([]);
    const persisted = JSON.parse(readFileSync(
      path.join(workspaceRoot, WORKSPACE_INDEX_STATE_FILENAME),
      'utf8',
    )) as { entries: unknown[] };
    expect(persisted.entries).toEqual([]);
    await memory.stop();
  });

  it('caches deterministic conversion errors until the file or parser version changes', async () => {
    const root = makeRoot();
    const workspaceRoot = path.join(root, 'workspaces');
    const store = new WorkspaceStore(workspaceRoot);
    const workspace = store.create('Research');
    writeFileSync(path.join(workspaceRoot, workspace.id, 'report.pdf'), 'problematic PDF');
    const memory = new LexicalMemoryProvider({ enabled: true, dbPath: path.join(root, 'memory.sqlite') });
    await memory.start();

    let attempts = 0;
    const failing = new WorkspaceIndexer(store, memory, {
      convertDocument: async () => {
        attempts += 1;
        throw new Error('conversion timed out');
      },
    });
    await failing.syncWorkspace(workspace.id);
    expect(failing.status(workspace.id, 'report.pdf')).toBe('error');
    expect(attempts).toBe(1);

    const sameVersion = new WorkspaceIndexer(store, memory, {
      convertDocument: async () => {
        attempts += 1;
        return 'should remain cached';
      },
    });
    await sameVersion.syncWorkspace(workspace.id);
    expect(sameVersion.status(workspace.id, 'report.pdf')).toBe('error');
    expect(attempts).toBe(1);

    const upgraded = new WorkspaceIndexer(store, memory, {
      documentConversionVersion: 'anydoc:new-parser-version',
      convertDocument: async () => {
        attempts += 1;
        return 'Recovered after parser upgrade';
      },
    });
    await upgraded.syncWorkspace(workspace.id);
    expect(upgraded.status(workspace.id, 'report.pdf')).toBe('ready');
    expect(attempts).toBe(2);
    expect(await upgraded.search('Recovered parser upgrade', 5, workspace.id)).toHaveLength(1);
    await memory.stop();
  });

  it('retries an indexing record left incomplete by an interrupted launch', async () => {
    const root = makeRoot();
    const workspaceRoot = path.join(root, 'workspaces');
    const store = new WorkspaceStore(workspaceRoot);
    const workspace = store.create('Research');
    writeFileSync(path.join(workspaceRoot, workspace.id, 'report.pdf'), 'PDF bytes');
    const memory = new LexicalMemoryProvider({ enabled: true, dbPath: path.join(root, 'memory.sqlite') });
    await memory.start();
    await new WorkspaceIndexer(store, memory, {
      convertDocument: async () => 'First successful conversion',
    }).syncWorkspace(workspace.id);

    const statePath = path.join(workspaceRoot, WORKSPACE_INDEX_STATE_FILENAME);
    const interruptedState = JSON.parse(readFileSync(statePath, 'utf8')) as {
      entries: Array<{ status: string }>;
    };
    interruptedState.entries[0].status = 'indexing';
    writeFileSync(statePath, `${JSON.stringify(interruptedState, null, 2)}\n`, 'utf8');

    let retries = 0;
    const restarted = new WorkspaceIndexer(store, memory, {
      convertDocument: async () => {
        retries += 1;
        return 'Recovered interrupted conversion';
      },
    });
    await restarted.syncWorkspace(workspace.id);
    expect(retries).toBe(1);
    expect(restarted.status(workspace.id, 'report.pdf')).toBe('ready');
    expect(await restarted.search('Recovered interrupted', 5, workspace.id)).toHaveLength(1);
    await memory.stop();
  });

  it('rebuilds cached files when the search database identity changes', async () => {
    const root = makeRoot();
    const workspaceRoot = path.join(root, 'workspaces');
    const store = new WorkspaceStore(workspaceRoot);
    const workspace = store.create('Research');
    writeFileSync(path.join(workspaceRoot, workspace.id, 'report.pdf'), 'PDF bytes');
    const memory = new LexicalMemoryProvider({ enabled: true, dbPath: path.join(root, 'memory.sqlite') });
    await memory.start();
    await new WorkspaceIndexer(store, memory, {
      convertDocument: async () => 'Original search database copy',
    }).syncWorkspace(workspace.id);

    const statePath = path.join(workspaceRoot, WORKSPACE_INDEX_STATE_FILENAME);
    const staleState = JSON.parse(readFileSync(statePath, 'utf8')) as { memoryInstanceToken: string };
    staleState.memoryInstanceToken = 'different-search-database';
    writeFileSync(statePath, `${JSON.stringify(staleState, null, 2)}\n`, 'utf8');

    let rebuilds = 0;
    const restarted = new WorkspaceIndexer(store, memory, {
      convertDocument: async () => {
        rebuilds += 1;
        return 'Rebuilt search database copy';
      },
    });
    await restarted.syncWorkspace(workspace.id);
    expect(rebuilds).toBe(1);
    expect(await restarted.search('Rebuilt search', 5, workspace.id)).toHaveLength(1);
    await memory.stop();
  });

  it('runs at most two isolated document conversions concurrently', async () => {
    const root = makeRoot();
    const workspaceRoot = path.join(root, 'workspaces');
    const store = new WorkspaceStore(workspaceRoot);
    const workspace = store.create('Research');
    for (let index = 1; index <= 5; index += 1) {
      writeFileSync(path.join(workspaceRoot, workspace.id, `report-${index}.pdf`), `PDF ${index}`);
    }

    let active = 0;
    let maximumActive = 0;
    let conversions = 0;
    const memory = new LexicalMemoryProvider({ enabled: true, dbPath: path.join(root, 'memory.sqlite') });
    await memory.start();
    const indexer = new WorkspaceIndexer(store, memory, {
      maxConcurrentDocumentConversions: 2,
      convertDocument: async (filePath) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        conversions += 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return `Converted ${path.basename(filePath)}`;
      },
    });

    await indexer.syncWorkspace(workspace.id);
    expect(conversions).toBe(5);
    expect(maximumActive).toBe(2);
    for (let index = 1; index <= 5; index += 1) {
      expect(indexer.status(workspace.id, `report-${index}.pdf`)).toBe('ready');
    }
    await memory.stop();
  });

  it('exposes workspace CRUD, file, and search operations over the local API', async () => {
    const root = makeRoot();
    const store = new WorkspaceStore(path.join(root, 'workspaces'));
    const memory = new LexicalMemoryProvider({ enabled: true, dbPath: path.join(root, 'memory.sqlite') });
    await memory.start();
    const indexer = new WorkspaceIndexer(store, memory);
    const server = http.createServer((req, res) => dispatch(
      buildWorkspaceRoutes(store, indexer),
      req,
      res,
      { allowUnauthenticated: true },
    ));
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
    });

    try {
      const created = await jsonRequest(`http://127.0.0.1:${port}/workspaces`, 'POST', { name: 'Launch' });
      expect(created.status).toBe(200);
      const workspaceId = created.body.workspace.id as string;

      expect((await jsonRequest(
        `http://127.0.0.1:${port}/workspaces/${workspaceId}/file`,
        'POST',
        { path: 'plan.md', content: 'Launch in November with a private beta.' },
      )).status).toBe(200);

      const duplicate = await jsonRequest(
        `http://127.0.0.1:${port}/workspaces/${workspaceId}/file`,
        'POST',
        { path: 'plan.md', content: '' },
      );
      expect(duplicate.status).toBe(409);
      expect(store.readText(workspaceId, 'plan.md').content).toContain('November');

      const search = await jsonRequest(`http://127.0.0.1:${port}/workspaces/search`, 'POST', {
        query: 'private beta',
      });
      expect(search.body.results[0]).toMatchObject({
        workspace: { id: workspaceId, name: 'Launch' },
        path: 'plan.md',
      });

      const read = await fetch(
        `http://127.0.0.1:${port}/workspaces/${workspaceId}/file?path=${encodeURIComponent('plan.md')}`,
      );
      expect((await read.json()).file.content).toContain('November');

      const researchPdf = makeMinimalPdf('Workspace documents can be read in complete chunks.');
      writeFileSync(path.join(root, 'workspaces', workspaceId, 'research.pdf'), researchPdf);
      const workspaceAttachment = await fetch(
        `http://127.0.0.1:${port}/workspaces/${workspaceId}/attachment?path=${encodeURIComponent('research.pdf')}`,
      );
      expect(workspaceAttachment.status).toBe(200);
      expect(workspaceAttachment.headers.get('content-type')).toBe('application/pdf');
      expect(Buffer.from(await workspaceAttachment.arrayBuffer())).toEqual(researchPdf);

      const firstDocumentResponse = await fetch(
        `http://127.0.0.1:${port}/workspaces/${workspaceId}/file?path=${encodeURIComponent('research.pdf')}&limit=12`,
      );
      expect(firstDocumentResponse.status).toBe(200);
      const firstDocument = (await firstDocumentResponse.json()).file;
      expect(firstDocument).toMatchObject({
        editable: false,
        mimeType: 'application/pdf',
        offset: 0,
      });
      expect(firstDocument.nextOffset).toBe(12);

      const remainingDocumentResponse = await fetch(
        `http://127.0.0.1:${port}/workspaces/${workspaceId}/file?path=${encodeURIComponent('research.pdf')}&offset=${firstDocument.nextOffset}`,
      );
      const remainingDocument = (await remainingDocumentResponse.json()).file;
      const fullDocument = `${firstDocument.content}${remainingDocument.content}`;
      expect(fullDocument).toContain('Workspace documents can be read in complete chunks.');
      expect(fullDocument).toHaveLength(firstDocument.totalChars);
      expect(remainingDocument.nextOffset).toBeNull();

      const documentRemoved = await fetch(
        `http://127.0.0.1:${port}/workspaces/${workspaceId}/entry?path=${encodeURIComponent('research.pdf')}`,
        { method: 'DELETE' },
      );
      expect(documentRemoved.status).toBe(200);

      const removed = await fetch(
        `http://127.0.0.1:${port}/workspaces/${workspaceId}/entry?path=${encodeURIComponent('plan.md')}`,
        { method: 'DELETE' },
      );
      expect(removed.status).toBe(200);
      expect((await removed.json()).entries).toEqual([]);
    } finally {
      await memory.stop();
    }
  });
});

async function jsonRequest(url: string, method: string, body: unknown): Promise<{
  status: number;
  body: Record<string, any>;
}> {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
