import { stripNamespace } from './message-activity-model';

// The drafting widget is a communication composer, not a generic approval
// surface for arbitrary connected-app mutations.
export const MESSAGE_DRAFT_CHANNELS = new Set(['gmail', 'slack', 'microsoft_teams']);

export function messageDraftChannel(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const channel = (input as Record<string, unknown>).channel;
  return typeof channel === 'string' ? channel.trim().toLowerCase() : '';
}

export function isSupportedMessageDraftInput(input: unknown): boolean {
  return MESSAGE_DRAFT_CHANNELS.has(messageDraftChannel(input));
}

export function isSupportedMessageDraftStep(step: { name: string; input?: unknown }): boolean {
  return stripNamespace(step.name).toLowerCase() === 'propose_message_draft'
    && isSupportedMessageDraftInput(step.input);
}
