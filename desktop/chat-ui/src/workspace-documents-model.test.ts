import { describe, expect, it } from 'vitest';
import type { WorkspaceEntryView } from './workspace-api';
import {
  activateDocument,
  activeDocument,
  closeDocument,
  documentHasUnsavedChanges,
  documentKey,
  EMPTY_WORKSPACE_DOCUMENTS_STATE,
  isDocumentTabEntry,
  moveDocuments,
  openDocument,
  removeDocuments,
  staleDocumentKeys,
  updateDocument,
} from './workspace-documents-model';

function entry(path: string, overrides: Partial<WorkspaceEntryView> = {}): WorkspaceEntryView {
  return {
    path,
    name: path.split('/').at(-1) ?? path,
    kind: 'file',
    editable: true,
    ...overrides,
  };
}

const WS = 'ws-1';

describe('isDocumentTabEntry', () => {
  it('claims editable markdown files only', () => {
    expect(isDocumentTabEntry(entry('notes.md'))).toBe(true);
    expect(isDocumentTabEntry(entry('Docs/README.MARKDOWN'))).toBe(true);
    expect(isDocumentTabEntry(entry('notes.txt'))).toBe(false);
    expect(isDocumentTabEntry(entry('deck.pdf', { editable: false }))).toBe(false);
    expect(isDocumentTabEntry(entry('Docs', { kind: 'folder', editable: false }))).toBe(false);
  });
});

describe('open / activate / close', () => {
  it('opens a new tab in front and re-activates an existing one', () => {
    let state = openDocument(EMPTY_WORKSPACE_DOCUMENTS_STATE, WS, entry('a.md'));
    state = openDocument(state, WS, entry('b.md'));
    expect(state.documents.map((document) => document.path)).toEqual(['a.md', 'b.md']);
    expect(activeDocument(state)?.path).toBe('b.md');

    state = openDocument(state, WS, entry('a.md'));
    expect(state.documents).toHaveLength(2);
    expect(activeDocument(state)?.path).toBe('a.md');
  });

  it('activating null shows the chat and ignores unknown keys', () => {
    const state = openDocument(EMPTY_WORKSPACE_DOCUMENTS_STATE, WS, entry('a.md'));
    expect(activateDocument(state, null).activeKey).toBeNull();
    expect(activateDocument(state, 'missing')).toBe(state);
  });

  it('closing the front tab hands over to the right neighbour, then the left, then chat', () => {
    let state = openDocument(EMPTY_WORKSPACE_DOCUMENTS_STATE, WS, entry('a.md'));
    state = openDocument(state, WS, entry('b.md'));
    state = openDocument(state, WS, entry('c.md'));
    state = activateDocument(state, documentKey(WS, 'b.md'));

    state = closeDocument(state, documentKey(WS, 'b.md'));
    expect(activeDocument(state)?.path).toBe('c.md');

    state = closeDocument(state, documentKey(WS, 'c.md'));
    expect(activeDocument(state)?.path).toBe('a.md');

    state = closeDocument(state, documentKey(WS, 'a.md'));
    expect(state.documents).toEqual([]);
    expect(state.activeKey).toBeNull();
  });

  it('closing a background tab keeps the front tab', () => {
    let state = openDocument(EMPTY_WORKSPACE_DOCUMENTS_STATE, WS, entry('a.md'));
    state = openDocument(state, WS, entry('b.md'));
    state = closeDocument(state, documentKey(WS, 'a.md'));
    expect(activeDocument(state)?.path).toBe('b.md');
  });
});

describe('drafts', () => {
  it('tracks unsaved changes against the loaded file', () => {
    const key = documentKey(WS, 'a.md');
    let state = openDocument(EMPTY_WORKSPACE_DOCUMENTS_STATE, WS, entry('a.md'));
    expect(documentHasUnsavedChanges(state.documents[0])).toBe(false);

    const file = { path: 'a.md', content: 'Hello', mimeType: 'text/markdown', editable: true };
    state = updateDocument(state, key, { file, draft: file.content });
    expect(documentHasUnsavedChanges(state.documents[0])).toBe(false);

    state = updateDocument(state, key, { draft: 'Hello there' });
    expect(documentHasUnsavedChanges(state.documents[0])).toBe(true);
  });
});

describe('panel moves and deletes', () => {
  it('renames tabs (including nested ones) after a move and keeps the active tab', () => {
    let state = openDocument(EMPTY_WORKSPACE_DOCUMENTS_STATE, WS, entry('Docs/a.md'));
    state = openDocument(state, WS, entry('other.md'));
    state = activateDocument(state, documentKey(WS, 'Docs/a.md'));
    state = updateDocument(state, documentKey(WS, 'Docs/a.md'), {
      file: { path: 'Docs/a.md', content: 'x', mimeType: 'text/markdown', editable: true },
      draft: 'x',
    });

    state = moveDocuments(state, WS, 'Docs', 'Archive/Docs');
    const moved = activeDocument(state);
    expect(moved?.path).toBe('Archive/Docs/a.md');
    expect(moved?.name).toBe('a.md');
    expect(moved?.key).toBe(documentKey(WS, 'Archive/Docs/a.md'));
    expect(moved?.file?.path).toBe('Archive/Docs/a.md');
    expect(state.documents[1].path).toBe('other.md');
  });

  it('leaves other workspaces alone', () => {
    let state = openDocument(EMPTY_WORKSPACE_DOCUMENTS_STATE, 'ws-2', entry('a.md'));
    state = moveDocuments(state, WS, 'a.md', 'b.md');
    expect(state.documents[0].path).toBe('a.md');
    state = removeDocuments(state, WS, 'a.md');
    expect(state.documents).toHaveLength(1);
  });

  it('closes tabs inside a deleted folder', () => {
    let state = openDocument(EMPTY_WORKSPACE_DOCUMENTS_STATE, WS, entry('Docs/a.md'));
    state = openDocument(state, WS, entry('Docs/b.md'));
    state = openDocument(state, WS, entry('keep.md'));
    state = activateDocument(state, documentKey(WS, 'Docs/a.md'));

    state = removeDocuments(state, WS, 'Docs');
    expect(state.documents.map((document) => document.path)).toEqual(['keep.md']);
    expect(activeDocument(state)?.path).toBe('keep.md');
  });
});

describe('staleDocumentKeys', () => {
  const file = { path: 'a.md', content: 'x', mimeType: 'text/markdown', editable: true };

  it('re-reads clean loaded documents when their workspace revision moves', () => {
    let state = openDocument(EMPTY_WORKSPACE_DOCUMENTS_STATE, WS, entry('a.md'));
    state = updateDocument(state, documentKey(WS, 'a.md'), { file, draft: 'x' });
    const seen = new Map([[WS, 1]]);
    expect(staleDocumentKeys(state.documents, seen, [{ id: WS, revision: 1 }])).toEqual([]);
    expect(staleDocumentKeys(state.documents, seen, [{ id: WS, revision: 2 }])).toEqual([documentKey(WS, 'a.md')]);
    expect(staleDocumentKeys(state.documents, new Map(), [{ id: WS, revision: 1 }])).toEqual([documentKey(WS, 'a.md')]);
  });

  it('skips unsaved, saving, unloaded, and unknown-workspace documents', () => {
    let state = openDocument(EMPTY_WORKSPACE_DOCUMENTS_STATE, WS, entry('dirty.md'));
    state = updateDocument(state, documentKey(WS, 'dirty.md'), { file: { ...file, path: 'dirty.md' }, draft: 'edited' });
    state = openDocument(state, WS, entry('saving.md'));
    state = updateDocument(state, documentKey(WS, 'saving.md'), { file: { ...file, path: 'saving.md' }, draft: 'x', isSaving: true });
    state = openDocument(state, WS, entry('loading.md'));
    state = openDocument(state, 'ws-2', entry('other.md'));
    state = updateDocument(state, documentKey('ws-2', 'other.md'), { file: { ...file, path: 'other.md' }, draft: 'x' });
    expect(staleDocumentKeys(state.documents, new Map(), [{ id: WS, revision: 5 }])).toEqual([]);
  });
});
