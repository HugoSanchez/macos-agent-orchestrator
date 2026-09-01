export const REVIEWED_MESSAGE_TOOL_BY_CHANNEL = {
  gmail: 'GMAIL_SEND_EMAIL',
  slack: 'SLACK_SEND_MESSAGE',
} as const;

export type ReviewedMessageChannel = keyof typeof REVIEWED_MESSAGE_TOOL_BY_CHANNEL;

// Exact provider actions that can publish an outbound Gmail or Slack message.
// Only the two standard dispatch slugs above are available after native
// review; the other variants remain blocked until Verso has a review UI that
// can accurately represent their semantics.
export const PROTECTED_MESSAGE_SEND_TOOL_SLUGS = [
  'GMAIL_FORWARD_MESSAGE',
  'GMAIL_REPLY_TO_THREAD',
  'GMAIL_SEND_DRAFT',
  'GMAIL_SEND_EMAIL',
  // Deprecated provider alias for SLACK_SEND_MESSAGE. Keep it blocked while
  // it remains discoverable in Composio's Slack catalog.
  'SLACK_CHAT_POST_MESSAGE',
  'SLACK_SCHEDULE_MESSAGE',
  'SLACK_SEND_EPHEMERAL_MESSAGE',
  'SLACK_SEND_ME_MESSAGE',
  'SLACK_SEND_MESSAGE',
  'SLACKBOT_SCHEDULE_MESSAGE',
  'SLACKBOT_SEND_EPHEMERAL_MESSAGE',
  'SLACKBOT_SEND_ME_MESSAGE',
  'SLACKBOT_SEND_MESSAGE',
  // Legacy Slackbot aliases retained so an older cached manifest cannot
  // bypass the current policy after an app upgrade.
  'SLACKBOT_SCHEDULES_A_MESSAGE_TO_A_CHANNEL_AT_A_SPECIFIED_TIME',
  'SLACKBOT_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL',
] as const;

const PROTECTED_MESSAGE_SEND_TOOL_SET = new Set<string>(
  PROTECTED_MESSAGE_SEND_TOOL_SLUGS,
);

export const SUPPORTED_MESSAGE_DRAFT_CHANNELS: ReadonlySet<string> = new Set(
  Object.keys(REVIEWED_MESSAGE_TOOL_BY_CHANNEL),
);

export function isProtectedMessageSendToolSlug(toolSlug: string): boolean {
  return PROTECTED_MESSAGE_SEND_TOOL_SET.has(toolSlug.trim().toUpperCase());
}

export function reviewedMessageToolSlug(channel: string): string | null {
  const normalized = channel.trim().toLowerCase();
  if (!SUPPORTED_MESSAGE_DRAFT_CHANNELS.has(normalized)) return null;
  return REVIEWED_MESSAGE_TOOL_BY_CHANNEL[normalized as ReviewedMessageChannel];
}
