import {
  RemoteBridgeHttpError,
  RemoteComposioBridgeClient,
  type RemoteBridgeSearchToolResult,
  type RemoteBridgeToolExecutionView,
  type RemoteBridgeToolSchemaView,
} from './composio-bridge-client.ts';
import { ManagedBackendClient } from './managed-backend-client.ts';
import {
  PROPOSE_MESSAGE_DRAFT_SLUG,
  manifestToolFromComposioUsageInput,
  type ComposioNativeToolManifest,
  type ComposioNativeToolManifestTool,
  type ComposioToolUsageStore,
} from '../connections/composio-tool-usage-store.ts';
import {
  isProtectedMessageSendToolSlug,
  reviewedMessageToolSlug,
  SUPPORTED_MESSAGE_DRAFT_CHANNELS,
} from './reviewed-message-policy.ts';

export interface ComposioBridgeSearchToolView extends RemoteBridgeSearchToolResult {}
export interface ComposioBridgeToolSchemaView extends RemoteBridgeToolSchemaView {}
export interface ComposioBridgeToolExecutionView extends RemoteBridgeToolExecutionView {}

export class ComposioBridgeHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ComposioBridgeHttpError';
    this.status = status;
  }
}

export interface ComposioBridgeUsageOptions {
  store: ComposioToolUsageStore;
  manifestPath: string;
  getActiveToolkitSlugs: () => string[];
  manifestLimit?: number;
}

export interface ToolUsageMetadata {
  slug: string;
  name: string | null;
  description: string | null;
  toolkitSlug: string | null;
  toolkitName: string | null;
}

export interface NativeToolManifestRefreshStatus {
  status: 'never' | 'ok' | 'failed';
  refreshedAt: string | null;
  activeToolkits: string[];
  listedToolCount: number;
  materializedToolCount: number;
  manifestToolCount: number;
  error: string | null;
}

/**
 * Local MCP-facing Composio bridge. The desktop never talks to Composio
 * directly; it forwards search/schema/execute calls to the authenticated
 * backend bridge so the Composio project API key stays server-side.
 */

/**
 * Deterministic id for a draft, derived from the agent's tool args. The chat
 * UI computes the same id from the same args (via stableStringify + FNV-1a)
 * so neither side needs to coordinate with the other. The hash space is
 * 32-bit, which is fine for the handful of concurrent drafts we'll ever see.
 */
export function draftIdForArgs(args: Record<string, unknown>): string {
  const canonical = stableStringify(args);
  return `draft_${fnv1a32(canonical)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export class ComposioBridgeService {
  private readonly bridgeClient: RemoteComposioBridgeClient;
  private readonly usage: ComposioBridgeUsageOptions | null;
  private readonly toolMetadataBySlug = new Map<string, ToolUsageMetadata>();
  private readonly materializedManifestTools = new Map<string, ComposioNativeToolManifestTool>();
  private nativeToolManifestStatus: NativeToolManifestRefreshStatus = {
    status: 'never',
    refreshedAt: null,
    activeToolkits: [],
    listedToolCount: 0,
    materializedToolCount: 0,
    manifestToolCount: 0,
    error: null,
  };

  constructor(managedBackend: ManagedBackendClient, usage: ComposioBridgeUsageOptions | null = null) {
    this.bridgeClient = new RemoteComposioBridgeClient(managedBackend);
    this.usage = usage;
  }

  get configured(): boolean {
    return this.bridgeClient.configured;
  }

  getNativeToolManifestStatus(): NativeToolManifestRefreshStatus {
    return {
      ...this.nativeToolManifestStatus,
      activeToolkits: [...this.nativeToolManifestStatus.activeToolkits],
    };
  }

  async listTools(toolkits: string[]): Promise<ComposioBridgeSearchToolView[]> {
    this.assertConfigured();
    const normalizedToolkits = Array.from(new Set(toolkits.map((toolkit) => toolkit.trim()).filter(Boolean)));
    if (normalizedToolkits.length === 0) throw new ComposioBridgeHttpError(400, 'Missing "toolkits"');

    try {
      const tools = await this.bridgeClient.listTools(normalizedToolkits);
      tools.forEach((tool) => this.rememberToolMetadata(tool));
      return tools;
    } catch (error) {
      throw mapRemoteBridgeError(error);
    }
  }

  async refreshNativeToolManifest(activeToolkitSlugs: string[]): Promise<void> {
    if (!this.usage) return;
    const activeToolkits = Array.from(new Set(
      activeToolkitSlugs.map((toolkit) => toolkit.trim().toLowerCase()).filter(Boolean),
    ));

    try {
      if (activeToolkits.length === 0) {
        this.materializedManifestTools.clear();
        const manifest = this.writeNativeToolManifest(activeToolkits);
        this.rememberNativeToolManifestStatus('ok', activeToolkits, 0, manifest, null);
        return;
      }

      const tools = await this.listTools(activeToolkits);
      const schemasBySlug = new Map<string, RemoteBridgeToolSchemaView>();
      // A multi-app account materializes ~600 tools (~25 schema chunks).
      // Fetching them strictly one at a time put whole-manifest refreshes at
      // ~25 sequential round-trips; a small concurrent window cuts that to a
      // few while keeping backend load bounded.
      const slugChunks = chunks(tools.map((tool) => tool.slug), 25);
      for (const window of chunks(slugChunks, 4)) {
        const results = await Promise.all(window.map((chunk) => this.getToolSchemas(chunk)));
        for (const schemas of results) {
          schemas.forEach((schema) => schemasBySlug.set(normalizeToolSlugKey(schema.slug), schema));
        }
      }

      this.materializedManifestTools.clear();
      for (const tool of tools) {
        const slug = cleanString(tool.slug);
        if (!slug) continue;
        const usageInput = buildComposioToolUsageInput(
          slug,
          schemasBySlug.get(normalizeToolSlugKey(slug)) ?? null,
          this.toolMetadataBySlug.get(normalizeToolSlugKey(slug)) ?? null,
          activeToolkits,
        );
        if (!usageInput) continue;
        const manifestTool = manifestToolFromComposioUsageInput(usageInput);
        if (!manifestTool) continue;
        this.materializedManifestTools.set(normalizeToolSlugKey(manifestTool.toolSlug), manifestTool);
      }

      const manifest = this.writeNativeToolManifest(activeToolkits);
      this.rememberNativeToolManifestStatus('ok', activeToolkits, tools.length, manifest, null);
    } catch (error) {
      this.rememberNativeToolManifestStatus('failed', activeToolkits, 0, null, error);
      throw error;
    }
  }

  async getToolSchemas(toolSlugs: string[]): Promise<ComposioBridgeToolSchemaView[]> {
    this.assertConfigured();
    const wanted = Array.from(new Set(toolSlugs.map((slug) => slug.trim()).filter(Boolean)));
    if (wanted.length === 0) throw new ComposioBridgeHttpError(400, 'Missing "toolSlugs"');

    try {
      const schemas = await this.bridgeClient.getToolSchemas(wanted);
      schemas.forEach((tool) => this.rememberToolMetadata(tool));
      return schemas;
    } catch (error) {
      throw mapRemoteBridgeError(error);
    }
  }

  async executeTool(
    toolSlug: string,
    arguments_: Record<string, unknown>,
    opts: { recordUsage?: boolean } = {},
  ): Promise<ComposioBridgeToolExecutionView> {
    const slug = toolSlug.trim();
    if (!slug) throw new ComposioBridgeHttpError(400, 'Missing "toolSlug"');
    const argumentRecord = asRecord(arguments_);
    if (!argumentRecord) {
      throw new ComposioBridgeHttpError(400, 'Missing required object "arguments".');
    }

    // propose_message_draft never reaches the remote bridge.
    if (slug.toUpperCase() === PROPOSE_MESSAGE_DRAFT_SLUG) {
      const channel = typeof argumentRecord.channel === 'string'
        ? argumentRecord.channel.trim().toLowerCase()
        : '';

      if (!SUPPORTED_MESSAGE_DRAFT_CHANNELS.has(channel)) {
        throw new ComposioBridgeHttpError(
          400,
          'propose_message_draft supports only Gmail email and Slack messages. Use the connected app tool directly for other actions.',
        );
      }

      return {
        data: {
          status: 'pending_review',
          channel,
          note: 'Draft surfaced to the user for review in Verso. The user will edit and send (or discard) it themselves, and Verso handles the actual send. Do NOT call any send tool. Reply in one short sentence that you have prepared it for review.',
        },
        error: null,
        logId: null,
      };
    }

    // Message delivery is never available through the generic agent-facing
    // bridge. The reviewed draft endpoint calls sendReviewedMessage(), whose
    // channel-to-slug mapping cannot be supplied or overridden by the model.
    if (isProtectedMessageSendToolSlug(slug)) {
      throw new ComposioBridgeHttpError(
        403,
        `Direct execution of ${slug.toUpperCase()} requires review in the message draft widget.`,
      );
    }

    return this.executeRemoteTool(slug, argumentRecord, opts);
  }

  async sendReviewedMessage(
    channel: string,
    arguments_: Record<string, unknown>,
  ): Promise<ComposioBridgeToolExecutionView> {
    const slug = reviewedMessageToolSlug(channel);
    if (!slug) {
      throw new ComposioBridgeHttpError(
        400,
        `Channel "${channel}" is not supported. Drafts are limited to Gmail and Slack.`,
      );
    }
    const argumentRecord = asRecord(arguments_);
    if (!argumentRecord) {
      throw new ComposioBridgeHttpError(400, 'Missing required object "arguments".');
    }

    const resolvedArguments = channel.trim().toLowerCase() === 'slack'
      ? await this.resolveReviewedSlackArguments(argumentRecord)
      : { arguments: argumentRecord };
    if ('error' in resolvedArguments) return resolvedArguments.error;

    return this.executeRemoteTool(slug, resolvedArguments.arguments, { recordUsage: false });
  }

  /**
   * Gmail accepts the special recipient `me`; Slack's message API does not.
   * Resolve that one user-friendly alias only after native approval, then use
   * the returned DM conversation id for the reviewed send. Other Slack targets
   * (channel names and C/G/D conversation ids) continue to pass through.
   */
  private async resolveReviewedSlackArguments(
    argumentRecord: Record<string, unknown>,
  ): Promise<
    | { arguments: Record<string, unknown> }
    | { error: ComposioBridgeToolExecutionView }
  > {
    const target = cleanString(argumentRecord.channel);
    if (!target || !isSlackSelfAlias(target)) return { arguments: argumentRecord };

    const auth = await this.executeRemoteTool('SLACK_TEST_AUTH', {}, { recordUsage: false });
    if (auth.error) return { error: auth };
    const userId = slackAuthenticatedUserId(auth.data);
    if (!userId) {
      throw new ComposioBridgeHttpError(
        502,
        'Slack did not return the authenticated user id needed to open your direct message.',
      );
    }

    const dm = await this.executeRemoteTool(
      'SLACK_OPEN_DM',
      { users: userId, return_im: true },
      { recordUsage: false },
    );
    if (dm.error) return { error: dm };
    const conversationId = slackConversationId(dm.data);
    if (!conversationId) {
      throw new ComposioBridgeHttpError(
        502,
        'Slack did not return the direct-message conversation id needed to send this message.',
      );
    }

    return {
      arguments: {
        ...argumentRecord,
        channel: conversationId,
      },
    };
  }

  private async executeRemoteTool(
    slug: string,
    argumentRecord: Record<string, unknown>,
    opts: { recordUsage?: boolean },
  ): Promise<ComposioBridgeToolExecutionView> {
    this.assertConfigured();
    try {
      const result = await this.bridgeClient.executeTool(slug, argumentRecord);
      if (!result.error && opts.recordUsage !== false) {
        // Background ingestion fetches pass recordUsage:false so read/list
        // tools are not surfaced/ranked in the visible agent's tool manifest.
        await this.recordSuccessfulToolUse(slug).catch(() => undefined);
      }
      return result;
    } catch (error) {
      throw mapRemoteBridgeError(error);
    }
  }

  private assertConfigured(): void {
    if (this.bridgeClient.configured) return;
    throw new ComposioBridgeHttpError(503, 'Managed backend URL is not configured.');
  }

  private async recordSuccessfulToolUse(toolSlug: string): Promise<void> {
    if (!this.usage) return;

    const schemas = await this.getToolSchemas([toolSlug]);
    const usageInput = buildComposioToolUsageInput(
      toolSlug,
      schemas[0] ?? null,
      this.toolMetadataBySlug.get(normalizeToolSlugKey(toolSlug)) ?? null,
      this.usage.getActiveToolkitSlugs(),
    );
    if (!usageInput) return;

    this.usage.store.recordSuccessfulUse(usageInput);
    const activeToolkits = new Set(this.usage.getActiveToolkitSlugs());
    activeToolkits.add(usageInput.toolkitSlug);
    this.writeNativeToolManifest(activeToolkits);
  }

  private writeNativeToolManifest(activeToolkitSlugs: Iterable<string>): ComposioNativeToolManifest {
    if (!this.usage) {
      throw new ComposioBridgeHttpError(500, 'Composio tool usage store is not configured.');
    }
    return this.usage.store.writeManifest(
      this.usage.manifestPath,
      activeToolkitSlugs,
      this.usage.manifestLimit,
      Array.from(this.materializedManifestTools.values()),
    );
  }

  private rememberNativeToolManifestStatus(
    status: 'ok' | 'failed',
    activeToolkits: string[],
    listedToolCount: number,
    manifest: ComposioNativeToolManifest | null,
    error: unknown,
  ): void {
    this.nativeToolManifestStatus = {
      status,
      refreshedAt: new Date().toISOString(),
      activeToolkits: [...activeToolkits],
      listedToolCount,
      materializedToolCount: this.materializedManifestTools.size,
      manifestToolCount: manifest?.tools.length ?? 0,
      error: error ? errorMessage(error) : null,
    };
  }

  private rememberToolMetadata(tool: RemoteBridgeSearchToolResult | RemoteBridgeToolSchemaView): void {
    const slug = cleanString(tool.slug);
    if (!slug) return;
    const key = normalizeToolSlugKey(slug);
    const existing = this.toolMetadataBySlug.get(key);
    this.toolMetadataBySlug.set(key, {
      slug,
      name: usefulMetadataName(tool) ?? existing?.name ?? null,
      description: usefulDescription(tool.description) ?? existing?.description ?? null,
      toolkitSlug: normalizeToolkitSlug(tool.toolkitSlug) ?? existing?.toolkitSlug ?? null,
      toolkitName: cleanString(tool.toolkitName) ?? existing?.toolkitName ?? null,
    });
  }
}

function mapRemoteBridgeError(error: unknown): Error {
  if (error instanceof RemoteBridgeHttpError) {
    return new ComposioBridgeHttpError(error.status, error.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isSlackSelfAlias(value: string): boolean {
  return /^(me|myself|self|yourself)$/i.test(value.trim());
}

function slackAuthenticatedUserId(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  const user = asRecord(record.user);
  const direct = [record.user_id, record.userId, user?.id]
    .map(cleanString)
    .find((candidate): candidate is string => candidate !== null && /^[UW][A-Z0-9]+$/i.test(candidate));
  if (direct) return direct;
  return slackAuthenticatedUserId(record.data);
}

function slackConversationId(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  const channel = asRecord(record.channel);
  const direct = [record.channel_id, record.channelId, channel?.id]
    .map(cleanString)
    .find((candidate): candidate is string => candidate !== null && /^D[A-Z0-9]+$/i.test(candidate));
  if (direct) return direct;
  return slackConversationId(record.data);
}

export function buildComposioToolUsageInput(
  requestedToolSlug: string,
  schema: RemoteBridgeToolSchemaView | null,
  metadata: ToolUsageMetadata | null,
  activeToolkitSlugs: Iterable<string>,
) {
  const slug = cleanString(schema?.slug) ?? cleanString(metadata?.slug) ?? requestedToolSlug.trim();
  if (!slug) return null;

  const activeToolkits = Array.from(activeToolkitSlugs)
    .map(normalizeToolkitSlug)
    .filter((toolkitSlug): toolkitSlug is string => toolkitSlug !== null);
  const toolkitSlug = normalizeToolkitSlug(schema?.toolkitSlug)
    ?? normalizeToolkitSlug(metadata?.toolkitSlug)
    ?? inferToolkitSlugFromToolSlug(slug, activeToolkits);
  if (!toolkitSlug) return null;

  const inputParameters = asRecord(schema?.inputParameters) ?? permissiveInputParameters();
  return {
    slug,
    name: usefulSchemaName(schema) ?? cleanString(metadata?.name) ?? slug,
    description: usefulDescription(schema?.description) ?? usefulDescription(metadata?.description),
    toolkitSlug,
    toolkitName: cleanString(schema?.toolkitName) ?? cleanString(metadata?.toolkitName),
    inputParameters,
  };
}

function inferToolkitSlugFromToolSlug(toolSlug: string, activeToolkitSlugs: string[]): string | null {
  const normalizedToolSlug = normalizeToolSlugPrefix(toolSlug);
  return activeToolkitSlugs.find((toolkitSlug) => {
    const prefix = `${normalizeToolSlugPrefix(toolkitSlug)}_`;
    return normalizedToolSlug.startsWith(prefix);
  }) ?? null;
}

function permissiveInputParameters(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {},
    additionalProperties: true,
  };
}

function normalizeToolSlugKey(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeToolSlugPrefix(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
}

function normalizeToolkitSlug(value: unknown): string | null {
  const cleaned = cleanString(value);
  return cleaned ? cleaned.toLowerCase() : null;
}

function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  return cleaned.length > 0 ? cleaned : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function usefulDescription(value: unknown): string | null {
  const description = cleanString(value);
  if (!description) return null;
  if (description.toLowerCase().includes('schema unavailable from composio')) return null;
  return description;
}

function usefulSchemaName(schema: RemoteBridgeToolSchemaView | null): string | null {
  if (!schema) return null;
  if (!schema.inputParameters && !schema.toolkitSlug) return null;
  return cleanString(schema.name);
}

function usefulMetadataName(tool: RemoteBridgeSearchToolResult | RemoteBridgeToolSchemaView): string | null {
  if ('inputParameters' in tool && !tool.inputParameters && !tool.toolkitSlug) return null;
  return cleanString(tool.name);
}

function chunks<T>(items: T[], size: number): T[][] {
  const chunkSize = Math.max(1, Math.floor(size));
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    result.push(items.slice(index, index + chunkSize));
  }
  return result;
}
