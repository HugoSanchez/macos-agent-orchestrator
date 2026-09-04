import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  File,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  LayoutGrid,
  Minus,
  MoreHorizontal,
  PanelRight,
  Plus,
} from 'lucide-react';
import type { WorkspaceEntryView, WorkspaceIndexStatus } from './workspace-api';
import { writeWorkspaceFileDrag } from './workspace-file-drag';
import { childEntries } from './workspace-panel-model';
import type { WorkspacePanelController } from './use-workspace-panel';

export interface WorkspacePanelProps {
  panel: WorkspacePanelController;
}

const CONTEXT_MENU_MARGIN = 8;
const CONTEXT_MENU_WIDTH = 160;
const CONTEXT_MENU_HEIGHT = 76;
const WORKSPACE_PANEL_WIDTH_KEY = 'verso.workspaces.panelWidth';
const MIN_WORKSPACE_PANEL_WIDTH = 280;
const MAX_WORKSPACE_PANEL_WIDTH = 620;
const MIN_CHAT_PANEL_WIDTH = 400;

function maximumWorkspacePanelWidth(): number {
  if (typeof window === 'undefined') return MAX_WORKSPACE_PANEL_WIDTH;
  return Math.max(
    MIN_WORKSPACE_PANEL_WIDTH,
    Math.min(MAX_WORKSPACE_PANEL_WIDTH, window.innerWidth - MIN_CHAT_PANEL_WIDTH),
  );
}

function constrainWorkspacePanelWidth(width: number): number {
  return Math.min(maximumWorkspacePanelWidth(), Math.max(MIN_WORKSPACE_PANEL_WIDTH, width));
}

function readStoredWorkspacePanelWidth(): number {
  if (typeof window === 'undefined') return 400;
  try {
    const stored = Number(window.localStorage.getItem(WORKSPACE_PANEL_WIDTH_KEY));
    if (Number.isFinite(stored)) return constrainWorkspacePanelWidth(stored);
  } catch {
    // Private mode: use the responsive default for this session.
  }
  return constrainWorkspacePanelWidth(Math.round(window.innerWidth * 0.32));
}

/** Right-column workspace browser: header + file tree on top, preview below. */
export function WorkspacePanel({ panel }: WorkspacePanelProps) {
  const [dialog, setDialog] = useState<PanelDialog | null>(null);
  const [contextMenu, setContextMenu] = useState<EntryContextMenu | null>(null);
  const [isFileDragging, setIsFileDragging] = useState(false);
  const [width, setWidth] = useState(readStoredWorkspacePanelWidth);
  const [resizeStart, setResizeStart] = useState<{ pointerId: number; x: number; width: number } | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  // Folders default to expanded (matching the native panel); this records the
  // exceptions. Paths that disappear after a move/delete are harmless here.
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(() => new Set());

  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const contextMenuRef = useOutsideDismiss<HTMLDivElement>(contextMenu !== null, closeContextMenu);
  const fileDragDepthRef = useRef(0);

  useEffect(() => {
    const constrain = () => setWidth((current) => constrainWorkspacePanelWidth(current));
    window.addEventListener('resize', constrain);
    return () => window.removeEventListener('resize', constrain);
  }, []);

  useEffect(() => {
    if (!resizeStart) return;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerId !== resizeStart.pointerId) return;
      // This is the right-hand sidebar: moving its left edge left makes it wider.
      setWidth(constrainWorkspacePanelWidth(resizeStart.width + resizeStart.x - event.clientX));
    };
    const stopResize = (event: PointerEvent) => {
      if (event.pointerId !== resizeStart.pointerId) return;
      setResizeStart(null);
    };
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', stopResize);
    document.addEventListener('pointercancel', stopResize);
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', stopResize);
      document.removeEventListener('pointercancel', stopResize);
    };
  }, [resizeStart]);

  const persistWidth = useCallback((nextWidth: number) => {
    try {
      window.localStorage.setItem(WORKSPACE_PANEL_WIDTH_KEY, String(nextWidth));
    } catch {
      // Private mode: keep the user's choice until this panel unmounts.
    }
  }, []);

  const beginResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    setResizeStart({ pointerId: event.pointerId, x: event.clientX, width });
  }, [width]);

  const resizeWithKeyboard = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 40 : 12;
    const delta = event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0;
    if (!delta) return;
    event.preventDefault();
    setWidth((current) => {
      const next = constrainWorkspacePanelWidth(current + delta);
      persistWidth(next);
      return next;
    });
  }, [persistWidth]);

  // Persist after drag completion, without repeatedly touching localStorage
  // while the pointer moves.
  useEffect(() => {
    if (resizeStart === null) persistWidth(width);
  }, [persistWidth, resizeStart, width]);

  // Tell the native host exactly where a Finder drop means "import into this
  // workspace." Drops elsewhere keep their existing chat-attachment behavior.
  useEffect(() => {
    const bridge = window.webkit?.messageHandlers?.chatBridge;
    if (!bridge) return;
    const publishRegion = () => {
      const bounds = panel.selectedWorkspace ? panelRef.current?.getBoundingClientRect() : null;
      bridge.postMessage({
        type: 'workspaceDropRegion',
        region: bounds ? { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height } : null,
      });
    };
    publishRegion();
    const observer = new ResizeObserver(publishRegion);
    if (panelRef.current) observer.observe(panelRef.current);
    window.addEventListener('resize', publishRegion);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', publishRegion);
      bridge.postMessage({ type: 'workspaceDropRegion', region: null });
    };
  }, [panel.selectedWorkspace?.id]);

  // Finder drops are delivered by the native WKWebView bridge with paths, so
  // the sidecar can copy the original files without loading them into JS.
  useEffect(() => {
    const onNativeFileDragState = (event: Event) => {
      const detail = (event as CustomEvent<{ active?: unknown }>).detail;
      if (typeof detail?.active === 'boolean') setIsFileDragging(detail.active);
    };
    const onNativeFilesDropped = (event: Event) => {
      const detail = (event as CustomEvent<{ paths?: unknown; x?: unknown; y?: unknown }>).detail;
      const paths = Array.isArray(detail?.paths)
        ? detail.paths.filter((path): path is string => typeof path === 'string')
        : [];
      if (paths.length === 0 || typeof detail?.x !== 'number' || typeof detail?.y !== 'number') return;
      const bounds = panelRef.current?.getBoundingClientRect();
      if (!bounds
        || detail.x < bounds.left || detail.x > bounds.right
        || detail.y < bounds.top || detail.y > bounds.bottom) return;
      panel.importDroppedFiles(paths);
    };
    window.addEventListener('verso:native-file-drag-state', onNativeFileDragState);
    window.addEventListener('verso:native-files-dropped', onNativeFilesDropped);
    return () => {
      window.removeEventListener('verso:native-file-drag-state', onNativeFileDragState);
      window.removeEventListener('verso:native-files-dropped', onNativeFilesDropped);
    };
  }, [panel]);

  const isFileDrag = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes('Files');
  const handleFileDragEnter = (event: React.DragEvent) => {
    if (!panel.selectedWorkspace || !isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    fileDragDepthRef.current += 1;
    setIsFileDragging(true);
  };
  const handleFileDragOver = (event: React.DragEvent) => {
    if (!panel.selectedWorkspace || !isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const handleFileDragLeave = (event: React.DragEvent) => {
    if (!isFileDrag(event)) return;
    event.stopPropagation();
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (fileDragDepthRef.current === 0) setIsFileDragging(false);
  };
  const handleFileDrop = (event: React.DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    fileDragDepthRef.current = 0;
    setIsFileDragging(false);
  };

  const toggleFolder = useCallback((path: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const openEntryContextMenu = useCallback((entry: WorkspaceEntryView, x: number, y: number) => {
    setContextMenu({
      entry,
      x: Math.max(CONTEXT_MENU_MARGIN,
        Math.min(x, window.innerWidth - CONTEXT_MENU_WIDTH - CONTEXT_MENU_MARGIN)),
      y: Math.max(CONTEXT_MENU_MARGIN,
        Math.min(y, window.innerHeight - CONTEXT_MENU_HEIGHT - CONTEXT_MENU_MARGIN)),
    });
  }, []);

  return (
    <aside
      ref={panelRef}
      className={`workspace-panel${resizeStart ? ' is-resizing' : ''}${isFileDragging ? ' is-file-dragging' : ''}`}
      aria-label="Workspaces"
      style={{ width }}
      onDragEnter={handleFileDragEnter}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
    >
      <div
        className="workspace-panel-resize-handle"
        role="separator"
        aria-label="Resize workspaces"
        aria-orientation="vertical"
        aria-valuemin={MIN_WORKSPACE_PANEL_WIDTH}
        aria-valuemax={maximumWorkspacePanelWidth()}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        onPointerDown={beginResize}
        onKeyDown={resizeWithKeyboard}
      />
      {isFileDragging && (
        <div className="workspace-file-drop-overlay" aria-hidden="true">
          Drop files to import
        </div>
      )}
      <div className="workspace-panel-top">
        <PanelHeader panel={panel} onOpenDialog={setDialog} />

        {panel.errorMessage && <div className="workspace-panel-error">{panel.errorMessage}</div>}

        <PanelContents
          panel={panel}
          collapsedFolders={collapsedFolders}
          onToggleFolder={toggleFolder}
          onEntryContextMenu={openEntryContextMenu}
          onCreateWorkspace={() => setDialog({ kind: 'create-workspace' })}
        />
      </div>

      <PanelPreview panel={panel} />

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="workspace-context-menu"
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            type="button"
            role="menuitem"
            className="workspace-menu-row"
            onClick={() => {
              setDialog({ kind: 'move-entry', entry: contextMenu.entry });
              closeContextMenu();
            }}
          >
            Move or Rename…
          </button>
          <div className="workspace-menu-divider" />
          <button
            type="button"
            role="menuitem"
            className="workspace-menu-row workspace-menu-row-danger"
            onClick={() => {
              setDialog({ kind: 'delete-entry', entry: contextMenu.entry });
              closeContextMenu();
            }}
          >
            Delete
          </button>
        </div>
      )}

      {dialog && (
        <PanelDialogView
          dialog={dialog}
          panel={panel}
          onClose={() => setDialog(null)}
        />
      )}
    </aside>
  );
}

export function WorkspacePanelToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="workspace-panel-toggle"
      data-no-window-drag
      aria-label={open ? 'Hide workspaces' : 'Show workspaces'}
      aria-expanded={open}
      title="Workspaces"
      onClick={onToggle}
    >
      <PanelRight size={14} strokeWidth={1.5} />
    </button>
  );
}

interface EntryContextMenu {
  entry: WorkspaceEntryView;
  x: number;
  y: number;
}

type PanelDialog =
  | { kind: 'create-workspace' }
  | { kind: 'rename-workspace' }
  | { kind: 'create-file' }
  | { kind: 'create-folder' }
  | { kind: 'move-entry'; entry: WorkspaceEntryView }
  | { kind: 'delete-entry'; entry: WorkspaceEntryView };

function PanelHeader({
  panel,
  onOpenDialog,
}: {
  panel: WorkspacePanelController;
  onOpenDialog: (dialog: PanelDialog) => void;
}) {
  const [openMenu, setOpenMenu] = useState<'workspaces' | 'actions' | null>(null);
  const closeMenu = useCallback(() => setOpenMenu(null), []);
  const menuRef = useOutsideDismiss<HTMLDivElement>(openMenu !== null, closeMenu);

  return (
    <div className="workspace-panel-header" ref={menuRef}>
      <div className="workspace-panel-header-row">
        <div className="workspace-menu">
          <button
            type="button"
            className="workspace-menu-trigger"
            aria-expanded={openMenu === 'workspaces'}
            onClick={() => setOpenMenu(openMenu === 'workspaces' ? null : 'workspaces')}
          >
            <span className="workspace-menu-trigger-name">
              {panel.selectedWorkspace?.name ?? 'Workspaces'}
            </span>
            <ChevronDown size={11} strokeWidth={1.75} />
          </button>
          {openMenu === 'workspaces' && (
            <div className="workspace-menu-popover" role="menu">
              {panel.workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={workspace.id === panel.selectedWorkspaceId}
                  className={`workspace-menu-row${workspace.id === panel.selectedWorkspaceId ? ' is-selected' : ''}`}
                  onClick={() => {
                    panel.selectWorkspace(workspace.id);
                    closeMenu();
                  }}
                >
                  {workspace.name}
                </button>
              ))}
              {panel.workspaces.length > 0 && <div className="workspace-menu-divider" />}
              <button
                type="button"
                role="menuitem"
                className="workspace-menu-row"
                onClick={() => {
                  onOpenDialog({ kind: 'create-workspace' });
                  closeMenu();
                }}
              >
                New Workspace…
              </button>
            </div>
          )}
        </div>

        {panel.selectedWorkspace && (
          <div className="workspace-menu workspace-menu-actions">
            <button
              type="button"
              className="workspace-icon-button"
              aria-expanded={openMenu === 'actions'}
              aria-label="Workspace actions"
              title="Workspace actions"
              onClick={() => setOpenMenu(openMenu === 'actions' ? null : 'actions')}
            >
              <MoreHorizontal size={13} />
            </button>
            {openMenu === 'actions' && (
              <div className="workspace-menu-popover workspace-menu-popover-right" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="workspace-menu-row"
                  onClick={() => {
                    onOpenDialog({ kind: 'rename-workspace' });
                    closeMenu();
                  }}
                >
                  Rename Workspace…
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {panel.selectedWorkspace && (
        <div className="workspace-panel-actions">
          {panel.canImportFiles && (
            <button
              type="button"
              className="workspace-icon-button"
              aria-label="Import files"
              title="Import files"
              onClick={panel.importFiles}
            >
              <Plus size={13} />
            </button>
          )}
          <button
            type="button"
            className="workspace-icon-button"
            aria-label="New Markdown file"
            title="New Markdown file"
            onClick={() => onOpenDialog({ kind: 'create-file' })}
          >
            <FilePlus2 size={13} />
          </button>
          <button
            type="button"
            className="workspace-icon-button"
            aria-label="New folder"
            title="New folder"
            onClick={() => onOpenDialog({ kind: 'create-folder' })}
          >
            <FolderPlus size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

function PanelContents({
  panel,
  collapsedFolders,
  onToggleFolder,
  onEntryContextMenu,
  onCreateWorkspace,
}: {
  panel: WorkspacePanelController;
  collapsedFolders: ReadonlySet<string>;
  onToggleFolder: (path: string) => void;
  onEntryContextMenu: (entry: WorkspaceEntryView, x: number, y: number) => void;
  onCreateWorkspace: () => void;
}) {
  if (panel.isLoading && panel.workspaces.length === 0) {
    return (
      <div className="workspace-panel-placeholder">
        <div className="workspace-spinner" aria-hidden="true" />
        <div className="workspace-placeholder-text">Loading workspaces…</div>
      </div>
    );
  }
  if (panel.workspaces.length === 0) {
    return (
      <div className="workspace-panel-placeholder">
        <LayoutGrid size={22} strokeWidth={1.25} className="workspace-preview-glyph" />
        <div className="workspace-placeholder-text">
          A shared place for your notes,
          <br />
          documents, and agent-created files.
        </div>
        <button type="button" className="settings-button" onClick={onCreateWorkspace}>
          Create Workspace
        </button>
      </div>
    );
  }
  if (panel.entries.length === 0) {
    return (
      <div className="workspace-panel-placeholder">
        <div className="workspace-placeholder-title">This workspace is empty</div>
        <div className="workspace-placeholder-text">Import a document or create a note.</div>
      </div>
    );
  }
  return (
    <div className="workspace-tree" role="tree">
      <EntryRows
        panel={panel}
        parent=""
        depth={0}
        collapsedFolders={collapsedFolders}
        onToggleFolder={onToggleFolder}
        onEntryContextMenu={onEntryContextMenu}
      />
    </div>
  );
}

function EntryRows({
  panel,
  parent,
  depth,
  collapsedFolders,
  onToggleFolder,
  onEntryContextMenu,
}: {
  panel: WorkspacePanelController;
  parent: string;
  depth: number;
  collapsedFolders: ReadonlySet<string>;
  onToggleFolder: (path: string) => void;
  onEntryContextMenu: (entry: WorkspaceEntryView, x: number, y: number) => void;
}) {
  return (
    <>
      {childEntries(panel.entries, parent).map((entry) => {
        const isFolder = entry.kind === 'folder';
        const isExpanded = isFolder && !collapsedFolders.has(entry.path);
        return (
          <div key={entry.path}>
            <button
              type="button"
              role="treeitem"
              aria-selected={entry.path === panel.selectedEntryPath}
              aria-expanded={isFolder ? isExpanded : undefined}
              className={`workspace-entry-row${entry.path === panel.selectedEntryPath ? ' is-selected' : ''}`}
              style={{ paddingLeft: 7 + depth * 13 }}
              draggable={!isFolder}
              onClick={() => panel.selectEntry(entry.path)}
              onDragStart={(event) => {
                if (isFolder || !panel.selectedWorkspace) return;
                writeWorkspaceFileDrag(event.dataTransfer, {
                  workspaceId: panel.selectedWorkspace.id,
                  path: entry.path,
                });
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                onEntryContextMenu(entry, event.clientX, event.clientY);
              }}
            >
              {isFolder && (
                <span
                  className={`workspace-entry-chevron${isExpanded ? ' is-expanded' : ''}`}
                  // The chevron is a hit target inside the row button; toggling
                  // expansion must not also change the selection.
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleFolder(entry.path);
                  }}
                >
                  <ChevronRight size={10} strokeWidth={1.75} />
                </span>
              )}
              <span className={`workspace-entry-icon${isFolder ? ' is-folder' : ''}`}>
                {isFolder
                  ? isExpanded ? <FolderOpen size={13} /> : <Folder size={13} />
                  : <EntryFileIcon entry={entry} />}
              </span>
              <span className="workspace-entry-name">{entry.name}</span>
              {!isFolder && <EntryIndexStatus status={entry.indexStatus} />}
            </button>
            {isExpanded && (
              <EntryRows
                panel={panel}
                parent={entry.path}
                depth={depth + 1}
                collapsedFolders={collapsedFolders}
                onToggleFolder={onToggleFolder}
                onEntryContextMenu={onEntryContextMenu}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function PanelPreview({ panel }: { panel: WorkspacePanelController }) {
  const entry = panel.selectedEntry;
  if (!entry) {
    return (
      <div className="workspace-panel-preview">
        <div className="workspace-panel-placeholder">
          <div className="workspace-placeholder-label">Preview</div>
          <div className="workspace-placeholder-text">Select an editable file to view or change it.</div>
        </div>
      </div>
    );
  }
  return (
    <div className="workspace-panel-preview">
      <div className="workspace-preview-header">
        <span className="workspace-preview-name">{entry.name}</span>
        {panel.hasUnsavedChanges && (
          <span className="workspace-dirty-dot" title="Unsaved changes" />
        )}
        <span className="workspace-preview-spacer" />
        {panel.loadedFile && (
          <>
            {panel.hasUnsavedChanges && (
              <button
                type="button"
                className="workspace-text-button"
                onClick={panel.discardChanges}
              >
                Discard
              </button>
            )}
            <button
              type="button"
              className={`workspace-text-button${panel.hasUnsavedChanges ? ' is-save-ready' : ''}`}
              disabled={!panel.hasUnsavedChanges || panel.isSaving}
              onClick={panel.saveSelectedFile}
            >
              {panel.isSaving ? 'Saving…' : 'Save'}
            </button>
          </>
        )}
      </div>

      {panel.loadedFile ? (
        <textarea
          className="workspace-editor"
          value={panel.draftContent}
          onChange={(event) => panel.setDraftContent(event.target.value)}
          spellCheck={false}
        />
      ) : (
        <div className="workspace-panel-placeholder">
          <span className="workspace-preview-glyph">
            {entry.kind === 'folder' ? <Folder /> : <EntryFileIcon entry={entry} />}
          </span>
          <div className="workspace-placeholder-text">
            {entry.kind === 'folder' ? 'Folder' : previewDescription(entry)}
          </div>
          {entry.size !== undefined && (
            <div className="workspace-placeholder-caption">{formatByteSize(entry.size)}</div>
          )}
        </div>
      )}
    </div>
  );
}

const DIALOG_COPY = {
  'create-workspace': {
    title: 'New Workspace',
    placeholder: 'Workspace name',
    actionTitle: 'Create',
  },
  'rename-workspace': {
    title: 'Rename Workspace',
    placeholder: 'Workspace name',
    actionTitle: 'Rename',
  },
  'create-file': {
    title: 'New Markdown File',
    message: 'You can include folders in the path. Verso adds .md if needed.',
    placeholder: 'notes or folder/notes.md',
    actionTitle: 'Create',
  },
  'create-folder': {
    title: 'New Folder',
    message: 'Use / to create nested folders.',
    placeholder: 'Folder name or path',
    actionTitle: 'Create',
  },
  'move-entry': {
    title: 'Move or Rename',
    message: 'Change the name, folder path, or both.',
    placeholder: 'Destination path',
    actionTitle: 'Move',
  },
} as const;

function PanelDialogView({
  dialog,
  panel,
  onClose,
}: {
  dialog: PanelDialog;
  panel: WorkspacePanelController;
  onClose: () => void;
}) {
  const [value, setValue] = useState(() => {
    if (dialog.kind === 'rename-workspace') return panel.selectedWorkspace?.name ?? '';
    if (dialog.kind === 'move-entry') return dialog.entry.path;
    return '';
  });
  const trimmed = value.trim();

  const submit = () => {
    switch (dialog.kind) {
      case 'create-workspace':
        panel.createWorkspace(trimmed);
        break;
      case 'rename-workspace':
        panel.renameSelectedWorkspace(trimmed);
        break;
      case 'create-file':
        panel.createMarkdownFile(trimmed);
        break;
      case 'create-folder':
        panel.createFolder(trimmed);
        break;
      case 'move-entry':
        panel.moveEntry(dialog.entry.path, trimmed);
        break;
      case 'delete-entry':
        panel.deleteEntry(dialog.entry.path);
        break;
    }
    onClose();
  };

  if (dialog.kind === 'delete-entry') {
    return (
      <DialogShell title={`Delete ${dialog.entry.name}?`} onClose={onClose}>
        <div className="workspace-dialog-message">
          {dialog.entry.kind === 'folder'
            ? 'This permanently deletes the folder and everything inside it.'
            : 'This permanently deletes the file.'}
        </div>
        <div className="workspace-dialog-buttons">
          <button type="button" className="settings-button" onClick={onClose}>Cancel</button>
          <button type="button" className="settings-button settings-button-danger" onClick={submit}>
            Delete
          </button>
        </div>
      </DialogShell>
    );
  }

  const copy = DIALOG_COPY[dialog.kind];
  return (
    <DialogShell title={copy.title} onClose={onClose}>
      {'message' in copy && <div className="workspace-dialog-message">{copy.message}</div>}
      <input
        type="text"
        className="workspace-dialog-input"
        placeholder={copy.placeholder}
        value={value}
        autoFocus
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && trimmed.length > 0) submit();
        }}
      />
      <div className="workspace-dialog-buttons">
        <button type="button" className="settings-button" onClick={onClose}>Cancel</button>
        <button
          type="button"
          className="settings-button settings-button-primary"
          disabled={trimmed.length === 0}
          onClick={submit}
        >
          {copy.actionTitle}
        </button>
      </div>
    </DialogShell>
  );
}

function DialogShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="workspace-dialog-backdrop" onMouseDown={onClose}>
      <div
        className="workspace-dialog"
        role="dialog"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="workspace-dialog-title">{title}</div>
        {children}
      </div>
    </div>
  );
}

function EntryIndexStatus({ status }: { status: WorkspaceIndexStatus | undefined }) {
  switch (status) {
    case 'indexing':
      return <span className="workspace-entry-status workspace-spinner" title="Indexing" />;
    case 'ready':
      return (
        <span className="workspace-entry-status is-ready" title="Ready for workspace search">
          <Check size={10} strokeWidth={2} />
        </span>
      );
    case 'error':
      return (
        <span className="workspace-entry-status is-error" title="Indexing failed">
          <CircleAlert size={10} strokeWidth={1.5} />
        </span>
      );
    case 'unsupported':
      return (
        <span className="workspace-entry-status" title="Not indexed">
          <Minus size={9} strokeWidth={2} />
        </span>
      );
    default:
      return null;
  }
}

function previewDescription(entry: WorkspaceEntryView): string {
  switch (entry.indexStatus) {
    case 'indexing': return 'Indexing…';
    case 'error': return 'Verso could not index this file.';
    case 'unsupported': return 'Preview is not available for this file type.';
    default: return 'Preview is available for text files.';
  }
}

/** Decimal units to match the native ByteCountFormatter file style. */
function formatByteSize(size: number): string {
  if (size < 1000) return `${size} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = size;
  for (const unit of units) {
    value /= 1000;
    if (value < 1000 || unit === units[units.length - 1]) {
      return `${value >= 100 ? Math.round(value) : Number(value.toFixed(1))} ${unit}`;
    }
  }
  return `${size} bytes`;
}

/** Close on outside pointer-down or Escape while `active`. */
function useOutsideDismiss<T extends HTMLElement>(active: boolean, onDismiss: () => void) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (!active) return;
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onDismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [active, onDismiss]);
  return ref;
}

function EntryFileIcon({ entry }: { entry: WorkspaceEntryView }) {
  const Icon = entry.mimeType === 'text/markdown'
    || entry.mimeType === 'application/pdf'
    || entry.editable
    ? FileText
    : File;
  return <Icon size={13} />;
}
