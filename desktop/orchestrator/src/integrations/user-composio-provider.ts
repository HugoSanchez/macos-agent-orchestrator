import { ComposioService, ComposioServiceError } from '@verso/composio';
import { ConnectedAppsError, type ConnectedAppsProvider } from './connected-apps-provider.ts';

/** A local broker for one user-owned project. No Verso session or backend. */
export class UserComposioProvider implements ConnectedAppsProvider {
  private enabled = true;

  constructor(private readonly service: ComposioService | null, private readonly userId: string) {}

  get configured(): boolean { return this.enabled && this.service !== null; }

  disable(): void { this.enabled = false; }

  listConnections() { return this.call((s) => s.listConnections(this.userId)); }
  deleteConnection(id: string) { return this.call((s) => s.deleteConnection(this.userId, id)); }
  listToolkits(query?: string, limit?: number) {
    return this.call((s) => s.listToolkits(this.userId, { query, limit }));
  }
  requestConnection(toolkit: string, callbackUrl: string, addAccount = false) {
    // Only the loopback callback produced by ConnectionsService.
    const match = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/connections\/callback$/.exec(callbackUrl);
    if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) {
      return Promise.reject(new ConnectedAppsError(400, 'Invalid connection callback.'));
    }
    return this.call((s) => s.requestConnection(this.userId, toolkit, callbackUrl, addAccount));
  }
  getRequest(id: string) { return this.call((s) => s.getRequest(this.userId, id)); }
  listTools(toolkits: string[]) { return this.call((s) => s.listTools(this.userId, toolkits)); }
  getToolSchemas(slugs: string[]) { return this.call((s) => s.getToolSchemas(this.userId, slugs)); }
  executeTool(slug: string, args: Record<string, unknown>, connectedAccountId?: string) {
    return this.call(async (s) => {
      const result = await s.executeTool(this.userId, slug, args, connectedAccountId);
      return { ...result, error: result.error ? 'The connected app could not complete this tool call.' : null };
    });
  }

  private async call<T>(operation: (service: ComposioService) => Promise<T>): Promise<T> {
    if (!this.configured || !this.service) {
      throw new ConnectedAppsError(503, 'Configure your Composio project in Settings → Connected apps, then restart Verso.');
    }
    try {
      const result = await operation(this.service);
      // Removing the key also rejects responses from already-running calls.
      if (!this.enabled) throw new ConnectedAppsError(503, 'Composio access has been disabled.');
      return result;
    } catch (error) {
      if (error instanceof ConnectedAppsError) throw error;
      // SDK errors can include request headers/payloads. Never forward them.
      const status = error instanceof ComposioServiceError ? error.status : 502;
      throw new ConnectedAppsError(status, status === 404
        ? 'Connection not found in this Composio project.'
        : 'Composio request failed. Check your project key, permissions, and connection status.');
    }
  }
}

export function createUserComposioService(apiKey: string): ComposioService {
  // The broker owns the credential in memory. It is never put in Hermes' env
  // or configuration. Suppress SDK-facade diagnostics containing upstream errors.
  return new ComposioService(apiKey, { log: () => undefined });
}
