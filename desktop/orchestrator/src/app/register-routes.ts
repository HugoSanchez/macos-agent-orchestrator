import { buildManagedAccountRoutes } from '../account/managed-account.ts';
import type { BrowserHost } from '../browser/browser-host.ts';
import type { BrowserSettingsStore } from '../browser/browser-settings-store.ts';
import { buildBrowserRoutes } from '../browser/browser.ts';
import { buildChatDiagnostics, buildChatRoutes } from '../chat/chat.ts';
import type { ChatRequestRegistry } from '../chat/chat-request-registry.ts';
import type { ChatStore } from '../chat/chat-store.ts';
import { buildDraftsRoutes } from '../chat/drafts.ts';
import { buildComposioBridgeRoutes } from '../connections/composio-bridge.ts';
import { buildConnectionsRoutes } from '../connections/connections.ts';
import type { CustomConnectorKeychain } from '../connections/keychain.ts';
import type { CustomConnectorsStore } from '../connections/custom-connectors-store.ts';
import { buildCustomConnectorRoutes } from '../connections/custom-connectors.ts';
import type { CronDescriptionsStore } from '../crons/cron-descriptions-store.ts';
import { buildCronsRoutes } from '../crons/crons.ts';
import type { HermesSupervisor } from '../hermes/hermes-supervisor.ts';
import { json, route, type Route } from '../http/router.ts';
import type { ComposioBridgeService } from '../integrations/composio-bridge.ts';
import type { ConnectionsService } from '../integrations/composio.ts';
import type { ManagedBackendClient } from '../integrations/managed-backend-client.ts';
import type { RuntimeMode } from '../integrations/runtime-mode.ts';
import { buildIngestionRoutes } from '../memory/ingestion/ingestion.ts';
import type { SourceIngestionScheduler } from '../memory/ingestion/source-ingestion.ts';
import type { MemoryExtractionScheduler } from '../memory/memory-extraction.ts';
import type { MemoryProvider } from '../memory/memory-provider.ts';
import { buildMemoryRoutes } from '../memory/memory-routes.ts';
import type { AnthropicAuthService, CodexAuthService } from '../models/model-auth.ts';
import { buildModelAuthRoutes } from '../models/model-auth.ts';
import { ANTHROPIC_CHAT_MODELS, CODEX_CHAT_MODELS } from '../models/model-catalog.ts';
import { buildSkillsHubRoutes } from '../skills/skills-hub.ts';
import type { PinnedSkillsStore } from '../skills/pinned-skills-store.ts';
import type { HermesSkillsConfig } from '../skills/skills-store.ts';
import { buildSkillsRoutes } from '../skills/skills.ts';
import { readComposioManifestSummary } from '../connections/composio-manifest.ts';
import type { LocalStateSnapshot } from './local-state.ts';

export interface RouteDependencies {
  runtimeMode: RuntimeMode;
  localState: LocalStateSnapshot;
  store: ChatStore;
  chatRequests: ChatRequestRegistry;
  hermes: HermesSupervisor;
  memoryExtraction: MemoryExtractionScheduler;
  managedBackend: ManagedBackendClient;
  composioBridge: ComposioBridgeService;
  memoryProvider: MemoryProvider;
  activeToolkitSlugs: () => string[];
  connections: ConnectionsService;
  refreshComposioToolsManifest: () => Promise<void>;
  customConnectorsStore: CustomConnectorsStore;
  customConnectorKeychain: CustomConnectorKeychain;
  sourceIngestion: SourceIngestionScheduler;
  skillsConfig: HermesSkillsConfig;
  pinnedSkills: PinnedSkillsStore;
  cronDescriptions: CronDescriptionsStore;
  browserHost: BrowserHost;
  browserSettings: BrowserSettingsStore;
  codexAuth: CodexAuthService;
  anthropicAuth: AnthropicAuthService;
}

/** Assemble the sidecar's HTTP surface from already-created feature services. */
export function registerRoutes(deps: RouteDependencies): Route[] {
  const coreRoutes = [
    route('GET', '/health', async (_req, res) => {
      json(res, 200, { status: 'ok', timestamp: Date.now() });
    }),
    route('GET', '/diagnostics', async (_req, res) => {
      json(res, 200, {
        status: 'ok',
        timestamp: Date.now(),
        runtime: {
          mode: deps.runtimeMode,
          pid: process.pid,
          cwd: process.cwd(),
          node: process.version,
        },
        chat: buildChatDiagnostics(deps.store, deps.chatRequests, deps.memoryExtraction),
        hermes: await deps.hermes.getStatus(500),
        memory: deps.memoryProvider.diagnostics(),
        managed: await deps.managedBackend.getAccount(),
        composioTools: deps.composioBridge.getNativeToolManifestStatus(),
        composioManifest: {
          path: deps.hermes.composioToolsManifestPath,
          activeToolkitCount: deps.activeToolkitSlugs().length,
          ...readComposioManifestSummary(deps.hermes.composioToolsManifestPath),
        },
        localState: deps.localState,
      });
    }),
  ];

  return [
    ...coreRoutes,
    ...buildMemoryRoutes(deps.memoryProvider),
    ...buildComposioBridgeRoutes(deps.composioBridge),
    ...buildDraftsRoutes(deps.composioBridge, deps.store),
    ...buildManagedAccountRoutes(deps.managedBackend, {
      onSessionChanged: () => {
        void deps.connections.listConnections().catch((error) => {
          console.warn(
            '[managed] connection refresh after session change failed:',
            error instanceof Error ? error.message : String(error),
          );
          void deps.refreshComposioToolsManifest();
        });
      },
    }),
    ...buildConnectionsRoutes(deps.connections),
    ...buildCustomConnectorRoutes(
      deps.customConnectorsStore,
      deps.customConnectorKeychain,
      deps.hermes,
    ),
    ...buildIngestionRoutes(deps.sourceIngestion, deps.memoryProvider),
    ...buildSkillsHubRoutes(deps.hermes),
    ...buildSkillsRoutes(deps.skillsConfig, deps.pinnedSkills),
    ...buildCronsRoutes(deps.hermes, deps.cronDescriptions),
    ...buildBrowserRoutes(deps.browserHost, deps.browserSettings, deps.hermes),
    ...buildModelAuthRoutes(deps.codexAuth, deps.anthropicAuth),
    ...buildChatRoutes(
      deps.store,
      deps.hermes,
      deps.managedBackend,
      deps.chatRequests,
      deps.memoryExtraction,
      async () => {
        const codex = await deps.codexAuth.getStatus();
        if (codex.connected) return CODEX_CHAT_MODELS[0];
        const anthropic = await deps.anthropicAuth.getStatus();
        if (anthropic.connected) return ANTHROPIC_CHAT_MODELS[0];
        return null;
      },
    ),
  ];
}
