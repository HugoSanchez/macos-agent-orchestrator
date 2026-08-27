import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ChatStore } from '../src/chat/chat-store.ts';

describe('ChatStore session model migration', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('adds a nullable model column to existing session databases', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'verso-chat-model-'));
    directories.push(directory);
    const storePath = path.join(directory, 'chat.sqlite');
    const legacy = new DatabaseSync(storePath);
    legacy.exec(`
      CREATE TABLE chat_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        hermes_session_id TEXT,
        archived_at TEXT
      );
      INSERT INTO chat_sessions (id, title, created_at, updated_at, hermes_session_id, archived_at)
      VALUES ('legacy', 'Legacy thread', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, NULL);
    `);
    legacy.close();

    const store = new ChatStore(storePath);
    expect(store.getSessionRecord('legacy')?.model).toBeNull();
    expect(store.setSessionModel('legacy', 'claude-opus-4-8')?.model).toBe('claude-opus-4-8');
  });

  it('backfills only model values supplied by an authoritative Hermes record', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'verso-chat-model-'));
    directories.push(directory);
    const store = new ChatStore(path.join(directory, 'chat.sqlite'));
    const created = store.createSession('Recoverable legacy chat');
    store.linkHermesSession(created.id, 'hermes-known-model');

    expect(store.backfillSessionModels((id) => id === 'hermes-known-model' ? 'claude-opus-4-8' : null)).toBe(1);
    expect(store.getSessionRecord(created.id)?.model).toBe('claude-opus-4-8');
    expect(store.backfillSessionModels(() => null)).toBe(0);
  });
});
