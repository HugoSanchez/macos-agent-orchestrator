import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { hasUsableComposioManifest, readComposioManifestSummary } from '../src/connections/composio-manifest.ts';

describe('hasUsableComposioManifest', () => {
  let tempRoot = '';

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = '';
    }
  });

  function manifestPath(): string {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'verso-composio-manifest-'));
    return path.join(tempRoot, 'verso-composio-tools.json');
  }

  test('keeps a populated v1 manifest usable', () => {
    const filePath = manifestPath();
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      tools: [{ toolSlug: 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN', toolkitSlug: 'googledocs' }],
    }), 'utf8');

    expect(hasUsableComposioManifest(filePath)).toBe(true);
  });

  test('rejects missing, corrupt, and empty manifests', () => {
    const filePath = manifestPath();
    expect(hasUsableComposioManifest(filePath)).toBe(false);

    writeFileSync(filePath, 'not json', 'utf8');
    expect(hasUsableComposioManifest(filePath)).toBe(false);

    writeFileSync(filePath, JSON.stringify({ version: 1, tools: [] }), 'utf8');
    expect(hasUsableComposioManifest(filePath)).toBe(false);
  });

  test('rejects manifests that only contain synthetic Verso tools', () => {
    const filePath = manifestPath();
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      tools: [{ toolSlug: 'PROPOSE_MESSAGE_DRAFT', toolkitSlug: 'verso' }],
    }), 'utf8');

    expect(hasUsableComposioManifest(filePath)).toBe(false);
  });
});

describe('readComposioManifestSummary', () => {
  let tempRoot = '';

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = '';
    }
  });

  function manifestPath(): string {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'verso-composio-manifest-'));
    return path.join(tempRoot, 'verso-composio-tools.json');
  }

  test('summarizes a populated manifest', () => {
    const filePath = manifestPath();
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      generatedAt: '2026-08-07T17:03:11.831Z',
      tools: [
        { toolSlug: 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN', toolkitSlug: 'googledocs' },
        { toolSlug: 'SLACK_SEARCH_MESSAGES', toolkitSlug: 'slack' },
        { toolSlug: 'PROPOSE_MESSAGE_DRAFT', toolkitSlug: 'verso' },
      ],
    }), 'utf8');

    expect(readComposioManifestSummary(filePath)).toEqual({
      exists: true,
      valid: true,
      toolCount: 3,
      nonVersoToolCount: 2,
      toolkitSlugs: ['googledocs', 'slack'],
      generatedAt: '2026-08-07T17:03:11.831Z',
    });
  });

  test('reports missing and corrupt manifests as invalid', () => {
    const filePath = manifestPath();
    expect(readComposioManifestSummary(filePath)).toEqual({
      exists: false,
      valid: false,
      toolCount: 0,
      nonVersoToolCount: 0,
      toolkitSlugs: [],
      generatedAt: null,
    });

    writeFileSync(filePath, 'not json', 'utf8');
    expect(readComposioManifestSummary(filePath)).toMatchObject({ exists: true, valid: false });

    writeFileSync(filePath, JSON.stringify({ version: 2, tools: [] }), 'utf8');
    expect(readComposioManifestSummary(filePath)).toMatchObject({ exists: true, valid: false });
  });
});
