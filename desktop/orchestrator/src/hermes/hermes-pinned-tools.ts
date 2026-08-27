import { readFileSync } from 'node:fs';

/**
 * Computes the `tools.tool_search.pinned` list written into the managed
 * Hermes config. Pinned tools stay in the model-visible tools array instead
 * of hiding behind the tool_search bridge, so the hot path skips the
 * search → describe → call round trips entirely.
 *
 * Sources, in order:
 * 1. The verso bridge's static tools (connection management + drafts) and,
 *    when memory is on, the memory tools — product-core, always pinned.
 * 2. Usage-ranked Composio tools from the native tool manifest (entries the
 *    usage store marked `origin: 'usage'`), taken in manifest order until
 *    the schema budget or count cap is hit.
 * 3. Cold-start seeds: one obvious tool per connected toolkit that has no
 *    pinned tool yet, so a fresh install isn't all-deferred until usage
 *    accumulates.
 *
 * A pinned name that matches nothing registered is inert on the Hermes side,
 * so this list can be generous about tools that may disappear (disconnected
 * toolkit, renamed slug) between config writes.
 */

// Hermes ≤0.18 registers MCP tools as `mcp_<server>_<tool>`; 0.19 moved to
// the Claude Code-style `mcp__<server>__<tool>` (tools/mcp_tool.py
// MCP_TOOL_NAME_PREFIX). Unmatched pin names are inert, so every pin is
// emitted in both wire forms and the same config works under either bundle.
const PIN_PREFIXES = ['mcp_verso_', 'mcp__verso__'];

const STATIC_PINNED_TOOLS = [
  'request_connection',
  'search_toolkits',
  'list_connections',
  'get_connection_status',
  'propose_message_draft',
];

const MEMORY_PINNED_TOOLS = [
  'search_memory',
  'get_memory_page',
  'write_memory_page',
];

// Composio schemas riding in the prompt prefix on every turn. ~4 chars per
// token puts this around 8K tokens — a few percent of context, and stable
// across turns so it stays prompt-cache friendly.
const PINNED_SCHEMA_CHAR_BUDGET = 32_000;
const MAX_USAGE_PINNED = 20;

// Verified against real Composio manifests; a slug that no longer exists in
// the manifest is simply skipped.
const COLD_START_SEEDS: Record<string, string> = {
  slack: 'SLACK_SEARCH_MESSAGES',
  gmail: 'GMAIL_FETCH_EMAILS',
  googledrive: 'GOOGLEDRIVE_FIND_FILE',
  googledocs: 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN',
  googlecalendar: 'GOOGLECALENDAR_EVENTS_LIST',
  notion: 'NOTION_SEARCH_NOTION_PAGE',
  todoist: 'TODOIST_GET_ALL_TASKS',
};

interface ManifestToolEntry {
  nativeName: string;
  toolSlug: string;
  toolkitSlug: string;
  inputParameters: Record<string, unknown>;
  origin?: string;
}

export function computePinnedToolNames(
  manifestPath: string,
  opts: { includeMemoryTools: boolean },
): string[] {
  const baseNames: string[] = [...STATIC_PINNED_TOOLS];
  if (opts.includeMemoryTools) baseNames.push(...MEMORY_PINNED_TOOLS);

  const tools = readManifestTools(manifestPath);
  if (tools.length === 0) return toWireNames(baseNames);

  let budget = PINNED_SCHEMA_CHAR_BUDGET;
  let usagePinned = 0;
  const pinnedNames = new Set<string>();
  const pinnedToolkits = new Set<string>();

  for (const tool of tools) {
    if (tool.origin !== 'usage' || usagePinned >= MAX_USAGE_PINNED) continue;
    const cost = schemaCost(tool);
    if (cost > budget) continue;
    budget -= cost;
    usagePinned += 1;
    pinnedNames.add(tool.nativeName);
    pinnedToolkits.add(tool.toolkitSlug);
  }

  // Cold-start seeds for connected toolkits nothing above covered.
  const bySlug = new Map(tools.map((tool) => [tool.toolSlug.toUpperCase(), tool]));
  for (const tool of tools) {
    if (pinnedToolkits.has(tool.toolkitSlug)) continue;
    const seedSlug = COLD_START_SEEDS[tool.toolkitSlug];
    if (!seedSlug) continue;
    const seed = bySlug.get(seedSlug);
    if (!seed) continue;
    const cost = schemaCost(seed);
    if (cost > budget) continue;
    budget -= cost;
    pinnedNames.add(seed.nativeName);
    pinnedToolkits.add(tool.toolkitSlug);
  }

  baseNames.push(...pinnedNames);
  return toWireNames(baseNames);
}

function toWireNames(baseNames: string[]): string[] {
  return baseNames.flatMap((name) => PIN_PREFIXES.map((prefix) => `${prefix}${name}`));
}

/**
 * Returns the core (product-critical) pins that match nothing in the
 * gateway's registered tool names. Hermes silently ignores unmatched pins,
 * so naming drift between this module and the bundled Hermes produces no
 * error anywhere — the tools just vanish from the model's view (this is how
 * the 0.19 `mcp_verso_*` → `mcp__verso__*` rename broke memory search
 * unnoticed). Callers log/report a non-empty result loudly.
 *
 * Results are base names (e.g. `search_memory`); a pin counts as live when
 * any registered name matches it under any known prefix convention.
 */
export function findInertCorePins(
  registeredToolNames: Iterable<string>,
  opts: { includeMemoryTools: boolean },
): string[] {
  const registered = new Set(registeredToolNames);
  const coreBaseNames = opts.includeMemoryTools
    ? [...STATIC_PINNED_TOOLS, ...MEMORY_PINNED_TOOLS]
    : [...STATIC_PINNED_TOOLS];
  return coreBaseNames.filter(
    (name) => !PIN_PREFIXES.some((prefix) => registered.has(`${prefix}${name}`)),
  );
}

function schemaCost(tool: ManifestToolEntry): number {
  try {
    return JSON.stringify(tool.inputParameters).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function readManifestTools(manifestPath: string): ManifestToolEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  if ((parsed as Record<string, unknown>).version !== 1) return [];
  const rawTools = (parsed as Record<string, unknown>).tools;
  if (!Array.isArray(rawTools)) return [];

  const tools: ManifestToolEntry[] = [];
  for (const raw of rawTools) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const nativeName = typeof entry.nativeName === 'string' ? entry.nativeName.trim() : '';
    const toolSlug = typeof entry.toolSlug === 'string' ? entry.toolSlug.trim() : '';
    const toolkitSlug = typeof entry.toolkitSlug === 'string' ? entry.toolkitSlug.trim().toLowerCase() : '';
    const inputParameters = entry.inputParameters;
    if (!nativeName || !toolSlug || !toolkitSlug) continue;
    if (!inputParameters || typeof inputParameters !== 'object' || Array.isArray(inputParameters)) continue;
    tools.push({
      nativeName,
      toolSlug,
      toolkitSlug,
      inputParameters: inputParameters as Record<string, unknown>,
      origin: typeof entry.origin === 'string' ? entry.origin : undefined,
    });
  }
  return tools;
}
