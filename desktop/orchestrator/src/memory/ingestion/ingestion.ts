import { json, route, type Route } from '../../http/router.ts';
import type { SourceIngestionScheduler } from './source-ingestion.ts';
import type { MemoryProvider } from '../memory-provider.ts';

/**
 * Settings → Ingestion routes. These manage per-source state and work
 * regardless of the global VERSO_INGESTION_ENABLED flag (which only gates
 * whether the background loop runs) — so the UI can list and toggle sources
 * even while the feature is globally gated.
 */
export function buildIngestionRoutes(scheduler: SourceIngestionScheduler, memoryProvider?: MemoryProvider): Route[] {
  return [
    route('GET', '/ingestion/sources', async (_req, res) => {
      json(res, 200, { sources: scheduler.listSources() });
    }),

    route('POST', '/ingestion/sources/:slug/toggle', async (_req, res, params, body) => {
      const current = scheduler.getSourceView(params.slug);
      if (!current) {
        return json(res, 404, { error: 'not_found', message: `Unknown ingestion source: ${params.slug}` });
      }

      const requested = (body as { enabled?: unknown } | null)?.enabled;
      const next = typeof requested === 'boolean' ? requested : !current.enabled;

      // Don't let a user enable a source whose connection is inactive — the
      // first fetch would just fail. (Disabling is always allowed.)
      if (next && !current.connected) {
        return json(res, 409, { error: 'not_connected', message: `${current.displayName} is not connected.` });
      }

      scheduler.setSourceEnabled(params.slug, next);
      json(res, 200, { source: scheduler.getSourceView(params.slug) });
    }),

    route('POST', '/ingestion/sources/:slug/reset', async (_req, res, params, body) => {
      const current = scheduler.getSourceView(params.slug);
      if (!current) {
        return json(res, 404, { error: 'not_found', message: `Unknown ingestion source: ${params.slug}` });
      }

      const confirm = (body as { confirm?: unknown } | null)?.confirm;
      if (confirm !== 'delete-source') {
        return json(res, 400, {
          error: 'bad_request',
          message: 'Set confirm to "delete-source" to reset ingestion state and delete passive memory documents for this source.',
        });
      }

      const ingestion = scheduler.resetSourceData(params.slug);
      const memory = memoryProvider?.deleteSourceDocuments
        ? await memoryProvider.deleteSourceDocuments(params.slug)
        : null;
      json(res, 200, { ingestion, memory });
    }),
  ];
}
