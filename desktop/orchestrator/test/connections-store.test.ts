import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConnectionsStore, type ConnectionRecord } from '../src/connections/connections-store.ts';

function fixtureConnection(overrides: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    connectedAccountId: 'ca_123',
    toolkitSlug: 'slack',
    toolkitName: 'Slack',
    logoUrl: 'https://example.com/slack.png',
    status: 'active',
    createdAt: '2026-05-12T10:00:00.000Z',
    updatedAt: '2026-05-12T10:00:00.000Z',
    ...overrides,
  };
}

describe('ConnectionsStore tool refresh marker', () => {
  it('touches the marker when tool availability changes', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'verso-connections-store-'));
    const storePath = path.join(tempDir, 'connections.json');
    const markerPath = path.join(tempDir, 'composio-tools-refresh.marker');
    const store = new ConnectionsStore(storePath, markerPath);

    store.upsertConnection(fixtureConnection());

    expect(readFileSync(markerPath, 'utf8').trim()).toMatch(/^\d+$/);
  });

  it('does not retouch the marker for timestamp-only churn', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'verso-connections-store-'));
    const storePath = path.join(tempDir, 'connections.json');
    const markerPath = path.join(tempDir, 'composio-tools-refresh.marker');
    const store = new ConnectionsStore(storePath, markerPath);

    store.upsertConnection(fixtureConnection());
    const initialMarker = readFileSync(markerPath, 'utf8');

    await new Promise((resolve) => setTimeout(resolve, 20));

    store.upsertConnection(fixtureConnection({
      updatedAt: '2026-05-12T10:05:00.000Z',
    }));

    expect(readFileSync(markerPath, 'utf8')).toBe(initialMarker);
  });

  it('replaces stale cached connections when the remote list is canonical', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'verso-connections-store-'));
    const storePath = path.join(tempDir, 'connections.json');
    const markerPath = path.join(tempDir, 'composio-tools-refresh.marker');
    const store = new ConnectionsStore(storePath, markerPath);

    store.upsertConnection(fixtureConnection());
    store.replaceConnections([]);

    expect(store.listConnections()).toEqual([]);
    expect(readFileSync(markerPath, 'utf8').trim()).toMatch(/^\d+$/);
  });
});
