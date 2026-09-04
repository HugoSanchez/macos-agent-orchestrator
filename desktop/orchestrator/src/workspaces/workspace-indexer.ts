import { createHash } from 'node:crypto';
import { readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { totalmem } from 'node:os';
import path from 'node:path';
import { DOCUMENT_MARKDOWN_CACHE_VERSION } from '../chat/document-conversion.ts';
import { convertDocumentFileToMarkdown } from '../chat/document-conversion-process.ts';
import type { MemoryProvider, MemorySearchResult } from '../memory/memory-provider.ts';
import { WorkspaceIndexStateStore } from './workspace-index-state.ts';
import { isEditable, isReadableDocument, type WorkspaceIndexStatus, WorkspaceStore } from './workspace-store.ts';

const MAX_INDEXED_TEXT_CHARS = 150_000;
const TEXT_INDEX_VERSION = 'utf8-text:150000:v1';
const UNSUPPORTED_INDEX_VERSION = 'unsupported:v1';
const TWO_WORKER_MEMORY_THRESHOLD_BYTES = 16 * 1024 * 1024 * 1024;

export interface WorkspaceIndexerOptions {
  convertDocument?: (filePath: string) => Promise<string>;
  documentConversionVersion?: string;
  maxConcurrentDocumentConversions?: number;
}

interface IndexJob {
  workspaceId: string;
  path: string;
  absolutePath: string;
  fingerprint: string;
  size: number;
  modifiedAtMs: number;
  parserVersion: string;
}

/** Keeps the rebuildable memory index in sync with the canonical workspace files. */
export class WorkspaceIndexer {
  private watcher: FSWatcher | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private stopping = false;
  private prepared = false;
  private readonly statuses = new Map<string, WorkspaceIndexStatus>();
  private readonly stateStore: WorkspaceIndexStateStore;
  private readonly convertDocument: (filePath: string) => Promise<string>;
  private readonly documentConversionVersion: string;
  private readonly maxConcurrentDocumentConversions: number;

  constructor(
    private readonly store: WorkspaceStore,
    private readonly memory: MemoryProvider,
    options: WorkspaceIndexerOptions = {},
  ) {
    this.stateStore = new WorkspaceIndexStateStore(store.root);
    this.convertDocument = options.convertDocument ?? convertDocumentFileToMarkdown;
    this.documentConversionVersion = options.documentConversionVersion ?? DOCUMENT_MARKDOWN_CACHE_VERSION;
    this.maxConcurrentDocumentConversions = Math.max(
      1,
      Math.floor(options.maxConcurrentDocumentConversions ?? defaultDocumentConcurrency()),
    );
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.prepare();
    this.watcher = watch(this.store.root, { recursive: true }, (_eventType, filename) => {
      const relativePath = filename?.toString() ?? null;
      if (!this.stateStore.ownsWatchedPath(relativePath)) this.scheduleRefresh();
    });
    // A large document collection can take minutes to convert on first run.
    // Keep that work behind the sidecar's ready boundary so the native app can
    // connect and show per-file progress while the initial scan continues.
    void this.enqueue(() => this.syncAll(false)).catch((error: unknown) => {
      console.warn(`[workspaces] initial scan failed: ${formatError(error)}`);
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.watcher?.close();
    this.watcher = null;
    await this.queue.catch(() => undefined);
  }

  status(workspaceId: string, relativePath: string): WorkspaceIndexStatus | undefined {
    return this.statuses.get(sourceRef(workspaceId, relativePath));
  }

  async syncWorkspace(workspaceId: string): Promise<void> {
    await this.enqueue(async () => {
      await this.prepare();
      await this.syncOne(workspaceId, false);
    });
  }

  async search(query: string, limit: number, workspaceId?: string): Promise<MemorySearchResult[]> {
    return this.memory.search(query, limit, {
      source: 'workspace',
      ...(workspaceId ? { stream: workspaceId } : {}),
    });
  }

  private scheduleRefresh(): void {
    if (this.stopping) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (this.stopping) return;
      void this.enqueue(() => this.syncAll(true)).catch((error: unknown) => {
        console.warn(`[workspaces] refresh failed: ${formatError(error)}`);
      });
    }, 250);
  }

  private async syncAll(touchChanged: boolean): Promise<void> {
    const workspaces = this.store.list();
    const liveWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
    for (const workspace of workspaces) await this.syncOne(workspace.id, touchChanged);

    for (const cached of this.stateStore.list()) {
      if (liveWorkspaceIds.has(cached.workspaceId)) continue;
      await this.deleteDocument(cached.workspaceId, cached.path);
      this.statuses.delete(sourceRef(cached.workspaceId, cached.path));
      this.stateStore.delete(cached.workspaceId, cached.path);
    }
  }

  private async syncOne(workspaceId: string, touchChanged: boolean): Promise<void> {
    if (!this.memory.isReady()) return;
    const entries = this.store.listEntries(workspaceId).filter((entry) => entry.kind === 'file');
    const liveKeys = new Set(entries.map((entry) => sourceRef(workspaceId, entry.path)));
    const documentJobs: IndexJob[] = [];
    let changed = false;

    for (const entry of entries) {
      const key = sourceRef(workspaceId, entry.path);
      const absolutePath = this.store.absoluteFilePath(workspaceId, entry.path);
      const fileStat = statSync(absolutePath);
      const parserVersion = parserVersionFor(entry.path, this.documentConversionVersion);
      const cached = this.stateStore.get(workspaceId, entry.path);
      if (
        cached?.size === fileStat.size
        && cached.modifiedAtMs === fileStat.mtimeMs
        && cached.parserVersion === parserVersion
        && cached.status !== 'indexing'
      ) {
        this.statuses.set(key, cached.status);
        continue;
      }

      const bytes = readFileSync(absolutePath);
      const fingerprint = createHash('sha256').update(bytes).digest('hex');
      const job: IndexJob = {
        workspaceId,
        path: entry.path,
        absolutePath,
        fingerprint,
        size: fileStat.size,
        modifiedAtMs: fileStat.mtimeMs,
        parserVersion,
      };
      if (
        cached?.fingerprint === fingerprint
        && cached.parserVersion === parserVersion
        && cached.status !== 'indexing'
      ) {
        this.recordStatus(job, cached.status);
        continue;
      }

      changed = true;
      this.recordStatus(job, 'indexing');

      if (isReadableDocument(entry.path)) {
        documentJobs.push(job);
        continue;
      }

      if (!isEditable(entry.path)) {
        await this.deleteDocument(workspaceId, entry.path);
        this.recordStatus(job, 'unsupported');
      } else {
        await this.index(job, () => Buffer.from(bytes).toString('utf8').slice(0, MAX_INDEXED_TEXT_CHARS));
      }
    }

    await runWithConcurrency(documentJobs, this.maxConcurrentDocumentConversions, (job) => (
      this.index(job, () => this.convertDocument(job.absolutePath))
    ));

    for (const cached of this.stateStore.list(workspaceId)) {
      const key = sourceRef(workspaceId, cached.path);
      if (liveKeys.has(key)) continue;
      changed = true;
      this.statuses.delete(key);
      await this.deleteDocument(workspaceId, cached.path);
      this.stateStore.delete(workspaceId, cached.path);
    }

    if (changed && touchChanged) this.store.touch(workspaceId);
  }

  private async prepare(): Promise<void> {
    if (this.prepared || !this.memory.isReady()) return;
    const memoryInstanceToken = this.memory.instanceToken?.() ?? null;
    const cacheMatchesMemory = memoryInstanceToken !== null
      && this.stateStore.memoryInstanceToken() === memoryInstanceToken;

    if (!cacheMatchesMemory) {
      if (this.memory.deleteSourceDocuments) await this.memory.deleteSourceDocuments('workspace');
      this.statuses.clear();
      this.stateStore.reset(memoryInstanceToken);
    } else {
      for (const cached of this.stateStore.list()) {
        this.statuses.set(sourceRef(cached.workspaceId, cached.path), cached.status);
      }
    }
    this.prepared = true;
  }

  private async index(job: IndexJob, loadContent: () => string | Promise<string>): Promise<void> {
    try {
      await this.memory.ingestSourceBatch({
        source: 'workspace',
        stream: job.workspaceId,
        items: [{
          sourceRef: sourceRef(job.workspaceId, job.path),
          title: job.path,
          content: await loadContent(),
        }],
      });
      this.recordStatus(job, 'ready');
    } catch (error: unknown) {
      await this.deleteDocument(job.workspaceId, job.path);
      this.recordStatus(job, 'error');
      console.warn(`[workspaces] could not index ${job.path}: ${formatError(error)}`);
    }
  }

  private async deleteDocument(workspaceId: string, relativePath: string): Promise<void> {
    await this.memory.deleteDocument?.('workspace', sourceRef(workspaceId, relativePath));
  }

  private recordStatus(job: IndexJob, status: WorkspaceIndexStatus): void {
    this.statuses.set(sourceRef(job.workspaceId, job.path), status);
    this.stateStore.set({
      workspaceId: job.workspaceId,
      path: job.path,
      fingerprint: job.fingerprint,
      size: job.size,
      modifiedAtMs: job.modifiedAtMs,
      parserVersion: job.parserVersion,
      status,
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function parserVersionFor(relativePath: string, documentConversionVersion: string): string {
  const extension = path.extname(relativePath).toLocaleLowerCase();
  if (isReadableDocument(relativePath)) return documentConversionVersion;
  if (isEditable(relativePath)) return TEXT_INDEX_VERSION;
  return UNSUPPORTED_INDEX_VERSION;
}

function sourceRef(workspaceId: string, relativePath: string): string {
  return `${workspaceId}:${relativePath}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  operation: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await operation(item);
    }
  });
  await Promise.all(workers);
}

function defaultDocumentConcurrency(): number {
  return totalmem() > TWO_WORKER_MEMORY_THRESHOLD_BYTES ? 2 : 1;
}
