import { existsSync, readFileSync } from 'node:fs';

export interface ComposioManifestSummary {
  exists: boolean;
  valid: boolean;
  toolCount: number;
  nonVersoToolCount: number;
  /** Distinct non-Verso toolkit slugs (lowercased, sorted). */
  toolkitSlugs: string[];
  generatedAt: string | null;
}

export function readComposioManifestSummary(manifestPath: string): ComposioManifestSummary {
  const summary: ComposioManifestSummary = {
    exists: false,
    valid: false,
    toolCount: 0,
    nonVersoToolCount: 0,
    toolkitSlugs: [],
    generatedAt: null,
  };
  if (!existsSync(manifestPath)) return summary;
  summary.exists = true;

  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      version?: unknown;
      generatedAt?: unknown;
      tools?: unknown;
    };
    if (parsed.version !== 1 || !Array.isArray(parsed.tools)) return summary;
    summary.valid = true;
    summary.generatedAt = typeof parsed.generatedAt === 'string' ? parsed.generatedAt : null;
    summary.toolCount = parsed.tools.length;
    const toolkits = new Set<string>();
    for (const tool of parsed.tools) {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) continue;
      const toolkitSlug = (tool as Record<string, unknown>).toolkitSlug;
      if (typeof toolkitSlug !== 'string') continue;
      const normalized = toolkitSlug.trim().toLowerCase();
      if (!normalized || normalized === 'verso') continue;
      summary.nonVersoToolCount += 1;
      toolkits.add(normalized);
    }
    summary.toolkitSlugs = [...toolkits].sort();
    return summary;
  } catch {
    return summary;
  }
}

/**
 * A manifest counts as usable only when it exposes at least one real
 * connected-app tool. Verso's own synthetic entries don't count: a
 * draft-only manifest is a degraded state and must not shadow a good one.
 */
export function hasUsableComposioManifest(manifestPath: string): boolean {
  const summary = readComposioManifestSummary(manifestPath);
  return summary.valid && summary.nonVersoToolCount > 0;
}

interface ComposioManifestLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface ComposioManifestCoordinatorOptions {
  manifestPath: string;
  getActiveToolkitSlugs: () => string[];
  refreshNativeToolManifest: (activeToolkitSlugs: string[]) => Promise<void>;
  writeFallbackManifest: (manifestPath: string, activeToolkitSlugs: string[]) => void;
  restartHermes: () => Promise<void>;
  logger?: ComposioManifestLogger;
}

/**
 * Keeps the on-disk native-tool manifest and the toolkits registered in the
 * running Hermes MCP bridge in sync. Hermes snapshots the manifest when it
 * starts, so a successful refresh that changes the toolkit set requires a
 * restart. Optimistic registration coalesces identical refreshes while that
 * restart is pending; a failed restart rolls it back so a later refresh can
 * retry.
 */
export class ComposioManifestCoordinator {
  private readonly logger: ComposioManifestLogger;
  private registeredToolkits: Set<string> | null = null;
  private restartChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: ComposioManifestCoordinatorOptions) {
    this.logger = options.logger ?? console;
  }

  async refresh(): Promise<void> {
    const activeToolkits = this.options.getActiveToolkitSlugs();
    try {
      await this.options.refreshNativeToolManifest(activeToolkits);
      this.handleSuccessfulRefresh();
    } catch (error) {
      this.logger.warn(
        `[composio-tools] native manifest refresh failed; writing learned-tools fallback: ${errorMessage(error)}`,
      );
      if (hasUsableComposioManifest(this.options.manifestPath)) return;

      const currentActiveToolkits = this.options.getActiveToolkitSlugs();
      this.options.writeFallbackManifest(this.options.manifestPath, currentActiveToolkits);
      if (currentActiveToolkits.length > 0 && !hasUsableComposioManifest(this.options.manifestPath)) {
        this.logger.error(
          `[composio-tools] manifest at ${this.options.manifestPath} has no connected-app tools while ${currentActiveToolkits.length} toolkit(s) are active — the model's connected-app tool surface is broken until a refresh succeeds`,
        );
      }
    }
  }

  /** Capture the toolkit set Hermes is about to register from disk. */
  captureRegisteredManifest(): void {
    this.registeredToolkits = new Set(
      readComposioManifestSummary(this.options.manifestPath).toolkitSlugs,
    );
  }

  needsManifestBeforeHermesStart(): boolean {
    return this.options.getActiveToolkitSlugs().length > 0
      && !hasUsableComposioManifest(this.options.manifestPath);
  }

  /** Test/cleanup hook; refresh itself intentionally does not wait on restarts. */
  waitForPendingRestarts(): Promise<void> {
    return this.restartChain;
  }

  private handleSuccessfulRefresh(): void {
    const summary = readComposioManifestSummary(this.options.manifestPath);
    const activeCount = this.options.getActiveToolkitSlugs().length;
    if (summary.nonVersoToolCount === 0 && activeCount > 0) {
      this.logger.error(
        `[composio-tools] manifest refresh succeeded but ${this.options.manifestPath} has no connected-app tools while ${activeCount} toolkit(s) are active — the model's connected-app tool surface is broken`,
      );
      return;
    }
    if (this.registeredToolkits === null) return;

    const current = new Set(summary.toolkitSlugs);
    const registered = this.registeredToolkits;
    if (setsEqual(current, registered)) return;

    this.registeredToolkits = current;
    this.logger.warn(
      `[composio-tools] connected-app toolkits changed (now: ${[...current].sort().join(', ') || 'none'}); restarting Hermes so the MCP bridge re-registers native tools`,
    );
    this.restartChain = this.restartChain
      .then(() => this.options.restartHermes())
      .catch((error: unknown) => {
        if (this.registeredToolkits === current) {
          this.registeredToolkits = registered;
        }
        this.logger.error(
          `[composio-tools] Hermes restart after toolkit change failed: ${errorMessage(error)}`,
        );
      });
  }
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
