import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type ChatRole = 'user' | 'assistant';
export type DraftResolutionStatus = 'sent' | 'discarded';

export type ChatActivityStep =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool';
      id?: string;
      name: string;
      input?: unknown;
      result?: string;
    };

export interface ChatMessageRecord {
  id: string;
  sessionId: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  reasoning?: string | null;
  steps?: ChatActivityStep[];
  startedAt?: number;
  endedAt?: number;
}

export interface ChatSessionRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  hermesSessionId: string | null;
  // The model is session state, not a composer preference. Keeping it with
  // the transcript prevents a reopened conversation from silently switching
  // providers (and their pricing) after an app restart.
  model: string | null;
  archivedAt: string | null;
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  model: string | null;
  messageCount: number;
  lastMessagePreview: string | null;
}

export interface DraftResolutionRecord {
  sessionId: string;
  draftId: string;
  status: DraftResolutionStatus;
  channel: string;
  updatedAt: string;
}

export type MemoryExtractionStatus = 'idle' | 'pending' | 'running' | 'failed';

export interface MemoryExtractionState {
  sessionId: string;
  status: MemoryExtractionStatus;
  lastExtractedMessageId: string | null;
  pendingSince: string | null;
  runningStartedAt: string | null;
  lastCompletedAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface MemoryExtractionClaim {
  session: ChatSessionRecord;
  state: MemoryExtractionState;
}

export interface MemoryExtractionDiagnostics {
  enabled: boolean;
  idleThresholdMs: number;
  counts: Record<MemoryExtractionStatus, number>;
  lastCompletedAt: string | null;
  lastError: string | null;
}

function defaultStorePath(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'verso', 'chat-sessions.sqlite');
}

export class ChatStore {
  private readonly storePath: string;
  private readonly db: DatabaseSync;

  constructor(storePath = process.env.VERSO_CHAT_STORE_PATH?.trim() || defaultStorePath()) {
    this.storePath = storePath;
    mkdirSync(path.dirname(this.storePath), { recursive: true });
    this.db = new DatabaseSync(this.storePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        hermes_session_id TEXT,
        model TEXT,
        archived_at TEXT
      );

      CREATE TABLE IF NOT EXISTS local_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated_at
        ON chat_sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_local_messages_session_id
        ON local_messages(session_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS draft_resolutions (
        session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        draft_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('sent', 'discarded')),
        channel TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, draft_id)
      );

      CREATE TABLE IF NOT EXISTS memory_extraction_state (
        session_id TEXT PRIMARY KEY REFERENCES chat_sessions(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('idle', 'pending', 'running', 'failed')),
        last_extracted_message_id TEXT REFERENCES local_messages(id) ON DELETE SET NULL,
        pending_since TEXT,
        running_started_at TEXT,
        last_completed_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_extraction_status
        ON memory_extraction_state(status, pending_since);
    `);
    this.ensureColumn('chat_sessions', 'model', 'TEXT');
  }

  private ensureColumn(table: 'chat_sessions', column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
    if (columns.some((entry) => entry.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  get path(): string {
    return this.storePath;
  }

  listSessions(): ChatSessionSummary[] {
    return this.listSessionRecords().map((session) => ({
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      archivedAt: session.archivedAt,
      model: session.model,
      messageCount: 0,
      lastMessagePreview: null,
    }));
  }

  listSessionRecords(): ChatSessionRecord[] {
    const rows = this.db.prepare(`
      SELECT id, title, created_at, updated_at, hermes_session_id, model, archived_at
      FROM chat_sessions
      ORDER BY updated_at DESC
    `).all() as unknown as SessionRow[];

    return rows.map(rowToSessionRecord);
  }

  getSession(sessionId: string): ChatSessionSummary | null {
    const session = this.getSessionRecord(sessionId);
    if (!session) return null;

    return {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      archivedAt: session.archivedAt,
      model: session.model,
      messageCount: 0,
      lastMessagePreview: null,
    };
  }

  getSessionRecord(sessionId: string): ChatSessionRecord | null {
    const row = this.db.prepare(`
      SELECT id, title, created_at, updated_at, hermes_session_id, model, archived_at
      FROM chat_sessions
      WHERE id = ?
    `).get(sessionId) as SessionRow | undefined;

    return row ? rowToSessionRecord(row) : null;
  }

  createSession(title?: string, model: string | null = null): ChatSessionSummary {
    const now = new Date().toISOString();
    const id = randomUUID();
    const resolvedTitle = normalizeTitle(title) || 'New chat';

    this.db.prepare(`
      INSERT INTO chat_sessions (id, title, created_at, updated_at, hermes_session_id, model, archived_at)
      VALUES (?, ?, ?, ?, NULL, ?, NULL)
    `).run(id, resolvedTitle, now, now, model);

    return {
      id,
      title: resolvedTitle,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      model,
      messageCount: 0,
      lastMessagePreview: null,
    };
  }

  setSessionModel(sessionId: string, model: string | null): ChatSessionRecord | null {
    const session = this.getSessionRecord(sessionId);
    if (!session) return null;

    this.db.prepare(`
      UPDATE chat_sessions
      SET model = ?
      WHERE id = ?
    `).run(model, sessionId);

    return { ...session, model };
  }

  // Sessions created before `chat_sessions.model` existed can still be
  // recovered exactly when their linked Hermes session retained a model. The
  // caller supplies only validated model ids; unknown rows intentionally stay
  // unset so no conversation is silently routed to another provider.
  backfillSessionModels(resolveModel: (hermesSessionId: string) => string | null): number {
    const rows = this.db.prepare(`
      SELECT id, hermes_session_id
      FROM chat_sessions
      WHERE (model IS NULL OR trim(model) = '')
        AND hermes_session_id IS NOT NULL
        AND trim(hermes_session_id) <> ''
    `).all() as Array<{ id: unknown; hermes_session_id: unknown }>;
    const update = this.db.prepare('UPDATE chat_sessions SET model = ? WHERE id = ?');
    let restored = 0;

    for (const row of rows) {
      if (typeof row.id !== 'string' || typeof row.hermes_session_id !== 'string') continue;
      const model = resolveModel(row.hermes_session_id);
      if (!model) continue;
      update.run(model, row.id);
      restored += 1;
    }

    return restored;
  }

  appendMessage(sessionId: string, role: ChatRole, content: string): ChatMessageRecord | null {
    const session = this.getSessionRecord(sessionId);
    if (!session) return null;

    const now = new Date().toISOString();
    const messageId = randomUUID();
    this.db.prepare(`
      INSERT INTO local_messages (id, session_id, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(messageId, sessionId, role, content, now);
    this.touchSession(sessionId, now);

    return {
      id: messageId,
      sessionId,
      role,
      content,
      createdAt: now,
    };
  }

  markMemoryExtractionPending(sessionId: string): MemoryExtractionState | null {
    const session = this.getSessionRecord(sessionId);
    if (!session) return null;

    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO memory_extraction_state (
        session_id, status, last_extracted_message_id, pending_since,
        running_started_at, last_completed_at, last_error, updated_at
      )
      VALUES (?, 'pending', NULL, ?, NULL, NULL, NULL, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        status = 'pending',
        pending_since = COALESCE(memory_extraction_state.pending_since, excluded.pending_since),
        running_started_at = NULL,
        last_error = NULL,
        updated_at = excluded.updated_at
    `).run(sessionId, now, now);

    return this.getMemoryExtractionState(sessionId);
  }

  claimDueMemoryExtraction(idleThresholdMs: number, now = new Date()): MemoryExtractionClaim | null {
    const cutoff = new Date(now.getTime() - idleThresholdMs).toISOString();
    const row = this.db.prepare(`
      SELECT
        s.id, s.title, s.created_at, s.updated_at, s.hermes_session_id, s.archived_at,
        m.status, m.last_extracted_message_id, m.pending_since, m.running_started_at,
        m.last_completed_at, m.last_error, m.updated_at AS memory_updated_at
      FROM memory_extraction_state m
      JOIN chat_sessions s ON s.id = m.session_id
      WHERE m.status = 'pending'
        AND s.archived_at IS NULL
        AND s.updated_at <= ?
        AND EXISTS (
          SELECT 1
          FROM local_messages lm
          WHERE lm.session_id = s.id
            AND (m.last_extracted_message_id IS NULL OR lm.created_at > (
              SELECT created_at FROM local_messages WHERE id = m.last_extracted_message_id
            ))
        )
      ORDER BY s.updated_at ASC
      LIMIT 1
    `).get(cutoff) as (SessionRow & MemoryExtractionStateRow) | undefined;

    if (!row) return null;

    const startedAt = now.toISOString();
    const result = this.db.prepare(`
      UPDATE memory_extraction_state
      SET status = 'running',
          running_started_at = ?,
          updated_at = ?
      WHERE session_id = ?
        AND status = 'pending'
    `).run(startedAt, startedAt, row.id);

    if (result.changes !== 1) return null;

    return {
      session: rowToSessionRecord(row),
      state: rowToMemoryExtractionState({
        session_id: row.id,
        status: 'running',
        last_extracted_message_id: row.last_extracted_message_id,
        pending_since: row.pending_since,
        running_started_at: startedAt,
        last_completed_at: row.last_completed_at,
        last_error: row.last_error,
        updated_at: startedAt,
      }),
    };
  }

  completeMemoryExtraction(sessionId: string, lastExtractedMessageId: string): MemoryExtractionState | null {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE memory_extraction_state
      SET status = 'idle',
          last_extracted_message_id = ?,
          pending_since = NULL,
          running_started_at = NULL,
          last_completed_at = ?,
          last_error = NULL,
          updated_at = ?
      WHERE session_id = ?
    `).run(lastExtractedMessageId, now, now, sessionId);
    return this.getMemoryExtractionState(sessionId);
  }

  failMemoryExtraction(sessionId: string, error: string): MemoryExtractionState | null {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE memory_extraction_state
      SET status = 'failed',
          running_started_at = NULL,
          last_error = ?,
          updated_at = ?
      WHERE session_id = ?
    `).run(error.slice(0, 2000), now, sessionId);
    return this.getMemoryExtractionState(sessionId);
  }

  resetStaleRunningMemoryExtractions(staleAfterMs: number, now = new Date()): number {
    const cutoff = new Date(now.getTime() - staleAfterMs).toISOString();
    const result = this.db.prepare(`
      UPDATE memory_extraction_state
      SET status = 'pending',
          running_started_at = NULL,
          updated_at = ?
      WHERE status = 'running'
        AND running_started_at <= ?
    `).run(now.toISOString(), cutoff);
    return Number(result.changes);
  }

  getMemoryExtractionState(sessionId: string): MemoryExtractionState | null {
    const row = this.db.prepare(`
      SELECT session_id, status, last_extracted_message_id, pending_since,
             running_started_at, last_completed_at, last_error, updated_at
      FROM memory_extraction_state
      WHERE session_id = ?
    `).get(sessionId) as MemoryExtractionStateRow | undefined;
    return row ? rowToMemoryExtractionState(row) : null;
  }

  getMessagesForMemoryExtraction(
    sessionId: string,
    lastExtractedMessageId: string | null,
  ): ChatMessageRecord[] {
    const rows = this.db.prepare(`
      SELECT id, session_id, role, content, created_at
      FROM local_messages
      WHERE session_id = ?
        AND (? IS NULL OR created_at > (
          SELECT created_at FROM local_messages WHERE id = ?
        ))
      ORDER BY created_at ASC, id ASC
    `).all(sessionId, lastExtractedMessageId, lastExtractedMessageId) as unknown as MessageRow[];

    return rows.map(rowToMessageRecord);
  }

  getMemoryExtractionDiagnostics(
    enabled: boolean,
    idleThresholdMs: number,
  ): MemoryExtractionDiagnostics {
    const counts: Record<MemoryExtractionStatus, number> = {
      idle: 0,
      pending: 0,
      running: 0,
      failed: 0,
    };
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM memory_extraction_state
      GROUP BY status
    `).all() as Array<{ status: MemoryExtractionStatus; count: number }>;
    for (const row of rows) {
      if (row.status in counts) counts[row.status] = row.count;
    }
    const latest = this.db.prepare(`
      SELECT last_completed_at, last_error
      FROM memory_extraction_state
      ORDER BY COALESCE(last_completed_at, updated_at) DESC
      LIMIT 1
    `).get() as { last_completed_at: string | null; last_error: string | null } | undefined;
    return {
      enabled,
      idleThresholdMs,
      counts,
      lastCompletedAt: latest?.last_completed_at ?? null,
      lastError: latest?.last_error ?? null,
    };
  }

  getMessages(sessionId: string): ChatMessageRecord[] | null {
    const exists = this.db.prepare(`
      SELECT 1
      FROM chat_sessions
      WHERE id = ?
    `).get(sessionId);
    if (!exists) return null;

    const rows = this.db.prepare(`
      SELECT id, session_id, role, content, created_at
      FROM local_messages
      WHERE session_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(sessionId) as unknown as MessageRow[];

    return rows.map(rowToMessageRecord);
  }

  linkHermesSession(sessionId: string, hermesSessionId: string): void {
    const session = this.getSessionRecord(sessionId);
    if (!session) return;

    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE chat_sessions
      SET hermes_session_id = ?, updated_at = ?
      WHERE id = ?
    `).run(hermesSessionId, now, sessionId);
  }

  touchSession(sessionId: string, updatedAt = new Date().toISOString()): void {
    this.db.prepare(`
      UPDATE chat_sessions
      SET updated_at = ?
      WHERE id = ?
    `).run(updatedAt, sessionId);
  }

  recordDraftResolution(
    sessionId: string,
    draftId: string,
    status: DraftResolutionStatus,
    channel: string,
  ): DraftResolutionRecord | null {
    const session = this.getSessionRecord(sessionId);
    if (!session) return null;

    const resolvedDraftId = normalizeDraftId(draftId);
    const resolvedChannel = normalizeChannel(channel);
    if (!resolvedDraftId || !resolvedChannel) return null;

    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO draft_resolutions (session_id, draft_id, status, channel, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, draft_id) DO UPDATE SET
        status = excluded.status,
        channel = excluded.channel,
        updated_at = excluded.updated_at
    `).run(sessionId, resolvedDraftId, status, resolvedChannel, now);
    this.touchSession(sessionId, now);

    return {
      sessionId,
      draftId: resolvedDraftId,
      status,
      channel: resolvedChannel,
      updatedAt: now,
    };
  }

  listDraftResolutions(sessionId: string): DraftResolutionRecord[] {
    const rows = this.db.prepare(`
      SELECT session_id, draft_id, status, channel, updated_at
      FROM draft_resolutions
      WHERE session_id = ?
    `).all(sessionId) as unknown as DraftResolutionRow[];

    return rows.map(rowToDraftResolutionRecord);
  }

  renameSession(sessionId: string, title: string): ChatSessionRecord | null {
    const session = this.getSessionRecord(sessionId);
    if (!session) return null;

    const resolvedTitle = normalizeTitle(title);
    if (!resolvedTitle) return session;

    this.db.prepare(`
      UPDATE chat_sessions
      SET title = ?
      WHERE id = ?
    `).run(resolvedTitle, sessionId);

    return {
      ...session,
      title: resolvedTitle,
    };
  }

  archiveSession(sessionId: string): ChatSessionRecord | null {
    const session = this.getSessionRecord(sessionId);
    if (!session) return null;

    const archivedAt = new Date().toISOString();
    this.db.prepare(`
      UPDATE chat_sessions
      SET archived_at = ?
      WHERE id = ?
    `).run(archivedAt, sessionId);

    return {
      ...session,
      archivedAt,
    };
  }

  unarchiveSession(sessionId: string): ChatSessionRecord | null {
    const session = this.getSessionRecord(sessionId);
    if (!session) return null;

    this.db.prepare(`
      UPDATE chat_sessions
      SET archived_at = NULL
      WHERE id = ?
    `).run(sessionId);

    return {
      ...session,
      archivedAt: null,
    };
  }
}

interface SessionRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  hermes_session_id: string | null;
  model: string | null;
  archived_at: string | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: ChatRole;
  content: string;
  created_at: string;
}

interface DraftResolutionRow {
  session_id: string;
  draft_id: string;
  status: DraftResolutionStatus;
  channel: string;
  updated_at: string;
}

interface MemoryExtractionStateRow {
  session_id: string;
  status: MemoryExtractionStatus;
  last_extracted_message_id: string | null;
  pending_since: string | null;
  running_started_at: string | null;
  last_completed_at: string | null;
  last_error: string | null;
  updated_at: string;
}

function rowToSessionRecord(row: SessionRow): ChatSessionRecord {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hermesSessionId: row.hermes_session_id,
    model: row.model,
    archivedAt: row.archived_at,
  };
}

function rowToMessageRecord(row: MessageRow): ChatMessageRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}

function rowToDraftResolutionRecord(row: DraftResolutionRow): DraftResolutionRecord {
  return {
    sessionId: row.session_id,
    draftId: row.draft_id,
    status: row.status,
    channel: row.channel,
    updatedAt: row.updated_at,
  };
}

function rowToMemoryExtractionState(row: MemoryExtractionStateRow): MemoryExtractionState {
  return {
    sessionId: row.session_id,
    status: row.status,
    lastExtractedMessageId: row.last_extracted_message_id,
    pendingSince: row.pending_since,
    runningStartedAt: row.running_started_at,
    lastCompletedAt: row.last_completed_at,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

function normalizeTitle(input: string | undefined): string {
  if (!input) return '';
  const compact = input.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  return compact.length > 80 ? `${compact.slice(0, 80)}...` : compact;
}

function normalizeDraftId(input: string): string {
  return input.trim().slice(0, 128);
}

function normalizeChannel(input: string): string {
  return input.trim().toLowerCase().slice(0, 64);
}
