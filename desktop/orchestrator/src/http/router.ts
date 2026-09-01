import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  body: unknown,
) => Promise<void>;

export interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: RouteHandler;
}

// Sized to carry the largest legal attachment payload plus text and JSON
// overhead. Attachments cap at 20MB of raw bytes (MAX_TOTAL_ATTACHMENT_BYTES),
// which base64-inflates by ~4/3 to ~27MB on the wire; 32MB leaves headroom for
// the surrounding JSON and message content. Enforced coarsely here; the
// attachment limits in attachments.ts are the precise, per-kind gate.
const MAX_BODY = 32 * 1024 * 1024; // 32MB
const AUTH_HEADER = 'x-verso-sidecar-token';
const DRAFT_APPROVAL_HEADER = 'x-verso-draft-approval-token';
// WKWebView serializes the chat page's origin as "file://" because the shell
// enables allowFileAccessFromFileURLs (see ChatWebView.swift). Deliberately
// NOT "null": sandboxed iframes on arbitrary websites also send Origin: null,
// so allowlisting it would let them read public-route responses.
const ALLOWED_ORIGINS = new Set(['file://']);
const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOWED_HEADERS = `Content-Type, ${AUTH_HEADER}, ${DRAFT_APPROVAL_HEADER}, Authorization`;

export interface DispatchOptions {
  authSecret?: string | null;
  allowUnauthenticated?: boolean;
}

/** Read request body as parsed JSON (or null for empty bodies). */
export function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Send a JSON response. */
export function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** Register a route with :param syntax. */
export function route(method: string, path: string, handler: RouteHandler): Route {
  const keys: string[] = [];
  // Convert :param to named capture groups. Use .+ for :slug (greedy) and [^/]+ for others.
  const pattern = path.replace(/:([a-zA-Z]+)/g, (_, key) => {
    keys.push(key);
    return key === 'slug' ? '(.+)' : '([^/]+)';
  });
  return {
    method: method.toUpperCase(),
    pattern: new RegExp(`^${pattern}$`),
    keys,
    handler,
  };
}

/** Dispatch a request to the matching route. */
export async function dispatch(
  routes: Route[],
  req: IncomingMessage,
  res: ServerResponse,
  opts: DispatchOptions = {},
): Promise<void> {
  if (!isAllowedLoopbackHost(req)) {
    json(res, 400, { error: 'bad_request', message: 'Invalid Host header' });
    return;
  }

  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const pathname = url.pathname;
  const method = req.method?.toUpperCase() || 'GET';
  applyCors(req, res);

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!isPublicRoute(method, pathname) && !isAuthorized(req, opts.authSecret, opts.allowUnauthenticated)) {
    json(res, 401, { error: 'unauthorized', message: 'Missing or invalid sidecar token' });
    return;
  }

  for (const r of routes) {
    if (r.method !== method) continue;
    const match = pathname.match(r.pattern);
    if (!match) continue;

    const params: Record<string, string> = {};
    for (let i = 0; i < r.keys.length; i++) {
      params[r.keys[i]] = decodeURIComponent(match[i + 1]);
    }

    // Also expose query params
    for (const [k, v] of url.searchParams) {
      if (!(k in params)) params[k] = v;
    }

    try {
      const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readBody(req) : null;
      await r.handler(req, res, params, body);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'Invalid JSON') {
        json(res, 400, { error: 'bad_request', message: 'Invalid JSON body' });
      } else if (message === 'Request body too large') {
        json(res, 413, { error: 'payload_too_large', message });
      } else {
        console.error(`[http] ${method} ${pathname} error:`, err);
        json(res, 500, { error: 'internal_error', message });
      }
    }
    return;
  }

  json(res, 404, { error: 'not_found', message: `No route for ${method} ${pathname}` });
}

function isAllowedLoopbackHost(req: IncomingMessage): boolean {
  const header = req.headers.host;
  if (typeof header !== 'string' || header.trim() !== header || header.length === 0) return false;
  const match = header.match(/^(127\.0\.0\.1|localhost):([0-9]{1,5})$/);
  if (!match) return false;

  let url: URL;
  try {
    url = new URL(`http://${header}`);
  } catch {
    return false;
  }

  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
  if (url.hostname !== match[1]) return false;
  if (!url.port) return false;

  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  const localPort = req.socket.localPort;
  return typeof localPort !== 'number' || localPort === port;
}

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
  res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
}

function isPublicRoute(method: string, pathname: string): boolean {
  if (method === 'GET' && pathname === '/health') return true;
  if (method === 'GET' && /^\/connections\/requests\/[^/]+\/open$/.test(pathname)) return true;
  if (method === 'GET' && pathname === '/connections/callback') return true;
  if (method === 'GET' && pathname === '/connections/callback/font') return true;
  if (method === 'GET' && /^\/connectors\/custom\/[^/]+\/icon$/.test(pathname)) return true;
  if (method === 'GET' && /^\/connectors\/custom\/[^/]+\/open$/.test(pathname)) return true;
  return false;
}

function isAuthorized(req: IncomingMessage, secret: string | null | undefined, allowUnauthenticated = false): boolean {
  if (!secret) return allowUnauthenticated;
  const token = readToken(req);
  if (!token) return false;
  const expected = Buffer.from(secret, 'utf8');
  const actual = Buffer.from(token, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function readToken(req: IncomingMessage): string | null {
  const header = req.headers[AUTH_HEADER];
  if (typeof header === 'string' && header.length > 0) return header;
  if (Array.isArray(header) && typeof header[0] === 'string' && header[0].length > 0) return header[0];
  const authorization = req.headers.authorization;
  const match = typeof authorization === 'string' ? authorization.match(/^Bearer\s+(.+)$/i) : null;
  return match?.[1] ?? null;
}
