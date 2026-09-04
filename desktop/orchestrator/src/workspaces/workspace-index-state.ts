import path from 'node:path';
import { readJsonFileOr, writeJsonFileAtomic } from '../shared/atomic-json-file.ts';
import type { WorkspaceIndexStatus } from './workspace-store.ts';

export const WORKSPACE_INDEX_STATE_FILENAME = 'workspace-index.json';

export interface WorkspaceIndexRecord {
  workspaceId: string;
  path: string;
  fingerprint: string;
  size: number;
  modifiedAtMs: number;
  parserVersion: string;
  status: WorkspaceIndexStatus;
}

interface WorkspaceIndexStateDocument {
  version: 1;
  memoryInstanceToken: string | null;
  entries: WorkspaceIndexRecord[];
}

/** Durable metadata for the rebuildable workspace search index. */
export class WorkspaceIndexStateStore {
  private readonly statePath: string;
  private memoryInstanceTokenValue: string | null;
  private readonly entries = new Map<string, WorkspaceIndexRecord>();

  constructor(root: string) {
    this.statePath = path.join(root, WORKSPACE_INDEX_STATE_FILENAME);
    const state = readJsonFileOr(this.statePath, decodeState, emptyState);
    this.memoryInstanceTokenValue = state.memoryInstanceToken;
    for (const entry of state.entries) this.entries.set(keyFor(entry.workspaceId, entry.path), entry);
  }

  memoryInstanceToken(): string | null {
    return this.memoryInstanceTokenValue;
  }

  get(workspaceId: string, relativePath: string): WorkspaceIndexRecord | null {
    return this.entries.get(keyFor(workspaceId, relativePath)) ?? null;
  }

  list(workspaceId?: string): WorkspaceIndexRecord[] {
    return [...this.entries.values()]
      .filter((entry) => !workspaceId || entry.workspaceId === workspaceId)
      .sort((a, b) => (
        a.workspaceId.localeCompare(b.workspaceId) || a.path.localeCompare(b.path)
      ));
  }

  set(entry: WorkspaceIndexRecord): void {
    this.entries.set(keyFor(entry.workspaceId, entry.path), entry);
    this.persist();
  }

  delete(workspaceId: string, relativePath: string): void {
    if (!this.entries.delete(keyFor(workspaceId, relativePath))) return;
    this.persist();
  }

  reset(memoryInstanceToken: string | null): void {
    this.memoryInstanceTokenValue = memoryInstanceToken;
    this.entries.clear();
    this.persist();
  }

  /** Ignore the state file and its atomic-write temporary siblings in fs.watch. */
  ownsWatchedPath(filename: string | null): boolean {
    if (!filename || filename.includes(path.sep)) return false;
    return filename === WORKSPACE_INDEX_STATE_FILENAME
      || filename.startsWith(`.${WORKSPACE_INDEX_STATE_FILENAME}.`);
  }

  private persist(): void {
    writeJsonFileAtomic(this.statePath, {
      version: 1,
      memoryInstanceToken: this.memoryInstanceTokenValue,
      entries: this.list(),
    } satisfies WorkspaceIndexStateDocument);
  }
}

function decodeState(value: unknown): WorkspaceIndexStateDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyState();
  const candidate = value as Partial<WorkspaceIndexStateDocument>;
  if (candidate.version !== 1 || !Array.isArray(candidate.entries)) return emptyState();
  return {
    version: 1,
    memoryInstanceToken: typeof candidate.memoryInstanceToken === 'string'
      ? candidate.memoryInstanceToken
      : null,
    entries: candidate.entries.filter(isIndexRecord),
  };
}

function emptyState(): WorkspaceIndexStateDocument {
  return { version: 1, memoryInstanceToken: null, entries: [] };
}

function isIndexRecord(value: unknown): value is WorkspaceIndexRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<WorkspaceIndexRecord>;
  return typeof candidate.workspaceId === 'string'
    && typeof candidate.path === 'string'
    && typeof candidate.fingerprint === 'string'
    && typeof candidate.size === 'number'
    && Number.isFinite(candidate.size)
    && candidate.size >= 0
    && typeof candidate.modifiedAtMs === 'number'
    && Number.isFinite(candidate.modifiedAtMs)
    && typeof candidate.parserVersion === 'string'
    && (
      candidate.status === 'ready'
      || candidate.status === 'unsupported'
      || candidate.status === 'error'
      || candidate.status === 'indexing'
    );
}

function keyFor(workspaceId: string, relativePath: string): string {
  return `${workspaceId}:${relativePath}`;
}
