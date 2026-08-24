import { ManagedBackendClient } from './managed-backend-client.ts';
import {
  RemoteBridgeHttpError,
  RemoteComposioBridgeClient,
  type RemoteBridgeToolkitView,
  type RemoteDisconnectConnectionResult,
  type RemoteProviderRevocation,
} from './composio-bridge-client.ts';
import {
  ConnectionsStore,
  type ConnectionRecord,
  type ConnectionRequestRecord,
  type ConnectionRequestStatus,
} from '../http/connections-store.ts';

export interface ConnectionRequestView {
  id: string;
  toolkitSlug: string;
  toolkitName: string;
  logoUrl: string | null;
  status: ConnectionRequestStatus;
  redirectUrl: string | null;
  connectedAccountId: string | null;
  errorMessage: string | null;
}

export interface ConnectionView {
  connectedAccountId: string;
  toolkitSlug: string;
  toolkitName: string;
  logoUrl: string | null;
  status: 'active' | 'inactive';
}

export interface DisconnectConnectionView {
  connectedAccountId: string;
  composioAccountDeleted: true;
  providerRevocation: RemoteProviderRevocation;
}

export interface ToolkitView {
  slug: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  categories: string[];
  authSchemes: string[];
  composioManagedAuthSchemes: string[];
  connected: boolean;
  connectedAccountId: string | null;
  noAuth: boolean;
}

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export class ConnectionsService {
  private readonly store: ConnectionsStore;

  private readonly bridgeClient: RemoteComposioBridgeClient;
  private readonly onConnectionsChanged: (() => void) | null;
  private readonly managedBackend: ManagedBackendClient;

  constructor(
    managedBackend: ManagedBackendClient,
    store = new ConnectionsStore(),
    onConnectionsChanged: (() => void) | null = null,
  ) {
    this.store = store;
    this.bridgeClient = new RemoteComposioBridgeClient(managedBackend);
    this.onConnectionsChanged = onConnectionsChanged;
    this.managedBackend = managedBackend;
  }

  get configured(): boolean {
    return this.bridgeClient.configured;
  }

  get storePath(): string {
    return this.store.path;
  }

  private remoteSyncInFlight: Promise<ConnectionView[]> | null = null;

  /**
   * With `maxWaitMs`, races the remote sync against the deadline and falls
   * back to the local cache when the remote is slower — the sync keeps
   * running in the background and lands in the store for the next fetch.
   * Only the app's boot fetch uses this; every mutation flow (connect,
   * disconnect, request polling) calls without it and keeps full-fresh
   * semantics. An empty cache (first ever run) always waits for the remote.
   */
  async listConnections(opts: { maxWaitMs?: number } = {}): Promise<ConnectionView[]> {
    const sync = this.syncFromRemote();
    const cached = this.store.listConnections().map(toConnectionView);
    if (typeof opts.maxWaitMs === 'number' && cached.length > 0) {
      const fresh = await Promise.race([
        sync.catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), opts.maxWaitMs)),
      ]);
      return fresh ?? cached;
    }
    try {
      return await sync;
    } catch {
      return this.store.listConnections().map(toConnectionView);
    }
  }

  // Shared in-flight sync: a bounded boot fetch and its follow-up full fetch
  // ride the same remote round-trip instead of issuing two.
  private syncFromRemote(): Promise<ConnectionView[]> {
    if (this.remoteSyncInFlight) return this.remoteSyncInFlight;
    const run = (async () => {
      const remote = await this.bridgeClient.listConnections();
      // Composio's delete is soft + eventually consistent: an account we
      // just disconnected can still come back in the list for a few
      // seconds. The tombstone filter keeps disconnected accounts out of
      // the sidebar until Composio's view catches up, so the row doesn't
      // pop back with an "Active" tag right after the user removes it.
      const filtered = remote.filter((item) => !this.store.isTombstoned(item.connectedAccountId));
      syncRemoteConnectionsIntoStore(this.store, filtered);
      this.notifyConnectionsChanged();
      return mergeConnectionViews(filtered, this.store.listConnections().map(toConnectionView));
    })();
    this.remoteSyncInFlight = run.finally(() => {
      this.remoteSyncInFlight = null;
    });
    return this.remoteSyncInFlight;
  }

  async listToolkits(opts: { query?: string; cursor?: string; limit?: number } = {}): Promise<{
    toolkits: ToolkitView[];
    nextCursor: string | null;
  }> {
    this.assertConfigured();
    const localConnections = this.store.listConnections().map(toConnectionView);

    try {
      const items = (await this.bridgeClient.listToolkits(opts.query, opts.limit))
        .map((toolkit) => this.clearTombstonedToolkitConnection(toolkit));
      return {
        toolkits: mergeToolkitViewsWithStoredConnections(items, localConnections, opts.query),
        nextCursor: null,
      };
    } catch {
      return {
        toolkits: mergeToolkitViewsWithStoredConnections([], localConnections, opts.query),
        nextCursor: null,
      };
    }
  }

  async deleteConnection(connectedAccountId: string): Promise<DisconnectConnectionView> {
    this.assertConfigured();
    const trimmedId = connectedAccountId.trim();
    if (!trimmedId) {
      throw new HttpError(400, 'Missing "connectedAccountId"');
    }

    let remote: RemoteDisconnectConnectionResult | null = null;
    try {
      remote = await this.bridgeClient.deleteConnection(trimmedId);
    } catch (error) {
      if (!(error instanceof RemoteBridgeHttpError && error.status === 404)) {
        // Retryable failure: keep the local row so the sidebar's optimistic
        // rollback restores it and the user can retry the revocation.
        throw mapRemoteBridgeError(error);
      }
      // DELETE is idempotent from the sidebar's point of view. If the
      // backend no longer finds the account for this user, remove any stale
      // local cache row so an old persisted connection cannot keep showing.
    }

    // The local row is removed only after the managed backend confirmed the
    // Composio deletion (or reported the account already absent).
    this.store.deleteConnection(trimmedId);
    this.notifyConnectionsChanged();
    return {
      connectedAccountId: trimmedId,
      composioAccountDeleted: true,
      providerRevocation: remote?.providerRevocation ?? 'already_absent',
    };
  }

  async requestConnection(toolkitSlug: string, baseUrl: string): Promise<ConnectionRequestView> {
    this.assertConfigured();

    try {
      const request = await this.bridgeClient.requestConnection(toolkitSlug, `${baseUrl}/connections/callback`);
      syncRemoteRequestIntoStore(this.store, request);
      this.notifyConnectionsChanged();
      return request;
    } catch (error) {
      throw mapRemoteBridgeError(error);
    }
  }

  async getRequest(requestId: string): Promise<ConnectionRequestView | null> {
    try {
      const beforeIds = new Set(this.store.listConnections().map((c) => c.connectedAccountId));
      const request = await this.bridgeClient.getRequest(requestId);
      syncRemoteRequestIntoStore(this.store, request);
      for (const connection of this.store.listConnections()) {
        if (!beforeIds.has(connection.connectedAccountId)) {
          this.managedBackend.recordAnalyticsEvent({ eventType: 'connection_added' });
        }
      }
      this.notifyConnectionsChanged();
      return request;
    } catch {
      const cached = this.store.getRequest(requestId);
      return cached ? toRequestView(cached) : null;
    }
  }

  getRequestRedirectUrl(requestId: string): string | null {
    return this.store.getRequest(requestId)?.redirectUrl ?? null;
  }

  private assertConfigured(): void {
    if (this.bridgeClient.configured) return;
    throw new HttpError(503, 'Managed backend URL is not configured.');
  }

  private notifyConnectionsChanged(): void {
    try {
      this.onConnectionsChanged?.();
    } catch {
      // Manifest refresh is best-effort and must not break connection flows.
    }
  }

  private clearTombstonedToolkitConnection(toolkit: RemoteBridgeToolkitView): RemoteBridgeToolkitView {
    const connectedAccountId = toolkit.connectedAccountId?.trim();
    if (!connectedAccountId || !this.store.isTombstoned(connectedAccountId)) return toolkit;
    return {
      ...toolkit,
      connected: false,
      connectedAccountId: null,
    };
  }
}

function mapRemoteBridgeError(error: unknown): HttpError {
  if (error instanceof RemoteBridgeHttpError) {
    return new HttpError(error.status, error.message);
  }
  return new HttpError(500, error instanceof Error ? error.message : String(error));
}

function toRequestView(record: ConnectionRequestRecord): ConnectionRequestView {
  return {
    id: record.id,
    toolkitSlug: record.toolkitSlug,
    toolkitName: record.toolkitName,
    logoUrl: record.logoUrl,
    status: record.status,
    redirectUrl: record.redirectUrl,
    connectedAccountId: record.connectedAccountId,
    errorMessage: record.errorMessage,
  };
}

function toConnectionView(record: ConnectionRecord): ConnectionView {
  return {
    connectedAccountId: record.connectedAccountId,
    toolkitSlug: record.toolkitSlug,
    toolkitName: record.toolkitName,
    logoUrl: record.logoUrl,
    status: record.status,
  };
}

function syncRemoteConnectionsIntoStore(
  store: ConnectionsStore,
  connections: ConnectionView[],
): void {
  const now = new Date().toISOString();
  const existingById = new Map(store.listConnections().map((item) => [item.connectedAccountId, item]));
  const records = connections.map((connection) => {
    const existing = existingById.get(connection.connectedAccountId);
    return {
      connectedAccountId: connection.connectedAccountId,
      toolkitSlug: connection.toolkitSlug,
      toolkitName: connection.toolkitName,
      logoUrl: connection.logoUrl,
      status: connection.status,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    } satisfies ConnectionRecord;
  });
  store.replaceConnections(records);
}

function syncRemoteRequestIntoStore(
  store: ConnectionsStore,
  request: ConnectionRequestView,
): void {
  const now = new Date().toISOString();
  const existingRequest = store.getRequest(request.id);
  store.upsertRequest({
    id: request.id,
    toolkitSlug: request.toolkitSlug,
    toolkitName: request.toolkitName,
    logoUrl: request.logoUrl,
    status: request.status,
    redirectUrl: request.redirectUrl ?? existingRequest?.redirectUrl ?? null,
    connectedAccountId: request.connectedAccountId,
    errorMessage: request.errorMessage,
    createdAt: existingRequest?.createdAt ?? now,
    updatedAt: now,
  });

  if (request.status === 'connected' && request.connectedAccountId) {
    const existingConnection = store.listConnections()
      .find((item) => item.connectedAccountId === request.connectedAccountId);
    store.upsertConnection({
      connectedAccountId: request.connectedAccountId,
      toolkitSlug: request.toolkitSlug,
      toolkitName: request.toolkitName,
      logoUrl: request.logoUrl,
      status: 'active',
      createdAt: existingConnection?.createdAt ?? now,
      updatedAt: now,
    });
  }
}

function mergeConnectionViews(remote: ConnectionView[], local: ConnectionView[]): ConnectionView[] {
  const merged = new Map<string, ConnectionView>();

  for (const connection of local) {
    merged.set(connection.connectedAccountId, connection);
  }

  for (const connection of remote) {
    merged.set(connection.connectedAccountId, { ...connection });
  }

  return Array.from(merged.values()).sort((left, right) => left.toolkitName.localeCompare(right.toolkitName));
}

function mergeToolkitViewsWithStoredConnections(
  remote: RemoteBridgeToolkitView[],
  localConnections: ConnectionView[],
  query?: string,
): ToolkitView[] {
  const merged = new Map(remote.map((toolkit) => [toolkit.slug, { ...toolkit }]));

  for (const connection of localConnections) {
    const existing = merged.get(connection.toolkitSlug);
    if (existing) {
      merged.set(connection.toolkitSlug, {
        ...existing,
        connected: connection.status === 'active',
        connectedAccountId: connection.connectedAccountId,
        logoUrl: existing.logoUrl ?? connection.logoUrl,
      });
      continue;
    }

    if (query && !matchesStoredConnectionQuery(connection, normalizeSearchQuery(query))) {
      continue;
    }

    merged.set(connection.toolkitSlug, {
      slug: connection.toolkitSlug,
      name: connection.toolkitName,
      description: null,
      logoUrl: connection.logoUrl,
      categories: [],
      authSchemes: [],
      composioManagedAuthSchemes: [],
      connected: connection.status === 'active',
      connectedAccountId: connection.connectedAccountId,
      noAuth: false,
    });
  }

  return Array.from(merged.values()).sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeSearchQuery(value: string): string {
  return value.trim().toLowerCase();
}

function matchesStoredConnectionQuery(connection: ConnectionView, normalizedQuery: string): boolean {
  const compactQuery = normalizedQuery.replace(/\s+/g, '');
  const haystacks = [
    connection.toolkitSlug.toLowerCase(),
    connection.toolkitSlug.toLowerCase().replace(/[_-]+/g, ''),
    connection.toolkitName.toLowerCase(),
  ];
  return haystacks.some((value) => value.includes(normalizedQuery) || value.includes(compactQuery));
}
