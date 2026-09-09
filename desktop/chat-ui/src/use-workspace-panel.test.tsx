/** @vitest-environment happy-dom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceSummary, WorkspaceTextFileView, WorkspaceTreeView } from './workspace-api';
import {
  useWorkspacePanel,
  type UseWorkspacePanelOptions,
  type WorkspacePanelController,
} from './use-workspace-panel';

const api = vi.hoisted(() => ({
  createWorkspace: vi.fn(),
  createWorkspaceFile: vi.fn(),
  createWorkspaceFolder: vi.fn(),
  deleteWorkspaceEntry: vi.fn(),
  getWorkspaceFile: vi.fn(),
  getWorkspaces: vi.fn(),
  getWorkspaceTree: vi.fn(),
  importWorkspaceFiles: vi.fn(),
  moveWorkspaceEntry: vi.fn(),
  renameWorkspace: vi.fn(),
  writeWorkspaceFile: vi.fn(),
}));

vi.mock('./workspace-api', () => api);
vi.mock('./native-file-picker', () => ({
  canPickNativeFiles: () => false,
  pickNativeFiles: vi.fn(async () => []),
}));
vi.mock('./useSystemSleep', () => ({ useIsSystemAsleep: () => false }));

const firstWorkspace = workspace('first', 1);
const secondWorkspace = workspace('second', 1);
const note = {
  path: 'notes.md',
  name: 'notes.md',
  kind: 'file' as const,
  size: 8,
  mimeType: 'text/markdown',
  editable: true,
  indexStatus: 'ready' as const,
};

let mountedRoot: Root | null = null;
let panel: WorkspacePanelController | null = null;

function Harness({ options }: { options: UseWorkspacePanelOptions }) {
  panel = useWorkspacePanel(options);
  return null;
}

function currentPanel(): WorkspacePanelController {
  if (!panel) throw new Error('Workspace panel hook has not rendered.');
  return panel;
}

async function renderHook(options: UseWorkspacePanelOptions) {
  const container = document.createElement('div');
  document.body.append(container);
  mountedRoot = createRoot(container);
  await act(async () => {
    mountedRoot?.render(<Harness options={options} />);
    await flushPromises();
  });
  return {
    rerender: async (next: UseWorkspacePanelOptions) => {
      await act(async () => {
        mountedRoot?.render(<Harness options={next} />);
        await flushPromises();
      });
    },
  };
}

describe('useWorkspacePanel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const mock of Object.values(api)) mock.mockReset();
    api.getWorkspaces.mockResolvedValue([]);
    api.getWorkspaceTree.mockResolvedValue({ workspace: firstWorkspace, entries: [] });
    panel = null;
  });

  afterEach(async () => {
    if (mountedRoot) {
      await act(async () => mountedRoot?.unmount());
      mountedRoot = null;
    }
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it('ignores an old account response after the account changes', async () => {
    const oldResponse = deferred<WorkspaceSummary[]>();
    api.getWorkspaces
      .mockImplementationOnce(() => oldResponse.promise)
      .mockResolvedValueOnce([secondWorkspace]);
    api.getWorkspaceTree.mockResolvedValue({ workspace: secondWorkspace, entries: [] });

    const view = await renderHook({ open: true, connected: true, accountId: 'account-a' });
    await view.rerender({ open: true, connected: true, accountId: 'account-b' });
    expect(currentPanel().selectedWorkspaceId).toBe(secondWorkspace.id);

    oldResponse.resolve([firstWorkspace]);
    await act(flushPromises);

    expect(currentPanel().workspaces).toEqual([secondWorkspace]);
    expect(currentPanel().selectedWorkspaceId).toBe(secondWorkspace.id);
  });

  it('refreshes a clean file but preserves an unsaved draft across polling', async () => {
    let currentWorkspace = firstWorkspace;
    const tree = (): WorkspaceTreeView => ({ workspace: currentWorkspace, entries: [note] });
    api.getWorkspaces.mockImplementation(async () => [currentWorkspace]);
    api.getWorkspaceTree.mockImplementation(async () => tree());
    api.getWorkspaceFile
      .mockResolvedValueOnce(textFile('Original'))
      .mockResolvedValueOnce(textFile('Changed outside Verso'));

    await renderHook({ open: true, connected: true, accountId: 'account-a' });
    await act(async () => {
      currentPanel().selectEntry(note.path);
      await flushPromises();
    });
    expect(currentPanel().draftContent).toBe('Original');

    currentWorkspace = workspace(firstWorkspace.id, 2);
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(currentPanel().draftContent).toBe('Changed outside Verso');

    act(() => currentPanel().setDraftContent('Unsaved local edit'));
    currentWorkspace = workspace(firstWorkspace.id, 3);
    await act(async () => vi.advanceTimersByTimeAsync(2_000));

    expect(api.getWorkspaceFile).toHaveBeenCalledTimes(2);
    expect(currentPanel().draftContent).toBe('Unsaved local edit');
    expect(currentPanel().hasUnsavedChanges).toBe(true);
  });

  it('keeps edits typed while a save request is in flight', async () => {
    api.getWorkspaces.mockResolvedValue([firstWorkspace]);
    api.getWorkspaceTree.mockResolvedValue({ workspace: firstWorkspace, entries: [note] });
    api.getWorkspaceFile.mockResolvedValue(textFile('Original'));
    const save = deferred<{ workspace: WorkspaceSummary; file: WorkspaceTextFileView }>();
    api.writeWorkspaceFile.mockImplementation(() => save.promise);

    await renderHook({ open: true, connected: true, accountId: 'account-a' });
    await act(async () => {
      currentPanel().selectEntry(note.path);
      await flushPromises();
    });
    act(() => currentPanel().setDraftContent('Submitted edit'));
    act(() => currentPanel().saveSelectedFile());
    act(() => currentPanel().setDraftContent('Edit typed during save'));

    save.resolve({ workspace: workspace(firstWorkspace.id, 2), file: textFile('Submitted edit') });
    await act(flushPromises);

    expect(currentPanel().loadedFile?.content).toBe('Submitted edit');
    expect(currentPanel().draftContent).toBe('Edit typed during save');
    expect(currentPanel().hasUnsavedChanges).toBe(true);
  });
});

function workspace(id: string, revision: number): WorkspaceSummary {
  return {
    id,
    name: `Workspace ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: `2026-01-01T00:00:0${revision}.000Z`,
    revision,
  };
}

function textFile(content: string): WorkspaceTextFileView {
  return { path: note.path, content, mimeType: 'text/markdown', editable: true };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
