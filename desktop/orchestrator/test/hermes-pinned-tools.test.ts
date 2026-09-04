import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computePinnedToolNames, findInertCorePins } from '../src/hermes/hermes-pinned-tools.ts';

// Every pin is emitted in both Hermes wire forms: ≤0.18 `mcp_verso_<tool>`
// and 0.19+ `mcp__verso__<tool>`.
const bothForms = (names: string[]): string[] =>
  names.flatMap((name) => [`mcp_verso_${name}`, `mcp__verso__${name}`]);

const STATIC_PINNED = bothForms([
  'request_connection',
  'search_toolkits',
  'list_connections',
  'get_connection_status',
  'propose_message_draft',
  'list_workspaces',
  'search_workspaces',
  'list_workspace_files',
  'read_workspace_file',
  'write_workspace_file',
]);

const MEMORY_PINNED = bothForms([
  'search_memory',
  'get_memory_page',
  'write_memory_page',
]);

interface FixtureTool {
  nativeName: string;
  toolSlug: string;
  toolkitSlug: string;
  origin?: string;
  schemaChars?: number;
}

function manifestTool(tool: FixtureTool): Record<string, unknown> {
  const padding = 'x'.repeat(Math.max(0, (tool.schemaChars ?? 100) - 60));
  return {
    nativeName: tool.nativeName,
    toolSlug: tool.toolSlug,
    toolkitSlug: tool.toolkitSlug,
    name: tool.toolSlug,
    description: null,
    inputParameters: { type: 'object', properties: { q: { description: padding } } },
    ...(tool.origin ? { origin: tool.origin } : {}),
  };
}

describe('computePinnedToolNames', () => {
  let tempDir = '';
  let manifestPath = '';

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'verso-pinned-test-'));
    manifestPath = path.join(tempDir, 'verso-composio-tools.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeManifest(tools: FixtureTool[]): void {
    writeFileSync(manifestPath, JSON.stringify({
      version: 1,
      generatedAt: '2026-07-21T00:00:00.000Z',
      tools: tools.map(manifestTool),
    }), 'utf8');
  }

  it('returns only static pins when the manifest is missing', () => {
    expect(computePinnedToolNames(manifestPath, { includeMemoryTools: false }))
      .toEqual(STATIC_PINNED);
  });

  it('includes memory tools only when memory is enabled', () => {
    const withMemory = computePinnedToolNames(manifestPath, { includeMemoryTools: true });
    expect(withMemory).toEqual([...STATIC_PINNED, ...MEMORY_PINNED]);
  });

  it('tolerates a corrupt or wrong-version manifest', () => {
    writeFileSync(manifestPath, 'not json', 'utf8');
    expect(computePinnedToolNames(manifestPath, { includeMemoryTools: false }))
      .toEqual(STATIC_PINNED);

    writeFileSync(manifestPath, JSON.stringify({ version: 2, tools: [] }), 'utf8');
    expect(computePinnedToolNames(manifestPath, { includeMemoryTools: false }))
      .toEqual(STATIC_PINNED);
  });

  it('pins usage-ranked tools in manifest order and skips toolkit-materialized ones', () => {
    writeManifest([
      { nativeName: 'slack_search_messages', toolSlug: 'SLACK_SEARCH_MESSAGES', toolkitSlug: 'slack', origin: 'usage' },
      { nativeName: 'gmail_fetch_emails', toolSlug: 'GMAIL_FETCH_EMAILS', toolkitSlug: 'gmail', origin: 'usage' },
      { nativeName: 'slack_kick_user', toolSlug: 'SLACK_KICK_USER', toolkitSlug: 'slack', origin: 'toolkit' },
    ]);
    const pinned = computePinnedToolNames(manifestPath, { includeMemoryTools: false });
    expect(pinned).toContain('mcp_verso_slack_search_messages');
    expect(pinned).toContain('mcp__verso__slack_search_messages');
    expect(pinned).toContain('mcp_verso_gmail_fetch_emails');
    expect(pinned).not.toContain('mcp_verso_slack_kick_user');
    expect(pinned).not.toContain('mcp__verso__slack_kick_user');
  });

  it('stops pinning usage tools when the schema budget runs out', () => {
    writeManifest([
      { nativeName: 'big_one', toolSlug: 'BIG_ONE', toolkitSlug: 'slack', origin: 'usage', schemaChars: 30_000 },
      { nativeName: 'big_two', toolSlug: 'BIG_TWO', toolkitSlug: 'slack', origin: 'usage', schemaChars: 30_000 },
      { nativeName: 'small_late', toolSlug: 'SMALL_LATE', toolkitSlug: 'slack', origin: 'usage', schemaChars: 200 },
    ]);
    const pinned = computePinnedToolNames(manifestPath, { includeMemoryTools: false });
    expect(pinned).toContain('mcp_verso_big_one');
    expect(pinned).not.toContain('mcp_verso_big_two');
    // Budget is per-tool, not a hard stop: a later small tool still fits.
    expect(pinned).toContain('mcp_verso_small_late');
  });

  it('caps the number of usage pins', () => {
    writeManifest(Array.from({ length: 30 }, (_, i) => ({
      nativeName: `tool_${i}`,
      toolSlug: `TOOL_${i}`,
      toolkitSlug: 'slack',
      origin: 'usage' as const,
      schemaChars: 100,
    })));
    const pinned = computePinnedToolNames(manifestPath, { includeMemoryTools: false });
    const usagePins = pinned.filter((name) => name.startsWith('mcp_verso_tool_'));
    expect(usagePins).toHaveLength(20);
    expect(usagePins[0]).toBe('mcp_verso_tool_0');
    expect(pinned.filter((name) => name.startsWith('mcp__verso__tool_'))).toHaveLength(20);
  });

  it('seeds a connected toolkit that has no usage pins', () => {
    writeManifest([
      { nativeName: 'slack_search_messages', toolSlug: 'SLACK_SEARCH_MESSAGES', toolkitSlug: 'slack', origin: 'usage' },
      { nativeName: 'gmail_delete_draft', toolSlug: 'GMAIL_DELETE_DRAFT', toolkitSlug: 'gmail', origin: 'toolkit' },
      { nativeName: 'gmail_fetch_emails', toolSlug: 'GMAIL_FETCH_EMAILS', toolkitSlug: 'gmail', origin: 'toolkit' },
    ]);
    const pinned = computePinnedToolNames(manifestPath, { includeMemoryTools: false });
    expect(pinned).toContain('mcp_verso_slack_search_messages');
    expect(pinned).toContain('mcp_verso_gmail_fetch_emails');
    expect(pinned).not.toContain('mcp_verso_gmail_delete_draft');
  });

  it('seeds Google Docs with document creation instead of read-only search', () => {
    writeManifest([
      { nativeName: 'googledocs_search_documents', toolSlug: 'GOOGLEDOCS_SEARCH_DOCUMENTS', toolkitSlug: 'googledocs', origin: 'toolkit' },
      { nativeName: 'googledocs_create_document_markdown', toolSlug: 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN', toolkitSlug: 'googledocs', origin: 'toolkit' },
    ]);
    const pinned = computePinnedToolNames(manifestPath, { includeMemoryTools: false });
    expect(pinned).toContain('mcp_verso_googledocs_create_document_markdown');
    expect(pinned).not.toContain('mcp_verso_googledocs_search_documents');
  });

  it('does not seed a toolkit already covered by a usage pin', () => {
    writeManifest([
      { nativeName: 'slack_search_all', toolSlug: 'SLACK_SEARCH_ALL', toolkitSlug: 'slack', origin: 'usage' },
      { nativeName: 'slack_search_messages', toolSlug: 'SLACK_SEARCH_MESSAGES', toolkitSlug: 'slack', origin: 'toolkit' },
    ]);
    const pinned = computePinnedToolNames(manifestPath, { includeMemoryTools: false });
    expect(pinned).toContain('mcp_verso_slack_search_all');
    expect(pinned).not.toContain('mcp_verso_slack_search_messages');
  });

  describe('findInertCorePins', () => {
    const CORE_BASE = [
      'request_connection', 'search_toolkits', 'list_connections',
      'get_connection_status', 'propose_message_draft',
      'list_workspaces', 'search_workspaces', 'list_workspace_files',
      'read_workspace_file', 'write_workspace_file',
    ];
    const MEMORY_BASE = ['search_memory', 'get_memory_page', 'write_memory_page'];

    it('reports nothing when the gateway registered 0.18-style names', () => {
      const registered = [...CORE_BASE, ...MEMORY_BASE].map((n) => `mcp_verso_${n}`);
      expect(findInertCorePins(registered, { includeMemoryTools: true })).toEqual([]);
    });

    it('reports nothing when the gateway registered 0.19-style names', () => {
      const registered = [...CORE_BASE, ...MEMORY_BASE].map((n) => `mcp__verso__${n}`);
      expect(findInertCorePins(registered, { includeMemoryTools: true })).toEqual([]);
    });

    it('reports memory pins as inert when only non-memory tools registered', () => {
      const registered = CORE_BASE.map((n) => `mcp__verso__${n}`);
      expect(findInertCorePins(registered, { includeMemoryTools: true })).toEqual(MEMORY_BASE);
    });

    it('ignores memory pins when memory tools are disabled', () => {
      const registered = CORE_BASE.map((n) => `mcp__verso__${n}`);
      expect(findInertCorePins(registered, { includeMemoryTools: false })).toEqual([]);
    });

    it('reports everything inert under an unknown future naming convention', () => {
      const registered = [...CORE_BASE, ...MEMORY_BASE].map((n) => `mcp.verso.${n}`);
      expect(findInertCorePins(registered, { includeMemoryTools: true }))
        .toEqual([...CORE_BASE, ...MEMORY_BASE]);
    });
  });

  it('handles a pre-origin manifest (all entries unmarked) via seeds only', () => {
    writeManifest([
      { nativeName: 'slack_search_messages', toolSlug: 'SLACK_SEARCH_MESSAGES', toolkitSlug: 'slack' },
      { nativeName: 'slack_kick_user', toolSlug: 'SLACK_KICK_USER', toolkitSlug: 'slack' },
    ]);
    const pinned = computePinnedToolNames(manifestPath, { includeMemoryTools: false });
    expect(pinned).toContain('mcp_verso_slack_search_messages');
    expect(pinned).not.toContain('mcp_verso_slack_kick_user');
  });
});
