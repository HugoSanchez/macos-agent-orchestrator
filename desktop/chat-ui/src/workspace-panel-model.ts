// Pure state transitions for the workspace panel. `useWorkspacePanel` owns
// the async orchestration (fetches, staleness guards, polling); everything
// decision-shaped lives here so it stays unit-testable.

import type {
  WorkspaceEntryView,
  WorkspaceSummary,
  WorkspaceTextFileView,
  WorkspaceTreeView,
} from './workspace-api';

export interface WorkspacePanelState {
  workspaces: WorkspaceSummary[];
  selectedWorkspaceId: string | null;
  entries: WorkspaceEntryView[];
  selectedEntryPath: string | null;
  loadedFile: WorkspaceTextFileView | null;
  draftContent: string;
  errorMessage: string | null;
}

export const EMPTY_WORKSPACE_PANEL_STATE: WorkspacePanelState = {
  workspaces: [],
  selectedWorkspaceId: null,
  entries: [],
  selectedEntryPath: null,
  loadedFile: null,
  draftContent: '',
  errorMessage: null,
};

export function hasUnsavedChanges(state: WorkspacePanelState): boolean {
  return state.loadedFile !== null && state.draftContent !== state.loadedFile.content;
}

export function parentPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

/** Direct children of `parent` ('' for the workspace root). */
export function childEntries(entries: WorkspaceEntryView[], parent: string): WorkspaceEntryView[] {
  return entries.filter((entry) => parentPath(entry.path) === parent);
}

/** Insert or replace by id, keeping the list ordered by creation date. */
export function upsertWorkspace(
  workspaces: WorkspaceSummary[],
  workspace: WorkspaceSummary,
): WorkspaceSummary[] {
  const next = workspaces.some((existing) => existing.id === workspace.id)
    ? workspaces.map((existing) => (existing.id === workspace.id ? workspace : existing))
    : [...workspaces, workspace];
  return next.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function ensureMarkdownExtension(path: string): string {
  return path.toLowerCase().endsWith('.md') ? path : `${path}.md`;
}

/**
 * Where the selection lands after moving `sourcePath` → `destinationPath`:
 * the destination itself, the equivalent path inside a moved folder, or null
 * when the selection was outside the moved subtree.
 */
export function movedSelectionPath(
  selectedPath: string | null,
  sourcePath: string,
  destinationPath: string,
): string | null {
  if (selectedPath === null) return null;
  if (selectedPath === sourcePath) return destinationPath;
  if (selectedPath.startsWith(`${sourcePath}/`)) {
    return destinationPath + selectedPath.slice(sourcePath.length);
  }
  return null;
}

/** True when the selection is `entryPath` itself or nested inside it. */
export function selectionInside(selectedPath: string | null, entryPath: string): boolean {
  return selectedPath === entryPath || selectedPath?.startsWith(`${entryPath}/`) === true;
}

export function clearSelection(state: WorkspacePanelState): WorkspacePanelState {
  return { ...state, selectedEntryPath: null, loadedFile: null, draftContent: '' };
}

/** Fold a fetched tree into the state (workspace metadata + entry list). */
export function applyTree(state: WorkspacePanelState, tree: WorkspaceTreeView): WorkspacePanelState {
  return {
    ...state,
    workspaces: upsertWorkspace(state.workspaces, tree.workspace),
    entries: tree.entries,
  };
}

/** Drop a selection whose entry no longer exists in the tree. */
export function clearMissingSelection(state: WorkspacePanelState): WorkspacePanelState {
  if (
    state.selectedEntryPath === null
    || state.entries.some((entry) => entry.path === state.selectedEntryPath)
  ) {
    return state;
  }
  return clearSelection(state);
}

export interface WorkspaceRefreshPlan {
  nextId: string | null;
  selectionChanged: boolean;
  reloadTree: boolean;
  /** Re-fetch the selected file's content — only when the local copy is clean. */
  refreshSelectedFile: boolean;
}

/**
 * Decide what a workspaces poll should do: keep or re-pick the selected
 * workspace, reload its tree only when the revision moved (or on demand),
 * and refresh the open file without ever clobbering an unsaved draft.
 */
export function planWorkspaceRefresh(opts: {
  fetched: WorkspaceSummary[];
  selectedWorkspaceId: string | null;
  previousRevision: number | null;
  forceTreeReload: boolean;
  hasLoadedFile: boolean;
  hasUnsavedChanges: boolean;
}): WorkspaceRefreshPlan {
  const keepSelection = opts.selectedWorkspaceId !== null
    && opts.fetched.some((workspace) => workspace.id === opts.selectedWorkspaceId);
  const nextId = keepSelection ? opts.selectedWorkspaceId : opts.fetched[0]?.id ?? null;
  const selectionChanged = nextId !== opts.selectedWorkspaceId;
  const nextRevision = opts.fetched.find((workspace) => workspace.id === nextId)?.revision ?? null;
  const reloadTree = nextId !== null
    && (opts.forceTreeReload || selectionChanged || opts.previousRevision !== nextRevision);
  return {
    nextId,
    selectionChanged,
    reloadTree,
    refreshSelectedFile: reloadTree
      && !selectionChanged
      && opts.hasLoadedFile
      && !opts.hasUnsavedChanges,
  };
}
