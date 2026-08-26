import { describe, expect, it } from 'vitest';
import {
  chatNavigationTitle,
  createChatNavigationState,
  isChatSurfaceActive,
  reduceChatNavigation,
  resolveShellSessionSelection,
} from './chat-navigation-model';
import type { ChatSessionSummary } from './types';

function session(id: string, model: ChatSessionSummary['model']): ChatSessionSummary {
  return {
    id,
    title: id,
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
    archivedAt: null,
    model,
    messageCount: 1,
    lastMessagePreview: null,
  };
}

describe('chat navigation model', () => {
  it('represents at most one catalog and one page', () => {
    let state = createChatNavigationState(true, true);
    expect(state.catalog).toBe('connections');

    state = reduceChatNavigation(state, {
      type: 'shell-command',
      command: { kind: 'open-skills-catalog' },
    });
    expect(state.catalog).toBe('skills');

    state = reduceChatNavigation(state, {
      type: 'shell-command',
      command: { kind: 'open-settings' },
    });
    expect(state).toMatchObject({ page: { kind: 'settings' }, catalog: null });
  });

  it('makes routine and settings navigation mutually exclusive', () => {
    let state = reduceChatNavigation(createChatNavigationState(), {
      type: 'shell-command',
      command: { kind: 'open-settings' },
    });
    state = reduceChatNavigation(state, {
      type: 'shell-command',
      command: { kind: 'open-cron', id: 'cron-1' },
    });

    expect(state.page).toEqual({ kind: 'cron', id: 'cron-1' });
    expect(chatNavigationTitle(state, 'Chat')).toBe('Routines');
  });

  it('clears stale resolved names when changing page families', () => {
    let state = reduceChatNavigation(createChatNavigationState(), {
      type: 'show-skill',
      slug: 'writer',
    });
    state = reduceChatNavigation(state, { type: 'resolve-skill-name', name: 'Writer' });
    expect(chatNavigationTitle(state, 'Chat')).toBe('Skills: Writer');

    state = reduceChatNavigation(state, {
      type: 'shell-command',
      command: { kind: 'open-cron', id: 'cron-1' },
    });
    expect(state.activeSkillName).toBeNull();

    state = reduceChatNavigation(state, { type: 'show-skill', slug: 'researcher' });
    expect(chatNavigationTitle(state, 'Chat')).toBe('Skills');
  });

  it('treats chat as actively viewed only when no catalog covers it', () => {
    let state = createChatNavigationState();
    expect(isChatSurfaceActive(state)).toBe(true);

    state = reduceChatNavigation(state, {
      type: 'shell-command',
      command: { kind: 'open-catalog' },
    });
    expect(isChatSurfaceActive(state)).toBe(false);

    state = reduceChatNavigation(state, { type: 'close-connections-catalog' });
    expect(isChatSurfaceActive(state)).toBe(true);
  });

  it('restores the persisted model even when the selected session is already hydrated', () => {
    const selection = resolveShellSessionSelection({
      sessions: [session('claude-chat', 'claude-opus-4-8')],
      selectedSessionId: 'claude-chat',
    }, 'claude-chat');

    expect(selection).toEqual({
      id: 'claude-chat',
      persistedModel: 'claude-opus-4-8',
      shouldHydrate: false,
    });
  });

  it('hydrates and restores the model when switching sessions', () => {
    const selection = resolveShellSessionSelection({
      sessions: [session('gpt-chat', 'gpt-5.5'), session('claude-chat', 'claude-opus-4-8')],
      selectedSessionId: 'claude-chat',
    }, 'gpt-chat');

    expect(selection).toEqual({
      id: 'claude-chat',
      persistedModel: 'claude-opus-4-8',
      shouldHydrate: true,
    });
  });
});
