import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { writeJsonFileAtomic } from '../shared/atomic-json-file.ts';
import { isProtectedMessageSendToolSlug } from '../integrations/reviewed-message-policy.ts';

export interface ComposioToolUsageInput {
  slug: string;
  name: string;
  description: string | null;
  toolkitSlug: string;
  toolkitName: string | null;
  inputParameters: Record<string, unknown>;
}

export interface ComposioNativeToolManifestTool {
  nativeName: string;
  toolSlug: string;
  toolkitSlug: string;
  name: string;
  description: string | null;
  inputParameters: Record<string, unknown>;
  // How the tool earned its manifest slot: 'usage' = ranked by successful
  // use (the hot set — pinned-tool selection reads this), 'toolkit' =
  // materialized wholesale from a connected toolkit. Absent in manifests
  // written before this field existed.
  origin?: 'usage' | 'toolkit';
}

export interface ComposioNativeToolManifest {
  version: 1;
  generatedAt: string;
  tools: ComposioNativeToolManifestTool[];
}

interface UsageRow {
  tool_slug: string;
  toolkit_slug: string;
  name: string;
  description: string | null;
  input_parameters: string;
  success_count: number;
  last_used_at: string;
}

const DEFAULT_MANIFEST_LIMIT = 25;

// Slug we use to identify the synthetic "draft a message for review" tool when
// the orchestrator intercepts execute calls. Kept in this module so both the
// manifest writer and the bridge interceptor stay in sync.
export const PROPOSE_MESSAGE_DRAFT_SLUG = 'PROPOSE_MESSAGE_DRAFT';

function defaultStorePath(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'verso', 'composio-tool-usage.sqlite');
}

export class ComposioToolUsageStore {
  private readonly storePath: string;
  private readonly db: DatabaseSync;

  constructor(storePath = process.env.VERSO_COMPOSIO_TOOL_USAGE_STORE_PATH?.trim() || defaultStorePath()) {
    this.storePath = storePath;
    mkdirSync(path.dirname(this.storePath), { recursive: true });
    this.db = new DatabaseSync(this.storePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS composio_tool_usage (
        tool_slug TEXT PRIMARY KEY,
        toolkit_slug TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        input_parameters TEXT NOT NULL,
        success_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_composio_tool_usage_rank
        ON composio_tool_usage(success_count DESC, last_used_at DESC);
      CREATE INDEX IF NOT EXISTS idx_composio_tool_usage_toolkit
        ON composio_tool_usage(toolkit_slug);
    `);
  }

  get path(): string {
    return this.storePath;
  }

  recordSuccessfulUse(tool: ComposioToolUsageInput, usedAt = new Date().toISOString()): void {
    const slug = tool.slug.trim();
    const toolkitSlug = tool.toolkitSlug.trim().toLowerCase();
    const name = tool.name.trim() || slug;
    if (!slug || !toolkitSlug) return;

    const inputParameters = normalizeInputParameters(tool.inputParameters);
    this.db.prepare(`
      INSERT INTO composio_tool_usage (
        tool_slug,
        toolkit_slug,
        name,
        description,
        input_parameters,
        success_count,
        last_used_at
      )
      VALUES (?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(tool_slug) DO UPDATE SET
        toolkit_slug = excluded.toolkit_slug,
        name = excluded.name,
        description = excluded.description,
        input_parameters = excluded.input_parameters,
        success_count = composio_tool_usage.success_count + 1,
        last_used_at = excluded.last_used_at
    `).run(
      slug,
      toolkitSlug,
      name,
      tool.description,
      JSON.stringify(inputParameters),
      usedAt,
    );
  }

  listManifestTools(activeToolkitSlugs: Iterable<string>, limit = DEFAULT_MANIFEST_LIMIT): ComposioNativeToolManifestTool[] {
    const active = normalizeToolkitSet(activeToolkitSlugs);
    if (active.size === 0 || limit <= 0) return [];

    const placeholders = Array.from(active, () => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT tool_slug, toolkit_slug, name, description, input_parameters, success_count, last_used_at
      FROM composio_tool_usage
      WHERE toolkit_slug IN (${placeholders})
      ORDER BY success_count DESC, last_used_at DESC, tool_slug ASC
      LIMIT ?
    `).all(...active, Math.floor(limit)) as unknown as UsageRow[];

    return rows
      .map(rowToManifestTool)
      .filter((tool): tool is ComposioNativeToolManifestTool => tool !== null);
  }

  writeManifest(
    manifestPath: string,
    activeToolkitSlugs: Iterable<string>,
    limit = DEFAULT_MANIFEST_LIMIT,
    materializedTools: ComposioNativeToolManifestTool[] = [],
  ): ComposioNativeToolManifest {
    const active = normalizeToolkitSet(activeToolkitSlugs);
    const connectedMaterializedTools = materializedTools
      .filter((tool) => active.has(tool.toolkitSlug.trim().toLowerCase()))
      .map((tool) => ({ ...normalizeManifestTool(tool), origin: 'toolkit' as const }));

    // Usage-ranked entries come first, so dedupe keeps the 'usage' origin
    // for tools that also appear in the materialized set.
    const tools = dedupeManifestTools([
      ...this.listManifestTools(active, limit).map((tool) => ({ ...tool, origin: 'usage' as const })),
      ...connectedMaterializedTools,
    ]).filter((tool) => !isProtectedMessageSendToolSlug(tool.toolSlug));
    const manifest: ComposioNativeToolManifest = {
      version: 1,
      generatedAt: new Date().toISOString(),
      tools,
    };

    writeJsonFileAtomic(manifestPath, manifest);
    return manifest;
  }
}

export function nativeNameForComposioToolSlug(toolSlug: string): string {
  const normalized = toolSlug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  if (!normalized) return 'composio_tool';
  return /^[a-z]/.test(normalized) ? normalized : `tool_${normalized}`;
}

export function manifestToolFromComposioUsageInput(tool: ComposioToolUsageInput): ComposioNativeToolManifestTool | null {
  const slug = tool.slug.trim();
  const toolkitSlug = tool.toolkitSlug.trim().toLowerCase();
  if (!slug || !toolkitSlug) return null;
  return normalizeManifestTool({
    nativeName: nativeNameForComposioToolSlug(slug),
    toolSlug: slug,
    toolkitSlug,
    name: tool.name.trim() || slug,
    description: tool.description,
    inputParameters: normalizeInputParameters(tool.inputParameters),
  });
}

function rowToManifestTool(row: UsageRow): ComposioNativeToolManifestTool | null {
  const parsedInputParameters = parseJsonRecord(row.input_parameters);
  if (!parsedInputParameters) return null;

  return {
    nativeName: nativeNameForComposioToolSlug(row.tool_slug),
    toolSlug: row.tool_slug,
    toolkitSlug: row.toolkit_slug,
    name: row.name,
    description: row.description,
    inputParameters: normalizeInputParameters(parsedInputParameters),
  };
}

function normalizeManifestTool(tool: ComposioNativeToolManifestTool): ComposioNativeToolManifestTool {
  return {
    nativeName: nativeNameForComposioToolSlug(tool.toolSlug || tool.nativeName),
    toolSlug: tool.toolSlug.trim(),
    toolkitSlug: tool.toolkitSlug.trim().toLowerCase(),
    name: tool.name.trim() || tool.toolSlug.trim(),
    description: tool.description,
    inputParameters: normalizeInputParameters(tool.inputParameters),
  };
}

function dedupeManifestTools(tools: ComposioNativeToolManifestTool[]): ComposioNativeToolManifestTool[] {
  const seenSlugs = new Set<string>();
  const seenNativeNames = new Set<string>();
  const deduped: ComposioNativeToolManifestTool[] = [];
  for (const tool of tools) {
    const slugKey = tool.toolSlug.trim().toUpperCase();
    const nativeNameKey = tool.nativeName.trim().toLowerCase();
    if (!slugKey || !nativeNameKey || seenSlugs.has(slugKey) || seenNativeNames.has(nativeNameKey)) {
      continue;
    }
    seenSlugs.add(slugKey);
    seenNativeNames.add(nativeNameKey);
    deduped.push(tool);
  }
  return deduped;
}

function normalizeInputParameters(value: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...value };
  if (typeof normalized.type !== 'string') {
    normalized.type = 'object';
  }
  if (!normalized.properties || typeof normalized.properties !== 'object' || Array.isArray(normalized.properties)) {
    normalized.properties = {};
  }
  return normalized;
}

function normalizeToolkitSet(values: Iterable<string>): Set<string> {
  return new Set(
    Array.from(values)
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
