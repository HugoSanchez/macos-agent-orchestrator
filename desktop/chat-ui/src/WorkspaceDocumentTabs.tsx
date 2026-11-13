import { X } from 'lucide-react';
import { documentHasUnsavedChanges } from './workspace-documents-model';
import type { WorkspaceDocumentsController } from './use-workspace-documents';

/**
 * Second header band: one tab per open workspace document, with the
 * conversation reachable from a trailing "Chat" tab. Renders nothing while
 * no document is open so the header keeps its launch shape.
 */
export function WorkspaceDocumentTabs({ documents }: { documents: WorkspaceDocumentsController }) {
  if (documents.documents.length === 0) return null;
  const activeKey = documents.activeDocument?.key ?? null;
  return (
    <div className="chat-header-band-tabs workspace-document-tabs" role="tablist" aria-label="Open documents">
      {documents.documents.map((document) => {
        const isActive = document.key === activeKey;
        const isDirty = documentHasUnsavedChanges(document);
        return (
          <div
            key={document.key}
            className={`workspace-document-tab${isActive ? ' is-active' : ''}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              className="workspace-document-tab-label"
              title={document.path}
              onClick={() => documents.activate(document.key)}
            >
              <span className="workspace-document-tab-name">{document.name}</span>
              {document.isSaving
                ? <span className="workspace-document-tab-saving">Saving…</span>
                : isDirty && <span className="workspace-dirty-dot" title="Unsaved changes · ⌘S to save" />}
            </button>
            <button
              type="button"
              className="workspace-document-tab-close"
              aria-label={`Close ${document.name}`}
              title={isDirty ? 'Close and drop unsaved changes' : 'Close'}
              onClick={() => documents.close(document.key)}
            >
              <X size={11} strokeWidth={2} />
            </button>
          </div>
        );
      })}
      <div className={`workspace-document-tab is-chat${activeKey === null ? ' is-active' : ''}`}>
        <button
          type="button"
          role="tab"
          aria-selected={activeKey === null}
          className="workspace-document-tab-label"
          onClick={documents.showChat}
        >
          <span className="workspace-document-tab-name">Chat</span>
        </button>
      </div>
    </div>
  );
}
