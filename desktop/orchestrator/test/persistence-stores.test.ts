import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConnectionsStore,
  type ConnectionRecord,
  type ConnectionRequestRecord,
} from '../src/connections/connections-store.ts';
import { CustomConnectorsStore } from '../src/connections/custom-connectors-store.ts';

const connection: ConnectionRecord = {
  connectedAccountId: 'account-1',
  toolkitSlug: 'slack',
  toolkitName: 'Slack',
  logoUrl: null,
  status: 'active',
  createdAt: '2026-08-18T09:00:00.000Z',
  updatedAt: '2026-08-18T09:00:00.000Z',
};

const request: ConnectionRequestRecord = {
  id: 'request-1',
  toolkitSlug: 'slack',
  toolkitName: 'Slack',
  logoUrl: null,
  status: 'pending',
  redirectUrl: null,
  connectedAccountId: null,
  errorMessage: null,
  createdAt: '2026-08-18T09:00:00.000Z',
  updatedAt: '2026-08-18T09:00:00.000Z',
};

describe('local persistence stores', () => {
  it('starts a missing connections store empty and creates its parent on save', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'verso-persistence-'));
    const storePath = path.join(tempDir, 'nested', 'connections.json');
    const markerPath = path.join(tempDir, 'tools.marker');
    const store = new ConnectionsStore(storePath, markerPath);

    expect(store.getversoUserId()).toBeNull();
    expect(store.listRequests()).toEqual([]);
    expect(store.listConnections()).toEqual([]);

    const versoUserId = store.ensureversoUserId();
    const persisted = JSON.parse(readFileSync(storePath, 'utf8')) as Record<string, unknown>;
    expect(persisted).toEqual({ versoUserId, requests: [], connections: [] });
    expect(readdirSync(path.dirname(storePath))).toEqual(['connections.json']);
  });

  it('recovers a corrupt connections store on the next mutation', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'verso-persistence-'));
    const storePath = path.join(tempDir, 'connections.json');
    writeFileSync(storePath, '{truncated', 'utf8');
    const store = new ConnectionsStore(storePath, path.join(tempDir, 'tools.marker'));

    expect(store.listConnections()).toEqual([]);
    store.upsertRequest(request);

    expect(new ConnectionsStore(storePath).getRequest(request.id)).toEqual(request);
    expect(readdirSync(tempDir).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('retains valid connection records while discarding invalid persisted entries', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'verso-persistence-'));
    const storePath = path.join(tempDir, 'connections.json');
    writeFileSync(storePath, JSON.stringify({
      versoUserId: 123,
      requests: [request, { id: 'incomplete' }],
      connections: [connection, null, { connectedAccountId: 'incomplete' }],
    }), 'utf8');

    const store = new ConnectionsStore(storePath, path.join(tempDir, 'tools.marker'));

    expect(store.getversoUserId()).toBeNull();
    expect(store.listRequests()).toEqual([request]);
    expect(store.listConnections()).toEqual([connection]);
  });

  it('recovers a corrupt custom connector store without changing its file shape', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'verso-persistence-'));
    const storePath = path.join(tempDir, 'custom-connectors.json');
    writeFileSync(storePath, 'null\n', 'utf8');
    const store = new CustomConnectorsStore(storePath);

    expect(store.list()).toEqual([]);
    const created = store.create({
      name: 'Internal MCP',
      slug: 'internal_mcp',
      url: 'https://mcp.example.com',
      transport: 'http',
      auth: 'bearer',
      logoUrl: null,
    });

    expect(new CustomConnectorsStore(storePath).get(created.id)).toEqual(created);
    const persisted = JSON.parse(readFileSync(storePath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(persisted)).toEqual(['connectors']);
    expect(readdirSync(tempDir).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('filters invalid custom connector records independently of file recovery', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'verso-persistence-'));
    const storePath = path.join(tempDir, 'custom-connectors.json');
    const valid = {
      id: 'connector-1',
      name: 'Internal MCP',
      slug: 'internal_mcp',
      url: 'https://mcp.example.com',
      transport: 'http',
      auth: 'none',
      logoUrl: null,
      createdAt: '2026-08-18T09:00:00.000Z',
      updatedAt: '2026-08-18T09:00:00.000Z',
    };
    writeFileSync(storePath, JSON.stringify({ connectors: [valid, { ...valid, id: 7 }] }), 'utf8');

    expect(new CustomConnectorsStore(storePath).list()).toEqual([valid]);
  });
});
