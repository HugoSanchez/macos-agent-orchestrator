import type { HermesSupervisor } from '../hermes/hermes-supervisor.ts';
import { KeychainSecretStore } from '../connections/keychain.ts';
import { VALID_CHAT_MODELS } from './model-catalog.ts';
import {
  CUSTOM_MODEL_KEYCHAIN_SERVICE,
  CustomModelProviderStore,
} from './custom-model-provider-store.ts';

const DISCOVERY_TIMEOUT_MS = 15_000;

export interface CustomModelStatus {
  connected: boolean;
  baseUrl: string | null;
  model: string | null;
}

export class CustomModelProviderService {
  constructor(
    private readonly store: CustomModelProviderStore,
    private readonly hermes: HermesSupervisor,
    private readonly keychain = new KeychainSecretStore(CUSTOM_MODEL_KEYCHAIN_SERVICE),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getStatus(): Promise<CustomModelStatus> {
    const record = this.store.get();
    if (!record) return { connected: false, baseUrl: null, model: null };
    const apiKey = record.usesApiKey ? await this.keychain.getSecret(record.id) : null;
    return {
      connected: !record.usesApiKey || Boolean(apiKey),
      baseUrl: record.baseUrl,
      model: record.model,
    };
  }

  getConfiguredModel(): string | null {
    return this.store.get()?.model ?? null;
  }

  async discover(baseUrlInput: string, apiKeyInput: string): Promise<{ models: string[] }> {
    const baseUrl = normalizeCustomModelBaseUrl(baseUrlInput);
    const apiKey = normalizeApiKey(apiKeyInput);
    let response: Response;
    try {
      response = await this.fetchImpl(`${baseUrl}/models`, {
        ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
    } catch {
      throw new CustomModelProviderError(502, 'Could not reach the endpoint.');
    }

    if (response.status === 401 || response.status === 403) {
      throw new CustomModelProviderError(
        401,
        apiKey
          ? 'The endpoint rejected this API key or proxy token.'
          : 'This endpoint requires an API key or proxy token.',
      );
    }
    if (response.status === 404 || response.status === 405) return { models: [] };
    if (!response.ok) {
      throw new CustomModelProviderError(502, `Model discovery failed (HTTP ${response.status}).`);
    }

    const body = await response.json().catch(() => null) as { data?: unknown } | null;
    if (!Array.isArray(body?.data)) return { models: [] };
    const models = body.data
      .map((item) => item && typeof item === 'object' ? (item as { id?: unknown }).id : null)
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      .map((id) => id.trim());
    return { models: [...new Set(models)] };
  }

  async connect(baseUrlInput: string, apiKeyInput: string, modelInput: string): Promise<CustomModelStatus> {
    const baseUrl = normalizeCustomModelBaseUrl(baseUrlInput);
    const apiKey = normalizeApiKey(apiKeyInput);
    const model = normalizeModelId(modelInput);
    if ((VALID_CHAT_MODELS as readonly string[]).includes(model)) {
      throw new CustomModelProviderError(400, 'Choose a model ID that does not duplicate a built-in Verso model.');
    }

    const previous = this.store.get();
    const record = this.store.set(baseUrl, model, apiKey !== null);
    try {
      if (apiKey) await this.keychain.setSecret(record.id, apiKey);
      else await this.keychain.deleteSecret(record.id);
    } catch (error) {
      this.store.restore(previous);
      throw error;
    }
    await this.hermes.restart();
    return { connected: true, baseUrl, model };
  }

  async disconnect(): Promise<void> {
    const record = this.store.clear();
    if (record) await this.keychain.deleteSecret(record.id);
    await this.hermes.restart();
  }
}

export function normalizeCustomModelBaseUrl(input: string): string {
  const raw = input.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CustomModelProviderError(400, 'Enter a valid HTTP or HTTPS base URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new CustomModelProviderError(400, 'Enter a valid HTTP or HTTPS base URL.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new CustomModelProviderError(400, 'The base URL cannot contain credentials, a query, or a fragment.');
  }
  if (url.hostname.endsWith('.modal.direct') && url.pathname === '/') {
    url.pathname = '/v1';
  }
  return url.toString().replace(/\/$/, '');
}

function normalizeApiKey(input: string): string | null {
  const pasted = input.trim();
  const value = /^(?:Authorization\s*:\s*)?Bearer\s+(\S+)$/i.exec(pasted)?.[1] ?? pasted;
  if (!value) return null;
  if (/\s/.test(value)) {
    throw new CustomModelProviderError(400, 'API key must be a single token.');
  }
  return value;
}

function normalizeModelId(input: string): string {
  const value = input.trim();
  if (!value || /[\r\n]/.test(value)) {
    throw new CustomModelProviderError(400, 'Enter a valid model ID.');
  }
  return value;
}

export class CustomModelProviderError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'CustomModelProviderError';
  }
}
