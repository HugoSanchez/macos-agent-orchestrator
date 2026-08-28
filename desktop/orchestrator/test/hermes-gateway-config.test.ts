import { afterEach, describe, expect, it } from 'vitest';
import { getHermesGatewayConfig } from '../src/hermes/hermes-supervisor.ts';

describe('Hermes gateway config', () => {
  const envSnapshot = {
    API_SERVER_KEY: process.env.API_SERVER_KEY,
    VERSO_HERMES_API_SERVER_KEY: process.env.VERSO_HERMES_API_SERVER_KEY,
    VERSO_HERMES_GATEWAY_URL: process.env.VERSO_HERMES_GATEWAY_URL,
    VERSO_HERMES_MANAGED: process.env.VERSO_HERMES_MANAGED,
    VERSO_HERMES_STARTUP_TIMEOUT_MS: process.env.VERSO_HERMES_STARTUP_TIMEOUT_MS,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('configures the Hermes gateway URL, startup timeout, and managed API key', () => {
    delete process.env.API_SERVER_KEY;
    delete process.env.VERSO_HERMES_API_SERVER_KEY;
    delete process.env.VERSO_HERMES_GATEWAY_URL;
    delete process.env.VERSO_HERMES_MANAGED;
    delete process.env.VERSO_HERMES_STARTUP_TIMEOUT_MS;

    const config = getHermesGatewayConfig();
    expect(config.baseUrl).toBe('http://127.0.0.1:8642');
    expect(config.startupTimeoutMs).toBe(90_000);
    expect(config.apiKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('allows an explicit startup timeout override', () => {
    process.env.VERSO_HERMES_STARTUP_TIMEOUT_MS = '60000';

    expect(getHermesGatewayConfig().startupTimeoutMs).toBe(60_000);
  });

  it('does not invent an API key for manual Hermes mode', () => {
    delete process.env.API_SERVER_KEY;
    delete process.env.VERSO_HERMES_API_SERVER_KEY;
    process.env.VERSO_HERMES_MANAGED = 'false';

    expect(getHermesGatewayConfig().apiKey).toBeNull();
  });

  it('keeps managed gateway credentials process-owned despite a generic ambient override', () => {
    process.env.API_SERVER_KEY = 'explicit-test-key';
    delete process.env.VERSO_HERMES_API_SERVER_KEY;
    delete process.env.VERSO_HERMES_MANAGED;

    expect(getHermesGatewayConfig().apiKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('allows a Verso-specific managed key override for explicit deployments', () => {
    process.env.VERSO_HERMES_API_SERVER_KEY = 'verso-test-key';
    delete process.env.VERSO_HERMES_MANAGED;

    expect(getHermesGatewayConfig().apiKey).toBe('verso-test-key');
  });

  it('uses the Verso-specific explicit key for a manually managed gateway', () => {
    process.env.API_SERVER_KEY = 'generic-test-key';
    process.env.VERSO_HERMES_API_SERVER_KEY = 'verso-test-key';
    process.env.VERSO_HERMES_MANAGED = 'false';

    expect(getHermesGatewayConfig().apiKey).toBe('verso-test-key');
  });
});
