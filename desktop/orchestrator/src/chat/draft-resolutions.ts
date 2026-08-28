import {
  draftIdForArgs,
  SUPPORTED_MESSAGE_DRAFT_CHANNELS,
} from '../integrations/composio-bridge.ts';
import type {
  ChatActivityStep,
  ChatMessageRecord,
  DraftResolutionRecord,
} from './chat-store.ts';

export function applyDraftResolutions(
  messages: ChatMessageRecord[],
  resolutions: DraftResolutionRecord[],
): ChatMessageRecord[] {
  if (resolutions.length === 0) return messages;

  const byDraftId = new Map(resolutions.map((resolution) => [resolution.draftId, resolution]));
  let changedMessages = false;

  const nextMessages = messages.map((message) => {
    if (!message.steps || message.steps.length === 0) return message;

    let changedSteps = false;
    const steps = message.steps.map((step) => {
      if (step.type !== 'tool' || !isProposeMessageDraftStep(step)) return step;
      const input = asRecord(step.input);
      if (!input) return step;
      const channel = typeof input.channel === 'string' ? input.channel.trim().toLowerCase() : '';
      if (!SUPPORTED_MESSAGE_DRAFT_CHANNELS.has(channel)) return step;

      const draftId = draftIdForArgs(input);
      const resolution = byDraftId.get(draftId);
      if (!resolution) return step;

      changedSteps = true;
      return {
        ...step,
        result: JSON.stringify({
          data: resolution.status === 'sent'
            ? {
                status: 'sent',
                channel: resolution.channel,
                draft_id: resolution.draftId,
                resolved_by: 'verso_native',
              }
            : {
                status: 'rejected',
                reason: 'discarded_by_user',
                channel: resolution.channel,
                draft_id: resolution.draftId,
                resolved_by: 'verso_native',
              },
          error: null,
          logId: null,
        }),
      } satisfies ChatActivityStep;
    });

    if (!changedSteps) return message;
    changedMessages = true;
    return { ...message, steps };
  });

  return changedMessages ? nextMessages : messages;
}

function isProposeMessageDraftStep(step: Extract<ChatActivityStep, { type: 'tool' }>): boolean {
  return step.name.trim().toLowerCase().endsWith('propose_message_draft');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
