import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HermesSupervisor } from '../src/hermes/hermes-supervisor.ts';

// Regression coverage for the connector add/remove restart failures:
//  - concurrent restart() calls used to run two full shutdown+start cycles,
//    with the second shutdown() SIGTERMing the healthy gateway the first
//    restart had just started ("did not become ready" while a good gateway
//    was running);
//  - shutdown used ChildProcess.killed as proof of exit, even though it only
//    means a signal was sent. Restart now waits for the process to exit before
//    reusing the stable gateway port required by OAuth redirect registrations.
describe('HermesSupervisor restart', () => {
  let supervisor: HermesSupervisor | null = null;
  let tempHome = '';
  let envSnapshot: Record<string, string | undefined> = {};

  beforeAll(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), 'verso-supervisor-restart-'));
    envSnapshot = {
      VERSO_HERMES_GATEWAY_URL: process.env.VERSO_HERMES_GATEWAY_URL,
      VERSO_HERMES_COMMAND: process.env.VERSO_HERMES_COMMAND,
      VERSO_HERMES_ARGS: process.env.VERSO_HERMES_ARGS,
      VERSO_HERMES_CWD: process.env.VERSO_HERMES_CWD,
      VERSO_HERMES_MANAGED: process.env.VERSO_HERMES_MANAGED,
      VERSO_HERMES_HOME: process.env.VERSO_HERMES_HOME,
      API_SERVER_KEY: process.env.API_SERVER_KEY,
      VERSO_HERMES_API_SERVER_KEY: process.env.VERSO_HERMES_API_SERVER_KEY,
      FAKE_HERMES_PORT_CONFLICT_ONCE_FILE: process.env.FAKE_HERMES_PORT_CONFLICT_ONCE_FILE,
    };
    // No VERSO_HERMES_GATEWAY_URL: exercise the dynamic-port managed path the
    // desktop app uses, where every spawn must land on a fresh port.
    delete process.env.VERSO_HERMES_GATEWAY_URL;
    delete process.env.API_SERVER_KEY;
    delete process.env.VERSO_HERMES_API_SERVER_KEY;
    process.env.VERSO_HERMES_COMMAND = process.execPath;
    process.env.VERSO_HERMES_ARGS = JSON.stringify([
      path.resolve(process.cwd(), 'test/fixtures/fake-hermes-gateway.mjs'),
    ]);
    process.env.VERSO_HERMES_CWD = process.cwd();
    process.env.VERSO_HERMES_MANAGED = 'true';
    process.env.VERSO_HERMES_HOME = tempHome;
    supervisor = new HermesSupervisor();
  });

  afterAll(async () => {
    await supervisor?.shutdown();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('coalesces concurrent restarts and reuses the stable gateway port', async () => {
    const first = await supervisor!.ensureReady();
    const portBefore = new URL(first.baseUrl).port;
    expect(portBefore).not.toBe('8642');

    // Slow the next boots down so the second restart() reliably arrives while
    // the first is mid-health-wait — the window where, pre-fix, its shutdown
    // SIGTERMed the child the first restart had just spawned.
    process.env.FAKE_HERMES_BOOT_DELAY_MS = '1000';
    try {
      const firstRestart = supervisor!.restart();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const secondRestart = supervisor!.restart();
      const results = await Promise.allSettled([firstRestart, secondRestart]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    } finally {
      delete process.env.FAKE_HERMES_BOOT_DELAY_MS;
    }

    const status = await supervisor!.getStatus();
    expect(status.reachable).toBe(true);
    const portAfter = new URL(status.baseUrl).port;
    expect(portAfter).toBe(portBefore);

    // Sequential restarts keep the same callback origin too.
    await supervisor!.restart();
    const statusAfter = await supervisor!.getStatus();
    expect(statusAfter.reachable).toBe(true);
    expect(new URL(statusAfter.baseUrl).port).toBe(portAfter);
  }, 30_000);

  it('surfaces stderr startup failures even when the stdout banner is newer', () => {
    const internals = supervisor as unknown as {
      logTail: string[];
      formatExitMessage: (code: number | null, signal: NodeJS.Signals | null) => string;
    };
    internals.logTail = [
      '[hermes stderr] ERROR Could not bind 127.0.0.1:8642: address already in use',
      '[hermes stdout] banner line 1',
      '[hermes stdout] banner line 2',
      '[hermes stdout] banner line 3',
      '[hermes stdout] banner line 4',
      '[hermes stdout] banner line 5',
      '[hermes stdout] banner line 6',
    ];

    const message = internals.formatExitMessage(0, null);
    expect(message).toContain('stopped unexpectedly');
    expect(message).toContain('Could not bind 127.0.0.1:8642');
  });

  it('recovers a managed restart from a startup port conflict', async () => {
    const before = await supervisor!.getStatus();
    const marker = path.join(tempHome, 'fail-port-once');
    process.env.FAKE_HERMES_PORT_CONFLICT_ONCE_FILE = marker;
    try {
      await supervisor!.restart();
    } finally {
      delete process.env.FAKE_HERMES_PORT_CONFLICT_ONCE_FILE;
    }

    const after = await supervisor!.getStatus();
    expect(after.reachable).toBe(true);
    expect(new URL(after.baseUrl).port).not.toBe(new URL(before.baseUrl).port);
  }, 30_000);
});
