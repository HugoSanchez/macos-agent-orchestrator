import { WorkOS } from '@workos-inc/node';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { BackendConfig } from '../config.ts';
import type {
  VerifiedWorkOSAccessToken,
  WorkOSAuthenticationResult,
  WorkOSAuthProvider,
} from './types.ts';

export class BackendWorkOSAuthProvider implements WorkOSAuthProvider {
  private readonly client: WorkOS;
  private readonly clientId: string;
  private readonly issuers: string[];
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(config: BackendConfig) {
    if (!config.workosConfigured || !config.WORKOS_API_KEY || !config.WORKOS_CLIENT_ID) {
      throw new Error('WorkOS is not configured.');
    }

    this.clientId = config.WORKOS_CLIENT_ID;
    const issuerWithoutTrailingSlash = config.workosIssuer.replace(/\/+$/, '');
    this.issuers = [issuerWithoutTrailingSlash, `${issuerWithoutTrailingSlash}/`];
    this.client = new WorkOS({
      apiKey: config.WORKOS_API_KEY,
      clientId: config.WORKOS_CLIENT_ID,
    });
    this.jwks = createRemoteJWKSet(new URL(config.workosJwksUrl));
  }

  async sendMagicCode(input: {
    email: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void> {
    await this.client.userManagement.createMagicAuth(input);
  }

  async authenticateMagicCode(input: {
    email: string;
    code: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<WorkOSAuthenticationResult> {
    const result = await this.client.userManagement.authenticateWithMagicAuth(input);
    return mapAuthenticationResult(result);
  }

  async refreshSession(input: {
    refreshToken: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<WorkOSAuthenticationResult> {
    const result = await this.client.userManagement.authenticateWithRefreshToken(input);
    return mapAuthenticationResult(result);
  }

  async verifyAccessToken(accessToken: string): Promise<VerifiedWorkOSAccessToken> {
    const { payload } = await jwtVerify(accessToken, this.jwks, {
      issuer: this.issuers,
      algorithms: ['RS256'],
    });

    if (payload.client_id !== this.clientId) {
      throw new Error('Access token was issued for a different WorkOS application.');
    }
    if (!payload.sub || typeof payload.sid !== 'string' || !payload.iat || !payload.exp) {
      throw new Error('Access token is missing required WorkOS session claims.');
    }

    return {
      userId: payload.sub,
      sessionId: payload.sid,
      issuedAt: payload.iat,
      expiration: payload.exp,
    };
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.client.userManagement.revokeSession({ sessionId });
  }
}

function mapAuthenticationResult(result: Awaited<ReturnType<WorkOS['userManagement']['authenticateWithMagicAuth']>>): WorkOSAuthenticationResult {
  return {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    user: {
      id: result.user.id,
      email: result.user.email,
      emailVerified: result.user.emailVerified,
      displayName: result.user.name,
    },
  };
}
