import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function defaultStorePath(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'verso', 'chat-sessions.sqlite');
}

export type CronDescriptionSource = 'auto' | 'user';

export interface CronDescription {
  description: string;
  source: CronDescriptionSource;
  generatedAt: number;
}

// One-line LLM-generated (or user-edited) summary per cron job, cached in
// the same SQLite file as the rest of verso's local UX state. Hermes itself
// has no description field — this is purely our display sugar, so it lives
// outside ~/.hermes/.
export class CronDescriptionsStore {
  private readonly db: DatabaseSync;

  constructor(storePath = process.env.VERSO_CHAT_STORE_PATH?.trim() || defaultStorePath()) {
    mkdirSync(path.dirname(storePath), { recursive: true });
    this.db = new DatabaseSync(storePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS cron_descriptions (
        job_id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('auto', 'user')),
        generated_at INTEGER NOT NULL
      );
    `);
  }

  get(jobId: string): CronDescription | null {
    const row = this.db.prepare(`
      SELECT description, source, generated_at FROM cron_descriptions WHERE job_id = ?
    `).get(jobId) as { description: string; source: string; generated_at: number } | undefined;
    if (!row) return null;
    if (row.source !== 'auto' && row.source !== 'user') return null;
    return {
      description: row.description,
      source: row.source,
      generatedAt: row.generated_at,
    };
  }

  set(jobId: string, description: string, source: CronDescriptionSource): void {
    this.db.prepare(`
      INSERT INTO cron_descriptions (job_id, description, source, generated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        description = excluded.description,
        source = excluded.source,
        generated_at = excluded.generated_at
    `).run(jobId, description, source, Date.now());
  }

  delete(jobId: string): void {
    this.db.prepare(`DELETE FROM cron_descriptions WHERE job_id = ?`).run(jobId);
  }
}
