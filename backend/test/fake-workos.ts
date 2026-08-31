import type {
  VerifiedWorkOSAccessToken,
  WorkOSAuthenticationResult,
  WorkOSAuthProvider,
  WorkOSUserIdentity,
} from '../src/auth/types.ts';

export class FakeWorkOSProvider implements WorkOSAuthProvider {
  readonly sentCodes: string[] = [];
  readonly revokedSessionIds: string[] = [];
  user: WorkOSUserIdentity = {
    id: 'user_workos_123',
    email: 'owner@example.com',
    emailVerified: true,
    displayName: 'Owner',
  };
  validCode = '123456';
  validRefreshToken = 'refresh-1';
  nextAccessToken = 'access-1';
  nextRefreshToken = 'refresh-1';
  sessionId = 'session-workos-1';
  issuedAt = 1_900_000_000;
  expiration = 2_000_000_000;

  async sendMagicCode(input: { email: string }): Promise<void> {
    this.sentCodes.push(input.email);
  }

  async authenticateMagicCode(input: { email: string; code: string }): Promise<WorkOSAuthenticationResult> {
    if (input.code !== this.validCode) {
      throw providerError(400, 'Invalid code.');
    }
    return this.authenticationResult();
  }

  async refreshSession(input: { refreshToken: string }): Promise<WorkOSAuthenticationResult> {
    if (input.refreshToken !== this.validRefreshToken) {
      throw providerError(400, 'Invalid refresh token.');
    }
    return this.authenticationResult();
  }

  async verifyAccessToken(accessToken: string): Promise<VerifiedWorkOSAccessToken> {
    if (accessToken !== this.nextAccessToken) {
      throw providerError(401, 'Invalid access token.');
    }
    return {
      userId: this.user.id,
      sessionId: this.sessionId,
      issuedAt: this.issuedAt,
      expiration: this.expiration,
    };
  }

  async revokeSession(sessionId: string): Promise<void> {
    this.revokedSessionIds.push(sessionId);
  }

  private authenticationResult(): WorkOSAuthenticationResult {
    return {
      accessToken: this.nextAccessToken,
      refreshToken: this.nextRefreshToken,
      user: { ...this.user },
    };
  }
}

function providerError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}
