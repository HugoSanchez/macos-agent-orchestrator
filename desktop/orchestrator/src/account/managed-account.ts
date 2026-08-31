import { json, route, type Route } from '../http/router.ts';
import {
  ManagedBackendClient,
  type ManagedSessionRecord,
} from '../integrations/managed-backend-client.ts';

export interface ManagedAccountRouteOptions {
  onSessionChanged?: () => void;
}

export function buildManagedAccountRoutes(
  managedBackend: ManagedBackendClient,
  opts: ManagedAccountRouteOptions = {},
): Route[] {
  return [
    route('GET', '/managed/account', async (_req, res) => {
      const account = await managedBackend.getAccount();
      json(res, 200, account);
    }),

    route('POST', '/managed/session', async (_req, res, _params, body) => {
      const parsed = parseSessionBody(body);
      if (parsed === 'invalid') {
        json(res, 400, { error: 'bad_request', message: 'Invalid managed session payload.' });
        return;
      }
      managedBackend.setSession(parsed);
      opts.onSessionChanged?.();
      json(res, 200, { ok: true });
    }),

    route('DELETE', '/managed/session', async (_req, res) => {
      // Best-effort server-side revoke before we drop the in-memory token.
      // If the backend is unreachable or rejects, we still clear locally so
      // the user is effectively signed out from the app's perspective.
      try {
        await managedBackend.revokeSession();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('[managed] revoke failed during sign-out (clearing local anyway):', message);
      }
      managedBackend.setSession(null);
      opts.onSessionChanged?.();
      json(res, 200, { ok: true });
    }),
  ];
}

function parseSessionBody(body: unknown): ManagedSessionRecord | null | 'invalid' {
  if (body === null || body === undefined) return null;
  if (typeof body !== 'object') return 'invalid';
  const candidate = body as Record<string, unknown>;
  if (candidate.session === null) return null;

  const source = (candidate.session && typeof candidate.session === 'object')
    ? candidate.session as Record<string, unknown>
    : candidate;

  const token = typeof source.token === 'string' ? source.token.trim() : '';
  const expiresAt = typeof source.expiresAt === 'string' ? source.expiresAt.trim() : '';
  const userId = typeof source.userId === 'string' ? source.userId.trim() : '';
  const deviceId = typeof source.deviceId === 'string' ? source.deviceId.trim() : '';
  if (!token || !expiresAt || !userId || !deviceId) return 'invalid';

  return {
    token,
    expiresAt,
    userId,
    deviceId,
    email: optionalString(source.email),
    displayName: optionalString(source.displayName),
    receivedAt: typeof source.receivedAt === 'string' && source.receivedAt.trim().length > 0
      ? source.receivedAt
      : new Date().toISOString(),
  };
}

function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
