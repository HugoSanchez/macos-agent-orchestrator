import { useEffect, useRef } from 'react';
import { defaultValueCtx, Editor, remarkStringifyOptionsCtx, rootCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { history } from '@milkdown/kit/plugin/history';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { replaceAll } from '@milkdown/kit/utils';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';

export interface WorkspaceMarkdownEditorProps {
  /** Markdown source; the editor re-syncs when this changes from outside. */
  value: string;
  onChange: (markdown: string) => void;
}

/**
 * In-place markdown editing with the read-mode look: a ProseMirror document
 * (Milkdown, GFM preset) that serialises back to markdown on every change.
 * The prose styling comes from the surrounding `.workspace-document-prose`
 * wrapper so the editor matches rendered assistant replies.
 */
export function WorkspaceMarkdownEditor(props: WorkspaceMarkdownEditorProps) {
  return (
    <MilkdownProvider>
      <MarkdownEditorSurface {...props} />
    </MilkdownProvider>
  );
}

function MarkdownEditorSurface({ value, onChange }: WorkspaceMarkdownEditorProps) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // The markdown the editor last produced (or was last given), so a parent
  // echoing our own change back doesn't trigger a document rebuild.
  const syncedRef = useRef(value);
  // Set while an external reset is being applied: the editor re-serialises
  // the replaced document, and that echo must not be reported as an edit.
  const suppressNextRef = useRef(false);

  const { get } = useEditor((root) => Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, syncedRef.current);
      ctx.update(remarkStringifyOptionsCtx, (prev) => ({
        ...prev,
        bullet: '-' as const,
        listItemIndent: 'one' as const,
        fences: true,
      }));
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
        if (suppressNextRef.current) {
          suppressNextRef.current = false;
          return;
        }
        syncedRef.current = markdown;
        onChangeRef.current(markdown);
      });
    })
    .use(commonmark)
    .use(gfm)
    .use(listener)
    .use(history), []);

  useEffect(() => {
    if (value === syncedRef.current) return;
    const editor = get();
    if (!editor) return;
    syncedRef.current = value;
    suppressNextRef.current = true;
    editor.action(replaceAll(value));
  }, [get, value]);

  return (
    <div className="workspace-markdown-editor">
      <Milkdown />
    </div>
  );
}
