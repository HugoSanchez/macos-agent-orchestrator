export type ConnectionRequestStatus = 'pending' | 'connected' | 'failed' | 'expired';
export type ConnectionStatus = 'active' | 'inactive';

export interface BridgeConnectionRequestView {
  id: string;
  toolkitSlug: string;
  toolkitName: string;
  logoUrl: string | null;
  status: ConnectionRequestStatus;
  redirectUrl: string | null;
  connectedAccountId: string | null;
  errorMessage: string | null;
}

export interface BridgeConnectionView {
  connectedAccountId: string;
  toolkitSlug: string;
  toolkitName: string;
  logoUrl: string | null;
  status: ConnectionStatus;
}

export type ProviderRevocationStatus = 'revoked' | 'already_absent' | 'manual_action_required';

/**
 * Result of a disconnect after the provider-revocation attempt. Contains no
 * provider payload, credentials, or user data; safe to return to clients.
 */
export interface DisconnectConnectionResult {
  connectedAccountId: string;
  composioAccountDeleted: true;
  providerRevocation: ProviderRevocationStatus;
}

export interface BridgeToolkitView {
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

export interface BridgeSearchToolResult {
  slug: string;
  name: string;
  description: string | null;
  toolkitSlug: string | null;
  toolkitName: string | null;
}

export interface BridgeToolSchemaView {
  slug: string;
  name: string;
  description: string | null;
  toolkitSlug: string | null;
  toolkitName: string | null;
  inputParameters: Record<string, unknown> | null;
}

export interface BridgeToolExecutionView {
  data: unknown;
  error: string | null;
  logId: string | null;
}

export interface CatalogToolkitItem {
  slug: string;
  name: string;
  meta: {
    description?: string;
    logo?: string;
    categories?: Array<{ slug: string; name: string }>;
  };
  authSchemes?: string[];
  composioManagedAuthSchemes?: string[];
  noAuth?: boolean;
}

export interface ToolkitSdkItem {
  slug: string;
  name: string;
  meta: {
    description?: string | null;
    logo?: string | null;
    categories?: Array<{ slug: string; name: string }>;
  };
  authConfigDetails?: Array<{ name: string }>;
  composioManagedAuthSchemes?: string[];
}

export interface ToolkitToolItem {
  slug: string;
  name: string;
  description?: string | null;
  toolkit?: { slug?: string | null; name?: string | null } | null;
}

export interface ComposioToolView extends ToolkitToolItem {
  description: string | null;
  toolkit: { slug?: string | null; name?: string | null } | null;
  inputParameters: Record<string, unknown> | null;
}

export interface ConnectedAccountItem {
  id: string;
  status?: string;
  statusReason?: string | null;
  isDisabled?: boolean;
  toolkit: { slug: string };
}

export interface ToolRouterSessionLike {
  sessionId?: string;
  search: (params: { query: string; toolkits?: string[] }) => Promise<unknown>;
  execute: (toolSlug: string, arguments_: Record<string, unknown>) => Promise<unknown>;
  authorize?: (toolkitSlug: string, options: { callbackUrl: string }) => Promise<{
    id: string;
    status?: string;
    redirectUrl?: string | null;
  }>;
}

/** The narrow SDK surface used by the backend, intentionally injectable for tests. */
export interface ComposioClient {
  connectedAccounts: {
    list: (params: {
      userIds: string[];
      statuses?: string[];
      cursor?: string;
      limit?: number;
    }) => Promise<{ items: ConnectedAccountItem[]; nextCursor?: string | null }>;
    get: (id: string) => Promise<ConnectedAccountItem>;
    disable: (id: string) => Promise<unknown>;
    delete: (id: string) => Promise<unknown>;
  };
  toolkits: {
    get: (slug: string) => Promise<ToolkitSdkItem>;
  };
  tools: {
    getRawComposioToolBySlug: (slug: string) => Promise<unknown>;
  };
  create: (userId: string, options: {
    toolkits?: string[];
    manageConnections: false;
  }) => Promise<ToolRouterSessionLike>;
}

export type ComposioFetch = typeof fetch;
export type ComposioLog = (event: string, details: Record<string, unknown>) => void;
