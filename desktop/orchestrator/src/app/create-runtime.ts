import path from 'node:path';
import { BrowserHost } from '../browser/browser-host.ts';
import { BrowserSettingsStore } from '../browser/browser-settings-store.ts';
import { ChatRequestRegistry } from '../chat/chat-request-registry.ts';
import { ChatStore } from '../chat/chat-store.ts';
import { hermesHistoryHomeCandidates, readHermesSessionModelFromHomes } from '../chat/hermes-history.ts';
import { ComposioManifestCoordinator } from '../connections/composio-manifest.ts';
import { ComposioToolUsageStore } from '../connections/composio-tool-usage-store.ts';
import { ConnectionsStore } from '../connections/connections-store.ts';
import { CustomConnectorsStore } from '../connections/custom-connectors-store.ts';
import { CustomConnectorKeychain, KeychainSecretStore } from '../connections/keychain.ts';
import { CronDescriptionsStore } from '../crons/cron-descriptions-store.ts';
import { HermesSupervisor } from '../hermes/hermes-supervisor.ts';
import { getTemplateHermesHome, getVersoHermesHome } from '../hermes/hermes-managed-profile.ts';
import type { Route } from '../http/router.ts';
import { ComposioBridgeService } from '../integrations/composio-bridge.ts';
import { ConnectionsService } from '../integrations/composio.ts';
import { ManagedBackendClient } from '../integrations/managed-backend-client.ts';
import { readRuntimeMode } from '../integrations/runtime-mode.ts';
import { LocalEmbedder, resolveEmbedderConfig } from '../memory/embedder.ts';
import { IngestionStore } from '../memory/ingestion/ingestion-store.ts';
import { SourceIngestionScheduler } from '../memory/ingestion/source-ingestion.ts';
import { ClickupSource } from '../memory/ingestion/sources/clickup-source.ts';
import { GdriveSource } from '../memory/ingestion/sources/gdrive-source.ts';
import { GmailSource } from '../memory/ingestion/sources/gmail-source.ts';
import { GranolaSource } from '../memory/ingestion/sources/granola-source.ts';
import { OneDriveSource } from '../memory/ingestion/sources/onedrive-source.ts';
import { ComposioSlackConversationDirectory } from '../memory/ingestion/sources/slack-conversations.ts';
import { SlackSource } from '../memory/ingestion/sources/slack-source.ts';
import { ComposioSlackUserDirectory } from '../memory/ingestion/sources/slack-users.ts';
import { TeamsSource } from '../memory/ingestion/sources/teams-source.ts';
import { isChatCaptureEnabled, LexicalMemoryProvider, resolveLexicalMemoryConfig } from '../memory/lexical-provider.ts';
import { MemoryExtractionScheduler } from '../memory/memory-extraction.ts';
import type { MemoryProvider } from '../memory/memory-provider.ts';
import { AnthropicAuthService, CodexAuthService } from '../models/model-auth.ts';
import { isAllowedChatModel } from '../models/model-catalog.ts';
import { CustomModelProviderService } from '../models/custom-model-provider.ts';
import {
  CUSTOM_MODEL_KEYCHAIN_SERVICE,
  CustomModelProviderStore,
} from '../models/custom-model-provider-store.ts';
import { PinnedSkillsStore } from '../skills/pinned-skills-store.ts';
import { HermesSkillsConfig } from '../skills/skills-store.ts';
import { setSkillsDir } from '../skills/skills.ts';
import { WorkspaceIndexer } from '../workspaces/workspace-indexer.ts';
import { WorkspaceStore } from '../workspaces/workspace-store.ts';
import { applyLocalStateIsolation } from './local-state.ts';
import { registerRoutes } from './register-routes.ts';

// A broken or absent native-tool manifest may delay Hermes warm-up, but never
// the sidecar's ready signal or longer than this bound.
const STARTUP_MANIFEST_REFRESH_WAIT_MS = 20_000;

export interface SidecarRuntime {
  routes: Route[];
  chatRequests: ChatRequestRegistry;
  setOrchestratorBaseUrl(baseUrl: string): void;
  startBackgroundServices(): Promise<void>;
  stop(): Promise<void>;
}

/** Construct the sidecar's long-lived feature services and their HTTP routes. */
export async function createSidecarRuntime(): Promise<SidecarRuntime> {
  const runtimeMode = readRuntimeMode();
  const localState = applyLocalStateIsolation(process.env, { runtimeMode });
  const store = new ChatStore();
  const chatRequests = new ChatRequestRegistry();
  const managedBackend = new ManagedBackendClient({ runtimeMode });
  const customConnectorsStore = new CustomConnectorsStore();
  const customConnectorKeychain = new CustomConnectorKeychain();
  const hermesHome = getVersoHermesHome(getTemplateHermesHome(), runtimeMode);
  const customModelProviderStore = new CustomModelProviderStore(
    CustomModelProviderStore.pathForHermesHome(hermesHome),
  );
  const customModelKeychain = new KeychainSecretStore(CUSTOM_MODEL_KEYCHAIN_SERVICE);
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
    customModelProviderStore,
    customModelKeychain,
    browserRuntime: {
      cdpUrl: () => browserHost.cdpUrl(),
      allowPrivateUrls: () => browserSettings.get().allowPrivateUrls,
    },
  });

  restoreLegacySessionModels(store, hermes, customModelProviderStore);

  const embedderConfig = resolveEmbedderConfig(hermes.hermesHome);
  const memoryProvider: MemoryProvider = new LexicalMemoryProvider(
    resolveLexicalMemoryConfig(hermes.hermesHome),
    { embedder: embedderConfig.enabled ? new LocalEmbedder(embedderConfig) : null },
  );
  const extractionGate = () => memoryProvider.isReady();
  const memoryExtraction = new MemoryExtractionScheduler(store, memoryProvider, {
    extractionGate,
    enabled: () => isChatCaptureEnabled() && memoryProvider.diagnostics().enabled,
  });
  const workspaceStore = new WorkspaceStore(
    localState.paths.workspacesRoot ?? path.join(localState.paths.root, 'workspaces'),
  );
  const workspaceIndexer = new WorkspaceIndexer(workspaceStore, memoryProvider);

  const connectionsStore = new ConnectionsStore();
  const activeToolkitSlugs = () => connectionsStore.listConnections()
    .filter((connection) => connection.status === 'active')
    .map((connection) => connection.toolkitSlug);
  const composioToolUsage = new ComposioToolUsageStore();
  const composioBridge = new ComposioBridgeService(managedBackend, {
    store: composioToolUsage,
    manifestPath: hermes.composioToolsManifestPath,
    getActiveToolkitSlugs: activeToolkitSlugs,
  });
  const composioManifest = new ComposioManifestCoordinator({
    manifestPath: hermes.composioToolsManifestPath,
    getActiveToolkitSlugs: activeToolkitSlugs,
    refreshNativeToolManifest: (toolkits) => composioBridge.refreshNativeToolManifest(toolkits),
    writeFallbackManifest: (manifestPath, toolkits) => {
      composioToolUsage.writeManifest(manifestPath, toolkits);
    },
    restartHermes: () => hermes.restart(),
  });
  const refreshComposioToolsManifest = () => composioManifest.refresh();
  const initialManifestRefresh = refreshComposioToolsManifest();
  const connections = new ConnectionsService(
    managedBackend,
    connectionsStore,
    refreshComposioToolsManifest,
  );

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
      new OneDriveSource(composioBridge),
      new ClickupSource(composioBridge),
    ],
    {
      extractionGate,
      connectionGate: (source) => {
        const toolkit = SOURCE_TOOLKITS[source] ?? source;
        return activeToolkitSlugs().includes(toolkit);
      },
    },
  );
  migrateSlackToSingleStream(ingestionStore, sourceIngestion);

  setSkillsDir(path.join(hermes.hermesHome, 'skills'));
  const skillsConfig = new HermesSkillsConfig(path.join(hermes.hermesHome, 'config.yaml'));
  const pinnedSkills = new PinnedSkillsStore();
  const cronDescriptions = new CronDescriptionsStore();
  const codexAuth = new CodexAuthService(hermes);
  const anthropicAuth = new AnthropicAuthService(
    hermes,
    async () => (await codexAuth.getStatus()).connected,
  );
  const customModelProvider = new CustomModelProviderService(
    customModelProviderStore,
    hermes,
    customModelKeychain,
  );

  const routes = registerRoutes({
    runtimeMode,
    localState,
    store,
    chatRequests,
    hermes,
    memoryExtraction,
    managedBackend,
    composioBridge,
    memoryProvider,
    activeToolkitSlugs,
    connections,
    refreshComposioToolsManifest,
    customConnectorsStore,
    customConnectorKeychain,
    sourceIngestion,
    skillsConfig,
    pinnedSkills,
    cronDescriptions,
    browserHost,
    browserSettings,
    codexAuth,
    anthropicAuth,
    customModelProvider,
    workspaceStore,
    workspaceIndexer,
  });

  let cleanupPromise: Promise<void> | null = null;
  return {
    routes,
    chatRequests,
    setOrchestratorBaseUrl: (baseUrl) => hermes.setOrchestratorBaseUrl(baseUrl),
    startBackgroundServices: async () => {
      // Warm Hermes independently of the ready signal. A fresh or corrupted
      // manifest gets one bounded chance to refresh before the process starts.
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
      void codexAuth.getStatus().catch(() => undefined);

      await memoryProvider.start();
      await workspaceIndexer.start();
      sourceIngestion.reconcileWithMemoryToken(memoryProvider.instanceToken?.() ?? null);
      memoryExtraction.start();
      sourceIngestion.start();
    },
    stop: () => {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = (async () => {
        memoryExtraction.stop();
        sourceIngestion.stop();
        await Promise.all([
          hermes.shutdown(),
          browserHost.shutdown(),
          workspaceIndexer.stop(),
        ]);
        await memoryProvider.stop();
      })();
      return cleanupPromise;
    },
  };
}

function restoreLegacySessionModels(
  store: ChatStore,
  hermes: HermesSupervisor,
  customModelProviderStore: CustomModelProviderStore,
): void {
  const hermesHomes = hermesHistoryHomeCandidates(hermes.hermesHome);
  const recoveredModels = store.backfillSessionModels((hermesSessionId) => {
    const model = readHermesSessionModelFromHomes({ hermesHomes, hermesSessionId });
    return model && isAllowedChatModel(model, customModelProviderStore.get()?.model ?? null) ? model : null;
  });
  if (recoveredModels > 0) {
    console.info(`[chat] restored persisted Hermes model for ${recoveredModels} legacy session(s)`);
  }
}

const SOURCE_TOOLKITS: Record<string, string> = {
  granola: 'granola_mcp',
  gdrive: 'googledrive',
  onedrive: 'one_drive',
  teams: 'microsoft_teams',
};

function migrateSlackToSingleStream(
  store: IngestionStore,
  scheduler: SourceIngestionScheduler,
): void {
  const legacy = store.listSourceStreams('slack').filter((state) => state.stream !== '');
  if (legacy.length === 0) return;
  const anyEnabled = legacy.some((state) => state.enabled);
  for (const state of legacy) store.disableSource('slack', state.stream);
  if (anyEnabled) scheduler.setSourceEnabled('slack', true);
}
