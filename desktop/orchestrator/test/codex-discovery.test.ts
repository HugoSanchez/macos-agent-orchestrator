import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('checks live model discovery with mocked accounts and upstream responses', () => {
  expect(() => execFileSync('python3', [
    fileURLToPath(new URL('./codex_models_test.py', import.meta.url)),
  ], { stdio: 'pipe', timeout: 10_000 })).not.toThrow();
});
