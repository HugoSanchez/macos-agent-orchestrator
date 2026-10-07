import { describe, expect, it } from 'vitest';
import { ANTHROPIC_CHAT_MODELS, CHAT_MODEL_LABELS, CODEX_CHAT_MODELS } from './types';

describe('Codex model picker catalog', () => {
  it('shows GPT-6 Astra alongside the GPT-5.6 family and GPT-5.5 with product labels', () => {
    expect(CODEX_CHAT_MODELS).toEqual([
      'gpt-5.5',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-6-astra',
    ]);
    expect(CODEX_CHAT_MODELS.map((model) => CHAT_MODEL_LABELS[model])).toEqual([
      'GPT-5.5',
      'GPT-5.6 Sol',
      'GPT-5.6 Terra',
      'GPT-5.6 Luna',
      'GPT-6 Astra',
    ]);
  });
});

describe('Anthropic model picker', () => {
  it('offers Opus 5.5 while preserving the existing default', () => {
    expect(ANTHROPIC_CHAT_MODELS).toContain('claude-opus-5-5');
    expect(CHAT_MODEL_LABELS['claude-opus-5-5']).toBe('Claude Opus 5.5');
    expect(ANTHROPIC_CHAT_MODELS[0]).toBe('claude-opus-4-8');
  });
});
