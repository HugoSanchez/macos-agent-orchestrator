import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { renderCallbackPage, sendHtml } from './connections.ts';

export const MCP_OAUTH_REDIRECT_URI = 'http://localhost:43821/oauth/callback';
const FLOW_TIMEOUT_MS = 330_000;

export interface OAuthCallbackLease {
  register(authorizationUrl: string, gatewayCallbackUrl: string, onFailure?: (message: string) => void): void;
  release(): void;
}

/** A shared return address for providers that require manual client registration.
 * The gateway still owns PKCE, state validation, token exchange, and storage.
 */
export class McpOAuthCallback {
  private servers: Server[] = [];
  private starting: Promise<void> | null = null;
  private leases = 0;
  private readonly pending = new Map<string, { url: string; onFailure?: (message: string) => void }>();

  constructor(private readonly port = 43821) {}

  async acquire(): Promise<OAuthCallbackLease> {
    this.leases += 1;
    try {
      this.starting ??= this.listen().finally(() => { this.starting = null; });
      await this.starting;
    } catch {
      this.leases -= 1;
      throw new Error(`Verso could not open OAuth callback port ${this.port}. Close other Verso instances or the app using that port, then try again.`);
    }
    let state: string | null = null;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      if (state) this.pending.delete(state);
      this.leases -= 1;
      if (this.leases === 0) {
        for (const server of this.servers) server.close();
        this.servers = [];
      }
    };
    const timer = setTimeout(release, FLOW_TIMEOUT_MS);
    timer.unref();
    return {
      release,
      register: (authorizationUrl, gatewayCallbackUrl, onFailure) => {
        const url = new URL(authorizationUrl);
        const nextState = url.searchParams.get('state');
        if (released || state || !nextState || this.pending.has(nextState)
          || url.searchParams.get('redirect_uri') !== MCP_OAUTH_REDIRECT_URI) {
          throw new Error('The MCP server returned an invalid OAuth authorization URL. Start sign-in again.');
        }
        state = nextState;
        this.pending.set(state, { url: gatewayCallbackUrl, onFailure });
      },
    };
  }

  private async listen(): Promise<void> {
    if (this.servers.length) return;
    const servers: Server[] = [];
    try {
      // localhost may resolve to either address. Never bind a public interface.
      for (const host of ['127.0.0.1', '::1']) {
        const server = createServer((req, res) => { void this.handle(req, res); });
        servers.push(server);
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen({ port: this.port, host, ipv6Only: true }, () => {
            server.removeListener('error', reject);
            resolve();
          });
        });
        server.unref();
      }
      this.servers = servers;
    } catch (error) {
      for (const server of servers) server.close();
      throw error;
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    let url: URL;
    try {
      url = new URL(req.url ?? '/', MCP_OAUTH_REDIRECT_URI);
    } catch {
      sendHtml(res, 400, renderCallbackPage('Invalid callback', 'Return to Verso to sign in.'));
      return;
    }
    if (req.method !== 'GET' || url.pathname !== '/oauth/callback'
      || req.headers.host !== `localhost:${this.port}`) {
      sendHtml(res, 404, renderCallbackPage('Not found', 'Return to Verso to sign in.'));
      return;
    }
    const state = url.searchParams.get('state');
    const target = state ? this.pending.get(state) : undefined;
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (!target || !state || (!code && !error) || (code && error)
      || ['state', 'code', 'error'].some((key) => url.searchParams.getAll(key).length > 1)) {
      sendHtml(res, 400, renderCallbackPage('Sign-in expired or invalid', 'Return to Verso and start sign-in again.'));
      return;
    }
    // Consume before awaiting so duplicate callbacks cannot be forwarded.
    this.pending.delete(state);
    const callback = new URL(target.url);
    callback.searchParams.set('state', state);
    if (code) callback.searchParams.set('code', code);
    if (error) callback.searchParams.set('error', error);
    try {
      const response = await fetch(callback, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
      const accepted = response.ok && !error;
      const message = error === 'access_denied'
        ? 'Authorization was declined. Start sign-in again to grant access.'
        : response.status === 404
          ? 'The sign-in session expired. Return to Verso and start sign-in again.'
          : 'The authorization callback was rejected. Return to Verso and start sign-in again.';
      await response.body?.cancel();
      if (!accepted) target.onFailure?.(message);
      sendHtml(res, accepted ? 200 : 400, renderCallbackPage(
        accepted ? 'Authorization received' : 'Sign-in failed',
        accepted ? 'You can close this tab and return to Verso.' : message,
      ));
    } catch {
      const message = 'Could not deliver authorization to Verso. Start sign-in again.';
      target.onFailure?.(message);
      sendHtml(res, 502, renderCallbackPage('Sign-in unavailable', message));
    }
  }
}

export const mcpOAuthCallback = new McpOAuthCallback();
