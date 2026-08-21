import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { json, route, type Route } from './router.ts';
import { ConnectionsService, HttpError } from '../integrations/composio.ts';

let callbackFont: Buffer | null | undefined;

export function buildConnectionsRoutes(connections: ConnectionsService): Route[] {
  return [
    route('GET', '/connections', async (_req, res, params) => {
      // `wait` (ms, capped) bounds how long we hold the response for the
      // remote sync before serving the local cache; the boot fetch uses it
      // so first paint never waits on a slow Composio round-trip.
      const rawWait = typeof params.wait === 'string' ? Number.parseInt(params.wait, 10) : Number.NaN;
      const maxWaitMs = Number.isFinite(rawWait) && rawWait > 0 ? Math.min(rawWait, 5_000) : undefined;
      const items = await connections.listConnections(maxWaitMs === undefined ? {} : { maxWaitMs });
      json(res, 200, {
        available: connections.configured,
        configured: connections.configured,
        connections: items,
      });
    }),

    route('DELETE', '/connections/:id', async (_req, res, params) => {
      try {
        await connections.deleteConnection(params.id);
        res.writeHead(204);
        res.end();
      } catch (error: unknown) {
        handleHttpError(res, error);
      }
    }),

    route('GET', '/connections/toolkits', async (_req, res, params) => {
      try {
        if (!connections.configured) {
          return json(res, 200, {
            available: false,
            configured: false,
            toolkits: [],
            nextCursor: null,
          });
        }
        const query = typeof params.query === 'string' ? params.query : undefined;
        const cursor = typeof params.cursor === 'string' && params.cursor.length > 0
          ? params.cursor
          : undefined;
        const rawLimit = typeof params.limit === 'string' ? Number.parseInt(params.limit, 10) : Number.NaN;
        const limit = Number.isFinite(rawLimit) ? rawLimit : undefined;
        const result = await connections.listToolkits({ query, cursor, limit });
        json(res, 200, {
          available: connections.configured,
          configured: connections.configured,
          toolkits: result.toolkits,
          nextCursor: result.nextCursor,
        });
      } catch (error: unknown) {
        handleHttpError(res, error);
      }
    }),

    route('POST', '/connections/request', async (req, res, _params, body) => {
      try {
        const toolkit = typeof (body as { toolkit?: unknown } | null)?.toolkit === 'string'
          ? ((body as { toolkit?: string }).toolkit ?? '').trim()
          : '';
        if (!toolkit) {
          return json(res, 400, { error: 'bad_request', message: 'Missing "toolkit"' });
        }

        const request = await connections.requestConnection(toolkit, requestBaseUrl(req));
        json(res, 201, { request });
      } catch (error: unknown) {
        handleHttpError(res, error);
      }
    }),

    route('GET', '/connections/requests/:id', async (_req, res, params) => {
      const request = await connections.getRequest(params.id);
      if (!request) {
        return json(res, 404, { error: 'not_found', message: `Unknown request: ${params.id}` });
      }

      json(res, 200, {
        available: connections.configured,
        configured: connections.configured,
        request,
      });
    }),

    route('GET', '/connections/requests/:id/open', async (_req, res, params) => {
      const redirectUrl = connections.getRequestRedirectUrl(params.id);
      if (!redirectUrl) {
        return sendHtml(
          res,
          404,
          renderCallbackPage('Connection unavailable', 'This connection link is no longer available. Return to verso and try again.'),
        );
      }

      res.writeHead(302, { Location: redirectUrl });
      res.end();
    }),

    route('GET', '/connections/callback', async (_req, res, params) => {
      const status = typeof params.status === 'string' ? params.status.toLowerCase() : '';
      const isFailed = status === 'failed';
      const title = isFailed ? 'Connection failed' : 'Connection complete';
      const message = isFailed
        ? 'The connection did not complete. You can return to verso and try again.'
        : 'You can return to verso now. The app will update automatically.';
      sendHtml(res, 200, renderCallbackPage(title, message));
    }),

    route('GET', '/connections/callback/font', async (_req, res) => {
      const font = loadCallbackFont();
      if (!font) {
        json(res, 404, { error: 'not_found', message: 'Callback font is unavailable' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'font/ttf',
        'Content-Length': font.byteLength,
        'Cache-Control': 'public, max-age=86400',
        // Hermes owns the OAuth callback on a second loopback port.
        'Access-Control-Allow-Origin': '*',
      });
      res.end(font);
    }),
  ];
}

function requestBaseUrl(req: IncomingMessage): string {
  const port = req.socket.localPort;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HttpError(500, 'Unable to determine local callback port');
  }
  return `http://127.0.0.1:${port}`;
}

export function renderCallbackPage(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      @font-face {
        font-family: "IBM Plex Sans";
        src: url("/connections/callback/font") format("truetype");
        font-style: normal;
        font-weight: 400;
        font-display: swap;
      }
      :root { color-scheme: light; }
      html, body { height: 100%; }
      body {
        margin: 0;
        font-family: "IBM Plex Sans", ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif;
        background: #F5F2EA;
        color: #34332D;
        display: flex;
        flex-direction: column;
        min-height: 100vh;
      }
      header {
        height: 38px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        font-weight: 600;
        color: #34332D;
      }
      main {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }
      h1 {
        margin: 0 0 16px;
        font-size: 35px;
        font-weight: 600;
        letter-spacing: -0.01em;
        color: #34332D;
      }
      p {
        margin: 0;
        max-width: 300px;
        text-align: center;
        font-size: 13px;
        line-height: 1.55;
        color: #55534A;
      }
    </style>
  </head>
  <body>
    <header>verso.</header>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
    </main>
  </body>
</html>`;
}

export function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
  });
  res.end(html);
}

function loadCallbackFont(): Buffer | null {
  if (callbackFont !== undefined) return callbackFont;

  const bundledDefaults = process.env.VERSO_BUNDLED_DEFAULTS?.trim();
  const candidates = [
    ...(bundledDefaults ? [join(dirname(bundledDefaults), 'Fonts', 'IBMPlexSans-Regular.ttf')] : []),
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../macos/Fonts/IBMPlexSans-Regular.ttf'),
  ];
  const fontPath = candidates.find((candidate) => existsSync(candidate));
  callbackFont = fontPath ? readFileSync(fontPath) : null;
  return callbackFont;
}

function handleHttpError(res: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    json(res, error.status, { error: 'request_failed', message: error.message });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  json(res, 500, { error: 'internal_error', message });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
