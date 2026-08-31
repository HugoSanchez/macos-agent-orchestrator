import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Hermetic-test guard. Every path the orchestrator resolves at runtime —
// chat-sessions.sqlite, connections.json, ~/.hermes, and the managed Hermes
// home — derives from os.homedir() unless a runtime override is present. Node
// reads os.homedir() from $HOME, so point it at a throwaway directory and
// remove overrides inherited from Xcode/Verso before any application module
// is imported. Individual suites can still set explicit overrides afterward.
//
// This exists because a suite without its own override once fell through to
// the real Application Support tree: it leaked test cron jobs into the live
// gateway, one of which ran real inference, and a managed-boot test replaced
// the user's running gateway (2026-08-04). Suites that need a specific home
// still win — this runs before any test code and they overwrite the env in
// their own beforeEach.
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'verso-test-home-'));
process.env.HOME = sandbox;

for (const key of [
  'API_SERVER_KEY',
  'HERMES_HOME',
  'VERSO_BUNDLED_DEFAULTS',
  'VERSO_BUNDLED_PYTHON_DIR',
  'VERSO_BUNDLED_SITE_PACKAGES_DIR',
  'VERSO_BUNDLE_VERSION',
  'VERSO_HERMES_ARGS',
  'VERSO_HERMES_COMMAND',
  'VERSO_HERMES_CWD',
  'VERSO_HERMES_GATEWAY_URL',
  'VERSO_HERMES_HOME',
  'VERSO_HERMES_MANAGED',
  'VERSO_HERMES_API_SERVER_KEY',
  'VERSO_RUNTIME_MODE',
  'VERSO_BACKEND_URL',
  'VERSO_BROWSER_DATA_ROOT',
  'VERSO_BROWSER_SETTINGS_PATH',
  'VERSO_COMPOSIO_TOOL_USAGE_STORE_PATH',
  'VERSO_CUSTOM_CONNECTOR_ICONS_DIR',
  'VERSO_CUSTOM_CONNECTORS_STORE_PATH',
  'VERSO_INGESTION_STORE_PATH',
  'VERSO_MANAGED_SESSION_TOKEN',
  'VERSO_MANAGED_SESSION_EXPIRES_AT',
  'VERSO_MANAGED_USER_ID',
  'VERSO_MANAGED_DEVICE_ID',
]) {
  delete process.env[key];
}

process.env.VERSO_PYTHON_CACHE_DIR = path.join(sandbox, 'python-bytecode');
mkdirSync(process.env.VERSO_PYTHON_CACHE_DIR, { recursive: true });

if (!os.homedir().startsWith(sandbox)) {
  throw new Error(
    `hermetic test setup failed: os.homedir() is ${os.homedir()}, expected it under ${sandbox}`,
  );
}
