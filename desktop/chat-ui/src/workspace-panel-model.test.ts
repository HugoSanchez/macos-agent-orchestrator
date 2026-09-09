import { describe, expect, it } from 'vitest';
import type { WorkspaceEntryView, WorkspaceSummary } from './workspace-api';
import {
  childEntries,
  clearMissingSelection,
  EMPTY_WORKSPACE_PANEL_STATE,
  ensureMarkdownExtension,
  hasUnsavedChanges,
  movedSelectionPath,
  planWorkspaceRefresh,
  selectionInside,
  upsertWorkspace,
} from './workspace-panel-model';

function workspace(id: string, overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id,
    name: id,
    createdAt: '2026-09-03T10:00:00Z',
    updatedAt: '2026-09-03T10:00:00Z',
    revision: 1,
    ...overrides,
  };
}

function entry(path: string, overrides: Partial<WorkspaceEntryView> = {}): WorkspaceEntryView {
  return {
    path,
    name: path.split('/').at(-1) ?? path,
    kind: 'file',
    editable: true,
    ...overrides,
  };
}

describe('workspace tree helpers', () => {
  it('groups entries under their parent folder', () => {
    const entries = [
      entry('Research', { kind: 'folder', editable: false }),
      entry('Research/summary.md'),
      entry('notes.md'),
    ];
    expect(childEntries(entries, '').map((e) => e.path)).toEqual(['Research', 'notes.md']);
    expect(childEntries(entries, 'Research').map((e) => e.path)).toEqual(['Research/summary.md']);
  });

  it('upserts workspaces sorted by creation date', () => {
    const list = upsertWorkspace(
      [workspace('b', { createdAt: '2026-09-02T00:00:00Z' })],
      workspace('a', { createdAt: '2026-09-01T00:00:00Z' }),
    );
    expect(list.map((w) => w.id)).toEqual(['a', 'b']);

    const renamed = upsertWorkspace(list, workspace('b', {
      createdAt: '2026-09-02T00:00:00Z',
      name: 'Renamed',
    }));
    expect(renamed.map((w) => w.name)).toEqual(['a', 'Renamed']);
  });

  it('adds the markdown extension only when missing', () => {
    expect(ensureMarkdownExtension('Research/summary')).toBe('Research/summary.md');
    expect(ensureMarkdownExtension('notes.MD')).toBe('notes.MD');
  });
});

describe('selection mapping', () => {
  it('follows a moved file or folder', () => {
    expect(movedSelectionPath('a/b.md', 'a/b.md', 'c/d.md')).toBe('c/d.md');
    expect(movedSelectionPath('a/b/deep.md', 'a/b', 'x')).toBe('x/deep.md');
    expect(movedSelectionPath('elsewhere.md', 'a/b', 'x')).toBeNull();
    expect(movedSelectionPath(null, 'a/b', 'x')).toBeNull();
  });

  it('detects selections inside a deleted subtree', () => {
    expect(selectionInside('a/b.md', 'a/b.md')).toBe(true);
    expect(selectionInside('a/b/c.md', 'a/b')).toBe(true);
    expect(selectionInside('a/bc.md', 'a/b')).toBe(false);
    expect(selectionInside(null, 'a/b')).toBe(false);
  });

  it('clears a selection whose entry disappeared from the tree', () => {
    const state = {
      ...EMPTY_WORKSPACE_PANEL_STATE,
      entries: [entry('kept.md')],
      selectedEntryPath: 'gone.md',
      loadedFile: { path: 'gone.md', content: 'x', mimeType: 'text/markdown', editable: true },
      draftContent: 'x',
    };
    const next = clearMissingSelection(state);
    expect(next.selectedEntryPath).toBeNull();
    expect(next.loadedFile).toBeNull();
    expect(next.draftContent).toBe('');
    expect(clearMissingSelection({ ...state, selectedEntryPath: 'kept.md' }).selectedEntryPath)
      .toBe('kept.md');
  });
});

describe('planWorkspaceRefresh', () => {
  const baseOpts = {
    selectedWorkspaceId: 'first',
    previousRevision: 1,
    forceTreeReload: false,
    hasLoadedFile: false,
    hasUnsavedChanges: false,
  };

  it('skips the tree reload when the revision is unchanged', () => {
    const plan = planWorkspaceRefresh({ ...baseOpts, fetched: [workspace('first')] });
    expect(plan).toEqual({
      nextId: 'first',
      selectionChanged: false,
      reloadTree: false,
      refreshSelectedFile: false,
    });
  });

  it('reloads the tree when the revision moves', () => {
    const plan = planWorkspaceRefresh({
      ...baseOpts,
      fetched: [workspace('first', { revision: 2 })],
    });
    expect(plan.reloadTree).toBe(true);
    expect(plan.selectionChanged).toBe(false);
  });

  it('refreshes a clean open file but never an unsaved draft', () => {
    const fetched = [workspace('first', { revision: 2 })];
    const clean = planWorkspaceRefresh({ ...baseOpts, fetched, hasLoadedFile: true });
    expect(clean.refreshSelectedFile).toBe(true);

    const dirty = planWorkspaceRefresh({
      ...baseOpts,
      fetched,
      hasLoadedFile: true,
      hasUnsavedChanges: true,
    });
    expect(dirty.refreshSelectedFile).toBe(false);
  });

  it('falls back to the first workspace when the selection disappears', () => {
    const plan = planWorkspaceRefresh({
      ...baseOpts,
      fetched: [workspace('other')],
    });
    expect(plan.nextId).toBe('other');
    expect(plan.selectionChanged).toBe(true);
    expect(plan.reloadTree).toBe(true);
    expect(plan.refreshSelectedFile).toBe(false);
  });

  it('handles an empty workspace list', () => {
    const plan = planWorkspaceRefresh({ ...baseOpts, fetched: [] });
    expect(plan).toEqual({
      nextId: null,
      selectionChanged: true,
      reloadTree: false,
      refreshSelectedFile: false,
    });
  });
});

describe('hasUnsavedChanges', () => {
  it('is true only when a loaded file diverges from the draft', () => {
    expect(hasUnsavedChanges(EMPTY_WORKSPACE_PANEL_STATE)).toBe(false);
    const loaded = {
      ...EMPTY_WORKSPACE_PANEL_STATE,
      loadedFile: { path: 'a.md', content: 'same', mimeType: 'text/markdown', editable: true },
      draftContent: 'same',
    };
    expect(hasUnsavedChanges(loaded)).toBe(false);
    expect(hasUnsavedChanges({ ...loaded, draftContent: 'edited' })).toBe(true);
  });
});
