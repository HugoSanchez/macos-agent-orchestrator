import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { json, route, type Route } from './router.ts';
import type { HermesSupervisor } from './hermes-supervisor.ts';
import { bundledPythonEnv } from './hermes-runtime-config.ts';
import { getBundledHermesInvocation } from './runtime-bootstrap.ts';

export interface HubSkillSummary {
  identifier: string;
  name: string;
  slug: string;
  description: string;
  source: string;
  trustLevel: string;
  repo: string | null;
  path: string | null;
  tags: string[];
  installed: boolean;
}

export interface HubSkillDetail extends HubSkillSummary {
  content: string;
  rawContent: string;
  files: string[];
}

export interface HubSkillInstallResult {
  installed: boolean;
  changed: boolean;
  skill: {
    name: string;
    source: string;
    identifier: string;
    trustLevel: string;
    scanVerdict: string;
    contentHash: string;
    installPath: string;
    files: string[];
    installedAt: string | null;
    updatedAt: string | null;
  } | null;
  message: string;
  output: string;
}

interface HubListResponse {
  skills: HubSkillSummary[];
  sourceCounts: Record<string, number>;
  timedOutSources: string[];
  query: string;
  source: string;
}

const HUB_QUERY_TIMEOUT_MS = 45_000;
const DEFAULT_HUB_LIMIT = 100;
const MAX_HUB_LIMIT = 250;

export function buildSkillsHubRoutes(hermes: HermesSupervisor): Route[] {
  return [
    route('GET', '/skills/hub', async (_req, res, params) => {
      const query = typeof params.query === 'string' ? params.query : '';
      const source = typeof params.source === 'string' ? params.source : 'all';
      const limit = clampInt(params.limit, DEFAULT_HUB_LIMIT, 1, MAX_HUB_LIMIT);
      const result = await queryHubSkills(hermes, { query, source, limit });
      json(res, 200, result);
    }),

    route('GET', '/skills/hub/:slug', async (_req, res, params) => {
      const result = await inspectHubSkill(hermes, params.slug);
      json(res, 200, result);
    }),

    route('POST', '/skills/hub/:slug/install', async (_req, res, params) => {
      const result = await installHubSkill(hermes, params.slug);
      if (!result.installed) {
        return json(res, 409, {
          error: 'install_failed',
          message: result.message,
          output: result.output,
        });
      }
      json(res, 200, result);
    }),
  ];
}

async function inspectHubSkill(
  hermes: HermesSupervisor,
  identifier: string,
): Promise<{ skill: HubSkillDetail }> {
  return runHubHelper(hermes, { action: 'inspect', identifier }) as Promise<{ skill: HubSkillDetail }>;
}

async function queryHubSkills(
  hermes: HermesSupervisor,
  request: { query: string; source: string; limit: number },
): Promise<HubListResponse> {
  return runHubHelper(hermes, request) as Promise<HubListResponse>;
}

async function installHubSkill(
  hermes: HermesSupervisor,
  identifier: string,
): Promise<HubSkillInstallResult> {
  return runHubHelper(hermes, {
    action: 'install',
    identifier,
  }) as Promise<HubSkillInstallResult>;
}

async function runHubHelper(
  hermes: HermesSupervisor,
  request: Record<string, unknown>,
): Promise<unknown> {
  const invocation = buildPythonInvocation(hermes);
  if (!invocation) {
    throw new Error('Hermes Python environment is not configured; cannot query Skills Hub.');
  }

  const helperPath = fileURLToPath(new URL('./skills-hub-helper.py', import.meta.url));
  const child = spawn(invocation.command, [helperPath], {
    cwd: hermes.launchCwd ?? process.cwd(),
    env: {
      ...process.env,
      ...invocation.env,
      HERMES_HOME: hermes.hermesHome,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const timeout = setTimeout(() => {
    child.kill('SIGTERM');
  }, HUB_QUERY_TIMEOUT_MS);

  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(JSON.stringify(request));

  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  }).finally(() => clearTimeout(timeout));

  const rawStdout = Buffer.concat(stdout).toString('utf8').trim();
  const rawStderr = Buffer.concat(stderr).toString('utf8').trim();

  if (code !== 0) {
    throw new Error(rawStderr || `Skills Hub query exited with code ${code ?? 'unknown'}`);
  }

  try {
    return JSON.parse(rawStdout) as unknown;
  } catch {
    throw new Error(`Skills Hub returned invalid JSON${rawStderr ? `: ${rawStderr}` : ''}`);
  }
}

function buildPythonInvocation(hermes: HermesSupervisor): { command: string; env: Record<string, string> } | null {
  const bundled = getBundledHermesInvocation();
  if (bundled) {
    return {
      command: bundled.python,
      env: {
        ...bundledPythonEnv(bundled),
        ...optionalSkillsEnv(),
      },
    };
  }

  const localBundled = fallbackLocalBundledPython();
  if (localBundled) {
    return {
      command: localBundled.python,
      env: {
        ...bundledPythonEnv(localBundled),
        ...optionalSkillsEnv(),
      },
    };
  }

  const python = process.env.VERSO_HERMES_PYTHON?.trim() || process.env.PYTHON?.trim() || 'python3.11';
  const pythonPath = [
    hermes.launchCwd,
    fallbackHermesSourceDir(),
    process.env.PYTHONPATH,
  ].filter(Boolean).join(':');

  return {
    command: python,
    env: {
      ...(pythonPath ? { PYTHONPATH: pythonPath } : {}),
      ...optionalSkillsEnv(),
    },
  };
}

function fallbackLocalBundledPython(): { python: string; sitePackages: string } | null {
  const desktopRoot = fallbackDesktopRoot();
  if (!desktopRoot) return null;
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch;
  const python = join(desktopRoot, 'runtime-bundles', 'python', arch, 'python', 'bin', 'python3.11');
  const sitePackages = join(desktopRoot, 'runtime-bundles', 'site-packages', arch, 'site-packages');
  return existsSync(python) && existsSync(sitePackages) ? { python, sitePackages } : null;
}

function optionalSkillsEnv(): Record<string, string> {
  if (process.env.HERMES_OPTIONAL_SKILLS?.trim()) return {};
  const fallback = fallbackHermesSourceDir();
  if (!fallback) return {};
  const optional = join(fallback, 'optional-skills');
  return existsSync(optional) ? { HERMES_OPTIONAL_SKILLS: optional } : {};
}

function fallbackHermesSourceDir(): string | null {
  const desktopRoot = fallbackDesktopRoot();
  if (!desktopRoot) return null;
  const candidate = join(desktopRoot, 'runtime-bundles', 'hermes-agent');
  return existsSync(candidate) ? candidate : null;
}

function fallbackDesktopRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, '..', '..', '..');
  return existsSync(join(candidate, 'runtime-bundles')) ? candidate : null;
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}
