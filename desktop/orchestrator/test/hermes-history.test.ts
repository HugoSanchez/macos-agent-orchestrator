import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  mapHermesRowsToChatMessages,
  readHermesSessionModel,
  readHermesSessionModelFromHomes,
} from '../src/chat/hermes-history.ts';
import type { ChatMessageRecord } from '../src/chat/chat-store.ts';

describe('Hermes history mapper', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reads the persisted model for a Hermes session', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'verso-hermes-history-'));
    directories.push(directory);
    const db = new DatabaseSync(path.join(directory, 'state.db'));
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT);');
    db.prepare('INSERT INTO sessions (id, model) VALUES (?, ?)').run('hermes-session', 'claude-opus-4-8');
    db.close();

    expect(readHermesSessionModel({ hermesHome: directory, hermesSessionId: 'hermes-session' }))
      .toBe('claude-opus-4-8');
    expect(readHermesSessionModel({ hermesHome: directory, hermesSessionId: 'missing' })).toBeNull();
    expect(readHermesSessionModelFromHomes({
      hermesHomes: [path.join(directory, 'missing'), directory],
      hermesSessionId: 'hermes-session',
    })).toBe('claude-opus-4-8');
  });

  it('hydrates assistant tool activity from Hermes message rows', () => {
    const localMessages: ChatMessageRecord[] = [
      {
        id: 'local-user-1',
        sessionId: 'verso-session',
        role: 'user',
        content: 'Please update the document',
        createdAt: '2026-06-01T10:00:00.000Z',
      },
      {
        id: 'local-assistant-1',
        sessionId: 'verso-session',
        role: 'assistant',
        content: 'Done.',
        createdAt: '2026-06-01T10:00:05.000Z',
      },
    ];

    const messages = mapHermesRowsToChatMessages([
      {
        id: 1,
        session_id: 'hermes-session',
        role: 'user',
        content: '[SYSTEM wrapper]\n\nPlease update the document',
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: 1780308000,
      },
      {
        id: 2,
        session_id: 'hermes-session',
        role: 'assistant',
        content: '',
        tool_call_id: null,
        tool_calls: JSON.stringify([{
          id: 'fc_1',
          call_id: 'call_1',
          type: 'function',
          function: {
            name: 'google_drive',
            arguments: JSON.stringify({ action: 'search', query: 'contract' }),
          },
        }]),
        tool_name: null,
        timestamp: 1780308001,
      },
      {
        id: 3,
        session_id: 'hermes-session',
        role: 'tool',
        content: JSON.stringify({ ok: true }),
        tool_call_id: 'call_1',
        tool_calls: null,
        tool_name: null,
        timestamp: 1780308002,
      },
      {
        id: 4,
        session_id: 'hermes-session',
        role: 'assistant',
        content: '',
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        reasoning: 'I should search the contract first, then update the document.',
        timestamp: 1780308003,
      },
      {
        id: 5,
        session_id: 'hermes-session',
        role: 'assistant',
        content: 'Done.',
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: 1780308004,
      },
    ], {
      hermesSessionId: 'hermes-session',
      versoSessionId: 'verso-session',
      localMessages,
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      id: 'local-user-1',
      role: 'user',
      content: 'Please update the document',
    });
    expect(messages[1]).toMatchObject({
      id: 'local-assistant-1',
      role: 'assistant',
      content: 'Done.',
      startedAt: Date.parse('2026-06-01T10:00:00.000Z'),
      endedAt: Date.parse('2026-06-01T10:00:05.000Z'),
      reasoning: 'I should search the contract first, then update the document.',
    });
    expect(messages[1].steps).toEqual([
      {
        type: 'tool',
        id: 'call_1',
        name: 'google_drive',
        input: { action: 'search', query: 'contract' },
        result: JSON.stringify({ ok: true }),
      },
      {
        type: 'reasoning',
        text: 'I should search the contract first, then update the document.',
      },
    ]);
  });

  it('uses local messages as the visible turn skeleton when Hermes omits a user row', () => {
    const localMessages: ChatMessageRecord[] = [
      {
        id: 'local-user-1',
        sessionId: 'verso-session',
        role: 'user',
        content: 'Create a draft',
        createdAt: '2026-06-01T10:00:00.000Z',
      },
      {
        id: 'local-assistant-1',
        sessionId: 'verso-session',
        role: 'assistant',
        content: 'Draft created.',
        createdAt: '2026-06-01T10:00:05.000Z',
      },
      {
        id: 'local-user-2',
        sessionId: 'verso-session',
        role: 'user',
        content: 'Send it',
        createdAt: '2026-06-01T10:00:10.000Z',
      },
      {
        id: 'local-assistant-2',
        sessionId: 'verso-session',
        role: 'assistant',
        content: 'Sent.',
        createdAt: '2026-06-01T10:00:20.000Z',
      },
    ];

    const messages = mapHermesRowsToChatMessages([
      {
        id: 1,
        session_id: 'hermes-session',
        role: 'user',
        content: 'Create a draft',
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: 1780308000,
      },
      {
        id: 2,
        session_id: 'hermes-session',
        role: 'assistant',
        content: '',
        tool_call_id: null,
        tool_calls: JSON.stringify([{
          call_id: 'call_draft',
          function: { name: 'mcp_verso_propose_message_draft', arguments: '{}' },
        }]),
        tool_name: null,
        timestamp: 1780308001,
      },
      {
        id: 3,
        session_id: 'hermes-session',
        role: 'tool',
        content: JSON.stringify({ draft: true }),
        tool_call_id: 'call_draft',
        tool_calls: null,
        tool_name: null,
        timestamp: 1780308002,
      },
      {
        id: 4,
        session_id: 'hermes-session',
        role: 'assistant',
        content: 'Draft created.',
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: 1780308003,
      },
      {
        id: 5,
        session_id: 'hermes-session',
        role: 'assistant',
        content: '',
        tool_call_id: null,
        tool_calls: JSON.stringify([{
          call_id: 'call_send',
          function: { name: 'mcp_verso_gmail_send_email', arguments: '{}' },
        }]),
        tool_name: null,
        timestamp: 1780308010,
      },
      {
        id: 6,
        session_id: 'hermes-session',
        role: 'tool',
        content: JSON.stringify({ sent: true }),
        tool_call_id: 'call_send',
        tool_calls: null,
        tool_name: null,
        timestamp: 1780308015,
      },
      {
        id: 7,
        session_id: 'hermes-session',
        role: 'assistant',
        content: 'Sent.',
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: 1780308020,
      },
    ], {
      hermesSessionId: 'hermes-session',
      versoSessionId: 'verso-session',
      localMessages,
    });

    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'Create a draft'],
      ['assistant', 'Draft created.'],
      ['user', 'Send it'],
      ['assistant', 'Sent.'],
    ]);
    expect(messages[1].steps?.map((step) => step.type === 'tool' ? step.name : step.type))
      .toEqual(['mcp_verso_propose_message_draft']);
    expect(messages[3].steps?.map((step) => step.type === 'tool' ? step.name : step.type))
      .toEqual(['mcp_verso_gmail_send_email']);
    expect(messages[1]).toMatchObject({
      startedAt: Date.parse('2026-06-01T10:00:00.000Z'),
      endedAt: Date.parse('2026-06-01T10:00:05.000Z'),
    });
    expect(messages[3]).toMatchObject({
      startedAt: Date.parse('2026-06-01T10:00:10.000Z'),
      endedAt: Date.parse('2026-06-01T10:00:20.000Z'),
    });
  });

  it('coalesces many Hermes assistant fragments into one saved assistant turn', () => {
    const localMessages: ChatMessageRecord[] = [
      {
        id: 'local-user',
        sessionId: 'verso-session',
        role: 'user',
        content: 'Research the account',
        createdAt: '2026-06-01T10:00:00.000Z',
      },
      {
        id: 'local-assistant',
        sessionId: 'verso-session',
        role: 'assistant',
        content: 'Research complete.',
        createdAt: '2026-06-01T10:00:10.000Z',
      },
    ];

    const messages = mapHermesRowsToChatMessages([
      {
        id: 1,
        session_id: 'hermes-session',
        role: 'user',
        content: 'Research the account',
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: 1780308000,
      },
      {
        id: 2,
        session_id: 'hermes-session',
        role: 'assistant',
        content: 'I will research this.',
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: 1780308001,
      },
      {
        id: 3,
        session_id: 'hermes-session',
        role: 'assistant',
        content: '',
        tool_call_id: null,
        tool_calls: JSON.stringify([{
          call_id: 'search_call',
          function: { name: 'search_contacts', arguments: '{}' },
        }]),
        tool_name: null,
        timestamp: 1780308002,
      },
      {
        id: 4,
        session_id: 'hermes-session',
        role: 'tool',
        content: JSON.stringify({ found: true }),
        tool_call_id: 'search_call',
        tool_calls: null,
        tool_name: null,
        timestamp: 1780308003,
      },
      {
        id: 5,
        session_id: 'hermes-session',
        role: 'assistant',
        content: 'I found the contact.',
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: 1780308004,
      },
      {
        id: 6,
        session_id: 'hermes-session',
        role: 'assistant',
        content: '',
        tool_call_id: null,
        tool_calls: JSON.stringify([{
          call_id: 'wallet_call',
          function: { name: 'lookup_wallet', arguments: '{}' },
        }]),
        tool_name: null,
        timestamp: 1780308005,
      },
      {
        id: 7,
        session_id: 'hermes-session',
        role: 'tool',
        content: JSON.stringify({ wallet: 'available' }),
        tool_call_id: 'wallet_call',
        tool_calls: null,
        tool_name: null,
        timestamp: 1780308006,
      },
      {
        id: 8,
        session_id: 'hermes-session',
        role: 'assistant',
        content: 'Research complete.',
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: 1780308007,
      },
    ], {
      hermesSessionId: 'hermes-session',
      versoSessionId: 'verso-session',
      localMessages,
    });

    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'Research the account'],
      ['assistant', 'Research complete.'],
    ]);
    expect(messages[1].steps?.filter((step) => step.type === 'tool').map((step) => step.name))
      .toEqual(['search_contacts', 'lookup_wallet']);
  });
});
