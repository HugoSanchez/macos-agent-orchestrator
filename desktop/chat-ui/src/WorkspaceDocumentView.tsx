import { useEffect } from 'react';
import { WorkspaceMarkdownEditor } from './WorkspaceMarkdownEditor';
import type { WorkspaceDocument } from './workspace-documents-model';
import type { WorkspaceDocumentsController } from './use-workspace-documents';

/**
 * The body of an active document tab: the markdown edited in place. The tab
 * itself carries the name and the unsaved-changes dot. Saving is
 * keyboard-only (Cmd+S) and works wherever focus is while the tab is in front.
 */
export function WorkspaceDocumentView({
  document,
  documents,
}: {
  document: WorkspaceDocument;
  documents: WorkspaceDocumentsController;
}) {
  const isLoaded = document.file !== null;
  const { key } = document;
  const { save } = documents;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      save(key);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [key, save]);

  return (
    <div className="workspace-document">
      {document.errorMessage && (
        <div className="workspace-document-error" role="alert">{document.errorMessage}</div>
      )}

      {!isLoaded ? (
        <div className="workspace-document-placeholder">
          {document.errorMessage ? 'Could not open this file.' : 'Loading…'}
        </div>
      ) : (
        <div className="workspace-document-scroll">
          <div className="workspace-document-prose message-content assistant-message-content">
            <WorkspaceMarkdownEditor
              value={document.draft}
              onChange={(markdown) => documents.setDraft(key, markdown)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
