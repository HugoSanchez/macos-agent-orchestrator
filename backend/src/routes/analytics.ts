import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthService, AuthServiceError } from '../auth/service.ts';
import { extractBearerToken, extractDeviceId } from './auth.ts';
import { getDb } from '../db/client.ts';
import { analyticsEvents } from '../db/schema.ts';
import type { BackendConfig } from '../config.ts';

const eventSchema = z.discriminatedUnion('eventType', [
  z.object({ eventType: z.literal('connection_added') }),
  z.object({ eventType: z.literal('session_created'), sessionId: z.string().min(1) }),
  z.object({ eventType: z.literal('message_sent'), sessionId: z.string().min(1) }),
  z.object({
    eventType: z.literal('message_completed'),
    sessionId: z.string().min(1),
    toolCallCount: z.number().int().min(0),
  }),
]);

interface RouteDeps {
  authService: AuthService;
  config: BackendConfig;
}

export async function registerAnalyticsRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  app.post('/v1/analytics/event', async (request, reply) => {
    try {
      const auth = await deps.authService.authenticateAccessToken(
        extractBearerToken(request),
        extractDeviceId(request),
      );
      const event = eventSchema.parse(request.body ?? {});

      if (!deps.config.databaseConfigured || !deps.config.DATABASE_URL) {
        // No database wired up (memory auth store mode) — accept silently so
        // the orchestrator's fire-and-forget call doesn't error in dev.
        return reply.code(204).send();
      }

      const db = getDb(deps.config.DATABASE_URL);
      await db.insert(analyticsEvents).values({
        id: randomUUID(),
        userId: auth.user.id,
        deviceId: auth.device.id,
        eventType: event.eventType,
        sessionId: 'sessionId' in event ? event.sessionId : null,
        toolCallCount: 'toolCallCount' in event ? event.toolCallCount : null,
        occurredAt: new Date(),
      });

      return reply.code(204).send();
    } catch (error) {
      return handleError(reply, error);
    }
  });
}

function handleError(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthServiceError) {
    return reply.code(error.status).send({ error: error.code, message: error.message });
  }
  if (error instanceof z.ZodError) {
    return reply.code(400).send({ error: 'bad_request', message: 'Invalid event body.', issues: error.issues });
  }
  return reply.code(500).send({
    error: 'internal_error',
    message: error instanceof Error ? error.message : String(error),
  });
}
