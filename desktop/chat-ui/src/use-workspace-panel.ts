import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  createWorkspace,
  createWorkspaceFile,
  createWorkspaceFolder,
  deleteWorkspaceEntry,
  getWorkspaceFile,
  getWorkspaces,
  getWorkspaceTree,
  importWorkspaceFiles,
  moveWorkspaceEntry,
  renameWorkspace,
  writeWorkspaceFile,
  type WorkspaceEntryView,
  type WorkspaceSummary,
  type WorkspaceTreeView,
} from './workspace-api';
import {
  applyTree,
  clearMissingSelection,
  clearSelection,
  EMPTY_WORKSPACE_PANEL_STATE,
  ensureMarkdownExtension,
  hasUnsavedChanges,
  movedSelectionPath,
  planWorkspaceRefresh,
  selectionInside,
  upsertWorkspace,
  type WorkspacePanelState,
} from './workspace-panel-model';
import { canPickNativeFiles, pickNativeFiles } from './native-file-picker';
import { useIsSystemAsleep } from './useSystemSleep';

const POLL_MS = 2_000;

export interface UseWorkspacePanelOptions {
  /** Panel visibility — polling only runs while the panel is showing. */
  open: boolean;
  connected: boolean;
  accountId: string | null;
}

export interface WorkspacePanelController extends WorkspacePanelState {
  selectedWorkspace: WorkspaceSummary | null;
  selectedEntry: WorkspaceEntryView | null;
  hasUnsavedChanges: boolean;
  isLoading: boolean;
  isSaving: boolean;
  canImportFiles: boolean;
  selectWorkspace: (id: string) => void;
  createWorkspace: (name: string) => void;
  renameSelectedWorkspace: (name: string) => void;
  importFiles: () => void;
  importDroppedFiles: (paths: string[]) => void;
  createFolder: (path: string) => void;
  createMarkdownFile: (path: string) => void;
  moveEntry: (path: string, destinationPath: string) => void;
  deleteEntry: (path: string) => void;
  selectEntry: (path: string) => void;
  setDraftContent: (content: string) => void;
  saveSelectedFile: () => void;
  discardChanges: () => void;
}

/**
 * Owns all workspace transport and async orchestration; the pure decisions
 * live in `workspace-panel-model`. Workspaces are panel state only — selecting
 * one never changes the current conversation or its prompt context.
 */
export function useWorkspacePanel({ open, connected, accountId }: UseWorkspacePanelOptions): WorkspacePanelController {
  const [state, setState] = useState<WorkspacePanelState>(EMPTY_WORKSPACE_PANEL_STATE);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const asleep = useIsSystemAsleep();

  // Async flows read the latest state through this ref so a poll landing
  // mid-operation can't act on a stale snapshot.
  const stateRef = useRef(state);
  stateRef.current = state;
  // Bumped on every sidecar (re)connect; in-flight responses from the previous
  // connection are dropped instead of applied to the new one.
  const generationRef = useRef(0);
  const refreshSequenceRef = useRef(0);

  useEffect(() => {
    generationRef.current += 1;
    refreshSequenceRef.current += 1;
    setIsLoading(false);
    setIsSaving(false);
  }, [connected]);

  useLayoutEffect(() => {
    generationRef.current += 1;
    refreshSequenceRef.current += 1;
    stateRef.current = EMPTY_WORKSPACE_PANEL_STATE;
    setState(EMPTY_WORKSPACE_PANEL_STATE);
    setIsLoading(false);
    setIsSaving(false);
  }, [accountId]);

  const fail = useCallback((error: unknown, generation: number) => {
    if (generation !== generationRef.current) return;
    const message = error instanceof Error ? error.message : String(error);
    setState((prev) => ({ ...prev, errorMessage: message }));
  }, []);

  /** False (and surfaces the error) while an unsaved draft would be lost. */
  const canLeaveDraft = useCallback((): boolean => {
    if (!hasUnsavedChanges(stateRef.current)) return true;
    setState((prev) => ({ ...prev, errorMessage: 'Save or discard your changes first.' }));
    return false;
  }, []);

  const loadFile = useCallback(async (
    workspaceId: string,
    entry: WorkspaceEntryView,
    generation: number,
  ) => {
    if (entry.kind !== 'file' || !entry.editable) return;
    try {
      const file = await getWorkspaceFile(workspaceId, entry.path);
      if (generation !== generationRef.current) return;
      setState((prev) => (
        prev.selectedWorkspaceId === workspaceId && prev.selectedEntryPath === entry.path
          ? { ...prev, loadedFile: file, draftContent: file.content }
          : prev
      ));
    } catch (error: unknown) {
      fail(error, generation);
    }
  }, [fail]);

  /** Returns the fetched tree so callers can act on the fresh entries. */
  const loadTree = useCallback(async (
    workspaceId: string,
    generation: number,
  ): Promise<WorkspaceTreeView | null> => {
    try {
      const tree = await getWorkspaceTree(workspaceId);
      if (generation !== generationRef.current) return null;
      setState((prev) => (
        prev.selectedWorkspaceId === workspaceId
          ? clearMissingSelection({ ...applyTree(prev, tree), errorMessage: null })
          : prev
      ));
      return tree;
    } catch (error: unknown) {
      fail(error, generation);
      return null;
    }
  }, [fail]);

  const refresh = useCallback(async (forceTreeReload: boolean) => {
    const generation = generationRef.current;
    const sequence = ++refreshSequenceRef.current;
    if (stateRef.current.workspaces.length === 0) setIsLoading(true);
    try {
      const fetched = await getWorkspaces();
      if (generation !== generationRef.current || sequence !== refreshSequenceRef.current) return;
      const current = stateRef.current;
      const plan = planWorkspaceRefresh({
        fetched,
        selectedWorkspaceId: current.selectedWorkspaceId,
        previousRevision: current.workspaces
          .find((workspace) => workspace.id === current.selectedWorkspaceId)?.revision ?? null,
        forceTreeReload,
        hasLoadedFile: current.loadedFile !== null,
        hasUnsavedChanges: hasUnsavedChanges(current),
      });
      setState((prev) => {
        const next = {
          ...prev,
          workspaces: fetched,
          selectedWorkspaceId: plan.nextId,
          errorMessage: null,
        };
        return plan.selectionChanged ? clearSelection({ ...next, entries: [] }) : next;
      });
      if (plan.nextId !== null && plan.reloadTree) {
        const tree = await loadTree(plan.nextId, generation);
        // The selection is unchanged when refreshSelectedFile is set; re-read
        // the still-present entry so an external edit lands in the editor.
        const entry = plan.refreshSelectedFile
          ? tree?.entries.find((candidate) => candidate.path === current.selectedEntryPath)
          : undefined;
        if (entry) await loadFile(plan.nextId, entry, generation);
      }
    } catch (error: unknown) {
      fail(error, generation);
    } finally {
      if (generation === generationRef.current && sequence === refreshSequenceRef.current) {
        setIsLoading(false);
      }
    }
  }, [fail, loadFile, loadTree]);

  // Poll workspace revisions while the panel is showing; `planWorkspaceRefresh`
  // keeps the reloads cheap (revision-gated) and never clobbers an open draft.
  useEffect(() => {
    if (!open || !connected || asleep) return;
    void refresh(true);
    const timer = window.setInterval(() => { void refresh(false); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [accountId, asleep, connected, open, refresh]);

  const handleSelectWorkspace = useCallback((id: string) => {
    if (id === stateRef.current.selectedWorkspaceId || !canLeaveDraft()) return;
    setState((prev) => clearSelection({ ...prev, selectedWorkspaceId: id, entries: [], errorMessage: null }));
    void loadTree(id, generationRef.current);
  }, [canLeaveDraft, loadTree]);

  const handleCreateWorkspace = useCallback((name: string) => {
    if (!canLeaveDraft()) return;
    const generation = generationRef.current;
    void (async () => {
      try {
        const workspace = await createWorkspace(name);
        if (generation !== generationRef.current) return;
        setState((prev) => clearSelection({
          ...prev,
          workspaces: upsertWorkspace(prev.workspaces, workspace),
          selectedWorkspaceId: workspace.id,
          entries: [],
          errorMessage: null,
        }));
        await loadTree(workspace.id, generation);
      } catch (error: unknown) {
        fail(error, generation);
      }
    })();
  }, [canLeaveDraft, fail, loadTree]);

  const handleRenameWorkspace = useCallback((name: string) => {
    const id = stateRef.current.selectedWorkspaceId;
    if (!id) return;
    const generation = generationRef.current;
    void (async () => {
      try {
        const workspace = await renameWorkspace(id, name);
        if (generation !== generationRef.current) return;
        setState((prev) => ({
          ...prev,
          workspaces: upsertWorkspace(prev.workspaces, workspace),
          errorMessage: null,
        }));
      } catch (error: unknown) {
        fail(error, generation);
      }
    })();
  }, [fail]);

  /** Apply a mutation's fresh tree, unless the user switched workspace meanwhile. */
  const applyTreeForWorkspace = useCallback((
    workspaceId: string,
    tree: WorkspaceTreeView,
    transform: (next: WorkspacePanelState) => WorkspacePanelState = (next) => next,
  ) => {
    setState((prev) => (
      prev.selectedWorkspaceId === workspaceId
        ? transform({ ...applyTree(prev, tree), errorMessage: null })
        : prev
    ));
  }, []);

  const importFilesFromPaths = useCallback((paths: string[]) => {
    const id = stateRef.current.selectedWorkspaceId;
    if (!id || paths.length === 0) return;
    const generation = generationRef.current;
    void (async () => {
      try {
        const tree = await importWorkspaceFiles(id, paths);
        if (generation !== generationRef.current) return;
        applyTreeForWorkspace(id, tree);
      } catch (error: unknown) {
        fail(error, generation);
      }
    })();
  }, [applyTreeForWorkspace, fail]);

  const handleImportFiles = useCallback(() => {
    void (async () => {
      try {
        const paths = await pickNativeFiles({
          prompt: 'Import',
          message: 'Choose files to copy into this workspace.',
        });
        importFilesFromPaths(paths);
      } catch (error: unknown) {
        fail(error, generationRef.current);
      }
    })();
  }, [fail, importFilesFromPaths]);

  const handleCreateFolder = useCallback((path: string) => {
    const id = stateRef.current.selectedWorkspaceId;
    if (!id) return;
    const generation = generationRef.current;
    void (async () => {
      try {
        const tree = await createWorkspaceFolder(id, path);
        if (generation !== generationRef.current) return;
        applyTreeForWorkspace(id, tree);
      } catch (error: unknown) {
        fail(error, generation);
      }
    })();
  }, [applyTreeForWorkspace, fail]);

  const handleCreateMarkdownFile = useCallback((path: string) => {
    if (!canLeaveDraft()) return;
    const id = stateRef.current.selectedWorkspaceId;
    if (!id) return;
    const generation = generationRef.current;
    void (async () => {
      try {
        const { workspace, file } = await createWorkspaceFile(id, ensureMarkdownExtension(path), '');
        if (generation !== generationRef.current) return;
        setState((prev) => ({ ...prev, workspaces: upsertWorkspace(prev.workspaces, workspace) }));
        await loadTree(id, generation);
        if (generation !== generationRef.current) return;
        setState((prev) => (
          prev.selectedWorkspaceId === id
            ? {
                ...prev,
                selectedEntryPath: file.path,
                loadedFile: file,
                draftContent: file.content,
                errorMessage: null,
              }
            : prev
        ));
      } catch (error: unknown) {
        fail(error, generation);
      }
    })();
  }, [canLeaveDraft, fail, loadTree]);

  const handleMoveEntry = useCallback((path: string, destinationPath: string) => {
    if (!canLeaveDraft()) return;
    const id = stateRef.current.selectedWorkspaceId;
    if (!id) return;
    const generation = generationRef.current;
    void (async () => {
      try {
        const tree = await moveWorkspaceEntry(id, path, destinationPath);
        if (generation !== generationRef.current) return;
        const movedSelection = movedSelectionPath(
          stateRef.current.selectedEntryPath,
          path,
          destinationPath,
        );
        const movedEntry = movedSelection !== null
          ? tree.entries.find((entry) => entry.path === movedSelection)
          : undefined;
        applyTreeForWorkspace(id, tree, (next) => (
          movedEntry
            ? { ...next, selectedEntryPath: movedEntry.path, loadedFile: null, draftContent: '' }
            : clearMissingSelection(next)
        ));
        if (movedEntry) await loadFile(id, movedEntry, generation);
      } catch (error: unknown) {
        fail(error, generation);
      }
    })();
  }, [applyTreeForWorkspace, canLeaveDraft, fail, loadFile]);

  const handleDeleteEntry = useCallback((path: string) => {
    const id = stateRef.current.selectedWorkspaceId;
    if (!id) return;
    const generation = generationRef.current;
    void (async () => {
      try {
        const tree = await deleteWorkspaceEntry(id, path);
        if (generation !== generationRef.current) return;
        const removedSelection = selectionInside(stateRef.current.selectedEntryPath, path);
        applyTreeForWorkspace(id, tree, (next) => (
          removedSelection ? clearSelection(next) : next
        ));
      } catch (error: unknown) {
        fail(error, generation);
      }
    })();
  }, [applyTreeForWorkspace, fail]);

  const handleSelectEntry = useCallback((path: string) => {
    const { selectedWorkspaceId, selectedEntryPath, entries } = stateRef.current;
    if (path === selectedEntryPath || !selectedWorkspaceId || !canLeaveDraft()) return;
    const entry = entries.find((candidate) => candidate.path === path);
    if (!entry) return;
    setState((prev) => ({
      ...prev,
      selectedEntryPath: path,
      loadedFile: null,
      draftContent: '',
      errorMessage: null,
    }));
    void loadFile(selectedWorkspaceId, entry, generationRef.current);
  }, [canLeaveDraft, loadFile]);

  const handleSetDraftContent = useCallback((content: string) => {
    setState((prev) => ({ ...prev, draftContent: content }));
  }, []);

  const handleSave = useCallback(() => {
    const { selectedWorkspaceId, loadedFile, draftContent } = stateRef.current;
    if (!selectedWorkspaceId || !loadedFile || isSaving) return;
    const generation = generationRef.current;
    const submittedContent = draftContent;
    setIsSaving(true);
    void (async () => {
      try {
        const { workspace, file } = await writeWorkspaceFile(
          selectedWorkspaceId,
          loadedFile.path,
          submittedContent,
        );
        if (generation !== generationRef.current) return;
        setState((prev) => {
          if (prev.selectedWorkspaceId !== selectedWorkspaceId
            || prev.selectedEntryPath !== loadedFile.path) {
            return prev;
          }
          return {
            ...prev,
            workspaces: upsertWorkspace(prev.workspaces, workspace),
            loadedFile: file,
            // Keep edits typed while the save was in flight.
            draftContent: prev.draftContent === submittedContent ? file.content : prev.draftContent,
            errorMessage: null,
          };
        });
        await loadTree(selectedWorkspaceId, generation);
      } catch (error: unknown) {
        fail(error, generation);
      } finally {
        if (generation === generationRef.current) setIsSaving(false);
      }
    })();
  }, [fail, isSaving, loadTree]);

  const handleDiscard = useCallback(() => {
    setState((prev) => (
      prev.loadedFile
        ? { ...prev, draftContent: prev.loadedFile.content, errorMessage: null }
        : prev
    ));
  }, []);

  return {
    ...state,
    selectedWorkspace: state.workspaces
      .find((workspace) => workspace.id === state.selectedWorkspaceId) ?? null,
    selectedEntry: state.entries
      .find((entry) => entry.path === state.selectedEntryPath) ?? null,
    hasUnsavedChanges: hasUnsavedChanges(state),
    isLoading,
    isSaving,
    canImportFiles: canPickNativeFiles(),
    selectWorkspace: handleSelectWorkspace,
    createWorkspace: handleCreateWorkspace,
    renameSelectedWorkspace: handleRenameWorkspace,
    importFiles: handleImportFiles,
    importDroppedFiles: importFilesFromPaths,
    createFolder: handleCreateFolder,
    createMarkdownFile: handleCreateMarkdownFile,
    moveEntry: handleMoveEntry,
    deleteEntry: handleDeleteEntry,
    selectEntry: handleSelectEntry,
    setDraftContent: handleSetDraftContent,
    saveSelectedFile: handleSave,
    discardChanges: handleDiscard,
  };
}
