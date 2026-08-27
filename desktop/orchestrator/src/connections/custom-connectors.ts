import { createReadStream, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { json, route, type Route } from '../http/router.ts';
import { renderCallbackPage, sendHtml } from './connections.ts';
import { CustomConnectorsStore, sanitizeCustomConnectorSlug, type CustomConnectorRecord } from './custom-connectors-store.ts';
import { CustomConnectorKeychain } from './keychain.ts';
import { probeMcpServer } from './mcp-probe.ts';
import { countCustomConnectorTools, fetchRegisteredToolNames, hermesGatewayAuthHeaders } from '../hermes/hermes-gateway-client.ts';
import type { HermesSupervisor } from '../hermes/hermes-supervisor.ts';

export type CustomConnectorStatus =
  | { state: 'connected'; toolCount: number; cached?: true }
  | { state: 'pending_auth'; toolCount: 0 }
  | { state: 'failed'; toolCount: 0; reason: string };

export interface CustomConnectorView extends CustomConnectorRecord {
  status: CustomConnectorStatus;
}

export function buildCustomConnectorRoutes(
  store: CustomConnectorsStore,
  keychain: CustomConnectorKeychain,
  hermes: HermesSupervisor,
): Route[] {
  const service = new CustomConnectorService(store, keychain, hermes);
  return [
    route('GET', '/connectors/custom', async (_req, res) => {
      json(res, 200, { connectors: await service.list() });
    }),
    route('GET', '/connectors/custom/:id/icon', async (_req, res, params) => {
      await service.streamIcon(params.id, res);
    }),
    route('GET', '/connectors/custom/:id/open', async (_req, res, params) => {
      await service.openAuth(params.id, res);
    }),
    route('POST', '/connectors/custom', async (_req, res, _params, body) => {
      try {
        json(res, 201, { connector: await service.add(body) });
      } catch (error: unknown) {
        handleError(res, error);
      }
    }),
    route('DELETE', '/connectors/custom/:id', async (_req, res, params) => {
      await service.remove(params.id);
      res.writeHead(204);
      res.end();
    }),
    route('POST', '/connectors/custom/:id/retry', async (_req, res, params) => {
      try {
        json(res, 200, { connector: await service.retry(params.id) });
      } catch (error: unknown) {
        handleError(res, error);
      }
    }),
  ];
}

export class CustomConnectorService {
  // Last error reported by a gateway OAuth flow, per connector id. In-memory
  // only: it exists to explain a stuck "pending sign-in" state in the UI, and
  // a fresh launch (or a retry) should start clean.
  private readonly lastAuthErrors = new Map<string, string>();
  private readonly authWatchers = new Map<string, AbortController>();

  constructor(
    private readonly store: CustomConnectorsStore,
    private readonly keychain: CustomConnectorKeychain,
    private readonly hermes: HermesSupervisor,
    private readonly opts: {
      registrationDelayMs?: number;
      registrationAttempts?: number;
      authPollDelayMs?: number;
      authPollAttempts?: number;
    } = {},
  ) {}

  async list(): Promise<CustomConnectorView[]> {
    const registered = await fetchRegisteredToolNames(this.hermes.gatewayConfig);
    return this.store.list().map((record) => this.view(record, registered));
  }

  async add(body: unknown): Promise<CustomConnectorView> {
    const parsed = parseCreateBody(body);
    const slug = sanitizeCustomConnectorSlug(parsed.name);
    if (!slug) throw new HttpInputError('Connector name must include letters or numbers.');
    const probe = await probeMcpServer(parsed.url, { token: parsed.token });
    const auth = parsed.token ? 'bearer' : probe.auth;
    const record = this.store.create({
      name: parsed.name,
      slug,
      url: parsed.url,
      transport: probe.transport,
      auth,
      logoUrl: null,
      iconPath: probe.iconPath,
      iconContentType: probe.iconContentType,
    });
    const displayRecord = this.store.update(record.id, {
      logoUrl: probe.iconPath ? `/connectors/custom/${encodeURIComponent(record.id)}/icon` : null,
    });
    try {
      if (auth === 'bearer') await this.keychain.setSecret(record.id, parsed.token ?? '');
      await this.hermes.restart();
      return this.view(displayRecord, await this.waitForConnectorTools(displayRecord));
    } catch (error) {
      this.store.delete(record.id);
      await this.keychain.deleteSecret(record.id);
      throw error;
    }
  }

  async retry(id: string): Promise<CustomConnectorView> {
    const current = this.store.get(id);
    if (!current) throw new HttpInputError(`Unknown custom connector: ${id}`, 404);
    this.lastAuthErrors.delete(id);
    try {
      const token = current.auth === 'bearer' ? await this.keychain.getSecret(current.id) : null;
      const probe = await probeMcpServer(current.url, { token });
      const updated = this.store.update(id, {
        transport: probe.transport,
        auth: current.auth === 'bearer' ? 'bearer' : probe.auth,
        logoUrl: probe.iconPath ? `/connectors/custom/${encodeURIComponent(current.id)}/icon` : current.logoUrl,
        iconPath: probe.iconPath ?? current.iconPath ?? null,
        iconContentType: probe.iconContentType ?? current.iconContentType ?? null,
      });
      if (updated.auth === 'oauth') {
        // Sign-in runs through the gateway's OAuth flow (openAuth); the config
        // entry is unchanged, so a gateway restart buys nothing — and would tear
        // down the gateway that hosts the OAuth callback the user is about to
        // be redirected to. Report status as-is so the UI can open sign-in now.
        // Retry is an explicit request to start a fresh browser flow. Do not
        // hydrate this response from cached OAuth state or the UI would see
        // "connected" and skip opening the authorization URL.
        return viewFor(updated, await fetchRegisteredToolNames(this.hermes.gatewayConfig));
      }
      await this.hermes.restart();
      return this.view(updated, await this.waitForConnectorTools(updated));
    } catch (error: unknown) {
      // Surface the failure on the row itself — a silent 500 leaves the user
      // clicking Retry with nothing visibly happening.
      const message = customConnectorErrorMessage(error);
      this.lastAuthErrors.set(id, message);
      throw error;
    }
  }

  async openAuth(id: string, res: ServerResponse): Promise<void> {
    const record = this.store.get(id);
    if (!record || record.auth !== 'oauth') {
      json(res, 404, { error: 'not_found', message: 'This custom connector is not waiting for sign-in.' });
      return;
    }

    const result = await this.startGatewayOAuthFlow(record);
    if (result.kind === 'redirect') {
      this.lastAuthErrors.delete(record.id);
      this.authWatchers.get(record.id)?.abort();
      const controller = new AbortController();
      this.authWatchers.set(record.id, controller);
      void this.watchAuthFlow(record, result.flowId, controller.signal)
        .finally(() => {
          if (this.authWatchers.get(record.id) === controller) {
            this.authWatchers.delete(record.id);
          }
        });
      res.writeHead(302, { Location: result.url });
      res.end();
      return;
    }
    this.lastAuthErrors.set(record.id, result.message);
    sendHtml(res, 500, renderCallbackPage('Sign-in unavailable', result.message));
  }

  async remove(id: string): Promise<void> {
    this.authWatchers.get(id)?.abort();
    this.authWatchers.delete(id);
    this.lastAuthErrors.delete(id);
    const removed = this.store.delete(id);
    if (!removed) return;
    await this.keychain.deleteSecret(removed.id);
    removeHermesOAuthFiles(this.hermes.hermesHome, `custom_${removed.slug}`);
    await this.hermes.restart();
  }

  async streamIcon(id: string, res: ServerResponse): Promise<void> {
    const record = this.store.get(id);
    if (!record?.iconPath || !existsSync(record.iconPath)) {
      json(res, 404, { error: 'not_found', message: 'No icon for custom connector.' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': record.iconContentType || contentTypeForPath(record.iconPath),
      'Cache-Control': 'public, max-age=86400',
    });
    createReadStream(record.iconPath).pipe(res);
  }

  private async waitForConnectorTools(record: CustomConnectorRecord): Promise<string[] | null> {
    return waitForCustomConnectorTools(record, () => fetchRegisteredToolNames(this.hermes.gatewayConfig), {
      attempts: this.opts.registrationAttempts ?? 4,
      delayMs: this.opts.registrationDelayMs ?? 4_000,
    });
  }

  private view(record: CustomConnectorRecord, registered: string[] | null): CustomConnectorView {
    const liveToolCount = registered ? countCustomConnectorTools(registered, record.slug) : 0;
    let current = record;
    if (liveToolCount > 0 && record.lastKnownToolCount !== liveToolCount) {
      current = this.store.update(record.id, { lastKnownToolCount: liveToolCount });
    }
    const hasOAuthSession = current.auth === 'oauth'
      && hasHermesOAuthTokens(this.hermes.hermesHome, `custom_${current.slug}`);
    return viewFor(current, registered, this.lastAuthErrors.get(current.id), hasOAuthSession);
  }

  /**
   * Ask the gateway to start an MCP OAuth flow (routes added by the
   * verso-gateway-mcp-oauth runtime patch). The gateway runs the SDK flow
   * in-process and hands back the provider's authorization URL; the provider
   * later redirects straight to the gateway's own callback route.
   */
  private async startGatewayOAuthFlow(record: CustomConnectorRecord): Promise<
    | { kind: 'redirect'; url: string; flowId: string }
    | { kind: 'error'; message: string }
  > {
    const config = this.hermes.gatewayConfig;
    let res: Response;
    try {
      res = await fetch(`${config.baseUrl}/api/mcp/servers/${encodeURIComponent(`custom_${record.slug}`)}/auth`, {
        method: 'POST',
        headers: hermesGatewayAuthHeaders(config),
        // The gateway waits up to 30s for the provider to produce an
        // authorization URL (discovery + client registration).
        signal: AbortSignal.timeout(45_000),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { kind: 'error', message: `Could not reach the Hermes gateway to start sign-in: ${message}` };
    }
    const body = await res.json().catch(() => null) as
      | { flow_id?: string; status?: string; authorization_url?: string | null; error?: string | null }
      | null;
    if (!res.ok) {
      return { kind: 'error', message: body?.error || `The Hermes gateway returned ${res.status} starting sign-in.` };
    }
    if (body?.status === 'authorization_required' && typeof body.authorization_url === 'string' && body.flow_id) {
      return { kind: 'redirect', url: body.authorization_url, flowId: String(body.flow_id) };
    }
    return { kind: 'error', message: body?.error || 'Hermes did not produce an authorization URL.' };
  }

  /**
   * Follow a started flow to completion in the background. On approval the
   * gateway has already verified tokens and live-reconnected the MCP server;
   * a gateway restart is only the fallback when tools still don't register.
   */
  private async watchAuthFlow(record: CustomConnectorRecord, flowId: string, signal: AbortSignal): Promise<void> {
    const config = this.hermes.gatewayConfig;
    const delayMs = this.opts.authPollDelayMs ?? 5_000;
    const attempts = this.opts.authPollAttempts ?? 65; // Just beyond the SDK's five-minute callback window.
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!await abortableDelay(delayMs, signal)) return;
      let snapshot: { status?: string; error?: string | null } | null = null;
      try {
        const res = await fetch(`${config.baseUrl}/api/mcp/oauth/flows/${encodeURIComponent(flowId)}`, {
          headers: hermesGatewayAuthHeaders(config),
          signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
        });
        if (res.status === 404) {
          this.setAuthError(record, 'The sign-in session expired. Start the sign-in again.', signal);
          return;
        }
        if (!res.ok) continue;
        snapshot = await res.json() as { status?: string; error?: string | null };
      } catch {
        if (signal.aborted) return;
        continue; // transient — gateway restarting, etc.
      }
      if (snapshot?.status === 'approved') {
        this.lastAuthErrors.delete(record.id);
        try {
          await this.ensureConnectorTools(record);
        } catch (error: unknown) {
          this.setAuthError(
            record,
            `Sign-in completed, but the connector could not be activated: ${error instanceof Error ? error.message : String(error)}`,
            signal,
          );
        }
        return;
      }
      if (snapshot?.status === 'error') {
        this.setAuthError(record, snapshot.error || 'Sign-in failed.', signal);
        return;
      }
    }
    this.setAuthError(record, 'The sign-in session timed out. Start the sign-in again.', signal);
  }

  private async ensureConnectorTools(record: CustomConnectorRecord): Promise<void> {
    if (!this.store.get(record.id)) return;
    const registered = await fetchRegisteredToolNames(this.hermes.gatewayConfig);
    if (registered && countCustomConnectorTools(registered, record.slug) > 0) return;
    await this.hermes.restart();
    const refreshed = await waitForCustomConnectorTools(
      record,
      () => fetchRegisteredToolNames(this.hermes.gatewayConfig),
      {
        attempts: this.opts.registrationAttempts ?? 4,
        delayMs: this.opts.registrationDelayMs ?? 4_000,
        waitForOAuth: true,
      },
    );
    if (refreshed === null) {
      throw new Error('The Hermes gateway did not report its registered tools.');
    }
    if (countCustomConnectorTools(refreshed, record.slug) === 0) {
      throw new Error('The connector signed in, but Hermes registered no tools for it.');
    }
  }

  private setAuthError(record: CustomConnectorRecord, message: string, signal: AbortSignal): void {
    if (signal.aborted || !this.store.get(record.id)) return;
    this.lastAuthErrors.set(record.id, customConnectorErrorMessage(message));
  }
}

export async function waitForCustomConnectorTools(
  record: Pick<CustomConnectorRecord, 'slug' | 'auth'>,
  fetcher: () => Promise<string[] | null>,
  opts: { attempts: number; delayMs: number; delayFn?: (ms: number) => Promise<void>; waitForOAuth?: boolean },
): Promise<string[] | null> {
  let last: string[] | null = null;
  for (let attempt = 0; attempt < opts.attempts; attempt += 1) {
    if (attempt > 0) await (opts.delayFn ?? delay)(opts.delayMs);
    last = await fetcher();
    if (last === null) return null;
    if (countCustomConnectorTools(last, record.slug) > 0) return last;
    if (record.auth === 'oauth' && !opts.waitForOAuth) return last;
  }
  return last;
}

export function removeHermesOAuthFiles(hermesHome: string, serverName: string): void {
  const safe = safeHermesServerName(serverName);
  for (const suffix of ['.json', '.client.json', '.meta.json']) {
    rmSync(path.join(hermesHome, 'mcp-tokens', `${safe}${suffix}`), { force: true });
  }
}

export function hasHermesOAuthTokens(hermesHome: string, serverName: string): boolean {
  const tokenPath = path.join(hermesHome, 'mcp-tokens', `${safeHermesServerName(serverName)}.json`);
  try {
    const token = JSON.parse(readFileSync(tokenPath, 'utf8')) as Record<string, unknown>;
    const hasRefreshToken = typeof token.refresh_token === 'string' && token.refresh_token.length > 0;
    if (hasRefreshToken) return true;
    const hasAccessToken = typeof token.access_token === 'string' && token.access_token.length > 0;
    if (!hasAccessToken) return false;
    return typeof token.expires_at !== 'number' || token.expires_at > Date.now() / 1_000;
  } catch {
    return false;
  }
}

function safeHermesServerName(serverName: string): string {
  return serverName.replace(/[^\w-]/g, '_').replace(/^_+|_+$/g, '').slice(0, 128) || 'default';
}

function viewFor(
  record: CustomConnectorRecord,
  registered: string[] | null,
  authError?: string,
  hasOAuthSession = false,
): CustomConnectorView {
  const toolCount = registered ? countCustomConnectorTools(registered, record.slug) : 0;
  if (toolCount > 0) return { ...record, status: { state: 'connected', toolCount } };
  if (authError) return { ...record, status: { state: 'failed', toolCount: 0, reason: authError } };
  if (hasOAuthSession) {
    return {
      ...record,
      status: { state: 'connected', toolCount: record.lastKnownToolCount ?? 0, cached: true },
    };
  }
  if (record.auth === 'oauth') return { ...record, status: { state: 'pending_auth', toolCount: 0 } };
  return {
    ...record,
    status: {
      state: 'failed',
      toolCount: 0,
      reason: registered === null ? 'Gateway status unavailable.' : 'No tools registered.',
    },
  };
}

function parseCreateBody(body: unknown): { name: string; url: string; token: string | null } {
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  const token = typeof input.token === 'string' && input.token.length > 0 ? input.token : null;
  if (!name) throw new HttpInputError('Missing "name".');
  if (!url) throw new HttpInputError('Missing "url".');
  return { name, url, token };
}

class HttpInputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function handleError(res: ServerResponse, error: unknown): void {
  if (error instanceof HttpInputError) {
    json(res, error.status, { error: 'bad_request', message: error.message });
    return;
  }
  const diagnostic = error instanceof Error ? error.message : String(error);
  console.error(`[custom-connectors] ${diagnostic}`);
  json(res, 500, { error: 'internal_error', message: customConnectorErrorMessage(error) });
}

export function customConnectorErrorMessage(error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error)).trim();
  if (!raw) return 'We couldn’t connect to this MCP server. Please try again.';

  if (/stopped unexpectedly|recent logs|process exit|eaddrinuse|address already in use|port\s+\d+\s+already in use/i.test(raw)) {
    return 'Verso couldn’t start the connection service. Please try again.';
  }

  // Probe/auth errors are deliberately short and actionable; keep those.
  // Anything unexpectedly verbose is an internal diagnostic and belongs in
  // logs rather than a connection form.
  if (raw.length > 240 || raw.includes('\n')) {
    return 'We couldn’t connect to this MCP server. Check the URL or credentials and try again.';
  }
  return raw;
}

function contentTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/x-icon';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
