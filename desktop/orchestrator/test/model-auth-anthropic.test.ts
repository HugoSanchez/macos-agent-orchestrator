import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AnthropicAuthService, AnthropicAuthError, readAnthropicKeyFromEnvFile } from '../src/models/model-auth.ts';
import type { HermesSupervisor } from '../src/hermes/hermes-supervisor.ts';

/**
 * The service shells into the bundled Hermes python to persist the key.
 * Tests substitute a capture script for the python binary: it appends the
 * `-c` payload to a file so assertions can inspect exactly what would run —
 * including that the API key itself never appears in the script text (it
 * must travel via the child environment, which `ps` cannot see).
 */
describe('AnthropicAuthService', () => {
  let tempHome = '';
  let capturePath = '';
  let scriptPath = '';
  let restart: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), 'verso-anthropic-test-'));
    capturePath = path.join(tempHome, 'captured-scripts.txt');
    scriptPath = path.join(tempHome, 'fake-python.sh');
    writeFileSync(scriptPath, '#!/bin/sh\nprintf \'%s\\n---\\n\' "$2" >> "$VERSO_TEST_CAPTURE"\n', 'utf8');
    chmodSync(scriptPath, 0o755);
    restart = vi.fn(async () => {});
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  function makeService(opts: {
    hasCodex?: boolean;
    fetchImpl?: typeof fetch;
  } = {}): AnthropicAuthService {
    const hermes = {
      hermesHome: tempHome,
      invoke: () => ({
        command: scriptPath,
        args: [],
        env: { VERSO_TEST_CAPTURE: capturePath },
      }),
      restart,
    } as unknown as HermesSupervisor;
    return new AnthropicAuthService(
      hermes,
      async () => opts.hasCodex ?? false,
      opts.fetchImpl ?? (async () => new Response(null, { status: 200 })),
    );
  }

  function capturedScripts(): string {
    return existsSync(capturePath) ? readFileSync(capturePath, 'utf8') : '';
  }

  it('reports disconnected without a stored key, connected with one', async () => {
    expect((await makeService().getStatus()).connected).toBe(false);
    writeFileSync(path.join(tempHome, '.env'), 'ANTHROPIC_API_KEY=sk-ant-test123\n', 'utf8');
    expect((await makeService().getStatus()).connected).toBe(true);
  });

  it('rejects malformed keys before any network or persistence work', async () => {
    const fetchSpy = vi.fn();
    const service = makeService({ fetchImpl: fetchSpy as unknown as typeof fetch });
    await expect(service.connect('  ')).rejects.toBeInstanceOf(AnthropicAuthError);
    await expect(service.connect('two words')).rejects.toBeInstanceOf(AnthropicAuthError);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(capturedScripts()).toBe('');
    expect(restart).not.toHaveBeenCalled();
  });

  it('rejects keys the Anthropic API refuses, without persisting', async () => {
    const service = makeService({
      fetchImpl: async () => new Response(null, { status: 401 }),
    });
    const err = await service.connect('sk-ant-bogus').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnthropicAuthError);
    expect((err as AnthropicAuthError).status).toBe(401);
    expect(capturedScripts()).toBe('');
    expect(restart).not.toHaveBeenCalled();
  });

  it('maps network failures to a reachability error', async () => {
    const service = makeService({
      fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
    });
    const err = await service.connect('sk-ant-key').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnthropicAuthError);
    expect((err as AnthropicAuthError).status).toBe(502);
  });

  it('persists a validated key via Hermes helpers and restarts the gateway', async () => {
    const validatedHeaders: Record<string, string>[] = [];
    const service = makeService({
      fetchImpl: async (_url, init) => {
        validatedHeaders.push({ ...(init?.headers as Record<string, string>) });
        return new Response(null, { status: 200 });
      },
    });
    await service.connect('sk-ant-live-key');

    expect(validatedHeaders[0]['x-api-key']).toBe('sk-ant-live-key');
    const script = capturedScripts();
    expect(script).toContain('save_provider_env_credential("ANTHROPIC_API_KEY"');
    expect(script).toContain('_update_config_for_provider("anthropic", "https://api.anthropic.com"');
    // _update_config_for_provider preserves non-slash defaults (e.g. a
    // lingering gpt-5.4), so the script must force model.default itself.
    expect(script).toContain('_m["default"] = "claude-opus-4-8"');
    // The secret must never be inlined into the python source.
    expect(script).not.toContain('sk-ant-live-key');
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('reports gatewayReady=false instead of failing when the restart times out', async () => {
    restart.mockRejectedValueOnce(new Error('Hermes gateway did not become ready'));
    const result = await makeService().connect('sk-ant-live-key');
    // The key is already persisted by this point; a slow gateway boot must
    // not surface as a connect failure.
    expect(result).toEqual({ gatewayReady: false });
    expect(capturedScripts()).toContain('save_provider_env_credential("ANTHROPIC_API_KEY"');
  });

  it('disconnect clears the key and hands the default back to Codex when connected', async () => {
    await makeService({ hasCodex: true }).disconnect();
    const script = capturedScripts();
    expect(script).toContain('save_env_value("ANTHROPIC_API_KEY", "")');
    expect(script).toContain('_update_config_for_provider("openai-codex"');
    expect(script).toContain('_m["default"] = "gpt-5.4"');
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('disconnect leaves the provider config alone when Codex is not connected', async () => {
    await makeService({ hasCodex: false }).disconnect();
    const script = capturedScripts();
    expect(script).toContain('save_env_value("ANTHROPIC_API_KEY", "")');
    expect(script).not.toContain('openai-codex');
  });
});

describe('readAnthropicKeyFromEnvFile', () => {
  let tempHome = '';

  beforeEach(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), 'verso-envread-test-'));
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  function writeEnv(content: string): void {
    writeFileSync(path.join(tempHome, '.env'), content, 'utf8');
  }

  it('returns null when the file is missing', () => {
    expect(readAnthropicKeyFromEnvFile(tempHome)).toBeNull();
  });

  it('reads plain, quoted, and export-prefixed values', () => {
    writeEnv('ANTHROPIC_API_KEY=sk-plain\n');
    expect(readAnthropicKeyFromEnvFile(tempHome)).toBe('sk-plain');
    writeEnv('ANTHROPIC_API_KEY="sk-quoted"\n');
    expect(readAnthropicKeyFromEnvFile(tempHome)).toBe('sk-quoted');
    writeEnv("export ANTHROPIC_API_KEY='sk-exported'\n");
    expect(readAnthropicKeyFromEnvFile(tempHome)).toBe('sk-exported');
  });

  it('treats an empty value as absent (the disconnect idiom)', () => {
    writeEnv('ANTHROPIC_API_KEY=\nOTHER=1\n');
    expect(readAnthropicKeyFromEnvFile(tempHome)).toBeNull();
    writeEnv('ANTHROPIC_API_KEY=""\n');
    expect(readAnthropicKeyFromEnvFile(tempHome)).toBeNull();
  });

  it('ignores unrelated keys and comments', () => {
    writeEnv('# ANTHROPIC_API_KEY=sk-commented\nOPENAI_API_KEY=sk-other\n');
    expect(readAnthropicKeyFromEnvFile(tempHome)).toBeNull();
  });
});
