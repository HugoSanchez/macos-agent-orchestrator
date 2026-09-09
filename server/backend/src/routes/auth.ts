import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthService, AuthServiceError, type AuthResult } from '../auth/service.ts';

const emailSchema = z.string().trim().email().max(320);

const startSchema = z.object({
  email: emailSchema,
});

const verifySchema = z.object({
  email: emailSchema,
  code: z.string().trim().regex(/^\d{6}$/),
  deviceLabel: z.string().trim().min(1).max(120).default('verso for macOS'),
  platform: z.string().trim().min(1).max(60).default('macos'),
});

const refreshSchema = z.object({
  refreshToken: z.string().trim().min(1).max(4_096),
  deviceId: z.string().trim().min(1).max(120),
});

export async function registerAuthRoutes(app: FastifyInstance, authService: AuthService): Promise<void> {
  app.post('/v1/auth/magic/start', async (request, reply) => {
    try {
      const body = startSchema.parse(request.body ?? {});
      await authService.sendMagicCode(body.email, requestContext(request));
      return reply.code(204).send();
    } catch (error: unknown) {
      return handleAuthError(reply, error);
    }
  });

  app.post('/v1/auth/magic/verify', async (request, reply) => {
    try {
      const body = verifySchema.parse(request.body ?? {});
      const result = await authService.verifyMagicCode({ ...body, ...requestContext(request) });
      return reply.code(200).send(authResponse(result));
    } catch (error: unknown) {
      return handleAuthError(reply, error);
    }
  });

  app.post('/v1/auth/refresh', async (request, reply) => {
    try {
      const body = refreshSchema.parse(request.body ?? {});
      const result = await authService.refreshSession({ ...body, ...requestContext(request) });
      return reply.code(200).send(authResponse(result));
    } catch (error: unknown) {
      return handleAuthError(reply, error);
    }
  });

  app.post('/v1/auth/revoke', async (request, reply) => {
    try {
      await authService.revokeSession(extractBearerToken(request));
      return reply.code(204).send();
    } catch (error: unknown) {
      return handleAuthError(reply, error);
    }
  });

  app.get('/v1/me', async (request, reply) => {
    try {
      const auth = await authService.authenticateAccessToken(
        extractBearerToken(request),
        extractDeviceId(request),
      );
      return reply.code(200).send({
        user: userResponse(auth.user),
        device: {
          id: auth.device.id,
          label: auth.device.deviceLabel,
          platform: auth.device.platform,
          lastSeenAt: auth.device.lastSeenAt,
        },
        session: auth.session,
        entitlements: entitlementResponse(auth.entitlements),
      });
    } catch (error: unknown) {
      return handleAuthError(reply, error);
    }
  });
}

function authResponse(result: AuthResult) {
  return {
    session: {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      id: result.tokenClaims.sessionId,
      expiresAt: new Date(result.tokenClaims.expiration * 1000).toISOString(),
    },
    user: userResponse(result.user),
    device: {
      id: result.device.id,
      label: result.device.deviceLabel,
      platform: result.device.platform,
    },
    entitlements: entitlementResponse(result.entitlements),
  };
}

function userResponse(user: AuthResult['user']) {
  return {
    id: user.id,
    workosUserId: user.workosUserId,
    email: user.email,
    displayName: user.displayName,
  };
}

function entitlementResponse(entitlements: AuthResult['entitlements']) {
  return entitlements.map((item) => ({
    id: item.id,
    mode: item.mode,
    status: item.status,
    allowedModels: item.allowedModels,
    monthlyUsdLimit: item.monthlyUsdLimit,
    dailyUsdLimit: item.dailyUsdLimit,
  }));
}

export function extractBearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header) {
    throw new AuthServiceError(401, 'missing_session', 'Missing Authorization header.');
  }
  if (!header.toLowerCase().startsWith('bearer ')) {
    throw new AuthServiceError(401, 'invalid_session', 'Authorization header must use Bearer token.');
  }
  return header.slice(7).trim();
}

export function extractDeviceId(request: FastifyRequest): string {
  const value = request.headers['x-verso-device-id'];
  const deviceId = (Array.isArray(value) ? value[0] : value)?.trim();
  if (!deviceId) {
    throw new AuthServiceError(401, 'missing_device', 'Missing X-Verso-Device-ID header.');
  }
  return deviceId;
}

function requestContext(request: FastifyRequest) {
  const rawUserAgent = request.headers['user-agent'];
  return {
    ipAddress: request.ip,
    userAgent: Array.isArray(rawUserAgent) ? rawUserAgent[0] : rawUserAgent,
  };
}

export function handleAuthError(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthServiceError) {
    return reply.code(error.status).send({
      error: error.code,
      message: error.message,
    });
  }

  if (error instanceof z.ZodError) {
    return reply.code(400).send({
      error: 'bad_request',
      message: 'Invalid request body.',
      issues: error.issues,
    });
  }

  return reply.code(500).send({
    error: 'internal_error',
    message: 'Unexpected authentication error.',
  });
}
