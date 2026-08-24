import { Composio } from '@composio/core';
import { ComposioAccountRevoker, type ConnectedAccountRevoker } from './account-revoker.ts';
import { ComposioConnections } from './connections.ts';
import { ComposioServiceError } from './errors.ts';
import { ComposioToolkitCatalog } from './toolkit-catalog.ts';
import { ComposioToolRouter } from './tool-router.ts';
import { normalizeUserId } from './shared.ts';
import type {
  BridgeConnectionRequestView,
  BridgeConnectionView,
  BridgeSearchToolResult,
  BridgeToolkitView,
  BridgeToolExecutionView,
  BridgeToolSchemaView,
  ComposioClient,
  ComposioFetch,
  ComposioLog,
  ConnectionRequestStatus,
  ConnectionStatus,
  DisconnectConnectionResult,
} from './contracts.ts';

export type {
  BridgeConnectionRequestView,
  BridgeConnectionView,
  BridgeSearchToolResult,
  BridgeToolkitView,
  BridgeToolExecutionView,
  BridgeToolSchemaView,
  ComposioClient,
  ConnectionRequestStatus,
  ConnectionStatus,
  DisconnectConnectionResult,
  ProviderRevocationStatus,
} from './contracts.ts';
export type { ConnectedAccountRevoker, ProviderRevocationResult } from './account-revoker.ts';
export { ComposioAccountRevoker } from './account-revoker.ts';
export { ComposioServiceError } from './errors.ts';

export interface ComposioServiceDependencies {
  /** A narrow injectable SDK client; omit to construct the production client. */
  client?: ComposioClient | null;
  fetch?: ComposioFetch;
  now?: () => number;
  log?: ComposioLog;
  sessionTtlMs?: number;
  allowedToolkits?: string;
  toolRouterToolkits?: string;
  /** Injectable provider-revocation boundary; omit to construct the production adapter. */
  accountRevoker?: ConnectedAccountRevoker;
}

/**
 * Stable facade for the backend routes. Each collaborator owns one source of
 * mutable state so connection changes can explicitly invalidate Tool Router
 * sessions without exposing SDK internals to callers or tests.
 */
export class ComposioService {
  private readonly client: ComposioClient | null;

  private readonly catalog: ComposioToolkitCatalog | null;

  private readonly connections: ComposioConnections | null;

  private readonly toolRouter: ComposioToolRouter | null;

  constructor(
    apiKey = process.env.COMPOSIO_API_KEY?.trim() || '',
    dependencies: ComposioServiceDependencies = {},
  ) {
    const normalizedApiKey = apiKey.trim();
    this.client = dependencies.client === undefined
      ? normalizedApiKey
        ? new Composio({ apiKey: normalizedApiKey }) as unknown as ComposioClient
        : null
      : dependencies.client;

    if (!this.client) {
      this.catalog = null;
      this.connections = null;
      this.toolRouter = null;
      return;
    }

    const allowedToolkits = dependencies.allowedToolkits ?? process.env.VERSO_COMPOSIO_ALLOWED_TOOLKITS;
    const toolkitScope = buildToolRouterToolkitScope(
      dependencies.toolRouterToolkits ?? process.env.VERSO_COMPOSIO_MCP_TOOLKITS,
      allowedToolkits,
    );
    this.catalog = new ComposioToolkitCatalog({
      apiKey: normalizedApiKey,
      client: this.client,
      allowedToolkits,
      fetch: dependencies.fetch,
    });
    this.toolRouter = new ComposioToolRouter({
      client: this.client,
      catalog: this.catalog,
      toolkitScope,
      now: dependencies.now,
      log: dependencies.log,
      sessionTtlMs: dependencies.sessionTtlMs,
    });
    // Disconnect lifecycle events must be recorded even when no logger is
    // injected: they carry only ids, toolkit slugs, and status codes, and are
    // the monitoring signal for revoke/delete failures.
    const lifecycleLog: ComposioLog = dependencies.log
      ?? ((event, details) => console.warn(`[composio] ${event}`, details));
    this.connections = new ComposioConnections({
      client: this.client,
      catalog: this.catalog,
      accountRevoker: dependencies.accountRevoker ?? new ComposioAccountRevoker({
        apiKey: normalizedApiKey,
        fetch: dependencies.fetch,
        log: lifecycleLog,
      }),
      log: lifecycleLog,
      onConnectionsChanged: (userId) => this.toolRouter?.invalidateUser(userId),
    });
  }

  get configured(): boolean {
    return this.client !== null;
  }

  async listConnections(userId: string): Promise<BridgeConnectionView[]> {
    this.assertConfigured();
    return this.connections!.list(userId);
  }

  async deleteConnection(userId: string, connectedAccountId: string): Promise<DisconnectConnectionResult> {
    this.assertConfigured();
    return this.connections!.delete(userId, connectedAccountId);
  }

  async listToolkits(
    userId: string,
    opts: { query?: string; limit?: number } = {},
  ): Promise<BridgeToolkitView[]> {
    this.assertConfigured();
    const connections = await this.connections!.list(normalizeUserId(userId));
    return this.catalog!.listToolkits(connections, opts);
  }

  async requestConnection(
    userId: string,
    toolkitSlug: string,
    callbackUrl: string,
  ): Promise<BridgeConnectionRequestView> {
    this.assertConfigured();
    return this.connections!.request(userId, toolkitSlug, callbackUrl);
  }

  async getRequest(userId: string, requestId: string): Promise<BridgeConnectionRequestView> {
    this.assertConfigured();
    return this.connections!.getRequest(userId, requestId);
  }

  async listTools(userId: string, toolkits: string[]): Promise<BridgeSearchToolResult[]> {
    this.assertConfigured();
    normalizeUserId(userId);
    return this.catalog!.listTools(toolkits);
  }

  async searchTools(userId: string, query: string, toolkits?: string[]): Promise<BridgeSearchToolResult[]> {
    this.assertConfigured();
    return this.toolRouter!.search(userId, query, toolkits);
  }

  async getToolSchemas(_userId: string, toolSlugs: string[]): Promise<BridgeToolSchemaView[]> {
    this.assertConfigured();
    return this.toolRouter!.getSchemas(toolSlugs);
  }

  async executeTool(
    userId: string,
    toolSlug: string,
    arguments_: Record<string, unknown> | undefined,
    _connectedAccountId?: string,
  ): Promise<BridgeToolExecutionView> {
    this.assertConfigured();
    return this.toolRouter!.execute(userId, toolSlug, arguments_);
  }

  private assertConfigured(): void {
    if (!this.client) {
      throw new ComposioServiceError(503, 'Composio backend is unavailable. Set COMPOSIO_API_KEY to enable it.');
    }
  }
}

function buildToolRouterToolkitScope(
  requestedValue: string | undefined,
  allowedValue: string | undefined,
): string[] | undefined {
  const requested = parseToolkitList(requestedValue);
  const allowed = parseToolkitList(allowedValue);
  if (!allowed) return requested;
  if (!requested) return allowed;
  const allowedSet = new Set(allowed);
  return requested.filter((toolkit) => allowedSet.has(toolkit));
}

function parseToolkitList(value: string | undefined): string[] | undefined {
  const toolkits = value?.trim().split(',').map((item) => item.trim().toLowerCase()).filter(Boolean) ?? [];
  return toolkits.length > 0 ? Array.from(new Set(toolkits)) : undefined;
}
