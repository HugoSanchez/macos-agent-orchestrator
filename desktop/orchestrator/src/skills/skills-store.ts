import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

function defaultConfigPath(): string {
  return path.join(os.homedir(), '.hermes', 'config.yaml');
}

// Source of truth for skill enable/disable is Hermes' own config:
// ~/.hermes/config.yaml under `skills.disabled`. Hermes filters its
// auto-injected skills index against this list at request time, so
// editing it here means our toggle surfaces a real Hermes setting
// instead of a verso-side parallel store.
//
// Note the inversion: Hermes tracks *disabled* names; our UI presents
// an enabled toggle, so callers pass `enabled` and we translate.
export class HermesSkillsConfig {
  private readonly configPath: string;

  constructor(configPath = process.env.VERSO_HERMES_CONFIG_PATH?.trim() || defaultConfigPath()) {
    this.configPath = configPath;
  }

  isEnabled(name: string): boolean {
    return !this.listDisabled().includes(name);
  }

  setEnabled(name: string, enabled: boolean): void {
    const doc = this.loadDoc();
    const next = new Set(readDisabled(doc));
    if (enabled) next.delete(name);
    else next.add(name);
    doc.setIn(['skills', 'disabled'], [...next].sort());
    this.persist(doc);
  }

  listDisabled(): string[] {
    return readDisabled(this.loadDoc());
  }

  private loadDoc(): YAML.Document.Parsed {
    if (!existsSync(this.configPath)) {
      return YAML.parseDocument('');
    }
    const raw = readFileSync(this.configPath, 'utf-8');
    return YAML.parseDocument(raw);
  }

  private persist(doc: YAML.Document.Parsed): void {
    mkdirSync(path.dirname(this.configPath), { recursive: true });
    writeFileSync(this.configPath, doc.toString());
  }
}

function readDisabled(doc: YAML.Document.Parsed): string[] {
  const value = doc.toJS()?.skills?.disabled;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}
