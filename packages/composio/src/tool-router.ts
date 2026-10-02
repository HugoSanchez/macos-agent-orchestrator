import { ComposioServiceError } from './errors.ts';
import type {
  BridgeSearchToolResult,
  BridgeToolExecutionView,
  BridgeToolSchemaView,
  ComposioClient,
  ComposioLog,
  ComposioToolView,
  ToolRouterSessionLike,
} from './contracts.ts';
import type { ComposioToolkitCatalog } from './toolkit-catalog.ts';
import {
  asRecord,
  asString,
  asStringArray,
  dedupeSearchToolResults,
  isComposioSchemaValidationError,
  normalizeToolkits,
  normalizeUserId,
} from './shared.ts';

interface CachedSession {
  session: Promise<ToolRouterSessionLike>;
  expiresAt: number;
}

export interface ComposioToolRouterOptions {
  client: ComposioClient;
  catalog: ComposioToolkitCatalog;
  toolkitScope?: string[];
  sessionTtlMs?: number;
  now?: () => number;
  log?: ComposioLog;
}

/** Owns Tool Router sessions, schema normalization/caching, and execution. */
export class ComposioToolRouter {
  private readonly sessions = new Map<string, CachedSession>();

  private readonly schemas = new Map<string, Promise<ComposioToolView>>();

  private readonly now: () => number;

  private readonly sessionTtlMs: number;

  private readonly log: ComposioLog;

  constructor(private readonly options: ComposioToolRouterOptions) {
    this.now = options.now ?? Date.now;
    this.sessionTtlMs = options.sessionTtlMs ?? 10 * 60 * 1000;
    this.log = options.log ?? logToolEvent;
  }

  invalidateUser(userId: string): void {
    this.sessions.delete(userId);
  }

  async search(userId: string, query: string, toolkits?: string[]): Promise<BridgeSearchToolResult[]> {
    const normalizedUserId = normalizeUserId(userId);
    const normalizedQuery = query.trim();
    if (!normalizedQuery) throw new ComposioServiceError(400, 'Missing "query"');
    const normalizedToolkits = normalizeToolkits(toolkits);

    try {
      const session = await this.getSession(normalizedUserId);
      const response = await session.search({
        query: normalizedQuery,
        ...(normalizedToolkits ? { toolkits: normalizedToolkits } : {}),
      });
      const slugs = parseToolRouterToolSlugs(response);
      if (slugs.length > 0) {
        const tools = await Promise.all(slugs.map(async (slug) => this.getTool(slug).catch(() => null)));
        const filtered = tools
          .filter((tool): tool is ComposioToolView => tool !== null)
          .filter((tool) => !normalizedToolkits || normalizedToolkits.includes(tool.toolkit?.slug?.trim().toLowerCase() ?? ''))
          .filter((tool) => !tool.toolkit?.slug || this.options.catalog.isAllowed(tool.toolkit.slug))
          .map(toSearchToolView);
        if (filtered.length > 0) return dedupeSearchToolResults(filtered);
      }
    } catch (error: unknown) {
      if (!normalizedToolkits?.length || !isComposioSchemaValidationError(error)) throw error;
    }

    return normalizedToolkits?.length
      ? this.options.catalog.searchToolsDirect(normalizedToolkits, normalizedQuery)
      : [];
  }

  async getSchemas(toolSlugs: string[]): Promise<BridgeToolSchemaView[]> {
    const wanted = new Set(toolSlugs.map((slug) => slug.trim()).filter(Boolean));
    if (wanted.size === 0) throw new ComposioServiceError(400, 'Missing "toolSlugs"');

    return Promise.all(Array.from(wanted).map(async (slug) => {
      try {
        const tool = await this.getTool(slug);
        const toolkitSlug = tool.toolkit?.slug ?? null;
        this.assertToolkitAllowed(toolkitSlug);
        return {
          slug: tool.slug,
          name: tool.name,
          description: tool.description,
          toolkitSlug,
          toolkitName: tool.toolkit?.name ?? null,
          inputParameters: compactInputParameters(tool.inputParameters),
        };
      } catch (error: unknown) {
        if (!isComposioSchemaValidationError(error)) throw error;
        this.log('composio.getSchemas.schemaUnavailable', {
          toolSlug: diagnosticToolSlug(slug),
          reason: 'upstream_schema_invalid',
        });
        return {
          slug,
          name: slug,
          description: 'Schema unavailable from Composio (malformed upstream). Call the tool with best-guess arguments.',
          toolkitSlug: null,
          toolkitName: null,
          inputParameters: null,
        };
      }
    }));
  }

  async execute(
    userId: string,
    toolSlug: string,
    arguments_: Record<string, unknown> | undefined,
    connectedAccountId?: string,
  ): Promise<BridgeToolExecutionView> {
    const normalizedUserId = normalizeUserId(userId);
    const slug = toolSlug.trim();
    if (!slug) throw new ComposioServiceError(400, 'Missing "toolSlug"');
    const argumentRecord = asRecord(arguments_);
    if (!argumentRecord) {
      this.log('composio.execute.rejected', { toolSlug: diagnosticToolSlug(slug), reason: 'missing_arguments' });
      throw new ComposioServiceError(400, 'Missing required object "arguments".');
    }

    let tool: ComposioToolView | null = null;
    try {
      tool = await this.getTool(slug);
    } catch (error: unknown) {
      if (!isComposioSchemaValidationError(error)) throw error;
      this.log('composio.execute.schemaUnavailable', {
        toolSlug: diagnosticToolSlug(slug),
        reason: 'upstream_schema_invalid',
      });
    }

    const executionSlug = tool?.slug ?? slug;
    this.assertToolkitAllowed(tool?.toolkit?.slug ?? null);
    if (connectedAccountId) {
      // IDs are supplied by callers. Verify user ownership and toolkit before
      // passing one to the project-scoped SDK execution endpoint.
      let cursor: string | undefined;
      const visited = new Set<string>();
      let owned = false;
      do {
        const page = await this.options.client.connectedAccounts.list({ userIds: [normalizedUserId], statuses: ['ACTIVE'], limit: 100, ...(cursor ? { cursor } : {}) });
        owned = page.items.some((account) => account.id === connectedAccountId && !account.isDisabled
          && account.toolkit.slug === tool?.toolkit?.slug);
        cursor = page.nextCursor || undefined;
        if (owned || !cursor || visited.has(cursor)) break;
        visited.add(cursor);
      } while (cursor);
      if (!owned) throw new ComposioServiceError(404, 'Connected account not found for this tool.');
    }
    if (tool) {
      const missing = getMissingRequiredToolArguments(tool.inputParameters, argumentRecord);
      if (missing.length > 0) {
        this.log('composio.execute.rejected', {
          toolSlug: diagnosticToolSlug(tool.slug),
          reason: 'missing_required_arguments',
          missingFieldCount: missing.length,
          argCount: Object.keys(argumentRecord).length,
        });
        throw new ComposioServiceError(
          400,
          `Missing required argument${missing.length === 1 ? '' : 's'} ${
            missing.map((field) => `"${field}"`).join(', ')
          } for ${tool.slug}.`,
        );
      }
    }

    try {
      const session = await this.getSession(normalizedUserId);
      const result = connectedAccountId
        ? await session.execute(executionSlug, argumentRecord, { account: connectedAccountId })
        : await session.execute(executionSlug, argumentRecord);
      const record = asRecord(result);
      const error = record ? asString(record.error) : null;
      const logId = record ? asString(record.logId ?? record.log_id) : null;
      this.log('composio.execute.completed', {
        toolSlug: diagnosticToolSlug(executionSlug),
        argCount: Object.keys(argumentRecord).length,
        hasError: Boolean(error),
      });
      return {
        data: record && 'data' in record ? record.data : result ?? null,
        error,
        logId,
      };
    } catch (error: unknown) {
      this.log('composio.execute.failed', {
        toolSlug: diagnosticToolSlug(executionSlug),
        argCount: Object.keys(argumentRecord).length,
        reason: 'upstream_execution_failed',
      });
      throw error;
    }
  }

  private async getSession(userId: string): Promise<ToolRouterSessionLike> {
    if (this.options.toolkitScope && this.options.toolkitScope.length === 0) {
      throw new ComposioServiceError(503, 'Composio Tool Router has no toolkits allowed by policy.');
    }
    const cached = this.sessions.get(userId);
    if (cached && cached.expiresAt > this.now()) return cached.session;

    const session = this.options.client.create(userId, {
      ...(this.options.toolkitScope ? { toolkits: this.options.toolkitScope } : {}),
      manageConnections: false,
      multiAccount: { enable: true, requireExplicitSelection: true },
    });
    // Treat an in-flight creation as live so concurrent calls share it. Start
    // the TTL only after creation succeeds, rather than consuming it during a
    // slow upstream response.
    const pending = { session, expiresAt: Number.POSITIVE_INFINITY };
    this.sessions.set(userId, pending);
    try {
      const resolved = await session;
      if (this.sessions.get(userId) !== pending) return this.getSession(userId);
      pending.expiresAt = this.now() + this.sessionTtlMs;
      return resolved;
    } catch (error) {
      if (this.sessions.get(userId)?.session === session) this.sessions.delete(userId);
      throw error;
    }
  }

  private async getTool(toolSlug: string): Promise<ComposioToolView> {
    const slug = toolSlug.trim();
    const cached = this.schemas.get(slug);
    if (cached) return cached;
    const loading = this.loadTool(slug);
    this.schemas.set(slug, loading);
    try {
      const normalized = await loading;
      const resolved = Promise.resolve(normalized);
      this.schemas.set(slug, resolved);
      this.schemas.set(normalized.slug, resolved);
      return normalized;
    } catch (error) {
      if (this.schemas.get(slug) === loading) this.schemas.delete(slug);
      throw error;
    }
  }

  private async loadTool(slug: string): Promise<ComposioToolView> {
    const record = asRecord(await this.options.client.tools.getRawComposioToolBySlug(slug));
    if (!record) throw new ComposioServiceError(502, `Composio returned an invalid schema for ${slug}.`);
    const toolkit = asRecord(record.toolkit);
    return {
      slug: asString(record.slug) ?? slug,
      name: asString(record.name) ?? slug,
      description: asString(record.description),
      toolkit: toolkit ? { slug: asString(toolkit.slug), name: asString(toolkit.name) } : null,
      inputParameters: asRecord(record.inputParameters ?? record.input_parameters),
    };
  }

  private assertToolkitAllowed(toolkitSlug: string | null): void {
    if (toolkitSlug && !this.options.catalog.isAllowed(toolkitSlug)) {
      throw new ComposioServiceError(400, `Toolkit "${toolkitSlug}" is not allowed by policy.`);
    }
  }
}

function parseToolRouterToolSlugs(response: unknown): string[] {
  const record = asRecord(response) ?? {};
  const results = Array.isArray(record.results) ? record.results : [];
  const seen = new Set<string>();
  const slugs: string[] = [];
  for (const result of results) {
    const item = asRecord(result);
    if (!item) continue;
    const candidates = [
      ...asStringArray(item.primaryToolSlugs ?? item.primary_tool_slugs),
      ...asStringArray(item.relatedToolSlugs ?? item.related_tool_slugs),
    ];
    for (const slug of candidates) {
      if (seen.has(slug)) continue;
      seen.add(slug);
      slugs.push(slug);
    }
  }
  return slugs;
}

function getMissingRequiredToolArguments(
  inputParameters: Record<string, unknown> | null,
  arguments_: Record<string, unknown>,
): string[] {
  return asStringArray(inputParameters?.required).filter((field) => {
    const value = arguments_[field];
    return value == null || (typeof value === 'string' && value.trim().length === 0);
  });
}

function compactInputParameters(inputParameters: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!inputParameters) return null;
  const properties = asRecord(inputParameters.properties);
  if (!properties) return inputParameters;
  const compactProperties: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(properties)) {
    const property = asRecord(value);
    compactProperties[name] = property ? compactSchemaProperty(property) : value;
  }
  return {
    type: asString(inputParameters.type) ?? 'object',
    required: asStringArray(inputParameters.required),
    properties: compactProperties,
  };
}

function compactSchemaProperty(property: Record<string, unknown>): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  if (typeof property.type === 'string' || Array.isArray(property.type)) compact.type = property.type;
  const description = asString(property.description);
  if (description) compact.description = description.length <= 300 ? description : `${description.slice(0, 297)}...`;
  if ('default' in property) compact.default = property.default;
  if (Array.isArray(property.enum)) compact.enum = property.enum;
  const items = asRecord(property.items);
  if (items) compact.items = compactSchemaProperty(items);
  return compact;
}

function toSearchToolView(tool: ComposioToolView): BridgeSearchToolResult {
  return {
    slug: tool.slug,
    name: tool.name,
    description: tool.description,
    toolkitSlug: tool.toolkit?.slug ?? null,
    toolkitName: tool.toolkit?.name ?? null,
  };
}

// Tool names are useful diagnostics, but a malformed caller-supplied slug
// must not turn this field into a free-text content log.
function diagnosticToolSlug(slug: string): string {
  return /^[A-Z][A-Z0-9_]{0,127}$/.test(slug) ? slug : 'invalid_tool_slug';
}

function logToolEvent(event: string, details: Record<string, unknown>): void {
  try {
    console.info(JSON.stringify({ event, source: 'composio_service', ...details }));
  } catch {
    // Diagnostics must never affect tool execution.
  }
}
