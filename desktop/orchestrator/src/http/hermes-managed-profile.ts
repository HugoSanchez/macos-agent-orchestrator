import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { RuntimeMode } from '../integrations/runtime-mode.ts';
import { getBundledHermesInvocation, getBundledPython } from './runtime-bootstrap.ts';
import { bundledPythonEnv } from './hermes-runtime-config.ts';
import { isMemoryEnabled } from './lexical-provider.ts';
import { applyMemorySoulSection, applySecuritySoulSection } from './memory-soul.ts';
import { computePinnedToolNames } from './hermes-pinned-tools.ts';
import { ANTHROPIC_CHAT_MODELS, CODEX_CHAT_MODELS } from './model-catalog.ts';
import { readAnthropicKeyFromEnvFile } from './model-auth.ts';
import { CustomConnectorsStore } from './custom-connectors-store.ts';

const LEGACY_DEFAULT_SOUL_MD = '# Verso\n\nYou are a helpful research assistant running inside the Verso macOS app.\n';

// Skills the user must never be able to enable. They overlap with — and
// would conflict with — the verso/Composio bridge or shell out to local
// CLIs in ways we don't support. Hidden from the UI and force-added to
// `skills.disabled` on every launch.
export const ALWAYS_DISABLED_HERMES_SKILLS: readonly string[] = [
  'google-workspace',
  'himalaya',
];

// First-party Hermes skills that teach use of shell CLIs or direct provider
// SDKs (gh, notion, etc.). We disable them so all third-party access flows
// through the verso/Composio bridge. Unlike ALWAYS_DISABLED, these are seeded
// once per profile migration — users can re-enable them via the UI.
const DEFAULT_DISABLED_HERMES_SKILLS = [
  ...ALWAYS_DISABLED_HERMES_SKILLS,
  'notion',
  'linear',
  'github-auth',
  'github-repo-management',
  'github-pr-workflow',
  'github-code-review',
  'github-issues',
];
const DEFAULT_DISABLED_SKILLS_MARKER = '.verso-default-disabled-skills-v1';

export interface HermesManagedProfileOptions {
  templateHome: string;
  managedHome: string;
  runtimeMode: RuntimeMode;
  memoryToolsMode: 'full' | 'none';
  customConnectorsStore: CustomConnectorsStore;
  /** Current agent-browser policy; read at each prepare() so toggles land on the next spawn. */
  browserRuntime?: { allowPrivateUrls(): boolean };
}

/**
 * Owns the on-disk profile Verso presents to a managed Hermes gateway.
 *
 * The supervisor owns the process and authenticated endpoint lifecycle. This
 * class owns the complementary persistent transaction: seed/migrate a profile,
 * remove stale transport overrides, and reconcile the config with Verso's
 * current model, tool, connector, and memory policy before each spawn.
 */
export class HermesManagedProfile {
  private readonly templateHome: string;
  private readonly managedHome: string;
  private readonly runtimeMode: RuntimeMode;
  private readonly memoryToolsMode: 'full' | 'none';
  private readonly customConnectorsStore: CustomConnectorsStore;
  private readonly browserRuntime: { allowPrivateUrls(): boolean } | null;

  constructor(options: HermesManagedProfileOptions) {
    this.templateHome = options.templateHome;
    this.managedHome = options.managedHome;
    this.runtimeMode = options.runtimeMode;
    this.memoryToolsMode = options.memoryToolsMode;
    this.customConnectorsStore = options.customConnectorsStore;
    this.browserRuntime = options.browserRuntime ?? null;
  }

  get composioToolsManifestPath(): string {
    return join(this.managedHome, 'verso-composio-tools.json');
  }

  prepare(orchestratorBaseUrl: string | null): void {
    this.migrateLegacyVervoProfile();
    mkdirSync(this.managedHome, { recursive: true });
    const configExistedBeforeSeed = existsSync(join(this.managedHome, 'config.yaml'));
    seedHermesHomeFile(this.templateHome, this.managedHome, 'config.yaml');
    seedHermesHomeFile(this.templateHome, this.managedHome, '.env');
    seedHermesHomeFile(this.templateHome, this.managedHome, 'auth.json');
    this.syncManagedAuthStore();
    seedHermesHomeFile(this.templateHome, this.managedHome, 'SOUL.md');
    seedHermesHomeFile(this.templateHome, this.managedHome, 'memories/MEMORY.md');
    seedHermesHomeFile(this.templateHome, this.managedHome, 'memories/USER.md');
    this.syncManagedSoulSections(isMemoryEnabled() && this.memoryToolsMode !== 'none');
    this.syncVersoSkill();
    this.configureManagedMcpServers(orchestratorBaseUrl);
    this.configureBrowserRuntime();
    this.configureModelRoutes();
    this.restoreManagedModelConfigIfProxyOwned();
    this.seedDefaultDisabledSkillsIfNeeded(configExistedBeforeSeed);
    this.enforceAlwaysDisabledSkills();
  }

  private syncVersoSkill(): void {
    const targetPath = join(this.managedHome, 'skills', 'verso', 'verso-composio', 'SKILL.md');
    if (process.env.VERSO_ENABLE_COMPOSIO_SKILL?.trim() !== '1') {
      rmSync(targetPath, { force: true });
      return;
    }

    const sourceDir = resolveVersoSkillSourceDir();
    if (!sourceDir) return;
    const sourcePath = join(sourceDir, 'SKILL.md');
    if (!existsSync(sourcePath)) return;
    if (existsSync(targetPath)) {
      try {
        if (statSync(targetPath).mtimeMs >= statSync(sourcePath).mtimeMs) return;
      } catch {
        // Fall through to re-copy.
      }
    }
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }

  private configureBrowserRuntime(): void {
    const configPath = join(this.managedHome, 'config.yaml');
    const config = readYamlRecord(configPath) ?? {};
    const browser = asRecord(config.browser) ?? {};
    const allowPrivateUrls = this.browserRuntime?.allowPrivateUrls() === true;
    // restrict_evaluate is upstream's own recommendation for agents driving a
    // logged-in profile: it blocks cookie/storage/clipboard/form-value reads
    // through browser_console(expression=...). allow_private_urls is the
    // user's opt-in for reaching self-hosted tools on localhost/RFC1918.
    if (browser.restrict_evaluate === true && browser.allow_private_urls === allowPrivateUrls) return;
    browser.restrict_evaluate = true;
    browser.allow_private_urls = allowPrivateUrls;
    config.browser = browser;
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, YAML.stringify(config), 'utf8');
  }

  private syncManagedAuthStore(): void {
    const sourcePath = join(this.templateHome, 'auth.json');
    const targetPath = join(this.managedHome, 'auth.json');
    if (sourcePath === targetPath || !existsSync(sourcePath)) return;

    const sourceAuth = readJsonRecord(sourcePath);
    if (!isModernHermesAuthStore(sourceAuth)) return;

    const targetAuth = readJsonRecord(targetPath);
    if (isModernHermesAuthStore(targetAuth)) {
      try {
        if (statSync(targetPath).mtimeMs >= statSync(sourcePath).mtimeMs) return;
      } catch {
        return;
      }
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }

  private enforceAlwaysDisabledSkills(): void {
    this.mergeDisabledSkills(ALWAYS_DISABLED_HERMES_SKILLS);
  }

  private mergeDisabledSkills(names: readonly string[]): void {
    const configPath = join(this.managedHome, 'config.yaml');
    const config = readYamlRecord(configPath) ?? {};
    const skills = asRecord(config.skills) ?? {};
    const existing = Array.isArray(skills.disabled)
      ? skills.disabled.filter((item): item is string => typeof item === 'string')
      : [];
    const existingSet = new Set(existing);
    if (names.every((name) => existingSet.has(name))) return;

    skills.disabled = [...new Set([...existing, ...names])].sort();
    config.skills = skills;
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, YAML.stringify(config), 'utf8');
  }

  private seedDefaultDisabledSkillsIfNeeded(configExistedBeforeSeed: boolean): void {
    const markerPath = join(this.managedHome, DEFAULT_DISABLED_SKILLS_MARKER);
    if (configExistedBeforeSeed && existsSync(markerPath)) return;

    this.mergeDisabledSkills(DEFAULT_DISABLED_HERMES_SKILLS);
    writeFileSync(markerPath, `${new Date().toISOString()}\n`, 'utf8');
  }

  private migrateLegacyVervoProfile(): void {
    if (process.env.VERSO_HERMES_HOME?.trim()) return;
    if (existsSync(this.managedHome)) return;
    const legacy = join(this.managedHome, '..', 'vervo');
    if (!existsSync(legacy)) return;
    try {
      renameSync(legacy, this.managedHome);
    } catch {
      // Let the following mkdir create a fresh profile.
    }
  }

  private configureModelRoutes(): void {
    const configPath = join(this.managedHome, 'config.yaml');
    if (!existsSync(configPath)) return;

    const config = readYamlRecord(configPath) ?? {};
    const hasAnthropic = readAnthropicKeyFromEnvFile(this.managedHome) !== null;
    const hasCodex = this.hasCodexPoolCredentials();
    const platforms = asRecord(config.platforms) ?? {};
    const apiServer = asRecord(platforms.api_server) ?? {};
    const extra = asRecord(apiServer.extra) ?? {};
    const routes = asRecord(extra.model_routes) ?? {};

    const removedManagedGatewayOverrides = ['host', 'port', 'key']
      .filter((field) => Object.hasOwn(extra, field));
    for (const field of removedManagedGatewayOverrides) delete extra[field];
    if (removedManagedGatewayOverrides.length > 0) {
      console.warn(
        '[hermes-supervisor] removed persisted managed gateway override(s): '
        + removedManagedGatewayOverrides.join(', '),
      );
    }

    for (const model of CODEX_CHAT_MODELS) {
      if (hasCodex) routes[model] = { model, provider: 'openai-codex' };
      else delete routes[model];
    }
    for (const model of ANTHROPIC_CHAT_MODELS) {
      if (hasAnthropic) routes[model] = { model, provider: 'anthropic' };
      else delete routes[model];
    }

    if (Object.keys(routes).length > 0) extra.model_routes = routes;
    else delete extra.model_routes;
    apiServer.extra = extra;
    platforms.api_server = apiServer;
    config.platforms = platforms;

    const modelCfg = asRecord(config.model);
    if (modelCfg && hasCodex) {
      const defaultModel = typeof modelCfg.default === 'string' ? modelCfg.default : '';
      const provider = typeof modelCfg.provider === 'string' ? modelCfg.provider : '';
      const baseUrl = typeof modelCfg.base_url === 'string' ? modelCfg.base_url : '';
      const codexBackend = provider === 'openai-codex' || baseUrl.includes('chatgpt.com');
      if (codexBackend && defaultModel.startsWith('claude-')) {
        modelCfg.default = CODEX_CHAT_MODELS[0];
        config.model = modelCfg;
      }
    }

    writeFileSync(configPath, YAML.stringify(config), 'utf8');
  }

  private hasCodexPoolCredentials(): boolean {
    try {
      const parsed = JSON.parse(readFileSync(join(this.managedHome, 'auth.json'), 'utf8')) as {
        credential_pool?: Record<string, unknown[]>;
      };
      const pool = parsed.credential_pool?.['openai-codex'];
      return Array.isArray(pool) && pool.length > 0;
    } catch {
      return false;
    }
  }

  private restoreManagedModelConfigIfProxyOwned(): void {
    if (this.runtimeMode !== 'managed') return;

    const configPath = join(this.managedHome, 'config.yaml');
    if (!existsSync(configPath)) return;
    const config = readYamlRecord(configPath) ?? {};
    const currentModel = asRecord(config.model);
    const baseUrl = typeof currentModel?.base_url === 'string' ? currentModel.base_url : '';
    const provider = typeof currentModel?.provider === 'string' ? currentModel.provider : '';
    if (provider !== 'custom' || !baseUrl.endsWith('/llm/v1')) return;

    const templateModel = asRecord(readYamlRecord(join(this.templateHome, 'config.yaml'))?.model);
    if (templateModel) config.model = templateModel;
    else delete config.model;
    writeFileSync(configPath, YAML.stringify(config), 'utf8');
  }

  private configureManagedMcpServers(orchestratorBaseUrl: string | null): void {
    const configPath = join(this.managedHome, 'config.yaml');
    if (!existsSync(configPath)) return;

    const config = readYamlRecord(configPath) ?? {};
    const mcpServers = asRecord(config.mcp_servers) ?? {};
    delete mcpServers.vervo;
    for (const key of Object.keys(mcpServers)) {
      if (key.startsWith('custom_')) delete mcpServers[key];
    }

    const memoryToolsActive = isMemoryEnabled() && this.memoryToolsMode !== 'none';
    if (orchestratorBaseUrl) {
      const pythonPath = resolveHermesPython(this.templateHome);
      const serverPath = resolveVersoMcpServerPath();
      if (pythonPath && serverPath) {
        const bundled = getBundledHermesInvocation();
        const env: Record<string, string> = {
          VERSO_ORCHESTRATOR_BASE_URL: orchestratorBaseUrl,
          VERSO_COMPOSIO_TOOLS_MANIFEST: this.composioToolsManifestPath,
        };
        const sidecarAuthSecret = process.env.VERSO_SIDECAR_AUTH_SECRET?.trim();
        if (sidecarAuthSecret) env.VERSO_SIDECAR_AUTH_SECRET = sidecarAuthSecret;
        if (bundled) Object.assign(env, bundledPythonEnv(bundled));
        if (memoryToolsActive) env.VERSO_MEMORY_TOOLS = 'full';
        mcpServers.verso = {
          command: pythonPath,
          args: [serverPath],
          env,
          timeout: 120,
          connect_timeout: 60,
        };
      }
    }

    delete mcpServers.composio;
    for (const connector of this.customConnectorsStore.list()) {
      const entry: Record<string, unknown> = {
        url: connector.url,
        timeout: 120,
        connect_timeout: 30,
      };
      if (connector.transport === 'sse') entry.transport = 'sse';
      if (connector.auth === 'oauth') entry.auth = 'oauth';
      if (connector.auth === 'bearer') {
        entry.headers = { Authorization: `Bearer \${VERSO_CC_${connector.id}_TOKEN}` };
      }
      mcpServers[`custom_${connector.slug}`] = entry;
    }

    const tools = asRecord(config.tools) ?? {};
    const toolSearch = asRecord(tools.tool_search) ?? {};
    tools.tool_search = {
      ...toolSearch,
      enabled: 'on',
      pinned: computePinnedToolNames(this.composioToolsManifestPath, {
        includeMemoryTools: memoryToolsActive,
      }),
    };
    config.mcp_servers = mcpServers;
    config.tools = tools;
    writeFileSync(configPath, YAML.stringify(config), 'utf8');
  }

  private syncManagedSoulSections(memoryEnabled: boolean): void {
    const soulPath = join(this.managedHome, 'SOUL.md');
    try {
      const current = existsSync(soulPath) ? readFileSync(soulPath, 'utf8') : '';
      const secured = applySecuritySoulSection(current);
      const next = applyMemorySoulSection(secured, memoryEnabled);
      if (next !== current) writeFileSync(soulPath, next, 'utf8');
    } catch (error: unknown) {
      console.warn(
        `[profile] SOUL.md managed section sync failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export function getTemplateHermesHome(): string {
  return process.env.VERSO_BUNDLED_DEFAULTS?.trim()
    || process.env.HERMES_HOME?.trim()
    || join(os.homedir(), '.hermes');
}

export function getVersoHermesHome(templateHome: string, runtimeMode: RuntimeMode): string {
  const override = process.env.VERSO_HERMES_HOME?.trim();
  if (override) return override;
  const profileName = runtimeMode === 'managed' ? 'verso' : `verso-${runtimeMode}`;
  return join(resolveHermesRoot(templateHome), 'profiles', profileName);
}

function resolveHermesRoot(home: string): string {
  const profilesMarker = `${sep}profiles${sep}`;
  const index = home.lastIndexOf(profilesMarker);
  return index >= 0 ? home.slice(0, index) : home;
}

function resolveHermesPython(templateHome: string): string | null {
  const bundledPython = getBundledPython();
  if (bundledPython && existsSync(bundledPython)) return bundledPython;
  const candidate = join(resolveHermesRoot(templateHome), 'hermes-agent', 'venv', 'bin', 'python');
  return existsSync(candidate) ? candidate : null;
}

function resolveVersoMcpServerPath(): string | null {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidate = join(currentDir, '..', '..', 'mcp', 'verso_server.py');
  return existsSync(candidate) ? candidate : null;
}

function resolveVersoSkillSourceDir(): string | null {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidate = join(currentDir, '..', '..', 'skills', 'verso-composio');
  return existsSync(candidate) ? candidate : null;
}

function seedHermesHomeFile(sourceHome: string, targetHome: string, fileName: string): void {
  const sourcePath = join(sourceHome, fileName);
  const targetPath = join(targetHome, fileName);
  if (!existsSync(sourcePath)) return;
  if (existsSync(targetPath) && !shouldRefreshManagedFile(sourcePath, targetPath, fileName)) return;
  mkdirSync(dirname(targetPath), { recursive: true });
  copyFileSync(sourcePath, targetPath);
}

function shouldRefreshManagedFile(sourcePath: string, targetPath: string, fileName: string): boolean {
  if (fileName === 'SOUL.md') return shouldRefreshDefaultSoul(sourcePath, targetPath);
  if (fileName !== 'auth.json') return false;
  try {
    return statSync(sourcePath).mtimeMs > statSync(targetPath).mtimeMs;
  } catch {
    return false;
  }
}

function shouldRefreshDefaultSoul(sourcePath: string, targetPath: string): boolean {
  try {
    const source = readFileSync(sourcePath, 'utf8');
    const target = readFileSync(targetPath, 'utf8');
    return target.trim() === LEGACY_DEFAULT_SOUL_MD.trim() && source.trim() !== target.trim();
  } catch {
    return false;
  }
}

function readYamlRecord(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = YAML.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readJsonRecord(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isModernHermesAuthStore(value: Record<string, unknown> | null): boolean {
  return Boolean(
    value
    && typeof value.active_provider === 'string'
    && asRecord(value.providers)
    && asRecord(value.credential_pool),
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
