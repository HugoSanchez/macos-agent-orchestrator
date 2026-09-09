import { afterEach, expect, it, vi } from 'vitest';
import type { HermesSupervisor } from '../src/hermes/hermes-supervisor.ts';

const { exec } = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: exec }),
}));
vi.mock('../src/hermes/hermes-managed-profile.ts', () => ({ resolveHermesPython: () => '/mock/python' }));
import { CodexAuthService } from '../src/models/model-auth.ts';

const hermes = {
  hermesHome: '/verso/profile', launchCwd: null,
  invoke: (args: string[]) => ({ command: '/mock/hermes', args, env: { PYTHONPATH: '/bundled/packages' } }),
} as unknown as HermesSupervisor;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); exec.mockReset(); });

it('returns connected status before discovery finishes, then exposes only availability', async () => {
  let finish!: (value: { stdout: string }) => void;
  exec.mockImplementation((_command, args) => args[0] === 'auth'
    ? Promise.resolve({ stdout: '(1 credential)' })
    : new Promise((resolve) => { finish = resolve; }));
  const service = new CodexAuthService(hermes);
  expect(await service.getStatus()).toEqual({ connected: true, count: 1, astraAvailable: null });
  expect(exec.mock.calls[1][2].env.HERMES_HOME).toBe('/verso/profile');
  finish({ stdout: '{"astraAvailable":true}' });
  await vi.waitFor(async () => expect((await service.getStatus()).astraAvailable).toBe(true));
});

it('keeps authentication working after discovery fails and retries on the existing refresh', async () => {
  vi.useFakeTimers();
  exec.mockImplementation((_command, args) => args[0] === 'auth'
    ? Promise.resolve({ stdout: '(1 credential)' })
    : Promise.reject(new Error('lookup timed out')));
  const service = new CodexAuthService(hermes);
  expect((await service.getStatus()).connected).toBe(true);
  await vi.advanceTimersByTimeAsync(16_000);
  expect((await service.getStatus()).astraAvailable).toBeNull();
  await vi.advanceTimersByTimeAsync(0);
  expect(exec.mock.calls.filter(([command]) => command === '/mock/python')).toHaveLength(2);
});

it('cancels discovery before disconnecting and ignores its late result', async () => {
  let count = 1;
  exec.mockImplementation((_command, args, options) => {
    if (args[0] !== 'auth') return new Promise((resolve) => {
      options.signal.addEventListener('abort', () => resolve({ stdout: '{"astraAvailable":true}' }));
    });
    if (args[1] === 'remove') count = 0;
    return Promise.resolve({ stdout: `(${count} credentials)` });
  });
  const service = new CodexAuthService(hermes);
  await service.getStatus();
  expect(await service.disconnect()).toEqual({ removed: 1 });
  expect(await service.getStatus()).toEqual({ connected: false, count: 0, astraAvailable: false });
  expect(exec.mock.calls.filter(([command]) => command === '/mock/python')).toHaveLength(1);
});

it('keeps confirmed availability during refresh and transient lookup failures', async () => {
  vi.useFakeTimers();
  let fail = false;
  exec.mockImplementation((_command, args) => args[0] === 'auth'
    ? Promise.resolve({ stdout: '(1 credential)' })
    : fail ? Promise.reject(new Error('offline')) : Promise.resolve({ stdout: '{"astraAvailable":true}' }));
  const service = new CodexAuthService(hermes);
  await service.getStatus();
  await vi.advanceTimersByTimeAsync(0);
  expect((await service.getStatus()).astraAvailable).toBe(true);
  fail = true;
  await vi.advanceTimersByTimeAsync(16_000);
  expect((await service.getStatus()).astraAvailable).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect((await service.getStatus()).astraAvailable).toBe(true);
});
