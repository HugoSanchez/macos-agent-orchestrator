import { useState, useRef, useCallback, useEffect, useMemo, useLayoutEffect } from 'react';
import { getSkills } from './chat';
import { useToast } from './Toaster';
import { chatModelLabel, type AttachedContext, type ChatModel, type OutgoingAttachment, type ReasoningEffort, type SkillSummaryView } from './types';
import { getWorkspaceAttachment } from './workspace-api';
import { isWorkspaceFileDrag, readWorkspaceFileDrag } from './workspace-file-drag';
import {
  REASONING_EFFORTS,
  REASONING_EFFORT_LABELS,
} from './types';

interface Props {
  text: string;
  attached: AttachedContext | null;
  onTextChange: (text: string) => void;
  onAttachedChange: (attached: AttachedContext | null) => void;
  onSend: (text: string, attached: AttachedContext | null, attachments: OutgoingAttachment[]) => void;
  onStop: () => void;
  reasoningEffort: ReasoningEffort;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  model: ChatModel | null;
  onModelChange: (model: ChatModel) => void;
  // Models the picker offers — App filters CHAT_MODELS down to the
  // providers that are actually connected.
  availableModels: readonly ChatModel[];
  // Called when the model menu opens; App re-checks provider status so
  // availability is fresh at the moment the user is looking at it.
  onModelMenuOpen?: () => void;
  isStreaming: boolean;
  disabled: boolean;
  focusRecoveryEnabled: boolean;
}

const SLASH_PATTERN = /^\/([a-z0-9-]*)/i;
const MAX_SUGGESTIONS = 8;

// Client-side gate for attachments; the orchestrator re-validates by magic
// bytes and enforces the same caps server-side (values mirror attachments.ts).
const ACCEPTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
// Documents often arrive with an empty or generic MIME (especially on drop), so
// we match by declared type OR by extension. anydoc converts these server-side.
const ACCEPTED_DOCUMENT_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);
const ACCEPTED_DOCUMENT_EXTENSIONS = ['.pdf', '.doc', '.docx', '.ppt', '.pptx'];
const MAX_ATTACHMENT_COUNT = 6;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function hasDocumentExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_DOCUMENT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// Classify a dropped/pasted file into the pipeline it belongs to, or null if
// it's neither a supported image nor document.
function classifyFile(file: File): 'image' | 'document' | null {
  if (ACCEPTED_IMAGE_TYPES.has(file.type)) return 'image';
  if (ACCEPTED_DOCUMENT_TYPES.has(file.type) || hasDocumentExtension(file.name)) return 'document';
  return null;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      if (comma < 0) {
        reject(new Error('Failed to read file'));
        return;
      }
      resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function InputBar({
  text,
  attached,
  onTextChange,
  onAttachedChange,
  onSend,
  onStop,
  reasoningEffort,
  onReasoningEffortChange,
  model,
  onModelChange,
  availableModels,
  onModelMenuOpen,
  isStreaming,
  disabled,
  focusRecoveryEnabled,
}: Props) {
  const isAttached = attached !== null;
  const requiresModelSelection = model === null;
  const [skills, setSkills] = useState<SkillSummaryView[]>([]);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [chipWidth, setChipWidth] = useState(0);
  const [attachments, setAttachments] = useState<OutgoingAttachment[]>([]);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [attachRowHeight, setAttachRowHeight] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLSpanElement>(null);
  const attachRowRef = useRef<HTMLDivElement>(null);
  const toast = useToast();

  // The attachments row lives inside the field, above the textarea. The skill
  // chip is absolutely pinned to the field's top inset, so when the row is
  // present we push the chip down by the row's rendered height (it wraps).
  useLayoutEffect(() => {
    if (attachments.length === 0) {
      setAttachRowHeight(0);
      return;
    }
    const el = attachRowRef.current;
    if (!el) return;
    setAttachRowHeight(Math.ceil(el.getBoundingClientRect().height) + 8);
  }, [attachments]);

  const addFiles = useCallback(async (files: File[]) => {
    const room = MAX_ATTACHMENT_COUNT - attachments.length;
    let totalBytes = attachments.reduce(
      (sum, attachment) => sum + Math.floor(attachment.dataBase64.length * 0.75),
      0,
    );
    const accepted: OutgoingAttachment[] = [];
    const rejections: string[] = [];

    for (const file of files) {
      const label = file.name || 'file';
      const kind = classifyFile(file);
      if (!kind) {
        rejections.push(`${label}: only images (PNG, JPEG, WebP, GIF) and documents (PDF, Word, PowerPoint) are supported`);
        continue;
      }
      const perFileLimit = kind === 'document' ? MAX_DOCUMENT_BYTES : MAX_IMAGE_BYTES;
      if (file.size > perFileLimit) {
        rejections.push(`${label}: larger than ${kind === 'document' ? '10MB' : '5MB'}`);
        continue;
      }
      if (accepted.length >= room) {
        rejections.push(`${label}: at most ${MAX_ATTACHMENT_COUNT} attachments per message`);
        continue;
      }
      if (totalBytes + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
        rejections.push(`${label}: attachments exceed 20MB total`);
        continue;
      }
      try {
        const dataBase64 = await readFileAsBase64(file);
        totalBytes += file.size;
        accepted.push({ name: file.name || kind, mimeType: file.type, dataBase64, kind });
      } catch {
        rejections.push(`${label}: could not read file`);
      }
    }

    if (accepted.length > 0) {
      setAttachments((prev) => [...prev, ...accepted]);
    }
    if (rejections.length > 0) {
      toast.show({ title: 'Some files were not attached', description: rejections.join('\n'), tone: 'error' });
    }
  }, [attachments, toast]);

  const addWorkspaceFile = useCallback(async (workspaceId: string, path: string) => {
    try {
      await addFiles([await getWorkspaceAttachment(workspaceId, path)]);
    } catch (error: unknown) {
      toast.show({
        title: 'File was not attached',
        description: error instanceof Error ? error.message : 'Failed to read workspace file',
        tone: 'error',
      });
    }
  }, [addFiles, toast]);

  // The whole window is the drop target — dropping an image anywhere attaches
  // it. The window-level preventDefault also stops WebKit from navigating to
  // the dropped file, which is the default behavior in WKWebView.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const hasAcceptedDrag = (event: DragEvent) => hasFiles(event) || isWorkspaceFileDrag(event.dataTransfer);
    const onDragEnter = (event: DragEvent) => {
      if (!hasAcceptedDrag(event)) return;
      depth += 1;
      setIsDraggingOver(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (hasAcceptedDrag(event)) event.preventDefault();
    };
    const onDragLeave = (event: DragEvent) => {
      if (!hasAcceptedDrag(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setIsDraggingOver(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasAcceptedDrag(event)) return;
      event.preventDefault();
      depth = 0;
      setIsDraggingOver(false);
      const workspaceFile = readWorkspaceFileDrag(event.dataTransfer);
      if (workspaceFile) {
        const target = event.target;
        if (target instanceof Node && fieldRef.current?.contains(target)) {
          void addWorkspaceFile(workspaceFile.workspaceId, workspaceFile.path);
        }
        return;
      }
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) void addFiles(files);
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [addFiles, addWorkspaceFile]);

  // Skills fetch races the sidecar port assignment in App.tsx — if our
  // mount fires before the port is set, getSkills() throws (silently),
  // skills stays empty, and the suggestions popover never renders. So
  // we also listen for the `verso:sidecar-port` event the native shell
  // dispatches and refetch on each port update.
  useEffect(() => {
    let cancelled = false;
    const fetchSkills = async () => {
      try {
        const next = await getSkills();
        if (!cancelled) setSkills(next);
      } catch {
        // sidecar not ready yet
      }
    };
    void fetchSkills();
    const onPortReady = () => { void fetchSkills(); };
    window.addEventListener('verso:sidecar-port-ready', onPortReady);
    return () => {
      cancelled = true;
      window.removeEventListener('verso:sidecar-port-ready', onPortReady);
    };
  }, []);

  // Suggestions only fire when no skill is attached and the body starts
  // with a slash — once a skill is attached the leading slash lives in
  // chip state, not text.
  const slashMatch = useMemo(() => {
    if (isAttached) return null;
    const match = text.match(SLASH_PATTERN);
    if (!match) return null;
    return { full: match[0], query: match[1].toLowerCase() };
  }, [text, isAttached]);

  const suggestions = useMemo(() => {
    if (!slashMatch) return [];
    const { query } = slashMatch;
    const filtered = skills.filter((skill) => {
      if (!query) return true;
      const haystack = `${skill.slug} ${skill.name} ${skill.description}`.toLowerCase();
      return haystack.includes(query);
    });
    filtered.sort((a, b) => {
      const aStarts = a.slug.startsWith(query) ? 0 : 1;
      const bStarts = b.slug.startsWith(query) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return a.slug.localeCompare(b.slug);
    });
    return filtered.slice(0, MAX_SUGGESTIONS);
  }, [skills, slashMatch]);

  useEffect(() => {
    setHighlightIndex(0);
  }, [slashMatch?.query]);

  useEffect(() => {
    if (!focusRecoveryEnabled) return;

    const recoverFocus = () => {
      window.setTimeout(() => {
        const el = textareaRef.current;
        if (!el) return;

        const active = document.activeElement;
        const activeIsOtherEditable = active instanceof HTMLElement
          && active !== document.body
          && active !== el
          && (
            active instanceof HTMLInputElement
            || active instanceof HTMLTextAreaElement
            || active.isContentEditable
          );
        if (activeIsOtherEditable) return;

        el.focus({ preventScroll: true });
      }, 0);
    };

    window.addEventListener('verso:system-wake', recoverFocus);
    window.addEventListener('verso:restore-chat-focus', recoverFocus);
    return () => {
      window.removeEventListener('verso:system-wake', recoverFocus);
      window.removeEventListener('verso:restore-chat-focus', recoverFocus);
    };
  }, [focusRecoveryEnabled]);

  const showSuggestions = slashMatch !== null && suggestions.length > 0 && !isStreaming;

  // Measure the chip so we can text-indent the textarea's first line by
  // exactly that much — the chip then sits inline with the body text on
  // line 1, and wrapped lines start flush left, matching how the post-
  // send chip renders in the chat bubble.
  useLayoutEffect(() => {
    if (!isAttached) {
      if (chipWidth !== 0) setChipWidth(0);
      return;
    }
    const el = chipRef.current;
    if (!el) return;
    const w = el.getBoundingClientRect().width;
    setChipWidth(w + 6);
  }, [isAttached, chipWidth]);

  const attachSkill = useCallback((slug: string) => {
    onAttachedChange({ kind: 'skill', slug });
    const match = text.match(SLASH_PATTERN);
    onTextChange(match ? text.slice(match[0].length).trimStart() : text);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [onAttachedChange, onTextChange, text]);

  const detachContext = useCallback(() => {
    onAttachedChange(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(0, 0);
    });
  }, [onAttachedChange]);

  // Auto-promote `/slug` to a chip as soon as the typed slug uniquely
  // identifies a real skill — no need to pick from the popover or hit
  // space first. This makes the input mirror the post-send chip while
  // the user is typing.
  //
  // We only promote when the typed slug has no longer sibling (e.g.
  // typing "/apple" doesn't promote because "apple-notes" and
  // "apple-reminders" exist; typing "/apple-notes" does). Backspace at
  // the start of an empty body still pops the chip off.
  useEffect(() => {
    if (isAttached || skills.length === 0) return;
    const match = text.match(/^\/([a-z0-9-]+)(\s|$)/i);
    if (!match) return;
    const slug = match[1].toLowerCase();
    const isExact = skills.some((s) => s.slug === slug);
    if (!isExact) return;
    const hasLongerSibling = skills.some(
      (s) => s.slug !== slug && s.slug.startsWith(`${slug}-`),
    );
    if (hasLongerSibling) return;
    attachSkill(slug);
  }, [text, isAttached, skills, attachSkill]);

  const handleSubmit = useCallback(() => {
    if (isStreaming) {
      onStop();
      return;
    }
    if (disabled || requiresModelSelection) return;
    const trimmedBody = text.trim();
    let payload = trimmedBody;
    if (attached?.kind === 'skill') {
      // Skills travel via slash text — orchestrator parses it back out.
      payload = trimmedBody.length > 0 ? `/${attached.slug} ${trimmedBody}` : `/${attached.slug}`;
    }
    if (!payload && attached?.kind !== 'cron' && attachments.length === 0) return;
    onSend(payload, attached, attachments);
    onTextChange('');
    onAttachedChange(null);
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [text, attached, attachments, isStreaming, disabled, onSend, onStop, onTextChange, onAttachedChange, requiresModelSelection]);

  // Pasted files (Cmd+V of a screenshot, a copied image, or a document) arrive
  // as clipboard files; take supported ones and leave plain-text pastes alone.
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files: File[] = [];
    for (const item of Array.from(e.clipboardData?.items ?? [])) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (file && classifyFile(file)) files.push(file);
    }
    if (files.length > 0) {
      e.preventDefault();
      void addFiles(files);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSuggestions) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightIndex((prev) => (prev + 1) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightIndex((prev) => (prev - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        attachSkill(suggestions[highlightIndex].slug);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onTextChange('');
        return;
      }
    }
    // Backspace at the start of an empty selection with a chip attached
    // pops the chip off — same intuition as how chips work in mail/Slack.
    if (
      e.key === 'Backspace'
      && isAttached
      && textareaRef.current
      && textareaRef.current.selectionStart === 0
      && textareaRef.current.selectionEnd === 0
    ) {
      e.preventDefault();
      detachContext();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onTextChange(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  };

  const canSend = isStreaming || text.trim().length > 0 || isAttached || attachments.length > 0;
  const placeholder = disabled
    ? 'Connecting... you can type while things load.'
    : attached?.kind === 'skill'
      ? `Message with /${attached.slug}…`
      : attached?.kind === 'cron'
        ? `Edit routine "${attached.name}" — describe the change`
        : 'Write a message...';

  return (
    <div className="input-bar">
      <div
        ref={fieldRef}
        onMouseDown={(event) => {
          const target = event.target;
          if (target instanceof HTMLElement && target.closest('button')) return;
          window.requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
        }}
        className={`input-bar-field${isDraggingOver ? ' is-dragging-over' : ''}`}
      >
        {showSuggestions && (
          <SlashSuggestions
            items={suggestions}
            highlightIndex={highlightIndex}
            onSelect={attachSkill}
            onHover={setHighlightIndex}
          />
        )}
        {attachments.length > 0 && (
          <div className="input-attachments-row" ref={attachRowRef}>
            {attachments.map((attachment, index) => (
              <span key={`${attachment.name}-${index}`} className="input-skill-chip input-attachment-chip">
                {attachment.kind === 'document' ? (
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M2.5 1 H6 L7.5 2.5 V9 H2.5 Z" />
                    <path d="M6 1 V2.5 H7.5" />
                    <line x1="3.7" y1="5" x2="6.3" y2="5" />
                    <line x1="3.7" y1="6.8" x2="6.3" y2="6.8" />
                  </svg>
                ) : (
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="1" y="1" width="8" height="8" rx="1.5" />
                    <circle cx="3.6" cy="3.6" r="0.9" fill="currentColor" stroke="none" />
                    <path d="M1.5 7.5 L4 5 L6 7 L7.4 5.6 L9 7.2" />
                  </svg>
                )}
                <span className="input-attachment-chip-name">{attachment.name}</span>
                <button
                  type="button"
                  className="input-skill-chip-remove"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    setAttachments((prev) => prev.filter((_, i) => i !== index));
                  }}
                  aria-label={`Remove ${attachment.name}`}
                  title={`Remove ${attachment.name}`}
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="1.5" y1="1.5" x2="6.5" y2="6.5" />
                    <line x1="6.5" y1="1.5" x2="1.5" y2="6.5" />
                  </svg>
                </button>
              </span>
            ))}
          </div>
        )}
        {attached && (
          <span
            ref={chipRef}
            className={`input-skill-chip${attached.kind === 'cron' ? ' is-cron' : ''}`}
            style={{
              position: 'absolute',
              top: `${12 + attachRowHeight}px`,
              left: '16px',
              pointerEvents: 'auto',
            }}
            aria-label={attached.kind === 'skill'
              ? `Skill attached: /${attached.slug}`
              : `Routine attached: ${attached.name}`}
          >
            {attached.kind === 'skill' ? (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M5 1 L6 4 L9 5 L6 6 L5 9 L4 6 L1 5 L4 4 Z" fill="currentColor" />
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="5.5" cy="5.5" r="4.4" />
                <polyline points="5.5,3 5.5,5.5 7.5,6.6" />
              </svg>
            )}
            <span className="input-skill-chip-slug">
              {attached.kind === 'skill' ? `/${attached.slug}` : attached.name}
            </span>
            <button
              type="button"
              className="input-skill-chip-remove"
              onMouseDown={(event) => {
                event.preventDefault();
                detachContext();
              }}
              aria-label={attached.kind === 'skill' ? 'Remove attached skill' : 'Remove attached routine'}
              title={attached.kind === 'skill' ? 'Remove attached skill' : 'Remove attached routine'}
            >
              <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="1.5" y1="1.5" x2="6.5" y2="6.5" />
                <line x1="6.5" y1="1.5" x2="1.5" y2="6.5" />
              </svg>
            </button>
          </span>
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          rows={2}
          className="input-bar-textarea"
          style={{ textIndent: isAttached ? `${chipWidth}px` : 0 }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
            <ModelMenu value={model} available={availableModels} onChange={onModelChange} onOpen={onModelMenuOpen} disabled={disabled} />
            <ReasoningEffortCycler
              value={reasoningEffort}
              onChange={onReasoningEffortChange}
              disabled={disabled}
            />
          </div>
          <div className="composer-send-group">
            <button
              onClick={handleSubmit}
              disabled={disabled || !canSend || (!isStreaming && requiresModelSelection)}
              className={`input-send-button${canSend && !disabled && (!requiresModelSelection || isStreaming) ? ' is-active' : ''}${disabled || (!isStreaming && requiresModelSelection) ? ' is-blocked' : ''}`}
              aria-label={isStreaming ? 'Stop' : 'Send'}
            >
              {isStreaming ? (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                  <rect x="2" y="2" width="10" height="10" rx="1.5" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="8" y1="12" x2="8" y2="4" />
                  <polyline points="4,7 8,3 12,7" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SlashSuggestions({
  items,
  highlightIndex,
  onSelect,
  onHover,
}: {
  items: SkillSummaryView[];
  highlightIndex: number;
  onSelect: (slug: string) => void;
  onHover: (index: number) => void;
}) {
  return (
    <div className="slash-popover" role="listbox">
      <div className="slash-popover-header">SKILLS</div>
      {items.map((item, index) => (
        <button
          key={item.slug}
          type="button"
          role="option"
          aria-selected={index === highlightIndex}
          className={`slash-popover-row${index === highlightIndex ? ' is-highlighted' : ''}`}
          onMouseEnter={() => onHover(index)}
          onMouseDown={(event) => {
            event.preventDefault();
            onSelect(item.slug);
          }}
        >
          <span className="slash-popover-slug">/{item.slug}</span>
          {item.description && (
            <span className="slash-popover-description">{item.description}</span>
          )}
        </button>
      ))}
    </div>
  );
}

// Signal-bars glyph whose filled-bar count tracks the effort level
// (low → 1, medium → 2, high → 3), mirroring the Cursor/Claude footer affordance.
function EffortBars({ level }: { level: number }) {
  const heights = [4, 7, 10];
  return (
    <svg width="13" height="11" viewBox="0 0 13 11" aria-hidden="true">
      {heights.map((h, i) => (
        <rect
          key={i}
          x={i * 4.5}
          y={11 - h}
          width="3"
          height={h}
          rx="1"
          fill="currentColor"
          opacity={i < level ? 1 : 0.3}
        />
      ))}
    </svg>
  );
}

function OpenAILogo() {
  return (
    <svg className="model-provider-logo" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <path d="M14.949 6.547a3.94 3.94 0 0 0-.348-3.273 4.11 4.11 0 0 0-4.4-1.934A4.1 4.1 0 0 0 8.423.2 4.15 4.15 0 0 0 6.305.086a4.1 4.1 0 0 0-1.891.948 4.04 4.04 0 0 0-1.158 1.753 4.1 4.1 0 0 0-1.563.679A4 4 0 0 0 .554 4.72a3.99 3.99 0 0 0 .502 4.731 3.94 3.94 0 0 0 .346 3.274 4.11 4.11 0 0 0 4.402 1.933c.382.425.852.764 1.377.995.526.231 1.095.35 1.67.346 1.78.002 3.358-1.132 3.901-2.804a4.1 4.1 0 0 0 1.563-.68 4 4 0 0 0 1.14-1.253 3.99 3.99 0 0 0-.506-4.716m-6.097 8.406a3.05 3.05 0 0 1-1.945-.694l.096-.054 3.23-1.838a.53.53 0 0 0 .265-.455v-4.49l1.366.778q.02.011.025.035v3.722c-.003 1.653-1.361 2.992-3.037 2.996m-6.53-2.75a2.95 2.95 0 0 1-.36-2.01l.095.057L5.29 12.09a.53.53 0 0 0 .527 0l3.949-2.246v1.555a.05.05 0 0 1-.022.041L6.473 13.3c-1.454.826-3.311.335-4.15-1.098m-.85-6.94A3.02 3.02 0 0 1 3.07 3.949v3.785a.51.51 0 0 0 .262.451l3.93 2.237-1.366.779a.05.05 0 0 1-.048 0L2.585 9.342a2.98 2.98 0 0 1-1.113-4.094zm11.216 2.571L8.747 5.576l1.362-.776a.05.05 0 0 1 .048 0l3.265 1.86a3 3 0 0 1 1.173 1.207 2.96 2.96 0 0 1-.27 3.2 3.05 3.05 0 0 1-1.36.997V8.279a.52.52 0 0 0-.276-.445m1.36-2.015-.097-.057-3.226-1.855a.53.53 0 0 0-.53 0L6.249 6.153V4.598a.04.04 0 0 1 .019-.04L9.533 2.7a3.07 3.07 0 0 1 3.257.139c.474.325.843.778 1.066 1.303.223.526.289 1.103.191 1.664zM5.503 8.575 4.139 7.8a.05.05 0 0 1-.026-.037V4.049c0-.57.166-1.127.476-1.607s.752-.864 1.275-1.105a3.08 3.08 0 0 1 3.234.41l-.096.054-3.23 1.838a.53.53 0 0 0-.265.455zm.742-1.577 1.758-1 1.762 1v2l-1.755 1-1.762-1z" />
    </svg>
  );
}

function ClaudeLogo() {
  return (
    <svg className="model-provider-logo model-provider-logo-claude" viewBox="0 0 512 509.64" aria-hidden="true" fill="currentColor">
      <path d="M142.27 316.619l73.655-41.326 1.238-3.589-1.238-1.996-3.589-.001-12.31-.759-42.084-1.138-36.498-1.516-35.361-1.896-8.897-1.895-8.34-10.995.859-5.484 7.482-5.03 10.717.935 23.683 1.617 35.537 2.452 25.782 1.517 38.193 3.968h6.064l.86-2.451-2.073-1.517-1.618-1.517-36.776-24.922-39.81-26.338-20.852-15.166-11.273-7.683-5.687-7.204-2.451-15.721 10.237-11.273 13.75.935 3.513.936 13.928 10.716 29.749 23.027 38.848 28.612 5.687 4.727 2.275-1.617.278-1.138-2.553-4.271-21.13-38.193-22.546-38.848-10.035-16.101-2.654-9.655c-.935-3.968-1.617-7.304-1.617-11.374l11.652-15.823 6.445-2.073 15.545 2.073 6.547 5.687 9.655 22.092 15.646 34.78 24.265 47.291 7.103 14.028 3.791 12.992 1.416 3.968 2.449-.001v-2.275l1.997-26.641 3.69-32.707 3.589-42.084 1.239-11.854 5.863-14.206 11.652-7.683 9.099 4.348 7.482 10.716-1.036 6.926-4.449 28.915-8.72 45.294-5.687 30.331h3.313l3.792-3.791 15.342-20.372 25.782-32.227 11.374-12.789 13.27-14.129 8.517-6.724 16.1-.001 11.854 17.617-5.307 18.199-16.581 21.029-13.75 17.819-19.716 26.54-12.309 21.231 1.138 1.694 2.932-.278 44.536-9.479 24.062-4.347 28.714-4.928 12.992 6.066 1.416 6.167-5.106 12.613-30.71 7.583-36.018 7.204-53.636 12.689-.657.48.758.935 24.164 2.275 10.337.556h25.301l47.114 3.514 12.309 8.139 7.381 9.959-1.238 7.583-18.957 9.655-25.579-6.066-59.702-14.205-20.474-5.106-2.83-.001v1.694l17.061 16.682 31.266 28.233 39.152 36.397 1.997 8.999-5.03 7.102-5.307-.758-34.401-25.883-13.27-11.651-30.053-25.302-1.996-.001v2.654l6.926 10.136 36.574 54.975 1.895 16.859-2.653 5.485-9.479 3.311-10.414-1.895-21.408-30.054-22.092-33.844-17.819-30.331-2.173 1.238-10.515 113.261-4.929 5.788-11.374 4.348-9.478-7.204-5.03-11.652 5.03-23.027 6.066-30.052 4.928-23.886 4.449-29.674 2.654-9.858-.177-.657-2.173.278-22.37 30.71-34.021 45.977-26.919 28.815-6.445 2.553-11.173-5.789 1.037-10.337 6.243-9.2 37.257-47.392 22.47-29.371 14.508-16.961-.101-2.451h-.859l-98.954 64.251-17.618 2.275-7.583-7.103.936-11.652 3.589-3.791 29.749-20.474-.101.102.024.101z" />
    </svg>
  );
}

function ModelProviderLogo({ model }: { model: ChatModel }) {
  return model.startsWith('claude-') ? <ClaudeLogo /> : <OpenAILogo />;
}

// Footer cycle buttons (model / reasoning-effort). Clicking advances to the
// next option; the tooltip names the control. No menu — matching the
// lightweight Cursor/Claude footer affordance. Styling lives in
// .footer-cycle-button (composer.css); the disabled state is driven by the
// button's own :disabled, so no dynamic inline style is needed.

function cycleNext<T>(items: readonly T[], current: T): T {
  const index = items.indexOf(current);
  return items[(index + 1) % items.length];
}

function ReasoningEffortCycler({
  value,
  onChange,
  disabled,
}: {
  value: ReasoningEffort;
  onChange: (effort: ReasoningEffort) => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(cycleNext(REASONING_EFFORTS, value))}
      disabled={disabled}
      aria-label={`Reasoning effort: ${REASONING_EFFORT_LABELS[value]} (click to change)`}
      title="Reasoning effort"
      className="footer-cycle-button footer-effort-button"
    >
      <EffortBars level={REASONING_EFFORTS.indexOf(value) + 1} />
      <span>{REASONING_EFFORT_LABELS[value]}</span>
    </button>
  );
}

// Dropdown model picker for starting/rerouting a conversation. An existing
// session may still display an unavailable historical model in the footer,
// but the menu deliberately offers only providers that are connected now.
function ModelMenu({
  value,
  available,
  onChange,
  onOpen,
  disabled,
}: {
  value: ChatModel | null;
  available: readonly ChatModel[];
  onChange: (model: ChatModel) => void;
  onOpen?: () => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="model-menu" ref={containerRef}>
      {open ? (
        <div className="model-menu-popover" role="listbox" aria-label="Model">
          {available.length === 0 ? (
            <div className="model-menu-hint">Connect a model provider in Settings</div>
          ) : available.map((m) => (
              <button
                key={m}
                type="button"
                role="option"
                aria-selected={m === value}
                className={`model-menu-row${m === value ? ' is-selected' : ''}`}
                onClick={() => { onChange(m); setOpen(false); }}
              >
                <span className="model-menu-logo-slot">
                  <ModelProviderLogo model={m} />
                </span>
                <span>{chatModelLabel(m)}</span>
              </button>
            ))}
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => {
          if (!open) onOpen?.();
          setOpen((v) => !v);
        }}
        disabled={disabled}
        aria-label={value ? `Model: ${chatModelLabel(value)} (click to choose)` : 'Choose model before sending'}
        aria-expanded={open}
        title="Model"
        className="footer-cycle-button footer-model-button"
      >
        <span>{value ? chatModelLabel(value) : 'Choose model'}</span>
      </button>
    </div>
  );
}
