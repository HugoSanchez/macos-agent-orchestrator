import os from 'node:os';
import path from 'node:path';
import { readJsonFileOr, writeJsonFileAtomic } from './atomic-json-file.ts';

interface BrowserSettings {
  /**
   * Lets the agent browser reach localhost/RFC1918 addresses (self-hosted
   * tools). On by default and no longer surfaced in settings: the reach is
   * needed often enough that a toggle added friction without pulling its
   * weight.
   */
  allowPrivateUrls: boolean;
}

function defaultStorePath(): string {
  return process.env.VERSO_BROWSER_SETTINGS_PATH?.trim()
    || path.join(os.homedir(), 'Library', 'Application Support', 'verso', 'browser-settings.json');
}

function decode(value: unknown): BrowserSettings {
  const record = (value ?? {}) as Record<string, unknown>;
  // On unless a stored config explicitly opted out; absent/malformed → on.
  return { allowPrivateUrls: record.allowPrivateUrls !== false };
}

export class BrowserSettingsStore {
  private readonly storePath: string;

  constructor(storePath = defaultStorePath()) {
    this.storePath = storePath;
  }

  get(): BrowserSettings {
    return readJsonFileOr(this.storePath, decode, () => ({ allowPrivateUrls: true }));
  }

  setAllowPrivateUrls(allow: boolean): BrowserSettings {
    const next = { allowPrivateUrls: allow };
    writeJsonFileAtomic(this.storePath, next);
    return next;
  }
}
