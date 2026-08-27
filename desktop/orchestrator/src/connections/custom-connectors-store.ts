import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readJsonFileOr, writeJsonFileAtomic } from '../shared/atomic-json-file.ts';

export type CustomConnectorAuth = 'none' | 'bearer' | 'oauth';
export type CustomConnectorTransport = 'http' | 'sse';

export interface CustomConnectorRecord {
  id: string;
  name: string;
  slug: string;
  url: string;
  transport: CustomConnectorTransport;
  auth: CustomConnectorAuth;
  logoUrl: string | null;
  iconPath?: string | null;
  iconContentType?: string | null;
  lastKnownToolCount?: number;
  createdAt: string;
  updatedAt: string;
}

interface StoreShape {
  connectors: CustomConnectorRecord[];
}

const RESERVED_SLUGS = new Set(['verso', 'composio']);

function defaultStorePath(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'verso', 'custom-connectors.json');
}

export function sanitizeCustomConnectorSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/_+/g, '_');
}

export function assertValidCustomConnectorSlug(slug: string, existing: Iterable<string> = []): void {
  if (!/^[a-z0-9_]+$/.test(slug)) throw new Error('Connector slug must contain only lowercase letters, numbers, and underscores.');
  if (RESERVED_SLUGS.has(slug)) throw new Error(`"${slug}" is reserved.`);
  for (const item of existing) {
    if (item === slug) throw new Error(`A custom connector named "${slug}" already exists.`);
  }
}

export class CustomConnectorsStore {
  private readonly storePath: string;
  private state: StoreShape;

  constructor(storePath = process.env.VERSO_CUSTOM_CONNECTORS_STORE_PATH?.trim() || defaultStorePath()) {
    this.storePath = storePath;
    this.state = this.load();
  }

  get path(): string {
    return this.storePath;
  }

  list(): CustomConnectorRecord[] {
    return [...this.state.connectors].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): CustomConnectorRecord | null {
    return this.state.connectors.find((item) => item.id === id) ?? null;
  }

  create(input: Omit<CustomConnectorRecord, 'id' | 'createdAt' | 'updatedAt'>): CustomConnectorRecord {
    assertValidCustomConnectorSlug(input.slug, this.state.connectors.map((item) => item.slug));
    const now = new Date().toISOString();
    const record: CustomConnectorRecord = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
    this.state.connectors.push(record);
    this.save();
    return record;
  }

  update(id: string, patch: Partial<Omit<CustomConnectorRecord, 'id' | 'createdAt'>>): CustomConnectorRecord {
    const index = this.state.connectors.findIndex((item) => item.id === id);
    if (index < 0) throw new Error(`Unknown custom connector: ${id}`);
    if (patch.slug && patch.slug !== this.state.connectors[index].slug) {
      assertValidCustomConnectorSlug(patch.slug, this.state.connectors.filter((item) => item.id !== id).map((item) => item.slug));
    }
    const record = { ...this.state.connectors[index], ...patch, updatedAt: new Date().toISOString() };
    this.state.connectors[index] = record;
    this.save();
    return record;
  }

  delete(id: string): CustomConnectorRecord | null {
    const record = this.get(id);
    if (!record) return null;
    this.state.connectors = this.state.connectors.filter((item) => item.id !== id);
    this.save();
    return record;
  }

  private load(): StoreShape {
    return readJsonFileOr(
      this.storePath,
      (value) => {
        const parsed = value && typeof value === 'object' && !Array.isArray(value)
          ? value as Partial<StoreShape>
          : {};
        return { connectors: Array.isArray(parsed.connectors) ? parsed.connectors.filter(isRecord) : [] };
      },
      () => ({ connectors: [] }),
    );
  }

  private save(): void {
    writeJsonFileAtomic(this.storePath, this.state);
  }
}

function isRecord(value: unknown): value is CustomConnectorRecord {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<CustomConnectorRecord>;
  return typeof item.id === 'string'
    && typeof item.name === 'string'
    && typeof item.slug === 'string'
    && typeof item.url === 'string'
    && (item.transport === 'http' || item.transport === 'sse')
    && (item.auth === 'none' || item.auth === 'bearer' || item.auth === 'oauth')
    && (typeof item.logoUrl === 'string' || item.logoUrl === null)
    && (typeof item.iconPath === 'string' || item.iconPath === null || item.iconPath === undefined)
    && (typeof item.iconContentType === 'string' || item.iconContentType === null || item.iconContentType === undefined)
    && (item.lastKnownToolCount === undefined
      || (Number.isInteger(item.lastKnownToolCount) && item.lastKnownToolCount >= 0))
    && typeof item.createdAt === 'string'
    && typeof item.updatedAt === 'string';
}
