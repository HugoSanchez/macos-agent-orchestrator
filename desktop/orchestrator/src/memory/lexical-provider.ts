import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { EmbedderLike } from './embedder.ts';
import type { IngestionDocument } from './ingestion/ingestion-source.ts';
import type {
  MemoryDiagnostics,
  MemoryPage,
  MemorySearchScope,
  MemoryRuntimeState,
  MemorySearchResult,
  MemoryWriteProvider,
} from './memory-provider.ts';

/**
 * The one memory backend: a single SQLite file with FTS5 (BM25 ranking),
 * opened in-process by the orchestrator. No child processes, no LLM in the
 * ingestion path.
 *
 * Two tables: `pages` are agent-curated memories (the visible agent writes
 * them itself via write_memory_page); `documents` are raw passive capture —
 * chat segments and connected-source items (Gmail/Granola/Slack/Drive)
 * indexed verbatim. Search merges both, boosting curated pages over raw
 * documents.
 *
 * Retrieval is hybrid when a local embedder is available: BM25 and cosine
 * similarity are fused with Reciprocal Rank Fusion. Embeddings are strictly
 * additive — they backfill lazily in the background and NEVER gate reads or
 * writes; until (and unless) the embedder is ready, search is BM25-only.
 */

export interface LexicalMemoryConfig {
  enabled: boolean;
  dbPath: string;
}

/** Memory is on by default; an explicit falsy VERSO_MEMORY_ENABLED is a kill switch. */
export function isMemoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.VERSO_MEMORY_ENABLED?.trim().toLowerCase();
  if (!raw) return true;
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off');
}

/**
 * Passive capture of idle chat transcripts into memory. ON by default; an
 * explicit falsy VERSO_MEMORY_CHAT_CAPTURE is a kill switch (matching
 * isMemoryEnabled / isSourceIngestionEnabled). Agent-written pages
 * (write_memory_page) and source ingestion are unaffected either way.
 */
export function isChatCaptureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.VERSO_MEMORY_CHAT_CAPTURE?.trim().toLowerCase();
  if (!raw) return true;
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off');
}

export function resolveLexicalMemoryConfig(
  hermesHome: string,
  env: NodeJS.ProcessEnv = process.env,
): LexicalMemoryConfig {
  return {
    enabled: isMemoryEnabled(env),
    // Sibling of the Hermes home (same convention as the models/ dir), so the
    // database survives app updates and profile reseeds.
    dbPath: env.VERSO_MEMORY_DB_PATH?.trim()
      || join(dirname(hermesHome), 'memory', 'verso-memory.db'),
  };
}

const MAX_SNIPPET_CHARS = 700;
const MAX_PAGE_CHARS = 20_000;
// Cap for merge-appended documents (Slack day buckets). Messages append
// oldest-first, so on overflow we keep the most-recent tail (recency ≈ relevance).
const MAX_MERGED_DOC_CHARS = 20_000;
const SNIPPET_TOKENS = 64;
// Curated pages beat raw documents for the same terms.
const PAGE_RANK_BOOST = 2;

// Hybrid retrieval. RRF_K is the standard reciprocal-rank-fusion constant;
// chunking covers the first ~12k chars of a row (Drive docs are capped at
// 40k — headline content is at the top).
const RRF_K = 60;
const CHUNK_CHARS = 1600;
const CHUNK_OVERLAP = 200;
const MAX_CHUNKS_PER_ROW = 8;
const BACKFILL_INTERVAL_MS = 20_000;
const BACKFILL_ROWS_PER_TICK = 8;

const SCHEMA = `
-- Store-instance metadata. instance_id is minted once, when the physical DB is
-- first created, and survives reopens. It changes only when the file is
-- recreated (fresh build, path change, manual wipe) — which is exactly how
-- ingestion detects that the corpus was reset and needs rebuilding.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pages (
  slug        TEXT PRIMARY KEY,
  title       TEXT,
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id          INTEGER PRIMARY KEY,
  source      TEXT NOT NULL,
  stream      TEXT,
  source_ref  TEXT NOT NULL,
  title       TEXT,
  content     TEXT NOT NULL,
  occurred_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT,
  UNIQUE(source, source_ref)
);

-- Chunked embedding vectors (Float32 BLOBs, unit-normalized), keyed by the
-- source row. source_stamp mirrors the row's updated_at so the backfill can
-- find missing/stale rows with a join instead of hashing content.
CREATE TABLE IF NOT EXISTS embeddings (
  kind         TEXT NOT NULL,     -- 'page' | 'doc'
  ref          TEXT NOT NULL,     -- pages.slug or documents.id
  chunk        INTEGER NOT NULL,
  model        TEXT NOT NULL,
  source_stamp TEXT NOT NULL,
  vector       BLOB NOT NULL,
  PRIMARY KEY (kind, ref, chunk)
);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  title, content, content='pages', content_rowid='rowid', tokenize='porter unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  title, content, content='documents', content_rowid='id', tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
  INSERT INTO pages_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
  INSERT INTO documents_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
`;

interface RankedHit {
  slug: string;
  title: string | null;
  snippet: string;
  relevance: number;
  recency: string;
  metadata?: Record<string, unknown>;
}

interface DocumentHitRow {
  id: number;
  title: string | null;
  source: string;
  stream: string | null;
  source_ref: string;
  recency: string;
}

export class LexicalMemoryProvider implements MemoryWriteProvider {
  readonly backend = 'lexical' as const;
  readonly capabilities = { search: true, getPage: true, bridgeWrites: true } as const;

  private readonly config: LexicalMemoryConfig;
  private readonly embedder: EmbedderLike | null;
  private db: DatabaseSync | null = null;
  private state: MemoryRuntimeState = 'idle';
  private instanceId: string | null = null;
  private lastError: string | null = null;
  private backfillTimer: NodeJS.Timeout | null = null;
  private backfillRunning = false;

  constructor(config: LexicalMemoryConfig, opts: { embedder?: EmbedderLike | null } = {}) {
    this.config = config;
    this.embedder = opts.embedder ?? null;
  }

  /** Idempotent, synchronous under the hood. Never throws — failures land in diagnostics. */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      this.state = 'disabled';
      return;
    }
    if (this.db) return;
    try {
      mkdirSync(dirname(this.config.dbPath), { recursive: true });
      this.db = new DatabaseSync(this.config.dbPath);
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec(SCHEMA);
      migrateSchema(this.db);
      this.instanceId = ensureInstanceId(this.db);
      this.state = 'ready';
      this.lastError = null;
    } catch (error: unknown) {
      this.state = 'error';
      this.lastError = formatError(error);
      this.db = null;
      console.warn(`[memory] lexical store failed to open: ${this.lastError}`);
      return;
    }
    // Embeddings are additive: kick the model load and backfill in the
    // background; nothing waits on them.
    if (this.embedder) {
      void this.embedder.start();
      this.backfillTimer = setInterval(() => {
        void this.runEmbeddingBackfill().catch((error: unknown) => {
          console.warn(`[memory] embedding backfill failed: ${formatError(error)}`);
        });
      }, BACKFILL_INTERVAL_MS);
      this.backfillTimer.unref();
    }
  }

  async stop(): Promise<void> {
    if (this.backfillTimer) {
      clearInterval(this.backfillTimer);
      this.backfillTimer = null;
    }
    this.db?.close();
    this.db = null;
    this.instanceId = null;
    if (this.state === 'ready') this.state = 'idle';
  }

  isReady(): boolean {
    return this.state === 'ready';
  }

  /**
   * Stable id of the physical store. Minted on first creation, unchanged across
   * reopens, and different whenever the DB file has been recreated. Ingestion
   * compares it against the last value it rebuilt for; a change means the corpus
   * was wiped and must be re-fetched. Null until the store is open.
   */
  instanceToken(): string | null {
    return this.instanceId;
  }

  getState(): MemoryRuntimeState {
    return this.state;
  }

  diagnostics(): MemoryDiagnostics {
    return {
      enabled: this.config.enabled,
      state: this.state,
      backend: this.backend,
      dbPath: this.config.dbPath,
      lastError: this.lastError,
      ...(this.db ? this.counts() : {}),
    };
  }

  async search(query: string, limit: number, scope?: MemorySearchScope): Promise<MemorySearchResult[]> {
    const bm25List = this.bm25Search(query, limit, scope);
    const vectorList = await this.vectorSearch(query, limit, scope);
    if (vectorList.length === 0) {
      return bm25List.slice(0, limit).map(toSearchResult);
    }

    // Reciprocal Rank Fusion across the two ranked lists. A hit's display
    // data comes from whichever list found it (BM25 hits carry an FTS
    // snippet; vector-only hits get a content-prefix snippet).
    const fused = new Map<string, RankedHit & { rrf: number }>();
    const accumulate = (list: RankedHit[]) => {
      list.forEach((hit, rank) => {
        const existing = fused.get(hit.slug);
        const rrf = 1 / (RRF_K + rank + 1);
        if (existing) {
          existing.rrf += rrf;
        } else {
          fused.set(hit.slug, { ...hit, rrf });
        }
      });
    };
    accumulate(bm25List);
    accumulate(vectorList);

    return [...fused.values()]
      .sort((a, b) => (b.rrf - a.rrf) || b.recency.localeCompare(a.recency))
      .slice(0, limit)
      .map((hit) => toSearchResult({ ...hit, relevance: hit.rrf }));
  }

  private bm25Search(query: string, limit: number, scope?: MemorySearchScope): RankedHit[] {
    const match = buildFtsMatchExpression(query);
    if (!match) return [];
    const db = this.requireDb();

    const pageHits = scope?.source || scope?.stream ? [] : db.prepare(`
      SELECT p.slug AS slug, p.title AS title, p.updated_at AS recency,
             -bm25(pages_fts) AS relevance,
             snippet(pages_fts, 1, '', '', '…', ${SNIPPET_TOKENS}) AS snip
      FROM pages_fts JOIN pages p ON p.rowid = pages_fts.rowid
      WHERE pages_fts MATCH ?
      ORDER BY bm25(pages_fts) LIMIT ?
    `).all(match, limit) as unknown as Array<{ slug: string; title: string | null; recency: string; relevance: number; snip: string }>;

    const filters = ['documents_fts MATCH ?'];
    const args: Array<string | number> = [match];
    if (scope?.source) {
      filters.push('d.source = ?');
      args.push(scope.source);
    }
    if (scope?.stream) {
      filters.push('d.stream = ?');
      args.push(scope.stream);
    }
    args.push(limit);
    const docHits = db.prepare(`
      SELECT d.id AS id, d.title AS title, d.source AS source, d.stream AS stream,
             d.source_ref AS source_ref,
             COALESCE(d.occurred_at, d.created_at) AS recency,
             -bm25(documents_fts) AS relevance,
             snippet(documents_fts, 1, '', '', '…', ${SNIPPET_TOKENS}) AS snip
      FROM documents_fts JOIN documents d ON d.id = documents_fts.rowid
      WHERE ${filters.join(' AND ')}
      ORDER BY bm25(documents_fts) LIMIT ?
    `).all(...args) as unknown as Array<DocumentHitRow & { relevance: number; snip: string }>;

    const merged: RankedHit[] = [
      ...pageHits.map((row) => ({
        slug: row.slug,
        title: row.title,
        snippet: row.snip,
        relevance: row.relevance * PAGE_RANK_BOOST,
        recency: row.recency ?? '',
      })),
      ...docHits.map((row) => rankedDocumentHit(row, row.snip, row.relevance)),
    ];

    return merged.sort((a, b) => (b.relevance - a.relevance) || b.recency.localeCompare(a.recency));
  }

  /**
   * Cosine ranking over all embedded chunks (vectors are unit-normalized, so
   * dot product == cosine), best chunk per row. Brute force is fine at
   * personal scale: ~20k chunks × 384 dims scans in single-digit ms. Returns
   * [] — degrading search to BM25-only — whenever the embedder is missing,
   * still loading, or fails.
   */
  private async vectorSearch(query: string, limit: number, scope?: MemorySearchScope): Promise<RankedHit[]> {
    if (!this.embedder?.isReady()) return [];
    const db = this.requireDb();
    try {
      const rows = db.prepare(`
        SELECT e.kind, e.ref, e.vector
        FROM embeddings e
        LEFT JOIN documents d ON e.kind = 'doc' AND d.id = CAST(e.ref AS INTEGER)
        WHERE e.model = ?
          ${scope?.source ? "AND e.kind = 'doc' AND d.source = ?" : ''}
          ${scope?.stream ? 'AND d.stream = ?' : ''}
      `).all(
        this.embedder.modelId,
        ...(scope?.source ? [scope.source] : []),
        ...(scope?.stream ? [scope.stream] : []),
      ) as unknown as Array<{ kind: string; ref: string; vector: Uint8Array }>;
      if (rows.length === 0) return [];

      const queryVector = await this.embedder.embedQuery(query);
      const bestByRow = new Map<string, number>();
      for (const row of rows) {
        const score = dot(queryVector, toFloat32(row.vector));
        const key = `${row.kind}:${row.ref}`;
        if (score > (bestByRow.get(key) ?? -Infinity)) bestByRow.set(key, score);
      }

      return [...bestByRow.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([key, score]) => this.hydrateVectorHit(key, score))
        .filter((hit): hit is RankedHit => hit !== null);
    } catch (error: unknown) {
      console.warn(`[memory] vector search failed; falling back to BM25: ${formatError(error)}`);
      return [];
    }
  }

  private hydrateVectorHit(key: string, score: number): RankedHit | null {
    const db = this.requireDb();
    const [kind, ...refParts] = key.split(':');
    const ref = refParts.join(':');

    if (kind === 'page') {
      const row = db.prepare('SELECT slug, title, content, updated_at FROM pages WHERE slug = ?')
        .get(ref) as { slug: string; title: string | null; content: string; updated_at: string } | undefined;
      if (!row) return null;
      return {
        slug: row.slug,
        title: row.title,
        snippet: row.content.slice(0, 240),
        relevance: score,
        recency: row.updated_at ?? '',
      };
    }
    const row = db.prepare(`
      SELECT id, title, source, stream, source_ref, content, COALESCE(occurred_at, created_at) AS recency
      FROM documents WHERE id = ?
    `).get(Number(ref)) as (DocumentHitRow & { content: string }) | undefined;
    if (!row) return null;
    return rankedDocumentHit(row, row.content.slice(0, 240), score);
  }

  async getPage(slug: string): Promise<MemoryPage | null> {
    const db = this.requireDb();
    const trimmed = slug.trim();

    // `doc:<id>` reads a raw ingested document, so the agent can open a
    // search hit that came from a transcript or email.
    const docMatch = /^doc:(\d+)$/.exec(trimmed);
    if (docMatch) {
      const row = db.prepare(
        'SELECT id, source, stream, title, content, occurred_at FROM documents WHERE id = ?',
      ).get(Number(docMatch[1])) as { id: number; source: string; stream: string | null; title: string | null; content: string; occurred_at: string | null } | undefined;
      if (!row) return null;
      return {
        slug: `doc:${row.id}`,
        title: row.title,
        content: truncate(row.content, MAX_PAGE_CHARS),
        source: row.source,
        stream: row.stream,
        occurredAt: row.occurred_at,
      };
    }

    const exact = db.prepare('SELECT slug, title, content, created_at, updated_at FROM pages WHERE slug = ?')
      .get(trimmed) as PageRow | undefined;
    const found = exact ?? this.fuzzyPageLookup(trimmed);
    if (!found) return null;
    return {
      slug: found.slug,
      title: found.title,
      content: truncate(found.content, MAX_PAGE_CHARS),
      createdAt: found.created_at,
      updatedAt: found.updated_at,
    };
  }

  async putPage(slug: string, content: string): Promise<unknown> {
    const db = this.requireDb();
    const cleanSlug = slug.trim();
    if (!cleanSlug) throw new Error('slug is required');
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO pages (slug, title, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        title = excluded.title,
        content = excluded.content,
        updated_at = excluded.updated_at
    `).run(cleanSlug, deriveTitle(cleanSlug, content), content, now, now);
    return { slug: cleanSlug, updatedAt: now };
  }

  async ingestChatSegment(segment: {
    sourceRef: string;
    sessionId: string;
    title: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string; createdAt: string }>;
    occurredAt?: string;
  }): Promise<void> {
    const content = segment.messages
      .map((message) => `${message.role} (${message.createdAt}): ${message.content}`)
      .join('\n');
    this.upsertDocument({
      source: 'chat',
      stream: segment.sessionId,
      sourceRef: segment.sourceRef,
      title: segment.title || null,
      content,
      occurredAt: segment.occurredAt ?? segment.messages.at(-1)?.createdAt ?? null,
      merge: false,
    });
  }

  async ingestSourceBatch(batch: {
    source: string;
    stream: string;
    items: IngestionDocument[];
  }): Promise<void> {
    for (const item of batch.items) {
      this.upsertDocument({
        source: batch.source,
        stream: batch.stream || null,
        sourceRef: item.sourceRef,
        title: item.title ?? null,
        content: item.content,
        occurredAt: item.occurredAt ?? null,
        merge: item.merge ?? false,
        mergeOrder: item.mergeOrder ?? null,
      });
    }
  }

  async deleteSourceDocuments(source: string): Promise<{ source: string; documentsDeleted: number }> {
    const cleanSource = source.trim();
    if (!cleanSource) throw new Error('source is required');
    const db = this.requireDb();
    const rows = db.prepare('SELECT id FROM documents WHERE source = ?').all(cleanSource) as Array<{ id: number }>;
    const deleteEmbedding = db.prepare("DELETE FROM embeddings WHERE kind = 'doc' AND ref = ?");
    for (const row of rows) deleteEmbedding.run(String(row.id));
    const result = db.prepare('DELETE FROM documents WHERE source = ?').run(cleanSource);
    return { source: cleanSource, documentsDeleted: Number(result.changes) };
  }

  async deleteDocument(source: string, sourceRef: string): Promise<boolean> {
    const db = this.requireDb();
    const row = db.prepare('SELECT id FROM documents WHERE source = ? AND source_ref = ?')
      .get(source, sourceRef) as { id: number } | undefined;
    if (!row) return false;
    db.prepare("DELETE FROM embeddings WHERE kind = 'doc' AND ref = ?").run(String(row.id));
    return Number(db.prepare('DELETE FROM documents WHERE id = ?').run(row.id).changes) > 0;
  }

  private upsertDocument(doc: {
    source: string;
    stream: string | null;
    sourceRef: string;
    title: string | null;
    content: string;
    occurredAt: string | null;
    merge: boolean;
    mergeOrder?: 'chronological' | null;
  }): void {
    const now = new Date().toISOString();
    const db = this.requireDb();

    // Merge sources (e.g. Slack day buckets) APPEND into the shared row instead
    // of replacing it. Items carry unique dedupRefs, so the scheduler's ledger
    // guarantees each one lands here exactly once — a plain append with no
    // in-content dedup is correct, and bounded by MAX_MERGED_DOC_CHARS.
    if (doc.merge) {
      const existing = db.prepare('SELECT content, occurred_at FROM documents WHERE source = ? AND source_ref = ?')
        .get(doc.source, doc.sourceRef) as { content: string; occurred_at: string | null } | undefined;
      if (existing) {
        db.prepare(`
          UPDATE documents
          SET stream = ?, title = ?, content = ?, occurred_at = ?, updated_at = ?
          WHERE source = ? AND source_ref = ?
        `).run(
          doc.stream,
          doc.title,
          doc.mergeOrder === 'chronological'
            ? mergeChronologicalContent(existing.content, doc.content)
            : mergeContent(existing.content, doc.content),
          laterIso(existing.occurred_at, doc.occurredAt),
          now,
          doc.source,
          doc.sourceRef,
        );
        return;
      }
      // No row yet: fall through and insert the first line normally.
    }

    db.prepare(`
      INSERT INTO documents (source, stream, source_ref, title, content, occurred_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, source_ref) DO UPDATE SET
        stream = excluded.stream,
        title = excluded.title,
        content = excluded.content,
        occurred_at = excluded.occurred_at,
        updated_at = excluded.updated_at
    `).run(doc.source, doc.stream, doc.sourceRef, doc.title, doc.content, doc.occurredAt, now, now);
  }

  /**
   * Embed rows whose vectors are missing or stale (edited pages, upserted
   * documents, model changes). Runs on a background interval; also callable
   * directly (tests, future "embed now" hooks). Returns rows processed.
   */
  async runEmbeddingBackfill(maxRows = BACKFILL_ROWS_PER_TICK): Promise<number> {
    if (!this.embedder?.isReady() || !this.db || this.backfillRunning) return 0;
    this.backfillRunning = true;
    try {
      const db = this.db;
      const model = this.embedder.modelId;
      const pending = [
        ...(db.prepare(`
          SELECT 'page' AS kind, p.slug AS ref, p.title AS title, p.content AS content, p.updated_at AS stamp
          FROM pages p
          LEFT JOIN embeddings e ON e.kind = 'page' AND e.ref = p.slug AND e.chunk = 0 AND e.model = ?
          WHERE e.ref IS NULL OR e.source_stamp != p.updated_at
          LIMIT ?
        `).all(model, maxRows) as unknown as PendingEmbedRow[]),
        ...(db.prepare(`
          SELECT 'doc' AS kind, CAST(d.id AS TEXT) AS ref, d.title AS title, d.content AS content,
                 COALESCE(d.updated_at, d.created_at) AS stamp
          FROM documents d
          LEFT JOIN embeddings e ON e.kind = 'doc' AND e.ref = CAST(d.id AS TEXT) AND e.chunk = 0 AND e.model = ?
          WHERE e.ref IS NULL OR e.source_stamp != COALESCE(d.updated_at, d.created_at)
          LIMIT ?
        `).all(model, maxRows) as unknown as PendingEmbedRow[]),
      ].slice(0, maxRows);

      for (const row of pending) {
        const chunks = chunkForEmbedding(row.title, row.content);
        const vectors = await this.embedder.embedPassages(chunks);
        db.exec('BEGIN');
        try {
          db.prepare('DELETE FROM embeddings WHERE kind = ? AND ref = ?').run(row.kind, row.ref);
          const insert = db.prepare(
            'INSERT INTO embeddings (kind, ref, chunk, model, source_stamp, vector) VALUES (?, ?, ?, ?, ?, ?)',
          );
          vectors.forEach((vector, index) => {
            insert.run(row.kind, row.ref, index, model, row.stamp, toBlob(vector));
          });
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      }
      return pending.length;
    } finally {
      this.backfillRunning = false;
    }
  }

  private fuzzyPageLookup(slug: string): PageRow | undefined {
    const normalized = normalizeSlug(slug);
    if (!normalized) return undefined;
    const rows = this.requireDb().prepare('SELECT slug, title, content, created_at, updated_at FROM pages')
      .all() as unknown as PageRow[];
    return rows.find((row) => normalizeSlug(row.slug) === normalized)
      ?? rows.find((row) => normalizeSlug(row.slug).includes(normalized));
  }

  private counts(): Record<string, unknown> {
    try {
      const db = this.requireDb();
      const pages = db.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS last FROM pages').get() as { n: number; last: string | null };
      const documents = db.prepare('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM documents').get() as { n: number; last: string | null };
      const embedded = db.prepare("SELECT COUNT(DISTINCT kind || ':' || ref) AS n FROM embeddings").get() as { n: number };
      return {
        pages: pages.n,
        documents: documents.n,
        lastPageWriteAt: pages.last,
        lastDocumentWriteAt: documents.last,
        embeddedRows: embedded.n,
        ...(this.embedder ? { embedder: this.embedder.diagnostics() } : {}),
      };
    } catch {
      return {};
    }
  }

  private requireDb(): DatabaseSync {
    if (!this.db || this.state !== 'ready') {
      throw new Error(`Memory is not available (state: ${this.state})`);
    }
    return this.db;
  }
}

interface PageRow {
  slug: string;
  title: string | null;
  content: string;
  created_at: string;
  updated_at: string;
}

interface PendingEmbedRow {
  kind: 'page' | 'doc';
  ref: string;
  title: string | null;
  content: string;
  stamp: string;
}

/** Read the store's instance id, minting (and persisting) one the first time. */
function ensureInstanceId(db: DatabaseSync): string {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('instance_id') as { value: string } | undefined;
  if (row?.value) return row.value;
  const id = randomUUID();
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run('instance_id', id);
  // Re-read: a concurrent opener may have won the insert (harmless — one id wins).
  const stored = db.prepare('SELECT value FROM meta WHERE key = ?').get('instance_id') as { value: string } | undefined;
  return stored?.value ?? id;
}

/** Additive columns for databases created by earlier builds. */
function migrateSchema(db: DatabaseSync): void {
  try {
    db.exec('ALTER TABLE documents ADD COLUMN updated_at TEXT');
  } catch {
    // Column already exists.
  }
}

function toSearchResult(hit: RankedHit): MemorySearchResult {
  return {
    slug: hit.slug,
    title: hit.title,
    score: Math.round(hit.relevance * 10_000) / 10_000,
    snippet: truncate(hit.snippet, MAX_SNIPPET_CHARS),
    ...(hit.metadata ? { metadata: hit.metadata } : {}),
  };
}

function rankedDocumentHit(row: DocumentHitRow, snippet: string, relevance: number): RankedHit {
  return {
    slug: `doc:${row.id}`,
    title: row.title ?? `${row.source} ${row.recency.slice(0, 10)}`.trim(),
    snippet,
    relevance,
    recency: row.recency,
    metadata: { source: row.source, stream: row.stream, sourceRef: row.source_ref },
  };
}

/** Overlapping windows over title+content, capped — headline content first. */
function chunkForEmbedding(title: string | null, content: string): string[] {
  const text = [title?.trim(), content.trim()].filter(Boolean).join('\n');
  if (text.length <= CHUNK_CHARS) return [text];
  const chunks: string[] = [];
  for (
    let start = 0;
    start < text.length && chunks.length < MAX_CHUNKS_PER_ROW;
    start += CHUNK_CHARS - CHUNK_OVERLAP
  ) {
    chunks.push(text.slice(start, start + CHUNK_CHARS));
  }
  return chunks;
}

/** Append `addition` to `existing`, keeping the most-recent tail within the cap. */
function mergeContent(existing: string, addition: string): string {
  const merged = existing ? `${existing}\n${addition}` : addition;
  if (merged.length <= MAX_MERGED_DOC_CHARS) return merged;
  return `…[earlier truncated]\n${merged.slice(merged.length - MAX_MERGED_DOC_CHARS)}`;
}

/** Sort one-line bucket entries after every merge. */
function mergeChronologicalContent(existing: string, addition: string): string {
  return mergeContent('', [...existing.split('\n'), ...addition.split('\n')]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .join('\n'));
}

/** The later of two ISO timestamps (lexicographic order works for ISO-8601); tolerates nulls. */
function laterIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

function toBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

function toFloat32(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += a[i] * b[i];
  return sum;
}

/**
 * Turn a free-form query into an FTS5 MATCH expression that can never hit
 * FTS5 syntax errors (`"`, `-`, `NEAR`, unbalanced quotes, emoji…): tokenize
 * on non-word characters, quote every token, OR them together, and also try
 * the full phrase so exact matches rank first.
 */
export function buildFtsMatchExpression(query: string): string | null {
  const tokens = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) return null;
  const quoted = tokens.map((token) => `"${token}"`);
  const parts = tokens.length > 1 ? [`"${tokens.join(' ')}"`, ...quoted] : quoted;
  return parts.join(' OR ');
}

function deriveTitle(slug: string, content: string): string {
  const heading = /^#\s+(.+)$/m.exec(content);
  if (heading) return heading[1].trim();
  const leaf = slug.split('/').at(-1) ?? slug;
  return leaf.replace(/[-_]+/g, ' ').trim();
}

function normalizeSlug(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…[truncated]`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
