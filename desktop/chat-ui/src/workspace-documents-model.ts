// Pure state for workspace document tabs: files the user opened from the
// workspace panel into the chat column, each with its own loaded copy and
// draft. `useWorkspaceDocuments` owns the async side (fetch, save).
//
// This is an experiment. Flip `WORKSPACE_DOCUMENT_TABS_ENABLED` to false to
// fall back to the panel-only preview without touching the rest of the app.

import type { WorkspaceEntryView, WorkspaceSummary, WorkspaceTextFileView } from './workspace-api';

export const WORKSPACE_DOCUMENT_TABS_ENABLED = true;

const MARKDOWN_EXTENSION = /\.(md|markdown)$/i;

/** Entries that open in a document tab instead of the panel preview. */
export function isDocumentTabEntry(entry: WorkspaceEntryView): boolean {
  return WORKSPACE_DOCUMENT_TABS_ENABLED
    && entry.kind === 'file'
    && entry.editable
    && MARKDOWN_EXTENSION.test(entry.path);
}

export interface WorkspaceDocument {
  key: string;
  workspaceId: string;
  path: string;
  name: string;
  /** Last content read from (or written to) disk; null until the first load. */
  file: WorkspaceTextFileView | null;
  draft: string;
  isSaving: boolean;
  errorMessage: string | null;
}

export interface WorkspaceDocumentsState {
  documents: WorkspaceDocument[];
  /** Key of the tab in front; null shows the conversation. */
  activeKey: string | null;
}

export const EMPTY_WORKSPACE_DOCUMENTS_STATE: WorkspaceDocumentsState = {
  documents: [],
  activeKey: null,
};

export function documentKey(workspaceId: string, path: string): string {
  return `${workspaceId}:${path}`;
}

export function documentHasUnsavedChanges(document: WorkspaceDocument): boolean {
  return document.file !== null && document.draft !== document.file.content;
}

export function activeDocument(state: WorkspaceDocumentsState): WorkspaceDocument | null {
  return state.documents.find((document) => document.key === state.activeKey) ?? null;
}

/** Bring an existing tab to the front, or add a new (not yet loaded) one. */
export function openDocument(
  state: WorkspaceDocumentsState,
  workspaceId: string,
  entry: Pick<WorkspaceEntryView, 'path' | 'name'>,
): WorkspaceDocumentsState {
  const key = documentKey(workspaceId, entry.path);
  if (state.documents.some((document) => document.key === key)) {
    return { ...state, activeKey: key };
  }
  const document: WorkspaceDocument = {
    key,
    workspaceId,
    path: entry.path,
    name: entry.name,
    file: null,
    draft: '',
    isSaving: false,
    errorMessage: null,
  };
  return { documents: [...state.documents, document], activeKey: key };
}

export function activateDocument(
  state: WorkspaceDocumentsState,
  key: string | null,
): WorkspaceDocumentsState {
  if (key !== null && !state.documents.some((document) => document.key === key)) return state;
  return state.activeKey === key ? state : { ...state, activeKey: key };
}

/**
 * Remove a tab. When it was in front, the neighbour to its right takes over
 * (else the one to its left, else the conversation).
 */
export function closeDocument(state: WorkspaceDocumentsState, key: string): WorkspaceDocumentsState {
  const index = state.documents.findIndex((document) => document.key === key);
  if (index === -1) return state;
  const documents = state.documents.filter((document) => document.key !== key);
  if (state.activeKey !== key) return { ...state, documents };
  const next = documents[index] ?? documents[index - 1] ?? null;
  return { documents, activeKey: next?.key ?? null };
}

export function updateDocument(
  state: WorkspaceDocumentsState,
  key: string,
  patch: Partial<WorkspaceDocument> | ((document: WorkspaceDocument) => Partial<WorkspaceDocument>),
): WorkspaceDocumentsState {
  if (!state.documents.some((document) => document.key === key)) return state;
  return {
    ...state,
    documents: state.documents.map((document) => (
      document.key === key
        ? { ...document, ...(typeof patch === 'function' ? patch(document) : patch) }
        : document
    )),
  };
}

function movedPath(path: string, sourcePath: string, destinationPath: string): string | null {
  if (path === sourcePath) return destinationPath;
  if (path.startsWith(`${sourcePath}/`)) return destinationPath + path.slice(sourcePath.length);
  return null;
}

/** Follow a rename/move so open tabs keep pointing at the file on disk. */
export function moveDocuments(
  state: WorkspaceDocumentsState,
  workspaceId: string,
  sourcePath: string,
  destinationPath: string,
): WorkspaceDocumentsState {
  let activeKey = state.activeKey;
  const documents = state.documents.map((document) => {
    if (document.workspaceId !== workspaceId) return document;
    const path = movedPath(document.path, sourcePath, destinationPath);
    if (path === null) return document;
    const key = documentKey(workspaceId, path);
    if (document.key === state.activeKey) activeKey = key;
    return {
      ...document,
      key,
      path,
      name: path.split('/').at(-1) ?? path,
      file: document.file ? { ...document.file, path } : null,
    };
  });
  return { documents, activeKey };
}

/** Close every tab for `path` (or nested inside it) after a delete. */
export function removeDocuments(
  state: WorkspaceDocumentsState,
  workspaceId: string,
  path: string,
): WorkspaceDocumentsState {
  return state.documents
    .filter((document) => (
      document.workspaceId === workspaceId
      && (document.path === path || document.path.startsWith(`${path}/`))
    ))
    .reduce((next, document) => closeDocument(next, document.key), state);
}

/**
 * Keys of open documents that should be re-read from disk after a poll:
 * loaded, clean, not mid-save, and in a workspace whose revision moved
 * (or was not seen before). Unsaved drafts are never clobbered.
 */
export function staleDocumentKeys(
  documents: WorkspaceDocument[],
  previousRevisions: ReadonlyMap<string, number>,
  fetched: Pick<WorkspaceSummary, 'id' | 'revision'>[],
): string[] {
  const revisions = new Map(fetched.map((workspace) => [workspace.id, workspace.revision]));
  return documents
    .filter((document) => (
      document.file !== null
      && !document.isSaving
      && !documentHasUnsavedChanges(document)
      && revisions.has(document.workspaceId)
      && previousRevisions.get(document.workspaceId) !== revisions.get(document.workspaceId)
    ))
    .map((document) => document.key);
}
