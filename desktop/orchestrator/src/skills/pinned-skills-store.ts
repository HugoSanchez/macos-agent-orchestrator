import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function defaultStorePath(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'verso', 'chat-sessions.sqlite');
}

// Pinned skills are a verso-side UI concern: which skills the user has
// bookmarked into the sidebar for quick access. Independent from Hermes'
// global enable/disable (which lives in ~/.hermes/config.yaml). Stored in
// the same SQLite file as ChatStore so we have one local user-state db.
//
// Keyed by skill `name` (frontmatter name / dir basename) — the same
// identifier Hermes uses in skills.disabled, so the pin survives any
// changes to slug normalization on the URL side.
export class PinnedSkillsStore {
  private readonly db: DatabaseSync;

  constructor(storePath = process.env.VERSO_CHAT_STORE_PATH?.trim() || defaultStorePath()) {
    mkdirSync(path.dirname(storePath), { recursive: true });
    this.db = new DatabaseSync(storePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS pinned_skills (
        skill_name TEXT PRIMARY KEY,
        pinned_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pinned_skills_pinned_at
        ON pinned_skills(pinned_at DESC);
    `);
  }

  isPinned(name: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM pinned_skills WHERE skill_name = ?
    `).get(name);
    return row !== undefined;
  }

  setPinned(name: string, pinned: boolean): void {
    if (pinned) {
      this.db.prepare(`
        INSERT INTO pinned_skills (skill_name, pinned_at) VALUES (?, ?)
        ON CONFLICT(skill_name) DO NOTHING
      `).run(name, Date.now());
    } else {
      this.db.prepare(`
        DELETE FROM pinned_skills WHERE skill_name = ?
      `).run(name);
    }
  }

  listPinnedNames(): string[] {
    const rows = this.db.prepare(`
      SELECT skill_name FROM pinned_skills ORDER BY pinned_at DESC
    `).all() as { skill_name: string }[];
    return rows.map((row) => row.skill_name);
  }
}
