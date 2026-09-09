import { ComposioServiceError } from './errors.ts';
import type {
  BridgeSearchToolResult,
  BridgeToolkitView,
  CatalogToolkitItem,
  ConnectionRequestStatus,
  ToolkitToolItem,
} from './contracts.ts';

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : [];
}

export function normalizeUserId(userId: string): string {
  const normalized = userId.trim();
  if (!normalized) throw new ComposioServiceError(400, 'Missing "userId"');
  return normalized;
}

export function normalizeToolkitLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return 20;
  return Math.max(1, Math.min(100, Math.floor(limit)));
}

export function toolkitInputCandidates(value: string): string[] {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return [];
  const aliases = new Set([
    normalized,
    normalized.replace(/\s+/g, '_'),
    normalized.replace(/\s+/g, ''),
    normalized.replace(/[_-]+/g, ' '),
  ]);
  if (normalized === 'granola' || normalized === 'granola mcp' || normalized === 'granola_mcp') {
    aliases.add('granola_mcp');
    aliases.add('granola mcp');
    aliases.add('granola');
  }
  return Array.from(aliases);
}

export function normalizeToolkits(toolkits: string[] | undefined): string[] | undefined {
  if (!toolkits || toolkits.length === 0) return undefined;
  const normalized = toolkits.flatMap(toolkitInputCandidates).filter(Boolean);
  return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
}

export function parseToolkitSet(value: string | undefined): Set<string> | null {
  const items = value?.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean) ?? [];
  return items.length > 0 ? new Set(items) : null;
}

export function mapConnectedAccountStatus(status: string | undefined): ConnectionRequestStatus {
  switch (status) {
    case 'ACTIVE': return 'connected';
    case 'FAILED': return 'failed';
    case 'EXPIRED': return 'expired';
    default: return 'pending';
  }
}

export function defaultToolkitMetadata(toolkitSlug: string): { toolkitName: string; logoUrl: string | null } {
  return {
    toolkitName: toolkitSlug === 'gmail'
      ? 'Gmail'
      : toolkitSlug.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()),
    logoUrl: null,
  };
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function normalizeSearchQuery(value: string): string {
  return value.trim().toLowerCase();
}

export function matchesToolkitQuery(toolkit: CatalogToolkitItem, normalizedQuery: string): boolean {
  const compactQuery = normalizedQuery.replace(/\s+/g, '');
  const haystacks = [
    toolkit.slug.toLowerCase(),
    toolkit.slug.replace(/[_-]+/g, ''),
    toolkit.name.toLowerCase(),
    toolkit.meta.description?.toLowerCase() ?? '',
  ];
  return haystacks.some((value) => value.includes(normalizedQuery) || value.includes(compactQuery));
}

export function matchesToolQuery(tool: ToolkitToolItem, normalizedQuery: string): boolean {
  const compactQuery = normalizedQuery.replace(/\s+/g, '');
  const haystacks = [
    tool.slug?.toLowerCase() ?? '',
    tool.slug?.toLowerCase().replace(/[_-]+/g, '') ?? '',
    tool.name?.toLowerCase() ?? '',
    tool.description?.toLowerCase() ?? '',
  ];
  return haystacks.some((value) => value.includes(normalizedQuery) || value.includes(compactQuery));
}

export function rankToolkits(
  toolkits: BridgeToolkitView[],
  normalizedInput: string,
): Array<{ toolkit: BridgeToolkitView; score: number }> {
  return toolkits
    .map((toolkit) => ({ toolkit, score: scoreToolkit(toolkit, normalizedInput) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.toolkit.name.localeCompare(right.toolkit.name));
}

function scoreToolkit(toolkit: BridgeToolkitView, normalizedInput: string): number {
  const slug = toolkit.slug.toLowerCase();
  const name = toolkit.name.toLowerCase();
  if (slug === normalizedInput) return 100;
  if (name === normalizedInput) return 95;
  if (slug.replace(/[_-]+/g, ' ') === normalizedInput) return 90;
  if (name.startsWith(normalizedInput)) return 70;
  if (slug.startsWith(normalizedInput)) return 65;
  if (name.includes(normalizedInput)) return 50;
  if (slug.includes(normalizedInput.replace(/\s+/g, ''))) return 45;
  return 0;
}

export function dedupeToolkitCatalogItems(items: CatalogToolkitItem[]): CatalogToolkitItem[] {
  return dedupeBySlug(items);
}

export function dedupeSearchToolResults(items: BridgeSearchToolResult[]): BridgeSearchToolResult[] {
  return dedupeBySlug(items);
}

function dedupeBySlug<T extends { slug: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.slug)) return false;
    seen.add(item.slug);
    return true;
  });
}

export function isComposioSchemaValidationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('outputParameters')
    || message.includes('invalid_literal')
    || message.includes('invalid_type');
}
