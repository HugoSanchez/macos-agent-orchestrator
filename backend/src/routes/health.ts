import type { FastifyInstance } from 'fastify';
import { checkDatabaseHealth } from '../db/health.ts';
import type { BackendConfig } from '../config.ts';

export async function registerHealthRoutes(app: FastifyInstance, config: BackendConfig): Promise<void> {
  app.get('/health', async (_request, reply) => {
    const database = await checkDatabaseHealth(config.DATABASE_URL);
    const healthy = database.reachable || !database.configured;

    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      service: 'verso-backend',
      environment: config.NODE_ENV,
      timestamp: Date.now(),
      capabilities: {
        databaseConfigured: config.databaseConfigured,
        workosConfigured: config.workosConfigured,
      },
      database,
    });
  });
}
