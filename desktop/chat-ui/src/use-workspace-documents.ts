import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  getWorkspaceFile,
  getWorkspaces,
  writeWorkspaceFile,
  type WorkspaceEntryView,
} from './workspace-api';
import {
  activateDocument,
  activeDocument,
  closeDocument,
  documentHasUnsavedChanges,
  documentKey,
  EMPTY_WORKSPACE_DOCUMENTS_STATE,
  moveDocuments,
  openDocument,
  removeDocuments,
  staleDocumentKeys,
  updateDocument,
  type WorkspaceDocument,
  type WorkspaceDocumentsState,
} from './workspace-documents-model';
import { useIsSystemAsleep } from './useSystemSleep';

const POLL_MS = 2_000;

export interface UseWorkspaceDocumentsOptions {
  accountId: string | null;
  connected: boolean;
}

export interface WorkspaceDocumentsController {
  documents: WorkspaceDocument[];
  activeDocument: WorkspaceDocument | null;
  /** Bring a file to the front as a tab, loading it on first open. */
  open: (workspaceId: string, entry: WorkspaceEntryView) => void;
  activate: (key: string) => void;
  showChat: () => void;
  close: (key: string) => void;
  setDraft: (key: string, content: string) => void;
  save: (key: string) => void;
  discard: (key: string) => void;
  /** Keep tabs in sync with panel moves/deletes. */
  entryMoved: (workspaceId: string, sourcePath: string, destinationPath: string) => void;
  entryDeleted: (workspaceId: string, path: string) => void;
}

/**
 * Document tabs opened from the workspace panel into the chat column. Each
 * tab keeps its own loaded copy and draft, so several files can stay open
 * with pending edits while the user moves between them and the conversation.
 */
export function useWorkspaceDocuments({ accountId, connected }: UseWorkspaceDocumentsOptions): WorkspaceDocumentsController {
  const [state, setState] = useState<WorkspaceDocumentsState>(EMPTY_WORKSPACE_DOCUMENTS_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const asleep = useIsSystemAsleep();
  // Bumped on account switches so a late response can't land in the new account.
  const generationRef = useRef(0);
  // Last workspace revisions seen by the poll; a moved revision re-reads
  // that workspace's clean documents so agent edits show up in place.
  const revisionsRef = useRef<Map<string, number>>(new Map());

  useLayoutEffect(() => {
    generationRef.current += 1;
    stateRef.current = EMPTY_WORKSPACE_DOCUMENTS_STATE;
    revisionsRef.current = new Map();
    setState(EMPTY_WORKSPACE_DOCUMENTS_STATE);
  }, [accountId]);

  const failDocument = useCallback((key: string, error: unknown, generation: number) => {
    if (generation !== generationRef.current) return;
    const message = error instanceof Error ? error.message : String(error);
    setState((prev) => updateDocument(prev, key, { errorMessage: message }));
  }, []);

  /** Re-read one document from disk; applied only if it is still clean. */
  const reloadDocument = useCallback(async (key: string, generation: number) => {
    const document = stateRef.current.documents.find((candidate) => candidate.key === key);
    if (!document) return;
    try {
      const file = await getWorkspaceFile(document.workspaceId, document.path);
      if (generation !== generationRef.current) return;
      setState((prev) => updateDocument(prev, key, (current) => (
        current.file !== null && !current.isSaving && !documentHasUnsavedChanges(current)
          ? { file, draft: file.content, errorMessage: null }
          : {}
      )));
    } catch (error: unknown) {
      failDocument(key, error, generation);
    }
  }, [failDocument]);

  // Poll workspace revisions while any tab is open, independently of the
  // panel (which only polls while it is showing).
  const hasDocuments = state.documents.length > 0;
  useEffect(() => {
    if (!hasDocuments || !connected || asleep) return;
    const generation = generationRef.current;
    const tick = async () => {
      try {
        const fetched = await getWorkspaces();
        if (generation !== generationRef.current) return;
        const keys = staleDocumentKeys(stateRef.current.documents, revisionsRef.current, fetched);
        revisionsRef.current = new Map(fetched.map((workspace) => [workspace.id, workspace.revision]));
        await Promise.all(keys.map((key) => reloadDocument(key, generation)));
      } catch {
        // Transient; the next tick retries.
      }
    };
    void tick();
    const timer = window.setInterval(() => { void tick(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [accountId, asleep, connected, hasDocuments, reloadDocument]);

  const open = useCallback((workspaceId: string, entry: WorkspaceEntryView) => {
    const key = documentKey(workspaceId, entry.path);
    const alreadyOpen = stateRef.current.documents.some((document) => document.key === key);
    setState((prev) => openDocument(prev, workspaceId, entry));
    if (alreadyOpen) return;
    const generation = generationRef.current;
    void (async () => {
      try {
        const file = await getWorkspaceFile(workspaceId, entry.path);
        if (generation !== generationRef.current) return;
        setState((prev) => updateDocument(prev, key, { file, draft: file.content, errorMessage: null }));
      } catch (error: unknown) {
        failDocument(key, error, generation);
      }
    })();
  }, [failDocument]);

  const activate = useCallback((key: string) => {
    setState((prev) => activateDocument(prev, key));
  }, []);

  const showChat = useCallback(() => {
    setState((prev) => activateDocument(prev, null));
  }, []);

  const close = useCallback((key: string) => {
    setState((prev) => closeDocument(prev, key));
  }, []);

  const setDraft = useCallback((key: string, content: string) => {
    setState((prev) => updateDocument(prev, key, { draft: content }));
  }, []);

  const save = useCallback((key: string) => {
    const document = stateRef.current.documents.find((candidate) => candidate.key === key);
    if (!document || !document.file || document.isSaving || !documentHasUnsavedChanges(document)) return;
    const generation = generationRef.current;
    const submittedContent = document.draft;
    setState((prev) => updateDocument(prev, key, { isSaving: true }));
    void (async () => {
      try {
        const { file } = await writeWorkspaceFile(document.workspaceId, document.path, submittedContent);
        if (generation !== generationRef.current) return;
        setState((prev) => updateDocument(prev, key, (current) => ({
          file,
          // Keep edits typed while the save was in flight.
          draft: current.draft === submittedContent ? file.content : current.draft,
          errorMessage: null,
        })));
      } catch (error: unknown) {
        failDocument(key, error, generation);
      } finally {
        if (generation === generationRef.current) {
          setState((prev) => updateDocument(prev, key, { isSaving: false }));
        }
      }
    })();
  }, [failDocument]);

  const discard = useCallback((key: string) => {
    setState((prev) => updateDocument(prev, key, (current) => (
      current.file ? { draft: current.file.content, errorMessage: null } : {}
    )));
  }, []);

  const entryMoved = useCallback((workspaceId: string, sourcePath: string, destinationPath: string) => {
    setState((prev) => moveDocuments(prev, workspaceId, sourcePath, destinationPath));
  }, []);

  const entryDeleted = useCallback((workspaceId: string, path: string) => {
    setState((prev) => removeDocuments(prev, workspaceId, path));
  }, []);

  return {
    documents: state.documents,
    activeDocument: activeDocument(state),
    open,
    activate,
    showChat,
    close,
    setDraft,
    save,
    discard,
    entryMoved,
    entryDeleted,
  };
}
