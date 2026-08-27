import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { readJsonFileOr, writeJsonFileAtomic } from '../shared/atomic-json-file.ts';
import { allocatePort, canBind, delay, hasExited, terminateChild } from '../hermes/hermes-process-utils.ts';

const execFileAsync = promisify(execFile);

// Mirrors Hermes's own local-Chrome detection list (hermes_cli/browser_connect.py
// _DARWIN_APPS) so both sides agree on what counts as a usable browser.
const DARWIN_BROWSER_APPS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

interface BrowserHostState {
  pid: number | null;
  binary: string | null;
  port: number | null;
}

interface BrowserHostStatus {
  supported: boolean;
  enabled: boolean;
  running: boolean;
}

interface BrowserHostOptions {
  /** Directory holding the profile dir and the pidfile. Defaults to the app data dir. */
  baseDir?: string;
  /** Override the browser binary (tests point this at a fake). */
  binary?: string | null;
  logger?: Pick<Console, 'info' | 'warn'>;
}

function defaultBaseDir(): string {
  return process.env.VERSO_BROWSER_DATA_ROOT?.trim()
    || path.join(os.homedir(), 'Library', 'Application Support', 'verso');
}

function decodeState(value: unknown): BrowserHostState {
  const record = (value ?? {}) as Record<string, unknown>;
  return {
    pid: typeof record.pid === 'number' && Number.isInteger(record.pid) && record.pid > 0
      ? record.pid
      : null,
    binary: typeof record.binary === 'string' ? record.binary : null,
    port: typeof record.port === 'number'
      && Number.isInteger(record.port)
      && record.port > 0
      && record.port <= 65_535
      ? record.port
      : null,
  };
}

function inactiveState(port: number | null = null): BrowserHostState {
  return { pid: null, binary: null, port };
}

/**
 * Owns the one Chromium instance the agent browses with. The profile directory
 * is dedicated to agent work (never the user's personal browser profile), and
 * doubles as the feature flag: it exists once the user has opened the agent
 * browser at least once. Hermes attaches over CDP (BROWSER_CDP_URL); this class
 * never speaks to Hermes directly.
 */
export class BrowserHost {
  readonly profileDir: string;
  private readonly stateFile: string;
  private readonly binaryOverride: string | null | undefined;
  private readonly logger: Pick<Console, 'info' | 'warn'>;

  private child: ChildProcess | null = null;
  private headless = false;
  private port: number | null = null;
  private startPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: BrowserHostOptions = {}) {
    const baseDir = options.baseDir ?? defaultBaseDir();
    this.profileDir = path.join(baseDir, 'agent-browser-profile');
    this.stateFile = path.join(baseDir, 'agent-browser-host.json');
    this.binaryOverride = options.binary;
    this.logger = options.logger ?? console;
  }

  private resolveBinary(): string | null {
    if (this.binaryOverride !== undefined) return this.binaryOverride;
    return DARWIN_BROWSER_APPS.find((candidate) => existsSync(candidate)) ?? null;
  }

  /** The feature is on once the dedicated profile exists. */
  isEnabled(): boolean {
    return existsSync(this.profileDir);
  }

  isRunning(): boolean {
    return this.child !== null && !hasExited(this.child);
  }

  /**
   * Loopback CDP endpoint for Hermes's child env. The port survives a stopped
   * browser so Hermes can request a lazy launch before its first browser tool
   * call, rather than forcing Chrome to start with the app.
   */
  cdpUrl(): string | null {
    if (!this.isEnabled() || !this.resolveBinary()) return null;
    const port = this.port ?? readJsonFileOr(this.stateFile, decodeState, inactiveState).port;
    return port === null ? null : `http://127.0.0.1:${port}`;
  }

  status(): BrowserHostStatus {
    return {
      supported: this.resolveBinary() !== null,
      enabled: this.isEnabled(),
      running: this.isRunning(),
    };
  }

  /** Coalesced start; creates the profile on first use. */
  ensureStarted(): Promise<void> {
    return this.start(true);
  }

  private start(headless: boolean): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise.then(() => this.start(headless));
    if (this.isRunning()) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startOnce(headless).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  /** Reserve Hermes' stable CDP endpoint without launching Chrome. */
  async prepareCdpEndpoint(): Promise<void> {
    if (!this.isEnabled() || !this.resolveBinary() || this.port !== null) return;
    await this.sweepStaleProcess();
    const persisted = readJsonFileOr(this.stateFile, decodeState, inactiveState).port;
    this.port = persisted !== null && await canBind('127.0.0.1', persisted)
      ? persisted
      : await allocatePort('127.0.0.1');
    writeJsonFileAtomic(this.stateFile, inactiveState(this.port));
  }

  /** Activate the dedicated browser after an explicit user action. */
  async open(): Promise<void> {
    await this.startPromise?.catch(() => undefined);
    if (this.isRunning() && this.headless) await this.shutdown();
    await this.start(false);
    const binary = this.resolveBinary();
    if (!binary) throw new Error('No Chromium-family browser installed.');
    const forwarder = spawn(binary, [`--user-data-dir=${this.profileDir}`, 'about:blank'], {
      stdio: 'ignore',
      detached: true,
    });
    await once(forwarder, 'spawn');
    forwarder.unref();
  }

  /** Stop the browser and delete the profile (signs out of everything). */
  async reset(): Promise<void> {
    await this.shutdown();
    rmSync(this.profileDir, { recursive: true, force: true });
    rmSync(this.stateFile, { force: true });
    this.port = null;
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      await this.startPromise?.catch(() => undefined);
      const child = this.child;
      if (child && !hasExited(child)) {
        try {
          await terminateChild(child);
        } catch (error) {
          this.logger.warn('[browser-host] browser did not exit cleanly:', error instanceof Error ? error.message : String(error));
        }
      }
      this.child = null;
      this.headless = false;
      if (this.isEnabled() || this.port !== null) {
        writeJsonFileAtomic(this.stateFile, inactiveState(this.port));
      }
    })().finally(() => {
      this.shutdownPromise = null;
    });
    return this.shutdownPromise;
  }

  /**
   * Kill a browser left over from a previous orchestrator run (crash path).
   * Only signals a process whose command line matches both the recorded binary
   * and our profile dir — PIDs get recycled, so a bare pidfile is not identity.
   */
  async sweepStaleProcess(): Promise<void> {
    const state = readJsonFileOr(this.stateFile, decodeState, inactiveState);
    if (!state.pid) return;
    const command = await processCommand(state.pid);
    const ours = command !== null
      && state.binary !== null
      && command.includes(state.binary)
      && command.includes(`--user-data-dir=${this.profileDir}`);
    if (ours) {
      this.logger.warn(`[browser-host] killing stale agent browser pid ${state.pid} from previous run`);
      try {
        process.kill(state.pid, 'SIGTERM');
        await delay(1_500);
        if (await processCommand(state.pid) !== null) process.kill(state.pid, 'SIGKILL');
      } catch {
        // Already gone between the check and the signal.
      }
    }
    writeJsonFileAtomic(this.stateFile, inactiveState(state.port));
  }

  private async startOnce(headless = true): Promise<void> {
    const binary = this.resolveBinary();
    if (!binary) throw new Error('No Chromium-family browser installed.');

    mkdirSync(this.profileDir, { recursive: true });
    await this.prepareCdpEndpoint();
    ensureProfilePreferences(this.profileDir);
    const port = this.port;
    if (port === null) throw new Error('Could not reserve an agent browser port.');

    const args = [
      `--user-data-dir=${this.profileDir}`,
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-startup-window',
      '--hide-crash-restore-bubble',
      '--disable-session-crashed-bubble',
      ...(headless ? ['--headless=new'] : []),
    ];
    const child = spawn(binary, args, { stdio: 'ignore' });
    this.child = child;
    this.headless = headless;
    child.once('exit', () => this.handleUnexpectedExit(child));

    try {
      await once(child, 'spawn');
      writeJsonFileAtomic(this.stateFile, {
        pid: child.pid ?? null,
        binary,
        port,
      } satisfies BrowserHostState);
      await this.awaitReady(child, port);
    } catch (error) {
      if (!hasExited(child)) {
        try {
          await terminateChild(child);
        } catch {
          // Readiness failure is the error worth reporting.
        }
      }
      this.child = null;
      this.headless = false;
      this.persistInactiveState(port);
      throw error;
    }

    this.logger.info(`[browser-host] agent browser ready on 127.0.0.1:${port} (pid ${child.pid})`);
  }

  private async awaitReady(child: ChildProcess, port: number): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (hasExited(child)) throw new Error('Agent browser exited during startup.');
      if (await this.cdpResponds(port) && await this.portOwnedByChild(child, port)) return;
      await delay(250);
    }
    throw new Error('Agent browser did not become ready within 15s.');
  }

  private async cdpResponds(port: number): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Never adopt a foreign CDP endpoint: the listener must be our child. */
  private async portOwnedByChild(child: ChildProcess, port: number): Promise<boolean> {
    if (!child.pid) return false;
    try {
      const { stdout } = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
      const owners = stdout.split('\n').map((line) => parseInt(line.trim(), 10)).filter(Number.isFinite);
      return owners.includes(child.pid);
    } catch {
      // lsof exits 1 when nothing listens yet; treat as not-ready, not error.
      return false;
    }
  }

  private handleUnexpectedExit(child: ChildProcess): void {
    if (this.child !== child) return;
    this.child = null;
    this.headless = false;
    if (this.shutdownPromise) return;
    // Chrome belongs to the user while it is visible. Do not turn a manual
    // quit into an app-level respawn loop; the next browser tool call starts it
    // again through the sidecar's explicit lazy-launch route.
    this.persistInactiveState(this.port);
  }

  private persistInactiveState(port: number | null): void {
    try {
      writeJsonFileAtomic(this.stateFile, inactiveState(port));
    } catch (error) {
      this.logger.warn('[browser-host] could not persist browser state:', error instanceof Error ? error.message : String(error));
    }
  }
}

/**
 * Reconcile the profile's Preferences before every launch (merging, so user
 * prefs accumulated in the profile survive):
 *
 * - Password manager off: the whole design keeps Verso out of credential
 *   custody, so the agent profile must not offer to save passwords.
 * - Session restore off + previous exit marked clean: a respawn (after the
 *   user quits the browser, or a crash) must come back WINDOWLESS. Without
 *   this, Chrome "helpfully" reopens the windows from the previous run in
 *   front of whatever the user is doing. Windows may only ever appear from
 *   an explicit user open or an agent navigation in an active chat.
 */
function ensureProfilePreferences(profileDir: string): void {
  const prefsPath = path.join(profileDir, 'Default', 'Preferences');
  mkdirSync(path.dirname(prefsPath), { recursive: true });
  const prefs = readJsonFileOr(
    prefsPath,
    (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}),
    () => ({} as Record<string, unknown>),
  );
  prefs.credentials_enable_service = false;
  const profile = (prefs.profile && typeof prefs.profile === 'object' && !Array.isArray(prefs.profile))
    ? prefs.profile as Record<string, unknown>
    : {};
  profile.password_manager_enabled = false;
  profile.exit_type = 'Normal';
  profile.exited_cleanly = true;
  prefs.profile = profile;
  const session = (prefs.session && typeof prefs.session === 'object' && !Array.isArray(prefs.session))
    ? prefs.session as Record<string, unknown>
    : {};
  // 5 = "open the New Tab Page", i.e. never restore the previous session.
  session.restore_on_startup = 5;
  prefs.session = session;
  writeJsonFileAtomic(prefsPath, prefs);
}

async function processCommand(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command=']);
    const command = stdout.trim();
    return command.length > 0 ? command : null;
  } catch {
    return null;
  }
}
