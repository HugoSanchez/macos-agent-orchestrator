import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonFileOr, writeJsonFileAtomic } from '../shared/atomic-json-file.ts';

export type ConnectionRequestStatus = 'pending' | 'connected' | 'failed' | 'expired';
export type ConnectionStatus = 'active' | 'inactive';

export interface ConnectionRequestRecord {
  id: string;
  toolkitSlug: string;
  toolkitName: string;
  logoUrl: string | null;
  status: ConnectionRequestStatus;
  redirectUrl: string | null;
  connectedAccountId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionRecord {
  connectedAccountId: string;
  toolkitSlug: string;
  toolkitName: string;
  logoUrl: string | null;
  status: ConnectionStatus;
  createdAt: string;
  updatedAt: string;
}

interface ConnectionsStoreShape {
  versoUserId: string | null;
  requests: ConnectionRequestRecord[];
  connections: ConnectionRecord[];
}

function defaultStorePath(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'verso', 'connections.json');
}

export function defaultComposioToolsRefreshMarkerPath(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'verso', 'composio-tools-refresh.marker');
}

// Composio's DELETE /connected_accounts/:id is a soft-delete that's
// eventually consistent. For a short window after a successful delete the
// list endpoint can still return the account as ACTIVE, which would make
// the disconnected toolkit reappear in the sidebar a moment later. We keep
// a brief in-memory tombstone per id and filter any remote list against
// it. 60s comfortably covers observed propagation; entries expire on read.
const DELETED_CONNECTION_TOMBSTONE_TTL_MS = 60_000;

export class ConnectionsStore {
  private readonly storePath: string;
  private readonly toolsRefreshMarkerPath: string;

  private state: ConnectionsStoreShape;

  private readonly tombstones = new Map<string, number>();

  constructor(
    storePath = process.env.VERSO_CONNECTIONS_STORE_PATH?.trim() || defaultStorePath(),
    toolsRefreshMarkerPath = process.env.VERSO_COMPOSIO_TOOLS_REFRESH_MARKER_PATH?.trim() || defaultComposioToolsRefreshMarkerPath(),
  ) {
    this.storePath = storePath;
    this.toolsRefreshMarkerPath = toolsRefreshMarkerPath;
    this.state = this.load();
  }

  get path(): string {
    return this.storePath;
  }

  getversoUserId(): string | null {
    return this.state.versoUserId;
  }

  ensureversoUserId(): string {
    if (this.state.versoUserId) return this.state.versoUserId;
    this.state.versoUserId = randomUUID();
    this.save();
    return this.state.versoUserId;
  }

  listConnections(): ConnectionRecord[] {
    return [...this.state.connections].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  findActiveConnectionByToolkit(toolkitSlug: string): ConnectionRecord | null {
    return this.state.connections.find((connection) =>
      connection.toolkitSlug === toolkitSlug && connection.status === 'active') ?? null;
  }

  upsertConnection(record: ConnectionRecord): ConnectionRecord {
    const existingIndex = this.state.connections.findIndex((item) => item.connectedAccountId === record.connectedAccountId);
    const existing = existingIndex >= 0 ? this.state.connections[existingIndex] : null;
    if (existingIndex >= 0) {
      this.state.connections[existingIndex] = record;
    } else {
      this.state.connections.push(record);
    }
    this.save();
    if (didToolAvailabilityChange(existing, record)) {
      this.touchToolsRefreshMarker();
    }
    return record;
  }

  replaceConnections(records: ConnectionRecord[]): void {
    const previous = this.state.connections;
    const deduped = new Map<string, ConnectionRecord>();
    for (const record of records) {
      deduped.set(record.connectedAccountId, record);
    }
    const next = Array.from(deduped.values());
    const availabilityChanged = connectionAvailabilitySignature(previous) !== connectionAvailabilitySignature(next);
    const persistedChanged = connectionPersistenceSignature(previous) !== connectionPersistenceSignature(next);

    if (!persistedChanged) return;

    this.state.connections = next;
    this.save();
    if (availabilityChanged) {
      this.touchToolsRefreshMarker();
    }
  }

  deleteConnection(connectedAccountId: string): boolean {
    const before = this.state.connections.length;
    this.state.connections = this.state.connections.filter(
      (item) => item.connectedAccountId !== connectedAccountId,
    );
    const removed = this.state.connections.length !== before;
    this.tombstones.set(connectedAccountId, Date.now() + DELETED_CONNECTION_TOMBSTONE_TTL_MS);
    if (removed) {
      this.save();
    }
    this.touchToolsRefreshMarker();
    return removed;
  }

  isTombstoned(connectedAccountId: string): boolean {
    const expiresAt = this.tombstones.get(connectedAccountId);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.tombstones.delete(connectedAccountId);
      return false;
    }
    return true;
  }

  getRequest(requestId: string): ConnectionRequestRecord | null {
    return this.state.requests.find((request) => request.id === requestId) ?? null;
  }

  listRequests(): ConnectionRequestRecord[] {
    return [...this.state.requests].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  upsertRequest(record: ConnectionRequestRecord): ConnectionRequestRecord {
    const existingIndex = this.state.requests.findIndex((item) => item.id === record.id);
    if (existingIndex >= 0) {
      this.state.requests[existingIndex] = record;
    } else {
      this.state.requests.push(record);
    }
    this.save();
    return record;
  }

  private load(): ConnectionsStoreShape {
    return readJsonFileOr(
      this.storePath,
      (value) => {
        const parsed = isObject(value) ? value as Partial<ConnectionsStoreShape> : {};
        return {
          versoUserId: typeof parsed.versoUserId === 'string' ? parsed.versoUserId : null,
          requests: Array.isArray(parsed.requests)
            ? parsed.requests.filter(isValidRequestRecord)
            : [],
          connections: Array.isArray(parsed.connections)
            ? parsed.connections.filter(isValidConnectionRecord)
            : [],
        };
      },
      () => ({
        versoUserId: null,
        requests: [],
        connections: [],
      }),
    );
  }

  private save(): void {
    writeJsonFileAtomic(this.storePath, this.state);
  }

  private touchToolsRefreshMarker(): void {
    mkdirSync(path.dirname(this.toolsRefreshMarkerPath), { recursive: true });
    writeFileSync(this.toolsRefreshMarkerPath, `${Date.now()}\n`, 'utf8');
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidRequestRecord(value: unknown): value is ConnectionRequestRecord {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ConnectionRequestRecord>;
  return typeof candidate.id === 'string'
    && typeof candidate.toolkitSlug === 'string'
    && typeof candidate.toolkitName === 'string'
    && isNullableString(candidate.logoUrl)
    && isNullableString(candidate.redirectUrl)
    && isNullableString(candidate.connectedAccountId)
    && isNullableString(candidate.errorMessage)
    && typeof candidate.createdAt === 'string'
    && typeof candidate.updatedAt === 'string'
    && isRequestStatus(candidate.status);
}

function isValidConnectionRecord(value: unknown): value is ConnectionRecord {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ConnectionRecord>;
  return typeof candidate.connectedAccountId === 'string'
    && typeof candidate.toolkitSlug === 'string'
    && typeof candidate.toolkitName === 'string'
    && isNullableString(candidate.logoUrl)
    && typeof candidate.createdAt === 'string'
    && typeof candidate.updatedAt === 'string'
    && isConnectionStatus(candidate.status);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isRequestStatus(value: unknown): value is ConnectionRequestStatus {
  return value === 'pending' || value === 'connected' || value === 'failed' || value === 'expired';
}

function isConnectionStatus(value: unknown): value is ConnectionStatus {
  return value === 'active' || value === 'inactive';
}

function didToolAvailabilityChange(
  previous: ConnectionRecord | null,
  next: ConnectionRecord,
): boolean {
  if (!previous) return true;

  return previous.connectedAccountId !== next.connectedAccountId
    || previous.toolkitSlug !== next.toolkitSlug
    || previous.toolkitName !== next.toolkitName
    || previous.logoUrl !== next.logoUrl
    || previous.status !== next.status;
}

function connectionAvailabilitySignature(records: ConnectionRecord[]): string {
  return records
    .map((record) => [
      record.connectedAccountId,
      record.toolkitSlug,
      record.toolkitName,
      record.logoUrl ?? '',
      record.status,
    ].join('\t'))
    .sort()
    .join('\n');
}

function connectionPersistenceSignature(records: ConnectionRecord[]): string {
  return records
    .map((record) => [
      record.connectedAccountId,
      record.toolkitSlug,
      record.toolkitName,
      record.logoUrl ?? '',
      record.status,
      record.createdAt,
      record.updatedAt,
    ].join('\t'))
    .sort()
    .join('\n');
}
