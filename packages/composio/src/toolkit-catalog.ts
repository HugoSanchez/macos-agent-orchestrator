import { ComposioServiceError } from './errors.ts';
import type {
  BridgeConnectionView,
  BridgeSearchToolResult,
  BridgeToolkitView,
  CatalogToolkitItem,
  ComposioClient,
  ComposioFetch,
  ToolkitSdkItem,
  ToolkitToolItem,
} from './contracts.ts';
import {
  dedupeSearchToolResults,
  dedupeToolkitCatalogItems,
  isNonEmptyString,
  matchesToolkitQuery,
  matchesToolQuery,
  normalizeSearchQuery,
  normalizeToolkitLimit,
  normalizeToolkits,
  rankToolkits,
  toolkitInputCandidates,
} from './shared.ts';

export interface ToolkitCatalogOptions {
  apiKey: string;
  client: ComposioClient;
  allowedToolkits?: string;
  fetch?: ComposioFetch;
}

/** Owns toolkit policy, catalog discovery, alias resolution, and catalog REST calls. */
export class ComposioToolkitCatalog {
  private readonly allowedToolkits: Set<string> | null;

  private readonly fetch: ComposioFetch;

  constructor(private readonly options: ToolkitCatalogOptions) {
    this.allowedToolkits = parseAllowedToolkits(options.allowedToolkits);
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async listToolkits(
    connections: BridgeConnectionView[],
    opts: { query?: string; limit?: number } = {},
  ): Promise<BridgeToolkitView[]> {
    const query = opts.query?.trim() || undefined;
    const limit = normalizeToolkitLimit(opts.limit);
    const items = await this.searchCatalog(query, limit);
    const connectedByToolkit = indexConnections(connections);

    return items
      .filter((toolkit) => this.isAllowed(toolkit.slug))
      .map((toolkit) => {
        const connected = connectedByToolkit.get(toolkit.slug) ?? null;
        return {
          ...catalogItemToView(toolkit),
          connected: connected?.status === 'active',
          connectedAccountId: connected?.connectedAccountId ?? null,
        };
      });
  }

  async resolve(toolkitInput: string): Promise<BridgeToolkitView> {
    const normalizedInput = toolkitInput.trim().toLowerCase();
    if (!normalizedInput) throw new ComposioServiceError(400, 'Missing "toolkit"');

    try {
      const toolkit = await this.getToolkitByInput(toolkitInput);
      if (!this.isAllowed(toolkit.slug)) {
        throw new ComposioServiceError(400, `Toolkit "${toolkitInput}" is not allowed by policy.`);
      }
      return sdkToolkitToView(toolkit);
    } catch (error: unknown) {
      // Policy failures must never be converted into catalog fallback. Otherwise
      // an allowed-looking alias could bypass an exact denied toolkit lookup.
      if (error instanceof ComposioServiceError && error.message.includes('not allowed by policy')) {
        throw error;
      }
      const response = await this.searchCatalog(toolkitInput, 8);
      const ranked = rankToolkits(
        response.filter((toolkit) => this.isAllowed(toolkit.slug)).map(catalogItemToView),
        normalizedInput,
      );
      const best = ranked[0];
      if (best && (ranked.length === 1 || best.score > ranked[1].score)) return best.toolkit;
      if (ranked.length === 0) {
        throw new ComposioServiceError(404, `No Composio toolkit found for "${toolkitInput}".`);
      }
      const suggestions = ranked.slice(0, 4).map(({ toolkit }) => `${toolkit.name} (${toolkit.slug})`).join(', ');
      throw new ComposioServiceError(400, `Toolkit "${toolkitInput}" is ambiguous. Try one of: ${suggestions}`);
    }
  }

  async listTools(toolkits: string[]): Promise<BridgeSearchToolResult[]> {
    const normalizedToolkits = normalizeToolkits(toolkits);
    if (!normalizedToolkits?.length) throw new ComposioServiceError(400, 'Missing "toolkits"');
    const results: BridgeSearchToolResult[] = [];

    for (const toolkitInput of normalizedToolkits) {
      const toolkit = await this.resolve(toolkitInput);
      const items = await this.listToolkitTools(toolkit.slug);
      results.push(...items
        .filter((tool) => this.isAllowed(tool.toolkit?.slug ?? toolkit.slug))
        .map((tool) => toSearchToolView(tool, toolkit)));
    }
    return dedupeSearchToolResults(results);
  }

  async searchToolsDirect(toolkits: string[], query: string): Promise<BridgeSearchToolResult[]> {
    const normalizedQuery = normalizeSearchQuery(query);
    const results: BridgeSearchToolResult[] = [];
    for (const toolkitInput of toolkits) {
      const toolkit = await this.resolve(toolkitInput);
      const items = await this.listToolkitTools(toolkit.slug);
      const matches = items.filter((tool) => matchesToolQuery(tool, normalizedQuery));
      results.push(...(matches.length > 0 ? matches : items).map((tool) => toSearchToolView(tool, toolkit)));
    }
    return dedupeSearchToolResults(results);
  }

  isAllowed(toolkitSlug: string): boolean {
    return !this.allowedToolkits || this.allowedToolkits.has(toolkitSlug.trim().toLowerCase());
  }

  async getMetadata(toolkitSlug: string): Promise<{ toolkitName: string; logoUrl: string | null }> {
    const fallback = {
      toolkitName: toolkitSlug === 'gmail'
        ? 'Gmail'
        : toolkitSlug.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()),
      logoUrl: null,
    };
    try {
      const toolkit = await this.options.client.toolkits.get(toolkitSlug);
      return { toolkitName: toolkit.name || fallback.toolkitName, logoUrl: toolkit.meta.logo ?? null };
    } catch {
      return fallback;
    }
  }

  private async searchCatalog(query: string | undefined, limit: number): Promise<CatalogToolkitItem[]> {
    const params = new URLSearchParams({
      managed_by: 'all',
      limit: String(query ? 200 : limit),
      sort_by: query ? 'alphabetically' : 'usage',
    });
    if (query) params.set('search', query);
    const response = await this.fetch(`https://backend.composio.dev/api/v3/toolkits?${params.toString()}`, {
      headers: { 'x-api-key': this.options.apiKey, Accept: 'application/json' },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ComposioServiceError(
        response.status,
        `Composio toolkits request failed (${response.status}): ${body || response.statusText}`,
      );
    }
    const body = await response.json() as { items?: CatalogToolkitItem[] };
    const items = Array.isArray(body.items) ? body.items : [];
    if (!query) return items.slice(0, limit);

    const matched = items.filter((toolkit) => matchesToolkitQuery(toolkit, normalizeSearchQuery(query))).slice(0, limit);
    const direct = await this.tryGetCatalogItem(query);
    return direct ? dedupeToolkitCatalogItems([direct, ...matched]).slice(0, limit) : matched;
  }

  private async getToolkitByInput(toolkitInput: string): Promise<ToolkitSdkItem> {
    let lastError: unknown = null;
    for (const candidate of toolkitInputCandidates(toolkitInput)) {
      try {
        return await this.options.client.toolkits.get(candidate);
      } catch (error: unknown) {
        lastError = error;
      }
    }
    throw lastError ?? new ComposioServiceError(404, `No Composio toolkit found for "${toolkitInput}".`);
  }

  private async tryGetCatalogItem(query: string): Promise<CatalogToolkitItem | null> {
    try {
      const toolkit = await this.getToolkitByInput(query);
      return {
        slug: toolkit.slug,
        name: toolkit.name,
        meta: {
          description: toolkit.meta.description ?? undefined,
          logo: toolkit.meta.logo ?? undefined,
          categories: toolkit.meta.categories ?? [],
        },
        authSchemes: toolkit.authConfigDetails?.map((detail) => detail.name).filter(isNonEmptyString) ?? [],
        composioManagedAuthSchemes: toolkit.composioManagedAuthSchemes ?? [],
        noAuth: false,
      };
    } catch {
      return null;
    }
  }

  private async listToolkitTools(toolkitSlug: string): Promise<ToolkitToolItem[]> {
    const response = await this.fetch(
      `https://backend.composio.dev/api/v3/tools?toolkit_slug=${encodeURIComponent(toolkitSlug)}&toolkit_versions=latest&limit=200`,
      { headers: { 'x-api-key': this.options.apiKey, Accept: 'application/json' } },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ComposioServiceError(
        response.status,
        `Composio tools request failed (${response.status}): ${body || response.statusText}`,
      );
    }
    const body = await response.json() as { items?: ToolkitToolItem[] };
    return Array.isArray(body.items) ? body.items : [];
  }
}

function parseAllowedToolkits(value: string | undefined): Set<string> | null {
  const toolkits = value?.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean) ?? [];
  return toolkits.length > 0 ? new Set(toolkits) : null;
}

function indexConnections(connections: BridgeConnectionView[]): Map<string, BridgeConnectionView> {
  const indexed = new Map<string, BridgeConnectionView>();
  for (const connection of connections) {
    if (!indexed.has(connection.toolkitSlug) || connection.status === 'active') {
      indexed.set(connection.toolkitSlug, connection);
    }
  }
  return indexed;
}

function catalogItemToView(toolkit: CatalogToolkitItem): BridgeToolkitView {
  return {
    slug: toolkit.slug,
    name: toolkit.name,
    description: toolkit.meta.description ?? null,
    logoUrl: toolkit.meta.logo ?? null,
    categories: toolkit.meta.categories?.map((category) => category.slug) ?? [],
    authSchemes: toolkit.authSchemes ?? [],
    composioManagedAuthSchemes: toolkit.composioManagedAuthSchemes ?? [],
    connected: false,
    connectedAccountId: null,
    noAuth: toolkit.noAuth ?? false,
  };
}

function sdkToolkitToView(toolkit: ToolkitSdkItem): BridgeToolkitView {
  return {
    slug: toolkit.slug,
    name: toolkit.name,
    description: toolkit.meta.description ?? null,
    logoUrl: toolkit.meta.logo ?? null,
    categories: toolkit.meta.categories?.map((category) => category.slug) ?? [],
    authSchemes: toolkit.authConfigDetails?.map((detail) => detail.name).filter(isNonEmptyString) ?? [],
    composioManagedAuthSchemes: toolkit.composioManagedAuthSchemes ?? [],
    connected: false,
    connectedAccountId: null,
    noAuth: false,
  };
}

function toSearchToolView(tool: ToolkitToolItem, fallback: BridgeToolkitView): BridgeSearchToolResult {
  return {
    slug: tool.slug,
    name: tool.name,
    description: tool.description ?? null,
    toolkitSlug: tool.toolkit?.slug ?? fallback.slug,
    toolkitName: tool.toolkit?.name ?? fallback.name,
  };
}
