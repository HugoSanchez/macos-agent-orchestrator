import { useEffect, useRef, useState } from 'react';
import { Brain } from 'lucide-react';
import type { ChatMessage, ActivityStep } from './types';
import { generateCronDescription, resolveSidecarUrl } from './chat';
import { MarkdownContent } from './MarkdownContent';
import {
  activityStepsWithReasoningFallback,
  formatElapsed,
  friendlyToolName,
  iconForTool,
  normalizeThinking,
  parseComposioExecute,
  parseCronToolStep,
  prettyValue,
  previewInput,
  unwrapToolCall,
  type CronToolCardModel,
  type ToolkitInfo,
  type ToolIconKind,
} from './message-activity-model';
import { dispatchShellCommand, postShellAction } from './shell-bridge';
import { useIsSystemAsleep } from './useSystemSleep';

interface AssistantActivityProps {
  message: ChatMessage;
  toolkits: Map<string, ToolkitInfo>;
}

export function AssistantActivity({ message, toolkits }: AssistantActivityProps) {
  const steps = activityStepsWithReasoningFallback(message.steps ?? [], message.reasoning);
  const hasReasoning = steps.some((step) => step.type === 'reasoning');
  const cronMutationSignature = JSON.stringify(steps.flatMap((step) => {
    if (step.type !== 'tool') return [];
    const card = parseCronToolStep(step);
    return card ? [[card.action, card.jobId]] : [];
  }));
  const [expanded, setExpanded] = useState(false);
  const wasStreaming = useRef(!!message.isStreaming);

  useEffect(() => {
    if (wasStreaming.current && !message.isStreaming) setExpanded(false);
    wasStreaming.current = !!message.isStreaming;
  }, [message.isStreaming]);

  // This must live above the collapsible tool-call details. A completed
  // assistant activity is collapsed by default, so a notification emitted by
  // CronToolCard would otherwise never run and leave the native sidebar stale.
  useEffect(() => {
    const mutations = JSON.parse(cronMutationSignature) as Array<[CronToolCardModel['action'], string | null]>;
    if (mutations.length === 0) return;
    postShellAction({ kind: 'crons-changed' });
    const createdJobIds = new Set(mutations.flatMap(([action, jobId]) => (
      action === 'create' && jobId ? [jobId] : []
    )));
    for (const jobId of createdJobIds) {
      void generateCronDescription(jobId).catch(() => {
        // Best effort; the detail page also generates missing descriptions.
      });
    }
  }, [cronMutationSignature]);

  if (steps.length === 0) return null;
  const toolCount = steps.filter((step) => step.type === 'tool').length;

  if (message.isStreaming) {
    return (
      <div className="assistant-activity-wrap">
        <div className="assistant-activity-live">
          {steps.map((step, index) => (
            <StepView key={index} step={step} toolkits={toolkits} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="assistant-activity-wrap">
      <ActivityHeader
        toolCount={toolCount}
        hasReasoning={hasReasoning}
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
      />
      {expanded && (
        <div className="assistant-activity-details">
          {steps.map((step, index) => (
            <StepView key={index} step={step} toolkits={toolkits} />
          ))}
        </div>
      )}
    </div>
  );
}

export function AssistantMessageActions({ message }: { message: ChatMessage }) {
  const hasTiming = typeof message.startedAt === 'number'
    && (message.isStreaming || typeof message.endedAt === 'number');
  const hasCopyableContent = message.content.trim().length > 0;
  if (!hasTiming && !hasCopyableContent) return null;

  return (
    <div className="assistant-message-footer-wrap">
      <div className="assistant-message-footer">
        {hasTiming && <ResponseTime message={message} />}
        {hasCopyableContent && <CopyMessageButton text={message.content} />}
      </div>
    </div>
  );
}

function ActivityHeader({
  toolCount,
  hasReasoning,
  expanded,
  onToggle,
}: {
  toolCount: number;
  hasReasoning: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const hasActivity = hasReasoning || toolCount > 0;
  const summary = [
    toolCount ? `${toolCount} tool call${toolCount === 1 ? '' : 's'}` : '',
    hasReasoning ? 'thinking' : '',
  ].filter(Boolean).join(' · ') || 'activity';

  return (
    <button
      type="button"
      onClick={hasActivity ? onToggle : undefined}
      className="activity-header-button"
      style={{ cursor: hasActivity ? 'pointer' : 'default' }}
    >
      {hasActivity && (
        <svg
          width="10" height="10" viewBox="0 0 10 10"
          fill="none" stroke="currentColor" strokeWidth="1.75"
          strokeLinecap="round" strokeLinejoin="round"
          style={{
            transition: 'transform 120ms ease',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            flexShrink: 0,
          }}
        >
          <polyline points="3.5,2 7,5 3.5,8" />
        </svg>
      )}
      <span>{summary}</span>
    </button>
  );
}

function StepView({
  step,
  toolkits,
}: {
  step: ActivityStep;
  toolkits: Map<string, ToolkitInfo>;
}) {
  if (step.type === 'text') {
    const body = step.text.trim();
    if (!body) return null;
    return (
      <div className="message-content assistant-message-content assistant-interim-message">
        <MarkdownContent content={body} />
      </div>
    );
  }
  if (step.type === 'reasoning') return <ThinkingStep text={step.text} />;
  const card = parseCronToolStep(step);
  if (card) return <CronToolCard {...card} />;
  return <ToolStep step={step} toolkits={toolkits} />;
}

function ThinkingStep({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const body = normalizeThinking(text);
  const hasDetails = body.length > 0;

  return (
    <div className="tool-step">
      <button
        type="button"
        className="tool-step-row thinking-row"
        onClick={hasDetails ? () => setExpanded((value) => !value) : undefined}
        disabled={!hasDetails}
      >
        <Brain size={13} strokeWidth={1.75} className="tool-step-icon" aria-hidden="true" />
        <span className="tool-step-name">Thinking</span>
        {hasDetails && <ToolChevron expanded={expanded} />}
      </button>
      {expanded && hasDetails && (
        <div className="tool-step-details">
          <div className="message-content reasoning-markdown">
            <MarkdownContent content={body} />
          </div>
        </div>
      )}
    </div>
  );
}

const CRON_ACTION_LABELS: Record<CronToolCardModel['action'], string> = {
  create: 'Scheduled',
  update: 'Updated',
  remove: 'Removed',
  pause: 'Paused',
  resume: 'Resumed',
  run: 'Triggered',
};

function CronToolCard({ action, jobId, name, scheduleDisplay }: CronToolCardModel) {
  const canView = action !== 'remove' && jobId !== null;
  const handleView = () => {
    if (canView && jobId !== null) dispatchShellCommand({ kind: 'open-cron', id: jobId });
  };

  return (
    <div className="cron-tool-card">
      <div className="cron-tool-card-icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="7" cy="7" r="5.5" />
          <polyline points="7,4 7,7 9.5,8.5" />
        </svg>
      </div>
      <div className="cron-tool-card-body">
        <div className="cron-tool-card-title">
          {CRON_ACTION_LABELS[action]} routine {name ? <strong>{name}</strong> : ''}
        </div>
        {scheduleDisplay && action !== 'remove' && (
          <div className="cron-tool-card-subtitle">{scheduleDisplay}</div>
        )}
      </div>
      {canView && (
        <button type="button" className="cron-tool-card-view" onClick={handleView}>View</button>
      )}
    </div>
  );
}

function ToolStep({
  step: rawStep,
  toolkits,
}: {
  step: Extract<ActivityStep, { type: 'tool' }>;
  toolkits: Map<string, ToolkitInfo>;
}) {
  const [expanded, setExpanded] = useState(false);
  const step = unwrapToolCall(rawStep);
  const composio = parseComposioExecute(step, toolkits);
  const friendlyName = composio ? composio.toolkitName : friendlyToolName(step.name);
  const inputPreview = composio ? composio.actionLabel : previewInput(step.input);
  const hasInput = step.input != null && step.input !== '';
  const hasResult = typeof step.result === 'string' && step.result.length > 0;
  const hasDetails = hasInput || hasResult;

  return (
    <div className="tool-step">
      <button
        type="button"
        className="tool-step-row"
        onClick={hasDetails ? () => setExpanded((value) => !value) : undefined}
        disabled={!hasDetails}
      >
        {composio ? (
          <ToolkitMark name={composio.toolkitName} logoUrl={composio.logoUrl} />
        ) : (
          <ToolIcon kind={iconForTool(step.name)} />
        )}
        <span className="tool-step-name">{friendlyName}</span>
        {inputPreview && !expanded && <span className="tool-step-preview">{inputPreview}</span>}
        {hasDetails && <ToolChevron expanded={expanded} />}
      </button>
      {expanded && hasDetails && (
        <div className="tool-step-details">
          {hasInput && (
            <pre className="tool-step-payload">
              <span className="tool-step-payload-label">Input</span>
              {prettyValue(step.input)}
            </pre>
          )}
          {hasResult && (
            <pre className="tool-step-payload">
              <span className="tool-step-payload-label">Result</span>
              {step.result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function ToolChevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className="tool-step-chevron"
      width="9" height="9" viewBox="0 0 9 9"
      fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round"
      style={{ transform: expanded ? 'rotate(90deg)' : undefined }}
      aria-hidden="true"
    >
      <polyline points="3,2 6,4.5 3,7" />
    </svg>
  );
}

function ToolkitMark({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  if (logoUrl) {
    return (
      <img
        src={resolveSidecarUrl(logoUrl) ?? logoUrl}
        alt=""
        aria-hidden="true"
        className="tool-step-toolkit-logo"
      />
    );
  }
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  return <span className="tool-step-toolkit-fallback" aria-hidden="true">{initial}</span>;
}

function ToolIcon({ kind }: { kind: ToolIconKind }) {
  return (
    <svg
      className="tool-step-icon"
      width="13" height="13" viewBox="0 0 13 13"
      fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === 'search' && <><circle cx="5.5" cy="5.5" r="3.25" /><path d="M8 8 L11 11" /></>}
      {kind === 'terminal' && <><polyline points="2.5,3.5 5,6.5 2.5,9.5" /><line x1="6.5" y1="9.5" x2="10.5" y2="9.5" /></>}
      {kind === 'pencil' && <><path d="M2.5 10.5 L8.5 4.5" /><path d="M8 4 L9.5 5.5" /><path d="M9.5 5.5 L11 4 L8.5 1.5 L7 3 Z" /><path d="M2.5 10.5 L2 11.5 L3 11" /></>}
      {kind === 'trash' && <><line x1="2" y1="3.5" x2="11" y2="3.5" /><path d="M3 3.5 L3.5 10.5 L9.5 10.5 L10 3.5" /><line x1="5.5" y1="3.5" x2="5.5" y2="2" /><line x1="7.5" y1="3.5" x2="7.5" y2="2" /></>}
      {kind === 'link' && <><path d="M5.5 4 L4 4 A2.5 2.5 0 0 0 4 9 L5.5 9" /><path d="M7.5 4 L9 4 A2.5 2.5 0 0 1 9 9 L7.5 9" /><line x1="4.5" y1="6.5" x2="8.5" y2="6.5" /></>}
      {kind === 'fetch' && <><line x1="6.5" y1="2" x2="6.5" y2="9" /><polyline points="3.5,6.5 6.5,9.5 9.5,6.5" /><line x1="3" y1="11.5" x2="10" y2="11.5" /></>}
      {kind === 'dot' && <circle cx="6.5" cy="6.5" r="1.25" fill="currentColor" />}
    </svg>
  );
}

function ResponseTime({ message }: { message: ChatMessage }) {
  const elapsed = useElapsed(message.startedAt, message.endedAt, message.isStreaming);
  return (
    <div className="assistant-response-time">
      <span className="assistant-response-time-value">{formatElapsed(elapsed)}</span>
    </div>
  );
}

function useElapsed(
  startedAt: number | undefined,
  endedAt: number | undefined,
  isStreaming: boolean | undefined,
): number {
  const [now, setNow] = useState(() => Date.now());
  const asleep = useIsSystemAsleep();
  useEffect(() => {
    if (!isStreaming || asleep) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [isStreaming, asleep]);
  if (!startedAt) return 0;
  const end = isStreaming ? now : (endedAt ?? now);
  return Math.max(0, end - startedAt);
}

function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  async function handleCopy() {
    const value = text.trim();
    if (!value) return;
    try {
      await copyText(value);
    } catch {
      return;
    }
    setCopied(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <button
      type="button"
      className={`message-copy-button${copied ? ' is-copied' : ''}`}
      onClick={handleCopy}
      aria-label={copied ? 'Message copied' : 'Copy message'}
      title={copied ? 'Copied' : 'Copy message'}
    >
      {copied ? <MessageCheckIcon /> : <MessageCopyIcon />}
    </button>
  );
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  if (!ok) throw new Error('Copy failed');
}

function MessageCopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function MessageCheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
