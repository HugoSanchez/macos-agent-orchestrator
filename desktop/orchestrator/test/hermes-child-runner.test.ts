import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const runnerPath = fileURLToPath(new URL('../src/hermes/hermes-child-runner.mjs', import.meta.url));

describe('Hermes child runner shutdown', () => {
  it('coalesces duplicate shutdown signals and waits for Hermes to exit', async () => {
    const childScript = [
      "console.log('child-ready')",
      "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 400))",
      'setInterval(() => {}, 1_000)',
    ].join(';');
    const runner = spawn(process.execPath, [runnerPath], {
      env: {
        ...process.env,
        VERSO_HERMES_CHILD_COMMAND: process.execPath,
        VERSO_HERMES_CHILD_ARGS: JSON.stringify(['-e', childScript]),
        VERSO_HERMES_CHILD_CWD: process.cwd(),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    try {
      await waitForOutput(runner, 'child-ready');
      const shutdownStartedAt = Date.now();
      runner.kill('SIGTERM');
      await delay(50);
      runner.kill('SIGTERM');

      const { code, signal } = await waitForExit(runner);
      expect(signal).toBeNull();
      expect(code).toBe(0);
      expect(Date.now() - shutdownStartedAt).toBeGreaterThanOrEqual(300);
    } finally {
      if (runner.exitCode === null && runner.signalCode === null) {
        runner.kill('SIGKILL');
      }
    }
  }, 10_000);
});

function waitForOutput(child: ChildProcess, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}. Output: ${output}`)), 5_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
      if (!output.includes(expected)) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Runner exited before ready (code=${code}, signal=${signal}). Output: ${output}`));
    });
  });
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
