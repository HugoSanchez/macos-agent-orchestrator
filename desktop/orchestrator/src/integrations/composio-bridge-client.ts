import { ConnectedAppsError as RemoteBridgeHttpError, type ConnectedAppsProvider } from './connected-apps-provider.ts';
import { ManagedBackendClient } from './managed-backend-client.ts';

import type {
  BridgeConnectionRequestView as RemoteBridgeConnectionRequestView,
  BridgeConnectionView as RemoteBridgeConnectionView,
  ProviderRevocationStatus as RemoteProviderRevocation,
  DisconnectConnectionResult as RemoteDisconnectConnectionResult,
  BridgeToolkitView as RemoteBridgeToolkitView,
  BridgeSearchToolResult as RemoteBridgeSearchToolResult,
  BridgeToolSchemaView as RemoteBridgeToolSchemaView,
  BridgeToolExecutionView as RemoteBridgeToolExecutionView,
} from '@verso/composio';

export type {
  RemoteBridgeConnectionRequestView,
  RemoteBridgeConnectionView,
  RemoteProviderRevocation,
  RemoteDisconnectConnectionResult,
  RemoteBridgeToolkitView,
  RemoteBridgeSearchToolResult,
  RemoteBridgeToolSchemaView,
  RemoteBridgeToolExecutionView,
};

export { ConnectedAppsError as RemoteBridgeHttpError } from './connected-apps-provider.ts';

/**
 * Composio proxy client that talks to the managed backend's /v1/composio/*
 * surface. Auth uses the user's in-memory managed session token.
 *
 * Tool discovery, schema lookup, and execution are proxied through the managed
 * backend so Verso’s managed project API key stays on its server.
 */
export class RemoteComposioBridgeClient implements ConnectedAppsProvider {
  private readonly managedBackend: ManagedBackendClient;
  private readonly baseUrl: string;

  constructor(managedBackend: ManagedBackendClient) {
    this.managedBackend = managedBackend;
    this.baseUrl = managedBackend.backendBaseUrl;
  }

  get configured(): boolean {
    return this.baseUrl.length > 0;
  }

  async listConnections(): Promise<RemoteBridgeConnectionView[]> {
    const body = await this.request<{ connections: RemoteBridgeConnectionView[] }>('GET', '/v1/composio/connections');
    return body.connections;
  }

  async deleteConnection(connectedAccountId: string): Promise<RemoteDisconnectConnectionResult> {
    const body = await this.request<{ disconnect?: unknown } | undefined>(
      'DELETE',
      `/v1/composio/connections/${encodeURIComponent(connectedAccountId)}`,
    );
    if (body === undefined) {
      // Only a genuine legacy 204 gets the compatibility fallback: that
      // backend deleted the record without confirming provider revocation,
      // so never upgrade it to "revoked" — surface the manual notice.
      return {
        connectedAccountId,
        composioAccountDeleted: true,
        providerRevocation: 'manual_action_required',
      };
    }
    return decodeDisconnectResult(body.disconnect, connectedAccountId);
  }

  async listToolkits(query?: string, limit?: number): Promise<RemoteBridgeToolkitView[]> {
    const params = new URLSearchParams();
    if (query && query.trim().length > 0) params.set('query', query.trim());
    if (typeof limit === 'number' && Number.isFinite(limit)) params.set('limit', String(Math.floor(limit)));
    const suffix = params.toString();
    const path = suffix ? `/v1/composio/toolkits?${suffix}` : '/v1/composio/toolkits';
    const body = await this.request<{ toolkits: RemoteBridgeToolkitView[] }>('GET', path);
    return body.toolkits;
  }

  async requestConnection(
    toolkit: string,
    callbackUrl: string,
  ): Promise<RemoteBridgeConnectionRequestView> {
    const body = await this.request<{ request: RemoteBridgeConnectionRequestView }>(
      'POST',
      '/v1/composio/connections/request',
      { toolkit, callbackUrl },
    );
    return body.request;
  }

  async getRequest(requestId: string): Promise<RemoteBridgeConnectionRequestView> {
    const body = await this.request<{ request: RemoteBridgeConnectionRequestView }>(
      'GET',
      `/v1/composio/connections/requests/${encodeURIComponent(requestId)}`,
    );
    return body.request;
  }

  async listTools(toolkits: string[]): Promise<RemoteBridgeSearchToolResult[]> {
    const body = await this.request<{ tools: RemoteBridgeSearchToolResult[] }>(
      'POST',
      '/v1/composio/tools/list',
      { toolkits },
    );
    return body.tools;
  }

  async getToolSchemas(
    toolSlugs: string[],
  ): Promise<RemoteBridgeToolSchemaView[]> {
    const body = await this.request<{ tools: RemoteBridgeToolSchemaView[] }>(
      'POST',
      '/v1/composio/tools/schemas',
      { toolSlugs },
    );
    return body.tools;
  }

  async executeTool(
    toolSlug: string,
    arguments_: Record<string, unknown>,
  ): Promise<RemoteBridgeToolExecutionView> {
    const body = await this.request<{ result: RemoteBridgeToolExecutionView }>(
      'POST',
      '/v1/composio/tools/execute',
      {
        toolSlug,
        arguments: arguments_,
      },
    );
    return body.result;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.configured) {
      throw new RemoteBridgeHttpError(503, 'Managed backend URL is not configured.');
    }

    const session = this.managedBackend.getStoredSession();
    if (!session) {
      throw new RemoteBridgeHttpError(401, 'No managed session is loaded — sign in to use Composio.');
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${session.token}`,
      'X-Verso-Device-ID': session.deviceId,
    };

    let payload: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { method, headers, body: payload });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RemoteBridgeHttpError(502, `Backend Composio request failed: ${message}`);
    }

    if (!response.ok) {
      const message = await readError(response, `${method} ${path} failed`);
      throw new RemoteBridgeHttpError(response.status, message);
    }

    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
}

const REMOTE_PROVIDER_REVOCATIONS: readonly RemoteProviderRevocation[] =
  ['revoked', 'already_absent', 'manual_action_required'];

// A 200 body must positively confirm the deletion of the account we asked
// about before the caller may drop the local row. Missing fields, a false
// deletion flag, or a mismatched id all mean the deletion is unconfirmed and
// must fail retryably. Only an otherwise valid result with an unrecognized
// revocation status degrades to manual_action_required — the deletion is
// confirmed there, just not the provider-side revocation.
function decodeDisconnectResult(value: unknown, expectedId: string): RemoteDisconnectConnectionResult {
  const record = value && typeof value === 'object'
    ? value as {
      connectedAccountId?: unknown;
      composioAccountDeleted?: unknown;
      providerRevocation?: unknown;
    }
    : null;
  if (!record
    || record.connectedAccountId !== expectedId
    || record.composioAccountDeleted !== true
    || typeof record.providerRevocation !== 'string') {
    // Static message: no upstream payload can leak into client errors.
    throw new RemoteBridgeHttpError(502, 'Managed backend returned an invalid disconnect result.');
  }
  const providerRevocation = REMOTE_PROVIDER_REVOCATIONS.includes(record.providerRevocation as RemoteProviderRevocation)
    ? record.providerRevocation as RemoteProviderRevocation
    : 'manual_action_required';
  return {
    connectedAccountId: expectedId,
    composioAccountDeleted: true,
    providerRevocation,
  };
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { message?: unknown };
    return typeof body.message === 'string' && body.message.trim().length > 0
      ? body.message
      : fallback;
  } catch {
    return fallback;
  }
}
