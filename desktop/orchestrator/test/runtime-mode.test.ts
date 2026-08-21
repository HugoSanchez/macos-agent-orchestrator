import { describe, expect, it } from 'vitest';
import { readRuntimeMode } from '../src/integrations/runtime-mode.ts';

describe('readRuntimeMode', () => {
  it.each(['managed', 'byo', 'local'] as const)('accepts %s', (mode) => {
    expect(readRuntimeMode({ VERSO_RUNTIME_MODE: mode })).toBe(mode);
  });

  it('normalizes an explicit mode', () => {
    expect(readRuntimeMode({ VERSO_RUNTIME_MODE: ' Managed ' })).toBe('managed');
  });

  it.each([undefined, '', 'enterprise'])('fails closed to local for %s', (mode) => {
    expect(readRuntimeMode({ VERSO_RUNTIME_MODE: mode })).toBe('local');
  });
});
