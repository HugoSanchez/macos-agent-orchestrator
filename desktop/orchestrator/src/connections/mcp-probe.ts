import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CustomConnectorAuth, CustomConnectorTransport } from './custom-connectors-store.ts';

export interface McpProbeResult {
  auth: CustomConnectorAuth;
  transport: CustomConnectorTransport;
  serverName: string | null;
  iconPath: string | null;
  iconContentType: string | null;
}

const MAX_ICON_BYTES = 256 * 1024;

interface ProbeOptions {
  iconDir?: string;
  token?: string | null;
}

export async function probeMcpServer(rawUrl: string, opts: ProbeOptions = {}): Promise<McpProbeResult> {
  const url = validateConnectorUrl(rawUrl);
  const initBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'verso', version: '1.0.0' },
    },
  };

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...bearerHeader(opts.token),
      },
      body: JSON.stringify(initBody),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error: unknown) {
    const message = error instanceof Error && error.name === 'TimeoutError'
      ? 'Timed out reaching MCP server.'
      : error instanceof Error && /certificate|tls|ssl/i.test(error.message)
        ? 'TLS error reaching MCP server.'
        : 'Unable to reach MCP server.';
    throw new Error(message);
  }

  if (res.status === 401 && res.headers.has('www-authenticate') && !opts.token) {
    const icon = await resolveConnectorIcon(url, null, opts);
    return {
      auth: 'oauth',
      transport: 'http',
      serverName: null,
      iconPath: icon?.path ?? null,
      iconContentType: icon?.contentType ?? null,
    };
  }
  if (res.status === 401 && !opts.token) {
    throw new Error('The server requires authentication — provide an API token.');
  }
  if ((res.status === 401 || res.status === 403) && opts.token) {
    throw new Error('The server rejected the API token.');
  }
  if (!res.ok) {
    if (res.status < 400 || res.status > 499) throw new Error('The URL did not respond like an MCP server.');
    const legacyTransport = await probeLegacySse(url, opts);
    if (legacyTransport) {
      const icon = await resolveConnectorIcon(url, null, opts);
      return {
        auth: opts.token ? 'bearer' : 'none',
        transport: legacyTransport,
        serverName: null,
        iconPath: icon?.path ?? null,
        iconContentType: icon?.contentType ?? null,
      };
    }
    throw new Error('The URL did not respond like an MCP server.');
  }

  const text = await res.text();
  const payload = parseMcpPayload(text, res.headers.get('content-type') ?? '');
  const serverInfo = asRecord(asRecord(payload)?.result)?.serverInfo;
  const info = asRecord(serverInfo);
  const icons = Array.isArray(info?.icons) ? info.icons : null;
  const icon = await resolveConnectorIcon(url, icons, opts);
  return {
    auth: opts.token ? 'bearer' : 'none',
    transport: 'http',
    serverName: typeof info?.name === 'string' ? info.name : null,
    iconPath: icon?.path ?? null,
    iconContentType: icon?.contentType ?? null,
  };
}

export function validateConnectorUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Enter a valid MCP server URL.');
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return url;
  throw new Error('MCP server URL must use HTTPS, except for localhost.');
}

/**
 * Resolve a brand icon for a connector, best source first:
 *   1. serverInfo.icons from the MCP initialize response (first-party).
 *   2. Icons declared in the HTML of the server origin's root page, then of
 *      each parent domain (mcp.linear.app → linear.app). Most hosted MCP
 *      endpoints live on a bare subdomain with no favicon of their own while
 *      the vendor's main domain carries the real mark — often only via
 *      <link rel="icon"/"apple-touch-icon">, not /favicon.ico.
 *   3. /favicon.ico on the same origin chain.
 * The bearer token authenticates against the MCP server only; it is sent
 * solely to same-origin serverInfo icon URLs, never to HTML pages, favicons,
 * parent domains, or third-party CDNs.
 */
export async function resolveConnectorIcon(originUrl: URL, icons: unknown[] | null, opts: ProbeOptions = {}): Promise<{ path: string; contentType: string } | null> {
  const candidates: Array<{ url: URL; withToken: boolean }> = [];
  if (icons) {
    const parsed = icons
      .map((icon) => asRecord(icon))
      .filter(Boolean)
      .map((icon) => ({
        url: typeof icon?.src === 'string' ? icon.src : typeof icon?.url === 'string' ? icon.url : '',
        size: largestIconSize(icon?.sizes),
      }))
      .filter((icon) => icon.url)
      .sort((a, b) => iconSizePreference(a.size) - iconSizePreference(b.size));
    for (const icon of parsed) {
      try {
        const url = new URL(icon.url, originUrl.origin);
        candidates.push({ url, withToken: url.origin === originUrl.origin });
      } catch {
        // Skip malformed icon URLs.
      }
    }
  }
  for (const origin of originChain(originUrl)) {
    for (const declared of await discoverHtmlIcons(origin)) {
      candidates.push({ url: declared, withToken: false });
    }
    candidates.push({ url: new URL('/favicon.ico', origin), withToken: false });
  }

  for (const candidate of candidates) {
    try {
      const fetched = await fetchIcon(candidate.url, candidate.withToken ? opts.token : null);
      if (!fetched) continue;
      const ext = iconExtension(fetched.contentType);
      const dir = opts.iconDir
        ?? process.env.VERSO_CUSTOM_CONNECTOR_ICONS_DIR?.trim()
        ?? path.join(os.homedir(), 'Library', 'Application Support', 'verso', 'custom-connector-icons');
      mkdirSync(dir, { recursive: true });
      const filename = `${createHash('sha256').update(candidate.url.toString()).digest('hex').slice(0, 24)}${ext}`;
      const filePath = path.join(dir, filename);
      writeFileSync(filePath, fetched.buffer);
      return { path: filePath, contentType: fetched.contentType };
    } catch {
      // Try next icon candidate.
    }
  }
  return null;
}

/**
 * The server origin followed by parent-domain origins (always https), e.g.
 * https://mcp.linear.app → [https://mcp.linear.app, https://linear.app].
 * Stops above two labels — a naive registrable-domain cut that avoids
 * pulling in a full public-suffix list; a miss here only costs a 404.
 */
function originChain(originUrl: URL): URL[] {
  const chain = [new URL(originUrl.origin)];
  const host = originUrl.hostname;
  if (host === 'localhost' || /^[\d.]+$/.test(host)) return chain;
  const labels = host.split('.');
  for (let start = 1; start <= labels.length - 2; start += 1) {
    chain.push(new URL(`https://${labels.slice(start).join('.')}`));
  }
  return chain;
}

const HTML_LINK_TAG = /<link\b[^>]*>/gi;
const MAX_HTML_BYTES = 512 * 1024;

/** Icon URLs declared via <link rel=…icon…> on the origin's root page, best first. */
async function discoverHtmlIcons(origin: URL): Promise<URL[]> {
  let html: string;
  try {
    const res = await fetch(origin, {
      headers: { Accept: 'text/html' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok || !(res.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) return [];
    html = (await res.text()).slice(0, MAX_HTML_BYTES);
  } catch {
    return [];
  }

  const found: Array<{ url: URL; score: number }> = [];
  for (const tag of html.match(HTML_LINK_TAG) ?? []) {
    const rel = attributeValue(tag, 'rel')?.toLowerCase() ?? '';
    if (!/(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/.test(rel)) continue;
    const href = attributeValue(tag, 'href');
    if (!href) continue;
    try {
      const url = new URL(href, origin);
      // apple-touch-icon is typically a crisp 180px PNG — the best mark most
      // sites publish; prefer it, then size closeness, then document order.
      const base = rel.includes('apple-touch-icon') ? 0 : 1000;
      found.push({ url, score: base + iconSizePreference(largestIconSize(attributeValue(tag, 'sizes'))) });
    } catch {
      // Skip malformed hrefs.
    }
  }
  return found.sort((a, b) => a.score - b.score).map((item) => item.url);
}

function attributeValue(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? (match[2] ?? match[3] ?? match[4] ?? null) : null;
}

// Rank icon sizes by distance from 128px (retina-sharp for the ~32px UI
// slots) so tiny 16px marks and giant banners both lose to a proper icon.
function iconSizePreference(size: number): number {
  return Math.abs(size - 128);
}

function parseMcpPayload(text: string, contentType: string): unknown {
  const source = contentType.includes('text/event-stream')
    ? text.split(/\r?\n/).find((line) => line.startsWith('data: '))?.slice(6) ?? ''
    : text;
  try {
    return JSON.parse(source);
  } catch {
    throw new Error('The URL did not return a valid MCP initialize response.');
  }
}

async function fetchIcon(url: URL, token: string | null | undefined): Promise<{ buffer: Buffer; contentType: string } | null> {
  const res = await fetch(url, { headers: bearerHeader(token), signal: AbortSignal.timeout(5_000) });
  if (!res.ok) return null;
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('image/')) return null;
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > MAX_ICON_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return { buffer: Buffer.concat(chunks), contentType };
}

async function probeLegacySse(url: URL, opts: ProbeOptions): Promise<CustomConnectorTransport | null> {
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'text/event-stream', ...bearerHeader(opts.token) },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return null;
  }
  const contentType = res.headers.get('content-type') ?? '';
  return res.ok && contentType.includes('text/event-stream') ? 'sse' : null;
}

function bearerHeader(token: string | null | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function largestIconSize(value: unknown): number {
  if (typeof value !== 'string') return 128;
  const sizes = value.match(/\d+x\d+/g) ?? [];
  return Math.max(0, ...sizes.map((size) => Number.parseInt(size, 10)).filter(Number.isFinite));
}

function iconExtension(contentType: string): string {
  if (contentType.includes('png')) return '.png';
  if (contentType.includes('svg')) return '.svg';
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return '.jpg';
  if (contentType.includes('webp')) return '.webp';
  return '.ico';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
