import { describe, expect, it } from 'vitest';
import { buildHermesInheritedEnvironment } from '../src/hermes/hermes-supervisor.ts';

describe('Hermes managed process environment', () => {
  it('does not inherit orchestrator-only Verso credentials', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      VERSO_RUNTIME_MODE: 'managed',
      VERSO_MANAGED_SESSION_TOKEN: 'managed-session-secret',
      VERSO_MANAGED_SESSION_EXPIRES_AT: '2099-01-01T00:00:00Z',
      VERSO_MANAGED_USER_ID: 'user-123',
      VERSO_MANAGED_DEVICE_ID: 'device-123',
      VERSO_SIDECAR_AUTH_SECRET: 'native-sidecar-secret',
      VERSO_DRAFT_APPROVAL_TOKEN_SHA256: 'native-approval-verifier',
      VERSO_HERMES_API_SERVER_KEY: 'supervisor-only-key',
      VERSO_CUSTOM_MODEL_API_KEY: 'stale-custom-model-key',
      VERSO_CC_example_TOKEN: 'custom-mcp-secret',
      API_SERVER_KEY: 'hermes-gateway-key',
    };

    const inherited = buildHermesInheritedEnvironment(source);

    expect(inherited).not.toHaveProperty('VERSO_MANAGED_SESSION_TOKEN');
    expect(inherited).not.toHaveProperty('VERSO_MANAGED_SESSION_EXPIRES_AT');
    expect(inherited).not.toHaveProperty('VERSO_MANAGED_USER_ID');
    expect(inherited).not.toHaveProperty('VERSO_MANAGED_DEVICE_ID');
    expect(inherited).not.toHaveProperty('VERSO_SIDECAR_AUTH_SECRET');
    expect(inherited).not.toHaveProperty('VERSO_DRAFT_APPROVAL_TOKEN_SHA256');
    expect(inherited).not.toHaveProperty('VERSO_HERMES_API_SERVER_KEY');
    expect(inherited).not.toHaveProperty('VERSO_CUSTOM_MODEL_API_KEY');
    expect(inherited).toMatchObject({
      PATH: '/usr/bin:/bin',
      VERSO_RUNTIME_MODE: 'managed',
      // Hermes resolves custom remote-MCP headers from this parent variable;
      // its terminal subprocess filter is responsible for stripping it.
      VERSO_CC_example_TOKEN: 'custom-mcp-secret',
      API_SERVER_KEY: 'hermes-gateway-key',
    });

    // The helper must not mutate the orchestrator's own live environment.
    expect(source.VERSO_MANAGED_SESSION_TOKEN).toBe('managed-session-secret');
    expect(source.VERSO_SIDECAR_AUTH_SECRET).toBe('native-sidecar-secret');
  });
});
