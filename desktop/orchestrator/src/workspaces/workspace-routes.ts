import { statSync } from 'node:fs';
import { json, route, type Route } from '../http/router.ts';
import { convertDocumentFileToMarkdown } from '../chat/document-conversion-process.ts';
import { WorkspaceIndexer } from './workspace-indexer.ts';
import { isReadableDocument, mimeTypeFor, WorkspaceError, WorkspaceStore } from './workspace-store.ts';

const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;
const DEFAULT_DOCUMENT_READ_CHARS = 16_000;
const MAX_DOCUMENT_READ_CHARS = 40_000;
const MAX_CACHED_DOCUMENTS = 24;

export function buildWorkspaceRoutes(store: WorkspaceStore, indexer: WorkspaceIndexer): Route[] {
  const documentReader = new WorkspaceDocumentReader(store);
  return [
    route('GET', '/workspaces', async (_req, res) => {
      json(res, 200, { workspaces: store.list() });
    }),

    route('POST', '/workspaces', async (_req, res, _params, body) => {
      await respond(res, async () => ({ workspace: store.create(requiredString(body, 'name')) }));
    }),

    route('PATCH', '/workspaces/:id', async (_req, res, params, body) => {
      await respond(res, async () => ({ workspace: store.rename(params.id, requiredString(body, 'name')) }));
    }),

    route('GET', '/workspaces/:id/tree', async (_req, res, params) => {
      await respond(res, async () => treeEnvelope(store, indexer, params.id));
    }),

    route('POST', '/workspaces/:id/import', async (_req, res, params, body) => {
      await respond(res, async () => {
        const sourcePaths = stringArray(body, 'sourcePaths');
        store.importFiles(params.id, sourcePaths);
        await indexer.syncWorkspace(params.id);
        return treeEnvelope(store, indexer, params.id);
      });
    }),

    route('POST', '/workspaces/:id/folders', async (_req, res, params, body) => {
      await respond(res, async () => {
        store.createFolder(params.id, requiredString(body, 'path'));
        return treeEnvelope(store, indexer, params.id);
      });
    }),

    route('PATCH', '/workspaces/:id/entry', async (_req, res, params, body) => {
      await respond(res, async () => {
        store.moveEntry(
          params.id,
          requiredString(body, 'path'),
          requiredString(body, 'destinationPath'),
        );
        await indexer.syncWorkspace(params.id);
        return treeEnvelope(store, indexer, params.id);
      });
    }),

    route('DELETE', '/workspaces/:id/entry', async (_req, res, params) => {
      await respond(res, async () => {
        store.deleteEntry(params.id, requiredParam(params, 'path'));
        await indexer.syncWorkspace(params.id);
        return treeEnvelope(store, indexer, params.id);
      });
    }),

    route('GET', '/workspaces/:id/file', async (_req, res, params) => {
      await respond(res, async () => {
        const filePath = requiredParam(params, 'path');
        if (!isReadableDocument(filePath)) return { file: store.readText(params.id, filePath) };

        const markdown = await documentReader.read(params.id, filePath);
        const offset = boundedQueryOffset(params, 'offset', 0);
        const limit = boundedQueryLimit(params, 'limit', DEFAULT_DOCUMENT_READ_CHARS, MAX_DOCUMENT_READ_CHARS);
        const content = markdown.slice(offset, offset + limit);
        const nextOffset = offset + content.length;
        return {
          file: {
            path: filePath,
            content,
            mimeType: mimeTypeFor(filePath),
            editable: false,
            offset,
            totalChars: markdown.length,
            nextOffset: nextOffset < markdown.length ? nextOffset : null,
          },
        };
      });
    }),

    route('GET', '/workspaces/:id/attachment', async (_req, res, params) => {
      respondAttachment(res, () => store.readAttachment(params.id, requiredParam(params, 'path')));
    }),

    route('POST', '/workspaces/:id/file', async (_req, res, params, body) => {
      await respond(res, async () => {
        const filePath = requiredString(body, 'path');
        const content = requiredString(body, 'content', true);
        const workspace = store.createText(params.id, filePath, content);
        await indexer.syncWorkspace(params.id);
        return { workspace, file: store.readText(params.id, filePath) };
      });
    }),

    route('PUT', '/workspaces/:id/file', async (_req, res, params, body) => {
      await respond(res, async () => {
        const filePath = requiredString(body, 'path');
        const content = requiredString(body, 'content', true);
        const workspace = store.writeText(params.id, filePath, content);
        await indexer.syncWorkspace(params.id);
        return { workspace, file: store.readText(params.id, filePath) };
      });
    }),

    route('POST', '/workspaces/search', async (_req, res, _params, body) => {
      await respond(res, async () => {
        const query = requiredString(body, 'query');
        const workspaceId = optionalString(body, 'workspaceId');
        if (workspaceId && !store.get(workspaceId)) throw new WorkspaceError('Workspace not found.', 404);
        const limit = boundedInteger(body, 'limit', DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
        const hits = await indexer.search(query, limit, workspaceId ?? undefined);
        return {
          results: hits.map((hit) => {
            const stream = typeof hit.metadata?.stream === 'string' ? hit.metadata.stream : '';
            const stableRef = typeof hit.metadata?.sourceRef === 'string' ? hit.metadata.sourceRef : '';
            const workspace = store.get(stream);
            const prefix = stream ? `${stream}:` : '';
            return {
              workspace: workspace ? { id: workspace.id, name: workspace.name } : null,
              path: prefix && stableRef.startsWith(prefix) ? stableRef.slice(prefix.length) : hit.title,
              snippet: hit.snippet,
              score: hit.score,
            };
          }).filter((hit) => hit.workspace !== null),
        };
      });
    }),
  ];
}

function treeEnvelope(store: WorkspaceStore, indexer: WorkspaceIndexer, id: string) {
  const workspace = store.get(id);
  if (!workspace) throw new WorkspaceError('Workspace not found.', 404);
  return {
    workspace,
    entries: store.listEntries(id).map((entry) => ({
      ...entry,
      ...(entry.kind === 'file' ? { indexStatus: indexer.status(id, entry.path) ?? 'indexing' } : {}),
    })),
  };
}

async function respond(
  res: Parameters<Route['handler']>[1],
  operation: () => Promise<Record<string, unknown>>,
): Promise<void> {
  try {
    json(res, 200, await operation());
  } catch (error: unknown) {
    if (error instanceof WorkspaceError) {
      json(res, error.status, { error: 'workspace_error', message: error.message });
      return;
    }
    throw error;
  }
}

function respondAttachment(
  res: Parameters<Route['handler']>[1],
  operation: () => { content: Buffer; mimeType: string },
): void {
  try {
    const attachment = operation();
    res.writeHead(200, {
      'Content-Type': attachment.mimeType,
      'Content-Length': attachment.content.length,
      'Cache-Control': 'no-store',
    });
    res.end(attachment.content);
  } catch (error: unknown) {
    if (error instanceof WorkspaceError) {
      json(res, error.status, { error: 'workspace_error', message: error.message });
      return;
    }
    throw error;
  }
}

function record(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WorkspaceError('A JSON object is required.');
  return body as Record<string, unknown>;
}

function requiredString(body: unknown, key: string, allowEmpty = false): string {
  const value = record(body)[key];
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new WorkspaceError(`${key} is required.`);
  return allowEmpty ? value : value.trim();
}

function optionalString(body: unknown, key: string): string | null {
  const value = record(body)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringArray(body: unknown, key: string): string[] {
  const value = record(body)[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new WorkspaceError(`${key} must be an array of paths.`);
  }
  return value;
}

function boundedInteger(body: unknown, key: string, fallback: number, maximum: number): number {
  const value = record(body)[key];
  if (value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new WorkspaceError(`${key} must be a positive integer.`);
  return Math.min(parsed, maximum);
}

function boundedQueryOffset(params: Record<string, string>, key: string, fallback: number): number {
  const value = params[key];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new WorkspaceError(`${key} must be a non-negative integer.`);
  return parsed;
}

function boundedQueryLimit(params: Record<string, string>, key: string, fallback: number, maximum: number): number {
  const value = params[key];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new WorkspaceError(`${key} must be a positive integer.`);
  return Math.min(parsed, maximum);
}

interface CachedDocument {
  modifiedAtMs: number;
  size: number;
  markdown: string;
}

/** Avoid re-running document conversion for each page of an agent's read. */
class WorkspaceDocumentReader {
  private readonly cache = new Map<string, CachedDocument>();

  constructor(private readonly store: WorkspaceStore) {}

  async read(workspaceId: string, filePath: string): Promise<string> {
    const absolutePath = this.store.absoluteFilePath(workspaceId, filePath);
    const fileStat = statSync(absolutePath);
    const cached = this.cache.get(absolutePath);
    if (cached && cached.modifiedAtMs === fileStat.mtimeMs && cached.size === fileStat.size) {
      return cached.markdown;
    }

    try {
      const markdown = await convertDocumentFileToMarkdown(absolutePath);
      this.cache.set(absolutePath, { modifiedAtMs: fileStat.mtimeMs, size: fileStat.size, markdown });
      while (this.cache.size > MAX_CACHED_DOCUMENTS) {
        const oldest = this.cache.keys().next().value;
        if (!oldest) break;
        this.cache.delete(oldest);
      }
      return markdown;
    } catch (error: unknown) {
      if (error instanceof WorkspaceError) throw error;
      const message = error instanceof Error && error.message.trim()
        ? error.message
        : "Couldn't read this document.";
      throw new WorkspaceError(message, 422);
    }
  }
}

function requiredParam(params: Record<string, string>, key: string): string {
  const value = params[key];
  if (!value?.trim()) throw new WorkspaceError(`${key} is required.`);
  return value;
}
