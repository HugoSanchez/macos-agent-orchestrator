import { readRuntimeMode, type RuntimeMode } from './runtime-mode.ts';

export interface ManagedSessionRecord {
  token: string;
  expiresAt: string;
  userId: string;
  email: string | null;
  displayName: string | null;
  receivedAt: string;
}

export interface ManagedBackendUserView {
  id: string;
  privyUserId: string;
  email: string | null;
  displayName: string | null;
}

export interface ManagedBackendDeviceView {
  id: string;
  label: string;
  platform: string;
  lastSeenAt: string;
}

export interface ManagedBackendEntitlementView {
  id: string;
  mode: string;
  status: string;
  allowedModels: string[] | null;
  monthlyUsdLimit: number | null;
  dailyUsdLimit: number | null;
}

export interface ManagedBackendSessionView {
  id: string;
  issuedAt: string;
  expiresAt: string;
}

export type ManagedAccountState =
  | 'signed_out'
  | 'expired'
  | 'authenticated'
  | 'invalid_session'
  | 'backend_unavailable';

export interface ManagedAccountView {
  runtimeMode: RuntimeMode;
  capabilities: {
    managedAccount: boolean;
    remoteConnections: boolean;
  };
  backend: {
    configured: boolean;
    baseUrl: string | null;
  };
  session: {
    present: boolean;
    userId: string | null;
    email: string | null;
    displayName: string | null;
    expiresAt: string | null;
    receivedAt: string | null;
    expired: boolean;
  };
  account: {
    state: ManagedAccountState;
    error: string | null;
    user: ManagedBackendUserView | null;
    device: ManagedBackendDeviceView | null;
    session: ManagedBackendSessionView | null;
    entitlements: ManagedBackendEntitlementView[];
  };
}

interface ManagedMeResponse {
  user: ManagedBackendUserView;
  device: ManagedBackendDeviceView;
  session: ManagedBackendSessionView;
  entitlements: ManagedBackendEntitlementView[];
}

interface ManagedBackendErrorBody {
  error?: string;
  message?: string;
}

export class ManagedBackendError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ManagedBackendError';
    this.status = status;
    this.code = code;
  }
}

/**
 * The session is held in process memory only. The macOS app pushes it over
 * loopback IPC after sign-in (POST /managed/session) so we never write the
 * bearer token to disk on the orchestrator side. At launch the env vars below
 * carry the session forward across sidecar restarts where the app is still
 * running.
 */

// `VERSO_BACKEND_URL=off` disables the managed backend entirely. Without
// this, dev/test runs silently adopt whatever service happens to be
// listening on the default local port (e.g. another workspace's backend)
// and surface its half-configured sign-in flow as "Verso is broken".
export function resolveManagedBackendUrl(
  runtimeMode: RuntimeMode,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (runtimeMode !== 'managed') return '';
  const raw = env.VERSO_BACKEND_URL?.trim();
  if (raw && ['off', 'none', 'disabled'].includes(raw.toLowerCase())) return '';
  return raw || '';
}

interface ManagedBackendClientOptions {
  runtimeMode?: RuntimeMode;
  baseUrl?: string;
}

export class ManagedBackendClient {
  private readonly baseUrl: string;
  private readonly runtimeMode: RuntimeMode;

  private currentSession: ManagedSessionRecord | null;

  constructor(options: string | ManagedBackendClientOptions = {}) {
    const normalizedOptions = typeof options === 'string'
      ? { runtimeMode: 'managed' as const, baseUrl: options }
      : options;
    this.runtimeMode = normalizedOptions.runtimeMode ?? readRuntimeMode();
    const resolvedBaseUrl = normalizedOptions.baseUrl
      ?? resolveManagedBackendUrl(this.runtimeMode);
    this.baseUrl = this.runtimeMode === 'managed' ? resolvedBaseUrl.replace(/\/+$/, '') : '';
    this.currentSession = this.runtimeMode === 'managed' ? readSessionFromEnv() : null;
    const source = normalizedOptions.baseUrl !== undefined
      ? 'constructor'
      : process.env.VERSO_BACKEND_URL?.trim() ? 'env VERSO_BACKEND_URL' : 'disabled default';
    console.error(`[managed-backend] baseUrl=${this.baseUrl || '(disabled)'} (${source})`);
  }

  get configured(): boolean {
    return this.baseUrl.length > 0;
  }

  /** Read-only accessor so peer integrations can build their own URLs against the same host. */
  get backendBaseUrl(): string {
    return this.baseUrl;
  }

  setSession(record: ManagedSessionRecord | null): void {
    this.currentSession = this.runtimeMode === 'managed' ? record : null;
  }

  getStoredSession(): ManagedSessionRecord | null {
    return this.currentSession;
  }

  async getAccount(): Promise<ManagedAccountView> {
    const stored = this.currentSession;
    const expired = stored ? isIsoExpired(stored.expiresAt) : false;

    const view: ManagedAccountView = {
      runtimeMode: this.runtimeMode,
      capabilities: {
        managedAccount: this.runtimeMode === 'managed',
        remoteConnections: this.configured,
      },
      backend: {
        configured: this.configured,
        baseUrl: this.configured ? this.baseUrl : null,
      },
      session: {
        present: Boolean(stored),
        userId: stored?.userId ?? null,
        email: stored?.email ?? null,
        displayName: stored?.displayName ?? null,
        expiresAt: stored?.expiresAt ?? null,
        receivedAt: stored?.receivedAt ?? null,
        expired,
      },
      account: {
        state: 'signed_out',
        error: null,
        user: null,
        device: null,
        session: null,
        entitlements: [],
      },
    };

    if (!stored) {
      return view;
    }

    if (expired) {
      view.account.state = 'expired';
      view.account.error = 'Managed session has expired locally.';
      return view;
    }

    if (!this.configured) {
      view.account.state = 'backend_unavailable';
      view.account.error = 'Managed backend URL is not configured.';
      return view;
    }

    try {
      const response = await fetch(`${this.baseUrl}/v1/me`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${stored.token}`,
        },
        // A wedged backend (accepts the socket but never replies) would
        // otherwise hang this request indefinitely — and with it the Settings
        // page, whose only spinner is gated on /managed/account. Time out fast
        // so the catch below degrades to `backend_unavailable` instead.
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        const body = await response.json() as ManagedMeResponse;
        view.account = {
          state: 'authenticated',
          error: null,
          user: body.user,
          device: body.device,
          session: body.session,
          entitlements: Array.isArray(body.entitlements) ? body.entitlements : [],
        };
        view.session.email = body.user.email ?? view.session.email;
        view.session.displayName = body.user.displayName ?? view.session.displayName;
        return view;
      }

      const errorBody = await readErrorBody(response);
      if (response.status === 401 || response.status === 403) {
        view.account.state = errorBody.error === 'expired_session' ? 'expired' : 'invalid_session';
        view.account.error = errorBody.message ?? 'Managed session is not valid.';
        return view;
      }

      view.account.state = 'backend_unavailable';
      view.account.error = errorBody.message ?? `Managed backend returned HTTP ${response.status}.`;
      return view;
    } catch (error) {
      view.account.state = 'backend_unavailable';
      view.account.error = error instanceof Error ? error.message : String(error);
      return view;
    }
  }

  /**
   * Server-side sign-out: marks the current session token revoked on the
   * backend so it can never be reused, even before its natural expiry. Safe
   * to call when no session is loaded (no-op). Best-effort: callers should
   * still clear their local session even if this throws.
   */
  async revokeSession(): Promise<void> {
    if (!this.configured) return;
    const stored = this.currentSession;
    if (!stored) return;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/auth/revoke`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${stored.token}` },
        // Same wedged-backend guard as getAccount: sign-out must not hang on
        // an unresponsive backend. Callers clear the local session regardless.
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ManagedBackendError(502, 'backend_unreachable', message);
    }

    // 204 (revoked), 401 invalid_session (already gone, treat as success).
    if (response.status === 204 || response.status === 401) return;

    const body = await readErrorBody(response);
    throw new ManagedBackendError(
      response.status,
      body.error ?? 'backend_error',
      body.message ?? `Backend returned HTTP ${response.status}.`,
    );
  }

  /**
   * Fire-and-forget product analytics. Never throws: the orchestrator's hot
   * paths (chat, connections) call this; an outage or expired session must
   * not break user-visible behavior. Errors land in stderr for diagnostics.
   */
  recordAnalyticsEvent(event: AnalyticsEventInput): void {
    if (!this.configured) return;
    const stored = this.currentSession;
    if (!stored) return;
    if (isIsoExpired(stored.expiresAt)) return;

    void fetch(`${this.baseUrl}/v1/analytics/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${stored.token}`,
      },
      body: JSON.stringify(event),
    })
      .then((response) => {
        if (!response.ok) {
          console.error(`[managed-backend] analytics event rejected: HTTP ${response.status}`);
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[managed-backend] analytics event failed: ${message}`);
      });
  }
}

export type AnalyticsEventInput =
  | { eventType: 'connection_added' }
  | { eventType: 'session_created'; sessionId: string }
  | { eventType: 'message_sent'; sessionId: string }
  | { eventType: 'message_completed'; sessionId: string; toolCallCount: number };

function readSessionFromEnv(): ManagedSessionRecord | null {
  const token = process.env.VERSO_MANAGED_SESSION_TOKEN?.trim() || '';
  const expiresAt = process.env.VERSO_MANAGED_SESSION_EXPIRES_AT?.trim() || '';
  const userId = process.env.VERSO_MANAGED_USER_ID?.trim() || '';
  if (!token || !expiresAt || !userId) return null;

  return {
    token,
    expiresAt,
    userId,
    email: null,
    displayName: null,
    receivedAt: new Date().toISOString(),
  };
}

async function readErrorBody(response: Response): Promise<ManagedBackendErrorBody> {
  try {
    return await response.json() as ManagedBackendErrorBody;
  } catch {
    return {
      message: `Backend returned HTTP ${response.status}.`,
    };
  }
}

function isIsoExpired(value: string): boolean {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return false;
  return timestamp <= Date.now();
}
