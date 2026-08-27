import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { BrowserHost } from './browser-host.ts';
import { BrowserSettingsStore } from './browser-settings-store.ts';
import { buildBrowserRoutes } from './browser.ts';
import { buildChatDiagnostics, buildChatRoutes } from './chat.ts';
import { ChatRequestRegistry } from './chat-request-registry.ts';
import { ChatStore } from './chat-store.ts';
import { buildComposioBridgeRoutes } from './composio-bridge.ts';
import { buildDraftsRoutes } from './drafts.ts';
import { ComposioToolUsageStore } from './composio-tool-usage-store.ts';
import { buildConnectionsRoutes } from './connections.ts';
import { ConnectionsStore } from './connections-store.ts';
import { CustomConnectorsStore } from './custom-connectors-store.ts';
import { CustomConnectorKeychain } from './keychain.ts';
import { buildCustomConnectorRoutes } from './custom-connectors.ts';
import { HermesSupervisor } from './hermes-supervisor.ts';
import { hermesHistoryHomeCandidates, readHermesSessionModelFromHomes } from './hermes-history.ts';
import { MemoryExtractionScheduler } from './memory-extraction.ts';
import { IngestionStore } from './ingestion-store.ts';
import { GdriveSource } from './gdrive-source.ts';
import { isOneDriveIngestionEnabled, OneDriveSource } from './onedrive-source.ts';
import { GmailSource } from './gmail-source.ts';
import { GranolaSource } from './granola-source.ts';
import { ClickupSource } from './clickup-source.ts';
import { SlackSource } from './slack-source.ts';
import { TeamsSource } from './teams-source.ts';
import { ComposioSlackUserDirectory } from './slack-users.ts';
import { ComposioSlackConversationDirectory } from './slack-conversations.ts';
import { SourceIngestionScheduler } from './source-ingestion.ts';
import { buildIngestionRoutes } from './ingestion.ts';
import { dispatch, json, route, type Route } from './router.ts';
import { buildSkillsRoutes, setSkillsDir } from './skills.ts';
import { buildSkillsHubRoutes } from './skills-hub.ts';
import { HermesSkillsConfig } from './skills-store.ts';
import { PinnedSkillsStore } from './pinned-skills-store.ts';
import { buildCronsRoutes } from './crons.ts';
import { CronDescriptionsStore } from './cron-descriptions-store.ts';
import { LocalEmbedder, resolveEmbedderConfig } from './embedder.ts';
import { isChatCaptureEnabled, LexicalMemoryProvider, resolveLexicalMemoryConfig } from './lexical-provider.ts';
import { buildMemoryRoutes } from './memory-routes.ts';
import type { MemoryProvider } from './memory-provider.ts';
import { ComposioBridgeService } from '../integrations/composio-bridge.ts';
import { ConnectionsService } from '../integrations/composio.ts';
import { ManagedBackendClient } from '../integrations/managed-backend-client.ts';
import { readRuntimeMode, type RuntimeMode } from '../integrations/runtime-mode.ts';
import { buildManagedAccountRoutes } from './managed-account.ts';
import { AnthropicAuthService, CodexAuthService, buildModelAuthRoutes } from './model-auth.ts';
import { ANTHROPIC_CHAT_MODELS, CODEX_CHAT_MODELS, VALID_CHAT_MODELS } from './model-catalog.ts';
import { applyLocalStateIsolation, type LocalStateSnapshot } from './local-state.ts';
import {
  ComposioManifestCoordinator,
  readComposioManifestSummary,
} from './composio-manifest.ts';

// Upper bound on how long Hermes' warm-up waits for the first native manifest
// refresh. Applies only when apps are connected but the on-disk manifest is
// unusable (fresh account profile, corrupted file) — with a usable manifest
// Hermes starts immediately. A hung/offline backend must not block chat
// readiness, and the server's ready signal never waits on this at all.
const STARTUP_MANIFEST_REFRESH_WAIT_MS = 20_000;

function buildRoutes(
  runtimeMode: RuntimeMode,
  store: ChatStore,
  chatRequests: ChatRequestRegistry,
  hermes: HermesSupervisor,
  memoryExtraction: MemoryExtractionScheduler,
  managedBackend: ManagedBackendClient,
  composioBridge: ComposioBridgeService,
  localState: LocalStateSnapshot,
  memoryProvider: MemoryProvider,
  connectionsStore: ConnectionsStore,
): Route[] {
  return [
    route('GET', '/health', async (_req, res) => {
      json(res, 200, { status: 'ok', timestamp: Date.now() });
    }),

    route('GET', '/diagnostics', async (_req, res) => {
      json(res, 200, {
        status: 'ok',
        timestamp: Date.now(),
        runtime: {
          mode: runtimeMode,
          pid: process.pid,
          cwd: process.cwd(),
          node: process.version,
        },
        chat: buildChatDiagnostics(store, chatRequests, memoryExtraction),
        hermes: await hermes.getStatus(500),
        memory: memoryProvider.diagnostics(),
        managed: await managedBackend.getAccount(),
        composioTools: composioBridge.getNativeToolManifestStatus(),
        composioManifest: {
          path: hermes.composioToolsManifestPath,
          activeToolkitCount: activeToolkitSlugs(connectionsStore).length,
          ...readComposioManifestSummary(hermes.composioToolsManifestPath),
        },
        localState,
      });
    }),
  ];
}

export async function startServer(opts: { port?: number; authSecret?: string | null; allowUnauthenticated?: boolean } = {}): Promise<{
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}> {
  const runtimeMode = readRuntimeMode();
  const localState = applyLocalStateIsolation(process.env, { runtimeMode });
  const store = new ChatStore();
  const chatRequests = new ChatRequestRegistry();
  const managedBackend = new ManagedBackendClient({ runtimeMode });
  const customConnectorsStore = new CustomConnectorsStore();
  const customConnectorKeychain = new CustomConnectorKeychain();
  const browserSettings = new BrowserSettingsStore();
  const browserHost = new BrowserHost();
  await browserHost.prepareCdpEndpoint().catch((error: unknown) => {
    console.warn(
      '[browser-host] could not prepare lazy CDP endpoint; Hermes stays in local browser mode:',
      error instanceof Error ? error.message : String(error),
    );
  });
  const hermes = new HermesSupervisor({
    runtimeMode,
    customConnectorsStore,
    customConnectorKeychain,
    browserRuntime: {
      cdpUrl: () => browserHost.cdpUrl(),
      allowPrivateUrls: () => browserSettings.get().allowPrivateUrls,
    },
  });
  const hermesHistoryHomes = hermesHistoryHomeCandidates(hermes.hermesHome);
  // Hermes has the exact model for conversations it executed. Restore that
  // durable per-session state for databases created before Verso stored model
  // selection locally. Never fill unknown/non-product models by inference.
  const recoveredModels = store.backfillSessionModels((hermesSessionId) => {
    const model = readHermesSessionModelFromHomes({
      hermesHomes: hermesHistoryHomes,
      hermesSessionId,
    });
    return model && (VALID_CHAT_MODELS as readonly string[]).includes(model) ? model : null;
  });
  if (recoveredModels > 0) {
    console.info(`[chat] restored persisted Hermes model for ${recoveredModels} legacy session(s)`);
  }
  // The one memory backend: an in-process SQLite FTS5 store, ready as soon
  // as the file opens. The local embedder upgrades search to hybrid
  // (BM25 + cosine, RRF-fused) once its model loads — it backfills in the
  // background and never gates reads or writes.
  const embedderConfig = resolveEmbedderConfig(hermes.hermesHome);
  const memoryProvider: MemoryProvider = new LexicalMemoryProvider(
    resolveLexicalMemoryConfig(hermes.hermesHome),
    { embedder: embedderConfig.enabled ? new LocalEmbedder(embedderConfig) : null },
  );
  // Defer extraction (don't fail it) until the store is open. Shared by chat
  // extraction and source ingestion.
  const extractionGate = () => memoryProvider.isReady();
  // Chat-transcript capture is opt-in (VERSO_MEMORY_CHAT_CAPTURE); connected
  // sources have their own per-source toggles in Settings.
  const memoryExtraction = new MemoryExtractionScheduler(store, memoryProvider, {
    extractionGate,
    enabled: () => isChatCaptureEnabled() && memoryProvider.diagnostics().enabled,
  });
  const connectionsStore = new ConnectionsStore();
  const composioToolUsage = new ComposioToolUsageStore();
  const composioBridge = new ComposioBridgeService(managedBackend, {
    store: composioToolUsage,
    manifestPath: hermes.composioToolsManifestPath,
    getActiveToolkitSlugs: () => activeToolkitSlugs(connectionsStore),
  });
  const composioManifest = new ComposioManifestCoordinator({
    manifestPath: hermes.composioToolsManifestPath,
    getActiveToolkitSlugs: () => activeToolkitSlugs(connectionsStore),
    refreshNativeToolManifest: (toolkits) => composioBridge.refreshNativeToolManifest(toolkits),
    writeFallbackManifest: (manifestPath, toolkits) => {
      composioToolUsage.writeManifest(manifestPath, toolkits);
    },
    restartHermes: () => hermes.restart(),
  });
  const refreshComposioToolsManifest = () => composioManifest.refresh();
  const initialManifestRefresh = refreshComposioToolsManifest();
  const connections = new ConnectionsService(managedBackend, connectionsStore, refreshComposioToolsManifest);
  // Automated source ingestion. Runs whenever memory is enabled; the
  // per-source toggles in Settings decide what actually gets ingested (an
  // explicit falsy VERSO_INGESTION_ENABLED is a kill switch).
  const ingestionStore = new IngestionStore();
  const sourceIngestion = new SourceIngestionScheduler(
    ingestionStore,
    memoryProvider,
    [
      new GmailSource(composioBridge),
      new GranolaSource(composioBridge),
      new SlackSource(composioBridge, {
        userDirectory: new ComposioSlackUserDirectory(composioBridge),
        conversationDirectory: new ComposioSlackConversationDirectory(composioBridge),
      }),
      new TeamsSource(composioBridge),
      new GdriveSource(composioBridge),
      ...(isOneDriveIngestionEnabled() ? [new OneDriveSource(composioBridge)] : []),
      new ClickupSource(composioBridge),
    ],
    {
      extractionGate,
      // Cheap, local connection check — never a remote listConnections() call.
      connectionGate: (source) => {
        const toolkit = SOURCE_TOOLKITS[source] ?? source;
        return activeToolkitSlugs(connectionsStore).includes(toolkit);
      },
    },
  );
  // Slack used to be polled per channel/DM (one stream each). It's now a single
  // search-based stream, so retire any legacy per-channel streams and carry the
  // user's intent forward: if any channel was on, turn the single stream on.
  migrateSlackToSingleStream(ingestionStore, sourceIngestion);
  // Point the skills scanner at the same Hermes home Hermes itself uses
  // (profile-aware, e.g. the runtime-scoped Hermes home's skills directory). Without this it
  // falls back to the legacy ~/.hermes/skills path and misses any skills
  // that only live under the active profile.
  setSkillsDir(path.join(hermes.hermesHome, 'skills'));
  // Same `config.yaml` Hermes itself reads at request time. If we leave
  // this at the legacy `~/.hermes/config.yaml` default, the UI toggle
  // writes to one file while Hermes reads from another — disables never
  // take effect.
  const skillsConfig = new HermesSkillsConfig(path.join(hermes.hermesHome, 'config.yaml'));
  const pinnedSkills = new PinnedSkillsStore();
  const cronDescriptions = new CronDescriptionsStore();
  const codexAuth = new CodexAuthService(hermes);
  const anthropicAuth = new AnthropicAuthService(
    hermes,
    async () => (await codexAuth.getStatus()).connected,
  );
  const routes = [
    ...buildRoutes(runtimeMode, store, chatRequests, hermes, memoryExtraction, managedBackend, composioBridge, localState, memoryProvider, connectionsStore),
    ...buildMemoryRoutes(memoryProvider),
    ...buildComposioBridgeRoutes(composioBridge),
    ...buildDraftsRoutes(composioBridge, store),
    ...buildManagedAccountRoutes(managedBackend, {
      onSessionChanged: () => {
        void connections.listConnections().catch((error) => {
          console.warn(
            '[managed] connection refresh after session change failed:',
            error instanceof Error ? error.message : String(error),
          );
          refreshComposioToolsManifest();
        });
      },
    }),
    ...buildConnectionsRoutes(connections),
    ...buildCustomConnectorRoutes(customConnectorsStore, customConnectorKeychain, hermes),
    ...buildIngestionRoutes(sourceIngestion, memoryProvider),
    ...buildSkillsHubRoutes(hermes),
    ...buildSkillsRoutes(skillsConfig, pinnedSkills),
    ...buildCronsRoutes(hermes, cronDescriptions),
    ...buildBrowserRoutes(browserHost, browserSettings, hermes),
    ...buildModelAuthRoutes(codexAuth, anthropicAuth),
    ...buildChatRoutes(store, hermes, managedBackend, chatRequests, memoryExtraction, async () => {
      const codex = await codexAuth.getStatus();
      if (codex.connected) return CODEX_CHAT_MODELS[0];
      const anthropic = await anthropicAuth.getStatus();
      if (anthropic.connected) return ANTHROPIC_CHAT_MODELS[0];
      return null;
    }),
  ];

  const authSecret = opts.authSecret ?? process.env.VERSO_SIDECAR_AUTH_SECRET ?? null;
  const nativeLaunch = Boolean(process.env.VERSO_PARENT_PID);
  const allowUnauthenticated = !nativeLaunch && (
    opts.allowUnauthenticated === true
    || process.env.VERSO_ALLOW_UNAUTHENTICATED_SIDECAR === '1'
  );
  if (!authSecret && !allowUnauthenticated) {
    throw new Error('VERSO_SIDECAR_AUTH_SECRET is required. For local development only, set VERSO_ALLOW_UNAUTHENTICATED_SIDECAR=1.');
  }

  const server = http.createServer((req, res) => {
    dispatch(routes, req, res, { authSecret, allowUnauthenticated });
  });
  let cleanupPromise: Promise<void> | null = null;
  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      memoryExtraction.stop();
      sourceIngestion.stop();
      await Promise.all([
        hermes.shutdown(),
        browserHost.shutdown(),
        memoryProvider.stop(),
      ]);
    })();
    return cleanupPromise;
  };
  server.on('close', () => {
    chatRequests.cancelAll();
    void cleanup();
  });

  const port = opts.port ?? parseInt(process.env.PORT || '0', 10);
  const close = async () => {
    chatRequests.cancelAll();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await cleanup();
  };

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', async () => {
      const addr = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      hermes.setOrchestratorBaseUrl(baseUrl);
      // Warm Hermes up off the critical path — never behind the server's
      // ready signal. In the common case the manifest from the last run is
      // already usable, so Hermes starts immediately against it and the
      // refresh updates the file in the background (zero added launch time).
      // Only when apps are connected but the on-disk manifest is unusable —
      // fresh account profile, corrupted file — is the warm-up held (bounded)
      // for the first refresh, because spawning the MCP bridge against a
      // broken manifest locks in a broken tool surface for the whole run. If
      // the refresh lands late, restart-on-recovery above picks it up; a chat
      // arriving before the hold expires starts Hermes via ensureReady() and
      // is covered by the same path.
      void (async () => {
        if (composioManifest.needsManifestBeforeHermesStart()) {
          await Promise.race([
            initialManifestRefresh,
            new Promise((resolve) => setTimeout(resolve, STARTUP_MANIFEST_REFRESH_WAIT_MS)),
          ]);
        }
        composioManifest.captureRegisteredManifest();
        hermes.prepare();
      })();
      // Warm the Codex status cache off the critical path: the first UI
      // status fetch and the first new chat's default-model lookup both
      // land within seconds, and the uncached path spawns the Python CLI.
      void codexAuth.getStatus().catch(() => undefined);
      // Open the memory store first so its instance token is available: if the
      // store was recreated since the last run, rebuild the ingested corpus
      // (re-seed cursors + clear the dedup ledger) before ingestion ticks, so a
      // reset store doesn't stay empty behind an already-'processed' ledger.
      await memoryProvider.start();
      sourceIngestion.reconcileWithMemoryToken(memoryProvider.instanceToken?.() ?? null);
      memoryExtraction.start();
      sourceIngestion.start();
      resolve({ server, port: addr.port, close });
    });
  });
}

// Ingestion sources whose Composio toolkit slug differs from the source name.
const SOURCE_TOOLKITS: Record<string, string> = {
  granola: 'granola_mcp',
  gdrive: 'googledrive',
  onedrive: 'one_drive',
  teams: 'microsoft_teams',
};

function activeToolkitSlugs(store: ConnectionsStore): string[] {
  return store.listConnections()
    .filter((connection) => connection.status === 'active')
    .map((connection) => connection.toolkitSlug);
}

/**
 * One-time migration from the old per-channel Slack model to the single
 * search-based stream. Disables every legacy per-channel/DM stream so the
 * scheduler stops claiming them (they'd feed stale cursors into the new
 * search adapter), and if the user had any of them on, enables the single
 * stream so Slack stays "on". Idempotent: a no-op once no legacy streams remain.
 */
function migrateSlackToSingleStream(store: IngestionStore, scheduler: SourceIngestionScheduler): void {
  const legacy = store.listSourceStreams('slack').filter((state) => state.stream !== '');
  if (legacy.length === 0) return;
  const anyEnabled = legacy.some((state) => state.enabled);
  for (const state of legacy) store.disableSource('slack', state.stream);
  if (anyEnabled) scheduler.setSourceEnabled('slack', true);
}

const isMain = process.argv[1] && (
  process.argv[1].endsWith('/server.ts') ||
  process.argv[1].endsWith('/server.js')
);

if (isMain) {
  installDiagnosticHandlers();

  startServer().then(({ close, port }) => {
    console.log(JSON.stringify({
      port,
      status: 'ready',
      pid: process.pid,
    }));

    const shutdown = (reason: string) => {
      console.error(`[sidecar] ${reason}, shutting down`);
      void close().finally(() => process.exit(0));
    };

    process.on('SIGTERM', () => shutdown('received SIGTERM'));
    process.on('SIGINT', () => shutdown('received SIGINT'));
    process.on('SIGHUP', () => shutdown('received SIGHUP'));
    process.on('beforeExit', (code) => {
      console.error(`[sidecar] beforeExit code=${code} — event loop drained`);
    });
    process.on('exit', (code) => {
      console.error(`[sidecar] exit code=${code}`);
    });

    installParentDeathWatcher(() => shutdown('parent process gone'));
  }).catch((error: unknown) => {
    console.error(JSON.stringify(classifyStartupError(error)));
    process.exit(1);
  });
}

/**
 * macOS has no equivalent of Linux's PR_SET_PDEATHSIG, so we poll the parent
 * pid every couple of seconds. If the parent disappears (verso crashed,
 * was force-quit, or Xcode's Stop button delivered SIGKILL), this process
 * exits cleanly instead of getting re-parented to launchd and spinning
 * forever — which is exactly what was cooking the user's laptop with three
 * orphaned orchestrators pinning CPU cores at 100%.
 */
function installParentDeathWatcher(onParentGone: () => void): void {
  const raw = process.env.VERSO_PARENT_PID;
  const parentPid = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parentPid) || parentPid <= 1) {
    console.error('[sidecar] VERSO_PARENT_PID not set; parent-death detection disabled');
    return;
  }

  console.error(`[sidecar] watching parent pid=${parentPid}`);
  const interval = setInterval(() => {
    try {
      // Signal 0 doesn't actually deliver anything — it just throws ESRCH if
      // no process with that pid exists, or EPERM if we can't signal it (in
      // which case the process is alive, just under a different uid). Either
      // way, only ESRCH means the parent is gone.
      process.kill(parentPid, 0);
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ESRCH') {
        clearInterval(interval);
        console.error(`[sidecar] parent pid=${parentPid} no longer exists, exiting`);
        onParentGone();
      }
      // EPERM/other → parent is alive in another user context; keep watching.
    }
  }, 2_000);
  // Don't keep the event loop alive just for this watcher.
  interval.unref();
}

function installDiagnosticHandlers(): void {
  // Defensive: when our parent (the verso Mac app) dies, the read end of our
  // stdout/stderr pipes closes. Subsequent writes fail with EPIPE. Without an
  // 'error' handler the writable stream's internal retry loop can pin a CPU
  // core indefinitely — exactly the symptom we saw with the orphaned orchestrators
  // running for 19 hours at 100% CPU. The parent-pid watcher should make us
  // exit within a few seconds anyway, but during that window we don't want to
  // burn a core, and these listeners cost nothing.
  process.stdout.on('error', () => { /* swallow EPIPE */ });
  process.stderr.on('error', () => { /* swallow EPIPE */ });


  // We deliberately do NOT call process.exit() in either handler — Node's
  // default for unhandled rejections is to terminate the process, which
  // is what we suspect is causing the silent disappearance of the sidebar.
  // Catching and logging keeps the process alive; the next request will
  // either work or surface a real error.
  process.on('unhandledRejection', (reason, promise) => {
    const message = reason instanceof Error
      ? `${reason.name}: ${reason.message}\n${reason.stack ?? ''}`
      : String(reason);
    console.error(`[sidecar] unhandledRejection ${new Date().toISOString()}\n${message}`);
    // Best-effort: log promise stringification too
    try {
      console.error(`[sidecar] unhandledRejection promise: ${String(promise)}`);
    } catch { /* ignore */ }
  });

  process.on('uncaughtException', (error, origin) => {
    const message = error instanceof Error
      ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
      : String(error);
    console.error(`[sidecar] uncaughtException origin=${origin} ${new Date().toISOString()}\n${message}`);
  });

  // Cheap heartbeat so a long stderr log shows we were alive, then the
  // last line before death tells us roughly when things went south.
  const heartbeatInterval = 60_000;
  setInterval(() => {
    const memory = process.memoryUsage();
    const rssMb = Math.round(memory.rss / 1024 / 1024);
    const heapMb = Math.round(memory.heapUsed / 1024 / 1024);
    console.error(`[sidecar] heartbeat ${new Date().toISOString()} pid=${process.pid} rss=${rssMb}MB heap=${heapMb}MB`);
  }, heartbeatInterval).unref();
}

function classifyStartupError(error: unknown): {
  status: 'error';
  code: 'startup_failed' | 'unknown';
  message: string;
  recoverable: boolean;
  details?: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (normalized.includes('eaddrinuse') || normalized.includes('address already in use')) {
    return {
      status: 'error',
      code: 'startup_failed',
      message: 'Sidecar port is already in use.',
      recoverable: false,
      details: message,
    };
  }

  return {
    status: 'error',
    code: 'unknown',
    message: 'Sidecar failed to start.',
    recoverable: false,
    details: message,
  };
}
