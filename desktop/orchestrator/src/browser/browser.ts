import type { BrowserHost } from './browser-host.ts';
import type { BrowserSettingsStore } from './browser-settings-store.ts';
import { json, route, type Route } from '../http/router.ts';

interface HermesRestarter {
  restart(): Promise<unknown>;
}

/**
 * Routes for explicit browser lifecycle, settings, and status requests.
 */
export function buildBrowserRoutes(
  browserHost: BrowserHost,
  settings: BrowserSettingsStore,
  hermes: HermesRestarter,
): Route[] {
  const status = () => ({ ...browserHost.status(), settings: settings.get() });

  // Hermes captures BROWSER_CDP_URL and browser.* config at spawn, so any
  // change to either must restart it. Serialized on the supervisor's own
  // coalesced restart(); fire-and-forget so the HTTP response stays snappy.
  const restartHermes = () => {
    void hermes.restart().catch((error: unknown) => {
      console.warn('[browser] Hermes restart failed:', error instanceof Error ? error.message : String(error));
    });
  };

  return [
    route('GET', '/browser/status', async (_req, res) => {
      json(res, 200, status());
    }),

    // Hermes calls this immediately before attaching its typed browser tools.
    // Keeping it separate from /browser/open starts Chrome without activating a
    // window, so simply launching Verso never brings Chrome along with it.
    route('POST', '/browser/ensure', async (_req, res) => {
      if (!browserHost.isEnabled()) {
        json(res, 409, { error: 'browser_not_configured', message: 'Open the agent browser once before using it.' });
        return;
      }
      try {
        await browserHost.ensureStarted();
        const cdpUrl = browserHost.cdpUrl();
        if (!cdpUrl) throw new Error('Agent browser did not expose a CDP endpoint.');
        json(res, 200, { cdpUrl });
      } catch (error) {
        json(res, 502, { error: 'browser_unavailable', message: error instanceof Error ? error.message : String(error) });
      }
    }),

    route('POST', '/browser/open', async (_req, res) => {
      const wasEnabled = browserHost.isEnabled();
      try {
        await browserHost.open();
      } catch (error) {
        json(res, 502, { error: 'browser_unavailable', message: error instanceof Error ? error.message : String(error) });
        return;
      }
      // First-ever open creates the profile, which turns CDP attach on;
      // Hermes must relaunch to pick up the endpoint.
      if (!wasEnabled && browserHost.isEnabled()) restartHermes();
      json(res, 200, status());
    }),

    route('POST', '/browser/reset', async (_req, res) => {
      await browserHost.reset();
      restartHermes();
      json(res, 200, status());
    }),

    route('POST', '/browser/settings', async (_req, res, _params, body) => {
      const record = (body ?? {}) as Record<string, unknown>;
      if (typeof record.allowPrivateUrls !== 'boolean') {
        json(res, 400, { error: 'bad_request', message: 'allowPrivateUrls must be a boolean.' });
        return;
      }
      const next = settings.setAllowPrivateUrls(record.allowPrivateUrls);
      restartHermes();
      json(res, 200, { settings: next });
    }),
  ];
}
