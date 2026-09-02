import { spawn, type ChildProcess } from 'node:child_process';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeMode } from '../integrations/runtime-mode.ts';
import {
  getBundledHermesInvocation,
  isBundledRuntime,
  seedHermesHomeFromBundle,
} from './runtime-bootstrap.ts';
import { isMemoryEnabled } from '../memory/lexical-provider.ts';
import { findInertCorePins } from './hermes-pinned-tools.ts';
import { CustomConnectorsStore } from '../connections/custom-connectors-store.ts';
import { CustomConnectorKeychain, KeychainSecretStore } from '../connections/keychain.ts';
import {
  CUSTOM_MODEL_KEYCHAIN_SERVICE,
  CUSTOM_MODEL_KEY_ENV,
  CustomModelProviderStore,
} from '../models/custom-model-provider-store.ts';
import { fetchRegisteredToolNames, hermesGatewayAuthHeaders } from './hermes-gateway-client.ts';
import {
  HermesManagedProfile,
  getVersoHermesHome,
  getTemplateHermesHome,
} from './hermes-managed-profile.ts';
import {
  HERMES_DEFAULT_HOST as DEFAULT_HOST,
  bundledPythonEnv,
  createManagedApiServerKey,
  getHermesGatewayConfig,
  getHermesLaunchConfig,
  isHermesManagedDisabled as isManagedDisabled,
  normalizeHermesBaseUrl as normalizeBaseUrl,
  type HermesGatewayConfig,
  type HermesLaunchConfig,
} from './hermes-runtime-config.ts';
import {
  abortable,
  allocatePort,
  canBind,
  delay,
  hasExited,
  terminateChild,
} from './hermes-process-utils.ts';
export { ALWAYS_DISABLED_HERMES_SKILLS } from './hermes-managed-profile.ts';
export { getHermesGatewayConfig } from './hermes-runtime-config.ts';
export type { HermesGatewayConfig } from './hermes-runtime-config.ts';

type HermesRuntimeState = 'idle' | 'starting' | 'ready' | 'error' | 'unavailable';
type HermesRuntimeSource = 'none' | 'managed' | 'manual';
type HermesGatewayProbe = 'ready' | 'unauthorized' | 'unreachable';

const ORCHESTRATOR_ONLY_HERMES_ENV_KEYS = [
  'VERSO_MANAGED_SESSION_TOKEN',
  'VERSO_MANAGED_SESSION_EXPIRES_AT',
  'VERSO_MANAGED_USER_ID',
  'VERSO_MANAGED_DEVICE_ID',
  'VERSO_SIDECAR_AUTH_SECRET',
  'VERSO_DRAFT_APPROVAL_TOKEN_SHA256',
  'VERSO_HERMES_API_SERVER_KEY',
  CUSTOM_MODEL_KEY_ENV,
] as const;

/**
 * Copy the native sidecar environment without credentials that Hermes does
 * not need. Credentials required by a dedicated MCP server are supplied in
 * that server's explicit environment instead of becoming ambient Hermes
 * process state.
 */
export function buildHermesInheritedEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const inherited = { ...source };
  for (const key of ORCHESTRATOR_ONLY_HERMES_ENV_KEYS) delete inherited[key];
  return inherited;
}

class HermesGatewayAuthMismatchError extends Error {
  constructor(baseUrl: string) {
    super(`Hermes at ${baseUrl} rejected Verso's managed gateway credential.`);
    this.name = 'HermesGatewayAuthMismatchError';
  }
}

export interface HermesRuntimeSnapshot {
  state: HermesRuntimeState;
  source: HermesRuntimeSource;
  reachable: boolean;
  launchConfigured: boolean;
  baseUrl: string;
  home: string | null;
  pid: number | null;
  command: string | null;
  cwd: string | null;
  lastError: string | null;
  // Core pinned tools the gateway did not register (base names). null while
  // unchecked or when the gateway doesn't expose /v1/toolsets; non-empty
  // means product-critical tools are invisible to the model.
  inertCorePins: string[] | null;
}

export interface HermesSupervisorOptions {
  config?: HermesGatewayConfig;
  launch?: HermesLaunchConfig;
  runtimeMode?: RuntimeMode;
  memoryToolsMode?: 'full' | 'none';
  customConnectorsStore?: CustomConnectorsStore;
  customConnectorKeychain?: CustomConnectorKeychain;
  customModelProviderStore?: CustomModelProviderStore;
  customModelKeychain?: KeychainSecretStore;
  /** Resolved on each spawn so browser setup and settings changes take effect after restart. */
  browserRuntime?: { cdpUrl(): string | null; allowPrivateUrls(): boolean };
}

export class HermesSupervisor {
  private readonly launch: HermesLaunchConfig;
  private readonly hasExplicitBaseUrl: boolean;
  private readonly manualMode: boolean;
  private readonly managedHermesHome: string;
  private readonly templateHermesHome: string;
  private readonly runtimeMode: RuntimeMode;
  private readonly memoryToolsMode: 'full' | 'none';
  private readonly customConnectorsStore: CustomConnectorsStore;
  private readonly customConnectorKeychain: CustomConnectorKeychain;
  private readonly customModelProviderStore: CustomModelProviderStore;
  private readonly customModelKeychain: KeychainSecretStore;
  private readonly browserRuntime: { cdpUrl(): string | null; allowPrivateUrls(): boolean } | null;
  private readonly managedProfile: HermesManagedProfile;

  private config: HermesGatewayConfig;
  private managedEndpointSelected: boolean;
  private orchestratorBaseUrl: string | null = null;
  private child: ChildProcess | null = null;
  private startPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private restartPromise: Promise<void> | null = null;
  private authRecoveryPromise: Promise<HermesGatewayConfig> | null = null;
  private state: HermesRuntimeState;
  private source: HermesRuntimeSource = 'none';
  private lastError: string | null = null;
  private logTail: string[] = [];
  // null = not checked yet (or gateway doesn't expose /v1/toolsets);
  // [] = all core pins live; non-empty = product-critical tools are
  // invisible to the model and someone should look at naming drift.
  private inertCorePins: string[] | null = null;
  private pinLivenessPromise: Promise<void> | null = null;

  constructor(options: HermesSupervisorOptions = {}) {
    this.config = options.config ?? getHermesGatewayConfig();
    this.launch = options.launch ?? getHermesLaunchConfig();
    this.runtimeMode = options.runtimeMode ?? 'local';
    this.memoryToolsMode = options.memoryToolsMode ?? 'full';
    this.customConnectorsStore = options.customConnectorsStore ?? new CustomConnectorsStore();
    this.customConnectorKeychain = options.customConnectorKeychain ?? new CustomConnectorKeychain();
    this.browserRuntime = options.browserRuntime ?? null;
    this.hasExplicitBaseUrl = Boolean(process.env.VERSO_HERMES_GATEWAY_URL?.trim());
    this.managedEndpointSelected = this.hasExplicitBaseUrl;
    this.manualMode = isManagedDisabled();
    this.templateHermesHome = getTemplateHermesHome();
    this.managedHermesHome = getVersoHermesHome(this.templateHermesHome, this.runtimeMode);
    this.customModelProviderStore = options.customModelProviderStore
      ?? new CustomModelProviderStore(CustomModelProviderStore.pathForHermesHome(this.managedHermesHome));
    this.customModelKeychain = options.customModelKeychain
      ?? new KeychainSecretStore(CUSTOM_MODEL_KEYCHAIN_SERVICE);
    this.managedProfile = new HermesManagedProfile({
      templateHome: this.templateHermesHome,
      managedHome: this.managedHermesHome,
      runtimeMode: this.runtimeMode,
      memoryToolsMode: this.memoryToolsMode,
      customConnectorsStore: this.customConnectorsStore,
      customModelProviderStore: this.customModelProviderStore,
      browserRuntime: this.browserRuntime ?? undefined,
    });
    this.state = this.launch.command || this.manualMode ? 'idle' : 'unavailable';
  }

  // The on-disk Hermes home for the gateway we manage (or the template path
  // when the user pointed us at their own gateway). Cron output files and
  // session JSON live under this directory, so the /crons routes need it.
  get hermesHome(): string {
    return this.manualMode ? this.templateHermesHome : this.managedHermesHome;
  }

  get composioToolsManifestPath(): string {
    return this.manualMode
      ? join(this.hermesHome, 'verso-composio-tools.json')
      : this.managedProfile.composioToolsManifestPath;
  }

  get gatewayConfig(): HermesGatewayConfig {
    return this.config;
  }

  // Resolved path/command of the Hermes binary the supervisor will spawn.
  // Exposed so one-off helpers (auth flows, etc.) can shell out to the same
  // binary without duplicating the detection logic. Callers that need to
  // run a Hermes subcommand should prefer invoke() below — launchCommand
  // alone is the bundled-python binary in Release builds, which spawns
  // garbage if passed Hermes subcommand args directly.
  get launchCommand(): string | null {
    return this.launch.command;
  }

  get launchCwd(): string | null {
    return this.launch.cwd;
  }

  /**
   * Build a spawn-compatible invocation for an arbitrary Hermes subcommand.
   * In Release builds the supervisor runs `<bundled-python> <hermes-script>
   * <args...>` with `PYTHONPATH=<bundled-site-packages>`; in Debug builds
   * it runs the developer's installed `hermes` directly with the bare args.
   * Helpers (codex auth, status checks, etc.) call this so they don't have
   * to special-case the bundled vs Debug code paths.
   */
  invoke(args: readonly string[]): { command: string; args: string[]; env: Record<string, string> } | null {
    if (!this.launch.command) return null;
    if (isBundledRuntime()) {
      const bundled = getBundledHermesInvocation();
      // A partially built or corrupted bundle must never fall through to the
      // Debug invocation below. launch.command is the Python interpreter in
      // bundled mode, so passing bare Hermes arguments would make Python try
      // to open a local file named `auth`, `gateway`, etc.
      if (!bundled) return null;
      return {
        command: bundled.python,
        args: [bundled.hermesScript, ...args],
        env: bundledPythonEnv(bundled),
      };
    }
    return { command: this.launch.command, args: [...args], env: {} };
  }

  prepare(): void {
    if (!this.launch.command) return;
    void this.ensureReady().catch((error: unknown) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.state = 'error';
    });
  }

  setOrchestratorBaseUrl(baseUrl: string): void {
    this.orchestratorBaseUrl = normalizeBaseUrl(baseUrl);
  }

  async ensureReady(signal?: AbortSignal): Promise<HermesGatewayConfig> {
    if (!this.launch.command && this.manualMode) {
      if (await this.ping(800, signal)) {
        this.lastError = null;
        this.state = 'ready';
        this.source = 'manual';
        return this.config;
      }
      this.lastError = `Hermes gateway unavailable at ${this.config.baseUrl}.`;
      this.state = 'error';
      this.source = 'none';
      throw new Error(this.lastError);
    }

    if (this.startPromise) {
      await abortable(this.startPromise, signal);
    } else if (this.isChildRunning() && await this.ping(800, signal)) {
      this.noteReady();
      return this.config;
    } else if (this.launch.command) {
      await abortable(this.startManaged(), signal);
    } else {
      this.lastError = 'Hermes CLI not found. Install Hermes or set VERSO_HERMES_COMMAND.';
      this.state = 'unavailable';
      this.source = 'none';
      throw new Error(this.lastError);
    }

    if (!(await this.ping(800, signal))) {
      const message = this.lastError || `Hermes gateway did not become ready at ${this.config.baseUrl}.`;
      this.state = 'error';
      throw new Error(message);
    }

    this.noteReady();
    return this.config;
  }

  async getStatus(timeoutMs = 1200): Promise<HermesRuntimeSnapshot> {
    const reachable = this.isChildRunning() ? await this.ping(timeoutMs) : false;
    if (!this.launch.command && this.manualMode) {
      const manualReachable = await this.ping(timeoutMs);
      if (manualReachable) {
        this.lastError = null;
        this.state = 'ready';
        this.source = 'manual';
      } else {
        this.state = 'idle';
        this.source = 'none';
      }
      return this.snapshot(manualReachable);
    }
    this.reconcileReachability(reachable);
    return this.snapshot(reachable);
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    const promise = this.shutdownInner().finally(() => {
      if (this.shutdownPromise === promise) this.shutdownPromise = null;
    });
    this.shutdownPromise = promise;
    return promise;
  }

  private async shutdownInner(): Promise<void> {
    const child = this.child;
    this.startPromise = null;

    if (!child || hasExited(child)) {
      if (this.child === child) this.child = null;
      this.state = this.launch.command || this.manualMode ? 'idle' : 'unavailable';
      this.source = 'none';
      return;
    }

    await terminateChild(child);

    if (this.child === child) this.child = null;
    this.state = this.launch.command || this.manualMode ? 'idle' : 'unavailable';
    this.source = 'none';
  }

  /**
   * Full child restart. Needed after credential/config changes the gateway
   * only reads at startup (.env API keys, api_server model_routes). Chat
   * sessions survive: the orchestrator rebuilds conversation history from
   * its own store when Hermes forgets a previous_response_id.
   *
   * Concurrent callers coalesce onto one in-flight restart. Without this,
   * two overlapping restarts (e.g. connector remove followed quickly by
   * add) have the second shutdown() SIGTERM the healthy gateway the first
   * restart just started, and the loser reports "did not become ready"
   * while a perfectly good gateway is running.
   */
  async restart(): Promise<void> {
    if (this.restartPromise) {
      return this.restartPromise;
    }
    const promise = (async () => {
      await this.shutdown();
      await this.ensureReady();
    })().finally(() => {
      this.restartPromise = null;
    });
    this.restartPromise = promise;
    return promise;
  }

  /**
   * Recover from a gateway-level 401 in managed mode. A 401 from Hermes'
   * API-server guard is emitted before the prompt is accepted, so one retry
   * is safe. Move to a fresh endpoint and credential instead of attempting to
   * reuse whichever process currently owns the old port.
   */
  async recoverFromAuthFailure(): Promise<HermesGatewayConfig> {
    if (this.manualMode) {
      throw new Error('The configured Hermes gateway rejected its API key. Update VERSO_HERMES_API_SERVER_KEY.');
    }
    if (this.hasExplicitBaseUrl) {
      throw new Error(
        `Hermes at ${this.config.baseUrl} rejected Verso's API key. `
        + 'Remove the explicit VERSO_HERMES_GATEWAY_URL override or make its key match.',
      );
    }
    if (this.authRecoveryPromise) return this.authRecoveryPromise;

    const promise = (async () => {
      const previousBaseUrl = this.config.baseUrl;
      await this.shutdown();
      this.config = {
        ...this.config,
        baseUrl: `http://${DEFAULT_HOST}:${await allocatePort(DEFAULT_HOST)}`,
        apiKey: createManagedApiServerKey(),
      };
      console.warn(
        `[hermes-supervisor] gateway credential mismatch at ${previousBaseUrl}; `
        + `recovering on ${this.config.baseUrl}`,
      );
      await this.ensureReady();
      return this.config;
    })().finally(() => {
      if (this.authRecoveryPromise === promise) this.authRecoveryPromise = null;
    });
    this.authRecoveryPromise = promise;
    return promise;
  }

  private snapshot(reachable: boolean): HermesRuntimeSnapshot {
    return {
      state: this.state,
      source: this.source,
      reachable,
      launchConfigured: Boolean(this.launch.command),
      baseUrl: this.config.baseUrl,
      home: this.managedHermesHome,
      pid: this.child?.pid ?? null,
      command: this.describeLaunch(),
      cwd: this.launch.cwd,
      lastError: this.lastError,
      inertCorePins: this.inertCorePins,
    };
  }

  private describeLaunch(): string | null {
    if (!this.launch.command) return null;
    return [this.launch.command, ...this.launch.args].join(' ');
  }

  private reconcileReachability(reachable: boolean): void {
    if (this.isChildRunning()) {
      if (reachable) {
        this.noteReady();
      } else if (this.state !== 'error') {
        this.state = 'starting';
        this.source = 'managed';
      }
      return;
    }

    this.source = 'none';
    this.state = this.launch.command || this.manualMode
      ? (this.lastError ? 'error' : 'idle')
      : 'unavailable';
  }

  private noteReady(): void {
    this.state = 'ready';
    this.lastError = null;
    this.source = 'managed';
    void this.verifyPinnedToolLiveness();
  }

  // Best-effort inert-pin detector. Hermes ignores pinned names that match
  // no registered tool without any diagnostic, so a naming-convention drift
  // (e.g. the 0.19 mcp_verso_* → mcp__verso__* rename) silently strips the
  // memory/product-core tools from the model. Ask the gateway what the
  // api_server platform actually exposes and complain loudly on a mismatch.
  private async verifyPinnedToolLiveness(): Promise<void> {
    if (this.pinLivenessPromise) return this.pinLivenessPromise;
    this.pinLivenessPromise = (async () => {
      // MCP registration can lag the health endpoint by a moment on cold
      // boots; retry a few times before concluding anything.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt > 0) await delay(5_000);
        const registered = await fetchRegisteredToolNames(this.config);
        if (registered === null) return; // endpoint unavailable — inconclusive, stay null
        const memoryToolsActive = isMemoryEnabled() && this.memoryToolsMode !== 'none';
        const inert = findInertCorePins(registered, { includeMemoryTools: memoryToolsActive });
        if (inert.length === 0 || attempt === 2) {
          this.inertCorePins = inert;
          if (inert.length > 0) {
            console.error(
              `[hermes-supervisor] ${inert.length} core pinned tool(s) matched nothing the gateway registered: `
              + `${inert.join(', ')}. The model cannot see them. This usually means the Hermes MCP tool-naming `
              + 'convention drifted from hermes-pinned-tools.ts — check the "registered N tool(s)" line in agent.log.',
            );
          }
          return;
        }
      }
    })().catch(() => {
      // Diagnostics must never disturb the boot path.
    }).finally(() => {
      this.pinLivenessPromise = null;
    });
    return this.pinLivenessPromise;
  }

  private isChildRunning(): boolean {
    return Boolean(this.child && !hasExited(this.child));
  }

  private async startManaged(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }
    if (!this.launch.command) {
      throw new Error('Hermes launch command is not configured.');
    }

    const promise = this.startManagedInner().finally(() => {
      this.startPromise = null;
    });
    this.startPromise = promise;
    return promise;
  }

  private async startManagedInner(allowStartupRecovery = true): Promise<void> {
    if (this.isChildRunning()) {
      if (await this.ping(500)) {
        this.noteReady();
        return;
      }
      const staleChild = this.child!;
      await terminateChild(staleChild);
      if (this.child === staleChild) this.child = null;
    }

    // First-launch bootstrap (Release builds only): seed hermes-home from the
    // bundled config templates. No-op when the bundled-runtime env vars
    // aren't set (Debug builds use the developer's existing ~/.hermes
    // install). The venv is pre-installed at bundle time and ships inside
    // Resources/site-packages/<arch>/ — no first-launch pip install needed.
    if (isBundledRuntime()) {
      this.state = 'starting';
      try {
        seedHermesHomeFromBundle();
      } catch (error) {
        this.lastError = `Failed to prepare bundled runtime: ${error instanceof Error ? error.message : String(error)}`;
        this.state = 'error';
        throw new Error(this.lastError);
      }
    }

    await this.ensureSpawnTargetAvailable();

    this.state = 'starting';
    this.source = 'managed';
    this.lastError = null;
    this.logTail = [];

    const child = await this.spawnManagedProcess();
    this.child = child;
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.lastError = this.formatExitMessage(code, signal);
      this.state = 'error';
      this.source = 'managed';
    });

    try {
      await this.waitForGatewayHealthy(child);
      this.noteReady();
    } catch (error) {
      await terminateChild(child);
      if (this.child === child) this.child = null;

      if (allowStartupRecovery && !this.hasExplicitBaseUrl && isPortConflictError(error)) {
        const previousBaseUrl = this.config.baseUrl;
        this.config = {
          ...this.config,
          baseUrl: `http://${DEFAULT_HOST}:${await allocatePort(DEFAULT_HOST)}`,
        };
        this.managedEndpointSelected = true;
        console.warn(
          `[hermes-supervisor] startup port conflict at ${previousBaseUrl}; `
          + `retrying once on ${this.config.baseUrl}`,
        );
        return this.startManagedInner(false);
      }

      if (error instanceof HermesGatewayAuthMismatchError && allowStartupRecovery && !this.hasExplicitBaseUrl) {
        const previousBaseUrl = this.config.baseUrl;
        this.config = {
          ...this.config,
          baseUrl: `http://${DEFAULT_HOST}:${await allocatePort(DEFAULT_HOST)}`,
          apiKey: createManagedApiServerKey(),
        };
        console.warn(
          `[hermes-supervisor] ${error.message} Retrying startup on ${this.config.baseUrl} `
          + `instead of trusting the process at ${previousBaseUrl}.`,
        );
        return this.startManagedInner(false);
      }
      throw error;
    }
  }

  private async ensureSpawnTargetAvailable(): Promise<void> {
    const target = new URL(this.config.baseUrl);
    const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));

    // The default URL is only a discovery/configuration fallback. Select a
    // unique endpoint before the first managed spawn so two Verso instances
    // cannot both observe 8642 as free and then race to bind it. Keep the
    // selected endpoint for normal restarts because OAuth callbacks depend on
    // the origin remaining stable for the lifetime of this supervisor.
    if (!this.hasExplicitBaseUrl && !this.managedEndpointSelected) {
      this.config = {
        ...this.config,
        baseUrl: `http://${DEFAULT_HOST}:${await allocatePort(DEFAULT_HOST)}`,
      };
      this.managedEndpointSelected = true;
      return;
    }

    if (await canBind(target.hostname, port)) {
      return;
    }

    if (!this.hasExplicitBaseUrl) {
      const port = await allocatePort(DEFAULT_HOST);
      this.config = { ...this.config, baseUrl: `http://${DEFAULT_HOST}:${port}` };
      this.managedEndpointSelected = true;
      return;
    }

    this.lastError = [
      `Configured Hermes gateway URL is already in use: ${this.config.baseUrl}.`,
      'Refusing to reuse an external process in managed mode.',
    ].join(' ');
    throw new Error(this.lastError);
  }

  private async spawnManagedProcess(): Promise<ChildProcess> {
    const customModel = this.customModelProviderStore.get();
    const customModelApiKey = customModel?.usesApiKey
      ? await this.customModelKeychain.getSecret(customModel.id)
      : null;
    this.ensureManagedHermesHome(!customModel?.usesApiKey || Boolean(customModelApiKey));
    const gatewayUrl = new URL(this.config.baseUrl);
    const port = gatewayUrl.port || (gatewayUrl.protocol === 'https:' ? '443' : '80');
    const host = gatewayUrl.hostname;
    const bundled = getBundledHermesInvocation();
    const pythonEnv = bundled ? bundledPythonEnv(bundled) : {};
    const customConnectorEnv: Record<string, string> = {};
    for (const connector of this.customConnectorsStore.list()) {
      if (connector.auth !== 'bearer') continue;
      const token = await this.customConnectorKeychain.getSecret(connector.id);
      if (token) customConnectorEnv[`VERSO_CC_${connector.id}_TOKEN`] = token;
    }
    const browserCdpUrl = this.browserRuntime?.cdpUrl() ?? null;

    const env = {
      ...buildHermesInheritedEnvironment(),
      ...pythonEnv,
      ...customConnectorEnv,
      ...(customModelApiKey ? { [CUSTOM_MODEL_KEY_ENV]: customModelApiKey } : {}),
      PATH: [
        fileURLToPath(new URL('../../node_modules/.bin/', import.meta.url)),
        dirname(process.execPath),
        process.env.PATH,
      ]
        .filter(Boolean)
        .join(delimiter),
      PORT: port,
      HOST: host,
      HERMES_PORT: port,
      HERMES_HOST: host,
      API_SERVER_ENABLED: 'true',
      API_SERVER_HOST: host,
      API_SERVER_PORT: port,
      ...(this.config.apiKey ? { API_SERVER_KEY: this.config.apiKey } : {}),
      HERMES_HOME: this.managedHermesHome,
      VERSO_HERMES_GATEWAY_URL: this.config.baseUrl,
      ...(this.orchestratorBaseUrl ? { VERSO_ORCHESTRATOR_BASE_URL: this.orchestratorBaseUrl } : {}),
      ...(browserCdpUrl ? { BROWSER_CDP_URL: browserCdpUrl } : {}),
      VERSO_BROWSER_LAZY_LAUNCH: browserCdpUrl ? '1' : '',
    };
    const runnerPath = fileURLToPath(new URL('./hermes-child-runner.mjs', import.meta.url));
    const child = spawn(process.execPath, [runnerPath], {
      cwd: this.launch.cwd ?? process.cwd(),
      env: {
        ...env,
        VERSO_HERMES_CHILD_COMMAND: this.launch.command ?? '',
        VERSO_HERMES_CHILD_ARGS: JSON.stringify(this.launch.args),
        VERSO_HERMES_CHILD_CWD: this.launch.cwd ?? '',
      },
      // 4th stdio slot opens an IPC channel so the child can detect parent
      // death via `process.on('disconnect')` instead of polling `ppid` once
      // per second. Saves a CPU wakeup every second on idle/sleep.
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.captureLog('stdout', chunk));
    child.stderr?.on('data', (chunk: string) => this.captureLog('stderr', chunk));

    return child;
  }

  private ensureManagedHermesHome(customModelAvailable = true): void {
    this.managedProfile.prepare(this.orchestratorBaseUrl, customModelAvailable);
  }

  private captureLog(stream: 'stdout' | 'stderr', chunk: string): void {
    const lines = chunk
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `[hermes ${stream}] ${line}`);

    if (lines.length === 0) return;

    this.logTail.push(...lines);
    if (this.logTail.length > 40) {
      this.logTail.splice(0, this.logTail.length - 40);
    }
    for (const line of lines) {
      console.log(line);
    }
  }

  private formatExitMessage(code: number | null, signal: NodeJS.Signals | null): string {
    const details = this.formatDiagnosticLogDetails();
    if (signal) {
      return `Hermes process exited on signal ${signal}.${details}`;
    }
    if (code === 0) {
      return `Hermes gateway stopped unexpectedly (process exit code 0).${details}`;
    }
    return `Hermes process exited with code ${code ?? 'unknown'}.${details}`;
  }

  private formatDiagnosticLogDetails(): string {
    if (this.logTail.length === 0) return '';

    // Hermes prints its banner to stdout after some startup failures. A plain
    // tail therefore hid the actual stderr error and showed only ASCII art in
    // the UI. Preserve the most useful failure lines alongside the last few
    // lines of context, without duplicating entries that are already recent.
    const diagnostic = this.logTail
      .filter((line) => /\[hermes stderr\].*(?:error|failed|failure|conflict|could not|traceback|exception)/i.test(line))
      .slice(-3);
    const recent = this.logTail.slice(-3);
    const selected = [...new Set([...diagnostic, ...recent])];
    return ` Recent logs: ${selected.join(' | ')}`;
  }

  private async waitForGatewayHealthy(child: ChildProcess): Promise<void> {
    const deadline = Date.now() + this.launch.startupTimeoutMs;

    while (Date.now() < deadline) {
      if (hasExited(child)) {
        throw new Error(this.formatExitMessage(child.exitCode, child.signalCode));
      }
      const probe = await this.probeGateway(500);
      if (probe === 'ready') {
        return;
      }
      if (probe === 'unauthorized') {
        throw new HermesGatewayAuthMismatchError(this.config.baseUrl);
      }
      await delay(250);
    }

    const details = this.formatDiagnosticLogDetails();
    this.lastError = `Timed out waiting for Hermes gateway at ${this.config.baseUrl}.${details}`;
    this.state = 'error';
    throw new Error(this.lastError);
  }

  private async ping(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    return await this.probeGateway(timeoutMs, signal) === 'ready';
  }

  private async probeGateway(timeoutMs: number, signal?: AbortSignal): Promise<HermesGatewayProbe> {
    const signals = [AbortSignal.timeout(timeoutMs), signal].filter(Boolean) as AbortSignal[];
    try {
      const res = await fetch(`${this.config.baseUrl}/v1/models`, {
        method: 'GET',
        headers: hermesGatewayAuthHeaders(this.config),
        signal: AbortSignal.any(signals),
      });
      if (res.ok) return 'ready';
      return res.status === 401 ? 'unauthorized' : 'unreachable';
    } catch {
      return 'unreachable';
    }
  }
}

function isPortConflictError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes('eaddrinuse')
    || message.includes('address already in use')
    || message.includes('port already in use')
    || /port\s+\d+\s+already\s+in\s+use/.test(message)
    || message.includes('startup conflict');
}
