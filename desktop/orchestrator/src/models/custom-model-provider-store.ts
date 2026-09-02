import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readJsonFileOr, writeJsonFileAtomic } from '../shared/atomic-json-file.ts';

export const CUSTOM_MODEL_KEY_ENV = 'VERSO_CUSTOM_MODEL_API_KEY';
export const CUSTOM_MODEL_PROVIDER_NAME = 'verso-custom';
export const CUSTOM_MODEL_KEYCHAIN_SERVICE = 'com.verso.custom-model-provider';

export interface CustomModelProviderRecord {
  id: string;
  baseUrl: string;
  model: string;
  usesApiKey: boolean;
  updatedAt: string;
}

export class CustomModelProviderStore {
  private record: CustomModelProviderRecord | null;

  constructor(private readonly storePath: string) {
    this.record = this.load();
  }

  static pathForHermesHome(hermesHome: string): string {
    return path.join(hermesHome, 'verso-custom-model.json');
  }

  get(): CustomModelProviderRecord | null {
    return this.record ? { ...this.record } : null;
  }

  set(baseUrl: string, model: string, usesApiKey: boolean): CustomModelProviderRecord {
    this.record = {
      id: this.record?.id ?? randomUUID(),
      baseUrl,
      model,
      usesApiKey,
      updatedAt: new Date().toISOString(),
    };
    writeJsonFileAtomic(this.storePath, this.record);
    return { ...this.record };
  }

  clear(): CustomModelProviderRecord | null {
    const previous = this.record;
    this.record = null;
    writeJsonFileAtomic(this.storePath, null);
    return previous ? { ...previous } : null;
  }

  restore(record: CustomModelProviderRecord | null): void {
    this.record = record ? { ...record } : null;
    writeJsonFileAtomic(this.storePath, this.record);
  }

  private load(): CustomModelProviderRecord | null {
    return readJsonFileOr(
      this.storePath,
      (value) => isRecord(value) ? value : null,
      () => null,
    );
  }
}

function isRecord(value: unknown): value is CustomModelProviderRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<CustomModelProviderRecord>;
  return typeof record.id === 'string'
    && typeof record.baseUrl === 'string'
    && typeof record.model === 'string'
    && typeof record.usesApiKey === 'boolean'
    && typeof record.updatedAt === 'string';
}
