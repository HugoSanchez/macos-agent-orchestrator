import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { HermesManagedProfile } from '../src/hermes/hermes-managed-profile.ts';
import { CustomConnectorsStore } from '../src/connections/custom-connectors-store.ts';
import { ANTHROPIC_CHAT_MODELS, CODEX_CHAT_MODELS } from '../src/models/model-catalog.ts';

/**
 * The managed-profile transaction reconciles api_server model_routes with
 * the credentials on disk so per-request model switching re-resolves the
 * right provider. It is tested directly, without process-supervisor setup.
 */
describe('HermesManagedProfile: model_routes reconciliation', () => {
  let tempRoot = '';
  let managedHome = '';
  let envSnapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'verso-model-routes-test-'));
    managedHome = path.join(tempRoot, 'profiles', 'verso');
    envSnapshot = {
      HERMES_HOME: process.env.HERMES_HOME,
      VERSO_HERMES_GATEWAY_URL: process.env.VERSO_HERMES_GATEWAY_URL,
      VERSO_MEMORY_ENABLED: process.env.VERSO_MEMORY_ENABLED,
    };
    process.env.HERMES_HOME = tempRoot;
    delete process.env.VERSO_HERMES_GATEWAY_URL;
    delete process.env.VERSO_MEMORY_ENABLED;

    writeFileSync(path.join(tempRoot, 'config.yaml'), [
      'model:',
      '  provider: openai-codex',
      '  default: gpt-5.4',
    ].join('\n'), 'utf8');
    writeFileSync(path.join(tempRoot, '.env'), '', 'utf8');
    writeFileSync(path.join(tempRoot, 'auth.json'), '{}', 'utf8');
    writeFileSync(path.join(tempRoot, 'SOUL.md'), '', 'utf8');
    mkdirSync(path.join(tempRoot, 'memories'), { recursive: true });
    writeFileSync(path.join(tempRoot, 'memories', 'MEMORY.md'), '', 'utf8');
    writeFileSync(path.join(tempRoot, 'memories', 'USER.md'), '', 'utf8');
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function seed(): void {
    const profile = new HermesManagedProfile({
      templateHome: tempRoot,
      managedHome,
      runtimeMode: 'managed',
      memoryToolsMode: 'full',
      customConnectorsStore: new CustomConnectorsStore(path.join(tempRoot, 'custom-connectors.json')),
    });
    profile.prepare('http://127.0.0.1:62000');
  }

  function managedRoutes(): Record<string, unknown> | undefined {
    const parsed = YAML.parse(readFileSync(path.join(managedHome, 'config.yaml'), 'utf8')) as {
      platforms?: { api_server?: { extra?: { model_routes?: Record<string, unknown> } } };
    };
    return parsed.platforms?.api_server?.extra?.model_routes;
  }

  function writeManagedCreds(opts: { codex?: boolean; anthropic?: boolean }): void {
    mkdirSync(managedHome, { recursive: true });
    writeFileSync(
      path.join(managedHome, 'auth.json'),
      JSON.stringify(opts.codex ? { credential_pool: { 'openai-codex': [{ id: 'c1' }] } } : {}),
      'utf8',
    );
    writeFileSync(
      path.join(managedHome, '.env'),
      opts.anthropic ? 'ANTHROPIC_API_KEY=sk-ant-test\n' : '',
      'utf8',
    );
  }

  it('writes no routes when no credentials exist', () => {
    seed();
    expect(managedRoutes()).toBeUndefined();
  });

  it('routes Codex models when Codex credentials exist', () => {
    writeManagedCreds({ codex: true });
    seed();
    const routes = managedRoutes();
    for (const model of CODEX_CHAT_MODELS) {
      expect(routes?.[model]).toEqual({ model, provider: 'openai-codex' });
    }
    for (const model of ANTHROPIC_CHAT_MODELS) {
      expect(routes?.[model]).toBeUndefined();
    }
  });

  it('routes Claude models when the Anthropic key exists, and drops them on disconnect', () => {
    writeManagedCreds({ codex: true, anthropic: true });
    seed();
    let routes = managedRoutes();
    for (const model of ANTHROPIC_CHAT_MODELS) {
      expect(routes?.[model]).toEqual({ model, provider: 'anthropic' });
    }

    // Key removed (disconnect writes an empty value) → routes disappear on
    // the next reconcile, Codex routes survive.
    writeFileSync(path.join(managedHome, '.env'), 'ANTHROPIC_API_KEY=\n', 'utf8');
    seed();
    routes = managedRoutes();
    for (const model of ANTHROPIC_CHAT_MODELS) {
      expect(routes?.[model]).toBeUndefined();
    }
    for (const model of CODEX_CHAT_MODELS) {
      expect(routes?.[model]).toEqual({ model, provider: 'openai-codex' });
    }
  });

  it('preserves hand-added routes it does not own', () => {
    writeManagedCreds({ codex: true });
    mkdirSync(managedHome, { recursive: true });
    writeFileSync(path.join(managedHome, 'config.yaml'), YAML.stringify({
      model: { provider: 'openai-codex', default: 'gpt-5.4' },
      platforms: { api_server: { extra: { model_routes: {
        'my-alias': { model: 'minimax/minimax-m1', provider: 'openrouter' },
      } } } },
    }), 'utf8');
    seed();
    const routes = managedRoutes();
    expect(routes?.['my-alias']).toEqual({ model: 'minimax/minimax-m1', provider: 'openrouter' });
    expect(routes?.['gpt-5.4']).toEqual({ model: 'gpt-5.4', provider: 'openai-codex' });
  });
});
