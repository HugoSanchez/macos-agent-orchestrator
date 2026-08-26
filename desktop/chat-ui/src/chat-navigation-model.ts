import type { ShellCommand, ShellState } from './shell-protocol';
import type { ChatModel } from './types';

export type ChatPage =
  | { kind: 'chat' }
  | { kind: 'skill'; slug: string }
  | { kind: 'hub-skill'; identifier: string }
  | { kind: 'cron'; id: string }
  | { kind: 'settings' };

export type ChatCatalog = 'connections' | 'skills' | null;

export interface ChatNavigationState {
  page: ChatPage;
  catalog: ChatCatalog;
  activeSkillName: string | null;
  activeCronName: string | null;
}

export interface ShellSessionSelection {
  id: string | null;
  persistedModel: ChatModel | null | undefined;
  shouldHydrate: boolean;
}

/**
 * Resolve every piece of UI state owned by the shell's session selection.
 * The persisted model must still be returned when the message cache already
 * points at this session: model state and message hydration can initialize at
 * different times when the app starts or a WebView is recreated.
 */
export function resolveShellSessionSelection(
  shellState: ShellState,
  hydratedSessionId: string | null,
): ShellSessionSelection {
  const id = shellState.selectedSessionId;
  const session = id ? shellState.sessions.find((candidate) => candidate.id === id) : undefined;
  return {
    id,
    persistedModel: session?.model,
    shouldHydrate: id !== hydratedSessionId,
  };
}

export type ChatNavigationAction =
  | { type: 'shell-command'; command: ShellCommand }
  | { type: 'show-chat' }
  | { type: 'show-skill'; slug: string }
  | { type: 'show-hub-skill'; identifier: string }
  | { type: 'close-connections-catalog' }
  | { type: 'close-skills-catalog' }
  | { type: 'close-catalogs' }
  | { type: 'resolve-skill-name'; name: string | null }
  | { type: 'resolve-cron-name'; name: string | null };

export function createChatNavigationState(
  connectionsCatalogOpen = false,
  skillsCatalogOpen = false,
): ChatNavigationState {
  return {
    page: { kind: 'chat' },
    catalog: connectionsCatalogOpen ? 'connections' : skillsCatalogOpen ? 'skills' : null,
    activeSkillName: null,
    activeCronName: null,
  };
}

export function reduceChatNavigation(
  state: ChatNavigationState,
  action: ChatNavigationAction,
): ChatNavigationState {
  switch (action.type) {
    case 'shell-command':
      return applyShellCommand(state, action.command);
    case 'show-chat':
      return showPage({ kind: 'chat' });
    case 'show-skill':
      return showPage({ kind: 'skill', slug: action.slug });
    case 'show-hub-skill':
      return showPage({ kind: 'hub-skill', identifier: action.identifier });
    case 'close-connections-catalog':
      return state.catalog === 'connections' ? { ...state, catalog: null } : state;
    case 'close-skills-catalog':
      return state.catalog === 'skills' ? { ...state, catalog: null } : state;
    case 'close-catalogs':
      return state.catalog === null ? state : { ...state, catalog: null };
    case 'resolve-skill-name':
      return state.page.kind === 'skill' || state.page.kind === 'hub-skill'
        ? { ...state, activeSkillName: action.name }
        : state;
    case 'resolve-cron-name':
      return state.page.kind === 'cron'
        ? { ...state, activeCronName: action.name }
        : state;
    default: {
      const unhandled: never = action;
      return unhandled;
    }
  }
}

export function isChatSurfaceActive(state: ChatNavigationState): boolean {
  return state.page.kind === 'chat' && state.catalog === null;
}

export function chatNavigationTitle(state: ChatNavigationState, chatTitle: string): string {
  switch (state.page.kind) {
    case 'settings':
      return 'Settings';
    case 'cron':
      return state.activeCronName ? `Routines: ${state.activeCronName}` : 'Routines';
    case 'skill':
    case 'hub-skill':
      return state.activeSkillName ? `Skills: ${state.activeSkillName}` : 'Skills';
    case 'chat':
      return chatTitle;
  }
}

function applyShellCommand(state: ChatNavigationState, command: ShellCommand): ChatNavigationState {
  switch (command.kind) {
    case 'open-catalog':
      return { ...state, catalog: 'connections' };
    case 'close-catalog':
      return state.catalog === 'connections' ? { ...state, catalog: null } : state;
    case 'open-skills-catalog':
      return { ...state, catalog: 'skills' };
    case 'close-skills-catalog':
      return state.catalog === 'skills' ? { ...state, catalog: null } : state;
    case 'open-cron':
      return showPage({ kind: 'cron', id: command.id });
    case 'open-settings':
      return showPage({ kind: 'settings' });
    case 'focus-chat':
      return showPage({ kind: 'chat' });
    default: {
      const unhandled: never = command;
      return unhandled;
    }
  }
}

function showPage(page: ChatPage): ChatNavigationState {
  return {
    page,
    catalog: null,
    activeSkillName: null,
    activeCronName: null,
  };
}
