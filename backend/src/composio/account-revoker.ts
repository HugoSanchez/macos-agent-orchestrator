import { ComposioServiceError } from './errors.ts';
import type { ComposioFetch, ComposioLog } from './contracts.ts';

export type ProviderRevocationResult =
  | { status: 'revoked' }
  | { status: 'already_absent' }
  | { status: 'manual_action_required'; upstreamStatus: 400 | 409 };

/** Narrow boundary for Composio's provider-side token revocation endpoint. */
export interface ConnectedAccountRevoker {
  revoke(connectedAccountId: string): Promise<ProviderRevocationResult>;
}

export interface ComposioAccountRevokerOptions {
  apiKey: string;
  fetch?: ComposioFetch;
  log?: ComposioLog;
}

const REVOKE_TIMEOUT_MS = 15_000;

/**
 * Calls `POST /api/v3.1/connected_accounts/:id/revoke`, which the repository's
 * `@composio/core` contract does not expose. Upstream statuses are normalized
 * to a closed result set: 2xx revoked, 404 already absent, 400/409 manual
 * action required. Everything else (auth, rate limit, server, timeout,
 * network) throws a sanitized retryable error — the API key and the upstream
 * response body never reach an error message or a log line.
 */
export class ComposioAccountRevoker implements ConnectedAccountRevoker {
  private readonly fetch: ComposioFetch;

  constructor(private readonly options: ComposioAccountRevokerOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async revoke(connectedAccountId: string): Promise<ProviderRevocationResult> {
    const id = connectedAccountId.trim();
    if (!id) throw new ComposioServiceError(400, 'Missing "connectedAccountId"');

    let response: Response;
    try {
      response = await this.fetch(
        `https://backend.composio.dev/api/v3.1/connected_accounts/${encodeURIComponent(id)}/revoke`,
        {
          method: 'POST',
          headers: { 'x-api-key': this.options.apiKey, Accept: 'application/json' },
          signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
        },
      );
    } catch {
      // The raw error can embed the request URL or agent internals.
      this.logSafely('composio.revoke.failed', { connectedAccountId: id, reason: 'network' });
      throw new ComposioServiceError(502, 'Could not reach Composio to revoke the connection. Try again.');
    }

    if (response.ok) return { status: 'revoked' };
    if (response.status === 404) return { status: 'already_absent' };
    if (response.status === 400 || response.status === 409) {
      return { status: 'manual_action_required', upstreamStatus: response.status };
    }

    // Retryable or configuration failure: the caller must leave the Composio
    // account untouched so the credential is still visible for a retry.
    this.logSafely('composio.revoke.failed', { connectedAccountId: id, upstreamStatus: response.status });
    throw new ComposioServiceError(
      response.status === 429 ? 503 : 502,
      'Could not revoke the provider connection. Try again.',
    );
  }

  // Diagnostics only: a throwing logger must never replace the sanitized
  // error this adapter is about to raise.
  private logSafely(event: string, details: Record<string, unknown>): void {
    try {
      this.options.log?.(event, details);
    } catch {
      // Swallow logger failures.
    }
  }
}
