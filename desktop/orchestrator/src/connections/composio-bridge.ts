import { json, route, type Route } from '../http/router.ts';
import { ComposioBridgeHttpError, ComposioBridgeService } from '../integrations/composio-bridge.ts';

export function buildComposioBridgeRoutes(bridge: ComposioBridgeService): Route[] {
  return [
    route('POST', '/composio/tools/execute', async (_req, res, _params, body) => {
      try {
        const toolSlug = getRequiredString(body, 'toolSlug');
        const arguments_ = getRequiredRecord(body, 'arguments');
        const result = await bridge.executeTool(toolSlug, arguments_);
        json(res, 200, { result });
      } catch (error: unknown) {
        handleBridgeError(res, error);
      }
    }),
  ];
}

function handleBridgeError(res: Parameters<typeof json>[0], error: unknown): void {
  if (error instanceof ComposioBridgeHttpError) {
    json(res, error.status, { error: 'request_failed', message: error.message });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  json(res, 500, { error: 'internal_error', message });
}

function getRequiredString(body: unknown, key: string): string {
  const value = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)[key]
    : undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ComposioBridgeHttpError(400, `Missing "${key}"`);
  }
  return value.trim();
}

function getRequiredRecord(body: unknown, key: string): Record<string, unknown> {
  const value = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)[key]
    : undefined;
  if (value == null) {
    throw new ComposioBridgeHttpError(400, `Missing "${key}"`);
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ComposioBridgeHttpError(400, `Invalid "${key}"`);
  }
  return value as Record<string, unknown>;
}
