import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  ComposioToolUsageStore,
  nativeNameForComposioToolSlug,
  type ComposioNativeToolManifest,
} from '../src/connections/composio-tool-usage-store.ts';

describe('ComposioToolUsageStore', () => {
  let tempRoot = '';

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = '';
    }
  });

  function setup() {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'verso-composio-usage-'));
    const store = new ComposioToolUsageStore(path.join(tempRoot, 'usage.sqlite'));
    const manifestPath = path.join(tempRoot, 'manifest.json');
    return { store, manifestPath };
  }

  test('ranks connected toolkit tools by success count and recency', () => {
    const { store, manifestPath } = setup();
    store.recordSuccessfulUse(tool('SLACK_SEARCH_MESSAGES', 'slack'), '2026-05-28T10:00:00.000Z');
    store.recordSuccessfulUse(tool('GMAIL_SEND_EMAIL', 'gmail'), '2026-05-28T11:00:00.000Z');
    store.recordSuccessfulUse(tool('GMAIL_SEND_EMAIL', 'gmail'), '2026-05-28T12:00:00.000Z');
    store.recordSuccessfulUse(tool('GMAIL_CREATE_DRAFT', 'gmail'), '2026-05-28T13:00:00.000Z');

    const manifest = store.writeManifest(manifestPath, ['gmail', 'slack']);

    expect(manifest.tools.map((item) => item.toolSlug)).toEqual([
      'GMAIL_SEND_EMAIL',
      'GMAIL_CREATE_DRAFT',
      'SLACK_SEARCH_MESSAGES',
    ]);
    const persisted = JSON.parse(readFileSync(manifestPath, 'utf8')) as ComposioNativeToolManifest;
    expect(persisted.tools).toHaveLength(3);
  });

  test('excludes disconnected toolkit tools', () => {
    const { store, manifestPath } = setup();
    store.recordSuccessfulUse(tool('SLACK_SEARCH_MESSAGES', 'slack'));
    store.recordSuccessfulUse(tool('GMAIL_SEND_EMAIL', 'gmail'));

    const manifest = store.writeManifest(manifestPath, ['gmail']);

    expect(manifest.tools.map((item) => item.toolkitSlug)).toEqual(['gmail']);
    expect(manifest.tools.map((item) => item.toolSlug)).toEqual(['GMAIL_SEND_EMAIL']);
  });

  test('keeps the manifest file present when no toolkit tools remain', () => {
    const { store, manifestPath } = setup();
    store.recordSuccessfulUse(tool('GMAIL_SEND_EMAIL', 'gmail'));
    store.writeManifest(manifestPath, ['gmail']);
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = store.writeManifest(manifestPath, ['slack']);

    expect(manifest.tools.map((item) => item.toolSlug)).toEqual([]);
    expect(existsSync(manifestPath)).toBe(true);
  });

  test('caps the composio portion of the manifest', () => {
    const { store, manifestPath } = setup();
    for (let index = 0; index < 30; index += 1) {
      store.recordSuccessfulUse(tool(`GMAIL_TOOL_${index}`, 'gmail'), `2026-05-28T10:${String(index).padStart(2, '0')}:00.000Z`);
    }

    const manifest = store.writeManifest(manifestPath, ['gmail']);

    expect(manifest.tools).toHaveLength(25);
  });

  test('includes materialized connected-app tools beyond the learned limit', () => {
    const { store, manifestPath } = setup();
    for (let index = 0; index < 30; index += 1) {
      store.recordSuccessfulUse(tool(`GMAIL_LEARNED_${index}`, 'gmail'), `2026-05-28T10:${String(index).padStart(2, '0')}:00.000Z`);
    }

    const materialized = [
      materializedTool('GMAIL_SEND_EMAIL', 'gmail'),
      materializedTool('GMAIL_CREATE_DRAFT', 'gmail'),
      materializedTool('SLACK_SEARCH_MESSAGES', 'slack'),
    ];
    const manifest = store.writeManifest(manifestPath, ['gmail'], undefined, materialized);

    expect(manifest.tools.map((item) => item.toolSlug)).toContain('GMAIL_SEND_EMAIL');
    expect(manifest.tools.map((item) => item.toolSlug)).toContain('GMAIL_CREATE_DRAFT');
    expect(manifest.tools.map((item) => item.toolSlug)).not.toContain('SLACK_SEARCH_MESSAGES');
    // 25 learned Gmail tools + 2 materialized Gmail tools
    expect(manifest.tools).toHaveLength(27);
  });

  test('dedupes materialized tools against learned tools', () => {
    const { store, manifestPath } = setup();
    store.recordSuccessfulUse(tool('GMAIL_SEND_EMAIL', 'gmail'), '2026-05-28T10:00:00.000Z');

    const manifest = store.writeManifest(
      manifestPath,
      ['gmail'],
      undefined,
      [materializedTool('GMAIL_SEND_EMAIL', 'gmail')],
    );

    expect(manifest.tools.filter((item) => item.toolSlug === 'GMAIL_SEND_EMAIL')).toHaveLength(1);
  });

  test('generates safe native names', () => {
    expect(nativeNameForComposioToolSlug('GMAIL_SEND_EMAIL')).toBe('gmail_send_email');
    expect(nativeNameForComposioToolSlug('123_BAD-SLUG')).toBe('tool_123_bad_slug');
  });
});

function tool(slug: string, toolkitSlug: string) {
  return {
    slug,
    name: slug,
    description: null,
    toolkitSlug,
    toolkitName: toolkitSlug,
    inputParameters: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
      },
    },
  };
}

function materializedTool(slug: string, toolkitSlug: string) {
  return {
    nativeName: nativeNameForComposioToolSlug(slug),
    toolSlug: slug,
    toolkitSlug,
    name: slug,
    description: null,
    inputParameters: {
      type: 'object',
      properties: {},
    },
  };
}
