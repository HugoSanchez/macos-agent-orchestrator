import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { delimiter, join } from 'node:path';
import { getBundledHermesInvocation } from './runtime-bootstrap.ts';

export interface HermesGatewayConfig {
  baseUrl: string;
  startupTimeoutMs: number;
  apiKey: string | null;
}

export interface HermesLaunchConfig {
  command: string | null;
  args: string[];
  cwd: string | null;
  startupTimeoutMs: number;
}

export const HERMES_DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8642;
const DEFAULT_STARTUP_TIMEOUT_MS = 90_000;

export function getHermesGatewayConfig(): HermesGatewayConfig {
  const baseUrl = normalizeHermesBaseUrl(
    process.env.VERSO_HERMES_GATEWAY_URL?.trim() || `http://${HERMES_DEFAULT_HOST}:${DEFAULT_PORT}`,
  );
  return {
    baseUrl,
    startupTimeoutMs: getHermesStartupTimeoutMs(),
    apiKey: getHermesApiServerKey(),
  };
}

export function getHermesLaunchConfig(): HermesLaunchConfig {
  const startupTimeoutMs = getHermesStartupTimeoutMs();
  const cwd = process.env.VERSO_HERMES_CWD?.trim() || null;
  if (isHermesManagedDisabled()) {
    return { command: null, args: [], cwd, startupTimeoutMs };
  }

  const bundled = getBundledHermesInvocation();
  if (bundled) {
    return {
      command: bundled.python,
      args: [bundled.hermesScript, 'gateway', 'run', '--replace'],
      cwd,
      startupTimeoutMs,
    };
  }

  const override = process.env.VERSO_HERMES_COMMAND?.trim();
  const command = override || detectInstalledHermesCommand();
  return {
    command,
    args: command === override
      ? parseLaunchArgs(process.env.VERSO_HERMES_ARGS)
      : ['gateway', 'run', '--replace'],
    cwd,
    startupTimeoutMs,
  };
}

export function normalizeHermesBaseUrl(rawBaseUrl: string): string {
  return rawBaseUrl.replace(/\/+$/, '');
}

export function isHermesManagedDisabled(): boolean {
  const managed = process.env.VERSO_HERMES_MANAGED?.trim().toLowerCase();
  return managed === '0' || managed === 'false' || managed === 'no';
}

export function createManagedApiServerKey(): string {
  return randomBytes(32).toString('hex');
}

export function bundledPythonEnv(bundled: { sitePackages: string }): Record<string, string> {
  return {
    ...getBundledPythonBytecodeEnv(),
    PYTHONPATH: [bundled.sitePackages, process.env.PYTHONPATH].filter(Boolean).join(':'),
  };
}

function getHermesStartupTimeoutMs(): number {
  const rawStartupTimeout = parseInt(
    process.env.VERSO_HERMES_STARTUP_TIMEOUT_MS || String(DEFAULT_STARTUP_TIMEOUT_MS),
    10,
  );
  return Number.isFinite(rawStartupTimeout) && rawStartupTimeout > 0
    ? rawStartupTimeout
    : DEFAULT_STARTUP_TIMEOUT_MS;
}

function getHermesApiServerKey(): string | null {
  const versoOverride = process.env.VERSO_HERMES_API_SERVER_KEY?.trim() || null;
  if (!isHermesManagedDisabled()) return versoOverride || createManagedApiServerKey();
  return versoOverride || process.env.API_SERVER_KEY?.trim() || null;
}

function parseLaunchArgs(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) return [];
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')) {
      return parsed;
    }
  } catch {
    // Fall through to a simple whitespace split for convenience.
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

function detectInstalledHermesCommand(): string | null {
  const home = process.env.HOME?.trim();
  const candidates = [
    home ? join(home, '.local', 'bin', 'hermes') : null,
    home ? join(home, '.hermes', 'hermes-agent', 'venv', 'bin', 'hermes') : null,
    findExecutableOnPath('hermes'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function findExecutableOnPath(name: string): string | null {
  for (const entry of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(entry, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function getBundledPythonBytecodeEnv(): Record<string, string> {
  const cachePrefix = process.env.VERSO_PYTHON_CACHE_DIR?.trim()
    || join(os.homedir(), 'Library', 'Caches', 'Verso', 'python-bytecode');
  try {
    mkdirSync(cachePrefix, { recursive: true });
  } catch {
    // Python can run without bytecode caches; never write into the app bundle.
  }
  return {
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPYCACHEPREFIX: cachePrefix,
  };
}
