import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HermesSupervisor } from '../src/http/hermes-supervisor.ts';

describe('Hermes bundled subcommand invocation', () => {
  const envNames = [
    'VERSO_BUNDLED_PYTHON_DIR',
    'VERSO_BUNDLED_SITE_PACKAGES_DIR',
    'VERSO_BUNDLED_DEFAULTS',
    'VERSO_HERMES_HOME',
    'VERSO_BUNDLE_VERSION',
  ] as const;
  const snapshot = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  const tempPaths: string[] = [];

  afterEach(() => {
    for (const name of envNames) {
      const value = snapshot[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const tempPath of tempPaths.splice(0)) {
      rmSync(tempPath, { recursive: true, force: true });
    }
  });

  it('does not pass bare Hermes arguments to Python when the bundle is incomplete', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'verso-incomplete-bundle-'));
    tempPaths.push(root);
    process.env.VERSO_BUNDLED_PYTHON_DIR = path.join(root, 'python');
    process.env.VERSO_BUNDLED_SITE_PACKAGES_DIR = path.join(root, 'site-packages');
    process.env.VERSO_BUNDLED_DEFAULTS = path.join(root, 'defaults');
    process.env.VERSO_HERMES_HOME = path.join(root, 'home');
    process.env.VERSO_BUNDLE_VERSION = 'test-bundle';

    const supervisor = new HermesSupervisor({
      launch: {
        command: path.join(root, 'python', 'arm64', 'python', 'bin', 'python3.11'),
        args: [],
        cwd: root,
        startupTimeoutMs: 1_000,
      },
    });

    expect(supervisor.invoke(['auth', 'list', 'openai-codex'])).toBeNull();
  });
});
