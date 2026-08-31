import { randomBytes } from 'node:crypto';
import type { BackendConfig } from '../config.ts';
import type {
  AppUserRecord,
  AuthStore,
  AuthenticatedContext,
  DeviceRecord,
  EntitlementRecord,
  VerifiedWorkOSAccessToken,
  WorkOSAuthenticationResult,
  WorkOSAuthProvider,
} from './types.ts';

export class AuthServiceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AuthServiceError';
    this.status = status;
    this.code = code;
  }
}

export interface MagicAuthRequestContext {
  ipAddress?: string;
  userAgent?: string;
}

export interface VerifyMagicCodeInput extends MagicAuthRequestContext {
  email: string;
  code: string;
  deviceLabel: string;
  platform: string;
}

export interface RefreshAuthInput extends MagicAuthRequestContext {
  refreshToken: string;
  deviceId: string;
}

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  tokenClaims: VerifiedWorkOSAccessToken;
  user: AppUserRecord;
  device: DeviceRecord;
  entitlements: EntitlementRecord[];
}

type AuthIdentityResult = Omit<AuthResult, 'device'>;

export class AuthService {
  private readonly config: BackendConfig;
  private readonly store: AuthStore;
  private readonly provider: WorkOSAuthProvider | null;

  constructor(config: BackendConfig, store: AuthStore, provider: WorkOSAuthProvider | null) {
    this.config = config;
    this.store = store;
    this.provider = provider;
  }

  async sendMagicCode(email: string, context: MagicAuthRequestContext = {}): Promise<void> {
    const provider = this.requireProvider();
    const normalizedEmail = normalizeEmail(email);

    try {
      await provider.sendMagicCode({ email: normalizedEmail, ...context });
    } catch (error) {
      throw mapProviderError(error, 'Unable to send a sign-in code.');
    }
  }

  async verifyMagicCode(input: VerifyMagicCodeInput): Promise<AuthResult> {
    const provider = this.requireProvider();
    const email = normalizeEmail(input.email);

    let authenticated: WorkOSAuthenticationResult;
    try {
      authenticated = await provider.authenticateMagicCode({
        email,
        code: input.code.trim(),
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });
    } catch (error) {
      throw mapProviderError(error, 'The email or sign-in code is not valid.', true);
    }

    if (normalizeEmail(authenticated.user.email) !== email) {
      throw new AuthServiceError(502, 'invalid_provider_response', 'WorkOS returned inconsistent user identity.');
    }

    const result = await this.finishAuthentication(authenticated);
    const device = await this.upsertDevice(result.user.id, input.deviceLabel, input.platform);
    return { ...result, device };
  }

  async refreshSession(input: RefreshAuthInput): Promise<AuthResult> {
    const provider = this.requireProvider();
    let authenticated: WorkOSAuthenticationResult;
    try {
      authenticated = await provider.refreshSession({
        refreshToken: input.refreshToken.trim(),
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });
    } catch (error) {
      throw mapProviderError(error, 'The session can no longer be refreshed.', true);
    }

    const result = await this.finishAuthentication(authenticated);
    const device = await this.store.getDeviceById(input.deviceId);
    if (!device || device.userId !== result.user.id) {
      throw new AuthServiceError(401, 'invalid_device', 'The session is not bound to this device.');
    }

    const updatedDevice = { ...device, lastSeenAt: new Date().toISOString() };
    await this.store.updateDevice(updatedDevice);
    return { ...result, device: updatedDevice };
  }

  async authenticateAccessToken(accessToken: string, deviceId: string): Promise<AuthenticatedContext> {
    const provider = this.requireProvider();
    const token = accessToken.trim();
    if (!token) {
      throw new AuthServiceError(401, 'missing_session', 'Missing access token.');
    }

    let claims: VerifiedWorkOSAccessToken;
    try {
      claims = await provider.verifyAccessToken(token);
    } catch {
      throw new AuthServiceError(401, 'invalid_session', 'The session is invalid or expired.');
    }

    const user = await this.store.getUserByWorkOSUserId(claims.userId);
    if (!user || !user.email) {
      throw new AuthServiceError(403, 'account_not_registered', 'This account is not registered with Verso.');
    }

    const device = await this.store.getDeviceById(deviceId);
    if (!device || device.userId !== user.id) {
      throw new AuthServiceError(401, 'invalid_device', 'The session is not bound to this device.');
    }

    const entitlements = await this.store.listEntitlementsByUserId(user.id);
    return {
      user,
      device,
      session: sessionFromClaims(claims),
      entitlements,
    };
  }

  async revokeSession(accessToken: string): Promise<void> {
    const provider = this.requireProvider();
    let claims: VerifiedWorkOSAccessToken;
    try {
      claims = await provider.verifyAccessToken(accessToken.trim());
    } catch {
      throw new AuthServiceError(401, 'invalid_session', 'The session is invalid or expired.');
    }

    try {
      await provider.revokeSession(claims.sessionId);
    } catch (error) {
      throw mapProviderError(error, 'Unable to revoke the session.');
    }
  }

  private async finishAuthentication(authenticated: WorkOSAuthenticationResult): Promise<AuthIdentityResult> {
    if (!authenticated.user.emailVerified) {
      throw new AuthServiceError(401, 'unverified_email', 'WorkOS did not verify this email address.');
    }

    const verifiedEmail = normalizeEmail(authenticated.user.email);

    let tokenClaims: VerifiedWorkOSAccessToken;
    try {
      tokenClaims = await this.requireProvider().verifyAccessToken(authenticated.accessToken);
    } catch {
      throw new AuthServiceError(502, 'invalid_provider_response', 'WorkOS returned an invalid access token.');
    }
    if (tokenClaims.userId !== authenticated.user.id) {
      throw new AuthServiceError(502, 'invalid_provider_response', 'WorkOS returned inconsistent user identity.');
    }

    const user = await this.upsertVerifiedUser({
      workosUserId: authenticated.user.id,
      email: verifiedEmail,
      displayName: normalizeOptionalString(authenticated.user.displayName),
    });

    const entitlements = await this.store.listEntitlementsByUserId(user.id);
    return {
      accessToken: authenticated.accessToken,
      refreshToken: authenticated.refreshToken,
      tokenClaims,
      user,
      entitlements,
    };
  }

  private async upsertVerifiedUser(input: {
    workosUserId: string;
    email: string;
    displayName: string | null;
  }): Promise<AppUserRecord> {
    const nowIso = new Date().toISOString();
    let user = await this.store.getUserByWorkOSUserId(input.workosUserId);

    // Matching pre-WorkOS users by their now-verified email preserves their
    // existing internal user IDs and connected-app data.
    user ??= await this.store.getUserByEmail(input.email);

    if (!user) {
      user = {
        id: createId('usr'),
        workosUserId: input.workosUserId,
        email: input.email,
        displayName: input.displayName,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      await this.store.insertUser(user);
      await this.ensureDefaultManagedEntitlement(user.id, nowIso);
      return user;
    }

    user = {
      ...user,
      workosUserId: input.workosUserId,
      email: input.email,
      displayName: input.displayName ?? user.displayName,
      updatedAt: nowIso,
    };
    await this.store.updateUser(user);
    await this.ensureDefaultManagedEntitlement(user.id, nowIso);
    return user;
  }

  private async upsertDevice(userId: string, rawLabel: string, rawPlatform: string): Promise<DeviceRecord> {
    const deviceLabel = rawLabel.trim();
    const platform = rawPlatform.trim();
    const nowIso = new Date().toISOString();
    let device = await this.store.getDeviceByUserAndPlatform(userId, deviceLabel, platform);
    if (!device) {
      device = {
        id: createId('dev'),
        userId,
        deviceLabel,
        platform,
        lastSeenAt: nowIso,
        createdAt: nowIso,
      };
      await this.store.insertDevice(device);
      return device;
    }

    device = { ...device, lastSeenAt: nowIso };
    await this.store.updateDevice(device);
    return device;
  }

  private async ensureDefaultManagedEntitlement(userId: string, nowIso: string): Promise<void> {
    const existing = await this.store.listEntitlementsByUserId(userId);
    if (existing.length > 0) return;

    await this.store.insertEntitlement({
      id: createId('ent'),
      userId,
      mode: 'managed',
      status: 'active',
      monthlyUsdLimit: null,
      dailyUsdLimit: null,
      allowedModels: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  }

  private requireProvider(): WorkOSAuthProvider {
    if (!this.config.workosConfigured || !this.provider) {
      throw new AuthServiceError(503, 'workos_unconfigured', 'WorkOS is not configured.');
    }
    return this.provider;
  }

}

function createId(prefix: string): string {
  return `${prefix}_${randomBytes(10).toString('hex')}`;
}

function sessionFromClaims(claims: VerifiedWorkOSAccessToken) {
  return {
    id: claims.sessionId,
    issuedAt: new Date(claims.issuedAt * 1000).toISOString(),
    expiresAt: new Date(claims.expiration * 1000).toISOString(),
  };
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function mapProviderError(error: unknown, fallbackMessage: string, invalidCredentials = false): AuthServiceError {
  const status = typeof error === 'object' && error && 'status' in error
    ? Number(error.status)
    : 0;
  if (status === 429) {
    return new AuthServiceError(429, 'rate_limited', 'Too many authentication attempts. Please try again later.');
  }
  if (invalidCredentials && [400, 401, 404, 422].includes(status)) {
    return new AuthServiceError(401, 'invalid_code', fallbackMessage);
  }
  return new AuthServiceError(502, 'auth_provider_error', fallbackMessage);
}
