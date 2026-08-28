import { spawn, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, route, type Route } from '../http/router.ts';
import { ANTHROPIC_CHAT_MODELS } from './model-catalog.ts';
import type { HermesSupervisor } from '../hermes/hermes-supervisor.ts';

const execFile = promisify(execFileCb);

const PROVIDER = 'openai-codex';
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const VERIFICATION_URL_PATTERN = /https?:\/\/auth\.openai\.com\/codex\/device\S*/;
const USER_CODE_PATTERN = /\b([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/;

interface CodexStatus {
  connected: boolean;
  count: number;
}

// How long a cached Codex status is served without kicking a background
// re-check. Status changes only through this service's own login/disconnect
// flows (which invalidate the cache), so staleness only matters for out-of-
// band `hermes auth` edits — those converge after one stale serve.
const CODEX_STATUS_FRESH_MS = 15_000;

export class CodexAuthService {
  // The uncached path spawns the bundled-Python Hermes CLI (~1-3s cold
  // start). Without a cache that spawn sat on every app load and on every
  // new chat's default-model lookup.
  private statusCache: { status: CodexStatus; at: number } | null = null;
  private statusInFlight: Promise<CodexStatus> | null = null;

  constructor(private readonly hermes: HermesSupervisor) {}

  private resolveInvocation(args: readonly string[]): {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    cwd: string | null;
  } {
    const invocation = this.hermes.invoke(args);
    if (!invocation) {
      throw new Error('Hermes command is not configured. Set VERSO_HERMES_COMMAND or install hermes locally.');
    }
    return {
      command: invocation.command,
      args: invocation.args,
      env: { ...this.env(), ...invocation.env },
      cwd: this.hermes.launchCwd,
    };
  }

  private env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HERMES_HOME: this.hermes.hermesHome,
      // Python block-buffers stdout when stdout is a pipe rather than a
      // TTY. Without this the device-code prompt sits in the buffer until
      // the subprocess exits, so we'd never see the user_code in time to
      // render the prompt event. Forcing line-buffered output is mandatory.
      PYTHONUNBUFFERED: '1',
      // Hermes uses ANSI escape codes for color emphasis; we strip them
      // anyway, but disabling color also shortens the parsed lines.
      NO_COLOR: '1',
      CLICOLOR: '0',
    };
  }

  async getStatus(): Promise<CodexStatus> {
    const cached = this.statusCache;
    if (cached) {
      // Stale-while-revalidate: serve instantly, re-check in the background
      // once the fresh window lapses. Login/disconnect invalidate directly.
      if (Date.now() - cached.at > CODEX_STATUS_FRESH_MS) {
        void this.fetchStatus().catch(() => undefined);
      }
      return cached.status;
    }
    return this.fetchStatus();
  }

  private fetchStatus(): Promise<CodexStatus> {
    if (this.statusInFlight) return this.statusInFlight;
    this.statusInFlight = (async () => {
      let status: CodexStatus;
      try {
        const invocation = this.resolveInvocation(['auth', 'list', PROVIDER]);
        const { stdout } = await execFile(invocation.command, invocation.args, {
          env: invocation.env,
          cwd: invocation.cwd ?? undefined,
          timeout: 10_000,
        });
        const stripped = stdout.replace(ANSI_PATTERN, '');
        const match = stripped.match(/\((\d+)\s+credentials?\)/);
        const count = match ? parseInt(match[1], 10) : 0;
        status = { connected: count > 0, count };
      } catch {
        status = { connected: false, count: 0 };
      }
      this.statusCache = { status, at: Date.now() };
      return status;
    })().finally(() => {
      this.statusInFlight = null;
    });
    return this.statusInFlight;
  }

  // Repeatedly remove credential #1 until the pool is empty. Cheaper than
  // parsing every label/id, and matches the only mutation the UI offers
  // ("disconnect" = forget everything).
  async disconnect(): Promise<{ removed: number }> {
    let removed = 0;
    for (let i = 0; i < 20; i++) {
      // Mutation loop needs live reads — bypass the status cache.
      const status = await this.fetchStatus();
      if (status.count === 0) break;
      const invocation = this.resolveInvocation(['auth', 'remove', PROVIDER, '1']);
      try {
        await execFile(invocation.command, invocation.args, {
          env: invocation.env,
          cwd: invocation.cwd ?? undefined,
          timeout: 10_000,
        });
        removed++;
      } catch {
        break;
      }
    }
    return { removed };
  }

  // Spawns `hermes auth add openai-codex --type oauth --no-browser` and
  // streams its lifecycle as SSE. The child prints the device URL + user
  // code, then blocks polling OpenAI. When the child exits 0, the
  // credentials are already saved to ~/.hermes/auth.json and the gateway
  // will pick them up on its next request.
  startLogin(req: IncomingMessage, res: ServerResponse): void {
    let invocation: ReturnType<CodexAuthService['resolveInvocation']>;
    try {
      invocation = this.resolveInvocation(['auth', 'add', PROVIDER, '--type', 'oauth', '--no-browser']);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      writeSseHeaders(res);
      sendEvent(res, { type: 'error', message });
      res.end();
      return;
    }

    writeSseHeaders(res);

    const child = spawn(invocation.command, invocation.args, {
      env: invocation.env,
      cwd: invocation.cwd ?? undefined,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const state = { url: null as string | null, code: null as string | null };
    let promptSent = false;
    let errorMessage: string | null = null;
    let stderrTail = '';

    function maybeEmitPrompt(): void {
      if (promptSent) return;
      if (state.url && state.code) {
        promptSent = true;
        sendEvent(res, { type: 'prompt', url: state.url, code: state.code });
      }
    }

    function parseLine(line: string): void {
      const clean = line.replace(ANSI_PATTERN, '').trim();
      if (!clean) return;
      if (!state.url) {
        const m = clean.match(VERIFICATION_URL_PATTERN);
        if (m) state.url = m[0];
      }
      if (!state.code) {
        const m = clean.match(USER_CODE_PATTERN);
        if (m) state.code = m[1];
      }
      maybeEmitPrompt();
    }

    let stdoutBuffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) parseLine(line);
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      // Keep the last ~2KB so we can surface a meaningful error if the
      // child fails before reaching the prompt.
      stderrTail = (stderrTail + chunk).slice(-2048);
    });

    child.on('error', (err) => {
      errorMessage = err instanceof Error ? err.message : String(err);
    });

    let closed = false;
    const closeOnce = (): void => {
      if (closed) return;
      closed = true;
      res.end();
    };

    child.on('close', async (code) => {
      if (stdoutBuffer.length > 0) parseLine(stdoutBuffer);
      if (code === 0) {
        // Hermes's `auth add openai-codex` only writes credentials — it
        // leaves config.yaml alone. The interactive `hermes model` flow
        // (`main.py:2350`) does the second step, calling
        // `_update_config_for_provider("openai-codex", DEFAULT_CODEX_BASE_URL)`
        // to set provider + base_url + default_model. Without that, the
        // gateway keeps trying the bundled default (claude-opus-4.6),
        // hits "no credentials," and returns errors that surface as the
        // Codex-connect widget — a misleading loop where the user keeps
        // reconnecting Codex but nothing changes.
        //
        // We invoke the same internal Hermes function here. Failure is
        // logged but non-fatal — auth itself succeeded, the user can
        // recover by editing config manually if needed.
        await applyCodexModelConfig(this.hermes).catch((err) => {
          console.error('[codex-auth] post-auth config update failed:', err instanceof Error ? err.message : err);
        });
        // Credentials just changed on disk — drop the cached status so the
        // UI's follow-up status fetch reflects the new connection.
        this.statusCache = null;
        sendEvent(res, { type: 'connected' });
      } else {
        const message = errorMessage
          ?? stderrTail.replace(ANSI_PATTERN, '').trim().split(/\r?\n/).pop()
          ?? `hermes auth add exited with code ${code ?? 'unknown'}`;
        sendEvent(res, { type: 'error', message });
      }
      closeOnce();
    });

    // If the UI closes the EventSource (modal dismissed, navigated away),
    // kill the subprocess so we don't leave a 15-minute poller orphaned.
    req.on('close', () => {
      if (!child.killed && child.exitCode === null) {
        child.kill('SIGTERM');
      }
      closeOnce();
    });
  }
}

// ---------------------------------------------------------------------------
// Anthropic (API-key provider)
//
// Unlike Codex (OAuth device flow via `hermes auth add`), Anthropic is an
// api_key-type provider in Hermes. The runtime resolver reads the key from
// `<HERMES_HOME>/.env` ANTHROPIC_API_KEY (the credential-pool path is
// OAuth-only — see agent/anthropic_adapter.py resolve_anthropic_token), so
// "connect" means: validate the key live, persist it via Hermes's own
// rotation-safe writer, point config.yaml at the anthropic provider, and
// restart the gateway (it loads .env into its environment only at startup).
// ---------------------------------------------------------------------------

const ANTHROPIC_ENV_VAR = 'ANTHROPIC_API_KEY';
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
// Written as model.default when the key is connected.
const DEFAULT_ANTHROPIC_MODEL: string = ANTHROPIC_CHAT_MODELS[0];

interface AnthropicStatus {
  connected: boolean;
}

export class AnthropicAuthService {
  constructor(
    private readonly hermes: HermesSupervisor,
    // True when a Codex credential exists — used on disconnect to hand the
    // default provider back to Codex instead of leaving a dangling
    // provider:anthropic config with no key.
    private readonly hasCodexCredentials: () => Promise<boolean>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getStatus(): Promise<AnthropicStatus> {
    return { connected: this.readStoredKey() !== null };
  }

  async connect(apiKey: string): Promise<{ gatewayReady: boolean }> {
    const key = apiKey.trim();
    if (!key || /\s/.test(key)) {
      throw new AnthropicAuthError(400, 'API key must be a single non-empty token.');
    }
    await this.validateKey(key);
    await this.runHermesPython(
      'import os; '
      + 'from hermes_cli.credential_lifecycle import save_provider_env_credential; '
      + 'from hermes_cli.auth import _update_config_for_provider; '
      + `save_provider_env_credential("${ANTHROPIC_ENV_VAR}", os.environ["VERSO_PENDING_ANTHROPIC_KEY"]); `
      + `_update_config_for_provider("anthropic", "${ANTHROPIC_BASE_URL}", default_model="${DEFAULT_ANTHROPIC_MODEL}"); `
      + forceDefaultModelScript(DEFAULT_ANTHROPIC_MODEL),
      { VERSO_PENDING_ANTHROPIC_KEY: key },
    );
    return { gatewayReady: await this.restartGateway() };
  }

  async disconnect(): Promise<{ gatewayReady: boolean }> {
    // Clearing = writing an empty value; the resolver treats "" as absent.
    // Same idiom Hermes itself uses (config.py save_env_value("ANTHROPIC_TOKEN", "")).
    let script =
      'from hermes_cli.config import save_env_value; '
      + `save_env_value("${ANTHROPIC_ENV_VAR}", "")`;
    if (await this.hasCodexCredentials()) {
      script += '; from hermes_cli.auth import _update_config_for_provider, DEFAULT_CODEX_BASE_URL'
        + `; _update_config_for_provider("openai-codex", DEFAULT_CODEX_BASE_URL, default_model="${DEFAULT_CODEX_MODEL}")`
        + '; ' + forceDefaultModelScript(DEFAULT_CODEX_MODEL);
    }
    await this.runHermesPython(script);
    return { gatewayReady: await this.restartGateway() };
  }

  // .env and model_routes are read at gateway startup; a running gateway
  // never re-reads them (reload_env() has no callers). The chat layer
  // rebuilds conversation history from its own store after a restart, so a
  // restart is safe mid-session. A slow cold boot must NOT fail the request
  // though — by this point the credential change is already persisted and
  // correct; the gateway just needs time to warm up. Report readiness so
  // the caller can surface it, but never throw.
  private async restartGateway(): Promise<boolean> {
    try {
      await this.hermes.restart();
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[anthropic-auth] gateway restart still warming:', message);
      return false;
    }
  }

  // Reads <HERMES_HOME>/.env directly. Mirrors the presence check the
  // supervisor uses for model_routes so status and routing can't disagree.
  private readStoredKey(): string | null {
    return readAnthropicKeyFromEnvFile(this.hermes.hermesHome);
  }

  private async validateKey(key: string): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${ANTHROPIC_BASE_URL}/v1/models`, {
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AnthropicAuthError(502, `Could not reach the Anthropic API to verify the key: ${message}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new AnthropicAuthError(401, 'Anthropic rejected this API key. Check the key and try again.');
    }
    if (!res.ok) {
      throw new AnthropicAuthError(502, `Anthropic API returned HTTP ${res.status} while verifying the key.`);
    }
  }

  // The secret travels via the child's environment, never argv (argv is
  // visible to `ps`) and never the script text (which may end up in logs).
  private async runHermesPython(script: string, extraEnv: Record<string, string> = {}): Promise<void> {
    const invocation = this.hermes.invoke([]);
    if (!invocation) {
      throw new AnthropicAuthError(500, 'Hermes is not configured; cannot update credentials.');
    }
    await execFile(invocation.command, ['-c', script], {
      env: {
        ...process.env,
        ...invocation.env,
        ...extraEnv,
        HERMES_HOME: this.hermes.hermesHome,
        PYTHONUNBUFFERED: '1',
      },
      timeout: 30_000,
    });
  }
}

export class AnthropicAuthError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

// _update_config_for_provider deliberately preserves an existing
// model.default unless it is empty or OpenRouter-formatted ("vendor/model"),
// so switching providers can leave e.g. provider=anthropic with
// default=gpt-5.4 — every unrouted request (crons, side tasks) would then
// send the wrong model name to the new provider. Force the default
// explicitly using Hermes's own atomic config writer.
function forceDefaultModelScript(defaultModel: string): string {
  return 'from hermes_cli.config import get_config_path, read_raw_config; '
    + 'from utils import atomic_yaml_write; '
    + '_cfg = read_raw_config(); '
    + '_m = _cfg.get("model") if isinstance(_cfg.get("model"), dict) else {}; '
    + `_m["default"] = "${defaultModel}"; `
    + '_cfg["model"] = _m; '
    + 'atomic_yaml_write(get_config_path(), _cfg, sort_keys=False)';
}

// Minimal .env line parse: KEY=value with optional single/double quotes.
// Only used for a presence check, so nuances of full dotenv escaping don't
// matter — Hermes's own save_env_value writes plain or simply-quoted values.
export function readAnthropicKeyFromEnvFile(hermesHome: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(join(hermesHome, '.env'), 'utf8');
  } catch {
    return null;
  }
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const value = match[1].trim().replace(/^(["'])(.*)\1$/, '$2').trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

// Default Codex model to write into config.yaml after a successful auth.
// Keep this aligned with the managed entitlement returned by the Verso backend;
// gpt-5.5 can silently hang on accounts that are only entitled for gpt-5.4.
const DEFAULT_CODEX_MODEL = 'gpt-5.4';

// Bridge to Hermes's own _update_config_for_provider helper — the
// canonical way to mutate config.yaml after an auth flow. We invoke it
// via the bundled python (or whatever python the supervisor's invoke()
// returns) so we don't duplicate Hermes's YAML-writing logic.
async function applyCodexModelConfig(hermes: HermesSupervisor): Promise<void> {
  const invocation = hermes.invoke([]);
  if (!invocation) {
    throw new Error('Hermes is not configured; cannot update model config.');
  }
  const py = invocation.command;
  const script =
    'from hermes_cli.auth import _update_config_for_provider, DEFAULT_CODEX_BASE_URL; '
    + `_update_config_for_provider("openai-codex", DEFAULT_CODEX_BASE_URL, default_model="${DEFAULT_CODEX_MODEL}")`;

  await execFile(py, ['-c', script], {
    env: {
      ...process.env,
      ...invocation.env,
      HERMES_HOME: hermes.hermesHome,
      PYTHONUNBUFFERED: '1',
    },
    timeout: 30_000,
  });
}

function writeSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  // Push initial headers so the client opens the connection immediately
  // even if the first parseable line takes a couple of seconds.
  res.write(': open\n\n');
}

function sendEvent(res: ServerResponse, data: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function buildModelAuthRoutes(service: CodexAuthService, anthropic: AnthropicAuthService): Route[] {
  return [
    route('GET', '/model-auth/codex/status', async (_req, res) => {
      const status = await service.getStatus();
      json(res, 200, status);
    }),

    route('GET', '/model-auth/codex/start', async (req, res) => {
      service.startLogin(req, res);
    }),

    route('POST', '/model-auth/codex/disconnect', async (_req, res) => {
      const result = await service.disconnect();
      json(res, 200, result);
    }),

    route('GET', '/model-auth/anthropic/status', async (_req, res) => {
      const status = await anthropic.getStatus();
      json(res, 200, status);
    }),

    route('POST', '/model-auth/anthropic/connect', async (_req, res, _params, body) => {
      const apiKey = (body as { apiKey?: unknown } | null)?.apiKey;
      if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
        json(res, 400, { error: 'bad_request', message: 'Missing apiKey' });
        return;
      }
      try {
        const result = await anthropic.connect(apiKey);
        json(res, 200, { connected: true, ...result });
      } catch (error: unknown) {
        if (error instanceof AnthropicAuthError) {
          json(res, error.status, { error: 'anthropic_auth_failed', message: error.message });
          return;
        }
        throw error;
      }
    }),

    route('POST', '/model-auth/anthropic/disconnect', async (_req, res) => {
      const result = await anthropic.disconnect();
      json(res, 200, { connected: false, ...result });
    }),
  ];
}
