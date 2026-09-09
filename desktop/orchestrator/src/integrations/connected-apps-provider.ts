import type {
  BridgeConnectionRequestView, BridgeConnectionView, BridgeSearchToolResult,
  BridgeToolkitView, BridgeToolExecutionView, BridgeToolSchemaView,
  DisconnectConnectionResult,
} from '@verso/composio';

/** Connection lifecycle and tools, independent of who operates the broker. */
export interface ConnectedAppsProvider {
  readonly configured: boolean;
  listConnections(): Promise<BridgeConnectionView[]>;
  deleteConnection(id: string): Promise<DisconnectConnectionResult>;
  listToolkits(query?: string, limit?: number): Promise<BridgeToolkitView[]>;
  requestConnection(toolkit: string, callbackUrl: string): Promise<BridgeConnectionRequestView>;
  getRequest(id: string): Promise<BridgeConnectionRequestView>;
  listTools(toolkits: string[]): Promise<BridgeSearchToolResult[]>;
  getToolSchemas(slugs: string[]): Promise<BridgeToolSchemaView[]>;
  executeTool(slug: string, args: Record<string, unknown>): Promise<BridgeToolExecutionView>;
}

export class ConnectedAppsError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ConnectedAppsError';
  }
}
