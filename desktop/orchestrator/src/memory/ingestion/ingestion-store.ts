import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Ingestion state lives in its own SQLite database (not chat-sessions.sqlite):
// external sources (gmail, slack, granola) are not chat sessions, so the
// scheduler that drains them should not depend on ChatStore, and the working
// chat schema stays untouched.

export type IngestionStatus = 'idle' | 'running' | 'failed';
export type IngestionItemStatus = 'pending' | 'processed' | 'poisoned';

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

export interface IngestionSourceState {
  source: string;
  /** Sub-stream within a source: '' for single-stream sources (gmail, granola); channel id for slack. */
  stream: string;
  enabled: boolean;
  status: IngestionStatus;
  /** Provider watermark (opaque to the store). Seeded on enable; never null while enabled. */
  cursor: string | null;
  intervalMs: number;
  nextDueAt: string | null;
  runningStartedAt: string | null;
  lastCompletedAt: string | null;
  lastError: string | null;
  failCount: number;
  updatedAt: string;
}

export interface IngestionItemRecord {
  source: string;
  stream: string;
  sourceRef: string;
  status: IngestionItemStatus;
  attempts: number;
  processedAt: string | null;
  error: string | null;
  updatedAt: string;
}

export interface IngestionDiagnostics {
  sourceCounts: Record<IngestionStatus, number>;
  itemCounts: Record<IngestionItemStatus, number>;
  sources: IngestionSourceState[];
}

function defaultStorePath(): string {
  // Co-locate the ingestion DB with the chat store so it inherits the same
  // isolation automatically: per-account in production (applyLocalStateIsolation
  // sets VERSO_CHAT_STORE_PATH to the account path before this constructs) and
  // per-test in the suite (full-server tests set a unique VERSO_CHAT_STORE_PATH).
  // Without this, parallel test servers — and multiple accounts — would all
  // share one default ingestion DB and contend on the SQLite lock.
  const chatStore = process.env.VERSO_CHAT_STORE_PATH?.trim();
  if (chatStore) {
    return `${chatStore.replace(/\.sqlite$/i, '')}-ingestion.sqlite`;
  }
  return path.join(os.homedir(), 'Library', 'Application Support', 'verso', 'ingestion.sqlite');
}

export class IngestionStore {
  private readonly storePath: string;
  private readonly db: DatabaseSync;

  constructor(storePath = process.env.VERSO_INGESTION_STORE_PATH?.trim() || defaultStorePath()) {
    this.storePath = storePath;
    mkdirSync(path.dirname(this.storePath), { recursive: true });
    this.db = new DatabaseSync(this.storePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS ingestion_state (
        source TEXT NOT NULL,
        stream TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK(status IN ('idle', 'running', 'failed')),
        cursor TEXT,
        interval_ms INTEGER NOT NULL,
        next_due_at TEXT,
        running_started_at TEXT,
        last_completed_at TEXT,
        last_error TEXT,
        fail_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source, stream)
      );

      CREATE INDEX IF NOT EXISTS idx_ingestion_state_due
        ON ingestion_state(enabled, status, next_due_at);

      CREATE TABLE IF NOT EXISTS ingestion_items (
        source TEXT NOT NULL,
        stream TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'processed', 'poisoned')),
        attempts INTEGER NOT NULL DEFAULT 0,
        processed_at TEXT,
        error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source, stream, source_ref)
      );

      CREATE INDEX IF NOT EXISTS idx_ingestion_items_status
        ON ingestion_items(source, stream, status);

      CREATE TABLE IF NOT EXISTS ingestion_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  get path(): string {
    return this.storePath;
  }

  /** Register a source/stream as a disabled row so the UI can list it. Idempotent; never overwrites an existing row. */
  ensureIngestionSource(source: string, stream: string, intervalMs = DEFAULT_INTERVAL_MS, now = new Date()): IngestionSourceState {
    const nowIso = now.toISOString();
    this.db.prepare(`
      INSERT INTO ingestion_state (
        source, stream, enabled, status, cursor, interval_ms, next_due_at,
        running_started_at, last_completed_at, last_error, fail_count, updated_at
      )
      VALUES (?, ?, 0, 'idle', NULL, ?, NULL, NULL, NULL, NULL, 0, ?)
      ON CONFLICT(source, stream) DO NOTHING
    `).run(source, stream, intervalMs, nowIso);
    return this.getSource(source, stream)!;
  }

  /**
   * Turn ingestion on for a source/stream. Seeds the cursor on the first
   * disabled->enabled transition: pass `seedCursor` (e.g. an ISO timestamp /
   * provider token computed by the caller, which owns cursor semantics).
   * A row can never be enabled with a null cursor — that would mean an
   * unbounded historical fetch — so enabling without an existing or seeded
   * cursor throws. Sets next_due_at = now so the first run happens promptly.
   */
  enableSource(
    source: string,
    stream: string,
    opts: { seedCursor?: string; intervalMs?: number } = {},
    now = new Date(),
  ): IngestionSourceState {
    const existing = this.getSource(source, stream);
    const cursor = existing?.cursor ?? opts.seedCursor ?? null;
    if (cursor === null) {
      throw new Error(`Cannot enable ingestion source ${source}/${stream || '(default)'} without a seeded cursor`);
    }
    const intervalMs = opts.intervalMs ?? existing?.intervalMs ?? DEFAULT_INTERVAL_MS;
    const nowIso = now.toISOString();
    this.db.prepare(`
      INSERT INTO ingestion_state (
        source, stream, enabled, status, cursor, interval_ms, next_due_at,
        running_started_at, last_completed_at, last_error, fail_count, updated_at
      )
      VALUES (?, ?, 1, 'idle', ?, ?, ?, NULL, NULL, NULL, 0, ?)
      ON CONFLICT(source, stream) DO UPDATE SET
        enabled = 1,
        status = CASE WHEN ingestion_state.status = 'running' THEN 'running' ELSE 'idle' END,
        cursor = excluded.cursor,
        interval_ms = excluded.interval_ms,
        next_due_at = excluded.next_due_at,
        updated_at = excluded.updated_at
    `).run(source, stream, cursor, intervalMs, nowIso, nowIso);
    return this.getSource(source, stream)!;
  }

  /**
   * Update the poll interval for an existing row. Used on startup to bring rows
   * created by an earlier build in line with the current default cadence
   * (ensureIngestionSource is DO-NOTHING on conflict, so it won't touch them).
   * Leaves cursor/enabled/next_due_at alone; the next completed run re-spaces.
   */
  setSourceInterval(source: string, stream: string, intervalMs: number, now = new Date()): IngestionSourceState | null {
    const existing = this.getSource(source, stream);
    if (!existing || existing.intervalMs === intervalMs) return existing;
    this.db.prepare(`
      UPDATE ingestion_state
      SET interval_ms = ?, updated_at = ?
      WHERE source = ? AND stream = ?
    `).run(intervalMs, now.toISOString(), source, stream);
    return this.getSource(source, stream);
  }

  /**
   * Rebuild support: re-seed an enabled source's cursor back to a fresh floor
   * and make it due now, so the next tick re-fetches from the lookback window.
   * Unlike enableSource this never flips `enabled` and always overwrites the
   * cursor (enableSource keeps an existing one). Clears failure state too.
   */
  reseedCursor(source: string, stream: string, seedCursor: string, now = new Date()): IngestionSourceState | null {
    const existing = this.getSource(source, stream);
    if (!existing) return null;
    const nowIso = now.toISOString();
    this.db.prepare(`
      UPDATE ingestion_state
      SET cursor = ?,
          status = 'idle',
          next_due_at = ?,
          running_started_at = NULL,
          last_error = NULL,
          fail_count = 0,
          updated_at = ?
      WHERE source = ? AND stream = ?
    `).run(seedCursor, nowIso, nowIso, source, stream);
    return this.getSource(source, stream);
  }

  /** Rebuild support: wipe the whole per-item dedup ledger so nothing is skipped on re-fetch. Returns rows deleted. */
  clearProcessedLedger(): number {
    const result = this.db.prepare('DELETE FROM ingestion_items').run();
    return Number(result.changes);
  }

  /** Turn ingestion off. The cursor is retained so re-enabling resumes from where it left off. */
  disableSource(source: string, stream: string, now = new Date()): IngestionSourceState | null {
    const existing = this.getSource(source, stream);
    if (!existing) return null;
    this.db.prepare(`
      UPDATE ingestion_state
      SET enabled = 0, updated_at = ?
      WHERE source = ? AND stream = ?
    `).run(now.toISOString(), source, stream);
    return this.getSource(source, stream);
  }

  /** Claim the oldest-due enabled source and flip it to 'running'. Returns null if nothing is due. */
  claimDueIngestionSource(now = new Date()): IngestionSourceState | null {
    const nowIso = now.toISOString();
    const row = this.db.prepare(`
      SELECT * FROM ingestion_state
      WHERE enabled = 1
        AND status IN ('idle', 'failed')
        AND next_due_at IS NOT NULL
        AND next_due_at <= ?
      ORDER BY next_due_at ASC
      LIMIT 1
    `).get(nowIso) as IngestionStateRow | undefined;
    if (!row) return null;

    this.db.prepare(`
      UPDATE ingestion_state
      SET status = 'running', running_started_at = ?, updated_at = ?
      WHERE source = ? AND stream = ?
    `).run(nowIso, nowIso, row.source, row.stream);

    return rowToIngestionState({ ...row, status: 'running', running_started_at: nowIso, updated_at: nowIso });
  }

  /** Commit a successful run: advance the cursor, reschedule, clear failure state. */
  completeIngestion(
    source: string,
    stream: string,
    cursor: string,
    nextDueAt: string,
    now = new Date(),
  ): IngestionSourceState | null {
    const nowIso = now.toISOString();
    this.db.prepare(`
      UPDATE ingestion_state
      SET status = 'idle',
          cursor = ?,
          next_due_at = ?,
          running_started_at = NULL,
          last_completed_at = ?,
          last_error = NULL,
          fail_count = 0,
          updated_at = ?
      WHERE source = ? AND stream = ?
    `).run(cursor, nextDueAt, nowIso, nowIso, source, stream);
    return this.getSource(source, stream);
  }

  /** Record a failed run: bump fail_count, back off via nextDueAt, leave the cursor untouched. */
  failIngestion(
    source: string,
    stream: string,
    error: string,
    nextDueAt: string,
    now = new Date(),
  ): IngestionSourceState | null {
    const nowIso = now.toISOString();
    this.db.prepare(`
      UPDATE ingestion_state
      SET status = 'failed',
          running_started_at = NULL,
          last_error = ?,
          fail_count = fail_count + 1,
          next_due_at = ?,
          updated_at = ?
      WHERE source = ? AND stream = ?
    `).run(error.slice(0, 2000), nextDueAt, nowIso, source, stream);
    return this.getSource(source, stream);
  }

  /** Reschedule without advancing the cursor or counting a failure (e.g. the source's connection is temporarily inactive). */
  deferIngestion(source: string, stream: string, nextDueAt: string, now = new Date()): IngestionSourceState | null {
    const nowIso = now.toISOString();
    this.db.prepare(`
      UPDATE ingestion_state
      SET status = 'idle',
          running_started_at = NULL,
          next_due_at = ?,
          updated_at = ?
      WHERE source = ? AND stream = ?
    `).run(nextDueAt, nowIso, source, stream);
    return this.getSource(source, stream);
  }

  /** Rescue rows stuck in 'running' (e.g. a crash mid-run) back to idle + due now. Returns the count reset. */
  resetStaleRunningIngestion(staleAfterMs: number, now = new Date()): number {
    const cutoff = new Date(now.getTime() - staleAfterMs).toISOString();
    const nowIso = now.toISOString();
    const result = this.db.prepare(`
      UPDATE ingestion_state
      SET status = 'idle',
          running_started_at = NULL,
          next_due_at = ?,
          updated_at = ?
      WHERE status = 'running'
        AND running_started_at IS NOT NULL
        AND running_started_at <= ?
    `).run(nowIso, nowIso, cutoff);
    return Number(result.changes);
  }

  getSource(source: string, stream: string): IngestionSourceState | null {
    const row = this.db.prepare(`
      SELECT * FROM ingestion_state WHERE source = ? AND stream = ?
    `).get(source, stream) as IngestionStateRow | undefined;
    return row ? rowToIngestionState(row) : null;
  }

  listSources(): IngestionSourceState[] {
    const rows = this.db.prepare(`
      SELECT * FROM ingestion_state ORDER BY source ASC, stream ASC
    `).all() as unknown as IngestionStateRow[];
    return rows.map(rowToIngestionState);
  }

  /** All streams (rows) for one source — e.g. every selected Slack channel/DM. */
  listSourceStreams(source: string): IngestionSourceState[] {
    const rows = this.db.prepare(`
      SELECT * FROM ingestion_state WHERE source = ? ORDER BY stream ASC
    `).all(source) as unknown as IngestionStateRow[];
    return rows.map(rowToIngestionState);
  }

  /** Number of processed items for a source, across all its streams. */
  countProcessedItems(source: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM ingestion_items WHERE source = ? AND status = 'processed'
    `).get(source) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /** Test/support cleanup: disable a source, clear its cursor, and wipe its item ledger. */
  resetSourceData(source: string, now = new Date()): { source: string; itemRowsDeleted: number; stateRowsReset: number } {
    const nowIso = now.toISOString();
    const itemResult = this.db.prepare('DELETE FROM ingestion_items WHERE source = ?').run(source);
    const stateResult = this.db.prepare(`
      UPDATE ingestion_state
      SET enabled = 0,
          status = 'idle',
          cursor = NULL,
          next_due_at = NULL,
          running_started_at = NULL,
          last_completed_at = NULL,
          last_error = NULL,
          fail_count = 0,
          updated_at = ?
      WHERE source = ?
    `).run(nowIso, source);
    return {
      source,
      itemRowsDeleted: Number(itemResult.changes),
      stateRowsReset: Number(stateResult.changes),
    };
  }

  getConfig(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM ingestion_config WHERE key = ?`).get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setConfig(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO ingestion_config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  // --- item-level dedup -----------------------------------------------------

  /** Of `refs`, return those NOT already processed or poisoned — i.e. the ones worth processing this run. */
  filterNewRefs(source: string, stream: string, refs: string[]): string[] {
    if (refs.length === 0) return [];
    const placeholders = refs.map(() => '?').join(',');
    const blockedRows = this.db.prepare(`
      SELECT source_ref FROM ingestion_items
      WHERE source = ? AND stream = ?
        AND status IN ('processed', 'poisoned')
        AND source_ref IN (${placeholders})
    `).all(source, stream, ...refs) as Array<{ source_ref: string }>;
    const blocked = new Set(blockedRows.map((r) => r.source_ref));
    return refs.filter((ref) => !blocked.has(ref));
  }

  /** Mark refs as in-flight ('pending') and bump their attempt counter. Terminal statuses are preserved. */
  recordPendingItems(source: string, stream: string, refs: string[], now = new Date()): void {
    if (refs.length === 0) return;
    const nowIso = now.toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO ingestion_items (source, stream, source_ref, status, attempts, processed_at, error, updated_at)
      VALUES (?, ?, ?, 'pending', 1, NULL, NULL, ?)
      ON CONFLICT(source, stream, source_ref) DO UPDATE SET
        attempts = ingestion_items.attempts + 1,
        status = CASE WHEN ingestion_items.status IN ('processed', 'poisoned')
                      THEN ingestion_items.status ELSE 'pending' END,
        updated_at = excluded.updated_at
    `);
    for (const ref of refs) stmt.run(source, stream, ref, nowIso);
  }

  markItemsProcessed(source: string, stream: string, refs: string[], now = new Date()): void {
    if (refs.length === 0) return;
    const nowIso = now.toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO ingestion_items (source, stream, source_ref, status, attempts, processed_at, error, updated_at)
      VALUES (?, ?, ?, 'processed', 1, ?, NULL, ?)
      ON CONFLICT(source, stream, source_ref) DO UPDATE SET
        status = 'processed', processed_at = excluded.processed_at, error = NULL, updated_at = excluded.updated_at
    `);
    for (const ref of refs) stmt.run(source, stream, ref, nowIso, nowIso);
  }

  markItemPoisoned(source: string, stream: string, ref: string, error: string, now = new Date()): IngestionItemRecord | null {
    const nowIso = now.toISOString();
    this.db.prepare(`
      INSERT INTO ingestion_items (source, stream, source_ref, status, attempts, processed_at, error, updated_at)
      VALUES (?, ?, ?, 'poisoned', 1, NULL, ?, ?)
      ON CONFLICT(source, stream, source_ref) DO UPDATE SET
        status = 'poisoned', error = excluded.error, updated_at = excluded.updated_at
    `).run(source, stream, ref, error.slice(0, 2000), nowIso);
    return this.getItem(source, stream, ref);
  }

  getItem(source: string, stream: string, ref: string): IngestionItemRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM ingestion_items WHERE source = ? AND stream = ? AND source_ref = ?
    `).get(source, stream, ref) as IngestionItemRow | undefined;
    return row ? rowToIngestionItem(row) : null;
  }

  getIngestionDiagnostics(): IngestionDiagnostics {
    const sources = this.listSources();
    const sourceCounts: Record<IngestionStatus, number> = { idle: 0, running: 0, failed: 0 };
    for (const source of sources) sourceCounts[source.status] += 1;

    const itemCounts: Record<IngestionItemStatus, number> = { pending: 0, processed: 0, poisoned: 0 };
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM ingestion_items GROUP BY status
    `).all() as Array<{ status: IngestionItemStatus; count: number }>;
    for (const row of rows) {
      if (row.status in itemCounts) itemCounts[row.status] = Number(row.count);
    }

    return { sourceCounts, itemCounts, sources };
  }
}

interface IngestionStateRow {
  source: string;
  stream: string;
  enabled: number;
  status: IngestionStatus;
  cursor: string | null;
  interval_ms: number;
  next_due_at: string | null;
  running_started_at: string | null;
  last_completed_at: string | null;
  last_error: string | null;
  fail_count: number;
  updated_at: string;
}

interface IngestionItemRow {
  source: string;
  stream: string;
  source_ref: string;
  status: IngestionItemStatus;
  attempts: number;
  processed_at: string | null;
  error: string | null;
  updated_at: string;
}

function rowToIngestionState(row: IngestionStateRow): IngestionSourceState {
  return {
    source: row.source,
    stream: row.stream,
    enabled: row.enabled === 1,
    status: row.status,
    cursor: row.cursor,
    intervalMs: Number(row.interval_ms),
    nextDueAt: row.next_due_at,
    runningStartedAt: row.running_started_at,
    lastCompletedAt: row.last_completed_at,
    lastError: row.last_error,
    failCount: Number(row.fail_count),
    updatedAt: row.updated_at,
  };
}

function rowToIngestionItem(row: IngestionItemRow): IngestionItemRecord {
  return {
    source: row.source,
    stream: row.stream,
    sourceRef: row.source_ref,
    status: row.status,
    attempts: Number(row.attempts),
    processedAt: row.processed_at,
    error: row.error,
    updatedAt: row.updated_at,
  };
}
