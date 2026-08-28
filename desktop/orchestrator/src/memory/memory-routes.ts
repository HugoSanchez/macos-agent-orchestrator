import type { MemoryProvider, MemoryWriteProvider } from './memory-provider.ts';
import { json, route, type Route } from '../http/router.ts';

/**
 * HTTP surface for memory — what the verso MCP bridge proxies to Hermes as
 * search_memory / get_memory_page / write_memory_page.
 */

const MAX_SEARCH_RESULTS = 10;
const DEFAULT_SEARCH_RESULTS = 6;

export function buildMemoryRoutes(provider: MemoryProvider): Route[] {
  const routes: Route[] = [
    route('GET', '/memory/status', async (_req, res) => {
      json(res, 200, { ok: true, ...provider.diagnostics(), capabilities: provider.capabilities });
    }),

    route('POST', '/memory/search', async (_req, res, _params, body) => {
      const payload = asRecord(body);
      const query = readString(payload, 'query');
      if (!query) return badRequest(res, 'query is required');
      const limit = clampInt(payload?.limit, 1, MAX_SEARCH_RESULTS, DEFAULT_SEARCH_RESULTS);

      await respondWithProvider(res, provider, async () => ({ results: await provider.search(query, limit) }));
    }),
  ];

  if (provider.capabilities.getPage) {
    routes.push(
      route('POST', '/memory/page', async (_req, res, _params, body) => {
        const payload = asRecord(body);
        const slug = readString(payload, 'slug');
        if (!slug) return badRequest(res, 'slug is required');

        await respondWithProvider(res, provider, async () => ({
          page: await provider.getPage!(slug),
        }));
      }),
    );
  }

  if (isWriteProvider(provider)) {
    routes.push(
      route('POST', '/memory/write-page', async (_req, res, _params, body) => {
        const payload = asRecord(body);
        const slug = readString(payload, 'slug');
        const content = readString(payload, 'content');
        if (!slug || !content) return badRequest(res, 'slug and content are required');

        await respondWithProvider(res, provider, async () => ({ result: await provider.putPage(slug, content) }));
      }),
    );
  }

  return routes;
}

async function respondWithProvider(
  res: Parameters<Route['handler']>[1],
  provider: MemoryProvider,
  operation: () => Promise<Record<string, unknown>>,
): Promise<void> {
  if (!provider.isReady()) {
    json(res, 503, {
      ok: false,
      error: 'memory_unavailable',
      message: `Memory is not available right now (state: ${provider.getState()}).`,
    });
    return;
  }
  try {
    json(res, 200, { ok: true, ...(await operation()) });
  } catch (error: unknown) {
    json(res, 502, {
      ok: false,
      error: 'memory_tool_failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function badRequest(res: Parameters<Route['handler']>[1], message: string): void {
  json(res, 400, { ok: false, error: 'invalid_request', message });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? Math.floor(value) : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function isWriteProvider(provider: MemoryProvider): provider is MemoryWriteProvider {
  return provider.capabilities.bridgeWrites;
}
