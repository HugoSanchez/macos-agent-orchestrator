import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonFileOr, writeJsonFileAtomic } from '../shared/atomic-json-file.ts';
import { readRuntimeMode, type RuntimeMode } from '../integrations/runtime-mode.ts';

export type LocalStateMode =
  | 'disabled'
  | 'signed_out'
  | 'runtime_scoped'
  | 'legacy_owned'
  | 'account_scoped';

export interface LocalStateSnapshot {
  enabled: boolean;
  mode: LocalStateMode;
  accountHash: string | null;
  legacyOwnerHash: string | null;
  legacyDataDetected: boolean;
  paths: {
    root: string;
    chatStore: string | null;
    connectionsStore: string | null;
    composioToolsRefreshMarker: string | null;
    hermesHome: string | null;
    memoryDatabase: string | null;
    customConnectorsStore: string | null;
    customConnectorIcons: string | null;
    composioToolUsageStore: string | null;
    ingestionStore: string | null;
    browserSettings: string | null;
    browserDataRoot: string | null;
    workspacesRoot: string | null;
    legacyOwnerMarker: string;
  };
}

interface LocalStateOwnerMarker {
  version: 1;
  ownerHash: string;
  claimedAt: string;
}

interface ResolveOptions {
  homeDir?: string;
  now?: Date;
  runtimeMode?: RuntimeMode;
}

interface ResolvedLocalState extends LocalStateSnapshot {
  envUpdates: Record<string, string>;
  shouldCreateAccountHermesHome: boolean;
  shouldClaimLegacyOwner: boolean;
}

const OWNER_MARKER_FILE = 'local-state-owner.json';

export function applyLocalStateIsolation(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveOptions = {},
): LocalStateSnapshot {
  const resolved = resolveLocalState(env, options);

  if (resolved.shouldClaimLegacyOwner && resolved.accountHash) {
    mkdirSync(path.dirname(resolved.paths.legacyOwnerMarker), { recursive: true });
    writeOwnerMarker(resolved.paths.legacyOwnerMarker, {
      version: 1,
      ownerHash: resolved.accountHash,
      claimedAt: (options.now ?? new Date()).toISOString(),
    });
  }

  for (const [key, value] of Object.entries(resolved.envUpdates)) {
    env[key] = value;
  }

  if (resolved.paths.chatStore) {
    mkdirSync(path.dirname(resolved.paths.chatStore), { recursive: true });
  }
  if (resolved.paths.connectionsStore) {
    mkdirSync(path.dirname(resolved.paths.connectionsStore), { recursive: true });
  }
  if (resolved.paths.composioToolsRefreshMarker) {
    mkdirSync(path.dirname(resolved.paths.composioToolsRefreshMarker), { recursive: true });
  }
  if (resolved.paths.hermesHome) {
    mkdirSync(resolved.paths.hermesHome, { recursive: true });
    if (resolved.shouldCreateAccountHermesHome) {
      mkdirSync(path.join(resolved.paths.hermesHome, 'home'), { recursive: true });
    }
  }
  if (resolved.paths.memoryDatabase) {
    mkdirSync(path.dirname(resolved.paths.memoryDatabase), { recursive: true });
  }
  if (resolved.paths.workspacesRoot) {
    mkdirSync(resolved.paths.workspacesRoot, { recursive: true });
  }

  return stripInternal(resolved);
}

export function resolveLocalState(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveOptions = {},
): ResolvedLocalState {
  const homeDir = options.homeDir ?? os.homedir();
  const roots = buildLocalStateRoots(env, homeDir);
  const userId = env.VERSO_MANAGED_USER_ID?.trim() || '';
  const runtimeMode = options.runtimeMode ?? readRuntimeMode(env);
  const accountHash = userId ? hashUserId(userId) : null;
  const enabled = isLocalStateIsolationEnabled(env);
  const owner = readOwnerMarker(roots.ownerMarkerPath);
  const legacyDataDetected = legacyDataExists(roots);

  const baseSnapshot = {
    enabled,
    accountHash,
    legacyOwnerHash: owner?.ownerHash ?? null,
    legacyDataDetected,
    paths: {
      root: roots.appSupportRoot,
      chatStore: null,
      connectionsStore: null,
      composioToolsRefreshMarker: null,
      hermesHome: null,
      memoryDatabase: null,
      customConnectorsStore: null,
      customConnectorIcons: null,
      composioToolUsageStore: null,
      ingestionStore: null,
      browserSettings: null,
      browserDataRoot: null,
      workspacesRoot: null,
      legacyOwnerMarker: roots.ownerMarkerPath,
    },
  };

  if (!enabled) {
    return {
      ...baseSnapshot,
      mode: 'disabled',
      envUpdates: {},
      shouldCreateAccountHermesHome: false,
      shouldClaimLegacyOwner: false,
    };
  }

  if (runtimeMode !== 'managed') {
    const runtimeRoot = path.join(roots.appSupportRoot, 'runtime', runtimeMode);
    const paths = {
      root: roots.appSupportRoot,
      chatStore: env.VERSO_CHAT_STORE_PATH?.trim()
        || path.join(runtimeRoot, 'chat-sessions.sqlite'),
      connectionsStore: env.VERSO_CONNECTIONS_STORE_PATH?.trim()
        || path.join(runtimeRoot, 'connections.json'),
      composioToolsRefreshMarker: env.VERSO_COMPOSIO_TOOLS_REFRESH_MARKER_PATH?.trim()
        || path.join(runtimeRoot, 'composio-tools-refresh.marker'),
      hermesHome: env.VERSO_HERMES_HOME?.trim()
        || path.join(runtimeRoot, 'hermes-home'),
      memoryDatabase: env.VERSO_MEMORY_DB_PATH?.trim()
        || path.join(runtimeRoot, 'memory', 'verso-memory.db'),
      customConnectorsStore: env.VERSO_CUSTOM_CONNECTORS_STORE_PATH?.trim()
        || path.join(runtimeRoot, 'custom-connectors.json'),
      customConnectorIcons: env.VERSO_CUSTOM_CONNECTOR_ICONS_DIR?.trim()
        || path.join(runtimeRoot, 'custom-connector-icons'),
      composioToolUsageStore: env.VERSO_COMPOSIO_TOOL_USAGE_STORE_PATH?.trim()
        || path.join(runtimeRoot, 'composio-tool-usage.sqlite'),
      ingestionStore: env.VERSO_INGESTION_STORE_PATH?.trim()
        || path.join(runtimeRoot, 'ingestion.sqlite'),
      browserSettings: env.VERSO_BROWSER_SETTINGS_PATH?.trim()
        || path.join(runtimeRoot, 'browser-settings.json'),
      browserDataRoot: env.VERSO_BROWSER_DATA_ROOT?.trim()
        || path.join(runtimeRoot, 'browser'),
      workspacesRoot: env.VERSO_WORKSPACES_ROOT?.trim()
        || path.join(runtimeRoot, 'workspaces'),
      legacyOwnerMarker: roots.ownerMarkerPath,
    };
    return {
      enabled,
      mode: 'runtime_scoped',
      accountHash: null,
      legacyOwnerHash: owner?.ownerHash ?? null,
      legacyDataDetected,
      paths,
      envUpdates: envUpdatesFor(paths),
      shouldCreateAccountHermesHome: true,
      shouldClaimLegacyOwner: false,
    };
  }

  if (!accountHash) {
    return {
      ...baseSnapshot,
      mode: 'signed_out',
      envUpdates: {},
      shouldCreateAccountHermesHome: false,
      shouldClaimLegacyOwner: false,
    };
  }

  const shouldUseLegacy = owner
    ? owner.ownerHash === accountHash
    : legacyDataDetected;

  if (shouldUseLegacy) {
    const paths = {
      root: roots.appSupportRoot,
      chatStore: roots.legacyChatStorePath,
      connectionsStore: roots.legacyConnectionsStorePath,
      composioToolsRefreshMarker: roots.legacyComposioMarkerPath,
      hermesHome: roots.legacyHermesHome,
      memoryDatabase: null,
      customConnectorsStore: null,
      customConnectorIcons: null,
      composioToolUsageStore: null,
      ingestionStore: null,
      browserSettings: null,
      browserDataRoot: null,
      workspacesRoot: env.VERSO_WORKSPACES_ROOT?.trim()
        || path.join(path.dirname(roots.legacyChatStorePath), 'workspaces'),
      legacyOwnerMarker: roots.ownerMarkerPath,
    };
    return {
      enabled,
      mode: 'legacy_owned',
      accountHash,
      legacyOwnerHash: owner?.ownerHash ?? accountHash,
      legacyDataDetected,
      paths,
      envUpdates: envUpdatesFor(paths),
      shouldCreateAccountHermesHome: false,
      shouldClaimLegacyOwner: !owner,
    };
  }

  const accountRoot = path.join(roots.appSupportRoot, 'accounts', accountHash);
  const paths = {
    root: roots.appSupportRoot,
    chatStore: path.join(accountRoot, 'chat-sessions.sqlite'),
    connectionsStore: path.join(accountRoot, 'connections.json'),
    composioToolsRefreshMarker: path.join(accountRoot, 'composio-tools-refresh.marker'),
    hermesHome: path.join(accountRoot, 'hermes-home'),
    memoryDatabase: null,
    customConnectorsStore: null,
    customConnectorIcons: null,
    composioToolUsageStore: null,
    ingestionStore: null,
    browserSettings: null,
    browserDataRoot: null,
    workspacesRoot: env.VERSO_WORKSPACES_ROOT?.trim()
      || path.join(accountRoot, 'workspaces'),
    legacyOwnerMarker: roots.ownerMarkerPath,
  };

  return {
    enabled,
    mode: 'account_scoped',
    accountHash,
    legacyOwnerHash: owner?.ownerHash ?? null,
    legacyDataDetected,
    paths,
    envUpdates: envUpdatesFor(paths),
    shouldCreateAccountHermesHome: true,
    shouldClaimLegacyOwner: false,
  };
}

function buildLocalStateRoots(env: NodeJS.ProcessEnv, homeDir: string): {
  appSupportRoot: string;
  ownerMarkerPath: string;
  legacyChatStorePath: string;
  legacyConnectionsStorePath: string;
  legacyComposioMarkerPath: string;
  legacyHermesHome: string;
} {
  const appSupportRoot = env.VERSO_LOCAL_STATE_ROOT?.trim()
    || path.join(homeDir, 'Library', 'Application Support', 'Verso');
  const legacySupportRoot = path.join(homeDir, 'Library', 'Application Support', 'verso');
  const appSupportHermesHome = path.join(legacySupportRoot, 'hermes-home');
  const existingAppSupportHermesHome = existsSync(appSupportHermesHome) ? appSupportHermesHome : null;

  return {
    appSupportRoot,
    ownerMarkerPath: path.join(appSupportRoot, OWNER_MARKER_FILE),
    legacyChatStorePath: env.VERSO_LEGACY_CHAT_STORE_PATH?.trim()
      || path.join(legacySupportRoot, 'chat-sessions.sqlite'),
    legacyConnectionsStorePath: env.VERSO_LEGACY_CONNECTIONS_STORE_PATH?.trim()
      || path.join(legacySupportRoot, 'connections.json'),
    legacyComposioMarkerPath: env.VERSO_LEGACY_COMPOSIO_TOOLS_REFRESH_MARKER_PATH?.trim()
      || path.join(legacySupportRoot, 'composio-tools-refresh.marker'),
    legacyHermesHome: env.VERSO_LEGACY_HERMES_HOME?.trim()
      || env.VERSO_HERMES_HOME?.trim()
      || existingAppSupportHermesHome
      || defaultManagedHermesHome(env, homeDir),
  };
}

function defaultManagedHermesHome(env: NodeJS.ProcessEnv, homeDir: string): string {
  const templateHome = env.VERSO_BUNDLED_DEFAULTS?.trim()
    || env.HERMES_HOME?.trim()
    || path.join(homeDir, '.hermes');
  return path.join(resolveHermesRoot(templateHome), 'profiles', 'verso');
}

function resolveHermesRoot(home: string): string {
  const profilesMarker = `${path.sep}profiles${path.sep}`;
  const index = home.lastIndexOf(profilesMarker);
  if (index >= 0) return home.slice(0, index);
  return home;
}

function envUpdatesFor(paths: {
  chatStore: string | null;
  connectionsStore: string | null;
  composioToolsRefreshMarker: string | null;
  hermesHome: string | null;
  memoryDatabase: string | null;
  customConnectorsStore: string | null;
  customConnectorIcons: string | null;
  composioToolUsageStore: string | null;
  ingestionStore: string | null;
  browserSettings: string | null;
  browserDataRoot: string | null;
  workspacesRoot: string | null;
}): Record<string, string> {
  const updates: Record<string, string> = {};
  if (paths.chatStore) updates.VERSO_CHAT_STORE_PATH = paths.chatStore;
  if (paths.connectionsStore) updates.VERSO_CONNECTIONS_STORE_PATH = paths.connectionsStore;
  if (paths.composioToolsRefreshMarker) {
    updates.VERSO_COMPOSIO_TOOLS_REFRESH_MARKER_PATH = paths.composioToolsRefreshMarker;
  }
  if (paths.hermesHome) updates.VERSO_HERMES_HOME = paths.hermesHome;
  if (paths.memoryDatabase) updates.VERSO_MEMORY_DB_PATH = paths.memoryDatabase;
  if (paths.customConnectorsStore) updates.VERSO_CUSTOM_CONNECTORS_STORE_PATH = paths.customConnectorsStore;
  if (paths.customConnectorIcons) updates.VERSO_CUSTOM_CONNECTOR_ICONS_DIR = paths.customConnectorIcons;
  if (paths.composioToolUsageStore) {
    updates.VERSO_COMPOSIO_TOOL_USAGE_STORE_PATH = paths.composioToolUsageStore;
  }
  if (paths.ingestionStore) updates.VERSO_INGESTION_STORE_PATH = paths.ingestionStore;
  if (paths.browserSettings) updates.VERSO_BROWSER_SETTINGS_PATH = paths.browserSettings;
  if (paths.browserDataRoot) updates.VERSO_BROWSER_DATA_ROOT = paths.browserDataRoot;
  if (paths.workspacesRoot) updates.VERSO_WORKSPACES_ROOT = paths.workspacesRoot;
  return updates;
}

function isLocalStateIsolationEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.VERSO_LOCAL_STATE_ISOLATION?.trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'no';
}

function hashUserId(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 32);
}

function legacyDataExists(roots: ReturnType<typeof buildLocalStateRoots>): boolean {
  return existsSync(roots.legacyChatStorePath)
    || existsSync(roots.legacyConnectionsStorePath)
    || existsSync(roots.legacyHermesHome);
}

function readOwnerMarker(markerPath: string): LocalStateOwnerMarker | null {
  return readJsonFileOr(
    markerPath,
    (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const parsed = value as Partial<LocalStateOwnerMarker>;
      if (parsed.version !== 1) return null;
      if (typeof parsed.ownerHash !== 'string' || !/^[a-f0-9]{32}$/.test(parsed.ownerHash)) return null;
      if (typeof parsed.claimedAt !== 'string' || !parsed.claimedAt) return null;
      return {
        version: 1,
        ownerHash: parsed.ownerHash,
        claimedAt: parsed.claimedAt,
      };
    },
    () => null,
  );
}

function writeOwnerMarker(markerPath: string, marker: LocalStateOwnerMarker): void {
  writeJsonFileAtomic(markerPath, marker);
}

function stripInternal(resolved: ResolvedLocalState): LocalStateSnapshot {
  const {
    envUpdates: _envUpdates,
    shouldCreateAccountHermesHome: _shouldCreateAccountHermesHome,
    shouldClaimLegacyOwner: _shouldClaimLegacyOwner,
    ...snapshot
  } = resolved;
  return snapshot;
}
