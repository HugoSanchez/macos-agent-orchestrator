import { json, route, type Route } from '../http/router.ts';
import {
  CustomModelProviderError,
  type CustomModelProviderService,
} from './custom-model-provider.ts';

export function buildCustomModelProviderRoutes(service: CustomModelProviderService): Route[] {
  return [
    route('GET', '/model-auth/custom/status', async (_req, res) => {
      json(res, 200, await service.getStatus());
    }),
    route('POST', '/model-auth/custom/discover', async (_req, res, _params, body) => {
      const input = parseInput(body);
      if (!input) return json(res, 400, { error: 'bad_request', message: 'Missing baseUrl' });
      try {
        json(res, 200, await service.discover(input.baseUrl, input.apiKey));
      } catch (error: unknown) {
        handleError(res, error);
      }
    }),
    route('POST', '/model-auth/custom/connect', async (_req, res, _params, body) => {
      const input = parseInput(body);
      const model = (body as { model?: unknown } | null)?.model;
      if (!input || typeof model !== 'string') {
        return json(res, 400, { error: 'bad_request', message: 'Missing baseUrl or model' });
      }
      try {
        json(res, 200, await service.connect(input.baseUrl, input.apiKey, model));
      } catch (error: unknown) {
        handleError(res, error);
      }
    }),
    route('POST', '/model-auth/custom/disconnect', async (_req, res) => {
      await service.disconnect();
      json(res, 200, { connected: false });
    }),
  ];
}

function parseInput(body: unknown): { baseUrl: string; apiKey: string } | null {
  const baseUrl = (body as { baseUrl?: unknown } | null)?.baseUrl;
  const apiKey = (body as { apiKey?: unknown } | null)?.apiKey;
  if (typeof baseUrl !== 'string') return null;
  return { baseUrl, apiKey: typeof apiKey === 'string' ? apiKey : '' };
}

function handleError(res: Parameters<typeof json>[0], error: unknown): void {
  if (error instanceof CustomModelProviderError) {
    json(res, error.status, { error: 'custom_model_provider_failed', message: error.message });
    return;
  }
  throw error;
}
