import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthService, AuthServiceError } from '../auth/service.ts';
import { ComposioService, ComposioServiceError } from '../composio/service.ts';

export interface ComposioRouteDeps {
  authService: AuthService;
  composioService: ComposioService;
}

/**
 * Auth'd Composio proxy. Every route authenticates the bearer and uses
 * `auth.user.id` as the Composio user id, so a client can never act as someone
 * else or access the project API key.
 */
export async function registerComposioRoutes(app: FastifyInstance, deps: ComposioRouteDeps): Promise<void> {
  app.get('/v1/composio/connections', async (request, reply) => {
    try {
      const auth = await deps.authService.authenticateAppSession(extractBearerToken(request));
      const connections = await deps.composioService.listConnections(auth.user.id);
      return reply.code(200).send({ connections });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.delete('/v1/composio/connections/:id', async (request, reply) => {
    try {
      const auth = await deps.authService.authenticateAppSession(extractBearerToken(request));
      const { id } = request.params as { id: string };
      const disconnect = await deps.composioService.deleteConnection(auth.user.id, id);
      return reply.code(200).send({ disconnect });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/v1/composio/toolkits', async (request, reply) => {
    try {
      const auth = await deps.authService.authenticateAppSession(extractBearerToken(request));
      const query = optionalString(request.query as Record<string, unknown> | undefined, 'query');
      const limit = optionalNumber(request.query as Record<string, unknown> | undefined, 'limit');
      const toolkits = await deps.composioService.listToolkits(auth.user.id, { query, limit });
      return reply.code(200).send({ toolkits });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post('/v1/composio/connections/request', async (request, reply) => {
    try {
      const auth = await deps.authService.authenticateAppSession(extractBearerToken(request));
      const body = (request.body ?? {}) as Record<string, unknown>;
      const toolkit = requiredString(body, 'toolkit');
      const callbackUrl = validateLoopbackCallbackUrl(requiredString(body, 'callbackUrl'));
      const result = await deps.composioService.requestConnection(auth.user.id, toolkit, callbackUrl);
      return reply.code(201).send({ request: result });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/v1/composio/connections/requests/:id', async (request, reply) => {
    try {
      const auth = await deps.authService.authenticateAppSession(extractBearerToken(request));
      const { id } = request.params as { id: string };
      const result = await deps.composioService.getRequest(auth.user.id, id);
      return reply.code(200).send({ request: result });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post('/v1/composio/tools/search', async (request, reply) => {
    try {
      const auth = await deps.authService.authenticateAppSession(extractBearerToken(request));
      const body = (request.body ?? {}) as Record<string, unknown>;
      const query = requiredString(body, 'query');
      const toolkits = optionalStringArray(body, 'toolkits');
      const results = await deps.composioService.searchTools(auth.user.id, query, toolkits);
      return reply.code(200).send({ results });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post('/v1/composio/tools/list', async (request, reply) => {
    try {
      const auth = await deps.authService.authenticateAppSession(extractBearerToken(request));
      const body = (request.body ?? {}) as Record<string, unknown>;
      const toolkits = requiredStringArray(body, 'toolkits');
      const tools = await deps.composioService.listTools(auth.user.id, toolkits);
      return reply.code(200).send({ tools });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post('/v1/composio/tools/schemas', async (request, reply) => {
    try {
      const auth = await deps.authService.authenticateAppSession(extractBearerToken(request));
      const body = (request.body ?? {}) as Record<string, unknown>;
      const toolSlugs = requiredStringArray(body, 'toolSlugs');
      const tools = await deps.composioService.getToolSchemas(auth.user.id, toolSlugs);
      return reply.code(200).send({ tools });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post('/v1/composio/tools/execute', async (request, reply) => {
    try {
      const auth = await deps.authService.authenticateAppSession(extractBearerToken(request));
      const body = (request.body ?? {}) as Record<string, unknown>;
      const toolSlug = requiredString(body, 'toolSlug');
      const args = requiredRecord(body, 'arguments');
      const connectedAccountId = optionalString(body, 'connectedAccountId');
      const result = await deps.composioService.executeTool(auth.user.id, toolSlug, args, connectedAccountId);
      return reply.code(200).send({ result });
    } catch (error) {
      return handleError(reply, error);
    }
  });
}

function validateLoopbackCallbackUrl(value: string): string {
  // The anchored shape check leaves only the port range to validate.
  const rawMatch = value.match(/^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/connections\/callback$/);
  const port = rawMatch ? Number(rawMatch[1]) : 0;
  if (port < 1 || port > 65535) {
    throw new ComposioServiceError(400, 'Invalid callbackUrl.');
  }
  return value;
}

function extractBearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header) throw new AuthServiceError(401, 'missing_session', 'Missing Authorization header.');
  if (!header.toLowerCase().startsWith('bearer ')) {
    throw new AuthServiceError(401, 'invalid_session', 'Authorization header must use Bearer token.');
  }
  return header.slice(7).trim();
}

function handleError(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthServiceError) {
    return reply.code(error.status).send({ error: error.code, message: error.message });
  }
  if (error instanceof ComposioServiceError) {
    return reply.code(error.status).send({ error: 'composio_error', message: error.message });
  }
  return reply.code(500).send({
    error: 'internal_error',
    message: error instanceof Error ? error.message : String(error),
  });
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ComposioServiceError(400, `Missing "${key}"`);
  }
  return value.trim();
}

function optionalString(body: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = body?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalNumber(body: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = body?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function requiredStringArray(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    throw new ComposioServiceError(400, `Missing "${key}"`);
  }
  return value.map((item) => (item as string).trim());
}

function optionalStringArray(body: Record<string, unknown>, key: string): string[] | undefined {
  const value = body[key];
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ComposioServiceError(400, `Invalid "${key}"`);
  }
  return value.map((item) => (item as string).trim()).filter(Boolean);
}

function requiredRecord(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key];
  if (value == null) {
    throw new ComposioServiceError(400, `Missing "${key}"`);
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ComposioServiceError(400, `Invalid "${key}"`);
  }
  return value as Record<string, unknown>;
}
