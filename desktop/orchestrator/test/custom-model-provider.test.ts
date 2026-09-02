import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HermesSupervisor } from '../src/hermes/hermes-supervisor.ts';
import { KeychainSecretStore, type KeychainExec } from '../src/connections/keychain.ts';
import {
  CustomModelProviderError,
  CustomModelProviderService,
  normalizeCustomModelBaseUrl,
} from '../src/models/custom-model-provider.ts';
import { CustomModelProviderStore } from '../src/models/custom-model-provider-store.ts';

describe('custom model provider', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('discovers OpenAI-compatible model IDs with or without an API key', async () => {
    const fixture = makeFixture();
    const requests: RequestInit[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {
      requests.push(init ?? {});
      return new Response(JSON.stringify({
        data: [{ id: 'Qwen/Qwen3.5-4B' }, { id: 'Qwen/Qwen3.5-4B' }, { nope: true }],
      }), { status: 200 });
    });
    const service = fixture.service(fetchImpl);

    await expect(service.discover('https://modal.example/v1/', '')).resolves.toEqual({
      models: ['Qwen/Qwen3.5-4B'],
    });
    await expect(service.discover('https://modal.example/v1', 'secret')).resolves.toEqual({
      models: ['Qwen/Qwen3.5-4B'],
    });
    expect(requests[0].headers).toBeUndefined();
    expect(requests[1].headers).toEqual({ Authorization: 'Bearer secret' });
  });

  it('accepts a pasted Modal URL and full Bearer header', async () => {
    const fixture = makeFixture();
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ data: [{ id: 'Qwen/Qwen3.5-4B' }] }), { status: 200 });
    });
    const service = fixture.service(fetchImpl);

    await service.discover(
      'https://workspace--endpoint.us-west.modal.direct',
      'Authorization: Bearer wk-example.ws-example',
    );

    expect(requests).toEqual([{
      url: 'https://workspace--endpoint.us-west.modal.direct/v1/models',
      init: expect.objectContaining({
        headers: { Authorization: 'Bearer wk-example.ws-example' },
      }),
    }]);
  });

  it('falls back to manual model entry when discovery is unavailable', async () => {
    const fixture = makeFixture();
    const service = fixture.service(vi.fn(async () => new Response('', { status: 404 })));
    await expect(service.discover('https://modal.example/v1', '')).resolves.toEqual({ models: [] });
  });

  it('reports unreachable endpoints instead of saving a dead configuration', async () => {
    const fixture = makeFixture();
    const networkFailure = fixture.service(vi.fn(async () => { throw new Error('offline'); }));
    await expect(networkFailure.discover('https://modal.example/v1', ''))
      .rejects.toMatchObject({ status: 502, message: 'Could not reach the endpoint.' });

    const serverFailure = fixture.service(vi.fn(async () => new Response('', { status: 500 })));
    await expect(serverFailure.discover('https://modal.example/v1', ''))
      .rejects.toMatchObject({ status: 502, message: 'Model discovery failed (HTTP 500).' });
  });

  it('distinguishes missing authentication from a rejected credential', async () => {
    const fixture = makeFixture();
    const service = fixture.service(vi.fn(async () => new Response('', { status: 401 })));

    await expect(service.discover('https://modal.example/v1', ''))
      .rejects.toMatchObject({ message: 'This endpoint requires an API key or proxy token.' });
    await expect(service.discover('https://modal.example/v1', 'bad-token'))
      .rejects.toMatchObject({ message: 'The endpoint rejected this API key or proxy token.' });
  });

  it('stores an unauthenticated endpoint and removes it cleanly', async () => {
    const fixture = makeFixture();
    const service = fixture.service();

    await expect(service.connect(
      'https://workspace--public.us-west.modal.direct/',
      '',
      'Qwen/Qwen3.5-4B',
    )).resolves.toEqual({
      connected: true,
      baseUrl: 'https://workspace--public.us-west.modal.direct/v1',
      model: 'Qwen/Qwen3.5-4B',
    });
    expect(fixture.store.get()).toMatchObject({
      baseUrl: 'https://workspace--public.us-west.modal.direct/v1',
      model: 'Qwen/Qwen3.5-4B',
      usesApiKey: false,
    });
    await expect(service.getStatus()).resolves.toMatchObject({ connected: true });
    expect(fixture.restart).toHaveBeenCalledTimes(1);

    await service.disconnect();
    expect(fixture.store.get()).toBeNull();
    expect(JSON.parse(readFileSync(fixture.storePath, 'utf8'))).toBeNull();
    expect(fixture.restart).toHaveBeenCalledTimes(2);
  });

  it('stores authenticated keys only in Keychain and rejects built-in model collisions', async () => {
    const fixture = makeFixture();
    const service = fixture.service();

    await service.connect('https://modal.example/v1', 'secret-token', 'modal-model');
    expect(fixture.store.get()).toMatchObject({ usesApiKey: true });
    expect(readFileSync(fixture.storePath, 'utf8')).not.toContain('secret-token');
    expect(fixture.keychainValues.size).toBe(1);
    await expect(service.getStatus()).resolves.toMatchObject({ connected: true });

    fixture.keychainValues.clear();
    await expect(service.getStatus()).resolves.toMatchObject({ connected: false });

    await expect(service.connect('https://modal.example/v1', 'secret-token', 'gpt-5.5'))
      .rejects.toMatchObject({ status: 400 });
  });

  it('normalizes safe base URLs and rejects embedded credentials or query strings', () => {
    expect(normalizeCustomModelBaseUrl('https://example.com/v1/')).toBe('https://example.com/v1');
    expect(normalizeCustomModelBaseUrl('https://workspace--endpoint.us-west.modal.direct'))
      .toBe('https://workspace--endpoint.us-west.modal.direct/v1');
    expect(normalizeCustomModelBaseUrl('https://workspace--endpoint.us-west.modal.direct/v1'))
      .toBe('https://workspace--endpoint.us-west.modal.direct/v1');
    expect(() => normalizeCustomModelBaseUrl('file:///tmp/model')).toThrow(CustomModelProviderError);
    expect(() => normalizeCustomModelBaseUrl('https://user:pass@example.com/v1')).toThrow(/cannot contain/);
    expect(() => normalizeCustomModelBaseUrl('https://example.com/v1?token=x')).toThrow(/cannot contain/);
  });

  function makeFixture() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'verso-custom-model-'));
    tempRoots.push(root);
    const storePath = path.join(root, 'custom-model.json');
    const store = new CustomModelProviderStore(storePath);
    const keychainValues = new Map<string, string>();
    const exec: KeychainExec = (_file, args, callback) => {
      const account = args[args.indexOf('-a') + 1];
      if (args[0] === 'add-generic-password') {
        keychainValues.set(account, args[args.indexOf('-w') + 1]);
        callback(null, '', '');
      } else if (args[0] === 'find-generic-password') {
        const value = keychainValues.get(account);
        if (value === undefined) callback(new Error('not found'), '', '');
        else callback(null, `${value}\n`, '');
      } else {
        keychainValues.delete(account);
        callback(null, '', '');
      }
    };
    const keychain = new KeychainSecretStore('com.verso.test-custom-model', exec);
    const restart = vi.fn(async () => undefined);
    const hermes = { restart } as unknown as HermesSupervisor;
    return {
      store,
      storePath,
      keychainValues,
      restart,
      service: (fetchImpl: typeof fetch = vi.fn()) => new CustomModelProviderService(
        store,
        hermes,
        keychain,
        fetchImpl,
      ),
    };
  }
});
