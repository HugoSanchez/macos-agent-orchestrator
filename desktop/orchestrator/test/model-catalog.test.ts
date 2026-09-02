import { describe, expect, it } from 'vitest';
import { CODEX_CHAT_MODELS, isAllowedChatModel } from '../src/models/model-catalog.ts';

describe('Codex model catalog', () => {
  it('offers the GPT-5.6 family and GPT-5.5 in preference order', () => {
    expect(CODEX_CHAT_MODELS).toEqual([
      'gpt-5.5',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]);
  });

  it('rejects retired Codex models', () => {
    expect(isAllowedChatModel('gpt-5.4')).toBe(false);
    expect(isAllowedChatModel('gpt-5.4-mini')).toBe(false);
  });
});
