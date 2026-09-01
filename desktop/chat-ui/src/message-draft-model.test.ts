import { describe, expect, it } from 'vitest';
import {
  isSupportedMessageDraftInput,
  isSupportedMessageDraftStep,
  messageDraftChannel,
} from './message-draft-model';

describe('message draft eligibility', () => {
  it.each(['gmail', 'slack', 'microsoft_teams', ' Gmail ', 'SLACK', ' MICROSOFT_TEAMS '])(
    'accepts communication channel %s',
    (channel) => {
    expect(isSupportedMessageDraftInput({ channel })).toBe(true);
    },
  );

  it.each(['notion', 'google_docs', 'airtable', 'calendar', ''])('rejects non-message channel %s', (channel) => {
    expect(isSupportedMessageDraftInput({ channel })).toBe(false);
  });

  it('rejects malformed inputs and normalizes valid channel names', () => {
    expect(isSupportedMessageDraftInput(null)).toBe(false);
    expect(isSupportedMessageDraftInput([])).toBe(false);
    expect(isSupportedMessageDraftInput({ channel: 42 })).toBe(false);
    expect(messageDraftChannel({ channel: ' Slack ' })).toBe('slack');
  });

  it('does not reconstruct an unsupported historical tool step as a widget', () => {
    expect(isSupportedMessageDraftStep({
      name: 'mcp_verso_propose_message_draft',
      input: { channel: 'notion', body: 'Append a table' },
    })).toBe(false);
    expect(isSupportedMessageDraftStep({
      name: 'mcp_verso_propose_message_draft',
      input: { channel: 'gmail', body: 'Hello' },
    })).toBe(true);
  });
});
