import { describe, expect, it } from 'vitest';
import { ANTHROPIC_CHAT_MODELS, CODEX_CHAT_MODELS, isAllowedChatModel } from '../src/models/model-catalog.ts';

describe('Codex model catalog', () => {
  it('offers GPT-6 Astra alongside the GPT-5.6 family and GPT-5.5', () => {
    expect(CODEX_CHAT_MODELS).toEqual([
      'gpt-5.5',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-6-astra',
    ]);
  });

  it('rejects retired Codex models', () => {
    expect(isAllowedChatModel('gpt-5.4')).toBe(false);
    expect(isAllowedChatModel('gpt-5.4-mini')).toBe(false);
  });
});

describe('Anthropic model catalog', () => {
  it('accepts Opus 5.5 without changing existing users’ default', () => {
    expect(isAllowedChatModel('claude-opus-5-5')).toBe(true);
    expect(ANTHROPIC_CHAT_MODELS[0]).toBe('claude-opus-4-8');
  });
});
