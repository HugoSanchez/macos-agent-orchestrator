import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ComposioService } from '@verso/composio';
import { KeychainSecretStore } from './keychain.ts';
import { readJsonFileOr, writeJsonFileAtomic } from '../shared/atomic-json-file.ts';
import { ConnectedAppsError } from '../integrations/connected-apps-provider.ts';
import { createUserComposioService, UserComposioProvider } from '../integrations/user-composio-provider.ts';
import type { RuntimeMode } from '../integrations/runtime-mode.ts';
import { json, route, type Route } from '../http/router.ts';

interface ProjectRecord {
  version: 1;
  userId: string;
  credentialHash: string | null;
}

export interface ComposioProjectStatus {
  provider: 'managed' | 'user';
  editable: boolean;
  saved: boolean;
  active: boolean;
  restartRequired: boolean;
  userId: string | null;
}

type SecretStore = Pick<KeychainSecretStore, 'getSecret' | 'setSecret' | 'deleteSecret'>;

/**
 * Configuration is staged until the next launch. Connection caches, ingestion
 * cursors, and document identities are selected once at startup, so changing
 * projects cannot send an old account's pending work to a new project.
 */
export class ComposioProject {
  private activeProvider = new UserComposioProvider(null, '');
  private record: ProjectRecord | null;
  private saved = false;
  private activeHash: string | null = null;
  private busy = false;
  private readonly keychain: SecretStore;
  private readonly createService: (key: string) => ComposioService;

  constructor(
    readonly filePath: string,
    private readonly mode: RuntimeMode,
    options: { keychain?: SecretStore; createService?: (key: string) => ComposioService } = {},
  ) {
    this.keychain = options.keychain ?? new KeychainSecretStore('com.verso.composio-project');
    this.createService = options.createService ?? createUserComposioService;
    this.record = readJsonFileOr(filePath, decodeRecord, () => null);
  }

  get namespace(): string | null { return this.activeHash; }
  get connectedApps(): UserComposioProvider { return this.activeProvider; }

  async initialize(): Promise<void> {
    if (this.mode === 'managed' || !this.record?.credentialHash) return;
    const key = await this.keychain.getSecret(this.secretId);
    if (!key || fingerprint(this.record.userId, key) !== this.record.credentialHash) return;
    this.saved = true;
    this.activeHash = this.record.credentialHash;
    this.activeProvider = new UserComposioProvider(this.createService(key), this.record.userId);
  }

  status(): ComposioProjectStatus {
    return {
      provider: this.mode === 'managed' ? 'managed' : 'user',
      editable: this.mode !== 'managed',
      saved: this.saved,
      active: this.mode !== 'managed' && this.activeProvider.configured,
      restartRequired: this.saved && (!this.activeProvider.configured || this.record?.credentialHash !== this.activeHash),
      userId: this.mode === 'managed' ? null : this.record?.userId ?? null,
    };
  }

  async save(input: unknown): Promise<ComposioProjectStatus> {
    this.assertEditable();
    const key = typeof input === 'string' ? input.trim() : '';
    if (!key || key.length > 1024 || /\s/.test(key)) {
      throw new ConnectedAppsError(400, 'Enter a valid Composio project API key.');
    }
    this.busy = true;
    try {
      const userId = this.record?.userId ?? `verso_${randomUUID()}`;
      const candidate = new UserComposioProvider(this.createService(key), userId);
      await candidate.listConnections(); // Read-only validation; never creates a connection.
      const previousKey = await this.keychain.getSecret(this.secretId);
      await this.keychain.setSecret(this.secretId, key);
      const next: ProjectRecord = { version: 1, userId, credentialHash: fingerprint(userId, key) };
      try {
        writeJsonFileAtomic(this.filePath, next);
      } catch {
        if (previousKey) await this.keychain.setSecret(this.secretId, previousKey);
        else await this.keychain.deleteSecret(this.secretId);
        throw new ConnectedAppsError(500, 'Could not save Composio settings.');
      }
      this.record = next;
      this.saved = true;
      if (next.credentialHash !== this.activeHash) this.activeProvider.disable();
      return this.status();
    } finally { this.busy = false; }
  }

  async remove(): Promise<ComposioProjectStatus> {
    this.assertEditable();
    this.busy = true;
    try {
      // Disable first: even an in-flight SDK request cannot return data after removal.
      this.activeProvider.disable();
      const next: ProjectRecord = {
        version: 1, userId: this.record?.userId ?? `verso_${randomUUID()}`, credentialHash: null,
      };
      writeJsonFileAtomic(this.filePath, next);
      this.record = next;
      this.saved = false;
      await this.keychain.deleteSecret(this.secretId);
      return this.status();
    } finally { this.busy = false; }
  }

  private get secretId(): string {
    return createHash('sha256').update(path.resolve(this.filePath)).digest('hex');
  }

  private assertEditable(): void {
    if (this.mode === 'managed') throw new ConnectedAppsError(403, 'Use a local build to configure your own Composio project.');
    if (this.busy) throw new ConnectedAppsError(409, 'Composio settings are already being updated.');
  }
}

function fingerprint(userId: string, key: string): string {
  return createHash('sha256').update(`${userId}:${key}`).digest('hex');
}

function decodeRecord(value: unknown): ProjectRecord | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Partial<ProjectRecord>;
  return r.version === 1 && typeof r.userId === 'string' && /^verso_[a-f0-9-]{36}$/.test(r.userId)
    && (r.credentialHash === null || typeof r.credentialHash === 'string' && /^[a-f0-9]{64}$/.test(r.credentialHash))
    ? r as ProjectRecord : null;
}

export function buildComposioProjectRoutes(project: ComposioProject, onChanged: () => void): Route[] {
  const change = (operation: () => Promise<ComposioProjectStatus>) => async (_req: unknown, res: Parameters<typeof json>[0]) => {
    try {
      const status = await operation();
      onChanged();
      json(res, 200, status);
    } catch (error) {
      json(res, error instanceof ConnectedAppsError ? error.status : 500, {
        error: 'composio_settings_failed',
        message: error instanceof ConnectedAppsError ? error.message : 'Could not update Composio settings.',
      });
    }
  };
  return [
    route('GET', '/settings/composio', async (_req, res) => { json(res, 200, project.status()); }),
    route('PUT', '/settings/composio', async (req, res, _params, body) => {
      await change(() => project.save((body as { apiKey?: unknown } | null)?.apiKey))(req, res);
    }),
    route('DELETE', '/settings/composio', change(() => project.remove())),
  ];
}
